/**
 * Tool cấu hình Base qua base/v3 (view, cột, form, automation) — chạy offline với `api` giả,
 * không gọi Lark. Bản platform (lsr-agent-platform, tests/test_lark_base_cau_hinh.py) kiểm
 * cùng các tình huống; khi đổi hành vi ở bên nào thì sửa cả hai.
 *
 *   node --test test/base-config.js
 */
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

// config.js đòi biến môi trường khi nạp — test không gọi Lark nên giá trị giả là đủ.
process.env.LARK_APP_ID ||= 'cli_test';
process.env.LARK_APP_SECRET ||= 'test';
process.env.DATA_DIR ||= path.join(os.tmpdir(), 'lark-mcp-base-test');

const { default: base } = await import('../src/tools/specs/base.js');
const { TOOL_NAMES } = await import('../src/tools/index.js');
const { helpers } = await import('../src/tools/registry.js');
const { LarkError } = await import('../src/lark.js');
const { DESTRUCTIVE, READ_ONLY } = await import('../src/tools/hints.js');

const tool = (name) => base.find((t) => t.name === name);
const T = '/open-apis/base/v3/bases/bascnA/tables/tblB';

/** `api` giả: ghi lại lời gọi; trả lời theo `${method} ${path}` → data | Error | hàm. */
function fakeApi(answers = {}) {
  const calls = [];
  const call = async (method, p, opts = {}) => {
    calls.push({ method, path: p, body: opts.body && JSON.parse(JSON.stringify(opts.body)) });
    let ans = answers[`${method} ${p}`];
    if (typeof ans === 'function') ans = ans();
    if (ans instanceof Error) throw ans;
    return { data: ans === undefined ? {} : JSON.parse(JSON.stringify(ans)) };
  };
  return {
    calls,
    writes: () => calls.filter((c) => c.method !== 'GET'),
    get: (p, o) => call('GET', p, o),
    post: (p, o) => call('POST', p, o),
    put: (p, o) => call('PUT', p, o),
    patch: (p, o) => call('PATCH', p, o),
  };
}
const run = (name, args, api) => tool(name).handler({ base_token: 'bascnA', table_id: 'tblB', ...args }, api, helpers);

const NEW = ['base_field_list', 'base_view_list', 'base_view_config', 'base_field_update', 'base_form_list',
  'base_form_config', 'base_workflow_get', 'base_workflow_update', 'base_button_bind'];

test('tool mới có mặt và đã phân loại đọc/ghi', () => {
  for (const n of NEW) assert.ok(TOOL_NAMES.includes(n), n);
  for (const n of ['base_view_config', 'base_field_update', 'base_form_config', 'base_workflow_update',
    'base_button_bind']) assert.ok(DESTRUCTIVE.has(n), n);
  for (const n of ['base_field_list', 'base_view_list', 'base_form_list', 'base_workflow_get']) {
    assert.ok(READ_ONLY.has(n), n);
  }
});

test('view: lọc cột công thức, sắp, nhóm, thứ tự cột — mỗi phần một PUT', async () => {
  const api = fakeApi();
  const out = await run('base_view_config', {
    view_id: 'vewC',
    filter_json: '{"conditions":[["Số ngày còn lại",">=",0],["Số ngày còn lại","<=",30]]}',
    sort_json: '[{"field":"Số ngày còn lại"}]',
    group_json: '[{"field":"Tên nhà thầu"}]',
    visible_fields: ['Tên', 'Số ngày còn lại'],
  }, api);
  assert.deepEqual(api.calls.map((c) => c.path.split('/').pop()), ['filter', 'sort', 'group', 'visible_fields']);
  assert.deepEqual(api.calls[0].body, { logic: 'and', conditions: [['Số ngày còn lại', '>=', 0], ['Số ngày còn lại', '<=', 30]] });
  assert.deepEqual(api.calls[1].body, { sort_config: [{ field: 'Số ngày còn lại', desc: false }] });
  assert.deepEqual(out.applied, ['filter', 'sort', 'group', 'visible_fields']);
});

