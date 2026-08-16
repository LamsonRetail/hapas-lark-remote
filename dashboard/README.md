# Dashboard

MỘT trang duy nhất, đọc từ trên xuống:

```
tiêu đề + phán quyết + "cập nhật lúc …"
BỘ LỌC TOÀN CỤC (dính lên đỉnh)   khoảng ngày · người · ứng dụng
dải canh gác                       ← KHÔNG theo bộ lọc, xem bên dưới
KPI ×5
biểu đồ                            nhóm theo × đo bằng × kiểu vẽ
bảng người · bảng số liệu nhóm
```

Chỉ ĐỌC. Thu hồi truy cập dùng `npm run revoke` chạy tại chỗ.

```
base.css              giao diện; build nhúng thẳng vào trang
impact.mjs            luật "lượt nào thật sự chặn người dùng" — xem bên dưới
range.mjs             khoảng thời gian + ngày theo giờ VN — xem bên dưới
compute.mjs           phép tính của tầng canh gác / KPI / bảng người
explore-schema.mjs    danh mục cột/phép đo — danh sách trắng, dùng chung API và trang
explore-compute.mjs   phép gộp của biểu đồ
sb.mjs                kết nối Supabase dùng chung cho api/
template.html         toàn bộ giao diện
build.mjs             dựng preview.html + index.html + tools.json
dev.mjs               chạy tại chỗ BẢN ĐẦY ĐỦ — gọi thẳng api/, bộ lọc chạy thật
api/data.js           số liệu tầng trên
api/explore.js        gộp số theo cột được chọn
```

`/*__DATA__*/null`, `/*__SCHEMA__*/null`, `/*__EXPLORE__*/null` và `/*__CSS__*/`
là các chỗ cắm mà `build.mjs` thay vào. Bản tĩnh và bản Vercel gọi CHUNG
`computeDashboard` / `aggregate` nên không bao giờ lệch số.

## Bộ lọc là TOÀN CỤC

Khoảng ngày, người, ứng dụng đi vào **cả hai** endpoint, nên mọi con số trên
trang đều nói về đúng một lát cắt. Trạng thái nằm trên URL (`?preset=7d`,
`?from=…&to=…&user=…&app=…&dim=…`) nên gửi được cho người khác bằng cách dán link.

Trước đây không phải vậy: `WINDOWS = [7, 30, 90]` chỉ điều khiển khu biểu đồ ở
cuối trang, còn `windowDays = 30` chốt cứng trong `compute.mjs` nuôi toàn bộ KPI
phía trên. Một ô chọn "Khoảng" nằm trên trang mà chỉ lọc một phần ba trang, và
không có gì nói ra điều đó — người đọc mặc định hiểu nó lọc tất cả.

Ba chỗ cố ý KHÔNG nghe theo bộ lọc, mỗi chỗ một lý do:

| Chỗ | Vì sao |
|---|---|
| Dải canh gác | "Canary cách đây 2 giờ" luôn tính từ BÂY GIỜ. Cho bộ lọc đụng vào thì chọn xem lại tuần trước sẽ ra "nhịp tim cách đây 9 ngày" và báo đỏ — cảnh báo giả do chính người xem vừa tạo ra. `ingest` vì thế hỏi bằng truy vấn riêng, không lấy dòng cuối của tập đã lọc |
| Luật "được cứu" | `impactedSet` chạy trên tập CHƯA lọc. Lọc theo ứng dụng có thể cắt mất đúng lượt thành công đã cứu một lỗi, biến nó thành lỗi thật chỉ vì người xem bấm một cái nút |
| Danh sách người / ứng dụng trong ô chọn | Dựng trước khi lọc. Dựng sau thì chọn một người xong là ô chỉ còn đúng người đó, không đổi sang ai được nữa |

Trần khoảng là **180 ngày** (`MAX_RANGE_DAYS`), chặn ở phía máy chủ chứ không
tin trang gửi lên. Cả hai endpoint đọc hàng thô theo trang 1000 dòng nối đuôi
nhau, nên khoảng càng dài thì chuỗi round-trip càng dài — và nó sẽ hết giờ vào
lúc bảng audit đã lớn, tức là lúc không ai còn nhớ trần này nằm ở đâu. Khoảng
sai/quá dài không làm gãy trang: `resolveRange` kẹp biên rồi trả kèm lời giải
thích để trang hiện ra.

