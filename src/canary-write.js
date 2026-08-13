import { TOOLS } from './tools/index.js';
import { execSpec } from './tools/registry.js';

/**
 * Canary cho nhóm tool GHI.
 *
 * VÌ SAO CẦN: canary cũ chỉ gọi tool đọc, và đó chính là lý do 5 tool ghi hỏng
 * mà không ai biết — `docx_block_append` dùng command Lark đã bỏ,
 * `sheets_table_put`/`_get` gửi sai lớp payload, `base_record_create` dùng shape
 * của bitable v1, `minutes_transcript` gọi endpoint không tồn tại. Cái sau nằm
 * im từ 10/08 với 5/5 lần gọi đều lỗi. Kiểm tra chỉ-đọc không bao giờ thấy được
 * lớp lỗi này.
 *
 * MỖI PROBE PHẢI TỰ DỌN. Canary chạy mỗi giờ, mãi mãi: một probe để lại một
 * dòng rác thì sau một năm là 8760 dòng. Ba probe dưới đây đều trở về đúng
 * trạng thái ban đầu — tạo rồi xoá, hoặc ghi đè lên chính chỗ cũ.
 *
 * KHÔNG có probe cho task_create: app chưa được cấp `task:task:delete` nên tạo
 * task xong không xoá được, mỗi giờ một task rác. Cấp scope đó rồi thì thêm.
 *
 * Khu nháp dựng một lần, token nhớ trong canary.json để lần sau dùng lại — chứ
 * không tạo file mới mỗi giờ.
 */

const SCRATCH = 'canary mcp remote — đừng xoá';

/** Docx cứ append thì phình mãi; quá ngưỡng này thì xoá và dựng lại cái mới. */
const DOC_MAX_CHARS = 20_000;

const call = (api, name, args = {}) => {
  const spec = TOOLS.find((t) => t.name === name);
  if (!spec) throw new Error(`Không có tool tên ${name}`);
  return execSpec(spec, args, api);
};

async function ensureScratch(api, state) {
  const s = (state._scratch ||= {});

  if (!s.base || !s.table) {
    // Không có tool tạo Base — đây là dựng sân, không phải thứ đang được kiểm.
    const r = await api.post('/open-apis/bitable/v1/apps', { body: { name: `${SCRATCH} (base)` } });
    s.base = r.data?.app?.app_token;
    s.table = r.data?.app?.default_table_id;
    s.base_url = r.data?.app?.url;
  }
  if (!s.sheet) {
    const r = await call(api, 'sheets_create', { title: `${SCRATCH} (sheet)` });
    s.sheet = r.data?.spreadsheet?.spreadsheet_token;
    s.sheet_url = r.data?.spreadsheet?.url;
  }
  if (!s.doc) {
    const r = await call(api, 'docs_create', {
      title: `${SCRATCH} (docx)`,
      content: `# ${SCRATCH}\n\nFile này do canary tự dựng để kiểm nhóm tool ghi. Xoá cũng được — canary sẽ dựng lại.\n`,
    });
    s.doc = r.data?.document?.document_id;
    s.doc_url = r.data?.document?.url;
  }
  return s;
}

/**
 * Base v3 nhất quán kiểu cuối cùng: ghi xong đọc lại NGAY thì thỉnh thoảng
 * chưa thấy, vài giây sau lại thấy. Probe cũ kết luận hỏng ngay lần đọc đầu
 * nên nó báo động giả — bản ghi vẫn vào bảng bình thường.
 *
 * Thử lại vài nhịp rồi mới kết luận. Hỏng thật thì sau ~4,5 giây vẫn hỏng, còn
 * trễ vài giây thì không đáng gọi là hỏng. Chỉ tốn thêm thời gian ở đúng những
 * lượt sắp fail, mà canary thì mỗi giờ mới chạy một lần.
 */
