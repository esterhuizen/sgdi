'use client';

// Client wrapper around <Leaderboard /> that adds:
//   - case-insensitive substring search over pool_name + pool_address
//   - "show top N" / "show all" toggle (default N = 25)
//
// State model:
//   - search empty + collapsed     → top N pools shown
//   - search empty + expanded      → all pools shown
//   - search non-empty             → filtered set across ALL pools, toggle hidden
//
// Filtering is client-side because the full pool set is small (~100). No
// virtualization is needed at this scale.

import { useMemo, useState } from 'react';
import { Leaderboard } from './Leaderboard';
import type { FormattedScore, FormattedBaseline } from '@/lib/data';

type Props = {
  pools: FormattedScore[];
  baseline: FormattedBaseline | null;
  epoch: number;
  defaultLimit?: number;
};

export function LeaderboardWithSearch({ pools, baseline, epoch, defaultLimit = 25 }: Props) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  const trimmed = query.trim().toLowerCase();
  const searching = trimmed.length > 0;

  const filtered = useMemo(() => {
    if (!searching) return pools;
    return pools.filter((p) => {
      const name = (p.pool_name ?? '').toLowerCase();
      const addr = p.pool_address.toLowerCase();
      return name.includes(trimmed) || addr.includes(trimmed);
    });
  }, [pools, trimmed, searching]);

  const visible = searching ? filtered : expanded ? pools : pools.slice(0, defaultLimit);
  const totalCount = pools.length;
  const canExpand = totalCount > defaultLimit;

  return (
    <div className="space-y-3">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative max-w-md flex-1">
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search by pool name or address…"
            aria-label="Search pools"
            className="
              w-full rounded-md border border-ring bg-surface px-3 py-2 text-sm text-ink
              placeholder:text-ink-dim
              focus:border-ink focus:outline-none focus:ring-2 focus:ring-ink/15
              transition-colors
            "
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery('')}
              aria-label="Clear search"
              className="
                absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-ink-dim
                hover:bg-bg-muted hover:text-ink
              "
            >
              ×
            </button>
          )}
        </div>
        <div className="text-xs text-ink-dim">
          {searching ? (
            <span>
              <span className="num font-medium text-ink-muted">{filtered.length}</span> match
              {filtered.length === 1 ? '' : 'es'} of{' '}
              <span className="num">{totalCount}</span> pools
            </span>
          ) : expanded ? (
            <span>
              Showing all <span className="num font-medium text-ink-muted">{totalCount}</span> pools
            </span>
          ) : (
            <span>
              Showing top <span className="num font-medium text-ink-muted">{Math.min(defaultLimit, totalCount)}</span> of{' '}
              <span className="num">{totalCount}</span> pools
            </span>
          )}
        </div>
      </div>

      <Leaderboard pools={visible} baseline={baseline} epoch={epoch} />

      {!searching && canExpand && (
        <div className="flex justify-center pt-1">
          <button
            type="button"
            onClick={() => setExpanded((v) => !v)}
            className="
              inline-flex items-center gap-1.5 rounded-full border border-ring bg-surface
              px-4 py-1.5 text-xs font-medium text-ink-muted
              transition-colors hover:border-ink hover:text-ink
            "
          >
            {expanded ? (
              <>Show top {defaultLimit} ↑</>
            ) : (
              <>Show all {totalCount} ↓</>
            )}
          </button>
        </div>
      )}
    </div>
  );
}
