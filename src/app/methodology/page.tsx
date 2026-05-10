import Link from 'next/link';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Methodology',
  description:
    'Formula, data sources, limitations, and version history for the Solana Geographic Decentralisation Index.',
};

// Minimal placeholder. Will be filled with the live methodology version constant
// once src/lib/gdi/scoring.ts ships.
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
          The formula
        </h2>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          For each pool and each Solana epoch, with <code>pᵢ</code> = the
          fraction of pool stake delegated to validators in category <code>i</code>,
          we compute the stake-weighted effective number of categories on three
          axes — country, city, and autonomous system (ASN):
        </p>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-muted p-4 text-sm leading-relaxed">
{`eN_D  =  exp( -Σ pᵢ · ln(pᵢ) )                       D ∈ {country, city, ASN}

GDI   =  ( eN_country · eN_city · eN_ASN )^(1/3)     # composite score

NIS   =  Σ wᵥ · stakewiz_wiz_score(v)                # network impact, secondary`}
        </pre>
        <p className="mt-4 max-w-3xl text-sm leading-relaxed text-ink-muted">
          Geometric mean penalises being good on one dimension and poor on another
          — distinct risk classes. eN reads in plain English as &quot;the pool&apos;s stake
          is effectively distributed across X categories.&quot; A pool with all stake
          in one country has eN_country = 1; a pool with stake evenly split across
          ten countries has eN_country = 10.
        </p>
        <p className="mt-3 max-w-3xl text-sm leading-relaxed text-ink-muted">
          NIS captures whether a pool delegates to validators that improve the
          network as a whole, distinct from the pool&apos;s internal diversity. A
          pool can be internally diverse but still cluster in already-concentrated
          locations.
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
              <td className="py-2 pr-4">IP-derived country / city / ASN, plus wiz_score</td>
              <td className="py-2">Primary for location</td>
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
          Limitations (read these before quoting a score)
        </h2>
        <ul className="mt-3 space-y-2 text-sm leading-relaxed text-ink-muted">
          <li>
            <strong className="text-ink">IP-derived geography is imperfect.</strong>{' '}
            VPNs, anycast, and IPs registered to small countries (Andorra,
            British Virgin Islands, etc.) but physically hosted elsewhere can
            shift the country distribution by a few percent. This affects the
            absolute score but not the ranking between pools using the same data.
          </li>
          <li>
            <strong className="text-ink">Stake within an epoch is fixed.</strong>{' '}
            Solana stake delegations only activate at epoch boundaries, so
            per-epoch resolution is the natural cadence. Don&apos;t expect intra-epoch
            updates.
          </li>
          <li>
            <strong className="text-ink">Per-epoch numbers are noisy.</strong>{' '}
            Pool rebalancing causes legitimate single-epoch swings of several
            percent. The 5-epoch and 10-epoch rolling averages are the trustworthy
            signal.
          </li>
          <li>
            <strong className="text-ink">eN has a ceiling at the pool&apos;s validator count.</strong>{' '}
            A pool with 10 validators has eN_country ≤ 10, regardless of how
            different those validators are. Comparing pools of vastly different
            sizes by absolute eN can be misleading; the GDI composite somewhat
            normalises this but doesn&apos;t eliminate it.
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
