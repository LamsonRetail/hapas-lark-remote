import { z } from 'zod';

/** Danh tính, danh bạ, lịch, IM. */
export default [
  {
    name: 'lark_whoami',
    desc: '[LARK] Xem bạn đang chạy dưới danh tính Lark nào.',
    schema: {},
    method: 'GET',
    path: '/open-apis/authen/v1/user_info',
  },
  {
    name: 'lark_auth_status',
    desc: '[LARK] Kiểm tra trạng thái xác thực: còn hạn bao lâu, có refresh token không.',
    schema: {},
    handler: async (_a, api) => {
      const me = await api.get('/open-apis/authen/v1/user_info');
      return {
        identity: 'user',
        name: me.data?.name,
        open_id: me.data?.open_id,
        email: me.data?.enterprise_email || me.data?.email,
        note: 'Server remote luôn chạy quyền user. Không có chế độ bot cho tool của người dùng.',
      };
    },
  },

  // ── IM ────────────────────────────────────────────────────────────────
  {
    name: 'im_chat_list',
    desc: '[IM] Liệt kê các nhóm chat của bạn.',
    schema: { page_size: z.number().int().min(1).max(100).optional() },
    method: 'GET',
    path: '/open-apis/im/v1/chats',
    query: ['page_size'],
  },
  {
    name: 'im_chat_search',
    desc: '[IM] Tìm nhóm chat theo tên.',
    schema: { query: z.string().describe('Từ khoá tên nhóm') },
    method: 'POST',
    path: '/open-apis/im/v2/chats/search',
    body: ['query'],
  },
  {
    name: 'im_chat_members_list',
    desc: '[IM] Liệt kê thành viên một nhóm (kèm open_id). Dùng để lấy open_id thật trước khi mention hay giao task.',
    schema: {
      chat_id: z.string().describe('chat_id của nhóm (oc_...)'),
      page_size: z.number().int().max(100).optional(),
    },
    method: 'GET',
    path: '/open-apis/im/v1/chats/{chat_id}/members/list',
    query: ['page_size'],
  },
  {
    name: 'im_send_message',
    desc: '[IM] Gửi tin nhắn text vào nhóm hoặc cho một người.',
    schema: {
      target_type: z.enum(['chat', 'user']),
      target_id: z.string().describe('chat_id (oc_...) hoặc open_id (ou_...)'),
      text: z.string(),
    },
    handler: async (a, api) =>
      api.post('/open-apis/im/v1/messages', {
        params: { receive_id_type: a.target_type === 'chat' ? 'chat_id' : 'open_id' },
        body: { receive_id: a.target_id, msg_type: 'text', content: JSON.stringify({ text: a.text }) },
      }),
  },
  {
    name: 'im_send_card',
    desc:
      '[IM] Gửi thẻ tương tác (Card 2.0) — tiêu đề màu, cột, nút bấm, bảng. ' +
      'card_json bắt buộc có "schema":"2.0". Mention trong thẻ dùng <at id=ou_xxx></at>.',
    schema: {
      target_type: z.enum(['chat', 'user']),
      target_id: z.string(),
      card_json: z.string().describe('Chuỗi JSON của thẻ Card 2.0'),
    },
    handler: async (a, api, h) =>
      api.post('/open-apis/im/v1/messages', {
        params: { receive_id_type: a.target_type === 'chat' ? 'chat_id' : 'open_id' },
        body: {
          receive_id: a.target_id,
          msg_type: 'interactive',
          content: JSON.stringify(h.jsonArg(a.card_json, 'card_json')),
        },
      }),
  },

  // ── Danh bạ, lịch ─────────────────────────────────────────────────────
  {
    name: 'contact_search_user',
    desc: '[CONTACT] Tìm nhân viên theo tên/email/số điện thoại.',
    schema: { query: z.string() },
    method: 'POST',
    path: '/open-apis/contact/v3/users/search',
    body: ['query'],
  },
  {
    name: 'calendar_agenda',
    desc: '[CALENDAR] Xem lịch họp của bạn trong khoảng thời gian.',
    schema: {
      start_time: z.string().describe('Unix timestamp giây'),
      end_time: z.string().describe('Unix timestamp giây'),
    },
    method: 'GET',
    path: '/open-apis/calendar/v4/calendars/primary/events/instance_view',
    query: ['start_time', 'end_time'],
  },

  // ── Cửa thoát hiểm, thay cho lark_cli_execute của bản zip ──────────────
  {
    name: 'lark_api_call',
    desc:
      '[LARK] Gọi thẳng bất kỳ endpoint nào của Lark Open API (2500+) dưới danh tính của bạn. ' +
      'Dùng khi không có tool chuyên dụng. Ví dụ: GET /open-apis/im/v1/chats',
    schema: {
      method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
      path: z.string().describe('Bắt đầu bằng /open-apis/'),
      params: z.string().optional().describe('Query string dạng JSON object'),
      body: z.string().optional().describe('Request body dạng JSON'),
    },
    handler: async (a, api, h) => {
      // Bản zip nhận cả lệnh shell (`lark-cli ...`) rồi đưa vào execSync.
      // Trên server dùng chung thì đó là remote code execution — ở đây chỉ HTTP.
      if (!a.path.startsWith('/open-apis/')) throw new Error('path phải bắt đầu bằng /open-apis/');
      return api.call(a.method, a.path, {
        params: h.jsonArg(a.params, 'params'),
        body: h.jsonArg(a.body, 'body'),
      });
    },
  },
];
