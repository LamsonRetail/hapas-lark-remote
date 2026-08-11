#!/usr/bin/env node
/**
 * Cấp bearer tĩnh cho client KHÔNG làm được OAuth.
 *
 * VÌ SAO CẦN: Claude tự đi hết luồng OAuth (đăng ký → device flow → token).
 * Nhiều client khác chỉ có ô "Bearer token" hoặc "Headers" — không có bước
 * nhảy ra trình duyệt. Với chúng thì phải cấp sẵn token từ phía server.
 *
 *   node token.js --list
 *   node token.js "Thẩm" --client codex
 *   node token.js ou_1bc55b6d… --client n8n
 *
 * ĐÁNH ĐỔI, đọc kỹ trước khi dùng:
 *   - Token này BỎ QUA hoàn toàn bước đăng nhập Lark. Ai cầm được nó thì hành
 *     động dưới danh nghĩa người đó, suốt 30 ngày.
 *   - Nó nằm ở dạng chữ trong config của client (hoặc biến môi trường). Đừng
 *     dán vào chat, ticket, hay repo.
 *   - Thu hồi: node revoke.js <open_id> --client <nhãn>
 *
 * Luôn đặt --client thành nhãn có nghĩa (codex, n8n, script-bao-cao…). Nhãn đó
 * là thứ duy nhất cho phép thu hồi đúng một chỗ cắm mà không đá văng những chỗ
 * còn lại của cùng người.
 */
import { listUsers, getUser } from './src/store.js';
import { issueForUser } from './src/oauth-as.js';
import { config } from './src/config.js';

const flags = {};
const positional = [];
{
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) {
      positional.push(argv[i]);
      continue;
    }
    const name = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) flags[name] = true;
    else flags[name] = argv[++i];
  }
}
const target = positional[0];

function list() {
  const users = listUsers();
  if (!users.length) return console.log('Chưa ai đăng nhập Lark trên server này.');
  console.log('open_id                              tên');
  for (const openId of users) console.log(openId.padEnd(37) + (getUser(openId)?.name || '?'));
}

if (flags.list || !target) {
  list();
  if (!target) {
    console.log('\nDùng: node token.js <open_id | phần tên> --client <nhãn>');
    process.exitCode = flags.list ? 0 : 1;
  }
  process.exit(process.exitCode || 0);
}

// Khớp mờ theo tên như revoke.js, nhưng nhiều hơn một thì dừng — cấp nhầm token
// cho người khác là trao quyền hành động dưới danh nghĩa họ.
const candidates = listUsers().filter(
  (openId) => openId === target || (getUser(openId)?.name || '').toLowerCase().includes(String(target).toLowerCase()),
);

if (!candidates.length) {
  console.error(`Không tìm thấy ai khớp "${target}". Xem: node token.js --list`);
  console.error('Người đó phải ĐĂNG NHẬP LARK ít nhất một lần trước đã — server không tự tạo được token Lark hộ.');
  process.exit(1);
}
if (candidates.length > 1) {
  console.error(`"${target}" khớp ${candidates.length} người — chỉ rõ open_id:`);
  for (const o of candidates) console.error(`  ${o}  ${getUser(o)?.name || ''}`);
  process.exit(1);
}

const openId = candidates[0];
const user = getUser(openId);
const label = typeof flags.client === 'string' ? flags.client : 'static';
const clientId = `static-${label}`;

if (!user?.refreshToken) {
  console.error(`${user?.name || openId} không còn refresh token Lark — bearer cấp ra sẽ chết ngay khi token hết hạn.`);
  console.error('Bảo người đó cắm connector và đăng nhập Lark lại trước.');
  process.exit(1);
}

const t = issueForUser(openId, user.name || '', clientId);

console.log(`Đã cấp bearer cho : ${user.name || openId}`);
console.log(`  open_id         : ${openId}`);
console.log(`  chỗ cắm         : ${clientId}`);
console.log(`  hạn             : ${Math.round(t.expires_in / 86400)} ngày`);
console.log(`\nURL   : ${config.publicUrl}/mcp`);
console.log(`Token : ${t.access_token}`);
console.log(`\nHeader nếu client cần điền tay:`);
console.log(`  Authorization: Bearer ${t.access_token}`);
console.log(`\nThu hồi: node revoke.js ${openId} --client ${clientId}`);
