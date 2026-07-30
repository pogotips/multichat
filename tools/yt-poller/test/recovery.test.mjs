// Pure classification of youtube-chat ChatItems on RECONNECT: separates the
// initial history burst (recovered) from genuinely live items, with id
// dedupe and age/count caps. No network, no timers — kept testable in
// isolation like normalize.mjs.
import { describe, it, expect } from 'vitest';
import { classifyYtItem, RECOVERY_AGE_CAP_MS, RECOVERY_COUNT_CAP } from '../recovery.mjs';

function item(id, timestamp) {
  return { id, timestamp };
}

describe('classifyYtItem: not armed (cold boot / already caught up)', () => {
  it('sends the item as live, unarmed', () => {
    const seenIds = new Set();
    const result = classifyYtItem(item('a', new Date()), { armed: false, armedAt: null, recoveredCount: 0 }, seenIds);
    expect(result.send).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.ephemeral.armed).toBe(false);
  });
});

describe('classifyYtItem: armed (reconnect)', () => {
  it('an item older than T is recovered, stays armed, increments recoveredCount', () => {
    const armedAt = Date.now();
    const seenIds = new Set();
    const result = classifyYtItem(
      item('a', new Date(armedAt - 5000)),
      { armed: true, armedAt, recoveredCount: 0 },
      seenIds
    );
    expect(result.send).toBe(true);
    expect(result.recovered).toBe(true);
    expect(result.ephemeral).toEqual({ armed: true, armedAt, recoveredCount: 1 });
    expect(seenIds.has('a')).toBe(true);
  });

  it('an item at/after T is live and disarms', () => {
    const armedAt = Date.now();
    const seenIds = new Set();
    const result = classifyYtItem(item('b', new Date(armedAt)), { armed: true, armedAt, recoveredCount: 3 }, seenIds);
    expect(result.send).toBe(true);
    expect(result.recovered).toBe(false);
    expect(result.ephemeral.armed).toBe(false);
  });

  it('a recovered item older than the 10min age cap is dropped, not sent', () => {
    const armedAt = Date.now();
    const seenIds = new Set();
    const result = classifyYtItem(
      item('old', new Date(armedAt - RECOVERY_AGE_CAP_MS - 1)),
      { armed: true, armedAt, recoveredCount: 0 },
      seenIds
    );
    expect(result.send).toBe(false);
    expect(result.ephemeral).toEqual({ armed: true, armedAt, recoveredCount: 0 });
    expect(seenIds.has('old')).toBe(false); // dropped items don't occupy the dedupe cache
  });

  it('drops further recovered items once the 200 count cap is reached, stays armed', () => {
    const armedAt = Date.now();
    const seenIds = new Set();
    const result = classifyYtItem(
      item('capped', new Date(armedAt - 1000)),
      { armed: true, armedAt, recoveredCount: RECOVERY_COUNT_CAP },
      seenIds
    );
    expect(result.send).toBe(false);
    expect(result.ephemeral.recoveredCount).toBe(RECOVERY_COUNT_CAP);
  });

  it('a duplicate id is dropped regardless of armed state', () => {
    const armedAt = Date.now();
    const seenIds = new Set(['dup']);
    const armedResult = classifyYtItem(
      item('dup', new Date(armedAt - 1000)),
      { armed: true, armedAt, recoveredCount: 0 },
      seenIds
    );
    expect(armedResult.send).toBe(false);
    const liveResult = classifyYtItem(item('dup', new Date()), { armed: false, armedAt: null, recoveredCount: 0 }, seenIds);
    expect(liveResult.send).toBe(false);
  });
});
