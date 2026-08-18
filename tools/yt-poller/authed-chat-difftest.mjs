#!/usr/bin/env node
// Manual diagnostic tool — NOT part of the deployed poller pipeline. Never
// imported by poller.mjs, never listed in this directory's Dockerfile COPY
// lines, never referenced from package.json scripts. A human runs it by
// hand, locally, to compare what YouTube's live chat looks like polled
// anonymously (same anon path tools/yt-poller/poller.mjs itself uses — the
// `youtube-chat` lib + this repo's patch) versus polled as an authenticated
// Google account, to see whether the authed session surfaces anything the
// anon session misses (member-only chat, different moderation visibility,
// etc).
//
// Lives under tools/yt-poller/ (not tools/) purely so it can resolve the
// `youtube-chat` import via this directory's own node_modules — it does
// NOT ship with the poller container and has no other coupling to it.
//
// Why two child processes instead of one process polling both ways: the
// `youtube-chat` library calls the bare `axios` singleton directly inside
// its own requests.js, with no per-call config hook. Authenticated polling
// needs a global axios request-interceptor to inject Cookie +
// SAPISIDHASH Authorization headers, and there is no way to scope that
// interceptor to only the authed LiveChat instance within a single process
// — it would leak onto the anon instance's requests too. Running each side
// in its own OS process (see authed/poll-worker.mjs) makes that leak
// structurally impossible instead of relying on care.
//
// Env vars:
//   YT_CHANNEL_ID     required. YouTube channel id, e.g. UCxxxxxxxxxxxxxxxxxxxxxx
//   YT_COOKIE_FILE    optional. Absolute path OUTSIDE this repo to a cookie
//                     file for a real, logged-in Google account (Netscape
//                     cookie-jar format or JSON — see authed/sapisidhash.mjs
//                     parseCookieFile for the accepted shapes). Needs at
//                     least a SAPISID (or __Secure-3PAPISID) cookie.
//                     UNSET = authed side is skipped entirely; this script
//                     runs anon-only and never touches the filesystem
//                     looking for cookies.
//   POLL_SECONDS      optional, default 120. How long each side polls
//                     before stopping and writing the diff report.
//   OUT_DIR           optional. Defaults to a fresh dir under the OS temp
//                     dir (never inside this repo) — printed at the end.
//
// Example invocation (anon-only, no cookies):
//   YT_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxxxxxx node tools/yt-poller/authed-chat-difftest.mjs
//
// Example invocation (anon + authed):
//   YT_CHANNEL_ID=UCxxxxxxxxxxxxxxxxxxxxxx \
//   YT_COOKIE_FILE=/absolute/path/outside/repo/youtube-cookies.txt \
//   POLL_SECONDS=180 \
//   node tools/yt-poller/authed-chat-difftest.mjs
//
// Output: <outDir>/anon.jsonl, <outDir>/authed.jsonl (raw ChatItem objects,
// one per line — never posted anywhere, never touches the multichat
// Worker), and <outDir>/diff-report.txt summarizing counts + which
// messages appeared on only one side. Also printed to stdout.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveDifftestConfig } from './authed/config.mjs';
import { diffMessages, formatDiffSummary } from './authed/diff.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const POLL_WORKER = path.join(DIR, 'authed', 'poll-worker.mjs');

function readJsonlSafe(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  const items = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed));
    } catch (err) {
      console.error(`[authed-chat-difftest] skipping unparsable line in ${filePath}: ${err.message}`);
    }
  }
  return items;
}

function runChild(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [POLL_WORKER, ...args], { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => resolve(code));
  });
}

async function main() {
  const config = resolveDifftestConfig(process.env);

  if (!config.channelId) {
    console.error('Missing required env: YT_CHANNEL_ID');
    process.exit(1);
  }

  const outDir = config.outDir || path.join(os.tmpdir(), `multichat-authed-difftest-${Date.now()}`);
  fs.mkdirSync(outDir, { recursive: true });
  const anonOut = path.join(outDir, 'anon.jsonl');
  const authedOut = path.join(outDir, 'authed.jsonl');

  console.log(`[authed-chat-difftest] polling for ${config.pollSeconds}s, output dir: ${outDir}`);

  const jobs = [
    runChild(['--mode=anon', `--channel-id=${config.channelId}`, `--out=${anonOut}`, `--duration-sec=${config.pollSeconds}`]),
  ];

  if (config.authed.enabled) {
    if (!fs.existsSync(config.authed.cookieFile)) {
      console.error(`[authed-chat-difftest] YT_COOKIE_FILE is set but does not exist: ${config.authed.cookieFile} — authed side skipped`);
    } else {
      console.log('[authed-chat-difftest] authed side enabled (cookie file found)');
      jobs.push(
        runChild([
          '--mode=authed',
          `--channel-id=${config.channelId}`,
          `--out=${authedOut}`,
          `--duration-sec=${config.pollSeconds}`,
          `--cookie-file=${config.authed.cookieFile}`,
        ]),
      );
    }
  } else {
    console.log(`[authed-chat-difftest] ${config.authed.reason}`);
  }

  await Promise.all(jobs);

  const anonItems = readJsonlSafe(anonOut);
  console.log(`[authed-chat-difftest] anon: ${anonItems.length} messages -> ${anonOut}`);

  if (jobs.length < 2) {
    console.log('[authed-chat-difftest] authed side did not run — no diff report (anon-only mode)');
    return;
  }

  const authedItems = readJsonlSafe(authedOut);
  console.log(`[authed-chat-difftest] authed: ${authedItems.length} messages -> ${authedOut}`);

  const diff = diffMessages(anonItems, authedItems);
  const summary = formatDiffSummary(diff);
  const reportPath = path.join(outDir, 'diff-report.txt');
  const report = [
    summary,
    '',
    '--- authed-only (missed by anon) ---',
    ...diff.authedOnly.map((item) => JSON.stringify(item)),
    '',
    '--- anon-only (missed by authed) ---',
    ...diff.anonOnly.map((item) => JSON.stringify(item)),
  ].join('\n');
  fs.writeFileSync(reportPath, report + '\n');

  console.log('');
  console.log(summary);
  console.log(`[authed-chat-difftest] full diff report: ${reportPath}`);
}

main().catch((err) => {
  console.error('[authed-chat-difftest] fatal:', err);
  process.exit(1);
});
