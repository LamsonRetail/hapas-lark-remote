/**
 * Giữ server + tunnel luôn sống.
 *
 * Server này phục vụ nhiều người, nên nó chết là cả công ty mất kết nối — và
 * không ai biết cho tới khi có người kêu. Supervisor lo bốn việc:
 *   1. Dựng tunnel, lấy URL công khai TRƯỚC rồi mới bật server
 *      (server đọc PUBLIC_URL lúc khởi động để phát OAuth metadata)
 *   2. Cái nào chết thì bật lại, backoff tăng dần
 *   3. Ghi log ra file để soi lại sự cố lúc 2 giờ sáng
 *   4. In trạng thái để nhìn màn hình là biết còn sống hay không
 *
 *   node supervisor.js
 *
 * Ba chế độ tunnel, chọn bằng TUNNEL trong .env:
 *   tailscale  — Tailscale Funnel. URL cố định vĩnh viễn, miễn phí, không cần
 *                domain. Funnel do dịch vụ tailscaled giữ (`--bg`) nên supervisor
 *                KHÔNG nuôi tiến trình tunnel nào — chỉ bật một lần rồi đọc
 *                hostname. Đây là cấu hình đang dùng.
 *   cloudflare  + TUNNEL_NAME — named tunnel, URL cố định, cần domain trên
 *                Cloudflare.
 *   cloudflare  không TUNNEL_NAME — quick tunnel, URL ĐỔI mỗi lần chạy lại và
 *                mọi người phải cắm lại connector. Chỉ hợp để thử.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import https from 'node:https';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const ENV = path.join(ROOT, '.env');
if (fs.existsSync(ENV)) process.loadEnvFile(ENV);

const LOG_DIR = path.join(ROOT, '.data', 'logs');
fs.mkdirSync(LOG_DIR, { recursive: true });
const logPath = path.join(LOG_DIR, 'server.log');
const MAX_LOG_BYTES = 10 * 1024 * 1024;

const CLOUDFLARED = [
  process.env.CLOUDFLARED_PATH,
  'C:\\Program Files (x86)\\cloudflared\\cloudflared.exe',
  'C:\\Program Files\\cloudflared\\cloudflared.exe',
  'cloudflared',
].find((p) => p && (p === 'cloudflared' || fs.existsSync(p)));

const TAILSCALE = [
  process.env.TAILSCALE_PATH,
  'C:\\Program Files\\Tailscale\\tailscale.exe',
  'C:\\Program Files (x86)\\Tailscale\\tailscale.exe',
  'tailscale',
].find((p) => p && (p === 'tailscale' || fs.existsSync(p)));

function write(line) {
  const stamped = `[${new Date().toISOString().slice(11, 19)}] ${line}`;
  process.stdout.write(stamped + '\n');
  try {
    if (fs.existsSync(logPath) && fs.statSync(logPath).size > MAX_LOG_BYTES) {
      fs.renameSync(logPath, path.join(LOG_DIR, 'server.prev.log'));
    }
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${line}\n`);
  } catch {
    /* log hỏng thì kệ, đừng làm chết supervisor */
  }
}

function setEnvVar(key, value) {
  let txt = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8') : '';
  txt = new RegExp(`^${key}=.*$`, 'm').test(txt)
    ? txt.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`)
    : txt.replace(/\n*$/, '\n') + `${key}=${value}\n`;
  fs.writeFileSync(ENV, txt);
  process.env[key] = value;
}

let stopping = false;
const procs = {};

// ── Tunnel ────────────────────────────────────────────────────────────────
const PORT_ = Number(process.env.PORT || 8787);
const PROVIDER = (process.env.TUNNEL || 'cloudflare').trim().toLowerCase();
let publicUrl = null;

const ts = (args) =>
  execFileSync(TAILSCALE, args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] });

/**
 * Tailscale Funnel.
 *
 * Không có tiến trình nào để nuôi: funnel do dịch vụ `tailscaled` giữ, cấu hình
 * nằm trong đó và tự bật lại sau reboot. Việc của supervisor chỉ là bảo đảm nó
 * đang trỏ đúng cổng rồi đọc hostname — hostname này cố định vĩnh viễn.
 */
function startFunnel() {
  if (!TAILSCALE) throw new Error('Không tìm thấy tailscale.exe — cài Tailscale hoặc đặt TAILSCALE_PATH trong .env.');

  let status;
  try {
    status = JSON.parse(ts(['status', '--json']));
  } catch (e) {
    throw new Error(`Không hỏi được trạng thái Tailscale: ${e.message}`);
  }
  if (status.BackendState !== 'Running') {
    throw new Error(`Tailscale chưa đăng nhập (BackendState=${status.BackendState}). Chạy: tailscale up`);
  }

  const host = (status.Self?.DNSName || '').replace(/\.$/, '');
  if (!host) throw new Error('Tailscale không trả về DNSName — bật MagicDNS trong admin console.');

  // Gọi lại khi đã bật thì không sao. Lỗi hay gặp nhất là tailnet chưa bật
  // Funnel trong ACL; tailscale in kèm link để bật, giữ nguyên lời nhắn đó
  // thay vì nuốt mất.
  try {
    ts(['funnel', '--bg', String(PORT_)]);
  } catch (e) {
    const detail = [e.stderr, e.stdout].filter(Boolean).join('\n').trim() || e.message;
    throw new Error(`Bật Funnel thất bại:\n${detail}`);
  }

  write(`Tailscale Funnel → localhost:${PORT_}`);
  return `https://${host}`;
}

