-- Số ký tự chuỗi kết quả mà tool trả về cho model.
--
-- VÌ SAO CẦN: trả lời câu "tool nào đang ngốn cửa sổ ngữ cảnh" — câu không đọc
-- được từ `duration_ms` hay số lượt gọi. Một tool chạy 200ms mà trả về 80 nghìn
-- ký tự mỗi lần đắt hơn nhiều một tool chạy 3 giây trả về một dòng.
--
-- VÌ SAO LƯU KÝ TỰ CHỨ KHÔNG LƯU TOKEN: server không biết tokenizer của client,
-- và tỉ lệ ký tự/token khác nhau theo model. Lưu số ký tự là đo được chính xác;
-- quy đổi ra token là việc của tầng đọc, và ở đó phải nói rõ là ước lượng.
--
-- Cột này để NULL cho mọi dòng cũ — không backfill được, vì độ dài kết quả đã
-- không được ghi lại lúc đó. Dashboard phải chịu được `null`, xem MEASURES
-- trong dashboard/explore-schema.mjs.

alter table public.audit_logs
  add column if not exists result_chars integer;

-- Index cho câu hỏi hay dùng nhất: "tool nào trả về nhiều nhất trong khoảng
-- này". Partial index vì phần lớn dòng cũ là null, không cần nằm trong cây.
create index if not exists audit_logs_result_chars_idx
  on public.audit_logs (created_at desc, tool_name)
  where result_chars is not null;
