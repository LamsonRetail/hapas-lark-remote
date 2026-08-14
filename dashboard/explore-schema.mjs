/**
 * Danh mục cột được phép nhóm, và các phép đo dựng trên chúng.
 *
 * MỘT NGUỒN DUY NHẤT cho cả hai phía: api/explore.js đọc để biết cột nào hợp
 * lệ, build.mjs nướng thẳng vào trang để dựng ô chọn. Để hai bên tự khai thì
 * trang sẽ chào một lựa chọn mà máy chủ từ chối — kiểu lỗi chỉ lộ ra khi có
 * người bấm đúng vào nó.
 *
 * Đây cũng là DANH SÁCH TRẮNG, không phải gợi ý: `col` đi thẳng vào tham số
 * select của PostgREST, nhận cột tuỳ ý từ query string là mở đường cho người
 * ngoài đọc cột họ không nên đọc.
 */

/**
 * `col`    cột thật trong audit_logs (null = suy ra từ created_at ở phía máy chủ)
 * `time`   trục thời gian → vẽ biểu đồ đường, và không sắp lại theo độ lớn
 * `mono`   giá trị là mã/định danh → hiện bằng font đơn cách
 */
/**
 * ĐÃ BỎ ba cột, mỗi cột một lý do:
 *
 *   lark_code  — mã lỗi thô. Bảng này chỉ đếm lỗi CHẶN người dùng (impact.mjs);
 *                nhóm theo mã lỗi là mời người đọc quay lại đếm lỗi thô, đúng
 *                thứ đã cố tình bỏ.
 *   source     — chỉ theo dõi MCP remote, mọi truy vấn đã chốt source='url'.
 *                Một cột chỉ có đúng một giá trị không nhóm được gì.
 *   client_id  — chuỗi băm DCR, đổi mỗi lần cắm lại, người đọc không hiểu gì.
 *                Thay bằng `client_app` (Claude / Codex) — xem ghi chú ở đó.
 */
export const DIMENSIONS = [
  { key: 'day', label: 'Ngày', col: null, time: true },
  { key: 'hour', label: 'Giờ trong ngày', col: null, time: true },
  { key: 'user_name', label: 'Người gọi', col: 'user_name' },
  { key: 'tool_name', label: 'Tool', col: 'tool_name', mono: true },
  { key: 'client_app', label: 'Ứng dụng', col: null },
  { key: 'ok', label: 'Kết quả', col: 'ok' },
];

/**
 * `agg` nói cho trang biết cách gộp khi vẽ, `fmt` cách hiện số.
 * `zeroable` — phép đo mà giá trị 0 vẫn có nghĩa (0 lỗi là tin tốt), khác với
 * p95 = 0 vốn chỉ nghĩa là không có mẫu nào.
 */
export const MEASURES = [
  { key: 'calls', label: 'Lượt gọi', fmt: 'int' },
  // KHÔNG có phép đo "tổng lỗi". Lỗi thô gồm cả thiếu quyền, sai tham số, quá
  // hạn mức — Lark đã trả lời và model đi tiếp được, người dùng không thấy gì.
  // Bày ra thì ai cũng chọn nó vì nó to hơn, rồi đọc ra một hệ thống đang hỏng
  // trong khi nó chạy mượt. Xem impact.mjs.
  { key: 'blocked', label: 'Không dùng được', fmt: 'int', zeroable: true },
  { key: 'blockRate', label: 'Tỉ lệ không dùng được', fmt: 'pct', zeroable: true },
  { key: 'p50', label: 'Thời gian trung vị', fmt: 'ms' },
  { key: 'p95', label: 'Thời gian p95', fmt: 'ms' },
  { key: 'users', label: 'Số người khác nhau', fmt: 'int' },
  { key: 'tools', label: 'Số tool khác nhau', fmt: 'int' },
];

export const WINDOWS = [7, 30, 90];

export const DIM_BY_KEY = new Map(DIMENSIONS.map((d) => [d.key, d]));
export const MEASURE_BY_KEY = new Map(MEASURES.map((m) => [m.key, m]));
