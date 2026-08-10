/**
 * Test đầu-cuối đúng như Claude sẽ làm:
 *   register → authorize → (user duyệt trên Lark) → token → tools/list → gọi tool thật
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
const b64url = (b) => Buffer.from(b).toString('base64url');
const verifier = b64url(crypto.randomBytes(32));
const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
const REDIRECT = 'http://localhost:9999/callback';

const j = async (url, opts) => {
  const r = await fetch(url, opts);
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, text: t };
  }
};

/** Streamable HTTP trả text/event-stream — phải bóc dòng `data:` ra mới có JSON-RPC. */
async function rpc(token, method, params) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await r.text();
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const m = JSON.parse(line.slice(5).trim());
        if (m.result || m.error) return { status: r.status, body: m };
      } catch {}
    }
    return { status: r.status, body: null, text };
  }
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: null, text };
  }
}

/** Bearer đã lấy được thì cache lại — không bắt người dùng duyệt lại mỗi lần test. */
const CACHE = new URL('../.data/.test-bearer', import.meta.url);
async function cachedBearer() {
  if (!fs.existsSync(CACHE)) return null;
  const t = fs.readFileSync(CACHE, 'utf8').trim();
  const probe = await rpc(t, 'tools/list', {});
  return probe.body?.result?.tools ? t : null;
}

(async () => {
  const reused = await cachedBearer();
  if (reused) {
    console.log('[0] dùng lại bearer đã cache — bỏ qua bước OAuth\n');
    return runMcpChecks(reused);
  }

  // 1. DCR
  const reg = await j(`${BASE}/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'test-client', redirect_uris: [REDIRECT] }),
  });
  if (!reg.body?.client_id) return console.error('register hỏng:', reg);
  console.log('[1] register        → client_id ' + reg.body.client_id.slice(0, 10) + '…');

  // 2. authorize
  const authUrl =
    `${BASE}/authorize?response_type=code&client_id=${reg.body.client_id}` +
    `&redirect_uri=${encodeURIComponent(REDIRECT)}&state=xyz` +
    `&code_challenge=${challenge}&code_challenge_method=S256`;
  const page = await fetch(authUrl);
  const html = await page.text();
  if (page.status !== 200) return console.error('authorize hỏng:', page.status, html.slice(0, 200));

  const flowId = html.match(/flow=([\w-]+)/)?.[1];
  const larkUrl = html.match(/href="(https:\/\/accounts[^"]+)"/)?.[1];
  const userCode = html.match(/<code>([^<]+)<\/code>/)?.[1];
  console.log('[2] authorize       → trang login OK\n');
  console.log('    ⇩ MỞ LINK NÀY VÀ BẤM ĐỒNG Ý ⇩');
  console.log('    ' + larkUrl);
  console.log('    mã: ' + userCode + '\n');

  // 3. poll như trình duyệt vẫn làm
  let redirect = null;
  const deadline = Date.now() + 600_000;
  process.stdout.write('[3] chờ duyệt       ');
  while (Date.now() < deadline) {
    const p = await j(`${BASE}/authorize/poll?flow=${flowId}`);
    if (p.body?.status === 'done') {
      redirect = p.body.redirect;
      console.log(' → ' + p.body.name);
      break;
    }
    if (p.body?.status === 'expired') return console.error('\n    hết hạn');
    if (p.body?.status === 'error') return console.error('\n    dừng:', p.body.message || '');
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 2500));
  }
  if (!redirect) return console.error('\n    hết giờ');

  // 4. đổi code lấy bearer
  const code = new URL(redirect).searchParams.get('code');
  const tok = await j(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: reg.body.client_id,
      redirect_uri: REDIRECT,
      code_verifier: verifier,
    }).toString(),
  });
  if (!tok.body?.access_token) return console.error('token hỏng:', tok);
  console.log('[4] token           → bearer OK, hạn ' + Math.round(tok.body.expires_in / 86400) + ' ngày');

  const bearer = tok.body.access_token;

  // 5. PKCE sai phải bị từ chối
  const bad = await j(`${BASE}/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      client_id: reg.body.client_id,
      redirect_uri: REDIRECT,
      code_verifier: 'sai-be-bet',
    }).toString(),
  });
  console.log('[5] code dùng lại   → ' + (bad.status === 400 ? 'bị chặn (đúng)' : 'KHÔNG CHẶN — LỖI BẢO MẬT'));

  fs.writeFileSync(CACHE, bearer, { mode: 0o600 });
  await runMcpChecks(bearer);
})();

async function runMcpChecks(bearer) {
  const list = await rpc(bearer, 'tools/list', {});
  const tools = list.body?.result?.tools;
  if (!tools) {
    return console.error('[6] tools/list      → KHÔNG PARSE ĐƯỢC\n' + (list.text || '').slice(0, 300));
  }
  console.log('[6] tools/list      → ' + tools.length + ' tool');

  for (const [name, args] of [
    ['lark_whoami', {}],
    ['im_chat_list', { page_size: 3 }],
    ['task_search', { page_size: 3 }],
    ['contact_search_user', { query: 'Thẩm' }],
    ['drive_search', { query: 'báo cáo' }],
  ]) {
    const r = await rpc(bearer, 'tools/call', { name, arguments: args });
    const res = r.body?.result;
    if (!res) {
      console.log(`    [FAIL] ${name.padEnd(20)} → không có result: ${(r.text || JSON.stringify(r.body) || '').slice(0, 90)}`);
      continue;
    }
    const c = res.content?.[0]?.text || '';
    let summary = c.slice(0, 80).replace(/\s+/g, ' ');
    try {
      const p = JSON.parse(c);
      if (p.data?.name) summary = p.data.name;
      else if (Array.isArray(p.data?.items)) summary = p.data.items.length + ' mục';
      else if (Array.isArray(p.data?.users)) summary = p.data.users.length + ' người';
    } catch {}
    console.log(`    ${res.isError ? '[FAIL]' : '[OK]  '} ${name.padEnd(20)} → ${summary}`);
  }

  // Chỗ race condition refresh token từng giết session
  const par = await Promise.all(
    Array.from({ length: 5 }, () => rpc(bearer, 'tools/call', { name: 'lark_whoami', arguments: {} })),
  );
  const okCount = par.filter((p) => p.body?.result && !p.body.result.isError).length;
  console.log(`[7] 5 call song song → ${okCount}/5 OK`);
}
