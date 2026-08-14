-- Tên ứng dụng người dùng cắm bằng, ghi kèm mỗi dòng audit.
--
-- VÌ SAO KHÔNG DÙNG `client_id` CÓ SẴN: nó là chuỗi băm do client tự đăng ký
-- qua DCR, và Claude đăng ký MỚI mỗi lần người dùng ngắt rồi cắm lại connector.
-- Vừa vô nghĩa với người đọc ("-IzrHj-hEmdQ0IRG63qNWw" là ai?), vừa không gom
-- nhóm được — cùng một chỗ cắm rơi thành nhiều mã khác nhau.
--
-- Chưa chạy câu này thì server tự bỏ cột đó ra rồi gửi lại (xem missingCols
-- trong src/audit.js): mất một trường, không mất cả lô log. Và nó tự thử lại
-- sau 30 phút nên chạy xong KHÔNG cần khởi động lại server.
--
-- Dòng cũ hơn ngày chạy câu này sẽ để NULL; dashboard hiện chúng thành
-- "(trước 14/08)" chứ không gộp vào "(trống)" — gộp thì bị đọc thành "có cắm
-- mà không rõ app", trong khi sự thật là "hồi đó chưa ghi".

alter table audit_logs add column if not exists client_app text;

-- Nhóm theo ứng dụng là truy vấn thường xuyên của trang; không có index thì
-- mỗi lần đổi ô chọn là một lần quét toàn bảng.
create index if not exists audit_logs_client_app_idx
  on audit_logs (client_app)
  where client_app is not null;
