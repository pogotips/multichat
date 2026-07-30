import { describe, it, expect, vi } from 'vitest';
import {
  parseIrcTags,
  parsePrivmsg,
  parseUsernotice,
  parseEmotes,
  parseClearmsg,
  parseClearchat,
  parseRoomstate,
  isProtocolNoise,
  isReconnectCommand,
  normalizeYt,
  filterRecoveredMessages,
  addToBoundedSet,
  addToBoundedMap,
} from '../src/worker.js';

describe('parseIrcTags', () => {
  it('parses a tag string into a map', () => {
    const tags = parseIrcTags('@badge-info=;badges=broadcaster/1;color=#FF0000;display-name=SomeUser');
    expect(tags).toEqual({
      'badge-info': '',
      badges: 'broadcaster/1',
      color: '#FF0000',
      'display-name': 'SomeUser',
    });
  });

  it('unescapes IRCv3 tag values', () => {
    const tags = parseIrcTags('@display-name=Foo\\sBar;emotes=25:0-4\\:6-10');
    expect(tags['display-name']).toBe('Foo Bar');
    expect(tags.emotes).toBe('25:0-4;6-10');
  });

  it('returns empty map for missing/non-tag input', () => {
    expect(parseIrcTags('')).toEqual({});
    expect(parseIrcTags(':user!user@host PRIVMSG #chan :hi')).toEqual({});
  });

  it('does not misinterpret an escaped backslash followed by a literal s', () => {
    // wire bytes: a, \, \, s, b  ->  \\ collapses to one literal backslash,
    // leaving s and b untouched (they were never escape-prefixed)
    const tags = parseIrcTags('@x=a\\\\sb');
    expect(tags.x).toBe('a\\sb');
  });

  it('drops the backslash for an unrecognized escape', () => {
    const tags = parseIrcTags('@x=a\\qb');
    expect(tags.x).toBe('aqb');
  });
});

describe('parsePrivmsg', () => {
  it('parses a tagged PRIVMSG line', () => {
    const line = '@badge-info=;badges=;color=#1E90FF;display-name=CoolViewer;emotes= :coolviewer!coolviewer@coolviewer.tmi.twitch.tv PRIVMSG #somechannel :hello chat!';
    const parsed = parsePrivmsg(line);
    expect(parsed).toEqual({ user: 'CoolViewer', login: 'coolviewer', color: '#1E90FF', text: 'hello chat!' });
  });

  it('falls back to nick when display-name tag is absent', () => {
    const line = ':plainnick!plainnick@plainnick.tmi.twitch.tv PRIVMSG #somechannel :no tags here';
    const parsed = parsePrivmsg(line);
    expect(parsed).toEqual({ user: 'plainnick', login: 'plainnick', color: undefined, text: 'no tags here' });
  });

  it('preserves unicode and emote text', () => {
    const line = '@display-name=Foo :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :Kappa 🎉 héllo';
    const parsed = parsePrivmsg(line);
    expect(parsed.text).toBe('Kappa 🎉 héllo');
  });

  it('returns null for PING lines', () => {
    expect(parsePrivmsg('PING :tmi.twitch.tv')).toBeNull();
  });

  it('returns null for malformed lines', () => {
    expect(parsePrivmsg('not an irc line')).toBeNull();
    expect(parsePrivmsg(':foo!foo@foo.tmi.twitch.tv JOIN #chan')).toBeNull();
    expect(parsePrivmsg('@display-name=Foo')).toBeNull();
  });

  it('marks a cheer via the bits tag', () => {
    const line = '@bits=500;display-name=Cheerer :cheerer!cheerer@cheerer.tmi.twitch.tv PRIVMSG #chan :Cheer500 nice stream!';
    const parsed = parsePrivmsg(line);
    expect(parsed).toEqual({
      user: 'Cheerer',
      login: 'cheerer',
      color: undefined,
      text: 'Cheer500 nice stream!',
      kind: 'cheer',
      amount: '500 bits',
    });
  });

  it('has no kind/amount for a plain message', () => {
    const line = ':plainnick!plainnick@plainnick.tmi.twitch.tv PRIVMSG #chan :hi';
    const parsed = parsePrivmsg(line);
    expect(parsed.kind).toBeUndefined();
    expect(parsed.amount).toBeUndefined();
  });

  it('marks isMod via the mod tag', () => {
    const line = '@mod=1;display-name=Mod :mod!mod@mod.tmi.twitch.tv PRIVMSG #chan :hi';
    expect(parsePrivmsg(line).isMod).toBe(true);
  });

  it('marks isMod via a broadcaster badge even without the mod tag', () => {
    const line = '@mod=0;badges=broadcaster/1;display-name=Streamer :streamer!streamer@streamer.tmi.twitch.tv PRIVMSG #chan :hi';
    expect(parsePrivmsg(line).isMod).toBe(true);
  });

  it('marks isMember via the subscriber tag', () => {
    const line = '@subscriber=1;display-name=Sub :sub!sub@sub.tmi.twitch.tv PRIVMSG #chan :hi';
    expect(parsePrivmsg(line).isMember).toBe(true);
  });

  it('marks isMember via a founder badge even when subscriber=0', () => {
    const line = '@subscriber=0;badges=founder/0;display-name=Founder :founder!founder@founder.tmi.twitch.tv PRIVMSG #chan :hi';
    expect(parsePrivmsg(line).isMember).toBe(true);
  });

  it('has no isMod/isMember for a plain viewer', () => {
    const line = ':plainnick!plainnick@plainnick.tmi.twitch.tv PRIVMSG #chan :hi';
    const parsed = parsePrivmsg(line);
    expect(parsed.isMod).toBeUndefined();
    expect(parsed.isMember).toBeUndefined();
  });

  it('marks firstMsg via the first-msg tag', () => {
    const line = '@first-msg=1;display-name=NewViewer :newviewer!newviewer@newviewer.tmi.twitch.tv PRIVMSG #chan :hi all';
    expect(parsePrivmsg(line).firstMsg).toBe(true);
  });

  it('has no firstMsg when the tag is 0 or absent', () => {
    const withZero = '@first-msg=0;display-name=Foo :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi';
    const absent = ':foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi';
    expect(parsePrivmsg(withZero).firstMsg).toBeUndefined();
    expect(parsePrivmsg(absent).firstMsg).toBeUndefined();
  });

  it('attaches parsed emotes from the emotes tag', () => {
    const line = '@emotes=25:0-4;display-name=Foo :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :Kappa hi';
    expect(parsePrivmsg(line).emotes).toEqual([{ id: '25', start: 0, end: 4 }]);
  });

  it('has no emotes key when the tag is absent or empty', () => {
    const absent = ':foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi';
    const empty = '@emotes=;display-name=Foo :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi';
    expect(parsePrivmsg(absent).emotes).toBeUndefined();
    expect(parsePrivmsg(empty).emotes).toBeUndefined();
  });
});

