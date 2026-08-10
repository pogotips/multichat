// Guards against tools/yt-poller/test/*.test.mjs silently import-failing (0
// tests collected, non-zero exit still happens but is easy to miss in a
// skimmed CI log) when the poller subtree's own node_modules was never
// installed — it's a separate package.json, `npm install` at repo root
// doesn't touch it.
//
// Also guards the present-but-unpatched case: patch-package printed its
// success checkmark while liveChatModeChangeMessageRenderer was absent from
// the installed dist (confirmed 2026-08-10 — patch-package's own exit
// status/log line is not proof the patch content actually landed). Without
// this, npm install "succeeding" silently drops member_new/milestone/gift/
// modeChange handling with no error, only downstream test failures.
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(fileURLToPath(import.meta.url));
const marker = path.join(root, '..', 'tools', 'yt-poller', 'node_modules', 'youtube-chat');

if (!existsSync(marker)) {
  console.error(
    '\nmultichat: tools/yt-poller/node_modules missing (youtube-chat not found).\n' +
    'The poller has its own package.json — root `npm install` does not install it.\n' +
    'Run: npm install --prefix tools/yt-poller\n'
  );
  process.exit(1);
}

const parserDist = path.join(marker, 'dist', 'parser.js');
const sentinel = 'liveChatModeChangeMessageRenderer';

if (!existsSync(parserDist) || !readFileSync(parserDist, 'utf8').includes(sentinel)) {
  console.error(
    '\nmultichat: tools/yt-poller/node_modules/youtube-chat is installed but NOT patched\n' +
    `(missing sentinel "${sentinel}" in dist/parser.js).\n` +
    'patch-package can print a success checkmark without the patch content actually\n' +
    'landing in dist — do not trust that log line alone.\n' +
    'Fix: rm -rf tools/yt-poller/node_modules && npm install --prefix tools/yt-poller\n'
  );
  process.exit(1);
}
