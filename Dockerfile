FROM node:22-bookworm-slim
# ffmpeg + шрифты для субтитров; curl — для скачивания yt-dlp на этапе сборки
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg curl ca-certificates fonts-dejavu-core fonts-liberation \
 && rm -rf /var/lib/apt/lists/*
# Официальный standalone-файл yt-dlp (не требует Python). Актуальная версия берётся при каждой сборке.
# Если файл не скачался или не запускается — сборка падает (а не выкатывается сломанный сервис).
RUN set -eux; arch="$(uname -m)"; f=yt-dlp_linux; [ "$arch" = "aarch64" ] && f=yt-dlp_linux_aarch64; \
    curl -fsSL --retry 5 --retry-delay 3 -o /usr/local/bin/yt-dlp "https://github.com/yt-dlp/yt-dlp/releases/latest/download/$f"; \
    chmod 755 /usr/local/bin/yt-dlp; /usr/local/bin/yt-dlp --version
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATA_DIR=/data YT_DLP_BIN=/usr/local/bin/yt-dlp
EXPOSE 3000
CMD ["node", "server.js"]
