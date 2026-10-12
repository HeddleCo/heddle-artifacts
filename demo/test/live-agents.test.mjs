// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveAgents } from '../lib/harness.mjs';
test('live lanes default to one provider and accept per-agent vendor and model overrides', () => {
  assert.deepEqual(liveAgents({}), { alice: { provider: 'codex', model: undefined }, bob: { provider: 'codex', model: undefined }, carol: { provider: 'codex', model: undefined } });
  const mixed = liveAgents({ DEMO_LIVE_PROVIDER: 'claude', DEMO_LIVE_PROVIDERS: 'alice=codex', DEMO_LIVE_MODEL: 'shared', DEMO_LIVE_MODELS: 'alice=gpt-6.1-sol, bob=claude-opus-5-5' });
  assert.deepEqual(mixed, { alice: { provider: 'codex', model: 'gpt-6.1-sol' }, bob: { provider: 'claude', model: 'claude-opus-5-5' }, carol: { provider: 'claude', model: 'shared' } });
});
test('live lane overrides reject unknown agents, providers and malformed pairs', () => {
  for (const env of [{ DEMO_LIVE_PROVIDERS: 'mallory=codex' }, { DEMO_LIVE_PROVIDERS: 'alice=gemini' }, { DEMO_LIVE_PROVIDER: 'sh' },
    { DEMO_LIVE_PROVIDERS: 'alice' }, { DEMO_LIVE_PROVIDERS: 'alice=codex,alice=claude' }, { DEMO_LIVE_MODELS: 'bob=a=b' }]) assert.throws(() => liveAgents(env));
});
