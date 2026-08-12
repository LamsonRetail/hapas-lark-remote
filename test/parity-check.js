/**
 * Đối chiếu bộ tool của bản remote với bản zip.
 *
 * Bản zip là chuẩn: nhân viên đã quen tên tool nào thì bản remote phải có tên
 * đó. Chạy script này mỗi khi zip ra bản mới để phát hiện trôi lệch ngay,
 * thay vì đợi người dùng báo "sao bên kia có mà bên này không có".
 *
 *   node parity-check.js                       # so với danh sách chốt bên dưới
 *   node parity-check.js <đường-dẫn-index.js>  # bóc thẳng từ index.js của zip
 */
import fs from 'node:fs';
import { TOOL_NAMES } from '../src/tools/index.js';

// Danh sách tool của bản zip v2.0.25, lấy từ chính MCP server đang chạy.
const ZIP_TOOLS = `
base_data_query base_record_create base_record_list base_url_resolve
base_workflow_create base_workflow_enable base_workflow_list calendar_agenda
contact_search_user dashboard_arrange dashboard_block_create
dashboard_block_delete dashboard_block_list dashboard_create docs_create
docs_history_list docs_history_revert docs_history_revert_status
docs_word_count docx_block_append docx_document_raw_content drive_download
drive_search im_chat_list im_chat_members_list im_chat_search im_send_card
im_send_message lark_auth_status lark_cli_execute lark_drive_transcribe
lark_meeting_note lark_whoami local_media_transcribe mail_send mail_triage
meeting_note_publish meeting_note_status minutes_search okr_cycle_list
sheets_create sheets_table_get sheets_table_put sheets_workbook_export
slides_create slides_replace_pages slides_xml_get task_complete task_create
task_search tasklist_create vc_meeting_message_send vc_search
whiteboard_export_svg whiteboard_query whiteboard_update
whiteboard_update_from_source wiki_node_create wiki_node_list wiki_space_list
`
  .trim()
  .split(/\s+/);

/**
 * Tool cố ý không port, kèm lý do. Danh sách này là tài liệu, không phải chỗ
 * giấu việc chưa làm — mỗi dòng phải nêu được vì sao remote không làm được.
 */
const INTENTIONAL = {
  lark_cli_execute:
    'Nhận chuỗi shell rồi execSync. Trên server dùng chung là remote code execution. Thay bằng lark_api_call (cùng độ phủ, chỉ HTTP).',
  local_media_transcribe:
    'Đọc file trên ổ đĩa NGƯỜI DÙNG. Server không thấy ổ đĩa đó — chạy trên server sẽ đọc nhầm đĩa máy chủ.',
  // Bản remote BỎ HẲN Whisper server. Lark Minutes đã tự tạo transcript, chính
  // xác hơn và không cần hạ tầng ngoài. Agent meeting của bản zip giữ nguyên,
  // không đụng tới.
  lark_drive_transcribe: 'Bỏ Whisper. Transcript lấy từ Lark Minutes qua minutes_search + minutes_transcript.',
  meeting_note_publish: 'Thuộc luồng Whisper cũ (submit → hàng đợi → DM kết quả). Bản remote lấy transcript đồng bộ nên không cần.',
  meeting_note_status: 'Như trên — không còn hàng đợi để hỏi trạng thái.',
  lark_meeting_note:
    'Chỉ là lớp bọc gộp minutes_search + metadata + /artifacts thành một lượt. Ba tool rời đã phủ đủ, nên bỏ để bớt một đường code phải nuôi.',
};

function fromIndexJs(file) {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/mcpServer\.tool\(\s*['"]([a-z0-9_]+)['"]/gi)].map((m) => m[1]);
}

const arg = process.argv[2];
const zip = arg ? fromIndexJs(arg) : ZIP_TOOLS;
const mine = new Set(TOOL_NAMES);

const missing = zip.filter((t) => !mine.has(t) && !INTENTIONAL[t]);
const skipped = zip.filter((t) => INTENTIONAL[t]);
const extra = TOOL_NAMES.filter((t) => !zip.includes(t));

console.log(`zip    : ${zip.length} tool`);
console.log(`remote : ${TOOL_NAMES.length} tool\n`);

if (missing.length) {
  console.log(`THIẾU (${missing.length}):`);
  for (const t of missing) console.log('  - ' + t);
} else {
  console.log('Không thiếu tool nào.');
}

console.log(`\nCố ý không port (${skipped.length}):`);
for (const t of skipped) console.log(`  - ${t}\n      ${INTENTIONAL[t]}`);

if (extra.length) {
  console.log(`\nChỉ có ở bản remote (${extra.length}):`);
  for (const t of extra) console.log('  + ' + t);
}

process.exit(missing.length ? 1 : 0);
