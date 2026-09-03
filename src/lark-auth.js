import { config } from './config.js';
import { larkApi, fetchRetry } from './lark.js';
import { getUser, saveUser, withUserLock } from './store.js';
import { auditAuth } from './audit.js';

const FORM = { 'Content-Type': 'application/x-www-form-urlencoded' };
const form = (o) => new URLSearchParams(o).toString();

/**
 * Device flow (RFC 8628) — không cần redirect URI, không cần quyền vào
 * Developer Console. Hai bước nằm trên HAI HOST khác nhau, đây là chi tiết
 * không có trong tài liệu Lark:
 *   xin mã    → accounts.larksuite.com/oauth/v1/device_authorization
 *   đổi token → open.larksuite.com/open-apis/authen/v2/oauth/token
 * Gọi nhầm host trả HTML 404 chứ không phải JSON lỗi.
 */
export async function startDeviceFlow(extraScopes = []) {
  const scope = [...new Set([...config.scopes, ...extraScopes])].join(' ');
  const res = await fetchRetry(`${config.accountsBase}/oauth/v1/device_authorization`, {
    method: 'POST',
    headers: FORM,
    // Basic auth bị từ chối (20140 invalid_client) — phải để secret trong body
    body: form({ client_id: config.appId, client_secret: config.appSecret, scope }),
  });
  const j = await res.json().catch(() => ({}));
  if (!j.device_code) throw new Error(`Không xin được device code: ${j.error || res.status} ${j.error_description || ''}`);
  return {
    deviceCode: j.device_code,
    userCode: j.user_code,
    verifyUrl: j.verification_uri_complete || j.verification_uri,
    expiresIn: j.expires_in || 600,
    interval: j.interval || 5,
  };
}

async function tokenEndpoint(params) {
  const res = await fetchRetry(`${config.openBase}/open-apis/authen/v2/oauth/token`, {
    method: 'POST',
    headers: FORM,
    body: form({ client_id: config.appId, client_secret: config.appSecret, ...params }),
  });
  const text = await res.text();
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`token endpoint trả non-JSON (${res.status}): ${text.slice(0, 100)}`);
  }
  return j;
}

/**
 * Một nhịp poll. Trả {status: 'pending'|'slow_down'|'done'|'network'|'error'}.
 *
 * 'network' tách riêng khỏi 'error': lỗi mạng thoáng qua KHÔNG được phép huỷ
 * phiên đăng nhập. Người dùng có 10 phút để bấm nút, trong 10 phút đó chỉ cần
 * một cú fetch hỏng là mất cả phiên nếu coi mọi lỗi như nhau.
 */
export async function pollDeviceFlow(deviceCode) {
  let j;
  try {
    j = await tokenEndpoint({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: deviceCode,
    });
  } catch (e) {
    return { status: 'network', description: e.message };
  }
  if (j.access_token) return { status: 'done', tokens: j };
  if (j.error === 'authorization_pending') return { status: 'pending' };
  if (j.error === 'slow_down') return { status: 'slow_down' };
  return { status: 'error', error: j.error || 'unknown', description: j.error_description || '' };
}

/** Lưu token kèm hạn tuyệt đối + open_id lấy từ chính token đó. */
export async function persistTokens(tokens) {
  const me = await larkApi('GET', '/open-apis/authen/v1/user_info', { token: tokens.access_token });
  const openId = me.data.open_id;
  saveUser(openId, {
    openId,
    name: me.data.name,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token || null,
    accessExpiresAt: Date.now() + (tokens.expires_in || 7200) * 1000,
    refreshExpiresAt: Date.now() + (tokens.refresh_token_expires_in || 604800) * 1000,
    scope: tokens.scope || '',
    updatedAt: Date.now(),
  });
  auditAuth({ event: 'lark_login', openId, userName: me.data.name, detail: { scope: tokens.scope || null } });
  return { openId, name: me.data.name };
}

export class ReauthRequired extends Error {
  constructor(msg) {
    super(msg);
    this.reauth = true;
  }
}

