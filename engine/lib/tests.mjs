// SPDX-License-Identifier: Apache-2.0
import { run } from './process.mjs';
import { access } from 'node:fs/promises';
import { join } from 'node:path';

export async function testCandidate(cwd) {
  const start = Date.now();
  try {
    const env = { CI: '1', NO_COLOR: '1', NPM_CONFIG_CACHE: join(process.env.TMPDIR || '/tmp', 'heddle-npm-cache') };
    const has = file => access(join(cwd, file)).then(() => true, () => false);
    if (await has('package-lock.json') && !await has('node_modules')) {
      const install = await run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund', '--silent'], { cwd, timeout: 60000, allowFailure: true, maxBytes: 1024 * 1024, env });
      if (install.code !== 0 || install.timedOut || install.overflow) return { status: 'error', passed: 0, failed: 0, summary: 'Unable to install locked test dependencies within 60 seconds', durationMs: Date.now() - start };
    }
    const remaining = 60000 - (Date.now() - start);
    if (remaining <= 0) return { status: 'error', passed: 0, failed: 0, summary: 'Tests exceeded 60 seconds', durationMs: Date.now() - start };
    const result = await run('npm', ['test', '--silent'], { cwd, timeout: remaining, allowFailure: true, maxBytes: 1024 * 1024, env });
    const output = (result.stdout.toString() + result.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const passed = Number(/(?:Tests\s+.*?)(\d+) passed/.exec(output)?.[1] || /(?:#|ℹ) pass (\d+)/.exec(output)?.[1] || 0);
    const failed = Number(/(?:Tests\s+)(\d+) failed/.exec(output)?.[1] || /(?:#|ℹ) fail (\d+)/.exec(output)?.[1] || 0);
    return { status: result.timedOut || result.overflow ? 'error' : result.code === 0 ? 'pass' : 'fail', passed, failed,
      summary: result.timedOut ? 'Tests exceeded 60 seconds' : result.overflow ? 'Test output exceeded 1 MiB' : output.trim().slice(-2048), durationMs: Date.now() - start };
  } catch { return { status: 'error', passed: 0, failed: 0, summary: 'Unable to run npm test --silent', durationMs: Date.now() - start }; }
}
