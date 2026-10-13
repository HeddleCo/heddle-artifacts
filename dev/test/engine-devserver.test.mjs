// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startEngineDevserver } from '../engine-devserver.mjs';
test('host engine-devserver streams bytes, isolates project roots, forwards env credentials, preserves exit 2 and suppresses stderr', async () => {
  const root = await mkdtemp(join(tmpdir(), 'engine-host-test-')), script = join(root, 'engine.mjs');
  await writeFile(script, `// SPDX-License-Identifier: Apache-2.0\nlet chunks=[];for await(const c of process.stdin)chunks.push(c);const input=Buffer.concat(chunks);const cmd=process.argv[2];if(cmd==='snapshot'){process.stdout.write(Buffer.from([0,255,4,3]));}else if(cmd==='restore'){process.stdout.write(JSON.stringify({generation:input.length})+'\\n');}else if(cmd==='decide'){process.stderr.write('fixture-secret-must-not-be-forwarded');process.stdout.write(JSON.stringify({error:{code:'stale',message:'changed'}})+'\\n');process.exitCode=2;}else{process.stdout.write(JSON.stringify({root:process.env.ENGINE_STATE_DIR,hasEnv:process.env.ARTIFACTS_WRITE_TOKEN==='fixture-only'})+'\\n');}\n`);
  const server = await startEngineDevserver({ root: join(root, 'state'), engine: script, port: 0, stub: false });
  const request = (project, command, body = '{}') => fetch(`${server.origin}/projects/${project}/${command}`, { method: 'POST', body, headers: { 'x-engine-env': JSON.stringify({ ARTIFACTS_WRITE_TOKEN: 'fixture-only' }) } });
  try {
    assert.equal((await request('a', 'decision.validate')).status, 200, 'decision anchor preflight reaches the engine');
    const a = await (await request('a', 'selftest')).json(), b = await (await request('b', 'selftest')).json();
    assert.notEqual(a.root, b.root); assert.equal(a.hasEnv, true);
    const bytes = new Uint8Array(await (await request('a', 'snapshot')).arrayBuffer()); assert.deepEqual([...bytes], [0, 255, 4, 3]);
    const restore = await (await request('a', 'restore', bytes)).json(); assert.equal(restore.generation, 4);
    const rejection = await request('a', 'decide'); assert.equal(rejection.status, 422); assert.equal((await rejection.json()).error.code, 'stale');
    assert.equal((await request('a', 'unknown')).status, 404);
  } finally { await server.close(); await rm(root, { recursive: true, force: true }); }
});
