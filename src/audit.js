import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { sbEnabled, sbFetch } from './supabase.js';

/**
 * Ghi nhật ký thao tác sang Supabase — chung bảng `audit_logs` với client zip,
 * phân biệt bằng cột `source`:
 *   'zip' → client CLI cài từ file zip (đi qua portal /api/audit)
 *   'url' → server này
 *
 * Chung bảng nên dashboard chỉ cần một query; muốn tách thì lọc `source`.
 *
 * Ba nguyên tắc:
 *  1. KHÔNG BAO GIỜ làm hỏng tool call. Audit chết thì tool vẫn chạy — người
 *     dùng không việc gì phải chịu hậu quả vì log không ghi được.
 *  2. Không chặn. Gom lô rồi bắn nền, tool call trả về ngay.
 *  3. Cắt dữ liệu. Tham số tool có thể là cả một tài liệu; không cắt thì bảng
 *     phình rất nhanh — đúng cái bệnh làm Bitable tràn.
 */

const ARGS_MAX = 2000;
const BATCH_MAX = 25;
const FLUSH_MS = 5000;
const QUEUE_MAX = 500; // chặn rò rỉ bộ nhớ khi Supabase chết dài

export const auditEnabled = sbEnabled;

let queue = [];
let timer = null;
let dropped = 0;

/**
 * Cột mà bảng chưa có. Schema Supabase luôn đi sau code — ai đó thêm trường
 * vào payload nhưng chưa chạy migration là chuyện thường. PostgREST không bỏ
 * qua cột lạ mà từ chối CẢ LÔ, nên nếu không xử lý thì mất sạch log chứ không
 * phải mất một trường. Đã dính đúng thế với `error_msg`: 0 dòng ghi được.
 */
const RECHECK_MS = 30 * 60_000;
const missingCols = new Map(); // cột -> lúc phát hiện thiếu

/**
 * Quên đi sau 30 phút, để lần sau thử gửi lại cột đó. Không có bước này thì
 * chạy migration xong vẫn phải restart server mới thấy trường quay lại — một
 * cái bẫy im lặng đúng kiểu "đã sửa rồi mà sao vẫn thiếu".
 */
function stillMissing() {
  const now = Date.now();
  for (const [col, at] of missingCols) if (now - at > RECHECK_MS) missingCols.delete(col);
  return missingCols;
}

function post(rows) {
  const skip = stillMissing();
  const body = skip.size
    ? rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !skip.has(k))))
    : rows;
  return sbFetch('audit_logs', { method: 'POST', body, prefer: 'return=minimal' });
}

/**
 * Ổ chứa tạm khi Supabase không nhận.
 *
 * Trước đây lô gửi hỏng là VỨT THẲNG: in một dòng `ghi thất bại` rồi đi tiếp.
 * Chấp nhận được với sự cố vài giây, nhưng ngày 02/09/2026 Supabase khoá dự án
 * vì `exceed_egress_quota` và trạng thái đó kéo dài NHIỀU NGÀY — mọi bản ghi
 * trong khoảng ấy mất sạch. Đúng lúc Nguyễn Thùy Chi báo lỗi thì không còn gì
 * để tra: ai gọi, gọi tool nào, hỏng ở đâu, tất cả đã bị vứt.
 *
 * NDJSON nối đuôi: rẻ, không cần parse lại file cũ, và crash giữa chừng chỉ
 * hỏng đúng dòng cuối. Vẫn giữ nguyên tắc số 1 — hỏng ở đây tuyệt đối không
 * được làm hỏng tool call, nên toàn bộ nằm trong try/catch câm.
 */
const SPILL = path.join(config.dataDir, 'audit-spill.ndjson');
const SPILL_MAX = 20 * 1024 * 1024;
let spilled = 0;

function spill(rows, why) {
  try {
    if (fs.existsSync(SPILL) && fs.statSync(SPILL).size > SPILL_MAX) {
      fs.renameSync(SPILL, SPILL + '.prev');
    }
    const at = new Date().toISOString();
    fs.appendFileSync(SPILL, rows.map((r) => JSON.stringify({ _spilled_at: at, _why: why, ...r })).join('\n') + '\n');
    spilled += rows.length;
    // Mỗi lô một dòng log thì 402 kéo dài sẽ ngập màn hình. Báo theo mốc.
    if (spilled === rows.length || spilled % 200 < rows.length) {
      console.error(`[audit] đã dồn ${spilled} bản ghi vào ${SPILL} — nạp lại khi Supabase sống lại`);
    }
  } catch (e) {
    console.error(`[audit] không ghi được file dự phòng: ${e.message}`);
  }
}