function startCloudflared() {
  return new Promise((resolve) => {
    if (!CLOUDFLARED) {
      write('Không tìm thấy cloudflared — chạy CHỈ TRÊN LOCALHOST, người ngoài không vào được.');
      return resolve(process.env.PUBLIC_URL || 'http://localhost:' + (process.env.PORT || 8787));
    }

    const named = (process.env.TUNNEL_NAME || '').trim();
    const args = named
      ? ['tunnel', 'run', named]
      : ['tunnel', '--url', `http://localhost:${process.env.PORT || 8787}`, '--no-autoupdate'];

    write(named ? `Tunnel cố định: ${named}` : 'Tunnel tạm (URL sẽ đổi mỗi lần chạy lại)');
    const p = spawn(CLOUDFLARED, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    procs.tunnel = p;

    let settled = false;
    const onData = (buf) => {
      const s = String(buf);
      const m = s.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !settled) {
        settled = true;
        resolve(m[0]);
      }
      for (const line of s.split('\n')) {
        if (/ERR|error|failed/i.test(line) && line.trim()) write('  [tunnel] ' + line.trim().slice(0, 160));
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);

    p.on('exit', (code) => {
      if (stopping) return;
      write(`TUNNEL DỪNG (code=${code}) — dựng lại sau 3s`);
      setTimeout(async () => {
        const url = await startCloudflared();
        if (url && url !== publicUrl) {
          write('');
          write('!!! URL CÔNG KHAI ĐÃ ĐỔI !!!');
          write(`    cũ : ${publicUrl}`);
          write(`    mới: ${url}`);
          write('    Mọi người phải XOÁ connector cũ và thêm lại bằng URL mới.');
          write('    Đặt TUNNEL_NAME trong .env để URL không bao giờ đổi nữa.');
          write('');
          publicUrl = url;
          setEnvVar('PUBLIC_URL', url);
          procs.server?.kill(); // server đọc PUBLIC_URL lúc khởi động
        }
      }, 3000);
    });

    // Tunnel cố định không in URL trycloudflare — dùng PUBLIC_URL đã cấu hình
    if (named) setTimeout(() => !settled && ((settled = true), resolve(process.env.PUBLIC_URL)), 4000);
  });
}

const startTunnel = () => (PROVIDER === 'tailscale' ? startFunnel() : startCloudflared());

// ── Server ────────────────────────────────────────────────────────────────
let restarts = 0;
let startedAt = Date.now();

function startServer() {
  startedAt = Date.now();
  const p = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, PUBLIC_URL: publicUrl },
  });
  procs.server = p;

  const relay = (buf) => {
    for (const line of String(buf).split('\n')) if (line.trim()) write('  ' + line.trim());
  };
  p.stdout.on('data', relay);
  p.stderr.on('data', relay);

  p.on('exit', (code, signal) => {
    if (stopping) return;
    // Chạy ổn >2 phút thì coi lần chết này là sự cố lẻ, reset đếm
    if (Date.now() - startedAt > 120_000) restarts = 0;
    const wait = Math.min(1000 * 2 ** restarts, 60_000);
    restarts++;
    write(`SERVER DỪNG (code=${code} signal=${signal}) — bật lại sau ${wait / 1000}s (lần ${restarts})`);
    setTimeout(startServer, wait);
  });
}

// ── Vòng đời ──────────────────────────────────────────────────────────────
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    stopping = true;
    write('Nhận lệnh dừng — tắt server và tunnel.');
    procs.server?.kill();
    procs.tunnel?.kill();
    setTimeout(() => process.exit(0), 1500);
  });
}

