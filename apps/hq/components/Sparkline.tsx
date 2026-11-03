/** One metric over time: a single line, the latest value and its change. Nothing to hover; the numbers are beside it. */
export function Sparkline({ points, color, width = 220, height = 48 }: { points: { at: string; value: number }[]; color: string; width?: number; height?: number }) {
  if (points.length < 2) {
    return <svg width={width} height={height} role="img" aria-label="Not enough data for a trend yet"><line x1={0} x2={width} y1={height - 1} y2={height - 1} stroke="rgba(124,196,255,0.25)" /></svg>;
  }
  const vals = points.map((p) => p.value);
  const min = Math.min(...vals), max = Math.max(...vals);
  const span = max - min || 1;
  const pad = 4;
  const x = (i: number) => pad + (i / (points.length - 1)) * (width - pad * 2);
  const y = (v: number) => height - pad - ((v - min) / span) * (height - pad * 2);
  const d = points.map((p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join("");
  const last = points[points.length - 1]!;
  return (
    <svg width={width} height={height} role="img" aria-label={`${points.length} readings, from ${vals[0]} to ${last.value}`}>
      <path d={d} fill="none" stroke={color} strokeWidth={1.8} strokeLinejoin="round" strokeLinecap="round" style={{ filter: `drop-shadow(0 0 4px ${color})` }} />
      <circle cx={x(points.length - 1)} cy={y(last.value)} r={3} fill={color} />
    </svg>
  );
}

export function fmtMetric(v: number | undefined, unit?: "$" | "%" | "n" | "h"): string {
  if (v === undefined || Number.isNaN(v)) return "—";
  const n = Math.abs(v) >= 1000 ? v.toLocaleString("en-US", { maximumFractionDigits: 0 }) : v.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return unit === "$" ? `$${n}` : unit === "%" ? `${n}%` : unit === "h" ? `${n}h` : n;
}
