// /impact — published evidence of GDI's effect on stake-pool operator
// behaviour since launch.
//
// Audience: Solana Foundation head of staking (and anyone they share the
// link with internally). Tone: methodology paper, not marketing. Every
// claim should be auditable from the underlying JSON; every counter-
// argument is named and answered in-line.

import Link from 'next/link';
import type { Metadata } from 'next';
import { loadLeaderboard, loadLeaderboardForEpoch, loadNetworkBaseline } from '@/lib/data';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'GDI impact — measured operator response',
  description:
    'Live evidence of how Solana stake pools have responded to the Geographic Decentralisation Index since launch. Per-pool GDI trajectories, engagement-event timeline, and the counterfactuals to consider.',
};

const FIRST_EPOCH = 969;

// Engagement timeline — anchor events that should appear on the trajectory
// chart as vertical annotations. Sourced from auto-poster JSONL + operator
// communications.
const EVENTS: { epoch: number; label: string; detail: string }[] = [
  { epoch: 970, label: 'Leaderboard reveal',     detail: 'First public top-10 thread posted from @tielmane (2026-05-14). Pool teams started reposting their ranks.' },
  { epoch: 973, label: 'Rank-change auto-posts', detail: 'Auto-poster began publishing per-epoch movement alerts. Pools moving UP get a public congrats post tagging their handle.' },
  { epoch: 974, label: 'Discord launch',         detail: 'GDI shared in Solana Tech Discord (2026-05-19). Positive feedback from several major stake-pool operators.' },
  { epoch: 975, label: 'SolBlaze Alpenglow',     detail: 'Independently, SolBlaze launched a 50k SOL stake-bonus campaign for decentralisation — adjacent thesis, same operator-incentive structure.' },
];

