// Pre-baked glass fracture: for each jar size, three Voronoi patterns whose seeds crowd around an
// impact point (left side, top, right side), so the jar breaks finest where it was hit. This is the
// DeepFracture idea (pick a fracture pattern by where the blow lands) without the network. Each cell
// becomes a small box shard in the rigid-body world.

export interface Piece {
  /** Centre in the jar's local frame. */
  x: number;
  y: number;
  hx: number;
  hy: number;
  a: number;
  /** Which of the renderer's shard outlines to draw. */
  shape: number;
}

const cache = new Map<string, Piece[][]>();

/** Pattern 0: hit from the left, 1: from above or head-on, 2: from the right. */
export function shatterPatterns(hx: number, hy: number): Piece[][] {
  const key = `${hx.toFixed(3)}:${hy.toFixed(3)}`;
  let p = cache.get(key);
  if (!p) cache.set(key, (p = [bake(hx, hy, -0.7, 0.1, 1), bake(hx, hy, 0, 0.45, 2), bake(hx, hy, 0.7, 0.1, 3)]));
  return p;
}

/** Deterministic PRNG so every jar of a size shatters the same few ways. */
function mulberry(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Poly = [number, number][];

function bake(hx: number, hy: number, ix: number, iy: number, seed: number): Piece[] {
  const rnd = mulberry(seed * 7919);
  const seeds: [number, number][] = [];
  // Dense near the impact, sparse elsewhere.
  for (let i = 0; i < 4; i++) {
    const a = rnd() * Math.PI * 2, r = 0.15 + rnd() * 0.3;
    seeds.push([clamp(ix + Math.cos(a) * r, -0.95, 0.95) * hx, clamp(iy + Math.sin(a) * r, -0.95, 0.95) * hy]);
  }
  for (let i = 0; i < 5; i++) seeds.push([(rnd() * 1.9 - 0.95) * hx, (rnd() * 1.9 - 0.95) * hy]);
  const out: Piece[] = [];
  for (let i = 0; i < seeds.length; i++) {
    let cell: Poly = [[-hx, -hy], [hx, -hy], [hx, hy], [-hx, hy]];
    const [sx, sy] = seeds[i];
    for (let j = 0; j < seeds.length && cell.length; j++) {
      if (j === i) continue;
      const [tx, ty] = seeds[j];
      // Keep the side of the bisector nearer seed i.
      cell = clipHalf(cell, tx - sx, ty - sy, (tx - sx) * (sx + tx) * 0.5 + (ty - sy) * (sy + ty) * 0.5);
    }
    if (cell.length < 3) continue;
    // Box the cell along its longest edge.
    let best = 0, ang = 0;
    for (let k = 0; k < cell.length; k++) {
      const [ax, ay] = cell[k], [bx, by] = cell[(k + 1) % cell.length];
      const l = Math.hypot(bx - ax, by - ay);
      if (l > best) {
        best = l;
        ang = Math.atan2(by - ay, bx - ax);
      }
    }
    const c = Math.cos(ang), s = Math.sin(ang);
    let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
    for (const [px, py] of cell) {
      const u = c * px + s * py, v = -s * px + c * py;
      u0 = Math.min(u0, u);
      u1 = Math.max(u1, u);
      v0 = Math.min(v0, v);
      v1 = Math.max(v1, v);
    }
    const uc = (u0 + u1) / 2, vc = (v0 + v1) / 2;
    // Shrunk a little: neighbouring boxes overlap where the cells don't.
    out.push({
      x: c * uc - s * vc,
      y: s * uc + c * vc,
      hx: Math.max(0.035, ((u1 - u0) / 2) * 0.8),
      hy: Math.max(0.03, ((v1 - v0) / 2) * 0.8),
      a: ang,
      shape: i % 3,
    });
  }
  return out;
}

/** Sutherland–Hodgman clip of a convex polygon to the half-plane nx*x + ny*y <= d. */
function clipHalf(poly: Poly, nx: number, ny: number, d: number): Poly {
  const out: Poly = [];
  for (let k = 0; k < poly.length; k++) {
    const p = poly[k], q = poly[(k + 1) % poly.length];
    const dp = nx * p[0] + ny * p[1] - d, dq = nx * q[0] + ny * q[1] - d;
    if (dp <= 0) out.push(p);
    if (dp * dq < 0) {
      const t = dp / (dp - dq);
      out.push([p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t]);
    }
  }
  return out;
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
