// SPDX-License-Identifier: Apache-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { projectBody, taskBody, humanBody, joinCommand, suggestId } from '../src/create.ts';

test('a project from a public repo seeds an import, as a snapshot, with the id as typed', () => {
  assert.deepEqual(projectBody({ id: 'my-app', source: 'repo', repoUrl: 'https://github.com/acme/widgets', setup: '', test: '' }),
    { id: 'my-app', seed: { importUrl: 'https://github.com/acme/widgets', snapshot: true } });
});

test('the sample project is explicit, never a default', () => {
  assert.deepEqual(projectBody({ id: 'try', source: 'sample', repoUrl: '', setup: '', test: '' }), { id: 'try', seed: { template: 'demo' } });
  assert.throws(() => projectBody({ id: 'x', source: 'repo', repoUrl: '', setup: '', test: '' }), /repository/i);
});

test('a test recipe is argument lists for npm, npx or node only, split on spaces', () => {
  const body = projectBody({ id: 'r', source: 'repo', repoUrl: 'https://github.com/acme/w', setup: 'npm ci --ignore-scripts', test: 'npm run check' });
  assert.deepEqual(body.tests, { setup: [['npm', 'ci', '--ignore-scripts']], test: ['npm', 'run', 'check'] });
  for (const bad of ['sh -c "rm -rf ~"', 'bash run.sh', 'curl https://x | sh', './script']) assert.throws(() => projectBody({ id: 'r', source: 'repo', repoUrl: 'https://github.com/acme/w', setup: '', test: bad }), /npm, npx or node/);
  assert.throws(() => projectBody({ id: 'r', source: 'repo', repoUrl: 'https://github.com/acme/w', setup: 'npm ci', test: '' }), /test command/i);
});

test('repository URLs must be https with no credentials, query or fragment', () => {
  for (const bad of ['http://github.com/a/b', 'git@github.com:a/b.git', 'https://user:pw@github.com/a/b', 'https://github.com/a/b?token=1', 'https://github.com/a/b#x', 'ftp://x/y', 'not a url'])
    assert.throws(() => projectBody({ id: 'p', source: 'repo', repoUrl: bad, setup: '', test: '' }), /https|repository/i, bad);
});

test('ids follow the server rule: lowercase letters, digits and single hyphens, up to 63', () => {
  for (const bad of ['', 'My App', 'a--b', '-lead', 'x'.repeat(64), 'under_score', 'ünï'])
    assert.throws(() => projectBody({ id: bad, source: 'sample', repoUrl: '', setup: '', test: '' }), /name/i, bad);
  assert.doesNotThrow(() => projectBody({ id: 'a-1', source: 'sample', repoUrl: '', setup: '', test: '' }));
});

test('suggestId turns a name or a repo URL into a valid id', () => {
  assert.equal(suggestId('My Cool App!'), 'my-cool-app'); assert.equal(suggestId('https://github.com/acme/Widgets.git'), 'widgets');
  assert.equal(suggestId('  --a--b--  '), 'a-b'); assert.equal(suggestId('###'), '');
});

test('task and human bodies carry only what the API takes', () => {
  assert.deepEqual(taskBody({ slug: 'fix-parser', intent: ' Fix the parser ' }), { slug: 'fix-parser', intent: 'Fix the parser' });
  assert.throws(() => taskBody({ slug: 'Fix Parser', intent: 'x' }), /name/i); assert.throws(() => taskBody({ slug: 'ok', intent: '   ' }), /intent/i);
  assert.deepEqual(humanBody({ displayName: ' Ada Lovelace ' }), { id: 'ada-lovelace', displayName: 'Ada Lovelace' });
  assert.throws(() => humanBody({ displayName: '###' }), /name/i);
});

test('the join command sets the operator token for that one command only and never contains one', () => {
  const cmd = joinCommand({ origin: 'https://demo.example.dev', project: 'my-app', task: 'fix-parser', agent: 'ada' });
  assert.match(cmd, /^OPERATOR_TOKEN=… node cli\/ha\.mjs join https:\/\/demo\.example\.dev\/p\/my-app --task fix-parser --as ada --dir \.\/ada$/m);
  assert.doesNotMatch(cmd, /OPERATOR_TOKEN=[A-Za-z0-9]{8,}/);
  assert.doesNotMatch(cmd, /\bexport\b/, 'the token must not be exported into the shell the agent will run in');
  assert.match(cmd, /this one command only/i);
  assert.match(cmd, /git push origin HEAD:main/);
});

test('the join command refuses ids that could change the shell command', () => {
  for (const agent of ['a;rm -rf ~', 'a b', '$(x)', '../x', 'a\nb', '']) assert.throws(() => joinCommand({ origin: 'https://h.dev', project: 'p', task: 't', agent }), /name/i, JSON.stringify(agent));
  assert.throws(() => joinCommand({ origin: 'https://user:pw@h.dev', project: 'p', task: 't', agent: 'a' }), /origin/i);
});