/**
 * Hai supervisor cùng chạy sẽ tranh cổng 8787: server của cái này bị EADDRINUSE
 * rồi chết, supervisor bật lại, lặp vô hạn. Nhìn log thì tưởng server tự chết.
 * Đã dính đúng bẫy này lúc dựng — nên chặn thẳng từ đầu.
 */
const PORT = Number(process.env.PORT || 8787);
try {
  const r = await fetch(`http://localhost:${PORT}/health`, { signal: AbortSignal.timeout(2000) });
  if (r.ok) {
    write(`Đã có server chạy ở cổng ${PORT}. Dừng cái đó trước, hoặc đổi PORT trong .env.`);
    // Mã 3 = "có người khác đang phục vụ". start-server.bat đọc mã này để KHÔNG
    // bật lại vòng vòng — bật lại chỉ tạo đúng cái vòng lặp EADDRINUSE nói trên.
    process.exit(3);
  }
} catch {
  /* không ai trả lời = cổng trống, chạy tiếp */
}

write('Supervisor khởi động. Ctrl+C để dừng hẳn.');
write(`Log: ${logPath}`);

// Lỗi Tailscale gần như luôn là thiếu một bước cấu hình, và thông điệp của
// tailscale đã nói rõ phải làm gì. In nguyên văn, đừng chôn dưới stack trace.
//
// Nhưng KHÔNG được thoát. Sau khi mất điện, Windows đăng nhập và gọi autostart
// trong lúc tailscaled còn đang dựng lại phiên (BackendState=NoState) — chỗ này
// trước đây exit(1), nên autostart chạy đúng một lần rồi chết và cả công ty mất
// kết nối tới khi có người mở tay. Đã dính đúng thế chiều 23/08/2026. Chờ là
// đủ: tailscaled tự đăng nhập lại bằng khoá đã lưu, funnel cũng tự bật lại.
for (let attempt = 1; publicUrl === null; attempt++) {
  try {
    publicUrl = await startTunnel();
  } catch (e) {
    const wait = Math.min(5000 * attempt, 60_000);
    write('');
    write(String(e.message));
    write(`Chưa dựng được tunnel — thử lại sau ${wait / 1000}s (lần ${attempt}).`);
    write('');
    await new Promise((r) => setTimeout(r, wait));
  }
}
if (publicUrl && publicUrl !== process.env.PUBLIC_URL) setEnvVar('PUBLIC_URL', publicUrl);

write('');
write('════════════════════════════════════════════════════════════');
write(`  URL CHO CLAUDE:  ${publicUrl}/mcp`);
write('════════════════════════════════════════════════════════════');
write('');


/**
 * Kiểm tra người NGOÀI có vào được không — khác hẳn "server còn sống không".
 *
 * Ngày 03/09/2026 có người báo Claude không đăng ký được connector, mà access
 * log KHÔNG có lấy một dòng: request chưa bao giờ tới nơi. Đo ra thì thủ phạm
 * là DNS của chính cái tên `*.ts.net` — Cloudflare 1.1.1.1 trả NXDOMAIN 13/20
 * lượt trong khi Google 8.8.8.8 trả đúng 20/20. Client nào vớ phải resolver
 * đang giữ bản ghi rỗng thì không kết nối được, còn phía ta xanh hoàn toàn.
 *
 * Nhịp tim cũ mù ở đúng loại sự cố này: nó gọi localhost, và `funnel status`
 * chỉ đọc CẤU HÌNH chứ không chứng minh có ai vào nổi.
 *
 * Hai phép đo tách bạch, vì hỏng ở hai tầng khác nhau:
 *   1. DNS — hỏi thẳng nhiều resolver công cộng. Đây là chỗ đang hỏng thật.
 *   2. HTTP — nối tới IP ingress kèm SNI, KHÔNG qua MagicDNS. Gọi từ máy này
 *      bằng tên miền sẽ bị MagicDNS trả 100.x rồi đi đường nội bộ: luôn xanh,
 *      không chứng minh được gì.
 */
const RESOLVERS = [
  ['google', (h) => `https://dns.google/resolve?name=${h}&type=A`],
  ['cloudflare', (h) => `https://1.1.1.1/dns-query?name=${h}&type=A`],
];

