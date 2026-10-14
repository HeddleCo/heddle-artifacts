// SPDX-License-Identifier: Apache-2.0
// `up cloudflare`: deploy this app to YOUR Cloudflare account with one command, then drive it from the UI.
//   node cli/up.mjs cloudflare --name my-app [--domain demo.example.com] [--public-project NAME] [--yes] [--dry-run]
//   node cli/up.mjs cloudflare --name my-app --destroy [--yes]      removes exactly what `up` created
// It wraps docs/DEPLOY.md: creates the R2 bucket and Queue (safe to re-run), writes a git-ignored Worker config, generates an
// operator token (kept in a 0600 file, never on a command line), builds the UI, deploys, and waits for the Worker to answer.
import { spawn } from 'node:child_process';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';

const SLUG = /^[a-z0-9](?:[a-z0-9]|-(?!-)){0,49}$/;
const DOMAIN = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;
const NAMESPACE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

export function parseCloudflareArgs(argv) {
  const o = { name: undefined, namespace: undefined, domain: undefined, publicProject: undefined, account: undefined, state: join(homedir(), '.heddle-artifacts', 'cloudflare'), yes: false, dryRun: false, destroy: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i], next = () => { if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    if (a === '--name') o.name = next(); else if (a === '--namespace') o.namespace = next(); else if (a === '--domain') o.domain = next();
    else if (a === '--public-project') o.publicProject = next(); else if (a === '--account') o.account = next(); else if (a === '--state') o.state = resolve(next());
    else if (a === '--yes') o.yes = true; else if (a === '--dry-run') o.dryRun = true; else if (a === '--destroy') o.destroy = true;
    else throw new Error(`Unknown option ${a}`);
  }
  if (!o.name) throw new Error('--name is required: the Worker name, which also names the bucket, queue and namespace (for example --name my-app)');
  if (!SLUG.test(o.name)) throw new Error('The name must be lowercase letters, digits and single hyphens, up to 50 characters.');
  o.namespace ??= o.name;
  if (!NAMESPACE.test(o.namespace)) throw new Error('The namespace must start with a letter or digit and use letters, digits, . _ or -.');
  if (o.domain !== undefined && !DOMAIN.test(o.domain)) throw new Error('--domain must be a bare host name such as demo.example.com (no https://, no path).');
  if (o.publicProject !== undefined && !SLUG.test(o.publicProject)) throw new Error('--public-project must be a project name: lowercase letters, digits and single hyphens.');
  return o;
}

/** The Worker config for a fresh account. Mirrors wrangler.example.jsonc (a test compares them); no secrets, and never the live account's pinned engine image. */
export function cloudflareConfig({ name, accountId, queueId, namespace, domain, publicProject }) {
  return {
    name, account_id: accountId, main: 'worker/index.ts', compatibility_date: '2026-10-10', compatibility_flags: ['nodejs_compat'],
    alias: { 'heddle-reviewer': './reviewer/reviewer.ts' },
    artifacts: [{ binding: 'ARTIFACTS', namespace }],
    durable_objects: { bindings: [{ name: 'PROJECT', class_name: 'ProjectDO' }, { name: 'ENGINE', class_name: 'HeddleEngine' }, { name: 'TEST_SANDBOX', class_name: 'CandidateTestSandbox' }] },
    migrations: [{ tag: 'v1', new_sqlite_classes: ['ProjectDO', 'HeddleEngine'] }, { tag: 'v2-isolated-candidate-tests', new_sqlite_classes: ['CandidateTestSandbox'] }],
    containers: [{ class_name: 'HeddleEngine', image: './engine/Dockerfile', image_build_context: '.', instance_type: 'standard-1', max_instances: 10 },
      { class_name: 'CandidateTestSandbox', image: './sandbox/Dockerfile', image_build_context: './sandbox', instance_type: 'standard-4', max_instances: 3 }],
    queues: { producers: [{ binding: 'EVENTS', queue: `${name}-events` }], consumers: [{ queue: `${name}-events`, max_batch_size: 100, max_batch_timeout: 1, max_retries: 3 }] },
    r2_buckets: [{ binding: 'STATE', bucket_name: `${name}-state` }],
    ai: { binding: 'AI' },
    assets: { directory: './ui/dist', binding: 'ASSETS', not_found_handling: 'single-page-application', run_worker_first: ['/api/*', '/login', '/__dev/*'] },
    // A project stays open for work this long after creation (the maximum the Worker allows), so your own projects do not lapse in an hour.
    vars: { ARTIFACTS_NAMESPACE: namespace, CF_ACCOUNT_ID: accountId, EVENTS_QUEUE_ID: queueId, ACTOR_EMAIL_DOMAIN: 'noreply.heddle.sh', DEMO_CREDENTIAL_TTL_SECONDS: '14400', ...(publicProject ? { DEMO_PROJECT: publicProject } : {}) },
    workers_dev: true, preview_urls: false, observability: { enabled: true },
    ...(domain ? { routes: [{ pattern: domain, custom_domain: true }] } : {}),
  };
}

