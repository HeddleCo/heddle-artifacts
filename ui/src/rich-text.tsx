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

/** One line of prose with the same inline formatting as agent turns: `code` and **bold**. */
export function InlineText({ text }: { text: string }) { return <>{inline(text)}</>; }

// Commit and object IDs, signing keys, and file paths with an optional symbol (src/table.ts:parseRow).
const IDENTIFIER = /(ed25519:[0-9a-f]+|\b[0-9a-f]{7,64}\b|[\w.-]*\/[\w./-]*\.\w+(?::\w+)?)/g;
/** Prose that carries identifiers, such as a decision note: the identifiers become `code`, the text is unchanged. */
export function identifiers(text: string): ComponentChildren[] {
  return text.split(IDENTIFIER).map((part, i) => i % 2 ? <code>{part}</code> : part).filter(part => part !== '');
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
    <p><InlineText text={review.summary}/></p>
    <ul class="verdicts">{review.perCandidate.map(c => <li><span class={`verdict ${c.verdict}`}>{c.verdict === 'approve' ? '✓ approve' : '△ concerns'}</span> <strong>{c.agent}</strong><span class="verdict-notes"><InlineText text={c.notes}/></span></li>)}</ul>
    {review.recommendation && <p class="recommendation">Recommends <strong>{review.recommendation.pick}</strong>: <InlineText text={review.recommendation.why}/></p>}
  </div>;
}

const PROOF = /^(\s*)(Test|Combined|Turn|Decision) proof:\s*(\{.*\})\s*$/;
const REVIEW = /^(\s*Review:\s+)(.*?):\s*(\{.*\})\s*$/;
function parsed(json: string): Record<string, unknown> | undefined {
  try { const v = JSON.parse(json); return v && typeof v === 'object' ? v : undefined; } catch { return undefined; }
}
/**
 * The Why note, line by line. Every line and every proof byte stays on the page; signed proof
 * envelopes and review JSON fold into expandable rows so the record reads as a record.
 */
export function Narrative({ text }: { text: string }) {
  return <div class="narrative-lines">{text.split('\n').map(line => {
    const proof = PROOF.exec(line);
    if (proof) {
      const key = parsed(proof[3])?.publicKey;
      return <details class="proof"><summary>{proof[1]}{proof[2]} proof · signed{typeof key === 'string' ? <> · <code>ed25519:{key.slice(0, 8)}…</code></> : null}</summary><code class="proof-body">{proof[3]}</code></details>;
    }
    const review = REVIEW.exec(line);
    const summary = review && parsed(review[3])?.summary;
    if (review && typeof summary === 'string') {
      return <details class="proof"><summary>{review[1]}{identifiers(review[2])}: {summary}</summary><code class="proof-body">{review[3]}</code></details>;
    }
    return <div class="line">{identifiers(line) }</div>;
  })}</div>;
}
