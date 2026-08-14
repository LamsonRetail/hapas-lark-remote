import { computeDashboard } from '../compute.mjs';
import { sb, requireSupabase } from '../sb.mjs';
// Import thay vì đọc file: hàm serverless được đóng gói riêng, file tĩnh cạnh
// nó không chắc có mặt trong bundle — còn import thì bundler bắt buộc phải kéo theo.
import toolNames from '../tools.json' with { type: 'json' };

/**
 * Số liệu dashboard, tính ở phía máy chủ.
 *
 * Service role key CHỈ tồn tại trong biến môi trường của Vercel và không bao
 * giờ đi xuống trình duyệt — trang chỉ nhận về kết quả đã tính.
 *
 * Biến môi trường cần đặt trên Vercel:
 *   SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY   — nguồn số liệu
 *   LARK_APP_ID                               — chỉ để hiển thị
 *   DASHBOARD_ADMIN_TOKEN                     — cổng cho api/hidden.js
 */
export default async function handler(req, res) {
  if (!requireSupabase(res)) return;

  try {
    const data = await computeDashboard({
      sb,
      toolNames,
      appId: process.env.LARK_APP_ID || '',
    });
    // KHÔNG cache. Trang poll lại mỗi 30s để theo dõi real-time, mà `s-maxage`
    // thì bảo CDN giữ bản cũ tới 60s + phục vụ stale thêm 120s — poll xong vẫn
    // nhận đúng bản cũ đó, tưởng hệ thống đứng yên trong khi nó đang chạy.
    // `no-store` ở vercel.json chỉ chặn cache phía trình duyệt, không chặn edge.
    res.setHeader('Cache-Control', 'no-store');
    // Trang cần biết nút ẩn có dùng được không, mà KHÔNG được biết token là gì.
    res.json({ ...data, canWrite: Boolean((process.env.DASHBOARD_ADMIN_TOKEN || '').trim()) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
