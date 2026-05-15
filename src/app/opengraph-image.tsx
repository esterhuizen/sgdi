import { ImageResponse } from 'next/og';
import { loadLeaderboard } from '@/lib/data';
import { DEFAULT_TVL_FLOOR_SOL } from '@/lib/leaderboard-config';

// Auto-generated 1200×630 PNG for tweet/Slack/Discord unfurls.
// Renders the top-5 pools at the current epoch.
//
// Dark theme to match the site's preferred default. Palette is borrowed
// from globals.css's `html.dark` block — kept inline because Satori can't
// read CSS variables.

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Re-render at most every 60s — matches the page revalidate.
export const revalidate = 60;
export const alt =
  'Solana Stake Pool Decentralisation Index — every pool ranked by where its stake actually lives.';

// Dark palette (mirrors --color-* in html.dark)
const C = {
  bg: '#0a0d12',
  bgMuted: '#141920',
  surface: '#12161d',
  ring: '#242a35',
  ink: '#e6edf3',
  inkMuted: '#8b949e',
  inkDim: '#6e7681',
  accentGreen: '#14F195',
  accentPurple: '#9945FF',
};

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
  // Mirror the site's default UI filter so the OG card and the live
  // leaderboard show the same pools at the same ranks. Without the
  // TVL floor we'd surface dust pools (e.g. xandSOL at 28k SOL) that
  // the site itself hides — confusing for anyone clicking through.
  const sortedPools =
    data?.pools
      ?.filter((p) => p.gdi != null && (p.total_stake_sol ?? 0) >= DEFAULT_TVL_FLOOR_SOL)
      .sort((a, b) => (b.gdi ?? 0) - (a.gdi ?? 0))
      .slice(0, 4) ?? [];
  const filteredCount = (data?.pools ?? []).filter(
    (p) => p.gdi != null && (p.total_stake_sol ?? 0) >= DEFAULT_TVL_FLOOR_SOL,
  ).length;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          background: `linear-gradient(135deg, ${C.bg} 0%, ${C.surface} 50%, ${C.bgMuted} 100%)`,
          color: C.ink,
          fontFamily: 'sans-serif',
          padding: 56,
          position: 'relative',
        }}
      >
        {/* Solana accent stripe at top */}
        <div
          style={{
            display: 'flex',
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            height: 6,
            background: `linear-gradient(90deg, ${C.accentGreen} 0%, ${C.accentPurple} 100%)`,
          }}
        />

        {/* Header */}
        <div style={{ display: 'flex', flexDirection: 'column' }}>
          <div
            style={{
              display: 'flex',
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: C.inkDim,
            }}
          >
            Solana Stake Pool
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 52,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              maxWidth: 1050,
              lineHeight: 1.05,
              marginTop: 6,
            }}
          >
            Geographic Decentralisation Index
          </div>
          {data ? (
            <div
              style={{
                display: 'flex',
                fontSize: 20,
                color: C.inkMuted,
                marginTop: 16,
              }}
            >
              Top 4 pools by GDI · epoch {data.epoch} ·{' '}
              {sortedPools.length === 4 ? `${filteredCount} pools tracked` : ''}
            </div>
          ) : (
            <div
              style={{
                display: 'flex',
                fontSize: 20,
                color: C.inkMuted,
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
            marginTop: 20,
            border: `1px solid ${C.ring}`,
            borderRadius: 16,
            overflow: 'hidden',
            background: C.surface,
          }}
        >
          {/* Column headers */}
          <div
            style={{
              display: 'flex',
              padding: '14px 28px',
              background: C.bgMuted,
              fontSize: 14,
              fontWeight: 600,
              textTransform: 'uppercase',
              letterSpacing: 1.2,
              color: C.inkDim,
            }}
          >
            <div style={{ width: 60, display: 'flex' }}>#</div>
            <div style={{ flex: 1, display: 'flex' }}>Pool</div>
            <div style={{ width: 160, display: 'flex', justifyContent: 'flex-end' }}>GDI</div>
            <div style={{ width: 160, display: 'flex', justifyContent: 'flex-end' }}>Validators</div>
            <div style={{ width: 180, display: 'flex', justifyContent: 'flex-end' }}>Stake</div>
          </div>

          {/* Rows */}
          {sortedPools.map((p, i) => (
            <div
              key={p.pool_address}
              style={{
                display: 'flex',
                padding: '14px 28px',
                borderTop: `1px solid ${C.ring}`,
                fontSize: 28,
                alignItems: 'center',
              }}
            >
              <div style={{ width: 60, display: 'flex', color: C.inkDim, fontWeight: 600 }}>
                {i + 1}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', fontWeight: 600, color: C.ink }}>
                  {p.pool_name || fmt.truncAddr(p.pool_address)}
                </div>
                {p.pool_name && (
                  <div
                    style={{
                      display: 'flex',
                      fontSize: 16,
                      color: C.inkDim,
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
                  color: C.inkMuted,
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
                  color: C.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {fmt.sol(p.total_stake_sol)} SOL
              </div>
            </div>
          ))}
          {sortedPools.length === 0 && (
            <div
              style={{
                display: 'flex',
                padding: 32,
                fontSize: 22,
                color: C.inkDim,
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
            color: C.inkMuted,
          }}
        >
          <div style={{ display: 'flex' }}>
            Open methodology · reproducible · Apache-2.0
          </div>
          <div style={{ display: 'flex', fontWeight: 600, color: C.ink }}>gdindex.app</div>
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": "public, max-age=1800, must-revalidate" } },
  );
}
