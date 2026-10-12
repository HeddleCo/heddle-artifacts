// SPDX-License-Identifier: Apache-2.0
// Independent, entirely synthetic smoke parser and observation checks.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireExactRefs, publicationEventTiming, measureGitPhase } from '../../dev/smoke-artifacts.mjs';
import { sanitizeBridgeValue } from '../../dev/smoke-bridge.mjs';
import { makePlan, createGitNetworkBudget } from '../../dev/smoke-safety.mjs';
import { createControlPlane } from '../../dev/smoke-control.mjs';
const before = 'a'.repeat(40), after = 'b'.repeat(40), ref = 'refs/heads/main';
const plan = makePlan({ runId: 'independent-local', accountId: 'c'.repeat(32), accountName: 'Synthetic', accountPlan: 'Workers Paid', namespace: 'heddle-demo', jurisdiction: 'unrestricted' });
const timestamp = '2026-10-10T20:00:00.000Z';
const event = { type: 'cf.artifacts.repo.pushed', source: { namespace: plan.target.namespace, repoName: plan.resources.repositories[0] }, payload: { ref, before, after }, metadata: { eventTimestamp: timestamp } };
const sentAt = Date.parse(timestamp);
const expected = { ...event.source, before, after, sentAt, sentMonotonic: 100 };
const item = { event, receivedAt: sentAt + 150, receivedMonotonic: 225 };
const sanitize = body => sanitizeBridgeValue('pull', 200, { success: true, result: { messages: [{ lease_id: 'synthetic-lease', body }] } }, plan).result.messages[0].body;

test('independent exact-hash parser rejects ambiguous or malformed proof advertisements', () => {
  assert.equal(requireExactRefs(`${after}\t${ref}\n`, { [ref]: after })[ref], after);
  for (const text of [`${before}\t${ref}\n`, `${after}\t${ref}-suffix\n`, `${after}\t${ref}\n${after}\t${ref}\n`, `${after}\t${ref}\n${before}\t${ref}\n`, `${after} ${ref}\n`, `${after}\t${ref}\r\n`, `${after}f\t${ref}\n`]) {
    assert.throws(() => requireExactRefs(text, { [ref]: after }), /proof_ref_check_failed/);
  }
});
test('independent network budget has exactly seven reservations and no retry allowance', () => {
  const budget = createGitNetworkBudget();
  assert.throws(() => budget.requireComplete(), /git_network_count_mismatch/);
  for (let count = 1; count <= 7; count++) assert.equal(budget.reserve(), count);
  budget.requireComplete();
  assert.throws(() => budget.reserve(), /git_network_command_limit/);
  assert.equal(budget.used, 7);
});
test('independent Queue correlation excludes seed and every mismatched decision identity', () => {
  assert.equal(publicationEventTiming(item, expected).observation_delay_ms, 125);
  for (const payload of [{ ref, before: '0'.repeat(40), after: before }, { ref, before, after: before }, { ref, before: after, after }, { ref: 'refs/heads/candidates/x/y', before, after }, { ref, after }]) assert.equal(publicationEventTiming({ ...item, event: { ...event, payload } }, expected), null);
  for (const source of [{ ...event.source, namespace: 'other' }, { ...event.source, repoName: 'other' }]) assert.equal(publicationEventTiming({ ...item, event: { ...event, source } }, expected), null);
  assert.equal(publicationEventTiming({ ...item, receivedMonotonic: 99 }, expected), null);
  for (const reported of [undefined, 'SYNTHETIC-PRIVATE-SENTINEL', '2026-02-30T20:00:00.000Z', '2026-10-10T20:00:00Z', '2026-10-11T20:00:00.000Z']) {
    const metric = publicationEventTiming({ ...item, event: { ...event, metadata: { eventTimestamp: reported } } }, expected);
    assert.equal(metric.event_timestamp, null);
    assert.equal(metric.event_to_observation_ms, null);
    assert.equal(metric.observation_delay_ms, 125);
    assert.equal(metric.server_clock_verified, false);
    assert(!JSON.stringify(metric).includes('SENTINEL'));
  }
});
test('independent bridge strips extras and rejects malformed hashes, IDs and timestamps', () => {
  const raw = { ...event, private: 'SYNTHETIC-PRIVATE-SENTINEL', payload: { ...event.payload, commits: [{ message: 'SYNTHETIC-PRIVATE-SENTINEL' }] }, metadata: { ...event.metadata, auth: 'SYNTHETIC-PRIVATE-SENTINEL' } };
  for (const body of [raw, JSON.stringify(raw), Buffer.from(JSON.stringify(raw)).toString('base64')]) assert.deepEqual(sanitize(body), event);
  for (const key of ['before', 'after']) for (const value of ['', 'a'.repeat(39), 'a'.repeat(41), 'A'.repeat(40), after + '\n', null, {}]) assert.throws(() => sanitize({ ...event, payload: { ...event.payload, [key]: value } }), /bridge_invalid/);
  for (const value of ['2026-02-30T20:00:00.000Z', timestamp + '\n', '2026-10-10T20:00:00Z', 'SYNTHETIC-PRIVATE-SENTINEL']) assert.throws(() => sanitize({ ...event, metadata: { eventTimestamp: value } }), /bridge_invalid/);
  for (const value of ['../outside', 'fixture\n', 'fixture?secret', 'x'.repeat(129), null]) assert.throws(() => sanitizeBridgeValue('queue-create', 200, { success: true, result: { queue_id: value, queue_name: plan.resources.queue } }, plan), /bridge_invalid/);
});
test('independent observations cannot persist request/response secrets or add telemetry saves', async () => {
  const ledger = { state: { resources: [], pending: [], cleanupFailures: [] }, save: async () => { throw new Error('Unexpected telemetry write'); } };
  let time = 0;
  const control = createControlPlane({ plan, ledger, apiToken: 'SYNTHETIC-PRIVATE-SENTINEL', monotonic: () => time += 7.5, fetchImpl: async () => ({ status: 200, ok: true, headers: { get: () => 'SYNTHETIC-PRIVATE-SENTINEL' }, json: async () => ({ success: true, result: { plaintext: 'SYNTHETIC-PRIVATE-SENTINEL' } }) }) });
  await control.api('/artifacts/namespaces/heddle-demo/tokens', 'POST', { arbitrary: 'SYNTHETIC-PRIVATE-SENTINEL' });
  assert.equal(ledger.state.apiTimings[0].elapsedMs, 7.5);
  assert.equal(ledger.state.apiTimings[0].contentLengthBytes, null);
  assert(!JSON.stringify(ledger).includes('SENTINEL'));
  const metrics = []; let tick = 0;
  await assert.rejects(() => measureGitPhase('SYNTHETIC-PRIVATE-SENTINEL', async () => { throw new Error('SYNTHETIC-PRIVATE-SENTINEL'); }, value => metrics.push(value), { monotonic: () => ++tick }));
  assert.equal(metrics[0].phase, 'unknown');
  assert.equal(metrics[0].failure, 'smoke_failed');
  assert(!JSON.stringify(metrics).includes('SENTINEL'));
});
