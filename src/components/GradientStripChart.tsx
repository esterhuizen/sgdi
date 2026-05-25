// Per-validator gradient strip chart for the pool detail page.
//
// Each validator is a dot on a 1D number-line; x = g (GDI gradient).
// Vertical line at g = 1.0. Dots above the line (g > 1) are validators
// where adding stake would raise the pool's GDI; below the line (g < 1)
// are validators where holding less stake would raise it.
//
// Dot size scales with stake (sqrt so big and tiny validators are both
// visible). Dot colour: green above 1, red below, neutral at ~1.
//
// Inline SVG, no external chart library — matches the pattern used on
// /impact and the validator location pages.

import type { PoolValidator } from '@/lib/data';

type Props = { validators: PoolValidator[] };

const C = {
  axis:     '#242a35',
  grid:     '#1a1f28',
  ink:      '#e6edf3',
  inkDim:   '#6e7681',
  inkMuted: '#8b949e',
  above:    '#14F195', // Solana green — adding here raises GDI
  below:    '#f97583', // soft red   — adding here lowers GDI
  neutral:  '#9ba3af',
  thresh:   '#9945FF', // Solana purple — the g=1 line
};

export function GradientStripChart({ validators }: Props) {
  const rows = validators
    .filter((v): v is PoolValidator & { g: number; stake_sol: number } =>
      v.g != null && Number.isFinite(v.g) && v.stake_sol > 0,
    );

  if (rows.length === 0) {
    return (
      <div className="text-xs text-ink-dim">
        Gradient data unavailable for this pool&apos;s current validators.
      </div>
    );
  }

  // X domain: pad symmetrically around [min, max] but always include 1.0.
  const gs = rows.map((r) => r.g);
  const lo = Math.min(0.5, Math.floor(Math.min(...gs) * 10) / 10);
  const hi = Math.max(1.5, Math.ceil(Math.max(...gs) * 10) / 10);

  const W = 880;
  const H = 110;
  const PAD = { top: 18, right: 24, bottom: 26, left: 24 };
  const innerW = W - PAD.left - PAD.right;
  const innerH = H - PAD.top - PAD.bottom;
  const xToPx = (g: number) => PAD.left + innerW * ((g - lo) / (hi - lo));
  const midY = PAD.top + innerH / 2;

  // Dot radius from stake — sqrt so a 30k validator isn't 30× a 1k one visually.
  const maxStake = Math.max(...rows.map((r) => r.stake_sol));
  const rFor = (stake: number) =>
    3 + 8 * Math.sqrt(Math.min(1, stake / maxStake));

  const colorFor = (g: number) => {
    if (g > 1.02) return C.above;
    if (g < 0.98) return C.below;
    return C.neutral;
  };

  // X ticks at 0.1 intervals; bold tick at 1.0 (the threshold).
  const ticks: number[] = [];
  for (let t = Math.round(lo * 10) / 10; t <= hi + 1e-9; t = +(t + 0.1).toFixed(2)) {
    ticks.push(+t.toFixed(2));
  }

  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="w-full" style={{ minWidth: '600px' }}>
      {/* Baseline */}
      <line x1={PAD.left} y1={midY} x2={W - PAD.right} y2={midY} stroke={C.axis} strokeWidth={1} />

      {/* x-axis ticks + labels */}
      {ticks.map((t) => {
        const isThresh = Math.abs(t - 1) < 1e-6;
        return (
          <g key={t}>
            <line
              x1={xToPx(t)}
              y1={midY - 4}
              x2={xToPx(t)}
              y2={midY + 4}
              stroke={isThresh ? C.thresh : C.axis}
              strokeWidth={isThresh ? 1.5 : 1}
            />
            <text
              x={xToPx(t)}
              y={midY + 18}
              textAnchor="middle"
              fontSize="10"
              fill={isThresh ? C.thresh : C.inkDim}
              fontWeight={isThresh ? 600 : 400}
            >
              {t.toFixed(1)}
            </text>
          </g>
        );
      })}

      {/* g = 1 threshold line (vertical) */}
      <line
        x1={xToPx(1)}
        y1={PAD.top}
        x2={xToPx(1)}
        y2={H - PAD.bottom}
        stroke={C.thresh}
        strokeWidth={1.5}
        strokeDasharray="3 3"
        opacity={0.7}
      />
      <text x={xToPx(1) + 6} y={PAD.top + 4} fontSize="10" fill={C.thresh} fontWeight={600}>
        g = 1
      </text>

      {/* Dots */}
      {rows.map((r) => (
        <circle
          key={r.pubkey}
          cx={xToPx(Math.max(lo, Math.min(hi, r.g)))}
          cy={midY}
          r={rFor(r.stake_sol)}
          fill={colorFor(r.g)}
          fillOpacity={0.65}
          stroke={colorFor(r.g)}
          strokeWidth={1}
        >
          <title>{`g = ${r.g.toFixed(3)} · ${(r.stake_sol).toFixed(0)} SOL · ${r.country ?? '?'}/${r.city ?? '?'}/${r.asn ?? '?'}`}</title>
        </circle>
      ))}
    </svg>
  );
}
