import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Node >=21.7 đọc .env sẵn, không cần dotenv
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) process.loadEnvFile(envFile);

function need(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Thiếu biến môi trường ${name} — xem .env.example`);
  return v;
}

const DOMAIN = process.env.LARK_DOMAIN || 'lark';

// Một nguồn duy nhất cho số version: package.json. Trước đây server.js ghi tay
// '3.0.0', thêm chỗ thứ hai cần version là thêm một chỗ để quên cập nhật.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

export const config = {
  version: pkg.version,
  appId: need('LARK_APP_ID'),
  appSecret: need('LARK_APP_SECRET'),
  domain: DOMAIN,

  // Device flow nằm trên HAI host khác nhau — xem port-cli-to-rest.md
  accountsBase: DOMAIN === 'feishu' ? 'https://accounts.feishu.cn' : 'https://accounts.larksuite.com',
  openBase: DOMAIN === 'feishu' ? 'https://open.feishu.cn' : 'https://open.larksuite.com',

  port: Number(process.env.PORT || 8787),
  // URL công khai của server này — Claude dùng để khám phá OAuth metadata
  publicUrl: (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 8787}`).replace(/\/$/, ''),

  // Khoá mã hoá token at-rest (32 byte hex). Chưa đặt thì sinh tạm + cảnh báo.
  tokenKey: process.env.TOKEN_ENC_KEY || null,

  dataDir: process.env.DATA_DIR || path.join(ROOT, '.data'),

  // offline_access BẮT BUỘC, thiếu là không có refresh_token
  scopes: (process.env.LARK_SCOPES || 'offline_access').split(/\s+/).filter(Boolean),
};

/**
 * Tên miền công khai KHÁC được chấp nhận, ngoài PUBLIC_URL. Phân tách bằng dấu phẩy.
 *
 * Có cái này thì mới chạy SONG SONG hai đường vào được. Trước đây toàn bộ OAuth
 * metadata (`issuer`, `authorization_endpoint`, `token_endpoint`,
 * `registration_endpoint`) và header `WWW-Authenticate` đều nướng cứng đúng một
 * giá trị `PUBLIC_URL`. Dựng thêm tên miền thứ hai trỏ vào cùng server thì người
 * vào bằng tên MỚI lập tức bị metadata đá ngược về tên CŨ — tức vẫn dính đúng
 * cái DNS đang hỏng, mà hỏng câm, rất khó nhận ra.
 *
 * Nhờ vậy mới chuyển dần được: 45 người cũ giữ nguyên URL cũ, người mới dùng URL
 * mới, cùng một tiến trình, cùng một kho token. Không có ngày cắt.
 */
const EXTRA_URLS = (process.env.PUBLIC_URL_ALT || '')
  .split(',')
  .map((s) => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

/** host (kèm cổng) → URL đầy đủ. Chỉ những tên đã KHAI mới có mặt ở đây. */
const URL_BY_HOST = new Map(
  [config.publicUrl, ...EXTRA_URLS].map((u) => {
    try {
      return [new URL(u).host.toLowerCase(), u];
    } catch {
      throw new Error(`PUBLIC_URL_ALT có giá trị không phải URL hợp lệ: ${u}`);
    }
  }),
);

export const publicHosts = [...URL_BY_HOST.keys()];

/**
 * URL công khai ĐÚNG với tên miền mà request này đi vào.
 *
 * Danh sách trắng, KHÔNG tin `Host` một cách mù quáng: ai đó gửi
 * `Host: evil.com` mà ta cứ thế khai theo là tự trỏ client của mình sang máy
 * người lạ. Tên lạ thì rơi về `PUBLIC_URL` mặc định.
 */
export function publicUrlFor(req) {
  const raw = req?.headers?.['x-forwarded-host'] || req?.headers?.host || '';
  const host = String(raw).split(',')[0].trim().toLowerCase();
  return URL_BY_HOST.get(host) || config.publicUrl;
}
