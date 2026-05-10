// Leaderboard table — the headline view at /.
//
// Server-component-friendly (no 'use client'): renders straight from the
// server-loaded JSON data. Sortable in-browser would need 'use client' +
// state; deliberately deferred — the default sort by GDI desc is the
// right one for the read.

import Link from 'next/link';
import { ArrowDown, ArrowUp, Minus } from 'lucide-react';
import type { FormattedBaseline, FormattedScore } from '@/lib/data';

type Props = {
  pools: FormattedScore[];
  baseline: FormattedBaseline | null;
  epoch: number;
};

const fmt = {
  num: (v: number | null, digits = 2) =>
    v == null ? '—' : v.toFixed(digits),
  pct: (v: number | null) =>
    v == null ? '—' : `${(v * 100).toFixed(1)}%`,
  sol: (v: number | null) => {
    if (v == null) return '—';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
  addr: (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`,
};

function comparisonToBaseline(
  poolGdi: number | null,
  baselineGdi: number | null,
): { dir: 'up' | 'down' | 'eq'; pct: number | null } {
  if (poolGdi == null || baselineGdi == null || baselineGdi === 0) {
    return { dir: 'eq', pct: null };
  }
  const delta = poolGdi - baselineGdi;
  const pct = (delta / baselineGdi) * 100;
  if (Math.abs(pct) < 0.5) return { dir: 'eq', pct };
  return { dir: pct > 0 ? 'up' : 'down', pct };
}

export function Leaderboard({ pools, baseline, epoch }: Props) {
  const sorted = [...pools].sort((a, b) => (b.gdi ?? -Infinity) - (a.gdi ?? -Infinity));

  return (
    <div className="surface overflow-x-auto">
      <table className="w-full text-sm">
        <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.10em] text-ink-dim">
          <tr>
            <th className="py-3 pl-5 pr-3 font-semibold">#</th>
            <th className="py-3 pr-3 font-semibold">Pool</th>
            <th className="py-3 pr-3 text-right font-semibold">GDI</th>
            <th className="py-3 pr-3 text-right font-semibold">vs baseline</th>
            <th className="py-3 pr-3 text-right font-semibold">DC country</th>
            <th className="py-3 pr-3 text-right font-semibold">DC city</th>
            <th className="py-3 pr-3 text-right font-semibold">DC ASN</th>
            <th className="py-3 pr-3 text-right font-semibold">NIS</th>
            <th className="py-3 pr-3 text-right font-semibold">Validators</th>
            <th className="py-3 pr-5 text-right font-semibold">Stake</th>
          </tr>
        </thead>
        <tbody className="text-ink">
          {sorted.length === 0 && (
            <tr>
              <td colSpan={10} className="py-12 text-center text-ink-dim">
                No pools scored for epoch {epoch} yet. Check back after the next ingest.
              </td>
            </tr>
          )}
          {sorted.map((p, i) => {
            const cmp = comparisonToBaseline(p.gdi, baseline?.gdi ?? null);
            return (
              <tr key={p.pool_address} className="border-t border-ring transition hover:bg-bg-muted/40">
                <td className="num py-3 pl-5 pr-3 text-ink-dim">{i + 1}</td>
                <td className="py-3 pr-3">
                  <Link
                    href={`/pools/${p.pool_address}`}
                    className="font-medium text-ink hover:underline"
                  >
                    {p.pool_name || fmt.addr(p.pool_address)}
                  </Link>
                  <div className="font-mono text-xs text-ink-dim">{fmt.addr(p.pool_address)}</div>
                </td>
                <td className="num py-3 pr-3 text-right font-semibold">{fmt.num(p.gdi, 3)}</td>
                <td className="num py-3 pr-3 text-right">
                  <span
                    className={
                      cmp.dir === 'up'
                        ? 'inline-flex items-center gap-1 text-success'
                        : cmp.dir === 'down'
                          ? 'inline-flex items-center gap-1 text-bad'
                          : 'inline-flex items-center gap-1 text-ink-dim'
                    }
                  >
                    {cmp.dir === 'up' && <ArrowUp className="h-3 w-3" />}
                    {cmp.dir === 'down' && <ArrowDown className="h-3 w-3" />}
                    {cmp.dir === 'eq' && <Minus className="h-3 w-3" />}
                    {cmp.pct == null ? '—' : `${cmp.pct >= 0 ? '+' : ''}${cmp.pct.toFixed(1)}%`}
                  </span>
                </td>
                <td className="num py-3 pr-3 text-right text-ink-muted">{fmt.num(p.dc_country, 2)}</td>
                <td className="num py-3 pr-3 text-right text-ink-muted">{fmt.num(p.dc_city, 2)}</td>
                <td className="num py-3 pr-3 text-right text-ink-muted">{fmt.num(p.dc_asn, 2)}</td>
                <td className="num py-3 pr-3 text-right text-ink-muted">{fmt.num(p.nis, 1)}</td>
                <td className="num py-3 pr-3 text-right text-ink-muted">{p.validator_count ?? '—'}</td>
                <td className="num py-3 pr-5 text-right text-ink-muted">{fmt.sol(p.total_stake_sol)} SOL</td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {baseline && (
        <div className="border-t border-ring bg-bg-muted/30 px-5 py-3 text-xs text-ink-muted">
          <span className="font-medium text-ink-dim">Network baseline (epoch {baseline.epoch}):</span>{' '}
          GDI <span className="num">{fmt.num(baseline.gdi, 3)}</span>
          {' · '} DC country <span className="num">{fmt.num(baseline.dc_country, 2)}</span>
          {' · '} DC city <span className="num">{fmt.num(baseline.dc_city, 2)}</span>
          {' · '} DC ASN <span className="num">{fmt.num(baseline.dc_asn, 2)}</span>
          {' · '}
          {baseline.validator_count} validators across {fmt.sol(baseline.total_stake_sol)} SOL
        </div>
      )}
    </div>
  );
}
