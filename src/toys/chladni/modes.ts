// Free-edge plate modes by the Ritz method, as Ritz (1909) did for Chladni's square plate and Gander &
// Kwok (SIAM Review 2012) retell: minimise the Kirchhoff bending energy over a finite basis. The free
// edge is the natural boundary condition of that energy, so nothing is imposed at the edge; the plate
// shape enters only through the quadrature. The basis is products of normalised Legendre polynomials
// P_i(x) P_j(y) of total degree <= N (rotation invariant, so a disc's cos/sin pairs stay degenerate),
// split into the four x/y parity classes, which decouple on both shapes. Per class this is a small
// dense generalised eigenproblem K c = lambda M c, solved by Jacobi rotations: M first (dropping
// near-null directions, since polynomials restricted to a disc are ill-conditioned), then K.
// Coordinates: the square is [-1,1]^2, the disc has radius 1; lambda = omega^2 rho h L^4 / D with L = 1.

export type PlateShape = 'square' | 'circle';

export interface PlateMode {
  /** Eigenvalue in half-size units, and the standard Leissa parameter omega a^2 sqrt(rho h / D). */
  lambda: number;
  leissa: number;
  /** Parity class: bit 0 = odd in x, bit 1 = odd in y. */
  cls: number;
  /** Basis indices (i, j) and coefficients, scaled so the mean of phi^2 over the plate is 1. */
  ii: Int32Array;
  jj: Int32Array;
  c: Float64Array;
  /** Mode shape sampled at the grid cell centres (G x G over [-1,1]^2, row-major, y down). */
  grid: Float32Array;
}

export interface PlateModes {
  shape: PlateShape;
  N: number;
  G: number;
  /** 1 where the grid cell centre is on the plate. */
  mask: Uint8Array;
  modes: PlateMode[];
}

/** Poisson's ratio of steel. */
export const NU = 0.3;

/** Normalised Legendre values and first two derivatives at x, degrees 0..N. */
export function legendre(N: number, x: number, P: Float64Array, D1: Float64Array, D2: Float64Array) {
  P[0] = 1;
  D1[0] = 0;
  D2[0] = 0;
  if (N >= 1) {
    P[1] = x;
    D1[1] = 1;
    D2[1] = 0;
  }
  for (let n = 1; n < N; n++) {
    P[n + 1] = ((2 * n + 1) * x * P[n] - n * P[n - 1]) / (n + 1);
    D1[n + 1] = D1[n - 1] + (2 * n + 1) * P[n];
    D2[n + 1] = D2[n - 1] + (2 * n + 1) * D1[n];
  }
  for (let n = 0; n <= N; n++) {
    const s = Math.sqrt(n + 0.5);
    P[n] *= s;
    D1[n] *= s;
    D2[n] *= s;
  }
}

/** Gauss-Legendre nodes and weights on [-1, 1]. */
function gauss(n: number) {
  const x = new Float64Array(n), w = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let z = Math.cos((Math.PI * (i + 0.75)) / (n + 0.5));
    let dp = 0;
    for (let it = 0; it < 100; it++) {
      let p0 = 1, p1 = z;
      for (let k = 1; k < n; k++) {
        const p2 = ((2 * k + 1) * z * p1 - k * p0) / (k + 1);
        p0 = p1;
        p1 = p2;
      }
      dp = (n * (z * p1 - p0)) / (z * z - 1);
      const dz = p1 / dp;
      z -= dz;
      if (Math.abs(dz) < 1e-15) break;
    }
    x[i] = z;
    w[i] = 2 / ((1 - z * z) * dp * dp);
  }
  return { x, w };
}

/** Quadrature points in the first quadrant (weights already x4: every integrand here is even in x and y). */
function quadrature(shape: PlateShape, N: number) {
  const xs: number[] = [], ys: number[] = [], ws: number[] = [];
  if (shape === 'square') {
    // Products have degree <= 2N per axis: N/2 + 2 positive nodes of an even Gauss rule suffice.
    const n = 2 * (Math.floor(N / 2) + 2);
    const g = gauss(n);
    for (let a = 0; a < n; a++) for (let b = 0; b < n; b++) {
      if (g.x[a] <= 0 || g.x[b] <= 0) continue;
      xs.push(g.x[a]);
      ys.push(g.x[b]);
      ws.push(4 * g.w[a] * g.w[b]);
    }
  } else {
    // Polar: Gauss in r on [0, 1] (the integrand times r is a polynomial of degree 2N + 1), midpoint in theta.
    const nr = N + 2, nt = N + 2;
    const g = gauss(nr);
    for (let a = 0; a < nr; a++) {
      const r = (g.x[a] + 1) / 2, wr = g.w[a] / 2;
      for (let b = 0; b < nt; b++) {
        const t = ((b + 0.5) * Math.PI) / 2 / nt;
        xs.push(r * Math.cos(t));
        ys.push(r * Math.sin(t));
        ws.push((4 * wr * r * Math.PI) / 2 / nt);
      }
    }
  }
  return { xs, ys, ws };
}

