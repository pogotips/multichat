# Changelog

<!-- CalVer entries (YYYY.MM.DD.N), matching RELEASE_VERSION in src/worker.js. -->

## [Unreleased]

## [2026.09.15.1]

### Fixed
- **Corrected a wrong-event bug from this same unmerged branch, before it ever shipped.** The original version of this entry claimed `USERNOTICE msg-id=rewardgift` was the points-funded emote-gigantify signal and wired a `pointsGigantify` gray/gold-sized row to it. Review found that's wrong on two independent counts: this repo's own internal streak-coverage audit (2026-08-08) already classified `rewardgift` as a generic, unrelated channel-points reward notice (never gold, no emote-gigantify connection); and an internal gigantify investigation (2026-08-01) already established that emote gigantify — bits- or points-funded — never sets *any* IRC tag at all (PRIVMSG has no `msg-id`, that tag is USERNOTICE-only), so the `rewardgift` branch could never have fired for a real gigantify event regardless. `rewardgift` now renders as its own honest gray kind (`rewardGift` flag, `.msg.reward-gift`) with no emote-gigantify claim, ordinary inline emotes only, no gold-sized image.

### Added
- **The real points-funded gigantify path**: `channel.channel_points_automatic_reward_redemption.add` (`reward_type: 'gigantify_an_emote'`) is now the 8th subscription in `buildDesiredSubs` — the only documented signal for this event (per the investigation doc above), same standing rule as `channel.bits.use` ("EventSub subscribes only to what IRC cannot see"). It reuses `channel:read:redemptions`, the scope already granted as part of the original 5-scope EventSub consent — **no new scope, no new re-consent required for this subscription specifically**. It's still held back from going live until the broadcaster's pending `channel.moderate` 13-scope re-consent ("consent day") completes and this branch merges after it, as a matter of process discipline (one coordinated EventSub deploy ceremony, not piecemeal ad hoc subscription creation) — see the consent-day runbook (internal, unmerged branch, on `feature/eventsub-mod-attribution`) and CLAUDE.md's standing invariants.
- Unlike `channel.bits.use`, this subscription never renders its own row (`mapEventToRow` always returns `null` for it — no amount, by design, same precedent as the plain `redeem` row). It feeds the existing `pendingGigantifies`/`consumePendingGigantify` bits-gigantify-dedupe correlation (`ChatHub.handleGigantifyDedupe`, `src/worker.js`) with a `points` marker instead: a match upgrades the correlated PRIVMSG in place (new `ChatHub.markPointsGigantify`) to carry `pointsGigantify: true` + the 3.0-scale emote — gray, gold-row-sized, no amount, no ledger entry, no buzz, no TTS — rather than superseding/hiding it the way a bits-funded match does. Every other `reward_type` on this subscription is structured-log-only (`automatic_reward_redemption_unmapped`), no row.
- Known gap, disclosed rather than silently accepted: this mutation is ring-authoritative (correct on every reconnect/replay) but not live — `pushMessage`'s own broadcast has already sent the plain PRIVMSG to already-connected clients by the time the correlation resolves (either arrival order), and no client `'mark'` handler exists to patch a rendered row's class + inject the gigantify image in place. Resume-reconnects replay only ids above `Last-Event-ID`, so an already-delivered row is never re-sent — the upgrade is visible only to sessions that replay the row from before its id (a fresh page load, or a viewer who connects after the upgrade lands).

## [2026.09.14.2]

