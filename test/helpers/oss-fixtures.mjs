// Shared fixture helpers for the publish-oss*.test.mjs files.
//
// Two problems this exists to fix (2026-10-13):
//
// 1. Tests must not depend on the developer's real repo or working tree.
//    Fixtures run `git init/add/commit` in temp dirs, but git honours
//    inherited GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE. Under a git hook
//    (pre-push/pre-commit running `npm test`) those point at the REAL repo,
//    so `git add -A && git commit` in a "temp" dir landed on the real
//    branch and every e2e test failed. cleanEnv() strips every GIT_* var,
//    pins identity through env (no `git config` spawns), and ignores
//    global/system git config (signing, hooksPath, aliases).
//
// 2. Per-test cost. Each fixture used to spawn ~10 git processes through
//    shells before the script under test spawned its own ~30. At the 5s
//    default test timeout that fails under CPU load (reproduced: 11 tests
//    timed out with the box oversubscribed 3x). Fewer spawns per fixture
//    plus a timeout sized for a loaded machine fixes both halves.
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import path from 'node:path';

// Spawn-heavy shell-script tests: generous ceiling, not a target. A hung
// script still fails, just not on a busy machine.
export const OSS_TEST_TIMEOUT_MS = 60_000;

export function cleanEnv(extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_')) env[key] = value;
  }
  return {
    ...env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_SYSTEM: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'test',
    GIT_AUTHOR_EMAIL: 'test@example.com',
    GIT_COMMITTER_NAME: 'test',
    GIT_COMMITTER_EMAIL: 'test@example.com',
    ...extra,
  };
}

export function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: cleanEnv() });
}

// git init, plus an initial commit when there is anything to commit.
// `files` (name -> content) are written first. 1 spawn when empty, 3 otherwise.
export function initRepo(dir, files = {}) {
  git(dir, ['init', '-q']);
  const names = Object.keys(files);
  for (const name of names) {
    writeFileSync(path.join(dir, name), files[name], 'utf8');
  }
  if (names.length) {
    git(dir, ['add', '-A']);
    git(dir, ['commit', '-q', '-m', 'init']);
  }
}
