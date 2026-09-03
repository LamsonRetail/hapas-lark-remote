import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config, publicUrlFor } from './config.js';
import { startDeviceFlow, pollDeviceFlow, persistTokens } from './lark-auth.js';
import { deleteUser, getUser } from './store.js';
import { recordAuth, revokeMachines } from './machines.js';
import { auditAuth } from './audit.js';

/**
 * OAuth 2.1 Authorization Server cho MCP.
 *
 * Claude không biết gì về Lark. Nó nói OAuth với server này; server này mới đi
 * nói device flow với Lark. Bearer token Claude cầm là token do ta phát, map
 * sang open_id — không bao giờ lộ token Lark ra ngoài.
 */

const DB = path.join(config.dataDir, 'oauth.json');
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { clients: {}, tokens: {} });
const save = (d) => {
  const tmp = DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, DB);
};

const sha256 = (s) => crypto.createHash('sha256').update(s).digest();
const b64url = (b) => b.toString('base64url');
const rand = (n = 32) => b64url(crypto.randomBytes(n));
const hashToken = (t) => b64url(sha256(t)); // chỉ lưu hash, lộ file không dùng lại được

const flows = new Map(); // state đang chờ user duyệt trên Lark
const codes = new Map(); // authorization code, dùng một lần

/**
 * Token hết hạn chỉ bị resolveBearer BỎ QUA chứ không xoá khỏi đĩa. Không dọn
 * thì oauth.json phình đơn điệu — mỗi lần refresh thêm một cặp token mới, cái cũ
 * (access 30 ngày, refresh 180 ngày) nằm lại mãi — mà cả file bị parse lại ở
 * mỗi request /mcp. Chỉ ghi lại khi THẬT SỰ có entry bị xoá, tránh viết đĩa mỗi
 * phút vô ích. Toàn bộ đồng bộ (không await giữa load↔save) nên vẫn nguyên tử.
 */
function pruneExpiredTokens(now = Date.now()) {
  const db = load();
  let removed = 0;
  for (const [hash, t] of Object.entries(db.tokens)) {
    if (t.expiresAt < now) {
      delete db.tokens[hash];
      removed++;
    }
  }
  if (removed) {
    save(db);
    console.log(`[oauth] dọn ${removed} token hết hạn`);
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of flows) if (v.expiresAt < now) flows.delete(k);
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
  pruneExpiredTokens(now);
}, 60_000).unref();

/**
 * Tên ứng dụng client tự khai lúc đăng ký DCR: "Claude", "Codex",
 * "Claude Code (lark-remote)". Tra lúc dùng chứ không lưu vào token: token sống
 * 30 ngày, mà bản ghi client có thể được sửa/xoá trong khoảng đó.
 *
 * KHÔNG dùng User-Agent thay thế: nó khác nhau giữa các bước của cùng một client
 * (Claude gọi OAuth bằng python-httpx nhưng gọi tool bằng Claude-User), nên cùng
 * một chỗ cắm sẽ ra hai nhãn khác nhau.
 */
const appNameOf = (db, clientId) => {
  if (db.clients[clientId]?.name) return db.clients[clientId].name;
  // token.js cấp clientId dạng `static-<nhãn>`. Không qua DCR nên không có bản
  // ghi client để tra tên, nhưng vẫn là chỗ cắm THẬT — hiện rõ nguồn gốc thay
  // vì để null rồi trông như dòng vô danh trong bảng machines.
  const m = /^static-(.+)$/.exec(clientId || '');
  return m ? `static: ${m[1]}` : null;
};

/**
 * Bỏ mọi bearer của một grant, đánh dấu machines, và xoá token Lark nếu đó là
 * chỗ cắm cuối cùng của người đó.
 *
 * Dùng chung bởi `/revoke` (RFC 7009, người dùng tự ngắt bằng bearer của mình)
 * và `revoke.js` (quản trị chạy tại chỗ). Hai đường phải có ngữ nghĩa GIỐNG HỆT
 * nhau — viết hai bản là sớm muộn một bên quên xoá token Lark rồi tưởng đã thu
 * hồi xong, mà đó là bên nguy hiểm nhất để sai.
 *
 * `clientId` bỏ trống nghĩa là thu hồi TẤT CẢ chỗ cắm của người đó.
 */
