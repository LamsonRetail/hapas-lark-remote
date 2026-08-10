import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { TOOLS } from './tools/index.js';
import { apiFor, execSpec } from './tools/registry.js';
import { getValidAccessToken } from './lark-auth.js';
import { auditToolCall } from './audit.js';
import { getBotToken, larkApi } from './lark.js';

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
const ALERT_TO = (process.env.CANARY_ALERT_OPEN_ID || OPEN_ID).trim();
const STATE_FILE = path.join(config.dataDir, 'canary.json');

/** Hỏng bao nhiêu lần liên tiếp mới báo. Một lần có thể chỉ là nghẽn mạng. */
const FAIL_THRESHOLD = 2;

/**
 * Chỉ tool ĐỌC. Không tạo, không sửa, không gửi gì — canary chạy mỗi giờ, mãi
 * mãi; bất cứ tool nào có tác dụng phụ sẽ thành rác tích tụ.
 */
function probes() {
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

/** DM as bot. Hỏng thì kệ — cảnh báo chết không được phép làm chết canary. */
async function dm(text) {
  if (!ALERT_TO) return;
  try {
    await larkApi('POST', '/open-apis/im/v1/messages', {
      params: { receive_id_type: 'open_id' },
      body: { receive_id: ALERT_TO, msg_type: 'text', content: JSON.stringify({ text }) },
      token: await getBotToken(),
    });
  } catch (e) {
    console.error('[canary] không gửi được cảnh báo:', e.message);
  }
}

async function runOnce() {
  const state = loadState();
  const api = apiFor(() => getValidAccessToken(OPEN_ID), { openId: OPEN_ID, name: 'canary' });

  const broke = [];
  const healed = [];

  for (const [name, args] of probes()) {
    const spec = TOOLS.find((t) => t.name === name);
    if (!spec) continue;

    const started = Date.now();
    let ok = true;
    let err = null;
    let code = null;
    try {
      await execSpec(spec, args, api);
    } catch (e) {
      ok = false;
      err = e.message;
      code = e.code;
    }

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

    const prev = state[name] || { fails: 0, alerted: false };
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

  saveState(state);

  if (broke.length) {
    const lines = broke.map((b) => `• ${b.name}${b.code ? ` (mã ${b.code})` : ''}\n  ${b.err}`);
    await dm(`⚠️ Lark MCP — ${broke.length} tool hỏng ${FAIL_THRESHOLD} lần liên tiếp:\n\n${lines.join('\n')}`);
  }
  if (healed.length) await dm(`✅ Lark MCP — đã chạy lại: ${healed.join(', ')}`);

  const bad = Object.values(state).filter((s) => s.fails > 0).length;
  console.log(`[canary] ${probes().length} tool, ${bad} đang lỗi`);
}

export function startCanary() {
  if (!EVERY_MIN) return console.log('  canary : TẮT (CANARY_EVERY_MIN=0)');
  if (!OPEN_ID) return console.log('  canary : TẮT (thiếu CANARY_OPEN_ID)');

  console.log(`  canary : mỗi ${EVERY_MIN} phút, cảnh báo DM tới ${ALERT_TO.slice(0, 12)}…`);
  // Chạy ngay một lượt để biết trạng thái lúc khởi động, đừng đợi hết chu kỳ
  const tick = () => runOnce().catch((e) => console.error('[canary]', e.message));
  setTimeout(tick, 15_000).unref();
  setInterval(tick, EVERY_MIN * 60_000).unref();
}
