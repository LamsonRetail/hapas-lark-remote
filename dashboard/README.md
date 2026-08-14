# Dashboard

Hai trang, cùng đọc `audit_logs` + `machines` trên Supabase:

- **Bảng vận hành** (`/`) — canh gác, KPI, người dùng, chỗ cắm.
- **Biểu đồ** (`/explore`) — chọn một cột để nhóm, một phép đo để vẽ.

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
