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
| `YOUTUBE_API_KEY` | Optional (2026-07-22). YouTube Data API key for live-counts AND the zombie-watchdog liveness gate (`videos.list`, 1 quota unit/poll, only spent while a session is live — see `yt-counts.mjs`). Absent = live-counts is off, chat is unaffected; the watchdog's liveness stays `unknown` (not the same as `not_live`), so it takes the patient 15-minute threshold with the watchdog still armed — NOT the same as `WATCHDOG_LIVENESS_GATE=off` below, which is a separate, legacy 3-minute path. |
| `WATCHDOG_LIVENESS_GATE` | Optional (round-3 audit). Default on. Set to `off` to instantly revert to the single fixed 3-minute threshold, ignoring liveness entirely — behavior-identical to the pre-audit code path (the one additive difference: the `poller_heartbeat` log line now also carries `liveness: 'gate_off'`) — without a rebuild: a Dockge env edit + container recreate, for recovering from a misbehaving gate mid-stream. |

**`fetched` vs `posted` in the heartbeat/logs:** `fetched` counts raw
`youtube-chat` library `chat` events, pre-dedupe — this includes the history
re-burst a fresh reconnect's continuation re-serves, which is why it can be
nonzero with nothing actually delivered. `posted` is the field that answers
"was anything delivered". `fetched:0` is the normal, expected state for
live-but-silent chat, not a sign anything is wrong — two rounds of a
production audit (2026-08-17) misread it as such before this line existed.

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

## Manual diagnostic: authed vs anon chat diff (`authed-chat-difftest.mjs`)

A standalone LOCAL diagnostic script — **not** part of the deployed poller
pipeline (not imported by `poller.mjs`, not in the Dockerfile's `COPY`
lines, not wired into `package.json` scripts). Run by hand to compare what
a real, logged-in Google account's chat session sees versus this poller's
normal anonymous session, e.g. to check whether authed polling surfaces
member-only chat or different moderation visibility that anon polling
misses.

Polls both ways in parallel, each in its own child process (see the file
header comment in `authed-chat-difftest.mjs` for why: `youtube-chat` calls
the bare `axios` singleton internally with no per-call config, so the
authed side's Cookie/SAPISIDHASH header injection can only be safely scoped
by process isolation, not by a shared-process guard). Writes raw ChatItem
objects to `anon.jsonl` / `authed.jsonl` (one per line) plus a
`diff-report.txt` — counts and which messages appeared on only one side,
matched primarily by YouTube's own per-message `id` (see
`authed/diff.mjs` for the full matching strategy, including its
content+timestamp fallback for the rare case an item has no id).

Env vars:

| Var | Purpose |
|---|---|
| `YT_CHANNEL_ID` | required. Same as the poller's own env var. |
| `YT_COOKIE_FILE` | optional. Absolute path **outside this repo** to a cookie file for a real Google account (Netscape cookie-jar format, or JSON — see `authed/sapisidhash.mjs`'s `parseCookieFile`). Needs at least a `SAPISID` (or `__Secure-3PAPISID`) cookie. **Unset = authed side is skipped entirely — anon-only mode, zero filesystem access looking for cookies.** |
| `POLL_SECONDS` | optional, default 120. |
| `OUT_DIR` | optional. Defaults to a fresh directory under the OS temp dir — never inside this repo. |

```
YT_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxxxxxx \
node tools/yt-poller/authed-chat-difftest.mjs
# anon-only — no cookies present anywhere in the invocation

YT_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxxxxxx \
YT_COOKIE_FILE=/absolute/path/outside/repo/youtube-cookies.txt \
POLL_SECONDS=180 \
node tools/yt-poller/authed-chat-difftest.mjs
# anon + authed, 3-minute poll, diff report at the end
```

Never commit a cookie file, and never point `YT_COOKIE_FILE` at a
repo-relative path. Cookie values are read into memory only to build the
`Cookie` and `SAPISIDHASH` `Authorization` headers — never logged, never
written to `anon.jsonl`/`authed.jsonl`/`diff-report.txt` (those only ever
contain YouTube's own chat message data).
