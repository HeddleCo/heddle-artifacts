// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, stat, readFile } from 'node:fs/promises';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execFileAsync = promisify(execFile);
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { isolatedTestResult } from '../../engine/lib/isolated-tests.mjs';
import { runCandidateLocally, startLocalTestRunner } from '../local-test-runner.mjs';
import { startFakeArtifacts } from '../fake-artifacts/server.mjs';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' } }).trim();

/** A one-commit repo whose single test file is the given source. */
async function candidate(root, name, testSource) {
  const dir = join(root, name); await mkdir(dir, { recursive: true });
  git(dir, 'init', '--initial-branch=main');
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0', scripts: { test: 'node --test' } }));
  await writeFile(join(dir, 'a.test.mjs'), testSource);
  git(dir, 'add', '.'); git(dir, 'commit', '-m', 'candidate');
  return { remote: dir, sourceSha: git(dir, 'rev-parse', 'HEAD'), treeSha: git(dir, 'rev-parse', 'HEAD^{tree}') };
}
const input = (c, extra = {}) => ({ project: 'p', task: 't', agent: 'a', readCredential: 'secret-read-token-123', recipe: { setup: [], test: ['node', '--test'], budgetMs: 30000 }, ...c, ...extra });
const opts = root => ({ root: join(root, 'work'), allowFileRemotes: true });
const withRoot = async fn => { const root = await mkdtemp(join(tmpdir(), 'local-runner-')); try { await fn(root); } finally { await rm(root, { recursive: true, force: true }); } };

