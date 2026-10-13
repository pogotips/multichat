// poller_heartbeat `dropped` counter (2026-10-12): a 400/413 payload
// rejection is dropped on first failure (isPayloadRejection, retry-queue.mjs)
// and must show in the heartbeat as `dropped`, never as `failed`. poller.mjs
// is not import-safe in a test process (see zombie-watchdog.test.mjs), so
// the wiring is pinned by source text, same style as retry-queue.test.mjs's
// noteSendStatus wiring test.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { isPayloadRejection } from '../retry-queue.mjs';

const src = readFileSync(new URL('../poller.mjs', import.meta.url), 'utf8');
const sendOnce = src.slice(src.indexOf('async function sendOnce'), src.indexOf('async function drainLoop'));
const heartbeatLog = src.slice(src.indexOf("ev: 'poller_heartbeat'"), src.indexOf("ev: 'poller_heartbeat'") + 600);

describe('poller_heartbeat dropped counter', () => {
  it('declares and resets a separate cycleDropped counter', () => {
    expect(src).toContain('let cycleDropped = 0;');
    expect(src).toContain('cycleDropped = 0;\n');
    expect(src.match(/cycleDropped = 0;/g).length).toBeGreaterThanOrEqual(2);
  });

  it('sendOnce routes a payload rejection to dropped, everything else to failed', () => {
    expect(sendOnce).toContain('if (isPayloadRejection(res.status)) cycleDropped++; else cycleFailed++;');
    // counted before the body read: a throwing res.text() must not turn a
    // drop into a failure via the catch path
    expect(sendOnce.indexOf('isPayloadRejection(res.status)')).toBeLessThan(sendOnce.indexOf('await res.text()'));
    // and the body read itself never throws into that catch, so one response
    // is booked exactly once
    expect(sendOnce).toContain('await res.text().catch(');
    expect(sendOnce.match(/cycleFailed\+\+/g)).toHaveLength(2);
    expect(sendOnce.match(/cycleDropped\+\+/g)).toHaveLength(1);
    // the network-error catch stays a real failure
    expect(sendOnce).toMatch(/catch \(err\) \{[\s\S]*cycleFailed\+\+;/);
    expect(sendOnce).not.toMatch(/catch \(err\) \{[\s\S]*cycleDropped\+\+;/);
  });

  it('the heartbeat log carries failed and dropped side by side', () => {
    expect(heartbeatLog).toContain('failed: cycleFailed,');
    expect(heartbeatLog).toContain('dropped: cycleDropped,');
  });

  it('isPayloadRejection is imported from retry-queue.mjs, the same predicate drainBatch drops on', () => {
    expect(src).toMatch(/import \{[\s\S]*isPayloadRejection[\s\S]*\} from '\.\/retry-queue\.mjs'/);
    expect(isPayloadRejection(400)).toBe(true);
    expect(isPayloadRejection(413)).toBe(true);
    for (const s of [401, 403, 404, 408, 429, 500, 502, 503]) expect(isPayloadRejection(s)).toBe(false);
  });
});
