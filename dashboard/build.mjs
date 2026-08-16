import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../src/config.js';
import { sbFetch } from '../src/supabase.js';
import { TOOLS } from '../src/tools/index.js';
import { computeDashboard } from './compute.mjs';
import { DIMENSIONS, MEASURES } from './explore-schema.mjs';
import { EXPLORE_COLS, aggregate } from './explore-compute.mjs';
import { DEFAULT_PRESET, MAX_RANGE_DAYS, PRESETS, TZ_MIN, resolveRange } from './range.mjs';

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

/**
 * CSS hỏng thì trình duyệt IM LẶNG bỏ qua — không log, không cảnh báo, trang
 * vẫn hiện ra, chỉ là mất màu. Đã dính đúng một lần: chú thích đầu base.css
 * viết cả `__CSS__` kèm hai dấu comment, dấu đóng của nó kết thúc sớm khối chú
 * thích và trình duyệt nuốt luôn khối `:root` ngay dưới → toàn bộ biến màu
 * rỗng, cả trang ra đen trắng ở chế độ sáng.
 *
 * Nên bóc chú thích đúng cách trình duyệt bóc, rồi kiểm mấy thứ BẮT BUỘC phải
 * sống sót. Thà build gãy còn hơn deploy một trang mất màu.
 */
function checkCss(css) {
  // Quét theo TRẠNG THÁI, không bằng regex. Regex bóc chú thích cho ra đúng kết
  // quả mà trình duyệt cho — tức là nó cũng "không thấy" lỗi, vì lỗi nằm ở chỗ
  // khối chú thích kết thúc SỚM chứ không phải ở chỗ thiếu dấu đóng.
  let inComment = false;
  for (let i = 0; i < css.length - 1; i++) {
    const two = css.slice(i, i + 2);
    if (!inComment && two === '/*') { inComment = true; i++; continue; }
    if (inComment && two === '*/') { inComment = false; i++; continue; }
    // CSS KHÔNG cho lồng chú thích: '/*' thứ hai không mở gì cả, nhưng '*/' của
    // nó thì đóng thật — phần chữ còn lại rơi ra ngoài thành selector rác và
    // nuốt luôn khối {…} ngay sau đó.
    if (inComment && two === '/*') {
      throw new Error(`base.css:${css.slice(0, i).split('\n').length} — '/*' lồng trong một chú thích. CSS không cho lồng: dấu '*/' của nó sẽ đóng sớm khối ngoài và làm mất quy tắc ngay bên dưới.`);
    }
  }
  if (inComment) throw new Error('base.css: còn một chú thích chưa đóng.');
  return css;
}

const CSS = checkCss(read('base.css'));
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

// ── MỘT trang duy nhất ─────────────────────────────────────────────────
// Trước đây là hai: `/` và `/explore`. Chúng trả lời cùng một câu hỏi trên
// cùng một tập dữ liệu, nên tách ra chỉ tổ phải nhớ trang nào có gì.
//
// Danh mục cột nướng vào trang để ô chọn không phải khai lại — lệch một cái
// tên là trang chào lựa chọn mà máy chủ từ chối.
const SCHEMA = { DIMENSIONS, MEASURES, PRESETS, DEFAULT_PRESET, MAX_RANGE_DAYS, TZ_MIN };

const range = resolveRange({ preset: DEFAULT_PRESET });
const data = await computeDashboard({ sb, toolNames: TOOLS.map((t) => t.name), appId: config.appId, range });

/**
 * Số của khu biểu đồ, nướng sẵn cho TỪNG cột nhóm.
 *
 * Bản preview.html không có backend, nên trước đây khu này mở ra là một dòng
 * "Không tải được dữ liệu" đỏ chót. Chấp nhận được hồi nó còn là khu phụ ở cuối
 * trang; giờ nó là biểu đồ CHÍNH, và một bản xem trước mà biểu đồ chính báo lỗi
 * thì không xem trước được cái gì.
 *
 * Sáu phép gộp trên cùng một tập hàng nên gần như miễn phí. Nướng KẾT QUẢ ĐÃ
 * GỘP, tuyệt đối không nướng hàng thô: hàng thô mang theo `args` và `error_msg`
 * kèm id tài liệu, mà preview.html là một file nằm trong repo.
 */
const exRows = [];
for (let off = 0; off < 200000; off += 1000) {
  const chunk = await sb(
    `audit_logs?created_at=gte.${range.since}&created_at=lt.${range.until}&source=eq.url`
    + `&select=${EXPLORE_COLS.join(',')}&order=created_at.asc&limit=1000&offset=${off}`,
  );
  exRows.push(...chunk);
  if (chunk.length < 1000) break;
}
const EXPLORE = {
  range: { from: range.from, to: range.to, preset: range.preset, days: range.days },
  byDim: Object.fromEntries(DIMENSIONS.map((d) => [d.key, aggregate({ rows: exRows, dim: d.key })])),
};

write('preview.html', build('template.html', { data, extra: { SCHEMA, EXPLORE } }));
write('index.html', DOCTYPE + build('template.html', { extra: { SCHEMA } }));

// Hàm serverless không import được src/ (thiếu biến môi trường của Lark), nên
// danh sách tool phải đi kèm dưới dạng dữ liệu.
write('tools.json', JSON.stringify(TOOLS.map((t) => t.name).sort()));

console.log(`lượt gọi      : ${data.kpi.calls}`);
console.log(`không dùng được: ${data.kpi.blocked} (${data.kpi.blockRate}%) — chỉ đếm lượt CHẶN người dùng, xem impact.mjs`);
// Chỉ in ra ĐÂY, không đưa lên trang — xem ghi chú ở cuối compute.mjs.
const broken = data.tools.filter((t) => t.broken).map((t) => t.name);
console.log(`nghi hỏng      : ${broken.length ? broken.join(', ') : 'không có'} (kiểm tay, canary mới là nguồn tin)`);
console.log(`tool          : ${data.kpi.toolsUsed}/${data.kpi.toolsTotal} đã dùng, ${data.unused.length} chưa`);
console.log(`người          : ${data.people.length} dòng — ${data.kpi.connected} đã cắm, ${data.kpi.users} đã gọi tool`);
const nhieuClient = data.people.filter((p) => p.clients.length > 2);
if (nhieuClient.length) {
  console.log(`nghi còn trùng : ${nhieuClient.length} người có >2 ứng dụng — chạy supabase/machines-dedup.sql`);
}
console.log('→ preview.html + index.html + tools.json');
