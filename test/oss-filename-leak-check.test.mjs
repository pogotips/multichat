// Covers tools/oss-filename-leak-check.mjs, publish-oss.sh's content-scan
// gate against internal doc filenames leaking into published code comments
// (2026-08-18 incident: 3 such references shipped before this gate existed).
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePatterns, scanDirForPatterns } from '../tools/oss-filename-leak-check.mjs';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CHECK_SCRIPT = path.join(DIR, '..', 'tools', 'oss-filename-leak-check.mjs');
// Built at runtime: this file is published but exempt from the FORBIDDEN sweep, so the literal must not appear in source.
const BL = ['BACK', 'LOG.md'].join('');
const FF = ['FASTFOLLOW_', 'BATCH.md'].join('');

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

describe('derivePatterns', () => {
  it('extracts a reusable naming-convention token from a wildcard glob line', () => {
    expect(derivePatterns('*_AUDIT_*.md\n')).toEqual(['_AUDIT_']);
    expect(derivePatterns('SHIP_REPORT_*.md\n')).toEqual(['SHIP_REPORT_']);
  });

  it('ignores comments and blank lines', () => {
    const content = ['# a comment', '', '*_REVIEW_*.md'].join('\n');
    expect(derivePatterns(content)).toEqual(['_REVIEW_']);
  });

  // M3 fix (2026-09-12 review, round 2): exact (non-wildcard) .md entries
  // used to contribute nothing, on the (false) assumption they're always
  // covered by a shared wildcard convention token — the fast-follow list,
  // the backlog doc, and the consent-day runbook all disproved that. They now
  // contribute their own basename as a literal, case-sensitive pattern.
  it('derives a literal basename pattern from an exact (non-wildcard) .md filename', () => {
    const content = ['# a comment', '', FF, '*_REVIEW_*.md'].join('\n');
    expect(derivePatterns(content).sort()).toEqual([FF, '_REVIEW_'].sort());
  });

  it('derives the basename, not the full path, for an exact entry nested in a directory', () => {
    expect(derivePatterns('docs/' + BL + '\n')).toEqual([BL]);
  });

  it('dedupes an exact entry and a directory-nested entry that share a basename', () => {
    const content = BL + '\ndocs/' + BL + '\n';
    expect(derivePatterns(content)).toEqual([BL]);
  });

  it('does not derive a pattern from exact non-.md entries (infra excludes, not doc filenames)', () => {
    const content = ['.git', '.claude/', 'node_modules', '.dev.vars', 'wrangler.jsonc', '.oss-exclude'].join('\n');
    expect(derivePatterns(content)).toEqual([]);
  });

  it('dedupes identical tokens across multiple glob lines', () => {
    const content = '*_AUDIT_*.md\n*_AUDIT_*.md\n';
    expect(derivePatterns(content)).toEqual(['_AUDIT_']);
  });
});

describe('scanDirForPatterns', () => {
  it('finds a pattern referenced inside a source file comment, with file:line', () => {
    const dir = makeTmpDir('oss-leak-scan-');
    writeFileSync(path.join(dir, 'code.mjs'), '// see SHIP_REPORT_2026-08-09_combo.md for context\nconst x = 1;\n', 'utf8');
    const hits = scanDirForPatterns(dir, ['SHIP_REPORT_']);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].file).toContain('code.mjs');
  });

  it('returns no hits on clean content', () => {
    const dir = makeTmpDir('oss-leak-scan-');
    writeFileSync(path.join(dir, 'code.mjs'), '// nothing private here\nconst x = 1;\n', 'utf8');
    expect(scanDirForPatterns(dir, ['SHIP_REPORT_', '_AUDIT_'])).toEqual([]);
  });

  it('recurses into subdirectories and skips excluded dirs/files', () => {
    const dir = makeTmpDir('oss-leak-scan-');
    mkdirSync(path.join(dir, 'nested'), { recursive: true });
    mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
    writeFileSync(path.join(dir, 'nested', 'deep.mjs'), '// _AUDIT_ reference\n', 'utf8');
    writeFileSync(path.join(dir, 'node_modules', 'vendor.mjs'), '// _AUDIT_ reference\n', 'utf8');
    writeFileSync(path.join(dir, '.oss-exclude'), '*_AUDIT_*.md\n', 'utf8');
    const hits = scanDirForPatterns(dir, ['_AUDIT_'], {
      excludeDirs: ['.git', 'node_modules'],
      excludeFiles: ['.oss-exclude'],
    });
    expect(hits).toHaveLength(1);
    expect(hits[0].file).toContain('deep.mjs');
  });
});

