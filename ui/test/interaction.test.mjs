// SPDX-License-Identifier: Apache-2.0
// Actual component-handler/effect regressions with controlled hooks. No DOM/browser acceptance claim.
import { test, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { components, mount, nodes, one, button, textOf, deferred, flush, submitEvent, FakeSocket } from './helpers/component-harness.mjs';
const { Board, Compare, Discussion, cleanup } = await components();
after(cleanup);
const fixture = JSON.parse(await readFile(new URL('../fixtures/conflict.json', import.meta.url), 'utf8'));
const taskPath = '/api/projects/demo/tasks/parser-escapes';
const project = () => structuredClone({ project: fixture.project, tasks: fixture.tasks, agents: fixture.agents });
const task = () => { const t = structuredClone(fixture.tasks[0]); return { task: { slug: t.slug, intent: t.intent, status: t.status }, candidates: t.candidates, turns: fixture.turns, heads: t.candidates.map(c => c.state) }; };
let calls, root, handler;
const saved = { fetch: globalThis.fetch, location: globalThis.location, WebSocket: globalThis.WebSocket };
beforeEach(() => {
  calls = []; FakeSocket.all = [];
  globalThis.location = { protocol: 'http:', host: 'fixture.invalid' };
  globalThis.WebSocket = FakeSocket;
  handler = async (url, options) => Response.json(url === taskPath ? task() : project());
  globalThis.fetch = async (url, options = {}) => { calls.push({ url, options }); return handler(url, options); };
});
afterEach(() => { root?.unmount(); root = undefined; Object.assign(globalThis, saved); delete globalThis.__componentHooks; });
const posts = () => calls.filter(c => c.options.method === 'POST');
async function compare() { root = mount(Compare, { p: 'demo', t: 'parser-escapes' }); FakeSocket.all[0].open(); await flush(root); return root; }
function choose() {
  one(root, n => n.type === 'input' && n.props.value === 'bob').props.onChange();
  one(root, n => n.type === 'textarea').props.onInput({ currentTarget: { value: 'Preserve the public API.' } }); root.render();
  return one(root, n => n.type === 'form').props.onSubmit;
}
test('board and compare label isolated sandbox test provenance', async () => {
  const p = project(), v = task();
  p.tasks[0].candidates[0].tests.provenance = 'isolated sandbox';
  v.candidates[0].tests.provenance = 'isolated sandbox';
  handler = async url => Response.json(url === taskPath ? v : p);
  root = mount(Board, { p: 'demo' }); FakeSocket.all[0].open(); await flush(root);
  const badges = () => nodes(root.tree, n => typeof n.type === 'function' && n.type.name === 'Badge').map(n => textOf(n.type(n.props))).join(' ');
  assert.match(badges(), /isolated sandbox/); root.unmount();
  await compare(); assert.match(badges(), /isolated sandbox/);
});
test('discussion: two same-turn submits produce one signed reply', async () => {
  const gate = deferred(); handler = () => gate.promise;
  root = mount(Discussion, { p: 'demo', t: 'parser-escapes', turns: [], humans: fixture.agents.filter(a => a.kind === 'human'), onTurn() {} });
  one(root, n => n.type === 'textarea').props.onInput({ currentTarget: { value: 'Keep the API stable.' } }); root.render();
  const submit = one(root, n => n.type === 'form').props.onSubmit;
  const first = submit(submitEvent()), second = submit(submitEvent());
  const count = posts().length; gate.resolve(Response.json({ id: 'reply' })); await Promise.all([first, second]);
  assert.equal(count, 1);
});
test('board: repeated refresh is single-flight and retains buffered events', async () => {
  root = mount(Board, { p: 'demo' }); FakeSocket.all[0].open(); await flush(root); calls.length = 0;
  const gate = deferred(); handler = () => gate.promise;
  const refresh = button(root, 'Refresh board').props.onClick;
  const first = refresh();
  FakeSocket.all[0].emit({ type: 'candidate.ready', candidate: { ...task().candidates[1], subject: 'Fresh buffered candidate' } });
  const second = refresh(); const count = calls.length;
  gate.resolve(Response.json(project())); await Promise.all([first, second]); await flush(root);
  assert.equal(count, 1); assert.match(textOf(root.tree), /Fresh buffered candidate/);
});
test('compare: disconnect blocks even a pre-render submit', async () => {
  await compare(); const submit = choose(); FakeSocket.all[0].disconnect();
  await submit(submitEvent()); assert.equal(posts().length, 0);
  root.render(); assert.equal(button(root, 'Land candidate →').props.disabled, true);
});
test('compare: candidate arrival invalidates same-turn selection', async () => {
  await compare(); const submit = choose();
  FakeSocket.all[0].emit({ type: 'candidate.ready', candidate: { ...task().candidates[1], state: 'state-bob-2' } });
  await submit(submitEvent()); assert.equal(posts().length, 0);
});
test('compare: repeated review is single-flight', async () => {
  await compare(); FakeSocket.all[0].emit({ type: 'candidate.ready', candidate: task().candidates[1] }); root.render(); calls.length = 0;
  const gate = deferred(); handler = async url => { await gate.promise; return Response.json(url === taskPath ? task() : project()); };
  const review = button(root, 'Review current candidates').props.onClick;
  const first = review(), second = review(); const count = calls.length; gate.resolve(); await Promise.all([first, second]); await flush(root);
  assert.equal(count, 2);
});
test('compare: disconnect during review cannot clear the stale guard', async () => {
  await compare(); FakeSocket.all[0].emit({ type: 'candidate.ready', candidate: task().candidates[1] }); root.render();
  const gate = deferred(); handler = async url => { await gate.promise; return Response.json(url === taskPath ? task() : project()); };
  const review = button(root, 'Review current candidates').props.onClick(); FakeSocket.all[0].disconnect(); gate.resolve(); await review; await flush(root);
  const submit = choose(); await submit(submitEvent()); assert.equal(posts().length, 0);
  assert.equal(button(root, 'Land candidate →').props.disabled, true);
});
test('navigation: late socket callbacks after unmount cannot reload old board', async () => {
  root = mount(Board, { p: 'demo' }); await flush(root); const socket = FakeSocket.all[0]; root.unmount(); root = undefined; calls.length = 0;
  socket.open(); socket.emit({ type: 'push.received', task: 'parser-escapes', agent: 'bob', sha: 'f'.repeat(40) });
  await flush(); assert.equal(calls.length, 0);
});

test('discussion: busy fields preserve the submitted draft and a failed post is retryable', async () => {
  const gate = deferred(); handler = () => gate.promise;
  root = mount(Discussion, { p: 'demo', t: 'parser-escapes', turns: [], humans: fixture.agents.filter(a => a.kind === 'human'), onTurn() {} });
  one(root, n => n.type === 'textarea').props.onInput({ currentTarget: { value: 'Keep this draft.' } }); root.render();
  const posting = one(root, n => n.type === 'form').props.onSubmit(submitEvent()); root.render();
  assert.equal(one(root, n => n.type === 'textarea').props.disabled, true);
  assert.equal(one(root, n => n.type === 'select').props.disabled, true);
  gate.reject(new TypeError('Network interrupted')); await posting; await flush(root);
  assert.equal(one(root, n => n.type === 'textarea').props.value, 'Keep this draft.');
  assert.equal(button(root, 'Post signed reply').props.disabled, false);
  handler = async () => Response.json({ id: 'reply' }); await one(root, n => n.type === 'form').props.onSubmit(submitEvent()); await flush(root);
  assert.equal(posts().length, 2); assert.equal(one(root, n => n.type === 'textarea').props.value, '');
});
test('compare: publication interruption plus failed read stays locked until recorded choice is recovered', async () => {
  await compare(); const submit = choose(); let saved, failRead = true;
  handler = async (url, options) => {
    if (options.method === 'POST') { saved = JSON.parse(options.body); throw new TypeError('Response lost after recording'); }
    if (url === taskPath && failRead) return Response.json({ error: 'unavailable' }, { status: 503 });
    return Response.json(url === taskPath ? { ...task(), decision: { ...saved, task: 'parser-escapes', mainSha: '' } } : project());
  };
  await submit(submitEvent()); await flush(root);
  assert.equal(button(root, 'Land candidate →').props.disabled, true);
  await one(root, n => n.type === 'form').props.onSubmit(submitEvent()); assert.equal(posts().length, 1);
  failRead = false; await button(root, 'Review current candidates').props.onClick(); await flush(root);
  assert.equal(one(root, n => n.type === 'textarea').props.value, saved.rationale);
  assert.equal(one(root, n => n.type === 'fieldset').props.disabled, true);
  assert.equal(button(root, 'Retry publication').props.disabled, false);
  handler = async (url, options) => Response.json({ ...JSON.parse(options.body), task: 'parser-escapes', mainSha: 'f'.repeat(40) });
  await one(root, n => n.type === 'form').props.onSubmit(submitEvent()); await flush(root);
  assert.deepEqual(JSON.parse(posts()[1].options.body), saved);
  assert.equal(button(root, 'Decision landed').props.disabled, true);
});
test('compare: reconnect requires explicit review and clears the previous selection', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await compare(); choose(); const original = FakeSocket.all[0]; original.disconnect(); context.mock.timers.tick(1000);
  assert.equal(FakeSocket.all.length, 2); FakeSocket.all[1].open(); root.render();
  assert.equal(button(root, 'Land candidate →').props.disabled, true);
  const current = task(); current.candidates[1].state = 'state-bob-2'; current.heads[1] = 'state-bob-2';
  handler = async url => Response.json(url === taskPath ? current : project());
  await button(root, 'Review current candidates').props.onClick(); await flush(root);
  assert.equal(one(root, n => n.type === 'input' && n.props.value === 'bob').props.checked, false);
  assert.equal(button(root, 'Land candidate →').props.disabled, true);
  const submit = choose(); handler = async () => Response.json({ task: 'parser-escapes', pick: 'bob', mainSha: 'f'.repeat(40) });
  await submit(submitEvent()); assert.deepEqual(JSON.parse(posts()[0].options.body).expectHeads, current.heads);
});
test('compare: an obsolete socket cannot invalidate a newly reviewed connection', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await compare(); const original = FakeSocket.all[0]; original.disconnect(); context.mock.timers.tick(1000); FakeSocket.all[1].open(); root.render();
  await button(root, 'Review current candidates').props.onClick(); await flush(root); choose();
  original.error(); original.emit({ type: 'candidate.ready', candidate: task().candidates[1] }); original.disconnect(); root.render();
  assert.equal(button(root, 'Land candidate →').props.disabled, false);
  context.mock.timers.tick(15000); assert.equal(FakeSocket.all.length, 2);
});
test('board: connection opening during a snapshot queues one fresh post-subscription read', async () => {
  const gate = deferred(); let reads = 0;
  handler = async () => { if (++reads === 1) { await gate.promise; return Response.json(project()); } const current = project(); current.tasks[0].intent = 'Updated before subscription'; return Response.json(current); };
  root = mount(Board, { p: 'demo' }); FakeSocket.all[0].open(); assert.equal(calls.length, 1);
  gate.resolve(); await flush(root); await flush(root);
  assert.equal(calls.length, 2); assert.match(textOf(root.tree), /Updated before subscription/);
});
test('compare: connection opening after hydration invalidates until fresh snapshot completes', async () => {
  root = mount(Compare, { p: 'demo', t: 'parser-escapes' }); await flush(root); const submit = choose();
  const gate = deferred(); handler = async url => { await gate.promise; return Response.json(url === taskPath ? task() : project()); };
  FakeSocket.all[0].open(); await submit(submitEvent()); assert.equal(posts().length, 0);
  gate.resolve(); await flush(root); assert.equal(one(root, n => n.type === 'input' && n.props.value === 'bob').props.checked, false);
});
test('compare: a landed event blocks a pre-render repeat of the previous draft', async () => {
  await compare(); const submit = choose();
  FakeSocket.all[0].emit({ type: 'decision.landed', decision: { task: 'parser-escapes', pick: 'bob', mainSha: 'f'.repeat(40) } });
  await submit(submitEvent()); assert.equal(posts().length, 0);
});
test('navigation: cleanup cancels reconnect timers and late responses do not schedule new loads', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const gate = deferred(); handler = () => gate.promise;
  root = mount(Board, { p: 'demo' }); const socket = FakeSocket.all[0]; socket.open(); socket.disconnect(); root.unmount(); root = undefined;
  gate.resolve(Response.json(project())); await flush(); context.mock.timers.tick(30000);
  socket.open(); socket.error(); socket.disconnect(); await flush();
  assert.equal(FakeSocket.all.length, 1); assert.equal(calls.length, 1);
});
test('compare: initial snapshot cannot unlock while waiting for the first subscription', async () => {
  root = mount(Compare, { p: 'demo', t: 'parser-escapes' }); await flush(root); const submit = choose();
  await submit(submitEvent()); assert.equal(posts().length, 0);
  assert.equal(button(root, 'Land candidate →').props.disabled, true);
});
test('compare: first subscription during an old snapshot waits for one fresh read', async () => {
  const gate = deferred(); let reads = 0;
  const current = task(); current.candidates[1].state = 'state-bob-before-open'; current.heads[1] = 'state-bob-before-open';
  handler = async url => { if (url !== taskPath) return Response.json(project()); if (++reads === 1) { await gate.promise; return Response.json(task()); } return Response.json(current); };
  root = mount(Compare, { p: 'demo', t: 'parser-escapes' }); FakeSocket.all[0].open(); gate.resolve(); await flush(root); await flush(root);
  assert.equal(reads, 2); const submit = choose();
  handler = async () => Response.json({ task: 'parser-escapes', pick: 'bob', mainSha: 'f'.repeat(40) });
  await submit(submitEvent()); assert.deepEqual(JSON.parse(posts()[0].options.body).expectHeads, current.heads);
});
test('navigation: board project change starts a new load and ignores the old response', async () => {
  const gate = deferred(); handler = async url => { if (url === '/api/projects/demo') { await gate.promise; return Response.json(project()); } return Response.json({ ...project(), tasks: [] }); };
  root = mount(Board, { p: 'demo' }); root.render({ p: 'another-project' }); await flush(root);
  assert.equal(calls.filter(c => c.url === '/api/projects/another-project').length, 1);
  gate.resolve(); await flush(root); assert.match(textOf(root.tree), /No tasks yet/); assert.doesNotMatch(textOf(root.tree), /parser-escapes/);
});
test('navigation: compare task change clears the draft and ignores a late publication response', async () => {
  await compare(); const submit = choose(); const gate = deferred();
  handler = async (url, options) => {
    if (options.method === 'POST') { await gate.promise; return Response.json({ task: 'parser-escapes', pick: 'bob', mainSha: 'f'.repeat(40) }); }
    return Response.json(url.endsWith('/tasks/docs') ? { ...task(), task: { slug: 'docs', intent: 'Documentation', status: 'open' } } : project());
  };
  const posting = submit(submitEvent()); root.render({ p: 'demo', t: 'docs' }); await flush(root);
  assert.equal(calls.filter(c => c.url.endsWith('/tasks/docs')).length, 1);
  gate.resolve(); await posting; await flush(root);
  assert.equal(one(root, n => n.type === 'textarea').props.value, '');
  assert.equal(button(root, 'Land candidate →').props.disabled, true); assert.doesNotMatch(textOf(root.tree), /Recorded decision/);
});
test('navigation: an old discussion response cannot append a turn after unmount', async () => {
  const gate = deferred(), turns = []; handler = () => gate.promise;
  root = mount(Discussion, { p: 'demo', t: 'parser-escapes', turns: [], humans: fixture.agents.filter(a => a.kind === 'human'), onTurn: turn => turns.push(turn) });
  one(root, n => n.type === 'textarea').props.onInput({ currentTarget: { value: 'Old task reply' } }); root.render();
  const posting = one(root, n => n.type === 'form').props.onSubmit(submitEvent()); root.unmount(); root = undefined;
  gate.resolve(Response.json({ id: 'old-turn', task: 'parser-escapes' })); await posting;
  assert.deepEqual(turns, []);
});
test('navigation: an interrupted old recovery read cannot show its error on a newer task', async () => {
  await compare(); const submit = choose(), gate = deferred(); let recovering = false;
  handler = async (url, options) => {
    if (options.method === 'POST') throw new TypeError('Response interrupted');
    if (url === taskPath) { recovering = true; await gate.promise; return Response.json(task()); }
    return Response.json(url.endsWith('/tasks/docs') ? { ...task(), task: { slug: 'docs', intent: 'Documentation', status: 'open' } } : project());
  };
  const posting = submit(submitEvent()); await flush(root); assert.equal(recovering, true);
  root.render({ p: 'demo', t: 'docs' }); await flush(root); gate.resolve(); await posting; await flush(root);
  assert.equal(nodes(root.tree, n => n.type?.name === 'ErrorNotice').length, 0);
});
test('compare: malformed live message reconnects and a fresh review restores decision access', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  await compare(); choose(); const socket = FakeSocket.all[0]; socket.onmessage({ data: '{bad-json' });
  assert.equal(socket.closed, true); socket.disconnect(); context.mock.timers.tick(1000); FakeSocket.all[1].open(); root.render();
  assert.equal(button(root, 'Land candidate →').props.disabled, true);
  await button(root, 'Review current candidates').props.onClick(); await flush(root); choose();
  assert.equal(button(root, 'Land candidate →').props.disabled, false);
});
