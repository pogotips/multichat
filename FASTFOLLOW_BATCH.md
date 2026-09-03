# multichat fast-follow batch

Queued items surfaced during the 2026-08-20 secret-rotation session. Not implemented here — this batch is docs-only, tracking work for a future session.

## 1. `MULTICHAT_INGEST_SECRET` has no off-box copy by design

Today the only copies are the Worker's own secret store and the poller host's `docker-compose.yml` `environment:` block — both single points of failure, and the rotation runbook (`docs/ARCHITECTURE.md` §6 step 5) already documents this as a hard 401 window with no dual-value support during a swap.

**Why:** the 2026-08-20 incident's backup-verification step only worked because a fresh tar of the poller stack existed at all — if it hadn't, the host-only compose file (and the only readable copy of the pre-rotation secret) would have been unrecoverable. A deliberate off-box copy (password manager entry, sealed secret in a vault) would remove that single point of failure without changing the trust model (nothing new gains read access).

**Where:** this is a process/storage decision, not a code change — no file:line. Needs a decision on where the off-box copy lives before any implementation.

## 2. Determine whether the `timer` worker is deployed and what it depends on

Discovered during the git-history search for item 2 above — `timer/src/worker.js` and `timer/wrangler.jsonc` exist in this monorepo and briefly held the same Google API key literal at commit `0dbd922e`. Not otherwise referenced in any multichat or raidq session context so far.

**Why:** before revoking the key in item 2, need to know if `timer` is a live deployed Worker that still depends on it (directly, or via some other credential from the same Google Cloud project) — revoking blind could break something nobody's looked at recently.

**Where:** `timer/` at the monorepo root — check `wrangler deployments list`/`wrangler versions list` for a live deployment, and read `timer/src/worker.js` for what it currently calls. No changes, read-only investigation.

## 3. Flaky `withExpiresIn` duration test (test/eventsub.test.js)

`withExpiresIn()` (test/eventsub.test.js:320) derives `expires_at` from
`Date.now()` at event-build time, then `mapEventToRow` re-derives the
duration from another `Date.now()` call downstream. Under load the ~1ms
of real time between the two calls occasionally lands the computed
duration at e.g. `29.999s` instead of the expected `30s`, failing the
`it.each` assertion in `mapEventToRow: channel.moderate` (seen 2026-08-20
during PR #53 pre-deploy gate 1 — first full-suite run failed 681/682 on
this exact case, reran clean 682/682 and 3x isolated-file clean).

Not touched by PR #53 (test/eventsub.test.js wasn't in that diff) — a
pre-existing flake, not a regression from that change.

**Fix:** freeze the clock in the test (e.g. `vi.useFakeTimers()` /
inject a fixed `now`) so `expires_at` and the duration calc read the same
instant. Do not widen the assertion or round more loosely — that would
mask real off-by-one duration bugs, not just the timing race.

## 4. TTS daily budget is pre-charged before `env.AI.run`

`handleTtsAllow` (`src/worker.js`, ChatHub) increments the daily character
budget (`ctx.storage`, `ttsDaily`) inside the same `blockConcurrencyWhile`
that checks it, before the Worker's `handleTts` ever calls `env.AI.run`. A
sustained Workers AI outage — every `env.AI.run` call throwing — burns
through the 25,000-char daily budget on failed generations that produce no
audio, degrading TTS to silent for the rest of that UTC day with nothing to
show for the spend.

**Why not fixed here:** flagged and accepted in
the 08-25 overlay premortem (private) §1 as the safer direction for a
real-money endpoint — under-spending (budget consumed, no audio) beats the
alternative of refunding on failure, which would need the DO to track
in-flight char reservations separately from committed spend. Each failure
is logged (`tts_generate_error`), so the degrade is diagnosable, not silent
to the operator. Not a bug, just tracked in case the failure mode is ever
observed live and the tradeoff needs revisiting.

**Where:** `src/worker.js`, `ChatHub.handleTtsAllow` (daily-budget block)
and `handleTts` (the `env.AI.run` call site). No changes proposed — this is
a tracking entry, not an open fix.

## 5. Widen the Twitch GIF host allowlist if `gif_host_rejected` shows other giphy hosts live

`isAllowedGifHost` (`src/worker.js`) only accepts `/^media\d*\.giphy\.com$/`
— chosen because the docs' single worked example uses `media4.giphy.com`.
Real Twitch GIF picker traffic may use other Giphy CDN subdomains never seen
in that one example (e.g. a differently-numbered or non-numbered variant
outside what `\d*` already covers, or a wholly different Giphy hostname).

**Why not widened preemptively:** no live traffic sample yet to confirm what
else Twitch actually sends — widening blind risks accepting an
attacker-controlled lookalike host. `gif_host_rejected {host}` (host only,
never the full URL) is the safety net, same shape as the YouTube emoji
allowlist's `emoji_host_rejected` audit trail (which is how `gstatic.com` got
added to that allowlist, 2026-08-08).

**Where:** `src/worker.js`, `GIF_HOST_RE`/`isAllowedGifHost` (worker) and
`ALLOWED_GIF_HOST_RE`/`isAllowedGifUrl` (`src/lib.js`, client-side defense in
depth — must stay in sync with the worker-side regex if either changes).
Check CF Observability for `gif_host_rejected` log volume/hosts after this
ships and widen both regexes together if a legitimate Giphy host is showing
up rejected.

