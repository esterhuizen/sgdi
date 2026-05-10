// Hand-rolled SVG line chart for a pool's GDI history vs network baseline.
//
// No charting library — pure SVG. Two series:
//   - solid sunrise-coloured line: pool's GDI per epoch
//   - dashed grey line: network baseline GDI per epoch (overlay)
//
// Renders empty state if there's < 2 data points.

type Point = { epoch: number; value: number | null };

type Props = {
  poolSeries: Point[];
  baselineSeries: Point[];
  /** SVG width in CSS pixels. Default 720. Height auto-scales 720x240. */
  width?: number;
  height?: number;
};

const PAD_L = 44;
const PAD_R = 16;
const PAD_T = 16;
const PAD_B = 30;

export function TrendChart({ poolSeries, baselineSeries, width = 720, height = 240 }: Props) {
  // Filter out null values; we plot only valid points but keep the X mapping
  // by epoch so the two series align.
  const validPool = poolSeries.filter((p): p is { epoch: number; value: number } => p.value != null);
  const validBaseline = baselineSeries.filter(
    (p): p is { epoch: number; value: number } => p.value != null,
  );

  if (validPool.length < 2 && validBaseline.length < 2) {
    return (
      <div className="surface flex h-48 items-center justify-center p-6 text-sm text-ink-dim">
        Trend appears after at least two epochs of data are captured.
      </div>
    );
  }

  // Domain
  const allPts = [...validPool, ...validBaseline];
  const xMin = Math.min(...allPts.map((p) => p.epoch));
  const xMax = Math.max(...allPts.map((p) => p.epoch));
  const yMin = Math.min(...allPts.map((p) => p.value)) * 0.95;
  const yMax = Math.max(...allPts.map((p) => p.value)) * 1.05;
  const xRange = Math.max(1, xMax - xMin);
  const yRange = Math.max(1e-9, yMax - yMin);

  const innerW = width - PAD_L - PAD_R;
  const innerH = height - PAD_T - PAD_B;

  const xScale = (e: number) => PAD_L + ((e - xMin) / xRange) * innerW;
  const yScale = (v: number) => PAD_T + (1 - (v - yMin) / yRange) * innerH;

  const pathFor = (pts: { epoch: number; value: number }[]) =>
    pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${xScale(p.epoch).toFixed(1)},${yScale(p.value).toFixed(1)}`).join(' ');

  // Y-axis ticks: 4 evenly spaced
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + (yRange * i) / 4);

  // X-axis: 5 evenly spaced epochs (rounded to integers)
  const xTickCount = Math.min(5, Math.ceil(xRange) + 1);
  const xTicks =
    xTickCount === 1
      ? [xMin]
      : Array.from({ length: xTickCount }, (_, i) =>
          Math.round(xMin + (xRange * i) / (xTickCount - 1)),
        );

  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="block w-full">
      {/* Y gridlines + labels */}
      {yTicks.map((t, i) => {
        const y = yScale(t);
        return (
          <g key={`yt-${i}`}>
            <line
              x1={PAD_L}
              x2={width - PAD_R}
              y1={y}
              y2={y}
              stroke="#ecedf3"
              strokeWidth={1}
            />
            <text
              x={PAD_L - 6}
              y={y + 3}
              textAnchor="end"
              className="fill-ink-dim"
              style={{ font: '11px ui-sans-serif, system-ui, sans-serif' }}
            >
              {t.toFixed(2)}
            </text>
          </g>
        );
      })}

      {/* X-axis ticks */}
      {xTicks.map((e, i) => {
        const x = xScale(e);
        return (
          <g key={`xt-${i}`}>
            <line
              x1={x}
              x2={x}
              y1={height - PAD_B}
              y2={height - PAD_B + 4}
              stroke="#52566a"
              strokeWidth={1}
            />
            <text
              x={x}
              y={height - PAD_B + 18}
              textAnchor="middle"
              className="fill-ink-dim"
              style={{ font: '11px ui-sans-serif, system-ui, sans-serif' }}
            >
              {e}
            </text>
          </g>
        );
      })}

      {/* Network baseline line — dashed grey */}
      {validBaseline.length >= 2 && (
        <path
          d={pathFor(validBaseline)}
          fill="none"
          stroke="#52566a"
          strokeWidth={1.25}
          strokeDasharray="4 3"
        />
      )}

      {/* Pool series — solid sunrise-coloured (green→purple gradient) */}
      <defs>
        <linearGradient id="trend-gradient" x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="#14F195" />
          <stop offset="100%" stopColor="#9945FF" />
        </linearGradient>
      </defs>
      {validPool.length >= 2 && (
        <path
          d={pathFor(validPool)}
          fill="none"
          stroke="url(#trend-gradient)"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      )}

      {/* Pool data point dots (only if few enough to be visible) */}
      {validPool.length <= 30 &&
        validPool.map((p, i) => (
          <circle
            key={`pt-${i}`}
            cx={xScale(p.epoch)}
            cy={yScale(p.value)}
            r={2.5}
            fill="#9945FF"
          />
        ))}

      {/* Legend */}
      <g transform={`translate(${PAD_L + 4}, ${PAD_T + 4})`}>
        <line x1={0} x2={20} y1={6} y2={6} stroke="url(#trend-gradient)" strokeWidth={2} />
        <text x={26} y={9} className="fill-ink-muted" style={{ font: '11px ui-sans-serif, system-ui, sans-serif' }}>
          pool GDI
        </text>
        <line x1={120} x2={140} y1={6} y2={6} stroke="#52566a" strokeWidth={1.25} strokeDasharray="4 3" />
        <text x={146} y={9} className="fill-ink-muted" style={{ font: '11px ui-sans-serif, system-ui, sans-serif' }}>
          network baseline
        </text>
      </g>
    </svg>
  );
}
