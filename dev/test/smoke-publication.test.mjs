// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFakeArtifacts } from '../fake-artifacts/server.mjs';
import { boundedGit } from '../smoke-safety.mjs';
import { requireExactRefs, smoke, measureGitPhase, publicationEventTiming } from '../smoke-artifacts.mjs';
import { DIRECTORY_REF, leasedPushArgs } from '../../engine/lib/ordered-publication.mjs';

test('local fake actually disables atomic and rejects rebuilt notes without changing remote refs', async t => {
  const root = await mkdtemp(join(tmpdir(), 'smoke-no-atomic-'));
  const fake = await startFakeArtifacts({ root: join(root, 'repos'), port: 0, advertiseAtomic: false, eventUrl: 'http://127.0.0.1:9' });
  t.after(async () => { await fake.close(); await rm(root, { recursive: true, force: true }); });
  const { remote, token } = await fake.binding.create('local-only');
  const work = join(root, 'work'); await mkdir(work);
  const git = args => boundedGit(args, work, { home: root });
  const remoteGit = args => boundedGit(args, work, { home: root, token, remote });
  await git(['init', '--initial-branch=main']); await git(['config', 'user.name', 'Smoke']); await git(['config', 'user.email', 'smoke@example.invalid']);
  await writeFile(join(work, 'README.md'), 'Artifacts smoke\n'); await git(['add', '.']); await git(['commit', '-m', 'Smoke seed']);
  const seed = (await git(['rev-parse', 'HEAD'])).trim();
  await git(['notes', '--ref=heddle-why', 'add', '-m', 'Artifacts why', seed]);
  const notes = (await git(['rev-parse', 'refs/notes/heddle-why'])).trim();
  await remoteGit(['push', remote, 'HEAD:refs/heads/main', 'refs/notes/heddle-why']);
  await assert.rejects(remoteGit(['push', '--atomic', remote, 'HEAD:refs/heads/atomic-probe']), /^Error: git_atomic_unsupported$/);
  await git(['update-ref', '-d', 'refs/notes/heddle-why']); await git(['notes', '--ref=heddle-why', 'add', '-m', 'Rebuilt why', seed]);
  await assert.rejects(remoteGit(['push', remote, 'refs/notes/heddle-why']), /^Error: git_non_fast_forward$/);
  const tips = requireExactRefs(await remoteGit(['ls-remote', remote]), { 'refs/heads/main': seed, 'refs/notes/heddle-why': notes });
  assert.equal(tips['refs/heads/atomic-probe'], undefined);
});

test('smoke fails before main CAS when an ordinary proof stage is partially rejected', async () => {
  const out = [], captured = {};
  const localFakeFactory = async options => {
    assert.equal(options.advertiseAtomic, false);
    const fake = await startFakeArtifacts(options), originalCreate = fake.binding.create.bind(fake.binding);
    fake.binding.create = async (name, opts) => {
      const result = await originalCreate(name, opts);
      if (!name.includes('--x--y')) {
        captured.path = fake.binding.path(name);
        await writeFile(join(captured.path, 'hooks', 'update'), '#!/bin/sh\n[ "$1" != "refs/heads/heddle/agents" ]\n', { mode: 0o755 });
      }
      return result;
    };
    const close = fake.close;
    fake.close = async () => {
      captured.main = (await boundedGit(['rev-parse', 'refs/heads/main'], captured.path, { home: options.root })).trim();
      captured.seedMessage = (await boundedGit(['show', '-s', '--format=%s', captured.main], captured.path, { home: options.root })).trim();
      captured.refs = await boundedGit(['show-ref'], captured.path, { home: options.root });
      await close();
    };
    return fake;
  };
  assert.equal(await smoke({ local: true, localFakeFactory, log: line => out.push(line) }), 1);
  assert.equal(captured.seedMessage, 'Smoke seed');
  assert(captured.refs.includes('refs/heads/candidates/x/y')); // Partial staging is honestly possible.
  assert(!captured.refs.includes(DIRECTORY_REF));
  assert(out.includes('GIT NETWORK COMMANDS 2/7')); assert(!out.includes('PASS main-last expected-old CAS'));
});