## 6. ~~No cap on `msg.gifs` array size through the gap-recovery replay path~~ — CLOSED 2026-09-03

Fixed: `RECOVERED_GIFS_MAX = 8` added alongside `RECOVERED_EMOTES_MAX` (64)
in `filterRecoveredMessages` (`src/worker.js`) — same truncation shape,
lower ceiling (a single message realistically can't carry many gif entries).
Test: `test/parse.test.js` "clamps a recovered message gifs array to 8 (9
entries in, 8 out)".

## 7. `test/bundle-gif-render.test.js`'s esbuild-helper sweep is static-text only, not execution, for 20 of 24 interpolated helpers

The `describe('all interpolated ${helper} functions...')` block extracts
every `${helper}`-interpolated function's own body text from the real
`wrangler deploy --dry-run` bundle and asserts it contains no esbuild
runtime helper reference (`__name(`, `__publicField(`, etc). That catches
the entire *class* of bug that shipped (any named local closure nested
inside an interpolated function) regardless of whether the helper is
otherwise exercised — confirmed via a mutation test (planted a throwaway
closure in `formatCount`, sweep caught it, reverted).

What it does NOT do: actually *call* each helper with valid arguments
inside the vm sandbox and check it runs without throwing. Only
`roleClass`/`isAllowedEmojiUrl`/`isAllowedGifUrl`/`renderGifToken`/
`mergeAnnotations`/`appendWithMention`/`renderText`/`buildRow` get real
execution coverage today (via the PWA/overlay render tests in the same
file). The other ~16 (`emitCategory`, `isEmittable`, `resolveToken`,
`cleanSpokenName`, `formatUtterance`, `enqueueCapped`, `formatCount`,
`pullPhase`, `versionMismatch`, `createPullGate`, `isClientStale`,
`supersedeSocket`, `shouldSendClientError`, `normalizeSpokenMentions`,
`formatOverlayUtterance`, `markMatchesQueueItem`) are static-text-swept only.

**Why not done here:** each needs its own plausible-argument construction
(a `msg` shape, a DOM container, specific numeric ranges) — real but
meaningfully more work than the static sweep, and the static sweep already
closes the actual gap that caused the 2026-09-03 incident (a closure
`__name`-wrapped by esbuild) for every one of them. Execution coverage would
catch a *different* class of bug (e.g. a helper that's individually correct
but throws on some specific real input) — worth doing, not the same risk.

**Where:** `test/bundle-gif-render.test.js`, the `PAGE_HELPERS` sweep —
add a per-helper invocation table (helper name -> plausible args) alongside
the existing static-text check, iterate the same `PAGE_HELPERS` list.

## 8. ~~`src/worker.js` now exceeds the Read tool's cap — move embedded icon assets to `src/assets.js`~~ — CLOSED 2026-09-03

Adding `FAVICON_32_B64` (2026-09-03) alongside the existing `ICON_180_B64`/
`ICON_192_B64`/`ICON_512_B64` base64 constants pushed `worker.js` over the
25k-token read cap — confirmed live this session: a plain `Read` of the file
(even a small offset/limit range) failed outright once the new constant
landed, because each base64 icon is one enormous single line and the tool
budgets by total file tokens, not by the specific range requested.

**Why not fixed here:** out of scope for the favicon task itself; a real
refactor (new module, import wiring, `wrangler dev`/`vitest` both still
booting cleanly per the `src/lib.js` header's own entry-module-export
constraint) deserves its own review, not a rider on an unrelated change.

**Where:** `src/worker.js` — `ICON_180_B64`, `ICON_192_B64`, `ICON_512_B64`,
`FAVICON_32_B64` (currently declared near the top of the file, ~line 36-39)
move to a new `src/assets.js`, imported into `worker.js` the same way
`src/lib.js`'s plain-value constants already are (see `src/lib.js`'s own
header comment for why: workerd requires every top-level named export of the
*entry* module to be a function/class/`ExportedHandler`, so plain-value
constants must live in a non-entry module — `assets.js` would follow that
same rule). Verify `wrangler dev` still boots and `npm test` still passes
after the move — same check that constraint's own header comment already
prescribes for any new module split.

**Done:** `src/assets.js` created with the 4 base64 constants, each exported
plain-value, no handlers — `assets.js`'s own header notes nothing here is
ever interpolated into a client script, so the esbuild `__name`-wrap toString
trap (the one that bit `bundle-gif-render.test.js`, item 8 above) doesn't
apply. `worker.js` imports them the same way it already imports from
`lib.js`. Verified byte-identical: sha256 of all 4 icon routes
(`/icon-180.png`, `/icon-192.png`, `/icon-512.png`, `/favicon.ico`) against
`wrangler dev` matches before and after the move. `worker.js` dropped from
344,322 to 241,037 bytes (4957→4951 lines — only the 6 header/const lines
moved, but 3 of those lines held ~100KB of base64 each); a plain `Read` of
the whole file now succeeds (paginates normally) instead of failing outright.
`npm test`: 839/839 passing, same count as before.
