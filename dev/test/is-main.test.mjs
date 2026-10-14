// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { isMain } from '../../cli/ha.mjs';

const cli = new URL('../../cli/ha.mjs', import.meta.url);
test('isMain resolves symlinks on both sides and safely rejects missing paths', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'heddle-is-main-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const linkedCli = join(temp, 'linked cli.mjs');
  await symlink(fileURLToPath(cli), linkedCli);
  const original = process.argv;
  try {
    process.argv = [process.execPath, linkedCli];
    assert.equal(isMain(cli.href), true);
    assert.equal(isMain(pathToFileURL(linkedCli).href), true);
    assert.equal(isMain(import.meta.url), false, 'imported modules are not the entry point');
    assert.equal(isMain(pathToFileURL(join(temp, 'missing.mjs')).href), false);
    process.argv = [process.execPath, join(temp, 'missing.mjs')];
    assert.equal(isMain(cli.href), false);
    process.argv = [process.execPath];
    assert.equal(isMain(cli.href), false);
  } finally { process.argv = original; }
});

test('CLI remains runnable as a standalone file with only Node', async t => {
  const temp = await mkdtemp(join(tmpdir(), 'heddle-standalone-cli-'));
  t.after(() => rm(temp, { recursive: true, force: true }));
  const standalone = join(temp, 'ha.mjs');
  await copyFile(cli, standalone);
  const result = spawnSync(process.execPath, [standalone], {
    cwd: temp, env: {}, encoding: 'utf8', timeout: 10000,
  });
  assert.ifError(result.error);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /ha: Usage:/);
});
