// SPDX-License-Identifier: Apache-2.0
// The combined check on the board and compare page: a candidate behind main, merged with main by
// Heddle, and that merged result's isolated tests. Shown next to (never instead of) its own tests.
import type { Candidate } from '../../contracts/types';
import { aloneText, combinedText } from './decision';
import { combinedTestedNote } from './format';

const short = (s: string) => s.slice(0, 10);
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Board card line: "✓ 22/22 alone · ✕ 3 failing combined with main". */
export function CombinedLine({ candidate }: { candidate: Candidate }) {
  const combined = combinedText(candidate);
  if (!combined) return null;
  return <p class={`combined-line combined-${combined.tone}`} data-testid={`combined-${candidate.agent}`}>{aloneText(candidate)} <span class="separator">·</span> <strong>{combined.text}</strong></p>;
}

/** Compare panel: Heddle's merge verdict, then the merged result's tests with the failing names. */
export function CombinedPanel({ candidate }: { candidate: Candidate }) {
  const combined = candidate.combined, line = combinedText(candidate);
  if (!combined || !line) return null;
  const t = combined.tests, verdict = combined.heddle;
  return <section class={`combined-panel combined-${line.tone}`} aria-label={`${candidate.agent} combined with main`}>
    <p class="eyebrow">COMBINED WITH MAIN <code title={combined.mainSha}>{short(combined.mainSha)}</code></p>
    <p class="combined-result"><span>{aloneText(candidate)}</span> <span class="separator">·</span> <strong>{line.text}</strong></p>
    {combined.status === 'conflict'
      ? <><p>Heddle could not merge this candidate with main: {plural(verdict.conflictCount || combined.conflicts.length, 'conflict')}.</p>
        <ul class="combined-conflicts">{combined.conflicts.map(c => <li><code>{c.path}</code>{c.symbol && <> · <code>{c.symbol}</code></>}{c.lines && <span class="muted"> · lines {c.lines[0]}–{c.lines[1]}</span>}</li>)}</ul></>
      : <p class="muted">Heddle merged it with main cleanly ({verdict.mergeType}, {plural(verdict.conflictCount, 'conflict')}){combined.sha && <> as <code title={combined.sha}>{short(combined.sha)}</code></>}. {combinedTestedNote(t)}</p>}
    {!!verdict.blockers.length && combined.status === 'conflict' && <ul class="muted">{verdict.blockers.map(b => <li>{b}</li>)}</ul>}
    {t && t.status !== 'pending' && t.status !== 'skipped' && <p class="test-summary">{t.summary} · {t.durationMs} ms{t.observation ? ' · signed observation' : ''}</p>}
    {!!t?.failures?.length && <><p><strong>Failing combined with main</strong></p><ul class="combined-failures">{t.failures.map(name => <li><code>{name}</code></li>)}</ul></>}
    {t?.excerpt && <details><summary>Test output</summary><pre class="combined-excerpt"><code>{t.excerpt}</code></pre></details>}
  </section>;
}
