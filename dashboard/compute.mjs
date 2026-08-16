import { impactedSet } from './impact.mjs';
import { localDay, resolveRange } from './range.mjs';

/**
 * Toàn bộ phép tính của dashboard, KHÔNG phụ thuộc gì vào repo.
 *
 * Tách khỏi build.mjs vì có hai nơi gọi: bản dựng tĩnh (chạy tại chỗ, có
 * src/config.js) và hàm serverless trên Vercel (chỉ có biến môi trường). Nếu để
 * mỗi bên tự tính thì hai bản dashboard cùng tên sẽ cho hai con số khác nhau —
 * và không ai biết bên nào đúng.
 *
 * Mọi phụ thuộc đi vào qua tham số: `sb(path)` gọi PostgREST, `toolNames` là
 * danh sách tool hiện có.
 */

export const SKIP_CLIENTS = new Set(['local-admin', 'canary', 'revoke-test-a']);

const pct = (n, d) => (d ? +((n / d) * 100).toFixed(1) : 0);
const quant = (s, q) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * q))] : null);

/**
 * `range`   khoảng đang xem, đã chuẩn hoá bởi resolveRange (range.mjs)
 * `user`    lọc theo MỘT người, chuỗi rỗng = tất cả
 * `app`     lọc theo MỘT ứng dụng đã cắm (Claude / Codex …), rỗng = tất cả
 *
 * Ba tham số này là bộ lọc TOÀN CỤC của trang. Trước đây hàm này chốt cứng 30
 * ngày và không biết gì về người/ứng dụng, nên thanh chọn trên trang chỉ đổi
 * được khu "Đào sâu" ở cuối — mọi KPI phía trên vẫn là 30 ngày của tất cả mọi
 * người, mà không có gì nói ra điều đó.
 */
