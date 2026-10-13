// SPDX-License-Identifier: Apache-2.0
// The diff endpoint answers text/x-diff. The experiment and revision round read it as text.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { request } from '../../cli/ha.mjs';
import { candidateDiff, regexAdditions, options } from '../lib/harness.mjs';

const patch = 'diff --git a/src/table.ts b/src/table.ts\n--- a/src/table.ts\n+++ b/src/table.ts\n@@ -1,3 +1,3 @@\n+  return text.split(/(?<!\\\\)\\|/);\n';
const seen = [];
const server = createServer((req, res) => {
  seen.push({ url: req.url, auth: req.headers.authorization });
  if (req.url === '/api/projects/demo/tasks/parser-newlines/candidates/briefed-1/diff') { res.writeHead(200, { 'content-type': 'text/x-diff' }); res.end(patch); }
  else { res.writeHead(404); res.end(); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
after(() => server.close());
const opts = options(['--url', `http://127.0.0.1:${server.address().port}`, '--project', 'demo'], 'experiment');

test('a candidate diff is read as text, so the experiment can scan it', async () => {
  const diff = await candidateDiff(opts, 'parser-newlines', 'briefed-1', 'operator-fixture');
  assert.equal(diff, patch);
  assert.deepEqual(regexAdditions(diff), ['return text.split(/(?<!\\\\)\\|/);']);
  assert.deepEqual(seen.at(-1), { url: '/api/projects/demo/tasks/parser-newlines/candidates/briefed-1/diff', auth: 'Bearer operator-fixture' });
});
test('the JSON request helper cannot read it (the crash this fixes)', async () => {
  await assert.rejects(request(`${opts.api}/tasks/parser-newlines/candidates/briefed-1/diff`, 'operator-fixture'), /API returned invalid JSON/);
});
test('a missing candidate diff is an HTTP error, not an empty diff', async () => {
  await assert.rejects(candidateDiff(opts, 'parser-newlines', 'nobody', 'operator-fixture'), e => e.status === 404);
});
