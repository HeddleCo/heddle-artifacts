// SPDX-License-Identifier: Apache-2.0
import { displayName } from './format';
import { RichText } from './rich-text';

/** Only render anchors supplied by the record. A file anchor has no invented symbol. */
export function AnchorChip({ anchor }: { anchor: string }) {
  const colon = anchor.lastIndexOf(':');
  const path = colon > 0 ? anchor.slice(0, colon) : anchor;
  const symbol = colon > 0 ? anchor.slice(colon + 1) : '';
  return <span class="anchor-chip" title={anchor}>{symbol && <span class="symbol-chip">◆ {symbol}</span>}<code>{path}</code></span>;
}

export function AnnotationCard({ kind, content, target, scope, attribution, tags, hash, anchor }: {
  kind: string; content: string; target?: string; scope?: string; attribution: string;
  tags?: string[]; hash?: string; anchor?: string;
}) {
  const tone = ['constraint', 'invariant', 'rationale'].includes(kind) ? kind : 'reason';
  return <article class={`annotation-card annotation-${tone}`} aria-label={kind === 'Reason' ? 'Reason' : `${kind} annotation`}>
    <div class="annotation-heading"><span class="kind-dot" aria-hidden="true"/><strong>{kind}</strong></div>
    <div class="annotation-note">
      {(target || scope || anchor) && <div class="annotation-target">
        {target && <code class="briefing-target">{target}</code>}
        {scope?.startsWith('symbol:') ? <span class="symbol-chip">◆ {scope.slice(7)}</span> : scope && <span class="annotation-scope">{scope}</span>}
        {anchor && <AnchorChip anchor={anchor}/>}
      </div>}
      <RichText text={content}/>
      <div class="annotation-footer"><span class="annotation-author" title={attribution}>by {displayName(attribution)}</span>
        {tags?.map(tag => <span class="tag" key={tag}>{tag}</span>)}
        {hash && <code class="briefing-hash" title={hash}>{hash.slice(0, 10)}</code>}
      </div>
    </div>
  </article>;
}
