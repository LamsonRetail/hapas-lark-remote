#!/usr/bin/env node
/**
 * Smoke test nhóm GHI: task → doc → sheet → file xuất ra.
 *
 * Khác `e2e.js` (chỉ đọc, chạy được bao nhiêu lần cũng vô hại): script này TẠO
 * DỮ LIỆU THẬT trong Lark và KHÔNG tự dọn — bộ tool không có tool xoá nào, cố ý.
 * Mỗi lần chạy để lại 1 tasklist, 1 task, 1 doc, 1 sheet. Tên đều có tiền tố
 * `[SMOKE]` + mốc thời gian để tìm và xoá tay sau.
 *
 *   node test/smoke-write.js
 *   BASE=https://hapasvn.tail65cea0.ts.net node test/smoke-write.js
 *
 * Cần `.data/.test-bearer` — lấy bằng `npm test` (nó tự lưu) hoặc `npm run token`.
 *
 * Vì sao đi qua HTTP chứ không gọi execSpec trực tiếp: để test đúng đường mà
 * người dùng đi — bearer, stateless transport, SSE, audit, machines. Gọi hàm nội
 * bộ chỉ chứng minh cái handler chạy, không chứng minh cái server chạy.
 */
import fs from 'node:fs';

const BASE = process.env.BASE || 'http://localhost:8787';
const CACHE = new URL('../.data/.test-bearer', import.meta.url);

if (!fs.existsSync(CACHE)) {
  console.error(`Không thấy ${CACHE.pathname}. Chạy \`npm test\` một lần để lấy bearer, hoặc \`npm run token\`.`);
  process.exit(1);
}
const bearer = fs.readFileSync(CACHE, 'utf8').trim();

const stamp = new Date().toISOString().slice(5, 16).replace('T', ' ');
const TAG = `[SMOKE ${stamp}]`;

