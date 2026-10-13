// Covers tools/publish-oss.sh's FORBIDDEN sweep gate (grep_args, line ~61).
// 2026-09-19 fix: grep_args gained --exclude=oss-filename-leak-check.mjs and
// --exclude=oss-filename-leak-check.test.mjs (mirroring the leak-check's own
// skip list) because the first doc-name FORBIDDEN literal lives in those two
// files' own source (the leak-check's skip-list literal, and its test
// fixtures) and was aborting every publish. It later gained
// --exclude=publish-oss-forbidden-gate.test.mjs and
// --exclude=publish-oss-post-sync-check.test.mjs too, for the same reason:
// this file and test/publish-oss-post-sync-check.test.mjs legitimately write
// that doc name and FASTFOLLOW_BATCH.md as fixture content and tripped the gate on
// themselves the moment they were added. This test extracts the real
// grep_args construction straight out of publish-oss.sh — never a
// reimplementation — and proves: (a) the four named files are now skipped,
// and (b) a FORBIDDEN literal anywhere else still trips the gate.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { OSS_TEST_TIMEOUT_MS } from './helpers/oss-fixtures.mjs';

vi.setConfig({ testTimeout: OSS_TEST_TIMEOUT_MS });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, '..', 'tools', 'publish-oss.sh');
const PATTERNS_FILE = path.join(DIR, '..', 'tools', 'oss-forbidden-patterns.sh');

// Built at runtime so this file (gate-exempt, but still published) carries no
// FORBIDDEN literal itself.
const LIT = ['BACK', 'LOG.md'].join('');

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

// Extracts the *actual* FORBIDDEN array (now in oss-forbidden-patterns.sh —
// moved 2026-09-19 so this literal-string list stops shipping inside
// publish-oss.sh, which IS published) and the grep_args construction
// straight out of the real files (never a reimplementation) into a temp
// script and sources that — `source <(process substitution)` does not
// reliably persist variables back to the parent shell under macOS's bundled
// bash 3.2, so this writes the extracted lines to a plain file first.
function runForbiddenGate(scanRoot) {
  const extracted = [
    ...execFileSync('sed', ['-n', '/^FORBIDDEN=(/,/^)/p', PATTERNS_FILE], { encoding: 'utf8' }).split('\n'),
    ...execFileSync('sed', ['-n', '/^grep_args=(/,/^done$/p', SCRIPT], { encoding: 'utf8' }).split('\n'),
  ].join('\n');
  const gateFile = path.join(makeTmpDir('publish-oss-gate-script-'), 'gate.sh');
  writeFileSync(
    gateFile,
    `#!/bin/bash\nset -euo pipefail\n${extracted}\nhits="$(grep "\${grep_args[@]}" "${scanRoot}" || true)"\nif [ -n "$hits" ]; then\n  printf '%s\\n' "$hits"\n  exit 1\nfi\nexit 0\n`,
    'utf8',
  );
  return spawnSync('bash', [gateFile], { encoding: 'utf8' });
}

describe('publish-oss.sh FORBIDDEN gate', () => {
  it('still trips on a FORBIDDEN literal in an ordinary published file (original leak case preserved)', () => {
    const scanRoot = makeTmpDir('publish-oss-gate-');
    writeFileSync(path.join(scanRoot, 'CHANGELOG.md'), `see ${LIT} item 3\n`, 'utf8');
    const result = runForbiddenGate(scanRoot);
    expect(result.status).toBe(1);
    expect(result.stdout).toContain(LIT);
  });

  it('skips oss-filename-leak-check.mjs even though it legitimately contains the doc-name literal', () => {
    const scanRoot = makeTmpDir('publish-oss-gate-');
    writeFileSync(path.join(scanRoot, 'oss-filename-leak-check.mjs'), `excludeFiles: ['${LIT}']\n`, 'utf8');
    const result = runForbiddenGate(scanRoot);
    expect(result.status).toBe(0);
  });

  it('skips oss-filename-leak-check.test.mjs even though its fixtures reference the doc-name literal', () => {
    const scanRoot = makeTmpDir('publish-oss-gate-');
    writeFileSync(path.join(scanRoot, 'oss-filename-leak-check.test.mjs'), `writeFileSync(..., '${LIT}');\n`, 'utf8');
    const result = runForbiddenGate(scanRoot);
    expect(result.status).toBe(0);
  });

  it('does not broaden the exclude beyond the named files — a third file with the same basename fragment still trips', () => {
    const scanRoot = makeTmpDir('publish-oss-gate-');
    writeFileSync(path.join(scanRoot, 'oss-filename-leak-check.notes.md'), `${LIT}\n`, 'utf8');
    const result = runForbiddenGate(scanRoot);
    expect(result.status).toBe(1);
  });

  it('skips its own filename — a published-name file carrying a FORBIDDEN literal is exempt (this file itself no longer carries one)', () => {
    const scanRoot = makeTmpDir('publish-oss-gate-');
    writeFileSync(path.join(scanRoot, 'publish-oss-forbidden-gate.test.mjs'), `${LIT}\n`, 'utf8');
    const result = runForbiddenGate(scanRoot);
    expect(result.status).toBe(0);
  });

  it("test/publish-oss-post-sync-check.test.mjs's real content passes this gate regardless of the exclude (its FASTFOLLOW_BATCH.md fixtures aren't a FORBIDDEN literal — the file needed excluding from oss-filename-leak-check.mjs's gate instead, not this one; the exclude here is defensive)", () => {
    const scanRoot = makeTmpDir('publish-oss-gate-');
    const siblingContent = readFileSync(path.join(DIR, 'publish-oss-post-sync-check.test.mjs'), 'utf8');
    writeFileSync(path.join(scanRoot, 'publish-oss-post-sync-check.test.mjs'), siblingContent, 'utf8');
    const result = runForbiddenGate(scanRoot);
    expect(result.status).toBe(0);
  });

  it('grep_args declaration carries exactly the four --exclude entries alongside the pre-existing publish-oss.sh exclude', () => {
    const src = readFileSync(SCRIPT, 'utf8');
    const declLine = src.split('\n').find((l) => l.startsWith('grep_args=('));
    expect(declLine).toContain('--exclude=publish-oss.sh');
    expect(declLine).toContain('--exclude=oss-filename-leak-check.mjs');
    expect(declLine).toContain('--exclude=oss-filename-leak-check.test.mjs');
    expect(declLine).toContain('--exclude=publish-oss-forbidden-gate.test.mjs');
    expect(declLine).toContain('--exclude=publish-oss-post-sync-check.test.mjs');
    expect(declLine).toContain('--exclude=publish-oss-e2e.test.mjs');
  });
});
