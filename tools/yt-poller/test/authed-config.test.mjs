import { describe, it, expect, vi, afterEach } from 'vitest';
import fs from 'node:fs';
import { resolveDifftestConfig, DEFAULT_POLL_SECONDS } from '../authed/config.mjs';

describe('resolveDifftestConfig', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('is anon-only (authed.enabled false) when YT_COOKIE_FILE is unset', () => {
    const config = resolveDifftestConfig({ YT_CHANNEL_ID: 'UCxxxx' });
    expect(config.authed.enabled).toBe(false);
    expect(config.authed.cookieFile).toBeNull();
    expect(config.authed.reason).toMatch(/YT_COOKIE_FILE not set/);
  });

  it('does not throw and does not touch the filesystem when resolving with zero cookies present', () => {
    const readSpy = vi.spyOn(fs, 'readFileSync');
    const existsSpy = vi.spyOn(fs, 'existsSync');
    expect(() => resolveDifftestConfig({ YT_CHANNEL_ID: 'UCxxxx' })).not.toThrow();
    expect(() => resolveDifftestConfig({})).not.toThrow();
    expect(readSpy).not.toHaveBeenCalled();
    expect(existsSpy).not.toHaveBeenCalled();
  });

  it('enables authed and carries the cookie file path through when YT_COOKIE_FILE is set', () => {
    const config = resolveDifftestConfig({ YT_CHANNEL_ID: 'UCxxxx', YT_COOKIE_FILE: '/outside/repo/cookies.txt' });
    expect(config.authed.enabled).toBe(true);
    expect(config.authed.cookieFile).toBe('/outside/repo/cookies.txt');
  });

  it('defaults pollSeconds and honors an override', () => {
    expect(resolveDifftestConfig({ YT_CHANNEL_ID: 'UCxxxx' }).pollSeconds).toBe(DEFAULT_POLL_SECONDS);
    expect(resolveDifftestConfig({ YT_CHANNEL_ID: 'UCxxxx', POLL_SECONDS: '30' }).pollSeconds).toBe(30);
  });

  it('leaves channelId null when YT_CHANNEL_ID is unset', () => {
    expect(resolveDifftestConfig({}).channelId).toBeNull();
  });

  it('leaves outDir null (caller picks a default) when OUT_DIR is unset', () => {
    expect(resolveDifftestConfig({ YT_CHANNEL_ID: 'UCxxxx' }).outDir).toBeNull();
  });
});
