// Covers scripts/check-poller-deps.mjs, previously hand-verified only.
// Spawns the guard as a real subprocess against fixture trees under a temp
// dir (via CHECK_POLLER_DEPS_ROOT) — never touches the real
// tools/yt-poller/node_modules.
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD_SCRIPT = path.join(DIR, '..', 'scripts', 'check-poller-deps.mjs');
const SENTINEL = 'liveChatModeChangeMessageRenderer';

let tmpDirs = [];

function makeFixtureRoot() {
  const dir = mkdtempSync(path.join(tmpdir(), 'check-poller-deps-'));
  tmpDirs.push(dir);
  return dir;
}

function writeParserDist(pollerRoot, content) {
  const distDir = path.join(pollerRoot, 'node_modules', 'youtube-chat', 'dist');
  mkdirSync(distDir, { recursive: true });
  writeFileSync(path.join(distDir, 'parser.js'), content, 'utf8');
}

function runGuard(pollerRoot) {
  return spawnSync(process.execPath, [GUARD_SCRIPT], {
    env: { ...process.env, CHECK_POLLER_DEPS_ROOT: pollerRoot },
    encoding: 'utf8',
  });
}

afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

describe('check-poller-deps guard', () => {
  it('exits 1 when tools/yt-poller/node_modules is missing entirely', () => {
    const pollerRoot = makeFixtureRoot();
    // node_modules/youtube-chat deliberately not created.
    const result = runGuard(pollerRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('node_modules missing');
  });

  it('exits 1 when installed but unpatched (sentinel absent from dist)', () => {
    const pollerRoot = makeFixtureRoot();
    writeParserDist(pollerRoot, 'module.exports = {};\n// no sentinel here\n');
    const result = runGuard(pollerRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NOT patched');
  });

  it('exits 0 when installed and patched (sentinel present in dist)', () => {
    const pollerRoot = makeFixtureRoot();
    writeParserDist(pollerRoot, `module.exports = {};\n// ${SENTINEL} present\n`);
    const result = runGuard(pollerRoot);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');
  });
});
