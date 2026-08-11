-- ─────────────────────────────────────────────────────────────────────────
-- Bảng `machines` đón thêm dòng của bản remote
--
-- Chạy một lần trong Supabase Studio → SQL Editor. Idempotent.
--
-- Hai việc:
--   1. Thêm cột `user_id` — dòng do bản remote sinh ra luôn biết chính xác
--      người dùng là ai (OAuth xong là có open_id, không đoán). Trước đây danh
--      tính chỉ nằm trong `username` (tên hiển thị, trùng được và đổi được),
--      không có cột nào join sang `audit_logs.open_id`.
--   2. Cho `channel` nhận 'mcp remote' — nhãn nguồn của dòng, song song với
--      `audit_logs.source='url'`. Constraint cũ chỉ nhận 'stable'|'beta'|NULL
--      (kênh cập nhật của client zip), nên insert bị chặn 23514.
--
-- Dòng của client zip giữ nguyên: `user_id` NULL (client cài trên máy cá nhân
-- đăng nhập bằng keychain, không qua OAuth server nên không gửi open_id lên),
-- `channel` vẫn NULL hoặc 'stable'/'beta'.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.machines
  add column if not exists user_id text;

comment on column public.machines.user_id is
  'Lark open_id của người dùng. Có với dòng bản remote (channel = ''mcp remote''), NULL với client zip.';

-- Truy vấn sẽ dùng nhiều nhất: "người này đã cắm những chỗ nào".
create index if not exists machines_user_id_idx on public.machines (user_id) where user_id is not null;

-- ── client_app: người dùng nối vào bằng CÁI GÌ ───────────────────────────
-- Claude | Codex | Claude Code (lark-remote) | … — lấy từ `client_name` mà
-- client tự khai lúc đăng ký DCR. Trước đây chỉ có `client_id` (chuỗi random),
-- nhìn bảng không biết được ai đang dùng công cụ nào.
--
-- ĐÂY LÀ LỜI TỰ KHAI, không phải danh tính đã xác thực: bất kỳ ai cũng đăng ký
-- được với `client_name` bất kỳ. Dùng để thống kê, đừng dùng để phân quyền.
--
-- NULL với dòng của client zip (không qua DCR) và với dòng bản remote đã tạo
-- trước khi có cột này.
alter table public.machines
  add column if not exists client_app text;

comment on column public.machines.client_app is
  'Ứng dụng client tự khai qua DCR (Claude, Codex, …). Lời tự khai, không phải danh tính đã xác thực. NULL với client zip.';

-- "Công ty đang dùng những client nào, mỗi cái bao nhiêu người":
--   select client_app, count(*) from machines
--    where channel = 'mcp remote' and status = 'active' group by 1 order by 2 desc;
create index if not exists machines_client_app_idx on public.machines (client_app) where client_app is not null;

-- ── Nới `channel` ────────────────────────────────────────────────────────
-- NULL vẫn hợp lệ: `channel in (…)` cho NULL ra UNKNOWN, mà CHECK chỉ chặn
-- khi kết quả là FALSE.
alter table public.machines
  drop constraint if exists machines_channel_check;

alter table public.machines
  add constraint machines_channel_check
  check (channel in ('stable', 'beta', 'mcp remote'));

comment on column public.machines.channel is
  'stable | beta = kênh cập nhật của client zip. ''mcp remote'' = dòng do server remote ghi (machine_id có tiền tố url-).';

-- Đếm người dùng bản remote: select count(*) from machines where channel = 'mcp remote';
create index if not exists machines_channel_idx on public.machines (channel) where channel is not null;
