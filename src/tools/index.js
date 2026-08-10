import core from './specs/core.js';
import docs from './specs/docs.js';
import office from './specs/office.js';
import base from './specs/base.js';
import work from './specs/work.js';
import { registerAll } from './registry.js';
import { assertClassified } from './hints.js';

export const TOOLS = [...core, ...docs, ...office, ...base, ...work];

// Trùng tên tool là lỗi im lặng khó chịu: MCP chỉ giữ cái đăng ký sau.
// Bắt ngay lúc khởi động thay vì để người dùng gặp tool "biến mất".
const seen = new Set();
for (const t of TOOLS) {
  if (seen.has(t.name)) throw new Error(`Tool trùng tên: ${t.name}`);
  seen.add(t.name);
}

export const TOOL_COUNT = TOOLS.length;
export const TOOL_NAMES = TOOLS.map((t) => t.name).sort();

// Mọi tool phải được xếp vào đúng một nhóm đọc/thêm/phá trong hints.js
assertClassified(TOOL_NAMES);

export function registerTools(server, getToken, actor) {
  return registerAll(server, TOOLS, getToken, actor);
}
