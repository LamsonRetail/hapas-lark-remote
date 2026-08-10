import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

/**
 * Kho file tạm cho các tool "xuất ra file".
 *
 * Bản zip chạy trên máy người dùng nên ghi thẳng ra ổ đĩa của họ
 * (`--output-path ./bao-cao.xlsx`). Server remote không có ổ đĩa đó — ghi ra
 * `output_path` chỉ tạo file trên máy chủ, người dùng không bao giờ thấy.
 *
 * Nên thay vì đường dẫn, tool trả về một URL tải ngắn hạn. Người dùng bấm là
 * tải được, và file tự hết hạn.
 */

const DIR = path.join(config.dataDir, 'files');
fs.mkdirSync(DIR, { recursive: true });

const TTL_MS = 60 * 60 * 1000; // 1 tiếng
const meta = new Map(); // id → { name, mime, openId, expiresAt }

/** Xoá file quá hạn. Không có bước này thì đĩa phình vô hạn. */
function sweep() {
  const now = Date.now();
  for (const [id, m] of meta) {
    if (m.expiresAt > now) continue;
    meta.delete(id);
    fs.rm(path.join(DIR, id), { force: true }, () => {});
  }
}
setInterval(sweep, 10 * 60 * 1000).unref();

export function saveFile({ buffer, name, mime = 'application/octet-stream', openId }) {
  const id = crypto.randomBytes(16).toString('hex');
  fs.writeFileSync(path.join(DIR, id), buffer);
  meta.set(id, { name, mime, openId, expiresAt: Date.now() + TTL_MS });
  return {
    download_url: `${config.publicUrl}/files/${id}`,
    file_name: name,
    size_bytes: buffer.length,
    expires_in_minutes: Math.round(TTL_MS / 60000),
    note: 'Link tải hết hạn sau 1 tiếng. Chỉ chính chủ mới tải được.',
  };
}

export function readFile(id, openId) {
  const m = meta.get(id);
  if (!m || m.expiresAt < Date.now()) return null;
  // File có thể chứa dữ liệu nội bộ — chỉ người tạo mới tải được
  if (m.openId && m.openId !== openId) return null;
  const p = path.join(DIR, id);
  if (!fs.existsSync(p)) return null;
  return { ...m, stream: fs.createReadStream(p) };
}

/** Xoá sạch khi khởi động — file tạm của lần chạy trước không còn ai giữ link. */
export function resetFiles() {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(path.join(DIR, f), { force: true });
}
