// Read the sim like a lab would: surface profiles of the grains in each bulb, the slope of the pile's
// flanks (angle of repose) and the depth of the dimple over the neck (the crater of funnel flow).
import type { Glass } from './glass';

const BIN = 0.0015;

/** Highest resting grain per x-bin, as height along `up` (glass y times up), within one bulb. */
function surface(glass: Glass, x: ArrayLike<number>, y: ArrayLike<number>, vx: ArrayLike<number>, vy: ArrayLike<number>, n: number, bulb: number, up: number) {
  const nb = Math.ceil((2 * 0.04) / BIN);
  const top = new Float64Array(nb).fill(-1);
  for (let i = 0; i < n; i++) {
    if (y[i] * bulb < 0.003) continue;
    // Only grains that are part of the bed, not the falling stream.
    if (vx[i] * vx[i] + vy[i] * vy[i] > 0.15 * 0.15) continue;
    const b = Math.floor((x[i] + 0.04) / BIN);
    if (b < 0 || b >= nb) continue;
    const h = y[i] * up + 0.1;
    if (h > top[b]) top[b] = h;
  }
  const out: { x: number; h: number; w: number }[] = [];
  for (let b = 0; b < nb; b++) {
    if (top[b] < 0) continue;
    const h = top[b] - 0.1;
    out.push({ x: (b + 0.5) * BIN - 0.04, h, w: glass.width(h * up) });
  }
  return out;
}

function fit(pts: { u: number; h: number }[]) {
  if (pts.length < 3) return NaN;
  let su = 0, sh = 0, suu = 0, suh = 0;
  for (const p of pts) {
    su += p.u;
    sh += p.h;
    suu += p.u * p.u;
    suh += p.u * p.h;
  }
  const k = pts.length;
  return (k * suh - su * sh) / (k * suu - su * su);
}

/** Angle of the pile's flanks in the receiving bulb (degrees), left and right. */
export function reposeAngle(glass: Glass, x: ArrayLike<number>, y: ArrayLike<number>, vx: ArrayLike<number>, vy: ArrayLike<number>, n: number, up: number, d: number) {
  const s = surface(glass, x, y, vx, vy, n, -up, up);
  if (s.length < 8) return { left: NaN, right: NaN, mean: NaN };
  let peak = s[0];
  for (const p of s) if (p.h > peak.h) peak = p;
  const side = (sgn: number) => {
    const pts: { u: number; h: number }[] = [];
    for (const p of s) {
      const u = (p.x - peak.x) * sgn;
      // Flank only: clear of the apex (where the stream lands) and of the glass.
      if (u < 2.5 * d || Math.abs(p.x) > p.w - 2.5 * d) continue;
      pts.push({ u, h: p.h });
    }
    return (Math.atan(-fit(pts)) * 180) / Math.PI;
  };
  const left = side(-1), right = side(1);
  const both = [left, right].filter((a) => Number.isFinite(a));
  return { left, right, mean: both.length ? both.reduce((a, b) => a + b, 0) / both.length : NaN, apex: peak.x };
}

/** Crater over the neck in the source bulb: depth (m) of the centre below the rim, and its flank angle. */
export function crater(glass: Glass, x: ArrayLike<number>, y: ArrayLike<number>, vx: ArrayLike<number>, vy: ArrayLike<number>, n: number, up: number, d: number) {
  const s = surface(glass, x, y, vx, vy, n, up, up);
  if (s.length < 8) return { depth: NaN, angle: NaN };
  let cen = 0, cn = 0, rim = 0, rn = 0;
  const pts: { u: number; h: number }[] = [];
  for (const p of s) {
    const f = Math.abs(p.x) / Math.max(p.w, 1e-4);
    if (Math.abs(p.x) < 1.6 * BIN) {
      cen += p.h;
      cn++;
    } else if (f > 0.55 && f < 0.85) {
      rim += p.h;
      rn++;
    }
    if (Math.abs(p.x) > 2 * d && f < 0.6) pts.push({ u: Math.abs(p.x), h: p.h });
  }
  if (!cn || !rn) return { depth: NaN, angle: NaN };
  return { depth: rim / rn - cen / cn, angle: (Math.atan(fit(pts)) * 180) / Math.PI };
}
