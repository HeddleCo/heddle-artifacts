// SPDX-License-Identifier: Apache-2.0
// One live lane whose coding agent runs in a Cloudflare Sandbox (agent-runner/).
// Usage: node sandbox-lane.mjs <codex|claude|opencode> <lane-name> <grant.json> <brief.md> <exit-marker>
// Env: DEMO_RUNNER_URL, and DEMO_RUNNER_TOKEN_FILE (a 0600 file holding the runner bearer).
import { readFile, rm, writeFile } from 'node:fs/promises';

const [agent, name, grantPath, briefPath, marker] = process.argv.slice(2);
const finish = async (code, line) => { console.log(line); await writeFile(marker, String(code)); };
try {
  if (!['codex', 'claude', 'opencode'].includes(agent) || !/^[a-z0-9][a-z0-9-]{0,62}$/.test(name ?? '')) throw new Error('usage');
  const base = new URL(process.env.DEMO_RUNNER_URL ?? '');
  if (base.protocol !== 'https:' || base.pathname !== '/') throw new Error('DEMO_RUNNER_URL must be an https origin');
  const token = (await readFile(process.env.DEMO_RUNNER_TOKEN_FILE ?? '', 'utf8')).trim();
  // Read the lane grant once, then remove it from disk; it travels only to the runner Worker.
  const grant = JSON.parse(await readFile(grantPath, 'utf8')); await rm(grantPath, { force: true });
  const lane = new URL(`/lanes/${agent}/${name}`, base), headers = { authorization: `Bearer ${token}` };
  const who = name.split('-').at(-2);
  // DEMO_LANE_MODEL (set per lane by the harness) picks a Workers AI model for opencode lanes.
  const model = process.env.DEMO_LANE_MODEL ? `cloudflare-workers-ai/${process.env.DEMO_LANE_MODEL}` : undefined;
  const body = JSON.stringify({ grant, prompt: await readFile(briefPath, 'utf8'), author: { name: who, email: `${who}@heddle-artifacts.local` }, ...(agent === 'opencode' && model ? { model } : {}) });
  // A sandbox image's first start in a location can fail while it provisions; retry that, nothing else.
  let started;
  for (let attempt = 1; attempt <= 3; attempt++) {
    started = await fetch(lane, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(300000) });
    if (started.status !== 500) break;
    console.log(`${who}: sandbox still starting (attempt ${attempt}), retrying`); await new Promise(r => setTimeout(r, 15000));
  }
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
  // Messages here come from this script's own checks or fetch/fs errors; none carry the grant or bearer.
  await finish(1, `${name ?? 'lane'}: sandbox lane failed: ${error.message === 'usage' ? 'invalid arguments' : String(error.message).slice(0, 160)}`);
}
