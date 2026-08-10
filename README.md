# Lark MCP v3 — Remote, multi-user

Server MCP từ xa cho Lark. Claude chỉ biết **một URL**; mỗi nhân viên tự đăng nhập
Lark của mình và mọi tool chạy đúng dưới danh tính người gọi.

Khác bản v2 (desktop): **không dùng `lark-cli`**, gọi thẳng REST. Không keychain,
không profile, không spawn process — nên một tiến trình phục vụ được cả công ty.

> **Kiến trúc, sơ đồ luồng, những chỗ dễ sai:** mở [docs/technical.html](docs/technical.html)
> bằng trình duyệt. File này chỉ là hướng dẫn vận hành.

## Chạy

```bash
npm install
cp .env.example .env      # điền LARK_APP_ID / LARK_APP_SECRET
npm start                 # supervisor: dựng tunnel → bật server → tự bật lại khi chết
```

Kiểm tra: `curl localhost:8787/health`

| Lệnh | Việc |
|---|---|
| `npm start` | supervisor (dùng cái này để chạy thật) |
| `npm run server` | chỉ server, không tunnel — để debug |
| `npm test` | đi đúng luồng Claude: register → authorize → token → gọi tool thật |
| `npm run test:race` | ép token hết hạn + nhiều call ập vào cùng lúc |
| `npm run parity` | đối chiếu bộ tool với bản zip |

## Đưa ra ngoài internet

`node supervisor.js` lo tunnel + tự bật lại khi chết. Chọn nhà cung cấp bằng
`TUNNEL` trong `.env`.

**`TUNNEL=tailscale`** (đang dùng) — Tailscale Funnel. URL cố định vĩnh viễn,
miễn phí, không cần domain. Chuẩn bị một lần:

```bash
tailscale up                     # đăng nhập bằng trình duyệt
tailscale funnel --bg 8787       # in link để bật Funnel nếu tailnet chưa cho
```

Funnel nằm trong dịch vụ `tailscaled`, không phải tiến trình con của supervisor
— nên nó tự sống qua reboot và supervisor chỉ việc đọc hostname.

**`TUNNEL=cloudflare`** — cần `TUNNEL_NAME` và một domain trên Cloudflare mới có
URL cố định. Bỏ trống `TUNNEL_NAME` thì mỗi lần chạy lại là một URL mới và **mọi
người phải cắm lại connector** — chỉ hợp để thử.

Cả hai đều chạy agent trên chính máy này: máy ngủ hoặc chưa ai đăng nhập Windows
thì cả công ty mất kết nối. URL cố định chỉ bảo đảm bật lại là chạy tiếp, không
ai phải làm gì.

## Cắm vào Claude

Settings → Connectors → Add custom connector → URL `https://<domain>/mcp`,
bật **Individual sign-in**. Không cần điền Client ID/Secret — server hỗ trợ
Dynamic Client Registration, Claude tự đăng ký.

## Người dùng đăng nhập thế nào

1. Claude gọi `/mcp`, chưa có token → 401 kèm `WWW-Authenticate`
2. Claude đọc metadata, mở `/authorize` trong trình duyệt
3. Server mở **device flow** với Lark, hiện link + mã cho user
4. User bấm Đồng ý trên Lark → server nhận token của user đó
5. Server phát authorization code → Claude đổi lấy bearer
6. Từ đây mọi tool call chạy dưới `open_id` của người đó

Không cần redirect URI, **không cần quyền vào Lark Developer Console** —
device flow chỉ cần `app_id` + `app_secret`.

## Những chỗ dễ sai (đã trả giá khi dựng)

**Device flow nằm trên hai host.** Xin mã ở `accounts.larksuite.com`, đổi token ở
`open.larksuite.com`. Gọi nhầm trả HTML 404 chứ không phải JSON → `JSON.parse`
chết âm thầm.

**`offline_access` là bắt buộc.** Thiếu nó vẫn có access_token nhưng không có
refresh_token, 2 tiếng sau user phải đăng nhập lại.

**Refresh token dùng được đúng một lần.** Lark xoay token mỗi lần refresh và giết
ngay cái cũ; dùng lại → thu hồi cả chuỗi, user bị đăng xuất. Vì thế
`getValidAccessToken()` khoá theo từng user **và đọc lại trạng thái sau khi giành
được khoá**. Bỏ bước đọc lại thì call thứ hai đang xếp hàng vẫn refresh bằng token
đã chết.

