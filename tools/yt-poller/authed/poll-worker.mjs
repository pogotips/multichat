#!/usr/bin/env node
// Child process spawned by ../authed-chat-difftest.mjs — one instance per
// side (anon or authed), run in separate OS processes specifically so an
// authed run's global axios request-interceptor patch can never leak onto
// the anon run's requests. youtube-chat's requests.js calls the bare
// `axios` singleton directly (axios.get/axios.post, no per-call config
// hook) — there's no way to scope headers to just one LiveChat instance
// within a single process, so process isolation is the mechanism, not a
// convenience.
//
// Not unit tested (network-dependent, same as poller.mjs itself — see that
// file's own "isn't import-safe in a test process" note). The pure pieces
// this leans on (SAPISIDHASH computation, cookie parsing) live in
// sapisidhash.mjs and ARE unit tested.
//
// Args (all required unless noted):
//   --mode=anon|authed
//   --channel-id=<YT channel id>
//   --out=<path to jsonl output file>
//   --duration-sec=<seconds to poll before stopping>
//   --cookie-file=<path>   (authed mode only)
import fs from 'node:fs';
import path from 'node:path';
import { parseCookieFile, extractSapisid, serializeCookieHeader, buildSapisidHashHeader, SAPISIDHASH_ORIGIN } from './sapisidhash.mjs';

function parseArgs(argv) {
  const out = {};
  for (const arg of argv) {
    const m = /^--([^=]+)=(.*)$/.exec(arg);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const mode = args.mode;
const channelId = args['channel-id'];
const outPath = args.out;
const durationSec = Number(args['duration-sec'] || 120);

if (!mode || !channelId || !outPath || !durationSec) {
  console.error(`[poll-worker] missing required args (got mode=${mode} channel-id=${channelId ? 'set' : 'unset'} out=${outPath} duration-sec=${durationSec})`);
  process.exit(1);
}

if (mode === 'authed') {
  const cookieFile = args['cookie-file'];
  if (!cookieFile) {
    console.error('[poll-worker:authed] --cookie-file is required in authed mode');
    process.exit(1);
  }
  let cookieMap;
  try {
    // Read only — never logged, never written anywhere but into the
    // in-memory header value below.
    cookieMap = parseCookieFile(fs.readFileSync(cookieFile, 'utf8'));
  } catch (err) {
    console.error(`[poll-worker:authed] failed to read cookie file: ${err.message}`);
    process.exit(1);
  }
  const sapisid = extractSapisid(cookieMap);
  if (!sapisid) {
    console.error('[poll-worker:authed] cookie file has neither SAPISID nor __Secure-3PAPISID — cannot sign requests');
    process.exit(1);
  }
  const cookieHeader = serializeCookieHeader(cookieMap);

  // Patch the axios singleton youtube-chat's requests.js uses internally.
  // Safe here specifically because this process runs ONLY the authed side
  // (see file header) — the anon worker never loads this module.
  const { default: axios } = await import('axios');
  axios.interceptors.request.use((config) => {
    config.headers = config.headers || {};
    config.headers['Cookie'] = cookieHeader;
    // Authorization is recomputed per request — SAPISIDHASH's timestamp
    // must be current at send time, not fixed once at startup.
    config.headers['Authorization'] = buildSapisidHashHeader(sapisid);
    // The server validates the hash against the Origin header, so this must
    // be sent and must match SAPISIDHASH_ORIGIN exactly.
    config.headers['Origin'] = SAPISIDHASH_ORIGIN;
    return config;
  });
}

const { LiveChat } = await import('youtube-chat');

fs.mkdirSync(path.dirname(outPath), { recursive: true });
const outStream = fs.createWriteStream(outPath, { flags: 'a' });

function writeItem(item) {
  outStream.write(JSON.stringify(item) + '\n');
}

const liveChat = new LiveChat({ channelId });

liveChat.on('start', (liveId) => {
  console.error(`[poll-worker:${mode}] started, liveId=${liveId}`);
});
liveChat.on('chat', (item) => {
  writeItem(item);
});
liveChat.on('error', (err) => {
  console.error(`[poll-worker:${mode}] error: ${err?.message || err}`);
});
liveChat.on('end', (reason) => {
  console.error(`[poll-worker:${mode}] ended: ${reason}`);
});

let stopping = false;
function shutdown(reason) {
  if (stopping) return;
  stopping = true;
  liveChat.stop(reason);
  outStream.end(() => process.exit(0));
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

const started = await liveChat.start();
if (!started) {
  console.error(`[poll-worker:${mode}] failed to start (see error above) — likely bad/expired cookies for authed mode, or no live stream for anon mode`);
  outStream.end(() => process.exit(1));
} else {
  setTimeout(() => shutdown('duration elapsed'), durationSec * 1000);
}
