// The glass: an hourglass cavity in its own frame (metres, y up, origin at the centre of the neck).
// The profile is two cones meeting at a short straight neck, rounding into domed bulbs. Collisions
// and rendering both read one signed-distance grid (negative inside the cavity), so the glass you see
// is exactly the wall the grains hit.

/** Inner half-height of each bulb, neck centre to dome top (m). */
export const HB = 0.072;
/** Inner radius of a bulb (m). */
export const R = 0.033;
/** Half-length of the straight part of the neck (m). */
export const NECK_L = 0.0015;
/** Glass wall thickness (m), for the render only. */
export const WALL = 0.0022;
/** Cone slope near the neck: |dx/dy|. 0.8 puts the wall ~51° above horizontal, steeper than any medium's
 *  angle of repose, so the bulb drains fully. */
export const CONE = { slope: 0.8 };
const DOME = 0.02;
/** SDF grid: cell size and padding around the cavity (m). */
export const CELL = 0.0004;
const PAD = 0.006;

export class Glass {
  /** Neck width D (m). */
  neck: number;
  readonly nx: number;
  readonly ny: number;
  readonly x0 = -R - PAD;
  readonly y0 = -HB - PAD;
  readonly sdf: Float32Array;
  /** Cavity area of one bulb (m²). */
  bulbArea = 0;
  version = 0;

  constructor(neck: number) {
    this.neck = neck;
    this.nx = Math.ceil((2 * (R + PAD)) / CELL) + 1;
    this.ny = Math.ceil((2 * (HB + PAD)) / CELL) + 1;
    this.sdf = new Float32Array(this.nx * this.ny);
    this.build();
  }

  setNeck(neck: number) {
    if (Math.abs(neck - this.neck) < 1e-7) return;
    this.neck = neck;
    this.build();
  }

  /** Inner half-width at height y. */
  width(y: number) {
    const a = this.neck / 2;
    const s = Math.abs(y);
    if (s >= HB) return 0;
    const c = a + Math.max(0, s - NECK_L) * CONE.slope;
    // Smooth min of the cone and the bulb radius rounds the shoulder.
    const k = 0.014;
    const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (R - c)) / k));
    let w = R * (1 - h) + c * h - k * h * (1 - h);
    const d0 = HB - DOME;
    if (s > d0) w *= Math.sqrt(Math.max(0, 1 - ((s - d0) / DOME) ** 2));
    return w;
  }

  private build() {
    // Right-hand profile polyline by arc length, bucketed by y so each cell checks only nearby segments.
    const pts: number[] = [];
    let y = -HB;
    pts.push(0, -HB);
    while (y < HB) {
      // Step so consecutive points are ~0.3 mm apart along the curve.
      const e = 1e-4, dw = (this.width(Math.min(HB, y + e)) - this.width(Math.max(-HB, y - e))) / (2 * e);
      y += Math.max(2e-6, 0.0003 / Math.sqrt(1 + dw * dw));
      pts.push(this.width(Math.min(y, HB)), Math.min(y, HB));
    }
    const nSeg = pts.length / 2 - 1;
    const BIN = 0.002, band = 0.005;
    const nb = Math.ceil((2 * (HB + PAD)) / BIN) + 1;
    const bins: number[][] = Array.from({ length: nb }, () => []);
    for (let s = 0; s < nSeg; s++) {
      const ya = pts[2 * s + 1], yb = pts[2 * s + 3];
      const lo = Math.floor((Math.min(ya, yb) - this.y0) / BIN), hi = Math.floor((Math.max(ya, yb) - this.y0) / BIN);
      for (let b = Math.max(0, lo); b <= Math.min(nb - 1, hi); b++) bins[b].push(s);
    }
    const { nx, ny, sdf } = this;
    const reach = Math.ceil(band / BIN);
    for (let j = 0; j < ny; j++) {
      const py = this.y0 + j * CELL;
      const bj = Math.floor((py - this.y0) / BIN);
      const cand: number[] = [];
      for (let b = Math.max(0, bj - reach); b <= Math.min(nb - 1, bj + reach); b++) for (const s of bins[b]) cand.push(s);
      const w = this.width(py);
      const inside = Math.abs(py) < HB;
      for (let i = 0; i < nx; i++) {
        const px = Math.abs(this.x0 + i * CELL);
        let best = band * band;
        for (const s of cand) {
          const ax = pts[2 * s], ay = pts[2 * s + 1], bx = pts[2 * s + 2], by = pts[2 * s + 3];
          const ex = bx - ax, ey = by - ay;
          const l2 = ex * ex + ey * ey || 1e-12;
          const t = Math.max(0, Math.min(1, ((px - ax) * ex + (py - ay) * ey) / l2));
          const dx = px - ax - t * ex, dy = py - ay - t * ey;
          const d2 = dx * dx + dy * dy;
          if (d2 < best) best = d2;
        }
        const d = Math.sqrt(best);
        sdf[j * nx + i] = inside && px < w ? -d : d;
      }
    }
    let area = 0;
    for (let k = 0; k < 2000; k++) area += 2 * this.width(((k + 0.5) / 2000) * HB) * (HB / 2000);
    this.bulbArea = area;
    this.version++;
  }

  /** Signed distance (m, negative inside) and outward normal at (x, y), bilinear. */
  sample(x: number, y: number, out: Float32Array) {
    const { nx, ny, sdf } = this;
    let fx = (x - this.x0) / CELL, fy = (y - this.y0) / CELL;
    fx = Math.max(0, Math.min(nx - 1.001, fx));
    fy = Math.max(0, Math.min(ny - 1.001, fy));
    const i = fx | 0, j = fy | 0, tx = fx - i, ty = fy - j;
    const k = j * nx + i;
    const a = sdf[k], b = sdf[k + 1], c = sdf[k + nx], d = sdf[k + nx + 1];
    out[0] = a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
    let gx = (b - a) * (1 - ty) + (d - c) * ty;
    let gy = (c - a) * (1 - tx) + (d - b) * tx;
    const l = Math.hypot(gx, gy) || 1;
    gx /= l;
    gy /= l;
    out[1] = gx;
    out[2] = gy;
    return out[0];
  }
}
