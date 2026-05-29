// /impact — per-pool GDI trajectories since publication.
// Reports the numbers; lets the reader draw the conclusions.

import Link from 'next/link';
import type { Metadata } from 'next';
import { loadLeaderboard, loadLeaderboardForEpoch, loadNetworkBaseline } from '@/lib/data';

export const revalidate = 60;

// Both `openGraph` and `twitter` must be set explicitly — the root layout
// declares them, and Next.js doesn't cascade `title`/`description` into
// the parent's openGraph block. Without these, social cards would show
// the leaderboard's title/description even though the image is /impact's.
const PAGE_TITLE = 'Improvements in GDI since launch';
const PAGE_DESCRIPTION =
  'Per-pool Geographic Decentralisation Index trajectories for all top-15 Solana stake pools since publishing began. Live data, recomputed each ingest.';
const PAGE_URL = 'https://gdindex.app/impact';

export const metadata: Metadata = {
  title: PAGE_TITLE,
  description: PAGE_DESCRIPTION,
  openGraph: {
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
    url: PAGE_URL,
    type: 'website',
  },
  twitter: {
    card: 'summary_large_image',
    title: PAGE_TITLE,
    description: PAGE_DESCRIPTION,
  },
  alternates: { canonical: PAGE_URL },
};

const FIRST_EPOCH = 969;

// Temporary exclusion: at epoch 978 we switched the canonical geo backend
// from Stakewiz to MaxMind, which corrected some long-standing
// country/city/ASN misclassifications for a handful of pools. The result
// was step-changes in their pool-level GDI big enough to dominate the
// chart's y-axis and warp the visual story of every other pool. These
// pools are excluded from the top-15 trajectory chart until the shadow
// window closes around epoch 987 — by then the 969-977 canonical history
// rolls off the left edge of the chart's display window naturally and
// the discontinuity is no longer in frame.
//
// REMOVE THIS LIST when the chart's leftmost displayed epoch crosses 978
// (currently the chart shows all epochs from FIRST_EPOCH, so the trigger
// is: epoch 987 + whatever delay you want; or bump FIRST_EPOCH past 978).
const TEMP_EXCLUDED_POOLS_UNTIL_EPOCH_987 = new Set<string>([
  'HQLwnQJFH7t9nBTP4vbdW4eHy62aecfDnj8te8VzqkFL', // BdMLRsol  — GDI ~1.79 → 3.42
  'spp1mo6shdcrRyqDK2zdurJ8H5uttZE6H6oVjHxN1QN', // xSHIN     — GDI ~2.56 → 3.04
]);

// Publication milestones — vertical markers on the trajectory chart for
// temporal context. No editorial framing — these are dates, not claims.
const MILESTONES: { epoch: number; label: string }[] = [
  { epoch: 970, label: 'First public leaderboard' },
  { epoch: 973, label: 'Per-epoch rank-change posts' },
  { epoch: 974, label: 'Shared in Solana Tech Discord' },
];

// Pool addresses referenced in the case-study section.
const ADDR = {
  definity: 'Bvbu55B991evqqhLtKcyTZjzQ4EQzRUwtf9T4CcpMmPL',
  solblaze: 'stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi',
  stkesol:  'StKeDUdSu7jMSnPJ1MPqDnk3RdEwD2QbJaisHMebGhw',
};

const fmt = {
  pct: (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`,
  num: (v: number, d = 2) => v.toFixed(d),
  sol: (v: number) => {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(0)}k`;
    return v.toFixed(0);
  },
};

function pctBucket(delta: number): { color: string; label: string } {
  if (delta >= 0.10) return { color: '#14F195', label: 'Large mover (+10%+)' };
  if (delta >= 0.03) return { color: '#9945FF', label: 'Mover (+3-10%)' };
  if (delta >= -0.03) return { color: '#8b949e', label: 'Flat (±3%)' };
  return { color: '#f97583', label: 'Negative' };
}

