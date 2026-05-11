import Link from 'next/link';
import type { ReactNode } from 'react';
import { ArrowUpRight } from 'lucide-react';
import { GdiLink } from '@/components/GdiLink';
import { Leaderboard } from '@/components/Leaderboard';
import { ThemeToggle } from '@/components/ThemeToggle';
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

// "12 min ago" / "2 h ago" / "3 d ago" — server-rendered, accurate to the
// 60s revalidate window. Anything older than 24h falls back to ISO date.
function freshnessAgo(iso: string | undefined): string {
  if (!iso) return '—';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return 'just now';
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min} min ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} h ago`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d} d ago`;
  return new Date(iso).toISOString().slice(0, 10);
}

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
      {/* Hairline accent stripe — the ONLY Solana brand colour on the page */}
      <div className="h-[3px] w-full bg-gradient-to-r from-accent-green via-accent-purple to-accent-purple" />

      {/* TOP STRIP — only the things first-time visitors need at-a-glance:
          freshness signal, methodology link, validator lookup, theme toggle.
          License / data sources / epoch number all moved to other surfaces
          (footer, methodology page, stat strip respectively). */}
      <div className="border-b border-ring bg-bg-muted/60">
        <div className="container-narrow flex flex-wrap items-center justify-between gap-3 py-2.5 text-xs">
          {data ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-ink-dim">
              <span className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-1.5 w-1.5 rounded-full bg-success" />
                <span>Updated <span className="text-ink-muted">{freshnessAgo(data.last_published_at)}</span></span>
              </span>
              <Link
                href="/methodology"
                className="drilldown text-ink-muted hover:text-ink"
              >
                Methodology →
              </Link>
              <Link
                href="/validator"
                className="drilldown text-ink-muted hover:text-ink"
              >
                Validator lookup →
              </Link>
            </div>
          ) : (
            <div className="text-ink-dim">First leaderboard arriving at next epoch boundary.</div>
          )}
          <ThemeToggle />
        </div>
      </div>

      <div className="container-narrow pt-10 pb-24 md:pt-14">
        {/* HERO — title, why, factors. Three short paragraphs. */}
        <header className="max-w-3xl">
          <h1 className="text-balance font-display text-3xl font-bold tracking-tight2 text-ink md:text-[44px] md:leading-[1.1]">
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
            <a
              href="https://github.com/esterhuizen/sgdi"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-ring bg-surface px-4 py-2 text-ink-muted transition-colors hover:border-ink hover:text-ink"
            >
              Open source · GitHub
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
            <a
              href="/gdi/leaderboard-latest.json"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 rounded-full border border-ring bg-surface px-4 py-2 text-ink-muted transition-colors hover:border-ink hover:text-ink"
            >
              Raw data · JSON
              <ArrowUpRight className="h-3.5 w-3.5" />
            </a>
          </div>
        </header>

        {/* STAT STRIP — three secondary facts, mono-numeric */}
        {data && (
          <section
            aria-label="Leaderboard at a glance"
            className="mt-12 grid gap-3 sm:grid-cols-3"
          >
            <StatCard
              label="Top pool"
              value={topPool?.pool_name || (topPool ? fmt.truncAddr(topPool.pool_address) : '—')}
              sub={topPool ? <><GdiLink /> <span className="num">{fmt.num(topPool.gdi, 2)}</span></> : ''}
              isNumeric={false}
            />
            <StatCard
              label="Tracked"
              value={`${sortedPools.length}`}
              valueSuffix={sortedPools.length === 1 ? ' pool' : ' pools'}
              sub={totalTrackedStake > 0 ? `${fmt.sol(totalTrackedStake)} SOL combined` : ''}
              isNumeric={true}
            />
            <StatCard
              label="Solana epoch"
              value={String(data.epoch)}
              sub={`published ${new Date(data.last_published_at).toUTCString().replace(/^\w+, /, '').replace(' GMT', ' UTC')}`}
              isNumeric={true}
            />
          </section>
        )}

        {/* LEADERBOARD */}
        <section className="mt-10">
          <div className="mb-2 flex items-baseline justify-between">
            <h2 className="font-display text-xl font-semibold text-ink md:text-2xl">
              Stake pool leaderboard
            </h2>
            {data?.pools && (
              <span className="text-xs text-ink-dim">ranked by <GdiLink /></span>
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

          <p className="mt-4 text-xs text-ink-dim">
            Pool operator — want your pool listed?{' '}
            <a
              href="https://github.com/esterhuizen/sgdi/issues/new?template=pool-inclusion.yml"
              target="_blank"
              rel="noopener noreferrer"
              className="drilldown text-ink-muted hover:text-ink"
            >
              Submit it for inclusion →
            </a>
          </p>
        </section>

        {/* FOOTER */}
        <footer className="mt-24 border-t border-ring pt-8 text-xs text-ink-dim">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div>
              Built and maintained by Tielman (
              <a
                href="https://x.com/tielmane"
                target="_blank"
                rel="noopener noreferrer"
                className="drilldown text-ink-muted hover:text-ink"
              >
                @tielmane
              </a>{' '}
              on X,{' '}
              <a
                href="https://t.me/realtielman"
                target="_blank"
                rel="noopener noreferrer"
                className="drilldown text-ink-muted hover:text-ink"
              >
                @realtielman
              </a>{' '}
              on Telegram). Methodology open and reproducible from public data — Apache-2.0 licensed.
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              <Link href="/methodology" className="drilldown hover:text-ink">
                Methodology
              </Link>
              <a
                href="https://github.com/esterhuizen/sgdi"
                target="_blank"
                rel="noopener noreferrer"
                className="drilldown hover:text-ink"
              >
                GitHub
              </a>
              <a
                href="https://github.com/esterhuizen/sgdi/issues/new/choose"
                target="_blank"
                rel="noopener noreferrer"
                className="drilldown hover:text-ink"
              >
                Contact / report an issue
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
  valueSuffix,
  sub,
  isNumeric,
}: {
  label: string;
  value: string;
  valueSuffix?: string;
  sub?: ReactNode;
  isNumeric: boolean;
}) {
  return (
    <div className="surface p-5">
      <div className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-dim">
        {label}
      </div>
      <div
        className={`mt-2.5 text-3xl font-bold text-ink ${
          isNumeric ? 'num' : 'font-display tracking-tight2'
        }`}
      >
        {value}
        {valueSuffix && (
          <span className="ml-1 text-base font-normal text-ink-dim">{valueSuffix}</span>
        )}
      </div>
      {sub && <div className="mt-1.5 text-xs text-ink-dim">{sub}</div>}
    </div>
  );
}
