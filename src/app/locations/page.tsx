import Link from 'next/link';
import type { Metadata } from 'next';
import { loadValidatorIndex, type ValidatorIndexEntry } from '@/lib/data';
import { GdiLink } from '@/components/GdiLink';
import { LocationsTable, type TupleRow } from '@/components/LocationsTable';

export const revalidate = 60;

export async function generateMetadata(): Promise<Metadata> {
  const idx = await loadValidatorIndex();
  // Embed the epoch in the og:image URL so each new epoch produces a URL X
  // has never seen — forces re-scrape so unfurls pick up the latest rarity
  // ranking. Same pattern as the landing page.
  const epoch = idx?.epoch ?? 0;
  const ogImageUrl = `/locations/opengraph-image?epoch=${epoch}`;
  return {
    title: 'Where to host for maximum stake',
    description:
      'Rare validator (country, city, ASN) tuples sorted by rarity, ' +
      'filterable by DoubleZero support. For validator operators: find the ' +
      'specific hosting location where your validator earns the most ' +
      'decentralisation score.',
    openGraph: {
      images: [{ url: ogImageUrl, width: 1200, height: 630 }],
    },
    twitter: {
      card: 'summary_large_image',
      images: [ogImageUrl],
    },
  };
}

/**
 * Aggregate per-validator entries from validator-index.json into one row per
 * unique (country, city, ASN) tuple. Composite rarity = geometric mean of the
 * three per-dim rarities (same formula GDI uses for pool scores). Only tuples
 * with at least one validator currently present are emitted — this is what
 * the data lets us know about; "empty" hypothetical tuples can't be surfaced.
 */
function aggregateTuples(rows: readonly ValidatorIndexEntry[]): TupleRow[] {
  // Two-pass: first build the buckets + per-validator sums, then compute means.
  type Agg = TupleRow & {
    _wizSum: number; _wizN: number;
    _ibrlSum: number; _ibrlN: number;
    _ibrlMax: number;
  };
  const tuples = new Map<string, Agg>();
  for (const v of rows) {
    if (!v.country || !v.city || !v.asn) continue;
    const key = `${v.country}|${v.city}|${v.asn}`;
    let t = tuples.get(key);
    if (!t) {
      t = {
        key,
        country: v.country,
        city: v.city,
        asnId: v.asn,
        asnName: v.asn_name || v.asn,
        rarityCountry: v.rarity_country,
        rarityCity: v.rarity_city,
        rarityAsn: v.rarity_asn,
        composite: v.composite_rarity,
        validatorCount: 0,
        dzCount: 0,
        totalStakeSol: 0,
        avgWizScore: null,
        avgIbrlScore: null,
        maxIbrlScore: null,
        _wizSum: 0,
        _wizN: 0,
        _ibrlSum: 0,
        _ibrlN: 0,
        _ibrlMax: 0,
      };
      tuples.set(key, t);
    }
    t.validatorCount += 1;
    if (v.is_dz === true) t.dzCount += 1;
    t.totalStakeSol += v.activated_stake_sol;
    // Simple unweighted mean for both Performance + IBRL. Each validator at
    // the location counts equally — audience is new operators evaluating
    // typical infra quality, not "what the whale here experiences".
    // Validators missing a score (e.g. no blocks produced this epoch for
    // IBRL) are excluded from the mean rather than counted as zero.
    if (typeof v.wiz_score === 'number' && Number.isFinite(v.wiz_score)) {
      t._wizSum += v.wiz_score;
      t._wizN += 1;
    }
    if (typeof v.ibrl_score === 'number' && Number.isFinite(v.ibrl_score)) {
      t._ibrlSum += v.ibrl_score;
      t._ibrlN += 1;
      if (v.ibrl_score > t._ibrlMax) t._ibrlMax = v.ibrl_score;
    }
  }
  // Finalise: compute means, strip internal sums before returning.
  return [...tuples.values()].map(({ _wizSum, _wizN, _ibrlSum, _ibrlN, _ibrlMax, ...t }) => ({
    ...t,
    avgWizScore: _wizN > 0 ? _wizSum / _wizN : null,
    avgIbrlScore: _ibrlN > 0 ? _ibrlSum / _ibrlN : null,
    // Max only meaningful when >1 IBRL data point; otherwise max == avg, no
    // extra signal. Null suppresses the "max N" subtext in the table cell.
    maxIbrlScore: _ibrlN > 1 ? _ibrlMax : null,
  }));
}

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
          Where to host for maximum stake
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
                <strong className="text-ink">Operator score</strong> and{' '}
                <strong className="text-ink">IBRL</strong> are both 0–100 means
                across the validators at this location, but they measure
                different things — read them together rather than picking one.
              </li>
              <li>
                <strong className="text-ink">Operator score</strong> is the
                simple arithmetic mean of{' '}
                <a href="https://api.stakewiz.com" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">
                  Stakewiz
                </a>
                &apos;s <code className="rounded bg-bg-muted px-1 py-0.5">wiz_score</code>.
                Captures the <em>operator&apos;s</em> competence: vote success,
                skip rate, uptime, commission, info-completeness. Same DC, two
                operators — scores can diverge widely. Use as a sanity check on
                the location: if everyone here scores poorly, something&apos;s
                wrong with the people or the infra.
              </li>
              <li>
                <strong className="text-ink">IBRL</strong> (
                <a href="https://ibrl.wtf/methodology/" target="_blank" rel="noopener noreferrer" className="drilldown hover:text-ink">
                  Increase Bandwidth, Reduce Latency
                </a>
                ) is the mean of Jito&apos;s block-build score, weighted
                non-vote packing (45%), slot time (40%), vote packing (15%).
                Captures the <em>network and DC</em> quality — almost pure
                latency / bandwidth signal once you control for operator. This
                is the one most directly tied to a hosting decision: a new
                validator moving in inherits the location&apos;s IBRL much more
                than its Operator score. Validators with no blocks this epoch
                are excluded; a dash means nobody here had a score.
              </li>
              <li>
                Both means are equal-weighted per operator (not stake-weighted)
                so a single whale doesn&apos;t dominate the typical-infra
                signal.
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
                Labels come from{' '}
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