/** Cyclic Jacobi eigen-decomposition of a symmetric n x n matrix (overwritten); returns eigenvalues, V columns. */
export function jacobi(A: Float64Array, n: number) {
  const V = new Float64Array(n * n);
  for (let i = 0; i < n; i++) V[i * n + i] = 1;
  for (let sweep = 0; sweep < 60; sweep++) {
    let off = 0, diag = 0;
    for (let p = 0; p < n; p++) {
      diag += A[p * n + p] * A[p * n + p];
      for (let q = p + 1; q < n; q++) off += A[p * n + q] * A[p * n + q];
    }
    if (off <= 1e-26 * diag) break;
    for (let p = 0; p < n - 1; p++)
      for (let q = p + 1; q < n; q++) {
        const apq = A[p * n + q];
        if (Math.abs(apq) < 1e-300) continue;
        const app = A[p * n + p], aqq = A[q * n + q];
        const th = (aqq - app) / (2 * apq);
        const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1));
        const c = 1 / Math.sqrt(t * t + 1), s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = A[k * n + p], akq = A[k * n + q];
          A[k * n + p] = c * akp - s * akq;
          A[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = A[p * n + k], aqk = A[q * n + k];
          A[p * n + k] = c * apk - s * aqk;
          A[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = V[k * n + p], vkq = V[k * n + q];
          V[k * n + p] = c * vkp - s * vkq;
          V[k * n + q] = s * vkp + c * vkq;
        }
      }
  }
  const d = new Float64Array(n);
  for (let i = 0; i < n; i++) d[i] = A[i * n + i];
  return { d, V };
}

/** Is (x, y) on the plate? */
export function inside(shape: PlateShape, x: number, y: number) {
  return shape === 'square' ? Math.abs(x) <= 1 && Math.abs(y) <= 1 : x * x + y * y <= 1;
}

/**
 * Solve for the lowest free-edge modes of a square or disc. N is the total polynomial degree, G the
 * sampling grid, maxLeissa the highest eigenvalue kept (Leissa's parameter, based on side or radius).
 */
