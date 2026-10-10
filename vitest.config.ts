// SPDX-License-Identifier: Apache-2.0
import { fileURLToPath, URL } from 'node:url';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
export default defineConfig({
  resolve: { alias: { 'heddle-reviewer': fileURLToPath(new URL('./dev/stub-reviewer.ts', import.meta.url)) } },
  plugins: [cloudflareTest({ wrangler: { configPath: './wrangler.dev.jsonc' }, miniflare: { compatibilityDate: '2026-08-15', bindings: { DEV: '0', OPERATOR_TOKEN: 'test-operator', ENGINE_DEV_URL: '' } } })],
  test: { include: ['worker/test/**/*.test.ts'], testTimeout: 20000 }
});
