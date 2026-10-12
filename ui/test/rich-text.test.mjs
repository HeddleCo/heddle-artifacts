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
const { RichText, ReviewBody, parseReview } = await import(pathToFileURL(join(temp, 'rich.mjs')));
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
