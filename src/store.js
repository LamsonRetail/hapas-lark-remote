import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

fs.mkdirSync(config.dataDir, { recursive: true });
const FILE = path.join(config.dataDir, 'tokens.json');

// ── Mã hoá at-rest ────────────────────────────────────────────────────────
let KEY;
if (config.tokenKey) {
  KEY = Buffer.from(config.tokenKey, 'hex');
  if (KEY.length !== 32) throw new Error('TOKEN_ENC_KEY phải là 32 byte hex (64 ký tự)');
} else {
  const kf = path.join(config.dataDir, '.devkey');
  if (!fs.existsSync(kf)) fs.writeFileSync(kf, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  KEY = Buffer.from(fs.readFileSync(kf, 'utf8'), 'hex');
  console.warn('[store] Chưa đặt TOKEN_ENC_KEY — dùng khoá dev sinh tạm. KHÔNG dùng cho production.');
}

const enc = (obj) => {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return [iv.toString('base64'), c.getAuthTag().toString('base64'), data.toString('base64')].join('.');
};
const dec = (s) => {
  const [iv, tag, data] = s.split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return JSON.parse(Buffer.concat([d.update(Buffer.from(data, 'base64')), d.final()]).toString('utf8'));
};

// ── Lưu trữ. Đổi sang Supabase chỉ cần thay 2 hàm này. ────────────────────
function readAll() {
  if (!fs.existsSync(FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
}
function writeAll(all) {
  const tmp = FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(all, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE); // ghi nguyên tử, tránh file rách khi crash giữa chừng
}

export function getUser(openId) {
  const row = readAll()[openId];
  if (!row) return null;
  try {
    return dec(row);
  } catch {
    return null;
  }
}

export function saveUser(openId, record) {
  const all = readAll();
  all[openId] = enc(record);
  writeAll(all);
}

export function deleteUser(openId) {
  const all = readAll();
  delete all[openId];
  writeAll(all);
}

export function listUsers() {
  return Object.keys(readAll());
}

/**
 * Khoá theo từng user.
 *
 * BẮT BUỘC phải có: refresh_token của Lark chỉ dùng được ĐÚNG MỘT LẦN
 * ("The refresh token has been revoked... can only be used once").
 * Claude bắn nhiều tool call song song; hai call cùng thấy token hết hạn sẽ
 * cùng đi refresh, cái thứ hai reuse token đã chết và Lark THU HỒI CẢ CHUỖI —
 * user bị đăng xuất giữa chừng. Đã kiểm chứng bằng tay khi dựng.
 */
const locks = new Map();
export function withUserLock(openId, fn) {
  const prev = locks.get(openId) || Promise.resolve();
  const result = prev.then(fn, fn); // chạy kể cả khi lượt trước lỗi
  const gate = result.then(
    () => {},
    () => {},
  );
  locks.set(openId, gate);
  gate.finally(() => {
    if (locks.get(openId) === gate) locks.delete(openId);
  });
  return result;
}
