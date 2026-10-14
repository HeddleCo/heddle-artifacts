// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
for (const { script, args, expected } of [
  { script: 'cli/ha.mjs', args: [], expected: /ha: Usage:/ },
  { script: 'demo/lib/harness.mjs', args: ['invalid-action'], expected: /demo: Expected run, verify/ },
]) {
  test(`${script} runs through a symlinked repository directory`, async t => {
    const temp = await mkdtemp(join(tmpdir(), 'heddle-entry-symlink-'));
    t.after(() => rm(temp, { recursive: true, force: true }));
    const linkedRoot = join(temp, 'repo');
    await symlink(root, linkedRoot, 'dir');
    const result = spawnSync(process.execPath, [join(linkedRoot, script), ...args], {
      cwd: temp, env: { PATH: process.env.PATH, TMPDIR: tmpdir() }, encoding: 'utf8', timeout: 10000,
    });
    const output = result.stdout + result.stderr;
    t.diagnostic(`${script}: exit=${result.status}, output=${JSON.stringify(output.trim())}`);
    assert.ifError(result.error);
    assert.equal(result.signal, null);
    assert.equal(result.status, 1, 'entry point must run and reject missing/invalid arguments');
    assert.match(output, expected);
  });
}
