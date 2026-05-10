import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { Leaderboard } from '@/components/Leaderboard';
import { loadLeaderboard } from '@/lib/data';

// Re-render at most every 60 seconds. Underlying JSON updates per ingest
// (every 30 min default), so 60s page revalidate is plenty fresh.
export const revalidate = 60;

const fmt = {
  num: (v: number | null | undefined, d = 2) =>
    v == null ? '—' : v.toFixed(d),
  sol: (v: number | null | undefined) => {
    if (v == null) return '—';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
  truncAddr: (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`,
};

export default async function HomePage() {
  const data = await loadLeaderboard();
  const sortedPools =
    data?.pools
      ?.slice()
      .sort((a, b) => (b.gdi ?? -Infinity) - (a.gdi ?? -Infinity)) ?? [];
  const topPool = sortedPools[0] ?? null;
  const totalTrackedStake = sortedPools.reduce(
    (sum, p) => sum + (p.total_stake_sol ?? 0),
    0,
  );

  return (
    <main className="min-h-screen">
      {/* Hairline accent stripe, Solana brand */}
      <div className="h-[3px] w-full bg-gradient-to-r from-accent-green via-accent-purple to-accent-purple" />

      <div className="container-narrow pt-12 pb-24 md:pt-16">
        {/* HERO — title, why, factors. Three lines, no rhetoric. */}
        <header className="max-w-3xl">
          <h1 className="font-display text-4xl font-bold tracking-tight2 text-ink md:text-[56px] md:leading-[1.05]">
            Solana Stake Pool Decentralisation Index
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-ink-muted md:text-xl md:leading-relaxed">
            Stake concentration on a few cities, network operators, or countries is real
            risk to Solana. Pools that distribute stake away from those clusters strengthen
            the network.
          </p>
          <p className="mt-3 text-base leading-relaxed text-ink-muted md:text-lg">
            We measure the <strong className="text-ink">country</strong>,{' '}
            <strong className="text-ink">city</strong>, and{' '}
            <strong className="text-ink">network operator</strong> (ASN) of every validator
            in every pool, every epoch — and rank pools by how widely their stake is spread.
          </p>

          <div className="mt-7 flex flex-wrap gap-3 text-sm">
            <Link
              href="/methodology"
              className="inline-flex items-center gap-1 rounded-full border border-ring bg-bg px-4 py-2 text-ink hover:border-ink"
            >
              How is this computed?
              <ArrowUpRight className="h-3.5 w-3.5" />
            </Link>
            <a
              href="https://github.com/esterhuizen/sgdi"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-ring bg-bg px-4 py-2 text-ink-muted hover:border-ink hover:text-ink"
            >
              Open source · GitHub
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
            <a
              href="/gdi/leaderboard-latest.json"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-ring bg-bg px-4 py-2 text-ink-muted hover:border-ink hover:text-ink"
            >
              Raw data · JSON
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </header>

        {/* STAT STRIP — neutral facts about what you're looking at, no flex */}
        {data && (
          <section
            aria-label="Leaderboard at a glance"
            className="mt-14 grid gap-3 sm:grid-cols-3"
          >
            <StatCard
              label="Top pool"
              value={topPool?.pool_name || (topPool ? fmt.truncAddr(topPool.pool_address) : '—')}
              sub={topPool ? `GDI ${fmt.num(topPool.gdi, 2)}` : ''}
            />
            <StatCard
              label="Tracked"
              value={`${sortedPools.length} pools`}
              sub={totalTrackedStake > 0 ? `${fmt.sol(totalTrackedStake)} SOL combined` : ''}
            />
            <StatCard
              label="Solana epoch"
              value={String(data.epoch)}
              sub={`published ${new Date(data.last_published_at).toUTCString().replace(/^\w+, /, '').replace(' GMT', ' UTC')}`}
            />
          </section>
        )}

        {/* LEADERBOARD */}
        <section className="mt-12">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-display text-xl font-semibold text-ink md:text-2xl">
              Stake pool leaderboard
            </h2>
            {data?.pools && (
              <span className="text-xs text-ink-dim">
                ranked by GDI
              </span>
            )}
          </div>
          <p className="mb-4 max-w-2xl text-sm leading-relaxed text-ink-muted">
            Pools at the top of this list contribute most to Solana&apos;s decentralisation.
            Click a pool name for the per-validator breakdown.
          </p>

          {data ? (
            <Leaderboard
              pools={data.pools}
              baseline={data.network_baseline}
              epoch={data.epoch}
            />
          ) : (
            <div className="surface p-8 text-center">
              <p className="text-base text-ink-muted">
                Leaderboard data isn&apos;t available yet — the first ingest hasn&apos;t completed.
              </p>
              <p className="mt-2 text-sm text-ink-dim">
                Check back after the next epoch boundary.
              </p>
            </div>
          )}
        </section>

        {/* FOOTER */}
        <footer className="mt-24 border-t border-ring pt-8 text-xs text-ink-dim">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              Built and maintained by{' '}
              <a
                href="https://definity.finance"
                target="_blank"
                rel="noopener noreferrer"
                className="text-ink-muted underline decoration-ring underline-offset-2 hover:text-ink"
              >
                Definity
              </a>
              . Methodology open and reproducible from public data — Apache-2.0 licensed.
            </div>
            <div className="flex gap-4">
              <Link href="/methodology" className="hover:text-ink">
                Methodology
              </Link>
              <a
                href="https://github.com/esterhuizen/sgdi"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-ink"
              >
                GitHub
              </a>
            </div>
          </div>
        </footer>
      </div>
    </main>
  );
}

function StatCard({
  label,
  value,
  sub,
}: {
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div className="surface p-5">
      <div className="text-xs font-medium uppercase tracking-[0.10em] text-ink-dim">
        {label}
      </div>
      <div className="num mt-2 font-display text-3xl font-bold text-ink">
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-dim">{sub}</div>}
    </div>
  );
}