/**
 * Ghi lại rồi trả về lỗi để `throw`. Một sự cố = ĐÚNG một dòng: refresh hỏng
 * bao giờ cũng dẫn tới ReauthRequired, nên ghi riêng thêm một dòng "refresh
 * failed" chỉ là đếm cùng một chuyện hai lần. Lý do nằm trong `error_msg`.
 */
function reauth(openId, userName, reason) {
  auditAuth({ event: 'reauth_required', openId, userName, ok: false, errorMsg: reason });
  return new ReauthRequired(reason);
}

/**
 * Xoay token NGAY. Chỉ gọi khi ĐANG giữ khoá của user này.
 *
 * Tách khỏi `getValidAccessToken` để `forceRefresh` dùng lại được cùng một
 * đoạn: hai đường vào khác nhau ở chỗ CÓ ĐI HAY KHÔNG, còn cách đi thì phải
 * giống hệt — nhất là chuyện ghi đè refresh token mới.
 */
async function rotate(openId, u) {
  if (!u.refreshToken) throw reauth(openId, u.name, 'Không có refresh token — cần đăng nhập lại (thiếu scope offline_access).');
  if (Date.now() > u.refreshExpiresAt) throw reauth(openId, u.name, 'Refresh token đã quá 7 ngày — cần đăng nhập lại.');

  const j = await tokenEndpoint({ grant_type: 'refresh_token', refresh_token: u.refreshToken });
  if (!j.access_token) {
    throw reauth(openId, u.name, `Refresh thất bại (${j.error || '?'}) — cần đăng nhập lại.`);
  }

  saveUser(openId, {
    ...u,
    accessToken: j.access_token,
    // Lark XOAY refresh token mỗi lần dùng. Phải ghi đè cái mới, nếu không
    // lần refresh sau sẽ reuse token đã chết và mất session.
    refreshToken: j.refresh_token || u.refreshToken,
    accessExpiresAt: Date.now() + (j.expires_in || 7200) * 1000,
    refreshExpiresAt: j.refresh_token_expires_in
      ? Date.now() + j.refresh_token_expires_in * 1000
      : u.refreshExpiresAt,
    updatedAt: Date.now(),
  });
  return j.access_token;
}

/**
 * Lấy access token còn hạn của một user, tự refresh nếu cần.
 *
 * Toàn bộ thân hàm nằm trong khoá theo user, và ĐỌC LẠI trạng thái sau khi
 * giành được khoá. Nếu không double-check, call thứ hai đang xếp hàng sẽ refresh
 * lần nữa bằng refresh_token vừa bị Lark giết → thu hồi cả chuỗi.
 */
export function getValidAccessToken(openId) {
  return withUserLock(openId, async () => {
    const u = getUser(openId);
    if (!u) throw reauth(openId, null, 'Chưa đăng nhập Lark.');

    if (Date.now() < u.accessExpiresAt - 120_000) return u.accessToken; // còn >2 phút thì dùng luôn

    return rotate(openId, u);
  });
}

/**
 * Xoay token DÙ access token còn hạn — dùng cho lệnh gia hạn chạy tay.
 *
 * Vì sao không dùng `getValidAccessToken`: cửa sổ 7 ngày chỉ trượt khi ta THẬT
 * SỰ gọi token endpoint. Access token sống 2 tiếng, nên gọi một tool bất kỳ
 * (whoami chẳng hạn) ngay sau một lượt keepalive sẽ dùng lại token còn hạn và
 * không xoay gì cả: `refreshExpiresAt` đứng nguyên. Một cái nút "gia hạn ngay"
 * đi đường đó sẽ báo thành công mà hạn không nhích một giờ.
 *
 * Đắt hơn một chút (luôn một request tới Lark) nên KHÔNG dùng cho đường tool
 * call bình thường — chỗ đó cần token còn hạn, không cần token mới.
 */
export function forceRefresh(openId) {
  return withUserLock(openId, async () => {
    const u = getUser(openId);
    if (!u) throw reauth(openId, null, 'Chưa đăng nhập Lark.');
    return rotate(openId, u);
  });
}