const READBACK_WAITS = [0, 1500, 3000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Ghi một bản ghi rồi đọc lại để chắc nó THẬT SỰ vào bảng, sau đó xoá.
 * Chỉ xem `code: 0` là không đủ: Base v3 nhận shape sai vẫn có thể trả 0.
 */
async function probeBase(api, s) {
  const marker = `canary ${new Date().toISOString()}`;
  const created = await call(api, 'base_record_create', {
    base_token: s.base,
    table_id: s.table,
    fields: JSON.stringify({ Text: marker }),
  });
  const id = created.data?.record_id_list?.[0];
  if (!id) throw new Error('base_record_create không trả record_id_list — shape response đã đổi');

  try {
    let seen = false;
    for (const wait of READBACK_WAITS) {
      if (wait) await sleep(wait);
      const list = await call(api, 'base_record_list', { base_token: s.base, table_id: s.table, limit: 200 });
      if ((list.data?.record_id_list || []).includes(id)) {
        seen = true;
        break;
      }
    }
    if (!seen) {
      const total = READBACK_WAITS.reduce((a, b) => a + b, 0) / 1000;
      throw new Error(`ghi xong nhưng base_record_list không thấy bản ghi sau ${total}s`);
    }
  } finally {
    await api.post(
      `/open-apis/base/v3/bases/${encodeURIComponent(s.base)}/tables/${encodeURIComponent(s.table)}/records/batch_delete`,
      { body: { record_id_list: [id] } },
    );
  }
}

/**
 * Ghi đè một vùng nhỏ rồi đọc lại và so KIỂU, không chỉ so có dữ liệu hay không.
 * Lỗi cũ của giao thức này là số bị ghi thành text — `code: 0` mà dữ liệu sai
 * kiểu thì chỉ so kiểu mới thấy.
 */
async function probeSheets(api, s) {
  const n = Date.now() % 100_000;
  await call(api, 'sheets_table_put', {
    spreadsheet_token: s.sheet,
    sheets_json: JSON.stringify({
      sheets: [{
        name: 'Sheet1',
        mode: 'overwrite',
        columns: ['khi', 'so', 'dung'],
        data: [[new Date().toISOString(), n, true]],
        dtypes: { khi: 'object', so: 'int64', dung: 'bool' },
      }],
    }),
  });

  const got = await call(api, 'sheets_table_get', { spreadsheet_token: s.sheet, range: 'A1:C2' });
  const row = got.ranges?.[0]?.cells?.[1] || [];
  if (row[1]?.value !== n) throw new Error(`ghi số ${n}, đọc lại ra ${JSON.stringify(row[1]?.value)} — kiểu bị đổi`);
  if (row[2]?.value !== true) throw new Error(`ghi bool true, đọc lại ra ${JSON.stringify(row[2]?.value)}`);
}

/** Chèn một dòng có dấu rồi đọc lại tìm đúng dấu đó. */
async function probeDocx(api, s) {
  const marker = `canary ${new Date().toISOString()}`;
  await call(api, 'docx_block_append', { document_id: s.doc, content: marker });

  const raw = await call(api, 'docx_document_raw_content', { document_id: s.doc });
  const content = raw.data?.document?.content || '';
  if (!content.includes(marker)) throw new Error('append xong nhưng đọc lại không thấy dòng vừa chèn');

  // Quá dài thì bỏ cả file, lần sau ensureScratch dựng cái mới
  if (content.length > DOC_MAX_CHARS) {
    try {
      await api.del(`/open-apis/drive/v1/files/${encodeURIComponent(s.doc)}`, { params: { type: 'docx' } });
    } catch {
      // Xoá không được thì cũng đừng làm probe fail — nó chỉ là dọn nhà
    }
    s.doc = null;
    s.doc_url = null;
  }
}

export const writeEnabled = (process.env.CANARY_WRITE ?? '1') !== '0';

/**
 * Trả danh sách probe cùng dạng với probe đọc: `{ name, args, run }`.
 * `name` là tool ghi đang được kiểm — để cảnh báo nói đúng tên thứ hỏng.
 */
export async function writeProbes(api, state) {
  const s = await ensureScratch(api, state);
  return [
    { name: 'base_record_create', args: { base: s.base }, run: () => probeBase(api, s) },
    { name: 'sheets_table_put', args: { sheet: s.sheet }, run: () => probeSheets(api, s) },
    { name: 'docx_block_append', args: { doc: s.doc }, run: () => probeDocx(api, s) },
  ];
}
