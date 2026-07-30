# multichat-yt-poller

Small Node script that watches your current YouTube live chat and forwards
normalized messages to the `multichat` Worker's `/ingest/yt` endpoint. Runs
outside Cloudflare (e.g. on any always-on Docker host), because the Worker
never polls YouTube itself.

Uses [`youtube-chat`](https://www.npmjs.com/package/youtube-chat), an
innertube-based scraper — no API key, no quota. Verified working live
against a real stream. This may violate YouTube's Terms of Service — use at
your own risk.

The library is locally patched via [`patch-package`](https://www.npmjs.com/package/patch-package)
(`patches/youtube-chat+2.2.0.patch`, applied automatically by `npm install`'s
postinstall hook). The patch marks membership announcements by renderer type
and parses the two membership-gift renderers the stock parser drops, so the
poller can emit `member_new` / `member_milestone` / `member_gift` /
`member_gift_received` events. Without the patch those events are silently
lost — never skip `npm install`.

## Env vars

| Var | Purpose |
|---|---|
| `YT_CHANNEL_ID` | Your channel id (starts `UC...`), e.g. `UCxxxxxxxxxxxxxxxxxxxxxx` |
| `MULTICHAT_URL` | Base URL of the `multichat` worker, e.g. `https://multichat.YOUR_DOMAIN` |
| `MULTICHAT_INGEST_SECRET` | Same value as the Worker's `MULTICHAT_INGEST_SECRET` wrangler secret |
| `YOUTUBE_API_KEY` | Optional (2026-07-22). YouTube Data API key for live-counts (`videos.list`, 1 quota unit/poll, only spent while a session is live — see `yt-counts.mjs`). Absent = counts feature is simply off; chat is unaffected. |

## Run

```
npm install
YT_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxxxxxx \
MULTICHAT_URL=https://multichat.YOUR_DOMAIN \
MULTICHAT_INGEST_SECRET=xxxxx \
npm start
```

Exits non-zero on missing/invalid config (fails fast under a restart-loop
supervisor). Reconnects with capped exponential backoff (2s → 60s) on
stream-end or scraper errors — it does not exit on transient chat errors,
so a process supervisor mainly needs to catch crashes, not flapping.

## docker compose

```yaml
services:
  multichat-yt-poller:
    build: .
    restart: unless-stopped
    environment:
      YT_CHANNEL_ID: "UCxxxxxxxxxxxxxxxxxxxxxx"
      MULTICHAT_URL: "https://multichat.YOUR_DOMAIN"
      MULTICHAT_INGEST_SECRET: "xxxxx"
      YOUTUBE_API_KEY: "xxxxx" # optional — omit to leave live-counts off
```

See `Dockerfile` in this directory. `patches/` copies in before `npm
install` so the postinstall `patch-package` run can apply the youtube-chat
patch; `patch-package` is a regular dependency, so `--omit=dev` is safe.
