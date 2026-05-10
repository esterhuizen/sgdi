import Link from 'next/link';

// Placeholder landing page until the ingest pipeline lands and we have data
// to render. The real implementation is in subsequent commits and reads from
// /public/gdi/leaderboard-latest.json.

export default function HomePage() {
  return (
    <main className="container-narrow py-20 md:py-28">
      <header className="max-w-2xl">
        <span className="pill">SGDI · Solana Geographic Decentralisation Index</span>
        <h1 className="mt-5 text-4xl font-semibold tracking-tight text-ink md:text-5xl">
          Where Solana stake actually lives.
        </h1>
        <p className="mt-5 text-lg leading-relaxed text-ink-muted">
          A per-epoch leaderboard ranking Solana stake pools by stake-weighted
          geographic decentralisation. Open methodology, reproducible from
          on-chain data and a small set of public APIs.
        </p>
        <p className="mt-3 text-sm text-ink-dim">
          Coming soon. The ingest pipeline is being assembled — first leaderboard
          will publish once the next epoch boundary is observed.
        </p>
      </header>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          The metric
        </h2>
        <pre className="mt-3 overflow-x-auto rounded-lg bg-bg-muted p-4 text-sm leading-relaxed text-ink">
{`eN_D  =  exp( -Σ pᵢ · ln(pᵢ) )       per dimension D ∈ {country, city, ASN}
GDI   =  ( eN_country · eN_city · eN_ASN )^(1/3)
NIS   =  Σ wᵥ · stakewiz_wiz_score(v)`}
        </pre>
        <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-muted">
          eN is the effective number of categories the pool&apos;s stake is spread
          across. Geometric mean of the three penalises being good on one
          dimension and poor on another. NIS captures whether a pool delegates
          to validators that improve the network as a whole.
        </p>
      </section>

      <section className="mt-12">
        <h2 className="text-sm font-semibold uppercase tracking-[0.18em] text-ink-dim">
          Links
        </h2>
        <ul className="mt-3 space-y-2 text-sm">
          <li>
            <Link
              href="/methodology"
              className="text-ink underline decoration-ring underline-offset-4 hover:decoration-ink"
            >
              Methodology
            </Link>{' '}
            <span className="text-ink-dim">— formula, sources, limitations, version policy</span>
          </li>
          <li>
            <a
              href="https://github.com/esterhuizen/sgdi"
              target="_blank"
              rel="noopener noreferrer"
              className="text-ink underline decoration-ring underline-offset-4 hover:decoration-ink"
            >
              GitHub
            </a>{' '}
            <span className="text-ink-dim">— source, methodology, contributing guide</span>
          </li>
        </ul>
      </section>

      <footer className="mt-20 border-t border-ring pt-6 text-xs text-ink-dim">
        Built and maintained by{' '}
        <a
          href="https://definity.finance"
          target="_blank"
          rel="noopener noreferrer"
          className="underline decoration-ring underline-offset-2 hover:text-ink"
        >
          Definity
        </a>{' '}
        — open methodology, Apache-2.0 licensed, reproducible from public data.
      </footer>
    </main>
  );
}