describe('CLI (subprocess, real .oss-exclude derivation)', () => {
  function runCheck(scanRoot, ossExcludeFile) {
    return spawnSync(process.execPath, [CHECK_SCRIPT, scanRoot], {
      env: { ...process.env, OSS_EXCLUDE_FILE: ossExcludeFile },
      encoding: 'utf8',
    });
  }

  it('exits 1 and prints the offending line when a leak is present', () => {
    const scanRoot = makeTmpDir('oss-leak-cli-');
    const ossExcludeFile = path.join(makeTmpDir('oss-leak-exclude-'), '.oss-exclude');
    writeFileSync(ossExcludeFile, '*_AUDIT_*.md\nSHIP_REPORT_*.md\n', 'utf8');
    writeFileSync(path.join(scanRoot, 'worker.js'), '// per an internal CAPTURE_AUDIT_2026-08-05 finding\n', 'utf8');
    const result = runCheck(scanRoot, ossExcludeFile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('CAPTURE_AUDIT_2026-08-05');
  });

  it('exits 0 clean when no pattern appears anywhere in scanned content', () => {
    const scanRoot = makeTmpDir('oss-leak-cli-');
    const ossExcludeFile = path.join(makeTmpDir('oss-leak-exclude-'), '.oss-exclude');
    writeFileSync(ossExcludeFile, '*_AUDIT_*.md\nSHIP_REPORT_*.md\n', 'utf8');
    writeFileSync(path.join(scanRoot, 'worker.js'), '// nothing private here\n', 'utf8');
    const result = runCheck(scanRoot, ossExcludeFile);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('clean');
  });

  it('exits 1 when an exact-name .oss-exclude entry is referenced by filename in a published doc (M3 fix, round 2)', () => {
    const scanRoot = makeTmpDir('oss-leak-cli-');
    const ossExcludeFile = path.join(makeTmpDir('oss-leak-exclude-'), '.oss-exclude');
    writeFileSync(ossExcludeFile, FF + '\n', 'utf8');
    writeFileSync(path.join(scanRoot, 'CHANGELOG.md'), 'see ' + FF + ' item 3\n', 'utf8');
    const result = runCheck(scanRoot, ossExcludeFile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(FF);
  });

  it('does not flag its own excluded files (.oss-exclude, publish-oss.sh) even though they legitimately contain the glob patterns', () => {
    const scanRoot = makeTmpDir('oss-leak-cli-');
    const ossExcludeFile = path.join(makeTmpDir('oss-leak-exclude-'), '.oss-exclude');
    const excludeContent = '*_AUDIT_*.md\nSHIP_REPORT_*.md\n';
    writeFileSync(ossExcludeFile, excludeContent, 'utf8');
    // Simulate these two files existing inside the scanned STAGE tree too,
    // exactly as they do in a real publish-oss.sh run.
    writeFileSync(path.join(scanRoot, '.oss-exclude'), excludeContent, 'utf8');
    writeFileSync(path.join(scanRoot, 'publish-oss.sh'), "FORBIDDEN=('SHIP_REPORT_')\n", 'utf8');
    const result = runCheck(scanRoot, ossExcludeFile);
    expect(result.status).toBe(0);
  });

  // 2026-09-19: publish-oss.sh's own regression tests for its FORBIDDEN
  // gate (test/publish-oss-forbidden-gate.test.mjs and
  // test/publish-oss-post-sync-check.test.mjs) legitimately write
  // the backlog doc/fast-follow list as fixture content and tripped this
  // check on themselves the moment they were added — same class of
  // self-reference as the two files above.
  it('does not flag its own excluded test files (publish-oss-forbidden-gate.test.mjs, publish-oss-post-sync-check.test.mjs) even though they legitimately write the backlog doc/fast-follow list as fixtures', () => {
    const scanRoot = makeTmpDir('oss-leak-cli-');
    const ossExcludeFile = path.join(makeTmpDir('oss-leak-exclude-'), '.oss-exclude');
    writeFileSync(ossExcludeFile, BL + '\n' + FF + '\n', 'utf8');
    writeFileSync(
      path.join(scanRoot, 'publish-oss-forbidden-gate.test.mjs'),
      "writeFileSync(path.join(scanRoot, 'CHANGELOG.md'), 'see " + BL + " item 3');\n",
      'utf8',
    );
    writeFileSync(
      path.join(scanRoot, 'publish-oss-post-sync-check.test.mjs'),
      "const dst = makeFakeDst(['" + FF + "']);\n",
      'utf8',
    );
    const result = runCheck(scanRoot, ossExcludeFile);
    expect(result.status).toBe(0);
  });

  it('still flags the backlog doc/fast-follow list referenced from any other file (original leak case preserved)', () => {
    const scanRoot = makeTmpDir('oss-leak-cli-');
    const ossExcludeFile = path.join(makeTmpDir('oss-leak-exclude-'), '.oss-exclude');
    writeFileSync(ossExcludeFile, BL + '\n' + FF + '\n', 'utf8');
    writeFileSync(path.join(scanRoot, 'NOTES.md'), 'see ' + BL + ' and ' + FF + '\n', 'utf8');
    const result = runCheck(scanRoot, ossExcludeFile);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(BL);
    expect(result.stderr).toContain(FF);
  });
});
