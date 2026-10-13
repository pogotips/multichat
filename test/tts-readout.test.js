// "Read Out Loud" channel-point redeem: server marks, lib classifies/renders.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { emitCategory, roleClass } from '../src/worker.js';
import { chatSpeakSkipReason, buildRow } from '../src/lib.js';
import { makeHub } from './helpers/makeHub.js';
import { createFakeDocument } from './helpers/fake-doc.js';

afterEach(() => { vi.restoreAllMocks(); });

describe('pushMessage: custom reward id', () => {
  const push = (envOverrides, data) => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { hub } = makeHub({ envOverrides });
    hub.pushMessage('tw', data);
    return { msg: hub.ring.at(-1), logs: logSpy.mock.calls.map((c) => String(c[0])) };
  };
  const data = { user: 'Viewer', login: 'viewer', text: 'read me', rewardId: 'abc-123' };

  it('marks readAloud when the id matches MULTICHAT_TTS_REWARD_ID, logs id + login only', () => {
    const { msg, logs } = push({ MULTICHAT_TTS_REWARD_ID: 'abc-123' }, data);
    expect(msg.readAloud).toBe(true);
    expect(msg).not.toHaveProperty('rewardId');
    const line = logs.find((l) => l.includes('custom_reward_seen'));
    expect(JSON.parse(line)).toEqual({ ev: 'custom_reward_seen', rewardId: 'abc-123', login: 'viewer' });
    expect(logs.join('\n')).not.toContain('read me');
  });

  it('a padded env value still matches (trimmed)', () => {
    const { msg } = push({ MULTICHAT_TTS_REWARD_ID: ' abc-123 ' }, data);
    expect(msg.readAloud).toBe(true);
  });

  it('a different id, or no env var, stays plain chat but still logs', () => {
    for (const env of [{ MULTICHAT_TTS_REWARD_ID: 'other' }, {}]) {
      const { msg, logs } = push(env, data);
      expect(msg).not.toHaveProperty('readAloud');
      expect(msg).not.toHaveProperty('rewardId');
      expect(logs.some((l) => l.includes('custom_reward_seen'))).toBe(true);
    }
  });

  it('a message without a reward id never logs or marks', () => {
    const { msg, logs } = push({ MULTICHAT_TTS_REWARD_ID: 'abc-123' }, { user: 'V', login: 'v', text: 'hi' });
    expect(msg).not.toHaveProperty('readAloud');
    expect(logs.some((l) => l.includes('custom_reward_seen'))).toBe(false);
  });
});

describe('lib: readAloud rows', () => {
  it('emitCategory is readout', () => {
    expect(emitCategory({ readAloud: true, text: 'x' })).toBe('readout');
    expect(emitCategory({ text: 'x' })).toBe('silent');
  });

  it('chatSpeakSkipReason is readout (not spoken as plain chat)', () => {
    const msg = { id: 1, platform: 'tw', user: 'A', login: 'a', text: 'hi', ts: 1000, readAloud: true };
    expect(chatSpeakSkipReason(msg, { myName: '', now: 2000, maxAgeMs: 20000 })).toBe('readout');
  });

  it('buildRow adds the readout class and leaves the text untouched', () => {
    const render = (extra) => buildRow({ platform: 'tw', user: 'V', text: 'hi', ...extra }, { myName: '', roleClass, doc: createFakeDocument(), mention: true });
    const plain = render({});
    const flagged = render({ readAloud: true });
    expect(flagged.className).toContain('readout');
    expect(plain.className).not.toContain('readout');
    expect(flagged.textContent).toBe(plain.textContent);
  });
});
