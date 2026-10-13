// Guards the shared publish-oss fixture helpers: a hook-style GIT_* env must
// never let a temp-dir fixture write to some other (the real) repo.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { git, initRepo, cleanEnv, OSS_TEST_TIMEOUT_MS } from './helpers/oss-fixtures.mjs';

vi.setConfig({ testTimeout: OSS_TEST_TIMEOUT_MS });

const dirs = [];
const savedEnv = {};
afterEach(() => {
  for (const key of Object.keys(savedEnv)) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
    delete savedEnv[key];
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function tmp(prefix) {
  const d = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}
function setEnv(key, value) {
  savedEnv[key] = process.env[key];
  process.env[key] = value;
}

describe('oss-fixtures cleanEnv', () => {
  it('drops inherited GIT_* vars and keeps the rest', () => {
    setEnv('GIT_DIR', '/nonexistent/decoy');
    setEnv('GIT_INDEX_FILE', '/nonexistent/index');
    setEnv('OSS_FIXTURE_KEEP', 'yes');
    const env = cleanEnv();
    expect(env.GIT_DIR).toBeUndefined();
    expect(env.GIT_INDEX_FILE).toBeUndefined();
    expect(env.OSS_FIXTURE_KEEP).toBe('yes');
  });

  it('initRepo commits into the temp dir even when GIT_DIR points at another repo', () => {
    const decoy = tmp('oss-fixtures-decoy-');
    git(decoy, ['init', '-q']);
    const target = tmp('oss-fixtures-target-');
    setEnv('GIT_DIR', path.join(decoy, '.git'));
    setEnv('GIT_WORK_TREE', decoy);

    initRepo(target, { 'a.txt': 'a\n' });

    expect(git(target, ['ls-files']).trim()).toBe('a.txt');
    // decoy repo must still have no commits
    expect(() => git(decoy, ['rev-parse', '--verify', '-q', 'HEAD'])).toThrow();
  });
});
