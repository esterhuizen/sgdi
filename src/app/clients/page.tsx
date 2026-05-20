import Link from 'next/link';
import type { Metadata } from 'next';
import { loadLeaderboard } from '@/lib/data';
import { DEFAULT_TVL_FLOOR_SOL } from '@/lib/leaderboard-config';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Solana validator client adoption',
  description:
    'Live network-wide rollout tracker for Agave-family v4 and Firedancer ' +
    '0.909.40001+. Shows stake share on v4 vs pre-v4 buckets across the ' +
    'whole network and per stake pool.',
};

// A client label "Agave v4" / "Frankendancer v5" / etc. → its major version
// number (4, 5, …). Returns null for unlabelled buckets like "Agave",
// "Frankendancer", "Firedancer" (pre-v4).
function vN(label: string): number | null {
  const m = /\sv(\d+)$/.exec(label);
  return m ? parseInt(m[1], 10) : null;
}

const fmt = {
  sol: (v: number) => {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
  pct: (v: number, d = 1) => `${(v * 100).toFixed(d)}%`,
};

export default async function ClientsPage() {
  const data = await loadLeaderboard();
  const network = data?.network_client_distribution;
  const pools = data?.pools ?? [];

  const networkTotalStake = (network?.by_client ?? []).reduce(
    (s, b) => s + b.stake_sol, 0,
  );
  // v4-and-up roll-up. Anything with a v4+ suffix counts.
  const v4Buckets = (network?.by_client ?? []).filter((b) => (vN(b.client) ?? 0) >= 4);
  const v4StakeSol = v4Buckets.reduce((s, b) => s + b.stake_sol, 0);
  const v4Validators = v4Buckets.reduce((s, b) => s + b.validator_count, 0);
  const v4Share = networkTotalStake > 0 ? v4StakeSol / networkTotalStake : 0;

  // Per-pool v4 share, filtered to the headline tier (≥ DEFAULT_TVL_FLOOR_SOL).
  // Sorted by v4 share descending so the leading pools surface.
  const poolRows = pools
    .map((p) => {
      const buckets = p.client_distribution?.by_client ?? [];
      const total = buckets.reduce((s, b) => s + b.stake_sol, 0);
      const v4 = buckets
        .filter((b) => (vN(b.client) ?? 0) >= 4)
        .reduce((s, b) => s + b.stake_sol, 0);
      return {
        address: p.pool_address,
        name: p.pool_name ?? p.pool_address.slice(0, 6) + '…' + p.pool_address.slice(-4),
        totalStakeSol: total,
        v4Share: total > 0 ? v4 / total : 0,
        gdi: p.gdi,
        validatorCount: buckets.reduce((s, b) => s + b.validator_count, 0),
      };
    })
    .filter((p) => p.totalStakeSol >= DEFAULT_TVL_FLOOR_SOL)
    .sort((a, b) => b.v4Share - a.v4Share);

  // For visual grouping in the bucket table: v4 first (highlighted), then pre-v4.
  const bucketsSorted = (network?.by_client ?? [])
    .slice()
    .sort((a, b) => b.stake_sol - a.stake_sol);

  return (
    <main className="container-narrow py-14 md:py-20">
      <Link href="/" className="drilldown text-sm text-ink-muted hover:text-ink">
        ← Back to leaderboard
      </Link>

      <header className="mt-6 max-w-3xl">
        <p className="font-display text-xs font-semibold uppercase tracking-[0.22em] text-ink-dim md:text-sm">
          Network rollout tracker
        </p>
        <h1 className="mt-2 text-balance font-display text-3xl font-bold tracking-tight text-ink md:text-[40px] md:leading-[1.1]">
          Solana validator client adoption
        </h1>
        <p className="mt-5 text-base leading-relaxed text-ink-muted md:text-lg">
          Live, on-chain view of the network&apos;s v4 rollout. Per Jump&apos;s
          compat note, every validator should be running a minimum of{' '}
          <strong className="text-ink">Agave 4.0.0-rc.1</strong> or{' '}
          <strong className="text-ink">Firedancer 0.909.40001</strong>.
          Client labels derived from on-chain <code className="rounded bg-bg-muted px-1 py-0.5 text-sm">getClusterNodes</code>{' '}
          + Jito&apos;s BAM API — no operator self-attestation.{' '}
          <Link href="/methodology#client-diversity" className="drilldown hover:text-ink">
            Methodology →
          </Link>
        </p>
      </header>

      {/* Headline: network-wide v4 stake share */}
      <section className="mt-10 grid gap-4 md:grid-cols-3">
        <div className="surface p-6">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Network stake on v4</div>
          <div className="num mt-2 font-display text-4xl font-semibold text-ink md:text-5xl">
            {fmt.pct(v4Share, 1)}
          </div>
          <div className="mt-1 text-sm text-ink-muted">
            {fmt.sol(v4StakeSol)} SOL of {fmt.sol(networkTotalStake)} SOL
          </div>
        </div>
        <div className="surface p-6">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Validators on v4</div>
          <div className="num mt-2 font-display text-4xl font-semibold text-ink md:text-5xl">
            {v4Validators}
          </div>
          <div className="mt-1 text-sm text-ink-muted">
            across {v4Buckets.length} v4 buckets
          </div>
        </div>
        <div className="surface p-6">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Epoch</div>
          <div className="num mt-2 font-display text-4xl font-semibold text-ink md:text-5xl">
            {data?.epoch ?? '—'}
          </div>
          <div className="mt-1 text-sm text-ink-muted">
            updated each ingest cycle
          </div>
        </div>
      </section>

      {/* Network-wide bucket table */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Network buckets
        </h2>
        <div className="surface mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.10em] text-ink-dim">
              <tr>
                <th className="py-3 pl-5 pr-3 font-semibold">Client</th>
                <th className="py-3 pr-3 text-right font-semibold">Validators</th>
                <th className="py-3 pr-3 text-right font-semibold">Stake (SOL)</th>
                <th className="py-3 pr-5 text-right font-semibold">Network share</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {bucketsSorted.map((b) => {
                const isV4 = (vN(b.client) ?? 0) >= 4;
                return (
                  <tr key={b.client} className="border-t border-ring">
                    <td className="py-3 pl-5 pr-3">
                      <span className={isV4 ? 'font-semibold text-ink' : 'text-ink-muted'}>
                        {b.client}
                      </span>
                      {isV4 && (
                        <span className="ml-2 rounded-full bg-success/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-success">
                          v4+
                        </span>
                      )}
                    </td>
                    <td className="num py-3 pr-3 text-right tabular-nums">{b.validator_count}</td>
                    <td className="num py-3 pr-3 text-right tabular-nums">{fmt.sol(b.stake_sol)}</td>
                    <td className="num py-3 pr-5 text-right tabular-nums">{fmt.pct(b.stake_share)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>

      {/* Per-pool v4 ranking */}
      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Stake pools — v4 adoption
        </h2>
        <p className="mt-2 max-w-2xl text-sm text-ink-muted">
          Pools above the {fmt.sol(DEFAULT_TVL_FLOOR_SOL)} SOL headline floor, sorted by v4 stake share.
          A pool delegating heavily to v4 is materially helping the rollout.
        </p>
        <div className="surface mt-4 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.10em] text-ink-dim">
              <tr>
                <th className="py-3 pl-5 pr-3 font-semibold">#</th>
                <th className="py-3 pr-3 font-semibold">Pool</th>
                <th className="py-3 pr-3 text-right font-semibold">v4 share</th>
                <th className="py-3 pr-3 text-right font-semibold">Validators</th>
                <th className="py-3 pr-5 text-right font-semibold">Total stake</th>
              </tr>
            </thead>
            <tbody className="text-ink">
              {poolRows.map((p, i) => (
                <tr key={p.address} className="border-t border-ring">
                  <td className="num py-3 pl-5 pr-3 text-ink-dim tabular-nums">{i + 1}</td>
                  <td className="py-3 pr-3">
                    <Link
                      href={`/pools/${p.address}`}
                      className="drilldown text-ink hover:text-ink"
                    >
                      {p.name}
                    </Link>
                  </td>
                  <td className="num py-3 pr-3 text-right tabular-nums">
                    <span className={p.v4Share >= 0.5 ? 'font-semibold text-success' : 'text-ink'}>
                      {fmt.pct(p.v4Share)}
                    </span>
                  </td>
                  <td className="num py-3 pr-3 text-right text-ink-muted tabular-nums">
                    {p.validatorCount}
                  </td>
                  <td className="num py-3 pr-5 text-right text-ink-muted tabular-nums">
                    {fmt.sol(p.totalStakeSol)}
                  </td>
                </tr>
              ))}
              {poolRows.length === 0 && (
                <tr>
                  <td colSpan={5} className="py-12 text-center text-ink-dim">
                    No pools above the headline floor.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>

      <footer className="mt-16 border-t border-ring pt-6 text-xs text-ink-dim">
        Network total stake = sum of <code>activated_stake</code> across all
        active validators. A bucket&apos;s &quot;network share&quot; is its
        stake divided by that total. Pool v4 share is computed per pool from
        its own delegations, not by inheriting the network share.{' '}
        <Link href="/methodology" className="drilldown hover:text-ink">
          Full methodology →
        </Link>
      </footer>
    </main>
  );
}
