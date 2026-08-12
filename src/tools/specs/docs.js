import { z } from 'zod';

/** Thẻ không có thẻ đóng trong nội dung `/fetch` trả về — không tính vào độ sâu. */
const VOID_TAGS = new Set(['col', 'br', 'img', 'hr', 'input', 'meta', 'link']);

/**
 * Id của block CẤP CAO NHẤT cuối cùng, để `block_insert_after` chèn vào cuối
 * tài liệu.
 *
 * Không lấy `id` cuối cùng xuất hiện trong chuỗi: tài liệu kết thúc bằng bảng
 * thì id cuối là ô trong bảng, chèn vào đó thì nội dung rơi VÀO TRONG ô. Phải
 * đếm độ sâu thẻ để biết đâu là cấp cao nhất.
 *
 * `<ul>`/`<ol>` không có id của riêng nó — dùng id con trực tiếp cuối cùng
 * (thẻ `<li>`); đã kiểm: Lark chèn ra SAU cả danh sách, không lồng vào trong.
 *
 * Không tìm được gì thì trả về chính document_id — id của `<title>`, tức chèn
 * ngay sau tiêu đề. Đó là hành vi đúng cho tài liệu rỗng.
 */
export function lastTopLevelBlockId(content, documentId) {
  const tag = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
  let depth = 0;
  let start = -1;
  let m;
  while ((m = tag.exec(content))) {
    const [, closing, name, , selfClosing] = m;
    if (selfClosing || VOID_TAGS.has(name.toLowerCase())) continue;
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    if (depth === 0) start = m.index;
    depth++;
  }
  if (start < 0) return documentId;

  const block = content.slice(start);
  const openTag = block.slice(0, block.indexOf('>') + 1);
  const own = openTag.match(/\bid="([^"]+)"/);
  if (own) return own[1];

  const ids = [...block.matchAll(/\bid="([^"]+)"/g)];
  return ids.length ? ids[ids.length - 1][1] : documentId;
}

/** Docs / Docx / Drive / Wiki. */
export default [
  {
    name: 'docs_create',
    desc: '[DOCS] Tạo tài liệu mới từ Markdown. Lark tự convert sang block, không cần dựng block thủ công.',
    schema: {
      title: z.string().optional(),
      content: z.string().describe('Nội dung Markdown'),
      folder_token: z.string().optional(),
    },
    method: 'POST',
    path: '/open-apis/docs_ai/v1/documents',
    body: ['title', 'content', 'folder_token'],
  },
  {
    name: 'docx_document_raw_content',
    desc: '[DOCX] Đọc toàn bộ nội dung văn bản của một tài liệu Docs. Nhận cả URL (kể cả link Wiki) lẫn token.',
    schema: { document_id: z.string().describe('Token tài liệu hoặc URL — link Wiki cũng được') },
    handler: async (a, api) =>
      api.post(`/open-apis/docs_ai/v1/documents/${encodeURIComponent(await docToken(api, a.document_id))}/fetch`, {}),
  },
  {
    name: 'docx_block_append',
    desc: '[DOCX] Chèn thêm nội dung vào cuối tài liệu Docs.',
    schema: {
      document_id: z.string(),
      content: z.string().describe('Nội dung cần chèn (Markdown)'),
    },
    /**
     * Lark đã BỎ command `append`: giờ chỉ còn str_replace, str_delete,
     * block_insert_after, block_replace, block_delete, block_move_after,
     * block_copy_insert_after, overwrite (lỗi 3380002 liệt kê đúng danh sách
     * này). Không còn cách nào nói "thêm vào cuối" trong một lời gọi — phải
     * đọc tài liệu để biết block cuối là gì rồi chèn sau nó.
     */
    handler: async (a, api) => {
      const token = await docToken(api, a.document_id);
      const doc = encodeURIComponent(token);
      const r = await api.post(`/open-apis/docs_ai/v1/documents/${doc}/fetch`, {});
      const blockId = lastTopLevelBlockId(r.data?.document?.content || '', token);
      return api.put(`/open-apis/docs_ai/v1/documents/${doc}`, {
        body: { command: 'block_insert_after', block_id: blockId, content: a.content, doc_format: 'markdown' },
      });
    },
  },
  {
    name: 'docs_word_count',
    desc: '[DOCS] Đếm số từ và số ký tự của tài liệu Docx. Tính theo từ với tiếng Việt, theo ký tự với CJK.',
    schema: { doc: z.string().describe('URL hoặc token tài liệu Docx') },
    handler: async (a, api) => {
      const token = (await docToken(api, a.doc));
      const r = await api.post(`/open-apis/docs_ai/v1/documents/${encodeURIComponent(token)}/fetch`, {});
      const text = collectText(r.data);
      // CJK đếm theo ký tự vì không có dấu cách giữa từ; phần còn lại đếm theo từ.
      const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
      const words = text.replace(/[一-鿿぀-ヿ가-힯]/g, ' ').trim().split(/\s+/).filter(Boolean).length;
      return { characters: text.length, words: words + cjk, cjk_characters: cjk, non_space_characters: text.replace(/\s/g, '').length };
    },
  },
  {
    name: 'docs_history_list',
    desc: '[DOCS] Xem lịch sử phiên bản tài liệu. Trả về history_version_id để dùng cho docs_history_revert.',
    schema: { doc: z.string(), page_size: z.number().int().optional(), page_token: z.string().optional() },
    handler: async (a, api) =>
      api.get(`/open-apis/docs_ai/v1/documents/${encodeURIComponent((await docToken(api, a.doc)))}/histories`, {
        params: { page_size: a.page_size, page_token: a.page_token },
      }),
  },
  {
    name: 'docs_history_revert',
    desc:
      '[DOCS] Khôi phục tài liệu về một phiên bản cũ. CẢNH BÁO: ghi đè nội dung hiện tại. ' +
      'Phải lấy history_version_id từ docs_history_list trước (không dùng revision_id).',
    schema: {
      doc: z.string(),
      history_version_id: z.number().describe('Lấy từ docs_history_list'),
      wait_timeout_ms: z.number().optional(),
    },
    handler: async (a, api) =>
      api.post(`/open-apis/docs_ai/v1/documents/${encodeURIComponent((await docToken(api, a.doc)))}/history/revert`, {
        body: { history_version_id: a.history_version_id, wait_timeout_ms: a.wait_timeout_ms ?? 0 },
      }),
  },
  {
    name: 'docs_history_revert_status',
    desc: '[DOCS] Kiểm tra trạng thái tác vụ khôi phục: running | done | partial_failed | failed.',
    schema: { doc: z.string(), task_id: z.string() },
    handler: async (a, api) =>
      api.get(`/open-apis/docs_ai/v1/documents/${encodeURIComponent((await docToken(api, a.doc)))}/history/revert_status`, {
        params: { task_id: a.task_id },
      }),
  },

  // ── Drive ─────────────────────────────────────────────────────────────
  {
    name: 'drive_search',
    desc: '[DRIVE] Tìm tài liệu trong Drive và Wiki.',
    schema: { query: z.string() },
    method: 'POST',
    path: '/open-apis/search/v2/doc_wiki/search',
    body: ['query'],
  },
  {
    name: 'drive_download',
    desc:
      '[DRIVE] Tải file từ Drive. Server không ghi được vào ổ đĩa của bạn nên trả về LINK TẢI ngắn hạn ' +
      '— đưa link đó cho người dùng bấm.',
    schema: { file_token: z.string(), file_name: z.string().optional() },
    handler: async (a, api) =>
      api.fetchToFile('GET', `/open-apis/drive/v1/files/${encodeURIComponent(a.file_token)}/download`, {
        name: a.file_name || `${a.file_token}.bin`,
      }),
  },

  // ── Wiki ──────────────────────────────────────────────────────────────
  { name: 'wiki_space_list', desc: '[WIKI] Liệt kê các không gian Wiki.', schema: {}, method: 'GET', path: '/open-apis/wiki/v2/spaces' },
  {
    name: 'wiki_node_list',
    desc: '[WIKI] Liệt kê node trong một không gian Wiki.',
    schema: { space_id: z.string(), parent_node_token: z.string().optional() },
    method: 'GET',
    path: '/open-apis/wiki/v2/spaces/{space_id}/nodes',
    query: ['parent_node_token'],
  },
  {
    name: 'wiki_node_create',
    desc: '[WIKI] Tạo node mới trong Wiki.',
    schema: {
      space_id: z.string(),
      title: z.string(),
      obj_type: z.string().optional().describe('docx (mặc định), sheet, bitable…'),
      parent_node_token: z.string().optional(),
    },
    handler: async (a, api) =>
      api.post(`/open-apis/wiki/v2/spaces/${encodeURIComponent(a.space_id)}/nodes`, {
        body: {
          title: a.title,
          obj_type: a.obj_type || 'docx',
          node_type: 'origin',
          ...(a.parent_node_token ? { parent_node_token: a.parent_node_token } : {}),
        },
      }),
  },
];

