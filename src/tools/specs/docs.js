import { z } from 'zod';

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
    desc: '[DOCX] Đọc toàn bộ nội dung văn bản của một tài liệu Docs.',
    schema: { document_id: z.string().describe('ID tài liệu (token trên URL)') },
    method: 'POST',
    path: '/open-apis/docs_ai/v1/documents/{document_id}/fetch',
  },
  {
    name: 'docx_block_append',
    desc: '[DOCX] Chèn thêm nội dung vào cuối tài liệu Docs.',
    schema: {
      document_id: z.string(),
      content: z.string().describe('Nội dung cần chèn (Markdown)'),
    },
    handler: async (a, api) =>
      api.put(`/open-apis/docs_ai/v1/documents/${encodeURIComponent(a.document_id)}`, {
        body: { command: 'append', content: a.content, doc_format: 'markdown' },
      }),
  },
  {
    name: 'docs_word_count',
    desc: '[DOCS] Đếm số từ và số ký tự của tài liệu Docx. Tính theo từ với tiếng Việt, theo ký tự với CJK.',
    schema: { doc: z.string().describe('URL hoặc token tài liệu Docx') },
    handler: async (a, api) => {
      const token = extractToken(a.doc);
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
      api.get(`/open-apis/docs_ai/v1/documents/${encodeURIComponent(extractToken(a.doc))}/histories`, {
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
      api.post(`/open-apis/docs_ai/v1/documents/${encodeURIComponent(extractToken(a.doc))}/history/revert`, {
        body: { history_version_id: a.history_version_id, wait_timeout_ms: a.wait_timeout_ms ?? 0 },
      }),
  },
  {
    name: 'docs_history_revert_status',
    desc: '[DOCS] Kiểm tra trạng thái tác vụ khôi phục: running | done | partial_failed | failed.',
    schema: { doc: z.string(), task_id: z.string() },
    handler: async (a, api) =>
      api.get(`/open-apis/docs_ai/v1/documents/${encodeURIComponent(extractToken(a.doc))}/history/revert_status`, {
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
