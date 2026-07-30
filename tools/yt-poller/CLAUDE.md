# CLAUDE.md — multichat/tools/yt-poller

Guidance for Claude Code when working in this directory specifically. See
`../CLAUDE.md` (the multichat Worker) and `../docs/ARCHITECTURE.md` for the
full system picture — this file covers only what's specific to the poller.

## What this is

Standalone Node script (own `package.json`, own deps — deliberately isolated
from the Worker's build) that scrapes the streamer's current YouTube live
chat via a locally-patched `youtube-chat` and POSTs normalized JSON to the
`multichat` Worker's `/ingest/yt`. Runs outside Cloudflare, on an always-on
poller host. See `README.md` for env vars and local run instructions.

## Standing invariants

- **This host is a deploy target, never an edit target.** Files reach it
  only via `rsync` from this repo (see `../docs/ARCHITECTURE.md` §6). Never
  hand-edit `poller.mjs`/`normalize.mjs`/etc. directly on the host — that
  creates drift this repo can't see or roll back.
- **Adding a new top-level `.mjs` module here (e.g. a future
  `recovery.mjs`-style file) always requires a `Dockerfile` `COPY` line
  update in the same commit.** The Dockerfile copies named files
  (`poller.mjs normalize.mjs recovery.mjs retry-queue.mjs capture.mjs`), not
  the directory — a module left out of `COPY` still passes `npm test` and a
  local `node poller.mjs` (both run from source on disk) but crashes the
  container on `import` at boot. This exact bug shipped twice before a test
  guarded it (`258cfa6` inlined the poller in the README instead of a real
  Dockerfile; `d0351f9`/`78d41d5` were modules missing from `COPY`).
  `test/*.test.mjs`'s Dockerfile-guard test (`c72ab84`) checks the `COPY` line
  against the actual module graph — never remove or weaken that test to make
  a change pass; add the module to `COPY` instead.
- **`npm install` must run before `npm start`/before building the image** —
  the `youtube-chat` patch (`patches/youtube-chat+2.2.0.patch`, applied via
  `patch-package`'s postinstall hook) is what makes `member_new` /
  `member_milestone` / `member_gift` / `member_gift_received` / `yt_gift`
  events exist at all. Skipping install silently drops all of them — no
  error, just missing events.
- **Never send raw chat text to `/ingest/yt` uninterpreted as a command.**
  Every chat item is untrusted public input; `normalize.mjs`/`recovery.mjs`
  are pure functions that only classify and reshape, never execute.
