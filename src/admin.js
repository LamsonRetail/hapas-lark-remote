import crypto from 'node:crypto';
import express from 'express';
import { TOOLS } from './tools/index.js';
import { apiFor, execSpec } from './tools/registry.js';
import { getUser, listUsers } from './store.js';
import { forceRefresh, getValidAccessToken } from './lark-auth.js';
import { publishTokenExpiry, publishTokenDead } from './machines.js';
import { auditAuth } from './audit.js';

/**
 * Một endpoint quản trị duy nhất: gia hạn token cho những người sắp hết.
 *
 * ĐÂY LÀ ĐƯỜNG GHI MỞ RA INTERNET, và `oauth-as.js` đã từng bỏ `/admin/revoke`
 * đúng vì lý do đó. Cho phép lại ở đây vì blast radius khác hẳn nhau: thu hồi
 * là phá được phiên của người khác, còn gia hạn thì tệ nhất chỉ làm đúng cái
 * việc mà `keepalive` vẫn tự làm mỗi 12 tiếng — kẻ có token cũng không đọc được
 * dữ liệu của ai, không thu hồi được của ai, không cắm thêm được connector nào.
 *
 * Ba lớp chặn, theo thứ tự:
 *   1. Chưa đặt ADMIN_TOKEN thì route KHÔNG tồn tại (404), không phải 401 —
 *      không cấu hình thì không có gì để dò.
 *   2. So token bằng timingSafeEqual, và so TRƯỚC khi đọc body hay đụng store.
 *   3. Mỗi lúc chỉ một lượt chạy. Bấm mười lần thì lượt sau nhận 409, không
 *      phải mười lượt cùng đập vào token endpoint của Lark.
 *
 * Trình duyệt KHÔNG giữ token này: dashboard gọi qua hàm serverless
 * `dashboard/api/refresh.js`, token nằm trong biến môi trường Vercel.
 */

const TOKEN = (process.env.ADMIN_TOKEN || '').trim();
const DEFAULT_HOURS = 48;
const MAX_HOURS = 168; // hơn 7 ngày thì "sắp hết" nghĩa là tất cả mọi người
const CONCURRENCY = 4; // 39 người × ~0.6s tuần tự là quá lâu cho một cú bấm

export const adminEnabled = Boolean(TOKEN);

const WHOAMI = TOOLS.find((t) => t.name === 'lark_whoami');
const hoursLeft = (u) => (u.refreshExpiresAt - Date.now()) / 3_600_000;
const round1 = (n) => Math.round(n * 10) / 10;

let running = false;

function authorized(req) {
  const got = Buffer.from(String(req.headers['x-admin-token'] || ''));
  const want = Buffer.from(TOKEN);
  // Độ dài khác nhau là timingSafeEqual ném lỗi, nên phải chặn trước
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

/** Chạy `fn` cho từng phần tử, nhiều nhất `n` việc cùng lúc. */
async function pool(items, n, fn) {
  const it = items[Symbol.iterator]();
  await Promise.all(
    Array.from({ length: Math.min(n, items.length) }, async () => {
      for (let x = it.next(); !x.done; x = it.next()) await fn(x.value);
    }),
  );
}

/**
 * Gia hạn cho mọi người còn dưới `hours` giờ.
 *
 * Hai bước cho mỗi người, và bước hai không phải cho đẹp:
 *   1. `forceRefresh` — xoay token thật, cửa sổ 7 ngày trượt lại từ đầu.
 *      (Không dùng đường tool call thường: xem ghi chú ở `forceRefresh`.)
 *   2. `lark_whoami` — gọi Lark bằng token VỪA nhận. Token endpoint trả 200 mà
 *      token không dùng được là chuyện có thật (app bị gỡ quyền giữa hai bước),
 *      và đó đúng là thứ phải biết TRƯỚC khi báo với cả phòng là đã gia hạn.
 *
 * Ngưỡng lấy từ store trên máy chủ, KHÔNG lấy từ con số dashboard đang hiện:
 * cột đếm ngược đọc `machines`, mà bảng đó có thể cũ hơn store cả tuần.
 */
export async function refreshDying(hours = DEFAULT_HOURS) {
  const users = listUsers()
    .map((openId) => getUser(openId))
    .filter(Boolean); // giải mã hỏng là việc của store, không phải của endpoint

  const targets = users.filter((u) => hoursLeft(u) > 0 && hoursLeft(u) < hours);
  const expired = users.filter((u) => hoursLeft(u) <= 0).map((u) => u.name || u.openId.slice(0, 12));

  const renewed = [];
  const failed = [];

  await pool(targets, CONCURRENCY, async (u) => {
    const who = u.name || u.openId.slice(0, 12);
    const before = hoursLeft(u);
    try {
      await forceRefresh(u.openId);
      await execSpec(WHOAMI, {}, apiFor(() => getValidAccessToken(u.openId), { openId: u.openId }));
      await publishTokenExpiry(u.openId);
      renewed.push({ name: who, beforeH: round1(before), afterH: round1(hoursLeft(getUser(u.openId))) });
    } catch (e) {
      failed.push({ name: who, reason: e.message });
      // `reauth` là câu trả lời DỨT KHOÁT từ Lark (invalid_grant chẳng hạn):
      // phiên chết dù đồng hồ của ta còn thấy hạn. Lỗi mạng thì không — chưa
      // kết luận được gì, và đánh dấu chết oan sẽ đẩy một người đang dùng tốt
      // vào danh sách phải quét mã lại.
      if (e.reauth) await publishTokenDead(u.openId);
    }
  });

  const out = {
    thresholdH: hours,
    users: users.length,
    matched: targets.length,
    renewed,
    failed,
    // Quá hạn thì không cách nào cứu từ phía server — người đó phải quét mã lại.
    // Trả về để cái nút nói được điều đó thay vì im lặng bỏ qua họ.
    expired,
  };

  auditAuth({
    event: 'admin_refresh',
    ok: failed.length === 0,
    errorMsg: failed.length ? `${failed.length} người không gia hạn được` : null,
    detail: {
      thresholdH: hours,
      matched: targets.length,
      renewed: renewed.length,
      failedCount: failed.length,
      expiredCount: expired.length,
      // Cắt danh sách: audit cắt `args` ở 2000 ký tự và một chuỗi JSON bị cắt
      // giữa chừng thì mất cả dòng, không phải mất phần đuôi.
      names: renewed.slice(0, 10).map((r) => r.name),
      failed: failed.slice(0, 5),
    },
  });

  return out;
}

export function buildAdminRouter() {
  const r = express.Router();
  if (!adminEnabled) return r;

  r.post('/admin/refresh', express.json({ limit: '4kb' }), async (req, res) => {
    if (!authorized(req)) return res.status(401).json({ error: 'Token quản trị không đúng.' });
    if (running) return res.status(409).json({ error: 'Đang có một lượt gia hạn chạy — chờ nó xong.' });

    const asked = Number(req.body?.hours);
    const hours = Number.isFinite(asked) ? Math.min(Math.max(asked, 1), MAX_HOURS) : DEFAULT_HOURS;

    running = true;
    try {
      res.json(await refreshDying(hours));
    } catch (e) {
      console.error('[admin] refresh:', e);
      res.status(500).json({ error: e.message });
    } finally {
      running = false;
    }
  });

  return r;
}