const wrangler = (...args) => ['npx', 'wrangler', ...args];
const names = name => ({ bucket: `${name}-state`, queue: `${name}-events`, config: `wrangler.live.up-${name}.json`, containers: [`${name}-heddleengine`, `${name}-candidatetestsandbox`] });

async function readJson(path) { try { return JSON.parse(await readFile(path, 'utf8')); } catch { return undefined; } }

/** Everything that must be true before anything is created. */
async function checkPrerequisites(options, deps) {
  const problems = []; let account;
  if (Number(deps.nodeVersion.split('.')[0]) < 22) problems.push(`Node 22 or newer (you have ${deps.nodeVersion}).`);
  for (const [path, fix] of [['node_modules/wrangler/bin/wrangler.js', 'npm ci'], ['ui/node_modules', 'npm ci --prefix ui']]) if (!(await deps.exists(join(deps.repo, path)))) problems.push(`Dependencies are missing. Run: ${fix}`);
  const docker = await deps.run(['docker', 'info']);
  if (docker.code !== 0) problems.push('Docker is not running. The first deploy builds the engine and test-sandbox images locally, so Docker must be installed and running.');
  const who = await deps.run(wrangler('whoami', '--json'));
  let info; try { info = JSON.parse(who.output); } catch { /* handled below */ }
  if (who.code !== 0 || !info?.loggedIn) problems.push('You are not logged in to Cloudflare. Run: npx wrangler login');
  else {
    const accounts = info.accounts ?? [], wanted = options.account ? accounts.filter(a => a.id === options.account || a.name === options.account) : accounts;
    if (wanted.length === 1) account = wanted[0];
    else if (!wanted.length) problems.push(options.account ? `No account matches --account ${options.account}.` : 'Your login has no Cloudflare account.');
    else problems.push(`Your login can use ${wanted.length} accounts. Choose one with --account <id or name>: ${wanted.map(a => `${a.name} (${a.id})`).join(', ')}`);
  }
  return { problems, account };
}

function planLines(options, account) {
  const n = names(options.name);
  return [
    `This will deploy "${options.name}" to the Cloudflare account ${account.name} (${account.id}):`,
    `  - Worker ${options.name}${options.domain ? ` at https://${options.domain}` : ''} (also on workers.dev)`,
    `  - R2 bucket ${n.bucket}, Queue ${n.queue}, Artifacts namespace ${options.namespace} (created on first use)`,
    `  - Containers: the Heddle engine and the test sandbox, built on THIS machine with Docker`,
    '',
    '  The first deploy builds the engine from Heddle source and takes about 30 minutes. Later deploys are fast.',
    '  Needs the Workers Paid plan (Containers). Resources are billed to your account. Remove everything again with:',
    `    node cli/up.mjs cloudflare --name ${options.name} --destroy`,
    options.publicProject ? `  Project "${options.publicProject}" will be readable by anyone, as on the public demo.` : '  No project is public: visitors see nothing until you sign in with the operator token.',
  ];
}

async function ensureToken(dir) {
  const file = join(dir, 'operator-token');
  let token = (await readFile(file, 'utf8').catch(() => '')).trim();
  if (!/^[0-9a-f]{64}$/.test(token)) { token = randomBytes(32).toString('hex'); await writeFile(file, `${token}\n`, { mode: 0o600 }); }
  await chmod(file, 0o600);
  return { token, file };
}

