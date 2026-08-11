/**
 * Kết nối Supabase dùng chung cho audit.js và machines.js.
 *
 * Tách ra vì cả hai đều cần đúng một thứ: URL + service role key + một hàm
 * fetch có timeout. Trước đây audit.js tự giữ riêng, module thứ hai muốn ghi
 * là phải copy lại phần đọc env — copy thì sớm muộn cũng lệch.
 */

function resolveUrl() {
  const raw = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  // Dashboard hay hiện Reference ID hơn là URL đầy đủ — nhận cả hai
  return /^https?:\/\//i.test(raw) ? raw : `https://${raw}.supabase.co`;
}

export const SB_URL = resolveUrl();
export const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
export const sbEnabled = Boolean(SB_URL && SB_KEY);

/**
 * Gọi PostgREST. `prefer` là chuỗi header Prefer, khác nhau theo từng chỗ dùng:
 *   'return=minimal'                 → không cần đọc lại dòng vừa ghi
 *   'resolution=ignore-duplicates'   → insert-nếu-chưa-có, không đụng dòng cũ
 */
export function sbFetch(path, { method = 'GET', body, prefer, timeoutMs = 10000 } = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    method,
    headers: {
      apikey: SB_KEY,
      Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      ...(prefer ? { Prefer: prefer } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
}
