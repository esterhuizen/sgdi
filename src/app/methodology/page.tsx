import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'Formula, data sources, limitations, and version history for the Solana Geographic Decentralisation Index.',
};

const METHODOLOGY_VERSION = 'sgdi-1.0.0';

export default function MethodologyPage() {
  return (
    <main className="container-narrow py-20 md:py-28">
      <Link href="/" className="text-sm text-ink-muted underline-offset-2 hover:underline">
        ← Back to leaderboard
      </Link>

      <header className="mt-8 max-w-3xl">
        <span className="pill">Methodology · {METHODOLOGY_VERSION}</span>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          How SGDI is computed
        </h1>
        <p className="mt-4 text-base leading-relaxed text-ink-muted">
          The score is reproducible from on-chain data and a small set of public
          APIs. If you can&apos;t reproduce it from this page, that&apos;s a bug — please{' '}
          <a
            href="https://github.com/esterhuizen/sgdi/issues"
            className="underline decoration-ring underline-offset-2 hover:text-ink"
            target="_blank"
            rel="noopener noreferrer"
          >
            file an issue
          </a>
          .
        </p>
      </header>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          What we&apos;re measuring
        </h2>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-ink-muted">
          A simple question: <strong className="text-ink">does this pool delegate to
          places that need stake, or does it pile more onto already-popular validators?</strong>
        </p>
        <p className="mt-3 max-w-3xl text-base leading-relaxed text-ink-muted">
          A pool whose stake sits in the same handful of overweight cities and ASNs
          as everyone else isn&apos;t improving network decentralisation, regardless of
          how internally diverse its own delegations look. A pool that finds
          underweight regions — Hong Kong, São Paulo, Manila, Lagos — is doing the
          actual work of decentralising the network.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          The formula
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          For each validator <code>v</code> in a pool with stake fraction <code>wᵥ</code>,
          we compute its <strong className="text-ink">rarity</strong> on three
          dimensions — country, city, and autonomous system number (ASN):
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-muted p-4 text-sm leading-relaxed">
{`rarity_D(v)  =  -ln( network_share_D(category of v) )       D ∈ {country, city, ASN}`}
        </pre>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          <code>network_share_D(category)</code> is the fraction of <em>total network
          stake</em> currently delegated to validators in that category. A
          validator in NYC (where ~8% of network stake sits) has a low rarity;
          a validator in Manila (~0.1%) has a high rarity.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          The pool&apos;s <strong className="text-ink">Decentralisation Contribution</strong>{' '}
          on each dimension is the stake-weighted average rarity of its validators:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-muted p-4 text-sm leading-relaxed">
{`DC_D  =  Σᵥ wᵥ · rarity_D(v)`}
        </pre>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          The composite GDI is the geometric mean of the three:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-muted p-4 text-sm leading-relaxed">
{`GDI  =  ( DC_country · DC_city · DC_asn )^(1/3)`}
        </pre>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Geometric mean penalises being good on one dimension and poor on
          another — these are distinct decentralisation risk classes. A pool
          that&apos;s geographically diverse but everyone&apos;s on AWS still has a
          single-ASN failure mode.
        </p>

        <p className="mt-6 max-w-3xl text-sm leading-relaxed text-ink-muted">
          A secondary signal, the <strong className="text-ink">Network Impact Score</strong>:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-muted p-4 text-sm leading-relaxed">
{`NIS  =  Σᵥ wᵥ · stakewiz_wiz_score(v)`}
        </pre>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Captures whether a pool delegates to validators that improve the
          network&apos;s overall health (as scored by Stakewiz). A pool can be
          geographically well-distributed but still delegate to under-performing
          validators; NIS surfaces that.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Network baseline — how to read it
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Applying the same formula to the entire active validator set gives
          the <strong className="text-ink">network baseline GDI</strong> — by
          construction, the network&apos;s own stake-weighted average rarity. A
          pool whose GDI is{' '}
          <strong className="text-ink">above the baseline</strong> is preferentially
          delegating to less-popular places than the network average — directly
          reducing concentration. A pool whose GDI is{' '}
          <strong className="text-ink">below the baseline</strong> is reinforcing
          already-popular spots — concentrating the network further.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          This is the metric&apos;s honest claim: it isolates which pools are
          contributing to decentralisation versus exacerbating concentration,
          regardless of size or yield.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Data sources
        </h2>
        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-ring text-left text-xs uppercase tracking-wider text-ink-dim">
              <th className="py-2 pr-4">Source</th>
              <th className="py-2 pr-4">Provides</th>
              <th className="py-2">Trust</th>
            </tr>
          </thead>
          <tbody className="text-ink-muted">
            <tr className="border-b border-ring">
              <td className="py-2 pr-4 font-medium text-ink">Helius RPC</td>
              <td className="py-2 pr-4">Pool → validator → stake mapping (current epoch)</td>
              <td className="py-2">Authoritative (on-chain)</td>
            </tr>
            <tr className="border-b border-ring">
              <td className="py-2 pr-4 font-medium text-ink">Stakewiz</td>
              <td className="py-2 pr-4">IP-derived country / city / ASN; activated stake; wiz_score</td>
              <td className="py-2">Primary for location + network shares</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-medium text-ink">Validators.app</td>
              <td className="py-2 pr-4">Cross-reference for validator metadata</td>
              <td className="py-2">Fallback / disagreement check</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Concentration: computed vs reported
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Stakewiz publishes its own per-validator{' '}
          <code>city_concentration</code> and <code>asn_concentration</code> fields.
          SGDI does <strong className="text-ink">not</strong> use these directly
          for scoring — instead, we compute network shares ourselves from the
          raw <code>activated_stake</code> + IP fields, so the math is fully
          reproducible from public inputs and we cover all three dimensions
          (country, city, ASN) the same way (Stakewiz doesn&apos;t expose a
          country-concentration field).
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          We <strong className="text-ink">do</strong> store Stakewiz&apos;s reported
          concentration values alongside our own computed shares as a sanity
          check. A side-by-side comparison for the top buckets is published at{' '}
          <code className="rounded bg-bg-muted px-1.5 py-0.5">/gdi/concentration-crosscheck.json</code>{' '}
          each ingest. Wide divergence between our numbers and Stakewiz&apos;s
          would be a red flag — if you spot one,{' '}
          <a
            href="https://github.com/esterhuizen/sgdi/issues"
            className="underline decoration-ring underline-offset-2 hover:text-ink"
            target="_blank"
            rel="noopener noreferrer"
          >
            file an issue
          </a>
          .
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Limitations (read these before quoting a score)
        </h2>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">
          <li>
            <strong className="text-ink">IP-derived geography is imperfect.</strong>{' '}
            Cloud-provider IPs occasionally place a chunk of stake in tiny
            countries (e.g. Andorra) that have no real node presence. This
            shifts absolute rarity numbers by a few percent but doesn&apos;t
            change pool rankings between pools using the same data.
          </li>
          <li>
            <strong className="text-ink">Stake within an epoch is fixed.</strong>{' '}
            Solana stake delegations only activate at epoch boundaries, so
            per-epoch resolution is the natural cadence. Don&apos;t expect
            intra-epoch updates.
          </li>
          <li>
            <strong className="text-ink">Per-epoch numbers are noisy.</strong>{' '}
            Pool rebalancing causes legitimate single-epoch swings of several
            percent. The 5-epoch and 10-epoch rolling averages are the
            trustworthy signal.
          </li>
          <li>
            <strong className="text-ink">A pool with one validator in a rare
            place can score very high.</strong>{' '}
            The leaderboard surfaces validator-count alongside the score so
            small pools are visually distinct, and we focus the leaderboard on
            top-25-by-TVL pools (which all have multiple validators).
          </li>
          <li>
            <strong className="text-ink">Placement coverage.</strong>{' '}
            Each pool&apos;s row reports the fraction of its stake we could
            place geographically (typically 100%; lower if a validator&apos;s
            metadata is unavailable from both Stakewiz and Validators.app).
            Stake we can&apos;t place is excluded from the rarity calculation
            so it neither helps nor hurts the pool&apos;s score.
          </li>
        </ul>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Version policy
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Methodology version: <code className="rounded bg-bg-muted px-1.5 py-0.5">{METHODOLOGY_VERSION}</code>.
          Historical scores remain reproducible under their original version
          forever; the leaderboard transparently flags any historical epoch
          computed under an older methodology version. See{' '}
          <a
            href="https://github.com/esterhuizen/sgdi/blob/main/CONTRIBUTING.md"
            target="_blank"
            rel="noopener noreferrer"
            className="underline decoration-ring underline-offset-2 hover:text-ink"
          >
            CONTRIBUTING.md
          </a>{' '}
          for the bump policy.
        </p>
      </section>
    </main>
  );
}
