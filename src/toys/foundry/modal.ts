// Modal analysis of a casting, for modal sound synthesis (O'Brien, Shen & Gatchalian 2002; van den
// Doel & Pai 1998). The cast cell mask becomes a 2D plane-stress finite-element mesh: one bilinear
// quad per cell (or per 2x2 block on big castings, to stay under ~1000 nodes), lumped mass at the
// corners. Sound metal has full stiffness, cold-shut seam cells almost none (a lap is nearly a
// crack), and voids are simply missing. The lowest elastic modes of K phi = lambda M phi come from
// shift-invert Lanczos with the three rigid-body modes deflated; each mode's damping is Rayleigh
// (air and material) plus the loss in seams and around voids, weighted by the mode's strain energy
// there. The solver is a generator so a caller can spread it over frames.

/** Casting cell codes. */
export const C_NONE = 0;
export const C_METAL = 1;
export const C_SEAM = 2;
/** Cavity the metal never reached (a void or misrun). */
export const C_VOID = 3;

/** Young's modulus of a seam cell relative to sound metal. */
const E_SEAM = 0.02;
const NU = 0.3;
/** Loss factors: a lap line rubs, gas around voids and porosity soaks up energy. */
const ETA_SEAM = 0.12;
const ETA_VOID = 0.02;
/** Rayleigh damping in real units: zeta(w) = A / 2w + B w / 2. ~4 s ring at 220 Hz, ~1 s at 2 kHz. */
const RAY_A = 3.3;
const RAY_B = 6.6e-8;
const MAX_NODES = 1000;
const MODES = 6;
const LANCZOS = 30;
/** Inner-loop operations between yields (~0.3 ms on a laptop). */
const SLICE = 1.5e5;

export interface ModalResult {
  /** Cell grid the analysis was built from, and the block size of one element. */
  w: number;
  h: number;
  b: number;
  /** Corner grid (nx x ny) to node index, -1 where there is no node. */
  nx: number;
  ny: number;
  node: Int32Array;
  nodes: number;
  /** Eigenvalues (ascending), mass-normalised shapes (2 per node) and flaw damping ratio per mode. */
  lambda: number[];
  phi: Float64Array[];
  zetaFlaw: number[];
  /** Where each mode's flaw loss sits, as a mean cell row (NaN if it has none). */
  flawY: number[];
  mass: number;
}

export interface Partial {
  freq: number;
  amp: number;
  decay: number;
}

/** Stiffness of a unit square Q4 element (E = 1, plane stress), corners (0,0) (1,0) (1,1) (0,1). */
const K0 = (() => {
  const k = new Float64Array(64);
  const c = 1 / (1 - NU * NU);
  const D = [c, c * NU, 0, c * NU, c, 0, 0, 0, (c * (1 - NU)) / 2];
  const g = 1 / Math.sqrt(3);
  for (const gx of [-g, g])
    for (const gy of [-g, g]) {
      const s = (gx + 1) / 2, t = (gy + 1) / 2;
      // Shape function gradients on the unit square.
      const dx = [-(1 - t), 1 - t, t, -t], dy = [-(1 - s), -s, s, 1 - s];
      const B = new Float64Array(24);
      for (let a = 0; a < 4; a++) {
        B[a * 2] = dx[a];
        B[8 + a * 2 + 1] = dy[a];
        B[16 + a * 2] = dy[a];
        B[16 + a * 2 + 1] = dx[a];
      }
      for (let i = 0; i < 8; i++)
        for (let j = 0; j < 8; j++) {
          let v = 0;
          for (let p = 0; p < 3; p++) for (let q = 0; q < 3; q++) v += B[p * 8 + i] * D[p * 3 + q] * B[q * 8 + j];
          k[i * 8 + j] += v * 0.25;
        }
    }
  return k;
})();

/**
 * Build the mesh and solve for the lowest elastic modes. Yields every few milliseconds of work;
 * run it to completion with `finish`.
 */
