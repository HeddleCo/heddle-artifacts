// SPDX-License-Identifier: Apache-2.0
import { run } from './process.mjs';

export async function testCandidate(cwd) {
  const start = Date.now();
  try {
    const result = await run('npm', ['test', '--silent'], { cwd, timeout: 60000, allowFailure: true, maxBytes: 1024 * 1024, env: { CI: '1', NO_COLOR: '1' } });
    const output = (result.stdout.toString() + result.stderr.toString()).replace(/\x1b\[[0-9;]*m/g, '');
    const passed = Number(/(?:Tests\s+.*?)(\d+) passed/.exec(output)?.[1] || /# pass (\d+)/.exec(output)?.[1] || 0);
    const failed = Number(/(?:Tests\s+)(\d+) failed/.exec(output)?.[1] || /# fail (\d+)/.exec(output)?.[1] || 0);
    return { status: result.timedOut || result.overflow ? 'error' : result.code === 0 ? 'pass' : 'fail', passed, failed,
      summary: result.timedOut ? 'Tests exceeded 60 seconds' : result.overflow ? 'Test output exceeded 1 MiB' : output.trim().slice(-2048), durationMs: Date.now() - start };
  } catch { return { status: 'error', passed: 0, failed: 0, summary: 'Unable to run npm test --silent', durationMs: Date.now() - start }; }
}
