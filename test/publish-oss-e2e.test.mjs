// End-to-end coverage of tools/publish-oss.sh's control flow: --stage-only,
// the pre-write non-tty/no---yes refusal, and the commit-subject sha stamp
// (all added 2026-09-19). Runs the REAL script (never a reimplementation)
// against a small fabricated SRC and DST — since SCRIPT_DIR/SRC are derived
// from the script's own on-disk location (`dirname "${BASH_SOURCE[0]}"`),
// a fake SRC means copying the real tools/publish-oss.sh,
// tools/oss-forbidden-patterns.sh and tools/oss-filename-leak-check.mjs
// into a temp tree at the same relative layout (<tmp>/tools/*.sh next to
// <tmp>/.oss-exclude), and DST is redirected by overriding $HOME (DST is
// `${HOME}/multichat-oss`) — every run here uses a temp HOME, never the
// real ~/multichat-oss.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { git, cleanEnv, OSS_TEST_TIMEOUT_MS } from './helpers/oss-fixtures.mjs';

vi.setConfig({ testTimeout: OSS_TEST_TIMEOUT_MS });

const DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.join(DIR, '..');
const REAL_SCRIPT = path.join(REPO_ROOT, 'tools', 'publish-oss.sh');
const REAL_PATTERNS = path.join(REPO_ROOT, 'tools', 'oss-forbidden-patterns.sh');
// Skipped when the private forbidden-patterns list (tools/oss-forbidden-patterns.sh, never published) is absent — e.g. in a clone of the public repo.
const HAS_PATTERNS = existsSync(REAL_PATTERNS);
const REAL_LEAK_CHECK = path.join(REPO_ROOT, 'tools', 'oss-filename-leak-check.mjs');

// FORBIDDEN literals are built at runtime: this file is exempt from the publish
// sweep gates but is still published, so it must not carry them itself.
const TERM = ['te', 'rm@'].join('');
const IP = ['192.', '168.1.1'].join('');
const WORD_A = ['v', 'id'].join('');

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

// Builds a fake SRC repo: <tmp>/tools/{publish-oss.sh,oss-forbidden-patterns.sh,
// oss-filename-leak-check.mjs} + <tmp>/.oss-exclude + whatever extra files the
// caller wants, committed so the script's dirty-check passes by default.
function makeFakeSrc({ files = {}, dirty = false } = {}) {
  const src = makeTmpDir('publish-oss-e2e-src-');
  mkdirSync(path.join(src, 'tools'), { recursive: true });
  copyFileSync(REAL_SCRIPT, path.join(src, 'tools', 'publish-oss.sh'));
  copyFileSync(REAL_PATTERNS, path.join(src, 'tools', 'oss-forbidden-patterns.sh'));
  copyFileSync(REAL_LEAK_CHECK, path.join(src, 'tools', 'oss-filename-leak-check.mjs'));
  writeFileSync(path.join(src, '.oss-exclude'), '.git\nnode_modules\ntools/oss-forbidden-patterns.sh\n', 'utf8');
  writeFileSync(path.join(src, 'README.md'), '# fake\n', 'utf8');
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(src, name)), { recursive: true });
    writeFileSync(path.join(src, name), content, 'utf8');
  }
  git(src, ['init', '-q']);
  git(src, ['add', '-A']);
  git(src, ['commit', '-q', '-m', 'init']);
  if (dirty) {
    writeFileSync(path.join(src, 'README.md'), '# fake, but dirty now\n', 'utf8');
  }
  return src;
}

// Builds a fake $HOME whose multichat-oss subdir is the fake DST — a
// bare-bones git repo (publish-oss.sh only requires $DST/.git to exist),
// optionally pre-tracking some files.
function makeFakeHomeWithDst(trackedFiles = []) {
  const home = makeTmpDir('publish-oss-e2e-home-');
  const dst = path.join(home, 'multichat-oss');
  mkdirSync(dst, { recursive: true });
  git(dst, ['init', '-q']);
  for (const name of trackedFiles) {
    writeFileSync(path.join(dst, name), 'content\n', 'utf8');
  }
  if (trackedFiles.length) {
    git(dst, ['add', '-A']);
    git(dst, ['commit', '-q', '-m', 'init']);
  }
  return { home, dst };
}

