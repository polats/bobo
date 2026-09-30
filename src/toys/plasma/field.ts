// Electric potential on a 2D grid: Laplace's (or Poisson's, with space charge) equation
// a_x (φ_l + φ_r) + a_y (φ_u + φ_d) - 2 (a_x + a_y) φ = -ρ, solved with a warm-started geometric
// multigrid V-cycle (red-black Gauss-Seidel smoothing, cell-centred 2x2 restriction, bilinear
// prolongation) plus cheap red-black SOR sweeps between growth steps. Warm starting matters: the
// discharge changes a few cells at a time, so one V-cycle a frame keeps the field converged.
// a_x ≠ a_y models anisotropic conduction (wood conducts better along the grain).

/** Cell kinds: FREE is solved; FIXED holds its value (Dirichlet); GHOST mirrors its inner neighbour (insulating edge). */
export const FREE = 0;
export const FIXED = 1;
export const GHOST = 3;

interface Level {
  W: number;
  H: number;
  u: Float32Array;
  f: Float32Array;
  r: Float32Array;
  kind: Uint8Array;
  h2: number;
}

export class Field {
  readonly W: number;
  readonly H: number;
  readonly phi: Float32Array;
  readonly rho: Float32Array;
  readonly kind: Uint8Array;
  ax = 1;
  ay = 1;
  private res: Float32Array;
  private levels: Level[] = [];
  private coarseDirty = true;

  constructor(W: number, H: number, readonly neumann: boolean) {
    this.W = W;
    this.H = H;
    const n = W * H;
    this.phi = new Float32Array(n);
    this.rho = new Float32Array(n);
    this.kind = new Uint8Array(n);
    this.res = new Float32Array(n);
    if (neumann) this.markBorder();
    let w = W, h = H, s = 1;
    while (w % 2 === 0 && h % 2 === 0 && w >= 8 && h >= 8) {
      w /= 2;
      h /= 2;
      s *= 2;
      const m = w * h;
      this.levels.push({ W: w, H: h, u: new Float32Array(m), f: new Float32Array(m), r: new Float32Array(m), kind: new Uint8Array(m), h2: s * s });
    }
  }

  private markBorder() {
    const { W, H, kind } = this;
    for (let x = 0; x < W; x++) kind[x] = kind[(H - 1) * W + x] = GHOST;
    for (let y = 0; y < H; y++) kind[y * W] = kind[y * W + W - 1] = GHOST;
  }

  /** Call after changing which cells are FIXED; coarse masks are rebuilt lazily. */
  touch() {
    this.coarseDirty = true;
  }

  set(i: number, kind: number, value?: number) {
    if (this.kind[i] !== kind) this.coarseDirty = true;
    this.kind[i] = kind;
    if (value !== undefined) this.phi[i] = value;
  }

  /** Mirror insulating edges (zero normal flux). */
  private ghosts(u: Float32Array, W: number, H: number) {
    for (let x = 1; x < W - 1; x++) {
      u[x] = u[W + x];
      u[(H - 1) * W + x] = u[(H - 2) * W + x];
    }
    for (let y = 0; y < H; y++) {
      u[y * W] = u[y * W + 1];
      u[y * W + W - 1] = u[y * W + W - 2];
    }
  }

  /** One red-black SOR sweep on the fine grid. */
  sweep(omega = 1.7) {
    this.relax(this.phi, this.rho, this.kind, this.W, this.H, 1, omega, 1);
  }

  private relax(u: Float32Array, f: Float32Array, kind: Uint8Array, W: number, H: number, h2: number, omega: number, iters: number) {
    const ax = this.ax, ay = this.ay, inv = 1 / (2 * ax + 2 * ay);
    for (let it = 0; it < iters; it++) {
      for (let color = 0; color < 2; color++) {
        if (this.neumann) this.ghosts(u, W, H);
        for (let y = 1; y < H - 1; y++) {
          const row = y * W;
          for (let x = 1 + ((y + color) & 1); x < W - 1; x += 2) {
            const i = row + x;
            if (kind[i] !== FREE) continue;
            const g = (ax * (u[i - 1] + u[i + 1]) + ay * (u[i - W] + u[i + W]) + h2 * f[i]) * inv;
            u[i] += omega * (g - u[i]);
          }
        }
      }
    }
  }

