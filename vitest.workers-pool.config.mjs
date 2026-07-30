// Isolated Vitest config for the ingest-tail Phase 4 discriminating tests.
// Deliberately NOT named vitest.config.* so
// plain `npm test` (zero-config vitest, root package.json) never loads this
// file or the @cloudflare/vitest-pool-workers plugin — the existing 380-test
// suite stays on its current plain-Node runner, untouched. Invoke this one
// explicitly via `npm run test:gate`.
//
// Real workerd (via Miniflare), not a Node mock — this is what lets Phase 4a
// test actual input-gate dispatch behavior, which a plain vitest call into
// the ChatHub class (like test/pull-refresh.test.js) structurally cannot:
// calling a method directly skips the runtime's event-dispatch queue
// entirely, so there is no gate to observe either way.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      // Test-only overrides — never real secrets. TWITCH_CLIENT_ID/SECRET
      // just need to be non-empty so getTwitchAppToken doesn't short-circuit
      // before making a (mocked) fetch call; MULTICHAT_INGEST_SECRET matches
      // what handleIngestYt's auth check expects.
      miniflare: {
        bindings: {
          TWITCH_CLIENT_ID: 'gate-test-client-id',
          TWITCH_CLIENT_SECRET: 'gate-test-client-secret',
          MULTICHAT_INGEST_SECRET: 'gate-test-ingest-secret',
        },
      },
    }),
  ],
  test: {
    include: ['test-workers/**/*.workers.mjs'],
  },
});
