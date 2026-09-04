# Ảnh nền node:22-slim — giải quyết luôn chuyện Ubuntu 22.04 chỉ có Node 12 trong
# apt, mà code thì cần >= 22 (`process.loadEnvFile` ở src/config.js:9 và
# supervisor.js:32). Đóng gói Node vào ảnh nghĩa là KHÔNG cài Node lên host,
# nên không đụng gì tới môi trường của lsr-platform.
FROM node:22-slim

WORKDIR /app

# Cài phụ thuộc trước, tách khỏi mã nguồn: sửa code mà không đổi package thì
# Docker dùng lại lớp này, build lại nhanh hơn nhiều.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY src/ ./src/
COPY supervisor.js ./

# curl cho HEALTHCHECK bên dưới. `--no-install-recommends` để không kéo thêm
# hàng chục gói không dùng tới.
RUN apt-get update \
 && apt-get install -y --no-install-recommends curl \
 && rm -rf /var/lib/apt/lists/*

# .env và .data/ KHÔNG nằm trong ảnh — bind mount lúc chạy (xem compose).
# Nhét .env vào ảnh là đưa TOKEN_ENC_KEY và app secret vào từng lớp image,
# ai kéo được ảnh là có token Lark của cả công ty.

ENV NODE_ENV=production
ENV PORT=8787

# Không có cloudflared/tailscale trong ảnh là CỐ Ý: supervisor thấy thiếu thì
# lấy thẳng PUBLIC_URL (supervisor.js:124). Caddy mới là thứ đứng ra ngoài.
# Log sẽ in "Không tìm thấy cloudflared — chạy CHỈ TRÊN LOCALHOST"; dòng đó
# SAI trong ngữ cảnh này, cứ bỏ qua.

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD curl -fsS http://127.0.0.1:8787/health || exit 1

CMD ["node", "supervisor.js"]
