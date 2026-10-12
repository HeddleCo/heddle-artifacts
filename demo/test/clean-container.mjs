// SPDX-License-Identifier: Apache-2.0
import { spawn } from 'node:child_process';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { startMock } from './mock-platform.mjs';
import { command, gitAuth } from '../../cli/ha.mjs';
const mock = await startMock({ mutation: process.env.MOCK_MUTATION });
const temp = await mkdtemp(join(tmpdir(), 'heddle-D-clean-'));
try {
  const key = randomBytes(32).toString('hex');
  mock.tokens.set(key, { name: 'source', scope: 'read' });
  await command('git', ['clone', '--quiet', '--bare', process.cwd(), join(mock.root, 'source.git')]);
  const source = `${mock.url}/git/source.git`;
  const env = { ...gitAuth([[source, key]]), SOURCE_URL: source, OPERATOR_TOKEN: mock.operatorToken,
    DEMO_URL: mock.url, DEMO_PROJECT: 'clean-demo', DEMO_DIR: '/tmp/heddle-try-it' };
  await writeFile(join(temp, 'env'), Object.entries(env).filter(([, v]) => v !== undefined).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
  const args = ['run', '--rm', '--network', 'host', '--env-file', join(temp, 'env'),
    '-v', `${resolve('demo/test/clean-container.sh')}:/input/clean-container.sh:ro`,
    'node:22-bookworm-slim', 'bash', '/input/clean-container.sh'];
  const status = await new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
    child.on('error', reject); child.on('close', resolvePromise);
  });
  if (status !== 0) throw new Error(`clean container failed: exit ${status}`);
} finally { await mock.close(); await rm(temp, { recursive: true, force: true }); }
