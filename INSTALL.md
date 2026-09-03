# Installing multichat

Three pieces to stand up, in order:

- **[A. Cloudflare Worker](#a-cloudflare-worker-the-hub)** — the hub. Required.
- **[B. YouTube poller](#b-youtube-poller-docker)** — Docker container. Required only if you want YouTube chat.
- **[C. PWA client](#c-pwa-client)** — served by the Worker, nothing to deploy.
- **[D. Optional: Twitch EventSub / live counts](#d-optional-twitch-eventsub--live-counts)**

Twitch chat works with just section A. YouTube needs A + B.

---

## A. Cloudflare Worker (the hub)

### Prerequisites

- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (the free plan covers Workers, Durable Objects, and R2 for this use).
- **Node.js 20+**.
- **wrangler** CLI — `npm install -g wrangler` (or use `npx wrangler`).
- A domain on Cloudflare if you want a custom route (optional — you can also run on a `*.workers.dev` subdomain by flipping `workers_dev` to `true`).

### 1. Clone and configure

```bash
git clone <this-repo>
cd multichat

cp wrangler.jsonc.example wrangler.jsonc
cp .dev.vars.example .dev.vars
```

Edit **`wrangler.jsonc`** and replace the placeholders:

| Placeholder | Replace with |
|---|---|
| `YOUR_CHANNEL` | Your Twitch login (e.g. `yourchannel`) |
| `YOUR_BROADCASTER_ID` | Numeric Twitch user id for that channel (one-time public login→id lookup; not secret — see below) |
| `YOUR_DOMAIN` | The hostname to serve on (e.g. `multichat.example.com`), or remove the `routes` block and set `"workers_dev": true` |

**Looking up `YOUR_BROADCASTER_ID`:** register a Twitch app once at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) (client-credentials flow, no user consent needed for this lookup), then:

```bash
# 1. Get an app access token
curl -X POST 'https://id.twitch.tv/oauth2/token' \
  -d 'client_id=<TWITCH_CLIENT_ID>' \
  -d 'client_secret=<TWITCH_CLIENT_SECRET>' \
  -d 'grant_type=client_credentials'
# → { "access_token": "<APP_TOKEN>", ... }

# 2. Look up the id
curl -H 'Authorization: Bearer <APP_TOKEN>' \
     -H 'Client-Id: <TWITCH_CLIENT_ID>' \
     'https://api.twitch.tv/helix/users?login=YOUR_CHANNEL'
# → data[0].id is YOUR_BROADCASTER_ID
```

### 2. Create the R2 bucket

The Worker captures any unclassified IRC line to R2 (exhaust, self-cleaning):

```bash
wrangler r2 bucket create multichat-capture
```

Then add a **30-day lifecycle rule scoped to the `capture/` prefix** (Cloudflare dashboard → R2 → the bucket → Settings, or `wrangler r2 bucket lifecycle`).

The Durable Object (`ChatHub`) and its SQLite migration are declared in `wrangler.jsonc` — no manual step; `wrangler deploy` provisions them.

### 3. Set secrets

Edit `.dev.vars` (used by `wrangler dev` locally) — every variable is documented inline in the file. For production, push the same values as Worker secrets:

```bash
wrangler secret put MULTICHAT_VIEW_SECRET      # required
wrangler secret put MULTICHAT_INGEST_SECRET    # required
# optional — set only if you use them:
wrangler secret put MULTICHAT_RAIDQ_INGEST_SECRET
wrangler secret put EVENTSUB_SECRET
wrangler secret put TWITCH_CLIENT_ID
wrangler secret put TWITCH_CLIENT_SECRET
wrangler secret put TWITCH_USER_REFRESH_TOKEN
```

**Required:** `MULTICHAT_VIEW_SECRET` (gates the viewer link) and `MULTICHAT_INGEST_SECRET` (gates the YouTube poller's POST). Everything else is optional and degrades to "feature off" when unset — see the comments in `.dev.vars.example` for exactly what each one enables. Generate the `*_SECRET` values as opaque random strings, e.g. `openssl rand -hex 32`.

> Both `wrangler.jsonc` and `.dev.vars` are gitignored — only the `.example` copies are committed, so your real values never land in git.

> **Protected host-only files** — gitignored, example-only in this repo,
> and unrecoverable if deleted since this repo holds no other copy:
>
> | File | Lives only | This repo has |
> |---|---|---|
> | `wrangler.jsonc` | your local checkout | `wrangler.jsonc.example` |
> | `.dev.vars` | your local checkout | `.dev.vars.example` |
> | `docker-compose.yml` (poller stack dir on the poller host) | the poller host | `tools/yt-poller/docker-compose.yml.example` |
>
> None of these are reachable by `rsync`, `git checkout`, or any rollback
> tag — the poller host's `docker-compose.yml` in particular is never
> touched by the poller's rsync rollout (see `docs/ARCHITECTURE.md` §6
> step 3), only hand-edited in place. A tool or command that could delete
> or overwrite one of these (`rsync --delete`, a compose "recreate from
> scratch," etc.) needs a fresh backup first, every time — see the
> step-zero tar rule in `docs/ARCHITECTURE.md` §6 step 3.

### 4. Deploy

```bash
wrangler deploy
```

### 5. Verify

- **Local:** `wrangler dev`, then open `http://localhost:8787/#t=<your MULTICHAT_VIEW_SECRET>`. Live Twitch messages should appear (purple badge, coloured username). The secret rides in the URL fragment and is never sent to the server on `GET /`.
- **Ingest smoke test:**
  ```bash
  curl -XPOST https://<your-domain>/ingest/yt \
    -H 'X-Multichat-Secret: <your MULTICHAT_INGEST_SECRET>' \
    -d '{"user":"Alice","text":"hi"}'
  ```
  A row with a red (YouTube) badge should appear in the feed.
- **Version endpoint:** `GET /api/version` returns `{ releaseVersion }`.

---

## B. YouTube poller (Docker)

### Why it's separate

The Worker never polls YouTube. YouTube live chat is consumed by scraping the live chat page over a **long-lived connection**, which doesn't fit the Cloudflare Workers execution model. So the poller runs as a small always-on process next to your infrastructure and pushes messages to the Worker over plain HTTPS. See [`tools/yt-poller/README.md`](tools/yt-poller/README.md) for the authoritative details.

### Env vars

| Var | Required? | Purpose |
|---|---|---|
| `YT_CHANNEL_ID` | Yes | Your YouTube channel id (starts `UC…`) |
| `MULTICHAT_URL` | Yes | Base URL of the Worker, e.g. `https://multichat.YOUR_DOMAIN` |
| `MULTICHAT_INGEST_SECRET` | Yes | **Must match** the Worker's `MULTICHAT_INGEST_SECRET` exactly |
| `YOUTUBE_API_KEY` | No | YouTube Data API key for optional live viewer/like counts (1 quota unit/poll, only while live) |

### Run with Docker Compose

Create a `docker-compose.yml` in `tools/yt-poller/` (an example block lives in that directory's README) with your values, then:

**Linux** — Docker Engine:
```bash
cd tools/yt-poller
docker compose up -d
```

**macOS** — [Docker Desktop](https://www.docker.com/products/docker-desktop/) or [OrbStack](https://orbstack.dev/); same command:
```bash
cd tools/yt-poller
docker compose up -d
```

**Windows** — Docker Desktop with the **WSL2 backend** enabled; same command from a WSL or PowerShell shell:
```bash
cd tools/yt-poller
docker compose up -d
```

The image is `node:20-alpine`; `npm install` runs `patch-package` automatically to apply the `youtube-chat` patch (see the README — never skip the install step or membership events are silently lost). `restart: unless-stopped` gives you the crash-restart loop the poller expects.

Prefer no Docker? `cd tools/yt-poller && npm install && npm start` with the env vars set works on any Node 20+ host.

### Verify it's posting

- The poller **only logs failures** on its success path (a healthy connect is silent by design), so its stdout is not a reliable liveness signal.
- The trustworthy check is the **Worker side**: while your YouTube stream is live, watch the feed (or the Worker's logs / Cloudflare observability) for `POST /ingest/yt` hits and YouTube-badged rows appearing.
- The poller exits non-zero on missing/invalid config, so a bad env var surfaces immediately under a restart supervisor.

---

## C. PWA client

There is **nothing separate to deploy** — the static page, manifest, and icons are all served by the Worker at `GET /`.

### Open it

Navigate to `https://<your-domain>/#t=<your MULTICHAT_VIEW_SECRET>`.

### Token seeding (auth flow)

The viewer secret is resolved entirely client-side (`resolveToken`):

1. A URL fragment `#t=<secret>` seeds `localStorage` — **the fragment always wins** over stale storage.
2. Once seeded, an installed PWA launched with **no fragment at all** still reconnects, because the value is in `localStorage`.
3. A ⚿ control on the page reopens the connect prompt for manual re-entry if you ever need to paste the token again.

The secret is used only to open the SSE stream (`GET /events?t=…`) — it is never sent to the server on the `GET /` page load itself. (Query-string auth on `/events` is unavoidable because `EventSource` can't set headers; the value therefore does appear in Cloudflare's account-private access logs. It's kept separate from the ingest secret for exactly this reason.)

### Install as a PWA

Open the page in mobile Safari (iOS) or Chrome (Android) and use **Add to Home Screen**. The app is mobile-first and dark by default; installed mode (`display-mode: standalone`) also unlocks pull-to-refresh.

---

## D. Optional: Twitch EventSub / live counts

These features all **degrade to "off" when their secrets are unset** — chat works without any of them.

### Live viewer & follower counts

- **Viewer count** needs a Twitch app (client-credentials flow, no user consent): register at [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps) and set `TWITCH_CLIENT_ID` + `TWITCH_CLIENT_SECRET`.
- **Follower count** additionally needs a user token with `moderator:read:followers`; seed the refresh token it returned as `TWITCH_USER_REFRESH_TOKEN`. The live token then rotates inside the Durable Object's storage.

  Obtaining `TWITCH_USER_REFRESH_TOKEN` (authorization-code flow — reuse the same `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET` from above; if you're also setting up EventSub below, do this once with all the scopes listed there to avoid repeating the flow):

  1. Visit this URL in a browser while logged in as the broadcaster (pick any `redirect_uri` registered on the app — e.g. `http://localhost`):
     ```
     https://id.twitch.tv/oauth2/authorize?client_id=<TWITCH_CLIENT_ID>&redirect_uri=<YOUR_REDIRECT_URI>&response_type=code&scope=moderator:read:followers
     ```
  2. Approve the consent screen. Twitch redirects to `<YOUR_REDIRECT_URI>?code=<AUTH_CODE>` — copy `AUTH_CODE` from the address bar.
  3. Exchange the code for tokens:
     ```bash
     curl -X POST 'https://id.twitch.tv/oauth2/token' \
       -d 'client_id=<TWITCH_CLIENT_ID>' \
       -d 'client_secret=<TWITCH_CLIENT_SECRET>' \
       -d 'code=<AUTH_CODE>' \
       -d 'grant_type=authorization_code' \
       -d 'redirect_uri=<YOUR_REDIRECT_URI>'
     ```
     The response's `refresh_token` field is what you set as `TWITCH_USER_REFRESH_TOKEN`. Twitch rotates it on every use — the Durable Object's own storage holds the live rotated value after the first refresh; the secret only re-seeds the chain if you ever need to re-consent.

### EventSub webhook (redemptions, Hype Train, ad breaks)

Enables real-time events that IRC can't see (channel-point redemptions — including button-only ones that post no chat message — plus Hype Train and ad-break notifications).

- Uses the **same Twitch app** as the counts above (reuse `TWITCH_CLIENT_ID`/`TWITCH_CLIENT_SECRET`), with broadcaster consent for the `channel:read:redemptions`, `channel:read:hype_train`, and `channel:read:ads` scopes.
- Set the webhook signing secret: `wrangler secret put EVENTSUB_SECRET`.
- Subscriptions are **created automatically on first client attach** — no manual `helix/eventsub/subscriptions` call.

The full signature-verification spec, subscription lifecycle, per-event render mapping, and token-refresh chain are documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) (§1 live counts, §3a EventSub).
