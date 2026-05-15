'use client';

// Client wrapper around the three per-dimension rarity tables (country / city
// / ASN). Reads pre-aggregated bucket rows from the parent (server component);
// the only state here is the DZ-supported-only toggle.

import { useMemo, useState } from 'react';

export type BucketRow = {
  /** e.g. "AT", "Vienna", "AS24940" */
  key: string;
  /** Human-readable name (same as key for country/city, asn_name for ASN). */
  label: string;
  /** -ln(network_share). Higher = rarer. */
  rarity: number | null;
  /** Stake-weighted share of the active set in this bucket, 0-1. */
  networkShare: number | null;
  validatorCount: number;
  dzCount: number;
  totalStakeSol: number;
};

type Props = {
  country: BucketRow[];
  city: BucketRow[];
  asn: BucketRow[];
};

const fmt = {
  num: (v: number | null, d = 2) => (v == null ? '—' : v.toFixed(d)),
  pct: (v: number | null, d = 2) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`),
  sol: (v: number) => {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
};

const SECTION_LIMIT = 25;

function applyFilters(rows: BucketRow[], dzOnly: boolean): BucketRow[] {
  // Drop "unknown" buckets — they're not actionable advice for an operator.
  const cleaned = rows.filter((r) => r.key && r.key.toLowerCase() !== 'unknown');
  return dzOnly ? cleaned.filter((r) => r.dzCount > 0) : cleaned;
}

function Section({
  anchorId,
  title,
  unit,
  rows,
  showAll,
  onToggleShowAll,
}: {
  anchorId: string;
  title: string;
  unit: string;
  rows: BucketRow[];
  showAll: boolean;
  onToggleShowAll: () => void;
}) {
  const visible = showAll ? rows : rows.slice(0, SECTION_LIMIT);
  return (
    <section id={anchorId} className="mt-10 scroll-mt-20 first:mt-0">
      <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
        {title}
      </h2>
      <div className="mt-2 text-sm text-ink-dim">
        Rarest {unit}s sorted by rarity desc. {rows.length} total{rows.length > SECTION_LIMIT && !showAll
          ? ` — showing top ${SECTION_LIMIT}`
          : ''}.
      </div>
      <div className="surface mt-4 overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.10em] text-ink-dim">
            <tr>
              <th className="py-3 pl-5 pr-3 font-semibold">Rarity</th>
              <th className="py-3 pr-3 font-semibold">{title}</th>
              <th className="py-3 pr-3 text-right font-semibold">Validators</th>
              <th className="py-3 pr-3 text-right font-semibold">On DZ</th>
              <th className="py-3 pr-3 text-right font-semibold">Network share</th>
              <th className="py-3 pr-5 text-right font-semibold">Total stake</th>
            </tr>
          </thead>
          <tbody className="text-ink">
            {visible.length === 0 && (
              <tr>
                <td colSpan={6} className="py-12 text-center text-ink-dim">
                  No {unit}s match the current filter.
                </td>
              </tr>
            )}
            {visible.map((r) => (
              <tr
                key={r.key}
                className="border-t border-ring transition hover:bg-bg-muted/40"
              >
                <td className="num py-3 pl-5 pr-3 font-display text-base font-semibold tabular-nums text-ink">
                  {fmt.num(r.rarity, 2)}
                </td>
                <td className="py-3 pr-3">
                  <div className="font-medium text-ink">{r.label}</div>
                  {r.label !== r.key && (
                    <div className="font-mono text-xs text-ink-dim">{r.key}</div>
                  )}
                </td>
                <td className="num py-3 pr-3 text-right text-ink-muted tabular-nums">
                  {r.validatorCount}
                </td>
                <td className="num py-3 pr-3 text-right tabular-nums">
                  <span className={r.dzCount > 0 ? 'text-success' : 'text-ink-dim'}>
                    {r.dzCount}
                  </span>
                </td>
                <td className="num py-3 pr-3 text-right text-xs tabular-nums text-ink-dim">
                  {fmt.pct(r.networkShare, 2)}
                </td>
                <td className="num py-3 pr-5 text-right text-ink-muted tabular-nums">
                  {fmt.sol(r.totalStakeSol)} SOL
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > SECTION_LIMIT && (
        <button
          type="button"
          onClick={onToggleShowAll}
          className="mt-3 text-xs text-ink-dim hover:text-ink"
        >
          {showAll ? `Show top ${SECTION_LIMIT}` : `Show all ${rows.length}`}
        </button>
      )}
    </section>
  );
}

export function LocationsTable({ country, city, asn }: Props) {
  const [dzOnly, setDzOnly] = useState(true);
  const [showAllCountry, setShowAllCountry] = useState(false);
  const [showAllCity, setShowAllCity] = useState(false);
  const [showAllAsn, setShowAllAsn] = useState(false);

  const filteredCountry = useMemo(() => applyFilters(country, dzOnly), [country, dzOnly]);
  const filteredCity = useMemo(() => applyFilters(city, dzOnly), [city, dzOnly]);
  const filteredAsn = useMemo(() => applyFilters(asn, dzOnly), [asn, dzOnly]);

  return (
    <>
      {/* Jump-to pills + filter — up-front so first-time visitors see all three
          dimensions are available without having to scroll. */}
      <div className="mt-8 flex flex-wrap items-center gap-2 text-sm">
        <span className="text-xs uppercase tracking-wider text-ink-dim">Jump to:</span>
        <a
          href="#country"
          className="rounded-full border border-ring px-3 py-1 text-ink-muted transition hover:border-ink hover:text-ink"
        >
          Country
        </a>
        <a
          href="#city"
          className="rounded-full border border-ring px-3 py-1 text-ink-muted transition hover:border-ink hover:text-ink"
        >
          City
        </a>
        <a
          href="#asn"
          className="rounded-full border border-ring px-3 py-1 text-ink-muted transition hover:border-ink hover:text-ink"
        >
          ASN
        </a>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={dzOnly}
            onChange={(e) => setDzOnly(e.target.checked)}
            className="h-4 w-4"
          />
          <span className="text-ink">DoubleZero-supported locations only</span>
        </label>
        <span className="text-xs text-ink-dim">
          ({dzOnly ? 'showing only buckets where at least one existing validator runs DZ' : 'showing all buckets, including those with zero DZ presence'})
        </span>
      </div>

      <Section
        anchorId="country"
        title="Country"
        unit="country"
        rows={filteredCountry}
        showAll={showAllCountry}
        onToggleShowAll={() => setShowAllCountry((v) => !v)}
      />
      <Section
        anchorId="city"
        title="City"
        unit="city"
        rows={filteredCity}
        showAll={showAllCity}
        onToggleShowAll={() => setShowAllCity((v) => !v)}
      />
      <Section
        anchorId="asn"
        title="ASN"
        unit="ASN"
        rows={filteredAsn}
        showAll={showAllAsn}
        onToggleShowAll={() => setShowAllAsn((v) => !v)}
      />
    </>
  );
}
