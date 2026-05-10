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
  int: (v: number | null | undefined) => (v == null ? '—' : String(v)),
};

export default async function HomePage() {
  const data = await loadLeaderboard();
  const baseline = data?.network_baseline?.gdi ?? null;
  const aboveBaseline =
    data && baseline != null
      ? data.pools.filter((p) => (p.gdi ?? 0) > baseline).length
      : 0;
  const belowBaseline =
    data && baseline != null
      ? data.pools.filter((p) => (p.gdi ?? 0) <= baseline).length
      : 0;

  return (
    <main className="min-h-screen">
      {/* Hairline accent stripe, Solana brand */}
      <div className="h-[3px] w-full bg-gradient-to-r from-accent-green via-accent-purple to-accent-purple" />

      <div className="container-narrow pt-12 pb-24 md:pt-16">
        {/* HERO */}
        <header className="max-w-3xl">
          <div className="text-xs font-semibold uppercase tracking-[0.22em] text-ink-dim">
            SGDI · Solana Geographic Decentralisation Index
          </div>
          <h1 className="mt-5 font-display text-5xl font-bold tracking-tight2 text-ink md:text-[64px] md:leading-[1.05]">
            The decentralisation leaderboard for{' '}
            <span className="bg-gradient-to-r from-accent-green to-accent-purple bg-clip-text text-transparent">
              Solana stake pools
            </span>
            .
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-ink-muted md:text-xl md:leading-relaxed">
            Most LSTs concentrate stake in a handful of validators in already-popular
            regions. A few don&apos;t.{' '}
            <strong className="text-ink">Stake with the ones that don&apos;t</strong> — same yield, better
            outcomes for the network.
          </p>

          <div className="mt-8 flex flex-wrap gap-3 text-sm">
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

        {/* STAT STRIP */}
        {data && (
          <section
            aria-label="Network at a glance"
            className="mt-14 grid gap-3 sm:grid-cols-3"
          >
            <StatCard
              label="Network baseline GDI"
              value={fmt.num(baseline, 2)}
              sub={`${data.network_baseline?.validator_count ?? '—'} active validators`}
            />
            <StatCard
              label="Pools above baseline"
              value={`${aboveBaseline} / ${aboveBaseline + belowBaseline}`}
              sub="actively reducing concentration"
              tone="good"
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
          <div className="mb-4 flex items-baseline justify-between">
            <h2 className="font-display text-xl font-semibold text-ink md:text-2xl">
              Stake pool leaderboard
            </h2>
            {data?.pools && (
              <span className="text-xs text-ink-dim">
                {data.pools.length} pools · sorted by GDI desc
              </span>
            )}
          </div>
          <p className="mb-4 max-w-2xl text-sm leading-relaxed text-ink-muted">
            Pools <strong className="text-success">above the baseline</strong> are
            preferentially delegating to less-popular places than the network
            average — directly reducing concentration. Pools{' '}
            <strong className="text-bad">below the baseline</strong> are reinforcing
            already-popular spots.
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

        {/* WHAT IT MEASURES */}
        <section className="mt-16 grid gap-8 md:grid-cols-3">
          <FactBlock
            label="What's measured"
            title="Where stake actually lives"
            body={
              <>
                For every pool, we measure how its stake is distributed
                geographically (country, city) and topologically (network
                operator / ASN). Stake in underweight regions scores higher
                than stake in already-saturated ones.
              </>
            }
          />
          <FactBlock
            label="Why it matters"
            title="Concentration is a real risk"
            body={
              <>
                When stake clusters on a few cities, ASNs, or countries,
                the network is one outage / regulatory action / cloud
                provider failure away from major disruption. A diverse
                stake distribution is healthier — for everyone.
              </>
            }
          />
          <FactBlock
            label="How to use it"
            title="Same yield, better outcomes"
            body={
              <>
                Yield differences between major LSTs are small. Decentralisation
                contribution differences are large. Pick a pool above the
                baseline and you&apos;re strengthening Solana on autopilot.
              </>
            }
          />
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
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'good' | 'bad';
}) {
  const valueColor =
    tone === 'good' ? 'text-success' : tone === 'bad' ? 'text-bad' : 'text-ink';
  return (
    <div className="surface p-5">
      <div className="text-xs font-medium uppercase tracking-[0.10em] text-ink-dim">
        {label}
      </div>
      <div className={`num mt-2 font-display text-3xl font-bold ${valueColor}`}>
        {value}
      </div>
      {sub && <div className="mt-1 text-xs text-ink-dim">{sub}</div>}
    </div>
  );
}

function FactBlock({
  label,
  title,
  body,
}: {
  label: string;
  title: string;
  body: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-xs font-medium uppercase tracking-[0.18em] text-ink-dim">
        {label}
      </div>
      <h3 className="mt-2 font-display text-lg font-semibold text-ink">{title}</h3>
      <p className="mt-3 text-sm leading-relaxed text-ink-muted">{body}</p>
    </div>
  );
}
