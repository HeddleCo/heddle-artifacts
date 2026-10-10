// SPDX-License-Identifier: Apache-2.0
import { cp, mkdtemp, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
for (const [name, mutate] of [
  ['keep duplicate setup headers', s => s.replace('if (configured) await command', 'if (false) await command')],
  ['remove project URL credential guard', s => s.replace('url.username || url.password || url.search || url.hash ||', 'false ||')],
]) {
  const temp = await mkdtemp(join(tmpdir(), 'heddle-D-cli-mutation-'));
  try {
    for (const dir of ['cli', 'demo', 'reviewer']) await cp(dir, join(temp, dir), { recursive: true, filter: path => !path.includes('node_modules') && !path.includes('/evidence') });
    await symlink(resolve('demo/seed-project/node_modules'), join(temp, 'demo/seed-project/node_modules'));
    const file = join(temp, 'cli/ha.mjs'), source = await readFile(file, 'utf8'), changed = mutate(source);
    if (source === changed) throw new Error('Mutation did not match');
    await writeFile(file, changed);
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn(process.execPath, ['--test', join(temp, 'cli/ha.test.mjs')]);
      let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
      child.on('error', reject); child.on('close', code => resolvePromise({ code, output }));
    });
    if (result.code !== 1 || !/AssertionError/.test(result.output)) throw new Error(`Mutation did not fail assertions: ${name}`);
    console.log(`${name}: exit ${result.code}; ${result.output.match(/(?:ℹ |# )fail \d+/)?.[0] ?? 'assertions failed'}`);
  } finally { await rm(temp, { recursive: true, force: true }); }
}
