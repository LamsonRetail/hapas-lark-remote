import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { config } from './config.js';
import { startDeviceFlow, pollDeviceFlow, persistTokens } from './lark-auth.js';
import { deleteUser } from './store.js';
import { recordAuth, revokeMachines } from './machines.js';

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

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of flows) if (v.expiresAt < now) flows.delete(k);
  for (const [k, v] of codes) if (v.expiresAt < now) codes.delete(k);
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

export function resolveBearer(token) {
  if (!token) return null;
  const db = load();
  const row = db.tokens[hashToken(token)];
  if (!row || row.expiresAt < Date.now()) return null;
  return { ...row, clientApp: appNameOf(db, row.clientId) }; // { openId, name, clientId, clientApp, expiresAt }
}

function issueTokens(openId, name, clientId) {
  const db = load();
  const access = rand(32);
  const refresh = rand(32);
  const ttl = 30 * 24 * 3600 * 1000;
  db.tokens[hashToken(access)] = { openId, name, clientId, kind: 'access', expiresAt: Date.now() + ttl };
  db.tokens[hashToken(refresh)] = { openId, name, clientId, kind: 'refresh', expiresAt: Date.now() + ttl * 6 };
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
  const ISS = config.publicUrl;

  // ── Metadata: Claude đọc hai file này để biết phải đi đâu ────────────────
  // RFC 9728: đường chuẩn là chèn well-known TRƯỚC path của resource, tức
  // `/.well-known/oauth-protected-resource/mcp`. Đường ở gốc chỉ là dự phòng.
  // codex-mcp-client thử cả hai biến thể có hậu tố /mcp trước rồi mới lùi về
  // gốc — nó chạy được nhờ fallback, nhưng client nào không có fallback sẽ tịt.
  r.get(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp'], (_req, res) => {
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
    (_req, res) => {
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
    const clientId = rand(16);
    db.clients[clientId] = { clientId, redirectUris: redirect_uris, name: client_name || 'MCP client', createdAt: Date.now() };
    save(db);
    res.status(201).json({
      client_id: clientId,
      client_name: client_name || 'MCP client',
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
    res.json({ status: 'done', redirect: back.toString(), name: who.name });
  });

  // ── /token ──────────────────────────────────────────────────────────────
  r.post('/token', express.urlencoded({ extended: true }), express.json(), (req, res) => {
    const b = { ...req.body, ...req.query };

    if (b.grant_type === 'authorization_code') {
      const c = codes.get(b.code);
      if (!c || c.expiresAt < Date.now()) return res.status(400).json({ error: 'invalid_grant' });
      codes.delete(b.code); // dùng một lần
      if (c.clientId !== b.client_id) return res.status(400).json({ error: 'invalid_grant', error_description: 'client_id lệch' });
      if (c.redirectUri !== b.redirect_uri) return res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri lệch' });
      if (b64url(sha256(b.code_verifier || '')) !== c.codeChallenge) {
        return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE không khớp' });
      }
      return res.json(issueTokens(c.openId, c.name, c.clientId));
    }

    if (b.grant_type === 'refresh_token') {
      const row = resolveBearer(b.refresh_token);
      if (!row || row.kind !== 'refresh') return res.status(400).json({ error: 'invalid_grant' });
      const db = load();
      delete db.tokens[hashToken(b.refresh_token)]; // xoay, giống Lark
      save(db);
      return res.json(issueTokens(row.openId, row.name, row.clientId));
    }

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

    const db = load();
    const revoked = [];
    for (const [hash, t] of Object.entries(db.tokens)) {
      if (t.openId !== row.openId || t.clientId !== row.clientId) continue;
      revoked.push(t.kind);
      delete db.tokens[hash];
    }

    const stillHasClients = new Set(
      Object.values(db.tokens).filter((t) => t.openId === row.openId).map((t) => t.clientId),
    );
    save(db);

    revokeMachines({ openId: row.openId, clientIds: [row.clientId] });
    if (stillHasClients.size === 0) deleteUser(row.openId);

    console.log(
      `[revoke] ${row.name || row.openId} / ${row.clientId} — bỏ ${revoked.length} token` +
        (stillHasClients.size === 0 ? ', hết chỗ cắm nên xoá luôn token Lark' : `, còn ${stillHasClients.size} chỗ cắm`),
    );
    res.status(200).end();
  });

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
</style>${body}`;

const errPage = (msg) => shell(`<div class="box"><h3>Không kết nối được</h3><p>${msg}</p></div>`);

const loginPage = (flowId, url, userCode) =>
  shell(`
<h2>Kết nối Lark</h2>
<p>Bấm nút bên dưới để đăng nhập bằng tài khoản Lark của bạn. Claude sẽ chỉ hành động với đúng quyền của bạn.</p>
<div class="box">
  <a class="btn" href="${url}" target="_blank" rel="noopener">Đăng nhập Lark</a>
  <p style="text-align:center;margin:16px 0 0">Mã xác nhận: <code>${userCode}</code></p>
</div>
<p id="s" class="muted">Đang chờ bạn duyệt trên Lark…</p>
<script>
const s=document.getElementById('s');
setInterval(async()=>{
  const r=await fetch('/authorize/poll?flow=${flowId}').then(r=>r.json()).catch(()=>({status:'pending'}));
  if(r.status==='done'){s.textContent='Xong — đang quay lại Claude…';location.href=r.redirect;}
  else if(r.status==='expired'){s.textContent='Hết hạn. Tải lại trang để lấy mã mới.';}
  else if(r.status==='error'){s.textContent='Lỗi: '+r.message;}
},2500);
</script>`);
