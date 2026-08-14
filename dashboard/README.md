# Dashboard

MỘT trang duy nhất: canh gác, KPI, xu hướng, bảng người, bảng canary, và khu
"Đào sâu" để chọn cột nhóm × phép đo × kiểu vẽ.

Trước đây tách làm hai (`/` và `/explore`) — chúng trả lời cùng một câu hỏi
trên cùng một tập dữ liệu, tách ra chỉ tổ phải nhớ trang nào có gì và phải mở
hai tab để đối chiếu số. Trạng thái khu Đào sâu nằm trên URL nên gửi được cho
người khác bằng cách dán link.

Chỉ ĐỌC. Thu hồi truy cập dùng `npm run revoke` chạy tại chỗ.

```
base.css              giao diện; build nhúng thẳng vào trang
impact.mjs            luật "lượt nào thật sự chặn người dùng" — xem bên dưới
compute.mjs           phép tính của bảng vận hành
explore-schema.mjs    danh mục cột/phép đo — danh sách trắng, dùng chung API và trang
explore-compute.mjs   phép gộp của khu Đào sâu
sb.mjs                kết nối Supabase dùng chung cho api/
template.html         toàn bộ giao diện
build.mjs             dựng preview.html + index.html + tools.json
api/data.js           số liệu bảng vận hành
api/explore.js        gộp số theo cột được chọn
```

`/*__DATA__*/null`, `/*__SCHEMA__*/null` và `/*__CSS__*/` là các chỗ cắm mà
`build.mjs` thay vào. Bản tĩnh và bản Vercel gọi CHUNG `computeDashboard` /
`aggregate` nên không bao giờ lệch số.

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

```bash
node dashboard/build.mjs
```

Mở `dashboard/preview.html` — số nướng sẵn, không cần backend. Ở bản tĩnh các ô
đổi truy vấn của khu Đào sâu bị khoá vì chúng cần máy chủ.

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

## Trước khi mở cho người khác

Trang bày ra tên nhân viên và `open_id`. Muốn kín thì bật Vercel Protection
(Password hoặc SSO) — không có tầng nào khác che phần đọc.
