// SPDX-License-Identifier: Apache-2.0
// Actual installed coding agents; contract mock still supplies fixture Heddle states/keys.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { startMock } from './mock-platform.mjs';
import { command } from '../../cli/ha.mjs';
const mock = await startMock();
const directory = await mkdtemp(join(tmpdir(), 'heddle-D-real-live-'));
let transcript = '';
const capture = text => { transcript += text; process.stdout.write(text); };
try {
  capture('Actual Codex agents in three tmux panes; localhost contract mock, fixture engine keys.\n');
  const code = await new Promise((resolvePromise, reject) => {
    const child = spawn('bash', [resolve('demo/run.sh'), '--mode', 'live', '--url', mock.url,
      '--dir', directory, '--timeout', '600'], { env: { ...process.env, OPERATOR_TOKEN: mock.operatorToken } });
    child.stdout.on('data', chunk => capture(chunk.toString())); child.stderr.on('data', chunk => capture(chunk.toString()));
    child.on('error', reject); child.on('close', resolvePromise);
  });
  const state = JSON.parse(await readFile(join(directory, '.demo.json'), 'utf8'));
  const session = `heddle-${state.id}-${state.generation}`;
  for (const pane of ['0', '1', '2']) {
    try { capture(`Pane ${pane}:\n${await command('tmux', ['capture-pane', '-p', '-S', '-1000', '-t', `${session}:0.${pane}`])}\n`); } catch { capture(`Pane ${pane}: unavailable\n`); }
  }
  capture(`Git receive-pack request timeline: ${JSON.stringify(mock.pushes, null, 2)}\n`);
  capture(`Live harness exit ${code}. Private clones retained at ${directory}.\n`);
  await writeFile(resolve('demo/evidence/live-local.txt'), transcript);
  process.exitCode = code;
} finally { await mock.close(); }
