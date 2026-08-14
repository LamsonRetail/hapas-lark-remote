import crypto from 'node:crypto';

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

/** Cùng công thức machine_id mà server dùng để ghi bảng `machines`. */
const machineIdFor = (openId, clientId) =>
  'url-' + crypto.createHash('sha256').update(`${openId}|${clientId}`).digest('hex').slice(0, 12);

/**
 * Chỉ phân loại thứ đã khẳng định được. Mã lạ để nguyên là "chưa phân loại" —
 * gán nhãn bừa cho một mã lỗi biến bảng này thành nguồn tin sai.
 */
function classify(code) {
  if (code === 'non_json') return { label: 'Lark trả HTML — nghi đổi API', sev: 'critical' };
  if (/^9999166|^9999167/.test(code || '')) return { label: 'Thiếu quyền', sev: 'warning' };
  return { label: 'Chưa phân loại', sev: 'serious' };
}

export async function computeDashboard({ sb, toolNames, appId, windowDays = 30 }) {
  const page = async (p) => {
    const out = [];
    for (let off = 0; off < 50000; off += 1000) {
      const j = await sb(`${p}&limit=1000&offset=${off}`);
      out.push(...j);
      if (j.length < 1000) break;
    }
    return out;
  };
  const since = new Date(Date.now() - windowDays * 86400000).toISOString();

  // Đọc THẲNG raw audit_logs trong cửa sổ — không còn qua tầng rollup. Ở quy mô
  // này raw đủ nhẹ, và bỏ rollup thì đây là nguồn duy nhất, không lệch số.
  // v_session_health giữ lại vì đó là chỗ DUY NHẤT có hạn refresh token (nằm
  // trong tokens.json mã hoá, Supabase không có đường nào khác chạm tới).
  /**
   * Bảng `dashboard_hidden` là tuỳ chọn: chưa chạy supabase/dashboard-hidden.sql
   * thì PostgREST trả 404 và cả trang phải chết theo — mà thứ chết đi chỉ là
   * một danh sách để ẩn bớt dòng. Nuốt lỗi, coi như chưa ai ẩn gì.
   */
  const readHidden = async () => {
    try {
      return await sb('dashboard_hidden?select=machine_id,label,hidden_at&order=hidden_at.desc');
    } catch {
      return [];
    }
  };

  const [raw, machines, canaryRow, sessionRow, hiddenRows] = await Promise.all([
    page(`audit_logs?source=eq.url&created_at=gte.${since}&select=created_at,tool_name,user_name,open_id,client_id,ok,duration_ms,lark_code,error_msg&order=created_at.asc`),
    // `display_name` chở theo client_id — xem ghi chú ở phần dựng chỗ cắm.
    page('machines?channel=eq.mcp%20remote&select=machine_id,username,user_id,client_app,display_name,status,installed_at,last_seen&order=last_seen.desc'),
    sb('audit_logs?source=eq.url&tool_name=eq.canary_heartbeat&select=created_at,ok,args&order=created_at.desc&limit=1'),
    sb('v_session_health?select=created_at,state&limit=1'),
    readHidden(),
  ]);

  const calls = raw.filter(
    (r) => !SKIP_CLIENTS.has(r.client_id) && !r.tool_name.startsWith('__auth.') && r.tool_name !== 'canary_heartbeat',
  );
  const errs = calls.filter((r) => r.ok === false);

  // ── theo ngày ──
  const dayMap = new Map();
  for (const r of calls) {
    const d = r.created_at.slice(0, 10);
    const e = dayMap.get(d) || { day: d, calls: 0, errors: 0 };
    e.calls++;
    if (r.ok === false) e.errors++;
    dayMap.set(d, e);
  }
  const daily = [...dayMap.values()].sort((a, b) => a.day.localeCompare(b.day));

  // ── theo tool ──
  const toolMap = new Map();
  for (const r of calls) {
    const e = toolMap.get(r.tool_name) || { name: r.tool_name, calls: 0, errors: 0, ms: [], lastOk: null, lastErr: null };
    e.calls++;
    if (r.ok === false) { e.errors++; e.lastErr = r.created_at; } else { e.lastOk = r.created_at; }
    if (r.duration_ms != null) e.ms.push(r.duration_ms);
    toolMap.set(r.tool_name, e);
  }
  const tools = [...toolMap.values()]
    .map((t) => ({
      name: t.name, calls: t.calls, errors: t.errors, errRate: pct(t.errors, t.calls),
      p95: quant(t.ms.slice().sort((a, b) => a - b), 0.95),
      lastOk: t.lastOk, lastErr: t.lastErr,
      // "Đang hỏng" so lượt đỏ gần nhất với lượt xanh gần nhất — đúng luật
      // canary.js dùng. Tỷ lệ lỗi trên cả cửa sổ vẫn cao sau khi đã vá xong,
      // tố theo nó là tố nhầm một tool đã khoẻ.
      broken: Boolean(t.lastErr) && (!t.lastOk || t.lastErr > t.lastOk),
      healed: Boolean(t.lastErr) && Boolean(t.lastOk) && t.lastOk > t.lastErr,
    }))
    .sort((a, b) => b.calls - a.calls);

  const all = [...toolNames].sort();
  const unused = all.filter((n) => !toolMap.has(n));
  // Đếm theo tool ĐANG CÒN: log giữ cả tool đã gỡ, nên `tổng − toolMap.size` ra
  // lệch với chính danh sách hiển thị ngay bên dưới.
  const usedCurrent = all.filter((n) => toolMap.has(n)).length;
  const retired = [...toolMap.keys()].filter((n) => !all.includes(n)).sort();

  // ── theo người ──
  const userMap = new Map();
  for (const r of calls) {
    const k = r.user_name || '(không rõ)';
    const e = userMap.get(k) || { name: k, calls: 0, errors: 0, last: '', tools: new Set() };
    e.calls++;
    if (r.ok === false) e.errors++;
    if (r.created_at > e.last) e.last = r.created_at;
    e.tools.add(r.tool_name);
    userMap.set(k, e);
  }
  const users = [...userMap.values()]
    .map((u) => ({ name: u.name, calls: u.calls, errors: u.errors, last: u.last, tools: u.tools.size }))
    .sort((a, b) => b.calls - a.calls);

  // ── mã lỗi ──
  const codeMap = new Map();
  for (const r of errs) {
    const code = r.lark_code || '(không mã)';
    const e = codeMap.get(code) || { code, hits: 0, tools: new Set(), sample: r.error_msg || '', ...classify(r.lark_code) };
    e.hits++;
    e.tools.add(r.tool_name);
    codeMap.set(code, e);
  }
  const codes = [...codeMap.values()]
    .map((c) => ({ code: c.code, hits: c.hits, tools: [...c.tools], sample: (c.sample || '').slice(0, 150), label: c.label, sev: c.sev }))
    .sort((a, b) => b.hits - a.hits);

  /**
   * "Lark không phản hồi" — lớp lỗi DUY NHẤT coi là ảnh hưởng người dùng.
   *
   * Chỉ tính khi Lark KHÔNG trả lời: endpoint trả HTML/404 (lark_code
   * 'non_json') hoặc mạng timeout/đứt kết nối. Permission, validation, business
   * là Lark ĐÃ trả lời — chỉ là trả "không" — nên KHÔNG tính: hệ thống vẫn chạy,
   * người dùng chỉ thiếu quyền hoặc nhập sai.
   *
   * Vẫn lọc "không được cứu": nếu cùng người có lượt THÀNH CÔNG trong 5 phút kế
   * (Claude thử lại hoặc đi đường khác), coi như không tới tay người dùng.
   */
  const isNoResponse = (r) =>
    r.lark_code === 'non_json' ||
    (!r.lark_code && /timeout|abort|fetch failed|network|econn|etimedout|socket|getaddrinfo/i.test(r.error_msg || ''));

  const okTimes = calls.filter((r) => r.ok === true).map((r) => ({ t: new Date(r.created_at).getTime(), u: r.user_name }));
  const noResponse = [];
  for (const e of errs) {
    if (!isNoResponse(e)) continue;
    const t = new Date(e.created_at).getTime();
    if (okTimes.some((o) => o.u === e.user_name && o.t > t && o.t - t <= 300000)) continue;
    noResponse.push({ at: e.created_at, tool: e.tool_name, code: e.lark_code, msg: (e.error_msg || '').slice(0, 120), user: e.user_name });
  }

  /**
   * Chỗ cắm — HỢP của hai nguồn, khoá chung là `machine_id`:
   *
   *   audit_logs  → ai đã GỌI tool (có open_id + client_id, băm ra machine_id)
   *   machines    → ai đã ĐĂNG NHẬP (machine_id là khoá chính sẵn)
   *
   * Trước đây chỉ dựng từ audit, nên người vừa cắm connector xong mà chưa gọi
   * tool nào thì không tồn tại trên bảng — đúng lúc cần nhìn nhất (vừa phát
   * link cho phòng ban, muốn biết ai đã cắm được) thì bảng lại trống. Đã đo:
   * 11/24 dòng `machines` không hiện ra.
   *
   * Chiều ngược lại vẫn phải giữ: dòng audit cũ hơn ngày có `machines` thì
   * không có dòng machines nào để ghép — đó là các dòng 'không rõ'.
   */
  const connMap = new Map();

  const touch = (mid, seed) => {
    const c = connMap.get(mid) || {
      machineId: mid, openId: null, clientId: null, user: null,
      calls: 0, last: null, app: null, status: null, installed: null, seen: null,
    };
    connMap.set(mid, Object.assign(c, seed));
    return c;
  };

  for (const r of calls) {
    if (!r.open_id || !r.client_id) continue;
    const c = touch(machineIdFor(r.open_id, r.client_id), {});
    c.openId = r.open_id;
    c.clientId = r.client_id;
    c.user = r.user_name || c.user;
    c.calls++;
    if (!c.last || r.created_at > c.last) c.last = r.created_at;
  }

  /**
   * `machines` không có cột client_id — server băm nó vào `machine_id`, không
   * đảo ngược được. Nhưng `display_name` do machines.js dựng theo đúng khuôn
   * "tên — app <client_id> (url)", nên bóc lại được từ đó. Bóc hụt thì để null
   * và bảng hiện '—': thà thiếu một nhãn còn hơn giấu cả một chỗ cắm.
   */
  const clientIdFromLabel = (s) => (String(s || '').match(/\s(\S+)\s+\(url\)\s*$/) || [])[1] || null;

  for (const m of machines) {
    const c = touch(m.machine_id, {});
    c.openId = c.openId || m.user_id || null;
    c.clientId = c.clientId || clientIdFromLabel(m.display_name);
    c.user = c.user || m.username || null;
    // `last` (audit) và `seen` (machines) trả lời hai câu khác nhau: lần cuối
    // GỌI tool, và lần cuối server CHẠM vào chỗ cắm này — xoay token cũng tính.
    // Để cạnh nhau thì chênh lệch tự tố cáo: còn nối mà lâu không gọi là bình
    // thường; gọi gần đây mà lâu không thấy là phiên đã chết.
    c.app = m.client_app || c.app;
    c.status = m.status || c.status;
    c.installed = m.installed_at || c.installed;
    c.seen = m.last_seen || c.seen;
  }

  const hiddenIds = new Set(hiddenRows.map((h) => h.machine_id));
  const allConnectors = [...connMap.values()]
    .map((c) => ({ ...c, status: c.status || 'không rõ' }))
    // Chưa gọi lần nào thì xếp theo lần thấy gần nhất, không rơi hết xuống đáy
    // chung một cục — người vừa cắm xong phải nổi lên trên.
    .sort((a, b) => b.calls - a.calls || String(b.seen || '').localeCompare(String(a.seen || '')));

  const connectors = allConnectors.filter((c) => !hiddenIds.has(c.machineId));
  // Đã ẩn thì vẫn gửi kèm, để trang có cái mà "hiện lại" — ẩn một chiều không
  // hoàn tác được thì chẳng khác gì xoá, mà xoá là thứ ta cố tình tránh.
  const hidden = allConnectors
    .filter((c) => hiddenIds.has(c.machineId))
    .map((c) => ({ ...c, hiddenAt: hiddenRows.find((h) => h.machine_id === c.machineId)?.hidden_at || null }));

  const durs = calls.map((r) => r.duration_ms).filter((x) => x != null).sort((a, b) => a - b);
  const canary = canaryRow[0] || null;
  const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
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
    windowDays,
    appId,
    from: calls.length ? calls[0].created_at : null,
    to: calls.length ? calls[calls.length - 1].created_at : null,
    kpi: {
      calls: calls.length,
      errors: errs.length,
      errRate: pct(errs.length, calls.length),
      noResp: noResponse.length,
      noRespRate: pct(noResponse.length, calls.length),
      p50: quant(durs, 0.5),
      p95: quant(durs, 0.95),
      users: users.length,
      // Đã cắm ≠ đã gọi. `users` đếm người có lượt gọi trong cửa sổ; `connected`
      // đếm người đã đăng nhập được, kể cả chưa gọi tool nào. Chênh lệch giữa
      // hai số chính là "phát link rồi mà chưa ai dùng" — số cần biết nhất
      // trong lúc triển khai cho phòng ban mới.
      connected: new Set(connectors.map((c) => c.openId).filter(Boolean)).size,
      toolsUsed: usedCurrent,
      toolsTotal: all.length,
      toolsRetired: retired,
    },
    watchdog: {
      canary: canary && { at: canary.created_at, ok: canary.ok, ...parse(canary.args) },
      session: sessionRow[0] ? { at: sessionRow[0].created_at, ...sessionRow[0].state } : null,
      ingest: { at: raw.length ? raw[raw.length - 1].created_at : null },
    },
    daily,
    tools,
    risky: tools.filter((t) => t.broken && t.errors >= 2).sort((a, b) => b.errors - a.errors),
    healed: tools.filter((t) => t.healed && t.errors >= 2),
    unused,
    users,
    noResponse,
    connectors,
    hidden,
    auth: [...authCounts.entries()].map(([event, n]) => ({ event, n })).sort((a, b) => b.n - a.n),
  };
}