describe('parseEmotes', () => {
  it('parses a single range', () => {
    expect(parseEmotes('25:0-4')).toEqual([{ id: '25', start: 0, end: 4 }]);
  });

  it('parses multiple ranges for one emote', () => {
    expect(parseEmotes('25:0-4,12-16')).toEqual([
      { id: '25', start: 0, end: 4 },
      { id: '25', start: 12, end: 16 },
    ]);
  });

  it('parses multiple emotes and sorts ascending by start', () => {
    expect(parseEmotes('1902:6-10/25:0-4')).toEqual([
      { id: '25', start: 0, end: 4 },
      { id: '1902', start: 6, end: 10 },
    ]);
  });

  it('returns [] for empty or malformed input', () => {
    expect(parseEmotes('')).toEqual([]);
    expect(parseEmotes(undefined)).toEqual([]);
    expect(parseEmotes('junk')).toEqual([]);
    expect(parseEmotes('25:')).toEqual([]);
    expect(parseEmotes('25:5-2')).toEqual([]); // end before start
  });

  it('keeps end inclusive — an emote as the final token in the text', () => {
    // text "hi Kappa" (8 code points, 0-indexed): Kappa occupies 3-7 inclusive
    const text = 'hi Kappa';
    const [emote] = parseEmotes('25:3-7');
    const cps = [...text];
    expect(cps.slice(emote.start, emote.end + 1).join('')).toBe('Kappa');
  });

  it('counts offsets in Unicode code points, correct after a multi-codepoint emoji', () => {
    // text "🎉 Kappa": 🎉 is one code point (surrogate pair in UTF-16, but one
    // entry in [...text]), so Kappa starts at code-point index 2, not 3.
    const text = '🎉 Kappa';
    const cps = [...text];
    expect(cps[2]).toBe('K');
    const [emote] = parseEmotes('25:2-6');
    expect(cps.slice(emote.start, emote.end + 1).join('')).toBe('Kappa');
  });
});