## Ngày cắt theo giờ Việt Nam

`created_at` là UTC. Bản cũ cắt ngày bằng `slice(0, 10)`, tức cắt theo ngày UTC,
mà ranh giới ngày UTC rơi vào **7 giờ sáng** giờ VN: mọi lượt gọi từ 0h đến 7h
sáng bị tính sang ngày hôm trước. Không ai để ý vì cột nào cũng có số — chỉ là
số nằm nhầm cột, và nhầm nhiều nhất đúng vào lúc người ta bắt đầu ngày làm việc.

`range.mjs` chốt cứng `+07:00` cho cả máy chủ lẫn trang. Lấy múi giờ trình duyệt
thì hai người ngồi hai nơi mở cùng một link sẽ thấy hai con số khác nhau.

## Bảng này KHÔNG đếm lỗi thô

Quy tắc quan trọng nhất, viết ở `impact.mjs`.

Phần lớn dòng `ok = false` trong `audit_logs` là Lark **đã trả lời đàng hoàng**,
chỉ là trả "không": thiếu quyền, sai tham số, quá hạn mức. Model đọc câu trả lời
đó rồi gọi lại cho đúng hoặc đi đường khác, và người dùng không thấy gì cả.

Chỉ đếm lượt **chặn người dùng** — lúc Lark không trả lời được (endpoint ra
HTML/404, mạng đứt) và model buộc phải nói "không dùng được tool này". Rồi trừ
tiếp ba lớp nữa:

| Trừ ra | Vì sao |
|---|---|
| Được cứu trong 5 phút | Cùng người có lượt thành công ngay sau đó — model đã tự đi đường khác |
| `lark_api_call` | Cửa thoát hiểm, model tự đưa `path`. 404 là gõ sai đường dẫn, không phải hệ thống hỏng |
| Tham số trỏ ra ngoài Lark | Đã gặp một lượt `sheets_table_get` nhận link **Google Sheets**. Chỉ trừ khi host KHÔNG thuộc Lark — link `.larksuite.com` hỏng thì vẫn tính, đó mới là thứ ta có trách nhiệm mở được |

Chênh lệch không nhỏ: có lúc **51 lỗi thô nhưng chỉ 15 lượt thật sự chặn người
dùng** — 11,1% so với 2,9%. Đếm kiểu thô thì bảng lúc nào cũng đỏ trong khi tool
chạy mượt, mà một cảnh báo luôn bật là một cảnh báo không ai đọc.

Vì thế trang **không** có phép đo "tổng lỗi", **không** có bảng mã lỗi, và
**không** có danh sách "tool đang hỏng" (đã thử: mục đầu tiên là `lark_api_call`
— tool gọi endpoint tuỳ ý, người dùng đưa sai đường dẫn là ra 404). Việc canh
tool hỏng thuộc về `src/canary.js`, nơi probe cố định nên 404 là tín hiệu thật.

Màu theo đúng luật đó: xanh lá dùng được hết, hổ phách dưới 20% không dùng được,
đỏ từ 20%. Chú giải chỉ hiện khi biểu đồ thật sự có phần đỏ.

## Chỉ theo dõi MCP remote

Mọi truy vấn chốt `source = 'url'`. Bản zip là client khác, ghi chung bảng
`audit_logs` nhưng không phải thứ trang này canh — để lẫn vào thì mọi con số
phải kèm một câu hỏi "của bản nào?".

## Một dòng = một NGƯỜI

`machines` khoá theo `(open_id, client_app)`, không theo `client_id`.

`client_id` do client tự đăng ký qua DCR, và Claude đăng ký MỚI mỗi lần người
dùng ngắt rồi cắm lại connector — khoá theo nó thì mỗi lần cắm lại đẻ một dòng.
Đo thật: một người có 6 dòng cho đúng 2 chỗ cắm.

Đánh đổi: cùng người dùng Claude desktop và Claude web gộp làm một. Server chỉ
nhận HTTP request nên vốn dĩ chưa bao giờ phân biệt được hai cái đó.

Ứng dụng đã cắm hiện thành chip trong ô của người đó; cột "Token còn" là đếm
ngược tới hạn refresh token 7 ngày, lấy từ `machines.token_expires_at`.

Migration: `supabase/machines-dedup.sql` (thêm cột, bỏ bảng ẩn cũ), kèm khối
gộp dòng trùng do công cụ sinh ra với giá trị tính sẵn.