**Secret phải nằm trong body.** Basic auth bị từ chối (`20140 invalid_client`).

**Lark nhét chỉ thị cho AI vào payload API.** Trường `hint` của lark-cli chứa
"You MUST…". Trên server dùng chung, response đi thẳng vào context Claude của mọi
người → `stripInstructions()` trong `lark.js` cắt các trường đó. Đây là phòng thủ
tối thiểu, không phải đầy đủ: nội dung tài liệu/tin nhắn vẫn là dữ liệu không tin
được.

**Mạng ra Lark chập chờn.** Đã gặp 5/6 request timeout. Mọi call đi qua
`fetchRetry` (3 lần, backoff). Poll device flow chịu được 8 lỗi mạng liên tiếp
trước khi bỏ phiên — một cú nghẽn mạng không được phép giết login của user.

## Audit

Ghi sang Supabase, chung bảng `audit_logs` với client zip, phân biệt bằng cột
`source` (`'zip'` / `'url'`). Chạy `supabase/audit-source.sql` một lần trong SQL
Editor để có đủ cột.

Chưa chạy migration thì audit **không chết**: PostgREST báo thiếu cột nào,
`flush()` bỏ đúng cột đó rồi gửi lại. Mất một trường, không mất cả lô — trước
khi có cơ chế này thì thiếu mỗi `error_msg` đã đủ làm rơi 100% log của bản
remote mà nhìn bên ngoài vẫn tưởng đang ghi bình thường.

## Canary — biết Lark đổi API trước khi người dùng đâm vào

`CANARY_EVERY_MIN` phút một lần, server tự gọi 9 tool chỉ-đọc dưới danh nghĩa
`CANARY_OPEN_ID`, ghi vào audit như mọi call khác (`user_name='canary'`). Tool
nào hỏng **2 lần liên tiếp** thì DM cảnh báo tới `CANARY_ALERT_OPEN_ID` qua bot;
chạy lại được thì báo tiếp một tin.

Vì sao cần khi đã có audit của traffic thật: audit chỉ nói được về tool **đang có
người gọi**. Tool ít dùng mới là chỗ hỏng âm thầm hàng tháng.

Báo đúng một lần cho mỗi lần hỏng, không lặp mỗi giờ — cảnh báo lặp là thứ khiến
người ta tắt thông báo rồi bỏ lỡ lần sau.

Đây **không phải** tự chữa. Lark đổi endpoint thì vẫn phải sửa tay; canary chỉ
rút thời gian phát hiện từ "chờ ai đó kêu" xuống một giờ. Cột `lark_code` tách
riêng mã lỗi Lark để lọc: `99991663` (user thiếu quyền) là chuyện thường ngày,
`404`/tham số sai mới là dấu hiệu API đổi.

Probe chỉ được phép là tool ĐỌC. Nó chạy mỗi giờ, mãi mãi — thêm tool có tác dụng
phụ vào đây là tự tạo rác tích tụ.

## Còn thiếu

- Server vẫn chạy trên một máy Windows. Muốn hết phụ thuộc máy đó thì phải
  đóng gói Docker + deploy (Fly.io/VPS) — khi ấy nhớ pin đúng **một** instance,
  vì khoá chống refresh-token-dùng-hai-lần là mutex trong tiến trình.
- Đổi token store từ file sang Supabase khi chạy nhiều instance
- Diff **endpoint** với bản zip, không chỉ diff tên tool. Spec bóc từ
  `lark-cli --dry-run`; zip cập nhật endpoint theo Lark mà remote thì không,
  hiện chưa có gì phát hiện ra.
- `/authorize` luôn mở device flow mới, kể cả khi user đã đăng nhập trước đó —
  server không có cách nào biết người đang mở trình duyệt là ai. Đặt cookie sau
  lần đăng nhập đầu sẽ bỏ được bước duyệt lại trên Lark.
  (khoá per-user hiện là mutex trong tiến trình, nhiều instance cần khoá ở DB)
- Tool phụ thuộc máy user: `local_media_transcribe`, tải file về đĩa —
  remote không làm được, giữ ở bản desktop
