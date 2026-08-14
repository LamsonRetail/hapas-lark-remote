import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { sbFetch } from '../src/supabase.js';
import { TOOLS } from '../src/tools/index.js';
import { computeDashboard } from './compute.mjs';
import { DIMENSIONS, MEASURES, WINDOWS } from './explore-schema.mjs';
import { EXPLORE_COLS, aggregate } from './explore-compute.mjs';

/**
 * Dựng các trang dashboard.
 *
 * Mỗi template ra HAI bản:
 *   *-preview.html  số nướng thẳng vào trang — xem tại chỗ, không cần backend.
 *                   Một trang tĩnh không có đường nào làm lộ service role key.
 *   index/explore   giữ nguyên `/*__DATA__*\/null` để trang tự gọi /api/… rồi
 *                   poll lại — đây là bản chạy trên Vercel.
 *
 * Cả hai bản gọi CHUNG computeDashboard/aggregate nên không bao giờ lệch số.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => fs.readFileSync(path.join(HERE, f), 'utf8');
const write = (f, s) => fs.writeFileSync(path.join(HERE, f), s);

const sb = async (p) => {
  const r = await sbFetch(p, { timeoutMs: 30000 });
  if (!r.ok) throw new Error(`${p.slice(0, 70)} → ${r.status} ${(await r.text()).slice(0, 160)}`);
  return r.json();
};

const CSS = read('base.css');
const DOCTYPE = '<!doctype html>\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n';

/**
 * `data` = null → bản live (trang tự fetch). Có giá trị → bản nướng sẵn.
 * CSS nhúng vào cả hai: bản preview mở như file rời thì <link> ngoài là mất
 * sạch giao diện.
 */
function build(tplFile, { data = null, extra = {} } = {}) {
  let html = read(tplFile).replace('/*__CSS__*/', () => CSS);
  for (const [marker, value] of Object.entries(extra)) {
    html = html.replace(`/*__${marker}__*/null`, () => JSON.stringify(value));
  }
  return data === null ? html : html.replace('/*__DATA__*/null', () => JSON.stringify(data));
}

// ── Bảng vận hành ──────────────────────────────────────────────────────
const data = await computeDashboard({ sb, toolNames: TOOLS.map((t) => t.name), appId: config.appId });

write('preview.html', build('template.html', { data }));
write('index.html', DOCTYPE + build('template.html'));

// ── Trang biểu đồ ──────────────────────────────────────────────────────
// Danh mục cột nướng vào trang để ô chọn không phải khai lại — lệch một cái
// tên là trang chào lựa chọn mà máy chủ từ chối.
const SCHEMA = { DIMENSIONS, MEASURES, WINDOWS };

const EX_DAYS = 30, EX_DIM = 'tool_name';
const since = new Date(Date.now() - EX_DAYS * 86400000).toISOString();
const exRows = [];
for (let off = 0; off < 200000; off += 1000) {
  const chunk = await sb(
    `audit_logs?created_at=gte.${since}&source=eq.url&select=${EXPLORE_COLS.join(',')}&order=created_at.asc&limit=1000&offset=${off}`,
  );
  exRows.push(...chunk);
  if (chunk.length < 1000) break;
}
const exData = { days: EX_DAYS, source: 'url', ...aggregate({ rows: exRows, dim: EX_DIM }) };

write('explore-preview.html', build('explore-template.html', { data: exData, extra: { SCHEMA } }));
write('explore.html', DOCTYPE + build('explore-template.html', { extra: { SCHEMA } }));

// Hàm serverless không import được src/ (thiếu biến môi trường của Lark), nên
// danh sách tool phải đi kèm dưới dạng dữ liệu.
write('tools.json', JSON.stringify(TOOLS.map((t) => t.name).sort()));

console.log(`lượt gọi      : ${data.kpi.calls}`);
console.log(`lỗi           : ${data.kpi.errors} (${data.kpi.errRate}%) — Lark không phản hồi ${data.kpi.noResp} (${data.kpi.noRespRate}%)`);
console.log(`tool          : ${data.kpi.toolsUsed}/${data.kpi.toolsTotal} đã dùng, ${data.unused.length} chưa`);
console.log(`chỗ cắm       : ${data.connectors.length} hiện, ${data.hidden.length} đang ẩn`);
console.log(`người          : ${data.kpi.connected} đã cắm, ${data.kpi.users} đã gọi tool`);
console.log(`biểu đồ       : ${exData.total} lượt → ${exData.groups} nhóm theo ${EX_DIM}`);
console.log('→ preview.html + explore-preview.html + index.html + explore.html + tools.json');
