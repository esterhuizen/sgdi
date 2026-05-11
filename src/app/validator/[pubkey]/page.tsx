import Link from 'next/link';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { loadValidatorIndex, loadLeaderboard, loadPoolLatest } from '@/lib/data';
import { GdiLink } from '@/components/GdiLink';

export const revalidate = 60;

type Props = { params: Promise<{ pubkey: string }> };

const fmt = {
  num: (v: number | null | undefined, d = 2) => (v == null ? '—' : v.toFixed(d)),
  pct: (v: number | null | undefined, d = 2) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`),
  sol: (v: number | null | undefined) => {
    if (v == null) return '—';
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(2)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
  truncAddr: (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`,
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { pubkey } = await params;
  const idx = await loadValidatorIndex();
  const v = idx?.validators.find((x) => x.vote_pubkey === pubkey || x.identity_pubkey === pubkey);
  const name = v?.identity_name || (v ? fmt.truncAddr(v.vote_pubkey) : fmt.truncAddr(pubkey));
  return {
    title: `${name} · Validator profile`,
    description: v
      ? `${name} — ${v.country}/${v.city}/${v.asn}. Composite rarity ${fmt.num(v.composite_rarity, 2)} (rank ${v.rank} of ${idx?.rankable_count}).`
      : `Validator profile for ${pubkey}`,
  };
}

// Verdict per dimension based on rarity vs the median rarity in that dim.
// Above median = strengthens decentralisation; below = reinforces concentration.
// Returns a small struct with a label, a one-word "tone" (good / bad / neutral)
// so the UI can colour or icon consistently.
function verdict(rarity: number | null, networkShare: number | null): {
  tone: 'good' | 'bad' | 'neutral';
  label: string;
} {
  if (rarity == null || networkShare == null) return { tone: 'neutral', label: 'no data' };
  // Treat top-quintile concentration (≥20% of network in this bucket) as "reinforces"
  // and rare buckets (<2%) as "strengthens". Middle = neutral.
  if (networkShare >= 0.20) return { tone: 'bad', label: 'reinforces concentration' };
  if (networkShare < 0.02) return { tone: 'good', label: 'strengthens decentralisation' };
  return { tone: 'neutral', label: 'neutral' };
}

