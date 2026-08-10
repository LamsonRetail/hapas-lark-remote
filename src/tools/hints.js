/**
 * Phân loại tool để client biết cái nào cần hỏi, cái nào không.
 *
 * MCP có `annotations.readOnlyHint` / `destructiveHint`. Không khai báo thì
 * client phải coi MỌI tool là có thể sửa dữ liệu, nên nó hỏi lại liên tục —
 * kể cả những tool chỉ đọc. Đó chính là cái làm người dùng bấm "Always allow"
 * cho từng tool một trong 60 lần.
 *
 * KHÔNG suy ra từ HTTP method được: Lark dùng POST cho rất nhiều API tìm kiếm
 * (`contact_search_user`, `drive_search`, `minutes_search`, `vc_search`…).
 * Suy theo method sẽ gắn nhãn "ghi" cho một loạt tool chỉ đọc.
 */

/** Chỉ đọc — không đổi gì ở phía Lark. */
export const READ_ONLY = new Set([
  'lark_whoami',
  'lark_auth_status',
  'im_chat_list',
  'im_chat_members_list',
  'im_chat_search',
  'contact_search_user',
  'calendar_agenda',
  'wiki_space_list',
  'wiki_node_list',
  'whiteboard_query',
  'whiteboard_export_svg',
  'base_record_list',
  'base_data_query',
  'base_url_resolve',
  'base_workflow_list',
  'dashboard_block_list',
  'task_search',
  'approval_search',
  'mail_message',
  'mail_triage',
  'drive_search',
  'drive_download',
  'docx_document_raw_content',
  'docs_word_count',
  'docs_history_list',
  'docs_history_revert_status',
  'sheets_table_get',
  'sheets_workbook_export',
  'slides_xml_get',
  'minutes_search',
  'minutes_transcript',
  'minutes_media_link',
  'lark_meeting_note',
  'okr_cycle_list',
  'vc_search',
]);

/**
 * Không lấy lại được: gửi ra ngoài, ghi đè nội dung đã có, hoặc làm được mọi
 * thứ. Những tool này PHẢI hỏi mỗi lần — đừng đưa vào diện tự động duyệt.
 */
export const DESTRUCTIVE = new Set([
  'im_send_message', // tin đã gửi không thu hồi được
  'im_send_card',
  'mail_send',
  'vc_meeting_message_send',
  'dashboard_block_delete', // xoá
  'docs_history_revert', // ghi đè nội dung hiện tại
  'sheets_table_put', // ghi đè ô đã có
  'slides_replace_pages', // thay nguyên trang
  'whiteboard_update', // ghi đè bảng trắng
  'whiteboard_update_from_source',
  'base_workflow_enable', // bật/tắt automation đang chạy
  'lark_api_call', // cửa thoát hiểm: làm được mọi thứ
]);

/**
 * Tạo mới, không ghi đè lên cái gì. Vẫn là ghi nên không readOnly, nhưng sai
 * thì xoá đi được — không xếp cùng nhóm với gửi mail hay ghi đè tài liệu.
 */
export const ADDITIVE = new Set([
  'docs_create',
  'docx_block_append',
  'sheets_create',
  'slides_create',
  'dashboard_create',
  'dashboard_block_create',
  'dashboard_arrange',
  'base_record_create',
  'base_record_batch_create',
  'base_workflow_create',
  'task_create',
  'task_complete',
  'tasklist_create',
  'wiki_node_create',
]);

/**
 * Thêm tool mà quên phân loại thì nó rơi vào diện "ghi, có thể phá" — client sẽ
 * hỏi mãi mà không ai hiểu tại sao. Ném lỗi ngay lúc khởi động thay vì để người
 * dùng phát hiện.
 */
export function assertClassified(names) {
  const missing = names.filter((n) => !READ_ONLY.has(n) && !DESTRUCTIVE.has(n) && !ADDITIVE.has(n));
  if (missing.length) {
    throw new Error(`Tool chưa phân loại trong hints.js: ${missing.join(', ')}`);
  }
  const all = [...READ_ONLY, ...DESTRUCTIVE, ...ADDITIVE];
  const stale = all.filter((n) => !names.includes(n));
  if (stale.length) {
    throw new Error(`hints.js còn tool không còn tồn tại: ${stale.join(', ')}`);
  }
}

export const annotationsFor = (name) => ({
  readOnlyHint: READ_ONLY.has(name),
  destructiveHint: DESTRUCTIVE.has(name),
  // Mọi tool đều đi ra Lark — dữ liệu ngoài tầm kiểm soát của server.
  openWorldHint: true,
});
