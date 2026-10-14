// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writePrivate } from './private-file.mjs';

test('existing permissions are restricted before truncation and the first private byte', async () => {
  const dir = await fs.mkdtemp(join(tmpdir(), 'private-order-')), file = join(dir, 'token');
  const original = fs.open, originalWrite = fs.writeFile; let observed = 0;
  try {
    await fs.writeFile(file, 'old public contents', { mode: 0o666 }); await fs.chmod(file, 0o666);
    fs.open = async (...args) => {
      const handle = await original(...args);
      for (const operation of ['truncate', 'writeFile']) {
        const fn = handle[operation].bind(handle);
        handle[operation] = async (...values) => {
          assert.equal((await handle.stat()).mode & 0o777, 0o600, `permissions before ${operation}`); observed++;
          return fn(...values);
        };
      }
      return handle;
    };
    fs.writeFile = async (target, ...values) => {
      if (target === file) { assert.equal((await fs.stat(file)).mode & 0o777, 0o600, 'permissions before path write'); observed++; }
      return originalWrite(target, ...values);
    };
    syncBuiltinESMExports();
    await writePrivate(file, 'private replacement');
    assert.ok(observed > 0, 'observed the actual file mutation');
    assert.equal(await fs.readFile(file, 'utf8'), 'private replacement');
  } finally { fs.open = original; fs.writeFile = originalWrite; syncBuiltinESMExports(); await fs.rm(dir, { recursive: true, force: true }); }
});
