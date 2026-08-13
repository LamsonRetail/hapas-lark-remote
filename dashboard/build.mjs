import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { sbFetch } from '../src/supabase.js';
import { TOOLS } from '../src/tools/index.js';
import { computeDashboard } from './compute.mjs';

/**
 * Dựng bản dashboard TĨNH — số liệu nướng thẳng vào trang.
 *
 * Dùng cho bản xem trước và cho trường hợp không muốn dựng serverless: một
 * trang tĩnh không có đường nào làm lộ service role key.
 *
 * Bản trên Vercel dùng `api/data.js`, gọi CHUNG `computeDashboard` nên hai bản
 * không bao giờ lệch số.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));

const sb = async (p) => {
  const r = await sbFetch(p, { timeoutMs: 30000 });
  if (!r.ok) throw new Error(`${p.slice(0, 70)} → ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
};

const data = await computeDashboard({
  sb,
  toolNames: TOOLS.map((t) => t.name),
  appId: config.appId,
});

const tpl = fs.readFileSync(path.join(HERE, 'template.html'), 'utf8');

// Bản xem trước: số nướng sẵn, không thẻ <html>/<head> (Artifact tự bọc).
fs.writeFileSync(path.join(HERE, 'preview.html'), tpl.replace('/*__DATA__*/null', JSON.stringify(data)));

// Bản Vercel: trang đầy đủ, số lấy từ /api/data lúc mở. `type="module"` để dùng
// được await ở cấp cao nhất.
fs.writeFileSync(
  path.join(HERE, 'index.html'),
  '<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
    tpl
      .replace('<script>', '<script type="module">')
      .replace("/*__DATA__*/null", "await (await fetch('/api/data', { cache: 'no-store' })).json()"),
);

// Hàm serverless không import được src/ (thiếu biến môi trường của Lark), nên
// danh sách tool phải đi kèm dưới dạng dữ liệu.
fs.writeFileSync(path.join(HERE, 'tools.json'), JSON.stringify(TOOLS.map((t) => t.name).sort()));

console.log(`lượt gọi      : ${data.kpi.calls}`);
console.log(`lỗi           : ${data.kpi.errors} (${data.kpi.errRate}%) — Lark không phản hồi ${data.kpi.noResp} (${data.kpi.noRespRate}%)`);
console.log(`tool          : ${data.kpi.toolsUsed}/${data.kpi.toolsTotal} đã dùng, ${data.unused.length} chưa`);
console.log(`chỗ cắm       : ${data.connectors.length}`);
console.log(`→ dashboard/preview.html + tools.json`);
