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

export const config = {
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