test('view: đầu vào sai thì không gọi Lark', async () => {
  for (const bad of [{}, { sort_json: JSON.stringify(Array(11).fill({ field: 'A' })) }, { group_json: '[{"desc":1}]' },
    { filter_json: '{"conditions":"A>0"}' }, { visible_fields: [] }, { view_id: '..' }]) {
    const api = fakeApi();
    await assert.rejects(run('base_view_config', { view_id: 'vewC', ...bad }, api));
    assert.equal(api.calls.length, 0, JSON.stringify(bad));
  }
});

test('cột: đổi tên Lookup gửi đủ định nghĩa, trộn sâu, cấm đổi kiểu', async () => {
  const lookup = { id: 'fldL', name: 'Chi phi ke hoach', type: 'lookup', from: 'NT', select: 'Chi phí',
    where: { logic: 'and', conditions: [['Tên', 'intersects', { type: 'field_ref', field: 'NT' }]] } };
  let api = fakeApi({ [`GET ${T}/fields/fldL`]: lookup });
  await run('base_field_update', { field_id: 'fldL', name: 'Chi phí kế hoạch (VND)' }, api);
  const { id, ...rest } = lookup;
  assert.equal(id, 'fldL');
  assert.deepEqual(api.calls[1].body, { ...rest, name: 'Chi phí kế hoạch (VND)' });

  const btn = { id: 'fldB', name: 'Nút', type: 'button', button_config: { title: 'Cũ', color: 'Blue' } };
  api = fakeApi({ [`GET ${T}/fields/fldB`]: btn });
  await run('base_field_update', { field_id: 'fldB', changes_json: '{"button_config":{"title":"Mới"}}' }, api);
  assert.deepEqual(api.calls[1].body.button_config, { title: 'Mới', color: 'Blue' });

  api = fakeApi({ [`GET ${T}/fields/fldL`]: lookup });
  await assert.rejects(run('base_field_update', { field_id: 'fldL', changes_json: '{"type":"text"}' }, api));
  assert.equal(api.writes().length, 0);
});

const QS = { questions: [{ id: 'fld1', title: 'Tên', required: false }, { id: 'fld2', title: 'Số HM', description: 'giữ' }] };

test('form: trộn câu hỏi với bản đang có, gọi theo tiêu đề không dấu', async () => {
  const F = `${T}/forms/vewF`;
  const api = fakeApi({ [`GET ${F}/questions`]: QS });
  await run('base_form_config', {
    form_id: 'vewF', name: 'Phiếu',
    questions_json: '[{"title":"ten","required":true},{"id":"fld2","visible_rule":{"logic":"and","conditions":[["Tên","==","x"]]}}]',
  }, api);
  assert.deepEqual(api.calls.map((c) => c.method), ['GET', 'PATCH', 'PATCH']);
  const sent = api.calls[2].body.questions;
  assert.deepEqual(sent[0], { id: 'fld1', title: 'Tên', required: true });
  assert.equal(sent[1].description, 'giữ');
});

test('form: đầu vào sai thì KHÔNG ghi gì, kể cả phần hợp lệ đi kèm', async () => {
  const F = `${T}/forms/vewF`;
  for (const bad of [{}, { name: 'X', questions_json: '[{"title":"Không có"}]' }, { name: 'X', questions_json: '"Tên"' }]) {
    const api = fakeApi({ [`GET ${F}/questions`]: QS });
    await assert.rejects(run('base_form_config', { form_id: 'vewF', ...bad }, api));
    assert.equal(api.writes().length, 0, JSON.stringify(bad));
  }
  const dup = { questions: [{ id: 'a', title: 'Ghi chú' }, { id: 'b', title: 'ghi chu' }] };
  const api = fakeApi({ [`GET ${F}/questions`]: dup });
  await assert.rejects(run('base_form_config', { form_id: 'vewF', questions_json: '[{"title":"Ghi chú","required":true}]' }, api),
    /gọi bằng id/);
});

test('form: chia sẻ mỗi thiết lập một lời gọi, anyone kèm cảnh báo', async () => {
  const F = `${T}/forms/vewF/share`;
  const api = fakeApi({ [`PATCH ${F}`]: { access_scope: 'anyone' } });
  const out = await run('base_form_config', { form_id: 'vewF', share_scope: 'anyone', require_login: true, share_enabled: true }, api);
  assert.deepEqual(api.calls.map((c) => c.body), [{ access_scope: 'anyone' }, { settings: { require_login: true } }, { enabled: true }]);
  assert.match(out.warning, /BẤT KỲ AI/);
});