test('smoke fails before main CAS when staged proof readback has the right ref name but wrong hash', async () => {
  const out = [], captured = {};
  const localFakeFactory = async options => {
    const fake = await startFakeArtifacts(options), originalCreate = fake.binding.create.bind(fake.binding);
    fake.binding.create = async (name, opts) => {
      const result = await originalCreate(name, opts);
      if (!name.includes('--x--y')) {
        captured.path = fake.binding.path(name);
        const hook = join(captured.path, 'hooks', 'post-receive'), original = await readFile(hook, 'utf8');
        // Synthetic corruption after a successful stage; no real account is used.
        await writeFile(hook, '#!/bin/sh\nif git rev-parse --verify refs/heads/heddle/agents >/dev/null 2>&1; then\n git update-ref refs/heads/heddle/agents "$(git rev-parse refs/heads/main)"\nfi\n' + original.replace(/^#!.*\n/, ''), { mode: 0o755 });
      }
      return result;
    };
    const close = fake.close;
    fake.close = async () => {
      captured.mainMessage = (await boundedGit(['show', '-s', '--format=%s', 'refs/heads/main'], captured.path, { home: options.root })).trim();
      await close();
    };
    return fake;
  };
  assert.equal(await smoke({ local: true, localFakeFactory, log: line => out.push(line) }), 1);
  assert.equal(captured.mainMessage, 'Smoke seed');
  assert(out.includes('SMOKE FAIL: proof_ref_check_failed (credentials suppressed)'));
  assert(out.includes('GIT NETWORK COMMANDS 3/7')); assert(!out.includes('PASS main-last expected-old CAS'));
});

test('main CAS uses the production primitive with explicit expected-old OID and one pinned target', () => {
  const before = 'a'.repeat(40), oid = 'b'.repeat(40), remote = 'http://127.0.0.1:1234/git/heddle-demo/synthetic.git';
  assert.deepEqual(leasedPushArgs(remote, [{ ref: 'refs/heads/main', oid, before }]),
    ['push', `--force-with-lease=refs/heads/main:${before}`, remote, `${oid}:refs/heads/main`]);
});

test('Git timing retains failure classification and expected rejection without leaking diagnostics', async () => {
  for (const [phase, failure, expected] of [['stale_main_cas', 'git_stale_info', true], ['mirror_clone', 'git_timeout', false], ['SECRET', 'SECRET_DIAGNOSTIC', false]]) {
    const samples = [], times = [100, 112.125], error = new Error(failure);
    await assert.rejects(measureGitPhase(phase, async () => { throw error; }, value => samples.push(value), { monotonic: () => times.shift() }), candidate => candidate === error);
    assert.equal(samples.length, 1); assert.equal(samples[0].elapsed_ms, 12.125); assert.equal(samples[0].outcome, 'failure');
    assert.equal(samples[0].expected_rejection === true, expected); assert.equal(samples[0].fresh_git_process, true);
    assert(!JSON.stringify(samples).includes('SECRET'));
  }
  const samples = [], times = [10, 15];
  assert.equal(await measureGitPhase('mirror_clone', async () => 'fixture result', value => samples.push(value), { monotonic: () => times.shift() }), 'fixture result');
  assert.deepEqual(samples, [{ phase: 'mirror_clone', elapsed_ms: 5, outcome: 'success', fresh_git_process: true }]);
});
test('event observation is correlated to exact main CAS, not seed or unvalidated clock metadata', () => {
  const before = 'a'.repeat(40), after = 'b'.repeat(40), sentAt = Date.parse('2026-10-10T12:00:00.000Z');
  const expected = { namespace: 'heddle-demo', repoName: 'synthetic', before, after, sentAt, sentMonotonic: 10 };
  const event = { type: 'cf.artifacts.repo.pushed', source: { namespace: 'heddle-demo', repoName: 'synthetic' },
    payload: { ref: 'refs/heads/main', before, after }, metadata: { eventTimestamp: '2026-10-10T12:00:00.020Z' } };
  const item = { event, receivedAt: sentAt + 100, receivedMonotonic: 95.5 };
  const metric = publicationEventTiming(item, expected);
  assert.equal(metric.observation_delay_ms, 85.5); assert.equal(metric.event_to_observation_ms, 80);
  assert.equal(metric.server_clock_verified, false); assert.equal(metric.event_timestamp, event.metadata.eventTimestamp);
  for (const payload of [{ ...event.payload, after: before }, { ...event.payload, before: '0'.repeat(40) }, { ref: 'refs/heads/main' }]) {
    assert.equal(publicationEventTiming({ ...item, event: { ...event, payload } }, expected), null);
  }
  for (const eventTimestamp of ['SECRET_DIAGNOSTIC', '2026-10-10T13:00:00.000Z', '2026-10-09T12:00:00.000Z']) {
    const sample = publicationEventTiming({ ...item, event: { ...event, metadata: { eventTimestamp } } }, expected);
    assert.equal(sample.event_timestamp, null); assert.equal(sample.event_to_observation_ms, null);
    assert.equal(sample.observation_delay_ms, 85.5); assert(!JSON.stringify(sample).includes('SECRET'));
  }
});
