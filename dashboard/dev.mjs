/**
 * Chạy dashboard ĐẦY ĐỦ tại chỗ.
 *
 *   node dashboard/dev.mjs      →  http://localhost:4173
 *
 * Khác `preview.html` ở chỗ căn bản: file này KHÔNG giả lập backend, nó gọi
 * thẳng hai hàm serverless trong `api/` — cùng hàm mà Vercel gọi, cùng tham số,
 * cùng đường đọc Supabase. Bộ lọc khoảng ngày / người / ứng dụng vì thế chạy
 * thật, và cái gì hỏng ở đây thì cũng hỏng y hệt trên bản deploy.
 *
 * Vì sao cần tới nó: `preview.html` nướng số cho ĐÚNG một khoảng, nên mở nó ra
 * mà bấm chọn ngày thì bộ lọc bật ngược về mốc đã nướng. Đó là giới hạn thật
 * của một trang tĩnh, không phải lỗi — nhưng nó khiến người ta không kiểm được
 * đúng cái tính năng quan trọng nhất của trang. Bản tĩnh để xem BỐ CỤC (và để
 * mở được khi không có mạng); bản này để kiểm HÀNH VI.
 *
 * Chỉ dùng tại chỗ. Nó đọc service role key từ .env và mở một cổng không khoá,
 * nên đừng bao giờ chạy nó ở nơi có người khác với tới được.
 */

import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PORT = Number(process.env.PORT_DASHBOARD || 4173);

// Node >= 21.7 đọc .env sẵn, không cần dotenv — cùng cách src/config.js dùng.
// Phải nạp TRƯỚC khi import api/: sb.mjs đọc process.env ngay lúc nạp mô-đun,
// nên import sớm một nhịp là nó chốt cứng chuỗi rỗng và mọi endpoint trả 500.
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
for (const k of ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY']) {
  if (!process.env[k]) {
    console.error(`Thiếu ${k} trong .env — xem .env.example.`);
    process.exit(1);
  }
}

const [data, explore] = await Promise.all([
  import('./api/data.js').then((m) => m.default),
  import('./api/explore.js').then((m) => m.default),
]);

const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.json': 'application/json' };

/**
 * Vercel đưa cho handler một `res` kiểu Express. `http` thuần thì không có
 * `.status().json()`, nên bắc một lớp mỏng đúng ba phương thức mà handler dùng.
 */
const shim = (res) => ({
  setHeader: (k, v) => res.setHeader(k, v),
  status(code) { this._code = code; return this; },
  json(obj) {
    res.writeHead(this._code || 200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
  },
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const query = Object.fromEntries(url.searchParams);
  const t0 = Date.now();
  const log = (what) => console.log(`  ${what.padEnd(8)} ${url.search || '(mặc định)'} — ${Date.now() - t0}ms`);

  try {
    if (url.pathname === '/api/data') { await data({ query }, shim(res)); return log('data'); }
    if (url.pathname === '/api/explore') { await explore({ query }, shim(res)); return log('explore'); }
  } catch (e) {
    // In nguyên stack ra terminal. Một endpoint chết im lặng ở bản dev là đúng
    // thứ làm mất cả buổi chiều đi tìm lỗi trong JS của trang.
    console.error(e);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    return res.end(JSON.stringify({ error: e.message }));
  }

  // `index.html` chứ không phải `preview.html`: bản index để trống chỗ cắm dữ
  // liệu nên nó tự gọi /api/… — đúng hành vi của bản chạy trên Vercel.
  const file = path.join(HERE, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!file.startsWith(HERE) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Không có file này.');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'text/plain', 'Cache-Control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

server.on('error', (e) => {
  if (e.code !== 'EADDRINUSE') throw e;
  console.error(`Cổng ${PORT} đang bận. Đặt PORT_DASHBOARD=<cổng khác> rồi chạy lại.`);
  process.exit(1);
});

server.listen(PORT, () => {
  console.log(`Dashboard (bản đầy đủ, gọi Supabase thật) → http://localhost:${PORT}`);
  console.log('Chạy `node dashboard/build.mjs` trước nếu vừa sửa template.html hay base.css.\n');
});
