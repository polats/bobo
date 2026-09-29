// Fracture: Voronoi cells in the piece's fracture square, seeded denser near the impact point,
// with every shared edge roughened by midpoint displacement. Cells are clipped against the
// square (so they stay convex and cheap), then mapped onto the real silhouette. The same jagged
// polylines are both the shard outlines and the seams the gold runs along.

import type { Shape } from './pieces';

export interface ShardGeo {
  /** Outline in piece-local pixels, flat [x0, y0, x1, y1, ...]. */
  poly: number[];
  cx: number;
  cy: number;
  area: number;
}

export interface Seam {
  i: number;
  j: number;
  /** Shared-vertex ids of the two ends (junctions where seams meet). */
  va: number;
  vb: number;
  /** Polyline in piece-local pixels, flat. */
  pts: number[];
}

export interface Fracture {
  shards: ShardGeo[];
  seams: Seam[];
  /** Silhouette of the unbroken piece, flat. */
  outline: number[];
  vertexCount: number;
}

type P = [number, number];

/** Clip a convex polygon (with per-edge labels) to the half-plane n·p <= c; new edges get `label`. */
function clip(poly: P[], labs: number[], nx: number, ny: number, c: number, label: number) {
  const out: P[] = [], ol: number[] = [];
  const m = poly.length;
  for (let k = 0; k < m; k++) {
    const a = poly[k], b = poly[(k + 1) % m];
    const da = nx * a[0] + ny * a[1] - c, db = nx * b[0] + ny * b[1] - c;
    const ain = da <= 0, bin = db <= 0;
    if (ain) {
      out.push(a);
      ol.push(labs[k]);
    }
    if (ain !== bin) {
      const t = da / (da - db);
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      ol.push(ain ? label : labs[k]);
    }
  }
  return { poly: out, labs: ol };
}

/** Midpoint-displaced polyline from a to b, endpoints fixed. */
function jag(a: P, b: P, amp: number, minLen: number, out: P[], ay: number) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len < minLen) {
    out.push(b);
    return;
  }
  const off = (Math.random() * 2 - 1) * amp * len;
  const m: P = [
    Math.max(-1, Math.min(1, (a[0] + b[0]) / 2 - (dy / len) * off)),
    Math.max(0, Math.min(ay, (a[1] + b[1]) / 2 + (dx / len) * off)),
  ];
  jag(a, m, amp * 0.9, minLen, out, ay);
  jag(m, b, amp * 0.9, minLen, out, ay);
}

function straight(a: P, b: P, step: number, out: P[]) {
  const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / step));
  for (let k = 1; k <= n; k++) out.push([a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n]);
}

function areaCentroid(poly: number[]) {
  let a = 0, cx = 0, cy = 0;
  for (let k = 0, n = poly.length / 2; k < n; k++) {
    const x0 = poly[2 * k], y0 = poly[2 * k + 1];
    const x1 = poly[(2 * k + 2) % poly.length], y1 = poly[(2 * k + 3) % poly.length];
    const cr = x0 * y1 - x1 * y0;
    a += cr;
    cx += (x0 + x1) * cr;
    cy += (y0 + y1) * cr;
  }
  a /= 2;
  return { area: Math.abs(a), cx: cx / (6 * a), cy: cy / (6 * a) };
}