export default async function ImpactPage() {
  const latest = await loadLeaderboard();
  if (!latest) return <div className="container-narrow py-20">Awaiting first ingest.</div>;

  const lastEpoch = latest.epoch;
  const epochs: number[] = [];
  for (let e = FIRST_EPOCH; e <= lastEpoch; e++) epochs.push(e);

  // Pull every epoch's leaderboard. 8 small files; fine to await serially.
  const leaderboards: Record<number, Awaited<ReturnType<typeof loadLeaderboardForEpoch>>> = {};
  for (const e of epochs) leaderboards[e] = await loadLeaderboardForEpoch(e);

  // Latest top-15 pools (filtered to >= 100k SOL, the standard TVL floor).
  // Also drops the temporarily-excluded pools — see comment on
  // TEMP_EXCLUDED_POOLS_UNTIL_EPOCH_987 above.
  const top15 = (latest.pools ?? [])
    .filter((p) => p.gdi != null && (p.total_stake_sol ?? 0) >= 100_000)
    .filter((p) => !TEMP_EXCLUDED_POOLS_UNTIL_EPOCH_987.has(p.pool_address))
    .sort((a, b) => (b.gdi ?? 0) - (a.gdi ?? 0))
    .slice(0, 15);

  // For each top-15 pool, gather GDI at each epoch (if present).
  type Series = {
    address: string;
    name: string;
    gdiNow: number;
    tvlSol: number;
    firstEpoch: number;
    firstGdi: number;
    delta: number;
    points: { epoch: number; gdi: number | null }[];
  };
  const series: Series[] = top15.map((p) => {
    const points = epochs.map((e) => {
      const board = leaderboards[e];
      const match = board?.pools?.find((x) => x.pool_address === p.pool_address);
      return { epoch: e, gdi: match?.gdi ?? null };
    });
    // Earliest epoch where this pool appears with non-null GDI.
    const firstPoint = points.find((pt) => pt.gdi != null);
    const firstEpoch = firstPoint?.epoch ?? lastEpoch;
    const firstGdi = firstPoint?.gdi ?? 0;
    const gdiNow = p.gdi!;
    const delta = firstGdi > 0 ? (gdiNow - firstGdi) / firstGdi : 0;
    return {
      address: p.pool_address,
      name: p.pool_name ?? p.pool_address.slice(0, 8) + '…',
      gdiNow,
      tvlSol: p.total_stake_sol ?? 0,
      firstEpoch,
      firstGdi,
      delta,
      points,
    };
  });

  // Sort series by Δ desc for the cohort table; chart uses same ordering.
  series.sort((a, b) => b.delta - a.delta);

  // Aggregate counts for headline.
  const movers3 = series.filter((s) => s.delta >= 0.03).length;
  const moversBig = series.filter((s) => s.delta >= 0.10).length;
  const flat = series.filter((s) => s.delta > -0.03 && s.delta < 0.03).length;
  const negative = series.filter((s) => s.delta <= -0.03).length;
  // Average among movers (>=3%) — the "improving cohort" headline number.
  const moverAvg = movers3 > 0
    ? series.filter((s) => s.delta >= 0.03).reduce((a, s) => a + s.delta, 0) / movers3
    : 0;
  const sinceDays = epochs.length * 2; // ~2-day epochs

  // ── chart geometry ────────────────────────────────────────────────────
  const W = 880;
  const H = 380;
  const PAD = { top: 20, right: 24, bottom: 38, left: 48 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;

  // Y domain: pad slightly around all observed GDI values.
  const allGdi = series.flatMap((s) => s.points.map((p) => p.gdi).filter((v): v is number => v != null));
  const yMinRaw = Math.min(...allGdi);
  const yMaxRaw = Math.max(...allGdi);
  const yPad = (yMaxRaw - yMinRaw) * 0.1 || 0.5;
  const yMin = Math.floor((yMinRaw - yPad) * 10) / 10;
  const yMax = Math.ceil((yMaxRaw + yPad) * 10) / 10;
  const yToPx = (v: number) => PAD.top + innerH * (1 - (v - yMin) / (yMax - yMin));
  const xToPx = (epoch: number) =>
    PAD.left + innerW * ((epoch - FIRST_EPOCH) / Math.max(1, lastEpoch - FIRST_EPOCH));

  // Y-axis ticks (5 evenly-spaced)
  const yTicks: number[] = [];
  for (let i = 0; i <= 4; i++) yTicks.push(yMin + ((yMax - yMin) * i) / 4);

  // Network baseline trend (small chart, separate)
  const baseline = await loadNetworkBaseline();
  const baselineSeries: { epoch: number; gdi: number }[] =
    baseline?.history
      ?.filter((h) => h.epoch >= FIRST_EPOCH && h.epoch <= lastEpoch && h.gdi != null)
      .map((h) => ({ epoch: h.epoch, gdi: h.gdi as number }))
      .sort((a, b) => a.epoch - b.epoch) ?? [];

  return (
    <main className="container-narrow py-14 md:py-20">
      <Link href="/" className="drilldown text-sm text-ink-muted hover:text-ink">
        ← Back to leaderboard
      </Link>

      <header className="mt-6 max-w-3xl">
        <p className="font-display text-xs font-semibold uppercase tracking-[0.22em] text-ink-dim md:text-sm">
          Per-pool trend · {epochs.length} epochs
        </p>
        <h1 className="mt-2 text-balance font-display text-3xl font-bold tracking-tight text-ink md:text-[40px] md:leading-[1.1]">
          Improvements in GDI since launch
        </h1>
        <p className="mt-5 text-base leading-relaxed text-ink-muted md:text-lg">
          Per-pool Geographic Decentralisation Index for the current top-15 pools, across every
          epoch since publication began ({sinceDays} days). Recomputed each ingest. Every number
          here is reproducible from the per-epoch <a href="/gdi/leaderboard-latest.json" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">leaderboard JSON archive</a>
          {' '}using <Link href="/methodology" className="drilldown hover:text-ink">the published methodology</Link>.
        </p>
      </header>

      {/* Headline strip */}
      <section className="mt-10 grid gap-4 md:grid-cols-4">
        <div className="surface p-6">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Pools improved &gt;3%</div>
          <div className="num mt-2 font-display text-4xl font-semibold text-ink md:text-5xl">
            {movers3}<span className="text-2xl text-ink-dim"> / {series.length}</span>
          </div>
          <div className="mt-1 text-sm text-ink-muted">of the current top-15 pools</div>
        </div>
        <div className="surface p-6">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Average gain (movers)</div>
          <div className="num mt-2 font-display text-4xl font-semibold text-ink md:text-5xl">
            {fmt.pct(moverAvg)}
          </div>
          <div className="mt-1 text-sm text-ink-muted">GDI lift across the {movers3} improving pools</div>
        </div>
        <div className="surface p-6">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Largest single move</div>
          <div className="num mt-2 font-display text-4xl font-semibold text-success md:text-5xl">
            {fmt.pct(series[0].delta)}
          </div>
          <div className="mt-1 text-sm text-ink-muted">{series[0].name} in {sinceDays} days</div>
        </div>
        <div className="surface p-6">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Observation window</div>
          <div className="num mt-2 font-display text-4xl font-semibold text-ink md:text-5xl">
            {sinceDays}d
          </div>
          <div className="mt-1 text-sm text-ink-muted">{epochs.length} Solana epochs, {FIRST_EPOCH}→{lastEpoch}</div>
        </div>
      </section>

      {/* Trajectory chart */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Per-pool GDI trajectory
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-ink-muted">
          One line per current-top-15 pool. Lines colour-coded by movement bucket since first observation.
          Vertical markers show the engagement events that shifted the operator-incentive landscape during the window.
        </p>
        <div className="surface mt-4 overflow-x-auto p-3">
          <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: '600px' }}>
            {/* Axes */}
            <line x1={PAD.left} y1={H - PAD.bottom} x2={W - PAD.right} y2={H - PAD.bottom} stroke="#242a35" strokeWidth={1} />
            <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={H - PAD.bottom} stroke="#242a35" strokeWidth={1} />

            {/* Y gridlines + labels */}
            {yTicks.map((t) => (
              <g key={t}>
                <line x1={PAD.left} y1={yToPx(t)} x2={W - PAD.right} y2={yToPx(t)} stroke="#1a1f28" strokeWidth={1} />
                <text x={PAD.left - 8} y={yToPx(t) + 4} textAnchor="end" fontSize="11" fill="#6e7681">
                  {t.toFixed(2)}
                </text>
              </g>
            ))}

            {/* X ticks (epochs) */}
            {epochs.map((e) => (
              <g key={e}>
                <line x1={xToPx(e)} y1={H - PAD.bottom} x2={xToPx(e)} y2={H - PAD.bottom + 4} stroke="#242a35" strokeWidth={1} />
                <text x={xToPx(e)} y={H - PAD.bottom + 18} textAnchor="middle" fontSize="11" fill="#6e7681">
                  {e}
                </text>
              </g>
            ))}

            {/* Publication milestones (vertical dashed lines) */}
            {MILESTONES.filter((ev) => ev.epoch >= FIRST_EPOCH && ev.epoch <= lastEpoch).map((ev) => (
              <g key={ev.epoch} opacity={0.55}>
                <line x1={xToPx(ev.epoch)} y1={PAD.top} x2={xToPx(ev.epoch)} y2={H - PAD.bottom} stroke="#9945FF" strokeWidth={1} strokeDasharray="4 3" />
                <text x={xToPx(ev.epoch) + 4} y={PAD.top + 12} fontSize="10" fill="#9945FF" fontWeight={600}>
                  {ev.label}
                </text>
              </g>
            ))}

            {/* Series lines */}
            {series.map((s) => {
              const { color } = pctBucket(s.delta);
              const pts = s.points
                .filter((p) => p.gdi != null)
                .map((p) => `${xToPx(p.epoch)},${yToPx(p.gdi!)}`)
                .join(' ');
              return (
                <g key={s.address}>
                  <polyline points={pts} fill="none" stroke={color} strokeWidth={1.6} opacity={0.85} />
                  {s.points
                    .filter((p) => p.gdi != null)
                    .map((p) => (
                      <circle key={p.epoch} cx={xToPx(p.epoch)} cy={yToPx(p.gdi!)} r={2.2} fill={color}>
                        <title>{`${s.name} · epoch ${p.epoch} · GDI ${p.gdi!.toFixed(3)}`}</title>
                      </circle>
                    ))}
                  {/* Label at last point */}
                  {(() => {
                    const lastPt = [...s.points].reverse().find((p) => p.gdi != null);
                    if (!lastPt) return null;
                    return (
                      <text x={xToPx(lastPt.epoch) + 5} y={yToPx(lastPt.gdi!) + 3} fontSize="10" fill={color} fontWeight={600}>
                        {s.name}
                      </text>
                    );
                  })()}
                </g>
              );
            })}
          </svg>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 px-3 text-xs">
            {(['Large mover (+10%+)', 'Mover (+3-10%)', 'Flat (±3%)', 'Negative'] as const).map((label) => {
              const dummy = label === 'Large mover (+10%+)' ? 0.15 : label === 'Mover (+3-10%)' ? 0.05 : label === 'Flat (±3%)' ? 0 : -0.05;
              return (
                <span key={label} className="inline-flex items-center gap-1.5 text-ink-muted">
                  <span aria-hidden className="inline-block h-2 w-3" style={{ background: pctBucket(dummy).color }} />
                  {label}
                </span>
              );
            })}
            <span className="inline-flex items-center gap-1.5 text-ink-muted">
              <span aria-hidden className="inline-block h-2 w-3" style={{ background: '#9945FF' }} />
              Publication milestone
            </span>
          </div>
        </div>
      </section>

      {/* The cohort table */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          The cohort
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-ink-muted">
          Each of the current top-15 pools, with their GDI at first observation (epoch {FIRST_EPOCH}, May 11) versus today.
          Sorted by movement.
        </p>
        <div className="surface mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.10em] text-ink-dim">
              <tr>
                <th className="py-3 pl-5 pr-3 font-semibold">Pool</th>
                <th className="py-3 pr-3 text-right font-semibold">First GDI</th>
                <th className="py-3 pr-3 text-right font-semibold">Now</th>
                <th className="py-3 pr-3 text-right font-semibold">Δ</th>
                <th className="py-3 pr-5 text-right font-semibold">TVL</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {series.map((s) => {
                const { color } = pctBucket(s.delta);
                return (
                  <tr key={s.address} className="border-t border-ring align-top">
                    <td className="py-3 pl-5 pr-3">
                      <Link href={`/pools/${s.address}`} className="drilldown text-ink hover:text-ink">
                        {s.name}
                      </Link>
                    </td>
                    <td className="num py-3 pr-3 text-right text-ink-muted tabular-nums">{fmt.num(s.firstGdi, 3)}</td>
                    <td className="num py-3 pr-3 text-right text-ink tabular-nums">{fmt.num(s.gdiNow, 3)}</td>
                    <td className="num py-3 pr-3 text-right tabular-nums" style={{ color }}>
                      {fmt.pct(s.delta)}
                    </td>
                    <td className="num py-3 pr-5 text-right text-ink-muted tabular-nums">{fmt.sol(s.tvlSol)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Network baseline trend */}
      {baselineSeries.length > 1 && (
        <section className="mt-12 max-w-3xl">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
            Network-wide baseline
          </h2>
          <p className="mt-2 text-sm text-ink-muted">
            Stake-weighted GDI across the entire active validator set.
          </p>
          <div className="surface mt-4 overflow-x-auto p-3">
            <svg viewBox="0 0 880 200" className="w-full" style={{ minWidth: '600px' }}>
              {(() => {
                const bW = 880;
                const bH = 200;
                const bPad = { top: 18, right: 24, bottom: 30, left: 48 };
                const bIW = bW - bPad.left - bPad.right;
                const bIH = bH - bPad.top - bPad.bottom;
                const gdis = baselineSeries.map((b) => b.gdi);
                const min = Math.min(...gdis);
                const max = Math.max(...gdis);
                const span = Math.max(0.1, max - min);
                const yMinB = min - span * 0.2;
                const yMaxB = max + span * 0.2;
                const yPx = (v: number) => bPad.top + bIH * (1 - (v - yMinB) / (yMaxB - yMinB));
                const xPx = (epoch: number) => bPad.left + bIW * ((epoch - FIRST_EPOCH) / Math.max(1, lastEpoch - FIRST_EPOCH));
                const pts = baselineSeries.map((b) => `${xPx(b.epoch)},${yPx(b.gdi)}`).join(' ');
                return (
                  <g>
                    {[yMinB, (yMinB + yMaxB) / 2, yMaxB].map((t) => (
                      <g key={t}>
                        <line x1={bPad.left} y1={yPx(t)} x2={bW - bPad.right} y2={yPx(t)} stroke="#1a1f28" />
                        <text x={bPad.left - 8} y={yPx(t) + 4} textAnchor="end" fontSize="11" fill="#6e7681">{t.toFixed(3)}</text>
                      </g>
                    ))}
                    {baselineSeries.map((b) => (
                      <text key={b.epoch} x={xPx(b.epoch)} y={bH - bPad.bottom + 16} textAnchor="middle" fontSize="11" fill="#6e7681">{b.epoch}</text>
                    ))}
                    <polyline points={pts} fill="none" stroke="#14F195" strokeWidth={2} />
                    {baselineSeries.map((b) => (
                      <circle key={b.epoch} cx={xPx(b.epoch)} cy={yPx(b.gdi)} r={2.5} fill="#14F195">
                        <title>{`epoch ${b.epoch} · network GDI ${b.gdi.toFixed(4)}`}</title>
                      </circle>
                    ))}
                  </g>
                );
              })()}
            </svg>
          </div>
        </section>
      )}

      {/* Case studies — three different pool postures all captured by the methodology */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Case studies
        </h2>
        <p className="mt-2 max-w-3xl text-sm text-ink-muted">
          Three pools, three different relationships to the GDI methodology.
        </p>
        <div className="mt-5 grid gap-4 md:grid-cols-3">
          {/* Card 1: STKESOL — independent confirmation */}
          {(() => {
            const s = series.find((x) => x.address === ADDR.stkesol);
            if (!s) return null;
            return (
              <div className="surface p-6">
                <div className="text-xs uppercase tracking-wider text-ink-dim">Independent confirmation</div>
                <Link href={`/pools/${s.address}`} className="mt-2 block font-display text-2xl font-semibold text-ink hover:text-ink">
                  STKESOL
                </Link>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-dim">Current GDI</div>
                    <div className="num mt-1 font-display text-2xl font-semibold text-ink tabular-nums">{fmt.num(s.gdiNow, 2)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-dim">Rank</div>
                    <div className="num mt-1 font-display text-2xl font-semibold text-ink tabular-nums">#1</div>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-ink-muted">
                  Sol Strategies has run a tightly-curated, decentralisation-aware
                  validator set for years. GDI&apos;s independent methodology surfaces
                  them at #1 with a {fmt.num(s.gdiNow, 2)} composite — validation of
                  long-standing work, not new behaviour. When the methodology and the
                  operator agree, the methodology gains credibility.
                </p>
              </div>
            );
          })()}

          {/* Card 2: SolBlaze — single-window improvement */}
          {(() => {
            const s = series.find((x) => x.address === ADDR.solblaze);
            if (!s) return null;
            return (
              <div className="surface p-6">
                <div className="text-xs uppercase tracking-wider text-ink-dim">Largest single move</div>
                <Link href={`/pools/${s.address}`} className="mt-2 block font-display text-2xl font-semibold text-ink hover:text-ink">
                  bSOL · SolBlaze
                </Link>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-dim">Δ since launch</div>
                    <div className="num mt-1 font-display text-2xl font-semibold text-success tabular-nums">{fmt.pct(s.delta)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-dim">Pool size</div>
                    <div className="num mt-1 font-display text-2xl font-semibold text-ink tabular-nums">{fmt.sol(s.tvlSol)}</div>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-ink-muted">
                  bSOL moved from {fmt.num(s.firstGdi, 2)} to {fmt.num(s.gdiNow, 2)} —
                  the largest single-pool improvement in the window, on a 1M-SOL pool.
                  At this scale, every basis-point of GDI lift represents meaningful
                  stake redistribution toward rarer locations.
                </p>
              </div>
            );
          })()}

          {/* Card 3: Definity — methodology-driven allocation */}
          {(() => {
            const s = series.find((x) => x.address === ADDR.definity);
            if (!s) return null;
            return (
              <div className="surface p-6">
                <div className="text-xs uppercase tracking-wider text-ink-dim">Methodology-driven</div>
                <Link href={`/pools/${s.address}`} className="mt-2 block font-display text-2xl font-semibold text-ink hover:text-ink">
                  definSOL · Definity
                </Link>
                <div className="mt-3 grid grid-cols-2 gap-3">
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-dim">Δ since launch</div>
                    <div className="num mt-1 font-display text-2xl font-semibold text-success tabular-nums">{fmt.pct(s.delta)}</div>
                  </div>
                  <div>
                    <div className="text-[10px] uppercase tracking-wider text-ink-dim">Pool size</div>
                    <div className="num mt-1 font-display text-2xl font-semibold text-ink tabular-nums">{fmt.sol(s.tvlSol)}</div>
                  </div>
                </div>
                <p className="mt-4 text-sm leading-relaxed text-ink-muted">
                  Open-source stake-allocation logic tied directly to the GDI methodology.
                  Every epoch, the optimiser reads live network shares, identifies validators
                  in rarer locations, and rebalances toward them. All on-chain actions are
                  auditable. Result: {fmt.pct(s.delta)} GDI improvement on a {fmt.sol(s.tvlSol)}-SOL
                  pool in {sinceDays} days.
                </p>
              </div>
            );
          })()}
        </div>
      </section>

      <footer className="mt-16 border-t border-ring pt-6 text-xs text-ink-dim">
        Data window {FIRST_EPOCH}–{lastEpoch} ({sinceDays} days). Recomputed each ingest cycle. Every
        number is reproducible from{' '}
        <a href="/gdi/leaderboard-latest.json" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">leaderboard-latest.json</a>{' '}
        and the per-epoch <code>leaderboard-{'{N}'}.json</code> archive at <code>/gdi/</code>.{' '}
        <Link href="/methodology" className="drilldown hover:text-ink">Methodology →</Link>
      </footer>
    </main>
  );
}
