/** Joi's skyline stand-in: a CSS city until Higgsfield renders the real animated one. */
const FAR = [38, 55, 44, 70, 52, 90, 60, 48, 75, 42, 66, 50, 80, 45, 58, 72, 40, 62];
const NEAR = [60, 110, 80, 150, 95, 200, 120, 90, 170, 75, 140, 100, 230, 85, 130, 160];

export function Skyline({ dim }: { dim?: boolean }) {
  return (
    <div className="skyline" aria-hidden="true" style={dim ? { opacity: 0.55 } : undefined}>
      <div className="row far">{FAR.map((h, i) => <div key={i} className="b" style={{ height: `${h}%`, animationDelay: `${(i * 0.7) % 7}s` }} />)}</div>
      <div className="row">{NEAR.map((h, i) => <div key={i} className="b" style={{ height: `${h / 2.6}%`, animationDelay: `${(i * 1.1) % 7}s` }} />)}</div>
      <div className="haze" />
    </div>
  );
}
