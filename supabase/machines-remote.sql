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
