// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { run } from '../lib/process.mjs';
import { testCandidate } from '../lib/tests.mjs';

const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-vitest-'));
await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'engine-vitest-evidence', private: true, type: 'module', scripts: { test: 'vitest run --maxWorkers=1' }, devDependencies: { vitest: '3.2.4' } }));
const file = join(root, 'parser.test.ts');
const fixture = expected => `// SPDX-License-Identifier: Apache-2.0\nimport {test,expect} from "vitest"; test("demo dependency bootstrapping",()=>expect(2+2).toBe(${expected}));\n`;
await writeFile(file, fixture(4));
await run('npm', ['install', '--package-lock-only', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root, env: { NPM_CONFIG_CACHE: join(process.env.TMPDIR || '/tmp', 'heddle-npm-cache') } });
const good = await testCandidate(root); assert.equal(good.status, 'pass'); assert.equal(good.passed, 1);
console.log('Vitest PASS: missing node_modules installed from lockfile; npm test --silent reports 1 passed within 60 seconds');
await writeFile(file, fixture(5));
const bad = await testCandidate(root); assert.equal(bad.status, 'fail'); assert.equal(bad.failed, 1);
console.log('Vitest negative PASS: deliberate assertion regression reports fail / 1 failed');
