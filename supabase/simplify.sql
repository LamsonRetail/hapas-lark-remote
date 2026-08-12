-- ─────────────────────────────────────────────────────────────────────────
-- Đơn giản hoá tầng audit: BỎ rollup, thay bằng một job xoá `args`
--
-- Chạy một lần trong Supabase Studio → SQL Editor. Idempotent, chạy lại vô hại.
--
-- VÌ SAO: ở quy mô luồng remote (~230 dòng/ngày), rollup là tối ưu hoá non —
-- audit_daily/audit_daily_errors/v_daily_tools được dựng nhưng dashboard đọc
-- thẳng raw nên gần như không ai chạm tới. Postgres thừa sức chứa raw nhiều năm.
--
-- Lợi ích THẬT duy nhất của rollup là tách `args` (nội dung người dùng, cắt
-- 2000 ký tự nhưng KHÔNG lọc) khỏi phần siêu dữ liệu đáng giữ lâu. Đạt được
-- điều đó bằng MỘT job xoá `args` sau 30 ngày — giữ lại dòng (tool, người, ok,
-- thời lượng, mã lỗi) để trends/lỗi sống lâu, chỉ bỏ phần nhạy cảm.
--
-- ĐIỀU KIỆN THỨ TỰ: chạy file này SAU khi đã deploy dashboard mới (compute.mjs
-- không còn đọc v_daily_auth). Nếu chạy trước, dashboard cũ sẽ 500 vì view mất.
-- ─────────────────────────────────────────────────────────────────────────

-- ── 1) Gỡ tầng rollup ────────────────────────────────────────────────────
-- Thứ tự: view trước (phụ thuộc bảng), rồi bảng. v_session_health GIỮ LẠI —
-- nó đọc audit_logs raw, không dính rollup, và là nguồn duy nhất cho hạn
-- refresh token trên dashboard.
drop view  if exists public.v_daily_tools;
drop view  if exists public.v_daily_auth;
drop table if exists public.audit_daily;
drop table if exists public.audit_daily_errors;
drop function if exists public.audit_rollup(date, date);

-- ── 2) Gỡ cron rollup, thêm cron xoá args ────────────────────────────────
create extension if not exists pg_cron;

do $$ begin perform cron.unschedule('audit-rollup');     exception when others then null; end $$;
do $$ begin perform cron.unschedule('audit-scrub-args'); exception when others then null; end $$;

-- 17:15 UTC = 00:15 giờ VN. Xoá args cũ hơn 30 ngày ở CẢ hai nguồn. Điều kiện
-- `args is not null` để job không quét lại dòng đã sạch mỗi đêm.
select cron.schedule(
  'audit-scrub-args',
  '15 17 * * *',
  $job$ update public.audit_logs set args = null
         where args is not null and created_at < now() - interval '30 days' $job$
);

-- ── 3) Dọn một lần phần args cũ đang có ───────────────────────────────────
update public.audit_logs set args = null
 where args is not null and created_at < now() - interval '30 days';

-- ─────────────────────────────────────────────────────────────────────────
-- TUỲ CHỌN — giữ dữ liệu cũ lâu hơn (liên quan than phiền "không có dữ liệu cũ")
--
-- schema.sql của client zip cài sẵn một job XOÁ nguyên dòng sau 90 ngày. Sau
-- khi đã có job xoá args ở trên, dòng cũ không còn nội dung nhạy cảm nên có thể
-- giữ lâu hơn nhiều mà vẫn an toàn. Xem job đang chạy:
--
--   select jobname, schedule, command from cron.job order by jobname;
--
-- Rồi thay job xoá đó bằng bản giữ url 365 ngày, zip 90 ngày (đổi <tên_job>):
--
--   do $$ begin perform cron.unschedule('<tên_job>'); exception when others then null; end $$;
--   select cron.schedule('audit-purge', '30 17 * * *',
--     $job$ delete from public.audit_logs
--            where (source = 'zip' and created_at < now() - interval '90 days')
--               or (source = 'url' and created_at < now() - interval '365 days') $job$);
-- ─────────────────────────────────────────────────────────────────────────
