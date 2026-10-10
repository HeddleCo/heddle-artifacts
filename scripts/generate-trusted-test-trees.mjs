// SPDX-License-Identifier: Apache-2.0
// Operator-only review aid. Never invoke this from ingest or use candidate input.
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createReviewedFixtureEntry } from '../engine/lib/trusted-tests.mjs';

const demo = new URL('../demo/', import.meta.url);
const files = ['README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'src/table.ts', 'test/table.test.ts'];
const seed = Object.fromEntries(await Promise.all(files.map(async path => [path, await readFile(new URL(`seed-project/${path}`, demo))])));
const trees = [createReviewedFixtureEntry('demo-seed', seed)];
for (const agent of ['alice', 'bob', 'carol']) {
  const source = { ...seed };
  if (agent === 'carol') source['README.md'] = await readFile(new URL('scripted-agents/carol.md', demo));
  else {
    source['src/table.ts'] = await readFile(new URL(`scripted-agents/${agent}.ts`, demo));
    source['test/escapes.test.ts'] = await readFile(new URL('scripted-agents/escapes.test.ts', demo));
  }
  trees.push(createReviewedFixtureEntry(`demo-${agent}`, source));
}
const output = JSON.stringify({ version: 1, purpose: 'Operator-reviewed public synthetic demo fixtures only. Changes require an out-of-band source and lockfile review; this is not a sandbox.', trees }, null, 2) + '\n';
const path = new URL('trusted-test-trees.json', demo);
if (process.argv.includes('--write')) {
  await writeFile(path, output, { mode: 0o644 });
  console.log(`Wrote review artifact ${fileURLToPath(path)}. Review its complete source trees before shipping.`);
} else {
  if (await readFile(path, 'utf8') !== output) throw new Error('Reviewed fixture manifest differs. Review source changes before explicitly regenerating it with --write.');
  console.log('Trusted fixture manifest matches the four explicit public demo trees.');
}