/** Streamable HTTP trả text/event-stream — phải bóc dòng `data:` mới có JSON-RPC. */
async function rpc(method, params) {
  const r = await fetch(`${BASE}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method, params }),
  });
  const text = await r.text();
  if ((r.headers.get('content-type') || '').includes('event-stream')) {
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const m = JSON.parse(line.slice(5).trim());
        if (m.result || m.error) return m;
      } catch {}
    }
  }
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: `HTTP ${r.status}: ${text.slice(0, 160)}` } };
  }
}

/**
 * Gọi tool, trả về payload đã parse. Tool lỗi thì MCP vẫn trả 200 kèm
 * `isError` — phải bắt riêng, không thì lỗi Lark trôi qua như thành công.
 */
async function call(name, args) {
  const m = await rpc('tools/call', { name, arguments: args });
  if (m.error) throw new Error(`${name}: ${m.error.message}`);
  const raw = m.result?.content?.[0]?.text ?? '';
  if (m.result?.isError) throw new Error(`${name}: ${raw.slice(0, 200)}`);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

/**
 * Tìm khoá ở mọi độ sâu. Response của Lark bọc token ở những chỗ khác nhau tuỳ
 * API (`data.document.document_id` vs `data.spreadsheet.spreadsheet_token`);
 * đào theo tên khoá thì không phải nhớ hình dạng từng cái, và API đổi chỗ bọc
 * cũng không làm script chết.
 */
function dig(obj, key, depth = 0) {
  if (depth > 8 || obj === null || typeof obj !== 'object') return undefined;
  if (!Array.isArray(obj) && obj[key] !== undefined) return obj[key];
  for (const v of Object.values(obj)) {
    const hit = dig(v, key, depth + 1);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

const done = [];
const ok = (label, detail) => {
  console.log(`  [OK]   ${label.padEnd(22)} ${detail || ''}`);
  done.push(`${label}: ${detail || ''}`);
};

async function main() {
  const who = await call('lark_whoami', {});
  console.log(`Chạy dưới danh nghĩa: ${dig(who, 'name') || '?'}`);
  console.log(`Server              : ${BASE}`);
  console.log(`Tiền tố dữ liệu tạo : ${TAG}\n`);

  // ── 1. Task ───────────────────────────────────────────────────────────
  const tl = await call('tasklist_create', { name: `${TAG} Danh sách thử` });
  ok('tasklist_create', dig(tl, 'guid') || '');

  const task = await call('task_create', {
    summary: `${TAG} Kiểm tra tạo task`,
    description: 'Task do smoke-write.js tạo. Xoá được sau khi kiểm tra xong.',
    due_time: String(Date.now() + 86_400_000), // mai, đơn vị mili giây
  });
  const taskGuid = dig(task, 'guid');
  ok('task_create', taskGuid || '');

  // Đánh dấu xong luôn để phủ cả nhánh cập nhật, không chỉ nhánh tạo
  if (taskGuid) {
    await call('task_complete', { task_guid: taskGuid });
    ok('task_complete', 'đã đánh dấu hoàn thành');
  }

  // ── 2. Doc ────────────────────────────────────────────────────────────
  const doc = await call('docs_create', {
    title: `${TAG} Tài liệu thử`,
    content: [
      '# Báo cáo kiểm tra',
      '',
      'Tài liệu này do `smoke-write.js` tạo để kiểm tra đường ghi Docs.',
      '',
      '## Hạng mục',
      '',
      '- Tạo tài liệu kèm nội dung Markdown',
      '- Chèn thêm block vào cuối',
      '- Đếm số từ để xác nhận nội dung đã vào',
      '',
      '| Hạng mục | Trạng thái |',
      '| --- | --- |',
      '| Task | xong |',
      '| Doc | đang chạy |',
    ].join('\n'),
  });
  const docId = dig(doc, 'document_id') || dig(doc, 'obj_token');
  ok('docs_create', docId || '');

  if (docId) {
    await call('docx_block_append', {
      document_id: docId,
      content: ['', '## Phần chèn thêm', '', `Chèn lúc ${new Date().toLocaleString('vi-VN')}.`].join('\n'),
    });
    ok('docx_block_append', 'đã chèn');

    // Đọc lại: tạo xong mà không đối chiếu thì không biết nội dung có vào thật
    const wc = await call('docs_word_count', { doc: docId });
    ok('docs_word_count', `${dig(wc, 'words') ?? dig(wc, 'word_count') ?? '?'} từ`);
  }

  // ── 3. Sheet ──────────────────────────────────────────────────────────
  const sheet = await call('sheets_create', { title: `${TAG} Bảng tính thử` });
  const sheetToken = dig(sheet, 'spreadsheet_token');
  ok('sheets_create', sheetToken || '');

  if (sheetToken) {
    await call('sheets_table_put', {
      spreadsheet_token: sheetToken,
      sheets_json: JSON.stringify({
        sheets: [
          {
            name: 'Sheet1',
            mode: 'overwrite',
            columns: ['Hạng mục', 'Số lượng', 'Đơn giá', 'Đạt'],
            data: [
              ['Bàn làm việc', 12, 1850000.5, true],
              ['Ghế xoay', 30, 990000, true],
              ['Màn hình 27"', 8, 4200000, false],
            ],
            // dtypes theo tên kiểu pandas, không phải kiểu JS
            dtypes: { 'Hạng mục': 'object', 'Số lượng': 'int64', 'Đơn giá': 'float64', Đạt: 'bool' },
          },
        ],
      }),
    });
    ok('sheets_table_put', '3 dòng × 4 cột');

    const back = await call('sheets_table_get', { spreadsheet_token: sheetToken, sheet_name: 'Sheet1' });
    const rows = dig(back, 'data');
    ok('sheets_table_get', `đọc lại ${Array.isArray(rows) ? rows.length : '?'} dòng`);

    // ── 4. File xuất ra ─────────────────────────────────────────────────
    // Đây là đường RIÊNG của bản remote: server không ghi được vào ổ đĩa người
    // dùng nên tool trả link /files/:id. Link vẫn đòi bearer.
    const exp = await call('sheets_workbook_export', { spreadsheet_token: sheetToken, file_extension: 'xlsx' });
    const link = dig(exp, 'download_url') || dig(exp, 'url') || dig(exp, 'link');
    ok('sheets_workbook_export', link || JSON.stringify(exp).slice(0, 90));

    if (link) {
      const head = await fetch(link.startsWith('http') ? link : `${BASE}${link}`, {
        headers: { Authorization: `Bearer ${bearer}` },
      });
      ok('tải file về', `HTTP ${head.status}, ${head.headers.get('content-type')}`);
    }
  }

  console.log(`\nXong ${done.length} bước.`);
  console.log(`\nDỮ LIỆU THẬT ĐÃ TẠO — tìm "${TAG}" trong Lark rồi xoá tay:`);
  console.log('  · 1 tasklist + 1 task (Task)');
  console.log('  · 1 tài liệu (Docs)');
  console.log('  · 1 bảng tính (Sheets)');
  console.log('Bộ tool không có tool xoá — cố ý, để AI không xoá được dữ liệu của ai.');
}

main().catch((e) => {
  console.error(`\nDỪNG: ${e.message}`);
  if (done.length) {
    console.error('\nĐã kịp tạo những thứ này, vẫn phải xoá tay:');
    for (const d of done) console.error('  · ' + d);
  }
  process.exitCode = 1;
});
