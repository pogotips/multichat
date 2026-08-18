import { describe, it, expect } from 'vitest';
import { diffMessages, formatDiffSummary } from '../authed/diff.mjs';

function item(id, { author = 'Alice', channelId = 'UCauthor', text = 'hi', timestamp = '2026-08-18T00:00:00.000Z' } = {}) {
  const out = { author: { name: author, channelId }, message: [{ text }], timestamp };
  if (id !== undefined) out.id = id;
  return out;
}

describe('diffMessages', () => {
  it('matches identical ids on both sides and reports zero anon/authed-only', () => {
    const anon = [item('m1'), item('m2')];
    const authed = [item('m1'), item('m2')];
    const diff = diffMessages(anon, authed);
    expect(diff.anonCount).toBe(2);
    expect(diff.authedCount).toBe(2);
    expect(diff.matchedCount).toBe(2);
    expect(diff.anonOnly).toEqual([]);
    expect(diff.authedOnly).toEqual([]);
  });

  it('reports a message present only in authed (e.g. member-only chat) as authedOnly', () => {
    const anon = [item('m1')];
    const authed = [item('m1'), item('m2', { text: 'members only' })];
    const diff = diffMessages(anon, authed);
    expect(diff.matchedCount).toBe(1);
    expect(diff.anonOnly).toEqual([]);
    expect(diff.authedOnly).toEqual([item('m2', { text: 'members only' })]);
  });

  it('reports a message present only in anon as anonOnly', () => {
    const anon = [item('m1'), item('m2', { text: 'anon saw this' })];
    const authed = [item('m1')];
    const diff = diffMessages(anon, authed);
    expect(diff.matchedCount).toBe(1);
    expect(diff.authedOnly).toEqual([]);
    expect(diff.anonOnly).toEqual([item('m2', { text: 'anon saw this' })]);
  });

  it('falls back to author+text+timestamp matching when ids are missing on both sides', () => {
    const anon = [item(undefined, { text: 'no id here', timestamp: '2026-08-18T00:00:00.000Z' })];
    const authed = [item(undefined, { text: 'no id here', timestamp: '2026-08-18T00:00:01.000Z' })];
    const diff = diffMessages(anon, authed, { toleranceMs: 2000 });
    expect(diff.matchedCount).toBe(1);
    expect(diff.anonOnly).toEqual([]);
    expect(diff.authedOnly).toEqual([]);
  });

  it('does not fallback-match no-id items outside the timestamp tolerance', () => {
    const anon = [item(undefined, { text: 'no id here', timestamp: '2026-08-18T00:00:00.000Z' })];
    const authed = [item(undefined, { text: 'no id here', timestamp: '2026-08-18T00:00:10.000Z' })];
    const diff = diffMessages(anon, authed, { toleranceMs: 2000 });
    expect(diff.matchedCount).toBe(0);
    expect(diff.anonOnly).toHaveLength(1);
    expect(diff.authedOnly).toHaveLength(1);
  });

  it('does not fallback-match no-id items with different text or author', () => {
    const anon = [item(undefined, { author: 'Alice', channelId: 'UCalice', text: 'hi' })];
    const authed = [item(undefined, { author: 'Bob', channelId: 'UCbob', text: 'hi' })];
    const diff = diffMessages(anon, authed);
    expect(diff.matchedCount).toBe(0);
    expect(diff.anonOnly).toHaveLength(1);
    expect(diff.authedOnly).toHaveLength(1);
  });

  it('handles empty inputs', () => {
    const diff = diffMessages([], []);
    expect(diff).toEqual({ anonCount: 0, authedCount: 0, matchedCount: 0, anonOnly: [], authedOnly: [] });
  });
});

describe('formatDiffSummary', () => {
  it('renders the five count lines', () => {
    const diff = diffMessages([item('m1')], [item('m1'), item('m2')]);
    const summary = formatDiffSummary(diff);
    expect(summary).toContain('anon messages:   1');
    expect(summary).toContain('authed messages: 2');
    expect(summary).toContain('matched:         1');
    expect(summary).toContain('anon-only:       0');
    expect(summary).toContain('authed-only:     1');
  });
});