/** Người dùng hay dán nguyên URL thay vì token — nhận cả hai. */
function extractToken(input) {
  if (!input) throw new Error('Thiếu doc');
  const m = String(input).match(/\/(?:docx|docs|wiki|sheets|base)\/([A-Za-z0-9]+)/);
  return m ? m[1] : String(input).trim();
}

/**
 * Token tài liệu THẬT.
 *
 * URL Wiki không chứa token tài liệu mà chứa token NODE — nhét thẳng vào
 * `/documents/{id}` thì Lark trả trang HTML 404, tức lỗi `non_json` chứ không
 * phải một mã lỗi đọc được. Phải hỏi Lark node đó đang bọc object nào.
 *
 * Đã xảy ra thật: 12/08 một lượt `docx_document_raw_content` nhận link `/wiki/`
 * và chết đúng kiểu đó — lỗi DUY NHẤT trong 14 ngày mà người dùng không có
 * đường vòng nào để thoát.
 *
 * `base_url_resolve` gỡ y hệt cái bẫy này cho Bitable.
 */
async function docToken(api, input) {
  const raw = extractToken(input);
  if (!/\/wiki\//.test(String(input))) return raw;
  try {
    const n = await api.get('/open-apis/wiki/v2/spaces/get_node', { params: { token: raw } });
    return n.data?.node?.obj_token || raw;
  } catch {
    // Thiếu quyền đọc Wiki thì cứ thử token thô — lỗi sau đó nói rõ hơn là
    // nuốt mất và báo một câu chung chung ở đây.
    return raw;
  }
}

function collectText(node, out = []) {
  if (!node) return out.join('');
  if (typeof node === 'string') {
    out.push(node);
    return out.join('');
  }
  if (Array.isArray(node)) {
    for (const n of node) collectText(n, out);
    return out.join('');
  }
  for (const [k, v] of Object.entries(node)) {
    if (k === 'content' && typeof v === 'string') out.push(v);
    else if (typeof v === 'object') collectText(v, out);
  }
  return out.join('');
}
