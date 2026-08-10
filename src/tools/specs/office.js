import { z } from 'zod';

/** Sheets / Slides / Whiteboard. */
export default [
  // ── Sheets ────────────────────────────────────────────────────────────
  {
    name: 'sheets_create',
    desc: '[SHEETS] Tạo bảng tính mới.',
    schema: { title: z.string(), folder_token: z.string().optional() },
    method: 'POST',
    path: '/open-apis/sheets/v3/spreadsheets',
    body: ['title', 'folder_token'],
  },
  {
    name: 'sheets_table_get',
    desc:
      '[SHEETS] Đọc dữ liệu bảng tính theo giao thức CÓ KIỂU (columns + data + dtypes + formats). ' +
      'Ưu tiên tool này thay vì đọc ô thô — kết quả đưa thẳng vào sheets_table_put được.',
    schema: {
      spreadsheet_token: z.string().optional(),
      url: z.string().optional().describe('URL bảng tính, thay cho token'),
      sheet_id: z.string().optional(),
      sheet_name: z.string().optional(),
      range: z.string().optional(),
      no_header: z.boolean().optional(),
    },
    handler: async (a, api) =>
      api.post(`/open-apis/sheet_ai/v2/spreadsheets/${encodeURIComponent(sheetToken(a))}/tools/invoke_read`, {
        body: {
          ...(a.sheet_id ? { sheet_id: a.sheet_id } : {}),
          ...(a.sheet_name ? { sheet_name: a.sheet_name } : {}),
          ...(a.range ? { range: a.range } : {}),
          ...(a.no_header ? { no_header: true } : {}),
        },
      }),
  },
  {
    name: 'sheets_table_put',
    desc:
      '[SHEETS] Ghi dữ liệu vào bảng tính ĐÃ TỒN TẠI theo giao thức có kiểu. ' +
      'sheets_json: {"sheets":[{"name":"Sheet1","mode":"overwrite","columns":[...],"data":[[...]],"dtypes":{...}}]}. ' +
      'mode: overwrite | append. LƯU Ý: giao thức này KHÔNG ghi được công thức — công thức dùng lark_api_call với sheets cells-set.',
    schema: {
      spreadsheet_token: z.string().optional(),
      url: z.string().optional(),
      sheets_json: z.string().describe('JSON có khoá gốc "sheets". dtypes dùng tên kiểu pandas: int64, float64, bool, object…'),
      styles_json: z.string().optional(),
      dry_run: z.boolean().optional(),
    },
    handler: async (a, api, h) =>
      api.post(`/open-apis/sheet_ai/v2/spreadsheets/${encodeURIComponent(sheetToken(a))}/tools/invoke_write`, {
        body: {
          ...h.jsonArg(a.sheets_json, 'sheets_json'),
          ...(a.styles_json ? { styles: h.jsonArg(a.styles_json, 'styles_json') } : {}),
          ...(a.dry_run ? { dry_run: true } : {}),
        },
      }),
  },
  {
    name: 'sheets_workbook_export',
    desc:
      '[SHEETS] Xuất cả bảng tính ra xlsx hoặc csv. Trả về LINK TẢI ngắn hạn (server không ghi được vào ổ đĩa của bạn). ' +
      'Chế độ csv bắt buộc có sheet_id.',
    schema: {
      spreadsheet_token: z.string().optional(),
      url: z.string().optional(),
      file_extension: z.enum(['xlsx', 'csv']).optional(),
      sheet_id: z.string().optional(),
    },
    handler: async (a, api) => {
      const token = sheetToken(a);
      const ext = a.file_extension || 'xlsx';
      if (ext === 'csv' && !a.sheet_id) throw new Error('Xuất csv bắt buộc có sheet_id.');

      const task = await api.post('/open-apis/drive/v1/export_tasks', {
        body: { file_extension: ext, token, type: 'sheet', ...(a.sheet_id ? { sub_id: a.sheet_id } : {}) },
      });
      const ticket = task.data?.ticket;
      if (!ticket) throw new Error('Lark không trả ticket xuất file.');

      // Lark xuất bất đồng bộ — phải chờ job xong mới có file_token
      let info;
      for (let i = 0; i < 30; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        info = await api.get(`/open-apis/drive/v1/export_tasks/${encodeURIComponent(ticket)}`, {
          params: { token },
        });
        const st = info.data?.result?.job_status;
        if (st === 0) break;
        if (st !== undefined && st !== 1 && st !== 2) {
          throw new Error(`Xuất thất bại: ${info.data?.result?.job_error_msg || 'job_status ' + st}`);
        }
      }
      const fileToken = info?.data?.result?.file_token;
      if (!fileToken) throw new Error('Hết thời gian chờ xuất file (30 giây).');

      return api.fetchToFile('GET', `/open-apis/drive/v1/export_tasks/file/${encodeURIComponent(fileToken)}/download`, {
        name: `${info.data.result.file_name || 'export'}.${ext}`,
      });
    },
  },

  // ── Slides ────────────────────────────────────────────────────────────
  {
    name: 'slides_create',
    desc: '[SLIDES] Tạo bài trình chiếu từ XML theo lược đồ SML của Lark.',
    schema: {
      xml: z.string().describe('<presentation xmlns="http://www.larkoffice.com/sml/2.0" width="960" height="540">…</presentation>'),
    },
    handler: async (a, api) =>
      api.post('/open-apis/slides_ai/v1/xml_presentations', { body: { xml_presentation: { content: a.xml } } }),
  },
  {
    name: 'slides_xml_get',
    desc:
      '[SLIDES] Lấy XML của bài trình bày. XML rất dài nên trả về LINK TẢI thay vì in ra. ' +
      'Dùng trước slides_replace_pages để biết slide_id và cấu trúc hiện tại.',
    schema: {
      presentation: z.string().describe('xml_presentation_id hoặc URL slides'),
      slide_id: z.string().optional(),
      revision_id: z.number().optional(),
    },
    handler: async (a, api) => {
      const id = extractToken(a.presentation);
      const r = await api.get(`/open-apis/slides_ai/v1/xml_presentations/${encodeURIComponent(id)}`, {
        params: { slide_id: a.slide_id, revision_id: a.revision_id },
      });
      const xml = r.data?.xml_presentation?.content || JSON.stringify(r.data);
      return { ...api.saveText(xml, `${id}.xml`, 'application/xml'), preview: xml.slice(0, 800) };
    },
  },
  {
    name: 'slides_replace_pages',
    desc:
      '[SLIDES] Thay nguyên nội dung một hoặc nhiều trang bằng XML mới. ' +
      'pages_json: [{"slide_id":"...","content":"<slide>…</slide>"}]. ' +
      'CẢNH BÁO: không nguyên tử — tạo trang mới rồi mới xoá trang cũ. Nên chạy validate_only trước.',
    schema: {
      presentation: z.string(),
      pages_json: z.string().describe('JSON: mảng {slide_id, content}'),
      validate_only: z.boolean().optional(),
      continue_on_error: z.boolean().optional(),
    },
    handler: async (a, api, h) => {
      const id = encodeURIComponent(extractToken(a.presentation));
      const pages = h.jsonArg(a.pages_json, 'pages_json');
      if (!Array.isArray(pages)) throw new Error('pages_json phải là một mảng.');
      if (a.validate_only) return { validated: pages.length, pages: pages.map((p) => p.slide_id) };

      const results = [];
      for (const p of pages) {
        try {
          const created = await api.post(`/open-apis/slides_ai/v1/xml_presentations/${id}/slide`, {
            body: { content: p.content, insert_after_slide_id: p.slide_id },
          });
          await api.del(`/open-apis/slides_ai/v1/xml_presentations/${id}/slide`, {
            params: { slide_id: p.slide_id },
          });
          results.push({ slide_id: p.slide_id, ok: true, new_slide: created.data });
        } catch (e) {
          results.push({ slide_id: p.slide_id, ok: false, error: e.message });
          if (!a.continue_on_error) break;
        }
      }
      return { results };
    },
  },

  // ── Whiteboard ────────────────────────────────────────────────────────
  {
    name: 'whiteboard_query',
    desc: '[WHITEBOARD] Đọc cấu trúc bảng trắng (flowchart, sơ đồ).',
    schema: { whiteboard_token: z.string() },
    method: 'GET',
    path: '/open-apis/board/v1/whiteboards/{whiteboard_token}/nodes',
  },
  {
    name: 'whiteboard_export_svg',
    desc: '[WHITEBOARD] Xuất bảng trắng ra SVG để đọc/phân tích. Trả về link tải.',
    schema: { whiteboard_token: z.string() },
    handler: async (a, api) => {
      const r = await api.get(`/open-apis/board/v1/whiteboards/${encodeURIComponent(a.whiteboard_token)}/nodes`);
      return {
        ...api.saveText(JSON.stringify(r.data, null, 2), `${a.whiteboard_token}.json`, 'application/json'),
        nodes: r.data?.nodes?.length ?? 0,
        note: 'Lark trả cấu trúc node; SVG dựng từ cấu trúc này ở phía client.',
      };
    },
  },
  {
    name: 'whiteboard_update',
    desc: '[WHITEBOARD] Vẽ/cập nhật bảng trắng từ mã Mermaid, PlantUML hoặc raw.',
    schema: {
      whiteboard_token: z.string(),
      source: z.string().describe('Mã nguồn biểu đồ, ví dụ Mermaid: graph TD; A-->B'),
      input_format: z.enum(['raw', 'plantuml', 'mermaid', 'svg']).optional(),
      overwrite: z.boolean().optional(),
    },
    handler: async (a, api) => {
      const fmt = a.input_format || 'mermaid';
      return api.post(`/open-apis/board/v1/whiteboards/${encodeURIComponent(a.whiteboard_token)}/nodes/${fmt}`, {
        body: { source: a.source, overwrite: Boolean(a.overwrite) },
      });
    },
  },
  {
    name: 'whiteboard_update_from_source',
    desc: '[WHITEBOARD] Như whiteboard_update, mặc định nhận SVG. Biến sơ đồ dạng text thành whiteboard thật.',
    schema: {
      whiteboard_token: z.string(),
      source: z.string(),
      input_format: z.enum(['svg', 'mermaid', 'plantuml', 'raw']).optional(),
      overwrite: z.boolean().optional(),
    },
    handler: async (a, api) => {
      const fmt = a.input_format || 'svg';
      return api.post(`/open-apis/board/v1/whiteboards/${encodeURIComponent(a.whiteboard_token)}/nodes/${fmt}`, {
        body: { source: a.source, overwrite: Boolean(a.overwrite) },
      });
    },
  },
];

function sheetToken(a) {
  const t = a.spreadsheet_token || extractToken(a.url);
  if (!t) throw new Error('Cần spreadsheet_token hoặc url.');
  return t;
}

function extractToken(input) {
  if (!input) return '';
  const m = String(input).match(/\/(?:sheets|docx|docs|wiki|slides|base|board)\/([A-Za-z0-9]+)/);
  return m ? m[1] : String(input).trim();
}
