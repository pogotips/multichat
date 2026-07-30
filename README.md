# multichat

A live chat aggregator that merges **Twitch** and **YouTube** live chat into a single dark, mobile-friendly feed — built for IRL streamers who want to watch both platforms' chat on a phone while out on a stream. A single Cloudflare Worker (backed by one Durable Object) holds the Twitch IRC connection and fans messages out to the browser over Server-Sent Events; a small companion Docker container handles YouTube.

## Features

- **Merged chat** — Twitch + YouTube in one chronological feed, colour-coded by platform.
- **Financial event highlighting** — bits/cheers, subs/gifts, YouTube Super Chats & memberships get distinct, prominent rows.
- **Text-to-speech** — optional read-aloud for financial events.
- **Native emotes, both platforms** — Twitch emotes and YouTube custom channel emojis render inline (with text fallback).
- **Mod actions** — Twitch `CLEARMSG`/`CLEARCHAT` and YouTube deletions mark affected rows in place (strikethrough) live and on replay.
- **Gap recovery** — reconnect replays missed messages from the Durable Object's ring buffer via `Last-Event-ID`, so a blip doesn't lose rows.
- **Pull-to-refresh** — installed-PWA pull gesture reconnects the feed.
- **PWA** — installable to a phone home screen; serves its own manifest and icons.
- **Optional live counts** — Twitch viewer & follower counts, YouTube concurrent viewers.
- **Twitch EventSub** — channel-point redemptions, Hype Train, and ad-break events that IRC can't see.

## Architecture

The system is three loosely-coupled pieces. The Worker is the hub; everything else talks to it over HTTP/SSE.

```
                 Twitch IRC  ──────────┐
                 Twitch EventSub  ─────┤ (webhook)
                                       ▼
   YouTube live chat                ┌───────────────────────────┐
        │                           │  Cloudflare Worker        │
        ▼  (scrape)                 │  ┌─────────────────────┐  │
  ┌──────────────┐   POST /ingest/yt│  │ ChatHub (Durable    │  │
  │  yt-poller   │ ────────────────▶│  │ Object) — ring      │  │
  │  (Docker)    │                  │  │ buffer + fan-out    │  │
  └──────────────┘                  │  └─────────────────────┘  │
                                    └───────────┬───────────────┘
                                                │  SSE  (GET /events)
                                                ▼
                                    ┌───────────────────────────┐
                                    │  Browser (PWA)            │
                                    │  dark mobile feed         │
                                    └───────────────────────────┘
```

- **Cloudflare Worker + Durable Object (`ChatHub`)** — opens an anonymous WebSocket to Twitch IRC, receives Twitch EventSub webhooks, holds an in-memory ring buffer of the last ~200 messages, and streams everything to connected browsers over SSE. State is in-memory only; if the DO evicts, clients just resume live.
- **yt-poller (Docker)** — a standalone Node script that scrapes YouTube's live chat and `POST`s normalized messages to the Worker's `/ingest/yt`. It runs outside Cloudflare because a YouTube chat scrape is a long-lived connection that doesn't fit the Workers execution model.
- **Browser (PWA)** — the static page is served by the Worker itself. It connects to `GET /events` and renders the merged feed.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the full system map, wire formats, trust boundaries, and deploy runbook.

## Quick start

See [`INSTALL.md`](INSTALL.md) for the full walkthrough (Worker → poller → PWA client → optional EventSub).

## A note on the YouTube integration

The YouTube side uses the unofficial [`youtube-chat`](https://www.npmjs.com/package/youtube-chat) npm package — **not** YouTube's official Live Streaming API. It works by scraping the live chat page. This may violate YouTube's Terms of Service — use at your own risk. Consequences:

- **No YouTube API key is needed for chat itself** (a key is only used for the optional live viewer/like counts).
- **It can break without notice** if YouTube changes their frontend. Treat it as best-effort; the Worker-side ingest count is the trustworthy liveness signal, not the poller's own logs.
- The package is **locally patched** via [`patch-package`](https://www.npmjs.com/package/patch-package) (`tools/yt-poller/patches/youtube-chat+2.2.0.patch`), applied automatically on `npm install` (`postinstall`).

## Optional integrations

- **Raid-queue renewal tendril** — the Worker's `/ingest/yt` accepts a second, independent secret (`MULTICHAT_RAIDQ_INGEST_SECRET`) so an external membership-renewal cron can post `member_renewed` events without gaining the poller's mod-action capability. This is entirely optional: leave the secret unset if you have no such cron. The multichat side only cares that the shared secret matches — the cron's own implementation is out of scope for this repo.

## License

[MIT](LICENSE) © 2026 PoGo.Tips contributors.
