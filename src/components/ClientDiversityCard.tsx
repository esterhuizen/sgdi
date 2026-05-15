'use client';

// Pool-detail card: client diversity at-a-glance with an inline expand
// toggle. Collapsed shows the dominant-client share and name; expanded
// swaps to a top-3 list within the same card. No layout change to the
// surrounding grid — only the card's own height grows by a few px.

import { useState } from 'react';

export type ClientDiversityRow = {
  client: string;
  /** Pre-formatted percentage string (e.g. "71.5%"). Parent formats so the
   *  client component stays presentation-only. */
  shareLabel: string;
};

export function ClientDiversityCard({ topClients }: { topClients: ClientDiversityRow[] }) {
  const [expanded, setExpanded] = useState(false);
  const top = topClients[0];

  if (!top) {
    return (
      <div className="surface p-5">
        <div className="text-xs uppercase tracking-wider text-ink-dim">Client diversity</div>
        <div className="num mt-2 text-2xl text-ink">—</div>
        <div className="text-xs text-ink-dim">no client data</div>
      </div>
    );
  }

  return (
    <div className="surface p-5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-xs uppercase tracking-wider text-ink-dim">Client diversity</div>
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-label={expanded ? 'Collapse client list' : 'Show top clients'}
          aria-expanded={expanded}
          className="text-base leading-none text-ink-dim hover:text-ink"
        >
          {expanded ? '−' : '+'}
        </button>
      </div>

      {!expanded ? (
        <>
          <div className="num mt-2 text-2xl text-ink">
            {top.shareLabel}{' '}
            <span className="text-lg font-normal text-ink-muted">{top.client}</span>
          </div>
          <div className="mt-1 text-xs text-ink-dim">share on dominant client</div>
        </>
      ) : (
        <ol className="mt-2 space-y-1 text-sm">
          {topClients.slice(0, 3).map((c, i) => (
            <li key={c.client} className="flex justify-between">
              <span className="text-ink">
                {i + 1}. {c.client}
              </span>
              <span className="num tabular-nums text-ink-muted">{c.shareLabel}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
