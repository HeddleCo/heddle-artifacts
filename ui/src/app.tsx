// SPDX-License-Identifier: Apache-2.0
import { render } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Agent, Candidate, Decision, FeedEvent, Turn } from './contracts';
import { ApiError, diff, projectPath, request, taskPath } from './api';
import type { ProjectView, TaskView, WhyView } from './api';
import { updateBoard, updateTask } from './feed';

const short = (s: string) => s.slice(0, 10);
const link = (p: string, t?: string) => `/p/${encodeURIComponent(p)}${t ? `/t/${encodeURIComponent(t)}` : ''}`;
const whyLink = (p: string, sha: string) => `${link(p)}/why/${encodeURIComponent(sha)}`;
const fingerprint = (key: string) => key ? `ed25519:${key.slice(0, 8)}…${key.slice(-8)}` : 'No signing key';
const message = (e: unknown) => e instanceof ApiError ? e.message : 'Could not reach the server. Try again.';
function ErrorNotice({ text }: { text: string }) { return <p class="notice error" role="alert">{text} <a href="/login">Sign in</a></p>; }
function Badge({ candidate }: { candidate?: Candidate }) {
  const tests = candidate?.tests;
  return <span class={`badge ${tests?.status || 'pending'}`}>{tests ? `${tests.status === 'pass' ? '✓' : tests.status === 'fail' ? '✕' : '○'} ${tests.status} · ${tests.passed}/${tests.passed + tests.failed}` : '○ Tests pending'}</span>;
}
function Signature({ signedBy, agent }: { signedBy: string; agent?: Agent }) {
  const matches = agent?.publicKey === signedBy;
  return <span class={`signature ${agent && !matches ? 'error-text' : ''}`} title={signedBy}>{fingerprint(signedBy)}{agent ? matches ? ' · directory match' : ' · key mismatch' : ''}</span>;
}
function useFeed(p: string, onEvent: (event: FeedEvent) => void, onConnect: (reconnected: boolean) => void) {
  const callbacks = useRef({ onEvent, onConnect }); callbacks.current = { onEvent, onConnect };
  const [status, setStatus] = useState('Connecting');
  useEffect(() => {
    let stopped = false, socket: WebSocket, timer: ReturnType<typeof setTimeout>, attempt = 0, opened = false;
    const connect = () => {
      socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${projectPath(p)}/ws`);
      socket.onopen = () => { attempt = 0; setStatus('Live'); callbacks.current.onConnect(opened); opened = true; };
      socket.onmessage = e => {
        try { const event = JSON.parse(e.data) as FeedEvent; if (event && typeof event.type === 'string') callbacks.current.onEvent(event); }
        catch { setStatus('Invalid live event'); }
      };
      socket.onclose = () => { if (!stopped) { setStatus('Reconnecting'); timer = setTimeout(connect, Math.min(1000 * 2 ** attempt++, 15000)); } };
      socket.onerror = () => { setStatus('Live feed unavailable'); };
    };
    connect();
    return () => { stopped = true; clearTimeout(timer); socket?.close(); };
  }, [p]);
  return status;
}
function Header({ p, live }: { p?: string; live?: string }) {
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('heddle-theme') || 'dark'; } catch { return 'dark'; } });
  useEffect(() => { document.documentElement.dataset.theme = theme; try { localStorage.setItem('heddle-theme', theme); } catch { /* Theme still works without storage. */ } }, [theme]);
  return <header><a class="brand" href={p ? link(p) : '/'}><span class="brand-mark" aria-hidden="true">H</span> heddle<span class="brand-sub"> / artifacts</span></a>
    <nav aria-label="Main"><span class="live"><span class={live === 'Live' ? 'live-dot' : ''} />{live || 'Decisions that travel with code'}</span>
      <button class="quiet" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? '☀ Light' : '☾ Dark'}</button><a href="/login">Sign in</a></nav></header>;
}
function PageTitle({ eyebrow, title, children }: { eyebrow: string; title: string; children?: preact.ComponentChildren }) {
  return <div class="page-title"><p class="eyebrow">{eyebrow}</p><h1>{title}</h1>{children}</div>;
}
function Board({ p }: { p: string }) {
  const [view, setView] = useState<ProjectView>(), [error, setError] = useState(''), [pulse, setPulse] = useState<Record<string, number>>({});
  const version = useRef(0);
  const load = async () => { const n = ++version.current; try { const data = await request<ProjectView>(projectPath(p)); if (n === version.current) { setView(data); setError(''); } } catch(e) { if (n === version.current) setError(message(e)); } };
  useEffect(() => { void load(); return () => { version.current++; }; }, [p]);
  const live = useFeed(p, event => {
    version.current++; // A snapshot begun before this event must not overwrite it.
    setView(v => v && updateBoard(v, event));
    if (event.type === 'push.received') setPulse(v => ({ ...v, [`${event.task}/${event.agent}`]: Date.now() }));
    if (event.type === 'engine.error') setError(`Engine operation failed (${event.code}). Refresh to check progress.`);
  }, () => { void load(); });
  const agents = new Map(view?.agents.map(a => [a.id, a]));
  const ready = view?.tasks.reduce((n, t) => n + t.candidates.length, 0) || 0;
  return <><Header p={p} live={live}/><main><PageTitle eyebrow={`PROJECT / ${p}`} title="Work in parallel. Decide together."><p>Every agent has a lane. Every alternative stays with the code.</p></PageTitle>
    {error && <ErrorNotice text={error}/>}
    <div class="toolbar"><span>{view?.tasks.length || 0} tasks <span class="separator">/</span> {view?.agents.filter(a => a.kind === 'agent').length || 0} agents <span class="separator">/</span> {ready} candidates</span><button class="quiet" onClick={load}>Refresh board</button></div>
    {!view ? <p role="status">Loading project…</p> : <div class="board">{view.tasks.map(task => <section class="task-column" key={task.slug} aria-label={task.slug}>
      <div class="column-heading"><span class="eyebrow">{task.decision ? 'LANDED' : task.candidates.some(c => c.conflicts.length) ? 'NEEDS A DECISION' : 'IN PROGRESS'}</span><span>{task.lanes.length} lanes</span></div>
      <h2><a href={link(p, task.slug)}>{task.slug}</a></h2><p class="intent">{task.intent}</p>
      {task.lanes.map(lane => {
        const agent = agents.get(lane.agent), candidate = task.candidates.find(c => c.agent === lane.agent);
        return <article class="lane-card" key={`${lane.agent}/${pulse[`${task.slug}/${lane.agent}`] || 0}`} data-testid={`lane-${lane.agent}`} data-push={pulse[`${task.slug}/${lane.agent}`] ? 'received' : 'idle'}>
          <div class={`push-pulse ${pulse[`${task.slug}/${lane.agent}`] ? 'pulsing' : ''}`}><span class="avatar">{lane.agent.slice(0, 1).toUpperCase()}</span><div><h3>{agent?.displayName || lane.agent}</h3><p class="muted">{agent?.provider || 'agent'} / {agent?.model || 'unspecified'}</p></div></div>
          <div class="card-status"><Badge candidate={candidate}/><span class="muted">{lane.status}</span></div>
          <p class="sha">Last push <code>{lane.lastSeenSha ? short(lane.lastSeenSha) : 'Waiting for a push'}</code></p>
          {candidate && <><p class="subject">{candidate.subject}</p><div class="card-footer"><span class={candidate.conflicts.length ? 'conflict-text' : 'success-text'}>{candidate.conflicts.length ? `⚑ ${candidate.conflicts.length} conflict region` : '✓ Clean candidate'}</span><span>+{candidate.diffstat.insertions} −{candidate.diffstat.deletions}</span></div></>}
        </article>;
      })}
      <a class="button compare-link" href={link(p, task.slug)}>{task.decision ? 'View decision' : 'Compare candidates'} <span aria-hidden="true">→</span></a>
      {task.decision && <a class="why-link" href={whyLink(p, task.decision.mainSha)}>Why {short(task.decision.mainSha)} landed →</a>}
    </section>)}</div>}
    {view && !view.tasks.length && <p>No tasks yet. Create a task through the project API.</p>}
    <footer>Artifacts holds the Git. Heddle holds the decisions.</footer></main></>;
}
function Diff({ p, t, candidate }: { p: string; t: string; candidate: Candidate }) {
  const [text, setText] = useState('Loading diff…'), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  useEffect(() => { const abort = new AbortController(); setText('Loading diff…'); setError('');
    diff(p, t, candidate.agent, abort.signal).then(setText).catch(e => { if (!abort.signal.aborted) setError(message(e)); });
    return () => abort.abort();
  }, [p, t, candidate.agent, candidate.sourceSha, retry]);
  return error ? <div role="alert">{error} <button class="quiet" onClick={() => setRetry(n => n + 1)}>Retry diff</button></div> : <pre class="diff" aria-label={`Diff for ${candidate.agent}`}><code>{text.split('\n').map((line, i) => <span key={i} class={line.startsWith('+') && !line.startsWith('+++') ? 'diff-add' : line.startsWith('-') && !line.startsWith('---') ? 'diff-remove' : line.startsWith('@@') ? 'diff-region' : ''}>{line}{'\n'}</span>)}</code></pre>;
}
function Discussion({ p, t, turns, humans, onTurn }: { p: string; t: string; turns: Turn[]; humans: Agent[]; onTurn: (turn: Turn) => void }) {
  const [body, setBody] = useState(''), [as, setAs] = useState(''), [replyTo, setReplyTo] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const author = as || humans[0]?.id || '';
  const submit = async (e: Event) => { e.preventDefault(); if (!author || !body.trim() || busy) return; setBusy(true); setError('');
    try { const turn = await request<Turn>(`${taskPath(p, t)}/turns`, { body: body.trim(), as: author, ...(replyTo ? { replyTo } : {}) }); onTurn(turn); setBody(''); setReplyTo(''); }
    catch(e) { setError(message(e)); } finally { setBusy(false); }
  };
  return <section class="panel discussion"><h2>Discussion <span class="count">{turns.length}</span></h2>
    {turns.length ? turns.map(turn => <article class="turn" key={turn.id}><div class="turn-heading"><strong>{turn.author}</strong><span class="muted">{turn.kind} · <time dateTime={turn.at}>{new Date(turn.at).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</time></span></div><p>{turn.body}</p><Signature signedBy={turn.signedBy}/>{turn.replyTo && <p class="muted">Reply to {turn.replyTo}</p>}<button class="quiet small" onClick={() => setReplyTo(turn.id)}>Reply to {turn.author}</button></article>) : <p class="muted">No discussion yet. Add the context that should travel with the code.</p>}
    <form onSubmit={submit}><label>Speak as<select value={author} onChange={e => setAs(e.currentTarget.value)} required><option value="" disabled>Select a human identity</option>{humans.map(a => <option value={a.id}>{a.displayName}</option>)}</select></label>
      <label>Your reply<textarea required maxLength={10000} value={body} onInput={e => setBody(e.currentTarget.value)} placeholder="What should the team consider?"/></label>
      {replyTo && <p>Replying to {replyTo} <button type="button" class="quiet" onClick={() => setReplyTo('')}>Cancel reply</button></p>}
      {error && <ErrorNotice text={error}/>}<button disabled={busy || !author || !body.trim()}>{busy ? 'Posting…' : 'Post signed reply'}</button>
      {!humans.length && <p class="muted">Enroll a human identity through the project API to discuss or decide.</p>}
    </form></section>;
}
function Compare({ p, t }: { p: string; t: string }) {
  const [view, setView] = useState<TaskView>(), [agents, setAgents] = useState<Agent[]>([]), [error, setError] = useState('');
  const [pick, setPick] = useState(''), [rationale, setRationale] = useState(''), [decider, setDecider] = useState(''), [busy, setBusy] = useState(false), [changed, setChanged] = useState(false), [reviewing, setReviewing] = useState(false);
  const version = useRef(0), hydrated = useRef(false);
  const load = async (reviewAgain = false) => { const n = ++version.current; setReviewing(true);
    try { const [task, project] = await Promise.all([request<TaskView>(taskPath(p, t)), request<ProjectView>(projectPath(p))]);
      if (n === version.current) { setView(task); setAgents(project.agents); setError(''); if (reviewAgain) { setChanged(false); setPick(''); } hydrated.current = true; }
    } catch(e) { if (n === version.current) setError(message(e)); } finally { if (n === version.current) setReviewing(false); }
  };
  useEffect(() => { void load(); return () => { version.current++; }; }, [p, t]);
  const live = useFeed(p, event => {
    if (event.type === 'candidate.ready' && event.candidate.task === t) { version.current++; setReviewing(false); setChanged(true); }
    setView(v => v && updateTask(v, event));
    if (event.type === 'engine.error') setError(`Engine operation failed (${event.code}). Review current candidates before retrying.`);
  }, reconnected => { if (reconnected && hydrated.current) setChanged(true); else void load(); });
  const humans = agents.filter(a => a.kind === 'human'), who = decider || humans[0]?.id || '';
  const submit = async (e: Event) => { e.preventDefault(); if (!view || !pick || !rationale.trim() || !who || busy || changed || reviewing) return; setBusy(true); setError('');
    try {
      const decision = await request<Decision>(`${taskPath(p, t)}/decision`, { pick, rationale: rationale.trim(), decider: who, expectHeads: [...view.heads] });
      setView(v => v && { ...v, decision });
    } catch(e) { if (e instanceof ApiError && e.status === 409) { setChanged(true); setError('Candidates changed, review again'); } else setError(message(e)); }
    finally { setBusy(false); }
  };
  const regions = new Map<string, Set<string>>();
  for (const c of view?.candidates || []) for (const region of c.conflicts) { const key = `${region.path}${region.region ? `:${region.region}` : ''}`; regions.set(key, new Set([...(regions.get(key) || []), c.agent, ...region.with])); }
  return <><Header p={p} live={live}/><main><a class="breadcrumb" href={link(p)}>← {p} / board</a><PageTitle eyebrow="COMPARE & DECIDE" title={t}><p>{view?.task.intent || 'Loading task…'}</p></PageTitle>
    {error && <ErrorNotice text={error}/>}
    {changed && <div class="notice warning" role="status">Candidates changed, review again. <button class="quiet" disabled={reviewing} onClick={() => load(true)}>Review current candidates</button></div>}
    {view?.decision && <section class="notice landed" role="status"><strong>✓ Landed {view.decision.pick} on main</strong><p>{view.decision.rationale}</p><a href={whyLink(p, view.decision.mainSha)}>See why {short(view.decision.mainSha)} landed →</a></section>}
    {!!regions.size && <section class="conflict-banner" aria-label="Conflict regions"><strong>⚑ Overlapping work, preserved as alternatives</strong>{[...regions].map(([region, ids]) => <p><code>{region}</code><span>{[...ids].join(' ↔ ')}</span></p>)}</section>}
    <div class="candidate-grid" style={{'--candidate-count': Math.min(view?.candidates.length || 1, 3)}}>{view?.candidates.map(candidate => { const agent = agents.find(a => a.id === candidate.agent); return <section class="candidate panel" key={candidate.agent} aria-label={`${candidate.agent} candidate`}>
      <div class="candidate-heading"><div><p class="eyebrow">CANDIDATE / {candidate.agent}</p><h2>{agent?.displayName || candidate.agent}</h2></div><Badge candidate={candidate}/></div>
      <p class="muted">{agent?.provider || 'unknown provider'} / {agent?.model || 'unspecified model'}</p><Signature signedBy={candidate.signedBy} agent={agent}/>
      <p class="candidate-stats"><code title={candidate.sourceSha}>{short(candidate.sourceSha)}</code><span>{candidate.diffstat.files} file · <b class="success-text">+{candidate.diffstat.insertions}</b> <b class="error-text">−{candidate.diffstat.deletions}</b></span></p>
      <p class="subject">{candidate.subject}</p>{candidate.tests && <p class="test-summary">{candidate.tests.summary} · {candidate.tests.durationMs} ms</p>}
      {candidate.conflicts.map(region => <p class="conflict-tag">⚑ <code>{region.path}{region.region ? `:${region.region}` : ''}</code> · with {region.with.join(', ')}</p>)}
      <Diff p={p} t={t} candidate={candidate}/></section>; })}</div>
    {view && !view.candidates.length && <p class="notice">Waiting for candidate captures. This page updates live.</p>}
    {view?.review && <section class="panel reviewer"><div><p class="eyebrow">REVIEWER / {view.review.model}</p><h2>{view.review.recommendation ? `Recommendation: ${view.review.recommendation.pick}` : 'Review'}</h2><p>{view.review.summary}</p>{view.review.recommendation && <p class="muted">{view.review.recommendation.why}</p>}</div><ul>{view.review.perCandidate.map(c => <li><strong>{c.agent} · {c.verdict}</strong><p>{c.notes}</p></li>)}</ul></section>}
    {view && <div class="decision-layout"><Discussion p={p} t={t} turns={view.turns} humans={humans} onTurn={turn => setView(v => v && { ...v, turns: [...v.turns.filter(x => x.id !== turn.id), turn] })}/>
      <section class="panel decision"><p class="eyebrow">A DECISION, WITH CONTEXT</p><h2>Choose what lands</h2><p class="muted">The rationale and every alternative travel with the code.</p>
        <form onSubmit={submit}><fieldset disabled={busy || !!view.decision || changed || reviewing}><legend>Candidate to land</legend>{view.candidates.map(c => <label class="radio-choice"><input type="radio" name="pick" value={c.agent} required checked={pick === c.agent} onChange={() => setPick(c.agent)}/><span>{c.agent}</span><Badge candidate={c}/></label>)}
          <label>Decide as<select required value={who} onChange={e => setDecider(e.currentTarget.value)}><option value="" disabled>Select a human identity</option>{humans.map(a => <option value={a.id}>{a.displayName}</option>)}</select></label>
          <label>Why this candidate?<textarea required maxLength={10000} value={rationale} onInput={e => setRationale(e.currentTarget.value)} placeholder="Explain the tradeoff. This becomes part of the Git history."/></label>
        </fieldset><button class="land-button" disabled={!pick || !rationale.trim() || !who || busy || !!view.decision || changed || reviewing}>{busy ? 'Landing…' : view.decision ? 'Decision landed' : 'Land candidate →'}</button></form>
        {!humans.length && <p class="muted">Enroll a human identity through the project API to decide.</p>}
      </section></div>}
  </main></>;
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
  const proof = `git fsck --strict${view?.decision && /^[a-zA-Z0-9_-]+$/.test(view.decision.task) && /^[a-zA-Z0-9_-]+$/.test(view.decision.pick) ? `\ngit rev-parse 'origin/main^{tree}' 'origin/candidates/${view.decision.task}/${view.decision.pick}^{tree}'` : ''}`;
  return <><Header p={p}/><main><a class="breadcrumb" href={link(p)}>← {p} / board</a><PageTitle eyebrow="THE WHY / PLAIN GIT" title="The decision stays with the code."><p>Commit <code>{short(sha)}</code> · the chosen work, the alternatives, and the reasoning.</p></PageTitle>{error && <ErrorNotice text={error}/>}
    <div class="why-layout"><section class="panel narrative"><h2>Decision narrative</h2><pre>{view?.narrative || 'Loading narrative…'}</pre>{view?.decision && <a href={link(p, view.decision.task)}>Back to the candidates →</a>}</section>
      <section class="panel verification"><p class="eyebrow">BYTE-EXACT VERIFICATION</p><h2>Verification evidence</h2><p class="notice">Unavailable from the current API.</p><p class="muted">Published verification results are not available yet. Run the checks below against a fresh clone.</p><ul><li>Candidate SHA preserved: awaiting evidence</li><li>Chosen tree matches main: awaiting evidence</li><li>Export reproduces main: awaiting evidence</li><li>Git objects valid: awaiting evidence</li></ul><p>Inspect the published objects locally:</p><pre><code>{proof}</code></pre></section></div>
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
  return <><Header/><main><PageTitle eyebrow="HEDDLE / ARTIFACTS" title={location.pathname === '/' ? 'Decisions that travel with code.' : 'Page not found.'}/><form class="panel" onSubmit={e => { e.preventDefault(); const value = new FormData(e.currentTarget).get('project'); if (typeof value === 'string' && value.trim()) location.assign(link(value.trim())); }}><label>Project ID<input name="project" required placeholder="demo"/></label><button>Open board →</button></form></main></>;
}
render(<App/>, document.getElementById('app')!);
