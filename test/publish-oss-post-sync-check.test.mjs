// Covers tools/publish-oss.sh's post-sync stale-exclusion check (added
// 2026-09-19, ~line 136). rsync --delete --exclude-from protects an
// excluded destination path from deletion the same way it protects
// $DST/.git — so FASTFOLLOW_BATCH.md, newly added to .oss-exclude, never
// actually left the public repo on its own; it sat tracked and pushed for
// weeks. This test extracts the real check straight out of publish-oss.sh
// (never a reimplementation) and proves: (a) a stale tracked file matching
// a .oss-exclude .md entry still aborts, and (b) once removed from the
// fake $DST's git index, the check passes clean.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, cleanEnv, OSS_TEST_TIMEOUT_MS } from './helpers/oss-fixtures.mjs';

vi.setConfig({ testTimeout: OSS_TEST_TIMEOUT_MS });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SCRIPT = path.join(DIR, '..', 'tools', 'publish-oss.sh');

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

function makeFakeDst(trackedFiles) {
  const dst = makeTmpDir('publish-oss-dst-');
  git(dst, ['init', '-q']);
  for (const name of trackedFiles) {
    writeFileSync(path.join(dst, name), 'content\n', 'utf8');
  }
  if (trackedFiles.length) {
    git(dst, ['add', '-A']);
    git(dst, ['commit', '-q', '-m', 'init']);
  }
  return dst;
}

// Runs the real post-sync check block extracted out of publish-oss.sh into
// a real temp script (bash 3.2's `source <(process substitution)` does not
// reliably persist variables back to the parent shell, so this writes the
// extracted lines to a plain file first — same approach as the FORBIDDEN
// gate test).
function runPostSyncCheck(dst, ossExcludeContent) {
  const srcDir = makeTmpDir('publish-oss-src-');
  writeFileSync(path.join(srcDir, '.oss-exclude'), ossExcludeContent, 'utf8');
  const extracted = execFileSync(
    'sed',
    ['-n', '/^stale_hits=""$/,/^fi$/p', SCRIPT],
    { encoding: 'utf8' },
  );
  const gateFile = path.join(makeTmpDir('publish-oss-postsync-script-'), 'gate.sh');
  writeFileSync(
    gateFile,
    `#!/bin/bash\nset -euo pipefail\nSRC="${srcDir}/"\nDST="${dst}"\n${extracted}\nexit 0\n`,
    'utf8',
  );
  return spawnSync('bash', [gateFile], { encoding: 'utf8', env: cleanEnv() });
}

describe('publish-oss.sh post-sync stale-exclusion check', () => {
  it('aborts when $DST still tracks a file matching a .oss-exclude exact .md entry (original leak case)', () => {
    const dst = makeFakeDst(['FASTFOLLOW_BATCH.md', 'README.md']);
    const result = runPostSyncCheck(dst, 'FASTFOLLOW_BATCH.md\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FASTFOLLOW_BATCH.md');
  });

  it('passes once the stale file is removed from $DST git index', () => {
    const dst = makeFakeDst(['README.md']);
    const result = runPostSyncCheck(dst, 'FASTFOLLOW_BATCH.md\n');
    expect(result.status).toBe(0);
  });

  it('aborts on a stale file matching a wildcard .md glob (e.g. *_AUDIT_*.md), not just exact names', () => {
    const dst = makeFakeDst(['CAPTURE_AUDIT_2026-08-05.md']);
    const result = runPostSyncCheck(dst, '*_AUDIT_*.md\n');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CAPTURE_AUDIT_2026-08-05.md');
  });

  it('ignores a non-.md .oss-exclude entry (e.g. .dev.vars) — this check is scoped to docs only', () => {
    const dst = makeFakeDst(['.dev.vars']);
    const result = runPostSyncCheck(dst, '.dev.vars\n');
    expect(result.status).toBe(0);
  });

  it('ignores a tracked file that does not match any .oss-exclude .md entry', () => {
    const dst = makeFakeDst(['README.md', 'CHANGELOG.md']);
    const result = runPostSyncCheck(dst, 'FASTFOLLOW_BATCH.md\n');
    expect(result.status).toBe(0);
  });
});