const STEPS = [{ id: 't1', type: 'TimerTrigger', data: { rule: 'DAILY' }, next: 'a1' },
  { id: 'a1', type: 'AddRecordAction', title: 'Thêm', data: {}, next: null }];
const W = '/open-apis/base/v3/bases/bascnA/workflows';

test('automation: điền tiêu đề bước, client_token, bật sau khi tạo', async () => {
  const api = fakeApi({ [`POST ${W}`]: { workflow_id: 'wkfX' } });
  const out = await run('base_workflow_create', { workflow_json: JSON.stringify({ title: 'Nhắc', steps: STEPS }), enable: true }, api);
  assert.deepEqual(api.calls[0].body.steps.map((s) => s.title), ['TimerTrigger', 'Thêm']);
  assert.equal(api.calls[0].body.client_token.length, 32);
  assert.equal(api.calls[1].path, `${W}/wkfX/enable`);
  assert.equal(out.data.status, 'enabled');
});

test('automation: bật hỏng vẫn báo ĐÃ tạo (tránh tạo trùng)', async () => {
  const api = fakeApi({ [`POST ${W}`]: { workflow_id: 'wkfX' }, [`PATCH ${W}/wkfX/enable`]: new LarkError(800004006, 'invalid') });
  const out = await run('base_workflow_create', { workflow_json: JSON.stringify({ title: 'Nhắc', steps: STEPS }), enable: true }, api);
  assert.equal(out.data.workflow_id, 'wkfX');
  assert.match(out.enable_error, /đừng tạo lại/);
});

test('automation: đổi tên giữ các bước; gửi thiếu bước phải có replace_all', async () => {
  let api = fakeApi({ [`GET ${W}/wkfX`]: { title: 'Cũ', steps: STEPS } });
  await run('base_workflow_update', { workflow_id: 'wkfX', title: 'Mới' }, api);
  assert.deepEqual(api.calls[1].body.steps.map((s) => s.id), ['t1', 'a1']);

  api = fakeApi({ [`GET ${W}/wkfX`]: { title: 'Cũ', steps: STEPS } });
  const one = JSON.stringify([STEPS[1]]);
  await assert.rejects(run('base_workflow_update', { workflow_id: 'wkfX', steps_json: one }, api), /t1/);
  assert.equal(api.writes().length, 0);
  await run('base_workflow_update', { workflow_id: 'wkfX', steps_json: one, replace_all: true }, api);
  assert.equal(api.writes()[0].body.steps.length, 1);
});

test('gắn nút: tra ID cột trước (gọi bằng tên thì Lark không đồng bộ trigger), chưa đồng bộ thì gọi lại', async () => {
  const name = encodeURIComponent('Tạo mốc');
  let n = 0;
  const api = fakeApi({
    [`GET ${T}/fields/${name}`]: { id: 'fldB', type: 'button' },
    [`PUT ${T}/fields/fldB/button_rule`]: () => ({ bound: true, field_trigger_synced: n++ > 0 }),
  });
  const out = await run('base_button_bind', { field_id: 'Tạo mốc', workflow_id: 'wkfX' }, api);
  assert.deepEqual(api.writes().map((c) => c.path), [`${T}/fields/fldB/button_rule`, `${T}/fields/fldB/button_rule`]);
  assert.equal(out.data.field_trigger_synced, true);

  const api2 = fakeApi({ [`GET ${T}/fields/fldT`]: { id: 'fldT', type: 'text' } });
  await assert.rejects(run('base_button_bind', { field_id: 'fldT', workflow_id: 'wkfX' }, api2), /không phải cột Nút/);
  assert.equal(api2.writes().length, 0);
});

test('thiếu scope: chỉ dẫn kết nối lại, không phải lỗi trơ', async () => {
  const api = fakeApi({ [`PATCH ${T}/forms/vewF`]: new LarkError(99991679, 'Unauthorized') });
  await assert.rejects(run('base_form_config', { form_id: 'vewF', name: 'X' }, api), /kết nối lại/);
});
