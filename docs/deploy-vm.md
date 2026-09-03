# Chuyển sang server công ty + `mcp.hapas.vn`

Viết ngày 03/09/2026, sau khi xác định nguyên nhân: DNS của `*.ts.net` phân giải
chập chờn (13% trên 123 lượt đo), và mình không sửa được vì cái tên là của
Tailscale.

---

## 0. Chuẩn bị TRƯỚC khi bắt tay (làm tối nay)

Ba câu hỏi phải có câu trả lời, nếu không mai sẽ tắc:

- [ ] **Ai giữ tài khoản quản trị DNS `hapas.vn` ở PA Việt Nam?**
      Cần thêm đúng một bản ghi cho `mcp.hapas.vn`. KHÔNG đụng `hapas.vn` gốc,
      KHÔNG đụng MX (email Lark), KHÔNG đụng TXT xác thực.
- [ ] **VM có gì:** hệ điều hành, IP công cộng tĩnh, mở được cổng 443 chưa?
- [ ] **Lark app có bật danh sách IP cho phép không?**
      Có thì phải thêm IP của VM, không thì lên VM xong gọi API hỏng hết.
      (Device flow nên không cần khai redirect URI — chỗ đó yên tâm.)

---

## 1. Mang theo từ máy hiện tại

| Thứ | Đường dẫn | Ghi chú |
|---|---|---|
| Cấu hình | `.env` | 14 biến |
| Dữ liệu | `.data/` | ~1.1 MB |

### ⚠️ `TOKEN_ENC_KEY` là thứ dễ mất nhất

`.data/tokens.json` được mã hoá AES-256-GCM bằng `TOKEN_ENC_KEY` trong `.env`.

**Copy dữ liệu mà quên khoá → file thành rác → cả 45 người phải quét mã đăng
nhập lại.** Không có đường cứu.

Và đừng để lộ: ai có `TOKEN_ENC_KEY` + `tokens.json` là có refresh token Lark
của cả công ty.

```bash
# Nén cả hai lại, chuyển bằng đường an toàn (scp), đừng gửi qua chat
tar czf mcp-migrate.tgz .env .data/
```

---

## 2. Dựng trên VM

```bash
# Node >= 22 (code dùng process.loadEnvFile, cần >= 21.7)
node -v

git clone <repo> /opt/lark-mcp && cd /opt/lark-mcp
npm ci --omit=dev

tar xzf mcp-migrate.tgz
chmod 600 .env && chmod -R 600 .data/*.json
```

Sửa `.env`:

```ini
PUBLIC_URL=https://mcp.hapas.vn
# Bỏ TUNNEL — VM có IP công cộng thì không cần tunnel nữa.
# Tunnel chỉ sinh ra để chọc thủng NAT khi server nằm trong PC văn phòng.
```

