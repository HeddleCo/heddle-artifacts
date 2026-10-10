// SPDX-License-Identifier: Apache-2.0
import { readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
// Deliberately break production guards, run the corresponding acceptance test,
// then restore the exact original bytes. Never commit or push mutant sources.
const mutations = [
  { name: 'A-T1', files: [['worker/project-do.ts', 'if (!lane) {', 'if (true) {']] },
  { name: 'A-T2', files: [['worker/project-do.ts', 'const id = `${row.id}:${sha}`;', 'const id = `${row.id}:${sha}:${crypto.randomUUID()}`;'], ['worker/store.ts', ', UNIQUE(lane, sha)', '']] },
  { name: 'A-T3', files: [['worker/project-do.ts', 'ORDER BY rowid LIMIT 100', 'ORDER BY rowid LIMIT 1']] },
  { name: 'A-T4', label: 'operator auth', files: [['worker/project-do.ts', "if (!credential(request)) throw new HttpError(403, 'forbidden');", "if (!credential(request)) return { op: true };"]] },
  { name: 'A-T4', label: 'stale heads', files: [['worker/project-do.ts', 'if (!Array.isArray(body.expectHeads) ||', 'if (false && (!Array.isArray(body.expectHeads) ||'], ['worker/project-do.ts', "h !== heads[i])) throw new HttpError(409, 'stale'", "h !== heads[i]))) throw new HttpError(409, 'stale'"]] },
  { name: 'A-T5', files: [['worker/engine-client.ts', 'if (!generation) return;', 'if (true) return;']] }
];
function run(args) { return new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', '--reporter', 'verbose', ...args], { env: { ...process.env, WRANGLER_LOG_PATH: process.env.WRANGLER_LOG_PATH ?? '/tmp/track-a-negative-wrangler.log' } });
  let output = ''; child.stdout.on('data', b => output += b); child.stderr.on('data', b => output += b); child.on('error', reject); child.on('close', code => resolve({ code, output }));
}); }
for (const mutation of mutations) {
  const originals = new Map();
  try {
    for (const [file, before, after] of mutation.files) {
      const current = await readFile(file, 'utf8'); if (!originals.has(file)) originals.set(file, current);
      if (!current.includes(before)) throw new Error(`Mutation anchor absent for ${mutation.name}`);
      await writeFile(file, current.replace(before, after));
    }
    const result = await run(['-t', mutation.name]);
    if (result.code === 0 || !result.output.includes('AssertionError') || !/\d+ failed/.test(result.output)) throw new Error(`Mutation ${mutation.name} did not produce the expected assertion failure`);
    const assertion = result.output.split('\n').find(line => line.includes('AssertionError'));
    console.log(`${mutation.name}${mutation.label ? ` (${mutation.label})` : ''}: mutant exit ${result.code}; ${assertion.trim()}`);
  } finally { for (const [file, original] of originals) await writeFile(file, original); }
}
const green = await run([]);
if (green.code !== 0) { console.error('Restored suite failed'); process.exitCode = 1; }
else console.log('Restored production sources: all Workers tests PASS; every A-T1–A-T5 guard mutation was caught.');
