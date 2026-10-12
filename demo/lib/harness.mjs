// SPDX-License-Identifier: Apache-2.0
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request, command, joinProject, enrollment, projectURL, identifier, gitAuth, remoteURL } from '../../cli/ha.mjs';
const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pause = ms => new Promise(r => setTimeout(r, ms));
const tasks = [
  { slug: 'parser-escapes', intent: 'Support escaped pipes (\\|) inside table cells while preserving the string[] API and backslash parity.' },
  { slug: 'docs-readme', intent: 'Document the table parser API with runnable examples; change only README.md.' },
];
export function options(args) {
  const opts = { url: process.env.DEMO_URL ?? 'http://localhost:8787', project: process.env.DEMO_PROJECT ?? 'demo',
    directory: process.env.DEMO_DIR ?? join(process.env.TMPDIR ?? '/tmp', 'heddle-demo'), mode: 'scripted',
    timeout: '180', delay: '8' };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    if (!['--url', '--project', '--dir', '--mode', '--timeout', '--delay'].includes(key) || !args[i + 1]) throw new Error('Invalid harness options');
    opts[key === '--dir' ? 'directory' : key.slice(2)] = args[i + 1];
  }
  identifier(opts.project);
  const parsed = new URL(opts.url);
  if (parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) throw new Error('--url must be a server origin');
  opts.projectUrl = `${parsed.origin}/p/${opts.project}`;
  opts.api = projectURL(opts.projectUrl).api;
  opts.directory = resolve(opts.directory);
  opts.timeout = Number(opts.timeout); opts.delay = Number(opts.delay);
  if (!['scripted', 'live'].includes(opts.mode) || !Number.isFinite(opts.timeout) || opts.timeout < 1 ||
      !Number.isFinite(opts.delay) || opts.delay < 0) throw new Error('Invalid mode, timeout or delay');
  return opts;
}
async function saved(opts) {
  try { const data = JSON.parse(await readFile(join(opts.directory, '.demo.json'), 'utf8'));
    if (data.api !== opts.api) throw new Error('Demo directory belongs to another project'); return data;
  } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
async function initialize(opts) {
  const token = process.env.OPERATOR_TOKEN;
  if (!token) throw new Error('Set OPERATOR_TOKEN');
  await mkdir(opts.directory, { recursive: true, mode: 0o700 });
  const existing = await saved(opts);
  if (existing) return existing;
  const project = await request(`${new URL(opts.url).origin}/api/projects`, token,
    { id: opts.project, seed: { template: 'demo' } });
  remoteURL(project.canonicalRemote, opts.api);
  const state = { ...project, api: opts.api, clones: {}, generation: Date.now() };
  // Persist immediately so an interrupted initialization can be cleaned up.
  await writeFile(join(opts.directory, '.demo.json'), JSON.stringify(state), { mode: 0o600 });
  await chmod(join(opts.directory, '.demo.json'), 0o600);
  for (const task of tasks) await request(`${opts.api}/tasks`, token, task);
  await request(`${opts.api}/humans`, token, { id: 'luke', displayName: 'Luke' });
  await request(`${opts.api}/tasks/parser-escapes/agents`, token,
    { id: 'reviewer', kind: 'reviewer', displayName: 'Reviewer', provider: 'workers-ai', model: '@cf/qwen/qwen2.5-coder-32b-instruct' });
  return state;
}
async function reset(opts) {
  // §7.2 deliberately has no DELETE. The owner provides the platform cleanup program.
  // It must revoke tokens/subscriptions, remove forks, clear the DO/R2 state, and canonical repo.
  if (!process.env.DEMO_RESET_COMMAND) throw new Error('Reset needs DEMO_RESET_COMMAND: §7.2 has no project deletion route. See demo/README.md.');
  await command('sh', ['-eu', '-c', process.env.DEMO_RESET_COMMAND], {
    env: { DEMO_PROJECT: opts.project, DEMO_URL: opts.url }, timeout: 90000,
  });
  await mkdir(opts.directory, { recursive: true, mode: 0o700 });
  // Keep old clones addressable; each reset gets a fresh generation directory.
  const { unlink } = await import('node:fs/promises');
  try { await unlink(join(opts.directory, '.demo.json')); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  await initialize(opts);
  console.log(`Reset ${opts.project}: cleanup completed and project recreated.`);
}
export function assertCandidates(parser, docs) {
  for (const [task, agents] of [[parser, ['alice', 'bob']], [docs, ['carol']]]) {
    for (const agent of agents) {
      const c = task.candidates.find(c => c.agent === agent);
      if (!c || !c.sourceSha || !c.signedBy || !c.tests) throw new Error(`Missing signed/tested candidate: ${agent}`);
    }
  }
  const alice = parser.candidates.find(c => c.agent === 'alice'), bob = parser.candidates.find(c => c.agent === 'bob');
  if (!alice.conflicts.some(c => c.path === 'src/table.ts' && c.with.includes('bob')) ||
      !bob.conflicts.some(c => c.path === 'src/table.ts' && c.with.includes('alice'))) throw new Error('Parser candidates must conflict on src/table.ts:parseRow');
  if (bob.tests.status !== 'pass') throw new Error('Bob tests must pass before the scripted decision');
  if (docs.candidates.find(c => c.agent === 'carol').conflicts.length) throw new Error('Carol must remain an independent clean candidate');
  if (docs.candidates.find(c => c.agent === 'carol').tests.status !== 'pass') throw new Error('Carol tests must pass');
}
async function waitFor(opts, predicate, message) {
  const end = Date.now() + opts.timeout * 1000;
  do { const result = await predicate(); if (result) return result; await pause(1000); } while (Date.now() < end);
  throw new Error(`Timed out: ${message}`);
}
async function views(opts) {
  return Promise.all(tasks.map(t => request(`${opts.api}/tasks/${t.slug}`, process.env.OPERATOR_TOKEN)));
}
function quote(value) { return "'" + value.replaceAll("'", "'\\''") + "'"; }
// DEMO_LIVE_PROVIDERS / DEMO_LIVE_MODELS ("alice=codex,bob=claude") override the
// shared DEMO_LIVE_PROVIDER / DEMO_LIVE_MODEL per agent, so lanes can mix vendors.
// cf-* lanes run their agent in a Cloudflare Sandbox through agent-runner/ (DEMO_RUNNER_URL).
export const LIVE_PROVIDERS = ['codex', 'claude', 'cf-codex', 'cf-claude'];
export function liveAgents(env = process.env) {
  const pairs = (value, name) => {
    const map = new Map();
    for (const item of (value ?? '').split(',').map(s => s.trim()).filter(Boolean)) {
      const [agent, setting, extra] = item.split('=');
      if (!['alice', 'bob', 'carol'].includes(agent) || !setting || extra !== undefined || map.has(agent)) throw new Error(`${name} must be agent=value pairs for alice, bob or carol`);
      map.set(agent, setting);
    }
    return map;
  };
  const providers = pairs(env.DEMO_LIVE_PROVIDERS, 'DEMO_LIVE_PROVIDERS'), models = pairs(env.DEMO_LIVE_MODELS, 'DEMO_LIVE_MODELS');
  return Object.fromEntries(['alice', 'bob', 'carol'].map(agent => {
    const provider = providers.get(agent) ?? env.DEMO_LIVE_PROVIDER ?? 'codex';
    if (!LIVE_PROVIDERS.includes(provider)) throw new Error(`Live providers must be one of ${LIVE_PROVIDERS.join(', ')}`);
    return [agent, { provider, model: models.get(agent) ?? env.DEMO_LIVE_MODEL }];
  }));
}
async function launchLive(opts, state) {
  const agents = liveAgents(), executables = {};
  for (const provider of new Set(Object.values(agents).map(a => a.provider).filter(p => !p.startsWith('cf-')))) {
    await command(provider, ['--version']);
    executables[provider] = await command('sh', ['-c', `command -v ${provider}`]);
  }
  const session = `heddle-${opts.project}-${state.generation}`;
  await command('tmux', ['new-session', '-d', '-s', session, '-x', '180', '-y', '40', '-c', state.clones.alice]);
  await command('tmux', ['set-option', '-t', session, 'remain-on-exit', 'on']);
  for (const [index, agent] of ['alice', 'bob', 'carol'].entries()) {
    const brief = join(demoRoot, 'briefs', `${agent}.md`);
    const marker = join(opts.directory, `${state.generation}-${agent}.exit`);
    const launcher = join(opts.directory, `${state.generation}-${agent}.sh`);
    // The operator bearer is cleared. Git auth is only in this clone's scoped headers.
    // Raw agent output stays off the recording terminal. No token-bearing config dumps.
    const { provider, model } = agents[agent], executable = executables[provider];
    if (provider.startsWith('cf-')) {
      // The lane's Git grant sits in a 0600 file the pane script reads once and deletes; only paths appear here.
      const script = join(demoRoot, 'lib', 'sandbox-lane.mjs');
      await writeFile(launcher, `#!/usr/bin/env bash\n# SPDX-License-Identifier: Apache-2.0\nunset OPERATOR_TOKEN\nexec node ${quote(script)} ${quote(provider.slice(3))} ${quote(`${opts.project}-${agent}-${state.generation}`)} ${quote(state.grants[agent])} ${quote(brief)} ${quote(marker)}\n`, { mode: 0o700 });
    } else {
    const modelFlag = model ? ` --model ${quote(model)}` : '';
    const invocation = provider === 'codex' ? `${quote(executable)} exec --sandbox workspace-write --ephemeral -c sandbox_workspace_write.network_access=true${modelFlag} - < ${quote(brief)}` :
      `${quote(executable)} --print --permission-mode acceptEdits --allowedTools ${quote('Read,Edit,Write,Bash(git:*),Bash(npm:*)')}${modelFlag} < ${quote(brief)}`;
    await writeFile(launcher, `#!/usr/bin/env bash\n# SPDX-License-Identifier: Apache-2.0\ncd ${quote(state.clones[agent])}\nexport npm_config_cache=${quote(join(state.clones[agent], '.git/npm-cache'))}\nunset OPERATOR_TOKEN\nprintf '%s\\n' ${quote(`${agent}: coding agent started`)}\n${invocation} >/dev/null 2>&1\nresult=$?\nprintf '%s' "$result" > ${quote(marker)}\nprintf '%s\\n' ${quote(`${agent}: coding agent finished; inspect the board`)}\nexit "$result"\n`, { mode: 0o700 });
    }
    if (index === 0) await command('tmux', ['respawn-pane', '-k', '-t', `${session}:0.0`, '-c', state.clones[agent], 'bash', launcher]);
    else await command('tmux', ['split-window', '-t', session, '-c', state.clones[agent], 'bash', launcher]);
    await command('tmux', ['select-layout', '-t', session, 'even-horizontal']);
  }
  console.log(`Live agents launched concurrently. Record with: tmux attach -t ${session}`);
  return { session, providers: Object.fromEntries(Object.entries(agents).map(([agent, a]) => [agent, a.provider])) };
}
async function run(opts) {
  const start = Date.now();
  const state = await initialize(opts);
  const runDir = join(opts.directory, String(state.generation));
  state.grants = {};
  for (const agent of ['alice', 'bob', 'carol']) {
    const lane = opts.mode === 'scripted' ? undefined : liveAgents()[agent];
    if (lane?.provider.startsWith('cf-')) {
      // Sandbox lanes keep no local clone: the runner clones the fork inside the sandbox.
      const directory = join(runDir, agent), grant = join(opts.directory, `${state.generation}-${agent}.grant.json`);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const joined = await enrollment(opts.projectUrl, { task: agent === 'carol' ? 'docs-readme' : 'parser-escapes', as: agent,
        provider: `cloudflare-sandbox/${lane.provider.slice(3)}`, model: lane.model ?? 'runner-default' });
      await writeFile(grant, JSON.stringify({ forkRemote: joined.fork.remote, forkToken: joined.fork.token,
        upstreamRemote: joined.upstream.remote, upstreamToken: joined.upstream.readToken }), { mode: 0o600 });
      state.clones[agent] = directory; state.grants[agent] = grant;
      continue;
    }
    const joined = await joinProject(opts.projectUrl, {
      task: agent === 'carol' ? 'docs-readme' : 'parser-escapes', as: agent,
      directory: join(runDir, agent), provider: opts.mode === 'scripted' ? 'scripted-git' : liveAgents()[agent].provider,
      model: opts.mode === 'scripted' ? 'prepared-v1' : liveAgents()[agent].model ?? 'cli-default',
    });
    state.clones[agent] = joined.cwd;
  }
  await writeFile(join(opts.directory, '.demo.json'), JSON.stringify(state), { mode: 0o600 });
  console.log('Three agents enrolled in independent forks.');
  let live;
  if (opts.mode === 'scripted') {
    const results = await Promise.all(['alice', 'bob', 'carol'].map(agent =>
      command('bash', [join(demoRoot, 'scripted-agents/run.sh'), agent, state.clones[agent], String(opts.delay)],
        { env: { OPERATOR_TOKEN: '' }, timeout: (opts.delay + 60) * 1000 })));
    for (const output of results) console.log(output);
  } else live = await launchLive(opts, state);
  let [parser, docs] = await waitFor(opts, async () => {
    let finished = true;
    if (live) for (const agent of ['alice', 'bob', 'carol']) {
      try {
        const code = await readFile(join(opts.directory, `${state.generation}-${agent}.exit`), 'utf8');
        if (code.trim() !== '0') throw new Error(`${agent}: live coding agent failed (exit ${code.trim()}); use the R7 scripted fallback`);
      } catch (error) { if (error.code !== 'ENOENT') throw error; finished = false; }
    }
    if (!finished) return undefined;
    const data = await views(opts);
    return data[0].candidates.some(c => c.agent === 'alice') && data[0].candidates.some(c => c.agent === 'bob') &&
      data[1].candidates.some(c => c.agent === 'carol') &&
      data[0].candidates.filter(c => ['alice', 'bob'].includes(c.agent)).every(c => c.tests) &&
      data[1].candidates.find(c => c.agent === 'carol')?.tests ? data : undefined;
  }, 'three tested candidates');
  assertCandidates(parser, docs);
  const pushed = {};
  for (const agent of ['alice', 'bob', 'carol']) pushed[agent] = await command('git', ['rev-parse', 'HEAD'], { cwd: state.clones[agent] });
  for (const candidate of [...parser.candidates, ...docs.candidates]) {
    if (pushed[candidate.agent] && candidate.sourceSha !== pushed[candidate.agent]) throw new Error('Candidate differs from agent pushed SHA');
  }
  parser = await waitFor(opts, async () => {
    const view = await request(`${opts.api}/tasks/parser-escapes`, process.env.OPERATOR_TOKEN);
    return view.review && view.turns.some(t => t.kind === 'reviewer' && t.signedBy) ? view : undefined;
  }, 'signed reviewer discussion');
  console.log(`Conflict candidates ready; independent docs clean. Reviewer: ${parser.review.model}`);
  await request(`${opts.api}/tasks/parser-escapes/turns`, process.env.OPERATOR_TOKEN,
    { body: 'Preserving the API and slash parity matters more than the shorter regex. I agree with choosing Bob.', as: 'luke' });
  // Refresh immediately before deciding; never auto-retry a stale decision.
  parser = await request(`${opts.api}/tasks/parser-escapes`, process.env.OPERATOR_TOKEN);
  const decision = await request(`${opts.api}/tasks/parser-escapes/decision`, process.env.OPERATOR_TOKEN,
    { pick: 'bob', rationale: 'Bob preserves string[] and handles escaped pipes and backslash parity; Alice remains a recorded alternative.',
      decider: 'luke', expectHeads: parser.heads });
  if (!/^[a-f0-9]{40,64}$/.test(decision.mainSha ?? '')) throw new Error('Decision has no published main SHA');
  const proof = join(runDir, 'proof');
  const env = gitAuth([[state.canonicalRemote, state.readToken]]);
  await command('git', ['clone', '--quiet', state.canonicalRemote, proof], { env });
  await command('git', ['fetch', '--quiet', 'origin', '+refs/notes/*:refs/notes/*'], { cwd: proof, env });
  const main = await command('git', ['rev-parse', 'main'], { cwd: proof });
  if (main !== decision.mainSha) throw new Error('Canonical main differs from the decision SHA');
  for (const [agent, task] of [['alice', 'parser-escapes'], ['bob', 'parser-escapes'], ['carol', 'docs-readme']]) {
    const sha = await command('git', ['rev-parse', `origin/candidates/${task}/${agent}`], { cwd: proof });
    if (sha !== pushed[agent]) throw new Error(`Original candidate SHA changed: ${agent}`);
  }
  const mainTree = await command('git', ['rev-parse', 'main^{tree}'], { cwd: proof });
  const chosenTree = await command('git', ['rev-parse', 'origin/candidates/parser-escapes/bob^{tree}'], { cwd: proof });
  if (mainTree !== chosenTree) throw new Error('Landed tree differs from chosen candidate');
  await command('git', ['fsck', '--strict'], { cwd: proof });
  await command('git', ['repack', '-ad'], { cwd: proof });
  const { readdir } = await import('node:fs/promises');
  for (const file of await readdir(join(proof, '.git/objects/pack'))) {
    if (file.endsWith('.pack')) await command('git', ['index-pack', '--strict', join(proof, '.git/objects/pack', file)], { cwd: proof });
  }
  const log = await command('git', ['log', "--notes=heddle*", '-1', 'main'], { cwd: proof });
  if (!/Chosen:\s*bob/.test(log) || !/Rejected:\s*alice/.test(log)) throw new Error('Git log lost chosen/rejected narrative');
  if (!/Heddle-State:/.test(log) || !/Heddle-Change:/.test(log)) throw new Error('Git log lost Heddle trailers');
  console.log(log);
  const why = await request(`${opts.api}/why/${main}`);
  if (!why.narrative.includes('bob') || !why.narrative.includes('alice')) throw new Error('Why API lost alternatives');
  const seconds = (Date.now() - start) / 1000;
  if (opts.mode === 'scripted' && seconds >= 240) throw new Error(`Storyline exceeded 4 minutes (${seconds.toFixed(1)}s)`);
  await writeFile(join(runDir, 'result.json'), JSON.stringify({ mode: opts.mode, seconds, main, mainTree, chosenTree, pushed,
    reviewModel: parser.review.model, live, checks: ['exact candidates', 'tree equality', 'fsck', 'index-pack', 'notes/trailers', 'why'] }, null, 2) + '\n');
  console.log(`PASS ${opts.mode}: full storyline in ${seconds.toFixed(1)}s; candidates exact; tree match; fsck/index-pack strict; why retained.`);
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [action, ...args] = process.argv.slice(2);
  Promise.resolve().then(() => { const opts = options(args);
    if (action === 'reset') return reset(opts); if (action === 'run') return run(opts); throw new Error('Expected run or reset');
  }).catch(error => { console.error(`demo: ${error.message}`); process.exitCode = 1; });
}
