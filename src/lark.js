import { config } from './config.js';

export class LarkError extends Error {
  constructor(code, msg, http) {
    super(`Lark ${code}: ${msg}`);
    this.code = code;
    this.http = http;
  }
}

/**
 * Lark nhét chỉ thị điều khiển agent vào payload API (trường `hint` của lark-cli
 * chứa "You MUST…", "YOU must execute…"). Trên server dùng chung, mọi response
 * đi thẳng vào context Claude của người dùng — đó là đường prompt injection.
 * Cắt các trường mang tính chỉ thị trước khi trả về.
 */
const INSTRUCTION_KEYS = new Set(['hint', 'hints', 'instruction', 'instructions', 'agent_hint', 'ai_hint']);

export function stripInstructions(value, depth = 0) {
  if (depth > 12 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => stripInstructions(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (INSTRUCTION_KEYS.has(k.toLowerCase()) && typeof v === 'string') continue;
    out[k] = stripInstructions(v, depth + 1);
  }
  return out;
}

/**
 * Thay toàn bộ runLarkCli của bản v2. Không spawn process, không keychain.
 * `token` là tham số — đây chính là chỗ multi-user được giải quyết.
 */
/**
 * fetch có retry. Mạng ra Lark chập chờn là chuyện thường (đã gặp 5/6 request
 * timeout khi dựng), và một request hỏng không được phép làm hỏng cả tool call.
 * Chỉ thử lại khi lỗi mạng / 5xx / 429 — không thử lại lỗi nghiệp vụ.
 */
export async function fetchRetry(url, init, { tries = 3, timeoutMs = 30000 } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
      if (res.status < 500 && res.status !== 429) return res;
      last = new Error(`HTTP ${res.status}`);
    } catch (e) {
      last = e;
    }
    if (i < tries - 1) await new Promise((r) => setTimeout(r, 400 * 2 ** i + Math.floor(Math.random() * 250)));
  }
  throw last;
}

export async function larkApi(method, apiPath, { params, body, token, raw = false, timeoutMs = 30000 } = {}) {
  const url = new URL(config.openBase + apiPath);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    }
  }

  const res = await fetchRetry(
    url,
    {
      method,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { timeoutMs },
  );

  if (raw) return res; // cho download file

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    // Gọi nhầm host trả về HTML — từng làm chết poller device flow lúc dựng
    throw new LarkError('non_json', `${res.status} không phải JSON: ${text.slice(0, 120)}`, res.status);
  }
  if (json.code !== undefined && json.code !== 0) throw new LarkError(json.code, json.msg, res.status);
  if (json.error) throw new LarkError(json.error, json.error_description || '', res.status);
  return stripInstructions(json);
}

/** Thay `--page-all` của CLI. */
export async function larkApiAll(apiPath, { params = {}, token, itemsKey = 'items', maxPages = 20 } = {}) {
  const items = [];
  let pageToken;
  let pages = 0;
  do {
    const r = await larkApi('GET', apiPath, {
      params: { page_size: 50, ...params, ...(pageToken ? { page_token: pageToken } : {}) },
      token,
    });
    const d = r.data || {};
    items.push(...(d[itemsKey] || []));
    pageToken = d.has_more ? d.page_token : null;
    pages++;
  } while (pageToken && pages < maxPages);
  return { items, pages, truncated: Boolean(pageToken) };
}

/** Token cấp app — dùng cho việc của hệ thống (ghi audit), không phải của user. */
let botToken = { value: null, expiresAt: 0 };
export async function getBotToken() {
  if (botToken.value && Date.now() < botToken.expiresAt - 60_000) return botToken.value;
  const r = await larkApi('POST', '/open-apis/auth/v3/tenant_access_token/internal', {
    body: { app_id: config.appId, app_secret: config.appSecret },
  });
  botToken = { value: r.tenant_access_token, expiresAt: Date.now() + r.expire * 1000 };
  return botToken.value;
}
