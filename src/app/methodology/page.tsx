import Link from 'next/link';
import type { Metadata } from 'next';
import { METHODOLOGY_VERSION } from '@/lib/gdi/scoring';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'Formula, data sources, limitations, and version history for the Geographic Decentralisation Index (GDI) used to rank Solana stake pools.',
};

export default function MethodologyPage() {
  return (
    <main className="container-narrow py-20 md:py-28">
      <Link href="/" className="drilldown text-sm text-ink-muted hover:text-ink">
        ← Back to leaderboard
      </Link>

      <header className="mt-8 max-w-3xl">
        <span className="pill">Methodology · {METHODOLOGY_VERSION}</span>
        <h1 className="mt-5 text-3xl font-semibold tracking-tight text-ink md:text-4xl">
          How the GDI is computed
        </h1>
        <p className="mt-4 text-base leading-relaxed text-ink-muted">
          The score is reproducible from on-chain data and a small set of public
          APIs. If you can&apos;t reproduce it from this page, that&apos;s a bug — please{' '}
          <a
            href="https://github.com/esterhuizen/sgdi/issues"
            className="drilldown hover:text-ink"
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
          The GDI deliberately excludes operator-quality composites
          (Stakewiz wiz_score, similar). Those metrics weight things like
          commission, which validators operating in remote regions often
          set higher to cover real cost differences — exactly the
          geographic decentralisation the index is designed to reward.
          Mixing quality and decentralisation into one number creates
          counter-incentives. Quality signals belong on their source
          (Stakewiz, Solana Compass); GDI&apos;s job is geographic spread.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Why three dimensions?
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          The obvious objection: country and city are correlated. If you know
          a validator is in Frankfurt, you know it&apos;s in Germany. So
          isn&apos;t the country dimension redundant once city is in the
          formula?
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Correlated, yes. Redundant, no. Consider a pool with five
          validators in LA, San Francisco, NYC, Chicago, and Dallas — five
          different US cities on five different ASNs. On a city-and-ASN-only
          composite that pool looks well-decentralised. With the country
          dimension included, the same pool scores poorly on country
          (effectively one bucket: <code>US</code>), and the geometric mean
          drags the composite down. That&apos;s the right answer:
          single-jurisdiction concentration is a real risk class, distinct
          from physical-location and network-operator risk.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          The three failure modes are independent:
        </p>
        <ul className="mt-2 ml-6 list-disc space-y-1 text-sm leading-relaxed text-ink-muted">
          <li>
            <strong className="text-ink">Country</strong> — regulatory action,
            sanctions, jurisdiction-specific rule changes (e.g. China&apos;s 2021
            crypto crackdown took ~50% of Bitcoin hashrate offline overnight).
          </li>
          <li>
            <strong className="text-ink">City</strong> — power outage,
            datacenter incident, regional fiber cut, weather event.
          </li>
          <li>
            <strong className="text-ink">ASN</strong> — cloud-provider outage,
            BGP misconfiguration, network-operator-level disruption.
          </li>
        </ul>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Geometric mean weights the three equally — no domain-expert opinion
          baked in about which risk class is most important. A pool concentrated
          on any single dimension gets pulled down by the geometric mean
          regardless of how diverse it looks on the other two. This is the
          intended behaviour: you don&apos;t want a pool with all stake on AWS
          (single-ASN failure mode) to claim a high score because its cities
          and countries are diverse.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          The active validator set (what counts as &quot;the network&quot;)
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Network shares are stake-weighted over Solana&apos;s{' '}
          <strong className="text-ink">actively-voting</strong> validator set:
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-muted p-4 text-sm leading-relaxed">
{`active = { v in Stakewiz : !v.delinquent AND v.activated_stake > 0 }`}
        </pre>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Roughly <strong className="text-ink">760 of ~1,955</strong>{' '}
          Stakewiz records at any given time. Delinquent or zero-stake
          validators still appear on chain (their stake is delegated, just
          not producing votes), but counting them in the denominator
          would inflate the network size and artificially lower rarity
          values for popular buckets. The active-set definition matches
          Solana&apos;s{' '}
          <code className="rounded bg-bg-muted px-1.5 py-0.5">getVoteAccounts.current</code>{' '}
          convention used by Stakewiz, Solana Beach, and other ecosystem
          tooling.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          The same definition gates the active-set rank shown on each
          validator&apos;s lookup page at{' '}
          <Link href="/validator" className="drilldown hover:text-ink">/validator</Link>.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Network baseline (reference value)
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Applying the same formula to the active validator set gives the{' '}
          <strong className="text-ink">network baseline GDI</strong> — by
          construction, the network&apos;s own stake-weighted average rarity.
          It&apos;s published at{' '}
          <code className="rounded bg-bg-muted px-1.5 py-0.5">/gdi/network-baseline.json</code>{' '}
          each epoch as a reference value. The leaderboard ranks pools by
          GDI directly (higher = more decentralised) rather than by
          deviation from the baseline; we found the rank-based framing
          easier to read than &quot;+X% vs baseline&quot;. The baseline is
          still useful as a single number for &quot;how decentralised is
          Solana right now overall?&quot;.
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
              <td className="py-2 pr-4">IP-derived country / city / ASN; activated stake</td>
              <td className="py-2">Primary for location + network shares</td>
            </tr>
            <tr className="border-b border-ring">
              <td className="py-2 pr-4 font-medium text-ink">Validators.app</td>
              <td className="py-2 pr-4">Cross-reference for validator metadata; software_client labels (Agave, AgaveBam, Frankendancer, JitoLabs, Firedancer, …)</td>
              <td className="py-2">Primary for client labels; fallback for location</td>
            </tr>
            <tr className="border-b border-ring">
              <td className="py-2 pr-4 font-medium text-ink">Jito BAM</td>
              <td className="py-2 pr-4">Block Assembly Marketplace connected-validator list (<code>is_bam</code> operational flag)</td>
              <td className="py-2">Authoritative (BAM public API)</td>
            </tr>
            <tr className="border-b border-ring">
              <td className="py-2 pr-4 font-medium text-ink">Jito IBRL</td>
              <td className="py-2 pr-4">Per-validator block-build quality score (0–100): non-vote packing, slot time, vote packing</td>
              <td className="py-2">Authoritative (Jito IBRL API)</td>
            </tr>
            <tr className="border-b border-ring">
              <td className="py-2 pr-4 font-medium text-ink">DoubleZero</td>
              <td className="py-2 pr-4">On-chain DZ User-account registrations (<code>is_dz</code> flag — shown but not scored)</td>
              <td className="py-2">Authoritative (on-chain)</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-medium text-ink">Jupiter</td>
              <td className="py-2 pr-4">LST mint → display name / symbol for newly discovered pools</td>
              <td className="py-2">Authoritative for naming</td>
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
          The GDI does <strong className="text-ink">not</strong> use these directly
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
            className="drilldown hover:text-ink"
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
            percent. The score we publish is the current epoch&apos;s value;
            multi-epoch rolling averages aren&apos;t computed yet (planned).
            Read trends across a few consecutive epochs of raw JSON for now.
          </li>
          <li>
            <strong className="text-ink">A pool with one validator in a rare
            place can score very high.</strong>{' '}
            The leaderboard surfaces validator-count alongside the score so
            small pools are visually distinct. We track the top-20 SPL stake
            pools by TVL; single-validator pools are excluded from the ranked
            leaderboard and surface separately as &quot;tracked but unscored&quot;.
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

      <section id="client-diversity" className="mt-12 scroll-mt-20">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Client diversity (CDI)
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Stake concentrated on a single validator client is a real network
          risk — a bug in that client can take down every validator running
          it. The Client Diversity Index (CDI) sits alongside GDI as
          a companion score on a different axis.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          For each pool we compute the stake-weighted distribution across
          known validator clients (Agave, AgaveBam, JitoLabs, Frankendancer,
          Firedancer, HarmonicAgave, Rakurai, …) and report the{' '}
          <em>effective number of clients</em> — the exponential of the
          Shannon entropy of that distribution. A pool with all stake on
          one client scores <code className="rounded bg-bg-muted px-1.5 py-0.5">1.0</code>;
          a perfectly even split across N clients scores N; real distributions
          land in between. The same metric is computed across the whole
          active validator set as a network baseline, so each pool can be
          read as &quot;above&quot; or &quot;below&quot; average.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          <strong className="text-ink">Trust model.</strong> Client labels
          come from{' '}
          <a
            href="https://www.validators.app/api-documentation"
            target="_blank"
            rel="noopener noreferrer"
            className="drilldown hover:text-ink"
          >
            validators.app
          </a>
          &apos;s curated <code className="rounded bg-bg-muted px-1.5 py-0.5">software_client</code>{' '}
          field. The <code>jito</code> flag is on-chain verifiable (validators
          participating in Jito&apos;s tip-distribution program are detectable
          from chain activity), but the finer distinctions between Frankendancer,
          Firedancer, HarmonicAgave etc. rely partly on operator self-attestation
          via the validators.app profile. We surface the labels as-is and
          flag the trust model here for transparency.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          <strong className="text-ink">Not folded into GDI.</strong> CDI is
          published as a separate score, not blended into the headline GDI.
          Historical GDI values remain valid under <code>gdi-1.0.0</code>;
          adding client diversity didn&apos;t reset that baseline. If we
          later decide to combine them into a unified Decentralisation
          Index, it will be a coordinated methodology bump with its own
          version, not a silent shift.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          <strong className="text-ink">DoubleZero is shown but not scored.</strong>{' '}
          DoubleZero is a dedicated fibre network for validators that provides
          faster voting and block production. Most active stake runs on it,
          and a pool that picks <em>non</em>-DZ validators effectively
          accepts slower performance — so the pool&apos;s &quot;lever&quot;
          there isn&apos;t symmetric with client choice. We report DZ
          participation on the pool detail page as an operator-quality
          signal but do not fold it into any decentralisation index.
          Network-level concentration on DZ infrastructure is a real risk
          worth tracking, but it lives outside the rarity-and-stake
          framework GDI/CDI use.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Version policy
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Current methodology version: <code className="rounded bg-bg-muted px-1.5 py-0.5">{METHODOLOGY_VERSION}</code>.
          Historical scores remain reproducible under their original version
          forever — each <code>pool_scores</code> row carries the version it
          was computed under, and a methodology bump only affects new epochs.
        </p>
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-ring text-left text-xs uppercase tracking-wider text-ink-dim">
              <th className="py-2 pr-4">Version</th>
              <th className="py-2 pr-4">Change</th>
              <th className="py-2">Effect</th>
            </tr>
          </thead>
          <tbody className="text-ink-muted">
            <tr className="border-b border-ring">
              <td className="py-2 pr-4 font-mono font-medium text-ink">gdi-1.0.0</td>
              <td className="py-2 pr-4">Initial methodology.</td>
              <td className="py-2">Network shares computed over { '{ stake > 0 }' } (~1,929 records).</td>
            </tr>
            <tr>
              <td className="py-2 pr-4 font-mono font-medium text-ink">gdi-1.1.0</td>
              <td className="py-2 pr-4">
                Tightened the network denominator to actively-voting
                validators only: <code>!delinquent &amp;&amp; stake &gt; 0</code>.
              </td>
              <td className="py-2">
                Smaller denominator (~760 instead of ~1,929) lifts rarity
                values uniformly; pool GDI rankings shift only slightly.
              </td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Disclosure
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          The maintainer of this index — Tielman (
          <a
            href="https://x.com/tielmane"
            target="_blank"
            rel="noopener noreferrer"
            className="drilldown hover:text-ink"
          >
            @tielmane
          </a>{' '}
          on X,{' '}
          <a
            href="https://t.me/realtielman"
            target="_blank"
            rel="noopener noreferrer"
            className="drilldown hover:text-ink"
          >
            @realtielman
          </a>{' '}
          on Telegram) — also operates the{' '}
          <a
            href="https://definity.finance"
            target="_blank"
            rel="noopener noreferrer"
            className="drilldown hover:text-ink"
          >
            Definity
          </a>{' '}
          stake pool, which appears in this leaderboard. Scoring is mechanical
          and reproducible from public data — there is no manual adjustment.
          Any pool&apos;s GDI can be recomputed from this page&apos;s
          formula plus the raw inputs published at{' '}
          <code className="rounded bg-bg-muted px-1.5 py-0.5">/gdi/*.json</code>.
          The maintainer cannot privilege any one pool without that privilege
          being visible in the code and the published JSON. The eventual aim
          is handoff to a fully neutral steward (Stakewiz, Solana Compass, or
          the Solana Foundation) once the project has a track record.
        </p>
      </section>
    </main>
  );
}
