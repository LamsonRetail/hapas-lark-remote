import { requireAdmin } from '../sb.mjs';

/**
 * Chuyển tiếp lệnh "gia hạn token ngay" từ trang sang server MCP.
 *
 * Vì sao phải đi vòng qua đây, thay vì trang gọi thẳng server MCP:
 *
 *   1. Trình duyệt KHÔNG được giữ token quản trị của server. Trang này ở URL
 *      công khai; nhét token vào JS là phát nó cho cả internet. Ở đây trang chỉ
 *      gửi `DASHBOARD_ADMIN_TOKEN` (thứ người vận hành dán tay), còn
 *      `MCP_ADMIN_TOKEN` nằm trong biến môi trường Vercel và không bao giờ đi
 *      xuống trình duyệt.
 *   2. Không phải dựng CORS trên server MCP — hai máy chủ nói với nhau, không
 *      có preflight nào.
 *
 * Biến môi trường cần đặt trên Vercel:
 *   DASHBOARD_ADMIN_TOKEN  — cổng cho trang (đã dùng chung với requireAdmin)
 *   MCP_SERVER_URL         — https://…ts.net, chính URL công khai của server
 *   MCP_ADMIN_TOKEN        — bằng ADMIN_TOKEN trong .env của server
 *
 * Thiếu bất kỳ biến nào thì trả 503 kèm tên biến còn thiếu. Nút trên trang chỉ
 * hiện khi /api/data báo `canRefresh`, nên đường này gần như không bị gọi oan —
 * nhưng ai gõ tay vào URL cũng phải nhận được câu trả lời nói rõ thiếu gì.
 */

// Gia hạn 39 người, mỗi người một vòng tới Lark: cứ để rộng tay. Vercel cắt
// hàm ở `maxDuration` trong vercel.json, nên chừa lại vài giây để còn kịp trả
// lời tử tế thay vì bị chặt giữa câu.
const TIMEOUT_MS = 50_000;

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Chỉ hỗ trợ POST.' });
  }
  if (!requireAdmin(req, res)) return;

  const base = (process.env.MCP_SERVER_URL || '').trim().replace(/\/+$/, '');
  const token = (process.env.MCP_ADMIN_TOKEN || '').trim();
  const missing = [!base && 'MCP_SERVER_URL', !token && 'MCP_ADMIN_TOKEN'].filter(Boolean);
  if (missing.length) {
    return res.status(503).json({ error: `Chưa đặt ${missing.join(' / ')} trên Vercel.` });
  }

  const hours = Number(req.body?.hours);

  let r;
  try {
    r = await fetch(`${base}/admin/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
      body: JSON.stringify({ hours: Number.isFinite(hours) ? hours : 48 }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (e) {
    /**
     * Server MCP chạy trên một máy ở công ty, sau Tailscale Funnel. Mất điện,
     * ai đó đóng cửa sổ console, funnel tắt — đều đổ về đây. Nói thẳng là
     * KHÔNG GỌI ĐƯỢC MÁY CHỦ, đừng để người bấm đoán là token sai.
     */
    return res.status(504).json({ error: `Không gọi được server MCP (${base}): ${e.message}` });
  }

  const text = await r.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    // 404 HTML nghĩa là server chạy nhưng chưa đặt ADMIN_TOKEN: route không tồn tại.
    return res.status(502).json({
      error: r.status === 404
        ? 'Server MCP chưa bật endpoint quản trị — đặt ADMIN_TOKEN trong .env rồi khởi động lại.'
        : `Server MCP trả về ${r.status}: ${text.slice(0, 200)}`,
    });
  }

  res.setHeader('Cache-Control', 'no-store');
  res.status(r.status).json(body);
}