describe('parseUsernotice', () => {
  it('parses a resub with a trailing user message', () => {
    const line = '@badge-info=;badges=staff/1;color=#008000;display-name=ronni;login=ronni;msg-id=resub;system-msg=ronni\\shas\\ssubscribed\\sfor\\s6\\smonths! :tmi.twitch.tv USERNOTICE #dallas :Great stream -- keep it up!';
    const parsed = parseUsernotice(line);
    expect(parsed).toEqual({
      user: 'ronni',
      login: 'ronni',
      color: '#008000',
      kind: 'sub',
      text: 'ronni has subscribed for 6 months! — Great stream -- keep it up!',
    });
  });

  it('parses a plain sub with no trailing message', () => {
    const line = '@display-name=ronni;login=ronni;msg-id=sub;system-msg=ronni\\ssubscribed! :tmi.twitch.tv USERNOTICE #dallas';
    const parsed = parseUsernotice(line);
    expect(parsed).toEqual({ user: 'ronni', login: 'ronni', color: undefined, kind: 'sub', text: 'ronni subscribed!' });
  });

  it('maps gift-sub msg-ids to giftsub', () => {
    for (const msgId of ['subgift', 'submysterygift', 'giftpaidupgrade', 'anongiftpaidupgrade']) {
      const line = `@display-name=TWW2;login=tww2;msg-id=${msgId};system-msg=TWW2\\sgifted\\sa\\ssub! :tmi.twitch.tv USERNOTICE #dallas`;
      expect(parseUsernotice(line)?.kind).toBe('giftsub');
    }
  });

  it('ignores unrelated msg-ids', () => {
    // 'unraid' (raid cancellation) is real Twitch traffic but not one we render.
    const line = '@msg-id=unraid;system-msg=The\\sraid\\shas\\sbeen\\scanceled :tmi.twitch.tv USERNOTICE #dallas';
    expect(parseUsernotice(line)).toBeNull();
  });

  it('parses a raid as a sys row, not a gold kind', () => {
    const line = '@msg-id=raid;msg-param-displayName=Raider;msg-param-login=raider;msg-param-viewerCount=42 :tmi.twitch.tv USERNOTICE #dallas';
    const parsed = parseUsernotice(line);
    expect(parsed).toEqual({
      user: 'Raider',
      login: 'raider',
      sys: 'raid',
      text: 'Raider raiding with 42 viewers',
    });
    expect(parsed.kind).toBeUndefined();
  });

  it('falls back to system-msg for a raid without viewer-count param', () => {
    const line = '@msg-id=raid;display-name=Raider;login=raider;system-msg=5\\sraiders\\sfrom\\sRaider :tmi.twitch.tv USERNOTICE #dallas';
    const parsed = parseUsernotice(line);
    expect(parsed.sys).toBe('raid');
    expect(parsed.text).toBe('5 raiders from Raider');
  });

  it('parses an announcement as a sys row using the trailing text', () => {
    const line = '@msg-id=announcement;display-name=Mod;login=mod :tmi.twitch.tv USERNOTICE #dallas :Welcome to the stream!';
    const parsed = parseUsernotice(line);
    expect(parsed).toEqual({ user: 'Mod', login: 'mod', sys: 'announce', text: 'Welcome to the stream!' });
    expect(parsed.kind).toBeUndefined();
  });

  it('returns null for non-USERNOTICE lines', () => {
    expect(parseUsernotice(':foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi')).toBeNull();
  });

  it('marks isMod/isMember on a USERNOTICE the same way as PRIVMSG', () => {
    const line = '@mod=1;subscriber=1;display-name=ronni;login=ronni;msg-id=resub;system-msg=ronni\\sresubbed! :tmi.twitch.tv USERNOTICE #dallas';
    const parsed = parseUsernotice(line);
    expect(parsed.isMod).toBe(true);
    expect(parsed.isMember).toBe(true);
  });
});

describe('parseClearmsg', () => {
  it('parses a message delete', () => {
    const line = '@login=baduser;target-msg-id=abc-123 :tmi.twitch.tv CLEARMSG #dallas :bad text';
    expect(parseClearmsg(line)).toEqual({ login: 'baduser', targetId: 'abc-123' });
  });

  it('returns null when login or target-msg-id is missing', () => {
    expect(parseClearmsg('@target-msg-id=abc-123 :tmi.twitch.tv CLEARMSG #dallas :hi')).toBeNull();
    expect(parseClearmsg('@login=baduser :tmi.twitch.tv CLEARMSG #dallas :hi')).toBeNull();
  });

  it('returns null for non-CLEARMSG lines', () => {
    expect(parseClearmsg(':foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi')).toBeNull();
  });
});

