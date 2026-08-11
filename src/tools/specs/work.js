import { z } from 'zod';

/** Task / Mail / Minutes / VC / OKR. */

/**
 * Transcript một cuộc họp một tiếng đã là ~70k ký tự — đổ hết vào hội thoại là
 * đốt context của người dùng cho thứ họ chưa chắc cần. Trả phần đầu kèm link
 * tải bản đầy đủ, giống cách slides_xml_get và whiteboard_query đang làm.
 */
const TRANSCRIPT_INLINE_MAX = 12000;

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

  // ── Approval ──────────────────────────────────────────────────────────
  // Nhóm duy nhất phải chạy as-bot: approval v4 từ chối user_access_token
  // (`99991668: user access token not support`). Vì bot thấy nhiều hơn người
  // gọi, `user_id` bị KHOÁ về api.openId — không nhận từ args. Bỏ rào đó là
  // mở đường cho bất kỳ ai đọc đơn phê duyệt của người khác.
  {
    name: 'approval_search',
    desc:
      '[APPROVAL] Đơn phê duyệt liên quan tới chính bạn. ' +
      'scope=to_me (mặc định): đơn đang chờ bạn duyệt. ' +
      'scope=by_me: đơn bạn đã gửi, trong `days` ngày gần nhất (Lark giới hạn 30 ngày). ' +
      'Chỉ đọc — không duyệt/từ chối được.',
    schema: {
      scope: z.enum(['to_me', 'by_me']).optional(),
      page_size: z.number().int().min(5).max(100).optional().describe('5–100, mặc định 20. Lark từ chối dưới 5.'),
      page_token: z.string().optional(),
      days: z.number().int().min(1).max(30).optional().describe('Chỉ dùng cho scope=by_me. Mặc định 30.'),
    },
    handler: async (a, api) => {
      // page_size PHẢI ở query: đặt trong body thì Lark bỏ qua và luôn trả 10
      // mục. Lark cũng từ chối page_size < 5 (`99992402 field validation
      // failed`) — đó là lý do schema chặn ở 5 chứ không phải 1.
      const params = {
        user_id_type: 'open_id',
        page_size: a.page_size || 20,
        ...(a.page_token ? { page_token: a.page_token } : {}),
      };

      if (a.scope === 'by_me') {
        const to = Date.now();
        const from = to - (a.days || 30) * 86_400_000;
        return api.callAsBot('POST', '/open-apis/approval/v4/instances/query', {
          params,
          body: {
            user_id: api.openId, // khoá phạm vi, xem ghi chú ở trên
            instance_start_time_from: String(from),
            instance_start_time_to: String(to),
          },
        });
      }

      return api.callAsBot('POST', '/open-apis/approval/v4/tasks/search', {
        params,
        body: { user_id: api.openId },
      });
    },
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
  // Transcript nằm ở `/minutes/{token}/artifacts` (một chuỗi thẳng, kèm
  // keywords), metadata ở `/minutes/{token}`. KHÔNG có endpoint `/blocks` —
  // bản đầu gọi vào đó và ăn 404 non-JSON, tức minutes_transcript và
  // lark_meeting_note CHƯA BAO GIỜ chạy được: audit_logs ghi 5/5 lần gọi đều
  // lỗi từ 10/08. Canary chỉ gọi tool đọc thuộc nhóm khác nên không chạm tới.
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
    desc:
      '[MINUTES] Lấy toàn văn transcript của một biên bản họp. ' +
      'Transcript dài thì trả LINK TẢI kèm phần đầu, thay vì đổ hết vào hội thoại.',
    schema: {
      minute_token: z.string().describe('Token hoặc URL Minutes'),
      max_chars: z.number().int().min(500).optional().describe(`Mặc định ${TRANSCRIPT_INLINE_MAX}. Dài hơn thì kèm link tải bản đầy đủ.`),
    },
    handler: async (a, api) => {
      const token = extractMinuteToken(a.minute_token);
      const r = await api.get(`/open-apis/minutes/v1/minutes/${encodeURIComponent(token)}/artifacts`);
      return {
        minute_token: token,
        keywords: r.data?.keywords || [],
        ...cutTranscript(api, token, r.data?.transcript || '', a.max_chars),
      };
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
          meta.other_matches = items.slice(1, 6).map((m) => ({
            title: plainTitle(m),
            token: m.minute_token || m.token,
          }));
        }
      }

      // Kết quả search KHÔNG có `title`, chỉ có `display_info` kèm thẻ <h> đánh
      // dấu từ khoá khớp — không dùng làm tiêu đề được. Hỏi metadata riêng, và
      // GỘP vào chứ không ghi đè: `other_matches` chỉ có ở kết quả search.
      if (!meta?.title) {
        try {
          const info = await api.get(`/open-apis/minutes/v1/minutes/${encodeURIComponent(token)}`);
          meta = { ...(meta || {}), ...(info.data?.minute || {}) };
        } catch {
          // Thiếu quyền đọc metadata không được cản việc lấy transcript — giữ
          // những gì search đã trả, chỉ dựng lại tiêu đề từ display_info.
          if (meta) meta.title = plainTitle(meta);
        }
      }

      const r = await api.get(`/open-apis/minutes/v1/minutes/${encodeURIComponent(token)}/artifacts`);

      return {
        minute_token: token,
        title: meta?.title,
        meeting: meta,
        keywords: r.data?.keywords || [],
        ...cutTranscript(api, token, r.data?.transcript || '', a.max_chars),
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
/**
 * Tiêu đề từ một kết quả minutes_search. Search chỉ trả `display_info`, trong đó
 * từ khoá khớp bị bọc thẻ <h>…</h> và phía sau còn dính Keywords/Owner/Duration.
 * Lấy dòng đầu, bỏ thẻ, giải mã vài entity HTML mà Lark chèn vào.
 */
function plainTitle(m) {
  if (m?.title) return m.title;
  const first = String(m?.display_info || '').split('\n')[0];
  return first
    .replace(/<\/?[a-z]+>/gi, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .trim();
}

function cutTranscript(api, token, transcript, maxChars) {
  const limit = maxChars || TRANSCRIPT_INLINE_MAX;
  const chars = transcript.length;
  if (chars <= limit) return { transcript, transcript_chars: chars, truncated: false };
  return {
    transcript: transcript.slice(0, limit) + '\n…',
    transcript_chars: chars,
    truncated: true,
    ...api.saveText(transcript, `${token}-transcript.txt`),
  };
}

function extractMinuteToken(input) {
  const m = String(input).match(/\/minutes\/([A-Za-z0-9]+)/);
  return m ? m[1] : String(input).trim();
}