export function fracture(sh: Shape, count: number): Fracture {
  // Fracture square in roughly physical proportions: X = u (-1..1), Y = v * ay.
  const ay = sh.def.plate ? 2 : Math.max(0.6, sh.h / (sh.R * sh.width(0.5)));
  const tmp = [0, 0];
  const toLocal = (p: P, out: number[]) => {
    sh.map(p[0], p[1] / ay, tmp);
    out.push(tmp[0], tmp[1]);
  };
  const impact: P = sh.def.plate ? [(Math.random() - 0.5) * 0.8, ay * (0.15 + Math.random() * 0.2)] : [(Math.random() - 0.5) * 0.5, 0.05 * ay];
  let best: Fracture | null = null;
  let bestScore = -1;
  for (let attempt = 0; attempt < 24; attempt++) {
    // Best-candidate seeds, closer together near the impact so the shards there are smaller.
    const seeds: P[] = [];
    while (seeds.length < count) {
      let pick: P = [0, 0], score = -1;
      for (let c = 0; c < 24; c++) {
        const p: P = [Math.random() * 2 - 1, Math.random() * ay];
        let dmin = 9;
        for (const s of seeds) dmin = Math.min(dmin, Math.hypot(p[0] - s[0], p[1] - s[1]));
        const di = Math.hypot(p[0] - impact[0], p[1] - impact[1]) / Math.max(2, ay);
        const sc = dmin / (0.7 + 0.6 * di);
        if (sc > score) [pick, score] = [p, sc];
      }
      seeds.push(pick);
    }
    const fr = build(seeds, ay, toLocal);
    // Reject patterns with slivers: every shard should be grabbable.
    const areas = fr.shards.map((s) => s.area);
    const mean = areas.reduce((a, b) => a + b, 0) / areas.length;
    const score = Math.min(...areas) / mean;
    if (score > bestScore) [best, bestScore] = [fr, score];
    if (score > 0.4) break;
  }
  return best!;
}

function build(seeds: P[], ay: number, toLocal: (p: P, out: number[]) => void): Fracture {
  const n = seeds.length;
  // Box edges: -1 bottom, -2 right, -3 top, -4 left.
  const cells = seeds.map((s, i) => {
    let poly: P[] = [[-1, 0], [1, 0], [1, ay], [-1, ay]];
    let labs = [-1, -2, -3, -4];
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      const t = seeds[j];
      const nx = t[0] - s[0], ny = t[1] - s[1];
      const c = (t[0] * t[0] + t[1] * t[1] - s[0] * s[0] - s[1] * s[1]) / 2;
      ({ poly, labs } = clip(poly, labs, nx, ny, c, j));
    }
    return { poly, labs };
  });
  // Merge the Voronoi vertices shared between cells.
  const verts: P[] = [];
  const vid = (p: P) => {
    for (let k = 0; k < verts.length; k++) if (Math.abs(verts[k][0] - p[0]) < 1e-6 && Math.abs(verts[k][1] - p[1]) < 1e-6) return k;
    verts.push(p);
    return verts.length - 1;
  };
  const ids = cells.map((c) => c.poly.map(vid));
  const edgeLen = 0.022;
  const jagged = new Map<string, { va: number; pts: P[] }>();
  const seams: Seam[] = [];
  const shards: ShardGeo[] = cells.map((c, i) => {
    const out: number[] = [];
    const m = c.poly.length;
    for (let k = 0; k < m; k++) {
      const va = ids[i][k], vb = ids[i][(k + 1) % m];
      if (va === vb) continue;
      const lab = c.labs[k];
      let pts: P[];
      if (lab >= 0) {
        const key = i < lab ? `${i},${lab}` : `${lab},${i}`;
        let e = jagged.get(key);
        if (!e) {
          const line: P[] = [verts[va]];
          jag(verts[va], verts[vb], 0.12, edgeLen, line, ay);
          e = { va, pts: line };
          jagged.set(key, e);
          const loc: number[] = [];
          for (const p of line) toLocal(p, loc);
          seams.push({ i: Math.min(i, lab), j: Math.max(i, lab), va, vb, pts: loc });
        }
        pts = e.va === va ? e.pts : [...e.pts].reverse();
      } else {
        pts = [verts[va]];
        straight(verts[va], verts[vb], 0.012, pts);
      }
      for (let q = 0; q < pts.length - 1; q++) toLocal(pts[q], out);
    }
    const { area, cx, cy } = areaCentroid(out);
    return { poly: out, area, cx, cy };
  });
  const outline: number[] = [];
  const box: P[] = [[-1, 0], [1, 0], [1, ay], [-1, ay], [-1, 0]];
  for (let k = 0; k < 4; k++) {
    const pts: P[] = [box[k]];
    straight(box[k], box[k + 1], 0.01, pts);
    for (let q = 0; q < pts.length - 1; q++) toLocal(pts[q], outline);
  }
  return { shards, seams, outline, vertexCount: verts.length };
}
