import { ImageResponse } from 'next/og';
import { loadLeaderboard } from '@/lib/data';

// 1200×630 OG card for /clients — the v4 rollout dashboard.
// Hero: % of network stake on v4. Below: per-bucket breakdown of the
// four v4 buckets. Built to land on crypto-Twitter; the hero number is
// the only thing readable on small previews.

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const revalidate = 60;
export const alt =
  'Solana v4 client rollout — % of network stake on Agave 4 / Firedancer 0.909.40001+.';

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
  success: '#14F195',
};

const fmt = {
  sol: (v: number) => {
    if (v >= 1_000_000) return `${(v / 1_000_000).toFixed(1)}M`;
    if (v >= 10_000) return `${(v / 1_000).toFixed(0)}k`;
    if (v >= 1_000) return `${(v / 1_000).toFixed(1)}k`;
    return v.toFixed(0);
  },
};

function vN(label: string): number | null {
  const m = /\sv(\d+)$/.exec(label);
  return m ? parseInt(m[1], 10) : null;
}

export default async function Image() {
  const data = await loadLeaderboard();
  const network = data?.network_client_distribution;
  const buckets = network?.by_client ?? [];
  const totalStake = buckets.reduce((s, b) => s + b.stake_sol, 0);
  const v4Buckets = buckets.filter((b) => (vN(b.client) ?? 0) >= 4);
  const v4Stake = v4Buckets.reduce((s, b) => s + b.stake_sol, 0);
  const v4Validators = v4Buckets.reduce((s, b) => s + b.validator_count, 0);
  const v4SharePct = totalStake > 0 ? (v4Stake / totalStake) * 100 : 0;

  // Sort v4 buckets by stake desc for the breakdown row.
  const v4Sorted = v4Buckets.slice().sort((a, b) => b.stake_sol - a.stake_sol);

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
        {/* Solana accent stripe */}
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
              fontSize: 16,
              fontWeight: 600,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: C.inkDim,
            }}
          >
            Solana network rollout tracker
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 48,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              lineHeight: 1.0,
              marginTop: 10,
            }}
          >
            Validator client v4 adoption
          </div>
        </div>

        {/* Hero: huge % */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 28,
            padding: '24px 0',
            borderRadius: 16,
            border: `1px solid ${C.ring}`,
            background: C.surface,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 14,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: C.inkDim,
            }}
          >
            Network stake on v4
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              marginTop: 4,
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 168,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
                color: C.success,
                letterSpacing: '-0.04em',
              }}
            >
              {v4SharePct.toFixed(0)}
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 80,
                fontWeight: 700,
                lineHeight: 1,
                color: C.success,
                marginLeft: 4,
              }}
            >
              %
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 14,
              fontSize: 22,
              color: C.inkMuted,
            }}
          >
            {fmt.sol(v4Stake)} SOL on {v4Validators} validators · Agave 4 / Firedancer 0.909.40001+
          </div>
        </div>

        {/* Per-bucket row */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 20,
            gap: 12,
          }}
        >
          {v4Sorted.slice(0, 4).map((b) => {
            const sharePct = totalStake > 0 ? (b.stake_sol / totalStake) * 100 : 0;
            return (
              <div
                key={b.client}
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  flex: 1,
                  padding: '14px 0',
                  borderRadius: 12,
                  border: `1px solid ${C.ring}`,
                  background: C.surface,
                }}
              >
                <div
                  style={{
                    display: 'flex',
                    fontSize: 14,
                    letterSpacing: 1,
                    color: C.inkMuted,
                    fontWeight: 600,
                  }}
                >
                  {b.client}
                </div>
                <div
                  style={{
                    display: 'flex',
                    fontSize: 30,
                    fontWeight: 700,
                    fontVariantNumeric: 'tabular-nums',
                    marginTop: 4,
                    color: C.ink,
                  }}
                >
                  {sharePct.toFixed(1)}%
                </div>
                <div
                  style={{
                    display: 'flex',
                    fontSize: 12,
                    color: C.inkDim,
                    marginTop: 2,
                  }}
                >
                  {b.validator_count} validators
                </div>
              </div>
            );
          })}
        </div>

        {/* Footer */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginTop: 'auto',
            paddingTop: 18,
            fontSize: 18,
            color: C.inkMuted,
          }}
        >
          <div style={{ display: 'flex' }}>
            epoch {data?.epoch ?? '—'} · live, on-chain
          </div>
          <div style={{ display: 'flex', fontWeight: 600, color: C.ink }}>
            gdindex.app/clients
          </div>
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": "public, max-age=1800, must-revalidate" } },
  );
}
