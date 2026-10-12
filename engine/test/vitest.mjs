// SPDX-License-Identifier: Apache-2.0
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { testCandidate } from '../lib/tests.mjs';
import { createReviewedFixtureEntry } from '../lib/trusted-tests.mjs';

const root = await mkdtemp(join(process.env.TMPDIR || '/tmp', 'track-b-vitest-'));
const candidate = join(root, 'candidate'); await mkdir(candidate);
// The package and lockfile are the shipped, reviewed public dependency fixture.
const packageJson = await readFile(new URL('../../demo/seed-project/package.json', import.meta.url));
const lockfile = await readFile(new URL('../../demo/seed-project/package-lock.json', import.meta.url));
const fixture = expected => `// SPDX-License-Identifier: Apache-2.0\nimport {test,expect} from "vitest"; test("demo dependency bootstrapping",()=>expect(2+2).toBe(${expected}));\n`;
const sources = expected => ({ 'package.json': packageJson, 'package-lock.json': lockfile, 'parser.test.ts': fixture(expected) });
const manifest = join(root, 'operator-reviewed.json');
await writeFile(manifest, JSON.stringify({ version: 1, trees: [createReviewedFixtureEntry('vitest-positive', sources(4)), createReviewedFixtureEntry('vitest-negative', sources(5))] }), { mode: 0o600 });
const previous = process.env.HEDDLE_TRUSTED_TEST_MANIFEST;
process.env.HEDDLE_TRUSTED_TEST_MANIFEST = manifest;
try {
  for (const [path, contents] of Object.entries(sources(4))) await writeFile(join(candidate, path), contents);
  const good = await testCandidate(candidate); assert.equal(good.status, 'pass', good.summary); assert.equal(good.passed, 1);
  console.log('Vitest PASS: reviewed source copied without metadata; locked dependencies installed fresh; npm test --silent reports 1 passed within 60 seconds');
  await writeFile(join(candidate, 'parser.test.ts'), fixture(5));
  const bad = await testCandidate(candidate); assert.equal(bad.status, 'fail', bad.summary); assert.equal(bad.failed, 1);
  console.log('Vitest negative PASS: separately reviewed deliberate assertion regression reports fail / 1 failed');
  await writeFile(join(candidate, 'parser.test.ts'), fixture(6));
  const unknown = await testCandidate(candidate); assert.equal(unknown.status, 'skipped'); assert.match(unknown.summary, /^Tests withheld:/);
  console.log('Vitest trust negative PASS: an unreviewed regression is withheld instead of executed');
} finally {
  if (previous === undefined) delete process.env.HEDDLE_TRUSTED_TEST_MANIFEST; else process.env.HEDDLE_TRUSTED_TEST_MANIFEST = previous;
  await rm(root, { recursive: true, force: true });
}
