import { ImageResponse } from 'next/og';
import { loadLeaderboard, loadLeaderboardForEpoch } from '@/lib/data';

// 1200×630 OG card for /impact — per-pool GDI trajectories since launch.
// Hero: cohort breadth (X of N pools improved >3%). Supporting row: avg
// gain across movers, largest single move, observation window. Mirrors
// the /clients OG card style.

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
export const dynamic = 'force-dynamic';
export const alt =
  'Improvements in GDI since launch — per-pool GDI trajectories across the top-15 Solana stake pools.';

const FIRST_EPOCH = 969;

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
  pct: (v: number) => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`,
};

export default async function Image() {
  const latest = await loadLeaderboard();
  const firstBoard = await loadLeaderboardForEpoch(FIRST_EPOCH);
  const lastEpoch = latest?.epoch ?? FIRST_EPOCH;

  // Current top-15 (≥100k SOL TVL, matches the page).
  const top15 = (latest?.pools ?? [])
    .filter((p) => p.gdi != null && (p.total_stake_sol ?? 0) >= 100_000)
    .sort((a, b) => (b.gdi ?? 0) - (a.gdi ?? 0))
    .slice(0, 15);

  // Compute Δ for each pool: latest GDI vs first observation (FIRST_EPOCH if
  // present, else the pool's current value — yields delta 0 and gets bucketed
  // flat, which is the right behaviour for pools too new to score the delta).
  type Row = { name: string; delta: number };
  const rows: Row[] = top15.map((p) => {
    const firstMatch = firstBoard?.pools?.find((x) => x.pool_address === p.pool_address);
    const firstGdi = firstMatch?.gdi ?? p.gdi!;
    const gdiNow = p.gdi!;
    const delta = firstGdi > 0 ? (gdiNow - firstGdi) / firstGdi : 0;
    return { name: p.pool_name ?? p.pool_address.slice(0, 8) + '…', delta };
  });
  rows.sort((a, b) => b.delta - a.delta);

  const movers3 = rows.filter((r) => r.delta >= 0.03).length;
  const moverAvg =
    movers3 > 0
      ? rows.filter((r) => r.delta >= 0.03).reduce((a, r) => a + r.delta, 0) / movers3
      : 0;
  const top = rows[0] ?? { name: '—', delta: 0 };
  const sinceDays = Math.max(1, (lastEpoch - FIRST_EPOCH + 1) * 2); // ~2-day epochs

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
            GDI · per-pool trajectory
          </div>
          <div
            style={{
              display: 'flex',
              fontSize: 52,
              fontWeight: 700,
              letterSpacing: '-0.02em',
              lineHeight: 1.0,
              marginTop: 10,
            }}
          >
            Improvements in GDI since launch
          </div>
        </div>

        {/* Hero: cohort breadth */}
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            marginTop: 24,
            padding: '20px 0',
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
            Top-15 pools with GDI gain &gt;3%
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
              {movers3}
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 80,
                fontWeight: 700,
                lineHeight: 1,
                color: C.inkMuted,
                marginLeft: 12,
              }}
            >
              / {rows.length}
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 12,
              fontSize: 22,
              color: C.inkMuted,
            }}
          >
            {sinceDays} days, {lastEpoch - FIRST_EPOCH + 1} epochs · stake redistribution toward rarer locations
          </div>
        </div>

        {/* Supporting stats row */}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: 18,
            gap: 12,
          }}
        >
          {/* Avg gain across movers */}
          <div
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
                fontSize: 12,
                letterSpacing: 1,
                color: C.inkDim,
                fontWeight: 600,
                textTransform: 'uppercase',
              }}
            >
              Avg gain (movers)
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 34,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                marginTop: 4,
                color: C.success,
              }}
            >
              {fmt.pct(moverAvg)}
            </div>
          </div>

          {/* Largest single move */}
          <div
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
                fontSize: 12,
                letterSpacing: 1,
                color: C.inkDim,
                fontWeight: 600,
                textTransform: 'uppercase',
              }}
            >
              Largest move
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 34,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                marginTop: 4,
                color: C.success,
              }}
            >
              {fmt.pct(top.delta)}
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 13,
                color: C.inkDim,
                marginTop: 2,
              }}
            >
              {top.name}
            </div>
          </div>

          {/* Observation window */}
          <div
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
                fontSize: 12,
                letterSpacing: 1,
                color: C.inkDim,
                fontWeight: 600,
                textTransform: 'uppercase',
              }}
            >
              Window
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 34,
                fontWeight: 700,
                fontVariantNumeric: 'tabular-nums',
                marginTop: 4,
                color: C.ink,
              }}
            >
              {sinceDays}d
            </div>
            <div
              style={{
                display: 'flex',
                fontSize: 13,
                color: C.inkDim,
                marginTop: 2,
              }}
            >
              epochs {FIRST_EPOCH}→{lastEpoch}
            </div>
          </div>
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
            epoch {lastEpoch} · live, on-chain
          </div>
          <div style={{ display: 'flex', fontWeight: 600, color: C.ink }}>
            gdindex.app/impact
          </div>
        </div>
      </div>
    ),
    { ...size, headers: { 'cache-control': 'public, max-age=1800, must-revalidate' } },
  );
}
