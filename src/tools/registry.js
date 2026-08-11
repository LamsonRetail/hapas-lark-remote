import { larkApi, larkApiAll, getBotToken } from '../lark.js';
import { auditToolCall } from '../audit.js';
import { touchMachine } from '../machines.js';
import { saveFile } from '../files.js';
import { annotationsFor } from './hints.js';

/**
 * Hạ tầng đăng ký tool.
 *
 * Tool được khai báo dạng DỮ LIỆU, không phải code:
 *   { name, desc, schema, method, path, query, body, fixedQuery }
 * Thêm một tool mới = thêm một object vào file spec tương ứng. Chỉ khi nào
 * cần nhiều hơn một REST call mới phải viết `handler`.
 *
 * Endpoint trong các file spec đều bóc từ `lark-cli <shortcut> --dry-run`
 * của chính bản zip, nên hai bản luôn gọi cùng một API.
 */

export function apiFor(getToken, actor) {
  const call = async (method, path, opts = {}) => larkApi(method, path, { ...opts, token: await getToken() });
  return {
    openId: actor.openId, // vài API bắt buộc user_id dù đang hỏi chính mình
    call,
    get: (p, o) => call('GET', p, o),
    post: (p, o) => call('POST', p, o),
    put: (p, o) => call('PUT', p, o),
    patch: (p, o) => call('PATCH', p, o),
    del: (p, o) => call('DELETE', p, o),
    getAll: async (p, o = {}) => larkApiAll(p, { ...o, token: await getToken() }),

    /**
     * Gọi bằng token BOT thay vì token của người dùng.
     *
     * Chỉ dùng cho API mà Lark KHÔNG nhận user_access_token — approval v4 trả
     * `99991668: user access token not support`.
     *
     * NGUY HIỂM trên server dùng chung: bot thấy nhiều hơn người gọi. Tool nào
     * dùng hàm này PHẢI tự khoá phạm vi về `api.openId` và KHÔNG BAO GIỜ nhận
     * user_id từ args — nếu không, ai cũng đọc được dữ liệu của người khác.
     */
    callAsBot: async (method, p, opts = {}) => larkApi(method, p, { ...opts, token: await getBotToken() }),

    /** Tải nội dung nhị phân rồi trả link tải thay vì đường dẫn ổ đĩa. */
    async fetchToFile(method, p, { name, mime, ...opts } = {}) {
      const res = await larkApi(method, p, { ...opts, token: await getToken(), raw: true });
      if (!res.ok) throw new Error(`Tải thất bại: HTTP ${res.status}`);
      const buffer = Buffer.from(await res.arrayBuffer());
      return saveFile({ buffer, name, mime: mime || res.headers.get('content-type'), openId: actor.openId });
    },
    saveText(text, name, mime = 'text/plain; charset=utf-8') {
      return saveFile({ buffer: Buffer.from(text, 'utf8'), name, mime, openId: actor.openId });
    },
  };
}

const jsonArg = (v, label) => {
  if (v === undefined || v === null || v === '') return undefined;
  if (typeof v === 'object') return v;
  try {
    return JSON.parse(v);
  } catch (e) {
    throw new Error(`${label} không phải JSON hợp lệ: ${e.message}`);
  }
};

function fillPath(tpl, args) {
  return tpl.replace(/\{(\w+)\}/g, (_, k) => {
    if (args[k] === undefined || args[k] === null || args[k] === '') {
      throw new Error(`Thiếu tham số bắt buộc: ${k}`);
    }
    return encodeURIComponent(args[k]);
  });
}

const pick = (args, keys = []) => {
  const o = {};
  for (const k of keys) if (args[k] !== undefined) o[k] = args[k];
  return o;
};

export const helpers = { jsonArg };

/**
 * Chạy một tool spec. Tách khỏi registerAll để canary gọi được cùng đúng đường
 * mà người dùng đi — canary chạy một nhánh code riêng thì nó chỉ chứng minh
 * nhánh riêng đó còn sống.
 */
export function execSpec(t, args, api) {
  return t.handler
    ? t.handler(args, api, helpers)
    : api.call(t.method, fillPath(t.path, args), {
        params: { ...(t.fixedQuery || {}), ...pick(args, t.query) },
        body: t.method === 'GET' || t.method === 'DELETE' ? undefined : pick(args, t.body),
      });
}

export function registerAll(server, specs, getToken, actor = {}) {
  const api = apiFor(getToken, actor);

  for (const t of specs) {
    const opts = {
      description: t.desc,
      inputSchema: t.schema || {},
      // Không có annotations thì client coi mọi tool là có thể sửa dữ liệu và
      // hỏi lại từng cái một — xem hints.js.
      annotations: annotationsFor(t.name),
    };

    server.registerTool(t.name, opts, async (args = {}) => {
      const started = Date.now();
      // `last_seen` trong bảng machines — có throttle 5 phút, xem machines.js
      touchMachine({ openId: actor.openId, name: actor.name, clientId: actor.clientId });
      const done = (ok, errorMsg, larkCode) =>
        auditToolCall({
          openId: actor.openId,
          userName: actor.name,
          clientId: actor.clientId,
          toolName: t.name,
          args,
          ok,
          errorMsg,
          larkCode,
          durationMs: Date.now() - started,
        });

      try {
        const out = await execSpec(t, args, api);
        done(true);
        return { content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] };
      } catch (e) {
        // e.code của LarkError: tách riêng để phân biệt "user thiếu quyền"
        // (chuyện thường ngày) với "endpoint đổi" (dấu hiệu API Lark thay đổi).
        done(false, e.message, e.code);
        const hint = e.reauth ? '\n→ Vào lại connector và đăng nhập Lark một lần nữa.' : '';
        return { content: [{ type: 'text', text: `Lỗi: ${e.message}${hint}` }], isError: true };
      }
    });
  }
  return specs.length;
}
