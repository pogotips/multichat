# multichat — Architecture & Operations

Source of truth for this doc: `src/worker.js`, `tools/yt-poller/*.mjs`, and git
log `d079b31..HEAD` (the full multichat sprint). A `deployed/<worker>` git tag
convention tracks the last-known-good deployed commit — see §6 Deploy Runbook
— and a diff-review gate re-checks drift against it on every deploy. Anything
not verifiable from those is marked **TODO-verify** — never guessed.

## 1. System Map

```
Twitch IRC (anon WS, justinfan*)  ──▶  ChatHub (DO, id "main")  ──▶  SSE  ──▶  browser (phone)
                                          ▲              ▲
YouTube live chat (poller, off-CF host) ──┘              │
external renewal cron (optional, renewals) ──────────────┘
```

- **Worker** (`src/worker.js`, `export default { fetch }`) — thin router (`ROUTES`
  array), does edge auth *before* touching the Durable Object so an
  unauthenticated request never bills DO duration.
- **`ChatHub` Durable Object** (single instance, `env.HUB.getByName('main')`,
  SQLite-backed class per `wrangler.jsonc` migrations but **no `ctx.storage`
  reads/writes for chat state** — everything chat-related is instance memory:
  a 200-entry ring buffer (`RING_SIZE`), a monotonic id counter seeded from
  `Date.now()` (`this.nextId`), per-platform dedupe sets, and the capture
  buffer. If the DO evicts, connected clients simply resume from whatever
  arrives live next — replay only has to survive client reconnects within one
  DO lifetime, not DO eviction. The `migrations`/SQLite classing in
  `wrangler.jsonc` is a platform requirement for DO classes, not a signal that
  chat state is persisted.
- **Outbound Twitch socket**: the DO itself opens `wss://irc-ws.chat.twitch.tv`
  anonymously (`justinfan<rand>` nick, no OAuth) and parses raw IRC lines.
  Connects lazily on first SSE client (`ensureTwitchConnected` from
  `handleEvents`), and a `ctx.storage.setAlarm` watchdog (`WATCHDOG_MS` = 60s)
  keeps it healthy while ≥1 client is attached; idle-disconnects
  (`IDLE_DISCONNECT_MS` = 2 min) after the last client leaves.
- **YouTube has no poller inside the Worker.** `tools/yt-poller/` is a
  standalone Node script meant to run on an always-on host (the poller host —
  see `CLAUDE.md`), scraping YouTube's live chat via the
  (patched) `youtube-chat` npm package and `POST`ing normalized JSON to
  `/ingest/yt`.
- **Raid-queue renewal tendril**: an optional external membership-renewal
  cron can detect YouTube membership *renewals* via the YouTube Data API and
  POST `member_renewed` events to the same `/ingest/yt` endpoint,
  authenticated with its own independent secret
  (`MULTICHAT_RAIDQ_INGEST_SECRET`, see §3). Entirely optional — leave the
  secret unset if you have no such cron. That cron's internal implementation
  is out of scope for this doc.
- **Live counts (Twitch viewers/followers, YouTube viewers/likes)** — all
  four ride the same `status` SSE event and render into the tw/yt topbar
  chips, client-gated (only polled while ≥1 SSE client attached):
  - Twitch viewers: `pollTwitchViewers`, `Get Streams`, client-credentials app
    token (`getTwitchAppToken`), every `TWITCH_HELIX_POLL_MS` (15s).
  - Twitch followers: `pollTwitchFollowers`, `Get Channel Followers`
    (`moderator:read:followers`), every `TW_FOLLOWERS_POLL_MS` (5min —
    followers don't move fast enough to justify anything tighter). Needs a
    user token, not an app token — see the `ctx.storage` exception below.
  - YouTube viewers/likes: pushed by the poller's heartbeat (`/ingest/yt`,
    every 15s) riding `videos.list`, gated to only carry counts while a live
    session holds a current video id.
  - **Push-on-change**: `pollTwitchViewers`/`pollTwitchFollowers`/the yt
    heartbeat branch of `handleIngestYt` each diff the new value against the
    cached one and `broadcastEvent('status', ...)` immediately on a change —
    a viewer never waits out the 25s `HEARTBEAT_MS` tick for a number that
    already changed. The 25s heartbeat itself is unchanged: it's the
    liveness floor (also drives `ping`), not the only path a status update
    can take.
  - Staleness is computed fresh per broadcast (`countField`, never stored) —
    a stale count keeps its last value and dims client-side rather than
    blanking.
  - **Structured logging (2026-07-28)**: each of the four fetch cycles logs
    `{ev: 'counts_update', metric, outcome, value}` on change, not per-tick —
    `metric` is one of `twViewers`/`twFollowers`/`ytViewers`/`ytLikes`.
    `pollTwitchViewers`/`pollTwitchFollowers` also log `outcome: 'error'`
    (with the error message) the first time a failure occurs, staying silent
    on repeat ticks of the *same* error, and log one more `outcome: 'ok'` on
    recovery even if the value lands back unchanged — otherwise an outage
    that resolves cleanly leaves a dangling error with no resolution line. A
    *different* error message while already erroring still logs (an
    unrelated failure B must not hide behind failure A's suppression). YT
    counts are receive-only in the Worker (`handleIngestYt`'s heartbeat
    branch) and only ever log `outcome: 'ok'` — an absent field there is a
    documented normal state (poller not live / not configured), not an
    error, so there's no Worker-side error signal for these two by design.
    That real gap (quota death or a revoked `YOUTUBE_API_KEY` silently
    freezing counts) is covered poller-side instead — see the poller
    heartbeat log below.
  - **`ctx.storage` exception for the Twitch user refresh token**: everything
    above is otherwise instance memory (see the no-`ctx.storage`-for-chat-state
    note above), but `getTwitchUserToken`'s refresh token is the one value
    persisted to `ctx.storage` (key `twUserRefreshToken`). Twitch rotates the
    refresh token on every use and invalidates the old one — losing it to a
    DO eviction would permanently break the followers feature instead of
    costing one cheap re-derive, so it can't live in memory like everything
    else here. `TWITCH_USER_REFRESH_TOKEN` (secret) only ever *seeds* the
    chain on first use; `ctx.storage` is the source of truth from then on,
    and is retried against the seed exactly once if the stored token is ever
    rejected (covers a manual re-consent + fresh `wrangler secret put`
    without a code change).
- **`src/worker.js` (entry module) vs `src/lib.js` (2026-07-22)**: workerd
  validates that every top-level named export of the ENTRY module (the file
  `wrangler.jsonc`'s `main` points at) is a function, class, or
  `ExportedHandler`-shaped object — a named export is a potential RPC/named-
  entrypoint target, and anything else fails local-dev boot (`wrangler dev`)
  with e.g. `Incorrect type for map entry 'EMIT_TTL_MS'`. This is enforced by
  the workerd binary itself, not a wrangler.jsonc/`compatibility_date` setting
  — root-caused via `cloudflare/workers-sdk#10213`, confirmed on both
  wrangler 4.112.0 and 4.113.0, and confirmed pre-existing (reproduces on an
  unmodified checkout via `git stash`). `export function`/`export class` are
  fine as entry-module exports; only *plain-value* exports (a number, an
  object literal, a `Set`) are rejected. The handful that existed
  (`PENDING_MOD_TTL_MS`, `PENDING_MOD_MAX`, `VALID_KINDS`, `TTS_LABELS`,
  `EMIT_TTL_MS`) now live in `src/lib.js` (a non-entry module, so no such
  validation applies) and are imported into `worker.js` for internal use;
  tests import them from `src/lib.js` directly. Every other pure
  helper/parser stayed in `worker.js` as a plain `export function` — those
  were never the problem.

## 2. Kind Table

Two independent tagging systems reach the client: `msg.kind` (financial /
money events, listed in `VALID_KINDS`) and `msg.sys` (non-financial system
events — raids, mod actions, room-state deltas). They're mutually exclusive
per message and render on different visual tiers.

### 2a. `VALID_KINDS` (`src/lib.js`) — gold/paid rows

Every kind gets the `.msg.paid` gold-tinted row + gold username (unless the
sender is a mod, which takes visual precedence — see `addRow`'s class
precedence comment, `src/worker.js:1825`).

| `kind` | Source | TTS label (`TTS_LABELS`) | Notes |
|---|---|---|---|
| `cheer` | Twitch `PRIVMSG` with a `bits` tag (`parsePrivmsg`) | "cheer" | `amount` = `"<N> bits"` |
| `sub` | Twitch `USERNOTICE` `msg-id=sub|resub` (`parseUsernotice`) | "sub" | `resub` appends `(<N> months[, <M>-month streak])` — read directly from `msg-param-cumulative-months`/`msg-param-streak-months` tags, not `system-msg` wording; absent/zero/unparseable tags omit the segment (`formatResubStreakInfo`) |
| `giftsub` | Twitch `USERNOTICE` `msg-id=subgift|submysterygift|giftpaidupgrade|anongiftpaidupgrade` | "gift sub" | |
| `superchat` | YT `item.superchat` (non-sticker) | "superchat" | `amount` = superchat amount string |
| `supersticker` | YT `item.superchat.sticker` | "super sticker" | |
| `member_new` | YT `item.membership`, non-milestone | "new member" | text falls back to `headerText` ("Welcome to X!") |
| `member_milestone` | YT `item.membership.milestone` | "member milestone" | text = `headerText — comment` when a comment exists |
| `member_gift` | YT `item.membershipGift` (classic `liveChatSponsorshipsGiftPurchaseAnnouncementRenderer`) | "gifted memberships" | `amount` = `"<N> gift(s)"` |
| `member_gift_received` | YT `item.membershipGiftReceived` | *(no label — excluded, see below)* | one row per redemption |
| `member_renewed` | optional external renewal cron via YT Data API, **not** the poller/IRC | "renewed member" | see §1 tendril note |
| `yt_gift` | YT `item.giftMessage` (newer Jewels/animated-gift **ViewModel**, `giftMessageViewModel` — structurally distinct from `member_gift`, no `count` field) | "gift" | `amount` = `item.giftMessage.giftName`; **no `timestampUsec`**, unlike classic renderers — see §7 gift-timestamp caveat |

**`member_gift_received` is deliberately excluded from vibrate/TTS eligibility**
(`emitCategory` returns `'silent'` for it — `src/worker.js`:
`msg.kind !== 'member_gift_received'`) — a 20-gift bomb arrives as one
`member_gift` (buzzes/speaks once) plus up to 20 individual redemption rows;
without the exclusion that would be 21 buzzes for one bomb.

`TTS_LABELS` (`src/lib.js`) has a coverage test
(`test/tts.test.js`) asserting every `VALID_KINDS` member except
`member_gift_received` maps to a real label — a future kind added to
`VALID_KINDS` without a label entry fails that test instead of silently
shipping as raw-kind speech (`formatUtterance` falls back to the raw `kind`
string if unmapped).

### 2b. `msg.sys` — gray info rows / glyphs / marking (not in `VALID_KINDS`)

| `sys` value | Source | Render treatment |
|---|---|---|
| `raid` | Twitch `USERNOTICE msg-id=raid` (`parseUsernotice`) | **Purple raid banner** (`.msg.raid`, border `#9147ff`, bold, 🎉 prefix) — promoted out of the gray tier specifically because a raid scrolled past unnoticed as gray noise on a real stream. Distinct double vibrate `[80, 40, 80]` via the same `isEmittable`/`fireEmission` gate as financial rows (fires once per id, live or replayed). No TTS — `emitCategory` maps `sys:'raid'` to category `'raid'` (buzz only, never spoken), never `'financial'`. |
| `announce` | Twitch `USERNOTICE msg-id=announcement` | Standard gray info row, `"<user>: <text>"` |
| `deleted` | Twitch: synthesized by `applyClearmsg` after `CLEARMSG`. YouTube: synthesized by `applyYtDelete`/`applyYtAuthorDelete` after a `{type:'mod'}` control POST (poller-parsed `markChatItemAsDeletedAction`/`removeChatItemAction`/`markChatItemsByAuthorAsDeletedAction`) | Gray row naming the author when the target/author is still in the 200-entry ring (`"<login>'s message deleted"` / `"<user>'s message deleted"` / `"<user>'s messages were removed"`), generic fallback text when it's scrolled out; **also** mutates the matching ring entry/entries in place (`entry.deleted = true`) so replayed rows arrive pre-struck, plus a transient live-only `mark` SSE event for already-rendered rows. Twitch matches by `twId` (`[data-twid]`); YouTube matches by `ytId` for a single message or `authorId` for all of one author's rows (`[data-ytid]` / `[data-ytauthor]`, `CSS.escape`d). **Twitch's row is suppressed when `esModerateHealthy` is true** (same rule as `timeout`/`ban` above — `channel.moderate`'s `delete` action owns the attributed row instead); the strike-mark always happens either way. YouTube is unaffected — no YouTube EventSub equivalent exists, see §3a. |
| `timeout` | `applyClearchat` — Twitch `CLEARCHAT` with a `ban-duration` tag | Gray row `"timeout: <login>, <N>s"` + same in-place `deleted` marking, matched by `login` (never display name — mod-action tags don't carry it). **Suppressed when `esModerateHealthy` is true** — `channel.moderate` (§3a) owns the attributed row instead; the strike-mark still always happens. |
| `ban` | `applyClearchat` — `CLEARCHAT` without `ban-duration` | Gray row `"ban: <login>"` + same marking by `login`. Suppressed under the same `esModerateHealthy` rule as `timeout` above. |
| `clear` | Bare `CLEARCHAT` (no trailing target — the "Clear Chat" button) | Gray row `"chat cleared"` **only** — never wipes the feed, never marks any row. **Never suppressed** — `channel.moderate` has no `clear`-equivalent action, so IRC keeps sole ownership regardless of `esModerateHealthy`. |
| `modact` | Twitch EventSub `channel.moderate` v2 (§3a) — owns 11 of its ~30 possible `action` values | Standard gray info row, `"<mod> <verb> <user>[ (<dur>)][ (shared chat: <source>)]"` — e.g. `"quotrok timed out baduser (10m)"`. Renders **only** while `esModerateHealthy` is true; IRC's own `timeout`/`ban`/`deleted` rows above are this feature's fallback, not a second copy. |
| `roomstate` | Non-first `ROOMSTATE` delta (`parseRoomstate`) — slow/subs-only/emote-only/followers-only/r9k | One gray row per changed setting's human-readable text. The **first** `ROOMSTATE` after each (re)connect is Twitch's full-state burst and is swallowed (`roomStateInit` flag, reset on every WS open) — never rendered. |
| `redeem` | Twitch EventSub `channel.channel_points_custom_reward_redemption.add` (§3a) | **Distinct teal row** (`.msg.redeem`, `#1fd1b5`) — `"<user> redeemed <rewardTitle>: <userInput>"` (input omitted when empty, e.g. button-only rewards). `rewardTitle`/`userInput` are ellipsized (64/200 chars) *before* they ever reach `pushMessage`/the ring — viewer-controlled EventSub text is never stored uncapped. Silent by design: `emitCategory` only treats `kind` or `sys:'raid'` as non-silent, so redemptions never buzz or speak. |
| `hype` | Twitch EventSub `channel.hype_train.begin`/`.progress`/`.end` (§3a) | Standard gray info row. `begin` and `end` always render; `progress` renders **only on a level-up** (DO tracks `hypeLevel`, reset on `end`) — every individual contribution otherwise fires `.progress`, which would flood the feed at exactly its busiest moments. The underlying bits/subs still render as their own gold IRC rows — nothing financial is lost by the suppression. |
| `ad` | Twitch EventSub `channel.ad_break.begin` (§3a) | Standard gray info row, `"Ad break — <duration>s"` (+ `" (auto)"` suffix when Twitch-initiated rather than manual). |
| `viewermilestone` | Twitch `USERNOTICE msg-id=viewermilestone` (`parseUsernotice`) — watch-streak notices | Standard gray info row, `system-msg` verbatim (e.g. `"<user> watched <N> consecutive streams and sparked a watch streak!"`). Rendered unconditionally off `msg-id`, not filtered on `msg-param-category`. Silent — not `sys:'raid'`, so `emitCategory` treats it as `'silent'`. |
| `modechange` | YouTube `liveChatModeChangeMessageRenderer` (patched parser → `{type:'mod', action:'mode_change'}` POST → `applyYtModeChange`) — ROOMSTATE parity for slow/sub-only/emote-only toggles | Standard gray info row, renderer's own `text.runs` verbatim, ellipsized to 200 chars server-side. |

### 2c. Other per-message flags (not a `kind`, not a `sys`)

| Flag | Source | Render treatment |
|---|---|---|
| `firstMsg` | Twitch `first-msg=1` tag | `✦` glyph prefix on an otherwise-normal row |
| `isMod` | Twitch `mod=1` tag or `broadcaster` badge; YT `item.isModerator`/`item.isOwner` | Blue username (`--role-mod`, `.user.mod`) — highest color precedence, wins even inside a gold financial row |
| `isMember` | Twitch `subscriber=1` tag **only** (a `founder` or `vip` badge alone grants no color); YT `item.isMembership` (badge-only signal, **not** a membership-money event — see the `member_*` kinds above for those) | Green username (`--role-member`, `.user.member`) — below a financial `kind`'s gold, above default |

Role color precedence (`roleClass()`, shared by both platforms): `isMod` > financial `kind` (gold) > `isMember` > default text color. Twitch's per-user `tags.color` is parsed nowhere and never applied — role color only, everyone else (including VIPs and founders with no independent subscription) renders in the page's default text color.
| `emotes` | Twitch `emotes` tag (`parseEmotes`) — entries `{id,start,end}`. YouTube custom emojis (poller `normalize.mjs`, worker `sanitizeYtEmotes`) — entries `{url,alt,start,end}` | Shared `renderText()` walker, one array, two entry shapes: Twitch derives the CDN URL from `id` (`EMOTE_ID_RE`-anchored before touching `img.src`); YouTube uses `url` directly (worker-side host-allowlisted at ingest, client re-checks as defense in depth — see §3). Both: inline `<img class="emote">` at text height, `onerror` falls back to the original text/shortcode. **`start`/`end` are Unicode code-point offsets (`[...str]` semantics), end inclusive, on both the Twitch and YouTube paths** — the poller computes YT offsets the same way the client walks them, verified by a multibyte fixture (astral + CJK + ZWJ-sequence emoji before a custom emoji). Standard unicode emoji never get an entry — they're plain text. |
| `recovered` | Gap-recovery paths (both platforms, §4) | `.msg.recovered { opacity: .55 }`. **No longer TTS-suppressed by the `recovered` flag** (2026.07.20.3): a financial row that landed during a connection blip and is replayed as `recovered` now buzzes/speaks **once** via the `isEmittable` id-set gate, because it carries a fresh monotonic id above the floor. Re-replays and already-heard ids are deduped by `spokenIds`; rows older than `EMIT_TTL_MS` (30 min) never fire. |
| *(uncaptured, unclassified)* | Any Twitch IRC line the parser doesn't recognize and isn't known connection/membership scaffolding (`isProtocolNoise`) | Never rendered — written to R2 capture (§4) as untrusted data, never dropped silently |

## 3. Trust Boundaries

| Secret | Header/param | Scopes | Notes |
|---|---|---|---|
| `MULTICHAT_VIEW_SECRET` | `?t=` query param on `GET /events` | Viewer SSE feed | Query-string auth is unavoidable — `EventSource` can't set headers. Appears in Cloudflare's own `/events` access logs (account-private). Accepted risk, kept as its own secret specifically so a leaked viewer link can't forge chat via `/ingest/yt`. Read client-side from the URL **fragment** (`location.hash`, never sent to the server on `GET /`); `<meta name="referrer" content="no-referrer">` blocks Referer leakage too. |
| `MULTICHAT_INGEST_SECRET` | `X-Multichat-Secret` header on `POST /ingest/yt` | yt-poller only | |
| `MULTICHAT_RAIDQ_INGEST_SECRET` | `X-Multichat-Secret` header on `POST /ingest/yt` | optional external renewal cron only | `handleIngestYt` accepts **either** ingest secret (`safeEqual` OR), but they're distinct values so neither caller can impersonate the other — that's the whole reason for the split. The edge threads *which* secret matched to the DO via an internal `x-multichat-caller: poller\|raidq` header; the DO's `{type:'mod'}` branch (chat-moderation control messages) requires `caller === 'poller'` and 403s otherwise — the renewal cron's plain chat-shaped renewal POSTs are unaffected, but it never gains the poller's mod-action capability just because both callers share this route. |
| `TWITCH_USER_REFRESH_TOKEN` | never sent over the wire — read server-side only, from `env` or `ctx.storage` | `moderator:read:followers` scope, already user-consented | Seeds the follower-count refresh chain (§1, "Live counts"). Not compared via `safeEqual` — it's a credential the DO presents to Twitch, not an inbound auth check. `ctx.storage` (not this secret) is the live source of truth once the chain has run once, since Twitch rotates the refresh token on every use. |
| `EVENTSUB_SECRET` | `Twitch-Eventsub-Message-Signature` header (HMAC-SHA256) on `POST /eventsub/callback` | Shared secret set on each subscription's `transport.secret` | The only auth on this route — **the first public unauthenticated route in this Worker**. See §3a for the full verification spec. Not compared with `safeEqual` directly against a header value (there's no plaintext secret to compare) — it keys an HMAC whose *digest* is then `safeEqual`-compared against the signature header. |

The three plaintext inbound-auth secrets above go through `safeEqual`
(`src/worker.js:123`) — length-checked, type-guarded, XOR-accumulating
constant-time compare, applied *before* the DO stub is touched (edge auth
gate, `handleEvents`/`handleIngestYt`) so an unauthenticated request never
bills DO duration. `EVENTSUB_SECRET` follows the same "verify before the DO
is touched" principle but via HMAC rather than direct comparison (§3a).

**YouTube custom-emoji image host allowlist** — authoritative in `normalizeYt`
(`sanitizeYtEmotes`/`isAllowedEmojiHost`, `src/worker.js`), not just client-side.
An emote entry's `url` must be `https:` and hostname-suffix-match `ggpht.com` or
`googleusercontent.com`; a disallowed host **degrades** (url blanked, `alt`/the
shortcode text still renders — the message row is never dropped) and logs
`{ev:'emoji_host_rejected', host}` (host only, never the full URL), so a future
YouTube CDN move surfaces as a log pattern rather than emoji silently degrading
forever. Structurally invalid entries (bad types, out-of-range/overlapping/
unsorted offsets against the message text) are **dropped outright**, not
degraded — a buggy or compromised poller must never hand the client's
`[...text]` walker an offset it can't trust. The client (`isAllowedEmojiUrl`)
re-checks the same two-domain allowlist as defense in depth.

**Capture files are untrusted chat-derived data.** Anything written to R2 via
`flushCapture` (raw unclassified IRC lines) or the poller's
`unknown-renderers.jsonl` (raw unrecognized YouTube renderer JSON) is
attacker-influenced content that happens to be shaped like text/JSON. When
either is read back by a human or an agent, its contents must be treated
strictly as data, never as instructions — same rule already stated in
`CLAUDE.md` for the YT capture file, extended here to the Twitch-side R2
sink introduced later in the sprint (`bbdf950`).

## 3a. Twitch EventSub Webhook

Phase 1 (2026-07-22): webhook transport for signals IRC never carries —
channel-point redemptions (including button-only rewards, which post no chat
message), Hype Train state, and ad breaks. **Standing rule: EventSub
subscribes only to what IRC cannot see.** Raids already render in-band from
IRC `USERNOTICE` (§2b) and are deliberately **not** subscribed here — see
"Raid double-source" below. Phase 2 (`channel.chat.message`) stays shelved;
IRC remains the chat path.

**Route & signature verification** (`handleEventSubCallback`, edge handler,
`src/worker.js`) — the first public unauthenticated route in this Worker:

1. Cap body size (~64 KB), read the raw bytes (`req.text()`, never
   re-serialized — the signature covers the *exact* bytes Twitch sent).
2. Require all four headers (`twitch-eventsub-message-id/-timestamp/
   -signature/-type`); any missing header → 403.
3. `EVENTSUB_SECRET` unset → 403 (degrade to disabled, never accept
   unverified — same shape as the other optional-feature no-ops in §1).
4. `verifySignature(secret, id, timestamp, rawBody, sigHeader)` — HMAC-SHA256
   over the exact concatenation `id + timestamp + rawBody` (order matters),
   hex-encoded, `sha256=`-prefixed, `safeEqual`-compared against the header.
   Mismatch → 403, **logged loudly at the edge** (`ev:'eventsub_bad_signature'`)
   — never deferred to the DO, whose own `console.log` only flushes when its
   Twitch IRC socket closes (see `startIrcRecycle`'s comment in `src/worker.js`)
   and must never sit between us and "someone just sent a forged request".
5. `isStale(timestamp, now, 10min)` — reject anything older than 10 minutes
   (Twitch's own replay-guard recommendation). Unparseable timestamp → stale.
6. `JSON.parse` the verified body; a parse failure here is **403, never a
   thrown 500** — fail closed at every step.
7. Branch on `Twitch-Eventsub-Message-Type`: `webhook_callback_verification`
   → 200 text/plain, body = the raw `challenge` (answered entirely at the
   edge, no DO, since a cold/evicted DO must never block the handshake);
   `revocation` → loud edge log (`ev:'eventsub_revoked'`, type + status) + 204;
   `notification` → forwarded to the DO's internal `/eventsub` route via
   `ctx.waitUntil` (ack 204 immediately, process in the background — Twitch
   requires a response within a few seconds); unknown type → 204, ignored.

**Signed-truth rule (security invariant).** The HMAC covers only
`id + timestamp + rawBody` — it does **not** cover any header, including ones
this Worker invents for its own edge→DO forward. So `subscription.type`/
`version`, wherever used for routing or event-mapping, is read from the
**parsed body's** `subscription` object (HMAC-covered), never from a header —
even a header we forward ourselves. Only `x-es-id` is forwarded edge→DO (the
already-verified message-id, used solely as the dedupe key, never for
routing); no `x-es-type`/`x-es-sub-type` header is ever sent. This closes a
replay path where a captured, still-validly-signed request could carry a
forged type header to mis-route.

**Dedupe** (`ChatHub.handleEventSub`, DO internal route) runs **strictly
before** any read of `subscription.type` or `mapEventToRow` — `this.
recentEventSubIds` (bounded `Set`, `addToBoundedSet`) gates first; a
message-id already seen is dropped and never reaches the mapper, regardless
of what the (untrusted) body claims about its type on the retry. Twitch is
at-least-once, so this is a live production path, not just defense in depth.
The `has()` check and the `addToBoundedSet()` insertion sit on the same
synchronous tick, with no `await` between them — inserting only after
`await req.json()` would leave a window where two near-simultaneous
redeliveries of the same id both pass `has()` before either records it,
producing a duplicate row.

**Hype Train level-gate** (DO instance state, `this.hypeLevel`): `begin` sets
it, `progress` renders a row only when `event.level` exceeds it (else
suppressed — per-contribution noise), `end` resets it to 0. Keeps a train to
~5 rows worst case regardless of how many individual cheers/subs contributed.

**Subscription lifecycle** (`ensureEventSubSubscriptions`, mirrors
`pollTwitchFollowers`'s Helix call shape): runs once per DO lifetime on the
first client attach, then re-checked on an **adaptive cadence** while clients
remain attached — piggybacked on the existing 15s viewer-poll cadence
(`maybeEnsureEventSub`), no dedicated alarm slot. While any desired sub is
unhealthy (missing, wrong-version, dead, or `EVENTSUB_SECRET`/broadcaster id
not yet set — `esAllHealthy` false) the recheck runs **hourly**, so a
late-placed secret or a dead sub self-heals within the hour; once every
desired sub is confirmed enabled at the correct version it backs off to
**once/day**. A live `revocation` notification doesn't wait for that cadence
at all: `handleEventSubCallback` pings the DO's `/eventsub-revoked` route
(`ChatHub.handleEventSubRevoked`), which resets `esAllHealthy = false` and
`esLastEnsured = 0` so the very next poll tick re-runs the reconcile
immediately rather than waiting out a stale daily interval. Twitch
subscriptions persist independent of DO lifecycle, so this on-wake ensure
(not a standing alarm) is what recovers from a DO eviction during the gap.
Lists subscriptions **without** a status filter (must see failed/revoked/
pending subs, not just enabled ones) and matches each desired sub on type +
version + callback + condition, branching per outcome: an exact match with
status `enabled` → left alone; `webhook_callback_verification_pending`
younger than 10 minutes → left alone (mid-handshake, never
duplicate-created), older → treated as dead; any other status on an exact
match (`authorization_revoked`, `user_removed`, `moderator_removed`,
`notification_failures_exceeded`, ...) → **loud `ev:'eventsub_dead_sub'`**
log + delete then recreate. A **same-slot subscription pinned to the wrong
version** (type/callback/condition match but `version` differs — e.g.
`version_removed` drift, or a stale v2 sub) is **not** treated as satisfied:
it's logged (`ev:'eventsub_version_mismatch'`) and explicitly deleted before
the correct-version sub is created. In both the dead-sub and wrong-version
cases, the replacement is only created **after the delete is confirmed
successful** (2xx or 404 — already gone counts) — proceeding to create on a
failed delete (logged `ev:'eventsub_delete_failed'`) would leave Twitch with
two enabled subscriptions of the same type, double-delivering every event; a
failed delete instead leaves that slot unhealthy for the next hourly retry.
A 409 on create is treated as benign (already exists, e.g. a race with a
prior ensure) and never fails the routine. Six of the seven subscribed types
use scopes the broadcaster already consented to, so those cost **0** against
the account's EventSub subscription limit; the seventh, `channel.moderate`,
needs its own separate 8-scope re-consent before it can ever go healthy —
see below.

**Chronic 403, root-caused and fixed 2026-07-28.** The "already consented"
claim above was false from 2026-07-22 through 2026-07-27: only
`moderator:read:followers` had ever actually been granted (from the
follower-count setup); the three EventSub scopes
(`channel:read:redemptions`, `channel:read:hype_train`, `channel:read:ads`)
were never consented, despite docs assuming they were.
a 2026-07-25 log audit found `channel.channel_points_custom_reward_redemption.add`
and `channel.ad_break.begin` 403ing on every single create, all night, every
hourly ensure cycle. Two diagnostics added 2026-07-25 helped confirm the
cause without guessing: `eventsub_create_failed` logs the Helix response
**body** alongside status (status alone left all 20 failures unexplained for
a full night); and a one-time-per-DO-lifetime `eventsub_scope_check` log
(`ChatHub.logEventSubScopeCheck`) reuses the existing follower-poll user-token
refresh chain (`getTwitchUserToken`) to read back that token's actual
`user_id`/granted `scopes` via `id.twitch.tv/oauth2/validate` and compares
`user_id` against `TWITCH_BROADCASTER_ID` — distinguishing a missing-scope
grant from a broadcaster/account mismatch (diagnostic-only, never blocks or
mutates the ensure routine, swallows its own failures). Fix: broadcaster ran
the manual OAuth authorization-code consent (`force_verify=true` to force a
real consent screen rather than silently reusing the old 1-scope grant) for
all 4 scopes at once against the existing registered Twitch app, producing
a new `TWITCH_USER_REFRESH_TOKEN`. Verified via CF Observability
(`workers/observability/telemetry/query`, not `wrangler tail` — see the
warning below): all 5 `/eventsub/callback` `webhook_callback_verification`
handshakes returned `200` within the same minute post-rotation, and follower
count populated live in the same session. If 403s resurface, suspect a
revoked/expired consent chain (re-run this flow) before suspecting a code
regression.

**`channel.bits.use` — Bits-funded power-up gold rows (2026-08-01).** Twitch's
chat "Power-ups" (Gigantify an Emote, Message Effect, On-Screen Celebration)
and broadcaster-defined Custom Power-ups (still Twitch BETA) don't set any
documented IRC tag carrying a price — `channel.bits.use` v1, Twitch's
all-purpose "any Bits use" event, is the only documented way to get gold-row
treatment (a real bits amount) for any of them. Full investigation trail in
an internal doc (2026-08-01). The event's
`type` field is `cheer` | `power_up` | `custom_power_up`; only `cheer` is
dropped before mapping — IRC's own `bits` tag already owns cheer rows, and
this event would otherwise double-render every one. `power_up` (all 3
built-in variants) and `custom_power_up` both get identical gold treatment,
since both cost real bits. Render mapping (`mapEventToRow`): a single new
`kind: 'power_up'` (`VALID_KINDS`/`TTS_LABELS`, `src/lib.js`) covers all 4
variants. The row carries `powerUpType`/`powerUpLabel` as server-side-only
fields (consumed by `mapEventToRow` and its tests) — `pushMessage`'s field
allowlist does not forward either to the client, so a viewer only ever sees
the rendered `text` field, set to the label (`event.custom_power_up.title`
for custom power-ups, ellipsized via the same `ellipsize()`/
`REWARD_TITLE_MAX` helper the channel-points redemption case already uses).
Both branches fail closed: an unrecognized `power_up.type` (a future Twitch
addition) or a missing/malformed `custom_power_up.title` drop the row
entirely rather than render a guessed/generic label — each drop logs a
`{ev: 'bits_use_unmapped', branch, type}` line so a real bits spend never
vanishes without a trace.

**No IRC/EventSub correlation exists.** Verified against Twitch's full
`channel.bits.use` event field reference
(`https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-bits-use-event`)
— there's no `id`/`message_id` field of any kind, nothing correlatable to an
IRC PRIVMSG's own `id` tag. If a viewer types a message alongside a
Gigantify/Message-Effect/Custom-Power-up use, IRC still delivers that text as
its own ordinary, non-gold PRIVMSG (IRC carries zero power-up/bits signal on
that line at all), and `channel.bits.use` separately delivers a second, gold
row summarizing the bits spent — two rows for one real-world action. This
still mirrors the existing precedent where a channel-points redemption's
optional `user_input` already renders as its own distinct `sys: 'redeem'`
row — not a new pattern, not a bug — for Message Effects and Custom
Power-ups, which keep this double-row behavior unchanged. On-Screen
Celebration is exempt from this double-row consideration entirely — it
never posts to IRC at all, so it produces only the one gold row.

**Gigantify an Emote double-display suppression (2026-08-08, selector +
unification pass 2026-08-08).** Gigantify specifically gets a best-effort fix
for the plain-row half of the double-row above:
`ChatHub.handleGigantifyDedupe`/`consumePendingGigantify` heuristically hide
the plain PRIVMSG, matched on same login + the gigantified emote within
`GIGANTIFY_SUPPRESS_WINDOW_MS` (10s, `src/lib.js`). Both arrival orders now
push every PRIVMSG through the exact same path — `handleIrcData` always calls
`pushMessage` first (ring/`recentTwitchIds`/`lastTwTmiSentTs`/SSE all fire
normally, gap-recovery-consistent by construction) — and suppression is
always a *second*, follow-up step: an in-place `superseded: true` ring
mutation plus a transient `mark` (`action: 'supersede'`) SSE broadcast via
`ChatHub.markSuperseded`, the same shape `markDeleted`/CLEARMSG uses. One
suppression mechanism, two triggers. A client hides a superseded row entirely
(`addRow` skips it, the `mark` listener removes an already-rendered one),
never strikes it through like a moderated message.

*Candidate selection (`selectGigantifyCandidates`/`pickGigantifyCandidate`,
`src/worker.js`).* IRC-first (the common case — PRIVMSG already in the ring
when the webhook lands) scans for candidates in two tiers: (1) prefer ring
rows whose own `emotes` tag data (copied verbatim from the PRIVMSG's IRC
`emotes` tag) contains the gigantified emote's id
(`event.power_up.emote.id`) — exact, can't collide on emote-name text; (2)
only when no id-tagged candidate exists, fall back to rows that carry no
emote data at all, matched by `gigantifyTextMatches` (a whole whitespace-
token match, not a bare substring — "Kappa" inside "KappaPride" doesn't
count) on the emote's name. A row that has emote data but no id match is
never eligible for the text fallback — its tagged emotes are known and don't
include this one, so a same-word text hit there would be a real collision,
not the gigantified message. Among the surviving candidates, the one
selected is whichever minimizes `|row.twTs − eventTs|` — `row.twTs` is
Twitch's own `tmi-sent-ts` tag value copied onto the ring entry by
`pushMessage`, and `eventTs` is `Date.parse` of the `Twitch-Eventsub-
Message-Timestamp` header, forwarded edge→DO as `x-es-ts` alongside `x-es-id`
in `handleEventSubCallback` (both are HMAC-covered inputs to
`verifySignature`, so forwarding either is the same "recoverable only via
header" case). Comparing two Twitch-side clocks avoids the DO's own receipt
clock, which would be skewed by exactly the kind of queueing delay this
selector exists to be robust against. A missing/unparseable `eventTs`, or an
exact tie, resolves to the newest candidate (ring-ordered, oldest first).
This replaced an earlier `ring.find()` (oldest-match) selector: picking
"first found" rather than "closest in time" meant a same-login
spam-then-gigantify sequence ("Kappa … Kappa … *gigantifies Kappa*") could
supersede the earlier, unrelated real message instead of the actual
gigantify PRIVMSG (see PR #41's own review finding F1, 2026-08-08). Zero
candidates in the window: IRC hasn't delivered the PRIVMSG yet (or never
will) — buffer `{login, emoteName, emoteId, ts}` in
`ChatHub.pendingGigantifies` (bounded to `PENDING_MOD_MAX`) for
`handleIrcData` to consume once it arrives, single-use, so one gigantify can
only ever suppress one PRIVMSG.

**The gold row itself is never suppressed, delayed, or gated on finding a
match** — worst-case failure mode is a duplicate plain row still showing,
never a vanished paid row. Redelivery-safe for free: the existing `x-es-id`
dedupe gate in `handleEventSub` drops a redelivered notification before
`handleGigantifyDedupe` ever runs, so a redelivery can't supersede a second
row or double-buffer. Because every PRIVMSG always pushes through the normal
path first, a disconnect shortly after a suppressed gigantify can no longer
resurrect it via gap recovery either: `recoverGap`'s `filterRecoveredMessages`
call excludes it on both of its independent guards — `recentTwitchIds`
already has its id, and `lastTwTmiSentTs` already advanced past its
`tmi-sent-ts` — where the pre-unification version's early `continue` (before
`pushMessage`) skipped both (see finding F2, closed by this same structural
change rather than a separate patch). Scoped to Gigantify only — Message
Effects share the same "no correlation id" gap but are mechanically identical
enough that a future extension could reuse this same machinery; deliberately
not done here to keep this change scoped to the one reported case. Flip side
of the same gap: `mapEventToRow` unconditionally drops `type: 'cheer'` (IRC's
own `bits` tag is assumed to own cheer rows), so if the Twitch IRC connection
is down when a cheer arrives, the EventSub `channel.bits.use` cheer event is
dropped too and the cheer never renders. Known, accepted — same
no-persistence posture as the rest of this Worker.

**Scope 403 diagnosis.** `createEventSubSubscription` failures for
`channel.bits.use` specifically get a `diagnosis` field
(`'scope_not_granted'` / `'not_a_scope_issue'` / `'scope_check_unavailable'`),
computed by cross-referencing the one-time-per-DO-lifetime
`eventsub_scope_check` result against whether `bits:read` was present —
gated to 403 responses only (a 400/401/404/500 gets no diagnosis, since
those aren't scope-related). This exists specifically to avoid repeating the
Chronic 403 incident's multi-day unexplained-403 pattern above, for this
newest scope. **Known staleness caveat**: the scope check runs once per DO
lifetime and is never refreshed — a `not_a_scope_issue` diagnosis reflects
the grant as of that one check, not a live guarantee, if the grant is
revoked mid-lifetime.

**Merge-order invariant.** Per the CLAUDE.md "Standing invariants" bullet on
EventSub scope additions, the broadcaster's single-URL 5-scope re-consent
must complete and be verified live before this feature's branch merges — else
this repeats the exact 2026-07-22→2026-07-28 chronic-403 pattern documented
above, just for `bits:read` instead of the original 3 scopes.

**Subscribed set** (`buildDesiredSubs`): `channel.channel_points_custom_reward_redemption.add` v1,
`channel.hype_train.begin`/`.progress`/`.end` **v2**, `channel.ad_break.begin`
v1, `channel.bits.use` **v1** — all with `condition: {broadcaster_user_id}`.
`channel.moderate` **v2** is the one exception, needing its own two-field
`condition: {broadcaster_user_id, moderator_user_id}` — see below. Hype Train was originally pinned to v1 — the fields actually read
(`level`/`total`/`progress`/`goal`) are identical between versions, and v1 is
what the installed `twitch-cli` 1.1.25 can mock (`event trigger ... -v 2`
errors "Invalid version given. Valid version(s): 1"). Moved to **v2** on
2026-07-25 after a 2026-07-25 log audit found production rejecting
every v1 create with a 400, all night, every hourly ensure cycle — Twitch's
current EventSub subscription-types docs only document v2 request/response
shapes for these three types, confirming v1 is sunset. The committed test
fixtures are now transcribed from Twitch's documented v2 example payloads
instead of live `twitch-cli` output, pending a real captured production
notification to replace them.

**Raid double-source decision.** IRC `USERNOTICE msg-id=raid` already renders
raids in-band, correctly ordered against surrounding chat, with no dependency
on EventSub subscription health. `channel.raid` is deliberately **not**
subscribed — adding it would either double-render every raid or require
suppressing the proven IRC path in favor of one with a dead-sub failure mode.

**`channel.moderate` v2 — moderator attribution (2026-08-05).** IRC's
`CLEARCHAT`/`CLEARMSG` never carry an actor — the `timeout`/`ban`/`deleted`
rows above can only ever name the *target*. `channel.moderate` v2 does carry
the acting moderator (`event.moderator_user_name`), so this feature adds it
as an eighth-condition-field desired sub and renders an attributed row
instead, wherever it's healthy.

*Condition & the moderator_user_id citation.* Unlike every other desired sub
(`condition: {broadcaster_user_id}` only), `channel.moderate` needs
`{broadcaster_user_id, moderator_user_id}` — set to the broadcaster's own id
for both. **`moderator_user_id` is an authorization identity, not an actor
filter** — Twitch's own docs example ("Payload Example - Adding a Moderator")
subscribes with condition `{broadcaster_user_id: "1337"}` (no
`moderator_user_id` at all) yet delivers an event whose `moderator_user_id`/
`moderator_user_login` (`"424596340"/"quotrok"`) is a different party than
the user acted on — proof the subscription isn't scoped to one moderator's
actions. This matches the documented pattern for sibling condition-having
types (`automod.message.hold`, `channel.unban_request.resolve`): "the ID in
the `moderator_user_id` condition parameter must match the user ID in the
access token" — i.e. it identifies whose grant authorizes the subscription,
not which moderator's actions get delivered. Because this is inferred from a
same-vendor sibling pattern rather than stated verbatim for `channel.moderate`
itself, it needs one live check post-consent: have a moderator **other than**
the broadcaster take an action and confirm the subscription still delivers
it, before leaning on "every moderator's actions are covered" as fact.

*Scopes — 8 new, on top of the existing 5.* v2's authorization is 8 OR-groups
(read variant chosen — least privilege for a display feature; 6 of the 8 also
accept a `manage:` alternative, the other 2 — `moderators`/`vips` — have no
manage alternative at all):
`moderator:read:blocked_terms`, `moderator:read:chat_settings`,
`moderator:read:unban_requests`, `moderator:read:banned_users`,
`moderator:read:chat_messages`, `moderator:read:warnings`,
`moderator:read:moderators`, `moderator:read:vips`. v2 does **not** need the
old v1 `channel:moderate` scope. Checked by `logEventSubScopeCheck`'s
`hasAllModerateScopes` (`MODERATE_SCOPE_GROUPS`, `src/worker.js`) — same
one-time-per-DO-lifetime diagnostic as `hasBitsRead`/`hasAllEventSubScopes`,
extended rather than duplicated.

*Merge-order invariant — 13-scope union, single re-consent.* Per CLAUDE.md's
"Standing invariants" bullet: the broadcaster's one OAuth authorization must
request all 13 scopes at once (the existing 5 — `moderator:read:followers`,
`channel:read:redemptions`, `channel:read:hype_train`, `channel:read:ads`,
`bits:read` — plus these 8) before this feature's branch merges, verified
live via CF Observability (`hasBitsRead && hasAllEventSubScopes &&
hasAllModerateScopes`, never `wrangler tail`) — never an incremental
per-scope consent, which would silently regress the others onto a narrower
token. Same failure class as the 2026-07-28 chronic-403 incident above, just
for a ninth scope group instead of the original three.

*Render mapping (`mapEventToRow`, `case 'channel.moderate'`).* 11 of the
~30 possible `action` values render (rest return `null` silently — frequent/
expected settings toggles, VIP/mod grants, raids, etc, never logged): the
core 6 — `timeout`/`ban`/`unban`/`untimeout`/`delete`/`warn` — plus the 5
`shared_chat_*` variants (un-deferred, not a follow-up: once
`applyClearchat`/`applyClearmsg` suppress their own row for an action
`channel.moderate` owns, IRC has no shared-chat-aware fallback row at all —
rendering these directly avoids making shared-chat moderation strictly worse
than before this feature). `<dur>` (`formatDuration`) **rounds** to the
nearest unit (`598s → "10m"`, never floored to `"9m"`). An **owned** action
with a missing/malformed expected field (schema drift — should never happen
per the documented payload shapes) logs `{ev: 'modact_unmapped', action,
reason: 'missing_fields'}` before returning `null`, mirroring
`bits_use_unmapped`'s fail-closed-and-loud precedent above.

*Ownership / dedupe — one action, one row, decided by health not timing.*
`applyClearchat`/`applyClearmsg` always strike-mark (`markDeleted`) regardless
of `channel.moderate`'s health — IRC is fast and works even if EventSub lags
or drops. Only the *attributed gray row* is gated: suppressed when
`this.esModerateHealthy` is true (channel.moderate renders it instead via the
normal EventSub notification path), pushed as today's target-only row when
false. This sidesteps EventSub-vs-IRC arrival-ordering entirely — ownership
is decided by subscription health, a piece of DO/config state, never by which
of the two deliveries happens to arrive first. Bare `CLEARCHAT` (`sys:'clear'`,
full-clear button) is never gated — `channel.moderate` has no equivalent
action, so IRC keeps permanent, unconditional ownership there.

*`esModerateHealthy` — persisted, not just in-memory.* Tracked and persisted
(`ctx.storage` key `esModerateHealthy`) at the end of every
`ensureEventSubSubscriptions` reconcile pass, mirrored into the in-memory
field read by `applyClearchat`/`applyClearmsg`. Hydrated in the constructor
via `ctx.blockConcurrencyWhile` (blocks `fetch()` until the read resolves) —
without this, a DO cold start (eviction between streams, a redeploy) would
default the flag to `false` in-memory while the real Twitch-side subscription
is still genuinely enabled from before, double-rendering every moderation
action until the next reconcile happened to run. Default `false` applies
**only** when no value has ever been persisted (first boot / pre-feature
DOs); once any reconcile runs, the persisted value always wins.
**Accepted mirror window:** the flag can still read stale-`true` for one
window — the sub is revoked/deleted server-side but no reconcile has run
since (DO evicted right after the last persist, or a fail-closed
`listEventSubSubscriptions` throw left the value unchanged). During that
window: **zero** moderation rows (IRC believes EventSub owns it and stays
suppressed; EventSub delivers nothing because the sub is actually dead) until
the next client attach triggers a reconcile, which observes the dead/missing
slot and flips the flag back. Bound: at most one attach-to-attach gap — the
same structural exposure `esAllHealthy` already has today, undocumented; this
plan is more conservative only in writing the bound down. Silent-zero-rows
is the deliberately safer failure direction versus silent-double-rows, which
is why the flag defaults conservatively and why this window is accepted
rather than engineered away.

*YouTube stays out of scope* — the anonymous YT feed carries no actor field
(per an internal audit, 2026-08-05), and existing YT deletion handling is already
classified; this is a Twitch-only feature end to end.

**No rate limit on `/eventsub/callback` (accepted).** It's the only public
unauthenticated route, but a forged/spam request is 403'd cheaply — body-size
cap, then HMAC verification — entirely at the edge, before the DO stub is ever
touched; cost per forgery is one edge invocation plus one HMAC. Twitch's own
source IPs vary, so an IP-keyed throttle risks rate-limiting legitimate Twitch
retries rather than an attacker. Accepted as-is rather than adding a
`ratelimits` binding.

## 4. Gap Recovery & Telemetry/Capture Sinks

### Twitch (server-side, in the DO)

- **Gap recovery**: on *reconnect* only (`isReconnect` in `ensureTwitchConnected`,
  never on first connect), fire-and-forget `recoverGap()` fetches
  `recent-messages.robotty.de` (a third-party community replay service),
  time-boxed to `RECOVER_TIMEOUT_MS` (3s hard cap — must never delay
  reconnect), filtered by `filterRecoveredMessages` against
  `lastTwTmiSentTs` (Twitch's own send-timestamp, not our receipt time — exact
  even if the DO was slow/evicted), a `RECOVER_MAX_AGE_MS` (10 min) floor, and
  `recentTwitchIds` dedupe. Recovered messages are marked `recovered: true`.
  Fetch failure of any kind is swallowed silently — the live reconnect already
  succeeded regardless.
- **Capture sink**: any IRC line not classified by a parser and not known
  connection/membership scaffolding (`isProtocolNoise`) is buffered
  (`captureBuf`, capped at `CAPTURE_MAX_BUFFER` = 500) and flushed to R2
  (`CAPTURE` binding → bucket `multichat-capture`, NDJSON,
  `capture/<date>/<uuid>.ndjson`) either on a mid-session burst trigger
  (`CAPTURE_FLUSH_LINES` = 50) or on teardown paths (idle-disconnect, socket
  drop, DO eviction risk) — those paths `await` the flush so the DO doesn't
  evict mid-write. A 30-day lifecycle rule on the `capture/` prefix
  self-cleans; this is exhaust, not archive. R2 write failures are logged
  (`console.error`) and dropped — capture must never block chat delivery.
  Covered by a permanent liveness test (`test/do-hardening.test.js`) that
  drives a synthetic unclassified line through `handleIrcData` and asserts the
  `CAPTURE.put` call fires — an empty bucket is provably good news, not a
  broken write path.
- **Structured connection/financial logging** (2026.07.20.3, added during
  remediation of an earlier chat-loss incident): every Twitch socket carries a per-connection `connId`
  (`crypto.randomUUID().slice(0,8)`, assigned in `ensureTwitchConnected`) and
  every SSE stream carries an `sseId`, threaded through `console.log(JSON...)`
  lines so a stream's chat-loss reports are attributable after the fact
  instead of "cannot attribute" (the prior state):
  - `tw_open {connId, reconnect}`, `tw_close {connId, code, reason, wasClean}`
    (from the `CloseEvent`, previously discarded), `tw_error {connId}`,
    `tw_reconnect_cmd {connId}` (Twitch's own `RECONNECT` IRC command, distinct
    from a network drop).
  - `sse_open {sseId, hadLastEventId}`, `sse_close {sseId, durationMs, reason}`.
  - `alarm {clients, socketOpen, connecting, action}` — `action` is one of
    `idle-teardown` / `reconnect` / `silence-close` / `noop`, logged
    unconditionally on every alarm firing (both the 60s watchdog and the 2min
    idle-disconnect share one alarm slot; this is what disambiguates them).
  - `reap {sseId, reason}` — `reason` is `backpressure` or `max-age` (see the
    zombie-reaping bullet below).
  - `do_fetch_timing {op, durationMs, outcome, span_id}` — wraps every
    awaited outbound fetch in `ChatHub`, nine `op` values in total:
    `helix_viewer_poll`, `token_refresh`, `backfill`, `app_token`,
    `follower_poll`, `eventsub_scope_check`, `eventsub_list`,
    `eventsub_create`, `eventsub_delete`, plus the pre-existing coarse
    `eventsub_ensure` wrapper (spans the whole ensure cycle, not each
    paginated/create/delete call inside it — deliberately not also
    `span_id`-tracked, to avoid double-counting the same wall-clock window
    its own nested fetches already cover individually). `outcome` is
    `ok`|`error` and refers to the fetch settling (resolve vs throw/abort),
    not HTTP status or body parse — an HTTP-500 response still logs `ok` with
    its durationMs. The span logs from a `finally`, so a hung/aborted fetch —
    the slow-then-failed case most likely to explain the tail — still emits
    with `outcome:'error'` instead of vanishing. Every span except
    `eventsub_ensure` also carries a `span_id` and is tracked in a
    module-level in-flight `Map`, feeding the `ingest_timing`/
    `ingest_delay_rollup` correlation below. No behavior change — added
    to attribute the ~15s p99 ingest-tail suspicion (median 2.5s, ~1ms CPU)
    to input-gate blocking on one of these awaits before redesigning
    anything. This hypothesis (H1, input-gate blocking) was since empirically
    falsified against real `workerd` — a concurrently-arriving `/ingest/yt`
    request is not deferred while another fetch is in flight — so
    `overlap_spans` non-empty no longer implies blocking on its own; a
    real-stream rollup would need `unattributed_ms` to dominate instead to
    support this path.
  - `ingest_timing {req_id, handler_ms, overlap_spans, overlap_ms}` — logged
    once per `/ingest/yt` request from `ChatHub.handleIngestYt`'s `finally`.
    `handler_ms` is this invocation's own wall-clock duration; `overlap_spans`
    lists the `span_id`s of any `do_fetch_timing` spans still open (per the
    in-flight `Map`) at the two snapshot points around the handler's one
    `await req.json()`; `overlap_ms` sums each open span's overlap
    independently (not a deduplicated union, so it can exceed `handler_ms`
    when multiple spans are open at once). `req_id` is forwarded from the
    edge's `X-Req-Id` header (`src/worker.js`, `handleIngestYt`) through to
    the DO's `stub.fetch` call, so it can be joined against the poller's own
    `rtt_buckets` (below) for the same logical request.
  - `ingest_delay_rollup {total_delay_s, over_1s, over_5s, over_10s,
    attributed_ms, unattributed_ms}` — change-gated, emitted from `alarm()`'s
    existing `finally` (both the ~60s watchdog tick and idle-teardown), so it
    fires roughly once a minute while clients are attached and once more as
    the last viewer disconnects. `over_1s`/`over_5s`/`over_10s` are threshold
    counts (an ingest over 10s increments all three), not exclusive tiers.
    `attributed_ms`/`unattributed_ms` are the per-request
    `min(handler_ms, overlap_ms)`/`max(0, handler_ms - overlap_ms)` split,
    summed and clamped so they always add up to total `handler_ms` — read
    these two, not raw `overlap_ms`, as the trustworthy aggregate: a nonzero
    `unattributed_ms` majority is the signature of delay with no fetch span
    open at all (consistent with burst-arrival serialization, a still-untested
    fourth candidate), while `attributed_ms` alone no longer implies causation
    per the H1 finding above.
  - `financial {platform, kind, user, amount, ts}` — one line per financial
    `pushMessage` call (see §2a's `kind` table for the set). **Never the
    message body** — same privacy rule as capture. This is what makes
    donations enumerable in Workers Observability going forward.
  - `tts_name_sep_candidate {name}` — fires alongside `financial`, only when
    the TTS-cleaned name (`cleanSpokenName`, Step1 only — trailing digits,
    absorbing one preceding `_`/`-`) still contains a separator. The
    speaks-what-buzzes invariant is intentionally relaxed for name suffixes:
    the spoken name may differ from the displayed one (`msg.user` itself is
    never touched). Exists solely to accumulate real separator-name cases for
    evaluating Step2 (a full trailing separator-segment strip, e.g.
    `darc-ttv` -> `darc`), which stays deferred/unimplemented — see the
    internal dry-run notes (2026-08-05).
  - Cross-referencing `tw_close`/`tw_open` against `sse_close`/`sse_open` by
    timestamp resolves "Twitch disconnects often" reports: IRC staying up
    while SSE drops points at the viewer's phone/LTE; both dropping together
    points upstream.
- **Overnight "Hiding" anomaly debug logging** (2026-08-18, `obs-debug-logs`):
  four gaps closed while chasing an overnight anomaly, each logged at
  ingest/decision time rather than reconstructed after the fact:
  - `gigantify_superseded {order, login, twId, entryTs, emoteName, emoteId,
    eventTs, pendingTs, windowMs}` — the single log point for the whole
    gigantify double-display dedupe feature (`ChatHub.markSuperseded`, called
    from both `handleGigantifyDedupe`'s IRC-first order and
    `handleIrcData`'s EventSub-first order via `consumePendingGigantify`).
    `order` is `'irc_first'` or `'eventsub_first'`; `eventTs` (IRC-first — the
    EventSub envelope timestamp `pickGigantifyCandidate` matched against) and
    `pendingTs` (EventSub-first — when the gold row was buffered) are
    mutually exclusive, whichever doesn't apply logs `null`. Previously zero
    server-side visibility into a supersede decision at all.
  - `yt_global_emoji_render {emojiText, alt, url}` — sampled
    (`GLOBAL_EMOJI_LOG_SAMPLE_RATE = 0.02`, `tools/yt-poller/normalize.mjs`)
    positive-path visibility for a successfully-rendered global/PUA YouTube
    emoji (the `isGlobalEmoji`/`PRIVATE_USE_EMOJI_RE` path from PR #42).
    Fires per global-emoji render at a 2% rate — this path is high-volume
    during an active stream (once per global emoji in every message), so
    full logging was rejected on cost/noise grounds; 2% is enough to catch a
    recurring bad `emojiText`/`alt` pair within a few dozen occurrences
    without meaningfully inflating log volume.
  - `tw_resub_streak_raw {login, rawStreakMonths, rawShouldShareStreak}` —
    logged in `parseUsernotice` for every `resub` USERNOTICE, before
    `parseStreakMonths`/`parseShouldShareStreak` (§2's streak-coverage logic,
    PR #38) interpret the tags at all. Not sampled — resub is rare relative
    to chat volume — added so an unexpected raw Twitch value (non-numeric
    `msg-param-streak-months`, an unfamiliar `msg-param-should-share-streak`
    string) is visible instead of silently absorbed into
    `undefined`/fail-open by the parsed fields.
  - `yt_gift_raw {giftName, giftImageA11yLabel}` — logged in `normalize.mjs`'s
    `item.giftMessage` branch, ahead of `yt_gift` classification.
    `giftImageA11yLabel` required threading a new field through the vendored
    parser patch (`tools/yt-poller/patches/youtube-chat+2.2.0.patch` — the
    `giftMessageViewModel` branch previously discarded the label after using
    it only as a `giftName` fallback source when the ViewModel's own text was
    empty); regenerated via the normal patch-package edit-then-
    `npx patch-package youtube-chat` flow and verified by reinstalling from a
    clean `node_modules`. Not sampled — `yt_gift` (paid Jewels/animated-gift)
    is a rare, human-triggered event, nowhere near per-message volume.
- **Zombie-client reaping** (2026.07.20.3): a half-open SSE controller whose
  `enqueue()` never throws (so the old enqueue-catch path never deleted it)
  and whose stream `cancel()` never fires can pin `this.clients.size > 0`
  forever — which both keeps `startHeartbeat()`'s interval alive (the
  2026.07.20.2 heartbeat-leak fix only stops it once `clients.size` reaches
  0, which a zombie prevents) and keeps the 60s watchdog alarm re-arming with
  no live viewer attached (this was behind a previously unexplained
  32-minute anomaly). `reapDeadClients()` runs on every heartbeat tick
  (`HEARTBEAT_MS` = 25s) with two independent backstops: (a) a controller
  whose `desiredSize` stays negative (unconsumed backpressure) across
  `REAP_STRIKE_LIMIT` (3) consecutive ticks is `close()`d and removed; (b) any
  stream older than `MAX_SSE_AGE_MS` (6h) is force-closed regardless —
  the client's existing `EventSource`/`Last-Event-ID` reconnect path picks it
  back up with no gap. Both paths route through `dropClient()`/`closeClient()`
  so `this.clients` and the new `this.clientMeta` (per-controller `sseId`,
  `openedAt`, `strikes`) stay in lockstep — the original enqueue-catch bug was
  exactly `this.clients.delete()` without the matching lifecycle bookkeeping.
  Covered by `test/do-hardening.test.js` (mock controllers with a scriptable
  `desiredSize`).

### YouTube (client-side, in the poller)

- **Gap recovery**: `tools/yt-poller/recovery.mjs`'s `classifyYtItem` — on
  reconnect (`ephemeral.armed = true`, set from `hasRunBefore`), items are
  self-classified by comparing their own YT timestamp against `armedAt` (wall
  clock when the new session was established): older = `recovered: true`,
  newer disarms recovery for the rest of the session. Bounded by
  `RECOVERY_AGE_CAP_MS` (10 min) and `RECOVERY_COUNT_CAP` (200), with an
  `ID_CACHE_SIZE`-bounded (200) dedupe set spanning the whole process
  lifetime (survives reconnects within one poller run, not process restarts).
- **Capture sink**: `capture.mjs` — any YouTube chat item whose renderer type
  the (patched) `youtube-chat` parser doesn't recognize is written raw to a
  bounded JSONL file (`/app/capture/unknown-renderers.jsonl`, rotates to `.1`
  past `CAPTURE_MAX_BYTES` = 5 MB) so new YouTube money-event formats (Jewels
  and whatever comes after) get harvested as real fixtures instead of
  silently vanishing. Counts also ride the poller's 15s heartbeat payload.
  **Extended to the action level**: the patch also surfaces any top-level
  live-chat *action* key the parser doesn't recognize (`rendererType:
  'unknownAction'`) — not just unrecognized renderers nested inside
  `addChatItemAction` — through the same sink, closing the gap for whatever
  other action types YouTube ships. `addLiveChatTickerItemAction` (a summary
  ticker that rides alongside a superchat/membership's own `addChatItemAction`)
  is the one known-benign action type still silently dropped, to avoid
  flooding the capture file with a duplicate of data already delivered.
- **Mod actions**: `markChatItemAsDeletedAction`/`removeChatItemAction`
  (single-message delete) and `markChatItemsByAuthorAsDeletedAction`
  (author-level removal) are parsed by the patch into control items
  (`rendererType: 'deletion'` / `'authorDeletion'`) and POSTed to
  `/ingest/yt` as `{type:'mod', action:'delete', ytId}` /
  `{type:'mod', action:'author_delete', authorId}` — routed through the same
  retry queue as chat (never fire-and-forget). The DO applies them via
  `applyYtDelete`/`applyYtAuthorDelete`, mirroring Twitch's
  `applyClearmsg`/`applyClearchat` exactly: mark-in-place + a gray info row,
  named by author when the target is still in the ring (§2b). Because the
  retry queue dispatches in concurrent batches (below), a delete can reach
  the DO before its target message — `applyYtDelete`/`applyYtAuthorDelete`
  buffer that miss into `pendingYtDeletes`/`pendingAuthorDeletes` (ytId/
  authorId → timestamp, bounded to `PENDING_MOD_MAX` = 64, TTL
  `PENDING_MOD_TTL_MS` = 5 min) instead of silently no-oping; `pushMessage`
  checks both maps on every yt insert and marks the entry deleted (plus a
  live `mark` broadcast) the moment it lands, so a late-arriving message
  still shows struck through.
- **Ingest resilience**: the poller's `retry-queue.mjs` is the single send
  path for every non-heartbeat message (live and recovered alike) — a bounded
  queue (`RETRY_QUEUE_MAX` = 50) drained at `SEND_CONCURRENCY` = 4 to avoid a
  cold-boot history-burst stampede (observed live: 27 concurrent bare
  `fetch()`s starved each other past a 10s client timeout even though the
  Worker answered every one in single-digit ms). Failed sends re-queue at the
  front (FIFO *enqueue* order preserved) with backoff
  (`RETRY_BACKOFF_INITIAL_MS` = 5s → `RETRY_BACKOFF_MAX_MS` = 60s, only
  resetting to floor on a fully clean batch). That FIFO guarantee covers
  requeue-on-failure only — up to 4 items in a batch are sent concurrently via
  `Promise.all`, so there's no guarantee they *arrive* at the Worker in
  enqueue order; chat message ordering has never depended on that, but the
  mod-action pending buffer above exists specifically because delete/
  author_delete ordering does. Heartbeats bypass the queue entirely — losing
  one is meaningless.
- **Poller heartbeat log (2026-07-28)**: every 15s heartbeat cycle
  (`poller.mjs`'s top-level `setInterval`, NOT live-gated — it runs
  identically whether a stream is live or not) logs one bounded line:
  `{ev: 'poller_heartbeat', fetched, posted, failed, status, counts,
  rtt_buckets, rtt_max_ms, rtt_count}`.
  `fetched` = chat items received from `youtube-chat` this cycle (all
  renderer types); `posted` = `post()` attempts for non-heartbeat messages
  this cycle (retry re-sends go through `sendOnce` directly via
  `drainBatch`, never back through `post()`, so they can't inflate this past
  `fetched`); `failed` = `sendOnce` failures this cycle, which *does*
  include retry re-attempts (a retry storm this cycle is itself useful
  signal); `status` = this cycle's own heartbeat `POST /ingest/yt` result
  (`res.ok`); `counts` = `'skip'` (no `YOUTUBE_API_KEY` or no live video id
  — feature not configured / nothing live, matches `fetchYtCounts`'s own
  no-op check), `'ok'` (counts fetched), or `'err'` (key + video id present
  but `videos.list` still came back empty — quota death, revoked key,
  malformed response; previously silent and indistinguishable from `'skip'`
  on both sides of the wire). Because the interval always runs, log silence
  itself (not any of these numbers) is what means the poller process died —
  never ambiguous with "stream is offline". `rtt_buckets`/`rtt_max_ms`/
  `rtt_count` (instrument/ingest-tail) give the caller-side RTT distribution
  for this cycle's `sendOnce` calls; every `/ingest/yt` POST from the edge
  carries the same `X-Req-Id` the DO's `ingest_timing` line logs, so a slow
  request can be joined across both log streams by that id to tell a
  poller-side retry-floor delay apart from a genuine DO-side stall.
- **Stuck-session self-heal**: `youtube-chat`'s poll loop doesn't recover from
  a broken chat session on its own (stale continuation token) — the poller
  forces a reconnect after `MAX_CONSECUTIVE_ERRORS` = 8 consecutive `error`
  events (`poller.mjs`).
- **Stream-not-live retry cadence** (2026.07.20.3, TRIAGE remediation): the
  2026-07-20 incident's ~8-9 min stream-start ingest outage was
  `"Live Stream was not found"` repeating while `scheduleReconnect`'s normal
  exponential backoff climbed toward `MAX_BACKOFF_MS` (60s) — pure discovery
  lag, since there's no load to back off from when the stream literally isn't
  live yet. `scheduleReconnect` now takes an explicit delay:
  `isStreamNotFound(lastErrorMsg)` (matches `/stream was not found/i`, keyed
  off the exact error text the `error` handler and `start()`'s catch both
  already log) routes to a constant `NOT_FOUND_BACKOFF_MS` (20s) that does
  **not** grow `backoffMs` — a real error afterward still gets the full
  exponential ramp it needs. Idle poll cost on the poller host at 20s is trivial; this
  bounds discovery lag to roughly that plus YouTube's own propagation delay.

## 5. Client Features

All client behavior lives in the inline `<script>` inside `PAGE_HTML`
(`src/worker.js`, from `~934` on).

- **Newest-at-top feed**: `addRow` does `feed.insertBefore(row, feed.firstChild)`;
  `MAX_ROWS` (300) trims from the bottom. Auto-scrolls to top unless the
  viewer has scrolled down into history (`paused`, tracked via `isNearTop()`),
  in which case new rows increment an unseen counter surfaced by the `#resume`
  pill ("N new ↑").
- **Retroactive marking**: mod actions (delete/timeout/ban) mutate the
  server-side ring in place (`deleted: true`) so *replayed* rows arrive
  pre-struck (no client reconciliation protocol needed) — see §2b. Live
  clients additionally get a transient `mark` SSE event to strike
  already-rendered rows via `[data-twid]`/`[data-login]` selectors.
- **Emotes**: native Twitch CDN images inline, dark/static variant, text
  fallback on load failure (§2c).
- **TTS read-aloud**: default-off `#speakToggle`
  (🔊/🔇). Buzz and speak fire from **one shared gate**, `fireEmission(msg,
  buzzPattern)`, which calls `isEmittable(msg, {floor, spokenIds, now})` —
  `emitCategory(msg) !== 'silent' && msg.id > floor && !spokenIds.has(msg.id)
  && now - msg.ts < EMIT_TTL_MS` (30 min). `emitCategory` decides the outputs:
  `financial` → buzz + speak, `raid` → buzz only, everything else → silent.
  **Speak-once-per-id semantics (2026.07.20.3, TRIAGE remediation)** replaced
  the old `liveThreshold` 300ms time window and the `!recovered` gate — those
  swallowed a donation that landed during a connection blip (replayed as
  `recovered` after reconnect). Now each financial id fires at most once, live
  or replayed: `floor` is the high-water mark of fired ids, `spokenIds` is a
  `Map<id, ts>` of recently-fired ids (pruned past `EMIT_TTL_MS`), and both
  persist to `localStorage` (`multichat-spoken`, alongside `lastMsgId`). A page
  reload / iOS background revival therefore behaves like a reconnect: the
  restored `lastMsgId` requests the gap replay, and donations that arrived
  while away fire once instead of being re-floored into silence — while a
  **stale** persisted floor cannot flood, because the `EMIT_TTL_MS` age term
  gates every row older than 30 min (verified by
  `test/tts.test.js`'s stale-floor case). Fresh device / cleared storage
  degrades to floor 0 (plain live behavior). Device-capability checks
  (`navigator.vibrate`, `window.speechSynthesis`, the on/off toggle) are kept
  **outside** `isEmittable` and checked per call site — iOS Safari has
  `speechSynthesis` but no `navigator.vibrate`, so bundling capability into the
  shared boolean would make TTS permanently silent on the exact device this
  targets. `formatUtterance` never reads `msg.text` — raw chat text
  structurally cannot reach the synthesizer. Pending utterances cap at 3
  (`enqueueCapped`, drop-oldest). A 10s pause/resume keepalive works around a
  Chrome long-utterance auto-pause bug; it restarts on page reload *and* on SSE
  reconnect (`3191b8a`, `4ae441c`).
- **TTS audio unlock hardening A** (2026.07.20.3): a one-time `click`/`touchstart`
  listener (`unlockTts`, alongside the wake-lock re-acquire listeners) fires a
  silent zero-volume utterance inside the first user gesture when the toggle is
  persisted `on`, then removes itself — so iOS reviving a backgrounded page can
  no longer leave audio re-gated behind a toggle that already reads on (the
  §7 caveat this replaces).
- **Toggles and their `localStorage` keys**:
  | Toggle | Key | Values |
  |---|---|---|
  | Font size | `multichat-fontsize` | `large` / (absent = normal) |
  | TTS read-aloud | `multichat-speak` | `on` / `off` |
  | Speak-once ledger | `multichat-spoken` | `{floor, lastMsgId, ids: [[id, ts], ...]}` — persisted on `pagehide`/hidden, restored on load (§5 TTS speak-once) |
  | View token | `multichat-token` | raw secret string (fragment-seeded, or manually re-entered via ⚿) |
- **PWA installability, no service worker**: manifest +
  apple-touch-icon make the page Add-to-Home-Screen-able on iOS and
  installable on Android/Chrome. Deliberately no SW — this Worker has no
  cache-busting build step (no hashed asset filenames), so a caching SW
  risks serving stale client JS after a deploy (the DO/client protocol has
  shipped breaking changes before, see `RELEASE_VERSION` bumps in git log).
  An installed PWA's `localStorage` is a separate storage partition from
  mobile Safari — the font-size toggle, TTS toggle, and view token all
  reset once at install time. `resolveToken` (fragment-seeds-storage,
  fragment always wins over stale storage) covers first install and a
  rotated `MULTICHAT_VIEW_SECRET`: a fresh install link re-seeds storage;
  an already-installed app with a stale token uses the ⚿ manual
  "set token" control (same prompt UI as the first-run neither-present
  case) to get back in without needing a new install link.
- **Pull-to-refresh, installed PWA only**: gated on
  `matchMedia('(display-mode: standalone)')` — an installed PWA has no
  browser chrome to supply native pull-to-refresh, so this is the only
  refresh affordance on that surface; browser-tab Safari keeps its native
  pull and gets no competing gesture. `#feed` carries
  `overscroll-behavior: contain` so the custom drag doesn't fight rubber-band
  scroll-chaining to the page. Armed only at `feed.scrollTop <= 0` (covers
  WebKit's momentary negative overscroll at the top); the
  phase is a pure function of drag distance (`pullPhase(deltaY, 70px)` →
  `idle`/`pulling`/`ready` — any upward drag reads `idle` and cancels
  cleanly, since that's normal scroll intent, not a pull). On trigger:
  shows a transient pill indicator, fetches `/api/version` and compares its
  `releaseVersion` against the client's own build-time-embedded
  `BUILD_VERSION` (`versionMismatch`, pure) — a mismatch means a new deploy
  shipped while the tab was open, and since this Worker deliberately ships
  no service worker (see above), a full `location.reload()` is the only
  update-pickup path. A version match instead reuses the existing
  stale-reconnect path verbatim (`connect()`: close + recreate the
  `EventSource` with the current `lastEventId`) — architecturally identical
  to what the `visibilitychange` staleness watchdog already does, so a
  manual pull is not a new code path. Because the server's SSE replay only
  ever resends ring entries with `id > lastId`, and `lastMsgId`/`spokenIds`/
  `floor` are left untouched by the pull handler, a resync at the current
  high-water mark is silent: no duplicate rows (nothing to replay), no
  re-buzz/re-speak (`isEmittable`'s `spokenIds` gate already covers replay,
  live or manual). The indicator settles on the first `message`/`status`
  event off the *new* socket, or a 3s timeout either way. The pull gesture's
  `touchstart` on `#feed` bubbles to the document-level `unlockTts` listener
  unchanged (nothing here calls `stopPropagation`), so a pull also serves as
  the first-gesture iOS audio unlock like any other tap.
- **Refresh button** (2026.07.30.2, haptics removed 2026-07-31): a `↻` button
  in the top-right of `#topbar` is the only manual (non-gesture) refresh
  affordance, on every platform — `⚿` moved to the far left of the row, and
  the old `#status` connection dot was removed (the tw/yt chip liveness dots
  and `#banner` already cover connection state, making the dot redundant).
  `refreshReconnect()` is the shared reconnect core — the same `/api/version`
  + `versionMismatch` + `connect()` logic `triggerPullRefresh` always used,
  factored out so the button and pull gesture share one path and one
  in-flight guard (`refreshBusy`, distinct from pull's own `pullBusy`). A
  `pendingRefreshConfirm`/`refreshConfirmTimer` pair clears `refreshBusy`
  once the refresh actually resolves — consumed by the next SSE message
  within ~5s, or cleared by the timeout / a version-mismatch reload — with no
  haptic feedback attached to it (an earlier iOS `<input type="checkbox"
  switch>` haptic workaround was removed entirely: JS-triggered haptics have
  been dead on iOS Safari since 26.5, an *invisible* overlay never worked,
  and a *visible* native switch worked but was a confusing, inconsistent
  control across platforms — simpler to have no haptic anywhere for refresh
  than a plain button on Android/desktop and a switch on iOS). Ordinary live
  messages never touch this path — only financial/raid rows keep their
  existing `fireEmission` buzz, which is a separate feature.

## 6. Deploy Runbook

1. **Diff review** — before deploying, review the diff against the
   `deployed/multichat` tag (`git log deployed/multichat..HEAD`) for
   correctness, security, and docs impact. Fix anything high-severity,
   re-review, repeat until clean.
2. **Tag + push rule** — deploy only from a `main` checkout (never a
   worktree or feature branch — merge to main first). After a successful
   `wrangler deploy`, retag: `git tag -f deployed/multichat && git push -f
   origin deployed/multichat`. The gate isn't done until `git push origin
   main` too — a deployed-but-unpushed `main` leaves the next session's
   diff review pointed at a baseline nobody else can see.
3. **Poller (`tools/yt-poller/`) rollout** — the poller runs on an
   always-on host outside Cloudflare (your compose host), in a Docker Compose
   stack directory of your choosing. It is **rsync'd from this repo, never
   hand-edited on the host** — see `CLAUDE.md`. Rollout pattern:
   - `rsync` the `tools/yt-poller/` contents to the stack directory on your
     compose host — e.g. `rsync -a --exclude=node_modules tools/yt-poller/ user@YOUR_POLLER_HOST:/path/to/your/stack`.
     The exclude matters: a bare `rsync -a` also syncs your local (gitignored)
     `node_modules` into the host's — cross-platform-built modules clobbering
     the host's own, harmless to the Docker build (the Dockerfile's `COPY`
     never touches it) but wrong for the host-level "local `node poller.mjs`"
     debug path (2026-08-17 incident).
     This is the exclusive deployment path; no other route (manual SSH edits,
     `docker cp`, editing via a stack-management UI's own file editor) is
     valid.
   - Rebuild the stack (your stack manager's rebuild action, or
     `docker compose build && docker compose up -d` from that directory) so
     `npm ci`/`patch-package`/Dockerfile `COPY` all re-run against the new
     source.
   - **Rollback-tag pattern**: mirror the Worker-side `deployed/<worker>`
     git-tag convention — tag the last-known-good poller commit
     (`deployed/multichat-yt-poller`, moved forward on every successful
     rollout) so a bad rollout can be rolled back by re-rsyncing that tagged
     commit and rebuilding, rather than by hand-reconstructing what was
     running. This is the durable fallback (works even if the Docker image
     tag below has since been pruned) — for the fast path actually used in
     practice (retag + recreate, no rebuild), see step 4.
4. **Rollback** — both stages have a same-day tag pair (`rollback-YYYY-MM-DD`,
   pointing at the PREVIOUS deploy's commit/image, cut *before* the new
   deploy per the tag law in step 2/3 above). Literal commands, not just the
   tag convention:
   - **Worker, fast path** (traffic-split rollback, no redeploy needed): find
     the prior Version ID — `wrangler versions list --config wrangler.jsonc`
     (the one just before today's, timestamp-ordered) — then
     `wrangler versions deploy <prior-version-id>@100 --config wrangler.jsonc`
     to send 100% of traffic back to it. This is the CLI's actual rollback
     primitive (there is no `wrangler rollback`/`wrangler versions rollback`
     subcommand as of wrangler 4.x — confirmed via `--help`, don't guess the
     name under pressure).
   - **Worker, full path** (if the fast path's version has since aged out of
     the 10-most-recent list `wrangler versions list` shows): from a scratch
     worktree pinned to the `rollback-YYYY-MM-DD` git tag, copy in
     `wrangler.jsonc` (gitignored, copy from any existing checkout — see the
     deploy-from-scratch-worktree pattern in step 2), then
     `wrangler deploy --config wrangler.jsonc`.
   - **Poller**: `ssh <user>@<poller-host>`, then —
     1. `docker tag multichat-yt-poller:rollback-YYYY-MM-DD multichat-yt-poller-multichat-yt-poller:latest`
        (compose builds locally with no explicit `image:` line, so the
        rollback is a retag onto compose's own computed image name, not a
        registry pull).
     2. `cd` to the stack directory, `docker compose up -d --force-recreate`
        (recreates the container from the retagged image — does NOT
        rebuild, since `up` without `--build` trusts whatever's already
        tagged).
     3. Verify before declaring it done: `docker exec <container>
        grep -c <sentinel-or-field> node_modules/youtube-chat/dist/parser.js`
        for whatever patch state the rollback target should have, plus a
        smoke ingest POST from inside the container (§8-style, secret read
        from the container's own env, never typed by hand).
   - **After either rollback**: move `deployed/<worker>` back —
     `git tag -f deployed/multichat rollback-YYYY-MM-DD^{}` (or the literal
     commit SHA) `&& git push -f origin deployed/multichat` — so the next
     session's diff-review baseline (step 1) reflects what's actually
     running, not the deploy that got rolled back.
5. **Rotating `MULTICHAT_INGEST_SECRET`** — same value must land on both the
   Worker and the poller; unlike `EVENTSUB_SECRET` this is an operational
   secret swap, not a code deploy, so the diff-review step above doesn't gate it.
   **Rotate off-stream only**: `wrangler secret put` publishes a new Worker
   version, which cycles the DO — in-memory ring/counter reset, SSE clients
   drop-and-resume. From the `multichat/` dir (confirm `wrangler.jsonc`
   `name` first — monorepo, no `--env` ambiguity):
   - Generate a fresh value as **hex** (`openssl rand -hex 32`) — no
     `/ + = & | \` chars, so it's safe unescaped in YAML, shell, `sed`, and an
     HTTP header.
   - `wrangler secret put MULTICHAT_INGEST_SECRET` fed from a temp file/stdin,
     never a shell literal (keeps it out of history).
   - The poller's copy lives in the **host-local** `docker-compose.yml`
     `environment:` block in the stack directory on the poller host — this
     is config, not source, so editing it there (not via rsync) is the
     sanctioned lane. Patch the `MULTICHAT_INGEST_SECRET:` line in place, then
     verify the edit actually landed (`sed` exits 0 even on a zero-match
     no-op) and that the YAML still parses (`docker compose config -q`)
     *before* recreating.
   - `docker compose up -d` to recreate the container (env changes need a
     recreate, not a bare `restart`).
   - Smoke test **from inside the container** (`docker compose exec`, reading
     its own env) — pass criterion is any non-401 status, since the auth gate
     runs before body parsing. Then confirm the *old* value now 401s.
   - **If the old value still succeeds**, it was aliased to
     `MULTICHAT_RAIDQ_INGEST_SECRET` (the privilege-confusion bug the split is
     meant to prevent, §Setup) — stop, don't delete the rollback backup, and
     rotate `MULTICHAT_RAIDQ_INGEST_SECRET` on both sides too.

## 7. Known Caveats

- **iOS: reload doesn't replay the audio-unlock gesture** — *addressed
  2026.07.20.3 by hardening A* (§5), still manual-smoke-only on-device.
  Previously, on a page reload with `multichat-speak` already `on`, no `speak()`
  ran inside a user gesture, so iOS could leave `speechSynthesis` gated behind a
  toggle that already read on and the first financial utterance after a reload
  could silently fail. The `unlockTts` one-time `click`/`touchstart` listener
  now fires a silent zero-volume utterance inside the first post-load gesture to
  unlock audio. Audible behavior and iOS unlock remain manual-smoke-only (not
  automatable via vitest); **TODO-verify** the hardening on an actual iOS
  device.
- **R2 first-`PUT` 501 retry.** Not documented or referenced anywhere in
  this repo's code, tests, or specs. **TODO-verify** — if this is a real
  Cloudflare R2 behavior (bucket cold-start returning `501` on an early
  `PUT`) that `flushCapture` or the poller's capture writes need to tolerate,
  confirm against current R2 docs/behavior and, if real, add a retry.
  `flushCapture`'s current error handling (`src/worker.js:543`) only logs and
  drops — it does not retry any R2 error class today.
- **`yt_gift` has no timestamp, gap-recovery classifies it as always-live.**
  `giftMessageViewModel` items carry no `timestampUsec` (unlike the classic
  renderers `member_gift`/`superchat`/etc.), per the `d96f4cb` commit
  message. `classifyYtItem`'s recovery check
  (`tools/yt-poller/recovery.mjs:40`) falls back to `Date.now()` when
  `item.timestamp` isn't a `Date`, which means a `yt_gift` item is compared
  against `armedAt` using the *current* wall clock — effectively always
  landing on the "live, not recovered" branch regardless of how old the
  underlying gift actually was. Conscious tradeoff embedded in the fallback,
  not a bug, but worth knowing if a `yt_gift` ever shows up unmarked
  `recovered` right after a poller reconnect when older items around it are.
- **Raid-queue renewal tendril depends on your external cron's own health.**
  See §1 — the `member_renewed` ingest path exists and is wired (secret,
  `VALID_KINDS` entry, TTS label), but whether it ever fires depends entirely
  on that external cron reaching the YouTube Data API. Not a multichat-side
  concern; nothing to fix here.
- **DO `console.log` flushes when the held Twitch WebSocket closes.**
  Verified 2026-07-21: entries
  aren't lost, but they sit buffered until `ChatHub`'s outbound Twitch IRC
  socket next closes/reconnects — delay is proportional to that socket's
  lifetime, not to when the event actually happened. `wrangler tail`/real-time
  logs can show nothing for minutes at a time; Workers Observability (queried
  over a wide-enough window) always has it. Logs are durable, not live —
  don't use a short tail window as evidence something didn't log. The
  client-initiated IRC keepalive (below) fixes the ~2-3min tw_close cadence
  that made this easy to notice — but a healthy connection now living for
  hours (as intended) means the flush delay gets *longer*, not shorter, in
  the common case. **Bounded 2026-07-22**: `startIrcRecycle()`/`stopIrcRecycle()`
  cleanly close (code 1000) and let the existing reconnect + `recoverGap()`
  backfill + dedupe heal the seam every `IRC_RECYCLE_MS` (30min) of socket
  lifetime, independent of the keepalive timer — so forensic-log latency is
  now capped at 30min regardless of how long the underlying connection
  otherwise stays healthy. Accepted tradeoff: these logs are forensic (query
  after the fact), not a live stream — don't build anything that assumes
  near-real-time delivery on them. Relatedly, the `query_worker_observability`
  MCP tool's `events`/`invocations` views zod-throw on DO-internal rows where
  `$workers.outcome` is null — an intermittent Cloudflare telemetry gap on
  `ChatHub` invocations, not deterministic by route (confirmed 2026-08-02: same
  route shows both populated and null `outcome`). Use the `calculations` view
  with a `groupBy $workers.entrypoint` and an `is_null` filter on
  `$workers.outcome` instead — it doesn't validate that field and returns
  accurate counts either way.
- **Twitch socket was cycling every ~2-3min off-stream (root-caused
  2026-07-21, fixed same day).** 30/30 `tw_close` events in a 76min
  Observability window were code `1006` ("WebSocket disconnected without
  sending Close frame."), `wasClean:false` — a pure network-level drop, not
  our own watchdog (`alarm` action was `noop` 53 times, `reconnect` once,
  `silence-close` once) and not Twitch's own `RECONNECT` command (0 received).
  Fix: `startIrcKeepalive()`/`stopIrcKeepalive()` send a client-initiated
  `PING :ka<n>` every `IRC_KEEPALIVE_MS` (60s) while the socket is open —
  Twitch's `PONG` reply is inbound traffic that feeds `lastSeen.tw` exactly
  like an inbound Twitch `PING` would, turning `IRC_SILENCE_MS` (6min) from a
  bet on Twitch's own ping schedule (margin was ~1min if Twitch pings every
  ~5min — and one `silence-close` fired at the 5m36s mark off-stream, using
  nearly the whole window) into a true-death detector with ~5 missed PONGs of
  margin. Timer starts on `open`, stops on every teardown path (network-drop
  `handleSocketDown` and the alarm's manual idle-teardown both call
  `stopIrcKeepalive()`) — never runs while disconnected. Post-deploy
  verification: `tw_close` over a 60min window should collapse from ~30/76min
  toward zero, zero `silence-close`, alarm still mostly `noop`.
- **`tw_user_token_refresh_failed` can permanently strand a DO's EventSub
  scope check.** `getTwitchUserToken()` (§1 "Live counts" refresh chain)
  logs `{ev: 'tw_user_token_refresh_failed', source}` when the stored
  refresh token, and then the seed, both fail — most often a transient
  window where `TWITCH_CLIENT_SECRET` was just rotated but a refresh call
  raced the old value. Observed 2026-08-01: 6 hits (3 `storage_chain` + 3
  `all`) clustered tightly around two same-day `wrangler secret put` events,
  zero hits before or after — self-healed once the correct secret value was
  in place. The interaction worth knowing: `logEventSubScopeCheck` (§3a)
  sets `esScopeChecked = true` *before* attempting the token fetch and never
  retries for that DO's lifetime, so any DO instance whose first
  `ensureEventSubSubscriptions` call happens to land during one of these
  failure windows gets a permanent `no_user_token` scope-check result (and
  `scope_check_unavailable` diagnosis on any later `channel.bits.use` 403)
  for its entire lifetime — not refreshed until the DO itself is evicted and
  recreated. Didn't cause a visible problem in the observed incident only
  because zero subscription creates happened to 403 during the affected
  DOs' lifetimes. See the internal post-stream audit (2026-08-01) for the full
  incident writeup.