export function revokeGrant({ openId, clientId = null, name = '' }) {
  const db = load();
  const revoked = [];
  for (const [hash, t] of Object.entries(db.tokens)) {
    if (t.openId !== openId) continue;
    if (clientId && t.clientId !== clientId) continue;
    revoked.push(t.kind);
    delete db.tokens[hash];
  }

  const clientsLeft = new Set(Object.values(db.tokens).filter((t) => t.openId === openId).map((t) => t.clientId));
  save(db);

  // Truyền TÊN ỨNG DỤNG, không phải client_id — khoá dòng machines đã đổi sang
  // (người + ứng dụng) để cắm lại không sinh dòng mới. Xem machineIdFor.
  revokeMachines({ openId, clientApps: clientId ? [appNameOf(db, clientId)] : [] });

  // Báo cáo đúng thứ ĐÃ xảy ra, không phải thứ lẽ ra xảy ra: open_id gõ sai thì
  // clientsLeft cũng bằng 0, và nếu cứ thế báo "đã xoá token Lark" thì dashboard
  // hiện một thao tác thành công cho một người không tồn tại.
  const hadLarkToken = Boolean(getUser(openId));
  if (clientsLeft.size === 0 && hadLarkToken) deleteUser(openId);

  console.log(
    `[revoke] ${name || openId} / ${clientId || 'MỌI chỗ cắm'} — bỏ ${revoked.length} token` +
      (clientsLeft.size === 0 && hadLarkToken ? ', hết chỗ cắm nên xoá luôn token Lark' : `, còn ${clientsLeft.size} chỗ cắm`),
  );
  return {
    tokens: revoked.length,
    clientsLeft: clientsLeft.size,
    larkTokenDeleted: clientsLeft.size === 0 && hadLarkToken,
    found: revoked.length > 0 || hadLarkToken,
  };
}

export function resolveBearer(token) {
  if (!token) return null;
  const db = load();
  const row = db.tokens[hashToken(token)];
  if (!row || row.expiresAt < Date.now()) return null;
  return { ...row, clientApp: appNameOf(db, row.clientId) }; // { openId, name, clientId, clientApp, expiresAt }
}

/**
 * Số CẶP token còn sống tối đa cho mỗi (người, ứng dụng).
 *
 * Không giới hạn thì bộ token phình đơn điệu: nút "Disconnect" của Claude KHÔNG
 * gọi `/revoke` về đây (đã xác minh bằng log ngày 03/09/2026 — cắm lại không
 * sinh một dòng revoke nào), nên mỗi lần cắm lại là thêm một cặp, cặp cũ sống
 * tiếp 30/180 ngày. Đo trên tài khoản thật: một người có 18 token còn dùng
 * được, riêng một client_id đã 3 cặp.
 *
 * KHÔNG bỏ hết cặp cũ khi cấp cặp mới. DCR gộp mọi bản Claude vào CHUNG một
 * client_id, nên cùng một người dùng Claude Desktop và claude.ai web sẽ trùng
 * (openId, clientId); bỏ hết nghĩa là đăng nhập bên này ngắt phiên bên kia.
 * Giữ vài cặp gần nhất là chặn được phình mà không giết phiên đang dùng.
 */
const MAX_GRANTS = 5;

/**
 * Bỏ những cặp CŨ NHẤT vượt quá ngưỡng của đúng (người, ứng dụng) đó.
 * Xoá theo `grantId` nên access và refresh của cùng một lần cấp đi liền nhau —
 * bỏ lẻ một nửa thì client vẫn refresh lại được, coi như chưa bỏ gì.
 */
function pruneGrants(db, openId, clientId) {
  const grants = new Map();
  for (const [hash, t] of Object.entries(db.tokens)) {
    if (t.openId !== openId || t.clientId !== clientId || !t.grantId) continue;
    const g = grants.get(t.grantId) || { at: t.issuedAt || 0, hashes: [] };
    g.at = Math.max(g.at, t.issuedAt || 0);
    g.hashes.push(hash);
    grants.set(t.grantId, g);
  }
  if (grants.size <= MAX_GRANTS) return 0;
  const old = [...grants.values()].sort((a, b) => b.at - a.at).slice(MAX_GRANTS);
  for (const g of old) for (const h of g.hashes) delete db.tokens[h];
  return old.length;
}

