-- Danh sách chỗ cắm bị ẩn khỏi bảng vận hành.
--
-- VÌ SAO CẦN BẢNG RIÊNG, KHÔNG XOÁ THẲNG:
-- Mục "chỗ cắm" trên dashboard KHÔNG phải là một bảng có sẵn — nó ghép
-- `audit_logs` (ai đã gọi gì) với `machines` (ai đã đăng nhập bằng cái gì).
-- Dòng trạng thái 'không rõ' là các lượt gọi cũ từ trước khi có `machines`:
-- chúng không có dòng `machines` nào để mà xoá. Muốn xoá thật thì phải xoá
-- `audit_logs` — tức là đốt luôn lịch sử audit để cho gọn một cái bảng.
--
-- Nên thay vì xoá, ghi machine_id vào đây và dashboard lọc ra. Hoàn tác được,
-- không mất dữ liệu gốc, và ai cũng thấy cùng một bảng (khác với ẩn bằng
-- localStorage — mỗi máy một kiểu).
--
-- Chạy MỘT LẦN trong Supabase SQL Editor. Chưa chạy thì dashboard vẫn hoạt
-- động bình thường, chỉ là nút ẩn báo lỗi — xem `readHidden()` trong
-- dashboard/compute.mjs.

create table if not exists dashboard_hidden (
  machine_id  text primary key,
  -- Chỉ để người đọc bảng này biết mình đang nhìn ai, không dùng để nối bảng.
  -- machine_id là chuỗi băm, mở bảng lên nhìn không đoán nổi đó là chỗ cắm nào.
  label       text,
  hidden_at   timestamptz not null default now()
);

-- RLS bật, KHÔNG kèm policy nào: service_role bỏ qua RLS nên hàm serverless
-- vẫn đọc/ghi được, còn anon key thì không chạm tới được gì. Cùng thế trận với
-- các bảng khác trong dự án.
alter table dashboard_hidden enable row level security;
