-- ─────────────────────────────────────────────────────────────────────────
-- Rollup ngày cho audit_logs — lịch sử sống lâu hơn dữ liệu thô
--
-- Chạy một lần trong Supabase Studio → SQL Editor. Idempotent, chạy lại vô hại.
--
-- VÌ SAO CẦN: audit_logs bị job 90 ngày xoá (xem audit-source.sql). Mọi biểu đồ
-- xu hướng dài hơn 3 tháng sẽ TỰ RỖNG DẦN mà không báo gì — sang năm mở
-- dashboard ra sẽ thấy lịch sử bắt đầu từ tháng trước, và không có cách nào lấy
-- lại. Bảng này giữ phần tổng hợp mãi mãi.
--
-- VÌ SAO KHÔNG BỎ JOB 90 NGÀY THAY VÌ LÀM CÁI NÀY: thứ đắt trong bảng thô không
-- phải số dòng mà là cột `args` — tham số thật của tool, cắt ở 2000 ký tự chứ
-- không hề lọc: câu tìm kiếm, id tài liệu, nội dung người dùng nhập. Giữ nó mãi
-- mãi là giữ đúng thứ đáng lẽ phải hết hạn, để đổi lấy thứ (số liệu tổng hợp)
-- vốn không cần giữ ở dạng thô. Rollup tách được hai thứ đó ra.
--
-- THỨ TỰ AN TOÀN: job này gom lại 3 ngày gần nhất, job dọn chỉ xoá thứ cũ hơn
-- 90 ngày. Hai bên không bao giờ chạm nhau, nên chạy theo thứ tự nào cũng đúng.
-- ─────────────────────────────────────────────────────────────────────────

-- ── Bảng tổng hợp ────────────────────────────────────────────────────────
--
-- `open_id`/`client_id` để '' thay vì NULL: chúng nằm trong khoá chính, mà NULL
-- trong khoá chính thì mỗi dòng là một dòng riêng và upsert không bao giờ khớp.
-- Dòng của client zip vốn không có danh tính nên rơi hết vào ''.
create table if not exists public.audit_daily (
  day        date   not null,
  source     text   not null,
  open_id    text   not null default '',
  client_id  text   not null default '',
  tool_name  text   not null,
  user_name  text,
  calls      int    not null,
  errors     int    not null,
  -- `ok` là NULL với source='zip'. Đếm riêng, vì gộp vào thành công là nói dối:
  -- dashboard sẽ báo 100% thành công cho một nguồn vốn không hề báo cáo kết quả.
  unknown    int    not null default 0,
  sum_ms     bigint,
  max_ms     int,
  -- p95 CỦA ĐÚNG Ô NÀY. Percentile không cộng lại được — muốn p95 toàn hệ thống
  -- thì phải tính lại từ bảng thô, đừng lấy trung bình các p95. Dùng sum_ms/calls
  -- khi cần một con số gộp được.
  p95_ms     int,
  primary key (day, source, open_id, client_id, tool_name)
);

-- Phân loại lỗi giữ riêng: cardinality thấp (vài mã lỗi × vài tool) nhưng đây là
-- thứ trả lời "Lark có hay đổi API không" sau khi đã có 12 tháng dữ liệu.
create table if not exists public.audit_daily_errors (
  day        date not null,
  source     text not null,
  tool_name  text not null,
  lark_code  text not null default '',
  hits       int  not null,
  sample_msg text,
  primary key (day, source, tool_name, lark_code)
);

create index if not exists audit_daily_day_idx        on public.audit_daily (day desc);
create index if not exists audit_daily_tool_idx       on public.audit_daily (tool_name, day desc);
create index if not exists audit_daily_errors_day_idx on public.audit_daily_errors (day desc);

-- RLS bật, KHÔNG kèm policy nào: service_role bỏ qua RLS nên server và dashboard
-- (chạy phía máy chủ) vẫn đọc được, còn anon key thì không thấy gì. Bảng mới
-- trong schema `public` mặc định được PostgREST đưa ra ngoài — quên bước này là
-- vô tình công bố toàn bộ lịch sử sử dụng.
alter table public.audit_daily        enable row level security;
alter table public.audit_daily_errors enable row level security;

-- ── Hàm gom ──────────────────────────────────────────────────────────────
--
-- Ngày tính theo GIỜ VIỆT NAM, không phải UTC. pg_cron chạy theo UTC, và nếu để
-- ngày theo UTC thì "hôm nay" trên dashboard lệch 7 tiếng so với "hôm nay" của
-- người đọc — mọi con số vẫn đúng nhưng luôn trả lời sai câu hỏi được hỏi.
create or replace function public.audit_rollup(p_from date, p_to date default null)
returns int
language plpgsql
security definer
set search_path = public
as $fn$
declare
  tz   constant text := 'Asia/Ho_Chi_Minh';
  d_to date := coalesce(p_to, p_from);
  lo   timestamptz := (p_from::timestamp at time zone tz);
  hi   timestamptz := ((d_to + 1)::timestamp at time zone tz);
  n    int;
