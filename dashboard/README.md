# Dashboard

Hai trang, cùng đọc `audit_logs` + `machines` trên Supabase:

- **Bảng vận hành** (`/`) — canh gác, KPI, người dùng, chỗ cắm.
- **Biểu đồ** (`/explore`) — chọn một cột để nhóm, một phép đo để vẽ, lọc theo
  một người gọi. Nhóm theo tool + lọc một người = "người này đã gọi tool nào".
  Trạng thái nằm trên URL nên gửi được cho người khác bằng cách dán link.

## Bảng này KHÔNG đếm lỗi thô

Đây là quy tắc quan trọng nhất của cả hai trang, viết ở `impact.mjs`.

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

Chênh lệch không nhỏ: 30 ngày gần nhất có **51 lỗi thô nhưng chỉ 15 lượt thật sự
chặn người dùng** — 11,1% so với 2,9%. Đếm kiểu thô thì bảng lúc nào cũng đỏ
trong khi tool chạy mượt, mà một cảnh báo luôn bật là một cảnh báo không ai đọc.

Vì thế trang **không** có phép đo "tổng lỗi", **không** có bảng mã lỗi, và
**không** có danh sách "tool đang hỏng" (đã thử: mục đầu tiên là `lark_api_call`
— tool gọi endpoint tuỳ ý, người dùng đưa sai đường dẫn là ra 404). Việc canh
tool hỏng thuộc về `src/canary.js`, nơi probe cố định nên 404 là tín hiệu thật.

Màu theo đúng luật đó: xanh lá dùng được hết, hổ phách dưới 20% không dùng được,
đỏ từ 20%. Chú giải chỉ hiện khi biểu đồ thật sự có phần đỏ.

Gần như chỉ ĐỌC. Thao tác ghi duy nhất là ẩn một dòng khỏi mục "chỗ cắm"
(xem bên dưới). Thu hồi truy cập vẫn dùng `npm run revoke` chạy tại chỗ.

```
base.css              giao diện dùng chung, build nhúng vào từng trang
compute.mjs           phép tính của bảng vận hành
explore-schema.mjs    danh mục cột/phép đo — danh sách trắng, dùng chung API và trang
explore-compute.mjs   phép gộp của trang biểu đồ
sb.mjs                kết nối Supabase + cổng token cho api/, dùng chung
template.html         giao diện bảng vận hành
explore-template.html giao diện trang biểu đồ
build.mjs             dựng cả bốn trang + tools.json
api/data.js           số liệu bảng vận hành
api/explore.js        gộp số theo cột được chọn
api/hidden.js         ẩn / hiện lại một chỗ cắm  (CẦN TOKEN)
```

`/*__DATA__*/null` và `/*__CSS__*/` là các chỗ cắm mà `build.mjs` thay vào.
Bản tĩnh và bản Vercel gọi CHUNG `computeDashboard` / `aggregate` nên không bao
giờ lệch số.

## Chạy tại chỗ

```bash
node dashboard/build.mjs
```

Mở `dashboard/preview.html` hoặc `dashboard/explore-preview.html` — số nướng
sẵn, không cần backend. Ở bản tĩnh các ô đổi truy vấn bị khoá và nút ẩn không
hiện, vì cả hai đều cần máy chủ.

## Deploy Vercel

Root directory = `dashboard/`. Chạy `node dashboard/build.mjs` trước để có
`tools.json` + bốn file HTML, rồi commit chúng.

```bash
node dashboard/build.mjs && npx vercel --prod --cwd dashboard
```

Biến môi trường:

| Biến | Để làm gì |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Nguồn số liệu. **Chỉ ở phía máy chủ** |
| `LARK_APP_ID` | Hiển thị ở chân trang |
| `DASHBOARD_ADMIN_TOKEN` | Cổng cho `api/hidden.js`. **Chưa đặt thì thao tác ẩn TỪ CHỐI**, không phải cho qua |

## Ẩn một chỗ cắm

Mục "chỗ cắm" KHÔNG phải một bảng có sẵn — nó ghép `audit_logs` với `machines`.
Dòng trạng thái `không rõ` là lượt gọi cũ hơn ngày server bắt đầu ghi `machines`:
**không có bản ghi nào để mà xoá**. Xoá thật thì phải xoá `audit_logs`, tức là
đốt lịch sử audit để cho gọn một cái bảng.

Nên nút "Ẩn" chỉ ghi `machine_id` vào bảng `dashboard_hidden` và trang lọc ra.
Hoàn tác được bằng "Hiện lại", và mọi người xem đều thấy cùng một bảng.

Chạy một lần trước khi dùng:

```
supabase/dashboard-hidden.sql   → Supabase SQL Editor
```

Chưa chạy thì bảng vận hành vẫn chạy bình thường, chỉ nút Ẩn báo thiếu bảng.

Lần đầu bấm Ẩn, trang hỏi `DASHBOARD_ADMIN_TOKEN` rồi nhớ trong `localStorage`.
Token KHÔNG bao giờ được nướng vào trang.

## Trước khi mở cho người khác

Trang bày ra tên người dùng, `open_id`, `client_id` và thông báo lỗi có kèm id
tài liệu. Token quản trị chỉ chặn thao tác GHI — nó **không** che phần đọc.
Muốn kín thì bật Vercel Protection (Password hoặc SSO).
