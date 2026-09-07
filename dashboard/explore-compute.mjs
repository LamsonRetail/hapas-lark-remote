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

/**
 * Số ký tự trên MỘT token — ĐO trên kết quả tool thật, không phải hệ số đoán.
 *
 * Đo bằng gpt-tokenizer (BPE cl100k) trên bốn mẫu kết quả thực tế của chính
 * server này:
 *
 *   lark_whoami  (tên tiếng Việt)         600 ký tự /   241 token = 2,49
 *   im_chat_list (ID + tên nhóm)        1.020 /   386            = 2,64
 *   task_search  (nhiều văn bản Việt)     566 /   254            = 2,23
 *   chỉ ID và số (không tiếng Việt)     1.533 /   681            = 2,25
 *   ─────────────────────────────────────────────────────────────────────
 *   TỔNG                                3.719 / 1.562            = 2,38
 *
 * VÌ SAO KHÔNG PHẢI 4 như mức thường nghe: 4 là tỉ lệ cho văn xuôi tiếng Anh.
 * Kết quả tool ở đây là JSON đầy dấu ngoặc, dấu phẩy, và ID Lark dạng hex ngẫu
 * nhiên (`ou_1bc55b6d...`) — BPE cắt ID thành rất nhiều token vụn. Mẫu "chỉ ID
 * và số" tệ nhất (2,25) chính vì thế, không phải do tiếng Việt. Dùng 4 thì
 * thiếu khoảng 40% số token thật.
 *
 * Dải đo được là 2,23–2,64, tức ±9% quanh 2,4 — đủ ổn định để quy đổi.
 *
 * CÒN LẠI MỘT SAI SỐ KHÔNG ĐO ĐƯỢC: đây là tokenizer của GPT, không phải của
 * Claude. Hai bên cùng họ BPE và cùng tầm nhưng không trùng nhau. Nên vẫn là
 * ƯỚC LƯỢNG — chỉ là ước lượng đã hiệu chỉnh bằng số đo, thay vì đoán.
 */
const CHARS_PER_TOKEN = 2.4;

/** clientId của công cụ chạy tại chỗ — cùng danh sách computeDashboard loại ra. */
export const SKIP_CLIENTS = new Set(['local-admin', 'canary', 'revoke-test-a']);

/**
 * Cột audit_logs cần đọc để tính được mọi phép đo trong MEASURES.
 * `args` chỉ phục vụ impact.mjs (nhận ra tham số trỏ ra ngoài Lark) — không
 * cột nào trong đó đi xuống trình duyệt, endpoint chỉ trả số đã gộp.
 */
export const EXPLORE_COLS = ['created_at', 'tool_name', 'user_name', 'client_id', 'ok', 'duration_ms', 'lark_code', 'source', 'args', 'client_app', 'result_chars'];

/**
 * Cột SINH SAU, có thể chưa tồn tại trên Supabase.
 *
 * Schema luôn đi sau code: `client_app` cần audit-client-app.sql, `result_chars`
 * cần audit-result-chars.sql. PostgREST KHÔNG bỏ qua cột lạ trong `select` —
 * nó trả 400 và cả endpoint chết theo 502.
 *
 * Bên đọc thử lần lượt bỏ từng cột trong danh sách này. Mất một cột (biểu đồ
 * ngữ cảnh trống) còn hơn mất cả trang.
 */
export const OPTIONAL_COLS = ['result_chars', 'client_app'];

/** Danh sách cột để thử lần lượt: đủ trước, rồi bỏ dần cột sinh sau. */
export function colAttempts(base = EXPLORE_COLS) {
  const out = [base];
  let cur = base;
  for (const c of OPTIONAL_COLS) {
    cur = cur.filter((x) => x !== c);
    out.push(cur);
  }
  return out;
}

