FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends \
      chromium xvfb x11vnc novnc websockify fonts-liberation fonts-noto-color-emoji ca-certificates \
    && rm -rf /var/lib/apt/lists/* && mkdir /data && chown node:node /data
WORKDIR /app
COPY package.json docker/start.sh ./
COPY server server
COPY public public
COPY extension extension
ENV DATA_DIR=/data DISPLAY=:99
USER node
EXPOSE 8080
CMD ["./start.sh"]