function issueTokens(openId, name, clientId, replaceGrantId = null) {
  const db = load();
  const access = rand(32);
  const refresh = rand(32);
  const ttl = 30 * 24 * 3600 * 1000;
  const grantId = rand(8);
  const issuedAt = Date.now();

  // Xoay refresh token: cặp CŨ bị thay, không phải bổ sung. Trước đây chỉ xoá
  // đúng refresh token gửi lên, còn access token cùng cặp nằm lại tới 30 ngày.
  if (replaceGrantId) {
    for (const [hash, t] of Object.entries(db.tokens)) {
      if (t.grantId === replaceGrantId) delete db.tokens[hash];
    }
  }

  db.tokens[hashToken(access)] = { openId, name, clientId, kind: 'access', grantId, issuedAt, expiresAt: issuedAt + ttl };
  db.tokens[hashToken(refresh)] = { openId, name, clientId, kind: 'refresh', grantId, issuedAt, expiresAt: issuedAt + ttl * 6 };

  const dropped = pruneGrants(db, openId, clientId);
  if (dropped) console.log(`[oauth] ${name || openId} / ${appNameOf(db, clientId) || clientId}: bỏ ${dropped} cặp token cũ (giữ ${MAX_GRANTS} cặp gần nhất)`);
  save(db);
  // Đây là chỗ duy nhất phát bearer — cả lần cắm đầu và mỗi lần xoay refresh
  // token đều đi qua đây, nên chỉ cần ghi danh tính ở một chỗ. Fire-and-forget:
  // Supabase chết thì người dùng vẫn đăng nhập được.
  recordAuth({ openId, name, clientId, clientApp: appNameOf(db, clientId) });
  return { access_token: access, refresh_token: refresh, token_type: 'Bearer', expires_in: ttl / 1000 };
}

/**
 * Cấp bearer cho một user đã đăng nhập Lark từ trước, không qua HTTP.
 * Dùng cho test và công cụ quản trị chạy tại chỗ — KHÔNG expose thành route.
 */
export function issueForUser(openId, name = '', clientId = 'local-admin') {
  return issueTokens(openId, name, clientId);
}