export async function computeDashboard({ sb, toolNames, appId, range, user = '', app = '' }) {
  const rg = range || resolveRange({});
  const page = async (p) => {
    const out = [];
    for (let off = 0; off < 50000; off += 1000) {
      const j = await sb(`${p}&limit=1000&offset=${off}`);
      out.push(...j);
      if (j.length < 1000) break;
    }
    return out;
  };
  const { since, until } = rg;

  // Đọc THẲNG raw audit_logs trong cửa sổ — không còn qua tầng rollup. Ở quy mô
  // này raw đủ nhẹ, và bỏ rollup thì đây là nguồn duy nhất, không lệch số.
  // v_session_health giữ lại vì đó là chỗ DUY NHẤT có hạn refresh token (nằm
  // trong tokens.json mã hoá, Supabase không có đường nào khác chạm tới).
  /**
   * `token_expires_at` chỉ có sau khi chạy supabase/machines-dedup.sql.
   *
   * PostgREST KHÔNG bỏ qua cột lạ trong `select` — nó trả 400 và cả trang chết
   * theo. (Đã thử: tưởng nó bỏ qua, hoá ra không.) Nên hỏi kèm cột đó trước,
   * hụt thì hỏi lại không kèm: mất một cột còn hơn mất cả trang. Cùng nguyên
   * tắc với DEGRADABLE ở phía server.
   */
  const MACHINE_COLS = 'machine_id,username,user_id,client_app,status,installed_at,last_seen';
  const readMachines = async () => {
    const q = (cols) => page(`machines?channel=eq.mcp%20remote&select=${cols}&order=last_seen.desc`);
    try {
      return await q(`${MACHINE_COLS},token_expires_at`);
    } catch {
      return q(MACHINE_COLS);
    }
  };

  /**
   * `client_app` cũng chỉ có sau supabase/audit-client-app.sql, và PostgREST
   * KHÔNG bỏ qua cột lạ trong `select` — nó trả 400 và cả trang chết theo. Cùng
   * cách xử lý với readMachines: hỏi kèm trước, hụt thì hỏi lại không kèm.
   */
  const AUDIT_COLS = 'created_at,tool_name,user_name,open_id,client_id,ok,duration_ms,lark_code,error_msg,args';
  const readAudit = async () => {
    // `args` chỉ để impact.mjs nhận ra tham số trỏ ra ngoài Lark. Nó KHÔNG đi
    // xuống trình duyệt — computeDashboard chỉ trả về số đã gộp.
    const q = (cols) => page(
      `audit_logs?source=eq.url&created_at=gte.${since}&created_at=lt.${until}&select=${cols}&order=created_at.asc`,
    );
    try {
      return await q(`${AUDIT_COLS},client_app`);
    } catch {
      return q(AUDIT_COLS);
    }
  };

  const [raw, machines, canaryRow, sessionRow, ingestRow] = await Promise.all([
    readAudit(),
    readMachines(),
    sb('audit_logs?source=eq.url&tool_name=eq.canary_heartbeat&select=created_at,ok,args&order=created_at.desc&limit=1'),
    sb('v_session_health?select=created_at,state&limit=1'),
    /**
     * Độ tươi đường nạp dữ liệu hỏi RIÊNG, không lấy dòng cuối của `raw`.
     *
     * Đây là câu "server còn đang ghi audit không", đáp án luôn tính từ BÂY GIỜ.
     * Lấy từ `raw` là để bộ lọc đụng vào nó: chọn xem lại tuần trước thì dải
     * canh gác đọc thành "9 ngày chưa nạp được dữ liệu" và báo đỏ — một cảnh
     * báo giả do chính người xem vừa tự tạo ra bằng cách đổi khoảng ngày.
     */
    sb('audit_logs?source=eq.url&select=created_at&order=created_at.desc&limit=1'),
  ]);

  const scope = raw.filter(
    (r) => !SKIP_CLIENTS.has(r.client_id) && !r.tool_name.startsWith('__auth.') && r.tool_name !== 'canary_heartbeat',
  );

  /**
   * Danh sách người / ứng dụng dựng TRƯỚC khi lọc — lọc rồi mới liệt kê thì
   * chọn xong một người là ô chọn chỉ còn đúng người đó, không đổi sang ai được.
   */
  const usersAvail = [...new Set(scope.map((r) => r.user_name).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
  const appsAvail = [...new Set(scope.map((r) => r.client_app).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'vi'));
  // Dòng ghi trước 14/08 chưa có `client_app`. Lọc theo ứng dụng là chúng biến
  // mất — không sai, nhưng phải NÓI RA, không thì người xem đọc ra một cú sụt
  // lưu lượng không có thật. Trang hiện con số này ngay cạnh bộ lọc.
  const noApp = scope.filter((r) => !r.client_app).length;

  /**
   * Bảng này đếm lượt CHẶN người dùng, không đếm lỗi thô — xem impact.mjs.
   * Thiếu quyền, sai tham số, quá hạn mức đều là Lark đã trả lời; model đọc
   * xong đi đường khác và người dùng không thấy gì. Đếm cả chúng thì bảng lúc
   * nào cũng đỏ trong khi tool chạy mượt, và một cảnh báo luôn bật là một
   * cảnh báo không ai đọc.
   *
   * Tính trên `scope` chứ không trên `calls` đã lọc: luật "được cứu trong 5
   * phút" cần lượt thành công NGAY SAU của chính người đó, mà lọc theo ứng dụng
   * có thể cắt mất đúng lượt cứu đó — và một lỗi đã được cứu sẽ hiện thành lỗi
   * thật chỉ vì người xem vừa bấm một cái nút lọc.
   */
  const blockedRows = impactedSet(scope);
  const isBlocked = (r) => blockedRows.has(r);

  const calls = scope.filter((r) => (!user || r.user_name === user) && (!app || r.client_app === app));
  /**
   * Đếm lượt bị chặn TRONG tập đã lọc.
   *
   * `blockedRows` cố ý dựng trên `scope` chưa lọc (luật "được cứu" cần lượt
   * thành công của chính người đó), nhưng lấy thẳng `.size` của nó làm KPI thì
   * sai hẳn: lọc còn một người mà con số hỏng vẫn là của cả tổ, chia cho số
   * lượt của riêng người đó — tỉ lệ ra được cả trên 100%.
   */
  const blockedCount = calls.reduce((n, r) => n + (blockedRows.has(r) ? 1 : 0), 0);

  // ── theo ngày ──
  const dayMap = new Map();
  for (const r of calls) {
    // Cắt ngày theo GIỜ VN. Cắt theo UTC (bản cũ) là mọi lượt gọi 0h–7h sáng
    // rơi sang cột hôm trước — xem ghi chú múi giờ ở range.mjs.
    const d = localDay(r.created_at);
    const e = dayMap.get(d) || { day: d, calls: 0, blocked: 0 };
    e.calls++;
    if (isBlocked(r)) e.blocked++;
    dayMap.set(d, e);
  }
  const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  // ── theo tool ──
  const toolMap = new Map();
  for (const r of calls) {
    const e = toolMap.get(r.tool_name) || { name: r.tool_name, calls: 0, blocked: 0, ms: [], lastOk: null, lastBlocked: null };
    e.calls++;
    if (isBlocked(r)) { e.blocked++; e.lastBlocked = r.created_at; }
    if (r.ok !== false) e.lastOk = r.created_at;
    if (r.duration_ms != null) e.ms.push(r.duration_ms);
    toolMap.set(r.tool_name, e);
  }
  const tools = [...toolMap.values()]
    .map((t) => ({
      name: t.name, calls: t.calls, blocked: t.blocked, blockRate: pct(t.blocked, t.calls),
      p95: quant(t.ms.slice().sort((a, b) => a - b), 0.95),
      lastOk: t.lastOk, lastBlocked: t.lastBlocked,
      // "Đang hỏng" so lượt chặn gần nhất với lượt chạy được gần nhất — đúng
      // luật canary.js dùng. Tỷ lệ trên cả cửa sổ vẫn cao sau khi đã vá xong,
      // tố theo nó là tố nhầm một tool đã khoẻ.
      broken: Boolean(t.lastBlocked) && (!t.lastOk || t.lastBlocked > t.lastOk),
    }))
    .sort((a, b) => b.calls - a.calls);

  const all = [...toolNames].sort();
  const unused = all.filter((n) => !toolMap.has(n));
  // Đếm theo tool ĐANG CÒN: log giữ cả tool đã gỡ, nên `tổng − toolMap.size` ra
  // lệch với chính danh sách hiển thị ngay bên dưới.
  const usedCurrent = all.filter((n) => toolMap.has(n)).length;
  const retired = [...toolMap.keys()].filter((n) => !all.includes(n)).sort();

  /**
   * Tool chưa ai gọi cũng là MỘT DÒNG trong `tools`, với calls = 0.
   *
   * Trước đây chúng nằm ở thẻ riêng "Tool chưa ai gọi" dưới dạng đám nhãn —
   * cùng một câu hỏi ("tool nào ít được dùng") bị tách làm hai chỗ, mà ranh
   * giới giữa "gọi 1 lần" với "gọi 0 lần" thì không đáng một thẻ riêng. Gộp
   * vào đây thì bộ lọc "ít nhất" trả lời luôn cả hai.
   *
   * Nối SAU khi đã đếm `usedCurrent`/`retired` — hai số đó đọc chính `toolMap`
   * để biết tool nào CÓ người gọi; thêm dòng 0 lượt vào trước là biến
   * "38/60 đã dùng" thành "60/60".
   */
  tools.push(...unused.map((name) => ({
    name, calls: 0, blocked: 0, blockRate: 0, p95: null,
    lastOk: null, lastBlocked: null, broken: false,
  })));

  /**
   * MỘT bảng, khoá là NGƯỜI (`open_id`) — hợp của hai nguồn:
   *
   *   audit_logs  → ai đã GỌI tool     (open_id)
   *   machines    → ai đã ĐĂNG NHẬP    (user_id) + họ cắm bằng ứng dụng gì
   *
   * Trước đây khoá là (người, client_id) nên có hai bệnh cùng lúc: người vừa
   * cắm mà chưa gọi tool thì không hiện, còn người cắm đi cắm lại thì đẻ ra
   * mỗi lần một dòng (đo thật: 6 dòng cho 2 chỗ cắm). Nay `client_id` không
   * còn là khoá của bất cứ thứ gì — nó đổi mỗi lần đăng ký DCR nên không phải
   * danh tính. Ứng dụng đã dùng thành DANH SÁCH CON trong dòng của người đó.
   */
  const pmap = new Map();
  const person = (openId) => {
    if (!pmap.has(openId)) {
      pmap.set(openId, {
        openId, name: null, clients: [],
        calls: 0, blocked: 0, tools: new Set(), last: null,
        seen: null, installed: null, tokenExpires: null,
      });
    }
    return pmap.get(openId);
  };

  for (const r of calls) {
    if (!r.open_id) continue;
    const p = person(r.open_id);
    p.name = r.user_name || p.name;
    p.calls++;
    if (isBlocked(r)) p.blocked++;
    p.tools.add(r.tool_name);
    if (!p.last || r.created_at > p.last) p.last = r.created_at;
  }

  /**
   * Bộ lọc toàn cục áp cho CẢ hai nguồn, không riêng audit.
   *
   * Lọc "chỉ Claude" mà bảng người vẫn bày chip Codex thì bảng đang trả lời một
   * câu khác câu đang hỏi. Khớp người theo `username` vì `machines` không giữ
   * `user_name` của audit — trật tên thì người đó chỉ mất mấy con chip, chứ
   * không hiện ra số của người khác.
   */
  for (const m of machines) {
    if (!m.user_id) continue;
    if (app && m.client_app !== app) continue;
    if (user && m.username && m.username !== user) continue;
    const p = person(m.user_id);
    p.name = p.name || m.username || null;
    p.clients.push({ app: m.client_app || 'connector', status: m.status, installed: m.installed_at, seen: m.last_seen });
    // `last` (audit) và `seen` (machines) trả lời hai câu khác nhau: lần cuối
    // GỌI tool, và lần cuối server CHẠM vào người này — xoay token cũng tính.
    if (!p.seen || String(m.last_seen) > p.seen) p.seen = m.last_seen;
    if (!p.installed || String(m.installed_at) < p.installed) p.installed = m.installed_at;
    // Token thuộc về người, mọi dòng của họ mang cùng một hạn — lấy cái xa nhất
    // để một dòng cũ chưa kịp cập nhật không kéo countdown xuống oan.
    if (m.token_expires_at && (!p.tokenExpires || m.token_expires_at > p.tokenExpires)) p.tokenExpires = m.token_expires_at;
  }

  const people = [...pmap.values()]
    .map((p) => ({
      ...p,
      tools: p.tools.size,
      clients: p.clients.sort((a, b) => String(b.seen || '').localeCompare(String(a.seen || ''))),
    }))
    // Chưa gọi lần nào thì xếp theo lần thấy gần nhất, không rơi hết xuống đáy
    // chung một cục — người vừa cắm xong phải nổi lên trên.
    .sort((a, b) => b.calls - a.calls || String(b.seen || '').localeCompare(String(a.seen || '')));

  const durs = calls.map((r) => r.duration_ms).filter((x) => x != null).sort((a, b) => a - b);
  const canary = canaryRow[0] || null;
  const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
  const canaryArgs = canary ? parse(canary.args) : {};

  /**
   * Chi tiết từng probe của lượt canary gần nhất. Dòng nhịp tim ghi mỗi ngày
   * một lần nên bảng này có thể cũ tới 24h — chấp nhận được, vì dải canh gác
   * ngay trên đã nói rõ nhịp tim cách đây bao lâu.
   *
   * Mảng gọn `[tên, ok, ms, mã]` do canary.js ghi; bản cũ chưa có thì `p`
   * không tồn tại và bảng chỉ trống chứ không gãy.
   */
  const canaryProbes = (canaryArgs.p || []).map(([name, ok, ms, code]) => ({
    name, ok: ok === 1, ms, code: code || null,
  }));
  // Sự kiện xác thực đếm thẳng từ raw trong cửa sổ (trước đây đọc view rollup
  // v_daily_auth). '__auth.' dài 7 ký tự — cắt để lấy tên sự kiện.
  const authCounts = new Map();
  for (const r of raw) {
    if (!r.tool_name.startsWith('__auth.')) continue;
    const event = r.tool_name.slice(7);
    authCounts.set(event, (authCounts.get(event) || 0) + 1);
  }

  return {
    generatedAt: new Date().toISOString(),
    // Khoảng + bộ lọc trả NGƯỢC về trang, không để trang tự nhớ mình đã hỏi gì.
    // Trang poll lại mỗi 30s: nếu máy chủ đã kẹp biên khoảng (dán URL 2 năm
    // chẳng hạn) mà trang vẫn hiện con số cũ trên nút, thì nhãn và số liệu nói
    // hai chuyện khác nhau. Cứ để máy chủ nói nó đã tính cái gì.
    range: { from: rg.from, to: rg.to, preset: rg.preset, days: rg.days, clamped: rg.clamped },
    filters: { user, app, users: usersAvail, apps: appsAvail, noApp },
    appId,
    from: calls.length ? calls[0].created_at : null,
    to: calls.length ? calls[calls.length - 1].created_at : null,
    kpi: {
      calls: calls.length,
      // MỘT con số về hỏng hóc, không phải hai. Trước đây có cả `errors` thô
      // lẫn `noResp`, và cái thô nhảy lên KPI vì nó to hơn — bảng báo 11% lỗi
      // trong khi thực tế chỉ 3% chạm tới người dùng.
      blocked: blockedCount,
      blockRate: pct(blockedCount, calls.length),
      p50: quant(durs, 0.5),
      p95: quant(durs, 0.95),
      users: people.filter((p) => p.calls).length,
      // Đã cắm ≠ đã gọi. `users` đếm người có lượt gọi trong cửa sổ; `connected`
      // đếm người đã đăng nhập được, kể cả chưa gọi tool nào. Chênh lệch giữa
      // hai số chính là "phát link rồi mà chưa ai dùng" — số cần biết nhất
      // trong lúc triển khai cho phòng ban mới.
      connected: people.filter((p) => p.clients.length).length,
      toolsUsed: usedCurrent,
      toolsTotal: all.length,
      toolsRetired: retired,
    },
    watchdog: {
      // `p` (chi tiết từng probe) tách ra `canaryProbes` ở dưới — dải canh gác
      // chỉ cần hai con số tổng, không cần chở cả mảng.
      canary: canary && { at: canary.created_at, ok: canary.ok, probes: canaryArgs.probes, failing: canaryArgs.failing },
      session: sessionRow[0] ? { at: sessionRow[0].created_at, ...sessionRow[0].state } : null,
      // Luôn là "dòng audit mới nhất TÍNH TỚI GIỜ", độc lập với khoảng đang xem.
      ingest: { at: ingestRow[0] ? ingestRow[0].created_at : null },
    },
    daily,
    tools,
    // CỐ Ý không có danh sách "tool đang hỏng" ở đây. Đã thử: nó gọi tên
    // `lark_api_call` — tool gọi endpoint tuỳ ý, người dùng đưa sai đường dẫn
    // là ra 404, không phải tool hỏng. Một danh sách mà mục đầu tiên đã là báo
    // động giả thì không ai đọc tới mục thứ hai. Việc canh tool hỏng thuộc về
    // canary.js, nơi có probe cố định nên 404 nghĩa là Lark đổi API thật.
    //
    // `risky`/`healed`/`codes`/`noResponse` cũ cũng đã bỏ: liệt kê lỗi thô,
    // không trang nào dùng, mà vẫn đẩy error_msg kèm id tài liệu xuống trình duyệt.
    unused,
    // MỘT bảng người thay cho hai bảng "người dùng" + "chỗ cắm" cũ. Hai bảng
    // đó vốn là hai lát cắt của cùng một tập người, đặt cạnh nhau chỉ khiến
    // phải đối chiếu bằng mắt xem dòng nào là ai.
    people,
    canaryProbes,
    auth: [...authCounts.entries()].map(([event, n]) => ({ event, n })).sort((a, b) => b.n - a.n),
  };
}
