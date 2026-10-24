export const LOBES = 6;

/** Closed smooth curve with six rounded lobes, as an SVG path string in a 0..100 box. */
export function lobePath(amp = 0.08, phase = 0, samples = 36): string {
  const cx = 50, cy = 50, base = 38;
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < samples; i++) {
    const a = (i / samples) * Math.PI * 2;
    const r = base * (1 + amp * Math.cos(LOBES * a + phase)) * (1 - amp * 0.6);
    pts.push([cx + r * Math.cos(a - Math.PI / 2), cy + r * Math.sin(a - Math.PI / 2)]);
  }
  const f = (n: number) => n.toFixed(2);
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 0; i < samples; i++) {
    const p0 = pts[(i - 1 + samples) % samples], p1 = pts[i], p2 = pts[(i + 1) % samples], p3 = pts[(i + 2) % samples];
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
  }
  return d + "Z";
}

export const LOBE_STATIC_PATH = lobePath(0.16, 0, 36);

