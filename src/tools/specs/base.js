import { randomUUID } from 'node:crypto';
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
    desc: '[BASE] Đọc bản ghi trong một bảng Base. '
      + 'LUÔN truyền `fields` với đúng những cột cần: bảng thực tế có thể tới 127 cột, '
      + 'và 200 bản ghi đủ cột đã là ~400KB (~118 nghìn token, hơn nửa cửa sổ ngữ cảnh). '
      + 'Chọn 3–4 cột thì giảm khoảng 97%. '
      + 'Chưa biết tên cột thì gọi trước một lượt `limit: 1` không kèm `fields` — '
      + 'phản hồi có mảng `fields` liệt kê đủ tên cột và chỉ tốn vài KB.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      // Lark chặn trên 200 (`800010701: Number must be less than or equal to
      // 200`); schema cũ cho tới 500 nên limit 201–500 ra lỗi khó hiểu.
      limit: z.number().int().min(1).max(200).optional(),
      offset: z.number().int().optional(),
      fields: z.array(z.string()).optional()
        .describe('Tên cột cần lấy. Bỏ trống là lấy HẾT — rất tốn ngữ cảnh.'),
    },
    /**
     * Lọc cột Ở PHÍA MÌNH, không nhờ Lark.
     *
     * Đã thử: endpoint GET này BỎ QUA mọi tham số chọn cột (`field_ids`,
     * `field_names`, `fields`, `field_id_list` — cả dạng JSON lẫn CSV đều trả
     * đủ 127 cột, `query_context.field_scope` vẫn là `all_fields`). Còn
     * `base_data_query` chọn được cột nhưng đòi quyền ADMIN trên Base
     * (`800004011: does not have admin`), nên phần lớn người dùng không gọi nổi.
     *
     * May là phản hồi v3 có dạng bảng: `data.data` là mảng-các-mảng, kèm
     * `fields` / `field_id_list` / `field_type_list` song song theo cùng thứ tự
     * cột. Nên cắt theo chỉ số cột là đủ và không mất mát gì.
     *
     * Vẫn tải đủ 400KB từ Lark về — chỗ đó mình không đổi được. Nhưng thứ đi
     * vào cửa sổ ngữ cảnh của model thì giảm đúng theo số cột đã chọn, mà đó
     * mới là chỗ đang đau: một lượt gọi ăn 59% ngữ cảnh.
     */
    handler: async (a, api) => {
      const r = await api.get(
        `/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/tables/${encodeURIComponent(a.table_id)}/records`,
        { params: { limit: a.limit, offset: a.offset } },
      );
      const d = r?.data;
      if (!a.fields?.length || !Array.isArray(d?.data) || !Array.isArray(d?.fields)) return r;

      const muon = new Set(a.fields);
      const idx = d.fields.map((t, i) => (muon.has(t) ? i : -1)).filter((i) => i >= 0);
      // Không cột nào khớp thì trả nguyên bản kèm danh sách cột có thật — im
      // lặng trả về bảng rỗng sẽ đọc thành "bảng không có dữ liệu".
      if (!idx.length) {
        return { ...r, _canh_bao: `Không cột nào khớp \`fields\`. Cột có thật: ${d.fields.join(', ')}` };
      }
      const lay = (arr) => (Array.isArray(arr) ? idx.map((i) => arr[i]) : arr);
      return {
        ...r,
        data: {
          ...d,
          data: d.data.map(lay),
          fields: lay(d.fields),
          field_id_list: lay(d.field_id_list),
          field_type_list: lay(d.field_type_list),
          _da_loc_cot: `${idx.length}/${d.fields.length}`,
        },
      };
    },
  },
  {
    name: 'base_record_create',
    desc: '[BASE] Tạo một bản ghi mới trong Bitable.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      fields: z.string().describe('JSON object các trường, ví dụ {"Tên":"A","Số":1}'),
    },
    handler: async (a, api, h) => batchCreate(api, a, [{ fields: h.jsonArg(a.fields, 'fields') }]),
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
      return batchCreate(api, a, Array.isArray(recs) ? recs : [recs]);
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
      '[BASE] Tạo automation. workflow_json = {"title":"…","steps":[…]}; mỗi bước {id, type, title, data, next}, ' +
      'bảng/cột gọi bằng TÊN. Trigger: AddRecordTrigger {table_name, watched_field_name} (thêm dòng) · ' +
      'SetRecordTrigger {table_name, field_watch_info:[{field_name}]} (sửa dòng) · ChangeRecordTrigger ' +
      '{table_name, condition_list} · TimerTrigger {rule: DAILY|WEEKLY|MONTHLY…, start_time "yyyy-MM-dd HH:mm"} · ' +
      'ReminderTrigger {table_name, field_name, offset, unit: DAY…, hour, minute} · ButtonTrigger ' +
      '{button_type:"buttonField", table_name}. Action: AddRecordAction / SetRecordAction {table_name, ' +
      'field_values:[{field_name, value:[{value_type:"text", value:"…"}]}]} · LarkMessageAction. ' +
      'Tạo xong ở trạng thái TẮT trừ khi enable=true.',
    schema: {
      base_token: z.string(),
      workflow_json: z.string().describe('JSON {"title","steps"} của automation'),
      enable: z.boolean().optional().describe('Bật luôn sau khi tạo (mặc định tắt)'),
    },
    handler: async (a, api, h) =>
      v3(async () => {
        const wf = h.jsonArg(a.workflow_json, 'workflow_json') || {};
        const base = `${V3}/${seg(a.base_token, 'base_token')}`;
        const r = await api.post(`${base}/workflows`, {
          body: { client_token: randomUUID().replace(/-/g, ''), ...wf, steps: withTitles(wf.steps) },
        });
        const id = r.data?.workflow_id;
        if (a.enable) {
          // Đã TẠO xong: bật hỏng mà ném lỗi thì model tạo lại → automation trùng (mỗi lần
          // một client_token mới nên Lark không chặn). Báo thành công kèm lý do.
          try {
            if (!id) throw new Error('Lark không trả workflow_id');
            await api.patch(`${base}/workflows/${seg(id, 'workflow_id')}/enable`, { body: {} });
            r.data.status = 'enabled';
          } catch (e) {
            r.enable_error = `Đã tạo nhưng CHƯA bật được: ${e.message} — bật bằng base_workflow_enable, đừng tạo lại.`;
          }
        }
        return r;
      }),
  },
  {
    name: 'base_workflow_get',
    desc: '[BASE] Đọc đầy đủ một automation (các bước trigger/action) — đọc trước khi sửa.',
    schema: { base_token: z.string(), workflow_id: z.string() },
    method: 'GET',
    path: '/open-apis/base/v3/bases/{base_token}/workflows/{workflow_id}',
  },
  {
    name: 'base_workflow_update',
    desc:
      '[BASE] Sửa automation đã có: đổi tên và/hoặc thay TOÀN BỘ các bước. Không truyền steps_json thì GIỮ ' +
      'NGUYÊN các bước cũ (chỉ đổi tên). Muốn sửa bước: đọc bằng base_workflow_get, sửa trên bản đó rồi gửi lại đủ.',
    schema: {
      base_token: z.string(),
      workflow_id: z.string(),
      title: z.string().optional(),
      steps_json: z.string().optional().describe('JSON mảng TOÀN BỘ các bước mới'),
      replace_all: z.boolean().optional()
        .describe('true khi CHỦ Ý bỏ bước cũ không có trong steps_json; mặc định tool từ chối để khỏi xoá nhầm'),
    },
    handler: async (a, api, h) =>
      v3(async () => {
        const path = `${V3}/${seg(a.base_token, 'base_token')}/workflows/${seg(a.workflow_id, 'workflow_id')}`;
        const title = (a.title || '').trim();
        const steps = h.jsonArg(a.steps_json, 'steps_json');
        if (!title && !steps) throw new Error('Cần title hoặc steps_json.');
        if (steps) withTitles(steps);
        // PUT thay cả workflow: thiếu bước nào là bước đó mất. Model hay chỉ gửi đúng bước
        // vừa sửa, nên làm mất bước cũ thì phải có replace_all.
        const cur = (await api.get(path)).data || {};
        if (steps && !a.replace_all) {
          const keep = new Set(steps.map((x) => x.id));
          const lost = (cur.steps || []).map((x) => x.id).filter((id) => !keep.has(id));
          if (lost.length) {
            throw new Error(
              `Các bước ${JSON.stringify(lost)} sẽ bị XOÁ vì không có trong steps_json. Gửi đủ mọi bước ` +
                '(đọc bằng base_workflow_get), hoặc replace_all=true nếu chủ ý bỏ chúng.',
            );
          }
        }
        return api.put(path, {
          body: { title: title || cur.title || '', steps: withTitles(steps || cur.steps) },
        });
      }),
  },
  {
    name: 'base_button_bind',
    desc: '[BASE] Gắn cột Nút vào một automation có trigger ButtonTrigger, để bấm nút là chạy automation đó.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      field_id: z.string().describe('ID hoặc tên cột Nút'),
      workflow_id: z.string(),
    },
    handler: async (a, api) => v3(async () => bindButton(api, a)),
  },

  // ── Cấu hình bảng: view, cột, form (base/v3) ──────────────────────────
  // bitable/v1 không lọc được cột công thức, không sắp/nhóm/đổi thứ tự cột, không
  // đổi tên cột Lookup/Nút và không chỉnh form — các tool dưới đây làm được hết.
  // Bảng/view/cột nhận cả ID lẫn TÊN (base/v3 tự tra).
  {
    name: 'base_field_list',
    desc: '[BASE] Liệt kê các cột của một bảng: id, tên, kiểu (kèm công thức/nguồn Lookup).',
    schema: { base_token: z.string(), table_id: z.string() },
    method: 'GET',
    path: '/open-apis/base/v3/bases/{base_token}/tables/{table_id}/fields',
    fixedQuery: { limit: 100 },
  },
  {
    name: 'base_view_list',
    desc: '[BASE] Liệt kê các view của một bảng (id, tên, loại, tóm tắt lọc/sắp/nhóm).',
    schema: { base_token: z.string(), table_id: z.string() },
    method: 'GET',
    path: '/open-apis/base/v3/bases/{base_token}/tables/{table_id}/views',
    fixedQuery: { limit: 100 },
  },
  {
    name: 'base_view_config',
    desc:
      '[BASE] Đặt lọc / sắp xếp / nhóm / cột hiển thị (kèm THỨ TỰ cột) cho một view. Lọc và sắp được cả cột ' +
      'công thức, nhóm được cả cột Lookup. Chỉ truyền phần cần đổi; phần đã truyền GHI ĐÈ cấu hình cũ của phần đó.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      view_id: z.string().describe('ID hoặc tên view'),
      filter_json: z.string().optional().describe(
        'JSON {"logic":"and"|"or","conditions":[["Tên cột","toán tử",giá trị]]}. Toán tử: == != > >= < <= ' +
          'intersects disjoint empty non_empty. Vd [["Số ngày còn lại",">=",0],["Số ngày còn lại","<=",30]]',
      ),
      sort_json: z.string().optional().describe('JSON tối đa 10: [{"field":"Tên cột","desc":true}]; [] = bỏ sắp'),
      group_json: z.string().optional().describe('JSON tối đa 3: [{"field":"Tên cột","desc":false}]; [] = bỏ nhóm'),
      visible_fields: z.array(z.string()).optional()
        .describe('Tên MỌI cột muốn hiện, theo đúng thứ tự muốn xếp; cột không có trong danh sách bị ẩn'),
    },
    handler: async (a, api, h) =>
      v3(async () => {
        const view = `${tablePath(a)}/views/${seg(a.view_id, 'view_id')}`;
        const parts = [];
        const filter = h.jsonArg(a.filter_json, 'filter_json');
        if (filter !== undefined) {
          if (!Array.isArray(filter?.conditions)) throw new Error('filter_json phải có mảng "conditions".');
          parts.push(['filter', { logic: filter.logic || 'and', conditions: filter.conditions }]);
        }
        for (const [key, wrap, cap] of [['sort', 'sort_config', 10], ['group', 'group_config', 3]]) {
          const v = h.jsonArg(a[`${key}_json`], `${key}_json`);
          if (v === undefined) continue;
          if (!Array.isArray(v) || v.length > cap || !v.every((x) => x?.field)) {
            throw new Error(`${key}_json phải là mảng tối đa ${cap} mục {"field":"Tên cột","desc":false}.`);
          }
          parts.push([key, { [wrap]: v.map((x) => ({ field: String(x.field), desc: Boolean(x.desc) })) }]);
        }
        if (a.visible_fields !== undefined) {
          if (!a.visible_fields.length) throw new Error('visible_fields phải có ít nhất một cột.');
          parts.push(['visible_fields', { visible_fields: a.visible_fields }]);
        }
        if (!parts.length) throw new Error('Cần ít nhất một trong filter_json, sort_json, group_json, visible_fields.');
        const result = {};
        for (const [key, body] of parts) result[key] = (await api.put(`${view}/${key}`, { body })).data;
        return { view_id: a.view_id, applied: parts.map(([k]) => k), result };
      }),
  },
  {
    name: 'base_field_update',
    desc:
      '[BASE] Đổi tên hoặc sửa thuộc tính một cột — làm được cả cột Lookup, Nút, công thức. Tool tự đọc cấu hình ' +
      'hiện tại rồi trộn phần được truyền vào (object con trộn tiếp, không mất khoá khác), nên không mất công ' +
      'thức/nguồn tra cứu. Không đổi KIỂU cột được.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      field_id: z.string().describe('ID hoặc tên hiện tại của cột'),
      name: z.string().optional().describe('Tên mới'),
      changes_json: z.string().optional().describe(
        'JSON thuộc tính khác cần đổi, vd {"expression":"[A]*2"} hoặc {"button_config":{"title":"Chạy"}}',
      ),
    },
    handler: async (a, api, h) =>
      v3(async () => {
        const path = `${tablePath(a)}/fields/${seg(a.field_id, 'field_id')}`;
        const changes = h.jsonArg(a.changes_json, 'changes_json') || {};
        const name = (a.name || '').trim();
        if (!name && !Object.keys(changes).length) throw new Error('Cần name hoặc changes_json.');
        // PUT của base/v3 thay CẢ định nghĩa cột — gửi mỗi tên là Lark báo 800010701.
        const cur = (await api.get(path)).data || {};
        if (!cur.type) throw new Error('Không đọc được định nghĩa hiện tại của cột.');
        if (changes.type !== undefined && changes.type !== cur.type) {
          throw new Error('Tool này không đổi kiểu cột — đổi kiểu dễ mất dữ liệu, hãy làm trên giao diện Lark.');
        }
        const { id, ...def } = cur;
        const { id: _drop, ...rest } = changes;
        const r = await api.put(path, { body: { ...deepMerge(def, rest), ...(name ? { name } : {}) } });
        return { field: r.data, old_name: cur.name, field_id: id };
      }),
  },
  {
    name: 'base_form_list',
    desc: '[BASE] Liệt kê các form của một bảng (id form = id view dạng vew…).',
    schema: { base_token: z.string(), table_id: z.string() },
    method: 'GET',
    path: '/open-apis/base/v3/bases/{base_token}/tables/{table_id}/forms',
    fixedQuery: { page_size: 100 },
  },
  {
    name: 'base_form_config',
    desc:
      '[BASE] Chỉnh form: tiêu đề, mô tả, câu bắt buộc, điều kiện hiển thị câu hỏi, chia sẻ. Câu hỏi gọi bằng id ' +
      'hoặc tiêu đề; chỉ phần truyền vào bị đổi, phần còn lại của câu hỏi được giữ nguyên.',
    schema: {
      base_token: z.string(),
      table_id: z.string(),
      form_id: z.string(),
      name: z.string().optional().describe('Tiêu đề form mới'),
      description: z.string().optional(),
      questions_json: z.string().optional().describe(
        'JSON [{"id" hoặc "title": câu cần sửa, "required":true, "new_title":"…", "description":"…", ' +
          '"visible_rule":{"logic":"and","conditions":[["Câu phía TRƯỚC","==","Có"]]}}]. visible_rule chỉ được ' +
          'nhắc tới câu nằm trước nó; null = bỏ điều kiện.',
      ),
      share_enabled: z.boolean().optional(),
      share_scope: z.enum(['tenant', 'invite', 'anyone']).optional()
        .describe('anyone = BẤT KỲ AI có link — chỉ dùng khi người dùng yêu cầu rõ'),
      require_login: z.boolean().optional(),
    },
    handler: async (a, api, h) =>
      v3(async () => {
        const form = `${tablePath(a)}/forms/${seg(a.form_id, 'form_id')}`;
        // Kiểm hết đầu vào (kể cả tra câu hỏi) TRƯỚC lần ghi đầu: sai là chưa đụng gì.
        const meta = {};
        if (a.name !== undefined) meta.name = a.name;
        if (a.description !== undefined) meta.description = a.description;
        const qs = h.jsonArg(a.questions_json, 'questions_json');
        if (qs !== undefined && (!Array.isArray(qs) || !qs.every((q) => q && typeof q === 'object'))) {
          throw new Error('questions_json phải là mảng object.');
        }
        // API chia sẻ chỉ nhận MỘT thiết lập mỗi lời gọi.
        const share = [];
        if (a.share_scope !== undefined) share.push({ access_scope: a.share_scope });
        if (a.require_login !== undefined) share.push({ settings: { require_login: a.require_login } });
        if (a.share_enabled !== undefined) share.push({ enabled: a.share_enabled });
        if (!Object.keys(meta).length && !qs?.length && !share.length) {
          throw new Error('Không có gì để đổi — truyền name/description/questions_json/share_*.');
        }
        let merged = [];
        if (qs?.length) {
          // Lark ghi đè CẢ câu hỏi (trường bỏ trống bị xoá) — trộn với bản đang có.
          const cur = (await api.get(`${form}/questions`)).data?.questions || [];
          merged = qs.map((q) => {
            let old = q.id ? cur.find((c) => c.id === q.id) : undefined;
            if (!old) {
              const hits = cur.filter((c) => fold(c.title) === fold(q.title));
              if (hits.length > 1) {
                throw new Error(`Có ${hits.length} câu cùng tiêu đề ${JSON.stringify(q.title)} — gọi bằng id.`);
              }
              [old] = hits;
            }
            if (!old) throw new Error(`Không tìm thấy câu hỏi ${JSON.stringify(q.id || q.title)} trong form.`);
            const item = { id: old.id };
            for (const k of Q_KEYS) if (k in old) item[k] = old[k];
            for (const k of Q_KEYS) if (k in q && k !== 'title') item[k] = q[k];
            if (q.new_title) item.title = String(q.new_title);
            return item;
          });
        }

        const done = {};
        if (Object.keys(meta).length) done.form = (await api.patch(form, { body: meta })).data;
        for (let i = 0; i < merged.length; i += 10) {
          const r = await api.patch(`${form}/questions`, { body: { questions: merged.slice(i, i + 10) } });
          (done.questions ||= []).push(...(r.data?.questions || []));
        }
        for (const body of share) done.share = (await api.patch(`${form}/share`, { body })).data;
        if (done.share?.access_scope === 'anyone') {
          done.warning = 'Form đang mở cho BẤT KỲ AI có link — nhắc người dùng nếu chưa chủ ý.';
        }
        return done;
      }),
  },
];

