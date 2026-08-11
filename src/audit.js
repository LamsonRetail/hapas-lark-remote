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

    if (!res.ok) console.error(`[audit] ghi thất bại ${res.status}: ${text.slice(0, 200)}`);
  } catch (e) {
    console.error(`[audit] ghi thất bại: ${e.message}`);
  }
  if (queue.length) schedule();
}

function schedule() {
  if (timer) return;
  timer = setTimeout(flush, FLUSH_MS);
  timer.unref?.(); // đừng giữ process sống chỉ vì hàng đợi audit
}

export function auditToolCall({ openId, userName, clientId, toolName, args, ok, errorMsg, larkCode, durationMs }) {
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

/** Gọi khi tắt server để không mất lô cuối. */
export async function flushAudit() {
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  while (queue.length) await flush();
}
