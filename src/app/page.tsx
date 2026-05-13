import Link from 'next/link';
import type { Metadata } from 'next';
import { GdiLink } from '@/components/GdiLink';
import { LeaderboardWithSearch } from '@/components/LeaderboardWithSearch';
import { ThemeToggle } from '@/components/ThemeToggle';
import { loadLeaderboard, loadValidatorIndex, type ValidatorIndexEntry } from '@/lib/data';

// Re-render at most every 60 seconds. Underlying JSON updates per ingest
// (every 30 min default), so 60s page revalidate is plenty fresh.
export const revalidate = 60;

/**
 * Embed the current epoch in the og:image URL. Each new epoch produces a URL
 * X has never seen, forcing a re-scrape (and a fresh top-5 leaderboard card)
 * without anyone needing to rebuild the site or bump a manual cache buster.
 */
export async function generateMetadata(): Promise<Metadata> {
  const data = await loadLeaderboard();
  const epoch = data?.epoch ?? 0;
  const ogImageUrl = `/opengraph-image?epoch=${epoch}`;
  return {
    openGraph: { images: [{ url: ogImageUrl, width: 1200, height: 630 }] },
    twitter: { card: 'summary_large_image', images: [ogImageUrl] },
  };
}

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

// Aggregate the validator index to find the single largest bucket on a
// dimension (ASN / country / city). Returns the key, its SOL total, and
// its share of total active stake. Used to render the "concentration
// headlines" strip on the landing page — the live numbers that frame
// why the index exists.
function topConcentrationBucket(
  validators: readonly ValidatorIndexEntry[],
  totalActiveStakeSol: number,
  getter: (v: ValidatorIndexEntry) => string | null,
): { key: string; sol: number; share: number } | null {
  const totals = new Map<string, number>();
  for (const v of validators) {
    const k = getter(v);
    if (!k) continue;
    totals.set(k, (totals.get(k) ?? 0) + v.activated_stake_sol);
  }
  if (totals.size === 0 || totalActiveStakeSol <= 0) return null;
  let best: { key: string; sol: number } | null = null;
  for (const [k, s] of totals) {
    if (!best || s > best.sol) best = { key: k, sol: s };
  }
  return best && { ...best, share: best.sol / totalActiveStakeSol };
}

export default async function HomePage() {
  const [data, validatorIndex] = await Promise.all([
    loadLeaderboard(),
    loadValidatorIndex(),
  ]);
  const sortedPools =
    data?.pools
      ?.slice()
      .sort((a, b) => (b.gdi ?? -Infinity) - (a.gdi ?? -Infinity)) ?? [];

  const concentrationByASN = validatorIndex
    ? topConcentrationBucket(validatorIndex.validators, validatorIndex.total_active_stake_sol, (v) => v.asn)
    : null;
  const concentrationByCountry = validatorIndex
    ? topConcentrationBucket(validatorIndex.validators, validatorIndex.total_active_stake_sol, (v) => v.country)
    : null;
  const concentrationByCity = validatorIndex
    ? topConcentrationBucket(validatorIndex.validators, validatorIndex.total_active_stake_sol, (v) => v.city)
    : null;

  // Look up the asn_name for the most-concentrated ASN. ASN strings like
  // "AS20326" are opaque on their own; surfacing the operator's name
  // ("TeraSwitch") anchors the abstraction.
  const topAsnName = concentrationByASN
    ? validatorIndex?.validators.find((v) => v.asn === concentrationByASN.key)?.asn_name ?? null
    : null;

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
                Index methodology →
              </Link>
              <Link
                href="/validator"
                className="drilldown text-ink-muted hover:text-ink"
              >
                Validator lookup →
              </Link>
              <a
                href="/gdi/leaderboard-latest.json"
                target="_blank"
                rel="noopener noreferrer"
                className="drilldown text-ink-muted hover:text-ink"
              >
                Raw data · JSON →
              </a>
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
          <p className="font-display text-xs font-semibold uppercase tracking-[0.22em] text-ink-dim md:text-sm">
            Solana Stake Pool
          </p>
          <h1 className="mt-2 text-balance font-display text-3xl font-bold tracking-tight2 text-ink md:text-[44px] md:leading-[1.1]">
            Geographic Decentralisation Index
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

        </header>

        {/* CONCENTRATION HEADLINES — the live "why" of the index. Replaces
            the old "Top pool / Tracked / Epoch" cards, all of which were
            already implicit in the leaderboard or the top strip. */}
        {validatorIndex && (concentrationByASN || concentrationByCountry || concentrationByCity) && (
          <section
            aria-label="Network concentration headlines"
            className="mt-12"
          >
            <p className="mb-4 text-xs font-medium uppercase tracking-[0.14em] text-ink-dim">
              The problem in three numbers · largest single bucket per dimension, today
            </p>
            <div className="grid gap-3 sm:grid-cols-3">
              <ConcentrationCard
                label="Most-concentrated ASN"
                share={concentrationByASN?.share}
                bucket={concentrationByASN?.key}
                bucketSubtitle={topAsnName}
                sol={concentrationByASN?.sol}
              />
              <ConcentrationCard
                label="Most-concentrated country"
                share={concentrationByCountry?.share}
                bucket={concentrationByCountry?.key}
                sol={concentrationByCountry?.sol}
              />
              <ConcentrationCard
                label="Most-concentrated city"
                share={concentrationByCity?.share}
                bucket={concentrationByCity?.key}
                sol={concentrationByCity?.sol}
              />
            </div>
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
            <LeaderboardWithSearch
              pools={data.pools}
              baseline={data.network_baseline}
              epoch={data.epoch}
              defaultLimit={25}
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

function ConcentrationCard({
  label,
  share,
  bucket,
  bucketSubtitle,
  sol,
}: {
  label: string;
  share: number | undefined;
  bucket: string | undefined;
  /** Optional human name to attach to an opaque bucket key (e.g. "TeraSwitch" for "AS20326"). */
  bucketSubtitle?: string | null;
  sol: number | undefined;
}) {
  const pct = share != null ? (share * 100).toFixed(1) : '—';
  const solFmt =
    sol == null
      ? '—'
      : sol >= 1_000_000
        ? `${(sol / 1_000_000).toFixed(0)}M`
        : sol >= 10_000
          ? `${(sol / 1_000).toFixed(0)}k`
          : sol.toFixed(0);
  return (
    <div className="surface p-5">
      <div className="text-[11px] font-medium uppercase leading-tight tracking-[0.14em] text-ink-dim min-h-[2.5em]">
        {label}
      </div>
      <div className="num mt-2.5 text-3xl font-bold text-ink">
        {pct}
        <span className="ml-0.5 text-2xl font-bold text-ink">%</span>
      </div>
      <div className="mt-1.5 text-xs text-ink-muted">
        {bucket ?? '—'}
        {bucketSubtitle && (
          <>
            {' '}
            <span className="text-ink-dim">·</span>{' '}
            <span className="text-ink-muted">{bucketSubtitle}</span>
          </>
        )}
        {sol != null && (
          <>
            {' '}
            <span className="text-ink-dim">·</span>{' '}
            <span className="num text-ink-dim">{solFmt} SOL</span>
          </>
        )}
      </div>
    </div>
  );
}
