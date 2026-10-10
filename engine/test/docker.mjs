// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run } from '../lib/process.mjs';

const repository = fileURLToPath(new URL('../../', import.meta.url));
const target = 'heddle-artifacts-engine:track-b';
const env = { DOCKER_CONFIG: process.env.DOCKER_CONFIG || join(process.env.TMPDIR || '/tmp', 'track-b-docker-config') };
const docker = args => run('docker', args, { cwd: repository, env, timeout: 120000 });
const inspect = async image => JSON.parse((await docker(['image', 'inspect', image])).stdout)[0];
const image = await inspect(target);
assert(image.Size < 400000000, 'Docker image must be under 400 MB');
assert.equal(image.Config.User, '65532:65532', 'Docker must run non-root');
const result = JSON.parse((await docker(['run', '--rm', '-i', target, 'selftest'])).stdout);
assert.equal(result.ok, true, 'Docker pinned versions');
console.log(`Docker PASS: ${image.Size} bytes < 400000000; user=${image.Config.User}`);
console.log(JSON.stringify(result));

const wrongVersion = JSON.parse((await docker(['run', '--rm', '-e', 'HEDDLE_BIN=/usr/bin/git', target, 'selftest'])).stdout);
assert.equal(wrongVersion.ok, false);
console.log('Docker version negative PASS: substitute Git for Heddle → selftest ok=false');

const temp = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-image-negative-'));
const file = join(temp, 'Dockerfile');
const source = await readFile(join(repository, 'engine/Dockerfile'), 'utf8');
await writeFile(file, source.slice(0, source.indexOf('# Keep the Debian trixie')) + '\nENV ENGINE_STATE_DIR=/state PATH=/usr/local/bin:/usr/bin:/bin TMPDIR=/tmp\nUSER 65532:65532\nWORKDIR /opt/engine\nENTRYPOINT ["engine"]\n');
const negative = 'heddle-artifacts-engine:negative-full-runtime';
await docker(['build', '-f', file, '-t', negative, '.']);
const full = await inspect(negative);
assert(full.Size >= 400000000, 'Reverting minimal root filesystem must break image acceptance');
console.log(`Docker size negative PASS: revert minimal root filesystem → ${full.Size} bytes; under-400-MB assertion fails`);
