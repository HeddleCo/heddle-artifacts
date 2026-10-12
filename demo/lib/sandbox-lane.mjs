// SPDX-License-Identifier: Apache-2.0
// One live lane whose coding agent runs in a Cloudflare Sandbox (agent-runner/).
// Usage: node sandbox-lane.mjs <codex|claude> <lane-name> <grant.json> <brief.md> <exit-marker>
// Env: DEMO_RUNNER_URL, and DEMO_RUNNER_TOKEN_FILE (a 0600 file holding the runner bearer).
import { readFile, rm, writeFile } from 'node:fs/promises';

const [agent, name, grantPath, briefPath, marker] = process.argv.slice(2);
const finish = async (code, line) => { console.log(line); await writeFile(marker, String(code)); };
try {
  if (!['codex', 'claude'].includes(agent) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name ?? '')) throw new Error('usage');
  const base = new URL(process.env.DEMO_RUNNER_URL ?? '');
  if (base.protocol !== 'https:' || base.pathname !== '/') throw new Error('DEMO_RUNNER_URL must be an https origin');
  const token = (await readFile(process.env.DEMO_RUNNER_TOKEN_FILE ?? '', 'utf8')).trim();
  // Read the lane grant once, then remove it from disk; it travels only to the runner Worker.
  const grant = JSON.parse(await readFile(grantPath, 'utf8')); await rm(grantPath, { force: true });
  const lane = new URL(`/lanes/${agent}/${name}`, base), headers = { authorization: `Bearer ${token}` };
  const who = name.split('-').at(-2);
  const started = await fetch(lane, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ grant, prompt: await readFile(briefPath, 'utf8'), author: { name: who, email: `${who}@heddle-artifacts.local` } }),
    signal: AbortSignal.timeout(300000) });
  if (started.status !== 202) { await finish(1, `${who}: sandbox start failed (HTTP ${started.status})`); process.exit(); }
  console.log(`${who}: ${agent} running in a Cloudflare Sandbox`);
  let last = '';
  for (const deadline = Date.now() + 40 * 60 * 1000; Date.now() < deadline;) {
    await new Promise(r => setTimeout(r, 10000));
    let status;
    try { status = await (await fetch(lane, { headers, signal: AbortSignal.timeout(30000) })).json(); } catch { continue; }
    if (status.state !== last) { console.log(`${who}: ${status.state}`); last = status.state; }
    if (status.state === 'succeeded') { await finish(0, `${who}: agent finished`); process.exit(); }
    if (['failed', 'lost'].includes(status.state)) { await finish(1, `${who}: agent ${status.state}`); process.exit(); }
  }
  await finish(1, `${who}: timed out after 40 minutes`);
} catch (error) {
  await finish(1, `${name ?? 'lane'}: ${error.message === 'usage' ? 'invalid arguments' : 'sandbox lane failed'}`);
}
