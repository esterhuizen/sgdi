'use client';

// Single sortable table of (country, city, ASN) tuples — one row per
// distinct hostable location currently occupied by at least one validator.
// Composite rarity = geometric mean of the per-dimension rarities (same
// formula as GDI). Per-dim rarities are shown as small subtext under each
// location name; clicking a column header sorts by that dimension.

import { useMemo, useState } from 'react';
// TupleRow lives in src/lib/tuples.ts (shared with /validator/<pubkey>).
// Re-export so existing `import { TupleRow } from '@/components/LocationsTable'`
// callers don't break.
export type { TupleRow } from '@/lib/tuples';
import type { TupleRow } from '@/lib/tuples';

type SortField = 'composite' | 'country' | 'city' | 'asn' | 'performance' | 'ibrl' | 'validators' | 'dz' | 'stake';
type SortDir = 'asc' | 'desc';

const fmt = {
  num: (v: number | null, d = 2) => (v == null ? '—' : v.toFixed(d)),
  sol: (v: number) => {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
};

const SECTION_LIMIT = 25;

function sortValue(r: TupleRow, field: SortField): number {
  switch (field) {
    case 'composite':   return r.composite ?? -Infinity;
    case 'country':     return r.rarityCountry ?? -Infinity;  // sort by per-dim rarity, not alpha
    case 'city':        return r.rarityCity ?? -Infinity;
    case 'asn':         return r.rarityAsn ?? -Infinity;
    case 'performance': return r.avgWizScore ?? -Infinity;
    case 'ibrl':        return r.avgIbrlScore ?? -Infinity;
    case 'validators':  return r.validatorCount;
    case 'dz':          return r.dzCount;
    case 'stake':       return r.totalStakeSol;
  }
}

function SortHeader({
  field,
  active,
  dir,
  onSort,
  children,
  align = 'left',
  title,
}: {
  field: SortField;
  active: boolean;
  dir: SortDir;
  onSort: (f: SortField) => void;
  children: React.ReactNode;
  align?: 'left' | 'right';
  title?: string;
}) {
  return (
    <th
      className={
        (align === 'right' ? 'text-right ' : '') +
        'py-3 pr-3 first:pl-5 last:pr-5 font-semibold'
      }
    >
      <button
        type="button"
        onClick={() => onSort(field)}
        title={title || `Sort by ${typeof children === 'string' ? children : field}`}
        className={
          'inline-flex items-center gap-1 ' +
          (active ? 'text-ink' : 'text-ink-dim hover:text-ink')
        }
      >
        <span>{children}</span>
        <span aria-hidden className="text-[10px]">
          {active ? (dir === 'desc' ? '↓' : '↑') : '↕'}
        </span>
      </button>
    </th>
  );
}

export function LocationsTable({ tuples }: { tuples: TupleRow[] }) {
  const [dzOnly, setDzOnly] = useState(true);
  const [minIbrl, setMinIbrl] = useState(0);
  const [sortField, setSortField] = useState<SortField>('composite');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showAll, setShowAll] = useState(false);

  const filtered = useMemo(() => {
    let cleaned = tuples.filter(
      (t) => t.country && t.city && t.asnId &&
             t.country.toLowerCase() !== 'unknown' &&
             t.asnId.toLowerCase() !== 'unknown',
    );
    if (dzOnly) cleaned = cleaned.filter((t) => t.dzCount > 0);
    // Min-IBRL is an absolute floor against the location's avg IBRL. Tuples
    // with no IBRL data (avgIbrlScore == null) are dropped when minIbrl > 0
    // — the operator asked for proven quality and we can't make that claim
    // for a location without measurements.
    if (minIbrl > 0) {
      cleaned = cleaned.filter(
        (t) => t.avgIbrlScore != null && t.avgIbrlScore >= minIbrl,
      );
    }
    return cleaned;
  }, [tuples, dzOnly, minIbrl]);

  const sorted = useMemo(() => {
    const sign = sortDir === 'desc' ? -1 : 1;
    return [...filtered].sort((a, b) => sign * (sortValue(a, sortField) - sortValue(b, sortField)));
  }, [filtered, sortField, sortDir]);

  const visible = showAll ? sorted : sorted.slice(0, SECTION_LIMIT);

  function toggleSort(field: SortField) {
    if (field === sortField) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  }

  return (
    <>
      <div className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dzOnly}
            onChange={(e) => setDzOnly(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="text-ink">DoubleZero-supported locations only</span>
        </label>
        <label className="inline-flex items-center gap-3 text-sm"
          title="Filter to locations whose avg IBRL meets this floor. Locations with no IBRL data are excluded when the floor is > 0.">
          <span className="text-ink whitespace-nowrap">Min IBRL</span>
          <input
            type="range"
            min={0}
            max={100}
            step={5}
            value={minIbrl}
            onChange={(e) => setMinIbrl(Number(e.target.value))}
            className="h-1 w-32 accent-ink"
          />
          <span className="num w-8 text-right text-ink tabular-nums">{minIbrl}</span>
        </label>
        {minIbrl > 0 && (
          <button
            type="button"
            onClick={() => setMinIbrl(0)}
            className="text-xs text-ink-dim hover:text-ink"
          >
            clear
          </button>
        )}
      </div>

      <div className="mt-2 text-sm text-ink-dim">
        {filtered.length} unique locations. Click a column header to re-sort.
        Per-dimension rarity shown as subtext under each name.
      </div>

      <div className="surface mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.10em] text-ink-dim">
            <tr>
              <SortHeader field="composite" active={sortField === 'composite'} dir={sortDir} onSort={toggleSort}
                title="Rarity = geometric mean of country, city, ASN rarities">
                Rarity
              </SortHeader>
              <SortHeader field="country" active={sortField === 'country'} dir={sortDir} onSort={toggleSort}
                title="Sort by country rarity">
                Country
              </SortHeader>
              <SortHeader field="city" active={sortField === 'city'} dir={sortDir} onSort={toggleSort}
                title="Sort by city rarity">
                City
              </SortHeader>
              <SortHeader field="asn" active={sortField === 'asn'} dir={sortDir} onSort={toggleSort}
                title="Sort by ASN rarity">
                ASN
              </SortHeader>
              <SortHeader field="ibrl" active={sortField === 'ibrl'} dir={sortDir} onSort={toggleSort} align="right"
                title="IBRL — avg Jito block-build quality score (0–100). Captures network/DC quality: non-vote packing, slot time, vote packing.">
                IBRL
              </SortHeader>
              <SortHeader field="performance" active={sortField === 'performance'} dir={sortDir} onSort={toggleSort} align="right"
                title="Operator score — avg Stakewiz wiz_score across validators at this location (0–100). Captures operator competence: vote success, skip rate, uptime, commission.">
                Operator score
              </SortHeader>
              <SortHeader field="validators" active={sortField === 'validators'} dir={sortDir} onSort={toggleSort} align="right">
                Validators
              </SortHeader>
              <SortHeader field="dz" active={sortField === 'dz'} dir={sortDir} onSort={toggleSort} align="right">
                On DZ
              </SortHeader>
              <SortHeader field="stake" active={sortField === 'stake'} dir={sortDir} onSort={toggleSort} align="right">
                Stake
              </SortHeader>
            </tr>
          </thead>
          <tbody className="text-ink">
            {visible.length === 0 && (
              <tr>
                <td colSpan={9} className="py-12 text-center text-ink-dim">
                  No locations match the current filter.
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr
                key={r.key}
                className="border-t border-ring transition hover:bg-bg-muted/40"
              >
                <td className="num py-3 pl-5 pr-3 font-display text-base font-semibold tabular-nums text-ink">
                  {fmt.num(r.composite, 2)}
                </td>
                <td className="py-3 pr-3">
                  <div className="font-medium text-ink">{r.country}</div>
                  <div className="text-xs text-ink-dim tabular-nums">{fmt.num(r.rarityCountry, 2)}</div>
                </td>
                <td className="py-3 pr-3">
                  <div className="font-medium text-ink">{r.city}</div>
                  <div className="text-xs text-ink-dim tabular-nums">{fmt.num(r.rarityCity, 2)}</div>
                </td>
                <td className="py-3 pr-3">
                  <div className="font-medium text-ink">{r.asnName}</div>
                  <div className="text-xs text-ink-dim">
                    <span className="font-mono">{r.asnId}</span>{' '}
                    · <span className="tabular-nums">{fmt.num(r.rarityAsn, 2)}</span>
                  </div>
                </td>
                <td className="num py-3 pr-3 text-right text-ink tabular-nums">
                  <div>{fmt.num(r.avgIbrlScore, 1)}</div>
                  {r.maxIbrlScore != null && (
                    <div className="text-xs text-ink-dim tabular-nums">max {fmt.num(r.maxIbrlScore, 1)}</div>
                  )}
                </td>
                <td className="num py-3 pr-3 text-right text-ink tabular-nums">
                  {fmt.num(r.avgWizScore, 1)}
                </td>
                <td className="num py-3 pr-3 text-right text-ink-muted tabular-nums">
                  {r.validatorCount}
                </td>
                <td className="num py-3 pr-3 text-right tabular-nums">
                  <span className={r.dzCount > 0 ? 'text-success' : 'text-ink-dim'}>
                    {r.dzCount}
                  </span>
                </td>
                <td className="num py-3 pr-5 text-right text-ink-muted tabular-nums">
                  {fmt.sol(r.totalStakeSol)} SOL
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {sorted.length > SECTION_LIMIT && (
        <button
          type="button"
          onClick={() => setShowAll((v) => !v)}
          className="mt-3 text-xs text-ink-dim hover:text-ink"
        >
          {showAll ? `Show top ${SECTION_LIMIT}` : `Show all ${sorted.length}`}
        </button>
      )}
    </>
  );
}
