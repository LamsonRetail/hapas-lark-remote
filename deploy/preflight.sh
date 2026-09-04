#!/usr/bin/env bash
# Kiểm tra TRƯỚC khi cài gì lên VM. Chỉ đọc — không cài, không sửa, không tắt gì.
#
# VM `digital-transformation-hosting` tạo từ 16/04/2026 và có 16 GB RAM, tức
# gần như chắc chắn đang chạy thứ khác. Cài Caddy mà không xem trước là có thể
# đá vào cổng 443 của một dịch vụ đang phục vụ người khác.
#
# Chạy:  bash preflight.sh

echo "=============== 1. MÁY ==============="
echo -n "OS            : "; . /etc/os-release 2>/dev/null && echo "$PRETTY_NAME" || echo "?"
echo -n "Kernel        : "; uname -r
echo -n "RAM           : "; free -h 2>/dev/null | awk '/Mem:/{print $2}'
echo -n "Đĩa /         : "; df -h / 2>/dev/null | awk 'NR==2{print $4" trống / "$2}'
echo -n "Uptime        : "; uptime -p 2>/dev/null

echo
echo "=============== 2. GCP METADATA ==============="
M="http://metadata.google.internal/computeMetadata/v1"
H="Metadata-Flavor: Google"
gcp() { curl -s -m 3 -H "$H" "$M/$1" 2>/dev/null; }
echo -n "IP công cộng  : "; gcp "instance/network-interfaces/0/access-configs/0/external-ip"; echo
echo -n "IP nội bộ     : "; gcp "instance/network-interfaces/0/ip"; echo
echo -n "Zone          : "; gcp "instance/zone" | awk -F/ '{print $NF}'
echo -n "Network tags  : "; gcp "instance/tags"; echo "   <- cần https-server, http-server"
echo -n "OS Login (máy): "; gcp "instance/attributes/enable-oslogin"; echo "   <- TRUE = metadata SSH key BỊ BỎ QUA"
echo -n "OS Login (prj): "; gcp "project/attributes/enable-oslogin"; echo

echo
echo "=============== 3. AI ĐANG GIỮ CỔNG 80/443 ==============="
# Đây là câu hỏi quan trọng nhất. Có thứ khác đang nghe 443 thì DỪNG, hỏi lại.
if command -v ss >/dev/null 2>&1; then
  ss -tlnp 2>/dev/null | awk 'NR==1 || /:(80|443|8787)\s/'
else
  netstat -tlnp 2>/dev/null | awk 'NR<3 || /:(80|443|8787)\s/'
fi
echo "(trống ở dưới dòng tiêu đề = không ai giữ, an toàn)"

echo
echo "=============== 4. WEB SERVER ĐÃ CÓ SẴN ==============="
for s in caddy nginx apache2 httpd traefik; do
  printf "%-10s " "$s"
  if command -v $s >/dev/null 2>&1 || systemctl list-unit-files 2>/dev/null | grep -q "^$s.service"; then
    echo "CÓ  — trạng thái: $(systemctl is-active $s 2>/dev/null || echo '?')"
  else
    echo "-"
  fi
done

echo
echo "=============== 5. NODE ==============="
if command -v node >/dev/null 2>&1; then
  V=$(node -v)
  MAJ=$(echo "$V" | sed 's/^v//' | cut -d. -f1)
  echo "node          : $V  (ở $(command -v node))"
  if [ "$MAJ" -ge 22 ] 2>/dev/null; then
    echo "               ✅ đạt yêu cầu >= 22"
  else
    echo "               ❌ QUÁ CŨ. Cần >= 22 vì code dùng process.loadEnvFile."
    echo "               Nguy hiểm: thiếu hàm này thì .env KHÔNG được nạp mà"
    echo "               không báo lỗi, rồi hỏng ở chỗ khác hoàn toàn vô nghĩa."
  fi
else
  echo "node          : chưa cài (Ubuntu 22.04 apt chỉ có v12 — đừng dùng apt)"
fi
echo -n "npm           : "; command -v npm >/dev/null 2>&1 && npm -v || echo "-"

echo
echo "=============== 6. CHỖ CÀI ==============="
echo -n "/opt/lark-mcp : "; [ -e /opt/lark-mcp ] && echo "ĐÃ TỒN TẠI — xem kỹ trước khi ghi đè" || echo "trống, an toàn"
echo -n "user mcp-deploy: "; id mcp-deploy >/dev/null 2>&1 && id mcp-deploy || echo "chưa có"

echo
echo "=============== 7. RA ĐƯỢC LARK KHÔNG ==============="
for h in open.larksuite.com accounts.larksuite.com; do
  printf "%-24s " "$h"
  code=$(curl -s -o /dev/null -w "%{http_code} %{time_total}s" -m 10 "https://$h" 2>/dev/null)
  [ -n "$code" ] && echo "$code" || echo "KHÔNG RA ĐƯỢC"
done
echo "(hỏng ở đây = Lark đang bật danh sách IP cho phép, phải thêm IP của VM)"

echo
echo "=============== XONG ==============="
