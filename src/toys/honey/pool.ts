// The honey already down: a height field over the toast (or pancake) and the plate around it.
// Buried thread edges are splatted in with their exact volume, then the film spreads as a viscous
// gravity current (lubrication flow, Huppert 1982): flux = -(ρ g h³ / 3μ) ∇(h + b), where b is the
// bread's own surface, so honey runs off crust ridges and pools in the pores. Films thinner than the
// crumb's roughness are pinned (a stand-in for contact-line pinning, not from the paper). Bread
// soaks a little of it up, which darkens the crumb. Coordinates are toast-local metres, y up, top of toast at 0.

export type Base = 'toast' | 'pancake';

/** Film depths (m) between which the contact line goes from pinned to free. */
const PIN0 = 0.00035;
const PIN1 = 0.0009;

export class Pool {
  readonly N: number;
  readonly half: number;
  readonly dx: number;
  /** Honey depth (m). */
  readonly h: Float32Array;
  /** How much the bread under each cell has soaked (0..1). */
  readonly soak: Float32Array;
  /** Bare surface height (m): toast top ~0, plate at -thickness. */
  readonly b: Float32Array;
  /** 1 on bread, 0 on the plate. */
  readonly bread: Uint8Array;
  base: Base = 'toast';
  thickness = 0.012;
  mu = 10;
  rho = 1420;
  soakRate = 0.05;
  /** Cells touched since the last upload: [i0, j0, i1, j1] inclusive. */
  dirty: [number, number, number, number] = [0, 0, -1, -1];
  /** Honey extent: the spreading step only visits this box (plus a margin). */
  private box: [number, number, number, number] = [1, 1, 0, 0];
  /** Where the film is deep enough to flow. */
  private mbox: [number, number, number, number] = [1, 1, 0, 0];
  private tick = 0;
  private acc = 0;
  // Line-solve scratch.
  private readonly fx: Float32Array;
  private readonly fz: Float32Array;
  private readonly out: Float32Array;
  volume = 0;
  /** Deepest honey (m), refreshed each step and on deposits. */
  peak = 0;

  constructor(N = 256, half = 0.064) {
    this.N = N;
    this.half = half;
    this.dx = (2 * half) / N;
    this.h = new Float32Array(N * N);
    this.soak = new Float32Array(N * N);
    this.b = new Float32Array(N * N);
    this.bread = new Uint8Array(N * N);
    this.fx = new Float32Array(N);
    this.fz = new Float32Array(N);
    this.out = new Float32Array(N);
    this.setBase('toast');
  }

  /** Signed distance to the bread's outline (m, negative inside). */
  sdf(x: number, z: number) {
    if (this.base === 'pancake') return Math.hypot(x, z) - 0.056;
    // A slice of sandwich bread: rounded square with a domed top edge.
    const hx = 0.048, hz = 0.046, r = 0.012;
    // The far (crown) end is a little wider, like a real loaf's top.
    const qx = Math.abs(x) - hx + r - (z < 0 ? 0.004 * Math.min(1, -z / hz) : 0);
    const qz = Math.abs(z) - hz + r;
    return Math.hypot(Math.max(qx, 0), Math.max(qz, 0)) + Math.min(Math.max(qx, qz), 0) - r;
  }

