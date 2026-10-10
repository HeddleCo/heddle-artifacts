// SPDX-License-Identifier: Apache-2.0
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { startFakeArtifacts } from './fake-artifacts/server.mjs';
import { git } from './fake-artifacts/binding.mjs';
export function requireRefs(output, expected) {
  for (const ref of expected) if (!output.split('\n').some(line => line.split(/\s+/)[1] === ref)) throw new Error('ref_check_failed');
}
export async function smoke({ local = false, missingRef = false } = {}) {
  if (!local && (!process.env.CF_ACCOUNT_ID || !process.env.CLOUDFLARE_API_TOKEN)) {
    console.error('A-S1 BLOCKED: CF_ACCOUNT_ID and CLOUDFLARE_API_TOKEN are required outside the sandbox.'); return 2;
  }
  const temp = await mkdtemp(join(tmpdir(), 'artifacts-smoke-')), repoName = `smoke-${randomBytes(4).toString('hex')}`, namespace = process.env.ARTIFACTS_NAMESPACE ?? 'heddle-demo';
  let fake, sink, queueId, subscriptionId, canonical, fork, failure, latency;
  const events = [], tokens = [], outcomes = [];
  const record = message => { outcomes.push(message); console.log(message); };
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4/accounts/${process.env.CF_ACCOUNT_ID}${path}`, { method, headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(30000) });
    const value = await response.json(); if (!response.ok || !value.success) throw new Error(`control_plane_${response.status}`); return value.result;
  };
  const base = `/artifacts/namespaces/${namespace}`;
  try {
    if (local) {
      sink = createServer(async (req, res) => { let body = ''; for await (const chunk of req) body += chunk; events.push({ event: JSON.parse(body), receivedAt: Date.now() }); res.end('ok'); });
      await new Promise(r => sink.listen(0, '127.0.0.1', r));
      fake = await startFakeArtifacts({ root: join(temp, 'repos'), port: 0, eventUrl: `http://127.0.0.1:${sink.address().port}/events` });
      canonical = await fake.binding.create(repoName);
    } else {
      canonical = await api(`${base}/repos`, 'POST', { name: repoName, default_branch: 'main' });
      const queue = await api('/queues', 'POST', { queue_name: `${repoName}-events` }); queueId = queue.queue_id;
      await api(`/queues/${queueId}/consumers`, 'POST', { type: 'http_pull', settings: { visibility_timeout_ms: 10000 } });
      const sub = await api('/event_subscriptions/subscriptions', 'POST', { name: repoName, enabled: true, source: { type: 'artifacts.repo', namespace, repo_name: repoName }, events: ['pushed'], destination: { type: 'queues.queue', queue_id: queueId } }); subscriptionId = sub.id;
    }
    const mint = async (name, scope) => {
      const result = local ? await (await fake.binding.get(name)).createToken(scope, 600) : await api(`${base}/tokens`, 'POST', { repo: name, scope, ttl: 600 }); tokens.push(result.id); return result.plaintext;
    };
    const write = await mint(repoName, 'write'), read = await mint(repoName, 'read');
    const auth = ['-c', 'protocol.version=1', '-c', `http.extraHeader=Authorization: Bearer ${write}`];
    const work = join(temp, 'work'); await mkdir(work); await git(['init', '--initial-branch=main'], work); await git(['config', 'user.name', 'Smoke'], work); await git(['config', 'user.email', 'smoke@example.invalid'], work);
    await writeFile(join(work, 'README.md'), 'Artifacts smoke\n'); await git(['add', '.'], work); await git(['commit', '-m', 'Smoke seed'], work);
    const pushedAt = Date.now(); await git([...auth, 'push', canonical.remote, 'HEAD:main'], work); record('PASS main push');
    fork = local ? await (await fake.binding.get(repoName)).fork(`${repoName}--x--y`, { defaultBranchOnly: true }) : await api(`${base}/repos/${repoName}/fork`, 'POST', { name: `${repoName}--x--y`, default_branch_only: true });
    await mint(fork.name, 'write'); record('PASS create/fork/mint token');
    await git([...auth, 'push', canonical.remote, 'HEAD:refs/heads/candidates/x/y'], work); record('PASS candidate ref push');
    await git(['notes', '--ref=heddle-why', 'add', '-m', 'Artifacts why'], work);
    try { await git([...auth, 'push', canonical.remote, 'refs/notes/heddle-why'], work); record('PASS notes push'); }
    catch { failure = 'notes_rejected'; record('FAIL notes push; R1 REQUIRED: publish refs/heads/heddle/why with why/<sha>.md'); throw new Error('notes_rejected'); }
    try { await git([...auth, 'push', '--atomic', canonical.remote, 'HEAD:refs/heads/candidates/atomic/y', 'refs/notes/heddle-why:refs/notes/heddle-why'], work); record('PASS atomic multi-ref push'); }
    catch { record('FAIL atomic push; integration must use separate ref pushes'); throw new Error('atomic_rejected'); }
    // Rebuilt notes can be a non-fast-forward even when all code refs advance.
    await git(['update-ref', '-d', 'refs/notes/heddle-why'], work); await git(['notes', '--ref=heddle-why', 'add', '-m', 'Rebuilt why'], work);
    try { await git([...auth, 'push', canonical.remote, 'refs/notes/heddle-why'], work); record('PASS non-fast-forward notes push'); }
    catch { record('INFO non-fast-forward notes rejected; R1: parent rebuilt notes onto remote notes tip'); }
    const refs = await git(['-c', `http.extraHeader=Authorization: Bearer ${read}`, 'ls-remote', canonical.remote]);
    requireRefs(refs, ['refs/heads/main', 'refs/heads/candidates/x/y', 'refs/heads/candidates/atomic/y', 'refs/notes/heddle-why', ...(missingRef ? ['refs/heads/missing'] : [])]);
    record('PASS git ls-remote confirms main, candidates and notes');
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline && latency === undefined) {
      if (!local) {
        const messages = await api(`/queues/${queueId}/messages/pull`, 'POST', { batch_size: 20, visibility_timeout_ms: 10000 });
        for (const message of messages.messages ?? []) {
          let event = message.body;
          if (typeof event === 'string') { try { event = JSON.parse(event); } catch { event = JSON.parse(Buffer.from(event, 'base64').toString()); } }
          events.push({ event, receivedAt: Date.now() });
          await api(`/queues/${queueId}/messages/ack`, 'POST', { acks: [{ lease_id: message.lease_id }], retries: [] });
        }
      }
      const found = events.find(x => x.event.type === 'cf.artifacts.repo.pushed' && x.event.source.repoName === repoName && x.event.payload.ref === 'refs/heads/main');
      if (found) latency = found.receivedAt - pushedAt;
      else await new Promise(r => setTimeout(r, 500));
    }
    if (latency === undefined) { record('FAIL pushed event deadline; R3: alarm polling remains enabled'); throw new Error('event_timeout'); }
    record(`PASS ${local ? 'fake hook' : 'Queue'} pushed event; observed latency ${latency} ms`);
    record(local ? 'LOCAL-SMOKE PASS (not A-S1 real-account evidence)' : 'A-S1 PASS');
    return 0;
  } catch (error) {
    failure ??= /^[a-z_0-9]+$/.test(error.message) ? error.message : 'smoke_failed'; record(`SMOKE FAIL: ${failure} (credentials suppressed)`); return 1;
  } finally {
    if (!local) {
      // Delete only this run's temporary resources; never touch existing project repos or queues.
      if (subscriptionId) await api(`/event_subscriptions/subscriptions/${subscriptionId}`, 'DELETE').catch(() => {});
      if (fork) await api(`${base}/repos/${fork.name}`, 'DELETE').catch(() => {});
      if (canonical) await api(`${base}/repos/${repoName}`, 'DELETE').catch(() => {});
      if (queueId) await api(`/queues/${queueId}`, 'DELETE').catch(() => {});
      await writeFile('docs/SMOKE.md', `<!-- SPDX-License-Identifier: Apache-2.0 -->\n# A-S1 live smoke\n\nRun: ${new Date().toISOString()}\n\n\`TMPDIR=/home/scratch bash scripts/smoke-artifacts.sh\`\n\n\`\`\`text\n${outcomes.join('\n')}\n\`\`\`\n\n${failure ? `Failed: ${failure}. Follow the fallback recorded above.` : 'All live checks passed.'}\n`);
    }
    if (fake) await fake.close(); if (sink) await new Promise(r => sink.close(r)); await rm(temp, { recursive: true, force: true });
  }
}
if (process.argv[1]?.endsWith('smoke-artifacts.mjs')) process.exitCode = await smoke({ local: process.argv.includes('--fake'), missingRef: process.argv.includes('--prove-ref-check') });
