// FIX 2 (round-3 audit): LIVENESS_MAX_AGE_MS is derived from
// HEARTBEAT_INTERVAL_MS specifically so it can never drift out of sync with
// the actual counts/heartbeat cadence — an assumed-but-unverified interval
// would silently age out every liveness sample and turn the zombie-watchdog
// liveness gate into a no-op with nothing in the logs saying so.
//
// poller.mjs isn't import-safe in a test process (top-level process.exit on
// missing env, run() side effect at module scope — see zombie-watchdog.
// test.mjs's no-export rationale), so this is a source-text regression
// guard, same pattern as dockerfile.test.mjs's Dockerfile COPY check: it
// reads the actual files and asserts the constant and its wiring are
// present, rather than importing and asserting a runtime value.
//
// M1 fix (2026-09-12 review): the watchdog *_MS/*_CYCLES constants moved
// out of poller.mjs into watchdog.mjs (importable, so zombie-watchdog.
// test.mjs can use the real decision function instead of re-typing it) —
// this guard now reads watchdog.mjs for the constant derivations and
// poller.mjs only for the setInterval wiring, which stayed put.
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const POLLER_SOURCE = fs.readFileSync(path.join(DIR, '..', 'poller.mjs'), 'utf8');
const WATCHDOG_SOURCE = fs.readFileSync(path.join(DIR, '..', 'watchdog.mjs'), 'utf8');

describe('poller.mjs / watchdog.mjs heartbeat cadence', () => {
  it('HEARTBEAT_INTERVAL_MS is 15_000 — the value every *_CYCLES constant assumes', () => {
    expect(WATCHDOG_SOURCE).toMatch(/export const HEARTBEAT_INTERVAL_MS = 15_000;/);
  });

  it('the setInterval driving counts/liveness/heartbeat is parameterized by the named constant, not a bare literal', () => {
    // Guards against a future edit re-introducing `}, 15_000);` directly —
    // that would silently desync the interval from every derived threshold.
    expect(POLLER_SOURCE).toMatch(/setInterval\(heartbeatRunner, HEARTBEAT_INTERVAL_MS\);/);
    expect(POLLER_SOURCE).not.toMatch(/}, 15_000\);/);
  });

  it('LIVENESS_MAX_AGE_MS is derived from HEARTBEAT_INTERVAL_MS, not an independent literal', () => {
    expect(WATCHDOG_SOURCE).toMatch(/export const LIVENESS_MAX_AGE_MS = 4 \* HEARTBEAT_INTERVAL_MS;/);
  });

  it('ZOMBIE_WATCHDOG_CYCLES / REDISCOVERY_CYCLES / LEGACY_ZOMBIE_WATCHDOG_CYCLES are all derived from HEARTBEAT_INTERVAL_MS', () => {
    expect(WATCHDOG_SOURCE).toMatch(/export const ZOMBIE_WATCHDOG_CYCLES = \(ZOMBIE_WATCHDOG_MIN \* 60_000\) \/ HEARTBEAT_INTERVAL_MS;/);
    expect(WATCHDOG_SOURCE).toMatch(/export const REDISCOVERY_CYCLES = \(REDISCOVERY_MIN \* 60_000\) \/ HEARTBEAT_INTERVAL_MS;/);
    expect(WATCHDOG_SOURCE).toMatch(
      /export const LEGACY_ZOMBIE_WATCHDOG_CYCLES = \(LEGACY_ZOMBIE_WATCHDOG_MIN \* 60_000\) \/ HEARTBEAT_INTERVAL_MS;/,
    );
  });
});
