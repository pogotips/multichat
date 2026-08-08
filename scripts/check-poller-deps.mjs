// Guards against tools/yt-poller/test/*.test.mjs silently import-failing (0
// tests collected, non-zero exit still happens but is easy to miss in a
// skimmed CI log) when the poller subtree's own node_modules was never
// installed — it's a separate package.json, `npm install` at repo root
// doesn't touch it.
import { existsSync } from 'node:fs';
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