export function solveModes(shape: PlateShape, N: number, G: number, maxModes: number): PlateModes {
  const { xs, ys, ws } = quadrature(shape, N);
  const nq = ws.length;
  const P = new Float64Array(N + 1), D1 = new Float64Array(N + 1), D2 = new Float64Array(N + 1);
  const Q = new Float64Array(N + 1), E1 = new Float64Array(N + 1), E2 = new Float64Array(N + 1);
  // Per quadrature point, per degree: values and derivatives along x and along y.
  const px = new Float64Array(nq * (N + 1) * 3), py = new Float64Array(nq * (N + 1) * 3);
  for (let q = 0; q < nq; q++) {
    legendre(N, xs[q], P, D1, D2);
    legendre(N, ys[q], Q, E1, E2);
    for (let n = 0; n <= N; n++) {
      const o = (q * (N + 1) + n) * 3;
      px[o] = P[n];
      px[o + 1] = D1[n];
      px[o + 2] = D2[n];
      py[o] = Q[n];
      py[o + 1] = E1[n];
      py[o + 2] = E2[n];
    }
  }
  const found: Omit<PlateMode, 'grid'>[] = [];
  const nu1 = 1 - NU;
  for (let cls = 0; cls < 4; cls++) {
    const bi: number[] = [], bj: number[] = [];
    for (let i = cls & 1; i <= N; i += 2) for (let j = (cls >> 1) & 1; i + j <= N; j += 2) {
      bi.push(i);
      bj.push(j);
    }
    const n = bi.length;
    const K = new Float64Array(n * n), M = new Float64Array(n * n);
    const w = new Float64Array(n), wxx = new Float64Array(n), wyy = new Float64Array(n), wxy = new Float64Array(n);
    for (let q = 0; q < nq; q++) {
      const W = ws[q];
      for (let a = 0; a < n; a++) {
        const ox = (q * (N + 1) + bi[a]) * 3, oy = (q * (N + 1) + bj[a]) * 3;
        w[a] = px[ox] * py[oy];
        wxx[a] = px[ox + 2] * py[oy];
        wyy[a] = px[ox] * py[oy + 2];
        wxy[a] = px[ox + 1] * py[oy + 1];
      }
      for (let a = 0; a < n; a++) {
        const la = wxx[a] + wyy[a], xa = wxx[a], ya = wyy[a], ta = wxy[a], va = w[a] * W;
        for (let b = a; b < n; b++) {
          // Kirchhoff bending energy density (Laplacian squared minus the Gaussian-curvature term).
          K[a * n + b] += W * (la * (wxx[b] + wyy[b]) - nu1 * (xa * wyy[b] + ya * wxx[b] - 2 * ta * wxy[b]));
          M[a * n + b] += va * w[b];
        }
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) {
      K[a * n + b] = K[b * n + a];
      M[a * n + b] = M[b * n + a];
    }
    // M = V diag(m) V^T; keep well-conditioned directions, T = V diag(1/sqrt m).
    const Kc = K.slice();
    const em = jacobi(M, n);
    const mmax = Math.max(...em.d);
    const keep: number[] = [];
    for (let k = 0; k < n; k++) if (em.d[k] > 1e-12 * mmax) keep.push(k);
    const r = keep.length;
    const T = new Float64Array(n * r);
    keep.forEach((k, col) => {
      const s = 1 / Math.sqrt(em.d[k]);
      for (let a = 0; a < n; a++) T[a * r + col] = em.V[a * n + k] * s;
    });
    // Kr = T^T K T
    const KT = new Float64Array(n * r);
    for (let a = 0; a < n; a++) for (let col = 0; col < r; col++) {
      let s = 0;
      for (let b = 0; b < n; b++) s += Kc[a * n + b] * T[b * r + col];
      KT[a * r + col] = s;
    }
    const Kr = new Float64Array(r * r);
    for (let i = 0; i < r; i++) for (let j = i; j < r; j++) {
      let s = 0;
      for (let a = 0; a < n; a++) s += T[a * r + i] * KT[a * r + j];
      Kr[i * r + j] = Kr[j * r + i] = s;
    }
    const ek = jacobi(Kr, r);
    for (let k = 0; k < r; k++) {
      const lambda = ek.d[k];
      if (lambda < 1) continue; // rigid-body motions (1, x, y) have lambda = 0
      const c = new Float64Array(n);
      for (let a = 0; a < n; a++) {
        let s = 0;
        for (let col = 0; col < r; col++) s += T[a * r + col] * ek.V[col * r + k];
        c[a] = s;
      }
      found.push({ lambda, leissa: shape === 'square' ? 4 * Math.sqrt(lambda) : Math.sqrt(lambda), cls, ii: Int32Array.from(bi), jj: Int32Array.from(bj), c });
    }
  }
  found.sort((a, b) => a.lambda - b.lambda);
  const chosen = found.slice(0, maxModes);
  // Sample the shapes on the grid, then scale each so mean(phi^2) over the plate is 1.
  const mask = new Uint8Array(G * G);
  const Pg = new Float64Array(G * (N + 1));
  for (let g = 0; g < G; g++) {
    legendre(N, -1 + ((g + 0.5) * 2) / G, P, D1, D2);
    for (let k = 0; k <= N; k++) Pg[g * (N + 1) + k] = P[k];
  }
  let area = 0;
  for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
    const on = inside(shape, -1 + ((gx + 0.5) * 2) / G, -1 + ((gy + 0.5) * 2) / G);
    mask[gy * G + gx] = on ? 1 : 0;
    area += on ? 1 : 0;
  }
  const modes: PlateMode[] = chosen.map((m) => {
    const grid = new Float32Array(G * G);
    let ss = 0;
    for (let gy = 0; gy < G; gy++) for (let gx = 0; gx < G; gx++) {
      let s = 0;
      for (let a = 0; a < m.c.length; a++) s += m.c[a] * Pg[gx * (N + 1) + m.ii[a]] * Pg[gy * (N + 1) + m.jj[a]];
      grid[gy * G + gx] = s;
      if (mask[gy * G + gx]) ss += s * s;
    }
    const k = 1 / Math.sqrt(ss / area);
    for (let i = 0; i < grid.length; i++) grid[i] *= k;
    const c = m.c.map((v) => v * k);
    return { ...m, c, grid };
  });
  return { shape, N, G, mask, modes };
}

/** Legendre values along x and y at a point, shared by every mode's exact evaluation there. */
export function basisAt(N: number, x: number, y: number) {
  const px = new Float64Array(N + 1), py = new Float64Array(N + 1), d1 = new Float64Array(N + 1), d2 = new Float64Array(N + 1);
  legendre(N, x, px, d1, d2);
  legendre(N, y, py, d1, d2);
  return { px, py };
}

/** A mode's exact value at the point basisAt() was evaluated for (strike and bow points). */
export function evalMode(m: PlateMode, b: { px: Float64Array; py: Float64Array }) {
  let v = 0;
  for (let a = 0; a < m.c.length; a++) v += m.c[a] * b.px[m.ii[a]] * b.py[m.jj[a]];
  return v;
}
