// Single source of truth for the youtube-chat patch verification constants
// used by scripts/check-poller-deps.mjs (and its test,
// test/check-poller-deps.test.js). Do not inline either value elsewhere —
// import from here so the guard and its tests can never drift apart.
//
// SENTINEL: string that only appears in tools/yt-poller/node_modules/
// youtube-chat/dist/parser.js if the patch in
// tools/yt-poller/patches/youtube-chat+2.2.0.patch actually landed in the
// built dist (patch-package printing a success checkmark is not proof of
// that — confirmed false-positive 2026-08-10).
export const SENTINEL = 'liveChatModeChangeMessageRenderer';

// PARSER_DIST_RELATIVE_PATH: path to the patched file, relative to the
// poller root (tools/yt-poller, or CHECK_POLLER_DEPS_ROOT in tests).
export const PARSER_DIST_RELATIVE_PATH = 'node_modules/youtube-chat/dist/parser.js';