async function flush() {
  timer = null;
  if (!queue.length) return;
  const batch = queue.splice(0, BATCH_MAX);
  try {
    let res = await post(batch);
    let text = res.ok ? '' : await res.text();

    // Thiếu cột thì bỏ đúng cột đó rồi gửi lại — mất một trường còn hơn mất log.
    const col = res.ok ? null : text.match(/Could not find the '(\w+)' column/)?.[1];
    if (col && !missingCols.has(col)) {
      missingCols.set(col, Date.now());
      console.error(`[audit] bảng audit_logs chưa có cột '${col}' — tạm bỏ cột này. Chạy supabase/audit-source.sql để ghi đủ.`);
      res = await post(batch);
      text = res.ok ? '' : await res.text();
    }

    if (!res.ok) {
      console.error(`[audit] ghi thất bại ${res.status}: ${text.slice(0, 200)}`);
      spill(batch, `http ${res.status}`);
    } else {
      await drainSpill();
    }
  } catch (e) {
    console.error(`[audit] ghi thất bại: ${e.message}`);
    spill(batch, e.message);
  }
  if (queue.length) schedule();
}

/**
 * Đẩy lại những gì đã dồn ra đĩa, mỗi lượt một ít.
 *
 * CHỈ chạy ngay sau một lần gửi THÀNH CÔNG. Thử nạp lại trong lúc Supabase còn
 * chết chỉ tạo thêm lượt hỏng rồi ghi đè lại chính file đó — vòng lặp vô ích và
 * mỗi vòng là một cơ hội làm rách file.
 *
 * Mỗi lượt một lô: sự cố kéo dài có thể dồn hàng chục nghìn dòng, bắn hết một
 * lần vừa dễ bị chặn tốc độ vừa chặn hàng đợi đang chạy. Còn dư thì lượt flush
 * sau nạp tiếp, tự rút cạn dần.
 */
async function drainSpill() {
  let lines;
  try {
    if (!fs.existsSync(SPILL)) return;
    lines = fs.readFileSync(SPILL, 'utf8').split('\n').filter(Boolean);
  } catch (e) {
    console.error(`[audit] không đọc được file dự phòng: ${e.message}`);
    return;
  }
  if (!lines.length) {
    try { fs.unlinkSync(SPILL); } catch {}
    return;
  }

  const take = lines.slice(0, BATCH_MAX);
  const rows = [];
  for (const l of take) {
    // Dòng rách (crash giữa lúc ghi) thì bỏ đúng dòng đó, đừng chặn cả file.
    try {
      const { _spilled_at, _why, ...row } = JSON.parse(l);
      rows.push(row);
    } catch {}
  }

  if (rows.length) {
    let ok = false;
    try {
      const res = await post(rows);
      ok = res.ok;
      if (!ok) console.error(`[audit] nạp lại thất bại ${res.status} — để dành lượt sau`);
    } catch (e) {
      console.error(`[audit] nạp lại thất bại: ${e.message}`);
    }
    if (!ok) return; // giữ nguyên file, thử lại lần flush sau
  }

  // Ghi lại phần còn dư qua file tạm rồi đổi tên — crash giữa chừng không mất.
  try {
    const rest = lines.slice(take.length);
    if (!rest.length) {
      fs.unlinkSync(SPILL);
      console.log(`[audit] đã nạp lại xong toàn bộ file dự phòng`);
    } else {
      fs.writeFileSync(SPILL + '.tmp', rest.join('\n') + '\n');
      fs.renameSync(SPILL + '.tmp', SPILL);
      console.log(`[audit] nạp lại ${rows.length} bản ghi, còn ${rest.length} dòng`);
    }
    spilled = Math.max(0, spilled - rows.length);
  } catch (e) {
    console.error(`[audit] không cắt được file dự phòng: ${e.message}`);
  }
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
  timer.unref?.(); // đừng giữ process sống chỉ vì hàng đợi audit
}