export default async function ValidatorDetailPage({ params }: Props) {
  const { pubkey } = await params;
  const [idx, leaderboard] = await Promise.all([
    loadValidatorIndex(),
    loadLeaderboard(),
  ]);

  if (!idx) {
    return (
      <main className="container-narrow py-16">
        <p className="text-base text-ink-muted">
          Validator index not yet available. Check back after the next ingest.
        </p>
      </main>
    );
  }

  // Resolve by vote pubkey OR identity pubkey (allows direct URLs from either)
  const v = idx.validators.find(
    (x) => x.vote_pubkey === pubkey || x.identity_pubkey === pubkey,
  );

  if (!v) {
    // Maybe the validator is delinquent or unranked — search the broader DB
    // would help, but for v1 we just show "not in active set" with a hint.
    return (
      <main className="container-narrow py-16">
        <Link href="/validator" className="text-sm text-ink-muted underline-offset-2 hover:underline">
          ← Back to validator lookup
        </Link>
        <h1 className="mt-8 font-display text-2xl font-semibold text-ink">
          Validator not in active set
        </h1>
        <p className="mt-3 max-w-2xl text-base text-ink-muted">
          No active voting validator matches{' '}
          <code className="rounded bg-bg-muted px-1.5 py-0.5 font-mono text-xs">{pubkey}</code>.
          The validator may be delinquent, have zero activated stake, or the key
          may be incorrect.
        </p>
        <p className="mt-3 max-w-2xl text-sm text-ink-dim">
          Definition: an "active validator" is one that is currently voting on
          chain and has activated stake &gt; 0. Last updated {new Date(idx.last_published_at).toUTCString().replace(/^\w+, /, '').replace(' GMT', ' UTC')}.
        </p>
      </main>
    );
  }

  // Find which tracked pools delegate to this validator (from the leaderboard
  // bundle we don't have per-validator delegation, so we'd need to scan each
  // pool's latest JSON. Acceptable for the page — ~20 small files cached.)
  type PoolHit = { address: string; name: string | null; stake_sol: number };
  const poolHits: PoolHit[] = [];
  if (leaderboard?.pools) {
    const pools = leaderboard.pools;
    await Promise.all(
      pools.map(async (p) => {
        const detail = await loadPoolLatest(p.pool_address);
        const hit = detail?.validators.find((dv) => dv.pubkey === v.vote_pubkey);
        if (hit) {
          poolHits.push({
            address: p.pool_address,
            name: p.pool_name ?? null,
            stake_sol: hit.stake_sol,
          });
        }
      }),
    );
    poolHits.sort((a, b) => b.stake_sol - a.stake_sol);
  }

  const verdictCountry = verdict(v.rarity_country, v.network_share_country);
  const verdictCity    = verdict(v.rarity_city,    v.network_share_city);
  const verdictAsn     = verdict(v.rarity_asn,     v.network_share_asn);
  const verdicts = [
    { dim: 'country', value: v.country, ...verdictCountry },
    { dim: 'city',    value: v.city,    ...verdictCity },
    { dim: 'asn',     value: v.asn,     ...verdictAsn },
  ];
  const goodDims = verdicts.filter((v) => v.tone === 'good').map((v) => v.dim);
  const badDims  = verdicts.filter((v) => v.tone === 'bad').map((v) => v.dim);

  const toneClass = (t: 'good' | 'bad' | 'neutral') =>
    t === 'good' ? 'text-success' : t === 'bad' ? 'text-bad' : 'text-ink-dim';
  const toneSymbol = (t: 'good' | 'bad' | 'neutral') =>
    t === 'good' ? '▲' : t === 'bad' ? '▼' : '▶';

  return (
    <main className="container-narrow py-12 md:py-16">
      <Link href="/validator" className="text-sm text-ink-muted underline-offset-2 hover:underline">
        ← Back to validator lookup
      </Link>

      <header className="mt-6 max-w-3xl">
        <div className="flex items-start gap-5">
          {v.image_url && (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={v.image_url}
              alt=""
              className="h-14 w-14 rounded-full border border-ring object-cover"
            />
          )}
          <div className="flex-1">
            <span className="pill">Validator profile · epoch {idx.epoch}</span>
            <h1 className="mt-3 font-display text-2xl font-semibold text-ink md:text-3xl">
              {v.identity_name || fmt.truncAddr(v.vote_pubkey)}
            </h1>
            <div className="mt-2 grid gap-1 text-xs text-ink-dim">
              <div>
                vote     · <span className="font-mono">{v.vote_pubkey}</span>
              </div>
              {v.identity_pubkey && (
                <div>
                  identity · <span className="font-mono">{v.identity_pubkey}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      </header>

      {/* Headline: composite rarity + rank */}
      <section className="mt-8 grid gap-4 md:grid-cols-3">
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Composite rarity</div>
          <div className="num mt-2 text-3xl font-semibold text-ink">{fmt.num(v.composite_rarity, 2)}</div>
          <div className="mt-1 text-xs text-ink-dim">
            network median <span className="num">{fmt.num(idx.median_composite_rarity, 2)}</span>
          </div>
        </div>
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Active-set rank</div>
          <div className="num mt-2 text-3xl font-semibold text-ink">
            #{v.rank ?? '—'} <span className="text-base font-normal text-ink-dim">/ {idx.rankable_count}</span>
          </div>
          <div className="mt-1 text-xs text-ink-dim">
            top <span className="num">{fmt.num(v.percentile, 1)}%</span> of voting validators
          </div>
        </div>
        <div className="surface p-5">
          <div className="text-xs uppercase tracking-wider text-ink-dim">Activated stake</div>
          <div className="num mt-2 text-3xl font-semibold text-ink">{fmt.sol(v.activated_stake_sol)} SOL</div>
          <div className="mt-1 text-xs text-ink-dim">network-wide total</div>
        </div>
      </section>

      {/* Per-dimension breakdown */}
      <section className="mt-10 max-w-3xl">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Per-dimension breakdown
        </h2>
        <p className="mt-2 text-sm text-ink-muted">
          Rarity = <code>−ln(network share of your bucket)</code>. Higher = rarer = better for decentralisation.
        </p>
        <div className="surface mt-3 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.12em] text-ink-dim">
              <tr>
                <th className="py-2.5 pl-4 pr-3 font-semibold">Dimension</th>
                <th className="py-2.5 pr-3 font-semibold">Your bucket</th>
                <th className="py-2.5 pr-3 text-right font-semibold">Network share</th>
                <th className="py-2.5 pr-3 text-right font-semibold">Rarity</th>
                <th className="py-2.5 pr-4 font-semibold">Effect</th>
              </tr>
            </thead>
            <tbody>
              <tr className="border-t border-ring">
                <td className="py-3 pl-4 pr-3 text-ink-muted">Country</td>
                <td className="py-3 pr-3 text-ink">{v.country ?? '—'}</td>
                <td className="num py-3 pr-3 text-right text-ink">{fmt.pct(v.network_share_country)}</td>
                <td className="num py-3 pr-3 text-right text-ink">{fmt.num(v.rarity_country, 2)}</td>
                <td className={`py-3 pr-4 ${toneClass(verdictCountry.tone)}`}>
                  {toneSymbol(verdictCountry.tone)} {verdictCountry.label}
                </td>
              </tr>
              <tr className="border-t border-ring">
                <td className="py-3 pl-4 pr-3 text-ink-muted">City</td>
                <td className="py-3 pr-3 text-ink">{v.city ?? '—'}</td>
                <td className="num py-3 pr-3 text-right text-ink">{fmt.pct(v.network_share_city)}</td>
                <td className="num py-3 pr-3 text-right text-ink">{fmt.num(v.rarity_city, 2)}</td>
                <td className={`py-3 pr-4 ${toneClass(verdictCity.tone)}`}>
                  {toneSymbol(verdictCity.tone)} {verdictCity.label}
                </td>
              </tr>
              <tr className="border-t border-ring">
                <td className="py-3 pl-4 pr-3 text-ink-muted">ASN</td>
                <td className="py-3 pr-3 text-ink">
                  {v.asn ?? '—'}
                  {v.asn_name && <span className="ml-1 text-xs text-ink-dim">{v.asn_name}</span>}
                </td>
                <td className="num py-3 pr-3 text-right text-ink">{fmt.pct(v.network_share_asn)}</td>
                <td className="num py-3 pr-3 text-right text-ink">{fmt.num(v.rarity_asn, 2)}</td>
                <td className={`py-3 pr-4 ${toneClass(verdictAsn.tone)}`}>
                  {toneSymbol(verdictAsn.tone)} {verdictAsn.label}
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        {/* Plain-English summary */}
        <p className="mt-4 max-w-2xl text-sm leading-relaxed text-ink-muted">
          {goodDims.length > 0 && (
            <>
              <strong className="text-ink">Strengthens</strong> network decentralisation
              on {goodDims.join(' and ')}.{' '}
            </>
          )}
          {badDims.length > 0 && (
            <>
              <strong className="text-ink">Reinforces</strong> concentration on{' '}
              {badDims.join(' and ')} — your bucket is over-represented in the network.
            </>
          )}
          {goodDims.length === 0 && badDims.length === 0 && (
            <>All three dimensions sit near network medians — neither strengthening nor reinforcing.</>
          )}
        </p>
      </section>

      {/* Tracked pools delegating to this validator */}
      <section className="mt-12 max-w-3xl">
        <h2 className="text-xs font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Tracked pools delegating to you
        </h2>
        {poolHits.length === 0 ? (
          <p className="mt-3 text-sm text-ink-muted">
            None of the {leaderboard?.pools.length ?? 0} tracked stake pools currently delegate to this
            validator.
          </p>
        ) : (
          <div className="surface mt-3 overflow-hidden">
            <table className="w-full text-sm">
              <thead className="bg-bg-muted/40 text-left text-xs uppercase tracking-[0.12em] text-ink-dim">
                <tr>
                  <th className="py-2.5 pl-4 pr-3 font-semibold">Pool</th>
                  <th className="py-2.5 pr-4 text-right font-semibold">Stake delegated</th>
                </tr>
              </thead>
              <tbody>
                {poolHits.map((p) => (
                  <tr key={p.address} className="border-t border-ring">
                    <td className="py-2.5 pl-4 pr-3">
                      <Link
                        href={`/pools/${p.address}`}
                        className="text-ink hover:underline"
                      >
                        {p.name || fmt.truncAddr(p.address)}
                      </Link>
                    </td>
                    <td className="num py-2.5 pr-4 text-right text-ink-muted">
                      {fmt.sol(p.stake_sol)} SOL
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <footer className="mt-16 border-t border-ring pt-6 text-xs text-ink-dim">
        Ranked among {idx.rankable_count} of {idx.active_count} active validators ({idx.active_set_definition}).
        Methodology: <GdiLink>see formula</GdiLink>. Data refreshed every 30 min from{' '}
        <a
          href="https://stakewiz.com/"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-ring underline-offset-2 hover:text-ink"
        >
          Stakewiz
        </a>
        .
      </footer>
    </main>
  );
}
