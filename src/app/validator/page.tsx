import Link from 'next/link';
import type { Metadata } from 'next';
import { loadValidatorIndex } from '@/lib/data';
import { ValidatorSearchBox } from '@/components/ValidatorSearchBox';

export const revalidate = 60;

export const metadata: Metadata = {
  title: 'Optimise validator location',
  description:
    'Look up any Solana validator and see rarer-but-equal-IBRL hosting locations. For operators wanting to lift their pool-delegation share by moving to a less concentrated country / city / ASN.',
};

const fmt = {
  pct: (v: number | null | undefined, d = 1) => (v == null ? '—' : `${v.toFixed(d)}%`),
};

export default async function ValidatorLookupPage() {
  const idx = await loadValidatorIndex();

  // Slim down to just the fields the search box needs — keeps the client
  // bundle small (full payload is ~115KB; this is ~80KB)
  const entries = (idx?.validators ?? []).map((v) => ({
    vote: v.vote_pubkey,
    identity: v.identity_pubkey,
    name: v.identity_name,
  }));

  return (
    <main className="container-narrow py-16 md:py-20">
      <Link href="/" className="drilldown text-sm text-ink-muted hover:text-ink">
        ← Back to leaderboard
      </Link>

      <header className="mt-8 max-w-2xl">
        <span className="pill">For validator operators</span>
        <h1 className="mt-4 font-display text-3xl font-bold tracking-tight2 text-ink md:text-4xl">
          Optimise validator location
        </h1>
        <p className="mt-4 text-base leading-relaxed text-ink-muted">
          See where your validator stands today, then get a shortlist of
          rarer locations where the typical operator already matches or
          beats your block-build score. Search by vote account, identity
          key, or validator name.
        </p>
      </header>

      <section className="mt-10 max-w-2xl">
        {entries.length === 0 ? (
          <p className="text-sm text-ink-muted">
            Index not yet generated. Check back after the next ingest.
          </p>
        ) : (
          <ValidatorSearchBox entries={entries} />
        )}
      </section>

      {idx && (
        <section className="mt-12 max-w-3xl">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-dim">
            Index at a glance
          </h2>
          <dl className="mt-3 grid grid-cols-2 gap-4 text-sm md:grid-cols-3">
            <div>
              <dt className="text-ink-dim">Active validators ranked</dt>
              <dd className="num mt-1 text-2xl font-semibold text-ink">{idx.rankable_count}</dd>
              <p className="mt-1 text-xs text-ink-dim">
                {idx.active_set_definition}
              </p>
            </div>
            <div>
              <dt className="text-ink-dim">Median composite rarity</dt>
              <dd className="num mt-1 text-2xl font-semibold text-ink">
                {idx.median_composite_rarity?.toFixed(2) ?? '—'}
              </dd>
              <p className="mt-1 text-xs text-ink-dim">
                Above = strengthens; below = reinforces concentration.
              </p>
            </div>
            <div>
              <dt className="text-ink-dim">Epoch</dt>
              <dd className="num mt-1 text-2xl font-semibold text-ink">{idx.epoch}</dd>
              <p className="mt-1 text-xs text-ink-dim">
                Updated {new Date(idx.last_published_at).toUTCString().replace(/^\w+, /, '').replace(' GMT', ' UTC')}
              </p>
            </div>
          </dl>
        </section>
      )}

      {idx && idx.validators.length > 0 && (
        <section className="mt-12 max-w-3xl">
          <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-dim">
            Top 20 rarest active validators
          </h2>
          <p className="mt-2 text-xs text-ink-dim">
            These contribute the most to network decentralisation by virtue of where they run.
          </p>
          <div className="surface mt-3 overflow-x-auto">
            <table className="w-full min-w-[36rem] text-sm">
              <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.12em] text-ink-dim">
                <tr>
                  <th className="py-2.5 pl-4 pr-3 font-semibold">Rank</th>
                  <th className="py-2.5 pr-3 font-semibold">Validator</th>
                  <th className="py-2.5 pr-3 font-semibold">Location</th>
                  <th className="py-2.5 pr-4 text-right font-semibold">Composite rarity</th>
                </tr>
              </thead>
              <tbody>
                {idx.validators.slice(0, 20).map((v) => (
                  <tr key={v.vote_pubkey} className="border-t border-ring">
                    <td className="num py-2.5 pl-4 pr-3 text-ink-muted">#{v.rank}</td>
                    <td className="py-2.5 pr-3">
                      <Link href={`/validator/${v.vote_pubkey}`} className="drilldown text-ink">
                        {v.identity_name || (
                          <span className="font-mono text-xs">{v.vote_pubkey.slice(0, 8)}…</span>
                        )}
                      </Link>
                    </td>
                    <td className="py-2.5 pr-3 text-ink-muted">
                      {v.country} / {v.city} / {v.asn}
                    </td>
                    <td className="num py-2.5 pr-4 text-right text-ink">
                      {v.composite_rarity?.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </main>
  );
}