export async function upCloudflare(options, deps) {
  if (options.destroy) return destroyCloudflare(options, deps);
  const { log } = deps, { problems, account } = await checkPrerequisites(options, deps);
  if (problems.length) { log('Cannot start yet:\n'); for (const p of problems) log(`  - ${p}`); return { code: 1 }; }
  for (const line of planLines(options, account)) log(line);
  if (options.dryRun) { log('\nDry run: nothing was created or changed.'); return { code: 0 }; }
  if (!options.yes && !(await deps.confirm('\nContinue? [y/N] '))) { log('Nothing was changed.'); return { code: 1 }; }

  const n = names(options.name), dir = join(options.state, options.name), env = { CLOUDFLARE_ACCOUNT_ID: account.id };
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const { token, file: tokenFile } = await ensureToken(dir);
  const recordFile = join(dir, 'created.json');
  const record = (await readJson(recordFile)) ?? { name: options.name, accountId: account.id, namespace: options.namespace, config: n.config, bucket: false, queue: false, worker: false };
  const save = () => writeFile(recordFile, JSON.stringify(record, null, 1), { mode: 0o600 });
  await save();
  const exec = (argv, extra = {}) => deps.run(argv, { cwd: deps.repo, env, ...extra });

  const bucket = await exec(wrangler('r2', 'bucket', 'create', n.bucket));
  if (bucket.code === 0) record.bucket = true; else if (!/already exists/i.test(bucket.output)) { log(`Could not create the R2 bucket ${n.bucket}:\n${bucket.output}`); return { code: 1 }; }
  const queue = await exec(wrangler('queues', 'create', n.queue));
  if (queue.code === 0) record.queue = true; else if (!/already exists/i.test(queue.output)) { log(`Could not create the Queue ${n.queue}:\n${queue.output}`); return { code: 1 }; }
  await save();
  const info = await exec(wrangler('queues', 'info', n.queue)), queueId = /Queue ID:\s*([0-9a-f]{32})/i.exec(info.output)?.[1];
  if (info.code !== 0 || !queueId) { log(`Could not read the Queue ID for ${n.queue}.`); return { code: 1 }; }

  log('\nBuilding the UI…');
  if ((await exec(['npm', 'run', 'build', '--prefix', 'ui'])).code !== 0) { log('The UI build failed. Run `npm run build` to see why.'); return { code: 1 }; }
  const configPath = join(deps.repo, n.config);
  await writeFile(configPath, JSON.stringify(cloudflareConfig({ name: options.name, accountId: account.id, queueId, namespace: options.namespace, domain: options.domain, publicProject: options.publicProject }), null, 2), { mode: 0o600 });

  log('\nDeploying. The first deploy builds the engine image (about 30 minutes); output follows.\n');
  const secrets = join(dir, `.secrets-${randomBytes(6).toString('hex')}.json`);
  await writeFile(secrets, JSON.stringify({ OPERATOR_TOKEN: token }), { mode: 0o600 });
  let deploy;
  try { deploy = await exec(wrangler('deploy', '--config', configPath, '--secrets-file', secrets), { stream: true, logFile: join(dir, 'deploy.log') }); }
  finally { await rm(secrets, { force: true }); }
  record.worker = deploy.code === 0 || record.worker; await save();
  if (deploy.code !== 0) { log(`\nThe deploy failed (full output: ${join(dir, 'deploy.log')}). Fix the problem and run the same command again; it is safe to repeat.`); return { code: 1 }; }

  const url = options.domain ? `https://${options.domain}` : /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(deploy.output)?.[0];
  const workersDev = /https:\/\/[a-z0-9.-]+\.workers\.dev/i.exec(deploy.output)?.[0] ?? url;
  if (!url) { log('\nDeployed, but the Worker address was not in the output. Check the Cloudflare dashboard.'); return { code: 1 }; }
  log(`\nWaiting for ${url} to answer…`);
  let up = false;
  for (let i = 0; i < 30 && !up; i++) { try { up = (await deps.fetch(`${url}/login`)).ok; } catch { up = false; } if (!up) await deps.sleep(4000); }
  if (!up) { log(`\nThe Worker did not answer at ${url} (also ${workersDev}). A new custom domain can take a few minutes for DNS and its certificate; try again shortly. Nothing was rolled back.`); return { code: 1 }; }

  log(`\nHeddle Artifacts is running on your Cloudflare account.\n\n  Open        ${url}\n  Sign in     with the operator token in ${tokenFile}\n              (print it with: cat "${tokenFile}")\n  Remove      node cli/up.mjs cloudflare --name ${options.name} --destroy\n`);
  log('Next: in the app, create a project (optionally from a public repository), add a task, then give your own agent the `ha join …` command it shows.\nThe first request to a new project starts its engine container (10 to 60 seconds). Candidate tests run in a keyless Sandbox.');
  return { code: 0, url, tokenFile };
}