  setBase(base: Base) {
    this.base = base;
    this.thickness = base === 'toast' ? 0.012 : 0.009;
    const { N, dx, half } = this;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const x = -half + (i + 0.5) * dx, z = -half + (j + 0.5) * dx;
        const d = this.sdf(x, z);
        const k = j * N + i;
        if (d > 0) {
          this.b[k] = -this.thickness;
          this.bread[k] = 0;
          continue;
        }
        this.bread[k] = 1;
        // A rounded top edge (the renderer drops the rest of the side as a clean vertical wall),
        // then the crumb: pores and a gentle crown.
        const edge = Math.min(1, -d / 0.0025);
        const shoulder = -this.thickness * 0.3 * (1 - Math.sqrt(Math.max(0, 1 - (1 - edge) ** 2)));
        let tex: number;
        if (base === 'toast') {
          // Open pores (sparse holes of mixed size) and a fine crumb roughness.
          const pores = -0.00045 * smooth(0.56, 0.76, fbm(x * 650, z * 650, 3)) - 0.00012 * smooth(0.5, 0.8, fbm(x * 1900 + 5, z * 1900, 2));
          const crust = d > -0.006 ? 0.0004 * smooth(-0.006, -0.0035, d) : 0;
          tex = pores + crust + 0.0008 * (1 - (x * x + z * z) / 0.0025);
        } else {
          // Pancake: a smooth crown with a few shallow bubble dimples.
          const dimples = Math.max(0, fbm(x * 420 + 7, z * 420, 2) - 0.35) * -0.0005;
          tex = dimples + 0.001 * (1 - (x * x + z * z) / 0.0031);
        }
        this.b[k] = shoulder + tex * edge;
      }
    this.clear();
  }

  clear() {
    this.h.fill(0);
    this.soak.fill(0);
    this.volume = 0;
    this.peak = 0;
    this.box = [1, 1, 0, 0];
    this.mbox = [1, 1, 0, 0];
    this.dirty = [0, 0, this.N - 1, this.N - 1];
  }

  /** Surface height (bread + honey) at local (x, z), bilinear. */
  height(x: number, z: number) {
    const { N, dx, half } = this;
    const fx = (x + half) / dx - 0.5, fz = (z + half) / dx - 0.5;
    if (fx < 0 || fz < 0 || fx >= N - 1 || fz >= N - 1) return -this.thickness;
    const i = fx | 0, j = fz | 0, u = fx - i, v = fz - j;
    const k = j * N + i;
    const B = this.b, H = this.h;
    const a = B[k] + H[k], b = B[k + 1] + H[k + 1];
    const c = B[k + N] + H[k + N], d = B[k + N + 1] + H[k + N + 1];
    return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
  }

  /** Honey depth at local (x, z), nearest cell. */
  depth(x: number, z: number) {
    const { N, dx, half } = this;
    const i = Math.floor((x + half) / dx), j = Math.floor((z + half) / dx);
    if (i < 0 || j < 0 || i >= N || j >= N) return 0;
    return this.h[j * N + i];
  }

  /** Lay a buried thread edge into the film as a Gaussian ridge holding exactly `vol`. */
  deposit(x0: number, z0: number, x1: number, z1: number, vol: number, a: number) {
    this.splat(this.h, x0, z0, x1, z1, vol, a);
    this.volume += vol;
  }

  private splat(f: Float32Array, x0: number, z0: number, x1: number, z1: number, vol: number, a: number) {
    const { N, dx, half } = this;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const steps = Math.max(1, Math.ceil(len / (dx * 0.7)));
    const sig = Math.max(a * 0.9, dx * 0.6);
    const R = Math.min(4, Math.ceil((2.2 * sig) / dx));
    const inv = 1 / (2 * sig * sig);
    for (let s = 0; s < steps; s++) {
      const t = (s + 0.5) / steps;
      const x = x0 + (x1 - x0) * t, z = z0 + (z1 - z0) * t;
      const ci = Math.floor((x + half) / dx), cj = Math.floor((z + half) / dx);
      if (ci < R || cj < R || ci >= N - R || cj >= N - R) continue;
      let sum = 0;
      for (let j = -R; j <= R; j++)
        for (let i = -R; i <= R; i++) {
          const px = -half + (ci + i + 0.5) * dx - x, pz = -half + (cj + j + 0.5) * dx - z;
          sum += Math.exp(-(px * px + pz * pz) * inv);
        }
      const k = vol / steps / (sum * dx * dx);
      for (let j = -R; j <= R; j++)
        for (let i = -R; i <= R; i++) {
          const px = -half + (ci + i + 0.5) * dx - x, pz = -half + (cj + j + 0.5) * dx - z;
          const q = (cj + j) * N + ci + i;
          const v = f[q] + k * Math.exp(-(px * px + pz * pz) * inv);
          f[q] = v;
          if (v > this.peak) this.peak = v;
        }
      this.grow(ci - R, cj - R, ci + R, cj + R);
    }
  }

  /** Extend the honey extent and the upload rect (and the mobile box, for fresh deposits). */
  private grow(i0: number, j0: number, i1: number, j1: number, mobile = true) {
    extend(this.box, i0, j0, i1, j1);
    extend(this.dirty, i0, j0, i1, j1);
    if (mobile) extend(this.mbox, i0, j0, i1, j1);
  }

  /**
   * Spread and soak for dt seconds. The film equation is stiff where honey is deep (D ~ h³), so it
   * is stepped implicitly, one direction at a time (x rows, then z columns): each line is a
   * tridiagonal solve with the face diffusivities frozen at the start of the step.
   */
  step(dt: number) {
    const b = this.box;
    if (b[2] < b[0]) return;
    const { N, h } = this;
    // Only film deep enough to move is swept (pinned film can't flow); its box is kept up to date
    // cheaply each frame, and the whole-extent bookkeeping (soak, volume) runs every 8th frame.
    const m = this.mbox;
    if (m[2] >= m[0]) {
      const i0 = Math.max(3, m[0] - 2), j0 = Math.max(3, m[1] - 2), i1 = Math.min(N - 4, m[2] + 2), j1 = Math.min(N - 4, m[3] + 2);
      const K = ((this.rho * 9.81) / (3 * this.mu)) * dt / (this.dx * this.dx);
      for (let j = j0; j <= j1; j++) this.sweep(j * N + i0, 1, i1 - i0 + 1, K);
      for (let i = i0; i <= i1; i++) this.sweep(j0 * N + i, N, j1 - j0 + 1, K);
      let hmax = 0, a0 = N, b0 = N, a1 = -1, b1 = -1;
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const d = h[j * N + i];
          if (d > hmax) hmax = d;
          if (d > PIN0) {
            if (i < a0) a0 = i;
            if (i > a1) a1 = i;
            if (j < b0) b0 = j;
            if (j > b1) b1 = j;
          }
        }
      this.peak = hmax;
      if (a1 >= 0) set4(this.mbox, a0, b0, a1, b1);
      else set4(this.mbox, 1, 1, 0, 0);
      this.grow(i0, j0, i1, j1, false);
    } else this.peak = 0;
    this.acc += dt;
    if (++this.tick % 8) return;
    const idt = this.acc;
    this.acc = 0;
    const i0 = Math.max(3, b[0] - 2), j0 = Math.max(3, b[1] - 2), i1 = Math.min(N - 4, b[2] + 2), j1 = Math.min(N - 4, b[3] + 2);
    let ni0 = N, nj0 = N, ni1 = -1, nj1 = -1;
    // Bread drinks a little; track the new extent.
    const soak = this.soak, bread = this.bread, rate = this.soakRate * 0.0002 * idt;
    let vol = 0, soaked = false;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        let d = h[k];
        if (d <= 1e-7) continue;
        if (bread[k] && soak[k] < 1) {
          const take = Math.min(d, rate * (1 - soak[k]));
          d -= take;
          h[k] = d;
          soak[k] = Math.min(1, soak[k] + take / 0.00025);
          soaked = true;
        }
        vol += d;
        if (i < ni0) ni0 = i;
        if (i > ni1) ni1 = i;
        if (j < nj0) nj0 = j;
        if (j > nj1) nj1 = j;
      }
    this.volume = vol * this.dx * this.dx;
    if (ni1 >= 0) set4(this.box, ni0, nj0, ni1, nj1);
    else set4(this.box, 1, 1, 0, 0);
    if (soaked) this.grow(i0, j0, i1, j1, false);
  }

  /**
   * Implicit Euler along one line of `m` cells starting at k0 with stride st:
   * h' - h = c⁺ (η'₊ - η') - c⁻ (η' - η'₋), η = b + h, c = K h_up³ on each face (upwind depth).
   */
  private sweep(k0: number, st: number, m: number, K: number) {
    const { h, b, fx: c, fz: dg, out: rh } = this;
    // Face coefficients c[q] between cell q and q+1 (q = 0..m-2).
    let any = false;
    for (let q = 0; q < m - 1; q++) {
      const k = k0 + q * st;
      const eL = b[k] + h[k], eR = b[k + st] + h[k + st];
      const hu = eL > eR ? h[k] : h[k + st];
      // Films thinner than the crumb's roughness are pinned (the contact line sticks on a porous,
      // rough surface), so laid ropes keep their shape while deep puddles still slump.
      const pin = hu < PIN0 ? 0 : hu > PIN1 ? 1 : ((hu - PIN0) / (PIN1 - PIN0)) ** 2;
      c[q] = hu > 1e-7 ? K * hu * hu * hu * pin : 0;
      if (c[q] > 0) any = true;
    }
    if (!any) return;
    c[m - 1] = 0;
    // Thomas: sub/super = -c, diag = 1 + c⁻ + c⁺.
    for (let q = 0; q < m; q++) {
      const k = k0 + q * st;
      const cm = q > 0 ? c[q - 1] : 0, cp = c[q];
      dg[q] = 1 + cm + cp;
      rh[q] = h[k] + (cp ? cp * (b[k + st] - b[k]) : 0) - (cm ? cm * (b[k] - b[k - st]) : 0);
    }
    for (let q = 1; q < m; q++) {
      const f = -c[q - 1] / dg[q - 1];
      dg[q] += f * c[q - 1];
      rh[q] -= f * rh[q - 1];
    }
    let next = rh[m - 1] / dg[m - 1];
    h[k0 + (m - 1) * st] = next > 0 ? next : 0;
    for (let q = m - 2; q >= 0; q--) {
      next = (rh[q] + c[q] * next) / dg[q];
      h[k0 + q * st] = next > 0 ? next : 0;
    }
  }
}

export function set4(b: number[], a: number, c: number, d: number, e: number) {
  b[0] = a; b[1] = c; b[2] = d; b[3] = e;
}

function extend(b: number[], i0: number, j0: number, i1: number, j1: number) {
  if (b[2] < b[0]) {
    b[0] = i0; b[1] = j0; b[2] = i1; b[3] = j1;
  } else {
    if (i0 < b[0]) b[0] = i0;
    if (j0 < b[1]) b[1] = j0;
    if (i1 > b[2]) b[2] = i1;
    if (j1 > b[3]) b[3] = j1;
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function hash(x: number, y: number) {
  const s = Math.sin(x * 127.1 + y * 311.7) * 43758.5453;
  return s - Math.floor(s);
}

function noise(x: number, y: number) {
  const i = Math.floor(x), j = Math.floor(y), u = x - i, v = y - j;
  const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
  const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
  return (a * (1 - su) + b * su) * (1 - sv) + (c * (1 - su) + d * su) * sv;
}

export function fbm(x: number, y: number, oct: number) {
  let s = 0, a = 0.5, f = 1;
  for (let o = 0; o < oct; o++) {
    s += a * noise(x * f, y * f);
    f *= 2.03;
    a *= 0.5;
  }
  return s;
}
