// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveAgents, options, regexAdditions, taskAgents } from '../lib/harness.mjs';
test('live lanes default to one provider and accept per-agent vendor and model overrides', () => {
  assert.deepEqual(liveAgents({}), { alice: { provider: 'codex', model: undefined }, bob: { provider: 'codex', model: undefined }, carol: { provider: 'codex', model: undefined } });
  const mixed = liveAgents({ DEMO_LIVE_PROVIDER: 'claude', DEMO_LIVE_PROVIDERS: 'alice=codex', DEMO_LIVE_MODEL: 'shared', DEMO_LIVE_MODELS: 'alice=gpt-6.1-sol, bob=claude-opus-5-5' });
  assert.deepEqual(mixed, { alice: { provider: 'codex', model: 'gpt-6.1-sol' }, bob: { provider: 'claude', model: 'claude-opus-5-5' }, carol: { provider: 'claude', model: 'shared' } });
});
test('sandbox providers route lanes to the Cloudflare agent runner', () => {
  const lanes = liveAgents({ DEMO_LIVE_PROVIDERS: 'alice=cf-codex,bob=cf-claude' });
  assert.equal(lanes.alice.provider, 'cf-codex'); assert.equal(lanes.bob.provider, 'cf-claude'); assert.equal(lanes.carol.provider, 'codex');
});
test('live lane overrides reject unknown agents, providers and malformed pairs', () => {
  for (const env of [{ DEMO_LIVE_PROVIDERS: 'mallory=codex' }, { DEMO_LIVE_PROVIDERS: 'alice=gemini' }, { DEMO_LIVE_PROVIDER: 'sh' },
    { DEMO_LIVE_PROVIDERS: 'alice' }, { DEMO_LIVE_PROVIDERS: 'alice=codex,alice=claude' }, { DEMO_LIVE_MODELS: 'bob=a=b' }]) assert.throws(() => liveAgents(env));
});

test('live runs and follow-ups wait long enough for coding agents; explicit --timeout wins', () => {
  const url = ['--url', 'https://example.test'];
  assert.equal(options(url).timeout, 180);
  assert.equal(options([...url, '--mode', 'live']).timeout, 2700);
  assert.equal(options(url, 'followup').timeout, 2700);
  assert.equal(options([...url, '--timeout', '60'], 'followup').timeout, 60);
});

test('experiment tally counts regexes added to src/table.ts, not division, paths, comments or other files', () => {
  const diff = (file, lines) => `diff --git a/${file} b/${file}\n--- a/${file}\n+++ b/${file}\n@@ -1 +1 @@\n${lines.map(l => '+' + l).join('\n')}\n`;
  const table = diff('src/table.ts', [
    'return cell.replace(/\\\\n/g, "\\n");', '  const re = new RegExp("\\\\\\\\n");', '  const half = width / 2 / scale;',
    '  // split on /\\|/ here', '  const path = "src/table.ts";', '  if (next === "n") cell += "\\n";']);
  assert.deepEqual(regexAdditions(table), ['return cell.replace(/\\\\n/g, "\\n");', 'const re = new RegExp("\\\\\\\\n");']);
  assert.deepEqual(regexAdditions(diff('test/table.test.ts', ['expect(x).toMatch(/a|b/);'])), []);
});

test('task lanes are named agents on Workers AI models', () => {
  assert.deepEqual(taskAgents('kimi=@cf/moonshotai/kimi-k2.7-code, glm=@cf/zai-org/glm-5.2'),
    [['kimi', '@cf/moonshotai/kimi-k2.7-code'], ['glm', '@cf/zai-org/glm-5.2']]);
  for (const bad of [undefined, '', 'Kimi=@cf/a/b', 'reviewer=@cf/a/b', 'luke=@cf/a/b', 'a=@cf/a/b,a=@cf/c/d', 'a=gpt-4', 'a=meta/muse-wonder-1.0', 'a=@cf/a/b=c'])
    assert.throws(() => taskAgents(bad), /DEMO_TASK_AGENTS/, String(bad));
});
