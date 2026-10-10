// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.dev.jsonc' }, miniflare: { compatibilityDate: '2026-08-15', bindings: { DEV: '0', OPERATOR_TOKEN: 'test-operator', ENGINE_DEV_URL: '' } } })],
  test: { include: ['worker/test/**/*.test.ts'], testTimeout: 20000 }
});
