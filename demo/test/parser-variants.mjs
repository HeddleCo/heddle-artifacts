// SPDX-License-Identifier: Apache-2.0
import { cp, mkdtemp, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
for (const [variant, passed, failed] of [['base', 14, 4], ['alice', 15, 3], ['bob', 18, 0]]) {
  const dir = await mkdtemp(join(tmpdir(), 'heddle-D-parser-'));
  try {
    await cp('demo/seed-project', dir, { recursive: true, filter: path => !path.includes('node_modules') });
    await symlink(resolve('demo/seed-project/node_modules'), join(dir, 'node_modules'));
    await cp('demo/scripted-agents/escapes.test.ts', join(dir, 'test/escapes.test.ts'));
    if (variant !== 'base') await cp(`demo/scripted-agents/${variant}.ts`, join(dir, 'src/table.ts'));
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, [resolve('demo/seed-project/node_modules/vitest/vitest.mjs'), 'run', '--maxWorkers=1', '--reporter=json'], { cwd: dir });
      let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', () => {});
      child.on('error', reject); child.on('close', code => resolvePromise({ code, report: JSON.parse(output) }));
    });
    assert.equal(result.code, failed ? 1 : 0);
    assert.equal(result.report.numPassedTests, passed); assert.equal(result.report.numFailedTests, failed);
    console.log(`${variant}: exit ${result.code}; ${passed} passed, ${failed} failed; regression suite is load-bearing.`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