export function* solveModes(cell: Uint8Array, w: number, h: number): Generator<void, ModalResult | null> {
  let metal = 0;
  for (let i = 0; i < cell.length; i++) if (cell[i] === C_METAL || cell[i] === C_SEAM) metal++;
  // Block size: the smallest that keeps the node count in budget.
  let b = 1;
  while (b < 4 && countNodes(cell, w, h, b) > MAX_NODES) b++;
  const ex = Math.ceil(w / b), ey = Math.ceil(h / b);
  const nx = ex + 1, ny = ey + 1;
  // Per element: stiffness scale, mass, loss factor.
  const E = new Float64Array(ex * ey), mE = new Float64Array(ex * ey), eta = new Float64Array(ex * ey);
  for (let by = 0; by < ey; by++)
    for (let bx = 0; bx < ex; bx++) {
      let sound = 0, seam = 0, nearVoid = 0;
      for (let i = by * b; i < Math.min(h, by * b + b); i++)
        for (let j = bx * b; j < Math.min(w, bx * b + b); j++) {
          const c = cell[i * w + j];
          if (c !== C_METAL && c !== C_SEAM) continue;
          if (c === C_SEAM) seam++;
          else sound++;
          if ((j > 0 && cell[i * w + j - 1] === C_VOID) || (j < w - 1 && cell[i * w + j + 1] === C_VOID) || (i > 0 && cell[(i - 1) * w + j] === C_VOID) || (i < h - 1 && cell[(i + 1) * w + j] === C_VOID)) nearVoid++;
        }
      const m = sound + seam;
      if (!m) continue;
      const e = by * ex + bx, fill = m / (b * b), s = seam / m;
      // A seam is in series with the sound metal around it (Reuss bound): a lap is nearly a crack.
      E[e] = fill / (1 - s + s / E_SEAM);
      mE[e] = m;
      eta[e] = ETA_SEAM * s + (ETA_VOID * nearVoid) / m;
    }
  // Keep the largest edge-connected piece; bits hanging on by a corner would be free hinges.
  const comp = new Int32Array(ex * ey).fill(-1);
  let best = -1, bestN = 0;
  const queue = new Int32Array(ex * ey);
  for (let s = 0, id = 0; s < ex * ey; s++) {
    if (!mE[s] || comp[s] >= 0) continue;
    let qh = 0, qt = 0;
    queue[qt++] = s;
    comp[s] = id;
    while (qh < qt) {
      const e = queue[qh++], x = e % ex, y = (e / ex) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const X = x + dx, Y = y + dy;
        if (X < 0 || Y < 0 || X >= ex || Y >= ey) continue;
        const f = Y * ex + X;
        if (mE[f] && comp[f] < 0) {
          comp[f] = id;
          queue[qt++] = f;
        }
      }
    }
    if (qt > bestN) {
      bestN = qt;
      best = id;
    }
    id++;
  }
  if (bestN < 3) return null;
  for (let e = 0; e < ex * ey; e++) if (comp[e] !== best) mE[e] = 0;
  // Number the corner nodes along the shorter axis so the matrix band stays narrow.
  const node = new Int32Array(nx * ny).fill(-1);
  const used = new Uint8Array(nx * ny);
  for (let e = 0; e < ex * ey; e++) {
    if (!mE[e]) continue;
    const x = e % ex, y = (e / ex) | 0;
    used[y * nx + x] = used[y * nx + x + 1] = used[(y + 1) * nx + x] = used[(y + 1) * nx + x + 1] = 1;
  }
  let nodes = 0;
  if (nx <= ny) {
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) if (used[y * nx + x]) node[y * nx + x] = nodes++;
  } else {
    for (let x = 0; x < nx; x++) for (let y = 0; y < ny; y++) if (used[y * nx + x]) node[y * nx + x] = nodes++;
  }
  const N = nodes * 2;
  const M = new Float64Array(N);
  const corner = (e: number, a: number) => {
    const x = e % ex, y = (e / ex) | 0;
    return node[(y + (a >> 1)) * nx + x + (a === 1 || a === 2 ? 1 : 0)];
  };
  let bw = 0;
  const dofs = new Int32Array(8);
  const elemDofs = (e: number) => {
    for (let a = 0; a < 4; a++) {
      const n = corner(e, a);
      dofs[a * 2] = n * 2;
      dofs[a * 2 + 1] = n * 2 + 1;
    }
  };
  for (let e = 0; e < ex * ey; e++) {
    if (!mE[e]) continue;
    elemDofs(e);
    let lo = N, hi = 0;
    for (let i = 0; i < 8; i++) {
      lo = Math.min(lo, dofs[i]);
      hi = Math.max(hi, dofs[i]);
    }
    bw = Math.max(bw, hi - lo);
    for (let i = 0; i < 8; i++) M[dofs[i]] += mE[e] / 4;
  }
  // Banded lower storage: A[i][j] (i - bw <= j <= i) at i * (bw + 1) + (j - i + bw).
  const W1 = bw + 1;
  const A = new Float64Array(N * W1);
  let diagK = 0, massSum = 0;
  for (let e = 0; e < ex * ey; e++) {
    if (!mE[e]) continue;
    elemDofs(e);
    for (let i = 0; i < 8; i++)
      for (let j = 0; j < 8; j++) {
        const r = dofs[i], c = dofs[j];
        if (c > r) continue;
        A[r * W1 + c - r + bw] += E[e] * K0[i * 8 + j];
      }
  }
  for (let i = 0; i < N; i++) {
    diagK += A[i * W1 + bw];
    massSum += M[i];
  }
  // Shift below zero so K + sM is positive definite; s well under the first elastic eigenvalue.
  const s = (diagK / massSum) * 1e-5;
  for (let i = 0; i < N; i++) A[i * W1 + bw] += s * M[i];
  yield;
  // Banded Cholesky, A = L L^T in place.
  let work = 0;
  for (let i = 0; i < N; i++) {
    const j0 = Math.max(0, i - bw);
    for (let j = j0; j <= i; j++) {
      let sum = A[i * W1 + j - i + bw];
      const k0 = Math.max(j0, j - bw);
      for (let k = k0; k < j; k++) sum -= A[i * W1 + k - i + bw] * A[j * W1 + k - j + bw];
      if (j === i) A[i * W1 + bw] = Math.sqrt(Math.max(sum, 1e-300));
      else A[i * W1 + j - i + bw] = sum / A[j * W1 + bw];
    }
    work += (i - j0) * (i - j0);
    if (work > SLICE) {
      work = 0;
      yield;
    }
  }
  const solve = (x: Float64Array) => {
    for (let i = 0; i < N; i++) {
      let sum = x[i];
      for (let k = Math.max(0, i - bw); k < i; k++) sum -= A[i * W1 + k - i + bw] * x[k];
      x[i] = sum / A[i * W1 + bw];
    }
    for (let i = N - 1; i >= 0; i--) {
      let sum = x[i];
      for (let k = i + 1; k <= Math.min(N - 1, i + bw); k++) sum -= A[k * W1 + i - k + bw] * x[k];
      x[i] = sum / A[i * W1 + bw];
    }
  };
  // Rigid-body modes in the symmetric (z = M^1/2 phi) frame: two translations and a rotation.
  const sq = new Float64Array(N);
  for (let i = 0; i < N; i++) sq[i] = Math.sqrt(M[i]);
  let cxm = 0, cym = 0;
  const px = new Float64Array(nodes), py = new Float64Array(nodes);
  for (let y = 0; y < ny; y++)
    for (let x = 0; x < nx; x++) {
      const n = node[y * nx + x];
      if (n < 0) continue;
      px[n] = x;
      py[n] = y;
      cxm += x * M[n * 2];
      cym += y * M[n * 2];
    }
  cxm /= massSum / 2;
  cym /= massSum / 2;
  const basis: Float64Array[] = [];
  const orth = (v: Float64Array) => {
    for (const q of basis) {
      let d = 0;
      for (let i = 0; i < N; i++) d += v[i] * q[i];
      for (let i = 0; i < N; i++) v[i] -= d * q[i];
    }
  };
  const norm = (v: Float64Array) => {
    let d = 0;
    for (let i = 0; i < N; i++) d += v[i] * v[i];
    return Math.sqrt(d);
  };
  for (let r = 0; r < 3; r++) {
    const v = new Float64Array(N);
    for (let n = 0; n < nodes; n++) {
      if (r === 0) v[n * 2] = sq[n * 2];
      else if (r === 1) v[n * 2 + 1] = sq[n * 2 + 1];
      else {
        v[n * 2] = -(py[n] - cym) * sq[n * 2];
        v[n * 2 + 1] = (px[n] - cxm) * sq[n * 2 + 1];
      }
    }
    orth(v);
    const l = norm(v);
    for (let i = 0; i < N; i++) v[i] /= l;
    basis.push(v);
  }
  const rigid = basis.length;
  // Lanczos on M^1/2 (K + sM)^-1 M^1/2 with full reorthogonalisation: its largest eigenvalues
  // are the lowest elastic modes.
  const m = Math.min(LANCZOS, N - rigid - 1);
  if (m < 2) return null;
  const alpha: number[] = [], beta: number[] = [];
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296) - 0.5;
  let q = new Float64Array(N);
  for (let i = 0; i < N; i++) q[i] = rnd();
  orth(q);
  let l0 = norm(q);
  for (let i = 0; i < N; i++) q[i] /= l0;
  const Q: Float64Array[] = [];
  for (let j = 0; j < m; j++) {
    Q.push(q);
    basis.push(q);
    const v = new Float64Array(N);
    for (let i = 0; i < N; i++) v[i] = q[i] * sq[i];
    solve(v);
    for (let i = 0; i < N; i++) v[i] *= sq[i];
    let a = 0;
    for (let i = 0; i < N; i++) a += v[i] * q[i];
    alpha.push(a);
    orth(v);
    orth(v);
    l0 = norm(v);
    if (l0 < 1e-12 * Math.abs(a)) break;
    beta.push(l0);
    q = new Float64Array(N);
    for (let i = 0; i < N; i++) q[i] = v[i] / l0;
    work += N * (4 * bw + 2 * basis.length);
    if (work > SLICE) {
      work = 0;
      yield;
    }
  }
  const k = alpha.length;
  const T = new Float64Array(k * k);
  for (let i = 0; i < k; i++) {
    T[i * k + i] = alpha[i];
    if (i + 1 < k) T[i * k + i + 1] = T[(i + 1) * k + i] = beta[i];
  }
  const { values, vectors } = jacobi(T, k);
  const order = [...values.keys()].sort((a, b2) => values[b2] - values[a]);
  const lambda: number[] = [], phi: Float64Array[] = [], zetaFlaw: number[] = [], flawY: number[] = [];
  yield;
  for (const r of order) {
    if (phi.length >= MODES) break;
    yield;
    const lam = 1 / values[r] - s;
    if (!(lam > s * 10)) continue;
    const z = new Float64Array(N);
    for (let j = 0; j < k; j++) {
      const c = vectors[j * k + r];
      const qj = Q[j];
      for (let i = 0; i < N; i++) z[i] += c * qj[i];
    }
    for (let i = 0; i < N; i++) z[i] /= sq[i];
    // Modal strain energy method: each element's loss weighted by its share of the strain energy.
    let U = 0, UL = 0, Y = 0;
    for (let e = 0; e < ex * ey; e++) {
      if (!mE[e]) continue;
      elemDofs(e);
      let u = 0;
      for (let i = 0; i < 8; i++) {
        let r2 = 0;
        for (let j = 0; j < 8; j++) r2 += K0[i * 8 + j] * z[dofs[j]];
        u += z[dofs[i]] * r2;
      }
      u *= E[e];
      U += u;
      if (eta[e]) {
        UL += eta[e] * u;
        Y += eta[e] * u * ((((e / ex) | 0) + 0.5) * b);
      }
    }
    lambda.push(lam);
    phi.push(z);
    zetaFlaw.push(U > 0 ? (0.5 * UL) / U : 0);
    flawY.push(UL > 0 ? Y / UL : NaN);
  }
  return { w, h, b, nx, ny, node, nodes, lambda, phi, zetaFlaw, flawY, mass: massSum / 2 };
}

