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
  const { discussion, briefing, ...grant } = JSON.parse(await readFile(grantPath, 'utf8')); await rm(grantPath, { force: true });
  const lane = new URL(`/lanes/${agent}/${name}`, base), headers = { authorization: `Bearer ${token}` };
  const who = name.split('-').at(-2);
  // DEMO_LANE_MODEL (set per lane by the harness) picks a Workers AI model for opencode lanes.
  const lane_model = process.env.DEMO_LANE_MODEL;
  const model = !lane_model ? undefined : agent === 'opencode' ? `cloudflare-workers-ai/${lane_model}` : agent === 'claude' ? lane_model : undefined;
  // Heddle's briefing of earlier decisions leads the prompt, so the agent starts from recorded intent.
  const context = briefing?.annotations?.length ? `## Context from earlier decisions (Heddle briefing ${String(briefing.hash).slice(0, 12)})\n\n` +
    `People recorded these notes when they decided earlier work on this code. Treat them as part of your task: follow their guidance, including any follow-up they ask the next change to make, and say in your closing message what you did about each.\n\n` +
    briefing.annotations.map(a => `- ${a.target}${a.scope && a.scope !== 'file' ? ` (${a.scope})` : ''}, ${a.kind} by ${a.attribution}: ${a.content}`).join('\n') + '\n\n' : '';
  const body = JSON.stringify({ grant, prompt: context + await readFile(briefPath, 'utf8'), author: { name: who, email: `${who}@heddle-artifacts.local` }, ...(model ? { model } : {}), ...(discussion ? { discussion } : {}) });
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
  // DEMO_LANE_MINUTES gives longer work (a real repository's task) more time; 40 minutes by default, at most 110.
  const minutes = Math.min(110, Math.max(1, Number(process.env.DEMO_LANE_MINUTES) || 40));
  for (const deadline = Date.now() + minutes * 60 * 1000; Date.now() < deadline;) {
    await new Promise(r => setTimeout(r, 10000));
    let status;
    try { status = await (await fetch(lane, { headers, signal: AbortSignal.timeout(30000) })).json(); } catch { continue; }
    if (status.state !== last) { console.log(`${who}: ${status.state}`); last = status.state; }
    if (status.state === 'succeeded') { await finish(0, `${who}: agent finished`); process.exit(); }
    if (['failed', 'lost'].includes(status.state)) { await finish(1, `${who}: agent ${status.state}`); process.exit(); }
  }
  await finish(1, `${who}: timed out after ${minutes} minutes`);
} catch (error) {
  // Messages here come from this script's own checks or fetch/fs errors; none carry the grant or bearer.
  await finish(1, `${name ?? 'lane'}: sandbox lane failed: ${error.message === 'usage' ? 'invalid arguments' : String(error.message).slice(0, 160)}`);
}
