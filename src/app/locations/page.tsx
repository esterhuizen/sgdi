import Link from 'next/link';
import type { Metadata } from 'next';
import { loadValidatorIndex, type ValidatorIndexEntry } from '@/lib/data';
import { GdiLink } from '@/components/GdiLink';
import { LocationsTable, type BucketRow } from '@/components/LocationsTable';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Where to host for maximum stake',
  description:
    'Rare validator locations sorted by rarity, filterable by DoubleZero support. ' +
    'For validator operators: find the country, city, and ASN where hosting earns the most decentralisation score.',
};

/**
 * Aggregate the per-validator entries from validator-index.json into one row
 * per bucket (country / city / ASN). For each bucket we surface: rarity (same
 * for every validator in the bucket — pulled from any one), network share,
 * how many validators currently sit there, of which how many run DZ, and
 * total stake. Buckets without any DZ validator are still emitted; the
 * client component filters them by default.
 */
function aggregateBuckets(
  rows: readonly ValidatorIndexEntry[],
  getKey: (v: ValidatorIndexEntry) => string | null,
  getLabel: (v: ValidatorIndexEntry) => string | null,
  getRarity: (v: ValidatorIndexEntry) => number | null,
  getShare: (v: ValidatorIndexEntry) => number | null,
): BucketRow[] {
  const buckets = new Map<string, BucketRow>();
  for (const v of rows) {
    const key = getKey(v);
    if (!key) continue;
    let b = buckets.get(key);
    if (!b) {
      b = {
        key,
        label: getLabel(v) || key,
        rarity: getRarity(v),
        networkShare: getShare(v),
        validatorCount: 0,
        dzCount: 0,
        totalStakeSol: 0,
      };
      buckets.set(key, b);
    }
    b.validatorCount += 1;
    if (v.is_dz === true) b.dzCount += 1;
    b.totalStakeSol += v.activated_stake_sol;
  }
  return [...buckets.values()].sort((a, b) => (b.rarity ?? -Infinity) - (a.rarity ?? -Infinity));
}

export default async function LocationsPage() {
  const idx = await loadValidatorIndex();
  const validators = idx?.validators ?? [];

  const country = aggregateBuckets(
    validators,
    (v) => v.country,
    (v) => v.country,
    (v) => v.rarity_country,
    (v) => v.network_share_country,
  );
  const city = aggregateBuckets(
    validators,
    (v) => v.city,
    (v) => v.city,
    (v) => v.rarity_city,
    (v) => v.network_share_city,
  );
  const asn = aggregateBuckets(
    validators,
    (v) => v.asn,
    (v) => v.asn_name || v.asn,
    (v) => v.rarity_asn,
    (v) => v.network_share_asn,
  );

  // Network-wide DZ + active counts for the context lede.
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
          Where to host for maximum stake
        </h1>
        <p className="mt-4 text-base leading-relaxed text-ink-muted">
          Stake pools delegate to validators that improve their decentralisation
          score. The rarest country / city / network operator buckets are where
          a new validator can move the needle the most.
        </p>
        <p className="mt-3 text-base leading-relaxed text-ink-muted">
          The filter below keeps you on{' '}
          <span className="font-medium text-ink">DoubleZero-supported</span>{' '}
          locations — proven by at least one existing DZ validator there — so
          your hosting choice both maximises rarity AND keeps you on the
          dedicated fibre network that drives voting + block-production
          performance. Toggle it off to see the rarest locations regardless of
          DZ availability.
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
                <code className="rounded bg-bg-muted px-1.5 py-0.5">−ln(network_share)</code>
              </div>
              <div className="text-xs text-ink-dim">higher = rarer (more decentralising)</div>
            </div>
          </div>

          <LocationsTable country={country} city={city} asn={asn} />

          <section className="mt-12 max-w-3xl">
            <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
              Reading the table
            </h2>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm leading-relaxed text-ink-muted">
              <li>
                <strong className="text-ink">Rarity</strong> is{' '}
                <code className="rounded bg-bg-muted px-1 py-0.5">−ln(network_share)</code>{' '}
                — the same number that feeds <GdiLink />. A bucket holding 1% of
                stake has rarity ≈ 4.6; a bucket holding 30% has rarity ≈ 1.2.
              </li>
              <li>
                <strong className="text-ink">On DZ</strong> counts how many
                existing validators at this location have DoubleZero enabled.
                A column value of <span className="text-success">1+</span> proves
                DZ coverage is feasible there; <span className="text-ink-dim">0</span>{' '}
                doesn&apos;t prove it&apos;s impossible — just that nobody&apos;s
                done it yet.
              </li>
              <li>
                <strong className="text-ink">Total stake</strong> at the location
                gives a feel for whether it&apos;s already capacity-constrained.
                Lower stake + higher rarity = the cleanest opportunity.
              </li>
              <li>
                Labels come from <a href="https://www.validators.app/api-documentation" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">validators.app</a>{' '}
                and <a href="https://api.stakewiz.com" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">Stakewiz</a>.
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
