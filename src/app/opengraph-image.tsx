import { ImageResponse } from 'next/og';
import { loadLeaderboard } from '@/lib/data';

// Auto-generated 1200×630 PNG for tweet/Slack/Discord unfurls.
// Renders the top-5 pools at the current epoch.
//
// Next.js's ImageResponse (powered by Satori) runs server-side; the JSX
// here is a simplified subset (no Tailwind, only inline CSS / flex).

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Re-render at most every 60s — matches the page revalidate.
export const revalidate = 60;
export const alt =
  'Solana Stake Pool Decentralisation Index — every pool ranked by where its stake actually lives.';

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

export default async function Image() {
  const data = await loadLeaderboard();
  const sortedPools =
    data?.pools
      ?.filter((p) => p.gdi != null)
      .sort((a, b) => (b.gdi ?? 0) - (a.gdi ?? 0))
      .slice(0, 5) ?? [];

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background:
            'linear-gradient(135deg, #ffffff 0%, #fafbff 50%, #f5f5fa 100%)',
          color: '#0d1014',
          fontFamily: 'sans-serif',
          padding: 56,
          position: 'relative',
        }}
      >
        {/* Solana-flavoured accent stripe at top */}
        <div
          style={{
            display: 'flex',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            background: 'linear-gradient(90deg, #14F195 0%, #9945FF 100%)',
          }}
        />

        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 52,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              maxWidth: 1050,
              lineHeight: 1.05,
            }}
          >
            Solana Stake Pool Decentralisation Index
          </div>
          {data ? (
            <div
              style={{
                display: 'flex',
                fontSize: 20,
                color: '#52566a',
                marginTop: 16,
              }}
            >
              Top 5 pools by GDI · epoch {data.epoch} · {sortedPools.length === 5 ? `${data.pools.length} pools tracked` : ''}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                fontSize: 20,
                color: '#52566a',
                marginTop: 16,
              }}
            >
              First leaderboard arriving at the next epoch boundary.
            </div>
          )}
        </div>

        {/* Pool table */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            marginTop: 36,
            border: '1px solid #ecedf3',
            borderRadius: 16,
            overflow: 'hidden',
          }}
        >
          {/* Column headers */}
          <div
            style={{
              display: 'flex',
              padding: '14px 28px',
              background: '#f7f7f9',
              fontSize: 14,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 1.2,
              color: '#52566a',
            }}
          >
            <div style={{ width: 60, display: 'flex' }}>#</div>
            <div style={{ flex: 1, display: 'flex' }}>Pool</div>
            <div
              style={{
                width: 160,
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              GDI
            </div>
            <div
              style={{
                width: 160,
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              Validators
            </div>
            <div
              style={{
                width: 180,
                display: 'flex',
                justifyContent: 'flex-end',
              }}
            >
              Stake
            </div>
          </div>

          {/* Rows */}
          {sortedPools.map((p, i) => {
            return (
              <div
                key={p.pool_address}
                style={{
                  display: 'flex',
                  padding: '18px 28px',
                  borderTop: '1px solid #f0f1f5',
                  fontSize: 28,
                  alignItems: 'center',
                }}
              >
                <div
                  style={{ width: 60, display: 'flex', color: '#8a8e9e', fontWeight: 600 }}
                >
                  {i + 1}
                </div>
                <div
                  style={{
                    flex: 1,
                    display: 'flex',
                    flexDirection: 'column',
                  }}
                >
                  <div style={{ display: 'flex', fontWeight: 600 }}>
                    {p.pool_name || fmt.truncAddr(p.pool_address)}
                  </div>
                  {p.pool_name && (
                    <div
                      style={{
                        display: 'flex',
                        fontSize: 16,
                        color: '#8a8e9e',
                        marginTop: 4,
                        fontFamily: 'monospace',
                      }}
                    >
                      {fmt.truncAddr(p.pool_address)}
                    </div>
                  )}
                </div>
                <div
                  style={{
                    width: 160,
                    display: 'flex',
                    justifyContent: 'flex-end',
                    fontVariantNumeric: 'tabular-nums',
                    fontWeight: 700,
                  }}
                >
                  {fmt.num(p.gdi, 2)}
                </div>
                <div
                  style={{
                    width: 160,
                    display: 'flex',
                    justifyContent: 'flex-end',
                    color: '#52566a',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {p.validator_count ?? '—'}
                </div>
                <div
                  style={{
                    width: 180,
                    display: 'flex',
                    justifyContent: 'flex-end',
                    color: '#52566a',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {fmt.sol(p.total_stake_sol)} SOL
                </div>
              </div>
            );
          })}
          {sortedPools.length === 0 && (
            <div
              style={{
                display: 'flex',
                padding: 32,
                fontSize: 22,
                color: '#8a8e9e',
                justifyContent: 'center',
              }}
            >
              Leaderboard data not yet generated.
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 'auto',
            paddingTop: 20,
            fontSize: 18,
            color: '#52566a',
          }}
        >
          <div style={{ display: 'flex' }}>
            Open methodology · reproducible · Apache-2.0
          </div>
          <div style={{ display: 'flex', fontWeight: 600, color: '#0d1014' }}>
            gdindex.app
          </div>
        </div>
      </div>
    ),
    {
      ...size,
    },
  );
}