describe('parseClearchat', () => {
  it('parses a timeout via the ban-duration tag', () => {
    const line = '@ban-duration=600 :tmi.twitch.tv CLEARCHAT #dallas :baduser';
    expect(parseClearchat(line)).toEqual({ login: 'baduser', seconds: 600 });
  });

  it('parses a ban when ban-duration is absent', () => {
    const line = ':tmi.twitch.tv CLEARCHAT #dallas :baduser';
    expect(parseClearchat(line)).toEqual({ login: 'baduser', seconds: null });
  });

  it('parses a bare clear (no trailing target) as clear:true', () => {
    const line = ':tmi.twitch.tv CLEARCHAT #dallas';
    expect(parseClearchat(line)).toEqual({ clear: true });
  });

  it('returns null for non-CLEARCHAT lines', () => {
    expect(parseClearchat(':foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi')).toBeNull();
  });
});

describe('parseRoomstate', () => {
  const line = (tagBody) => `@${tagBody} :tmi.twitch.tv ROOMSTATE #dallas`;

  it('returns null for non-ROOMSTATE or untagged lines', () => {
    expect(parseRoomstate(':tmi.twitch.tv ROOMSTATE #dallas')).toBeNull(); // no tags
    expect(parseRoomstate('@slow=0 :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi')).toBeNull();
  });

  it('slow=0 is off, N>0 is on with seconds', () => {
    expect(parseRoomstate(line('slow=0'))).toEqual({ slow: 'slow mode off' });
    expect(parseRoomstate(line('slow=30'))).toEqual({ slow: 'slow mode on: 30s' });
  });

  it('subs-only and emote-only are plain 0/1 toggles', () => {
    expect(parseRoomstate(line('subs-only=1'))).toEqual({ subsOnly: 'sub-only on' });
    expect(parseRoomstate(line('subs-only=0'))).toEqual({ subsOnly: 'sub-only off' });
    expect(parseRoomstate(line('emote-only=1'))).toEqual({ emoteOnly: 'emote-only on' });
    expect(parseRoomstate(line('emote-only=0'))).toEqual({ emoteOnly: 'emote-only off' });
  });

  it('followers-only: -1 off, 0 on/any-follower, N on/N-minutes', () => {
    expect(parseRoomstate(line('followers-only=-1'))).toEqual({ followersOnly: 'followers-only off' });
    expect(parseRoomstate(line('followers-only=0'))).toEqual({ followersOnly: 'followers-only on' });
    expect(parseRoomstate(line('followers-only=10'))).toEqual({ followersOnly: 'followers-only on: 10m' });
  });

  it('r9k (unique-chat) is a plain 0/1 toggle', () => {
    expect(parseRoomstate(line('r9k=1'))).toEqual({ uniqueChat: 'unique-chat on' });
    expect(parseRoomstate(line('r9k=0'))).toEqual({ uniqueChat: 'unique-chat off' });
  });

  it('reports only the tags present on the line (delta, not full state)', () => {
    expect(parseRoomstate(line('followers-only=5'))).toEqual({ followersOnly: 'followers-only on: 5m' });
  });

  it('reports multiple changed keys when a line carries more than one', () => {
    expect(parseRoomstate(line('slow=0;subs-only=1'))).toEqual({
      slow: 'slow mode off',
      subsOnly: 'sub-only on',
    });
  });

  it('returns null when tags carry none of the known settings', () => {
    expect(parseRoomstate(line('room-id=1'))).toBeNull();
  });
});

describe('isProtocolNoise', () => {
  it('flags connection/membership scaffolding', () => {
    expect(isProtocolNoise(':tmi.twitch.tv 001 justinfan1 :Welcome')).toBe(true);
    expect(isProtocolNoise('@badges=;color= :tmi.twitch.tv 353 justinfan1 = #chan :justinfan1')).toBe(true);
    expect(isProtocolNoise(':tmi.twitch.tv CAP * ACK :twitch.tv/tags')).toBe(true);
    expect(isProtocolNoise(':foo!foo@foo.tmi.twitch.tv JOIN #chan')).toBe(true);
    expect(isProtocolNoise(':foo!foo@foo.tmi.twitch.tv PART #chan')).toBe(true);
    expect(isProtocolNoise(':foo!foo@foo.tmi.twitch.tv USERSTATE #chan')).toBe(true);
    expect(isProtocolNoise('@badges= :tmi.twitch.tv GLOBALUSERSTATE')).toBe(true);
  });

  it('does not flag handled or capturable commands', () => {
    expect(isProtocolNoise(':foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi')).toBe(false);
    expect(isProtocolNoise(':tmi.twitch.tv USERNOTICE #chan')).toBe(false);
    expect(isProtocolNoise(':tmi.twitch.tv NOTICE #chan :msg')).toBe(false);
    expect(isProtocolNoise(':tmi.twitch.tv HOSTTARGET #chan :other 5')).toBe(false);
    expect(isProtocolNoise('not an irc line')).toBe(false);
  });
});

