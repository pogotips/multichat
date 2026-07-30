# node:20-alpine, pinned 2026-07-15
FROM node:20-alpine@sha256:fb4cd12c85ee03686f6af5362a0b0d56d50c58a04632e6c0fb8363f609372293
WORKDIR /app
COPY package.json package-lock.json ./
COPY patches ./patches
RUN npm ci --omit=dev
COPY poller.mjs normalize.mjs recovery.mjs retry-queue.mjs capture.mjs yt-counts.mjs ./
CMD ["node", "poller.mjs"]
