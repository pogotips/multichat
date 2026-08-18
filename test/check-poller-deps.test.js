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
import { SENTINEL, PARSER_DIST_RELATIVE_PATH } from '../scripts/poller-patch-sentinel.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const GUARD_SCRIPT = path.join(DIR, '..', 'scripts', 'check-poller-deps.mjs');

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

  it('exits 1 when youtube-chat is present but dist/parser.js is absent', () => {
    const pollerRoot = makeFixtureRoot();
    // node_modules/youtube-chat exists (passes the first existsSync check)
    // but never got built/copied a dist/ directory at all.
    mkdirSync(path.join(pollerRoot, 'node_modules', 'youtube-chat'), { recursive: true });
    const result = runGuard(pollerRoot);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('NOT patched');
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

  it('checks the file at PARSER_DIST_RELATIVE_PATH, not just any dist/parser.js', () => {
    // Proves the test suite would catch a drift between the constant and
    // the guard's actual lookup location: write the sentinel-bearing file
    // exactly where PARSER_DIST_RELATIVE_PATH says it should live (derived
    // from the shared constant, not the hardcoded 'dist/parser.js' segments
    // used elsewhere in this file), and confirm the guard finds it there.
    const pollerRoot = makeFixtureRoot();
    const target = path.join(pollerRoot, PARSER_DIST_RELATIVE_PATH);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, `module.exports = {};\n// ${SENTINEL} present\n`, 'utf8');
    const result = runGuard(pollerRoot);
    expect(result.status).toBe(0);
    expect(result.stderr).toBe('');

    // If the constant's path were wrong (didn't match where the guard
    // actually looks: node_modules/youtube-chat/dist/parser.js), this
    // fixture write would have landed somewhere the guard never inspects,
    // and the guard would instead report the module as missing/unpatched.
    expect(PARSER_DIST_RELATIVE_PATH).toBe('node_modules/youtube-chat/dist/parser.js');
  });
});
