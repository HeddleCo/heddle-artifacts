// SPDX-License-Identifier: Apache-2.0
// Temporarily remove one behavior at a time, run the real browser check, then restore it.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const cwd = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env, UI_TEST_URL: 'http://127.0.0.1:8790', UI_SCREENSHOT_DIR: '.local/negative-shots',
  XDG_CONFIG_HOME: '/tmp/heddle-c-negative-config', WRANGLER_SEND_METRICS: 'false', FORCE_COLOR: '0' };
delete env.NO_COLOR;
const originals = new Map();
for (const file of ['src/app.tsx', 'src/api.ts', 'src/decision.ts']) originals.set(file, await readFile(new URL(`../${file}`, import.meta.url), 'utf8'));
const evidence = resolve(cwd, process.env.UI_NEGATIVE_EVIDENCE_DIR || 'evidence');
await mkdir(evidence, { recursive: true });
function run(args) { return spawnSync('npm', args, { cwd, env, encoding: 'utf8' }); }
function build() { const r = run(['run', 'build']); if (r.status !== 0) throw new Error(r.stdout + r.stderr); }
async function ready(bundle = false) {
  const expected = bundle ? await readFile(new URL('../dist/app.js', import.meta.url), 'utf8') : '';
  for (let i = 0; i < 100; i++) {
    try { const r = await fetch(`${env.UI_TEST_URL}${bundle ? '/app.js' : '/p/demo'}`); if (r.ok && (!bundle || await r.text() === expected)) return; } catch { /* Wait for local Worker startup. */ }
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Local Worker did not serve the expected assets.');
}
const scenarios = [
  { id: 'C-T1-board', file: 'src/app.tsx', before: 'view.tasks.map(task =>', after: 'view.tasks.slice(0, 0).map(task =>', grep: 'C-T1', marker: 'Expected: 3' },
  { id: 'C-T1-conflict', file: 'src/app.tsx', before: '!!regions.size &&', after: 'false && !!regions.size &&', grep: 'C-T1', marker: 'src/table.ts:parseRow' },
  { id: 'C-T1-why', file: 'src/app.tsx', before: "view?.narrative || 'Loading narrative…'", after: "'Narrative removed'", grep: 'C-T1', marker: 'Chosen:    bob' },
  { id: 'C-T2-replay', file: 'src/app.tsx', before: 'callbacks.current.onEvent(event);', after: '; /* Live event reducer removed. */', grep: 'C-T2 WebSocket replay updates board without reload', marker: 'data-push' },
  { id: 'C-T2-board-buffer', file: 'src/app.tsx', before: 'setView(pending.current.reduce(updateBoard, data));', after: 'setView(data);', grep: 'C-T2 early feed survives delayed initial board snapshot', marker: 'fail · 12/14' },
  { id: 'C-T2-compare-buffer', file: 'src/app.tsx', before: 'setView(pending.current.reduce(updateTask, task));', after: 'setView(task);', grep: 'C-T2 initial compare snapshot retains early discussion and landing', marker: '✓ Landed bob on main' },
  { id: 'C-T3-heads', file: 'src/decision.ts', before: 'expectHeads: [...view.heads]', after: 'expectHeads: []', grep: 'C-T3 decision exact body and 200', marker: 'state-alice-1' },
  { id: 'C-T3-forbidden', file: 'src/api.ts', before: "'Access denied. Sign in with an operator session.'", after: "'Forbidden handling removed.'", grep: 'C-T3 decision exact body and 403', marker: 'Access denied' },
  { id: 'C-T3-stale', file: 'src/app.tsx', before: 'setChanged(true); setError(conflictMessage(e.code));', after: 'setError(conflictMessage(e.code));', grep: 'C-T3 decision exact body and 409', marker: 'toBeDisabled' },
  { id: 'C-T3-rationale', file: 'src/decision.ts', before: 'if (!choice.pick || !choice.decider || !choice.rationale.trim()) return;', after: 'if (!choice.pick || !choice.decider) return;', grep: 'C-T3 required rationale', marker: 'toBeDisabled' },
  { id: 'C-T3-discussion', file: 'src/app.tsx', before: 'onTurn(turn);', after: '/* Discussion render update removed. */', grep: 'C-T3 required rationale', marker: 'Keep the API stable.' },
  { id: 'C-T4-routing', file: 'src/app.tsx', before: "path[2] === 'why'", after: "path[2] === 'why-disabled'", grep: 'C-T4', marker: 'Chosen:    bob' }
];
build();
const server = spawn(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'dev', '--config', 'wrangler.mock.jsonc', '--local', '--ip', '127.0.0.1', '--port', '8790', '--inspector-port', '9232', '--persist-to', `.local/negative-state-${process.pid}`], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let serverOutput = '';
server.stdout.on('data', chunk => { serverOutput += chunk; });
server.stderr.on('data', chunk => { serverOutput += chunk; });
server.on('exit', code => { if (code && code !== 143) console.error('Local mock Worker exited:', code, serverOutput); });
try {
  await ready();
  const baseline = run(['test']);
  await writeFile(resolve(evidence, 'baseline.txt'), `SPDX-License-Identifier: Apache-2.0\n$ npm test\n${baseline.stdout}${baseline.stderr}`);
  if (baseline.status !== 0) throw new Error('Baseline failed; no mutation evidence is valid.\n' + baseline.stdout + baseline.stderr);
  console.log(`Baseline: ${baseline.stdout.match(/(\d+) passed/)?.[1]} browser checks passed against local wrangler dev.`);
  for (const s of scenarios) {
    const original = originals.get(s.file);
    if (original.split(s.before).length !== 2) throw new Error(`Mutation ${s.id} must match exactly one site.`);
    try {
      await writeFile(new URL(`../${s.file}`, import.meta.url), original.replace(s.before, s.after)); build(); await ready(true);
      const r = run(['test', '--', '--grep', s.grep]);
      const output = (r.stdout + r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
      await writeFile(resolve(evidence, `negative-${s.id}.txt`), `SPDX-License-Identifier: Apache-2.0\nMutation: ${s.before} → ${s.after}\n$ npm test -- --grep '${s.grep}'\nExit: ${r.status}\n${output}`);
      if (r.status !== 1 || !output.includes(s.marker) || !output.includes('1 failed')) throw new Error(`Mutation ${s.id} did not produce its expected assertion failure.\n${output}`);
      console.log(`${s.id}: removed behavior → expected assertion failure (exit 1; ${s.marker}).`);
    } finally { await writeFile(new URL(`../${s.file}`, import.meta.url), original); }
  }
} finally {
  for (const [file, original] of originals) await writeFile(new URL(`../${file}`, import.meta.url), original);
  build();
  try { await ready(true); } catch (e) { try { process.kill(-server.pid, 'SIGTERM'); } catch {} throw new Error(String(e) + '\n' + serverOutput); }
  const restored = run(['test']);
  await writeFile(resolve(evidence, 'restored.txt'), `SPDX-License-Identifier: Apache-2.0\n$ npm test\n${restored.stdout}${restored.stderr}`);
  try { process.kill(-server.pid, 'SIGTERM'); } catch { /* Server already exited. */ }
  if (restored.status !== 0) throw new Error('Restored implementation failed.\n' + restored.stdout + restored.stderr);
  console.log(`Restored: ${restored.stdout.match(/(\d+) passed/)?.[1]} browser checks passed. All source mutations reverted.`);
}
