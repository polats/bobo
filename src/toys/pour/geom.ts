// Tube geometry: the interior is a convex polygon (straight walls over a round bottom) in the tube's
// local frame (origin at the bottom of the round, y up the axis). Liquid is the part of it below a
// world-horizontal line, so every volume question is "clip a convex polygon by a half-plane, take
// the area" — exact for any tilt, and cheap enough to bisect a few dozen times a frame.

const scratch = new Float64Array(256);

/** Area of { p in poly : p·n <= d } (Sutherland–Hodgman against one plane, then the shoelace formula). */
export function clipArea(poly: Float64Array, nx: number, ny: number, d: number) {
  const n = poly.length / 2;
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = poly[2 * i], ay = poly[2 * i + 1];
    const bx = poly[2 * j], by = poly[2 * j + 1];
    const da = ax * nx + ay * ny - d;
    const db = bx * nx + by * ny - d;
    if (da <= 0) {
      scratch[m++] = ax;
      scratch[m++] = ay;
    }
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      scratch[m++] = ax + (bx - ax) * t;
      scratch[m++] = ay + (by - ay) * t;
    }
  }
  let a = 0;
  const k = m / 2;
  for (let i = 0; i < k; i++) {
    const j = (i + 1) % k;
    a += scratch[2 * i] * scratch[2 * j + 1] - scratch[2 * j] * scratch[2 * i + 1];
  }
  return Math.abs(a) * 0.5;
}

export class TubeShape {
  readonly poly: Float64Array;
  /** Area of one unit of liquid (a unit is `unitH` tall where the walls are straight). */
  readonly unitArea: number;
  /** Interior height from the bottom of the round to the rim. */
  readonly h: number;
  private lo: number[] = [];

  constructor(readonly r: number, readonly unitH: number, readonly cap: number) {
    this.unitArea = 2 * r * unitH;
    const pts: number[] = [];
    // Build with a temporary tall rim, find where `cap` units reach, then leave half a unit of headroom.
    const build = (h: number) => {
      pts.length = 0;
      pts.push(r, h, -r, h);
      const seg = 12;
      for (let i = 0; i <= seg; i++) {
        const a = Math.PI + (i / seg) * Math.PI;
        pts.push(Math.cos(a) * r, r + Math.sin(a) * r);
      }
      return Float64Array.from(pts);
    };
    const tall = build(r + (cap + 2) * unitH);
    const full = levelFor(tall, 0, 1, cap * this.unitArea);
    this.h = full + unitH * 0.55;
    this.poly = build(this.h);
  }

  /** Surface offset d (along up-vector n) holding `area`, for a tube tilted by `ang` (CCW, radians). */
  surface(ang: number, area: number) {
    return levelFor(this.poly, Math.sin(ang), Math.cos(ang), area);
  }

  /** Most liquid (area) the tube holds at tilt `ang` before it runs over the lip on side `s`. */
  capacity(ang: number, s: number) {
    const nx = Math.sin(ang), ny = Math.cos(ang);
    return clipArea(this.poly, nx, ny, s * this.r * nx + this.h * ny);
  }

  /** Height of the lip on side `s` along the up-vector at tilt `ang`. */
  lipD(ang: number, s: number) {
    return s * this.r * Math.sin(ang) + this.h * Math.cos(ang);
  }

  /** Tilt magnitude at which `area` just reaches the lip when pouring over side s (tilt = -s·mag). */
  spillAngle(area: number, s: number, max = 2.4) {
    if (this.capacity(0, s) <= area) return 0;
    let a = 0, b = max;
    for (let i = 0; i < 22; i++) {
      const m = (a + b) / 2;
      if (this.capacity(-s * m, s) > area) a = m;
      else b = m;
    }
    return (a + b) / 2;
  }

  /** Upright surface height for `units` of liquid (cached per 1/64 unit for the hot path). */
  levelAt(units: number) {
    const q = Math.max(0, units) * 64;
    const i = Math.floor(q);
    const lo = this.lo;
    while (lo.length <= i + 1) lo.push(levelFor(this.poly, 0, 1, (lo.length / 64) * this.unitArea));
    return lo[i] + (lo[i + 1] - lo[i]) * (q - i);
  }
}

/** Bisect the offset d so that the polygon area under the plane equals `area`. */
export function levelFor(poly: Float64Array, nx: number, ny: number, area: number) {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < poly.length; i += 2) {
    const d = poly[i] * nx + poly[i + 1] * ny;
    lo = Math.min(lo, d);
    hi = Math.max(hi, d);
  }
  if (area <= 0) return lo;
  for (let i = 0; i < 24; i++) {
    const m = (lo + hi) / 2;
    if (clipArea(poly, nx, ny, m) < area) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}