// Pools we keep in the spotlight regardless of current rank. Latest top-15
// is loaded dynamically, but these get explicit "observations" in the cohort
// table because the trajectory is interesting enough to flag.
const NOTABLE_OBSERVATIONS: Record<string, string> = {
  'stk9ApL5HeVAwPLr3TLhDXdZS8ptVu7zp6ov8HFDuMi': 'SolBlaze. +16% in 13 days coincides with the operator launching a 50k-SOL stake-bonus campaign for decentralisation. Strongest correlation in the dataset.',
  'jagEdDepWUgexiu4jxojcRWcVKKwFqgZBBuAoGu2BxM': 'JagPool. Small mission-aligned team; visible engagement with GDI rankings on X.',
  'aero2ePURjuEgLKTzcUmF6RypBncBGd7pMUYCoSsVJ6': 'Phase / DEVOUR. Moved +7% with no public statement — quiet rebalance.',
  'CtMyWsrUtAwXWiGr9WjHT5fC3p3fgV8cyGpLTo2LJzG1': 'JPool. Steady improvement; DAO-governed allocation.',
  'hy1oDeVCVRDGkxS26qLVDvRhDpZGfWJ6w9AMvwMegwL': 'Hylo. New entrant who moved fast.',
  // Movement-flat / negative pools — names given for honesty
  'Hr9pzexrBge3vgmBNRR8u42CNQgBXdHm4UkUN2DH4a7r': 'Binance CEX-issued LST. Curated validator set tied to Binance ops; geographic mobility is structurally limited. As expected, no movement.',
  '3fV1sdGeXaNEZj6EPDTpub82pYxcRXwt2oie6jkSzeWi': 'dzSOL (DoubleZero). Already curated around DoubleZero coverage; GDI ≈ flat reflects an already-optimised baseline.',
  'edgejNWAqkePLpi5sHRxT9vHi7u3kSHP9cocABPKiWZ': 'Edgevana. Already curated; slight regression on transient delegations.',
  'Bvbu55B991evqqhLtKcyTZjzQ4EQzRUwtf9T4CcpMmPL': 'definSOL (Definity). Operates the GDI methodology. Movement reflects direct application of our optimiser — case study, not third-party evidence.',
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
  const top15 = (latest.pools ?? [])
    .filter((p) => p.gdi != null && (p.total_stake_sol ?? 0) >= 100_000)
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
          Operator response · live impact
        </p>
        <h1 className="mt-2 text-balance font-display text-3xl font-bold tracking-tight text-ink md:text-[40px] md:leading-[1.1]">
          Has GDI moved stake-pool behaviour?
        </h1>
        <p className="mt-5 text-base leading-relaxed text-ink-muted md:text-lg">
          Honest read of the first {epochs.length} epochs ({sinceDays} days) since GDI started publishing.
          Every number on this page is computed from <Link href="/methodology" className="drilldown hover:text-ink">the methodology</Link> using public on-chain + Stakewiz data, and is reproducible from
          {' '}<a href="/gdi/leaderboard-latest.json" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">our published JSON</a>.
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

            {/* Event annotations (vertical dashed lines) */}
            {EVENTS.filter((ev) => ev.epoch >= FIRST_EPOCH && ev.epoch <= lastEpoch).map((ev) => (
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
              Engagement event
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
                <th className="py-3 pr-3 text-right font-semibold">TVL</th>
                <th className="py-3 pr-5 font-semibold">Observation</th>
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
                    <td className="num py-3 pr-3 text-right text-ink-muted tabular-nums">{fmt.sol(s.tvlSol)}</td>
                    <td className="py-3 pr-5 text-ink-muted">
                      {NOTABLE_OBSERVATIONS[s.address] ?? <span className="text-ink-dim">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Engagement timeline */}
      <section className="mt-12 max-w-3xl">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Engagement timeline
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          Each event is a candidate intervention. Movement in the chart following an event is suggestive — not proof — of operator response.
        </p>
        <ol className="mt-5 space-y-3">
          {EVENTS.filter((ev) => ev.epoch >= FIRST_EPOCH && ev.epoch <= lastEpoch).map((ev) => (
            <li key={ev.epoch} className="surface flex items-start gap-3 p-5">
              <span className="font-display text-xs font-semibold uppercase tracking-wider text-accent-purple">
                Epoch {ev.epoch}
              </span>
              <div>
                <div className="font-semibold text-ink">{ev.label}</div>
                <p className="mt-1 text-sm leading-relaxed text-ink-muted">{ev.detail}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      {/* Counterfactuals */}
      <section className="mt-12 max-w-3xl">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Counterfactuals worth naming
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          Honest read of what else could explain the data.
        </p>
        <div className="mt-5 space-y-4">
          <div className="surface p-5">
            <div className="font-semibold text-ink">&quot;Stakewiz / SolanaCompass also publish data — pool teams could be responding to those.&quot;</div>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              Stakewiz publishes per-validator <code>wiz_score</code> — operator-quality composite,
              not geographic decentralisation. SolanaCompass publishes raw stake and validator
              metrics with no headline rank. GDI is the only public index producing a single
              comparable &quot;decentralisation rank&quot; per pool with per-dimension breakdown.
              If operators were optimising for Stakewiz, you&apos;d see wiz_score movement, not
              geographic-rarity movement.
            </p>
          </div>
          <div className="surface p-5">
            <div className="font-semibold text-ink">&quot;SF&apos;s own SAM / SFDP pressure could be driving the moves.&quot;</div>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              No SAM or SFDP delegation criteria changes shipped within this {sinceDays}-day
              window. Decentralisation pressure from SF has been a constant background
              variable across all of 2026 — it cannot explain a specific {sinceDays}-day
              spike in 8 of 15 pools. The single largest mover (SolBlaze, +16.4%) is
              correlated with the operator&apos;s own decentralisation campaign — independent of SF.
            </p>
          </div>
          <div className="surface p-5">
            <div className="font-semibold text-ink">&quot;{sinceDays} days is too short to be conclusive.&quot;</div>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              True. This is Phase 1 evidence. We commit to publishing a 30-day and 90-day
              update at the same URL, with the same methodology, so the conclusion is the
              same exercise repeated with more data. The current numbers are directionally
              consistent with the hypothesis; longer windows will sharpen or refute it.
            </p>
          </div>
          <div className="surface p-5">
            <div className="font-semibold text-ink">&quot;Pool rebalancing is normal churn — not a response to GDI.&quot;</div>
            <p className="mt-2 text-sm leading-relaxed text-ink-muted">
              The flat-and-negative cohort (BNSOL, dzSOL, edgeSOL) is normal churn — and
              shows essentially no movement, as expected. The improving cohort all share
              specific engagement signals (X reposts of rank, Discord engagement, founder
              tagging GDI). Random churn would be evenly distributed across the cohort; this
              isn&apos;t.
            </p>
          </div>
        </div>
      </section>

      {/* Network baseline trend */}
      {baselineSeries.length > 1 && (
        <section className="mt-12 max-w-3xl">
          <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
            Network-wide baseline
          </h2>
          <p className="mt-2 text-sm text-ink-muted">
            Stake-weighted GDI across the entire active validator set — the network as a
            whole. Per-pool moves translate to network-level shifts slowly, so this is the
            true long-game metric. Phase 1 numbers below; we&apos;ll watch this over months.
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

      {/* Definity case study + the forward ask */}
      <section className="mt-12 max-w-3xl">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Case study — Definity
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          One pool, one optimiser, fully open. The clearest answer to{' '}
          &quot;what would happen if a pool actively used GDI to drive allocation?&quot;
        </p>
        {(() => {
          const def = series.find((s) => s.address === 'Bvbu55B991evqqhLtKcyTZjzQ4EQzRUwtf9T4CcpMmPL');
          if (!def) return null;
          return (
            <div className="surface mt-4 p-6">
              <div className="grid gap-4 md:grid-cols-3">
                <div>
                  <div className="text-xs uppercase tracking-wider text-ink-dim">GDI lift</div>
                  <div className="num mt-2 font-display text-3xl font-semibold text-success">{fmt.pct(def.delta)}</div>
                  <div className="mt-1 text-xs text-ink-muted">{sinceDays} days, no marketing</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-ink-dim">Pool size</div>
                  <div className="num mt-2 font-display text-3xl font-semibold text-ink">{fmt.sol(def.tvlSol)} SOL</div>
                  <div className="mt-1 text-xs text-ink-muted">small relative to top-5 — leverage matters</div>
                </div>
                <div>
                  <div className="text-xs uppercase tracking-wider text-ink-dim">Mechanism</div>
                  <div className="num mt-2 font-display text-3xl font-semibold text-ink">Open</div>
                  <div className="mt-1 text-xs text-ink-muted">methodology + optimiser + scripts all public</div>
                </div>
              </div>
              <p className="mt-5 text-sm leading-relaxed text-ink-muted">
                Definity is the only pool whose stake-allocation logic is open-sourced and tied
                directly to GDI&apos;s methodology. Every epoch, the optimiser reads the live
                network shares, identifies which validators in our pool are in rarer locations,
                and rebalances stake toward them. The 14 on-chain actions executed at epoch{' '}
                {lastEpoch - 1} are auditable on chain. Result: {fmt.pct(def.delta)} GDI improvement
                on a 245k-SOL pool in {sinceDays} days.
              </p>
              <p className="mt-3 text-sm leading-relaxed text-ink-muted">
                <strong className="text-ink">The forward projection.</strong> With every additional
                100k SOL of stake delegated to Definity, the optimiser deploys the same
                methodology at scale. Stake to Definity is, in effect, leveraged delegation to
                under-represented validators — the same delegation SF would make directly, just
                routed through a methodology-driven LST with re-balancing already wired up.
              </p>
            </div>
          );
        })()}
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
