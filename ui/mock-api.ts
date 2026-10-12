// SPDX-License-Identifier: Apache-2.0
// LOCAL TEST HARNESS ONLY. Never import this file from the production Worker.
import pushing from './fixtures/pushing.json';
import conflict from './fixtures/conflict.json';
import decided from './fixtures/decided.json';
import type { FeedEvent, Decision, Turn } from '../contracts/types';
import type { ProjectView, TaskView } from './src/api';
import { updateBoard } from './src/feed';
const fixtures = { pushing, conflict, decided };
const diffs: Record<string, string> = {
  alice: 'diff --git a/src/table.ts b/src/table.ts\n--- a/src/table.ts\n+++ b/src/table.ts\n@@ -4,2 +4,3 @@ parseRow\n-export function parseRow(row: string): string[] {\n-  return row.split("|");\n+export function parseRow(row: string): { cells: string[] } {\n+  return { cells: row.split(/(?<!\\\\)\\|/) };\n+}\n',
  bob: 'diff --git a/src/table.ts b/src/table.ts\n--- a/src/table.ts\n+++ b/src/table.ts\n@@ -4,2 +4,8 @@ parseRow\n export function parseRow(row: string): string[] {\n-  return row.split("|");\n+  const cells: string[] = [];\n+  let cell = "", escaped = false;\n+  for (const char of row) {\n+    if (escaped) { cell += char; escaped = false; }\n+    else if (char === "\\\\") escaped = true;\n+    else if (char === "|") { cells.push(cell); cell = ""; }\n+    else cell += char;\n+  }\n+  return [...cells, cell];\n }\n',
  carol: 'diff --git a/README.md b/README.md\n--- a/README.md\n+++ b/README.md\n@@ -1 +1,3 @@\n # Table parser\n+Use \\| to include a pipe in a cell.\n+Example: parseRow("one\\|two|three").\n'
};
export function createMock(initial = 'conflict') {
  let state = structuredClone(fixtures[initial as keyof typeof fixtures] || conflict);
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
      const body = await request.json() as { fixture: keyof typeof fixtures; decisionStatus?: number; pendingPublication?: boolean };
      if (!fixtures[body.fixture]) return json({ error: 'unknown fixture' }, 400);
      state = structuredClone(fixtures[body.fixture]); decisionStatus = body.decisionStatus || 200; requests.length = 0;
      if (body.pendingPublication) { state.tasks[0].decision = { ...decided.tasks[0].decision!, mainSha: '' }; state.tasks[0].status = 'reviewing'; }
      return json({ ok: true });
    }
    if (pathname === '/__mock/decision-status' && request.method === 'POST') {
      decisionStatus = (await request.json() as { decisionStatus: number }).decisionStatus; return json({ ok: true });
    }
    if (pathname === '/__mock/requests') return json(requests);
    if (!pathname.startsWith('/api/')) return;
    const parts = pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts[0] !== 'api' || parts[1] !== 'projects' || parts[2] !== 'demo') return json({ error: 'not_found' }, 404);
    if (parts.length === 3 && request.method === 'GET') return json({ project: state.project, agents: state.agents, tasks: state.tasks });
    if (parts[3] === 'why' && parts.length === 5) return parts[4] === state.why.sha ? json(state.why) : json({ error: 'not_found' }, 404);
    if (parts[3] !== 'tasks') return json({ error: 'not_found' }, 404);
    const slug = parts[4], task = taskView(slug);
    if (!task) return json({ error: 'not_found' }, 404);
    if (parts.length === 5 && request.method === 'GET') return json(task);
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
        const decision: Decision = existing ?? { ...decided.tasks[0].decision!, mainSha: '', task: slug, pick: body.pick as string, rationale: body.rationale, decider: body.decider as string, alternatives: task.candidates.filter(c => c.agent !== body.pick).map(c => c.agent) };
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
