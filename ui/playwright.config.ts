// SPDX-License-Identifier: Apache-2.0
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './test', testMatch: '*.spec.ts', workers: 1, fullyParallel: false,
  timeout: 20000, expect: { timeout: 6000 }, reporter: 'list',
  use: { baseURL: process.env.UI_TEST_URL || 'http://127.0.0.1:8788', viewport: { width: 1280, height: 720 }, trace: process.env.UI_SCREENSHOT_DIR ? 'off' : 'retain-on-failure',
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : undefined },
  webServer: process.env.UI_TEST_URL ? undefined : {
    command: 'npm run dev:worker', url: 'http://127.0.0.1:8788/p/demo',
    reuseExistingServer: !process.env.CI, timeout: 60000,
    env: { XDG_CONFIG_HOME: '/tmp/heddle-c-config', WRANGLER_SEND_METRICS: 'false' }
  }
});
