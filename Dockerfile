FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-pip ca-certificates fonts-dejavu-core fonts-liberation \
 && pip3 install --break-system-packages -U yt-dlp && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY . .
ENV NODE_ENV=production DATA_DIR=/data
EXPOSE 3000
CMD ["node", "server.js"]
