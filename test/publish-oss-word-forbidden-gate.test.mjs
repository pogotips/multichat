// Covers tools/publish-oss.sh's whole-word FORBIDDEN sweep (word_grep_args,
// added 2026-09-19 alongside the FORBIDDEN_WORDS list in
// tools/oss-forbidden-patterns.sh). Plain substring matching (the original
// FORBIDDEN gate) false-positives on short words (the first listed entry is inside
// "video" and "provide") — so these two entries need `grep -w` instead. This
// test extracts the real FORBIDDEN_WORDS array and word_grep_args
// construction straight out of the real files (never a reimplementation)
// and proves: (a) each listed word trips on its own, as a whole word, (b)
// the words that merely contain it as a substring never trip, and (c) the
// sweep is clean against a fresh STAGE of this repo's own tree.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnv, OSS_TEST_TIMEOUT_MS } from './helpers/oss-fixtures.mjs';

vi.setConfig({ testTimeout: OSS_TEST_TIMEOUT_MS });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, '..', 'tools', 'publish-oss.sh');
const PATTERNS_FILE = path.join(DIR, '..', 'tools', 'oss-forbidden-patterns.sh');
// Skipped when the private forbidden-patterns list (tools/oss-forbidden-patterns.sh, never published) is absent — e.g. in a clone of the public repo.
const HAS_PATTERNS = existsSync(PATTERNS_FILE);
const REPO_ROOT = path.join(DIR, '..');

// Built at runtime so this file (gate-exempt, but still published) carries no
// FORBIDDEN_WORDS literal itself.
const WORD_A = ['v', 'id'].join('');
const WORD_B = ['quo', 'trok'].join('');

let tmpDirs = [];
function makeTmpDir(prefix) {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of tmpDirs) rmSync(dir, { recursive: true, force: true });
  tmpDirs = [];
});

function runWordGate(scanRoot) {
  const extracted = [
    ...execFileSync('sed', ['-n', '/^FORBIDDEN_WORDS=(/,/^)/p', PATTERNS_FILE], { encoding: 'utf8' }).split('\n'),
    ...execFileSync('sed', ['-n', '/^FORBIDDEN_EXCLUDES=(/,/^)/p', SCRIPT], { encoding: 'utf8' }).split('\n'),
    ...execFileSync('sed', ['-n', '/^word_grep_args=(/,/^done$/p', SCRIPT], { encoding: 'utf8' }).split('\n'),
  ].join('\n');
  const gateFile = path.join(makeTmpDir('publish-oss-word-gate-script-'), 'gate.sh');
  writeFileSync(
    gateFile,
    `#!/bin/bash\nset -euo pipefail\n${extracted}\nhits="$(grep "\${word_grep_args[@]}" "${scanRoot}" || true)"\nif [ -n "$hits" ]; then\n  printf '%s\\n' "$hits"\n  exit 1\nfi\nexit 0\n`,
    'utf8',
  );
  return spawnSync('bash', [gateFile], { encoding: 'utf8' });
}

describe.skipIf(!HAS_PATTERNS)('publish-oss.sh whole-word FORBIDDEN gate', () => {
  it('trips on the standalone short word (first entry)', () => {
    const scanRoot = makeTmpDir('publish-oss-word-gate-');
    writeFileSync(path.join(scanRoot, 'notes.md'), `ssh ${WORD_A} for logs\n`, 'utf8');
    const result = runWordGate(scanRoot);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(WORD_A);
  });

  it('does NOT trip on "video"', () => {
    const scanRoot = makeTmpDir('publish-oss-word-gate-');
    writeFileSync(path.join(scanRoot, 'notes.md'), 'record a video of the stream\n', 'utf8');
    const result = runWordGate(scanRoot);
    expect(result.status).toBe(0);
  });

  it('does NOT trip on "provide"', () => {
    const scanRoot = makeTmpDir('publish-oss-word-gate-');
    writeFileSync(path.join(scanRoot, 'notes.md'), 'this endpoint does not provide auth\n', 'utf8');
    const result = runWordGate(scanRoot);
    expect(result.status).toBe(0);
  });

  it('trips on the standalone word (second entry)', () => {
    const scanRoot = makeTmpDir('publish-oss-word-gate-');
    writeFileSync(path.join(scanRoot, 'notes.md'), `moderator_user_login: ${WORD_B}\n`, 'utf8');
    const result = runWordGate(scanRoot);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(WORD_B);
  });

  it('does NOT trip on the second entry as a substring of a longer word', () => {
    const scanRoot = makeTmpDir('publish-oss-word-gate-');
    writeFileSync(path.join(scanRoot, 'notes.md'), `${WORD_B}ish is not a real word\n`, 'utf8');
    const result = runWordGate(scanRoot);
    expect(result.status).toBe(0);
  });

  it('word_grep_args declaration carries -w and the same exclude list as grep_args, plus itself', () => {
    const src = execFileSync('cat', [SCRIPT], { encoding: 'utf8' });
    const wordDecl = src.split('\n').find((l) => l.startsWith('word_grep_args=('));
    expect(wordDecl).toContain('-w');
    expect(wordDecl).toContain('"${FORBIDDEN_EXCLUDES[@]}"');
    const declLine = execFileSync('sed', ['-n', '/^FORBIDDEN_EXCLUDES=(/,/^)/p', SCRIPT], { encoding: 'utf8' });
    expect(declLine).toContain('--exclude=publish-oss.sh');
    expect(declLine).toContain('--exclude=oss-filename-leak-check.mjs');
    expect(declLine).toContain('--exclude=oss-filename-leak-check.test.mjs');
    expect(declLine).toContain('--exclude=publish-oss-forbidden-gate.test.mjs');
    expect(declLine).toContain('--exclude=publish-oss-post-sync-check.test.mjs');
    expect(declLine).toContain('--exclude=publish-oss-word-forbidden-gate.test.mjs');
    expect(declLine).toContain('--exclude=publish-oss-e2e.test.mjs');
  });

  it('skips its own filename — a published-name file carrying both words is exempt (this file itself no longer carries them)', () => {
    const scanRoot = makeTmpDir('publish-oss-word-gate-');
    writeFileSync(path.join(scanRoot, 'publish-oss-word-forbidden-gate.test.mjs'), `${WORD_A} ${WORD_B}\n`, 'utf8');
    const result = runWordGate(scanRoot);
    expect(result.status).toBe(0);
  });

  it('is clean against a fresh STAGE of this repo (mirrors the real rsync --exclude-from pass)', () => {
    // Source is the COMMITTED tree (git archive HEAD), not the working dir:
    // an untracked scratch file or an unstaged edit on the developer's tree
    // must not decide this test (the real publish refuses a dirty tree
    // anyway, so committed content is exactly what would ship).
    const committed = makeTmpDir('publish-oss-word-gate-committed-');
    const archive = spawnSync('bash', ['-c', 'set -o pipefail; git archive --format=tar HEAD -- . | tar -x -C "$1"', 'bash', committed], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: cleanEnv(),
    });
    expect(archive.status).toBe(0);
    const stage = makeTmpDir('publish-oss-word-gate-stage-');
    const ossExclude = path.join(committed, '.oss-exclude');
    const rsync = spawnSync('rsync', ['-a', `--exclude-from=${ossExclude}`, `${committed}/`, `${stage}/`], {
      encoding: 'utf8',
    });
    expect(rsync.status).toBe(0);
    const result = runWordGate(stage);
    if (result.status !== 0) {
      // eslint-disable-next-line no-console
      console.error(result.stdout);
    }
    expect(result.status).toBe(0);
  });
});
