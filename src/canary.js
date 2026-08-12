import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { TOOLS } from './tools/index.js';
import { apiFor, execSpec } from './tools/registry.js';
import { getValidAccessToken } from './lark-auth.js';
import { auditToolCall } from './audit.js';
import { dmAdmin as dm, alertTarget } from './notify.js';
import { writeProbes, writeEnabled } from './canary-write.js';

/**
 * Canary — tự gọi vài tool chỉ-đọc theo giờ để biết Lark đổi API TRƯỚC khi có
 * người dùng đâm vào.
 *
 * Vì sao cần, khi đã có audit của traffic thật: audit chỉ nói được về tool đang
 * có người gọi. Mấy tool ít dùng mới là chỗ hỏng âm thầm hàng tháng trời.
 *
 * KHÔNG tự chữa được API đổi — không hệ thống nào đoán ra endpoint mới. Thứ nó
 * rút ngắn là thời gian phát hiện: từ "chờ ai đó kêu" xuống "biết trong một giờ".
 *
 * Chạy dưới danh nghĩa một user thật (CANARY_OPEN_ID) vì hầu hết API Lark ở đây
 * là user-scoped. Người đó phải đã đăng nhập.
 */

const EVERY_MIN = Number(process.env.CANARY_EVERY_MIN ?? 60);
const OPEN_ID = (process.env.CANARY_OPEN_ID || '').trim();
const STATE_FILE = path.join(config.dataDir, 'canary.json');

/** Hỏng bao nhiêu lần liên tiếp mới báo. Một lần có thể chỉ là nghẽn mạng. */
const FAIL_THRESHOLD = 2;

/**
 * Tool ĐỌC. Nhóm ghi nằm ở canary-write.js: probe ghi phải tự dọn nên chúng cần
 * nhiều bước (ghi → đọc lại đối chiếu → xoá), không gói vào một cặp [ten, args].
 */
function readProbes() {
  const now = Math.floor(Date.now() / 1000);
  return [
    ['lark_whoami', {}],
    ['im_chat_list', { page_size: 1 }],
    ['task_search', { page_size: 1 }],
    ['wiki_space_list', { page_size: 1 }],
    ['okr_cycle_list', {}],
    ['contact_search_user', { query: 'a' }],
    ['drive_search', { query: 'a' }],
    ['minutes_search', { query: 'a' }],
    ['calendar_agenda', { start_time: String(now), end_time: String(now + 86400) }],
  ];
}

const loadState = () => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return {};
  }
};
const saveState = (s) => {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2));
  } catch (e) {
    console.error('[canary] không ghi được state:', e.message);
  }
};

/** Gộp probe đọc và ghi về cùng một dạng `{ name, args, run }`. */
async function allProbes(api, state) {
  const list = [];
  for (const [name, args] of readProbes()) {
    const spec = TOOLS.find((t) => t.name === name);
    if (spec) list.push({ name, args, run: () => execSpec(spec, args, api) });
  }
  if (!writeEnabled) return list;

  try {
    list.push(...(await writeProbes(api, state)));
  } catch (e) {
    // Dựng khu nháp hỏng thì báo như một probe hỏng, đừng làm chết cả canary
    list.push({
      name: 'canary_write_setup',
      args: {},
      run: () => {
        throw new Error(`không dựng được khu nháp: ${e.message}`);
      },
    });
  }
  return list;
}

/**
 * Ghi audit CÓ CHỌN LỌC.
 *
 * Canary chạy mỗi giờ và hầu như luôn xanh. Ghi mọi lượt là đổ ~260 dòng/ngày
 * toàn "vẫn ổn" vào đúng cái bảng dùng để tra "ai đã làm gì" — đã có lúc canary
 * chiếm 44% bảng mà 100% số đó là ok=true, không dòng nào mang thông tin.
 *
 * Chỉ ghi dòng nào TRẢ LỜI ĐƯỢC một câu hỏi:
 *   - tool lỗi              → dấu vết để soi lúc sự cố
 *   - vừa chạy lại được     → mốc kết thúc sự cố
 *   - nhịp tim mỗi ngày một → chứng minh canary còn sống
 *
 * Nhịp tim không phải thừa: bỏ nó đi thì canary chết âm thầm trông y hệt "mọi
 * thứ đều ổn" — không dòng nào, không cảnh báo nào, và không ai biết mình đã
 * mất hệ thống phát hiện từ bao giờ.
 */
const today = () => new Date().toISOString().slice(0, 10);