function runPublish(src, home, args, opts = {}) {
  return spawnSync('bash', [path.join(src, 'tools', 'publish-oss.sh'), ...args], {
    encoding: 'utf8',
    env: cleanEnv({ HOME: home }),
    input: opts.stdin,
  });
}

describe.skipIf(!HAS_PATTERNS)('publish-oss.sh --stage-only', () => {
  it('exits 0 on a clean tree without ever writing to $DST', () => {
    const src = makeFakeSrc();
    const { home, dst } = makeFakeHomeWithDst(['README.md']);
    const before = readFileSync(path.join(dst, '.git', 'HEAD'), 'utf8');

    const result = runPublish(src, home, ['--stage-only']);

    expect(result.status).toBe(0);
    expect(git(dst, ['status', '--porcelain'])).toBe('');
    expect(readFileSync(path.join(dst, '.git', 'HEAD'), 'utf8')).toBe(before);
  });

  it('exits 1 on a forbidden-string hit, still without writing to $DST', () => {
    const src = makeFakeSrc({ files: { 'notes.md': `internal host ${TERM}example lives at ${IP}\n` } });
    const { home, dst } = makeFakeHomeWithDst(['README.md']);

    const result = runPublish(src, home, ['--stage-only']);

    expect(result.status).toBe(1);
    expect(git(dst, ['status', '--porcelain'])).toBe('');
  });

  it('exits 1 on a forbidden whole-word hit', () => {
    const src = makeFakeSrc({ files: { 'notes.md': `ssh ${WORD_A} for logs\n` } });
    const { home } = makeFakeHomeWithDst(['README.md']);

    const result = runPublish(src, home, ['--stage-only']);

    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/forbidden/);
  });

  it('never rsyncs into $DST even when a custom commit message arg is also passed', () => {
    const src = makeFakeSrc();
    const { home, dst } = makeFakeHomeWithDst([]);

    const result = runPublish(src, home, ['--stage-only', 'some custom message']);

    expect(result.status).toBe(0);
    expect(git(dst, ['ls-files'])).toBe('');
  });
});

describe.skipIf(!HAS_PATTERNS)('publish-oss.sh non-interactive refusal happens before any $DST write', () => {
  it('exits 2 with no tty and no --yes, and $DST is untouched', () => {
    const src = makeFakeSrc();
    const { home, dst } = makeFakeHomeWithDst(['README.md']);

    const result = runPublish(src, home, [], { stdin: '' });

    expect(result.status).toBe(2);
    expect(git(dst, ['status', '--porcelain'])).toBe('');
    expect(git(dst, ['ls-files']).trim()).toBe('README.md');
  });
});

describe.skipIf(!HAS_PATTERNS)('publish-oss.sh commit subject stamps the source sha', () => {
  it('refuses to publish from a dirty source tree', () => {
    const src = makeFakeSrc({ dirty: true });
    const { home } = makeFakeHomeWithDst(['README.md']);

    const result = runPublish(src, home, ['--yes']);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('uncommitted changes');
  });

  it('default commit subject is "sync from private <short sha of SRC>"', () => {
    const src = makeFakeSrc();
    const srcSha = git(src, ['rev-parse', '--short', 'HEAD']).trim();
    const { home, dst } = makeFakeHomeWithDst(['README.md']);

    const result = runPublish(src, home, ['--yes']);

    expect(result.status).toBe(0);
    const subject = git(dst, ['log', '-1', '--pretty=%s']).trim();
    expect(subject).toBe(`sync from private ${srcSha}`);
  });

  it('a custom commit message overrides the default subject as-is', () => {
    const src = makeFakeSrc();
    const { home, dst } = makeFakeHomeWithDst(['README.md']);

    const result = runPublish(src, home, ['--yes', 'a hand-written message']);

    expect(result.status).toBe(0);
    const subject = git(dst, ['log', '-1', '--pretty=%s']).trim();
    expect(subject).toBe('a hand-written message');
  });
});