async function resolvePublic(host) {
  const out = {};
  await Promise.all(
    RESOLVERS.map(async ([name, url]) => {
      try {
        const r = await fetch(url(host), {
          headers: { accept: 'application/dns-json' },
          signal: AbortSignal.timeout(8000),
        });
        const j = await r.json();
        out[name] = {
          ok: j.Status === 0,
          ips: (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data),
          status: j.Status,
        };
      } catch (e) {
        out[name] = { ok: false, ips: [], status: e.name === 'TimeoutError' ? 'timeout' : e.message };
      }
    }),
  );
  return out;
}

/** GET /health qua IP ingress công cộng, giữ SNI + Host đúng tên miền. */
function fetchViaIp(host, ip, pathname = '/health', timeoutMs = 10_000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      { host: ip, port: 443, servername: host, path: pathname, method: 'GET', headers: { Host: host }, timeout: timeoutMs },
      (r) => {
        let body = '';
        r.on('data', (d) => (body += d));
        r.on('end', () => resolve({ ok: r.statusCode === 200, code: r.statusCode, ms: Date.now() - t0, body }));
      },
    );
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, code: 0, ms: Date.now() - t0, err: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, code: 0, ms: Date.now() - t0, err: e.code || e.message }));
    req.end();
  });
}

/**
 * Trả về chuỗi ngắn để nối vào dòng nhịp tim, và tự la lên khi có vấn đề.
 * Im lặng khi mọi thứ tốt — log này đã đủ ồn rồi.
 */
async function checkReachable(publicUrl) {
  if (!publicUrl) return '';
  const host = new URL(publicUrl).hostname;

  const dns = await resolvePublic(host);
  const bad = Object.entries(dns).filter(([, v]) => !v.ok);
  const good = Object.values(dns).find((v) => v.ok);

  if (bad.length) {
    write(
      `DNS CÔNG CỘNG HỎNG — ${bad.map(([n, v]) => `${n}=${v.status === 3 ? 'NXDOMAIN' : v.status}`).join(', ')}` +
        (good ? ` (còn resolver khác vẫn trả ${good.ips.join(',')})` : ' (KHÔNG resolver nào phân giải được)'),
    );
    write('  → client dùng resolver đang hỏng sẽ KHÔNG kết nối được, và access log phía ta sẽ trống trơn.');
  }

  if (!good) return ' | ngoài: DNS chết';

  const hit = await fetchViaIp(host, good.ips[0]);
  if (!hit.ok) {
    write(`NGOÀI KHÔNG VÀO ĐƯỢC — ${host} qua ${good.ips[0]}: ${hit.err || 'HTTP ' + hit.code}`);
    return ' | ngoài: KHÔNG VÀO ĐƯỢC';
  }
  return ` | ngoài: OK ${hit.ms}ms${bad.length ? ` (${bad.length}/${RESOLVERS.length} resolver hỏng)` : ''}`;
}


startServer();

// Nhịp tim: nhìn màn hình là biết còn sống, không phải đoán
setInterval(async () => {
  try {
    const r = await fetch(`http://localhost:${process.env.PORT || 8787}/health`, { signal: AbortSignal.timeout(5000) });
    const j = await r.json();
    const reach = await checkReachable(publicUrl);
    write(`còn sống — ${j.tools} tool, ${j.users} user, liên tục ${Math.round((Date.now() - startedAt) / 60000)} phút${reach}`);
  } catch (e) {
    write(`KHÔNG PHẢN HỒI /health: ${e.message}`);
  }

  // /health chỉ chứng minh server sống, không chứng minh người ngoài vào được.
  // Funnel tắt là cả công ty mất kết nối trong khi log vẫn báo "còn sống".
  if (PROVIDER === 'tailscale') {
    try {
      const st = ts(['funnel', 'status']);
      // Đổi tên máy trong Tailscale thì hostname đổi theo, nhưng serve config
      // vẫn ghim tên CŨ — funnel trỏ vào một tên không còn tồn tại trong khi
      // /health cục bộ vẫn xanh. Đã dính đúng thế lúc đổi tên sang `hapasvn`.
      if (!/https:\/\//.test(st) || (publicUrl && !st.includes(publicUrl))) {
        write('FUNNEL TẮT HOẶC TRỎ SAI TÊN — dựng lại.');
        ts(['serve', 'reset']);
        const url = startFunnel();
        if (url !== publicUrl) {
          write(`URL đổi: ${publicUrl} → ${url}`);
          publicUrl = url;
          setEnvVar('PUBLIC_URL', url);
          procs.server?.kill(); // server đọc PUBLIC_URL lúc khởi động
        }
      }
    } catch (e) {
      write(`Không kiểm tra được Funnel: ${e.message}`);
    }
  }
}, 300_000);
