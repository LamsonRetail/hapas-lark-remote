import { sb, requireAdmin, requireSupabase } from '../sb.mjs';

/**
 * Ẩn / hiện lại một chỗ cắm trên bảng vận hành.
 *
 *   POST   { machineId, label }   → ẩn
 *   DELETE ?machineId=…           → hiện lại
 *
 * KHÔNG xoá gì cả — chỉ ghi machine_id vào `dashboard_hidden` để computeDashboard
 * lọc ra. Lý do đầy đủ nằm ở supabase/dashboard-hidden.sql: mấy dòng 'không rõ'
 * mà người dùng muốn dọn vốn không có bản ghi nào trong `machines`; chúng suy ra
 * từ `audit_logs`, nên "xoá" chúng nghĩa là xoá lịch sử audit.
 *
 * Cả hai thao tác đều qua requireAdmin — trang đang ở URL công khai.
 */
export default async function handler(req, res) {
  if (!requireSupabase(res)) return;

  if (req.method !== 'POST' && req.method !== 'DELETE') {
    res.setHeader('Allow', 'POST, DELETE');
    return res.status(405).json({ error: 'Chỉ nhận POST (ẩn) hoặc DELETE (hiện lại).' });
  }
  if (!requireAdmin(req, res)) return;

  // machine_id đi vào đường dẫn PostgREST ở nhánh DELETE. Chốt khuôn dạng ngay
  // từ đầu — đây là chuỗi băm server tự sinh, không có lý do gì lệch khuôn.
  const raw = req.method === 'POST' ? req.body?.machineId : req.query?.machineId;
  const machineId = String(raw || '').trim();
  if (!/^url-[0-9a-f]{12}$/.test(machineId)) {
    return res.status(400).json({ error: 'machineId không hợp lệ.' });
  }

  res.setHeader('Cache-Control', 'no-store');
  try {
    if (req.method === 'POST') {
      await sb('dashboard_hidden', {
        method: 'POST',
        // Ẩn hai lần không phải lỗi — người dùng bấm lại thì cứ im lặng cho qua.
        prefer: 'resolution=ignore-duplicates,return=minimal',
        body: [{ machine_id: machineId, label: String(req.body?.label || '').slice(0, 200) || null }],
      });
    } else {
      await sb(`dashboard_hidden?machine_id=eq.${encodeURIComponent(machineId)}`, {
        method: 'DELETE',
        prefer: 'return=minimal',
      });
    }
    return res.json({ ok: true, machineId });
  } catch (e) {
    // Bảng chưa tồn tại là lỗi vận hành chứ không phải lỗi người dùng — nói
    // thẳng phải chạy migration nào, thay vì để lại một mã 502 trống trơn.
    const msg = /dashboard_hidden.*(does not exist|404)|PGRST205/i.test(e.message)
      ? 'Chưa có bảng dashboard_hidden — chạy supabase/dashboard-hidden.sql trong SQL Editor.'
      : e.message;
    return res.status(502).json({ error: msg });
  }
}
