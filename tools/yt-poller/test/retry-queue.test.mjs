import { describe, it, expect } from 'vitest';
import { enqueueRetry, drainBatch, isRetryable, RETRY_QUEUE_MAX, SEND_CONCURRENCY, nextAttempt } from '../retry-queue.mjs';

describe('nextAttempt', () => {
  it('starts at 1 and increments per call for the same message identity', () => {
    const msg = { user: 'Alice', text: 'hi' };
    expect(nextAttempt(msg)).toBe(1);
    expect(nextAttempt(msg)).toBe(2);
    expect(nextAttempt(msg)).toBe(3);
  });

  it('tracks each message object independently — one message\'s retries never inflate another\'s count', () => {
    const msgA = { user: 'Alice', text: 'hi' };
    const msgB = { user: 'Bob', text: 'yo' };
    expect(nextAttempt(msgA)).toBe(1);
    expect(nextAttempt(msgA)).toBe(2);
    expect(nextAttempt(msgB)).toBe(1);
  });

  it('two distinct objects with identical content are still counted separately (identity, not equality)', () => {
    const first = { user: 'Alice', text: 'hi' };
    const second = { user: 'Alice', text: 'hi' };
    expect(nextAttempt(first)).toBe(1);
    expect(nextAttempt(second)).toBe(1);
    expect(nextAttempt(first)).toBe(2);
  });

  it('a non-object msg (e.g. a bare string test double) always reads as attempt 1, never throws', () => {
    expect(nextAttempt('msgA')).toBe(1);
    expect(nextAttempt('msgA')).toBe(1);
    expect(nextAttempt(null)).toBe(1);
    expect(nextAttempt(undefined)).toBe(1);
  });
});

describe('isRetryable', () => {
  it('excludes heartbeats', () => {
    expect(isRetryable({ type: 'heartbeat' })).toBe(false);
  });
  it('includes chat messages', () => {
    expect(isRetryable({ user: 'Alice', text: 'hi' })).toBe(true);
  });
  it('excludes null/undefined', () => {
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(undefined)).toBe(false);
  });
});

describe('enqueueRetry', () => {
  it('appends an item', () => {
    const queue = [];
    enqueueRetry(queue, 'a', 3);
    expect(queue).toEqual(['a']);
  });

  it('drops the oldest once over maxSize', () => {
    const queue = ['a', 'b', 'c'];
    enqueueRetry(queue, 'd', 3);
    expect(queue).toEqual(['b', 'c', 'd']);
  });

  it('defaults to RETRY_QUEUE_MAX', () => {
    const queue = Array.from({ length: RETRY_QUEUE_MAX }, (_, i) => i);
    enqueueRetry(queue, 'overflow');
    expect(queue.length).toBe(RETRY_QUEUE_MAX);
    expect(queue.at(-1)).toBe('overflow');
    expect(queue[0]).toBe(1); // oldest (0) dropped
  });
});

describe('drainBatch', () => {
  it('sends up to `concurrency` items and empties the queue on all-success', async () => {
    const queue = ['a', 'b', 'c'];
    const sent = [];
    const result = await drainBatch(queue, async (item) => {
      sent.push(item);
      return true;
    }, 4);
    expect(sent.sort()).toEqual(['a', 'b', 'c']);
    expect(queue).toEqual([]);
    expect(result).toEqual({ attempted: 3, sent: 3 });
  });

  it('only claims `concurrency` items when the queue is larger', async () => {
    const queue = ['a', 'b', 'c', 'd', 'e'];
    const result = await drainBatch(queue, async () => true, 2);
    expect(result.attempted).toBe(2);
    expect(queue).toEqual(['c', 'd', 'e']); // untouched items stay queued, in order
  });

  it('runs the batch concurrently, not sequentially', async () => {
    const queue = ['a', 'b', 'c', 'd'];
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    // Peak-in-flight counter, not a real-clock bound — deterministic and
    // immune to CI scheduling jitter, but still fails if dispatch is
    // serialized (peak would drop to 1).
    let inFlight = 0;
    let peakInFlight = 0;
    await drainBatch(queue, async () => {
      inFlight++;
      peakInFlight = Math.max(peakInFlight, inFlight);
      await delay(30);
      inFlight--;
      return true;
    }, 4);
    expect(peakInFlight).toBe(4);
  });

  it('requeues failures at the front, preserving their relative order', async () => {
    const queue = ['a', 'b', 'c'];
    const result = await drainBatch(queue, async (item) => item !== 'a' && item !== 'c', 4);
    expect(result).toEqual({ attempted: 3, sent: 1 });
    expect(queue).toEqual(['a', 'c']); // failures back in original relative order
  });

  it('newly-claimed batch never includes items pushed to the queue mid-flight', async () => {
    const queue = ['a', 'b'];
    const result = await drainBatch(queue, async (item) => {
      if (item === 'a') queue.push('injected-during-flight');
      return true;
    }, 4);
    expect(result.attempted).toBe(2); // only the 2 items present when drainBatch started
    expect(queue).toEqual(['injected-during-flight']);
  });

  it('no-ops on an empty queue', async () => {
    const queue = [];
    const result = await drainBatch(queue, async () => true, 4);
    expect(result).toEqual({ attempted: 0, sent: 0 });
  });

  it('defaults concurrency to SEND_CONCURRENCY', async () => {
    const queue = Array.from({ length: SEND_CONCURRENCY + 2 }, (_, i) => i);
    const result = await drainBatch(queue, async () => true);
    expect(result.attempted).toBe(SEND_CONCURRENCY);
  });
});