  private residual(u: Float32Array, f: Float32Array, kind: Uint8Array, W: number, H: number, h2: number, r: Float32Array) {
    const ax = this.ax, ay = this.ay, c = 2 * ax + 2 * ay, ih2 = 1 / h2;
    if (this.neumann) this.ghosts(u, W, H);
    r.fill(0);
    for (let y = 1; y < H - 1; y++) {
      const row = y * W;
      for (let x = 1; x < W - 1; x++) {
        const i = row + x;
        if (kind[i] !== FREE) continue;
        r[i] = f[i] + (ax * (u[i - 1] + u[i + 1]) + ay * (u[i - W] + u[i + W]) - c * u[i]) * ih2;
      }
    }
  }

  private buildCoarse() {
    let fk = this.kind, fW = this.W;
    for (const L of this.levels) {
      const { W, H, kind } = L;
      for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
          const j = 2 * y * fW + 2 * x;
          // A coarse cell is held (zero correction) if any of its children is held.
          const held = fk[j] === FIXED || fk[j + 1] === FIXED || fk[j + fW] === FIXED || fk[j + fW + 1] === FIXED;
          const edge = x === 0 || y === 0 || x === W - 1 || y === H - 1;
          kind[y * W + x] = this.neumann && edge ? GHOST : held || edge ? FIXED : FREE;
        }
      fk = kind;
      fW = W;
    }
    this.coarseDirty = false;
  }

  /** One multigrid V-cycle on the error equation; warm-started from the current φ. */
  vcycle(pre = 2, post = 2) {
    if (!this.levels.length) return this.relax(this.phi, this.rho, this.kind, this.W, this.H, 1, 1.8, pre + post);
    if (this.coarseDirty) this.buildCoarse();
    this.relax(this.phi, this.rho, this.kind, this.W, this.H, 1, 1.15, pre);
    this.residual(this.phi, this.rho, this.kind, this.W, this.H, 1, this.res);
    let fr = this.res, fW = this.W;
    for (let l = 0; l < this.levels.length; l++) {
      const L = this.levels[l];
      restrict(fr, fW, L);
      L.u.fill(0);
      const last = l === this.levels.length - 1;
      this.relax(L.u, L.f, L.kind, L.W, L.H, L.h2, 1.15, last ? 30 : pre);
      if (!last) this.residual(L.u, L.f, L.kind, L.W, L.H, L.h2, L.r);
      fr = L.r;
      fW = L.W;
    }
    for (let l = this.levels.length - 1; l >= 0; l--) {
      const C = this.levels[l];
      if (l > 0) {
        const F = this.levels[l - 1];
        prolong(C, F.u, F.kind, F.W, F.H);
        this.relax(F.u, F.f, F.kind, F.W, F.H, F.h2, 1.15, post);
      } else {
        prolong(C, this.phi, this.kind, this.W, this.H);
        this.relax(this.phi, this.rho, this.kind, this.W, this.H, 1, 1.15, post);
      }
    }
  }

  /** Max |residual| over free cells (for tests). */
  maxResidual() {
    this.residual(this.phi, this.rho, this.kind, this.W, this.H, 1, this.res);
    let m = 0;
    for (let i = 0; i < this.res.length; i++) m = Math.max(m, Math.abs(this.res[i]));
    return m;
  }
}

function restrict(fr: Float32Array, fW: number, L: Level) {
  const { W, H, f, kind } = L;
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      if (kind[i] !== FREE) {
        f[i] = 0;
        continue;
      }
      const j = 2 * y * fW + 2 * x;
      f[i] = (fr[j] + fr[j + 1] + fr[j + fW] + fr[j + fW + 1]) * 0.25;
    }
}

function prolong(C: Level, u: Float32Array, kind: Uint8Array, W: number, H: number) {
  const cu = C.u, cW = C.W, cH = C.H;
  for (let y = 1; y < H - 1; y++) {
    const Y = y >> 1, sy = y & 1 ? 1 : -1;
    const Y2 = Math.min(cH - 1, Math.max(0, Y + sy));
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      if (kind[i] !== FREE) continue;
      const X = x >> 1, sx = x & 1 ? 1 : -1;
      const X2 = Math.min(cW - 1, Math.max(0, X + sx));
      u[i] += 0.5625 * cu[Y * cW + X] + 0.1875 * (cu[Y * cW + X2] + cu[Y2 * cW + X]) + 0.0625 * cu[Y2 * cW + X2];
    }
  }
}
