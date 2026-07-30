import { describe, it, expect } from 'vitest';
import { enqueueRetry, drainBatch, isRetryable, RETRY_QUEUE_MAX, SEND_CONCURRENCY } from '../retry-queue.mjs';

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
    const started = Date.now();
    await drainBatch(queue, async () => { await delay(30); return true; }, 4);
    expect(Date.now() - started).toBeLessThan(30 * 4); // parallel, not 4x30ms serial
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
