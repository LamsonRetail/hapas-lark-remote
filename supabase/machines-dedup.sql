-- Gộp dòng `machines` trùng, và thêm cột hạn refresh token.
--
-- VÌ SAO TRÙNG: `machine_id` từng băm theo (open_id, client_id). Nhưng
-- `client_id` do client tự đăng ký qua DCR, và Claude đăng ký MỚI mỗi lần
-- người dùng ngắt rồi cắm lại connector — nên mỗi lần cắm lại là một dòng mới.
-- Đo trên dữ liệu thật: một người có 6 dòng cho đúng 2 chỗ cắm.
--
-- Khoá mới là (open_id, client_app): cắm lại bao nhiêu lần cũng vẫn dòng đó.
-- Đánh đổi: cùng người dùng Claude desktop và Claude web gộp làm một — server
-- chỉ nhận HTTP request nên vốn dĩ chưa bao giờ phân biệt được hai cái đó.
--
-- Phần `update`/`delete` cụ thể do dashboard sinh ra kèm giá trị đã tính sẵn
-- (installed_at sớm nhất, last_seen mới nhất của từng nhóm) — chạy khối SQL mà
-- công cụ in ra, KHÔNG chạy tay theo trí nhớ.

-- ── Cột hạn refresh token ────────────────────────────────────────────────
-- Hạn 7 ngày nằm trong tokens.json mã hoá trên máy chủ; Supabase không có
-- đường nào khác chạm tới. Trước đây chỉ có bản TỔNG trong dòng nhịp tim
-- keepalive, nên bảng nói được "17 phiên còn sống" nhưng không nói được ai
-- sắp hết hạn — mà đó mới là thứ cần hành động.
--
-- Chưa chạy câu này thì server tự bỏ cột đó ra rồi gửi lại (xem DEGRADABLE
-- trong src/machines.js): mất một trường, không mất cả dòng.
alter table machines add column if not exists token_expires_at timestamptz;

-- ── Bỏ bảng ẩn thủ công ──────────────────────────────────────────────────
-- Bảng này sinh ra chỉ để giấu các dòng trùng. Hết trùng thì hết lý do tồn
-- tại — giữ lại một nút "ẩn" cho một bảng không còn rác là mời người ta giấu
-- đi đúng thứ cần nhìn.
drop table if exists dashboard_hidden;