test('a passing candidate is actually executed and reports its own counts', () => withRoot(async root => {
  const c = await candidate(root, 'pass', "import test from 'node:test'; test('one', () => {}); test('two', () => {});");
  const run = await runCandidateLocally(input(c), opts(root));
  assert.equal(run.testExitCode, 0); assert.equal(run.local, true, 'the runner says what it is, so the board labels the result from it');
  assert.equal(run.sourceSha, c.sourceSha); assert.equal(run.treeSha, c.treeSha);
  assert.match(run.output, /^(?:#|ℹ) pass 2$/m); assert.match(run.output, /^(?:#|ℹ) fail 0$/m);
  const result = isolatedTestResult(run);
  assert.equal(result.status, 'pass', result.summary);
  assert.equal(result.summary, 'Local run (not isolated): 2 passed, 0 failed');
}));

test('a failing candidate is reported failing: the result comes from running it, not from a fixture', () => withRoot(async root => {
  const c = await candidate(root, 'fail', "import test from 'node:test'; import assert from 'node:assert'; test('ok', () => {}); test('broken', () => assert.equal(1, 2));");
  const run = await runCandidate(c, root);
  assert.notEqual(run.testExitCode, 0);
  assert.match(run.output, /^(?:#|ℹ) pass 1$/m); assert.match(run.output, /^(?:#|ℹ) fail 1$/m);
}));
const runCandidate = (c, root, extra) => runCandidateLocally(input(c, extra), opts(root));

test('only npm, npx and node may run; a shell is refused before anything executes', () => withRoot(async root => {
  const c = await candidate(root, 'shell', "import test from 'node:test'; test('x', () => {});");
  await assert.rejects(() => runCandidate(c, root, { recipe: { setup: [], test: ['sh', '-c', 'echo pwned > /tmp/should-not-exist'], budgetMs: 30000 } }), /recipe/i);
}));

test('a checkout that does not match the recorded tree is rejected', () => withRoot(async root => {
  const c = await candidate(root, 'tree', "import test from 'node:test'; test('x', () => {});");
  const run = await runCandidate({ ...c, treeSha: '0'.repeat(40) }, root);
  assert.equal(run.failure, 'checkout'); assert.equal(run.testExitCode, undefined);
}));

test('the time budget is enforced and the run is killed', () => withRoot(async root => {
  const c = await candidate(root, 'slow', "import test from 'node:test'; test('hang', () => new Promise(() => setTimeout(() => {}, 60000)));");
  const started = Date.now();
  const run = await runCandidate(c, root, { recipe: { setup: [], test: ['node', '--test'], budgetMs: 1500 } });
  assert.equal(run.failure, 'timeout'); assert.ok(Date.now() - started < 10000, 'returned well before the test would have finished');
}));

test('candidate code never sees the read credential, in its environment or its output', () => withRoot(async root => {
  const c = await candidate(root, 'env', "import test from 'node:test'; test('env', () => { console.log('ENV:' + JSON.stringify(process.env)); });");
  const run = await runCandidate(c, root);
  assert.ok(run.output.includes('ENV:'), 'the test really ran');
  assert.ok(!run.output.includes('secret-read-token-123'));
  assert.ok(!/OPERATOR_TOKEN|AUTHORIZATION/i.test(run.output));
}));

const SECRET = 'runner-secret-0123456789abcdef';
const post = (origin, body, secret = SECRET) => fetch(`${origin}/run`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-runner-secret': secret }, body: JSON.stringify(body) });

test('over a real http remote the read credential reaches git and never the candidate: fetch succeeds, and the candidate sees nothing of it', { timeout: 20000 }, () => withRoot(async root => {
  const fake = await startFakeArtifacts({ root: join(root, 'artifacts'), port: 0, eventUrl: 'http://127.0.0.1:1/ignored' });
  try {
    const c = await candidate(root, 'viahttp', "import test from 'node:test'; test('env', () => { console.log('ENV:' + JSON.stringify(process.env)); });");
    await fake.binding.create('cand'); const repo = await fake.binding.get('cand');
    const write = await repo.createToken('write', 600), read = await repo.createToken('read', 600);
    await execFileAsync('git', ['-c', `http.extraHeader=Authorization: Bearer ${write.plaintext}`, 'push', fake.binding.remote('cand'), 'HEAD:main'], { cwd: c.remote }); // async: the fake server lives in this process
    const run = await runCandidateLocally(input({ ...c, remote: fake.binding.remote('cand'), readCredential: read.plaintext }), { root: join(root, 'work') });
    assert.equal(run.failure, undefined, 'git could fetch with the credential, so it was really sent'); assert.equal(run.testExitCode, 0);
    assert.ok(run.output.includes('ENV:'), 'the candidate ran');
    assert.ok(!run.output.includes(read.plaintext) && !run.output.includes('art_v1_'), 'the credential is not in the candidate environment or output');
    assert.ok(!/GIT_CONFIG_(KEY|VALUE|COUNT)/.test(run.output), 'no git credential config leaks into the candidate environment');
    const denied = await runCandidateLocally(input({ ...c, remote: fake.binding.remote('cand'), readCredential: 'art_v1_wrong?expires=9999999999' }), { root: join(root, 'work') });
    assert.notEqual(denied.failure, undefined, 'a wrong credential is refused by the server, proving the header is what authorizes the fetch');
  } finally { await fake.close(); }
}));

test('more requests than slots are queued and all complete, never refused as errors, and never run more than `slots` at once', { timeout: 20000 }, () => withRoot(async root => {
  const sleepy = "import test from 'node:test'; test('t', async () => { console.log('S:' + Date.now()); await new Promise(r => setTimeout(r, 400)); console.log('E:' + Date.now()); });";
  const cs = []; for (const n of ['a', 'b', 'c']) cs.push(await candidate(root, `q${n}`, sleepy));
  const runner = await startLocalTestRunner({ root: join(root, 'work'), secret: SECRET, slots: 1, allowFileRemotes: true });
  try {
    const responses = await Promise.all(cs.map(c => post(runner.origin, input(c))));
    assert.deepEqual(responses.map(r => r.status), [200, 200, 200], 'nobody was turned away');
    const runs = await Promise.all(responses.map(r => r.json()));
    for (const r of runs) assert.equal(r.testExitCode, 0);
    const spans = runs.map(r => ({ s: Number(/S:(\d+)/.exec(r.output)[1]), e: Number(/E:(\d+)/.exec(r.output)[1]) })).sort((x, y) => x.s - y.s);
    for (let i = 1; i < spans.length; i++) assert.ok(spans[i].s >= spans[i - 1].e - 5, 'with one slot the runs do not overlap');
  } finally { await runner.close(); }
}));

test('a full queue says busy (429) instead of growing without limit', { timeout: 20000 }, () => withRoot(async root => {
  const sleepy = "import test from 'node:test'; test('t', async () => { await new Promise(r => setTimeout(r, 1500)); });";
  const cs = []; for (const n of ['a', 'b', 'c', 'd']) cs.push(await candidate(root, `f${n}`, sleepy));
  const runner = await startLocalTestRunner({ root: join(root, 'work'), secret: SECRET, slots: 1, maxQueue: 1, allowFileRemotes: true });
  try {
    const statuses = (await Promise.all(cs.map(c => post(runner.origin, input(c, { recipe: { setup: [], test: ['node', '--test'], budgetMs: 30000 } }))))).map(r => r.status).sort();
    assert.deepEqual(statuses, [200, 200, 429, 429], 'one running, one queued, the rest refused');
  } finally { await runner.close(); }
}));

test('closing the runner kills candidate processes that are still running and returns promptly', { timeout: 20000 }, () => withRoot(async root => {
  const pidFile = join(root, 'pid');
  const c = await candidate(root, 'hang', `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('hang', () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); return new Promise(() => setInterval(() => {}, 1000)); });`);
  const runner = await startLocalTestRunner({ root: join(root, 'work'), secret: SECRET, slots: 1, allowFileRemotes: true });
  const pending = post(runner.origin, input(c, { recipe: { setup: [], test: ['node', '--test'], budgetMs: 300000 } })).catch(() => undefined);
  let pid; for (let i = 0; i < 60 && !pid; i++) { await new Promise(r => setTimeout(r, 100)); try { pid = Number((await import('node:fs/promises')).readFile && Number(await (await import('node:fs/promises')).readFile(pidFile, 'utf8'))); } catch { /* not yet */ } }
  assert.ok(pid > 0, 'the candidate started');
  const started = Date.now(); await runner.close();
  assert.ok(Date.now() - started < 5000, 'close did not wait for the 5 minute budget');
  let alive = true; for (let i = 0; i < 40 && alive; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 100)); } catch { alive = false; } }
  assert.equal(alive, false, 'the candidate process is gone'); await pending;
}));

test('the runner works in a private directory it creates itself, and removes it on close', { timeout: 20000 }, async () => {
  const runner = await startLocalTestRunner({ secret: SECRET });
  const dir = runner.root; assert.ok(dir, 'the runner reports where it works');
  assert.equal((await stat(dir)).mode & 0o777, 0o700);
  await runner.close(); await assert.rejects(() => stat(dir), /ENOENT/);
  await assert.rejects(() => runCandidateLocally(input({ remote: '/x', sourceSha: 'a'.repeat(40), treeSha: 'b'.repeat(40) })), /private work directory/, 'no shared, predictable default directory');
});

test('when the client gives up, a running candidate is stopped and its slot is freed', { timeout: 30000 }, () => withRoot(async root => {
  const pidFile = join(root, 'pid');
  const hang = await candidate(root, 'abandoned', `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('hang', () => { writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); return new Promise(() => setInterval(() => {}, 1000)); });`);
  const quick = await candidate(root, 'next', "import test from 'node:test'; test('ok', () => {});");
  const runner = await startLocalTestRunner({ root: join(root, 'work'), secret: SECRET, slots: 1, allowFileRemotes: true });
  try {
    const abort = new AbortController();
    const first = fetch(`${runner.origin}/run`, { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json', 'x-runner-secret': SECRET }, body: JSON.stringify(input(hang, { recipe: { setup: [], test: ['node', '--test'], budgetMs: 300000 } })) }).catch(() => undefined);
    let pid; for (let i = 0; i < 80 && !pid; i++) { await new Promise(r => setTimeout(r, 100)); try { pid = Number(await readFile(pidFile, 'utf8')); } catch { /* not yet */ } }
    assert.ok(pid > 0, 'the candidate started'); abort.abort(); await first;
    let alive = true; for (let i = 0; i < 50 && alive; i++) { try { process.kill(pid, 0); await new Promise(r => setTimeout(r, 100)); } catch { alive = false; } }
    assert.equal(alive, false, 'the abandoned candidate was killed, not left to run out its 5 minute budget');
    const next = await post(runner.origin, input(quick)); assert.equal(next.status, 200, 'the slot was freed'); assert.equal((await next.json()).testExitCode, 0);
  } finally { await runner.close(); }
}));

test('a request that gives up while still waiting in the queue never runs', { timeout: 30000 }, () => withRoot(async root => {
  const marker = join(root, 'ran'), slow = "import test from 'node:test'; test('t', async () => { await new Promise(r => setTimeout(r, 1200)); });";
  const first = await candidate(root, 'holder', slow);
  const waiter = await candidate(root, 'waiter', `import test from 'node:test'; import { writeFileSync } from 'node:fs'; test('t', () => { writeFileSync(${JSON.stringify(marker)}, 'ran'); });`);
  const runner = await startLocalTestRunner({ root: join(root, 'work'), secret: SECRET, slots: 1, allowFileRemotes: true });
  try {
    const holding = post(runner.origin, input(first));
    await new Promise(r => setTimeout(r, 300));
    const abort = new AbortController();
    const queued = fetch(`${runner.origin}/run`, { method: 'POST', signal: abort.signal, headers: { 'content-type': 'application/json', 'x-runner-secret': SECRET }, body: JSON.stringify(input(waiter)) }).catch(() => undefined);
    await new Promise(r => setTimeout(r, 300)); abort.abort(); await queued;
    assert.equal((await holding).status, 200); await new Promise(r => setTimeout(r, 800));
    await assert.rejects(() => stat(marker), /ENOENT/, 'the abandoned queued job was never executed');
    // The slot the holder released must go to a real request, not to the one that left (a leaked slot would block everyone after it).
    const later = await candidate(root, 'later', "import test from 'node:test'; test('ok', () => {});");
    const third = await Promise.race([post(runner.origin, input(later)), new Promise(r => setTimeout(() => r(undefined), 8000))]);
    assert.ok(third, 'a later request is served; the abandoned waiter did not keep the slot'); assert.equal(third.status, 200);
  } finally { await runner.close(); }
}));

test('queued checkout finishes before its credential expires and queue wait preserves the recipe budget', { timeout: 20000 }, () => withRoot(async root => {
  const release = join(root, 'release'), marker = join(root, 'started');
  const holder = await candidate(root, 'lease-holder', `import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started'); while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20));`);
  const queued = await candidate(root, 'lease-waiter', "import test from 'node:test'; test('ok', () => {});");
  const fake = await startFakeArtifacts({ root: join(root, 'artifacts'), port: 0 });
  const runner = await startLocalTestRunner({ root: join(root, 'work'), secret: SECRET, slots: 1, allowFileRemotes: true });
  const until = async fn => { for (let i = 0; i < 100; i++) { if (await fn()) return; await new Promise(r => setTimeout(r, 30)); } throw new Error('condition did not become true'); };
  try {
    await fake.binding.create('queued'); const repo = await fake.binding.get('queued');
    const write = await repo.createToken('write', 600), read = await repo.createToken('read', 240);
    await execFileAsync('git', ['-c', `http.extraHeader=Authorization: Bearer ${write.plaintext}`, 'push', fake.binding.remote('queued'), 'HEAD:main'], { cwd: queued.remote });
    const first = post(runner.origin, input(holder, { recipe: { setup: [], test: ['node', 'a.test.mjs'], budgetMs: 10000 } })).catch(() => undefined);
    await until(() => stat(marker).then(() => true, () => false));
    const second = post(runner.origin, input({ ...queued, remote: fake.binding.remote('queued'), readCredential: read.plaintext }, { recipe: { setup: [], test: ['node', '--test'], budgetMs: 1000 } })).catch(() => undefined);
    await until(async () => {
      const { readdir } = await import('node:fs/promises');
      for (const dir of await readdir(runner.root)) {
        const head = await readFile(join(runner.root, dir, 'candidate/.git/HEAD'), 'utf8').catch(() => '');
        if (head.trim() === queued.sourceSha) return true;
      }
      return false;
    });
    fake.binding.now = () => Date.now() + 241000;
    assert.equal(await fake.binding.authorize('queued', read.plaintext), false, 'credential expired before the queued recipe starts');
    await new Promise(r => setTimeout(r, 1200));
    await writeFile(release, 'go');
    assert.equal((await first).status, 200);
    const response = await second; assert.equal(response.status, 200);
    const run = await response.json(); assert.equal(run.failure, undefined); assert.equal(run.testExitCode, 0);
  } finally { await runner.close(); await fake.close(); }
}));

test('local restart preserves clone remotes and metadata, refreshes event hooks, and refuses an occupied origin', { timeout: 20000 }, () => withRoot(async root => {
  const { startPersistentArtifacts } = await import('../../cli/up.mjs');
  const { createServer } = await import('node:http');
  const events = [], listener = createServer(async (req, res) => { let body = ''; for await (const c of req) body += c; events.push(JSON.parse(body)); res.end('ok'); });
  await new Promise(r => listener.listen(0, '127.0.0.1', r));
  const eventUrl = `http://127.0.0.1:${listener.address().port}/__dev/events`;
  let fake;
  try {
    fake = await startPersistentArtifacts(root, 'http://127.0.0.1:1/old-events');
    await fake.binding.create('restart'); const repo = await fake.binding.get('restart'), token = await repo.createToken('write', 600);
    const origin = fake.origin, remote = fake.binding.remote('restart');
    const c = await candidate(root, 'restart-clone', "import test from 'node:test'; test('ok', () => {});");
    git(c.remote, 'remote', 'add', 'origin', remote);
    await execFileAsync('git', ['-c', `http.extraHeader=Authorization: Bearer ${token.plaintext}`, 'push', 'origin', 'HEAD:main'], { cwd: c.remote });
    await fake.close(); fake = undefined;
    // Existing pre-fix installations recover the origin from their saved Wrangler config.
    await rm(join(root, 'artifacts-port'));
    await writeFile(join(root, 'wrangler.local.json'), JSON.stringify({ vars: { FAKE_ARTIFACTS_URL: origin } }));
    fake = await startPersistentArtifacts(root, eventUrl);
    assert.equal(fake.origin, origin); assert.equal((await (await fake.binding.get('restart')).info()).remote, remote);
    await assert.rejects(() => startPersistentArtifacts(root, eventUrl), /EADDRINUSE/, 'an occupied persisted port must not silently choose a new origin');
    await writeFile(join(c.remote, 'next'), 'next'); git(c.remote, 'add', '.'); git(c.remote, 'commit', '-m', 'after restart');
    await execFileAsync('git', ['-c', `http.extraHeader=Authorization: Bearer ${token.plaintext}`, 'push', 'origin', 'HEAD:main'], { cwd: c.remote });
    assert.ok(events.length > 0, 'the persisted clone push reaches the refreshed event hook');
    await fake.close(); fake = await startPersistentArtifacts(root, eventUrl);
    assert.equal(fake.origin, origin, 'the new port record also survives another restart');
    const fetched = await runCandidateLocally(input({ ...c, sourceSha: git(c.remote, 'rev-parse', 'HEAD'), treeSha: git(c.remote, 'rev-parse', 'HEAD^{tree}'), remote, readCredential: token.plaintext }), { root: join(root, 'tests') });
    assert.equal(fetched.testExitCode, 0, 'test checkout still reaches the persisted remote');
  } finally { if (fake) await fake.close(); await new Promise(r => listener.close(r)); }
}));

test('a failed setup still reports dependency install failure and never runs tests', () => withRoot(async root => {
  const c = await candidate(root, 'install-fail', "import test from 'node:test'; test('ok', () => {});");
  const run = await runCandidate(c, root, { recipe: { setup: [['node', '-e', 'process.exit(1)']], test: ['node', '--test'], budgetMs: 30000 } });
  assert.equal(run.installExitCode, 1); assert.equal(run.testExitCode, undefined);
  assert.equal(isolatedTestResult(run).summary, 'Local run (not isolated) dependency install failed');
}));

test('closing one runner does not kill another runner’s candidate', { timeout: 20000 }, () => withRoot(async root => {
  const marker = join(root, 'other-started'), release = join(root, 'other-release');
  const c = await candidate(root, 'other-runner', `import { existsSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'started'); while (!existsSync(${JSON.stringify(release)})) await new Promise(r => setTimeout(r, 20));`);
  const first = await startLocalTestRunner({ root: join(root, 'first'), secret: SECRET });
  const second = await startLocalTestRunner({ root: join(root, 'second'), secret: SECRET, allowFileRemotes: true });
  try {
    const running = post(second.origin, input(c, { recipe: { setup: [], test: ['node', 'a.test.mjs'], budgetMs: 10000 } })).catch(() => undefined);
    let started = false;
    for (let i = 0; i < 100 && !started; i++) { started = await stat(marker).then(() => true, () => false); if (!started) await new Promise(r => setTimeout(r, 30)); }
    assert.equal(started, true);
    await first.close(); await writeFile(release, 'go');
    const response = await running; assert.equal(response?.status, 200);
    assert.equal((await response.json()).testExitCode, 0, 'the second runner keeps its own candidate alive');
  } finally { await first.close(); await second.close(); }
}));
