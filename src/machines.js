import crypto from 'node:crypto';
import { config } from './config.js';
import { sbEnabled, sbFetch } from './supabase.js';

/**
 * Ghi danh tính người dùng bản remote vào bảng `machines` — cùng bảng với
 * client zip, phân biệt bằng TIỀN TỐ `machine_id = 'url-…'`.
 *
 * Nhãn nguồn nằm ở `channel = 'mcp remote'`, song song với
 * `audit_logs.source = 'url'`. Constraint gốc `machines_channel_check` chỉ nhận
 * 'stable' | 'beta' | NULL (kênh CẬP NHẬT của client zip) nên phải nới bằng
 * supabase/machines-remote.sql; chưa chạy migration thì code tự bỏ `channel`
 * và `user_id` ra rồi gửi lại — xem DEGRADABLE.
 *
 * VÌ SAO CẦN: `machines` là sổ đăng ký bản CÀI ĐẶT — mỗi dòng một máy có CLI
 * cài trên đó. Bản remote không có bản cài nào để đăng ký, nên trước đây ai
 * dùng qua URL đều không xuất hiện ở bảng này; dashboard đếm người dùng bằng
 * `machines` sẽ báo thiếu đúng bằng số người dùng bản remote.
 *
 * MỘT DÒNG = MỘT CẶP (người, chỗ cắm). Server chỉ nhận HTTP request nên không
 * có cách nào biết máy của người gọi: `hostname`/`os` để NULL thật thà, thay vì
 * đoán. Cái phân biệt được là `client_id` do client tự đăng ký qua DCR — cùng
 * một người cắm Claude desktop và Claude web sẽ ra hai dòng, và không có cách
 * nào biết đó là cùng một máy.
 *
 * `client_app` trả lời "người này dùng CÁI GÌ để nối vào": Claude, Codex,
 * Claude Code… Lấy từ `client_name` mà client tự khai lúc đăng ký DCR. Đây là
 * lời tự khai, KHÔNG phải danh tính đã xác thực — ai cũng đăng ký được với tên
 * bất kỳ. Dùng để thống kê, đừng dùng để phân quyền.
 *
 * Cùng ba nguyên tắc với audit.js: không bao giờ làm hỏng luồng gọi, không
 * chặn, và lỗi ghi thì chỉ log ra chứ không ném lên.
 */

/** Nhãn nguồn của dòng, song song với `audit_logs.source = 'url'`. */
const CHANNEL = 'mcp remote';

/** machine_id của client zip là 16 ký tự hex; thêm tiền tố để không đụng PK. */
export const machineIdFor = (openId, clientId) =>
  'url-' + crypto.createHash('sha256').update(`${openId}|${clientId}`).digest('hex').slice(0, 12);

/**
 * Nhãn cho người đọc dashboard. Giữ NGUYÊN `client_id` chứ không cắt ngắn: đây
 * là thứ duy nhất nối dòng này với `audit_logs.client_id`, cắt đi là mất đường
 * truy về xem chỗ cắm đó đã gọi những gì.
 */
const labelFor = (openId, name, clientId, clientApp) =>
  `${name || openId} — ${clientApp || 'connector'} ${clientId || '?'} (url)`;

const row = (machineId) => `machines?machine_id=eq.${encodeURIComponent(machineId)}&app_id=eq.${encodeURIComponent(config.appId)}`;

/**
 * Hai field chỉ ghi được SAU khi chạy supabase/machines-remote.sql:
 *   user_id → cột chưa tồn tại  (PostgREST: "Could not find the 'x' column")
 *   channel → 'mcp remote' chưa nằm trong machines_channel_check (23514)
 *
 * Cả hai đều làm Lark/PostgREST từ chối CẢ request chứ không bỏ qua field lạ,
 * nên không xử lý là mất sạch dòng chứ không phải mất một field — đúng cái bẫy
 * đã dính với `audit_logs.error_msg`, xem audit.js. Quên đi sau 30 phút để chạy
 * migration xong là dùng lại được ngay, không cần restart server.
 */
const RECHECK_MS = 30 * 60_000;

const DEGRADABLE = [
  {
    field: 'user_id',
    detect: (t) => /Could not find the 'user_id' column/.test(t),
    why: "bảng machines chưa có cột 'user_id'",
  },
  {
    field: 'client_app',
    detect: (t) => /Could not find the 'client_app' column/.test(t),
    why: "bảng machines chưa có cột 'client_app'",
  },
  {
    field: 'channel',
    detect: (t) => /machines_channel_check/.test(t),
    why: "constraint machines_channel_check chưa nhận 'mcp remote'",
  },
];

const rejectedAt = new Map(); // field -> lúc bị từ chối

function usableFields() {
  const now = Date.now();
  for (const [f, at] of rejectedAt) if (now - at > RECHECK_MS) rejectedAt.delete(f);
  return DEGRADABLE.filter((d) => !rejectedAt.has(d.field)).map((d) => d.field);
}

/** Field nào vừa bị từ chối? Trả về tên field để bỏ ra, hoặc null nếu lỗi khác. */
function noteRejected(text) {
  for (const d of DEGRADABLE) {
    if (!d.detect(text)) continue;
    if (!rejectedAt.has(d.field)) {
      console.error(`[machines] ${d.why} — tạm bỏ '${d.field}'. Chạy supabase/machines-remote.sql để ghi đủ.`);
    }
    rejectedAt.set(d.field, Date.now());
    return d.field;
  }
  return null;
}

