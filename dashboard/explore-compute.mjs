import { DIM_BY_KEY } from './explore-schema.mjs';
import { impactedSet } from './impact.mjs';
import { localDay, localHour } from './range.mjs';

/**
 * Gộp hàng audit_logs thô theo MỘT cột.
 *
 * Tách khỏi api/explore.js vì có hai nơi gọi — hàm serverless trên Vercel và
 * build.mjs (nướng số vào bản preview tĩnh). Cùng lý do computeDashboard tồn
 * tại tách khỏi api/data.js: hai bản dashboard cùng tên mà tính riêng thì sớm
 * muộn cho hai con số khác nhau, và không ai biết bên nào đúng.
 */

const pct = (n, d) => (d ? +((n / d) * 100).toFixed(1) : 0);
const quant = (s, q) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null);

/** clientId của công cụ chạy tại chỗ — cùng danh sách computeDashboard loại ra. */
export const SKIP_CLIENTS = new Set(['local-admin', 'canary', 'revoke-test-a']);

/**
 * Cột audit_logs cần đọc để tính được mọi phép đo trong MEASURES.
 * `args` chỉ phục vụ impact.mjs (nhận ra tham số trỏ ra ngoài Lark) — không
 * cột nào trong đó đi xuống trình duyệt, endpoint chỉ trả số đã gộp.
 */
export const EXPLORE_COLS = ['created_at', 'tool_name', 'user_name', 'client_id', 'ok', 'duration_ms', 'lark_code', 'source', 'args', 'client_app'];

export function aggregate({ rows, dim: dimKey, include = 'tools', user = '', app = '' }) {
  const dim = DIM_BY_KEY.get(dimKey);
  if (!dim) throw new Error(`Cột không hợp lệ: ${dimKey}`);

  const inScope = rows.filter((r) => {
    if (SKIP_CLIENTS.has(r.client_id)) return false;
    if (include === 'all') return true;
    // Mặc định bỏ __auth.* và canary: chúng là nhịp tim của hệ thống, không
    // phải người dùng gọi tool. Trộn vào thì mọi biểu đồ theo ngày đều có một
    // sàn phẳng do canary tạo, che mất hình dạng thật của lưu lượng.
    return !String(r.tool_name || '').startsWith('__auth.') && r.tool_name !== 'canary_heartbeat';
  });

  /**
   * Danh sách người/ứng dụng lấy TRƯỚC khi lọc, không phải sau — lọc rồi mới
   * liệt kê thì chọn xong một người là ô chọn chỉ còn đúng người đó, không đổi
   * sang ai được nữa.
   */
  const users = [...new Set(inScope.map((r) => r.user_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
  const apps = [...new Set(inScope.map((r) => r.client_app).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));

  // Nhóm theo tool + lọc một người = "người này đã gọi những tool nào" — mức
  // bóc tách thứ hai mà một cột nhóm đơn lẻ không trả lời được.
  const kept = inScope.filter((r) => (!user || r.user_name === user) && (!app || r.client_app === app));

  /**
   * Tính trên inScope chứ không trên `kept`: luật "được cứu" cần lượt thành
   * công của chính người đó, mà lọc theo cột khác (ví dụ chỉ xem mã lỗi) có
   * thể cắt mất đúng những lượt đó và biến một lỗi đã được cứu thành lỗi thật.
   */
  const blocked = impactedSet(inScope);

  /** Nhãn nhóm. `ok` là boolean, `lark_code` hay null — cả hai cần chữ, không phải "null"/"false". */
  const keyOf = (r) => {
    // Ngày/giờ cắt theo GIỜ VN, không theo UTC — xem ghi chú TZ ở range.mjs.
    if (dim.key === 'day') return localDay(r.created_at);
    if (dim.key === 'hour') return localHour(r.created_at);
    if (dim.key === 'ok') return r.ok === false ? 'Lỗi' : 'Thành công';
    // null = dòng ghi trước khi có cột client_app. Trả null để BỎ HẲN khỏi
    // phép nhóm, xem `skipped` bên dưới.
    if (dim.key === 'client_app') return r.client_app || null;
    return r[dim.col] || '(trống)';
  };

  /**
   * Dòng không có giá trị cho cột đang nhóm thì BỎ, không gom vào một nhóm
   * "(trống)".
   *
   * Đã thử gom: cột client_app mới ghi được từ 14/08 nên 99% dòng rơi vào một
   * nhóm khổng lồ, cạnh đó là hai cột con con "Claude 3" và "Codex 1". Biểu đồ
   * đọc thành "hầu hết lượt gọi đến từ một ứng dụng tên là (trước 14/08)" —
   * sai hoàn toàn. Số bị bỏ vẫn báo ra ở `skipped` để trang nói rõ.
   */
  let skipped = 0;
  const g = new Map();
  for (const r of kept) {
    const k = keyOf(r);
    if (k === null) { skipped++; continue; }
    const e = g.get(k) || { key: k, calls: 0, blocked: 0, ms: [], users: new Set(), tools: new Set(), last: null };
    e.calls++;
    if (blocked.has(r)) e.blocked++;
    if (r.duration_ms != null) e.ms.push(r.duration_ms);
    if (r.user_name) e.users.add(r.user_name);
    if (r.tool_name) e.tools.add(r.tool_name);
    if (!e.last || r.created_at > e.last) e.last = r.created_at;
    g.set(k, e);
  }

  const out = [...g.values()].map((e) => {
    const s = e.ms.sort((a, b) => a - b);
    return {
      key: e.key, calls: e.calls, blocked: e.blocked, blockRate: pct(e.blocked, e.calls),
      p50: quant(s, 0.5), p95: quant(s, 0.95),
      users: e.users.size, tools: e.tools.size, last: e.last,
    };
  });

  // Trục thời gian giữ đúng thứ tự thời gian; cột phân loại xếp giảm dần theo
  // lượt gọi để cái đáng nhìn nằm trên đầu.
  out.sort(dim.time ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.calls - a.calls);

  return {
    dim: dim.key, include, user, app, users, apps,
    total: kept.length - skipped, skipped, groups: out.length, rows: out,
  };
}