/** Run a solver generator to the end. */
export function finish<T>(g: Generator<void, T>): T {
  for (;;) {
    const r = g.next();
    if (r.done) return r.value;
  }
}

function countNodes(cell: Uint8Array, w: number, h: number, b: number) {
  const ex = Math.ceil(w / b), nx = ex + 1, ey = Math.ceil(h / b);
  const used = new Uint8Array(nx * (ey + 1));
  let n = 0;
  for (let i = 0; i < h; i++)
    for (let j = 0; j < w; j++) {
      const c = cell[i * w + j];
      if (c !== C_METAL && c !== C_SEAM) continue;
      const x = (j / b) | 0, y = (i / b) | 0;
      for (const k of [y * nx + x, y * nx + x + 1, (y + 1) * nx + x, (y + 1) * nx + x + 1])
        if (!used[k]) {
          used[k] = 1;
          n++;
        }
    }
  return n;
}

/** Cyclic Jacobi eigen-decomposition of a small dense symmetric matrix (row-major, n x n). */
function jacobi(a: Float64Array, n: number) {
  const v = new Float64Array(n * n);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q] ** 2;
    if (off < 1e-30) break;
    for (let p = 0; p < n; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const th = (a[q * n + q] - a[p * n + p]) / (2 * apq);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p], akq = a[k * n + q];
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k], aqk = a[q * n + k];
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p], vkq = v[k * n + q];
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  const values: number[] = [];
  for (let i = 0; i < n; i++) values.push(a[i * n + i]);
  return { values, vectors: v };
}

