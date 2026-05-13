import { ImageResponse } from 'next/og';
import { loadPoolLatest, loadLeaderboard } from '@/lib/data';
import { DEFAULT_TVL_FLOOR_SOL } from '@/lib/leaderboard-config';

// Auto-generated 1200×630 PNG that unfurls in Twitter/Discord/Slack/Telegram
// when someone shares a pool URL. Each pool gets its own card: name, rank,
// GDI (large), sub-scores (country/city/ASN), validator count, TVL.
//
// Dark theme to match the site's preferred default. Palette mirrors the
// --color-* tokens in globals.css's `html.dark` block — inlined because
// Satori can't read CSS variables.

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const revalidate = 60;
export const alt =
  'Per-pool decentralisation card — rank, GDI, validator count, and where stake actually sits.';

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

type Props = { params: Promise<{ address: string }> };

export default async function Image({ params }: Props) {
  const { address } = await params;
  const [data, leaderboard] = await Promise.all([
    loadPoolLatest(address),
    loadLeaderboard(),
  ]);

  // Fallback: pool not found / not yet ingested
  if (!data) {
    return new ImageResponse(
      (
        <div
          style={{
            width: '100%',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            background: `linear-gradient(135deg, ${C.bg} 0%, ${C.surface} 100%)`,
            color: C.ink,
            fontFamily: 'sans-serif',
            padding: 56,
          }}
        >
          <div style={{ display: 'flex', fontSize: 32, color: C.inkMuted }}>Pool not indexed</div>
          <div style={{ display: 'flex', marginTop: 16, fontSize: 20, color: C.inkDim, fontFamily: 'monospace' }}>
            {fmt.truncAddr(address)}
          </div>
          <div style={{ display: 'flex', marginTop: 32, fontSize: 18, color: C.inkMuted }}>
            gdindex.app
          </div>
        </div>
      ),
      { ...size, headers: { "cache-control": "public, max-age=1800, must-revalidate" } },
    );
  }

  const name = data.pool.name ?? fmt.truncAddr(data.pool.address);
  const baselineGdi = data.network_baseline?.gdi ?? null;
  const aboveBaseline =
    baselineGdi != null && data.score.gdi != null && data.score.gdi > baselineGdi;

  // Compute rank within the default UI view (pools >= DEFAULT_TVL_FLOOR_SOL,
  // sorted by GDI desc). This is what visitors actually see when they land
  // on gdindex.app — keeping the OG rank aligned avoids confusion ("but it
  // says #4 on the site and #7 on the card").
  //
  // If this pool's TVL is below the default floor, it doesn't appear in
  // that ranking at all; fall back to the per-pool rank from the published
  // JSON (computed across all scored pools) and label it accordingly.
  const filteredPools = (leaderboard?.pools ?? [])
    .filter((p) => p.gdi != null && (p.total_stake_sol ?? 0) >= DEFAULT_TVL_FLOOR_SOL)
    .sort((a, b) => (b.gdi ?? 0) - (a.gdi ?? 0));
  const filteredRank = filteredPools.findIndex((p) => p.pool_address === data.pool.address);
  const displayRank =
    filteredRank >= 0
      ? { n: filteredRank + 1, total: filteredPools.length, suffix: '' }
      : data.rank != null && data.total_ranked > 0
        ? { n: data.rank, total: data.total_ranked, suffix: ' (all)' }
        : null;

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

        {/* Top row: pool name (left) + rank chip (right) */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'flex-start',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', maxWidth: 800 }}>
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
              Solana Stake Pool
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 64,
                fontWeight: 700,
                letterSpacing: '-0.02em',
                lineHeight: 1.0,
                marginTop: 8,
              }}
            >
              {name}
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 18,
                color: C.inkDim,
                marginTop: 12,
                fontFamily: 'monospace',
              }}
            >
              {fmt.truncAddr(data.pool.address)}
            </div>
          </div>

          {displayRank && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-end',
              }}
            >
              <div
                style={{
                  display: 'flex',
                  fontSize: 14,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  color: C.inkDim,
                }}
              >
                Rank
              </div>
              <div
                style={{
                  display: 'flex',
                  fontSize: 56,
                  fontWeight: 700,
                  fontVariantNumeric: 'tabular-nums',
                  color: C.ink,
                  marginTop: 2,
                  lineHeight: 1,
                }}
              >
                #{displayRank.n}
              </div>
              <div
                style={{
                  display: 'flex',
                  fontSize: 16,
                  color: C.inkMuted,
                  marginTop: 6,
                }}
              >
                of {displayRank.total}{displayRank.suffix}
              </div>
            </div>
          )}
        </div>

        {/* Centre: huge GDI */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            marginTop: 20,
            padding: '20px 0',
            borderRadius: 16,
            border: `1px solid ${C.ring}`,
            background: C.surface,
          }}
        >
          <div
            style={{
              display: 'flex',
              fontSize: 12,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: C.inkDim,
            }}
          >
            Geographic Decentralisation Index
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-end',
              marginTop: 4,
            }}
          >
            <div
              style={{
                display: 'flex',
                fontSize: 104,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                lineHeight: 1,
                color: C.ink,
              }}
            >
              {fmt.num(data.score.gdi, 2)}
            </div>
          </div>
          {baselineGdi != null && (
            <div
              style={{
                display: 'flex',
                marginTop: 10,
                fontSize: 18,
                color: aboveBaseline ? C.accentGreen : C.inkMuted,
              }}
            >
              {aboveBaseline ? '↑' : '↓'} vs network baseline {fmt.num(baselineGdi, 2)}
            </div>
          )}
        </div>

        {/* Bottom row: sub-scores + meta */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 18,
            gap: 14,
          }}
        >
          {[
            { label: 'Country', value: data.score.dc_country },
            { label: 'City', value: data.score.dc_city },
            { label: 'ASN', value: data.score.dc_asn },
            { label: 'Validators', value: data.score.validator_count, integer: true },
            { label: 'Stake (SOL)', value: data.score.total_stake_sol, sol: true },
          ].map((s) => (
            <div
              key={s.label}
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
                  fontSize: 11,
                  letterSpacing: 2,
                  textTransform: 'uppercase',
                  color: C.inkDim,
                }}
              >
                {s.label}
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
                {s.sol
                  ? fmt.sol(s.value)
                  : s.integer
                    ? String(s.value ?? '—')
                    : fmt.num(s.value, 2)}
              </div>
            </div>
          ))}
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
            epoch {data.score.epoch} · gdi-{data.score.methodology_version.replace(/^gdi-/, '')}
          </div>
          <div style={{ display: 'flex', fontWeight: 600, color: C.ink }}>gdindex.app</div>
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": "public, max-age=1800, must-revalidate" } },
  );
}
