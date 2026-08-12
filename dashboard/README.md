# Dashboard

Bảng vận hành cho server MCP. Chỉ ĐỌC — `audit_logs` + `machines` trên Supabase.
Thu hồi truy cập vẫn dùng `npm run revoke` chạy tại chỗ.

```
compute.mjs      toàn bộ phép tính, không phụ thuộc repo — dùng chung cho cả hai bản
template.html    giao diện; `/*__DATA__*/null` là chỗ cắm dữ liệu
build.mjs        dựng preview.html (số nướng sẵn) + index.html (gọi /api/data) + tools.json
api/data.js      serverless: tính số ở phía máy chủ
```

Hai bản dùng chung `computeDashboard` nên không bao giờ lệch số.

## Chạy tại chỗ

```bash
node dashboard/build.mjs
```

Mở `dashboard/preview.html`.

## Deploy Vercel

Root directory = `dashboard/`. Chạy `node dashboard/build.mjs` trước để có
`tools.json` và `index.html`, rồi commit chúng.

Biến môi trường:

| Biến | Để làm gì |
|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Nguồn số liệu. **Chỉ ở phía máy chủ** |
| `LARK_APP_ID` | Hiển thị ở chân trang |

## Trước khi mở cho người khác

Trang không sửa được gì, nhưng nó bày ra tên người dùng, `open_id`, `client_id`
và thông báo lỗi có kèm id tài liệu. Bật Vercel Protection (Password hoặc SSO)
trước khi để nó ở URL công khai.