/** Real frequency (Hz) of a mode given the family's scale. */
export function freqOf(r: ModalResult, k: number, scale: number) {
  return scale * Math.sqrt(r.lambda[k]);
}

/** Seconds to -60 dB: Rayleigh damping plus the flaw loss of that mode. */
export function decayOf(r: ModalResult, k: number, scale: number) {
  const w = 2 * Math.PI * freqOf(r, k, scale);
  const zeta = RAY_A / (2 * w) + (RAY_B * w) / 2 + r.zetaFlaw[k];
  return Math.log(1000) / (zeta * w);
}

/** Node nearest a point in cell coordinates (cell centres at +0.5). */
export function nearestNode(r: ModalResult, fx: number, fy: number) {
  let best = -1, bd = 1e9;
  const cx = fx / r.b, cy = fy / r.b;
  const x0 = Math.round(cx), y0 = Math.round(cy);
  for (let rad = 0; rad < Math.max(r.nx, r.ny) && best < 0; rad++)
    for (let y = y0 - rad; y <= y0 + rad; y++)
      for (let x = x0 - rad; x <= x0 + rad; x++) {
        if (x < 0 || y < 0 || x >= r.nx || y >= r.ny) continue;
        const n = r.node[y * r.nx + x];
        if (n < 0) continue;
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        if (d < bd) {
          bd = d;
          best = n;
        }
      }
  return best;
}