async function warn(label, res) {
  if (res.ok) return true;
  console.error(`[machines] ${label} thất bại ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return false;
}

/**
 * Gọi khi phát bearer thành công — tức là user đã duyệt trên Lark xong. Chạy
 * cả ở lần cắm đầu tiên (authorization_code) và mỗi lần xoay refresh_token,
 * nên `last_seen` không bao giờ cũ hơn lần xoay token gần nhất.
 */
export function recordAuth({ openId, name, clientId, clientApp }) {
  if (!sbEnabled || !openId) return;
  void upsert({ openId, name, clientId, clientApp, activate: true }).catch((e) => console.error(`[machines] ${e.message}`));
}

/**
 * Gửi, và nếu schema chưa sẵn sàng thì bỏ đúng field bị từ chối rồi gửi lại —
 * mất một field còn hơn mất cả dòng. Thử tối đa số lần bằng số field bỏ được,
 * vì lần gửi lại có thể vấp field còn lại.
 */
async function send(label, path, opts) {
  let body = opts.body;
  for (let attempt = 0; attempt <= DEGRADABLE.length; attempt++) {
    const res = await sbFetch(path, { ...opts, body });
    if (res.ok) return true;
    const field = noteRejected(await res.clone().text());
    if (!field) return warn(label, res);
    const strip = (o) => { const { [field]: _drop, ...rest } = o; return rest; };
    body = Array.isArray(body) ? body.map(strip) : strip(body);
  }
  return false;
}

/**
 * `activate` — CHỈ sự kiện auth thật mới được đặt `status`. Tool call thì không:
 * một tool call đang bay lúc người dùng bấm revoke sẽ đáp SAU lệnh PATCH và đẩy
 * dòng vừa thu hồi về 'active' (đã dựng đúng cảnh này trong test). Trạng thái
 * thuộc vòng đời auth, không thuộc hoạt động.
 */
async function upsert({ openId, name, clientId, clientApp, activate = false }) {
  const machineId = machineIdFor(openId, clientId);
  const now = new Date().toISOString();
  const optional = { user_id: openId, channel: CHANNEL, client_app: clientApp || null };
  const withOptional = (o) => {
    const out = { ...o };
    for (const f of usableFields()) out[f] = optional[f];
    return out;
  };

  // Hai bước, không phải một upsert: merge-duplicates sẽ ghi đè `installed_at`
  // mỗi lần xoay token, làm mất mốc "cắm lần đầu khi nào".
  const ok = await send('insert', 'machines', {
    method: 'POST',
    prefer: 'resolution=ignore-duplicates,return=minimal',
    body: [withOptional({
      machine_id: machineId,
      app_id: config.appId,
      display_name: labelFor(openId, name, clientId, clientApp),
      username: name || null,
      hostname: null, // server không thấy máy người gọi, xem ghi chú đầu file
      os: null,
      version: config.version,
      status: 'active',
      installed_at: now,
      last_seen: now,
    })],
  });
  if (!ok) return;

  // Dòng đã có từ trước: cập nhật phần thay đổi được, giữ nguyên installed_at.
  await send('update', row(machineId), {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: withOptional({
      display_name: labelFor(openId, name, clientId, clientApp),
      username: name || null,
      version: config.version,
      ...(activate ? { status: 'active' } : {}),
      last_seen: now,
    }),
  });
}

/**
 * Gọi mỗi tool call. Có throttle vì `last_seen` chính xác tới phút là đủ —
 * không throttle thì mỗi tool call kèm một round-trip Supabase, và người dùng
 * phải chờ nó chỉ để cập nhật một cột thời gian.
 *
 * Dùng lại đúng `upsert` của recordAuth chứ không chỉ PATCH: người đã đăng nhập
 * TRƯỚC khi có tính năng này không có dòng nào để mà PATCH, và access token
 * hạn 30 ngày nên phải đợi tới cả tháng mới có lần xoay token tiếp theo. Cứ
 * insert-nếu-chưa-có thì họ hiện ra ngay lần gọi tool kế tiếp.
 */
const TOUCH_MS = 5 * 60_000;
const lastTouch = new Map();

export function touchMachine({ openId, name, clientId, clientApp }) {
  if (!sbEnabled || !openId) return;
  const key = `${openId}|${clientId}`;
  const now = Date.now();
  if (now - (lastTouch.get(key) || 0) < TOUCH_MS) return;
  // Chặn rò rỉ bộ nhớ nếu có client sinh client_id mới liên tục
  if (lastTouch.size > 500) lastTouch.clear();
  lastTouch.set(key, now);

  void upsert({ openId, name, clientId, clientApp }).catch((e) => console.error(`[machines] touch: ${e.message}`));
}

/**
 * Đánh dấu một chỗ cắm đã bị thu hồi. `status` của bảng chỉ nhận
 * active | revoked | inactive (đã kiểm bằng cách thử từng giá trị).
 *
 * KHÔNG xoá dòng: mất luôn `installed_at` là mất lịch sử "ai từng cắm cái gì,
 * từ khi nào" — đúng thứ mà bảng này tồn tại để trả lời. Cắm lại thì `recordAuth`
 * đưa `status` về active trên chính dòng cũ.
 *
 * `machineIds` rỗng nghĩa là thu hồi mọi chỗ cắm của người này.
 */
export function revokeMachines({ openId, clientIds = [] }) {
  if (!sbEnabled || !openId) return;
  const ids = clientIds.length ? clientIds.map((c) => machineIdFor(openId, c)) : null;
  const path = ids
    ? `machines?machine_id=in.(${ids.map(encodeURIComponent).join(',')})&app_id=eq.${encodeURIComponent(config.appId)}`
    : `machines?user_id=eq.${encodeURIComponent(openId)}&app_id=eq.${encodeURIComponent(config.appId)}`;

  void send('revoke', path, {
    method: 'PATCH',
    prefer: 'return=minimal',
    body: { status: 'revoked', last_seen: new Date().toISOString() },
  }).catch((e) => console.error(`[machines] revoke: ${e.message}`));
}
