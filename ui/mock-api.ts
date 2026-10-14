// SPDX-License-Identifier: Apache-2.0
// LOCAL TEST HARNESS ONLY. Never import this file from the production Worker.
import pushing from './fixtures/pushing.json';
import conflict from './fixtures/conflict.json';
import decided from './fixtures/decided.json';
import type { Capture, CaptureHistory, FeedEvent, Decision, Lane, Turn } from '../contracts/types';
import type { ProjectView, TaskView } from './src/api';
import { updateBoard } from './src/feed';
const fixtures = { pushing, conflict, decided };
// When the engine opened each lane; carol's lane predates openedAt and has none.
const openedAt: Record<string, string> = { 'parser-escapes/alice': '2026-10-10T18:10:00Z', 'parser-escapes/bob': '2026-10-10T18:12:00Z' };
const diffs: Record<string, string> = {
  alice: 'diff --git a/src/table.ts b/src/table.ts\n--- a/src/table.ts\n+++ b/src/table.ts\n@@ -4,2 +4,3 @@ parseRow\n-export function parseRow(row: string): string[] {\n-  return row.split("|");\n+export function parseRow(row: string): { cells: string[] } {\n+  return { cells: row.split(/(?<!\\\\)\\|/) };\n+}\n',
  bob: 'diff --git a/src/table.ts b/src/table.ts\n--- a/src/table.ts\n+++ b/src/table.ts\n@@ -4,2 +4,8 @@ parseRow\n export function parseRow(row: string): string[] {\n-  return row.split("|");\n+  const cells: string[] = [];\n+  let cell = "", escaped = false;\n+  for (const char of row) {\n+    if (escaped) { cell += char; escaped = false; }\n+    else if (char === "\\\\") escaped = true;\n+    else if (char === "|") { cells.push(cell); cell = ""; }\n+    else cell += char;\n+  }\n+  return [...cells, cell];\n }\n',
  carol: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,3 @@\n # Table parser\n+Use \\| to include a pipe in a cell.\n+Example: parseRow("one\\|two|three").\n'
};
export function createMock(initial = 'conflict') {
  let state = structuredClone(fixtures[initial as keyof typeof fixtures] || conflict);
  const makeHistories = () => {
    const histories: Record<string, Capture[]> = {};
    for (const task of state.tasks) for (const lane of task.lanes as Lane[]) {
      // alice was briefed with no earlier decisions (no tag), bob is the control, carol started from one decision.
      if (lane.agent === 'alice') lane.briefing = { hash: 'e'.repeat(64), annotations: [], omitted: 0 };
      if (lane.agent === 'bob') lane.unbriefed = true;
      if (lane.agent === 'carol') lane.briefing = { hash: 'd'.repeat(64), omitted: 0, annotations: [{ target: 'src/table.ts', scope: 'file', annotationId: 'ann-fixture', revisionId: 'rev-fixture', kind: 'rationale', content: 'Document the escaped-pipe syntax next to parseRow.', attribution: 'luke' }] };
    }
    for (const task of state.tasks) for (const c of task.candidates) {
      histories[`${task.slug}/${c.agent}`] = c.agent === 'alice' ? [
        { ...structuredClone(c), sourceSha: '1'.repeat(40), state: 'state-alice-early', subject: 'Add the row parser', capturedAt: '2026-10-10T18:14:00Z', fromState: 'state-base', semantic: { status: 'ready', changes: [{ change_type: 'function_added', description: 'Function added: parseRow in src/table.ts', new_name: 'parseRow' }] } },
        { ...structuredClone(c), sourceSha: '2'.repeat(40), state: 'state-alice-middle', subject: 'Handle escaped pipes', capturedAt: '2026-10-10T18:15:00Z', fromState: 'state-alice-early', semantic: { status: 'unavailable' } },
        { ...structuredClone(c), capturedAt: '2026-10-10T18:16:00Z', fromState: 'state-alice-middle', semantic: { status: 'ready', changes: [{ change_type: 'function_modified', description: 'Function modified: parseRow in src/table.ts', old_name: 'parseRow' }] } }
      ] : c.agent === 'bob' ? [
        { ...structuredClone(c), sourceSha: '3'.repeat(40), state: 'state-bob-early', subject: 'Keep the public API', capturedAt: '2026-10-10T18:14:30Z', fromState: 'state-base', semantic: { status: 'ready', changes: [{ change_type: 'function_modified', description: 'Function modified: parseRow in src/table.ts', old_name: 'parseRow' }] } },
        { ...structuredClone(c), capturedAt: '2026-10-10T18:15:30Z', fromState: 'state-bob-early', semantic: { status: 'ready', changes: [{ change_type: 'function_modified', description: 'Function modified: parseRow in src/table.ts', old_name: 'parseRow' }] } }
      ] : [{ ...structuredClone(c), fromState: 'state-base', semantic: { status: 'ready', changes: [] } }];
    }
    return histories;
  };
  let histories = makeHistories();
  let decisionStatus = 200;
  const requests: { path: string; body: unknown }[] = [];
  const json = (value: unknown, status = 200) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store' } });
  const taskView = (slug: string): TaskView | undefined => {
    const task = state.tasks.find(t => t.slug === slug);
    if (!task) return;
    return { task: { slug, intent: task.intent, status: task.status }, candidates: task.candidates,
      turns: state.turns.filter(t => t.task === slug), ...(slug === 'parser-escapes' && state.review ? { review: state.review } : {}),
      ...(task.decision ? { decision: task.decision } : {}), heads: task.candidates.map(c => c.state) };
  };
  const apply = (event: FeedEvent) => {
    if (event.type === 'tests.done') {
      const list = histories[`${event.task}/${event.agent}`] ?? [];
      const capture = event.sourceSha ? list.find(c => c.sourceSha === event.sourceSha) : list.at(-1);
      if (capture) capture.tests = event.tests;
    }
    if (event.type === 'candidate.ready') {
      const c = event.candidate, name = `${c.task}/${c.agent}`, list = histories[name] ??= [], existing = list.find(x => x.sourceSha === c.sourceSha);
      if (existing) Object.assign(existing, c);
      else list.push({ ...c, fromState: list.at(-1)?.state ?? 'state-base', semantic: { status: 'ready', changes: [{ change_type: 'function_modified', description: 'Function modified: parseRow in src/table.ts' }] } });
    }
    const board = updateBoard(state as ProjectView, event);
    state.tasks = board.tasks as typeof state.tasks;
    if (event.type === 'review.posted') state.review = event.review;
    if (event.type === 'review.posted' || event.type === 'discussion.posted') state.turns = [...state.turns.filter(t => t.id !== event.turn.id), event.turn] as typeof state.turns;
  };
  const handle = async (request: Request): Promise<Response | undefined> => {
    const { pathname } = new URL(request.url);
    if (pathname === '/login' && request.method === 'POST') {
      const body = await request.formData();
      if (body.get('token') !== 'fixture-operator') return new Response('Fixture login requires fixture-operator.', { status: 403 });
      return new Response(null, { status: 303, headers: { Location: '/p/demo', 'Set-Cookie': 'fixture_session=local; HttpOnly; SameSite=Strict; Path=/' } });
    }
    if (pathname === '/__mock/reset' && request.method === 'POST') {
      const body = await request.json() as { fixture: keyof typeof fixtures; decisionStatus?: number; pendingPublication?: boolean; noHumans?: boolean };
      if (!fixtures[body.fixture]) return json({ error: 'unknown fixture' }, 400);
      state = structuredClone(fixtures[body.fixture]); decisionStatus = body.decisionStatus || 200; requests.length = 0;
      histories = makeHistories();
      if (body.noHumans) state.agents = state.agents.filter(a => a.kind !== 'human');
      if (body.pendingPublication) { state.tasks[0].decision = { ...decided.tasks[0].decision!, mainSha: '' }; state.tasks[0].status = 'reviewing'; }
      return json({ ok: true });
    }
    if (pathname === '/__mock/decision-status' && request.method === 'POST') {
      decisionStatus = (await request.json() as { decisionStatus: number }).decisionStatus; return json({ ok: true });
    }
    if (pathname === '/__mock/requests') return json(requests);
    if (!pathname.startsWith('/api/')) return;
    // Operator surface, as the real Worker has it: /api/session answers one boolean; creating things needs the operator session.
    const isOperator = /(?:^|;\s*)fixture_session=local(?:;|$)/.test(request.headers.get('cookie') ?? '');
    if (pathname === '/api/session') return request.method === 'GET' ? json({ operator: isOperator, demo: 'demo' }) : new Response(null, { status: 405 });
    if (request.method === 'POST' && (pathname === '/api/projects' || /^\/api\/projects\/[^/]+\/(tasks|humans)$/.test(pathname))) {
      const body = await request.json().catch(() => ({})) as Record<string, any>;
      if (!isOperator) return json({ error: 'forbidden' }, 403); requests.push({ path: pathname, body });
      if (pathname.endsWith('/tasks')) { if (state.tasks.some(t => t.slug === body.slug)) return json({ error: 'task_exists' }, 409); state.tasks.push({ slug: body.slug, intent: body.intent, status: 'open', lanes: [], candidates: [] } as typeof state.tasks[number]); return json({ slug: body.slug }); }
      if (pathname.endsWith('/humans')) { state.agents.push({ id: body.id, kind: 'human', displayName: body.displayName, publicKey: `fixture-key-${body.id}` } as typeof state.agents[number]); return json({ id: body.id, publicKey: `fixture-key-${body.id}` }); }
      return json({ project: body.id });
    }
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'api' || parts[1] !== 'projects' || parts[2] !== 'demo') return json({ error: 'not_found' }, 404);
    if (parts.length === 3 && request.method === 'GET') return json({ project: state.project, agents: state.agents, tasks: state.tasks });
    if (parts[3] === 'why' && parts.length === 5) return parts[4] === state.why.sha ? json(state.why) : json({ error: 'not_found' }, 404);
    if (parts[3] !== 'tasks') return json({ error: 'not_found' }, 404);
    const slug = parts[4], task = taskView(slug);
    if (!task) return json({ error: 'not_found' }, 404);
    if (parts.length === 5 && request.method === 'GET') return json(task);
    if (parts.length === 6 && parts[5] === 'captures' && request.method === 'GET') {
      const lanes = state.tasks.find(t => t.slug === slug)!.lanes.filter(l => state.agents.find(a => a.id === l.agent)?.kind !== 'reviewer').map(l => ({ agent: l.agent, ...(openedAt[`${slug}/${l.agent}`] ? { openedAt: openedAt[`${slug}/${l.agent}`] } : {}), captures: (histories[`${slug}/${l.agent}`] ?? []).toSorted((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt)) }));
      return json({ task: slug, lanes, pending: 0 } satisfies CaptureHistory);
    }
    if (parts[5] === 'candidates' && parts[7] === 'diff' && task.candidates.some(c => c.agent === parts[6])) return new Response(diffs[parts[6]] || '', { headers: { 'Content-Type': 'text/x-diff' } });
    if (request.method === 'POST' && (parts[5] === 'decision' || parts[5] === 'turns')) {
      const body = await request.json() as Record<string, unknown>;
      requests.push({ path: pathname, body });
      if (parts[5] === 'decision') {
        if (decisionStatus === 403) return json({ error: 'forbidden' }, 403);
        if (decisionStatus === 409 || JSON.stringify(body.expectHeads) !== JSON.stringify(task.heads)) return json({ error: 'stale', heads: [...task.heads, 'new-state'] }, 409);
        if (!task.candidates.some(c => c.agent === body.pick) || typeof body.rationale !== 'string' || !body.rationale.trim() || !state.agents.some(a => a.kind === 'human' && a.id === body.decider)) return json({ error: 'invalid_decision' }, 400);
        const existing = state.tasks.find(t => t.slug === slug)?.decision;
        if (existing && (existing.pick !== body.pick || existing.decider !== body.decider || existing.rationale !== body.rationale)) return json({ error: 'decision_in_progress' }, 409);
        if (existing?.mainSha) return json({ error: 'task_decided' }, 409);
        const decision: Decision = existing ?? { ...decided.tasks[0].decision!, mainSha: '', task: slug, pick: body.pick as string, rationale: body.rationale, ...(body.anchor !== undefined ? { anchor: body.anchor as string } : {}), ...(body.tags !== undefined ? { tags: body.tags as string[] } : {}), decider: body.decider as string, alternatives: task.candidates.filter(c => c.agent !== body.pick).map(c => c.agent) };
        if (decisionStatus >= 500) {
          state.tasks.find(t => t.slug === slug)!.decision = decision;
          return json({ error: 'engine_failure' }, decisionStatus);
        }
        decision.mainSha = decided.tasks[0].decision!.mainSha;
        apply({ type: 'decision.landed', decision }); state.why.decision = decision;
        return json(decision);
      }
      if (typeof body.body !== 'string' || !body.body.trim()) return json({ error: 'empty_turn' }, 400);
      const author = state.agents.find(a => a.id === body.as && a.kind === 'human');
      if (!author) return json({ error: 'unknown_author' }, 400);
      const turn: Turn = { id: `turn-${requests.length}`, task: slug, author: author.id, kind: 'human', body: body.body,
        ...(typeof body.replyTo === 'string' ? { replyTo: body.replyTo } : {}), heddleDiscussion: 'fixture-discussion', signedBy: author.publicKey, at: new Date().toISOString() };
      apply({ type: 'discussion.posted', turn }); return json(turn);
    }
    return json({ error: 'not_found' }, 404);
  };
  return { handle, apply };
}