describe('isReconnectCommand', () => {
  it('detects a RECONNECT line', () => {
    expect(isReconnectCommand(':tmi.twitch.tv RECONNECT')).toBe(true);
  });

  it('ignores RECONNECT appearing only as chat text', () => {
    expect(isReconnectCommand(':foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :please RECONNECT now')).toBe(false);
  });

  it('ignores unrelated lines', () => {
    expect(isReconnectCommand('PING :tmi.twitch.tv')).toBe(false);
    expect(isReconnectCommand('not an irc line')).toBe(false);
  });
});

describe('normalizeYt', () => {
  it('normalizes a valid body', () => {
    expect(normalizeYt({ user: ' Alice ', text: 'hi', color: '#ff0000' })).toEqual({
      user: 'Alice',
      text: 'hi',
      color: '#ff0000',
    });
  });

  it('drops invalid color', () => {
    expect(normalizeYt({ user: 'Alice', text: 'hi', color: 'not-a-color' })).toEqual({
      user: 'Alice',
      text: 'hi',
    });
  });

  it('throws on missing user', () => {
    expect(() => normalizeYt({ text: 'hi' })).toThrow();
    expect(() => normalizeYt({ user: '  ', text: 'hi' })).toThrow();
  });

  it('throws on missing text', () => {
    expect(() => normalizeYt({ user: 'Alice' })).toThrow();
  });

  it('throws on non-object body', () => {
    expect(() => normalizeYt(null)).toThrow();
    expect(() => normalizeYt('nope')).toThrow();
  });

  it('clamps user to 100 chars', () => {
    const long = 'x'.repeat(150);
    const result = normalizeYt({ user: long, text: 'hi' });
    expect(result.user).toHaveLength(100);
    expect(result.user).toBe('x'.repeat(100));
  });

  it('clamps overlong text to 500 chars', () => {
    const long = 'x'.repeat(600);
    const result = normalizeYt({ user: 'Alice', text: long });
    expect(result.text.length).toBe(500);
  });

  it('accepts a valid kind + amount', () => {
    const result = normalizeYt({ user: 'Alice', text: 'thanks!', kind: 'superchat', amount: '$5.00' });
    expect(result.kind).toBe('superchat');
    expect(result.amount).toBe('$5.00');
  });

  it('drops an invalid kind', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', kind: 'not-a-kind', amount: '$5.00' });
    expect(result.kind).toBeUndefined();
  });

  it('clamps overlong amount to 32 chars', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', kind: 'supersticker', amount: 'x'.repeat(50) });
    expect(result.amount.length).toBe(32);
  });

  it('rejects the retired membership kind', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', kind: 'membership' });
    expect(result.kind).toBeUndefined();
  });

  it('accepts the member_* announcement kinds', () => {
    for (const kind of ['member_new', 'member_milestone', 'member_gift', 'member_gift_received']) {
      const result = normalizeYt({ user: 'Alice', text: 'Welcome!', kind });
      expect(result.kind).toBe(kind);
    }
  });

  it('member_gift carries the gift count in amount', () => {
    const result = normalizeYt({
      user: 'GenerousGifter',
      text: 'Gifted 5 Fan Club memberships',
      kind: 'member_gift',
      amount: '5 gifts',
    });
    expect(result.kind).toBe('member_gift');
    expect(result.amount).toBe('5 gifts');
  });

  it('accepts yt_gift (paid Jewels/animated-gift, distinct from member_gift)', () => {
    const result = normalizeYt({ user: 'Jaydengames017', text: 'sent Gold coin', kind: 'yt_gift' });
    expect(result.kind).toBe('yt_gift');
  });

  it('yt_gift carries the gift name in amount', () => {
    const result = normalizeYt({
      user: 'Jaydengames017',
      text: 'sent Gold coin',
      kind: 'yt_gift',
      amount: 'Gold coin',
    });
    expect(result.kind).toBe('yt_gift');
    expect(result.amount).toBe('Gold coin');
  });

  it('accepts isMod/isMember booleans', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', isMod: true, isMember: false });
    expect(result.isMod).toBe(true);
    expect(result.isMember).toBe(false);
  });

  it('ignores non-boolean isMod/isMember', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', isMod: 'yes', isMember: 1 });
    expect(result.isMod).toBeUndefined();
    expect(result.isMember).toBeUndefined();
  });

  it('forwards ytId', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', ytId: 'Chz-abc123' });
    expect(result.ytId).toBe('Chz-abc123');
  });

  it('ignores a non-string or blank ytId', () => {
    expect(normalizeYt({ user: 'Alice', text: 'hi', ytId: 42 }).ytId).toBeUndefined();
    expect(normalizeYt({ user: 'Alice', text: 'hi', ytId: '  ' }).ytId).toBeUndefined();
  });

  it('clamps an oversized ytId to 128 chars', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', ytId: 'x'.repeat(200) });
    expect(result.ytId.length).toBe(128);
  });

  it('forwards recovered: true', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', recovered: true });
    expect(result.recovered).toBe(true);
  });

  it('ignores a non-boolean recovered', () => {
    expect(normalizeYt({ user: 'Alice', text: 'hi', recovered: 'yes' }).recovered).toBeUndefined();
  });

  it('forwards authorId', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', authorId: 'UCabc123' });
    expect(result.authorId).toBe('UCabc123');
  });

  it('ignores a non-string or blank authorId', () => {
    expect(normalizeYt({ user: 'Alice', text: 'hi', authorId: 42 }).authorId).toBeUndefined();
    expect(normalizeYt({ user: 'Alice', text: 'hi', authorId: '  ' }).authorId).toBeUndefined();
  });

  it('clamps an oversized authorId to 128 chars', () => {
    const result = normalizeYt({ user: 'Alice', text: 'hi', authorId: 'x'.repeat(200) });
    expect(result.authorId.length).toBe(128);
  });

  describe('emotes (YouTube custom emoji)', () => {
    it('accepts a valid entry with an allowlisted host', () => {
      const result = normalizeYt({
        user: 'Alice',
        text: 'gg :_smile:',
        emotes: [{ start: 3, end: 10, url: 'https://yt3.ggpht.com/abc.png', alt: ':_smile:' }],
      });
      expect(result.emotes).toEqual([{ start: 3, end: 10, url: 'https://yt3.ggpht.com/abc.png', alt: ':_smile:' }]);
    });

    it('accepts googleusercontent.com as an allowlisted host', () => {
      const result = normalizeYt({
        user: 'Alice',
        text: 'gg :_smile:',
        emotes: [{ start: 3, end: 10, url: 'https://lh3.googleusercontent.com/abc.png', alt: ':_smile:' }],
      });
      expect(result.emotes[0].url).toBe('https://lh3.googleusercontent.com/abc.png');
    });

    it('degrades a disallowed host: url blanked, entry+alt kept, row never dropped', () => {
      const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
      const result = normalizeYt({
        user: 'Alice',
        text: 'gg :_smile:',
        emotes: [{ start: 3, end: 10, url: 'https://evil.example.com/abc.png', alt: ':_smile:' }],
      });
      expect(result.emotes).toEqual([{ start: 3, end: 10, alt: ':_smile:' }]);
      expect(result.emotes[0].url).toBeUndefined();
      expect(spy).toHaveBeenCalledWith(JSON.stringify({ ev: 'emoji_host_rejected', host: 'evil.example.com' }));
      spy.mockRestore();
    });

    it('rejects a non-https url as a disallowed host (degrade, not drop)', () => {
      const result = normalizeYt({
        user: 'Alice',
        text: 'gg :_smile:',
        emotes: [{ start: 3, end: 10, url: 'http://yt3.ggpht.com/abc.png', alt: ':_smile:' }],
      });
      expect(result.emotes).toEqual([{ start: 3, end: 10, alt: ':_smile:' }]);
    });

    it('drops (not degrades) an entry whose end is out of range for text', () => {
      const result = normalizeYt({
        user: 'Alice',
        text: 'hi', // code-point length 2, max valid end is 1
        emotes: [{ start: 0, end: 2, url: 'https://yt3.ggpht.com/abc.png', alt: 'x' }],
      });
      expect(result.emotes).toBeUndefined();
    });

    it('drops an entry with start > end', () => {
      const result = normalizeYt({
        user: 'Alice',
        text: 'hello world',
        emotes: [{ start: 5, end: 2, url: 'https://yt3.ggpht.com/abc.png', alt: 'x' }],
      });
      expect(result.emotes).toBeUndefined();
    });

    it('drops overlapping entries (keeps the first, drops the overlapping second)', () => {
      const result = normalizeYt({
        user: 'Alice',
        text: 'hello world',
        emotes: [
          { start: 0, end: 4, url: 'https://yt3.ggpht.com/a.png', alt: 'a' },
          { start: 3, end: 6, url: 'https://yt3.ggpht.com/b.png', alt: 'b' },
        ],
      });
      expect(result.emotes).toEqual([{ start: 0, end: 4, url: 'https://yt3.ggpht.com/a.png', alt: 'a' }]);
    });

    it('drops unsorted entries (second entry starts before the first ends)', () => {
      const result = normalizeYt({
        user: 'Alice',
        text: 'hello world',
        emotes: [
          { start: 6, end: 10, url: 'https://yt3.ggpht.com/a.png', alt: 'a' },
          { start: 0, end: 4, url: 'https://yt3.ggpht.com/b.png', alt: 'b' },
        ],
      });
      expect(result.emotes).toEqual([{ start: 6, end: 10, url: 'https://yt3.ggpht.com/a.png', alt: 'a' }]);
    });

    it('drops non-integer start/end', () => {
      const result = normalizeYt({
        user: 'Alice',
        text: 'hello world',
        emotes: [{ start: 0.5, end: 4, url: 'https://yt3.ggpht.com/a.png', alt: 'a' }],
      });
      expect(result.emotes).toBeUndefined();
    });

    it('caps at 20 entries', () => {
      const text = 'x'.repeat(100);
      const emotes = Array.from({ length: 25 }, (_, i) => ({
        start: i * 4,
        end: i * 4 + 1,
        url: 'https://yt3.ggpht.com/a.png',
        alt: 'a',
      }));
      const result = normalizeYt({ user: 'Alice', text, emotes });
      expect(result.emotes.length).toBe(20);
    });

    it('ignores a non-array emotes field', () => {
      expect(normalizeYt({ user: 'Alice', text: 'hi', emotes: 'nope' }).emotes).toBeUndefined();
    });

    it('a plain YT message with no emotes normalizes identically to today (no emotes key)', () => {
      const result = normalizeYt({ user: 'Alice', text: 'hello world' });
      expect(result).toEqual({ user: 'Alice', text: 'hello world' });
      expect('emotes' in result).toBe(false);
    });
  });
});

