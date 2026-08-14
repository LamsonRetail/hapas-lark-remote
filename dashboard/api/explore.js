import { sb, requireSupabase } from '../sb.mjs';
import { DIM_BY_KEY, WINDOWS } from '../explore-schema.mjs';
import { EXPLORE_COLS, aggregate } from '../explore-compute.mjs';

/**
 * Gộp số audit_logs theo MỘT cột do người xem chọn.
 *
 *   GET /api/explore?dim=tool_name&days=30&source=url&include=tools
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

  const days = WINDOWS.includes(+req.query?.days) ? +req.query.days : 30;
  const source = ['url', 'zip', 'all'].includes(req.query?.source) ? req.query.source : 'url';
  const include = req.query?.include === 'all' ? 'all' : 'tools';
  // Lọc theo người khớp CHÍNH XÁC chuỗi ở phía máy chủ sau khi đã đọc về, không
  // ghép vào truy vấn PostgREST — tên có dấu phẩy và ngoặc, mà cú pháp lọc của
  // PostgREST lại dùng đúng hai ký tự đó làm dấu phân cách.
  const user = String(req.query?.user || '').slice(0, 200);

  const since = new Date(Date.now() - days * 86400000).toISOString();
  const filter = source === 'all' ? '' : `&source=eq.${source}`;

  try {
    const rows = [];
    // PostgREST trả tối đa 1000 dòng một lần. Trần 200k là chốt chặn cho vòng
    // lặp, không phải giới hạn thiết kế — 90 ngày hiện ở mức vài nghìn dòng.
    for (let off = 0; off < 200000; off += 1000) {
      const chunk = await sb(
        `audit_logs?created_at=gte.${since}${filter}&select=${EXPLORE_COLS.join(',')}&order=created_at.asc&limit=1000&offset=${off}`,
      );
      rows.push(...chunk);
      if (chunk.length < 1000) break;
    }

    res.setHeader('Cache-Control', 'no-store');
    res.json({ generatedAt: new Date().toISOString(), days, source, ...aggregate({ rows, dim: dim.key, include, user }) });
  } catch (e) {
    res.status(502).json({ error: e.message });
  }
}