/**
 * Partials for a strike at a node pushing along (dx, dy): each mode is excited in proportion to
 * its shape there (an impulse's modal participation), so tapping near a node line mutes that mode.
 */
export function strikePartials(r: ModalResult, n: number, dx: number, dy: number, scale: number): Partial[] {
  const out: Partial[] = [];
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  for (let k = 0; k < r.lambda.length; k++) {
    const ux = r.phi[k][n * 2], uy = r.phi[k][n * 2 + 1];
    const along = Math.abs(ux * dx + uy * dy), across = Math.abs(ux * dy - uy * dx);
    const f = freqOf(r, k, scale);
    // A hard strike's contact time rolls off the top; a little tangential friction excites the rest.
    const amp = (along + 0.15 * across) / (1 + (f / 5000) ** 2);
    out.push({ freq: f, amp, decay: decayOf(r, k, scale) });
  }
  return out;
}

export interface Grade {
  /** 0..1 */
  q: number;
  /** Ring time relative to the flawless casting of this mould. */
  ring: number;
  /** Mean spectral mismatch against the flawless casting, in octaves. */
  detune: number;
  /** Fundamental shift in semitones (negative = flat). */
  semis: number;
  /** Mean row of the flaw losses (NaN if clean), for naming where the flaw is. */
  flawY: number;
}

/**
 * Grade a casting against the flawless one from the same mould: how long it rings, and how far its
 * partials sit from the flawless set (a lap or a misrun shifts and splits them).
 */
