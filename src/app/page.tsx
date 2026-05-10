import Link from 'next/link';
import { Leaderboard } from '@/components/Leaderboard';
import { loadLeaderboard } from '@/lib/data';

// Re-render at most every 60 seconds at the page level. The underlying JSON
// updates per ingest (every 30 min by default), so 60s is plenty fresh.
export const revalidate = 60;

export default async function HomePage() {
  const data = await loadLeaderboard();

  return (
    <main className="container-narrow py-14 md:py-20">
      <header className="max-w-3xl">
        <span className="pill">SGDI · Solana Geographic Decentralisation Index</span>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-ink md:text-5xl">
          Where Solana stake actually lives.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-ink-muted">
          A per-epoch leaderboard ranking Solana stake pools by stake-weighted
          geographic decentralisation. Pools above the network baseline are
          delegating to less-popular places than average — directly reducing
          concentration. Pools below are reinforcing it.
        </p>
        <p className="mt-4 text-sm text-ink-muted">
          <Link href="/methodology" className="underline decoration-ring underline-offset-4 hover:text-ink">
            How is this computed?
          </Link>
        </p>
      </header>

      {data ? (
        <section className="mt-12">
          <div className="flex items-baseline justify-between">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
              Leaderboard · epoch {data.epoch}
            </h2>
            <span className="text-xs text-ink-dim">
              published {new Date(data.last_published_at).toUTCString()}
            </span>
          </div>
          <div className="mt-4">
            <Leaderboard
              pools={data.pools}
              baseline={data.network_baseline}
              epoch={data.epoch}
            />
          </div>
        </section>
      ) : (
        <section className="mt-12">
          <div className="surface p-8 text-center">
            <p className="text-base text-ink-muted">
              Leaderboard data isn&apos;t available yet — the first ingest hasn&apos;t completed.
            </p>
            <p className="mt-2 text-sm text-ink-dim">Check back after the next epoch boundary.</p>
          </div>
        </section>
      )}

      <footer className="mt-20 border-t border-ring pt-6 text-xs text-ink-dim">
        Built and maintained by{' '}
        <a
          href="https://definity.finance"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-ring underline-offset-2 hover:text-ink"
        >
          Definity
        </a>
        .{' '}
        <a
          href="https://github.com/esterhuizen/sgdi"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-ring underline-offset-2 hover:text-ink"
        >
          Open source
        </a>{' '}
        · Apache-2.0 · reproducible from public data.
      </footer>
    </main>
  );
}