async function runOnce() {
  const state = loadState();
  const api = apiFor(() => getValidAccessToken(OPEN_ID), { openId: OPEN_ID, name: 'canary' });

  const broke = [];
  const healed = [];
  const probes = await allProbes(api, state);
  const startedRun = Date.now();
  let failing = 0;

  for (const { name, args, run } of probes) {
    const started = Date.now();
    let ok = true;
    let err = null;
    let code = null;
    try {
      await run();
    } catch (e) {
      ok = false;
      err = e.message;
      code = e.code;
    }

    const prev = state[name] || { fails: 0, alerted: false };
    // Lượt xanh nối tiếp lượt xanh không nói thêm được gì; lượt xanh ngay sau
    // một chuỗi lỗi thì có — nó là mốc "hết hỏng từ đây".
    if (!ok || prev.fails > 0) {
      auditToolCall({
        openId: OPEN_ID,
        userName: 'canary',
        clientId: 'canary',
        toolName: name,
        args,
        ok,
        errorMsg: err,
        larkCode: code,
        durationMs: Date.now() - started,
      });
    }
    if (!ok) failing++;

    if (ok) {
      if (prev.alerted) healed.push(name);
      state[name] = { fails: 0, alerted: false };
    } else {
      const fails = prev.fails + 1;
      // Báo đúng một lần cho mỗi lần hỏng, không lặp lại mỗi giờ — cảnh báo
      // lặp là thứ khiến người ta tắt thông báo rồi bỏ lỡ lần sau.
      if (fails >= FAIL_THRESHOLD && !prev.alerted) broke.push({ name, err, code });
      state[name] = { fails, alerted: prev.alerted || fails >= FAIL_THRESHOLD, lastError: err, larkCode: code };
    }
  }

  // Nhịp tim: đúng một dòng mỗi ngày, mang số liệu tổng của lượt chạy.
  // `__meta` không phải tên tool nên không đụng vòng lặp phía trên.
  const meta = state.__meta || {};
  if (meta.heartbeat !== today()) {
    state.__meta = { ...meta, heartbeat: today() };
    auditToolCall({
      openId: OPEN_ID,
      userName: 'canary',
      clientId: 'canary',
      toolName: 'canary_heartbeat',
      args: { probes: probes.length, failing },
      ok: failing === 0,
      errorMsg: failing ? `${failing}/${probes.length} probe đang lỗi` : null,
      durationMs: Date.now() - startedRun,
    });
  }

  saveState(state);

  if (broke.length) {
    const lines = broke.map((b) => `• ${b.name}${b.code ? ` (mã ${b.code})` : ''}\n  ${b.err}`);
    await dm(`⚠️ Lark MCP — ${broke.length} tool hỏng ${FAIL_THRESHOLD} lần liên tiếp:\n\n${lines.join('\n')}`);
  }
  if (healed.length) await dm(`✅ Lark MCP — đã chạy lại: ${healed.join(', ')}`);

  const bad = Object.values(state).filter((s) => s?.fails > 0).length;
  const writes = probes.length - readProbes().length;
  console.log(`[canary] ${probes.length} tool (${writes} ghi), ${bad} đang lỗi`);
}

/**
 * Nhiễu ±25% quanh chu kỳ. Chu kỳ cố định có điểm mù: nó rơi vào đúng những
 * mốc đồng hồ giống nhau mỗi ngày, nên một sự cố lặp lại theo giờ — bảo trì
 * hằng đêm, job nặng chạy đúng phút :00 — có thể bị hụt đều đặn và canary báo
 * xanh suốt trong khi người dùng vẫn gặp lỗi.
 *
 * Hẹn từng lượt bằng setTimeout thay vì setInterval, vì mỗi lượt cần một
 * khoảng cách khác nhau.
 */
const JITTER = 0.25;
const nextDelay = () => EVERY_MIN * 60_000 * (1 + (Math.random() * 2 - 1) * JITTER);

export function startCanary() {
  if (!EVERY_MIN) return console.log('  canary : TẮT (CANARY_EVERY_MIN=0)');
  if (!OPEN_ID) return console.log('  canary : TẮT (thiếu CANARY_OPEN_ID)');

  const perDay = (24 * 60) / EVERY_MIN;
  console.log(
    `  canary : ~${perDay.toFixed(1)} lượt/ngày (${EVERY_MIN} phút ±${JITTER * 100}%), DM tới ${alertTarget().slice(0, 12)}…` +
      (writeEnabled ? ' (có probe ghi)' : ' (chỉ đọc — CANARY_WRITE=0)'),
  );

  const tick = () => {
    runOnce()
      .catch((e) => console.error('[canary]', e.message))
      // Hẹn lượt sau khi lượt này XONG, không phải khi nó bắt đầu — lượt chạy
      // lâu bất thường sẽ không bị lượt kế chồng lên.
      .finally(() => setTimeout(tick, nextDelay()).unref());
  };
  // Chạy ngay một lượt để biết trạng thái lúc khởi động, đừng đợi hết chu kỳ
  setTimeout(tick, 15_000).unref();
}
