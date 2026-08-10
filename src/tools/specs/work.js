import { z } from 'zod';

/** Task / Mail / Minutes / VC / OKR. */
export default [
  // ── Task ──────────────────────────────────────────────────────────────
  {
    name: 'task_search',
    desc: '[TASK] Liệt kê task của chính bạn.',
    schema: { page_size: z.number().int().min(1).max(100).optional() },
    method: 'GET',
    path: '/open-apis/task/v2/tasks',
    query: ['page_size'],
    // Bản zip dùng type=assignee và đang HỎNG: Lark trả 1470400
    // "Invalid Param 'type'. Only 'my_tasks' is supported."
    fixedQuery: { type: 'my_tasks' },
  },
  {
    name: 'task_create',
    desc: '[TASK] Tạo task mới.',
    schema: {
      summary: z.string(),
      description: z.string().optional(),
      due_time: z.string().optional().describe('Unix timestamp mili giây'),
      assignee_ids: z.string().optional().describe('JSON mảng open_id người thực hiện'),
    },
    handler: async (a, api, h) => {
      const members = a.assignee_ids
        ? h.jsonArg(a.assignee_ids, 'assignee_ids').map((id) => ({ id, type: 'user', role: 'assignee' }))
        : undefined;
      return api.post('/open-apis/task/v2/tasks', {
        body: {
          summary: a.summary,
          ...(a.description ? { description: a.description } : {}),
          ...(a.due_time ? { due: { timestamp: String(a.due_time), is_all_day: false } } : {}),
          ...(members ? { members } : {}),
        },
      });
    },
  },
  {
    name: 'task_complete',
    desc: '[TASK] Đánh dấu task đã hoàn thành.',
    schema: { task_guid: z.string() },
    handler: async (a, api) =>
      api.patch(`/open-apis/task/v2/tasks/${encodeURIComponent(a.task_guid)}`, {
        params: { update_fields: 'completed_at' },
        body: { task: { completed_at: String(Date.now()) } },
      }),
  },
  {
    name: 'tasklist_create',
    desc: '[TASK] Tạo danh sách task.',
    schema: { name: z.string() },
    method: 'POST',
    path: '/open-apis/task/v2/tasklists',
    body: ['name'],
  },

  // ── Mail ──────────────────────────────────────────────────────────────
  {
    name: 'mail_triage',
    desc: '[MAIL] Đọc lướt hộp thư đến của bạn.',
    schema: {
      page_size: z.number().int().max(50).optional(),
      folder_id: z.string().optional().describe('Mặc định INBOX'),
    },
    handler: async (a, api) => {
      const list = await api.get('/open-apis/mail/v1/user_mailboxes/me/messages', {
        params: { folder_id: a.folder_id || 'INBOX', page_size: a.page_size || 20 },
      });
      const ids = (list.data?.items || []).map((m) => m.message_id).filter(Boolean);
      if (!ids.length) return list;
      return api.post('/open-apis/mail/v1/user_mailboxes/me/messages/batch_get', { body: { message_ids: ids } });
    },
  },
  {
    name: 'mail_message',
    desc: '[MAIL] Đọc chi tiết một email.',
    schema: { message_id: z.string() },
    method: 'GET',
    path: '/open-apis/mail/v1/user_mailboxes/me/messages/{message_id}',
  },
  {
    name: 'mail_send',
    desc: '[MAIL] Gửi email từ hộp thư của bạn.',
    schema: {
      to: z.string().describe('Email người nhận, nhiều địa chỉ cách nhau bằng dấu phẩy'),
      subject: z.string(),
      body: z.string(),
      is_html: z.boolean().optional(),
    },
    handler: async (a, api) => {
      // Bản zip cũng làm hai bước: lấy profile để biết địa chỉ gửi, rồi tạo draft
      const me = await api.get('/open-apis/mail/v1/user_mailboxes/me/profile');
      const from = me.data?.email || me.data?.primary_email;
      return api.post('/open-apis/mail/v1/user_mailboxes/me/drafts', {
        body: {
          subject: a.subject,
          body_html: a.is_html ? a.body : undefined,
          body_plain_text: a.is_html ? undefined : a.body,
          to: a.to.split(',').map((e) => ({ mail_address: e.trim() })),
          ...(from ? { from: { mail_address: from } } : {}),
        },
      });
    },
  },

  // ── Minutes ───────────────────────────────────────────────────────────
  {
    name: 'minutes_search',
    desc: '[MINUTES] Tìm biên bản họp.',
    schema: { query: z.string() },
    method: 'POST',
    path: '/open-apis/minutes/v1/minutes/search',
    body: ['query'],
  },
  {
    name: 'minutes_transcript',
    desc: '[MINUTES] Lấy toàn văn transcript của một biên bản họp.',
    schema: { minute_token: z.string() },
    handler: async (a, api) => {
      // Gom từng block thay vì dùng +search: cách này không sót chữ nào
      const r = await api.getAll(`/open-apis/minutes/v1/minutes/${encodeURIComponent(a.minute_token)}/blocks`);
      const text = r.items
        .map((b) => b?.paragraph?.elements?.map((e) => e?.text_run?.content || '').join('') || b?.text || '')
        .filter(Boolean)
        .join('\n');
      return { transcript: text, blocks: r.items.length, truncated: r.truncated };
    },
  },
  {
    name: 'minutes_media_link',
    desc: '[MINUTES] Lấy link tải file ghi âm/ghi hình của biên bản họp.',
    schema: { minute_token: z.string() },
    handler: async (a, api) =>
      api.get(`/open-apis/minutes/v1/minutes/${encodeURIComponent(a.minute_token)}/media`),
  },
  {
    name: 'lark_meeting_note',
    desc:
      '[MINUTES] Lấy biên bản một cuộc họp: tìm theo từ khoá hoặc nhận thẳng token/URL, ' +
      'rồi trả về toàn văn transcript kèm thông tin cuộc họp. Nguồn duy nhất là Lark Minutes.',
    schema: {
      query: z.string().optional().describe('Từ khoá tên cuộc họp; bỏ trống nếu đã có minute_token'),
      minute_token: z.string().optional().describe('Token hoặc URL Minutes'),
      max_chars: z.number().int().optional().describe('Cắt bớt transcript nếu quá dài'),
    },
    handler: async (a, api) => {
      // Bản zip tải video về máy rồi đẩy sang Whisper server. Bản này không:
      // Lark Minutes đã có sẵn transcript do chính Lark tạo, chính xác hơn và
      // không cần hạ tầng ngoài. Ai cần Whisper thì vẫn dùng bản zip.
      let token = a.minute_token ? extractMinuteToken(a.minute_token) : null;
      let meta = null;

      if (!token) {
        if (!a.query) throw new Error('Cần query hoặc minute_token.');
        const found = await api.post('/open-apis/minutes/v1/minutes/search', { body: { query: a.query } });
        const items = found.data?.items || [];
        if (!items.length) throw new Error(`Không tìm thấy biên bản nào khớp "${a.query}".`);
        meta = items[0];
        token = meta.minute_token || meta.token;
        if (items.length > 1) {
          meta.other_matches = items.slice(1, 6).map((m) => ({ title: m.title, token: m.minute_token || m.token }));
        }
      }

      const r = await api.getAll(`/open-apis/minutes/v1/minutes/${encodeURIComponent(token)}/blocks`);
      let transcript = r.items
        .map((b) => b?.paragraph?.elements?.map((e) => e?.text_run?.content || '').join('') || b?.text || '')
        .filter(Boolean)
        .join('\n');

      const full = transcript.length;
      if (a.max_chars && transcript.length > a.max_chars) transcript = transcript.slice(0, a.max_chars) + '\n…';

      return {
        minute_token: token,
        title: meta?.title,
        meeting: meta,
        transcript,
        transcript_chars: full,
        blocks: r.items.length,
        truncated: r.truncated || full !== transcript.length,
      };
    },
  },

  // ── VC / OKR ──────────────────────────────────────────────────────────
  {
    name: 'vc_search',
    desc: '[VC] Tìm cuộc họp video.',
    schema: { query: z.string() },
    method: 'POST',
    path: '/open-apis/vc/v1/meetings/search',
    body: ['query'],
  },
  {
    name: 'vc_meeting_message_send',
    desc:
      '[VC] Gửi tin nhắn hoặc reaction vào cuộc họp ĐANG DIỄN RA. Chỉ dùng meeting_id dạng số dài ' +
      '(không phải số phòng họp 9 chữ số). Người gửi phải đang ở trong cuộc họp.',
    schema: {
      meeting_id: z.string(),
      text: z.string().optional(),
      emoji_type: z.string().optional(),
    },
    handler: async (a, api) =>
      api.post(`/open-apis/vc/v1/meetings/${encodeURIComponent(a.meeting_id)}/messages`, {
        body: { ...(a.text ? { text: a.text } : {}), ...(a.emoji_type ? { emoji_type: a.emoji_type } : {}) },
      }),
  },
  {
    name: 'okr_cycle_list',
    desc: '[OKR] Liệt kê chu kỳ OKR. Bỏ trống user_id thì lấy của chính bạn.',
    schema: { user_id: z.string().optional().describe('open_id, mặc định là bạn') },
    // user_id là BẮT BUỘC với Lark (99992402 field validation failed nếu thiếu),
    // kể cả khi hỏi OKR của chính mình.
    handler: async (a, api) =>
      api.get('/open-apis/okr/v2/cycles', {
        params: { user_id: a.user_id || api.openId, user_id_type: 'open_id' },
      }),
  },
];

/** Nhận cả URL Minutes lẫn token trần. */
function extractMinuteToken(input) {
  const m = String(input).match(/\/minutes\/([A-Za-z0-9]+)/);
  return m ? m[1] : String(input).trim();
}