/**
 * Gộp theo NHIỀU cột trong một lượt.
 *
 * Vì sao đáng tách ra: việc đắt tiền ở đây là ĐỌC hàng từ Supabase và tính
 * `impactedSet` — gộp thêm một cột nữa chỉ là một vòng lặp trên tập đã nằm sẵn
 * trong bộ nhớ. Trang mới bày 8 biểu đồ cùng lúc; gọi 8 lượt thì mỗi lượt đọc
 * lại toàn bộ hàng, tức trả giá đọc 8 lần cho cùng một tập dữ liệu.
 *
 * Chuyện này không phải tối ưu sớm: Supabase vừa bị khoá vì `exceed_egress_quota`
 * ở mức 344% hạn mức, và dashboard chính là bên đọc nhiều nhất.
 */
export function aggregateMany({ rows, dims, include = 'tools', user = '', app = '', tool = '' }) {
  const list = dims.map((k) => {
    const d = DIM_BY_KEY.get(k);
    if (!d) throw new Error(`Cột không hợp lệ: ${k}`);
    return d;
  });
  const shared = prepare({ rows, include, user, app, tool });
  const byDim = {};
  for (const d of list) byDim[d.key] = groupOne(d, shared);
  return {
    include, user, app, tool,
    users: shared.users, apps: shared.apps, tools: shared.toolNames,
    total: shared.kept.length, byDim,
  };
}

export function aggregate({ rows, dim: dimKey, include = 'tools', user = '', app = '', tool = '' }) {
  const dim = DIM_BY_KEY.get(dimKey);
  if (!dim) throw new Error(`Cột không hợp lệ: ${dimKey}`);

  const shared = prepare({ rows, include, user, app, tool });
  const g = groupOne(dim, shared);
  return {
    dim: dim.key, include, user, app, tool,
    users: shared.users, apps: shared.apps, tools: shared.toolNames,
    total: shared.kept.length - g.skipped, skipped: g.skipped, groups: g.rows.length, rows: g.rows,
  };
}

/** Phần đắt tiền, làm ĐÚNG MỘT LẦN dù sau đó gộp theo bao nhiêu cột. */
function prepare({ rows, include = 'tools', user = '', app = '', tool = '' }) {
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
  // Tool cũng vào danh sách lọc: câu hay phải hỏi nhất khi có người báo lỗi là
  // "tool X hỏng với riêng ai", mà trước đây không lọc theo tool được.
  const toolNames = [...new Set(inScope.map((r) => r.tool_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));

  // Nhóm theo tool + lọc một người = "người này đã gọi những tool nào" — mức
  // bóc tách thứ hai mà một cột nhóm đơn lẻ không trả lời được.
  const kept = inScope.filter((r) => (!user || r.user_name === user)
    && (!app || r.client_app === app)
    && (!tool || r.tool_name === tool));

  /**
   * Tính trên inScope chứ không trên `kept`: luật "được cứu" cần lượt thành
   * công của chính người đó, mà lọc theo cột khác (ví dụ chỉ xem mã lỗi) có
   * thể cắt mất đúng những lượt đó và biến một lỗi đã được cứu thành lỗi thật.
   */
  const blocked = impactedSet(inScope);

  return { users, apps, toolNames, kept, blocked };
}

/** Phần rẻ: gộp tập đã chuẩn bị theo đúng một cột. Gọi lại nhiều lần thoải mái. */
function groupOne(dim, { kept, blocked }) {
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
    const e = g.get(k) || { key: k, calls: 0, blocked: 0, ms: [], users: new Set(), tools: new Set(), last: null, chars: 0, charsN: 0 };
    e.calls++;
    // Dong cu (truoc khi co cot result_chars) la null — dem RIENG so dong co so
    // de tinh trung binh dung, thay vi chia cho ca nhung dong khong do duoc.
    if (r.result_chars != null) { e.chars += r.result_chars; e.charsN++; }
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
      chars: e.charsN ? e.chars : null,
      charsAvg: e.charsN ? Math.round(e.chars / e.charsN) : null,
      tokens: e.charsN ? Math.round(e.chars / CHARS_PER_TOKEN) : null,
    };
  });

  // Trục thời gian giữ đúng thứ tự thời gian; cột phân loại xếp giảm dần theo
  // lượt gọi để cái đáng nhìn nằm trên đầu.
  out.sort(dim.time ? (a, b) => a.key.localeCompare(b.key) : (a, b) => b.calls - a.calls);

  return { skipped, rows: out };
}