begin
  -- Lọc theo khoảng timestamptz chứ không theo biểu thức ngày: biểu thức làm
  -- index trên created_at thành vô dụng và bắt quét cả bảng mỗi đêm.
  insert into public.audit_daily as t
        (day, source, open_id, client_id, tool_name, user_name, calls, errors, unknown, sum_ms, max_ms, p95_ms)
  select (a.created_at at time zone tz)::date,
         a.source,
         coalesce(a.open_id, ''),
         coalesce(a.client_id, ''),
         a.tool_name,
         max(a.user_name),
         count(*),
         count(*) filter (where a.ok is false),
         count(*) filter (where a.ok is null),
         sum(a.duration_ms),
         max(a.duration_ms),
         percentile_disc(0.95) within group (order by a.duration_ms)
    from public.audit_logs a
   where a.created_at >= lo and a.created_at < hi
     and a.tool_name is not null
   group by 1, 2, 3, 4, 5
  on conflict (day, source, open_id, client_id, tool_name) do update
     set calls     = excluded.calls,
         errors    = excluded.errors,
         unknown   = excluded.unknown,
         sum_ms    = excluded.sum_ms,
         max_ms    = excluded.max_ms,
         p95_ms    = excluded.p95_ms,
         user_name = coalesce(excluded.user_name, t.user_name);
  get diagnostics n = row_count;

  insert into public.audit_daily_errors as e
        (day, source, tool_name, lark_code, hits, sample_msg)
  select (a.created_at at time zone tz)::date,
         a.source,
         a.tool_name,
         coalesce(a.lark_code, ''),
         count(*),
         min(a.error_msg)
    from public.audit_logs a
   where a.created_at >= lo and a.created_at < hi
     and a.ok is false
   group by 1, 2, 3, 4
  on conflict (day, source, tool_name, lark_code) do update
     set hits = excluded.hits, sample_msg = excluded.sample_msg;

  return n;
end;
$fn$;

-- ── Job hằng đêm ─────────────────────────────────────────────────────────
--
-- Nếu `create extension` báo lỗi quyền: bật pg_cron ở Dashboard → Database →
-- Extensions rồi chạy lại từ đây.
create extension if not exists pg_cron;

do $$ begin perform cron.unschedule('audit-rollup'); exception when others then null; end $$;

-- 17:25 UTC = 00:25 giờ VN, tức ngay sau nửa đêm địa phương.
--
-- Gom lại 3 ngày chứ không phải một: bỏ lỡ một đêm (server bảo trì, job kẹt) thì
-- đêm sau tự vá, không cần ai phát hiện ra và chạy tay. Gom lại là upsert nên
-- chạy thừa không sinh dòng trùng. Ngày hôm nay cũng được gom — dòng đó chưa
-- đủ và sẽ được ghi đè ở hai đêm tiếp theo.
select cron.schedule(
  'audit-rollup',
  '25 17 * * *',
  $job$ select public.audit_rollup(((now() at time zone 'Asia/Ho_Chi_Minh')::date - 3),
                                   ((now() at time zone 'Asia/Ho_Chi_Minh')::date)) $job$
);

-- ── Backfill ─────────────────────────────────────────────────────────────
-- Toàn bộ dữ liệu đang có (42k+ dòng của client zip vẫn còn nguyên giá trị lịch
-- sử). Chạy một lần, mất vài giây.
select public.audit_rollup('2000-01-01'::date, (now() at time zone 'Asia/Ho_Chi_Minh')::date);

-- ── View cho dashboard ───────────────────────────────────────────────────
--
-- Luật "luôn lọc source='url', luôn bỏ canary và local-admin" được ĐÓNG VÀO
-- view thay vì nhắc nhau nhớ. Quên lọc một lần là mọi con số sai, mà lại sai một
-- cách trông rất hợp lý nên không ai nhận ra.
--
-- left(tool_name,7) chứ không phải LIKE '__auth.%': trong LIKE thì `_` là ký tự
-- đại diện, nên mẫu đó còn khớp cả những tên tool không mong muốn.

create or replace view public.v_daily_tools as
  select day, open_id, client_id, user_name, tool_name,
         calls, errors, sum_ms, max_ms, p95_ms,
         round(sum_ms::numeric / nullif(calls, 0)) as avg_ms
    from public.audit_daily
   where source = 'url'
     and left(tool_name, 7) <> '__auth.'
     and client_id not in ('canary', 'local-admin');

create or replace view public.v_daily_auth as
  select day, substring(tool_name from 8) as event,
         open_id, client_id, user_name, calls, errors
    from public.audit_daily
   where source = 'url'
     and left(tool_name, 7) = '__auth.';

-- Tình trạng phiên Lark của từng người. Dữ liệu này KHÔNG có trong Supabase theo
-- đường nào khác: hạn refresh token nằm trong tokens.json mã hoá trên máy chủ.
-- keepalive.js đẩy ra đây mỗi ngày một dòng.
--
-- Chặn `right(args,1) = '}'`: audit cắt `args` ở 2000 ký tự, và một chuỗi JSON
-- bị cắt giữa chừng sẽ làm cả view ném lỗi chứ không phải trả về một dòng thiếu.
create or replace view public.v_session_health as
  select created_at, (args::jsonb) as state
    from public.audit_logs
   where source = 'url'
     and tool_name = '__auth.keepalive'
     and args is not null
     and right(args, 1) = '}'
   order by created_at desc;

-- ── Tuỳ chọn: giữ dòng lâu hơn nhưng bỏ `args` sớm ───────────────────────
--
-- Nếu muốn soi lỗi xa hơn 90 ngày mà không giữ dữ liệu người dùng, dùng ba tầng
-- thay vì một: đủ 30 ngày → 90 ngày chỉ còn siêu dữ liệu → sau đó chỉ còn rollup.
--
--   update public.audit_logs set args = null
--    where args is not null and created_at < now() - interval '30 days';
--
-- Đặt vào một job pg_cron riêng chạy trước job dọn 90 ngày.
