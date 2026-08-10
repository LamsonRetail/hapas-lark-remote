import { z } from 'zod';

/** Bitable: bảng, bản ghi, dashboard, automation. */
export default [
  {
    name: 'base_url_resolve',
    desc:
      '[BASE] Từ URL Bitable/Wiki/link chia sẻ record, tách ra base_token, table_id, view_id, record_id. ' +
      'Dùng ĐẦU TIÊN khi người dùng chỉ dán link — thay vì đoán token.',
    schema: { url: z.string() },
    handler: async (a, api) => {
      // Bản zip cũng chỉ phân tích chuỗi, không gọi API (dry-run trả api: []).
      const u = String(a.url);
      const out = {
        base_token: (u.match(/\/(?:base|wiki)\/([A-Za-z0-9]+)/) || [])[1] || null,
        table_id: (u.match(/[?&]table=([A-Za-z0-9]+)/) || [])[1] || null,
        view_id: (u.match(/[?&]view=([A-Za-z0-9]+)/) || [])[1] || null,
        record_id: (u.match(/[?&]record=([A-Za-z0-9]+)/) || [])[1] || null,
        dashboard_id: (u.match(/[?&]dashboard=([A-Za-z0-9]+)/) || [])[1] || null,
      };
      if (!out.base_token) throw new Error('Không nhận ra token Bitable trong URL này.');

      // Link Wiki trỏ tới Bitable: phải hỏi Lark node thật là gì
      if (/\/wiki\//.test(u)) {
        try {
          const n = await api.get('/open-apis/wiki/v2/spaces/get_node', { params: { token: out.base_token } });
          if (n.data?.node?.obj_token) {
            out.wiki_node_token = out.base_token;
            out.base_token = n.data.node.obj_token;
            out.obj_type = n.data.node.obj_type;
          }
        } catch {
          out.note = 'Là link Wiki nhưng không resolve được node — có thể thiếu quyền.';
        }
      }
      return out;
    },
  },

  // ── Bản ghi ───────────────────────────────────────────────────────────
  {
    name: 'base_record_list',
    desc: '[BASE] Đọc bản ghi trong một bảng Base.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      limit: z.number().int().max(500).optional(),
      offset: z.number().int().optional(),
    },
    method: 'GET',
    path: '/open-apis/base/v3/bases/{base_token}/tables/{table_id}/records',
    query: ['limit', 'offset'],
  },
  {
    name: 'base_record_create',
    desc: '[BASE] Tạo một bản ghi mới trong Bitable.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      fields: z.string().describe('JSON object các trường, ví dụ {"Tên":"A","Số":1}'),
    },
    handler: async (a, api, h) =>
      api.post(
        `/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/tables/${encodeURIComponent(a.table_id)}/records/batch_create`,
        { body: { records: [{ fields: h.jsonArg(a.fields, 'fields') }] } },
      ),
  },
  {
    name: 'base_record_batch_create',
    desc: '[BASE] Tạo nhiều bản ghi cùng lúc.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      records: z.string().describe('JSON mảng: [{"fields":{…}}, …]'),
    },
    handler: async (a, api, h) => {
      const recs = h.jsonArg(a.records, 'records');
      return api.post(
        `/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/tables/${encodeURIComponent(a.table_id)}/records/batch_create`,
        { body: { records: Array.isArray(recs) ? recs : [recs] } },
      );
    },
  },
  {
    name: 'base_data_query',
    desc: '[BASE] Truy vấn/tổng hợp dữ liệu Base bằng JSON DSL (group, filter, sort, top N). dimensions và measures không được cùng rỗng.',
    schema: { base_token: z.string(), dsl: z.string().describe('Chuỗi JSON DSL') },
    handler: async (a, api, h) =>
      api.post(`/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/data/query`, {
        body: h.jsonArg(a.dsl, 'dsl'),
      }),
  },

  // ── Dashboard (tên khớp bản zip) ──────────────────────────────────────
  {
    name: 'dashboard_create',
    desc: '[BASE] Tạo dashboard trong Base.',
    schema: { base_token: z.string(), name: z.string() },
    method: 'POST',
    path: '/open-apis/base/v3/bases/{base_token}/dashboards',
    body: ['name'],
  },
  {
    name: 'dashboard_block_list',
    desc: '[BASE] Liệt kê block trong dashboard.',
    schema: { base_token: z.string(), dashboard_id: z.string() },
    method: 'GET',
    path: '/open-apis/base/v3/bases/{base_token}/dashboards/{dashboard_id}/blocks',
  },
  {
    name: 'dashboard_block_create',
    desc: '[BASE] Tạo block biểu đồ trong dashboard.',
    schema: {
      base_token: z.string(),
      dashboard_id: z.string(),
      name: z.string(),
      type: z.string().describe('bar | line | pie | …'),
      data_config: z.string().optional().describe('JSON cấu hình dữ liệu'),
    },
    handler: async (a, api, h) =>
      api.post(
        `/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/dashboards/${encodeURIComponent(a.dashboard_id)}/blocks`,
        { body: { name: a.name, type: a.type, ...(a.data_config ? { data_config: h.jsonArg(a.data_config, 'data_config') } : {}) } },
      ),
  },
  {
    name: 'dashboard_block_delete',
    desc: '[BASE] Xoá một block khỏi dashboard.',
    schema: { base_token: z.string(), dashboard_id: z.string(), block_id: z.string() },
    method: 'DELETE',
    path: '/open-apis/base/v3/bases/{base_token}/dashboards/{dashboard_id}/blocks/{block_id}',
  },
  {
    name: 'dashboard_arrange',
    desc: '[BASE] Sắp xếp bố cục dashboard.',
    schema: { base_token: z.string(), dashboard_id: z.string(), layout: z.string().optional().describe('JSON layout') },
    handler: async (a, api, h) =>
      api.post(
        `/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/dashboards/${encodeURIComponent(a.dashboard_id)}/arrange`,
        { body: a.layout ? h.jsonArg(a.layout, 'layout') : {} },
      ),
  },

  // ── Automation ────────────────────────────────────────────────────────
  {
    name: 'base_workflow_list',
    desc: '[BASE] Liệt kê automation của một Base.',
    schema: { base_token: z.string() },
    method: 'POST',
    path: '/open-apis/base/v3/bases/{base_token}/workflows/list',
  },
  {
    name: 'base_workflow_enable',
    desc: '[BASE] Bật hoặc tắt một automation.',
    schema: { base_token: z.string(), workflow_id: z.string(), enable: z.boolean().optional() },
    handler: async (a, api) => {
      const action = a.enable === false ? 'disable' : 'enable';
      return api.patch(
        `/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/workflows/${encodeURIComponent(a.workflow_id)}/${action}`,
        { body: {} },
      );
    },
  },
  {
    name: 'base_workflow_create',
    desc:
      '[BASE] Tạo automation mới. LƯU Ý GIỚI HẠN CỦA LARK: API chỉ tạo được trigger loại AddRecordTrigger ' +
      '(khi có dòng mới). FieldChangeTrigger và trigger theo lịch bị chặn hoàn toàn qua API — phải tạo bằng giao diện Lark.',
    schema: { base_token: z.string(), workflow_json: z.string().describe('JSON định nghĩa workflow') },
    handler: async (a, api, h) =>
      api.post(`/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/workflows`, {
        body: h.jsonArg(a.workflow_json, 'workflow_json'),
      }),
  },
];
