'use client';

// Client wrapper around <Leaderboard /> that adds:
//   - TVL minimum filter via preset pills (default 50k SOL)
//   - case-insensitive substring search over pool_name + pool_address
//   - "show top N" / "show all" toggle (default N = 25)
//
// State model (filters compose left-to-right):
//   pools → [TVL floor filter] → [search filter] → [top-N slice or show-all]

import { useMemo, useState } from 'react';
import { Leaderboard } from './Leaderboard';
import type { FormattedScore, FormattedBaseline } from '@/lib/data';
import { DEFAULT_TVL_FLOOR_SOL } from '@/lib/leaderboard-config';

type Props = {
  pools: FormattedScore[];
  baseline: FormattedBaseline | null;
  epoch: number;
  defaultLimit?: number;
};

// TVL preset thresholds in SOL. 0 = "All" (no filter). Values chosen as
// round, log-spaced milestones a viewer can reason about: 50k = serious
// LST cutoff, 1M+ = "household name" pools only.
const TVL_PRESETS: { value: number; label: string }[] = [
  { value: 0, label: 'All' },
  { value: 50_000, label: '50k' },
  { value: 100_000, label: '100k' },
  { value: 500_000, label: '500k' },
  { value: 1_000_000, label: '1M+' },
];

const DEFAULT_TVL_FLOOR = DEFAULT_TVL_FLOOR_SOL;

function formatFloor(sol: number): string {
  if (sol >= 1_000_000) return `${sol / 1_000_000}M`;
  if (sol >= 1_000) return `${sol / 1_000}k`;
  return String(sol);
}

export function LeaderboardWithSearch({ pools, baseline, epoch, defaultLimit = 25 }: Props) {
  const [tvlFloor, setTvlFloor] = useState<number>(DEFAULT_TVL_FLOOR);
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(false);

  const trimmed = query.trim().toLowerCase();
  const searching = trimmed.length > 0;

  // Step 1: apply TVL floor.
  const tvlFiltered = useMemo(
    () => pools.filter((p) => (p.total_stake_sol ?? 0) >= tvlFloor),
    [pools, tvlFloor],
  );

  // Step 2: apply search (over the TVL-filtered set).
  const searchFiltered = useMemo(() => {
    if (!searching) return tvlFiltered;
    return tvlFiltered.filter((p) => {
      const name = (p.pool_name ?? '').toLowerCase();
      const addr = p.pool_address.toLowerCase();
      return name.includes(trimmed) || addr.includes(trimmed);
    });
  }, [tvlFiltered, trimmed, searching]);

  // Step 3: slice to top-N unless expanded or searching.
  const visible = searching
    ? searchFiltered
    : expanded
      ? tvlFiltered
      : tvlFiltered.slice(0, defaultLimit);
  const totalCount = tvlFiltered.length;
  const canExpand = totalCount > defaultLimit;
  const floorSuffix = tvlFloor > 0 ? ` ≥ ${formatFloor(tvlFloor)} SOL` : '';

  return (
    <div className="space-y-3">
      {/* TVL preset pills */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Min stake
        </span>
        {TVL_PRESETS.map((p) => {
          const isActive = tvlFloor === p.value;
          return (
            <button
              key={p.value}
              type="button"
              onClick={() => setTvlFloor(p.value)}
              aria-pressed={isActive}
              className={
                isActive
                  ? 'inline-flex items-center rounded-full border border-ink bg-bg-muted px-3 py-1 text-xs font-medium text-ink transition-colors'
                  : 'inline-flex items-center rounded-full border border-ring bg-surface px-3 py-1 text-xs text-ink-muted transition-colors hover:border-ink hover:text-ink'
              }
            >
              {p.label}
            </button>
          );
        })}
      </div>

      {/* Search input + counter */}
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
              <span className="num font-medium text-ink-muted">{searchFiltered.length}</span>{' '}
              match{searchFiltered.length === 1 ? '' : 'es'} of{' '}
              <span className="num">{totalCount}</span> pool{totalCount === 1 ? '' : 's'}
              {floorSuffix}
            </span>
          ) : expanded ? (
            <span>
              Showing all <span className="num font-medium text-ink-muted">{totalCount}</span>{' '}
              pool{totalCount === 1 ? '' : 's'}
              {floorSuffix}
            </span>
          ) : (
            <span>
              Showing top{' '}
              <span className="num font-medium text-ink-muted">
                {Math.min(defaultLimit, totalCount)}
              </span>{' '}
              of <span className="num">{totalCount}</span> pool{totalCount === 1 ? '' : 's'}
              {floorSuffix}
            </span>
          )}
        </div>
      </div>

      {/* Table or empty state */}
      {totalCount === 0 ? (
        <div className="surface p-8 text-center">
          <p className="text-sm text-ink-muted">
            No pools match these filters.{' '}
            <button
              type="button"
              onClick={() => setTvlFloor(0)}
              className="drilldown text-ink hover:text-ink"
            >
              Show all
            </button>
          </p>
        </div>
      ) : (
        <Leaderboard pools={visible} baseline={baseline} epoch={epoch} />
      )}

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