export function buildOAuthRouter() {
  const r = express.Router();

  // Metadata phải khai ĐÚNG tên miền mà request đi vào, không phải một hằng số.
  // Nướng cứng `PUBLIC_URL` thì tên miền thứ hai vừa dựng lên đã tự đá người
  // dùng ngược về tên thứ nhất. Xem `publicUrlFor` trong config.js.

  // ── Metadata: Claude đọc hai file này để biết phải đi đâu ────────────────
  // RFC 9728: đường chuẩn là chèn well-known TRƯỚC path của resource, tức
  // `/.well-known/oauth-protected-resource/mcp`. Đường ở gốc chỉ là dự phòng.
  // codex-mcp-client thử cả hai biến thể có hậu tố /mcp trước rồi mới lùi về
  // gốc — nó chạy được nhờ fallback, nhưng client nào không có fallback sẽ tịt.
  r.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (req, res) => {
    const ISS = publicUrlFor(req);
    res.json({
      resource: ISS,
      authorization_servers: [ISS],
      bearer_methods_supported: ['header'],
    });
  });
  r.get(
    [
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-authorization-server/mcp',
      '/.well-known/openid-configuration',
      '/.well-known/openid-configuration/mcp',
    ],
    (req, res) => {
      const ISS = publicUrlFor(req);
      res.json({
        issuer: ISS,
        authorization_endpoint: `${ISS}/authorize`,
        token_endpoint: `${ISS}/token`,
        registration_endpoint: `${ISS}/register`,
        revocation_endpoint: `${ISS}/revoke`,
        revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['lark'],
      });
    },
  );

  // ── Dynamic Client Registration ─────────────────────────────────────────
  r.post('/register', express.json(), (req, res) => {
    const { redirect_uris, client_name } = req.body || {};
    if (!Array.isArray(redirect_uris) || redirect_uris.length === 0) {
      return res.status(400).json({ error: 'invalid_redirect_uri', error_description: 'redirect_uris bắt buộc' });
    }
    const db = load();
    const name = client_name || 'MCP client';

    // Dedup: cùng client_name + cùng TẬP redirect_uris thì tái dùng client_id cũ
    // thay vì đúc mới. Không có bước này thì mỗi lần Claude đăng ký lại connector
    // là một client_id mới → machine_id mới (machine_id = hash(open_id|client_id))
    // → một dòng 'url-*' trùng người trong bảng machines.
    //
    // client_id là định danh ỨNG DỤNG, không bí mật (public client + PKCE), nên
    // nhiều người cùng dùng "Claude" CHIA SẺ một client_id là đúng chuẩn OAuth —
    // machine_id vẫn tách theo open_id nên mỗi người vẫn một dòng riêng.
    const sameSet = (a, b) =>
      Array.isArray(a) && a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
    const existing = Object.values(db.clients).find((c) => c.name === name && sameSet(c.redirectUris, redirect_uris));

    const clientId = existing?.clientId || rand(16);
    if (!existing) {
      db.clients[clientId] = { clientId, redirectUris: redirect_uris, name, createdAt: Date.now() };
      save(db);
    }

    res.status(201).json({
      client_id: clientId,
      client_name: name,
      redirect_uris,
      token_endpoint_auth_method: 'none',
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    });
  });

  // ── /authorize: mở device flow Lark, hiện link cho user bấm ─────────────
  r.get('/authorize', async (req, res) => {
    const { client_id, redirect_uri, state, code_challenge, code_challenge_method, response_type } = req.query;
    const db = load();
    const client = db.clients[client_id];

    if (!client) return res.status(400).send(errPage('client_id không hợp lệ. Claude cần đăng ký lại connector.'));
    if (!client.redirectUris.includes(redirect_uri)) return res.status(400).send(errPage('redirect_uri không khớp đăng ký.'));
    if (response_type !== 'code') return res.status(400).send(errPage('Chỉ hỗ trợ response_type=code.'));
    if (!code_challenge || code_challenge_method !== 'S256') {
      return res.status(400).send(errPage('Bắt buộc PKCE với S256.'));
    }

    let flow;
    try {
      flow = await startDeviceFlow();
    } catch (e) {
      return res.status(502).send(errPage(`Không khởi tạo được đăng nhập Lark: ${e.message}`));
    }

    const flowId = rand(16);
    flows.set(flowId, {
      deviceCode: flow.deviceCode,
      clientId: client_id,
      redirectUri: redirect_uri,
      state,
      codeChallenge: code_challenge,
      interval: flow.interval * 1000,
      nextPollAt: 0,
      expiresAt: Date.now() + flow.expiresIn * 1000,
    });

    res.type('html').send(loginPage(flowId, flow.verifyUrl, flow.userCode));
  });

  // Trang login tự gọi endpoint này; ta poll Lark hộ, tránh lộ device_code ra browser
  r.get('/authorize/poll', async (req, res) => {
    // Endpoint polling nằm sau CDN — ETag của Express từng trả 304 ở đây.
    // Cache một câu trả lời "pending" là đủ để treo cả luồng đăng nhập.
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    const f = flows.get(req.query.flow);
    if (!f) return res.json({ status: 'expired' });
    if (Date.now() > f.expiresAt) {
      flows.delete(req.query.flow);
      return res.json({ status: 'expired' });
    }
    if (Date.now() < f.nextPollAt) return res.json({ status: 'pending' });
    f.nextPollAt = Date.now() + f.interval;

    let out;
    try {
      out = await pollDeviceFlow(f.deviceCode);
    } catch (e) {
      out = { status: 'network', description: e.message };
    }

    // Lỗi mạng thoáng qua: giữ phiên, chỉ bỏ cuộc khi hỏng liên tiếp
    if (out.status === 'network') {
      f.netErrors = (f.netErrors || 0) + 1;
      if (f.netErrors <= 8) return res.json({ status: 'pending' });
      flows.delete(req.query.flow);
      return res.json({ status: 'error', message: `Mất kết nối tới Lark: ${out.description}` });
    }
    f.netErrors = 0;

    if (out.status === 'slow_down') {
      f.interval += 2000;
      return res.json({ status: 'pending' });
    }
    if (out.status === 'pending') return res.json({ status: 'pending' });
    if (out.status === 'error') {
      flows.delete(req.query.flow);
      return res.json({ status: 'error', message: `${out.error}: ${out.description}` });
    }

    // Lark đã duyệt — lưu token của user rồi phát authorization code cho Claude
    let who;
    try {
      who = await persistTokens(out.tokens);
    } catch (e) {
      return res.json({ status: 'error', message: `Lưu token thất bại: ${e.message}` });
    }
    flows.delete(req.query.flow);

    const code = rand(24);
    codes.set(code, {
      openId: who.openId,
      name: who.name,
      clientId: f.clientId,
      redirectUri: f.redirectUri,
      codeChallenge: f.codeChallenge,
      expiresAt: Date.now() + 600_000,
    });

    const back = new URL(f.redirectUri);
    back.searchParams.set('code', code);
    if (f.state) back.searchParams.set('state', f.state);
    // Mốc phân định trách nhiệm: có dòng này mà không thấy `POST /token` ngay
    // sau đó nghĩa là phần của ta đã xong — Lark duyệt rồi, code đã phát — và
    // thứ hỏng nằm ở trình duyệt hoặc phía Claude. Không có dòng này thì ngược
    // lại: Lark chưa từng duyệt. Trước đây hai trường hợp đó trông y hệt nhau.
    console.log(`[oauth] đã duyệt Lark, phát code cho ${who.name} — chờ Claude đổi lấy token`);
    res.json({ status: 'done', redirect: back.toString(), name: who.name });
  });

  // ── /token ──────────────────────────────────────────────────────────────
  r.post('/token', express.urlencoded({ extended: true }), express.json(), (req, res) => {
    const b = { ...req.body, ...req.query };

    /**
     * Grant bị từ chối là dấu hiệu client đang KẸT — Claude thử refresh bằng
     * token đã chết sẽ lặp lại mãi và người dùng chỉ thấy "connector lỗi".
     * Không ghi lại thì cả sự cố đó vô hình với dashboard, vì chưa có tool call
     * nào để mà xuất hiện trong audit.
     */
    const deny = (why, extra = {}) => {
      auditAuth({
        event: 'grant_denied',
        clientId: b.client_id || null,
        ok: false,
        errorMsg: why,
        detail: { grant_type: b.grant_type || null, ...extra },
      });
      return res.status(400).json({ error: 'invalid_grant', error_description: why });
    };

    if (b.grant_type === 'authorization_code') {
      const c = codes.get(b.code);
      if (!c || c.expiresAt < Date.now()) return deny('code không hợp lệ hoặc đã hết hạn');
      codes.delete(b.code); // dùng một lần
      if (c.clientId !== b.client_id) return deny('client_id lệch');
      if (c.redirectUri !== b.redirect_uri) return deny('redirect_uri lệch');
      if (b64url(sha256(b.code_verifier || '')) !== c.codeChallenge) return deny('PKCE không khớp');

      auditAuth({ event: 'login', openId: c.openId, userName: c.name, clientId: c.clientId });
      return res.json(issueTokens(c.openId, c.name, c.clientId));
    }

    if (b.grant_type === 'refresh_token') {
      const row = resolveBearer(b.refresh_token);
      if (!row || row.kind !== 'refresh') return deny('refresh token không hợp lệ hoặc đã hết hạn');

      // Token cấp TRƯỚC bản vá cặp không có `grantId`. Với chúng vẫn phải xoay
      // theo cách cũ — bỏ đúng phiếu gửi lên — nếu không thì refresh token đã
      // dùng vẫn sống, đúng cái mà vòng xoay sinh ra để chặn.
      if (!row.grantId) {
        const db = load();
        delete db.tokens[hashToken(b.refresh_token)];
        save(db);
      }
      // Bearer sống 30 ngày nên đây là sự kiện hiếm — ghi mọi lượt vẫn rẻ, và
      // nó là mốc duy nhất chứng minh vòng xoay token phía Claude còn chạy.
      auditAuth({ event: 'refresh', openId: row.openId, userName: row.name, clientId: row.clientId });
      return res.json(issueTokens(row.openId, row.name, row.clientId, row.grantId || null));
    }

    auditAuth({ event: 'grant_denied', clientId: b.client_id || null, ok: false, errorMsg: 'grant_type không hỗ trợ', detail: { grant_type: b.grant_type || null } });
    res.status(400).json({ error: 'unsupported_grant_type' });
  });

  // ── /revoke (RFC 7009) ──────────────────────────────────────────────────
  //
  // Thu hồi CẢ grant của chỗ cắm đó, không chỉ riêng token được gửi lên: RFC
  // 7009 cho phép, và đó là điều người bấm "ngắt kết nối" thật sự muốn — bỏ
  // access token mà giữ refresh token thì client tự lấy lại được token mới.
  //
  // Chỗ cắm CUỐI CÙNG của một người bị thu hồi thì xoá luôn token Lark của họ:
  // không còn client nào dùng nữa, giữ lại chỉ là để dành một refresh token
  // sống trên đĩa. Lần sau người đó phải duyệt lại trên Lark — đúng nghĩa
  // "đã ngắt".
  //
  // Luôn trả 200 kể cả token sai, theo RFC: trả lỗi khác nhau là cho người ngoài
  // dò xem token nào còn sống.
  r.post('/revoke', express.urlencoded({ extended: true }), express.json(), (req, res) => {
    const b = { ...req.body, ...req.query };
    const row = resolveBearer(b.token);
    if (!row) return res.status(200).end();

    const out = revokeGrant({ openId: row.openId, clientId: row.clientId, name: row.name });
    auditAuth({ event: 'revoke', openId: row.openId, userName: row.name, clientId: row.clientId, detail: out });
    res.status(200).end();
  });

  // Đã từng có `/admin/revoke` cho dashboard bấm từ xa. Bỏ đi vì không dựng
  // được đăng nhập cho dashboard: một endpoint thu hồi mở ra HTTP mà chỉ dựa
  // vào một secret dùng chung là quá nhiều rủi ro cho thứ `npm run revoke` đã
  // làm được. Cần lại thì lấy từ git — `revokeGrant()` vẫn còn nguyên.

  return r;
}