describe('addToBoundedSet', () => {
  it('adds a value', () => {
    const set = new Set();
    addToBoundedSet(set, 'a', 3);
    expect(set.has('a')).toBe(true);
  });

  it('evicts the oldest (FIFO) once over maxSize', () => {
    const set = new Set(['a', 'b', 'c']);
    addToBoundedSet(set, 'd', 3);
    expect([...set]).toEqual(['b', 'c', 'd']);
  });

  it('re-adding an existing value is a no-op (native Set semantics: no reordering)', () => {
    const set = new Set(['a', 'b']);
    addToBoundedSet(set, 'a', 3);
    expect([...set]).toEqual(['a', 'b']);
  });

  // Mirrors handleIngestYt's recentYtIds check (src/worker.js): a `has()`
  // lookup before push, then add. yt_gift's ChatItem.timestamp is wall-clock
  // "now" (the ViewModel carries no timestampUsec — see the parser patch),
  // which means a gift can't rely on time-based recovery filtering the way
  // other kinds can. This dedupe set is the only thing that still catches a
  // true duplicate (e.g. reconnect overlap re-posting the same gift); a
  // regression here would double-post gifts on every poller reconnect.
  it('a gift item with an already-seen ytId is dropped by the worker dedupe set', () => {
    const recentYtIds = new Set();
    const first = normalizeYt({
      user: 'Jaydengames017',
      text: 'sent Gold coin',
      kind: 'yt_gift',
      amount: 'Gold coin',
      ytId: 'ChwKGkNMMjF4ZkRtM0pVREZVZXd3Z0VkOEZRYUhn',
    });
    expect(recentYtIds.has(first.ytId)).toBe(false); // first arrival: worker pushes it
    addToBoundedSet(recentYtIds, first.ytId, 200);

    const duplicate = normalizeYt({
      user: 'Jaydengames017',
      text: 'sent Gold coin',
      kind: 'yt_gift',
      amount: 'Gold coin',
      ytId: first.ytId,
    });
    expect(recentYtIds.has(duplicate.ytId)).toBe(true); // handleIngestYt short-circuits, no re-push
  });
});