const V3 = '/open-apis/base/v3/bases';
const Q_KEYS = ['title', 'description', 'required', 'option_display_mode', 'visible_rule'];

/** Một đoạn path: mã hoá, và không cho '.'/'..' leo sang endpoint khác. */
function seg(v, label) {
  const s = String(v ?? '').trim();
  if (!s || s === '.' || s === '..') throw new Error(`Thiếu hoặc sai ${label}.`);
  return encodeURIComponent(s);
}

const tablePath = (a) => `${V3}/${seg(a.base_token, 'base_token')}/tables/${seg(a.table_id, 'table_id')}`;

/**
 * Trộn sâu: object con trộn tiếp, giá trị khác thay hẳn. PUT base/v3 thay CẢ định nghĩa
 * cột, nên đổi {"button_config":{"title":…}} không được làm rơi các khoá khác của nó.
 */
function deepMerge(cur, next) {
  const isObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  const out = { ...cur };
  for (const [k, v] of Object.entries(next)) out[k] = isObj(v) && isObj(out[k]) ? deepMerge(out[k], v) : v;
  return out;
}

/** So tiêu đề không phân biệt hoa thường/dấu (Tên ~ ten). */
const fold = (s) => String(s ?? '').normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim();

/**
 * Gắn nút → automation. PHẢI gọi bằng ID cột: gọi bằng tên thì Lark ghi quan hệ nhưng trả
 * `field_trigger_synced:false` (bấm nút không chạy) — đo 21/10. Lark tự bảo gọi lại lệnh
 * y hệt khi chưa đồng bộ, nên thử thêm một lần.
 */
