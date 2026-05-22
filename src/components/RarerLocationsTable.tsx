'use client';

// Sortable table of (country, city, ASN) buckets rarer than the viewing
// validator's current location, filtered by their IBRL bar. The full
// list comes pre-filtered from the server; this component only handles
// presentation: 40-row default, "Show all" expansion, and column sort.
//
// Mirrors LocationsTable's sort UX so the two surfaces feel consistent.

import { useMemo, useState } from 'react';
import type { TupleRow } from '@/lib/tuples';

export type AltRow = TupleRow & { gainVsMine: number };

type SortField = 'rarity' | 'country' | 'city' | 'asn' | 'ibrl' | 'validators' | 'dz';
type SortDir = 'asc' | 'desc';

const DEFAULT_VISIBLE = 40;

const fmt = {
  num: (v: number | null, d = 2) => (v == null ? '—' : v.toFixed(d)),
};

function sortValue(r: AltRow, field: SortField): number {
  switch (field) {
    case 'rarity':     return r.gainVsMine ?? -Infinity;
    case 'country':    return r.rarityCountry ?? -Infinity;
    case 'city':       return r.rarityCity ?? -Infinity;
    case 'asn':        return r.rarityAsn ?? -Infinity;
    case 'ibrl':       return r.avgIbrlScore ?? -Infinity;
    case 'validators': return r.validatorCount;
    case 'dz':         return r.dzCount;
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
        'py-2.5 pr-3 first:pl-4 last:pr-4 font-semibold'
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

export function RarerLocationsTable({
  alternatives,
  myIbrl,
}: {
  alternatives: AltRow[];
  myIbrl: number | null;
}) {
  const [sortField, setSortField] = useState<SortField>('rarity');
  const [sortDir, setSortDir] = useState<SortDir>('desc');
  const [showAll, setShowAll] = useState(false);

  const sorted = useMemo(() => {
    const arr = alternatives.slice();
    const sign = sortDir === 'desc' ? -1 : 1;
    arr.sort((a, b) => (sortValue(a, sortField) - sortValue(b, sortField)) * sign);
    return arr;
  }, [alternatives, sortField, sortDir]);

  const visible = showAll ? sorted : sorted.slice(0, DEFAULT_VISIBLE);
  const total = alternatives.length;
  const hasMore = total > DEFAULT_VISIBLE;

  const toggleSort = (f: SortField) => {
    if (f === sortField) {
      setSortDir((d) => (d === 'desc' ? 'asc' : 'desc'));
    } else {
      setSortField(f);
      setSortDir('desc');
    }
  };

  return (
    <div className="surface mt-3 overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.12em] text-ink-dim">
          <tr>
            <SortHeader
              field="rarity"
              active={sortField === 'rarity'}
              dir={sortDir}
              onSort={toggleSort}
              title="Sort by rarity gain over your current bucket"
            >
              Rarity
            </SortHeader>
            <SortHeader
              field="country"
              active={sortField === 'country'}
              dir={sortDir}
              onSort={toggleSort}
              title="Sort by country rarity"
            >
              Country
            </SortHeader>
            <SortHeader
              field="city"
              active={sortField === 'city'}
              dir={sortDir}
              onSort={toggleSort}
              title="Sort by city rarity"
            >
              City
            </SortHeader>
            <SortHeader
              field="asn"
              active={sortField === 'asn'}
              dir={sortDir}
              onSort={toggleSort}
              title="Sort by ASN rarity"
            >
              ASN
            </SortHeader>
            <SortHeader
              field="ibrl"
              active={sortField === 'ibrl'}
              dir={sortDir}
              onSort={toggleSort}
              align="right"
              title="Sort by average IBRL across validators at this location"
            >
              IBRL (avg)
            </SortHeader>
            <SortHeader
              field="validators"
              active={sortField === 'validators'}
              dir={sortDir}
              onSort={toggleSort}
              align="right"
              title="Sort by number of validators currently in this bucket"
            >
              Validators
            </SortHeader>
            <SortHeader
              field="dz"
              active={sortField === 'dz'}
              dir={sortDir}
              onSort={toggleSort}
              align="right"
              title="Sort by number of DoubleZero-enabled validators in this bucket"
            >
              On DZ
            </SortHeader>
          </tr>
        </thead>
        <tbody className="text-ink">
          {visible.map((t) => (
            <tr key={t.key} className="border-t border-ring">
              <td className="num py-3 pl-4 pr-3 font-display text-base font-semibold tabular-nums text-ink">
                {fmt.num(t.composite, 2)}
                <div className="text-xs font-normal text-ink-dim tabular-nums">
                  +{fmt.num(t.gainVsMine, 2)} vs yours
                </div>
              </td>
              <td className="py-3 pr-3">
                <div className="font-medium text-ink">{t.country}</div>
                <div className="text-xs text-ink-dim tabular-nums">{fmt.num(t.rarityCountry, 2)}</div>
              </td>
              <td className="py-3 pr-3">
                <div className="font-medium text-ink">{t.city}</div>
                <div className="text-xs text-ink-dim tabular-nums">{fmt.num(t.rarityCity, 2)}</div>
              </td>
              <td className="py-3 pr-3">
                <div className="font-medium text-ink">{t.asnName}</div>
                <div className="text-xs text-ink-dim">
                  <span className="font-mono">{t.asnId}</span>{' '}
                  · <span className="tabular-nums">{fmt.num(t.rarityAsn, 2)}</span>
                </div>
              </td>
              <td className="num py-3 pr-3 text-right text-ink tabular-nums">
                {fmt.num(t.avgIbrlScore, 1)}
                {myIbrl != null && t.avgIbrlScore != null && (
                  <div className="text-xs text-ink-dim tabular-nums">
                    +{fmt.num(t.avgIbrlScore - myIbrl, 1)} vs yours
                  </div>
                )}
              </td>
              <td className="num py-3 pr-3 text-right text-ink-muted tabular-nums">
                {t.validatorCount}
              </td>
              <td className="num py-3 pr-4 text-right tabular-nums">
                <span className={t.dzCount > 0 ? 'text-success' : 'text-ink-dim'}>
                  {t.dzCount}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {hasMore && (
        <div className="flex items-center justify-between border-t border-ring px-4 py-2 text-xs text-ink-dim">
          <span>
            Showing {visible.length} of {total} rarer locations meeting your IBRL bar.
          </span>
          <button
            type="button"
            onClick={() => setShowAll((v) => !v)}
            className="font-medium text-ink-muted hover:text-ink"
          >
            {showAll ? `Show top ${DEFAULT_VISIBLE}` : `Show all ${total}`}
          </button>
        </div>
      )}
    </div>
  );
}
