/**
 * Ép đúng tình huống nguy hiểm nhất của kiến trúc này:
 * token hết hạn + nhiều tool call ập vào cùng lúc.
 *
 * Refresh token của Lark dùng được ĐÚNG MỘT LẦN. Nếu khoá per-user hỏng,
 * nhiều call sẽ cùng refresh, cái sau reuse token đã chết → Lark thu hồi cả
 * chuỗi và user bị đăng xuất giữa chừng. Test này phải PASS trước khi lên production.
 */
import fs from 'node:fs';
import { getUser, saveUser } from '../src/store.js';
import { resolveBearer } from '../src/oauth-as.js';

const BASE = 'http://localhost:8787';
const bearer = fs.readFileSync(new URL('../.data/.test-bearer', import.meta.url), 'utf8').trim();
const N = 6;
let seq = 0;

async function call(name) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: ++seq, // JSON-RPC id phải là số NGUYÊN — Math.random() bị SDK từ chối -32700

      method: 'tools/call',
      params: { name, arguments: {} },
    }),
  });
  const text = await r.text();
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue;
    try {
      const m = JSON.parse(line.slice(5).trim());
      if (m.result) return m.result;
      if (m.error) return { isError: true, content: [{ text: `JSON-RPC ${m.error.code}: ${m.error.message}` }] };
    } catch {}
  }
  try {
    const m = JSON.parse(text);
    if (m.result) return m.result;
    return { isError: true, content: [{ text: `HTTP ${r.status}: ${JSON.stringify(m).slice(0, 120)}` }] };
  } catch {
    return { isError: true, content: [{ text: `HTTP ${r.status} không parse được: ${text.slice(0, 120)}` }] };
  }
}

// Phải là user CỦA CHÍNH bearer, không phải listUsers()[0]: hai cái tình cờ
// trùng nhau nên bug nằm im, tới khi một user bị xoá rồi thêm lại làm thứ tự
// khoá trong tokens.json đổi. Lúc đó test ép hết hạn token người A rồi gọi API
// bằng token người B — không có refresh nào xảy ra và test báo FAIL oan, lại còn
// ghi đè accessExpiresAt của một người không liên quan.
const openId = resolveBearer(bearer)?.openId;
if (!openId) throw new Error('.data/.test-bearer không còn hợp lệ — chạy `npm test` để lấy bearer mới.');

const before = getUser(openId);
console.log(`User        : ${before.name}`);
console.log(`Refresh cũ  : …${before.refreshToken.slice(-12)}`);

// Làm access token hết hạn để ép refresh
saveUser(openId, { ...before, accessExpiresAt: Date.now() - 1000 });
console.log(`\nĐã ép access token hết hạn. Bắn ${N} tool call cùng lúc…\n`);

const t0 = Date.now();
const results = await Promise.all(Array.from({ length: N }, () => call('lark_whoami')));
const ms = Date.now() - t0;

let ok = 0;
const errors = [];
for (const r of results) {
  if (r && !r.isError) ok++;
  else errors.push(r?.content?.[0]?.text?.slice(0, 100) || 'không có result');
}

const after = getUser(openId);
const rotated = after.refreshToken !== before.refreshToken;

console.log(`Kết quả     : ${ok}/${N} call thành công  (${ms}ms)`);
if (errors.length) errors.forEach((e) => console.log(`   lỗi: ${e}`));
console.log(`Refresh mới : …${after.refreshToken.slice(-12)}`);
console.log(`Đã xoay     : ${rotated ? 'CÓ — refresh đúng 1 lần' : 'KHÔNG'}`);

const stillAlive = await call('lark_whoami');
console.log(`Session sau : ${stillAlive && !stillAlive.isError ? 'CÒN SỐNG' : 'ĐÃ CHẾT'}`);

console.log(
  `\n${ok === N && rotated && stillAlive && !stillAlive.isError ? '✅ PASS — khoá per-user giữ được session' : '❌ FAIL'}`,
);
