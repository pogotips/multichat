// Guards the recurring failure class: a new top-level .mjs module gets
// imported by poller.mjs but never added to the Dockerfile's COPY line —
// works outside Docker (npm test, local `node poller.mjs` both run from
// source), crashes on import inside the container. Third occurrence of
// this exact bug is what prompted this test.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const POLLER_DIR = path.join(DIR, '..');

// Every local `.mjs` module reachable from poller.mjs, direct or transitive.
function collectLocalModules(entryFile) {
  const seen = new Set();
  const stack = [entryFile];
  while (stack.length > 0) {
    const file = stack.pop();
    if (seen.has(file)) continue;
    seen.add(file);
    const content = fs.readFileSync(path.join(POLLER_DIR, file), 'utf8');
    for (const m of content.matchAll(/from\s+['"]\.\/(.+?\.mjs)['"]/g)) {
      if (!seen.has(m[1])) stack.push(m[1]);
    }
  }
  return seen;
}

// Every `.mjs` filename named across all COPY lines in the Dockerfile.
function collectDockerfileCopiedModules(dockerfileContent) {
  const copied = new Set();
  for (const line of dockerfileContent.split('\n')) {
    if (!line.trim().startsWith('COPY ')) continue;
    for (const token of line.trim().split(/\s+/)) {
      if (token.endsWith('.mjs')) copied.add(token);
    }
  }
  return copied;
}

describe('Dockerfile COPY vs poller.mjs import graph', () => {
  it('copies every local module poller.mjs imports, directly or transitively', () => {
    const required = collectLocalModules('poller.mjs');
    const dockerfile = fs.readFileSync(path.join(POLLER_DIR, 'Dockerfile'), 'utf8');
    const copied = collectDockerfileCopiedModules(dockerfile);
    const missing = [...required].filter((m) => !copied.has(m));
    expect(missing).toEqual([]);
  });

  it('the checker actually catches a missing module (sanity: fails against a stale COPY line)', () => {
    const staleDockerfile = 'COPY poller.mjs normalize.mjs recovery.mjs retry-queue.mjs yt-counts.mjs ./';
    const required = collectLocalModules('poller.mjs');
    const copied = collectDockerfileCopiedModules(staleDockerfile);
    const missing = [...required].filter((m) => !copied.has(m));
    expect(missing).toEqual(['capture.mjs']);
  });
});
