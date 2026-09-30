// Shatter: the bowl's silhouette cut into Voronoi cells (half-plane clipping, as in Kintsugi's
// fracture), seeded densest where the wall strained most, then thrown as spinning shards that
// bounce and tinkle on the table. Water leaves as a burst of drops that pool into a puddle.

export interface Shard {
  /** Outline around the centroid, CSS px, flat [x0, y0, ...]. */
  poly: number[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  a: number;
  va: number;
  /** Size (sqrt area, px), for the tinkle's pitch. */
  size: number;
  resting: boolean;
  shade: number;
}

type P = [number, number];

function clip(poly: P[], nx: number, ny: number, c: number) {
  const out: P[] = [];
  for (let k = 0, m = poly.length; k < m; k++) {
    const a = poly[k], b = poly[(k + 1) % m];
    const da = nx * a[0] + ny * a[1] - c, db = nx * b[0] + ny * b[1] - c;
    if (da <= 0) out.push(a);
    if (da <= 0 !== db <= 0) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
    }
  }
  return out;
}

/** Cut `outline` (flat, CSS px) into about `count` shards, denser near (hx, hy). */
export function shatter(outline: number[], count: number, hx: number, hy: number, cx: number, cy: number): Shard[] {
  const poly: P[] = [];
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (let i = 0; i < outline.length; i += 2) {
    poly.push([outline[i], outline[i + 1]]);
    x0 = Math.min(x0, outline[i]);
    x1 = Math.max(x1, outline[i]);
    y0 = Math.min(y0, outline[i + 1]);
    y1 = Math.max(y1, outline[i + 1]);
  }
  const span = Math.max(x1 - x0, y1 - y0);
  const seeds: P[] = [];
  for (let tries = 0; seeds.length < count && tries < count * 40; tries++) {
    // Pull seeds toward the break point so the shards there are small.
    const u = Math.random();
    const p: P = u < 0.45 ? [hx + (Math.random() - 0.5) * span * 0.5, hy + (Math.random() - 0.5) * span * 0.35] : [x0 + Math.random() * (x1 - x0), y0 + Math.random() * (y1 - y0)];
    if (inside(poly, p)) seeds.push(p);
  }
  const shards: Shard[] = [];
  for (let i = 0; i < seeds.length; i++) {
    let cell = poly;
    const s = seeds[i];
    for (let j = 0; j < seeds.length && cell.length > 2; j++) {
      if (j === i) continue;
      const t = seeds[j];
      cell = clip(cell, t[0] - s[0], t[1] - s[1], (t[0] * t[0] + t[1] * t[1] - s[0] * s[0] - s[1] * s[1]) / 2);
    }
    if (cell.length < 3) continue;
    let a = 0, mx = 0, my = 0;
    for (let k = 0; k < cell.length; k++) {
      const p = cell[k], q = cell[(k + 1) % cell.length];
      const cr = p[0] * q[1] - q[0] * p[1];
      a += cr;
      mx += (p[0] + q[0]) * cr;
      my += (p[1] + q[1]) * cr;
    }
    if (Math.abs(a) < 4) continue;
    mx /= 3 * a;
    my /= 3 * a;
    const flat: number[] = [];
    for (const p of cell) flat.push(p[0] - mx, p[1] - my);
    // Thrown out from the strained wall, up and away from the glass's axis.
    const dx = mx - cx, dy = my - cy;
    const d = Math.hypot(dx, dy) || 1;
    const sp = 90 + Math.random() * 220;
    shards.push({
      poly: flat,
      x: mx,
      y: my,
      vx: (dx / d) * sp + (Math.random() - 0.5) * 80,
      vy: (dy / d) * sp * 0.5 - 120 - Math.random() * 200,
      a: 0,
      va: (Math.random() - 0.5) * 16,
      size: Math.sqrt(Math.abs(a) / 2),
      resting: false,
      shade: Math.random(),
    });
  }
  return shards;
}

function inside(poly: P[], p: P) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j];
    if (a[1] > p[1] !== b[1] > p[1] && p[0] < ((b[0] - a[0]) * (p[1] - a[1])) / (b[1] - a[1]) + a[0]) c = !c;
  }
  return c;
}
