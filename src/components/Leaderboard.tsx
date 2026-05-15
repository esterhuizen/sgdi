// Leaderboard table. Columns: rank, pool, CDI (dim peer), GDI (bold/large),
// country, city, asn (dim sub-scores), validators, stake. GDI carries the
// headline weight; CDI sits beside it as a different-axis-different-math
// companion. The three sub-scores are visible but de-emphasised.

import Link from 'next/link';
import { GdiLink } from '@/components/GdiLink';
import type { FormattedBaseline, FormattedScore } from '@/lib/data';

type Props = {
  pools: FormattedScore[];
  baseline: FormattedBaseline | null;  // kept for the optional reference line; not displayed in rows
  epoch: number;
};

const fmt = {
  num: (v: number | null, digits = 2) => (v == null ? '—' : v.toFixed(digits)),
  sol: (v: number | null) => {
    if (v == null) return '—';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
  addr: (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`,
};

export function Leaderboard({ pools, baseline, epoch }: Props) {
  const sorted = [...pools].sort((a, b) => (b.gdi ?? -Infinity) - (a.gdi ?? -Infinity));

  return (
    <div className="surface overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.12em] text-ink-dim">
          <tr>
            <th className="py-3 pl-5 pr-3 font-semibold">#</th>
            <th className="py-3 pr-3 font-semibold">Pool</th>
            <th className="hidden py-3 pr-3 text-right font-normal text-ink-dim sm:table-cell">
              <GdiLink
                href="/methodology#client-diversity"
                title="CDI — Client Decentralisation Index. Click for methodology."
              >
                CDI
              </GdiLink>
            </th>
            <th className="py-3 pr-3 text-right font-semibold"><GdiLink /></th>
            <th className="hidden py-3 pr-3 text-right font-normal text-ink-dim sm:table-cell">country</th>
            <th className="hidden py-3 pr-3 text-right font-normal text-ink-dim sm:table-cell">city</th>
            <th className="hidden py-3 pr-3 text-right font-normal text-ink-dim sm:table-cell">asn</th>
            <th className="py-3 pr-3 text-right font-semibold">Validators</th>
            <th className="py-3 pr-5 text-right font-semibold">Stake</th>
          </tr>
        </thead>
        <tbody className="text-ink">
          {sorted.length === 0 && (
            <tr>
              <td colSpan={9} className="py-12 text-center text-ink-dim">
                No pools scored for epoch {epoch} yet. Check back after the next ingest.
              </td>
            </tr>
          )}
          {sorted.map((p, i) => (
            <tr
              key={p.pool_address}
              className="border-t border-ring transition hover:bg-bg-muted/40"
            >
              <td className="num py-4 pl-5 pr-3 font-display text-base font-semibold text-ink-muted">
                {i + 1}
              </td>
              <td className="py-4 pr-3">
                <Link
                  href={`/pools/${p.pool_address}`}
                  className="drilldown font-medium text-ink"
                >
                  {p.pool_name || fmt.addr(p.pool_address)}
                </Link>
                <div className="font-mono text-xs text-ink-dim">{fmt.addr(p.pool_address)}</div>
              </td>
              <td className="num hidden py-4 pr-3 text-right text-xs tabular-nums text-ink-dim sm:table-cell">
                {fmt.num(p.client_distribution?.effective_clients ?? null, 2)}
              </td>
              <td className="num py-4 pr-3 text-right font-display text-xl font-bold tabular-nums">
                {fmt.num(p.gdi, 2)}
              </td>
              <td className="num hidden py-4 pr-3 text-right text-xs tabular-nums text-ink-dim sm:table-cell">
                {fmt.num(p.dc_country, 2)}
              </td>
              <td className="num hidden py-4 pr-3 text-right text-xs tabular-nums text-ink-dim sm:table-cell">
                {fmt.num(p.dc_city, 2)}
              </td>
              <td className="num hidden py-4 pr-3 text-right text-xs tabular-nums text-ink-dim sm:table-cell">
                {fmt.num(p.dc_asn, 2)}
              </td>
              <td className="num py-4 pr-3 text-right text-ink-muted">{p.validator_count ?? '—'}</td>
              <td className="num py-4 pr-5 text-right text-ink-muted">{fmt.sol(p.total_stake_sol)} SOL</td>
            </tr>
          ))}
        </tbody>
      </table>
      {baseline && (
        <div className="border-t border-ring bg-bg-muted/30 px-5 py-3 text-xs text-ink-muted">
          For reference, the network-wide average <GdiLink /> across all{' '}
          <span className="num">{baseline.validator_count ?? '—'}</span> active Solana validators is{' '}
          <span className="num font-medium text-ink-muted">{fmt.num(baseline.gdi, 2)}</span>.{' '}
          <Link href="/methodology" className="drilldown text-ink-muted hover:text-ink">
            How this is computed.
          </Link>
        </div>
      )}
    </div>
  );
}
