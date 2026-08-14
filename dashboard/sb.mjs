/**
 * Kết nối Supabase + cổng xác thực quản trị, dùng chung cho mọi hàm trong api/.
 *
 * Tách ra vì đã có ba hàm serverless cùng cần đúng một thứ (URL + service role
 * key + fetch có timeout). Trước đây api/data.js tự giữ riêng; thêm hàm thứ hai
 * mà copy lại thì sớm muộn hai bên lệch nhau — đúng lý do src/supabase.js tồn
 * tại ở phía server. Không import thẳng src/supabase.js được: nó kéo theo
 * src/config.js, mà file đó đòi LARK_APP_SECRET — biến không có (và không nên
 * có) trên Vercel.
 */

import crypto from 'node:crypto';

const RAW = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');

// Dashboard Supabase hay hiện Reference ID hơn là URL đầy đủ — nhận cả hai.
export const SB_URL = /^https?:\/\//i.test(RAW) ? RAW : RAW && `https://${RAW}.supabase.co`;
export const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

/** Gọi PostgREST. Ném lỗi kèm status để hàm gọi biết đường trả về 502. */
export async function sb(path, { method = 'GET', body, prefer, timeoutMs = 20000 } = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${path}`, {
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
  if (!r.ok) throw new Error(`${path.slice(0, 60)} → ${r.status} ${(await r.text()).slice(0, 160)}`);
  // 204 (return=minimal) không có thân — đọc .json() sẽ ném.
  return r.status === 204 ? null : r.json();
}

/** Thiếu cấu hình Supabase thì mọi endpoint đều vô nghĩa — chặn ngay đầu vào. */
export function requireSupabase(res) {
  if (SB_URL && SB_KEY) return true;
  res.status(500).json({ error: 'Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });
  return false;
}

/**
 * Cổng cho MỌI endpoint có ghi.
 *
 * Trang này đang ở URL công khai, nên một endpoint ghi không khoá là ai có link
 * cũng ẩn/xoá được dòng. Token đặt ở `DASHBOARD_ADMIN_TOKEN` trên Vercel.
 *
 * CHƯA đặt biến thì TỪ CHỐI, không phải cho qua. Mặc định mở là kiểu hỏng mà
 * nhìn bên ngoài vẫn thấy chạy tốt — đúng đến hôm có người dò ra URL.
 *
 * `timingSafeEqual` chứ không phải `===`: so sánh chuỗi thoát ra ngay ký tự đầu
 * khác nhau, đủ để dò dần từng ký tự qua thời gian phản hồi.
 */
export function requireAdmin(req, res) {
  const want = (process.env.DASHBOARD_ADMIN_TOKEN || '').trim();
  if (!want) {
    res.status(503).json({ error: 'Chưa đặt DASHBOARD_ADMIN_TOKEN trên Vercel — thao tác ghi đang tắt.' });
    return false;
  }
  const got = String(req.headers['x-admin-token'] || '');
  const a = Buffer.from(got), b = Buffer.from(want);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    res.status(401).json({ error: 'Token quản trị không đúng.' });
    return false;
  }
  return true;
}
