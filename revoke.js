#!/usr/bin/env node
/**
 * Thu hồi truy cập của một người — dùng từ phía quản trị.
 *
 * VÌ SAO CẦN RIÊNG: `/revoke` (RFC 7009) đòi chính bearer token, mà token nằm
 * trong config connector của người dùng. Người quản trị server không có token
 * đó, nên không có cách nào thu hồi hộ ai qua HTTP. Script này đi thẳng vào
 * cùng hai file mà server đọc.
 *
 *   node revoke.js --list
 *   node revoke.js "Thẩm"                     # khớp theo tên, hỏi lại nếu >1 người
 *   node revoke.js ou_1bc55b6d…               # khớp chính xác open_id
 *   node revoke.js ou_1bc55b6d… --client abc  # chỉ một chỗ cắm
 *   node revoke.js "Thẩm" --yes               # bỏ bước xác nhận
 *
 * Server đọc lại hai file này ở mỗi request nên không cần restart. Đừng chạy
 * đúng lúc có người đang đăng nhập: cả hai bên đều ghi lại cả file.
 */
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline/promises';
import { config } from './src/config.js';
import { listUsers, getUser, deleteUser } from './src/store.js';
import { revokeMachines } from './src/machines.js';

const OAUTH_DB = path.join(config.dataDir, 'oauth.json');
// Tách cờ khỏi tham số vị trí. `--yes` không có giá trị đi kèm, nên cờ nào mà
// phần tử sau nó cũng là cờ thì tính là true.
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
const flag = (name) => flags[name] ?? null;
const target = positional[0];

const onlyClientArg = () => (typeof flags.client === 'string' ? ` --client ${flags.client}` : '');

const loadOAuth = () => (fs.existsSync(OAUTH_DB) ? JSON.parse(fs.readFileSync(OAUTH_DB, 'utf8')) : { clients: {}, tokens: {} });
const saveOAuth = (d) => {
  const tmp = OAUTH_DB + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(d, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, OAUTH_DB);
};

/** Ai đang có chỗ cắm nào, gom từ oauth.json. */
function connections() {
  const db = loadOAuth();
  const byUser = new Map();
  for (const t of Object.values(db.tokens)) {
    if (!byUser.has(t.openId)) byUser.set(t.openId, { name: t.name || '', clients: new Map() });
    const u = byUser.get(t.openId);
    if (t.name) u.name = t.name;
    u.clients.set(t.clientId, (u.clients.get(t.clientId) || 0) + 1);
  }
  return byUser;
}

function list() {
  const conns = connections();
  const larkUsers = new Set(listUsers());
  console.log('open_id                              tên                                        chỗ cắm  token Lark');
  for (const openId of new Set([...larkUsers, ...conns.keys()])) {
    const c = conns.get(openId);
    const name = c?.name || getUser(openId)?.name || '?';
    console.log(
      openId.padEnd(37) +
        name.slice(0, 42).padEnd(43) +
        String(c ? c.clients.size : 0).padEnd(9) +
        (larkUsers.has(openId) ? 'còn' : 'không'),
    );
    for (const [cid, n] of c?.clients || []) console.log(' '.repeat(37) + `└─ ${cid} (${n} token)`);
  }
}

async function main() {
  if (flag('list') || !target) {
    list();
    if (!target) {
      console.log('\nDùng: node revoke.js <open_id | phần tên> [--client <client_id>] [--yes]');
      process.exitCode = flag('list') ? 0 : 1;
    }
    if (!target) return;
  }

  const conns = connections();
  const candidates = [...new Set([...listUsers(), ...conns.keys()])].filter((openId) => {
    if (openId === target) return true;
    const name = conns.get(openId)?.name || getUser(openId)?.name || '';
    return name.toLowerCase().includes(String(target).toLowerCase());
  });

  if (!candidates.length) {
    console.error(`Không tìm thấy ai khớp "${target}". Xem: node revoke.js --list`);
    process.exitCode = 1;
    return;
  }
  if (candidates.length > 1) {
    console.error(`"${target}" khớp ${candidates.length} người — chỉ rõ open_id:`);
    for (const o of candidates) console.error(`  ${o}  ${conns.get(o)?.name || getUser(o)?.name || ''}`);
    process.exitCode = 1;
    return;
  }

  const openId = candidates[0];
  const name = conns.get(openId)?.name || getUser(openId)?.name || openId;

  // `--yes` CHỈ đi với open_id chính xác. Khớp mờ theo tên cộng bỏ xác nhận là
  // công thức để thu hồi nhầm người: một chuỗi ngắn như "Nguy" vô tình khớp
  // đúng một người thì script coi như đã được chỉ định rõ và xoá luôn token
  // Lark của họ. Đã xảy ra thật trong lúc test chính script này.
  if (flag('yes') === true && openId !== target) {
    console.error(`--yes chỉ dùng được với open_id chính xác.`);
    console.error(`  "${target}" khớp theo TÊN với: ${name}`);
    console.error(`  Chạy lại: node revoke.js ${openId}${onlyClientArg()} --yes`);
    process.exitCode = 1;
    return;
  }
  const onlyClient = typeof flag('client') === 'string' ? flag('client') : null;
  const clientIds = [...(conns.get(openId)?.clients.keys() || [])].filter((c) => !onlyClient || c === onlyClient);

  if (onlyClient && !clientIds.length) {
    console.error(`Người này không có chỗ cắm nào tên "${onlyClient}".`);
    process.exitCode = 1;
    return;
  }

  const dropsLark = !onlyClient || clientIds.length === (conns.get(openId)?.clients.size || 0);
  console.log(`Thu hồi của: ${name}\n  open_id   : ${openId}`);
  console.log(`  chỗ cắm   : ${clientIds.length ? clientIds.join(', ') : '(không có token nào)'}`);
  console.log(`  token Lark: ${dropsLark ? 'XOÁ — người này sẽ phải đăng nhập lại trên Lark' : 'giữ (còn chỗ cắm khác)'}`);

  if (flag('yes') !== true) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ok = (await rl.question('\nĐồng ý? [y/N] ')).trim().toLowerCase();
    rl.close();
    if (ok !== 'y' && ok !== 'yes') return console.log('Đã huỷ, không thay đổi gì.');
  }

  const db = loadOAuth();
  let removed = 0;
  for (const [hash, t] of Object.entries(db.tokens)) {
    if (t.openId !== openId) continue;
    if (onlyClient && t.clientId !== onlyClient) continue;
    delete db.tokens[hash];
    removed++;
  }
  saveOAuth(db);

  if (dropsLark) deleteUser(openId);
  revokeMachines({ openId, clientIds: onlyClient ? [onlyClient] : [] });

  console.log(`\nXong: bỏ ${removed} bearer token${dropsLark ? ', xoá token Lark' : ''}, đánh dấu machines = revoked.`);
  // machines ghi nền, đợi một nhịp cho request bay xong
  await new Promise((r) => setTimeout(r, 1500));
}

await main();
