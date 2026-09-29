// Outlines of cell masks: marching squares (the 2-D case of Lorensen & Cline's marching cubes) for
// the contour, then Douglas–Peucker to drop vertices that add nothing, then even resampling so the
// collision points are about a cell apart.

/**
 * Outer contour of a mask (nonzero = solid) as a closed polygon, flat [x0, y0, x1, y1, ...], in mask
 * coordinates where cell (i, j) spans [i, i+1] x [j, j+1]. The iso-line runs through the cell centres
 * at 0.5, so vertices sit on cell edges and corners are cut. Saddles keep diagonal cells apart,
 * matching the 4-connected islands.
 */
export function traceOutline(mask: Uint8Array, w: number, h: number): number[] {
  const at = (i: number, j: number) => (i >= 1 && i <= w && j >= 1 && j <= h && mask[(j - 1) * w + (i - 1)] ? 1 : 0);
  const K = 8192;
  const adj = new Map<number, number[]>();
  const link = (ax: number, ay: number, bx: number, by: number) => {
    const a = ax * K + ay, b = bx * K + by;
    const la = adj.get(a), lb = adj.get(b);
    if (la) la.push(b);
    else adj.set(a, [b]);
    if (lb) lb.push(a);
    else adj.set(b, [a]);
  };
  // Squares between the centres of padded cells (i, j) .. (i+1, j+1); edge midpoints in doubled coords.
  for (let j = 0; j <= h; j++)
    for (let i = 0; i <= w; i++) {
      const c = (at(i, j) << 3) | (at(i + 1, j) << 2) | (at(i + 1, j + 1) << 1) | at(i, j + 1);
      if (c === 0 || c === 15) continue;
      const Tx = 2 * i + 2, Ty = 2 * j + 1, Rx = 2 * i + 3, Ry = 2 * j + 2;
      const Bx = 2 * i + 2, By = 2 * j + 3, Lx = 2 * i + 1, Ly = 2 * j + 2;
      switch (c) {
        case 1:
        case 14:
          link(Lx, Ly, Bx, By);
          break;
        case 2:
        case 13:
          link(Bx, By, Rx, Ry);
          break;
        case 3:
        case 12:
          link(Lx, Ly, Rx, Ry);
          break;
        case 4:
        case 11:
          link(Tx, Ty, Rx, Ry);
          break;
        case 5:
          link(Lx, Ly, Bx, By);
          link(Tx, Ty, Rx, Ry);
          break;
        case 6:
        case 9:
          link(Tx, Ty, Bx, By);
          break;
        case 7:
        case 8:
          link(Tx, Ty, Lx, Ly);
          break;
        case 10:
          link(Tx, Ty, Lx, Ly);
          link(Bx, By, Rx, Ry);
          break;
      }
    }
  // Stitch segments into loops and keep the one enclosing the most area (the outside, not a hole).
  const seen = new Set<number>();
  let best: number[] = [], bestArea = 0;
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const loop: number[] = [];
    let prev = -1, cur = start;
    for (let guard = 0; guard < 1e6; guard++) {
      seen.add(cur);
      loop.push((Math.floor(cur / K) >> 0) / 2 - 1, (cur % K) / 2 - 1);
      const nb = adj.get(cur)!;
      const next = nb[0] !== prev ? nb[0] : nb[1];
      prev = cur;
      cur = next;
      if (cur === start || cur === undefined) break;
    }
    let area = 0;
    for (let i = 0, m = loop.length; i < m; i += 2) {
      const j = (i + 2) % m;
      area += loop[i] * loop[j + 1] - loop[j] * loop[i + 1];
    }
    if (Math.abs(area) > bestArea) {
      bestArea = Math.abs(area);
      best = loop;
    }
  }
  return best;
}

/** Douglas–Peucker (1973) on a closed polygon: keep only vertices more than `eps` off the simplified line. */
export function simplify(p: number[], eps: number): number[] {
  const n = p.length / 2;
  if (n < 5) return p;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) {
    const d = (p[2 * i] - p[0]) ** 2 + (p[2 * i + 1] - p[1]) ** 2;
    if (d > fd) {
      fd = d;
      far = i;
    }
  }
  const keep = new Uint8Array(n);
  keep[0] = keep[far] = 1;
  const stack = [0, far, far, n];
  const e2 = eps * eps;
  while (stack.length) {
    const i1 = stack.pop()!, i0 = stack.pop()!;
    const ax = p[2 * i0], ay = p[2 * i0 + 1], bx = p[2 * (i1 % n)], by = p[2 * (i1 % n) + 1];
    const dx = bx - ax, dy = by - ay, l2 = dx * dx + dy * dy || 1e-9;
    let worst = -1, wd = e2;
    for (let i = i0 + 1; i < i1; i++) {
      const px = p[2 * i] - ax, py = p[2 * i + 1] - ay;
      const t = Math.max(0, Math.min(1, (px * dx + py * dy) / l2));
      const d = (px - t * dx) ** 2 + (py - t * dy) ** 2;
      if (d > wd) {
        wd = d;
        worst = i;
      }
    }
    if (worst < 0) continue;
    keep[worst] = 1;
    stack.push(i0, worst, worst, i1);
  }
  const out: number[] = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  return out.length >= 6 ? out : p;
}

/** Points every `spacing` or closer around a closed polygon. */
export function resample(p: number[], spacing: number): number[] {
  const out: number[] = [];
  const n = p.length / 2;
  for (let i = 0; i < n; i++) {
    const ax = p[2 * i], ay = p[2 * i + 1];
    const j = (i + 1) % n;
    const bx = p[2 * j], by = p[2 * j + 1];
    const k = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / spacing));
    for (let t = 0; t < k; t++) out.push(ax + ((bx - ax) * t) / k, ay + ((by - ay) * t) / k);
  }
  return out;
}

/**
 * Pull points that the contour put outside the cells (it bulges out at concave corners) back onto
 * the nearest solid cell, so a slab that exactly fills a gap doesn't wedge itself in. In place, on
 * points in mask coordinates.
 */
export function snapInside(p: number[], mask: Uint8Array, w: number, h: number) {
  const solid = (i: number, j: number) => i >= 0 && j >= 0 && i < w && j < h && mask[j * w + i] !== 0;
  for (let k = 0; k < p.length; k += 2) {
    const px = p[k], py = p[k + 1];
    const ci = Math.floor(px), cj = Math.floor(py);
    if (solid(ci, cj)) continue;
    let best = Infinity, bx = px, by = py;
    for (let j = cj - 1; j <= cj + 1; j++)
      for (let i = ci - 1; i <= ci + 1; i++) {
        if (!solid(i, j)) continue;
        const qx = Math.max(i, Math.min(i + 1, px)), qy = Math.max(j, Math.min(j + 1, py));
        const d = (qx - px) ** 2 + (qy - py) ** 2;
        if (d < best) {
          best = d;
          bx = qx;
          by = qy;
        }
      }
    p[k] = bx;
    p[k + 1] = by;
  }
}
