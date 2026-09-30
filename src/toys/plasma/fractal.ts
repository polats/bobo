// Classic DBM cluster (Niemeyer, Pietronero & Wiesmann 1984) for measuring the fractal dimension the
// toy's η produces: a point seed at φ = 1 in a grounded circle, one cell added per step with probability
// ∝ φ-drop^η over all perimeter cells (4-neighbour, as in the paper), the field re-solved between steps.
// D from mass-radius, N(r) ∝ r^D, and from box counting. Dev tool: runs in a few seconds.
import { Field, FIXED, FREE } from './field';

export function dbmCluster(eta: number, N = 128, seed = 1) {
  let s = seed >>> 0 || 1;
  const rand = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const f = new Field(N, N, false);
  const c0 = N / 2, R = N / 2 - 2;
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const r = Math.hypot(x + 0.5 - c0, y + 0.5 - c0);
      if (r >= R) f.set(y * N + x, FIXED, 0);
    }
  const seedCell = (N / 2) * N + N / 2;
  f.set(seedCell, FIXED, 1);
  const inC = new Uint8Array(N * N);
  inC[seedCell] = 1;
  const cells = [seedCell];
  const cand: number[] = [];
  const w: number[] = [];
  const mark = new Uint32Array(N * N);
  for (let k = 0; k < 20; k++) f.vcycle();
  let step = 0;
  for (;;) {
    step++;
    cand.length = 0;
    w.length = 0;
    let tot = 0;
    for (const c of cells)
      for (const nb of [c + 1, c - 1, c + N, c - N]) {
        if (f.kind[nb] !== FREE || mark[nb] === step) continue;
        mark[nb] = step;
        const e = Math.pow(Math.max(0, 1 - f.phi[nb]), eta);
        cand.push(nb);
        tot += e;
        w.push(tot);
      }
    if (!cand.length || tot <= 0) break;
    const r = rand() * tot;
    let lo = 0, hi = w.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (w[m] < r) lo = m + 1;
      else hi = m;
    }
    const c = cand[lo];
    f.set(c, FIXED, 1);
    inC[c] = 1;
    cells.push(c);
    const x = c % N, y = (c / N) | 0;
    if (Math.hypot(x + 0.5 - c0, y + 0.5 - c0) > R * 0.72) break;
    f.vcycle(1, 1);
  }
  return { cells, N, dMass: massRadius(cells, N, R * 0.72), dBox: boxCount(inC, N) };
}

/** Least-squares slope of log N(r) against log r, for r between a few cells and most of the cluster. */
function massRadius(cells: number[], N: number, rMax: number) {
  const c0 = N / 2;
  const radii = cells.map((c) => Math.hypot((c % N) - c0, ((c / N) | 0) - c0)).sort((a, b) => a - b);
  const xs: number[] = [], ys: number[] = [];
  for (let r = 3; r <= rMax * 0.8; r *= 1.25) {
    let k = 0;
    while (k < radii.length && radii[k] <= r) k++;
    xs.push(Math.log(r));
    ys.push(Math.log(k));
  }
  return slope(xs, ys);
}

function boxCount(inC: Uint8Array, N: number) {
  const xs: number[] = [], ys: number[] = [];
  for (let b = 2; b <= N / 8; b *= 2) {
    let k = 0;
    for (let by = 0; by < N; by += b)
      for (let bx = 0; bx < N; bx += b) {
        let hit = 0;
        for (let y = by; y < by + b && !hit; y++) for (let x = bx; x < bx + b; x++) if (inC[y * N + x]) { hit = 1; break; }
        k += hit;
      }
    xs.push(Math.log(1 / b));
    ys.push(Math.log(k));
  }
  return slope(xs, ys);
}

function slope(xs: number[], ys: number[]) {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  return +(num / den).toFixed(3);
}
