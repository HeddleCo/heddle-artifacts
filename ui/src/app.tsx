// SPDX-License-Identifier: Apache-2.0
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Agent, Candidate, Decision, FeedEvent, Lane, Turn } from '../../contracts/types';
import { ApiError, diff, projectPath, request, taskPath } from './api';
import type { ProjectView, Task, TaskView, WhyView } from './api';
import { updateBoard, updateTask } from './feed';
import { publicationEvidence } from './verification';
import { isPublished, decisionRequest, conflictMessage, combinedBlock, combinedText } from './decision';
import { DecisionNotice } from './decision-notice';
import { identifiers, InlineText, Narrative, parseReview, ReviewBody, RichText } from './rich-text';
import { plural, runnerLabel } from './format';
import { CombinedLine, CombinedPanel } from './combined';
import { Captures } from './captures';
import { AnchorChip, AnnotationCard } from './annotation-card';
import { AddAgent, AddHuman, NewProject, NewTask, useOperator, useSession } from './create-forms';


const short = (s: string) => s.slice(0, 10);
function HumanPrompt({ p, what, onHuman }: { p: string; what: string; onHuman: (human: Agent) => void }) {
  return useOperator() ? <><p class="muted">Add your name to {what}.</p><AddHuman p={p} onAdded={onHuman}/></> : <p class="muted">Sign in as an operator to {what}.</p>;
}
const link = (p: string, t?: string) => `/p/${encodeURIComponent(p)}${t ? `/t/${encodeURIComponent(t)}` : ''}`;
const whyLink = (p: string, sha: string) => `${link(p)}/why/${encodeURIComponent(sha)}`;
const fingerprint = (key: string) => key ? `ed25519:${key.slice(0, 8)}…${key.slice(-8)}` : 'No signing key';
const message = (e: unknown) => e instanceof ApiError ? e.message : 'Could not reach the server. Try again.';
function ErrorNotice({ text }: { text: string }) { return <p class="notice error" role="alert">{text} <a href="/login">Sign in</a></p>; }
function Badge({ candidate }: { candidate?: Candidate }) {
  const tests = candidate?.tests;
  return <span class={`badge ${tests?.status || 'pending'}`}>{tests ? `${tests.status === 'pass' ? '✓' : tests.status === 'fail' ? '✕' : '○'} ${tests.status} · ${tests.passed}/${tests.passed + tests.failed}${runnerLabel(tests) ? ` · ${runnerLabel(tests)}` : ''}` : '○ Tests pending'}</span>;
}
function Signature({ signedBy, agent }: { signedBy: string; agent?: Agent }) {
  const matches = agent?.publicKey === signedBy;
  return <span class={`signature ${agent && !matches ? 'error-text' : ''}`} title={signedBy}><code>{fingerprint(signedBy)}</code>{agent ? matches ? ' · directory match' : ' · key mismatch' : ''}</span>;
}
function useFeed(p: string, onEvent: (event: FeedEvent) => void, onConnect: (reconnected: boolean) => void, onDisconnect: () => void = () => {}) {
  const callbacks = useRef({ onEvent, onConnect, onDisconnect }); callbacks.current = { onEvent, onConnect, onDisconnect };
  const [status, setStatus] = useState('Connecting');
  useEffect(() => {
    let stopped = false, socket: WebSocket, timer: ReturnType<typeof setTimeout>, attempt = 0, opened = false;
    const connect = () => {
      const current = socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${projectPath(p)}/ws`);
      const active = () => !stopped && socket === current;
      current.onopen = () => { if (!active()) return; attempt = 0; setStatus('Live'); callbacks.current.onConnect(opened); opened = true; };
      current.onmessage = e => {
        if (!active()) return;
        try { const event = JSON.parse(e.data) as FeedEvent; if (event && typeof event.type === 'string') callbacks.current.onEvent(event); }
        catch { setStatus('Invalid live event'); callbacks.current.onDisconnect(); current.close(); }
      };
      // A feed that never opened is a signed-out or archived view, not a lost connection.
      current.onclose = () => { if (active()) { setStatus(opened ? 'Reconnecting' : 'Read-only'); callbacks.current.onDisconnect(); timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000)); } };
      current.onerror = () => { if (active()) { setStatus(opened ? 'Live feed unavailable' : 'Read-only'); callbacks.current.onDisconnect(); } };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); socket?.close(); };
  }, [p]);
  return status;
}
function Header({ p, live }: { p?: string; live?: string }) {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('heddle-theme') || 'dark'; } catch { return 'dark'; } });
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('heddle-theme', theme); } catch { /* Theme still works without storage. */ } }, [theme]);
  return <header><a class="brand" href={p ? link(p) : '/'}><span class="brand-mark" aria-hidden="true"><i/><i/><i/></span><span class="wordmark">HEDDLE.</span><span class="brand-sub">{p ? `artifacts / ${p}` : 'artifacts'}</span></a>
    <nav aria-label="Main"><span class="live"><span class={live === 'Live' ? 'live-dot' : ''} />{live || 'Decisions that travel with code'}</span>
      <button class="quiet" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? '☀ Light' : '☾ Dark'}</button><a href="/login">Sign in</a></nav></header>;
}
function PageTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: preact.ComponentChildren }) {
  return <div class="page-title"><p class="eyebrow">{eyebrow}</p><h1>{title}</h1>{children}</div>;
}
const views = ['Needs a decision', 'In progress', 'Landed', 'All tasks'] as const;
type BoardFilter = typeof views[number];
function taskGroup(task: Pick<Task, 'candidates' | 'decision'>): BoardFilter {
  return isPublished(task.decision) ? 'Landed' : task.decision || task.candidates.length ? 'Needs a decision' : 'In progress';
}
function TaskIcon() {
  return <span class="task-icon" aria-hidden="true"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="5" y="3" width="14" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg></span>;
}
function Facts({ rows }: { rows: [string, preact.ComponentChildren][] }) {
  return <dl class="facts">{rows.map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>;
}
function RepositoryLink({ remote }: { remote?: string }) {
  // Metadata can contain an arbitrary remote; only navigate to ordinary HTTPS URLs.
  try { const url = new URL(remote || ''); if (url.protocol === 'https:' && !url.username && !url.password) return <a href={url.href} title={remote}>Canonical repo ↗</a>; } catch { /* No link until metadata is available. */ }
  return <span class="muted">Unavailable</span>;
}
function TaskTabs({ ready }: { ready: boolean }) {
  const sections = ['Candidates', 'Captures', 'Discussion', 'Context'];
  const [active, setActive] = useState('candidates');
  useEffect(() => {
    const sync = () => { const id = location.hash.slice(1); setActive(sections.some(s => s.toLowerCase() === id) ? id : 'candidates'); };
    sync(); window.addEventListener('hashchange', sync);
    // The task arrives after the browser's initial fragment scroll.
    if (ready && location.hash) document.getElementById(location.hash.slice(1))?.scrollIntoView();
    return () => window.removeEventListener('hashchange', sync);
  }, [ready]);
  return <nav class="task-tabs" aria-label="Task sections">{sections.map(section => <a key={section} href={`#${section.toLowerCase()}`} aria-current={active === section.toLowerCase() ? 'location' : undefined} onClick={() => setActive(section.toLowerCase())}>{section}</a>)}</nav>;
}
type Activity = { task: string; agent: string; sha: string; kind: 'Push received' | 'Captured'; at: string };
function Board({ p }: { p: string }) {
  const [filter, setFilter] = useState<BoardFilter>('All tasks'), [activity, setActivity] = useState<Activity[]>([]);
  const [view, setView] = useState<ProjectView>(), [error, setError] = useState(''), [pulse, setPulse] = useState<Record<string, number>>({}), [refreshing, setRefreshing] = useState(false);
  const version = useRef(0), loading = useRef(false), reloadRequested = useRef(false), pending = useRef<FeedEvent[]>([]);
  const load = async () => {
    if (loading.current) return;
    const n = ++version.current; loading.current = true; setRefreshing(true); pending.current = [];
    try { const data = await request<ProjectView>(projectPath(p)); if (n === version.current) { setView(pending.current.reduce(updateBoard, data)); setError(''); } }
    catch(e) { if (n === version.current) setError(message(e)); }
    finally { if (n === version.current) { loading.current = false; setRefreshing(false); pending.current = []; if (reloadRequested.current) { reloadRequested.current = false; void load(); } } }
  };
  useEffect(() => { setView(undefined); setError(''); setPulse({}); setFilter('All tasks'); setActivity([]); void load();
    return () => { version.current++; loading.current = false; reloadRequested.current = false; pending.current = []; };
  }, [p]);
  const live = useFeed(p, event => {
    if (loading.current) pending.current.push(event); // Replay events that arrived after the snapshot request began.
    setView(v => v && updateBoard(v, event));
    if (event.type === 'push.received') setPulse(v => ({ ...v, [`${event.task}/${event.agent}`]: Date.now() }));
    if (event.type === 'push.received' || event.type === 'candidate.ready') {
      const item: Activity = event.type === 'push.received' ? { task: event.task, agent: event.agent, sha: event.sha, kind: 'Push received', at: new Date().toISOString() } : { task: event.candidate.task, agent: event.candidate.agent, sha: event.candidate.sourceSha, kind: 'Captured', at: event.candidate.capturedAt };
      setActivity(items => [item, ...items.filter(i => !(i.task === item.task && i.agent === item.agent && i.sha === item.sha))].slice(0, 6));
    }
    if (event.type === 'engine.error') setError(`Engine operation failed (${event.code}). Refresh to check progress.`);
  }, () => { if (loading.current) reloadRequested.current = true; else void load(); });
  const operator = useOperator();
  const agents = new Map(view?.agents.map(a => [a.id, a]));
  const ready = view?.tasks.reduce((n, t) => n + t.candidates.length, 0) || 0;
  const counts = (name: BoardFilter) => view?.tasks.filter(task => name === 'All tasks' || taskGroup(task) === name).length || 0;
  const recent = activity.length ? activity : (view?.tasks.flatMap(task => task.candidates.map(c => ({ task: task.slug, agent: c.agent, sha: c.sourceSha, kind: 'Captured' as const, at: c.capturedAt }))) || []).sort((a, b) => Date.parse(b.at) - Date.parse(a.at)).slice(0, 6);
  return <><Header p={p} live={live}/><main class="app-shell dashboard">
    <aside class="rail-card left-rail" aria-label="Views"><h2 class="rail-title">Views</h2><nav class="view-list" aria-label="Task views">{views.map(name => <button class="view-row" key={name} aria-pressed={filter === name} onClick={() => setFilter(name)}><span>{name}</span><span class="count">{counts(name)}</span></button>)}</nav><p class="rail-note">Each agent works in its own lane. You decide what lands.</p></aside>
    <div class="page-centre"><div class="page-title"><p class="date-line">{new Date().toLocaleDateString('en', { weekday: 'long', month: 'long', day: 'numeric' })}</p><h1>{p}</h1><p class="path-line"><code>artifacts / {p}</code></p><p class="intent">Each agent pushes to its own fork. Its latest push shows here as a candidate.</p></div>
    {error && <ErrorNotice text={error}/>}
    <div class="toolbar"><span>{view?.tasks.length || 0} tasks <span class="separator">/</span> {view?.agents.filter(a => a.kind === 'agent').length || 0} agents <span class="separator">/</span> {ready} candidates</span><button class="quiet" disabled={refreshing} onClick={load}>{refreshing ? 'Refreshing…' : 'Refresh board'}</button></div>
    {!view ? <p role="status">Loading project…</p> : <div class="board">{views.filter(name => name !== 'All tasks' && (filter === 'All tasks' || filter === name)).map(group => <section class="task-group" key={group} aria-label={`${group} tasks`}><h2>{group} <span class="count">{counts(group)}</span></h2>
    {view.tasks.filter(task => taskGroup(task) === group).map(task => <section class={`task-column ${group === 'Needs a decision' ? 'needs-decision' : ''}`} key={task.slug} aria-label={task.slug}>
      <div class="task-row-heading"><TaskIcon/><div><h3><a href={link(p, task.slug)}>{task.slug}</a></h3><p class="intent">{task.intent}</p></div><span class="task-status">{task.decision && !isPublished(task.decision) ? 'PUBLICATION PENDING' : group === 'Needs a decision' ? 'Awaiting your choice' : group === 'Landed' ? 'Landed on main' : 'Agents working'}</span></div>
      <div class="column-heading"><span>{plural(task.lanes.filter(l => agents.get(l.agent)?.kind !== 'reviewer').length, 'lane')}</span></div>
      {task.lanes.filter(l => agents.get(l.agent)?.kind === 'reviewer').map(l => <p class="reviewed-by" key={`reviewer/${l.agent}`}>Reviewed by <span class="tag">{agents.get(l.agent)?.model || l.agent}</span></p>)}
      <div class="lanes">{task.lanes.filter(l => agents.get(l.agent)?.kind !== 'reviewer').map(lane => {
        const agent = agents.get(lane.agent), candidate = task.candidates.find(c => c.agent === lane.agent);
        return <article class="lane-card" key={`${lane.agent}/${pulse[`${task.slug}/${lane.agent}`] || 0}`} data-testid={`lane-${lane.agent}`} data-push={pulse[`${task.slug}/${lane.agent}`] ? 'received' : 'idle'}>
          <div class={`push-pulse ${pulse[`${task.slug}/${lane.agent}`] ? 'pulsing' : ''}`}><span class="avatar">{lane.agent.slice(0, 1).toUpperCase()}</span><div><h3>{agent?.displayName || lane.agent}</h3><p class="muted">{agent?.provider || 'agent'} / {agent?.model || 'unspecified'}</p></div></div>
          <div class="card-status"><Badge candidate={candidate}/><span class="muted">{lane.status}</span></div>
          {candidate && <CombinedLine candidate={candidate}/>}
          {lane.unbriefed && <p class="briefed"><span class="tag dashed control" title="Opened without a Heddle briefing, as a control">○ no briefing · control</span></p>}
          {!!lane.briefing?.annotations.length && <p class="briefed"><span class="tag dashed" title={`Heddle briefing ${lane.briefing.hash}`}>◆ briefed · {lane.briefing.annotations.length} earlier decision{lane.briefing.annotations.length === 1 ? '' : 's'}</span></p>}
          <p class="sha">Last push <code>{lane.lastSeenSha ? short(lane.lastSeenSha) : 'Waiting for a push'}</code></p>
          {candidate && <><p class="subject">{candidate.subject}</p><div class="card-footer"><span class={candidate.conflicts.length ? 'conflict-text' : 'success-text'}>{candidate.conflicts.length ? `⚑ ${candidate.conflicts.length} conflict region` : '✓ Clean candidate'}</span><span>+{candidate.diffstat.insertions} −{candidate.diffstat.deletions}</span></div></>}
        </article>;
      })}</div>
      <a class="button compare-link" href={link(p, task.slug)}>{isPublished(task.decision) ? 'View decision' : task.decision ? 'Retry publication' : 'Compare candidates'} <span aria-hidden="true">→</span></a>
      {task.decision && isPublished(task.decision) && <a class="why-link" href={whyLink(p, task.decision.mainSha)}>Why {short(task.decision.mainSha)} landed →</a>}
    </section>)}{!counts(group) && <p class="empty-state">{group === 'Needs a decision' ? 'Nothing needs a decision right now.' : `No ${group.toLowerCase()} tasks.`}</p>}</section>)}</div>}
    {operator && <NewTask p={p} onCreated={() => { void load(); }}/>}
    {view && !view.tasks.length && <p>{operator ? 'No tasks yet. Create the first one above.' : 'No tasks yet.'}</p>}
    <footer>Artifacts holds the Git. Heddle holds the decisions.</footer></div>
    <aside class="rail-card right-rail" aria-label="Project activity and facts"><section><h2 class="rail-title">Live</h2>{!recent.length ? <p class="muted">Nothing moving right now.</p> : <ol class="activity-list">{recent.map(item => <li key={`${item.task}/${item.agent}/${item.sha}`}><span class="activity-dot" aria-hidden="true"/><div><a href={link(p, item.task)}>{item.agent} <span class="muted">· {item.kind}</span></a><p class="activity-path"><code>{item.task}</code></p><p class="muted"><code>{short(item.sha)}</code> · <time dateTime={item.at}>{new Date(item.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time></p></div></li>)}</ol>}</section>
    <section><h2 class="rail-title">About</h2><Facts rows={[
      ['Project', p], ['Agents', view?.agents.filter(a => a.kind === 'agent').length || 0], ['Tasks', view?.tasks.length || 0], ['Candidates', ready], ['Repository', <RepositoryLink remote={typeof view?.project === 'object' ? view.project.canonicalRemote : undefined}/>]
    ]}/></section></aside></main></>;
}
function Diff({ p, t, candidate }: { p: string; t: string; candidate: Candidate }) {
  const [text, setText] = useState('Loading diff…'), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => { const abort = new AbortController(); setText('Loading diff…'); setError('');
    diff(p, t, candidate.agent, abort.signal).then(setText).catch(e => { if (!abort.signal.aborted) setError(message(e)); });
    return () => abort.abort();
  }, [p, t, candidate.agent, candidate.sourceSha, retry]);
  return error ? <div role="alert">{error} <button class="quiet" onClick={() => setRetry(n => n + 1)}>Retry diff</button></div> : <pre class="diff" aria-label={`Diff for ${candidate.agent}`}><code>{text.split('\n').map((line, i) => <span key={i} class={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-region' : ''}>{line}{'\n'}</span>)}</code></pre>;
}
function Discussion({ p, t, turns, humans, decision, onTurn, onHuman }: { p: string; t: string; turns: Turn[]; humans: Agent[]; decision?: Decision; onTurn: (turn: Turn) => void; onHuman: (human: Agent) => void }) {
  const [body, setBody] = useState(''), [as, setAs] = useState(''), [replyTo, setReplyTo] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const sending = useRef(false), lifecycle = useRef(0);
  useEffect(() => { setBody(''); setAs(''); setReplyTo(''); setError(''); setBusy(false); sending.current = false;
    return () => { lifecycle.current++; };
  }, [p, t]);
  const author = as || humans[0]?.id || '';
  const submit = async (e: Event) => { e.preventDefault(); if (!author || !body.trim() || busy || sending.current) return; const n = lifecycle.current; sending.current = true; setBusy(true); setError('');
    try { const turn = await request<Turn>(`${taskPath(p, t)}/turns`, { body: body.trim(), as: author, ...(replyTo ? { replyTo } : {}) }); if (n === lifecycle.current) { onTurn(turn); setBody(''); setReplyTo(''); } }
    catch(e) { if (n === lifecycle.current) setError(message(e)); } finally { if (n === lifecycle.current) { sending.current = false; setBusy(false); } }
  };
  return <section id="discussion" tabIndex={-1} class="panel discussion">
    <div class="discussion-heading"><h2>Discussion <span class="count">{turns.length}</span></h2><span class={`discussion-status ${decision ? 'resolved' : 'open'}`}>{decision ? 'resolved' : 'open'}</span></div>
    <p class="discussion-title">{t}</p>{decision?.anchor && <AnchorChip anchor={decision.anchor}/>}
    {turns.length ? <div class="discussion-thread">{turns.map((turn, i) => {
      const grouped = i > 0 && turns[i - 1].author === turn.author && turns[i - 1].kind === turn.kind;
      const name = humans.find(a => a.id === turn.author)?.displayName || turn.author;
      const initials = name.split(/\s+/).map(part => part[0]).slice(0, 2).join('').toUpperCase();
      const review = turn.kind === 'reviewer' ? parseReview(turn.body) : undefined;
      return <article class={`turn turn-${turn.kind}${grouped ? ' turn-grouped' : ''}`} key={turn.id} aria-label={`${name}, ${new Date(turn.at).toLocaleString()}`}>
        {!grouped && <><span class="avatar turn-avatar" aria-hidden="true">{turn.kind === 'human' ? initials : '◇'}</span>
          <div class="turn-heading"><strong>{name}</strong>{turn.kind !== 'human' && <span class="turn-role">{turn.kind}</span>}<time dateTime={turn.at}>{new Date(turn.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></div></>}
        <div class="turn-content"><div class="turn-bubble">{review ? <ReviewBody review={review}/> : <RichText text={turn.body}/>}<Signature signedBy={turn.signedBy}/></div>
          <div class="turn-actions">{turn.replyTo && <span class="muted">Reply to {turn.replyTo}</span>}<button class="quiet small turn-reply" disabled={busy} onClick={() => setReplyTo(turn.id)}>Reply to {turn.author}</button></div>
        </div>
      </article>;
    })}</div> : <p class="muted">No discussion yet. Add the context that should travel with the code.</p>}
    <form onSubmit={submit}><label>Speak as<select disabled={busy} value={author} onChange={e => setAs(e.currentTarget.value)} required><option value="" disabled>Select a human identity</option>{humans.map(a => <option value={a.id}>{a.displayName}</option>)}</select></label>
      <label>Your reply<textarea disabled={busy} required maxLength={10000} value={body} onInput={e => setBody(e.currentTarget.value)} placeholder="What should the team consider?"/></label>
      {replyTo && <p>Replying to {replyTo} <button type="button" class="quiet" disabled={busy} onClick={() => setReplyTo('')}>Cancel reply</button></p>}
      {error && <ErrorNotice text={error}/>}<button disabled={busy || !author || !body.trim()}>{busy ? 'Posting…' : 'Post signed reply'}</button>
      {!humans.length && <HumanPrompt p={p} what="discuss or decide" onHuman={onHuman}/>}
    </form></section>;
}
function Compare({ p, t }: { p: string; t: string }) {
  const [captureRefresh, setCaptureRefresh] = useState(0), [project, setProject] = useState<ProjectView>();
  const [view, setView] = useState<TaskView>(), [agents, setAgents] = useState<Agent[]>([]), [lanes, setLanes] = useState<Lane[]>([]), [error, setError] = useState('');
  const [pick, setPick] = useState(''), [rationale, setRationale] = useState(''), [anchor, setAnchor] = useState(''), [tags, setTags] = useState(''), [decider, setDecider] = useState(''), [busy, setBusy] = useState(false), [changed, setChanged] = useState(false), [reviewing, setReviewing] = useState(false);
  const sending = useRef(false), version = useRef(0), hydrated = useRef(false), loading = useRef(false), pending = useRef<FeedEvent[]>([]);
  // No subscription still blocks decisions; a positive epoch records a previously opened feed's loss.
  const stale = useRef(false), feedAvailable = useRef(false), connectionEpoch = useRef(0), reloadRequested = useRef(false), previousProject = useRef(p), lifecycle = useRef(0);
  const invalidate = () => { stale.current = true; setChanged(true); };
  const load = async (reviewAgain = false) => {
    if (loading.current) return;
    const n = ++version.current, epoch = connectionEpoch.current; setReviewing(true); loading.current = true; pending.current = [];
    try { const [task, project] = await Promise.all([request<TaskView>(taskPath(p, t)), request<ProjectView>(projectPath(p))]);
      if (n === version.current) { setView(pending.current.reduce(updateTask, task)); setAgents(project.agents); setProject(pending.current.reduce(updateBoard, project)); setLanes(project.tasks.find(x => x.slug === t)?.lanes ?? []); setError(''); if (reviewAgain || !hydrated.current) { stale.current = !feedAvailable.current || epoch !== connectionEpoch.current || pending.current.some(e => e.type === 'candidate.ready' && e.candidate.task === t); setChanged(stale.current && (feedAvailable.current || connectionEpoch.current > 0)); if (reviewAgain) setPick(''); } hydrated.current = true; }
    } catch(e) { if (n === version.current) setError(message(e)); } finally { if (n === version.current) { setReviewing(false); loading.current = false; pending.current = []; if (reloadRequested.current) { reloadRequested.current = false; void load(true); } } }
  };
  useEffect(() => {
    if (previousProject.current !== p) { feedAvailable.current = false; connectionEpoch.current = 0; previousProject.current = p; }
    setView(undefined); setProject(undefined); setAgents([]); setError(''); setPick(''); setRationale(''); setAnchor(''); setTags(''); setDecider(''); setBusy(false); setChanged(false);
    hydrated.current = false; sending.current = false; stale.current = true; void load();
    return () => { version.current++; lifecycle.current++; loading.current = false; reloadRequested.current = false; pending.current = []; };
  }, [p, t]);
  const live = useFeed(p, event => {
    if (loading.current) pending.current.push(event);
    if (event.type === 'push.received' && event.task === t || event.type === 'candidate.ready' && event.candidate.task === t || event.type === 'tests.done' && event.task === t) setCaptureRefresh(n => n + 1);
    if (event.type === 'candidate.ready' && event.candidate.task === t) invalidate();
    if (event.type === 'decision.landed' && event.decision.task === t) stale.current = true;
    setView(v => v && updateTask(v, event));
    setProject(v => v && updateBoard(v, event));
    if (event.type === 'engine.error') setError(`Engine operation failed (${event.code}). Review current candidates before retrying.`);
  }, reconnected => {
    feedAvailable.current = true;
    setCaptureRefresh(n => n + 1);
    if (reconnected) { connectionEpoch.current++; invalidate(); if (!hydrated.current && !loading.current) void load(); }
    else { // Re-read after subscribing so a snapshot taken before the socket opened cannot miss updates.
      if (loading.current) reloadRequested.current = true; else { invalidate(); void load(true); }
    }
  },
  () => { if (!feedAvailable.current) return; feedAvailable.current = false; connectionEpoch.current++; invalidate(); });
  const humans = agents.filter(a => a.kind === 'human'), who = decider || humans[0]?.id || '';
  const addHuman = (human: Agent) => setAgents(list => list.some(a => a.id === human.id) ? list : [...list, human]);
  const operator = useOperator();
  const submit = async (e: Event) => { e.preventDefault(); if (!view || sending.current || busy || stale.current || loading.current || changed || reviewing) return;
    const body = decisionRequest(view, { pick, rationale, decider: who, ...(anchor.trim() ? { anchor: anchor.trim() } : {}), ...(tags.trim() ? { tags: tags.split(',').map(t => t.trim()) } : {}) }); if (!body) return; const n = lifecycle.current; sending.current = true; setBusy(true); setError('');
    try {
      const decision = await request<Decision>(`${taskPath(p, t)}/decision`, body);
      if (n === lifecycle.current) setView(v => v && { ...v, decision });
    } catch(e) {
      if (n !== lifecycle.current) return;
      if (e instanceof ApiError && e.status === 409) { invalidate(); setError(conflictMessage(e.code)); }
      else {
        // A failed response can follow a successful signed decision. Re-read before allowing another choice.
        if (!(e instanceof ApiError && [401, 403].includes(e.status))) { invalidate(); await load(true); }
        if (n === lifecycle.current) setError(message(e));
      }
    }
    finally { if (n === lifecycle.current) { sending.current = false; setBusy(false); } }
  };
  const regions = new Map<string, Set<string>>();
  for (const c of view?.candidates || []) for (const region of c.conflicts) { const key = `${region.path}${region.region ? `:${region.region}` : ''}`; regions.set(key, new Set([...(regions.get(key) || []), c.agent, ...region.with])); }
  const base = view?.task.baseSha || view?.candidates[0]?.parentSha;
  const tasks = project?.tasks.map(task => task.slug === t && view ? { ...task, candidates: view.candidates, decision: view.decision } : task);
  return <><Header p={p} live={live}/><main class="app-shell spool">
    <aside class="rail-card left-rail" aria-label="Project tasks"><h2 class="rail-title">Tasks</h2><a class="tree-project" href={link(p)}>{p}<span class="count">{project?.tasks.length || 0}</span></a><nav class="task-tree" aria-label="Tasks">{tasks?.map(task => <a key={task.slug} href={link(p, task.slug)} aria-current={task.slug === t ? 'page' : undefined}><span class="tree-label">{task.slug}<span class={`tree-status ${taskGroup(task) === 'Landed' ? 'success-text' : ''}`} aria-hidden="true">{taskGroup(task) === 'Landed' ? '✓' : taskGroup(task) === 'Needs a decision' ? '◌' : '·'}</span></span><span class="muted">{taskGroup(task)}</span></a>)}</nav><a class="rail-back" href={link(p)}>← Back to dashboard</a></aside>
    <div class="page-centre"><div class="page-title"><h1>{t}</h1><p class="path-line"><code>{view?.task.thread || `${p} / ${t}`} <span class="separator">/</span> base {base ? short(base) : 'awaiting capture'}</code></p><p class="intent">{view?.task.intent || 'Loading task…'}</p></div>
    {operator && <AddAgent p={p} t={t}/>}
    <TaskTabs ready={!!view}/><a class="mobile-decision-link" href="#decision">Go to decision ↓</a>
    {error && <ErrorNotice text={error}/>}
    {changed && <div class="notice warning" role="status">Review the latest task state before continuing. <button class="quiet" disabled={reviewing} onClick={() => load(true)}>{view?.decision ? 'Refresh recorded decision' : 'Review current candidates'}</button></div>}
    {view?.decision && <DecisionNotice project={p} decision={view.decision}/>}
    {!!regions.size && <section class="conflict-banner" aria-label="Conflict regions"><strong>⚑ Overlapping work, preserved as alternatives</strong>{[...regions].map(([region, ids]) => <p><code>{region}</code><span>{[...ids].join(' ↔ ')}</span></p>)}</section>}
    <div class="compare-main"><section id="candidates" tabIndex={-1} class="candidates-section" aria-label="Candidates"><h2 class="section-title">Candidates <span class="count">{view?.candidates.length || 0}</span></h2>
    <div class="candidate-grid" style={{'--candidate-count': Math.min(view?.candidates.length || 1, 3)}}>{view?.candidates.map(candidate => { const agent = agents.find(a => a.id === candidate.agent); return <section class="candidate panel" key={candidate.agent} aria-label={`${candidate.agent} candidate`}>
      <div class="candidate-heading"><div><p class="eyebrow">CANDIDATE / {candidate.agent}</p><h2>{agent?.displayName || candidate.agent}</h2></div><Badge candidate={candidate}/></div>
      <p class="muted">{agent?.provider || 'unknown provider'} / {agent?.model || 'unspecified model'}</p>
      <p class="candidate-stats"><code title={candidate.sourceSha}>{short(candidate.sourceSha)}</code><span>{candidate.diffstat.files} file · <b class="success-text">+{candidate.diffstat.insertions}</b> <b class="error-text">−{candidate.diffstat.deletions}</b></span></p>
      <p class="subject">{candidate.subject}</p>{candidate.tests && <p class="test-summary">{candidate.tests.summary} · {candidate.tests.durationMs} ms</p>}
      {candidate.conflicts.map(region => <p class="conflict-tag">⚑ <code>{region.path}{region.region ? `:${region.region}` : ''}</code> · with {region.with.join(', ')}</p>)}
      <CombinedPanel candidate={candidate}/>
      <Diff p={p} t={t} candidate={candidate}/><Signature signedBy={candidate.signedBy} agent={agent}/></section>; })}</div>
    {view && !view.candidates.length && <p class="notice">Waiting for candidate captures. This page updates live.</p>}
  {view?.review && <section class="panel reviewer">
    <div class="reviewer-heading"><h2>Reviews <span class="count">{view.review.perCandidate.length}</span></h2><span class="reviewer-model" title={view.review.model}>{view.review.model.startsWith('@cf/') ? view.review.model.split('/').at(-1)?.toUpperCase() : view.review.model}</span></div>
    <div class="reviewer-summary"><h3>{view.review.recommendation ? `Recommendation: ${view.review.recommendation.pick}` : 'Review'}</h3><p><InlineText text={view.review.summary}/></p>{view.review.recommendation && <p class="muted"><InlineText text={view.review.recommendation.why}/></p>}</div>
    <ul class="review-rows">{view.review.perCandidate.map(c => <li class={`review-row review-${c.verdict}`} key={c.agent}>
      <span class="review-glyph" role="img" aria-label={c.verdict}>{c.verdict === 'approve' ? '✓' : '–'}</span><div><strong class="review-agent">{c.agent}</strong><blockquote><InlineText text={c.notes}/></blockquote></div>
    </li>)}</ul></section>}
    </section>
    {view && <Captures key={`captures/${p}/${t}`} p={p} t={t} agents={agents} lanes={lanes} refresh={captureRefresh}/>}
    {view && <Discussion key={`${p}/${t}`} p={p} t={t} turns={view.turns} humans={humans} decision={view.decision} onTurn={turn => setView(v => v && { ...v, turns: [...v.turns.filter(x => x.id !== turn.id), turn] })} onHuman={addHuman}/>}
      {view && <section id="context" tabIndex={-1} class="panel context-supplied" aria-label="Context supplied"><h2>Context supplied</h2>
        <p class="muted">{lanes.some(l => l.briefing?.annotations.length) ? "Heddle briefed each agent with earlier decisions on this code before it started." : "No earlier decisions were supplied to these lanes."}</p>
        {lanes.some(l => l.unbriefed) && <p class="muted control-note">Not briefed, as a control: {lanes.filter(l => l.unbriefed).map(l => l.agent).join(', ')}.</p>}
        {lanes.filter(l => l.briefing?.annotations.length).map(l => <div class="briefing" key={l.agent}><h3 class="briefing-lane">{l.agent} <span class="count">{l.briefing!.annotations.length} supplied</span></h3>
          <div class="annotation-list">{l.briefing!.annotations.map(a => <AnnotationCard key={`${a.annotationId}/${a.revisionId}`} kind={a.kind} target={a.target} scope={a.scope} content={a.content} tags={a.tags} attribution={a.attribution} hash={l.briefing!.hash}/>)}</div></div>)}
      </section>}
    </div></div>
    <aside class="rail-card right-rail rail" aria-label="Decision"><section class="task-facts"><h2 class="rail-title">About</h2><Facts rows={[
      ['Status', view ? taskGroup(view) : 'Loading…'], ['Base', base ? <code title={base}>{short(base)}</code> : 'Awaiting capture'], ['Candidates', view?.candidates.length || 0], ['Tests', `${view?.candidates.filter(c => c.tests?.status === 'pass').length || 0} / ${view?.candidates.length || 0} passing`]
    ]}/></section>
    {view && <>

      <section id="decision" tabIndex={-1} class="panel decision"><p class="eyebrow">DECISION · TO LAND</p><h2>{view.decision ? 'Recorded decision' : 'Choose what lands'}</h2><p class="muted">Your reason is saved with the decision on main.</p>
        <form onSubmit={submit}><fieldset disabled={busy || !!view.decision || stale.current || changed || reviewing}><legend>Candidate to land</legend>{view.candidates.map(c => <label class="radio-choice"><input type="radio" name="pick" value={c.agent} required checked={(view.decision?.pick ?? pick) === c.agent} onChange={() => setPick(c.agent)}/><span>{c.agent}</span><Badge candidate={c}/></label>)}
          <label>Decide as<select required value={view.decision?.decider ?? who} onChange={e => setDecider(e.currentTarget.value)}><option value="" disabled>Select a human identity</option>{humans.map(a => <option value={a.id}>{a.displayName}</option>)}</select></label>
          <label>Why this candidate?<textarea required maxLength={10000} value={view.decision?.rationale ?? rationale} onInput={e => setRationale(e.currentTarget.value)} placeholder="Explain the tradeoff. This becomes part of the Git history."/></label>
          {view.decision ? <>{view.decision.anchor && <p class="recorded-anchor">Reason points at <AnchorChip anchor={view.decision.anchor}/></p>}
            {!!view.decision.tags?.length && <p class="recorded-tags">{view.decision.tags.map(tag => <span class="tag" key={tag}>{tag}</span>)}</p>}</> : <>
          <label>Point this reason at<input type="text" value={anchor} onInput={e => setAnchor(e.currentTarget.value)} placeholder="path/to/file.ts:symbol"/></label>
          <label>Tags<input type="text" value={tags} onInput={e => setTags(e.currentTarget.value)} placeholder="tag-one, tag-two"/></label><p class="muted">Optional, comma-separated · up to 8 tags</p></>}
        </fieldset><button class="land-button" disabled={!decisionRequest(view, { pick, rationale, decider: who, ...(anchor.trim() ? { anchor: anchor.trim() } : {}), ...(tags.trim() ? { tags: tags.split(',').map(t => t.trim()) } : {}) }) || busy || stale.current || changed || reviewing}>{busy ? view.decision ? 'Publishing…' : 'Landing…' : isPublished(view.decision) ? 'Decision landed' : view.decision ? 'Retry publication' : 'Land candidate →'}</button></form>
        {!view.decision && (() => { const picked = view.candidates.find(c => c.agent === pick), blocked = combinedBlock(picked);
          return blocked ? <p class="notice warning combined-block" role="status">{blocked}</p>
            : picked?.combined?.status === 'pass' ? <p class="muted combined-note">{picked.agent} lands as Heddle's merge with main, the exact result that passed its tests.</p> : null; })()}
        {!humans.length && <HumanPrompt p={p} what="decide" onHuman={addHuman}/>}
      </section>
      {!!view.candidates.length && <section class="panel checks"><p class="eyebrow">CHECKS <span class="count">{view.candidates.length}</span></p><ul>{view.candidates.map(c => <li class={`check ${c.tests?.status || 'pending'}`}><span class="check-mark" aria-hidden="true">{c.tests?.status === 'pass' ? '✓' : c.tests?.status === 'fail' || c.tests?.status === 'error' ? '✕' : '○'}</span><strong>{c.agent}</strong><span class="check-detail">{c.tests ? `${c.tests.passed} pass · ${c.tests.failed} fail${c.tests.durationMs ? ` · ${(c.tests.durationMs / 1000).toFixed(1)} s` : ''}` : 'tests pending'}</span>{runnerLabel(c.tests) && <span class="tag dashed">{runnerLabel(c.tests)}</span>}</li>)}
        {view.candidates.filter(c => c.combined).map(c => { const line = combinedText(c)!; return <li class={`check combined ${line.tone}`}><span class="check-mark" aria-hidden="true">{line.text.slice(0, 1)}</span><strong>{c.agent} + main</strong><span class="check-detail">{line.text.slice(2)}</span></li>; })}</ul></section>}
    </>}</aside>
  </main></>;
}
function Verification({ view, sha, proof }: { view?: WhyView; sha: string; proof: string }) {
  const evidence = publicationEvidence(view, sha);
  return <section class="panel verification"><p class="eyebrow">PUBLICATION VERIFICATION</p><h2>Verification evidence</h2>
    {evidence ? <><p class={`notice ${evidence.passed ? 'success-text' : 'error-text'}`}>{evidence.passed ? 'Recorded publication checks passed.' : 'Recorded publication checks failed.'}</p>
      <p class="muted">Recorded for <code>{short(evidence.sha)}</code> at <time dateTime={evidence.checkedAt}>{evidence.checkedAt}</time>. This is publication-time evidence, not a live Artifacts recheck.</p>
      <ul><li>Chosen tree matches main: {evidence.treeMatch ? 'passed' : 'FAILED'}</li><li>Export reproduces main: {evidence.exportRoundTrip ? 'passed' : 'FAILED'}</li><li>Git objects valid: {evidence.fsck ? 'passed' : 'FAILED'}</li></ul>
      <p class="muted">Candidate SHA preservation is a separate check and is not included in this result.</p></>
      : <><p class="notice">Unavailable from the current API.</p><p class="muted">No matching publication verification is available for this commit. Run the checks below against a fresh clone.</p><ul><li>Candidate SHA preserved: awaiting evidence</li><li>Chosen tree matches main: awaiting evidence</li><li>Export reproduces main: awaiting evidence</li><li>Git objects valid: awaiting evidence</li></ul></>}
    <p>Inspect the published objects locally:</p><pre><code>{proof}</code></pre></section>;
}
function Why({ p, sha }: { p: string; sha: string }) {
  const [view, setView] = useState<WhyView>(), [error, setError] = useState(''), [remote, setRemote] = useState(''), [copied, setCopied] = useState('');
  useEffect(() => { const controller = new AbortController();
    request<WhyView>(`${projectPath(p)}/why/${encodeURIComponent(sha)}`, undefined, controller.signal).then(setView).catch(e => { if (!controller.signal.aborted) setError(message(e)); });
    // The narrative is public for the demo, but the project metadata may require a session.
    request<ProjectView>(projectPath(p), undefined, controller.signal).then(v => { if (typeof v.project === 'object' && v.project.canonicalRemote) setRemote(v.project.canonicalRemote); }).catch(() => {});
    return () => controller.abort();
  }, [p, sha]);
  // Accept a clean HTTPS remote only; never put userinfo, query tokens or shell syntax into copied commands.
  let cloneRemote = '<CANONICAL_REMOTE>';
  try { const u = new URL(remote); if (u.protocol === 'https:' && !u.username && !u.password && !u.search && /^[a-zA-Z0-9./:_-]+$/.test(remote)) cloneRemote = remote; } catch { /* Show a placeholder until an authenticated project response provides a safe remote. */ }
  const commands = `read -r -s -p 'Artifacts read token: ' HEDDLE_READ_TOKEN; printf '\\n'\nexport HEDDLE_READ_TOKEN\ngit -c http.extraHeader="Authorization: Bearer $HEDDLE_READ_TOKEN" clone '${cloneRemote}' heddle-check\ncd heddle-check\ngit -c http.extraHeader="Authorization: Bearer $HEDDLE_READ_TOKEN" fetch origin '+refs/notes/*:refs/notes/*'\nunset HEDDLE_READ_TOKEN\ngit log --notes='heddle*' -3\ngit branch -r`;
  const proof = `git fsck --strict${/^[a-f0-9]{40}$/i.test(sha) && view?.decision && /^[a-zA-Z0-9_-]+$/.test(view.decision.task) && /^[a-zA-Z0-9_-]+$/.test(view.decision.pick) ? `\ngit rev-parse '${sha}^{tree}' 'origin/candidates/${view.decision.task}/${view.decision.pick}^{tree}'` : ''}`;
  return <><Header p={p}/><main><a class="breadcrumb" href={link(p)}>← {p} / board</a><PageTitle eyebrow="THE WHY / PLAIN GIT" title="The decision stays with the code."><p>Commit <code>{short(sha)}</code> · the chosen work, the alternatives, and the reasoning.</p></PageTitle>{error && <ErrorNotice text={error}/>}
    <div class="why-layout"><section class="panel narrative"><h2>Decision narrative</h2>{view?.decision && <AnnotationCard kind="Reason" content={view.decision.rationale} attribution={view.decision.decider} anchor={view.decision.anchor} tags={view.decision.tags}/>}<Narrative text={view?.narrative || 'Loading narrative…'}/>{view?.decision && <a href={link(p, view.decision.task)}>Back to the candidates →</a>}</section>
      <Verification view={view} sha={sha} proof={proof}/></div>
    <section class="panel git-instructions"><div class="section-heading"><h2>See it in plain Git</h2><button class="quiet" onClick={async () => { try { await navigator.clipboard.writeText(commands); setCopied('Copied'); } catch { setCopied('Select and copy the commands below.'); } }}>Copy commands</button></div><p class="muted">Use Bash. Enter your repo-scoped read token at the hidden prompt.{cloneRemote === '<CANONICAL_REMOTE>' ? ' Replace <CANONICAL_REMOTE> with the project’s Artifacts HTTPS clone URL.' : ''}</p><pre tabIndex={0}><code>{commands}</code></pre><p role="status">{copied}</p></section>
  </main></>;
}
function Login() {
  return <><Header/><main class="login"><PageTitle eyebrow="OPERATOR SESSION" title="Sign in to decide."><p>Your session can discuss, review, and land candidates.</p></PageTitle><form class="panel" method="post" action="/login"><label>Operator token<input type="password" name="token" required autoComplete="off"/></label><button>Sign in</button><p class="muted">The server sets an HttpOnly session cookie.</p></form></main></>;
}
function App() {
  const path = location.pathname.split('/').filter(Boolean).map(x => { try { return decodeURIComponent(x); } catch { return ''; } });
  if (path[0] === 'login' && path.length === 1) return <Login/>;
  if (path[0] === 'p' && path[1]) {
    if (path.length === 2) return <Board p={path[1]}/>;
    if (path[2] === 't' && path[3] && path.length === 4) return <Compare p={path[1]} t={path[3]}/>;
    if (path[2] === 'why' && path[3] && path.length === 4) return <Why p={path[1]} sha={path[3]}/>;
  }
  return <Home/>;
}
function Home() {
  const { ready, operator, demo } = useSession(), root = location.pathname === '/';
  if (root && !ready) return <><Header/><main><p role="status">Loading…</p></main></>;
  // Visitors at the root see the public demo board; operators keep the create form.
  if (root && !operator && demo) return <Board p={demo}/>;
  return <><Header/><main><PageTitle eyebrow="HEDDLE / ARTIFACTS" title={location.pathname === '/' ? 'Decisions that travel with code.' : 'Page not found.'}/>{operator && root && <NewProject/>}{operator && root && demo && <p class="muted"><a href={link(demo)}>Open the demo board →</a></p>}<form class="panel" onSubmit={e => { e.preventDefault(); const value = new FormData(e.currentTarget).get('project'); if (typeof value === 'string' && value.trim()) location.assign(link(value.trim())); }}><label>Project ID<input name="project" required placeholder="demo"/></label><button>Open board →</button></form></main></>;
}
render(<App/>, document.getElementById('app')!);
