// Internal forensics doc (2026-08-05), rec 5: a minimal client error beacon,
// gated on requireEventsToken — the same either-secret (view or overlay)
// check /events already uses (never an open endpoint), widened from
// view-only per the ChatHub review of 2026-09-12 (internal), H1 follow-up so the
// overlay's own onmessage catch can beacon too, with server-side size/field
// caps and no echo of the token itself into the log line.
import { describe, it, expect, vi } from 'vitest';
import worker from '../src/worker.js';
import { logEvents } from './helpers/logEvents.js';

const env = { MULTICHAT_VIEW_SECRET: 'correct-secret', MULTICHAT_OVERLAY_SECRET: 'overlay-secret' };

function post(url, body) {
  return worker.fetch(new Request(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body,
  }), env, {});
}

describe('POST /client-error', () => {
  it('401 when the token is missing', async () => {
    const res = await post('https://x/client-error', JSON.stringify({ message: 'boom' }));
    expect(res.status).toBe(401);
  });

  it('401 when the token is wrong', async () => {
    const res = await post('https://x/client-error?t=wrong', JSON.stringify({ message: 'boom' }));
    expect(res.status).toBe(401);
  });

  it('200 when the overlay secret is used — same either-secret gate as /events, so the overlay\'s own beacon isn\'t always 401', async () => {
    const res = await post('https://x/client-error?t=overlay-secret', JSON.stringify({ message: 'boom' }));
    expect(res.status).toBe(200);
  });

  it('401 on a junk token matching neither MULTICHAT_VIEW_SECRET nor MULTICHAT_OVERLAY_SECRET', async () => {
    const res = await post('https://x/client-error?t=junk', JSON.stringify({ message: 'boom' }));
    expect(res.status).toBe(401);
  });

  it('413 on an oversized body, even with the correct token', async () => {
    const bigMessage = 'x'.repeat(4096); // > CLIENT_ERROR_MAX_BYTES (2KB)
    const res = await post('https://x/client-error?t=correct-secret', JSON.stringify({ message: bigMessage }));
    expect(res.status).toBe(413);
  });

  it('400 on malformed JSON, correct token, under the size cap', async () => {
    const res = await post('https://x/client-error?t=correct-secret', 'not json');
    expect(res.status).toBe(400);
  });

  it('400 when message is missing/empty', async () => {
    const res = await post('https://x/client-error?t=correct-secret', JSON.stringify({ message: '' }));
    expect(res.status).toBe(400);
  });

  it('200 on a valid small payload, logs client_error with truncated fields', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const longStack = 'y'.repeat(1000); // > CLIENT_ERROR_FIELD_MAX (500), still under the body cap
    const res = await post('https://x/client-error?t=correct-secret', JSON.stringify({
      message: 'TypeError: boom',
      source: 'https://x/app.js',
      line: 12,
      col: 3,
      stack: longStack,
      ts: 1700000000000,
    }));
    expect(res.status).toBe(200);
    const events = logEvents(logSpy, 'client_error');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ message: 'TypeError: boom', line: 12, col: 3, ts: 1700000000000 });
    expect(events[0].stack.length).toBe(500); // clamped to CLIENT_ERROR_FIELD_MAX
    logSpy.mockRestore();
  });

  it('handler never derives logged fields from req.url — the auth query string never reaches the log', async () => {
    // The real guarantee this endpoint gives: it only ever reads `t` from
    // url.searchParams for auth and never re-emits req.url/the query string
    // anywhere in the log line — independent of whatever the client happens
    // to put in its own message/source/stack fields (out of server control).
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    await post('https://x/client-error?t=correct-secret', JSON.stringify({ message: 'boom' }));
    const events = logEvents(logSpy, 'client_error');
    expect(events).toHaveLength(1);
    expect(events[0]).not.toHaveProperty('url');
    expect(events[0]).not.toHaveProperty('token');
    expect(events[0]).not.toHaveProperty('t');
    const rawLine = logSpy.mock.calls.find((c) => c[0].includes('client_error'))[0];
    expect(rawLine).not.toContain('t=correct-secret');
    logSpy.mockRestore();
  });
});