## Chạy tại chỗ

Hai cách, cho hai việc khác nhau. **Muốn thử bộ lọc thì phải dùng cách thứ hai.**

### Bản đầy đủ — kiểm HÀNH VI

```bash
npm run dashboard
```

Build rồi mở máy chủ ở `http://localhost:4173`. Nó gọi thẳng hai hàm trong
`api/` — **đúng** hàm Vercel gọi, đúng tham số, đúng đường đọc Supabase. Bộ lọc
khoảng ngày / người / ứng dụng chạy thật; cái gì hỏng ở đây thì cũng hỏng y hệt
trên bản deploy. Cần `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` trong `.env`.

Chỉ chạy tại chỗ: nó đọc service role key và mở một cổng không khoá.

### Bản tĩnh — kiểm BỐ CỤC

```bash
npm run dashboard:build
```

Mở `dashboard/preview.html` — một file rời, số nướng sẵn, không cần backend,
không cần mạng.

Build nướng sẵn phép gộp cho **từng** cột nhóm, nên "Nhóm theo / Đo bằng / Kiểu
vẽ" đổi được thật ngay trong bản tĩnh. Nhưng số chỉ nướng cho ĐÚNG một khoảng,
nên bộ lọc toàn cục bị **khoá hẳn** (`lockGlobalFilters` trong template) kèm một
dòng nói rõ lý do.

Khoá chứ không phải để bấm rồi tự bật lại — bản đầu làm thế và kết quả đúng như
dự đoán được: người dùng chọn ngày, thấy nó nhảy về chỗ cũ, kết luận là tính
năng hỏng. Hoàn toàn hợp lý, vì **một cái nút bấm được là một lời hứa**. Nút
khoá nói thật ngay từ đầu; nút tự bật lại bắt người ta tự đoán ra lý do.

## Deploy Vercel

Root directory = `dashboard/`. Chạy build trước để có `tools.json` +
`index.html`, rồi commit chúng.

```bash
node dashboard/build.mjs
```

```bash
npx.cmd vercel --prod --yes --scope hapas-tech-team --cwd dashboard
```

| Biến môi trường | Để làm gì |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Nguồn số liệu. **Chỉ ở phía máy chủ** |
| `LARK_APP_ID` | Hiển thị ở chân trang |

`.vercelignore` chặn `preview.html` và `.env*` khỏi gói deploy. Đừng bỏ nó:
`.gitignore` chỉ chắn đường vào git, Vercel CLI không đọc file đó, nên thiếu
`.vercelignore` là bản nướng sẵn (tên thật + `open_id`) nằm ở `/preview`.

### Kiểm endpoint sau khi deploy

`vercel curl` chỉ chuyển được **tham số truy vấn ĐẦU TIÊN** — dán nguyên URL có
`&` vào là mọi tham số sau bị nuốt lặng lẽ, và endpoint trả về kết quả của mốc
mặc định. Nhìn y như tính năng hỏng, mà thật ra là công cụ đo hỏng. Ép curl tự
dựng query thì mới đúng:

```bash
npx.cmd vercel curl --scope hapas-tech-team "$URL/api/data" --get --data-urlencode "from=2026-08-13" --data-urlencode "to=2026-08-15"
```

## Trước khi mở cho người khác

Trang bày ra tên nhân viên, `open_id` và hạn refresh token. Không có tầng nào
khác che phần đọc — muốn kín thì bật Vercel Protection (Password hoặc SSO).

**Cái bẫy**: mức bảo vệ mặc định của Vercel chỉ chắn **URL của từng bản deploy**
(`…-9i3i7c6t9-….vercel.app` trả 302 về trang đăng nhập), còn **địa chỉ chính thì
mở toang**. Đo ngày 17/08: `https://lark-mcp-dashboard.vercel.app/api/data` trả
200 cho người lạ, kèm 16 dòng người và hạn token của 6 người.

Thử bằng URL bản deploy rồi thấy 302 mà kết luận "đã khoá rồi" là kết luận sai.
Muốn khoá thật thì đặt Vercel Authentication thành **All Deployments** (hoặc bật
Password Protection) trong Project Settings → Deployment Protection, rồi kiểm
lại bằng chính địa chỉ chính, ở cửa sổ ẩn danh.
