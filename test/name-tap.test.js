import { describe, it, expect } from 'vitest';
import { userKeyOf, createMessageStore } from '../src/lib.js';

describe('userKeyOf', () => {
  it('keys tw by login', () => expect(userKeyOf({ platform: 'tw', login: 'bob', user: 'Bob' })).toBe('tw:bob'));
  it('tw without login is null', () => expect(userKeyOf({ platform: 'tw', user: 'Bob' })).toBeNull());
  it('keys yt by authorId', () => expect(userKeyOf({ platform: 'yt', authorId: 'UC1', user: 'A' })).toBe('yt:UC1'));
  it('yt without authorId is null', () => expect(userKeyOf({ platform: 'yt', user: 'A' })).toBeNull());
  it('same yt display name, different authorId, different keys', () => {
    expect(userKeyOf({ platform: 'yt', authorId: 'UC1', user: 'Sam' })).not.toBe(userKeyOf({ platform: 'yt', authorId: 'UC2', user: 'Sam' }));
  });
  it('same display name on tw vs yt, different keys', () => {
    expect(userKeyOf({ platform: 'tw', login: 'sam', user: 'Sam' })).not.toBe(userKeyOf({ platform: 'yt', authorId: 'sam', user: 'Sam' }));
  });
  it('sys rows are null', () => expect(userKeyOf({ platform: 'tw', login: 'bob', sys: 'raid' })).toBeNull());
  it('null/undefined are null', () => {
    expect(userKeyOf(null)).toBeNull();
    expect(userKeyOf(undefined)).toBeNull();
  });
});

describe('createMessageStore', () => {
  it('drops the oldest beyond cap', () => {
    const s = createMessageStore(3);
    for (let i = 1; i <= 5; i++) s.push({ platform: 'tw', login: 'a', id: i });
    expect(s.size()).toBe(3);
    expect(s.forKey('tw:a').map((m) => m.id)).toEqual([5, 4, 3]);
  });
  it('cap 2000 with 2001 pushes keeps 2000, oldest gone', () => {
    const s = createMessageStore(2000);
    for (let i = 0; i < 2001; i++) s.push({ platform: 'tw', login: 'a', id: i });
    expect(s.size()).toBe(2000);
    const ids = s.forKey('tw:a').map((m) => m.id);
    expect(ids).not.toContain(0);
    expect(ids[0]).toBe(2000);
  });
  it('forKey returns only matches, newest first', () => {
    const s = createMessageStore(10);
    s.push({ platform: 'tw', login: 'a', id: 1 });
    s.push({ platform: 'tw', login: 'b', id: 2 });
    s.push({ platform: 'yt', authorId: 'a', id: 3 });
    s.push({ platform: 'tw', login: 'a', id: 4 });
    expect(s.forKey('tw:a').map((m) => m.id)).toEqual([4, 1]);
    expect(s.forKey('yt:a').map((m) => m.id)).toEqual([3]);
  });
  describe('applyMark', () => {
    const mk = () => {
      const s = createMessageStore(10);
      const msgs = [
        { platform: 'yt', authorId: 'UC1', ytId: 'y1', id: 1 },
        { platform: 'yt', authorId: 'UC1', ytId: 'y2', id: 2 },
        { platform: 'tw', login: 'bob', twId: 't1', id: 3 },
        { platform: 'tw', login: 'bob', twId: 't2', id: 4 },
      ];
      msgs.forEach((m) => s.push(m));
      return { s, msgs };
    };
    it('delete yt by ytId', () => {
      const { s, msgs } = mk();
      s.applyMark({ action: 'delete', platform: 'yt', targetId: 'y1' });
      expect(msgs.map((m) => !!m.deleted)).toEqual([true, false, false, false]);
    });
    it('delete tw by twId', () => {
      const { s, msgs } = mk();
      s.applyMark({ action: 'delete', platform: 'tw', targetId: 't2' });
      expect(msgs.map((m) => !!m.deleted)).toEqual([false, false, false, true]);
    });
    it('author_delete marks every message of the author', () => {
      const { s, msgs } = mk();
      s.applyMark({ action: 'author_delete', authorId: 'UC1' });
      expect(msgs.map((m) => !!m.deleted)).toEqual([true, true, false, false]);
    });
    it('supersede sets superseded, not deleted', () => {
      const { s, msgs } = mk();
      s.applyMark({ action: 'supersede', targetId: 't1' });
      expect(msgs[2].superseded).toBe(true);
      expect(msgs[2].deleted).toBeUndefined();
    });
    it('login mark clears every message of that login', () => {
      const { s, msgs } = mk();
      s.applyMark({ login: 'bob' });
      expect(msgs.map((m) => !!m.deleted)).toEqual([false, false, true, true]);
    });
    it('unmatched mark changes nothing', () => {
      const { s, msgs } = mk();
      s.applyMark({ action: 'delete', platform: 'tw', targetId: 'zzz' });
      s.applyMark({ login: 'nobody' });
      expect(msgs.some((m) => m.deleted || m.superseded)).toBe(false);
    });
    it('undefined is a no-op', () => {
      const { s } = mk();
      expect(() => s.applyMark(undefined)).not.toThrow();
    });
  });
});
