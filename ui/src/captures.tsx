// SPDX-License-Identifier: Apache-2.0
import { useEffect, useRef, useState } from 'preact/hooks';
import type { Agent, Capture, CaptureHistory, Lane } from '../../contracts/types';
import { request, taskPath } from './api';

const key = (c: Capture) => `${c.agent}/${c.sourceSha}`;
const clock = (at: string) => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
export function Captures({ p, t, agents, lanes, refresh }: { p: string; t: string; agents: Agent[]; lanes: Lane[]; refresh: number }) {
  const [history, setHistory] = useState<CaptureHistory>(), [selected, setSelected] = useState(''), [error, setError] = useState(''), [retry, setRetry] = useState(0);
  const dots = useRef(new Map<string, HTMLButtonElement>());
  useEffect(() => {
    const abort = new AbortController(); let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const data = await request<CaptureHistory>(`${taskPath(p, t)}/captures`, undefined, abort.signal);
        if (abort.signal.aborted) return;
        setHistory(data); setError('');
        if (data.pending) timer = setTimeout(load, 1200);
      } catch { if (!abort.signal.aborted) setError('Could not load captures.'); }
    };
    void load();
    return () => { abort.abort(); clearTimeout(timer); };
  }, [p, t, refresh, retry]);
  const all = (history?.lanes.flatMap(l => l.captures) ?? []).sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt) || key(a).localeCompare(key(b)));
  const index = Math.max(0, all.findIndex(c => key(c) === selected)), current = all[index];
  const start = all.length ? Date.parse(all[0].capturedAt) : 0, end = all.length ? Date.parse(all[all.length - 1].capturedAt) : 0;
  const position = (at: string) => end === start ? 50 : 3 + 94 * (Date.parse(at) - start) / (end - start);
  const step = (direction: number, focus = false) => {
    const next = all[Math.min(all.length - 1, Math.max(0, index + direction))];
    if (next) { setSelected(key(next)); if (focus) dots.current.get(key(next))?.focus(); }
  };
  return <section id="captures" class="panel captures" aria-label="Captures" onKeyDown={e => {
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); step(e.key === 'ArrowRight' ? 1 : -1, true); }
  }}>
    <div class="captures-heading"><div><p class="eyebrow">SIGNED HEDDLE CAPTURES</p><h2>Captures <span class="count">{all.length}</span></h2></div>
      <div class="capture-navigation"><button class="quiet" disabled={!current || index === 0} onClick={() => step(-1)}>Previous</button><button class="quiet" disabled={!current || index === all.length - 1} onClick={() => step(1)}>Next</button></div>
    </div>
    <p class="muted">Each dot is a capture. Spans show when agents worked in parallel. Use ← / → to step through time.</p>
    {error && <p role="alert">{error} <button class="quiet small" onClick={() => setRetry(n => n + 1)}>Retry captures</button></p>}
    {!history && !error && <p role="status">Loading captures…</p>}
    {history && <div class="capture-timeline">
      <div class="capture-axis"><span>Capture time</span><div>{all.length > 0 && [0, 0.5, 1].map((fraction, i) => <time key={i} style={{ left: `${3 + 94 * fraction}%` }}>{clock(new Date(start + (end - start) * fraction).toISOString())}</time>)}</div></div>
      {history.lanes.map(track => {
        const lane = lanes.find(l => l.agent === track.agent), agent = agents.find(a => a.id === track.agent), first = track.captures[0], last = track.captures[track.captures.length - 1];
        return <div class="capture-track" key={track.agent} data-agent={track.agent}>
          <div class="capture-label"><strong>{agent?.displayName || track.agent}</strong>{lane?.unbriefed ? <span class="tag dashed control">○ control</span> : lane?.briefing ? <span class="tag dashed">◆ briefed</span> : null}</div>
          <div class="capture-track-line">
            {first ? <><span class="capture-span" aria-hidden="true" style={{ left: `${position(first.capturedAt)}%`, width: `${position(last.capturedAt) - position(first.capturedAt)}%` }}/>
              {track.captures.map(c => <button key={key(c)} ref={el => { if (el) dots.current.set(key(c), el); else dots.current.delete(key(c)); }} class="capture-dot" style={{ left: `${position(c.capturedAt)}%` }} aria-pressed={current && key(c) === key(current)} aria-label={`${agent?.displayName || c.agent}, ${clock(c.capturedAt)}, ${c.sourceSha.slice(0, 10)}: ${c.subject}`} title={`${clock(c.capturedAt)} · ${c.subject}`} onClick={() => setSelected(key(c))}/>)}</>
              : <span class="muted capture-waiting">Waiting for a capture</span>}
          </div>
        </div>;
      })}
    </div>}
    {history && !all.length && <p class="muted">No captures yet. Pushes will appear here live.</p>}
    {current && <div class="capture-detail" aria-live="polite" aria-atomic="true">
      <p class="eyebrow">{agents.find(a => a.id === current.agent)?.displayName || current.agent} · CAPTURE {index + 1} OF {all.length}</p>
      <h3>{current.subject}</h3><p class="capture-metadata"><time dateTime={current.capturedAt}>{new Date(current.capturedAt).toLocaleString()}</time><code title={current.sourceSha}>{current.sourceSha.slice(0, 10)}</code><span>{current.diffstat.files} files · <b class="success-text">+{current.diffstat.insertions}</b> <b class="error-text">−{current.diffstat.deletions}</b></span></p>
      <p class={`test-summary ${current.tests?.status === 'pass' ? 'success-text' : current.tests?.status === 'fail' || current.tests?.status === 'error' ? 'error-text' : 'muted'}`}>Tests: {current.tests ? `${current.tests.status} · ${current.tests.passed} passed / ${current.tests.failed} failed · ${current.tests.summary}` : 'not recorded'}</p>
      <p class="muted">Semantic changes since {history?.lanes.find(l => l.agent === current.agent)?.captures[0].sourceSha === current.sourceSha ? 'the task base' : 'this lane’s previous capture'}:</p>
      {current.semantic.status === 'ready' ? current.semantic.changes.length ? <ul class="semantic-changes">{current.semantic.changes.map((c, i) => <li key={i}>{c.description}</li>)}</ul> : <p>No semantic changes reported by Heddle.</p>
        : <p role="status">Semantic summary {current.semantic.status === 'pending' ? 'pending…' : 'unavailable'}.</p>}
    </div>}
  </section>;
}