async function bindButton(api, a) {
  const field = (await api.get(`${tablePath(a)}/fields/${seg(a.field_id, 'field_id')}`)).data || {};
  if (field.type !== 'button') throw new Error(`Cột ${JSON.stringify(a.field_id)} không phải cột Nút.`);
  const path = `${tablePath(a)}/fields/${seg(field.id, 'field_id')}/button_rule`;
  let r = await api.put(path, { body: { workflow_id: a.workflow_id } });
  if (r.data?.field_trigger_synced === false) r = await api.put(path, { body: { workflow_id: a.workflow_id } });
  if (r.data?.field_trigger_synced === false) {
    r.warning = 'Đã gắn nhưng Lark chưa đồng bộ trigger của nút — gọi lại base_button_bind lần nữa.';
  }
  return r;
}

/** Lark từ chối bước thiếu tiêu đề (800004006 "step title is empty") — điền sẵn. */
function withTitles(steps) {
  if (!Array.isArray(steps) || !steps.length) throw new Error('steps phải là mảng bước {id, type, title, data, next}.');
  return steps.map((s) => ({ ...s, title: s.title || s.type || s.id || 'Bước' }));
}

/**
 * 99991679/99991672 = token chưa được cấp scope cho việc này (vd form cần
 * `bitable:app`, có từ 64cfb53). Chỉ người cần tính năng mới phải kết nối lại —
 * nói rõ thay vì để "Lark 99991679" trơ trọi.
 */
