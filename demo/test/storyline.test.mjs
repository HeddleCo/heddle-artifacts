// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startMock } from './mock-platform.mjs';
import { command, joinProject, request } from '../../cli/ha.mjs';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
async function environment(mutation) {
  const mock = await startMock({ mutation });
  const directory = await mkdtemp(join(tmpdir(), 'heddle-D-demo-'));
  const args = ['--url', mock.url, '--dir', directory, '--timeout', '20', '--delay', '0'];
  const env = { OPERATOR_TOKEN: mock.operatorToken, DEMO_RESET_COMMAND: `node '${join(root, 'demo/test/cleanup-mock.mjs')}'` };
  return { mock, directory, args, env, close: async () => { await mock.close(); await rm(directory, { recursive: true, force: true }); } };
}
test('D-T1 local contract rehearsal twice after reset; CLI status/why and scoped Git auth', { timeout: 90000 }, async t => {
  const e = await environment(); t.after(e.close);
  for (let take = 1; take <= 2; take++) {
    const reset = await command('bash', [join(root, 'demo/reset.sh'), ...e.args], { env: e.env });
    assert.match(reset, /cleanup completed and project recreated/);
    const output = await command('bash', [join(root, 'demo/run.sh'), '--mode', 'scripted', ...e.args], { env: e.env });
    assert.match(output, /PASS scripted/); assert.match(output, /Chosen:\s*bob/); assert.match(output, /Rejected:\s*alice/);
    const state = JSON.parse(await readFile(join(e.directory, '.demo.json'), 'utf8'));
    const result = JSON.parse(await readFile(join(e.directory, String(state.generation), 'result.json'), 'utf8'));
    assert.ok(result.seconds < 240);
    const status = await command('node', [join(root, 'cli/ha.mjs'), 'status'], { cwd: state.clones.alice });
    assert.match(status, /parser-escapes/); assert.ok(!status.includes(e.mock.operatorToken));
    const why = await command('node', [join(root, 'cli/ha.mjs'), 'why', result.main], { cwd: state.clones.alice });
    assert.match(why, /Chosen:\s*bob/); assert.match(why, /Rejected:\s*alice/);
    assert.equal((await stat(join(state.clones.alice, '.git/ha-auth'))).mode & 0o777, 0o600);
    await assert.rejects(command('git', ['push', '--quiet', 'upstream', 'HEAD:refs/heads/unauthorized'], { cwd: state.clones.alice }), /git failed/);
    assert.equal(await command('git', ['remote', 'get-url', 'origin'], { cwd: state.clones.alice }), `${e.mock.url}/git/demo--parser-escapes--alice.git`);
    console.log(`Local rehearsal ${take}: ${output.split('\n').at(-1)}`);
  }
});
for (const [mutation, expected] of [['conflict', 'Parser candidates must conflict'], ['notes', 'Git log lost chosen/rejected narrative'], ['stale', 'HTTP 409'], ['tests', 'Bob tests must pass']]) {
  test(`load-bearing storyline guard rejects ${mutation} mutation`, { timeout: 60000 }, async t => {
    const e = await environment(mutation); t.after(e.close);
    // Preserve child error text privately, then assert the precise guard fired.
    await command('bash', [join(root, 'demo/reset.sh'), ...e.args], { env: e.env });
    const { spawn } = await import('node:child_process');
    const result = await new Promise((resolvePromise, reject) => {
      const child = spawn('bash', [join(root, 'demo/run.sh'), '--mode', 'scripted', ...e.args], { env: { ...process.env, ...e.env } });
      let output = ''; child.stdout.on('data', c => output += c); child.stderr.on('data', c => output += c);
      child.on('error', reject); child.on('close', code => resolvePromise({ code, output }));
    });
    assert.equal(result.code, 1); assert.ok(result.output.includes(expected), result.output);
    console.log(`Mutation ${mutation}: exit ${result.code}; ${result.output.split('\n').find(line => line.startsWith('demo:'))}`);
  });
}
test('reset refuses to guess a production deletion endpoint', async t => {
  const e = await environment(); t.after(e.close);
  await assert.rejects(command('bash', [join(root, 'demo/reset.sh'), ...e.args], { env: { ...e.env, DEMO_RESET_COMMAND: '' } }), /bash failed/);
  assert.equal(e.mock.projects.size, 0);
});