### Fixed
- FASTFOLLOW 9: `YT_REACTION_EMOJI_RE` (`src/worker.js`) now requires at least one pictographic base codepoint (`\p{Extended_Pictographic}` or `\p{Regional_Indicator}` — flags carry no Extended_Pictographic) via a lookahead. A key made entirely of joiners/modifiers (ZWJ, VS16, skin-tone modifier, U+20E3 keycap combiner) previously passed the pure alternation; all real single/VS16/skin-tone/ZWJ-family/flag sequences still pass.
- FASTFOLLOW 10: the `/ingest/yt` heartbeat branch (`handleIngestYt`) is now caller-scoped like the `yt_reactions`/`mod` branches — a non-`poller` caller (e.g. the raidq membership-renewal cron's secret) gets 403 instead of being able to spoof `ytViewers`/`ytLikes` or the YT liveness clock. Plain chat POSTs (the raidq cron's actual lane) are unaffected.
- FASTFOLLOW 11 (yt-reactions review LOW-1): the poller no longer POSTs a `yt_reactions` payload whose per-emoji map is empty (same-usec growth with an unchanged emoji map, or nonzero buckets whose `reactionsData` YouTube omitted) — `reactionPostPayload` (`tools/yt-poller/capture.mjs`) returns `null` and the poller skips the POST, ending the recurring 400 `bad reactions shape` noise during real bursts. `lastReaction` still advances; `reactionsSeen` keeps counting posted bursts only (review NIT-2: comment added at the increment). Poller-side, rides the next poller deploy.

## [2026.09.14.1]

