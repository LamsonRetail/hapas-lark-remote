import { computeDashboard } from '../compute.mjs';
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
 */

const SB_URL = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
const SB_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const url = /^https?:\/\//i.test(SB_URL) ? SB_URL : SB_URL && `https://${SB_URL}.supabase.co`;


export default async function handler(req, res) {
  if (!url || !SB_KEY) return res.status(500).json({ error: 'Thiếu SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' });

  const sb = async (p) => {
    const r = await fetch(`${url}/rest/v1/${p}`, {
      headers: { apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}` },
      signal: AbortSignal.timeout(20000),
    });
    if (!r.ok) throw new Error(`${p.slice(0, 60)} → ${r.status}`);
    return r.json();
  };

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
    res.json(data);
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
