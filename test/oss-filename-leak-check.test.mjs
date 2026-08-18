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

  it('ignores comments, blank lines, and exact (non-wildcard) filenames', () => {
    const content = [
      '# a comment',
      '',
      'CAPTURE_AUDIT_2026-08-05.md', // exact filename, no "*" — not a reusable token on its own
      '*_REVIEW_*.md',
    ].join('\n');
    expect(derivePatterns(content)).toEqual(['_REVIEW_']);
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
});
