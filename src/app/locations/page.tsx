import Link from 'next/link';
import type { Metadata } from 'next';
import { loadValidatorIndex } from '@/lib/data';
import { aggregateTuples } from '@/lib/tuples';
import { GdiLink } from '@/components/GdiLink';
import { LocationsTable } from '@/components/LocationsTable';

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const idx = await loadValidatorIndex();
  // Embed the epoch in the og:image URL so each new epoch produces a URL X
  // has never seen — forces re-scrape so unfurls pick up the latest rarity
  // ranking. Same pattern as the landing page.
  const epoch = idx?.epoch ?? 0;
  const ogImageUrl = `/locations/opengraph-image?epoch=${epoch}`;
  return {
    title: 'Explore rare hosting locations',
    description:
      'Rare validator (country, city, ASN) tuples sorted by rarity, ' +
      'filterable by DoubleZero support and minimum IBRL. For validator ' +
      'operators: find the specific hosting location where your validator ' +
      'earns the most decentralisation score.',
    openGraph: {
      images: [{ url: ogImageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      images: [ogImageUrl],
    },
  };
}

// Tuple aggregation lives in `@/lib/tuples` so the /validator detail page
// can use the same formulas for its "where you could move to" feature.

export default async function LocationsPage() {
  const idx = await loadValidatorIndex();
  const validators = idx?.validators ?? [];

  const tuples = aggregateTuples(validators);
  const totalActive = validators.length;
  const totalDz = validators.filter((v) => v.is_dz === true).length;

  return (
    <main className="container-narrow py-14 md:py-20">
      <Link href="/" className="drilldown text-sm text-ink-muted hover:text-ink">
        ← Back to leaderboard
      </Link>

      <header className="mt-6 max-w-3xl">
        <span className="pill">For validator operators</span>
        <h1 className="mt-4 text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          Explore rare hosting locations
        </h1>
        <p className="mt-4 text-base leading-relaxed text-ink-muted">
          Stake pools delegate to validators that improve their decentralisation
          score. The rarest country / city / network operator combinations are
          where a new validator can move the needle the most.
        </p>
        <p className="mt-3 text-base leading-relaxed text-ink-muted">
          Each row below is a real (country, city, ASN) location currently
          occupied by at least one validator. The{' '}
          <span className="font-medium text-ink">rarity</span> column is the
          geometric mean of the three per-dimension rarities — the same formula
          we use for <GdiLink />. Higher = more decentralising. Click any
          column header to re-sort.
        </p>
        <p className="mt-3 text-base leading-relaxed text-ink-muted">
          The default filter keeps only{' '}
          <span className="font-medium text-ink">DoubleZero-supported</span>{' '}
          locations — proven by at least one DZ validator already at that exact
          spot — so your hosting pick maximises both rarity AND voting/block
          performance. Toggle off to see the long tail.
        </p>
      </header>

      {idx ? (
        <>
          <div className="mt-6 grid gap-4 md:grid-cols-3">
            <div className="surface p-4">
              <div className="text-xs uppercase tracking-wider text-ink-dim">Active validators</div>
              <div className="num mt-1 text-2xl text-ink">{totalActive}</div>
              <div className="text-xs text-ink-dim">epoch {idx.epoch}</div>
            </div>
            <div className="surface p-4">
              <div className="text-xs uppercase tracking-wider text-ink-dim">on DoubleZero</div>
              <div className="num mt-1 text-2xl text-ink">{totalDz}</div>
              <div className="text-xs text-ink-dim">
                {totalActive > 0 ? `${((totalDz / totalActive) * 100).toFixed(0)}% of active set` : '—'}
              </div>
            </div>
            <div className="surface p-4">
              <div className="text-xs uppercase tracking-wider text-ink-dim">Rarity formula</div>
              <div className="mt-1 text-sm text-ink">
                <code className="rounded bg-bg-muted px-1.5 py-0.5">
                  ∛(r_country · r_city · r_asn)
                </code>
              </div>
              <div className="text-xs text-ink-dim">geometric mean of per-dim rarities</div>
            </div>
          </div>

          <LocationsTable tuples={tuples} />

          <section className="mt-12 max-w-3xl">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
              Reading the table
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-muted">
              <li>
                <strong className="text-ink">Rarity</strong> is the headline
                — geometric mean of the country, city, and ASN rarities for
                that exact tuple. Sort by this for the strongest overall
                decentralisation candidates.
              </li>
              <li>
                The small number under each Country/City/ASN cell is that
                dimension&apos;s rarity in isolation —{' '}
                <code className="rounded bg-bg-muted px-1 py-0.5">−ln(network_share)</code>.
                Click the column header to sort by that dimension instead of
                the headline rarity.
              </li>
              <li>
                <strong className="text-ink">IBRL</strong> (
                <a href="https://ibrl.wtf/methodology/" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">
                  Increase Bandwidth, Reduce Latency
                </a>
                ) is the equal-weighted mean of Jito&apos;s block-build score
                (non-vote packing 45%, slot time 40%, vote packing 15%) across
                validators at this location. Captures the{' '}
                <em>network and DC</em> quality — almost pure latency /
                bandwidth signal once you control for operator. A new validator
                moving in inherits the location&apos;s IBRL more than any
                operator-specific stat. Validators with no blocks this epoch
                are excluded; a dash means nobody here had a score.
              </li>
              <li>
                <strong className="text-ink">On DZ</strong>{' '}
                <span className="text-success">≥ 1</span> means at least one
                existing validator at this exact (country, city, ASN) tuple has
                DoubleZero enabled — proves the location can support DZ.{' '}
                <span className="text-ink-dim">0</span> doesn&apos;t prove
                infeasibility, just that nobody&apos;s tried it yet.
              </li>
              <li>
                <strong className="text-ink">Validators / Stake</strong> show
                how crowded the location already is. Lower validator count +
                higher composite = the cleanest opportunity.
              </li>
              <li>
                Geo labels come from{' '}
                <a href="https://www.validators.app/api-documentation" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">
                  validators.app
                </a>{' '}
                and{' '}
                <a href="https://api.stakewiz.com" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">
                  Stakewiz
                </a>.
                See <Link href="/methodology" className="drilldown hover:text-ink">methodology</Link>{' '}
                for the full data lineage.
              </li>
            </ul>
          </section>
        </>
      ) : (
        <div className="mt-10 surface p-8 text-center text-ink-dim">
          Location data isn&apos;t available yet — the first ingest hasn&apos;t completed.
        </div>
      )}
    </main>
  );
}
