-- ─────────────────────────────────────────────────────────────────────────
-- Một bảng audit duy nhất, phân biệt nguồn bằng cột `source`
--
-- Chạy một lần trong Supabase Studio → SQL Editor. Idempotent.
--
--   source = 'zip'  → client CLI cài từ file zip trên máy cá nhân
--   source = 'url'  → server MCP remote, người dùng cắm bằng URL
--
-- 42.104 dòng đang có đều đến từ client zip, nên DEFAULT 'zip' gán nhãn đúng
-- cho toàn bộ dữ liệu cũ mà không cần backfill.
--
-- Các cột mới chỉ có nghĩa với source='url' (server biết danh tính người gọi,
-- biết tool chạy bao lâu, thành công hay không). Với source='zip' chúng để NULL
-- cho tới khi client zip được cập nhật để gửi kèm.
-- ─────────────────────────────────────────────────────────────────────────

alter table public.audit_logs
  add column if not exists source      text    not null default 'zip',
  add column if not exists open_id     text,
  add column if not exists user_name   text,
  add column if not exists client_id   text,
  add column if not exists ok          boolean,
  add column if not exists error_msg   text,
  add column if not exists lark_code   text,
  add column if not exists duration_ms integer;

-- Chỉ nhận đúng hai giá trị — chặn sớm lỗi chính tả từ client.
do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'audit_logs_source_check'
  ) then
    alter table public.audit_logs
      add constraint audit_logs_source_check check (source in ('zip', 'url'));
  end if;
end $$;

-- Truy vấn thường xuyên nhất sau khi có cột này: "hoạt động của bản remote
-- trong 7 ngày qua". Thiếu index thì phải quét cả 42k+ dòng.
create index if not exists audit_logs_source_idx on public.audit_logs (source, created_at desc);
-- Lọc riêng lần lỗi để soi sự cố; index một phần nên rất nhẹ.
create index if not exists audit_logs_error_idx  on public.audit_logs (created_at desc) where ok = false;
-- Ai dùng gì, dành cho bản remote.
create index if not exists audit_logs_openid_idx on public.audit_logs (open_id, created_at desc) where open_id is not null;

-- Nếu đã lỡ tạo bảng tách trước đó thì dọn đi.
drop view  if exists public.audit_all;
drop table if exists public.audit_remote;

-- ── Vòng đời dữ liệu ─────────────────────────────────────────────────────
-- Đây mới là thứ chống tràn, không phải việc tách bảng: Postgres không có
-- giới hạn số dòng như Bitable. Job 90 ngày đã có sẵn từ schema.sql và vẫn
-- áp cho cả hai nguồn. Muốn giữ hai nguồn với hạn khác nhau thì thay bằng:
--
--   delete from public.audit_logs
--    where (source = 'zip' and created_at < now() - interval '90 days')
--       or (source = 'url' and created_at < now() - interval '30 days');
--
-- Kiểm tra dung lượng bất cứ lúc nào:
--   select source, count(*), pg_size_pretty(sum(pg_column_size(audit_logs.*)))
--     from public.audit_logs group by source;
