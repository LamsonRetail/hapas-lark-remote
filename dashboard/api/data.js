import { computeDashboard } from '../compute.mjs';
import { resolveRange } from '../range.mjs';
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
 *   DASHBOARD_ADMIN_TOKEN                     — cổng cho mọi endpoint có ghi
 *   MCP_SERVER_URL, MCP_ADMIN_TOKEN           — để api/refresh.js gọi được server
 */
export default async function handler(req, res) {
  if (!requireSupabase(res)) return;

  try {
    /**
     * Khoảng + bộ lọc đến từ query string, tức là từ NGƯỜI NGOÀI — resolveRange
     * kẹp biên và không bao giờ ném lỗi, nên một URL viết sai chỉ rơi về mốc mặc
     * định chứ không làm trắng trang. Cắt độ dài chuỗi lọc vì chúng chỉ dùng để
     * so bằng trong bộ nhớ, không ghép vào truy vấn PostgREST (tên người có dấu
     * phẩy và ngoặc — đúng hai ký tự PostgREST dùng làm dấu phân cách).
     */
    const data = await computeDashboard({
      sb,
      toolNames,
      appId: process.env.LARK_APP_ID || '',
      range: resolveRange(req.query || {}),
      user: String(req.query?.user || '').slice(0, 200),
      app: String(req.query?.app || '').slice(0, 80),
    });
    // Cache Ở EDGE, có chủ đích. Trước đây để `no-store` vì "real-time", nhưng
    // mỗi tab poll lại kéo NGUYÊN cửa sổ audit từ Supabase — đó chính là thứ đẩy
    // egress vượt hạn mức và suýt bị khoá project. Giờ để edge giữ một bản ~50s:
    // N tab / N người xem trùng nhau gộp còn ĐÚNG một lần đọc Supabase mỗi khoảng
    // đó. `max-age=0` nên trình duyệt không tự giữ bản cũ; poll cách nhau 60s nên
    // staleness tối đa ~một chu kỳ — chấp nhận được cho bảng vận hành, rẻ hơn
    // nhiều so với bị Supabase restrict. stale-while-revalidate: trả bản gần đúng
    // ngay rồi làm mới ở nền, người xem không phải chờ vòng đọc lại.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=50, stale-while-revalidate=120');
    /**
     * Trang cần biết nút nào dùng được, mà KHÔNG được biết token là gì.
     *
     * `canRefresh` đòi đủ CẢ BA biến: thiếu một cái là nút bấm vào chỉ để nhận
     * 503. Nút không hiện thì người vận hành đi đọc lỗi ở đâu — nên chỗ nào tắt
     * nút, chỗ đó phải nói được vì sao, xem `refreshNote` trong template.
     */
    const dashToken = (process.env.DASHBOARD_ADMIN_TOKEN || '').trim();
    res.json({
      ...data,
      canWrite: Boolean(dashToken),
      canRefresh: Boolean(dashToken && (process.env.MCP_SERVER_URL || '').trim() && (process.env.MCP_ADMIN_TOKEN || '').trim()),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
