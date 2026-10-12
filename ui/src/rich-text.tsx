// SPDX-License-Identifier: Apache-2.0
// Light formatting for agent-written discussion turns: paragraphs, fenced code, inline code and
// bold. It builds Preact nodes from plain text and never sets HTML, so turn bodies cannot inject markup.
import type { ComponentChildren } from 'preact';
import type { Review } from '../../contracts/types';

function inline(text: string): ComponentChildren[] {
  const out: ComponentChildren[] = [];
  // `code` first so ** inside code stays literal; then **bold**.
  for (const [i, part] of text.split(/(`[^`\n]+`)/g).entries()) {
    if (i % 2) { out.push(<code>{part.slice(1, -1)}</code>); continue; }
    for (const [j, piece] of part.split(/(\*\*[^*\n]+\*\*)/g).entries()) {
      if (piece) out.push(j % 2 ? <strong>{piece.slice(2, -2)}</strong> : piece);
    }
  }
  return out;
}

export function RichText({ text }: { text: string }) {
  const blocks: ComponentChildren[] = [];
  for (const [i, chunk] of text.split(/```[^\n]*\n?/g).entries()) {
    if (i % 2) { if (chunk.trim()) blocks.push(<pre class="turn-code"><code>{chunk.replace(/\n$/, '')}</code></pre>); continue; }
    for (const para of chunk.split(/\n{2,}/)) {
      const lines = para.split('\n').filter(l => l.trim());
      if (!lines.length) continue;
      if (lines.every(l => /^\s*[-*]\s+/.test(l))) blocks.push(<ul>{lines.map(l => <li>{inline(l.replace(/^\s*[-*]\s+/, ''))}</li>)}</ul>);
      else blocks.push(<p>{lines.flatMap((l, k) => k ? [<br/>, ...inline(l)] : inline(l))}</p>);
    }
  }
  return <div class="rich-text">{blocks}</div>;
}

/** A reviewer turn body is the signed Review JSON; anything else renders as text. */
export function parseReview(body: string): Review | undefined {
  try {
    const value = JSON.parse(body) as Review;
    return value && typeof value.summary === 'string' && Array.isArray(value.perCandidate) ? value : undefined;
  } catch { return undefined; }
}

export function ReviewBody({ review }: { review: Review }) {
  return <div class="review-body">
    <p>{review.summary}</p>
    <ul class="verdicts">{review.perCandidate.map(c => <li><span class={`verdict ${c.verdict}`}>{c.verdict === 'approve' ? '✓ approve' : '△ concerns'}</span> <strong>{c.agent}</strong><span class="verdict-notes">{c.notes}</span></li>)}</ul>
    {review.recommendation && <p class="recommendation">Recommends <strong>{review.recommendation.pick}</strong>: {review.recommendation.why}</p>}
  </div>;
}
