# Changelog

<!-- CalVer entries (YYYY.MM.DD.N), matching RELEASE_VERSION in src/worker.js. -->

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
- Known accepted tradeoff, not a bug: the daily TTS budget is pre-charged before `env.AI.run` runs, so a Workers AI outage burns budget on failed generations (see `FASTFOLLOW_BATCH.md` item 5).