// ── Giao diện ─────────────────────────────────────────────────────────────
const shell = (body) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kết nối Lark</title>
<style>
 body{font:15px/1.6 system-ui,sans-serif;max-width:520px;margin:12vh auto;padding:0 24px;color:#1a1a1a}
 @media(prefers-color-scheme:dark){body{background:#111;color:#eee}.box{background:#1c1c1c;border-color:#333}}
 .box{border:1px solid #ddd;border-radius:12px;padding:24px;margin:20px 0}
 a.btn{display:block;text-align:center;background:#2563eb;color:#fff;padding:13px;border-radius:9px;text-decoration:none;font-weight:600}
 code{font-size:20px;letter-spacing:2px;font-weight:600}
 .muted{color:#888;font-size:13px}
 button.btn{display:block;width:100%;background:#2563eb;color:#fff;padding:13px;border:0;border-radius:9px;font:inherit;font-weight:600;cursor:pointer}
</style>${body}`;

const errPage = (msg) => shell(`<div class="box"><h3>Không kết nối được</h3><p>${msg}</p></div>`);

/**
 * Trang chờ duyệt Lark.
 *
 * Bản trước hỏng theo một cách rất kín: nó mở Lark bằng TAB MỚI mà không hề nói
 * người dùng phải quay lại tab này. Duyệt xong trên Lark thì tab Lark chẳng có
 * gì thêm, nên người ta quay về tab CLAUDE — thấy vẫn "chưa connect" thì bấm
 * Connect lần nữa, sinh flow mới và mã mới. Vài vòng là ba bốn tab cùng chờ,
 * mỗi tab một mã khác nhau, và cái tab đang giữ lệnh chuyển hướng thì không ai
 * nhìn tới.
 *
 * Hậu quả đo được ngày 03/09/2026: token Lark ĐÃ lưu (persistTokens chạy trước
 * khi phát code) nhưng Claude không bao giờ gọi `/token`, nên người dùng thấy
 * "duyệt xong xuôi mà vẫn chưa kết nối". Hôm đó 16 lượt mở trang chỉ đổi được
 * 9 token; có máy mở 4 lần trong 2 phút mà không lần nào tới `/token`.
 *
 * Ba thay đổi, đều nhắm đúng chỗ đó:
 *   1. Xong thì vẫn hiện link bấm tay, phòng khi lệnh chuyển hướng không chạy
 *      (tab nền bị trình duyệt bóp). Trước đây hỏng ở đây là hỏng câm.
 *   2. Hỏi lại NGAY khi tab được nhìn lại, không chờ hết nhịp 2.5s — người dùng
 *      quay về là thấy kết quả luôn.
 *   3. Hết hạn thì có nút lấy mã mới, thay vì một dòng chữ bảo tự tải lại.
 *
 * ĐÃ CÓ một khung cảnh báo vàng dặn phải quay lại trang này, nhắm thẳng vào
 * nguyên nhân gốc. Bỏ đi theo yêu cầu ngày 03/09/2026: nó làm người dùng hiểu
 * nhầm là có gì đó sai, trong khi luồng bình thường chỉ mất ~13 giây nên hiếm
 * ai kịp đi lạc. Nếu tỉ lệ /authorize so với /token tụt lại thì đây là thứ đầu
 * tiên nên cân nhắc đưa về, dưới dạng một dòng chữ nhạt thay vì khung vàng.
 *
 * Vòng poll giữ nguyên: nó đã chạy đúng qua 98 lượt đăng nhập thành công, không
 * có lý do gì đụng vào.
 */
const loginPage = (flowId, url, userCode) =>
  shell(`
<h2>Kết nối Lark</h2>
<p>Bấm nút bên dưới để đăng nhập bằng tài khoản Lark của bạn. Claude sẽ chỉ hành động với đúng quyền của bạn.</p>
<div class="box">
  <a class="btn" href="${url}" target="_blank" rel="noopener">Đăng nhập Lark</a>
  <p style="text-align:center;margin:16px 0 0">Mã xác nhận: <code>${userCode}</code></p>
</div>
<p id="s" class="muted">Đang chờ bạn duyệt trên Lark…</p>
<div id="done" style="display:none">
  <a class="btn" id="go" href="#">Quay lại Claude</a>
  <p class="muted" style="text-align:center">Nếu trang không tự chuyển, bấm nút trên.</p>
</div>
<div id="again" style="display:none"><button class="btn" onclick="location.reload()">Lấy mã mới</button></div>
<script>
const s=document.getElementById('s');
const flow='${flowId}';
let stopped=false;

async function tick(){
  if(stopped) return;
  const r=await fetch('/authorize/poll?flow='+flow,{cache:'no-store'}).then(r=>r.json()).catch(()=>({status:'pending'}));
  if(r.status==='done'){
    stopped=true;
    s.textContent='Đã duyệt xong — đang quay lại Claude…';
    // Hiện link TRƯỚC khi chuyển hướng: tab nền bị bóp thì lệnh dưới không
    // chạy, và khi đó đây là đường thoát duy nhất người dùng còn thấy.
    const g=document.getElementById('go');
    g.href=r.redirect;
    document.getElementById('done').style.display='block';
    location.href=r.redirect;
  } else if(r.status==='expired'){
    stopped=true;
    s.textContent='Mã đã hết hạn.';
    document.getElementById('again').style.display='block';
  } else if(r.status==='error'){
    stopped=true;
    s.textContent='Lỗi: '+r.message;
    document.getElementById('again').style.display='block';
  }
}

setInterval(tick,2500);
// Quay lại tab là hỏi ngay, đừng bắt chờ hết nhịp — và nếu trình duyệt đã treo
// setInterval lúc tab ở nền thì đây là thứ đánh thức lại vòng lặp.
document.addEventListener('visibilitychange',()=>{ if(!document.hidden) tick(); });
window.addEventListener('pageshow',tick);
</script>`);
