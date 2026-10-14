// SPDX-License-Identifier: Apache-2.0
// Contract-only local test double. Real Git; fixture keys/states, no Heddle/Cloudflare claims.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { command, isMain } from '../../cli/ha.mjs';
import { createReviewer, REVIEW_MODEL } from '../../reviewer/reviewer.ts';
const demoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const hash = text => createHash('sha256').update(text).digest('hex');
function raw(program, args, options = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(program, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', c => stdout += c); child.stderr.on('data', c => stderr += c);
    child.on('error', reject); child.on('close', code => resolvePromise({ code, stdout, stderr }));
  });
}
export async function startMock({ root, port = 0, operatorToken = randomBytes(32).toString('hex'), mutation, setupMode } = {}) {
  root ??= await mkdtemp(join(tmpdir(), 'heddle-D-platform-'));
  await mkdir(root, { recursive: true });
  const projects = new Map(), tokens = new Map(), pushes = [];
  let url;
  const git = (repo, args, extra = {}) => command('git', ['--git-dir', repo, ...args], extra);
  const remote = name => `${url}/git/${name}.git`;
  const repo = name => join(root, `${name}.git`);
  const token = (name, scope) => { const secret = randomBytes(32).toString('hex'); tokens.set(secret, { name, scope }); return secret; };
  const json = (res, code, value) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)); };
  const testTree = async (name, sha) => {
    const dir = await mkdtemp(join(root, 'test-'));
    try {
      await command('git', ['clone', '--quiet', repo(name), dir]);
      await command('git', ['checkout', '--quiet', sha], { cwd: dir });
      await symlink(join(demoRoot, 'seed-project/node_modules'), join(dir, 'node_modules'));
      const result = await raw(process.execPath, [join(demoRoot, 'seed-project/node_modules/vitest/vitest.mjs'),
        'run', '--maxWorkers=1', '--reporter=json'], { cwd: dir, env: { ...process.env, NO_COLOR: '1' } });
      const report = JSON.parse(result.stdout.slice(result.stdout.indexOf('{')));
      return { status: result.code === 0 ? 'pass' : 'fail', passed: report.numPassedTests, failed: report.numFailedTests,
        summary: `${report.numPassedTests} passed, ${report.numFailedTests} failed`, durationMs: Date.now() - report.startTime };
    } finally { await rm(dir, { recursive: true, force: true }); }
  };
  const refresh = async (project, task) => {
    for (const lane of task.lanes) {
      if (lane.agent === 'reviewer') continue;
      const sha = await git(repo(lane.forkRepo), ['rev-parse', 'main']);
      if (sha === task.baseSha || lane.lastSeenSha === sha) continue;
      lane.lastSeenSha = sha;
      const tests = await testTree(lane.forkRepo, sha);
      await git(repo(project.id), ['fetch', '--quiet', repo(lane.forkRepo), `${sha}:refs/heads/candidates/${task.slug}/${lane.agent}`]);
      const candidate = { task: task.slug, agent: lane.agent, state: `fixture-state-${sha}`, sourceSha: sha,
        treeSha: await git(repo(project.id), ['rev-parse', `${sha}^{tree}`]), parentSha: task.baseSha,
        subject: await git(repo(project.id), ['log', '-1', '--format=%s', sha]),
        diffstat: { files: task.slug === 'parser-escapes' ? 2 : 1, insertions: 10, deletions: 5 }, tests,
        conflicts: [], signedBy: hash(`fixture-key-${lane.agent}`), capturedAt: new Date().toISOString() };
      task.candidates = task.candidates.filter(c => c.agent !== lane.agent).concat(candidate);
    }
    if (task.candidates.length >= 2) {
      const [a, b] = task.candidates;
      const merged = await raw('git', ['--git-dir', repo(project.id), 'merge-tree', '--write-tree', a.sourceSha, b.sourceSha]);
      if (merged.code === 1 && !mutation?.includes('conflict')) {
        for (const c of task.candidates) c.conflicts = [{ path: 'src/table.ts', region: 'parseRow',
          with: task.candidates.filter(other => other.agent !== c.agent).map(other => other.agent) }];
      }
    }
    task.heads = task.candidates.map(c => c.state).sort();
    if (task.candidates.length && !task.review) {
      if (task.slug === 'parser-escapes' && task.candidates.length < 2) return;
      const input = { intent: task.intent, base: task.baseSha, turns: task.turns,
        candidates: await Promise.all(task.candidates.map(async c => ({ agent: c.agent, tests: c.tests,
          diff: await git(repo(project.id), ['diff', task.baseSha, c.sourceSha]) }))) };
      const reviewer = createReviewer({ AI: { run: async () => ({ response: JSON.stringify({ summary: 'Bob preserves the API and slash parity.',
        perCandidate: task.candidates.map(c => ({ agent: c.agent, verdict: c.tests.status === 'pass' ? 'approve' : 'concerns', notes: c.tests.summary })),
        ...(task.candidates.some(c => c.agent === 'bob' && c.tests.status === 'pass') ?
          { recommendation: { pick: 'bob', why: 'Parity tests pass and the API stays stable.' } } : {}), model: REVIEW_MODEL }) }) } });
      task.review = await reviewer(input);
      task.turns.push({ id: 'fixture-review', task: task.slug, author: 'reviewer', kind: 'reviewer', body: task.review.summary,
        heddleDiscussion: 'fixture-discussion', signedBy: hash('fixture-key-reviewer'), at: new Date().toISOString() });
    }
    if (mutation?.includes('tests')) for (const c of task.candidates) if (c.agent === 'bob') c.tests.status = 'fail';
  };
  let serialized = Promise.resolve();
  const server = createServer((req, res) => {
    if (req.url.startsWith('/git/')) {
      const parsed = new URL(req.url, url), match = parsed.pathname.match(/^\/git\/([\w-]+)\.git(\/.*)?$/);
      const auth = tokens.get(req.headers.authorization?.replace(/^Bearer /, ''));
      const push = parsed.searchParams.get('service') === 'git-receive-pack' || parsed.pathname.endsWith('/git-receive-pack');
      if (!match || !auth || auth.name !== match[1] || (push && auth.scope !== 'write')) return json(res, 403, { error: 'Git auth scope' });
      const pushEvent = push ? { repo: match[1], startedAt: new Date().toISOString() } : undefined;
      if (pushEvent) pushes.push(pushEvent);
      const child = spawn('git', ['http-backend'], { env: { ...process.env, GIT_PROJECT_ROOT: root, GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: `/${match[1]}.git${match[2] ?? ''}`, QUERY_STRING: parsed.searchParams.toString(),
        REQUEST_METHOD: req.method, CONTENT_TYPE: req.headers['content-type'] ?? '', REMOTE_USER: 'fixture',
        ...(req.headers['git-protocol'] ? { HTTP_GIT_PROTOCOL: req.headers['git-protocol'] } : {}) }, stdio: ['pipe', 'pipe', 'pipe'] });
      let header = Buffer.alloc(0), sent = false;
      child.stderr.on('data', () => {});
      child.stdout.on('data', chunk => {
        if (sent) return res.write(chunk);
        header = Buffer.concat([header, chunk]); const end = header.indexOf('\r\n\r\n'); if (end < 0) return;
        let status = 200; const headers = {};
        for (const line of header.subarray(0, end).toString().split('\r\n')) {
          const split = line.indexOf(':'); if (split < 0) continue;
          const key = line.slice(0, split), value = line.slice(split + 1).trim();
          if (key.toLowerCase() === 'status') status = parseInt(value); else headers[key] = value;
        }
        res.writeHead(status, headers); sent = true; res.write(header.subarray(end + 4)); header = Buffer.alloc(0);
      });
      child.on('error', () => { if (!res.headersSent) json(res, 500, { error: 'fixture Git unavailable' }); else res.end(); });
      child.on('close', code => { if (pushEvent) { pushEvent.finishedAt = new Date().toISOString(); pushEvent.exit = code; } res.end(); }); child.stdin.on('error', () => {}); req.pipe(child.stdin); return;
    }
    serialized = serialized.then(async () => {
      let body = ''; for await (const chunk of req) body += chunk;
      body = body ? JSON.parse(body) : undefined;
      const path = new URL(req.url, url).pathname;
      if (path === '/__test/reset' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${operatorToken}`) return json(res, 403, {});
        const project = projects.get(body.id);
        if (project) {
          for (const task of project.tasks) for (const lane of task.lanes) await rm(repo(lane.forkRepo), { recursive: true, force: true });
          await rm(repo(project.id), { recursive: true, force: true }); projects.delete(project.id);
          for (const [key, t] of tokens) if (t.name === project.id || t.name.startsWith(`${project.id}--`)) tokens.delete(key);
        }
        return json(res, 200, { ok: true });
      }
      if (path === '/api/projects' && req.method === 'POST') {
        if (req.headers.authorization !== `Bearer ${operatorToken}`) return json(res, 403, {});
        if (projects.has(body.id)) return json(res, 409, {});
        const seed = await mkdtemp(join(root, 'seed-'));
        await cp(join(demoRoot, 'seed-project'), seed, { recursive: true, filter: source => !source.includes('/node_modules') });
        await command('git', ['init', '--quiet', '-b', 'main'], { cwd: seed });
        await command('git', ['add', '.'], { cwd: seed });
        await command('git', ['-c', 'user.name=Seed', '-c', 'user.email=seed@demo.local', 'commit', '--quiet', '-m', 'demo seed'], { cwd: seed });
        await command('git', ['clone', '--quiet', '--bare', seed, repo(body.id)]);
        await git(repo(body.id), ['config', 'http.receivepack', 'true']);
        await rm(seed, { recursive: true, force: true });
        const project = { id: body.id, canonicalRemote: remote(body.id), readToken: token(body.id, 'read'), agents: [], tasks: [] };
        projects.set(body.id, project); return json(res, 200, { id: body.id, canonicalRemote: project.canonicalRemote, readToken: project.readToken });
      }
      const match = path.match(/^\/api\/projects\/([\w-]+)(.*)$/); if (!match) return json(res, 404, {});
      const project = projects.get(match[1]), tail = match[2]; if (!project) return json(res, 404, {});
      if (!tail.startsWith('/why/')) {
        const auth = req.headers.authorization?.replace(/^Bearer /, '');
        if (auth !== operatorToken && !project.agents.some(a => a.agentKey === auth)) return json(res, 403, {});
      }
      if (req.method === 'GET' && tail === '') return json(res, 200, { project: { id: project.id }, agents: project.agents.map(({ agentKey, ...a }) => a), tasks: project.tasks });
      if (req.method === 'POST' && tail === '/tasks') {
        const baseSha = await git(repo(project.id), ['rev-parse', 'main']);
        project.tasks.push({ ...body, baseSha, status: 'active', candidates: [], heads: [], lanes: [], turns: [] });
        return json(res, 200, { slug: body.slug, thread: `task/${body.slug}`, baseSha });
      }
      if (tail === '/humans') { const human = { ...body, kind: 'human', publicKey: hash(`fixture-key-${body.id}`) }; project.agents.push(human); return json(res, 200, human); }
      if (tail.startsWith('/why/')) return json(res, 200, { sha: tail.slice(5), narrative: project.narrative ?? '' });
      const taskMatch = tail.match(/^\/tasks\/([\w-]+)(.*)$/); if (!taskMatch) return json(res, 404, {});
      const task = project.tasks.find(t => t.slug === taskMatch[1]); if (!task) return json(res, 404, {});
      const action = taskMatch[2];
      if (action === '/agents') {
        const forkRepo = `${project.id}--${task.slug}--${body.id}`;
        if (task.lanes.some(l => l.agent === body.id)) return json(res, 409, { error: 'fixture already enrolled' });
        await command('git', ['clone', '--quiet', '--bare', repo(project.id), repo(forkRepo)]);
        await git(repo(forkRepo), ['config', 'http.receivepack', 'true']);
        const agentKey = randomBytes(32).toString('hex');
        project.agents.push({ ...body, agentKey, publicKey: hash(`fixture-key-${body.id}`) });
        task.lanes.push({ project: project.id, task: task.slug, agent: body.id, forkRepo, forkRemote: remote(forkRepo), laneThread: `task/${task.slug}/${body.id}`, status: 'active' });
        const forkToken = token(forkRepo, 'write');
        return json(res, 200, { agentKey, fork: { remote: remote(forkRepo), token: forkToken, expiresAt: new Date(Date.now() + 43200000).toISOString() },
          upstream: { remote: project.canonicalRemote, readToken: project.readToken },
          // Mirror Track A's self-authenticating script, including its persisted headers.
          setup: setupMode === 'none' ? '# auth-only setup\n' :
            `git -c 'http.${remote(forkRepo)}.extraHeader=Authorization: Bearer ${forkToken}' clone --quiet '${remote(forkRepo)}' ${setupMode === 'child' ? 'checkout' : '.'}\n` +
            (setupMode === 'child' ? 'cd checkout\n' : '') + `git remote add upstream '${project.canonicalRemote}'\n` +
            `git config 'http.${remote(forkRepo)}.extraHeader' 'Authorization: Bearer ${forkToken}'\n` +
            `git config 'http.${project.canonicalRemote}.extraHeader' 'Authorization: Bearer ${project.readToken}'\n`
 });
      }
      if (action === '' && req.method === 'GET') { await refresh(project, task); return json(res, 200, { task: { slug: task.slug, intent: task.intent }, candidates: task.candidates, turns: task.turns, review: task.review, decision: task.decision, heads: task.heads }); }
      if (action === '/turns') {
        const turn = { id: `fixture-turn-${task.turns.length}`, task: task.slug, author: body.as ?? 'alice', kind: 'human', body: body.body,
          heddleDiscussion: 'fixture-discussion', signedBy: hash(`fixture-key-${body.as}`), at: new Date().toISOString() };
        task.turns.push(turn); return json(res, 200, turn);
      }
      if (action === '/decision') {
        if (req.headers.authorization !== `Bearer ${operatorToken}`) return json(res, 403, {});
        if (mutation?.includes('stale') || JSON.stringify(body.expectHeads) !== JSON.stringify(task.heads)) return json(res, 409, { error: 'stale', heads: task.heads });
        const chosen = task.candidates.find(c => c.agent === body.pick);
        const alternatives = task.candidates.filter(c => c.agent !== body.pick).map(c => c.agent);
        project.narrative = `Heddle decision · task ${task.slug}\nIntent: ${task.intent}\nChosen: bob\nRejected: alice\nReview: ${task.review.summary}\nDiscussion: luke: ${task.turns.at(-1).body}\nDecided by luke fixture-key\n`;
        const env = { GIT_AUTHOR_NAME: 'Luke', GIT_AUTHOR_EMAIL: 'luke@demo.local', GIT_COMMITTER_NAME: 'Fixture engine', GIT_COMMITTER_EMAIL: 'engine@demo.local' };
        const sha = await git(repo(project.id), ['commit-tree', chosen.treeSha, '-p', task.baseSha], { env,
          input: `${body.rationale}\n\nHeddle-State: fixture-land\nHeddle-Change: fixture-change\n` });
        await git(repo(project.id), ['update-ref', 'refs/heads/main', sha]);
        if (!mutation?.includes('notes')) {
          await git(repo(project.id), ['notes', '--ref=heddle-why', 'add', '-m', project.narrative, sha], { env });
          await git(repo(project.id), ['notes', '--ref=heddle', 'add', '-m', 'fixture Heddle machine note', sha], { env });
        }
        task.decision = { task: task.slug, decider: body.decider, pick: body.pick, rationale: body.rationale,
          alternatives, resolutionState: 'fixture-resolution', landState: 'fixture-land', mainSha: sha, at: new Date().toISOString() };
        return json(res, 200, task.decision);
      }
      return json(res, 404, {});
    }).catch(() => { if (!res.headersSent) json(res, 500, { error: 'mock request failed' }); else res.end(); });
  });
  await new Promise(r => server.listen(port, '127.0.0.1', r));
  url = `http://127.0.0.1:${server.address().port}`;
  return { url, root, operatorToken, projects, tokens, pushes,
    close: async () => { await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); } };
}
if (isMain(import.meta.url)) {
  const mock = await startMock({ port: Number(process.env.MOCK_PORT ?? 8787), mutation: process.env.MOCK_MUTATION });
  if (!process.env.MOCK_CONFIG) throw new Error('Set MOCK_CONFIG to a private temporary JSON file');
  await writeFile(process.env.MOCK_CONFIG, JSON.stringify({ url: mock.url, operatorToken: mock.operatorToken }), { mode: 0o600 });
  console.log(`Local contract mock ready at ${mock.url}; fixture signatures only.`);
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => { await mock.close(); process.exit(); });
}
