// Pure env-parsing for authed-chat-difftest.mjs, split out so the
// anon-only-mode decision is unit-testable without touching the
// filesystem or spawning anything (see test/authed-config.test.mjs).
export const DEFAULT_POLL_SECONDS = 120;

// resolveDifftestConfig never reads the cookie file itself — it only
// decides WHETHER the authed side should run, based purely on whether
// YT_COOKIE_FILE is set in the passed-in env. The caller is responsible for
// actually reading/parsing the file (and only when config.authed.enabled is
// true), which keeps this function side-effect-free and keeps "no cookie
// env var set" provably a zero-filesystem-access path.
export function resolveDifftestConfig(env = {}) {
  const channelId = env.YT_CHANNEL_ID || null;
  const pollSeconds = env.POLL_SECONDS ? Number(env.POLL_SECONDS) : DEFAULT_POLL_SECONDS;
  const outDir = env.OUT_DIR || null;

  const cookieFile = env.YT_COOKIE_FILE || null;
  const authed = cookieFile
    ? { enabled: true, cookieFile }
    : { enabled: false, cookieFile: null, reason: 'YT_COOKIE_FILE not set — authed side skipped, anon-only mode' };

  return { channelId, pollSeconds, outDir, authed };
}
