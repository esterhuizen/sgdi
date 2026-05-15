import Link from 'next/link';
import { notFound } from 'next/navigation';
import type { Metadata } from 'next';
import { loadPoolLatest, loadPoolHistory, loadNetworkBaseline, loadLeaderboard } from '@/lib/data';
import { DEFAULT_TVL_FLOOR_SOL } from '@/lib/leaderboard-config';
import { GdiLink } from '@/components/GdiLink';
import { TrendChart } from '@/components/TrendChart';

export const revalidate = 60;

type Props = { params: Promise<{ address: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { address } = await params;
  const data = await loadPoolLatest(address);
  const name = data?.pool.name || address.slice(0, 6) + '…' + address.slice(-4);
  // Embed the current epoch in the og:image URL so each new epoch produces a
  // URL X has never seen, forcing it to re-scrape (and pick up the latest
  // rank / GDI / sub-scores). Without this, Next.js's static og:image hash
  // never changes across data updates and X serves stale cached previews.
  const epoch = data?.score?.epoch ?? 0;
  const ogImageUrl = `/pools/${address}/opengraph-image?epoch=${epoch}`;
  return {
    title: `${name}`,
    description: `Geographic decentralisation score and per-validator breakdown for ${name}.`,
    openGraph: {
      images: [{ url: ogImageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      images: [ogImageUrl],
    },
  };
}

const fmt = {
  num: (v: number | null, d = 2) => (v == null ? '—' : v.toFixed(d)),
  sol: (v: number | null) => {
    if (v == null) return '—';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
  pct: (v: number | null) => (v == null ? '—' : `${(v * 100).toFixed(1)}%`),
  addr: (a: string) => `${a.slice(0, 8)}…${a.slice(-6)}`,
};

export default async function PoolDetailPage({ params }: Props) {
  const { address } = await params;
  const [latest, history, baselineFile, leaderboard] = await Promise.all([
    loadPoolLatest(address),
    loadPoolHistory(address),
    loadNetworkBaseline(),
    loadLeaderboard(),
  ]);

  if (!latest) notFound();

  // Rank shown on this page must match the landing-page leaderboard, which
  // filters at DEFAULT_TVL_FLOOR_SOL (100k). The publish-time rank stored on
  // latest.rank is across ALL scored pools at the ingest floor (20k SOL), so
  // we'd see "Definity #4 of 30" here vs "Definity #3 of 23" on landing.
  // Recompute against the same filter the UI applies.
  const filteredPools = (leaderboard?.pools ?? [])
    .filter((p) => p.gdi != null && (p.total_stake_sol ?? 0) >= DEFAULT_TVL_FLOOR_SOL)
    .sort((a, b) => (b.gdi ?? 0) - (a.gdi ?? 0));
  const filteredIdx = filteredPools.findIndex((p) => p.pool_address === latest.pool.address);
  const displayRank =
    filteredIdx >= 0
      ? { n: filteredIdx + 1, total: filteredPools.length, suffix: '' }
      : latest.rank != null && latest.total_ranked > 0
        ? { n: latest.rank, total: latest.total_ranked, suffix: ' (all pools)' }
        : null;

  // Build trend chart series. Baseline series stays — useful as a *visual*
  // backdrop for the pool's GDI line, even though we no longer surface
  // "vs baseline" deltas in the UI.
  const poolSeries = (history?.history || []).map((s) => ({ epoch: s.epoch, value: s.gdi }));
  const epochSet = new Set(poolSeries.map((p) => p.epoch));
  const baselineSeries =
    (baselineFile?.history || [])
      .filter((b) => epochSet.has(b.epoch))
      .map((b) => ({ epoch: b.epoch, value: b.gdi }));

  // Per-validator breakdown sorted by stake desc
  const validatorsSorted = [...latest.validators].sort((a, b) => b.stake_sol - a.stake_sol);

  return (
    <main className="container-narrow py-14 md:py-20">
      <Link href="/" className="drilldown text-sm text-ink-muted hover:text-ink">
        ← Back to leaderboard
      </Link>

      <header className="mt-6 max-w-3xl">
        <span className="pill">Pool · epoch {latest.score.epoch}</span>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          {latest.pool.name || fmt.addr(latest.pool.address)}
        </h1>
        <div className="mt-2 font-mono text-xs text-ink-dim">{latest.pool.address}</div>
        {latest.pool.program && (
          <div className="mt-1 text-xs text-ink-dim">
            Program: <span className="font-mono">{fmt.addr(latest.pool.program)}</span>
          </div>
        )}
      </header>

      {/* Score summary — leads with rank, sub-scores explain the components */}
      <section className="mt-10 grid gap-4 md:grid-cols-4">
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim"><GdiLink /></div>
          <div className="num mt-2 text-3xl font-semibold text-ink">{fmt.num(latest.score.gdi, 3)}</div>
          {displayRank ? (
            <div className="mt-1 text-xs text-ink-muted">
              Rank <span className="font-semibold text-ink">#{displayRank.n}</span>{' '}
              <span className="text-ink-dim">of {displayRank.total}{displayRank.suffix}</span>
            </div>
          ) : (
            <div className="mt-1 text-xs text-ink-dim">unranked this epoch</div>
          )}
        </div>
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">DC country</div>
          <div className="num mt-2 text-2xl text-ink">{fmt.num(latest.score.dc_country, 2)}</div>
          <div className="text-xs text-ink-dim">geographic spread by country</div>
        </div>
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">DC city</div>
          <div className="num mt-2 text-2xl text-ink">{fmt.num(latest.score.dc_city, 2)}</div>
          <div className="text-xs text-ink-dim">geographic spread by city</div>
        </div>
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">DC ASN</div>
          <div className="num mt-2 text-2xl text-ink">{fmt.num(latest.score.dc_asn, 2)}</div>
          <div className="text-xs text-ink-dim">network operator spread</div>
        </div>
      </section>

      {/* Secondary stats */}
      <section className="mt-4 grid gap-4 md:grid-cols-3">
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Network impact (NIS)</div>
          <div className="num mt-2 text-2xl text-ink">{fmt.num(latest.score.nis, 1)}</div>
          <div className="text-xs text-ink-dim">stake-weighted Stakewiz wiz_score</div>
        </div>
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Validators / Stake</div>
          <div className="num mt-2 text-2xl text-ink">
            {latest.score.validator_count ?? '—'}
          </div>
          <div className="text-xs text-ink-dim">{fmt.sol(latest.score.total_stake_sol)} SOL total</div>
        </div>
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Placement coverage</div>
          <div className="num mt-2 text-2xl text-ink">{fmt.pct(latest.score.placement_coverage)}</div>
          <div className="text-xs text-ink-dim">of stake placed geographically</div>
        </div>
      </section>

      {/* Client diversity + operational signals (gdi-1.2 phase 1).
          Phase 1: surfaced as separate metrics, NOT folded into headline GDI. */}
      {latest.client_distribution && (
        <section className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="surface p-5">
            <div className="text-xs uppercase tracking-wider text-ink-dim">Effective clients</div>
            <div className="num mt-2 text-2xl text-ink">
              {latest.client_distribution.effective_clients != null
                ? fmt.num(latest.client_distribution.effective_clients, 2)
                : '—'}
            </div>
            <div className="text-xs text-ink-dim">
              client-diversity score — as-if N equal clients (
              <Link href="/methodology#client-diversity" className="drilldown hover:text-ink">
                see breakdown
              </Link>
              )
            </div>
          </div>
          <div className="surface p-5">
            <div className="text-xs uppercase tracking-wider text-ink-dim">DoubleZero</div>
            <div className="num mt-2 text-2xl text-ink">
              {fmt.pct(latest.client_distribution.operational.dz_share)}
            </div>
            <div className="text-xs text-ink-dim">stake on dedicated fibre — faster voting + block production</div>
          </div>
        </section>
      )}

      {/* Trend chart */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          GDI trend
        </h2>
        <div className="mt-4 surface p-4">
          <TrendChart poolSeries={poolSeries} baselineSeries={baselineSeries} />
        </div>
      </section>

      {/* Per-validator breakdown */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Validators (current epoch)
        </h2>
        <div className="surface mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.10em] text-ink-dim">
              <tr>
                <th className="py-3 pl-5 pr-3 font-semibold">Validator</th>
                <th className="py-3 pr-3 font-semibold">Country</th>
                <th className="py-3 pr-3 font-semibold">City</th>
                <th className="py-3 pr-3 font-semibold">ASN</th>
                <th className="py-3 pr-3 text-right font-semibold">wiz_score</th>
                <th className="py-3 pr-5 text-right font-semibold">Stake</th>
              </tr>
            </thead>
            <tbody>
              {validatorsSorted.map((v) => (
                <tr key={v.pubkey} className="border-t border-ring">
                  <td className="py-3 pl-5 pr-3 font-mono text-xs">
                    <Link
                      href={`/validator/${v.pubkey}`}
                      className="drilldown text-ink-muted hover:text-ink"
                      title="View this validator's decentralisation profile"
                    >
                      {fmt.addr(v.pubkey)}
                    </Link>
                  </td>
                  <td className="py-3 pr-3 text-ink">{v.country || <span className="text-ink-dim">—</span>}</td>
                  <td className="py-3 pr-3 text-ink">{v.city || <span className="text-ink-dim">—</span>}</td>
                  <td className="py-3 pr-3 text-ink">
                    {v.asn ? (
                      <>
                        {v.asn}
                        {v.asn_name && <span className="ml-1 text-xs text-ink-dim">{v.asn_name}</span>}
                      </>
                    ) : (
                      <span className="text-ink-dim">—</span>
                    )}
                  </td>
                  <td className="num py-3 pr-3 text-right text-ink-muted">{fmt.num(v.wiz_score, 1)}</td>
                  <td className="num py-3 pr-5 text-right text-ink-muted">{fmt.sol(v.stake_sol)} SOL</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-20 border-t border-ring pt-6 text-xs text-ink-dim">
        Computed under {latest.score.methodology_version}. See{' '}
        <Link href="/methodology" className="drilldown hover:text-ink">
          methodology
        </Link>{' '}
        for the formula.
      </footer>
    </main>
  );
}