/** Removes exactly what `up cloudflare` recorded for this name; refuses anything it did not create. */
export async function destroyCloudflare(options, deps) {
  const { log } = deps, dir = join(options.state, options.name), record = await readJson(join(dir, 'created.json'));
  if (!record || record.name !== options.name) { log(`This command did not create "${options.name}" on this machine (no record in ${dir}), so nothing is removed.`); return { code: 1 }; }
  const n = names(options.name);
  const list = [`Worker ${options.name}`, `its containers (${n.containers.join(', ')})`, record.bucket && `R2 bucket ${n.bucket}`, record.queue && `Queue ${n.queue}`, 'the local operator token and config'].filter(Boolean);
  log(`This removes ${list.join(', ')}.\nArtifacts repositories in namespace ${record.namespace} are not removed by this command.`);
  if (!options.yes && !(await deps.confirm('\nRemove them? [y/N] '))) { log('Nothing was changed.'); return { code: 1 }; }
  const env = { CLOUDFLARE_ACCOUNT_ID: record.accountId }, exec = argv => deps.run(argv, { cwd: deps.repo, env }), left = [];
  const gone = (r, what) => { if (r.code !== 0 && !/not found|does not exist|10007|10006/i.test(r.output)) left.push(`${what}: ${r.output.trim().split('\n').pop()}`); };
  gone(await exec(wrangler('delete', options.name)), `Worker ${options.name}`);
  const apps = await exec(wrangler('containers', 'list'));
  for (const row of apps.output.split('\n')) { const cells = row.split('│').map(c => c.trim()); if (cells.length > 2 && n.containers.includes(cells[2])) gone(await exec(wrangler('containers', 'delete', cells[1])), `container ${cells[2]}`); }
  if (record.queue) gone(await exec(wrangler('queues', 'delete', n.queue)), `Queue ${n.queue}`);
  if (record.bucket) gone(await exec(wrangler('r2', 'bucket', 'delete', n.bucket)), `R2 bucket ${n.bucket} (a bucket must be empty to be deleted)`);
  await rm(join(deps.repo, n.config), { force: true });
  if (left.length) { log(`\nRemoved most of it. Left in place:\n${left.map(l => `  - ${l}`).join('\n')}\nFix those in the Cloudflare dashboard, or re-run this command. The local record was kept.`); return { code: 1 }; }
  await rm(dir, { recursive: true, force: true });
  log('\nRemoved.'); return { code: 0 };
}

/** The real thing: spawn, optionally stream to the terminal and a log file, always capture. */
export function realDeps(repo) {
  const run = (argv, { cwd = repo, env = {}, stream = false, logFile } = {}) => new Promise(resolveRun => {
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env, WRANGLER_SEND_METRICS: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const chunks = []; let out = logFile ? rm(logFile, { force: true }).then(() => writeFile(logFile, '', { mode: 0o600 })) : Promise.resolve();
    const take = chunk => { chunks.push(chunk); if (stream) process.stdout.write(chunk); };
    child.stdout.on('data', take); child.stderr.on('data', take);
    child.on('error', error => resolveRun({ code: 127, output: String(error.message) }));
    child.on('close', async code => { const output = Buffer.concat(chunks).toString('utf8'); if (logFile) { await out; await writeFile(logFile, output, { mode: 0o600 }); } resolveRun({ code: code ?? 1, output }); });
  });
  const confirm = async question => { if (!process.stdin.isTTY) return false; const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return /^y(es)?$/i.test((await rl.question(question)).trim()); } finally { rl.close(); } };
  const exists = async path => { try { await access(path); return true; } catch { return false; } };
  return { run, confirm, exists, fetch: (url) => fetch(url, { signal: AbortSignal.timeout(15000), redirect: 'manual' }), sleep: ms => new Promise(r => setTimeout(r, ms)), log: console.log, repo, nodeVersion: process.versions.node };
}