describe('addToBoundedMap', () => {
  it('adds a key/value pair', () => {
    const map = new Map();
    addToBoundedMap(map, 'a', 1, 3);
    expect(map.get('a')).toBe(1);
  });

  it('evicts the oldest (FIFO) key once over maxSize', () => {
    const map = new Map([['a', 1], ['b', 2], ['c', 3]]);
    addToBoundedMap(map, 'd', 4, 3);
    expect([...map.keys()]).toEqual(['b', 'c', 'd']);
  });
});

describe('filterRecoveredMessages', () => {
  const line = (id, sentTs, text = 'hi') =>
    `@display-name=Foo;id=${id};tmi-sent-ts=${sentTs} :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :${text}`;

  it('keeps lines newer than cutoffTs, sorted ascending by tmi-sent-ts', () => {
    const lines = [line('c', 3000, 'third'), line('a', 1000, 'first'), line('b', 2000, 'second')];
    const result = filterRecoveredMessages(lines, { cutoffTs: 0, floorTs: 0, seenIds: new Set() });
    expect(result.map((r) => r.data.text)).toEqual(['first', 'second', 'third']);
    expect(result.every((r) => r.data.recovered)).toBe(true);
  });

  it('drops lines at or before cutoffTs', () => {
    const lines = [line('a', 1000), line('b', 2000)];
    const result = filterRecoveredMessages(lines, { cutoffTs: 1000, floorTs: 0, seenIds: new Set() });
    expect(result.map((r) => r.twId)).toEqual(['b']);
  });

  it('drops lines older than floorTs', () => {
    const lines = [line('a', 500), line('b', 2000)];
    const result = filterRecoveredMessages(lines, { cutoffTs: 0, floorTs: 1000, seenIds: new Set() });
    expect(result.map((r) => r.twId)).toEqual(['b']);
  });

  it('drops lines whose id is already in seenIds', () => {
    const lines = [line('dupe', 1000), line('new', 2000)];
    const result = filterRecoveredMessages(lines, { cutoffTs: 0, floorTs: 0, seenIds: new Set(['dupe']) });
    expect(result.map((r) => r.twId)).toEqual(['new']);
  });

  it('skips lines without a usable tmi-sent-ts', () => {
    const untagged = ':foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi';
    const noTs = '@display-name=Foo;id=x :foo!foo@foo.tmi.twitch.tv PRIVMSG #chan :hi';
    const result = filterRecoveredMessages([untagged, noTs], { cutoffTs: 0, floorTs: 0, seenIds: new Set() });
    expect(result).toEqual([]);
  });

  it('skips lines that neither parser accepts (e.g. ROOMSTATE)', () => {
    const roomstate = '@room-id=1;tmi-sent-ts=1000 :tmi.twitch.tv ROOMSTATE #chan';
    const result = filterRecoveredMessages([roomstate], { cutoffTs: 0, floorTs: 0, seenIds: new Set() });
    expect(result).toEqual([]);
  });

  it('recovers a USERNOTICE the same as a PRIVMSG', () => {
    const usernotice =
      '@display-name=ronni;login=ronni;msg-id=sub;system-msg=ronni\\ssubscribed!;id=u1;tmi-sent-ts=1000 :tmi.twitch.tv USERNOTICE #dallas';
    const result = filterRecoveredMessages([usernotice], { cutoffTs: 0, floorTs: 0, seenIds: new Set() });
    expect(result).toHaveLength(1);
    expect(result[0].data).toMatchObject({ kind: 'sub', recovered: true });
  });

  it('clamps a recovered message emote array to 64', () => {
    const ranges = Array.from({ length: 70 }, (_, i) => `${i}-${i}`).join(',');
    const text = 'x'.repeat(70);
    const emotesLine = line('a', 1000, text).replace(
      'tmi-sent-ts=1000',
      `tmi-sent-ts=1000;emotes=25:${ranges}`
    );
    const result = filterRecoveredMessages([emotesLine], { cutoffTs: 0, floorTs: 0, seenIds: new Set() });
    expect(result).toHaveLength(1);
    expect(result[0].data.emotes).toHaveLength(64);
  });
});
