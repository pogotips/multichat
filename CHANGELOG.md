# Changelog

<!-- CalVer entries (YYYY.MM.DD.N), matching RELEASE_VERSION in src/worker.js. -->

## [Unreleased]

## [2026.10.21.1]

### Fixed
- **PWA reload replays no longer read as a replay gap in `sse_replay_result`.** A full-ring reload replay (`lastEventId=0`) now logs `kind: 'ring'` and `gap: null` instead of `gap: true`; every other replay line is unchanged (no `kind`, real `gap`). Gap queries need no `lastId: 0` exclusion any more. DO-side only: takes effect after DO adoption.

## [2026.10.20.1]

### Added
- **Spoken @mentions and spoken word map (PWA + overlay).** A body `@mention` is now spoken exactly like that name as a sender: the whole handle after the `@` (`-` and `.` included) goes through the same spoken-name rule (`spokenNameFor`: curse check, then `cleanSpokenName`), trailing punctuation is peeled first and put back after (`@Name_42!` is spoken `Name!`), and only an `@` at the start of a word counts (emails and mid-word `@` are untouched, `well-known` stays whole). The overlay's sender name and `@mention`s now take the same path as the PWA, so overlay speech matches PWA speech (the overlay also gets the curse-name check on senders, and `MULTICHAT_TTS_EXTRA_CURSES` for it). New optional wrangler secret `MULTICHAT_TTS_SAY_AS` (JSON object, word to spoken form, never a `vars` entry): a case-insensitive whole-word match on sender names, `@mentions` and message text, speech only, applied to the PWA chat/gold/Read-Out-Loud lines and the overlay's chat and `ttsBody` lines (the overlay's `/tts` receives the same text). Unset or invalid JSON is an empty map and a no-op; invalid JSON logs one `tts_say_as_bad_config {reason}` per isolate and never the value. Display text is never rewritten. New helpers `applySpokenWordMap`, `spokenSenderName`, `formatOverlayChatUtterance` (interpolated; also covered by the bundle test) and server-only `parseSayAsMap`; `sanitizeSpokenBody` now uses `cleanSpokenMentions` instead of the `@`-strip-only `normalizeSpokenMentions`.

### Changed
- **PWA long sender names (CSS only).** The platform badge and the sender name always share a line. Non-gold rows cap the name at 60% of the row width on one line and end an overlong name in an ellipsis (the full name is still in the name-tap sheet; the verified tick and colon are clipped along with the overlong tail); gold rows (`paid`, gigantify) keep the full name and let it wrap with the badge glued to its first characters instead of leaving the badge alone on a line. No DOM change, `buildRow` and the golden fixture untouched, overlay layout untouched.

## [2026.10.18.2]

### Added
- **YT chip forced reconnect (PWA + overlay).** When the YT chip has been red for a minute or more while frames are still arriving (a Durable Object moved or restarted mid-stream leaves the open stream pinned to the old instance: Twitch flows, YouTube is dead), the client opens a fresh connection on its own, which lands on the live instance, so YouTube rows come back without pull-to-refresh. YouTube rows return in about 2.5-3 minutes. At most one forced reconnect per 5 minutes per client, so a real poller outage doesn't loop. The PWA beacons it as `reconnect_attempt` trigger `yt_stale` (the overlay beacons the same, under its own 10-per-session budget); the 60s silence watchdog is unchanged. The usual gray "some messages may be missing" row after a reconnect is expected.
- **Superseded-DO self-close.** A `ChatHub` instance that stops receiving alarms for more than 3 intervals (180s) while SSE clients are attached, on two consecutive heartbeat ticks, logs `do_superseded_suspect`; the second strike confirms with a storage read, and only a failing read logs `do_superseded_close` (about 3.5 minutes after its last alarm), closes its SSE streams and IRC socket (no IRC reconnect) and stops its loop. A healthy read logs `do_superseded_false_alarm` and closes nothing. Kill switch: var `MULTICHAT_SUPERSEDED_DETECT="off"` (default on; documented in `wrangler.jsonc.example`).

## [2026.10.18.1]

### Added
- **PWA reload keeps the feed.** A reload (pull-to-refresh version mismatch, iOS killing and reviving the installed app, a manual refresh) within 30 minutes of the last rendered message now brings back the messages that were on screen — as many as the DO ring holds (200) — instead of an empty feed. The page keeps a small feed cursor (`multichat-feed`: highest rendered id + when it last advanced, written at most every 5 s and on hide/unload) and asks the hub for the whole ring on load; the stored id drives the existing "reconnected, some messages may be missing" decision, so a ring that rolled past it still shows that one gray row and a ring that still holds it replays silently. Replayed rows never buzz or speak: buzz and TTS already share the persisted-floor + 30-minute age gate, so only a gold/raid row that arrived while the app was dead, and is under 30 minutes old, fires — once. More than 30 minutes after the last message (or with nothing stored) the app starts clean, with no gray row — the old `multichat-spoken.lastMsgId` restore, which had no expiry and produced that gray row on next-day opens, is gone. OBS overlay unchanged (never carries the helpers; a scene-switch reload still gets zero ring rows).

## [2026.10.13.3]

### Added
- **TTS mute button (PWA).** A 🔔/🔕 toggle in the topbar, immediately left of the speaker button, silences all phone speech (alerts, chat, Read Out Loud, mode announcement) and cancels the line being read. Buzz and the Gold/All speaker mode are untouched, and the speaker button still cycles. Saved under its own key (`multichat-tts-muted`), so it survives a reload. While muted the spoken-id floor and spoken set still advance, so unmuting never reads a backlog. The overlay is unchanged.

### Changed
- `MULTICHAT_TTS_REWARD_ID` is a wrangler secret (`wrangler secret put`), no longer a `wrangler.jsonc.example` var; a `vars` entry of that name would shadow the secret. The Worker reads `env.MULTICHAT_TTS_REWARD_ID` either way.

### Fixed
- "Read Out Loud" redeem rows (PWA) now buzz once like other gold-class rows; the row call site used to pass no buzz pattern for them. Spoken-once and the per-id gate are unchanged. Not live until `MULTICHAT_TTS_REWARD_ID` is set.

## [Poller 2026-10-13] — poller only, no RELEASE_VERSION bump

### Fixed
- Poller: no log line can carry a secret value. Every error-text log path (`yt counts fetch failed`, ingest errors, capture writes, live-chat errors, rediscovery probe, `yt_session_end` `lastErrors`) now masks via one shared `describeErr`/`maskSecrets` (ingest secret, `YOUTUBE_API_KEY`, percent-encoded forms, `key=` values), including a `videos.list` error whose message holds the key-bearing URL.
- Poller: a hung heartbeat tick can no longer silence the poller. The in-flight guard releases after `TICK_CEILING_MS` (60s) with one `poller_tick_ceiling_release` line and runs the watchdog; the stale tick can neither clear the newer tick's guard nor post its heartbeat or write state (`poller_tick_stale_dropped`, once). Poller-only; no Worker change.

## [2026.10.13.2]

### Changed
- Poller heartbeat log gains `evicted` (retry-queue evictions this cycle) and an `unknownRenderers` top-10 summary. Both are log-only, not on the heartbeat wire.

### Fixed
- **`irc_line_error` redaction works.** The per-line catch now passes the line to `redactErr`, so an error that echoes any 24-char window of the line logs `[redacted]`.
- **`irc_line_error` is capped.** 20 per minute per hub; the overflow is counted and the next window opens with one `irc_line_error_suppressed` summary.
- **A failing gigantify step keeps the plain row.** If the dedupe step throws after the row landed, the row is restored to its plain state and logged as `irc_line_error` with `stage: 'gigantify'`.
- **JSON.parse SyntaxErrors no longer carry chat text to `/client-error`.** The PWA and overlay beacon `SyntaxError at position N` only, and the server reduces the same shape from older clients.
- Poller: `drainBatch`'s re-queue now respects `RETRY_QUEUE_MAX` (evicts oldest-first, counted in `evicted`, not `dropped`).
- Poller: a throwing heartbeat tick logs `poller_heartbeat_tick_error` and the interval keeps running, instead of an unhandled rejection killing the process.
- Poller: tick errors mask the ingest secret and API key (exact values), not just `key=` query values.
- Poller: the zombie watchdog and per-cycle counter resets run in a `finally`, so a throw mid-tick no longer skips them.
- Poller: a heartbeat tick that starts while the previous is still running skips with `poller_heartbeat_tick_skipped`.
- Test-only (tools/tests, no release): the `publish-oss*` test files no longer depend on the developer's repo or tree. Fixtures scrub inherited `GIT_*` env (a hook-run `npm test` pointed fixture `git add/commit` at the real repo), the real-stage check reads the committed tree, fixtures spawn fewer git processes, and the spawn-heavy files carry a 60s per-file timeout (11 timeouts reproduced under 3x CPU load at the 5s default). `publish-oss.sh` itself is unchanged and still refuses a dirty tree for real publishes.

## [2026.10.13.1]

### Fixed
- **Overlay-config preview matches the overlay.** The font preview now uses all six real font stacks (it only knew mono and serif), and the sample rows carry the real platform value so their badges read "tw".
- **A TTS meter storage error no longer resets the hub.** The metering step logs `tts_meter_error` and answers as a failed generation instead of throwing; chat is untouched.
- **Malformed `null` bodies get the documented answer.** `/tts` and `/tts-allow` treat a literal `null` body as a no-op (204/400), `/overlay/admin` answers 400 — none of them 500s.
- **Non-401 Helix errors (429/5xx) on the viewer and follower counts are logged once.** One `counts_update` error line per distinct `http_N`, then quiet until recovery (which already logged ok).
- **No AI binding no longer burns translate/TTS budget.** The binding is checked before the daily meter is charged.

### Changed
- Overlay: the unused spoken-curse word list is no longer shipped in the overlay page, and its reconnect backoff uses the shared curve (same 1s doubling to 30s cap).
- Hub: the TTS kill flag is read once and kept in memory; the EventSub moderate-health flag and translate settle only write storage when the value changes.
- PWA: the redeem and Read Out Loud row styles are one CSS rule (no visual change).
- `GET /` memoizes the rendered page per isolate (keyed on the owner name and extra-curse list).
- Internal consolidation, no behavior change: moderation mark/delete helpers, hub timer teardown, YouTube ingest branches, shared request-body cap and token gate, IRC line parsing.
- Docs now cite code by symbol rather than line number.

## [2026.10.12.4]

### Fixed
- **Tap-to-translate works again (PWA).** Gemma 4 is a reasoning model; its thinking consumed the 120-token output cap and the translation came back empty, so every tap read "failed". Thinking is now disabled for the translate call, the output cap is a real 200 completion tokens, array/null model content is tolerated, and an empty answer logs the finish reason and token counts (never the text).
- **TTS never reads Streamlabs or any listed bot (PWA).** The bot-skip check now strips a leading `@`, a verified tick and surrounding spaces and compares case-insensitively, on YT display names and Twitch logins alike.

### Changed
- **Spoken names cut at the first digit (PWA).** `RRR0O08B8` is read "RRR", `AIRBRAKE_88` is "AIRBRAKE"; names with fewer than three letters before the first digit keep the old trailing-digit strip, and a name left with under three letters or mostly digits is read "someone" (names without digits are never replaced). Display text is unchanged.
- **@mentions in chat are read by the same rule (PWA).** "@RRR0O08B8 lol" is spoken "RRR lol"; emails and plain words are untouched.
- **Curses are spoken as "bleep" (PWA).** One shared filter for chat, gold and redeem speech: a built-in word list with asterisk and simple leet variants, whole-word on the body; a username containing a strong curse is spoken "someone". Extra words come from the optional `MULTICHAT_TTS_EXTRA_CURSES` var (comma list). Display text is unchanged. The overlay's gold rows also speak a cursing username as "someone" (built-in list only).
- **Gold always speaks (PWA).** The speaker button now toggles chat reading only, Gold ↔ All; there is no Off. A tap during speech stops the current line, drops queued chat, keeps queued gold and lands on Gold. `!tts off` → Gold, `!tts all`/`on` → All (the `gold` argument is gone). A saved Off mode from an older client migrates to Gold. The overlay's modes are unchanged.

### Added
- **"Read Out Loud" channel-point redeem (PWA).** When `MULTICHAT_TTS_REWARD_ID` names the reward, a Twitch chat message redeemed with it shows as a teal row and is spoken once (like gold, in every mode, through the bot-skip, spoken-name, mention and bleep rules) and is not read a second time as chat. Without the var, it is normal chat. The DO logs `custom_reward_seen` (reward id + login, never the text) for any custom-reward message.

## [2026.10.12.3]

### Fixed
- **Tap-to-translate retries failed and limit-hit taps (PWA).** A "failed" or "limit hit" label is no longer cached; the next tap sends a new request. Only real translations and "already English" stay cached, and a tap while "translating…" is in flight still sends no second request.
- **TTS speaker button: the mode announcement is not "speaking" (PWA).** Taps during "read alerts on" / "read all chat on" keep cycling Off → Gold → All, each announcing the new mode and cancelling the previous announcement. Stop + clear + Off fires only while a chat or gold line is being read.
- **TTS skips 14 bot accounts and any name ending in "bot" (PWA).** Matched case-insensitively on Twitch login and YT display name (was 5 names); names with "bot" mid-word are still spoken. TTS only, the rows still display.

## [2026.10.12.2]

### Added
- **Name sheet stats + @ copy button (PWA).** The name-tap sheet now opens with one stats line — message count, first seen "since open", and gold given listed per type and per currency (same-currency amounts are summed, nothing is ever converted or summed across currencies) — plus a button that copies `@name` (Twitch uses the login, any leading `@` is stripped) with a ✓ for about 1.5 s. Clipboard via `navigator.clipboard.writeText` with a textarea fallback. Computed from the existing 2,000-message in-memory list (`sheetStats`, `summarizeGold`, `copyHandle`, `writeClipboard` in `src/lib.js`); `buildRow` and the golden fixture are untouched; the feed gains no vertical space.
- **Phone TTS modes Off → Gold → All.** The speaker button cycles three modes (Gold = the previous "on" behavior; a fresh install stays Off; an existing `multichat-speak=on` migrates to Gold; mode persists in `localStorage` `multichat-tts-mode`). In All, each new chat line is spoken within about 20 s of arrival or skipped. Never spoken: replay/recovered rows, commands (leading `!`), bots (`TTS_BOT_NAMES`: Nightbot, StreamElements, Moobot, Fossabot, Streamlabs), rows containing links, emote-only rows, the broadcaster's own lines, deleted rows — a mark on a queued or in-flight row drops it mid-speech (`markMatchesQueueItem`, now used by the PWA as well as the overlay). Gold rows jump the queue; queue cap 5; spoken chat capped at 200 chars with emote ranges stripped (`stripEmoteRanges`) and the spoken-name cleanup reused. A tap while speaking cancels, clears the queue and sets Off; a tap while silent cycles. Raid rows stay buzz-only. Overlay untouched.
- **`!tts off|on|all` chat command (PWA only).** Sent by the broadcaster or a mod on either platform (the `isMod` flag the blue mod coloring already uses), it changes that phone's TTS mode within about 2 s: `off` goes to Gold, `on` and `all` go to All. Live rows only (replay/recovered and rows older than 20 s are ignored; deduped by message id); unknown arguments (including `gold`) ignored. The command row still displays but is never spoken; applying shows one local gray row "TTS <mode> by <name>" that never buzzes, speaks, or enters the seen-id gate.
- **Tap-to-translate (PWA).** Tapping a message's text (never the name) shows its English under that row, in the feed and in the name sheet, from one in-memory cache per message id, or a visible label: "translating…", "already English", "nothing to translate", "limit hit", "failed". Emote-only and GIF-only rows are a no-op. New `POST /translate` (view secret ONLY — the overlay secret is rejected because it lives in an OBS scene URL), JSON `{text}`, 2 KB body cap, 300-char input cap after stripping emotes/links/control chars; empty input never calls Workers AI. The `ChatHub` DO meters it like `/tts` with its own keys: 10/min in-memory, 8,000 neurons/day persisted (`translateDaily`, UTC-midnight reset), an estimate pre-charged under `blockConcurrencyWhile` and settled from the response's usage tokens (chars/4 when absent). Model `@cf/google/gemma-4-26b-a4b-it` with `@cf/meta/llama-3.1-8b-instruct-fp8-fast` as fallback, strict translate-only system prompt, chat text passed as the user message, `max_tokens` 120, output trimmed and capped at 400 chars; a normalized match with the input reports "already English". The client renders `textContent` only, labeled "translated", appended outside `buildRow`. Log line `ev:translate {ok, reason, ms, inTok, outTok, neuronsEst}` — never the input or output text.

## [2026.10.12.1]

### Changed
- **Verified tick is a CSS-drawn badge, not a text glyph.** `span.verified` (shared `buildRow`) is now an empty element rendered as a filled round badge with the check as `::before` content, on the PWA, the overlay and the config preview. A `✓` typed into a display name stays plain name text — no element, no badge — so it cannot imitate the real tick. Display names are never rewritten.
- **Name-tap sheet polish (PWA).** While the sheet is open the feed behind it is frozen (`body.sheet-open`, `overscroll-behavior: contain`, a touchmove guard on the dim area) so iPhone cannot scroll the feed through the backdrop; the lock releases on every close path (backdrop tap, close button, Escape all route through `closeSheet`). Focus moves into the dialog and is restored on close. Pointer cursor is feed-only (`#feed .user`); sheet colors are `:root` tokens.

### Fixed
- **yt-poller: `poller_heartbeat` counts 400/413 drops as `dropped`, never `failed`.** New per-cycle `dropped` field next to `failed`; `failed` is now only real delivery failures.
- **yt-poller: every rediscovery probe that returns no videoId logs its reason.** `yt_rediscovery` lines carry `reason` (`error_event` | `timeout` | `start_rejected` | `empty_live_id`), a capped `detail`, and `cleanupError` when the probe's `stop()` threw (`probeCurrentLive`, `rediscovery.mjs`).

## [2026.10.11.1]

### Added
- **PWA name-tap history sheet.** Tapping a username in the feed opens a bottom sheet with every message from that same platform account seen since page open, newest on top, deleted rows struck, updating live, closed by a backdrop tap, the close button or Escape. Backed by two new `src/lib.js` helpers: `userKeyOf` (key is `tw:<login>` or `yt:<authorId>`, never the display name; `sys` rows and accounts with no stable id are not tappable) and `createMessageStore` (bounded in-memory list, last 2,000 messages overall, fed only by frames that passed the seen-id gate, gone on reload). Sheet rows go through `buildRow` directly, so nothing new buzzes, speaks or enters TTS. PWA only; overlay untouched.
- **YouTube verified tick.** Verified channels show a small tick after the name, inside `span.user`, rendered by the shared `buildRow` so the overlay shows it too. The poller forwards the stock parser's `isVerified` as `verified`, and `normalizeYt` / `pushMessage` accept a strict boolean `true` only. No color or precedence change.
- **Poller `docker-compose.override.yml.example`** for a host-persisted `/app/capture` volume, so capture files survive a container recreate.

### Changed
- **PWA `.user` gets `margin-right: 4px`**, so feed rows read "name: text" with a visible gap (the overlay already had it). No text change.
- **YouTube custom emoji uses the 48px thumbnail**, falling back to the first thumbnail when none is 48px (new hunk in `patches/youtube-chat+2.2.0.patch`).

### Fixed
- **yt-poller: a 400 or 413 ingest reply never blocks chat.** Such a reply drops that item on its first failure (`isPayloadRejection`, `retry-queue.mjs`) and logs `ingest_dropped` with no body. A batch whose only non-sent items were dropped no longer doubles the drain backoff, so a poison item never holds chat.
- **yt-poller: back-to-back handoff is blind under 100 s with no `too_soon` skips.** `REDISCOVERY_MIN` 5 → 2, and the probe gate `REDISCOVERY_GATE_MS` sits one heartbeat tick under the cadence (105 s / 120 s). Rediscovery log lines now carry the resolved liveness instead of a `not_live` literal.

## [2026.09.23.1]

### Changed
- **Inline Twitch emotes render at the 2.0 CDN tier (was 1.0)** — crisper on 3x/HiDPI screens, displayed size unchanged (`.emote { height: 1.4em }` already pins render height regardless of the source image's pixel density). Twitch only; YouTube custom-emoji rendering is untouched. Gigantify's dedicated 3.0-scale image (`.emote.gigantify`) is unaffected — this only touches the plain-inline emote path in `renderText` (`src/lib.js`).

## [2026.09.22.1]

### Changed
- **Reactions strip persists 60s (was 10s).** `REACTIONS_WINDOW_MS` on the PWA topbar bumped from `10_000` to `60_000` so a burst stays visible longer after it fades — the YT-not-live hide path and `YT_REACTIONS_STALE_MS` (server-side decay, unrelated) are untouched, they were already independent of the client window.
- **Reaction counts now format as `1.2k`/`1M`** via the existing `formatCount` helper (already interpolated into the PWA script for the chip counts), instead of raw integers, so a large burst doesn't blow out the topbar row.
- **Topbar refresh button (`↻`) removed.** Pull-to-refresh is now the only manual reconnect trigger on the PWA; `refreshReconnect()` and the shared reconnect core are unchanged. Overlay, overlay-config, poller, and DO untouched.

### Fixed
- `#reactions` gets `min-width: 0; overflow: hidden` so a full 4-emoji strip can never push the viewer/likes/followers chips off a 390px viewport.

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
