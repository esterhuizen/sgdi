import { ImageResponse } from 'next/og';
import { loadValidatorIndex } from '@/lib/data';

// Auto-generated 1200×630 PNG for tweet/Slack/Discord unfurls of the
// /locations page. Renders the top-4 (country, city, ASN) tuples on
// DoubleZero by composite rarity. Mirrors the landing-page OG style.

export const runtime = 'nodejs';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';
// Render per-request: same reasoning as the landing OG. Build-time prerender
// can't see /var/lib/sgdi/published, ISR doesn't re-run for ImageResponse
// routes. CDN cache-control header below handles edge caching.
export const dynamic = 'force-dynamic';
export const alt =
  'Where to host for maximum stake — rare validator locations on DoubleZero, ranked by composite rarity.';

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
};

type TupleAgg = {
  key: string;
  country: string;
  city: string;
  asnName: string;
  composite: number;
  validatorCount: number;
  dzCount: number;
};

export default async function Image() {
  const idx = await loadValidatorIndex();
  const validators = idx?.validators ?? [];

  // Aggregate (country, city, ASN) tuples — same logic as the page server
  // component, just inline here to avoid pulling component code into the
  // edge-renderable handler. Filter to DZ-supported only (matching the
  // page's default), then sort by composite desc, take top 4.
  const tuples = new Map<string, TupleAgg>();
  for (const v of validators) {
    if (!v.country || !v.city || !v.asn) continue;
    const key = `${v.country}|${v.city}|${v.asn}`;
    let t = tuples.get(key);
    if (!t) {
      t = {
        key,
        country: v.country,
        city: v.city,
        asnName: v.asn_name || v.asn,
        composite: v.composite_rarity ?? 0,
        validatorCount: 0,
        dzCount: 0,
      };
      tuples.set(key, t);
    }
    t.validatorCount += 1;
    if (v.is_dz === true) t.dzCount += 1;
  }
  const dzTuples = [...tuples.values()].filter(
    (t) => t.dzCount > 0 &&
           t.country.toLowerCase() !== 'unknown' &&
           t.asnName.toLowerCase() !== 'unknown',
  );
  const sortedTuples = dzTuples.sort((a, b) => b.composite - a.composite).slice(0, 4);
  const totalDzTuples = dzTuples.length;

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
              fontSize: 18,
              fontWeight: 600,
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: C.inkDim,
            }}
          >
            For Solana validator operators
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
            Where to host for maximum stake
          </div>
          {idx ? (
            <div
              style={{
                display: 'flex',
                fontSize: 20,
                color: C.inkMuted,
                marginTop: 16,
              }}
            >
              Top 4 rarest locations on DoubleZero · epoch {idx.epoch} ·{' '}
              {totalDzTuples} DZ-supported tuples
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
              Location data arriving at the next epoch boundary.
            </div>
          )}
        </div>

        {/* Tuple table */}
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
            <div style={{ flex: 1, display: 'flex' }}>Location</div>
            <div style={{ width: 160, display: 'flex', justifyContent: 'flex-end' }}>Composite</div>
            <div style={{ width: 200, display: 'flex', justifyContent: 'flex-end' }}>Val · DZ</div>
          </div>

          {/* Rows */}
          {sortedTuples.map((t, i) => (
            <div
              key={t.key}
              style={{
                display: 'flex',
                padding: '14px 28px',
                borderTop: `1px solid ${C.ring}`,
                fontSize: 26,
                alignItems: 'center',
              }}
            >
              <div style={{ width: 60, display: 'flex', color: C.inkDim, fontWeight: 600 }}>
                {i + 1}
              </div>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
                <div style={{ display: 'flex', fontWeight: 600, color: C.ink }}>
                  {t.country} · {t.city}
                </div>
                <div
                  style={{
                    display: 'flex',
                    fontSize: 16,
                    color: C.inkDim,
                    marginTop: 2,
                  }}
                >
                  {t.asnName}
                </div>
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
                {fmt.num(t.composite, 2)}
              </div>
              <div
                style={{
                  width: 200,
                  display: 'flex',
                  justifyContent: 'flex-end',
                  color: C.inkMuted,
                  fontVariantNumeric: 'tabular-nums',
                }}
              >
                {t.validatorCount} · {t.dzCount} DZ
              </div>
            </div>
          ))}
          {sortedTuples.length === 0 && (
            <div
              style={{
                display: 'flex',
                padding: 32,
                fontSize: 22,
                color: C.inkDim,
                justifyContent: 'center',
              }}
            >
              No DZ-supported locations yet.
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
            Composite = ∛(country · city · ASN rarity)
          </div>
          <div style={{ display: 'flex', fontWeight: 600, color: C.ink }}>gdindex.app/locations</div>
        </div>
      </div>
    ),
    { ...size, headers: { "cache-control": "public, max-age=1800, must-revalidate" } },
  );
}