### Added
- Live YouTube reaction bursts (heart/like fountain), end to end: the yt-poller, PWA topbar, and OBS overlay. `get_live_chat` carries these at `frameworkUpdates.entityBatchUpdate.mutations[].payload.emojiFountainDataEntity` — a shape `youtube-chat` discarded entirely before parsing; intermittent (absent on most polls), with `reactionsData` itself omitted on an all-zero bucket.
  - **Poller**: `patches/youtube-chat+2.2.0.patch` extended to surface `frameworkUpdates` mutations as `rendererType:"emojiFountain"` chat items (same tag-not-new-emitter mechanism the existing patch already uses). Per-poll per-bucket detail lands in a log-only `./capture/reactions.jsonl` (5MB-capped, same rotation as `unknown-renderers.jsonl`); the aggregated `{emoji, intensity}` summary posts through the normal `/ingest/yt` lane as a new `yt_reactions` message type — pushed only when a poll's bucket total is nonzero, bypasses the retry queue (same "stale snapshot, not worth retrying" treatment as heartbeat). `poller_heartbeat` gained a cumulative `reactionsSeen` field. New standalone `tools/yt-reactions-probe.mjs` polls any live video's `get_live_chat` directly (no poller/broadcast needed) to check whether it's emitting the entity at all.
  - **Worker**: `handleIngestYt` accepts `type: 'yt_reactions'`, validated by `sanitizeYtReactions` (emoji keys must match `\p{Extended_Pictographic}`, counts are capped positive integers, top 20 by count survive) before folding into `buildStatusPayload` as `reactions: {emoji, intensity, ts}` — never touches the ring, never replayed, decays to `null` after 15s (`YT_REACTIONS_STALE_MS`) so a fresh SSE connect never shows a burst that already faded client-side.
  - **PWA**: a `#reactions` topbar cell (empty/zero-width when quiet or YT isn't live, same `:empty{display:none}` pattern as the count cells) accumulates incoming bursts over a rolling 10s client-side window, shows the top 4 emoji by count, and briefly pulses at intensity ≥ 0.75. No buzz, no TTS.
  - **Overlay**: emoji particles rise up the right edge on receipt of a burst, capped at 8 spawns/sec, size/speed scaled by intensity. New `reactions` `OVERLAY_PARAM_SPEC` param (default **off** — an opt-in new animated element, unlike `gifAlt`'s opt-out-of-existing-content posture) gates it per scene, editable from the existing `/overlay/config` builder with no new UI code (params render generically from the spec). New `src/lib.js` helpers `reactionSpawnUnits`/`spawnReactionParticle`, added to `test/bundle-gif-render.test.js`'s `PAGE_HELPERS` transitive-interpolation scan.

## [2026.09.12.2] — docs/tests/poller only, no RELEASE_VERSION bump

### Fixed
- M1 (ChatHub review of 2026-09-12, internal): `tools/yt-poller/poller.mjs`'s zombie-watchdog threshold-selection and zeroStreak decision logic (`resolveLiveness`, `selectWatchdogThreshold`, `watchdogTick`) extracted into a new importable `tools/yt-poller/watchdog.mjs` — `zombie-watchdog.test.mjs` now imports the real decision function instead of re-typing it from source comments. Behavior byte-for-byte identical; heartbeat payload fields unchanged. Rides the next poller deploy, not the worker deploy.
- M3: the internal fast-follow list added to `.oss-exclude` (exact-name entry).
- L2: `POST /client-error` added to CLAUDE.md's route table.
- L3: `MULTICHAT_MY_NAME` documented in CLAUDE.md Setup and `docs/ARCHITECTURE.md` §5 (self-mention highlighting).
- L4: stale root backlog stub deleted — the internal backlog list is canonical.
- L8: `tools/yt-poller/test/ingest-tail-h2.test.mjs`'s clean-batch control test replaced a real-wall-clock `toBeLessThan` bound with scoped fake timers (`vi.getTimerCount() === 0`), removing a plausible CI-load flake — same pattern as the eventsub clock freeze (8e3e869).

## [2026.09.12.1]

### Fixed
- SSE replay gap now client-visible (ChatHub review of 2026-09-12, internal, finding H2): if more than `RING_SIZE` (200) messages landed since a client's `Last-Event-ID`, the gap between it and the ring's current floor was silently dropped — no signal, client or server. `buildStatusPayload` now carries `ringFloor` (oldest surviving ring id, or `null`); the PWA's `detectReplayGap` (`src/lib.js`) compares it against the reconnect's `Last-Event-ID` on the first `status` frame after open and, on a real gap, inserts one gray "reconnected, some messages may be missing" row (no id, never buzzes/speaks). `sse_replay_result` gained matching `ringFloor`/`gap` fields for the server-side audit trail.

## [2026.09.06.2]

### Fixed
- SSE auto-recovery: unified every client reconnect trigger (`onerror`/CLOSED, the stale watchdog, `visibilitychange`→visible, and the manual refresh button/pull-to-refresh) onto one path (`refreshReconnect`), so a stale connection recovers on its own instead of requiring a manual page refresh.
- Client-side id dedupe (`createSeenIdGate`, bounded ~400) — a duplicate delivery from Last-Event-ID replay racing a live broadcast across a reconnect now renders exactly once. Resets itself if an incoming id is ever lower than the highest seen (a real DO restart or clock skew), so it can never wrongly suppress a legitimate row.
- Watchdog no longer re-trips a socket that's still `CONNECTING`: it now re-arms its own staleness clock at the moment it attempts a reconnect, not only on the next real byte.
- Shared exponential backoff (`reconnectBackoffMs`, 1s→30s cap) now applies to watchdog-triggered reconnects too, not just `onerror`/CLOSED — one counter, so a watchdog trip can't hammer the server independently of a real-disconnect backoff already in progress. Resets on `visibilitychange`→visible and on any received SSE frame.
- Shared in-flight reconnect guard (`refreshBusy`) now also clears on the new socket's `onopen`/`onerror`, and its timeout is 20s (was 5s, and previously only reachable via the refresh-confirm path) — a hung `CONNECTING` socket can no longer pin it forever.
- Reconnect-attempt beacon (`POST /client-error`, `kind: 'reconnect_attempt'`) — trigger (`watchdog`/`onerror`/`visibility`/`manual`), attempt number, backoff ms, and the superseded socket's `readyState`, token-gated like the existing client-error beacon, on its own send cap so a reconnect storm can't starve real error reporting.

### Notes
- Server-side SSE replay (Last-Event-ID via header or `?lastEventId=`, and the immediate `status` snapshot on stream open) was already correct — verified, not changed, this pass.
- Overlay (`GET /overlay`) intentionally untouched: its reconnect logic is a separate, simpler implementation (no watchdog, no dedupe, no shared guard) that only shares `supersedeSocket` with the PWA — not the code this change touches.

## [2026.09.06.1]

### Added
- `?debug=1` query param on the PWA (never the overlay) renders one extra gray topbar row showing `RELEASE_VERSION` and the current gifs-toggle state (on/off). Read-only, never prints the auth token.

### Fixed
- `test/eventsub.test.js`'s `mapEventToRow: channel.moderate` `it.each` block froze the clock (`vi.useFakeTimers`/`vi.setSystemTime`, scoped `beforeEach`/`afterEach`) — closes the flaky duration-rounding race tracked in the internal fast-follow list, item 3 (two independent `Date.now()` reads, ~1ms apart, occasionally straddled a rounding boundary).

## [2026.08.25.1]

### Added
- OBS overlay (`GET /overlay`, `GET /overlay/config`) — a transparent-background browser-source page rendering the same live chat feed as the phone PWA, with server-validated config params (`bg`/`text`/`name`/`gold`/`mod`/`sub` colors, `font`, `fontSize`, `maxRows`, `rowTtlSec`, `order`, `outline`, `tts`, `ttsVolume`, `ttsBody`) via a single `OVERLAY_PARAM_SPEC` shared between the overlay and its config-page preview. Gated by a new `MULTICHAT_OVERLAY_SECRET`, independent of the existing view/ingest secrets so an OBS scene-URL leak (screen share, scene-collection export) can be rotated without disrupting the phone-bookmarked `/events` link. `GET /events` now accepts either the view secret or the overlay secret.
- Server-side TTS (`POST /tts`, Workers AI `@cf/deepgram/aura-2-en`) reads financial-row events aloud in the overlay. Metered entirely in the `ChatHub` DO (`handleTtsAllow`): 20 calls/min (in-memory, burst-shape only) and 25,000 chars/day (`ctx.storage`, UTC-midnight reset, the real spend ceiling — both checked and incremented as one atomic unit), plus a kill switch (`ctx.storage`, flipped via `POST /overlay/admin`). `/overlay/admin` is gated by a fourth, independent secret (`MULTICHAT_ADMIN_SECRET`) so overlay-secret leakage never grants kill-switch authority. Text is hardened server-side (control-char strip, URL strip, 200-char cap) independent of client input.
- `buildRow` (`src/lib.js`) — the PWA's inline row renderer extracted into a pure function (`msg`, `opts` → detached DOM node), shared by both the PWA and the new overlay. Pinned against a golden fixture generated from the pre-extraction renderer (`test/buildrow-parity.test.js`) so the extraction can't silently change either surface's output.
- "Deleted must mean unspoken": a `mark` event (mod delete/timeout/ban/supersede) drops the matching item from the TTS queue, including mid-fetch and mid-playback — closes two races (`currentCancelled`, `currentResolvePlayback`) where a struck message could still play, or `audio.pause()`'s lack of an `ended`/`error` event could permanently stall the queue.
- Reconnect replay (`replay: true` on a resent SSE frame) suppresses the overlay's row-entry animation only — TTS speak-once suppression still runs on the existing floor/spokenIds/`EMIT_TTL_MS` predicate, so a genuinely-missed financial message during a transient reconnect still speaks.
- Spoken-name cleanup (`cleanSpokenName`) now strips a leading `@` before TTS in both the overlay and the PWA — on-screen display text is unaffected.

### Notes
- Not deployed with this merge — needs `MULTICHAT_OVERLAY_SECRET` and `MULTICHAT_ADMIN_SECRET` set and the `AI` binding applied first (Jon's call, tracked in the 08-25 overlay premortem, private).
- Full risk writeup (billing ceilings, the two-secret split's blast radius, deleted-before-spoken timing windows, what's structurally untestable in the overlay's `<script>` block) is in the 08-25 overlay premortem, private; design detail is `docs/ARCHITECTURE.md` §3b.
- Known accepted tradeoff, not a bug: the daily TTS budget is pre-charged before `env.AI.run` runs, so a Workers AI outage burns budget on failed generations (see the internal fast-follow list, item 5).
