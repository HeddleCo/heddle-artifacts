// SPDX-License-Identifier: Apache-2.0
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import renderToString from 'preact-render-to-string';
import { h } from 'preact';
// Bundle inside the package so the external preact resolves to this package's copy.
const temp = await mkdtemp(fileURLToPath(new URL('./.rich-', import.meta.url)));
after(() => rm(temp, { recursive: true, force: true }));
await build({ entryPoints: [fileURLToPath(new URL('../src/rich-text.tsx', import.meta.url))], outfile: join(temp, 'rich.mjs'), bundle: true, platform: 'node', format: 'esm', jsx: 'automatic', jsxImportSource: 'preact', external: ['preact', 'preact/*'] });
const mod = await import(pathToFileURL(join(temp, 'rich.mjs')));
const { RichText, ReviewBody, parseReview, Narrative } = mod;
const html = text => renderToString(h(RichText, { text }));

test('agent turns get paragraphs, bold, inline and fenced code', () => {
  const out = html('**Approach** uses `parseRow`.\n\n```ts\nconst a = 1;\n```\n\n- one\n- two');
  assert.match(out, /<strong>Approach<\/strong>/); assert.match(out, /<code>parseRow<\/code>/);
  assert.match(out, /<pre class="turn-code"><code>const a = 1;<\/code><\/pre>/); assert.match(out, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
});
test('turn bodies are text: markup and attributes are escaped, never injected', () => {
  const out = html('<img src=x onerror=alert(1)> **<b>x</b>** `<script>`');
  assert.doesNotMatch(out, /<img|<script>|<b>x/); assert.match(out, /&lt;img src=x onerror=alert\(1\)>/);
});
test('reviewer JSON renders as verdicts; anything else is not a review', () => {
  const review = { summary: 'Bob keeps parity.', perCandidate: [{ agent: 'alice', verdict: 'concerns', notes: 'lookbehind' }, { agent: 'bob', verdict: 'approve', notes: 'scanner' }], recommendation: { pick: 'bob', why: 'parity' }, model: 'm' };
  assert.deepEqual(parseReview(JSON.stringify(review)), review);
  for (const body of ['plain words', '{"summary":1}', '[]', '']) assert.equal(parseReview(body), undefined);
  const out = renderToString(h(ReviewBody, { review }));
  assert.match(out, /△ concerns/); assert.match(out, /✓ approve/); assert.match(out, /Recommends <strong>bob<\/strong>/);
});
test('reviewer prose renders inline code and bold, never literal backticks', () => {
  const review = { summary: 'Bob handles `a|b` escaped newlines.', perCandidate: [{ agent: 'alice', verdict: 'concerns', notes: 'an odd run of backslashes followed by `n` emits a real newline' }], recommendation: { pick: 'bob', why: 'keeps **parity** with `parseRow`' }, model: 'm' };
  const out = renderToString(h(ReviewBody, { review }));
  assert.match(out, /<code>a\|b<\/code>/); assert.match(out, /<code>n<\/code>/); assert.match(out, /<code>parseRow<\/code>/); assert.match(out, /<strong>parity<\/strong>/);
  assert.doesNotMatch(out, /`/);
});
test('decision narratives keep their text and set IDs, keys and paths as code', () => {
  const { identifiers } = mod;
  const note = 'Chosen:    bob   bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb  signed ed25519:0a1b2c (workers-ai/qwen-coder)\nconflicts: src/table.ts:parseRow';
  const out = renderToString(h('pre', null, identifiers(note)));
  assert.match(out, /<code>bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb<\/code>/); assert.match(out, /<code>ed25519:0a1b2c<\/code>/); assert.match(out, /<code>src\/table.ts:parseRow<\/code>/);
  assert.doesNotMatch(out, /<code>workers-ai/); assert.match(out, /Chosen:    bob   <code>/);
  assert.equal(out.replace(/<\/?(pre|code)>/g, ''), note);
});
test('why narratives fold proof envelopes and review JSON without dropping any byte', () => {
  const proof = JSON.stringify({ publicKey: '6270b86e59ee07994f8d812b879bde7b8a349cd65cb902817f6314e680a6223a', payload: '{"domain":"x"}', signature: 'ab'.repeat(32) });
  const review = JSON.stringify({ summary: 'Model review unavailable.', perCandidate: [] });
  const text = `Heddle decision · task parser-escapes\nChosen:  bob tests 22/22\n    Test proof: ${proof}\n    Review:    reviewer (workers-ai/m): ${review}\nRationale: keep it explicit`;
  const out = renderToString(h(Narrative, { text }));
  assert.match(out, /<details class="proof"><summary>    Test proof · signed · <code>ed25519:6270b86e…<\/code><\/summary>/);
  assert.match(out, /<summary>    Review:    reviewer \(workers-ai\/m\): Model review unavailable.<\/summary>/);
  assert.ok(out.includes(proof.replace(/"/g, '&quot;')) || out.includes(proof), 'full proof JSON stays on the page');
  assert.match(out, /Chosen:  bob tests 22\/22/); assert.match(out, /Rationale: keep it explicit/);
});
