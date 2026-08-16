import { sb, requireSupabase } from '../sb.mjs';
import { DIM_BY_KEY } from '../explore-schema.mjs';
import { resolveRange } from '../range.mjs';
import { EXPLORE_COLS, aggregate } from '../explore-compute.mjs';

/**
 * Gộp số audit_logs theo MỘT cột do người xem chọn.
 *
 *   GET /api/explore?dim=tool_name&days=30&user=…
 *
 * Trả về MỌI phép đo cho từng nhóm trong một lần gọi, không chỉ phép đo đang
 * hiện. Đổi từ "lượt gọi" sang "tỉ lệ lỗi" là đổi cách nhìn cùng một tập số —
 * bắt trang đi vòng lại máy chủ chỉ để đọc cột khác của cùng hàng đó là thêm
 * một giây chờ cho thao tác đáng lẽ tức thì.
 *
 * Gộp ở PHÍA MÁY CHỦ chứ không đẩy hàng thô về: hàng thô mang theo error_msg
 * và open_id, mà trang này chỉ cần con số.
 */
export default async function handler(req, res) {
  if (!requireSupabase(res)) return;

  const dim = DIM_BY_KEY.get(String(req.query?.dim || 'tool_name'));
  if (!dim) return res.status(400).json({ error: 'Cột không hợp lệ.' });

  /**
   * Khoảng đến từ query string. resolveRange kẹp biên (không quá hôm nay, không
   * dài quá MAX_RANGE_DAYS) và không bao giờ ném lỗi — trần độ dài ở đây không
   * phải để cho đẹp mà để vòng lặp đọc trang bên dưới không kéo dài quá thời
   * gian sống của hàm serverless.
   */
  const range = resolveRange(req.query || {});
  // Luôn bỏ __auth.* và canary: chúng là nhịp tim của hệ thống, không phải
  // người dùng gọi tool. Trước đây có ô tick để bật — nhưng bật lên thì mọi
  // biểu đồ theo ngày có một sàn phẳng do canary tạo, che mất hình dạng thật.
  const include = 'tools';
  // Lọc theo người / ứng dụng khớp CHÍNH XÁC chuỗi ở phía máy chủ sau khi đã đọc
  // về, không ghép vào truy vấn PostgREST — tên có dấu phẩy và ngoặc, mà cú pháp
  // lọc của PostgREST lại dùng đúng hai ký tự đó làm dấu phân cách.
  const user = String(req.query?.user || '').slice(0, 200);
  const app = String(req.query?.app || '').slice(0, 80);

  const { since, until } = range;
  // Chốt cứng source='url': chỉ theo dõi MCP remote. Bản zip ghi chung bảng
  // nhưng để lẫn vào thì mọi con số phải kèm câu hỏi 'của bản nào?'.
  const filter = '&source=eq.url';

  /**
   * `client_app` chỉ có sau supabase/audit-client-app.sql. PostgREST KHÔNG bỏ
   * qua cột lạ trong `select` — nó trả 400 và cả endpoint chết theo 502. Nên
   * đọc kèm cột đó trước, hụt thì đọc lại không kèm: mất một cột còn hơn mất
   * cả khu "Đào sâu". Cùng nguyên tắc với readMachines ở compute.mjs.
   */
  const page = async (cols, off) => sb(
    `audit_logs?created_at=gte.${since}&created_at=lt.${until}${filter}`
    + `&select=${cols.join(',')}&order=created_at.asc&limit=1000&offset=${off}`,
  );
  const WITHOUT = EXPLORE_COLS.filter((c) => c !== 'client_app');

  try {
    let cols = EXPLORE_COLS;
    const rows = [];
    // PostgREST trả tối đa 1000 dòng một lần. Trần 200k là chốt chặn cho vòng
    // lặp, không phải giới hạn thiết kế — 90 ngày hiện ở mức vài nghìn dòng.
    for (let off = 0; off < 200000; off += 1000) {
      let chunk;
      try {
        chunk = await page(cols, off);
      } catch (e) {
        if (cols === WITHOUT) throw e;
        cols = WITHOUT;
        chunk = await page(cols, off);
      }
      rows.push(...chunk);
      if (chunk.length < 1000) break;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      generatedAt: new Date().toISOString(),
      range: { from: range.from, to: range.to, preset: range.preset, days: range.days, clamped: range.clamped },
      ...aggregate({ rows, dim: dim.key, include, user, app }),
    });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
