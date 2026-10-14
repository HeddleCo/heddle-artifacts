// SPDX-License-Identifier: Apache-2.0
import { useEffect, useState } from 'preact/hooks';
import type { Agent } from '../../contracts/types';
import { ApiError, projectPath, request } from './api';
import { humanBody, joinCommand, projectBody, suggestId, taskBody, validId } from './create';
import type { ProjectForm } from './create';

// One answer per page load: operators see the create forms, everyone else (judges on the public demo included) does not.
let session: Promise<boolean> | undefined;
export function useOperator(): boolean {
  const [operator, setOperator] = useState(false);
  useEffect(() => {
    session ??= fetch('/api/session', { credentials: 'same-origin' }).then(r => r.ok ? r.json() as Promise<{ operator?: unknown }> : { operator: false }).then(b => b.operator === true).catch(() => false);
    let live = true; void session.then(v => { if (live) setOperator(v); });
    return () => { live = false; };
  }, []);
  return operator;
}
const say = (e: unknown) => e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Could not reach the server. Try again.';

export function NewProject() {
  const [form, setForm] = useState<ProjectForm & { name: string }>({ id: '', source: 'repo', repoUrl: '', setup: '', test: '', name: '' });
  const [idTouched, setIdTouched] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const set = (patch: Partial<typeof form>) => setForm(f => ({ ...f, ...patch }));
  const submit = async (e: Event) => {
    e.preventDefault(); if (busy) return; setError('');
    let body, human;
    try { body = projectBody(form); human = humanBody({ displayName: form.name }); } catch (err) { setError(say(err)); return; }
    setBusy(true);
    try {
      await request('/api/projects', body);
      await request(`${projectPath(body.id)}/humans`, human);
      location.assign(`/p/${encodeURIComponent(body.id)}`);
    } catch (err) { setError(say(err)); setBusy(false); }
  };
  return <form class="panel create-form" onSubmit={submit} aria-label="New project">
    <h2>New project</h2>
    <fieldset disabled={busy}><legend>Start from</legend>
      <label class="radio"><input type="radio" name="source" checked={form.source === 'repo'} onChange={() => set({ source: 'repo' })}/> A public repository</label>
      <label class="radio"><input type="radio" name="source" checked={form.source === 'sample'} onChange={() => set({ source: 'sample' })}/> The sample project (a small Markdown-table parser)</label>
    </fieldset>
    {form.source === 'repo' && <>
      <label>Repository address<input value={form.repoUrl} placeholder="https://github.com/you/your-repo" inputMode="url" onInput={e => { const repoUrl = e.currentTarget.value; set({ repoUrl, ...(idTouched ? {} : { id: suggestId(repoUrl) }) }); }} disabled={busy}/></label>
      <p class="muted">Heddle imports the current files as one starting commit. Only public https addresses.</p>
      <label>Test command<input value={form.test} placeholder="npm test" onInput={e => set({ test: e.currentTarget.value })} disabled={busy}/></label>
      <label>Setup command <span class="muted">(optional, runs first)</span><input value={form.setup} placeholder="npm ci" onInput={e => set({ setup: e.currentTarget.value })} disabled={busy}/></label>
      <p class="muted">Candidates are tested with these. npm, npx and node only; leave both empty to use <code>npm ci</code> then <code>npm test</code>.</p>
    </>}
    <label>Project name<input value={form.id} onInput={e => { setIdTouched(true); set({ id: e.currentTarget.value }); }} aria-invalid={!!form.id && !validId(form.id)} disabled={busy}/></label>
    <label>Your name <span class="muted">(shown next to your decisions)</span><input value={form.name} onInput={e => set({ name: e.currentTarget.value })} disabled={busy}/></label>
    {error && <p class="notice error" role="alert">{error}</p>}
    <button disabled={busy}>{busy ? 'Creating… the first request starts the engine, which can take a minute' : 'Create project'}</button>
  </form>;
}

export function NewTask({ p, onCreated }: { p: string; onCreated: () => void }) {
  const [slug, setSlug] = useState(''), [intent, setIntent] = useState(''), [touched, setTouched] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault(); if (busy) return; setError('');
    let body; try { body = taskBody({ slug, intent }); } catch (err) { setError(say(err)); return; }
    setBusy(true);
    try { await request(`${projectPath(p)}/tasks`, body); setSlug(''); setIntent(''); setTouched(false); onCreated(); }
    catch (err) { setError(say(err)); } finally { setBusy(false); }
  };
  return <details class="panel create-form" data-testid="new-task"><summary>New task</summary>
    <form onSubmit={submit} aria-label="New task">
      <label>What should the agents try to do?<textarea value={intent} maxLength={2000} placeholder="Fix the table parser so escaped pipes stay inside their cell" onInput={e => { const v = e.currentTarget.value; setIntent(v); if (!touched) setSlug(suggestId(v.split(/\s+/).slice(0, 5).join(' '))); }} disabled={busy}/></label>
      <label>Task name<input value={slug} onInput={e => { setTouched(true); setSlug(e.currentTarget.value); }} aria-invalid={!!slug && !validId(slug)} disabled={busy}/></label>
      {error && <p class="notice error" role="alert">{error}</p>}
      <button disabled={busy}>{busy ? 'Creating…' : 'Create task'}</button>
    </form></details>;
}

/** Shown where the decision form says nobody can decide yet: one field instead of a pointer at the API. */
export function AddHuman({ p, onAdded }: { p: string; onAdded: (human: Agent) => void }) {
  const [name, setName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const submit = async (e: Event) => {
    e.preventDefault(); if (busy) return; setError('');
    let body; try { body = humanBody({ displayName: name }); } catch (err) { setError(say(err)); return; }
    setBusy(true);
    try { const made = await request<{ id: string; publicKey: string }>(`${projectPath(p)}/humans`, body); onAdded({ id: made.id, kind: 'human', displayName: body.displayName, publicKey: made.publicKey } as Agent); }
    catch (err) { setError(say(err)); } finally { setBusy(false); }
  };
  return <div class="add-human"><label>Your name <span class="muted">(shown next to your decisions)</span><input value={name} onInput={e => setName(e.currentTarget.value)} disabled={busy}/></label>
    <button type="button" disabled={busy || !name.trim()} onClick={submit}>{busy ? 'Adding…' : 'Add me'}</button>{error && <p class="notice error" role="alert">{error}</p>}</div>;
}

/** The command that puts someone's own agent on this task. The operator token stays in their environment. */
export function AddAgent({ p, t }: { p: string; t: string }) {
  const [agent, setAgent] = useState('agent-1'), [copied, setCopied] = useState('');
  let command = ''; try { command = joinCommand({ origin: location.origin, project: p, task: t, agent }); } catch { /* Shown as a prompt below. */ }
  return <details class="panel create-form" data-testid="add-agent"><summary>Put your own agent on this task</summary>
    <label>Agent name<input value={agent} onInput={e => { setAgent(e.currentTarget.value.toLowerCase()); setCopied(''); }} aria-invalid={!!agent && !validId(agent)}/></label>
    {command ? <><pre class="join-command"><code>{command}</code></pre>
      <button type="button" class="quiet" onClick={async () => { try { await navigator.clipboard.writeText(command); setCopied('Copied'); } catch { setCopied('Select and copy the commands.'); } }}>Copy commands</button> <span class="muted" role="status">{copied}</span>
      <p class="muted">Each agent works in its own fork. Its pushes appear here as candidates, tested on their own.</p></>
      : <p class="muted">Use lowercase letters, digits and single hyphens.</p>}
  </details>;
}