export function auditToolCall({ openId, userName, clientId, clientApp, toolName, args, ok, errorMsg, larkCode, durationMs }) {
  if (!auditEnabled) return;

  if (queue.length >= QUEUE_MAX) {
    dropped++;
    if (dropped % 100 === 1) console.error(`[audit] hàng đợi đầy, đã bỏ ${dropped} bản ghi`);
    return;
  }

  let argsStr = null;
  try {
    argsStr = args && Object.keys(args).length ? JSON.stringify(args).slice(0, ARGS_MAX) : null;
  } catch {
    argsStr = '[không serialize được]';
  }

  queue.push({
    source: 'url', // 'zip' là client cài từ file zip, ghi qua portal
    machine_name: null, // chỉ có nghĩa với source='zip'
    app_id: config.appId,
    open_id: openId || null,
    user_name: userName || null,
    client_id: clientId || null,
    /**
     * Tên ứng dụng người dùng cắm bằng (Claude / Codex / static:…).
     *
     * `client_id` KHÔNG thay được nó: nó là chuỗi băm DCR và Claude đăng ký mới
     * mỗi lần cắm lại connector, nên vừa vô nghĩa với người đọc vừa không gom
     * nhóm được. Dashboard cần tên để nhóm "ai dùng cái gì".
     *
     * Cột mới — chưa chạy migration thì `flush()` tự bỏ nó ra rồi gửi lại
     * (xem missingCols), mất một trường chứ không mất cả lô log.
     */
    client_app: clientApp || null,
    tool_name: toolName,
    args: argsStr,
    ok: Boolean(ok),
    error_msg: errorMsg ? String(errorMsg).slice(0, 500) : null,
    // Mã lỗi Lark tách riêng để lọc được. Là text chứ không phải số: ngoài mã
    // số Lark còn trả chuỗi (`non_json` khi gọi nhầm host trả về HTML).
    lark_code: larkCode === undefined || larkCode === null ? null : String(larkCode).slice(0, 40),
    duration_ms: typeof durationMs === 'number' ? Math.round(durationMs) : null,
  });

  if (queue.length >= BATCH_MAX) flush();
  else schedule();
}

/**
 * Sự kiện vòng đời xác thực, ghi chung bảng với tool call.
 *
 * VÌ SAO CẦN: `machines` chỉ giữ TRẠNG THÁI hiện tại — `last_seen` bị ghi đè mỗi
 * lần chạm, nên không còn dấu vết của sự kiện. Không có bảng nào trả lời được
 * "tuần này bao nhiêu người phải đăng nhập lại", mà đó đúng là câu hỏi cần đo
 * khi refresh token của Lark chỉ sống 7 ngày.
 *
 * VÌ SAO KHÔNG TÁCH BẢNG: dùng lại `audit_logs` là được luôn index, job dọn,
 * batching và rollup có sẵn. Giá phải trả là `tool_name` mang tên sự kiện —
 * chấp nhận được vì tiền tố `__auth.` không thể đụng tên tool thật (tool MCP
 * không có tên bắt đầu bằng dấu gạch dưới). Dashboard lọc bằng
 * `tool_name like '__auth.%'`; xem view trong supabase/rollup.sql.
 *
 * Chỉ ghi sự kiện TRẢ LỜI ĐƯỢC một câu hỏi. Refresh thành công thì không ghi:
 * nó xảy ra mỗi 2 tiếng cho mỗi người đang hoạt động, ghi hết là ~70 dòng/ngày
 * toàn "vẫn ổn" — đúng cái bệnh đã phải sửa ở canary. Trạng thái bình thường đã
 * được keepalive tóm tắt đúng một dòng mỗi ngày.
 */
export function auditAuth({ event, openId, userName, clientId, ok = true, errorMsg = null, detail = null }) {
  auditToolCall({
    openId,
    userName,
    clientId,
    toolName: `__auth.${event}`,
    args: detail,
    ok,
    errorMsg,
    durationMs: null,
  });
}

/** Gọi khi tắt server để không mất lô cuối. */
export async function flushAudit() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  while (queue.length) await flush();
}