TLS bằng Caddy (tự xin Let's Encrypt, tự gia hạn):

```
# /etc/caddy/Caddyfile
mcp.hapas.vn {
    reverse_proxy 127.0.0.1:8787
}
```

DNS tại PA Việt Nam: thêm bản ghi **A** `mcp` → `<IP của VM>`.

---

## 3. Kiểm chứng — ĐỪNG kiểm từ chính VM

Cái bẫy đã làm mất cả ngày hôm nay: kiểm tra từ máy chạy server thì lúc nào cũng
xanh, vì nó không đi qua đường công cộng.

**Kiểm từ máy khác**, hoặc ép qua IP:

```bash
# 1. issuer phải là tên MỚI, không phải ts.net
curl -s https://mcp.hapas.vn/.well-known/oauth-authorization-server | grep issuer

# 2. TLS đúng tên
curl -sI https://mcp.hapas.vn/health

# 3. DNS phân giải được ở NHIỀU resolver
for r in 1.1.1.1 8.8.8.8 9.9.9.9; do nslookup mcp.hapas.vn $r; done
```

Ba cái đều đạt mới đi tiếp.

---

## 4. Chuyển người dùng — chọn một trong hai

### Cách A: cắt thẳng (nhanh, nhưng 45 người phải cắm lại)

Đổi URL trong connector của Claude Team. Đổi URL = đổi OAuth issuer = **mọi
người phải cắm lại**. Làm ngoài giờ, báo trước.

### Cách B: chạy song song (không ai phải cắm lại ngay) ← nên chọn

Server đã hỗ trợ sẵn từ commit `8c57921`. Khai cả hai tên:

```ini
PUBLIC_URL=https://mcp.hapas.vn
PUBLIC_URL_ALT=https://hapasvn.tail65cea0.ts.net
```

Mỗi request được khai **đúng tên miền nó đi vào**, nên hai đường sống song song
trên cùng một tiến trình, cùng một kho token.

Để URL cũ còn sống thì PC văn phòng phải giữ Tailscale, và trỏ funnel sang VM
thay vì `localhost` (cho VM vào tailnet rồi trỏ vào IP `100.x` của nó — đi trong
tailnet, không hở ra internet).

> Chưa kiểm chứng: `tailscale serve` proxy sang một máy khác trong tailnet.
> Phải thử trước khi dựa vào.

**Và nhờ anh Thiện: publish connector MỚI, ĐỪNG sửa URL cái đang có.**
Sửa URL cái cũ là 45 người mất kết nối ngay lập tức.

---

## 5. Chạy nền

`supervisor.js` vẫn dùng được trên VM: không tìm thấy `cloudflared` thì nó lấy
thẳng `PUBLIC_URL` đã cấu hình, và probe đo đường vào từ ngoài vẫn chạy.

```ini
# /etc/systemd/system/lark-mcp.service
[Unit]
After=network-online.target

[Service]
WorkingDirectory=/opt/lark-mcp
ExecStart=/usr/bin/node supervisor.js
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
```

---

## 6. Quay đầu nếu hỏng

PC văn phòng **giữ nguyên, đừng tắt, đừng xoá gì** trong ít nhất một tuần.

Hỏng thì: tắt server trên VM → bật lại trên PC văn phòng → URL cũ sống lại ngay.

Điều kiện để quay đầu sạch: **chưa ai cắm bằng URL mới**. Đã có người cắm rồi
thì token của họ nằm trong `.data/oauth.json` **trên VM**, quay đầu là mất. Nên
sau khi có người đầu tiên cắm URL mới, phải **copy `.data/` ngược về** nếu muốn
quay đầu.

---

## 7. Sau khi xong

- [ ] Bật sao lưu `.data/` — **hiện chưa có gì cả**
- [ ] Nâng quota Supabase (audit đang dồn ra `.data/audit-spill.ndjson`, tự nạp
      lại khi Supabase sống)
- [ ] Theo dõi `ngoài: OK` trong log — trên tên miền mới thì phải sạch
- [ ] Một tuần sau, nếu không ai dùng URL cũ nữa thì tắt Funnel và bỏ
      `PUBLIC_URL_ALT`

---

## Hai người đang kẹt, nhắn trước khi chuyển

- **Trần Thị Vân Anh** — phiên Lark đã chết, bắt buộc đăng nhập lại
- **Kim Tuấn Anh** — có token Lark nhưng không có bearer; cắm lại là được

---

## Việc KHÔNG cần làm

- ❌ Đăng ký tên miền mới — `hapas.vn` đã là của công ty
- ❌ Chuyển nameserver `hapas.vn` sang Cloudflare — kéo theo MX, dễ mất email
- ❌ ngrok — gói free chèn trang cảnh báo làm gãy trang đăng nhập, tunnel chết
     sau 1 tiếng, và `*.ngrok-free.app` cũng là tên đi mượn y hệt `*.ts.net`
- ❌ Cloudflare quick tunnel — URL đổi mỗi lần chạy lại