export function grade(r: ModalResult, tpl: ModalResult, scale: number): Grade {
  const K = Math.min(r.lambda.length, tpl.lambda.length, 5);
  let ring = 0, rw = 0, detune = 0, fy = 0, fw = 0;
  for (let k = 0; k < K; k++) {
    const wgt = 1 / (k + 1);
    ring += wgt * Math.min(1.2, decayOf(r, k, scale) / decayOf(tpl, k, scale));
    rw += wgt;
    detune += wgt * Math.abs(Math.log2(Math.sqrt(r.lambda[k] / tpl.lambda[k])));
    if (r.flawY[k] === r.flawY[k]) {
      fy += wgt * r.zetaFlaw[k] * r.flawY[k];
      fw += wgt * r.zetaFlaw[k];
    }
  }
  ring = Math.min(1, ring / rw);
  detune /= rw;
  const semis = 12 * Math.log2(Math.sqrt(r.lambda[0] / tpl.lambda[0]));
  // Gentle: a lap that halves the ring time, or a quarter-tone of mistuning, still scores ~0.7.
  const q = Math.max(0, Math.min(1, ring ** 0.5 * Math.exp(-detune * 4.5)));
  return { q, ring, detune, semis, flawY: fw > 0 ? fy / fw : NaN };
}

/**
 * Per-pixel displacement of each mode over a padded copy of the cell grid, normalised so the
 * largest motion is one cell; pixels outside the metal take their nearest metal neighbour's value,
 * so a warp that samples the casting back through the field has no holes at the edge.
 */
export function modeFields(r: ModalResult, cell: Uint8Array, pad: number) {
  const { w, h, b, nx } = r;
  const W = w + pad * 2, H = h + pad * 2;
  const fields: Float32Array[] = [];
  const known = new Uint8Array(W * H);
  for (let k = 0; k < r.lambda.length; k++) {
    const f = new Float32Array(W * H * 2);
    const z = r.phi[k];
    known.fill(0);
    let mx = 1e-12;
    for (let i = 0; i < h; i++)
      for (let j = 0; j < w; j++) {
        const c = cell[i * w + j];
        if (c !== C_METAL && c !== C_SEAM) continue;
        const ex = (j / b) | 0, ey = (i / b) | 0;
        const s = (j + 0.5) / b - ex, t = (i + 0.5) / b - ey;
        const n = [r.node[ey * nx + ex], r.node[ey * nx + ex + 1], r.node[(ey + 1) * nx + ex + 1], r.node[(ey + 1) * nx + ex]];
        if (n[0] < 0 || n[1] < 0 || n[2] < 0 || n[3] < 0) continue;
        const wt = [(1 - s) * (1 - t), s * (1 - t), s * t, (1 - s) * t];
        let ux = 0, uy = 0;
        for (let a = 0; a < 4; a++) {
          ux += wt[a] * z[n[a] * 2];
          uy += wt[a] * z[n[a] * 2 + 1];
        }
        const o = ((i + pad) * W + j + pad) * 2;
        f[o] = ux;
        f[o + 1] = uy;
        known[(i + pad) * W + j + pad] = 1;
        mx = Math.max(mx, Math.hypot(ux, uy));
      }
    for (let i = 0; i < f.length; i++) f[i] /= mx;
    // Grow the field outwards a ring at a time.
    for (let pass = 0; pass < pad + 1; pass++) {
      const add: number[] = [];
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const p = y * W + x;
          if (known[p]) continue;
          let sx = 0, sy = 0, c = 0;
          for (const q of [p - 1, p + 1, p - W, p + W]) {
            if (q < 0 || q >= W * H || !known[q] || (q === p - 1 && x === 0) || (q === p + 1 && x === W - 1)) continue;
            sx += f[q * 2];
            sy += f[q * 2 + 1];
            c++;
          }
          if (c) add.push(p, sx / c, sy / c);
        }
      for (let i = 0; i < add.length; i += 3) {
        const p = add[i];
        f[p * 2] = add[i + 1];
        f[p * 2 + 1] = add[i + 2];
        known[p] = 1;
      }
    }
    fields.push(f);
  }
  return { W, H, fields };
}