async function v3(fn) {
  try {
    return await fn();
  } catch (e) {
    if ([99991679, 99991672].includes(Number(e.code))) {
      throw new Error(
        `${e.message} — tài khoản Lark của bạn chưa cấp quyền cho việc này. Gỡ connector Lark MCP rồi kết nối ` +
          'lại một lần để cấp thêm quyền (các tool khác vẫn dùng bình thường, không cần làm gì).',
      );
    }
    throw e;
  }
}

/**
 * Base v3 nhận bản ghi theo dạng CỘT: {fields:["Tên","Số"], rows:[["A",1]]}.
 * KHÔNG phải {records:[{fields:{…}}]} như bitable v1 — gửi shape cũ thì Lark trả
 * `800010701 invalid_request: Unrecognized key(s) in object: 'records'`. Shape
 * này bóc từ `lark-cli base +record-batch-create --dry-run` của bản zip.
 *
 * Tool vẫn nhận {fields:{…}} cho từng bản ghi vì đó là dạng dễ viết đúng hơn;
 * việc dựng ma trận cột nằm ở đây.
 */
function batchCreate(api, a, records) {
  const rows = records.map((r) => (r && typeof r === 'object' && 'fields' in r ? r.fields : r) || {});
  // Hợp của mọi khoá, giữ thứ tự xuất hiện — bản ghi thiếu trường thì để null
  const fields = [];
  for (const row of rows) for (const k of Object.keys(row)) if (!fields.includes(k)) fields.push(k);
  if (!fields.length) throw new Error('Không có trường nào để ghi.');

  return api.post(
    `/open-apis/base/v3/bases/${encodeURIComponent(a.base_token)}/tables/${encodeURIComponent(a.table_id)}/records/batch_create`,
    { body: { fields, rows: rows.map((row) => fields.map((f) => (row[f] === undefined ? null : row[f]))) } },
  );
}
