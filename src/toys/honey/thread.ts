// A falling viscous thread as a discrete viscous rod, after Bergou, Audoly, Vouga, Wardetzky and
// Grinspun (2010): a viscous thread behaves like an elastic rod whose rest shape is its own shape a
// moment ago, so every "stiffness" becomes a viscosity times a strain rate. Here that runs as XPBD
// with the rest state reset every substep:
//   stretching: 3μA (Trouton) on each edge's length rate
//   bending:    3μI on each vertex's turning-angle rate
// both solved together, exactly, by a banded direct solve.
// Each edge carries a fixed volume, so its radius follows from its length (mass is conserved as the
// thread thins). Nodes are born at the nozzle, split as they stretch, stick where they land, and are
// handed to the pool once buried under newer coils. Twisting viscosity is optional (see `twist`).
// Units: metres, seconds, kilograms. Node 0 is the oldest (the landed end); the last is at the nozzle.

export const FREE = 0;
export const NOZZLE = 1;
export const STUCK = 2;

export interface ThreadHost {
  /** World height of whatever is under (x, z): toast, plate or honey already down. */
  surface(x: number, z: number): number;
  /** A node came to rest here, moving at `speed` m/s; `a` is its radius. */
  land(x: number, z: number, speed: number, a: number, fromBreak: boolean): void;
  /** A landed edge buried under the newer coils: hand its volume to the pool. */
  bake(x0: number, z0: number, x1: number, z1: number, vol: number, a: number): void;
  /** The thread snapped at height y. */
  snap(x: number, y: number, z: number, a: number): void;
}

const G = 9.81;
/** Landed nodes kept in the rod below the live thread, at least (they clamp its landing end). */
const KEEP = 5;

export class Thread {
  readonly cap: number;
  n = 0;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly z: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly vz: Float64Array;
  readonly kind: Uint8Array;
  /** Nozzle nodes: distance below the nozzle along the pour. */
  readonly ext: Float64Array;
  /** Edge i joins node i and i+1: its volume (m³) and whether it has snapped. */
  readonly vol: Float64Array;
  readonly cut: Uint8Array;
  /** Set on a free node that came loose in a snap until it lands (for the drip sound). */
  readonly drip: Uint8Array;
  /** Sim time each node landed. */
  readonly tland: Float64Array;
  /** Material spin rate about the axis at each vertex (rad/s): the twist degree of freedom. */
  readonly spin: Float64Array;
  /**
   * Twisting viscosity (μJ, J = 2I) with a quasi-static material spin. Off by default: the bend rest
   * frame is then carried by minimal rotation (no spin about the axis), which reproduces the coiling
   * regimes; with it on, this discretisation folds in a plane at some heights instead of coiling.
   */
  twist = false;

  mu = 10;
  rho = 1420;
  /** Target node spacing, m. */
  ds = 0.7e-3;
  /** Nozzle (neck) radius, m, and volume flux, m³/s. */
  a0 = 1.6e-3;
  Q = 0;
  /** A thread thinner than this pinches off. */
  aBreak = 0.035e-3;
  /** A node sticks once its centre is within this many radii of the surface (1 = touching). */
  touch = 1;
  /** Linearised solves per substep (1 matches 2 to within measurement noise; see the report). */
  iters = 1;
  /** Substeps: no node moves more than cfl × ds per substep, up to maxSub. */
  cfl = 0.5;
  maxSub = 32;
  /** Spacing grows to this multiple of ds high above the landing point, where the thread is straight. */
  coarse = 2.5;
  /** Upper bound on the surface height anywhere (set by the host each frame): contact tests skip nodes above it. */
  ceiling = 0.02;
  /** Last frame's substep count and fastest node (for the HUD). */
  substeps = 0;
  vmax = 0;
  time = 0;

  /** First node the solver moves this substep. */
  private s0 = 0;
  // Nozzle this substep and its velocity.
  private nx = 0;
  private ny = 0;
  private nz = 0;
  private nvx = 0;
  private nvy = 0;
  private nvz = 0;

  // Scratch.
  private readonly px: Float64Array;
  private readonly py: Float64Array;
  private readonly pz: Float64Array;
  private readonly w: Float64Array;
  private readonly L: Float64Array;
  private readonly lam: Float64Array;
  private readonly th0: Float64Array;
  private readonly gx: Float64Array;
  private readonly gy: Float64Array;
  private readonly gz: Float64Array;
  private readonly alpha: Float64Array;
  private readonly rest: Float64Array;
  private readonly band: Float64Array;
  private readonly rhs: Float64Array;
  private readonly tmp: Float64Array;
  /** Twist scratch per vertex: t̄ (3), transported u (3), bend stiffness × |w|², and ∂ terms. */
  private readonly tw: Float64Array;

  constructor(cap = 1600) {
    this.cap = cap;
    const f = () => new Float64Array(cap);
    this.x = f(); this.y = f(); this.z = f();
    this.vx = f(); this.vy = f(); this.vz = f();
    this.ext = f(); this.vol = f();
    this.kind = new Uint8Array(cap);
    this.cut = new Uint8Array(cap);
    this.drip = new Uint8Array(cap);
    this.tland = f();
    this.spin = f();
    this.tw = new Float64Array(8 * cap);
    this.px = f(); this.py = f(); this.pz = f();
    this.w = f(); this.L = f();
    this.lam = new Float64Array(3 * cap); this.th0 = f(); this.rest = new Float64Array(7 * cap);
    this.gx = new Float64Array(9 * cap); this.gy = new Float64Array(9 * cap); this.gz = new Float64Array(9 * cap);
    this.alpha = new Float64Array(3 * cap); this.band = new Float64Array(24 * cap); this.rhs = new Float64Array(3 * cap);
    this.tmp = new Float64Array((cap * 2 + 2) * 13);
  }

  clear() {
    this.n = 0;
  }

  /** Radius of edge e from its volume and current length. */
  edgeRadius(e: number) {
    const l = Math.max(0.1 * this.ds, len3(this.x[e + 1] - this.x[e], this.y[e + 1] - this.y[e], this.z[e + 1] - this.z[e]));
    return Math.sqrt(this.vol[e] / (Math.PI * l));
  }

  /** Radius at node i: the mean cross-section of the (unbroken) edges either side. */
  nodeRadius(i: number) {
    let A = 0, k = 0;
    if (i > 0 && !this.cut[i - 1]) {
      A += this.edgeRadius(i - 1) ** 2;
      k++;
    }
    if (i < this.n - 1 && !this.cut[i]) {
      A += this.edgeRadius(i) ** 2;
      k++;
    }
    return k ? Math.sqrt(A / k) : this.drip[i] || this.kind[i] === NOZZLE ? this.a0 * 0.5 : 0.1e-3;
  }

  /** Slide everything already landed (the toast moved under it). */
  shiftStuck(dx: number, dz: number) {
    for (let i = 0; i < this.n; i++)
      if (this.kind[i] === STUCK) {
        this.x[i] += dx;
        this.z[i] += dz;
      }
  }

  /**
   * Advance one frame. The nozzle moves linearly from (x0,y0,z0) to (x1,y1,z1) over the frame, and
   * the pour leaves it straight down at Q / (π a0²).
   */
  step(dt: number, x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, host: ThreadHost) {
    let vmax = len3(x1 - x0, y1 - y0, z1 - z0) / dt + this.Q / (Math.PI * this.a0 * this.a0);
    for (let i = 0; i < this.n; i++) if (this.kind[i] === FREE) vmax = Math.max(vmax, len3(this.vx[i], this.vy[i], this.vz[i]));
    this.vmax = vmax;
    // Substeps so no node moves more than a third of a spacing: the coil at the landing point is resolved.
    const nsub = Math.min(this.maxSub, Math.max(6, Math.ceil((dt * vmax) / (this.cfl * this.ds))));
    this.substeps = nsub;
    const h = dt / nsub;
    this.nvx = (x1 - x0) / dt;
    this.nvy = (y1 - y0) / dt;
    this.nvz = (z1 - z0) / dt;
    for (let s = 1; s <= nsub; s++) {
      const f = s / nsub;
      this.nx = x0 + (x1 - x0) * f;
      this.ny = y0 + (y1 - y0) * f;
      this.nz = z0 + (z1 - z0) * f;
      this.substep(h, host);
      this.time += h;
    }
    this.snapThin(host);
    this.resample(host);
    this.bake(host);
    // Belt and braces: a degenerate step (a dipper buried in its own heap) must not poison the rod.
    for (let i = 0; i < this.n; i++)
      if (!Number.isFinite(this.x[i] + this.y[i] + this.z[i] + this.vx[i] + this.vy[i] + this.vz[i])) {
        this.n = 0;
        break;
      }
  }

  private substep(h: number, host: ThreadHost) {
    this.extrude(h);
    const n = this.n;
    if (n < 2) return;
    const { x, y, z, vx, vy, vz, px, py, pz, w, L, kind, vol } = this;
    // Only the rod from just below the first unlanded node moves; the laid rope before it is fixed.
    let s0 = 0;
    while (s0 < n && kind[s0] === STUCK) s0++;
    s0 = Math.max(0, s0 - 2);
    this.s0 = s0;
    // Start-of-substep state: the viscous "rest" shape.
    for (let i = s0; i < n; i++) {
      px[i] = x[i];
      py[i] = y[i];
      pz[i] = z[i];
    }
    for (let e = s0; e < n - 1; e++) L[e] = Math.max(1e-7, len3(x[e + 1] - x[e], y[e + 1] - y[e], z[e + 1] - z[e]));
    this.bendRest();
    // Lumped masses; nozzle and landed nodes are kinematic.
    for (let i = s0; i < n; i++) {
      const m = this.rho * 0.5 * ((i > 0 ? vol[i - 1] : 0) + (i < n - 1 ? vol[i] : 0));
      w[i] = kind[i] === FREE && m > 0 ? 1 / m : 0;
    }
    // Predict: gravity and a little air drag.
    const drag = 1 / (1 + 0.4 * h);
    const U0 = this.Q / (Math.PI * this.a0 * this.a0);
    for (let i = s0; i < n; i++) {
      if (kind[i] === FREE) {
        vy[i] -= G * h;
        vx[i] *= drag;
        vy[i] *= drag;
        vz[i] *= drag;
        x[i] += vx[i] * h;
        y[i] += vy[i] * h;
        z[i] += vz[i] * h;
      } else if (kind[i] === NOZZLE) {
        x[i] = this.nx;
        y[i] = this.ny - this.ext[i];
        z[i] = this.nz;
        vx[i] = this.nvx;
        vy[i] = this.nvy - U0;
        vz[i] = this.nvz;
      }
    }
    this.lam.fill(0, 3 * s0, 3 * n);
    for (let it = 0; it < this.iters; it++) {
      this.solveDirect(h);
      if (this.twist) this.solveTwist(h);
    }
    // Contact: honey sticks where it lands (no slip on toast or on the pile).
    const ceil = this.ceiling;
    for (let i = s0; i < n; i++) {
      if (kind[i] !== FREE || y[i] > ceil + 0.01) continue;
      // Touch down when the thread's underside meets the surface. A thread squashed far thicker
      // than it left the nozzle is a heap, not a rope: it touches down at thread scale and spreads.
      const a = this.nodeRadius(i);
      const sy = host.surface(x[i], z[i]);
      const s = sy + Math.min(a, 1.5e-3) * this.touch;
      // Squashed into a blob against the surface (a short, thick pour): it flows out into the heap.
      if (y[i] < s || (a > 2.5e-3 && y[i] - sy < 1.5 * a)) {
        const sp = len3((x[i] - px[i]) / h, (y[i] - py[i]) / h, (z[i] - pz[i]) / h);
        y[i] = Math.max(y[i], s);
        kind[i] = STUCK;
        vx[i] = vy[i] = vz[i] = 0;
        this.tland[i] = this.time;
        host.land(x[i], z[i], sp, a, this.drip[i] === 1);
        this.drip[i] = 0;
      }
    }
    for (let i = s0; i < n; i++) {
      if (kind[i] !== FREE) continue;
      vx[i] = (x[i] - px[i]) / h;
      vy[i] = (y[i] - py[i]) / h;
      vz[i] = (z[i] - pz[i]) / h;
    }
  }

  /** Honey leaves the nozzle: nozzle nodes slide down at the pour speed and are let go two spacings out. */
  private extrude(h: number) {
    const U0 = this.Q / (Math.PI * this.a0 * this.a0);
    const ds = this.ds;
    const { kind, ext } = this;
    if (this.n === 0 || kind[this.n - 1] !== NOZZLE) {
      if (this.Q <= 0 || this.n >= this.cap - 2) return;
      // A fresh neck at the nozzle (first pour, or after the thread pinched off at the top).
      this.addNode(this.nx, this.ny, this.nz, NOZZLE, 0);
      if (this.n > 1) this.cut[this.n - 2] = 1;
    }
    for (let i = this.n - 1; i >= 0 && kind[i] === NOZZLE; i--) ext[i] += U0 * h;
    // New node at the nozzle once the top one has moved a spacing down.
    const top = this.n - 1;
    if (ext[top] >= ds && this.n < this.cap - 2) {
      this.addNode(this.nx, this.ny, this.nz, NOZZLE, ext[top] - ds);
      this.vol[top] = Math.PI * this.a0 * this.a0 * ds;
      this.cut[top] = 0;
    }
    for (let i = this.n - 1; i >= 0 && kind[i] !== FREE; i--) {
      if (kind[i] === NOZZLE && ext[i] > 2 * ds) {
        kind[i] = FREE;
        // A whisker of sideways noise, as from air and an uneven neck: a perfectly straight thread
        // could never pick a direction to buckle in.
        this.vx[i] = this.nvx + (Math.random() - 0.5) * 2e-4;
        this.vy[i] = this.nvy - U0;
        this.vz[i] = this.nvz + (Math.random() - 0.5) * 2e-4;
      }
      if (kind[i] === STUCK) break;
    }
  }

  private addNode(x: number, y: number, z: number, k: number, ext: number) {
    const i = this.n++;
    this.x[i] = x;
    this.y[i] = y - ext;
    this.z[i] = z;
    this.vx[i] = this.vy[i] = this.vz[i] = 0;
    this.kind[i] = k;
    this.ext[i] = ext;
    this.vol[i] = 0;
    this.cut[i] = 0;
    this.drip[i] = 0;
    this.spin[i] = 0;
  }

  /** Turning angle at node i between its two edges (0 = straight). */
  private angle(i: number) {
    const { x, y, z } = this;
    if (this.cut[i - 1] || this.cut[i]) return 0;
    const ax = x[i] - x[i - 1], ay = y[i] - y[i - 1], az = z[i] - z[i - 1];
    const bx = x[i + 1] - x[i], by = y[i + 1] - y[i], bz = z[i + 1] - z[i];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    return Math.atan2(len3(cx, cy, cz), ax * bx + ay * by + az * bz);
  }

  /**
   * Rest state for bending: each vertex's curvature binormal κb at the start of the substep, stored in
   * a frame (t̄0, u0) so it can be carried along as the vertex turns.
   */
  private bendRest() {
    const { x, y, z, n, cut, rest } = this;
    for (let i = Math.max(1, this.s0); i < n - 1; i++) {
      const o = i * 7;
      rest[o + 6] = 0;
      if (cut[i - 1] || cut[i]) continue;
      const e0x = x[i] - x[i - 1], e0y = y[i] - y[i - 1], e0z = z[i] - z[i - 1];
      const e1x = x[i + 1] - x[i], e1y = y[i + 1] - y[i], e1z = z[i + 1] - z[i];
      const l0 = len3(e0x, e0y, e0z), l1 = len3(e1x, e1y, e1z);
      if (l0 < 1e-9 || l1 < 1e-9) continue;
      let tx = e0x / l0 + e1x / l1, ty = e0y / l0 + e1y / l1, tz = e0z / l0 + e1z / l1;
      const tl = len3(tx, ty, tz);
      if (tl < 1e-6) continue;
      tx /= tl; ty /= tl; tz /= tl;
      const D = l0 * l1 + e0x * e1x + e0y * e1y + e0z * e1z;
      const kx = (2 * (e0y * e1z - e0z * e1y)) / D, ky = (2 * (e0z * e1x - e0x * e1z)) / D, kz = (2 * (e0x * e1y - e0y * e1x)) / D;
      const kl = len3(kx, ky, kz);
      let ux: number, uy: number, uz: number;
      if (kl > 1e-9) {
        ux = kx / kl; uy = ky / kl; uz = kz / kl;
      } else {
        // Straight: any direction across the tangent.
        const ax = Math.abs(tx) < 0.9 ? 1 : 0, ay = ax ? 0 : 1;
        ux = ay * tz; uy = -ax * tz; uz = ax * ty - ay * tx;
        const ul = len3(ux, uy, uz);
        ux /= ul; uy /= ul; uz /= ul;
      }
      rest[o] = tx; rest[o + 1] = ty; rest[o + 2] = tz;
      rest[o + 3] = ux; rest[o + 4] = uy; rest[o + 5] = uz;
      rest[o + 6] = kl;
    }
  }

  /**
   * One linearised XPBD solve of every stretch and bend constraint together, exactly. Rows ordered
   * edge, vertex(2), edge, vertex(2)... make the system banded (half-bandwidth 7), so a banded
   * Cholesky factorisation solves it in O(n) (in the spirit of Deul et al.'s direct rod solver).
   * Viscous bending is near-rigid within a substep at these scales, which Gauss-Seidel can't converge.
   *   stretch e: C = |x_{e+1} - x_e| - L_e,         compliance L_e / (3μ A_e) / h
   *   bend i:    C = (κb - κb_rest) across t̄ (2 rows), compliance l_i / (3μ I_i) / h,  I = A² / 4π
   * The rest curvature rides in a frame carried by minimal rotation from the start-of-substep tangent,
   * so a rigidly turning coil costs nothing but a swivelling bend plane does (twist itself is not a DOF).
   */
  private solveDirect(h: number) {
    const n = this.n, M = 3 * n - 5, r0 = 3 * this.s0;
    if (M - r0 < 1) return;
    const { x, y, z, w, L, lam, vol, cut, gx, gy, gz, band, rhs, alpha, rest } = this;
    const k = 1 / (3 * this.mu * h);
    const P = 7, B = P + 1;
    for (let r = r0; r < M; r++) {
      const o = r * 3;
      gx[o] = gy[o] = gz[o] = gx[o + 1] = gy[o + 1] = gz[o + 1] = gx[o + 2] = gy[o + 2] = gz[o + 2] = 0;
      alpha[r] = 1;
      rhs[r] = 0;
    }
    for (let g = this.s0; g <= n - 2; g++) {
      // Stretch row for edge g.
      const e = g, rs = 3 * g;
      if (!(cut[e] || vol[e] <= 0 || w[e] + w[e + 1] === 0)) {
        const dx = x[e + 1] - x[e], dy = y[e + 1] - y[e], dz = z[e + 1] - z[e];
        const l = Math.max(1e-9, len3(dx, dy, dz));
        const o = rs * 3;
        gx[o] = -dx / l; gy[o] = -dy / l; gz[o] = -dz / l;
        gx[o + 1] = dx / l; gy[o + 1] = dy / l; gz[o + 1] = dz / l;
        const at = (L[e] * L[e] * k) / vol[e];
        alpha[rs] = at;
        rhs[rs] = -(l - L[e]) - at * lam[rs];
      }
      // Two bend rows for vertex i = g + 1.
      const i = g + 1;
      if (i > n - 2 || rest[i * 7 + 6] < 0 || cut[i - 1] || cut[i] || w[i - 1] + w[i] + w[i + 1] === 0) continue;
      const e0x = x[i] - x[i - 1], e0y = y[i] - y[i - 1], e0z = z[i] - z[i - 1];
      const e1x = x[i + 1] - x[i], e1y = y[i + 1] - y[i], e1z = z[i + 1] - z[i];
      const l0 = len3(e0x, e0y, e0z), l1 = len3(e1x, e1y, e1z);
      if (l0 < 1e-9 || l1 < 1e-9) continue;
      let tx = e0x / l0 + e1x / l1, ty = e0y / l0 + e1y / l1, tz = e0z / l0 + e1z / l1;
      const tl = len3(tx, ty, tz);
      if (tl < 1e-6) continue;
      tx /= tl; ty /= tl; tz /= tl;
      // Carry the rest frame from the start tangent to this one by minimal rotation.
      const q = i * 7;
      const ax = rest[q], ay = rest[q + 1], az = rest[q + 2];
      let ux = rest[q + 3], uy = rest[q + 4], uz = rest[q + 5];
      const c = ax * tx + ay * ty + az * tz;
      if (c > -0.99) {
        const kx = ay * tz - az * ty, ky = az * tx - ax * tz, kz = ax * ty - ay * tx;
        const ku = kx * ux + ky * uy + kz * uz, f = ku / (1 + c);
        const rx = ux * c + (ky * uz - kz * uy) + kx * f;
        const ry = uy * c + (kz * ux - kx * uz) + ky * f;
        const rz = uz * c + (kx * uy - ky * ux) + kz * f;
        ux = rx; uy = ry; uz = rz;
      }
      // Re-orthogonalise against t̄; v completes the frame.
      const ut = ux * tx + uy * ty + uz * tz;
      ux -= ut * tx; uy -= ut * ty; uz -= ut * tz;
      const ul = len3(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const D = l0 * l1 + e0x * e1x + e0y * e1y + e0z * e1z;
      if (D < 1e-12) continue;
      const kbx = (2 * (e0y * e1z - e0z * e1y)) / D, kby = (2 * (e0z * e1x - e0x * e1z)) / D, kbz = (2 * (e0x * e1y - e0y * e1x)) / D;
      const g0x = (l1 / l0) * e0x + e1x, g0y = (l1 / l0) * e0y + e1y, g0z = (l1 / l0) * e0z + e1z;
      const g1x = (l0 / l1) * e1x + e0x, g1y = (l0 / l1) * e1y + e0y, g1z = (l0 / l1) * e1z + e0z;
      const A = 0.5 * (vol[i - 1] / L[i - 1] + vol[i] / L[i]);
      const at = (0.5 * (L[i - 1] + L[i]) * k * 4 * Math.PI) / (A * A);
      // The rest curvature also turns with the material's own spin about the axis (twist DOF).
      const c1 = rest[q + 6], ph = this.twist ? this.spin[i] * h : 0;
      const r0x = c1 * Math.cos(ph), r0y = c1 * Math.sin(ph);
      for (let row = 0; row < 2; row++) {
        const px = row ? vx : ux, py = row ? vy : uy, pz = row ? vz : uz;
        const r = rs + 1 + row, o = r * 3;
        const pk = px * kbx + py * kby + pz * kbz;
        // Row gradients: wrt e0: (2 e1×p - (p·κb) g0)/D; wrt e1: (2 p×e0 - (p·κb) g1)/D.
        const G0x = (2 * (e1y * pz - e1z * py) - pk * g0x) / D, G0y = (2 * (e1z * px - e1x * pz) - pk * g0y) / D, G0z = (2 * (e1x * py - e1y * px) - pk * g0z) / D;
        const G1x = (2 * (py * e0z - pz * e0y) - pk * g1x) / D, G1y = (2 * (pz * e0x - px * e0z) - pk * g1y) / D, G1z = (2 * (px * e0y - py * e0x) - pk * g1z) / D;
        gx[o] = -G0x; gy[o] = -G0y; gz[o] = -G0z;
        gx[o + 1] = G0x - G1x; gy[o + 1] = G0y - G1y; gz[o + 1] = G0z - G1z;
        gx[o + 2] = G1x; gy[o + 2] = G1y; gz[o + 2] = G1z;
        alpha[r] = at;
        rhs[r] = -(pk - (row ? r0y : r0x)) - at * lam[r];
      }
    }
    // Banded J W Jᵀ + α̃ (lower band: band[r*B + d] = A(r, r-d)). Row r touches nodes g..g+1 or g..g+2.
    for (let r = r0; r < M; r++) {
      const n0 = (r / 3) | 0, n1 = n0 + (r % 3 === 0 ? 1 : 2);
      for (let d = 0; d <= P && d <= r - r0; d++) {
        const r2 = r - d;
        const m0 = (r2 / 3) | 0, m1 = m0 + (r2 % 3 === 0 ? 1 : 2);
        let sum = d === 0 ? alpha[r] : 0;
        const lo = Math.max(n0, m0), hi = Math.min(n1, m1);
        for (let q = lo; q <= hi; q++) {
          const wq = w[q];
          if (wq === 0) continue;
          const a1 = r * 3 + q - n0, a2 = r2 * 3 + q - m0;
          sum += wq * (gx[a1] * gx[a2] + gy[a1] * gy[a2] + gz[a1] * gz[a2]);
        }
        band[r * B + d] = sum;
      }
    }
    // Banded Cholesky in place, then the two triangular solves.
    for (let r = r0; r < M; r++) {
      for (let d = Math.min(P, r - r0); d >= 0; d--) {
        const j = r - d;
        let sum = band[r * B + d];
        for (let kk = Math.max(r - P, j - P, r0); kk < j; kk++) sum -= band[r * B + (r - kk)] * band[j * B + (j - kk)];
        band[r * B + d] = d === 0 ? Math.sqrt(Math.max(sum, 1e-30)) : sum / band[j * B];
      }
    }
    for (let r = r0; r < M; r++) {
      let sum = rhs[r];
      for (let kk = Math.max(r0, r - P); kk < r; kk++) sum -= band[r * B + (r - kk)] * rhs[kk];
      rhs[r] = sum / band[r * B];
    }
    for (let r = M - 1; r >= r0; r--) {
      let sum = rhs[r];
      for (let kk = r + 1; kk <= Math.min(M - 1, r + P); kk++) sum -= band[kk * B + (kk - r)] * rhs[kk];
      rhs[r] = sum / band[r * B];
    }
    // Apply: Δx = W Jᵀ Δλ.
    for (let r = r0; r < M; r++) {
      const d = rhs[r];
      if (d === 0) continue;
      lam[r] += d;
      const n0 = (r / 3) | 0, cnt = r % 3 === 0 ? 2 : 3;
      for (let q = 0; q < cnt; q++) {
        const wq = w[n0 + q];
        if (wq === 0) continue;
        const o = r * 3 + q;
        x[n0 + q] += wq * gx[o] * d;
        y[n0 + q] += wq * gy[o] * d;
        z[n0 + q] += wq * gz[o] * d;
      }
    }
  }

  /**
   * Twisting viscosity, quasi-static: after the positions move, choose each vertex's material spin
   * over the substep, φ, to minimise viscous bending (the rest curvature turns with the material)
   * plus viscous twisting μJ/(l h) (φ₊ - φ + δ)², where δ is the twist the motion itself put
   * between neighbouring frames. One tridiagonal solve; the spin rate is used in the next substep.
   */
  private solveTwist(h: number) {
    const n = this.n, s0 = Math.max(1, this.s0);
    const { x, y, z, kind, vol, cut, rest, L, tw, spin } = this;
    const bd = this.gx, cp = this.gy, dp = this.gz, bo = this.alpha, br = this.rhs;
    const k = 1 / (3 * this.mu * h);
    // Pass 1: each vertex's transported frame, and its bend stiffness × |w|² and × w·r.
    // tw[o+6]: -1 no frame (a cut), -2 fixed (nozzle or landed: no spin), else ≥ 0.
    for (let i = s0; i < n - 1; i++) {
      const o = i * 8;
      tw[o + 6] = -1;
      if (cut[i - 1] || cut[i]) continue;
      const e0x = x[i] - x[i - 1], e0y = y[i] - y[i - 1], e0z = z[i] - z[i - 1];
      const e1x = x[i + 1] - x[i], e1y = y[i + 1] - y[i], e1z = z[i + 1] - z[i];
      const l0 = len3(e0x, e0y, e0z), l1 = len3(e1x, e1y, e1z);
      if (l0 < 1e-9 || l1 < 1e-9) continue;
      let tx = e0x / l0 + e1x / l1, ty = e0y / l0 + e1y / l1, tz = e0z / l0 + e1z / l1;
      const tl = len3(tx, ty, tz);
      if (tl < 1e-6) continue;
      tx /= tl; ty /= tl; tz /= tl;
      const q = i * 7;
      const ax = rest[q], ay = rest[q + 1], az = rest[q + 2];
      let ux = rest[q + 3], uy = rest[q + 4], uz = rest[q + 5];
      const c = ax * tx + ay * ty + az * tz;
      if (c > -0.99) {
        const kx = ay * tz - az * ty, ky = az * tx - ax * tz, kz = ax * ty - ay * tx;
        const f = (kx * ux + ky * uy + kz * uz) / (1 + c);
        const rx = ux * c + (ky * uz - kz * uy) + kx * f, ry = uy * c + (kz * ux - kx * uz) + ky * f, rz = uz * c + (kx * uy - ky * ux) + kz * f;
        ux = rx; uy = ry; uz = rz;
      }
      const ut = ux * tx + uy * ty + uz * tz;
      ux -= ut * tx; uy -= ut * ty; uz -= ut * tz;
      const ul = len3(ux, uy, uz) || 1;
      ux /= ul; uy /= ul; uz /= ul;
      tw[o] = tx; tw[o + 1] = ty; tw[o + 2] = tz;
      tw[o + 3] = ux; tw[o + 4] = uy; tw[o + 5] = uz;
      tw[o + 6] = 0;
      tw[o + 7] = 0;
      if (kind[i] !== FREE) {
        tw[o + 6] = -2;
        continue;
      }
      const D = l0 * l1 + e0x * e1x + e0y * e1y + e0z * e1z;
      const c1 = rest[q + 6];
      if (D < 1e-12 || c1 < 1e-9) continue;
      const vx = ty * uz - tz * uy, vy = tz * ux - tx * uz, vz = tx * uy - ty * ux;
      const kbx = (2 * (e0y * e1z - e0z * e1y)) / D, kby = (2 * (e0z * e1x - e0x * e1z)) / D, kbz = (2 * (e0x * e1y - e0y * e1x)) / D;
      const ku = kbx * ux + kby * uy + kbz * uz, kv = kbx * vx + kby * vy + kbz * vz;
      const ph = spin[i] * h, cs = Math.cos(ph), sn = Math.sin(ph);
      // Residual r = κb⊥ - c1 (cos φ u + sin φ v); w = dκ̃/dφ = c1 (-sin φ u + cos φ v).
      const rx0 = ku - c1 * cs, ry0 = kv - c1 * sn;
      const wx = -c1 * sn, wy = c1 * cs;
      const A = 0.5 * (vol[i - 1] / L[i - 1] + vol[i] / L[i]);
      const kb = (A * A) / (0.5 * (L[i - 1] + L[i]) * k * 4 * Math.PI * h * h);
      tw[o + 6] = kb * (wx * wx + wy * wy);
      tw[o + 7] = kb * (wx * rx0 + wy * ry0);
    }
    // Pass 2: tridiagonal in Δφ over free vertices; each edge between two framed vertices twists.
    const m0 = s0, m1 = n - 2;
    if (m1 < m0) return;
    for (let i = m0; i <= m1; i++) {
      const o = i * 8, free = tw[o + 6] >= 0;
      bd[i] = free ? tw[o + 6] + 1e-30 : 1;
      br[i] = free ? tw[o + 7] : 0;
      bo[i] = 0;
    }
    for (let e = m0; e < m1; e++) {
      const a = e * 8, b = (e + 1) * 8;
      if (tw[a + 6] === -1 || tw[b + 6] === -1 || cut[e]) continue;
      const fa = tw[a + 6] >= 0, fb = tw[b + 6] >= 0;
      if (!fa && !fb) continue;
      // Twist the motion put between the two frames: reference twist now minus at the substep start.
      const qa = e * 7, qb = (e + 1) * 7;
      const t1 = refTwist(tw[a + 3], tw[a + 4], tw[a + 5], tw[a], tw[a + 1], tw[a + 2], tw[b + 3], tw[b + 4], tw[b + 5], tw[b], tw[b + 1], tw[b + 2]);
      const t0 = refTwist(rest[qa + 3], rest[qa + 4], rest[qa + 5], rest[qa], rest[qa + 1], rest[qa + 2], rest[qb + 3], rest[qb + 4], rest[qb + 5], rest[qb], rest[qb + 1], rest[qb + 2]);
      let d = t1 - t0;
      if (d > Math.PI) d -= 2 * Math.PI;
      if (d < -Math.PI) d += 2 * Math.PI;
      // Twisting viscosity μJ / (l h) on the edge between them, J = 2I = A² / 2π.
      const Ae = vol[e] / L[e];
      const kt = (this.mu * ((Ae * Ae) / (2 * Math.PI))) / (L[e] * h);
      const tau = (fb ? spin[e + 1] * h : 0) - (fa ? spin[e] * h : 0) + d;
      if (fa) {
        bd[e] += kt;
        br[e] += kt * tau;
      }
      if (fb) {
        bd[e + 1] += kt;
        br[e + 1] -= kt * tau;
      }
      if (fa && fb) bo[e] = -kt;
    }
    // Thomas on (bd, bo, br) for Δφ.
    cp[m0] = m1 > m0 ? bo[m0] / bd[m0] : 0;
    dp[m0] = br[m0] / bd[m0];
    for (let i = m0 + 1; i <= m1; i++) {
      const mm = bd[i] - bo[i - 1] * cp[i - 1];
      cp[i] = i < m1 ? bo[i] / mm : 0;
      dp[i] = (br[i] - bo[i - 1] * dp[i - 1]) / mm;
    }
    for (let i = m1 - 1; i >= m0; i--) dp[i] -= cp[i] * dp[i + 1];
    for (let i = m0; i <= m1; i++) {
      if (tw[i * 8 + 6] < 0) {
        spin[i] = 0;
        continue;
      }
      spin[i] += Math.max(-0.5, Math.min(0.5, dp[i])) / h;
    }
  }

  /** Pinch-off: an edge stretched thinner than aBreak snaps; its volume goes to its neighbours. */
  private snapThin(host: ThreadHost) {
    const n = this.n;
    const b2 = this.aBreak * this.aBreak * Math.PI;
    for (let e = 0; e < n - 1; e++) {
      if (this.cut[e] || this.kind[e] === STUCK || this.kind[e + 1] === STUCK) continue;
      const l = len3(this.x[e + 1] - this.x[e], this.y[e + 1] - this.y[e], this.z[e + 1] - this.z[e]);
      if (this.vol[e] / l > b2) continue;
      this.cut[e] = 1;
      const v = this.vol[e];
      this.vol[e] = 0;
      if (e > 0 && !this.cut[e - 1]) this.vol[e - 1] += v / 2;
      if (e < n - 2 && !this.cut[e + 1]) this.vol[e + 1] += v / 2;
      // The upper piece now ends in a free drop: mark its tip so its landing plops.
      if (this.kind[e + 1] === FREE) this.drip[e + 1] = 1;
      host.snap(this.x[e], this.y[e], this.z[e], Math.sqrt(v / (Math.PI * Math.max(l, 1e-6))));
    }
  }

  /** Split long free edges (Catmull-Rom midpoint) and merge squashed ones, keeping ~ds spacing. */
  private resample(host: ThreadHost) {
    const n = this.n;
    const { x, y, z, vx, vy, vz, kind, ext, vol, cut, drip, tmp } = this;
    // Fine spacing near the landing point (the coil), coarser up the straight falling part.
    const base = this.ds * (n > this.cap * 0.8 ? 2 : 1), extra = this.coarse - 1;
    const target = (i: number) => base * (1 + extra * smooth(0.004, 0.02, y[i] - host.surface(x[i], z[i])));
    // Pack into scratch rows: 12 values per node.
    const S = 13;
    const out = tmp;
    let m = 0;
    const put = (X: number, Y: number, Z: number, VX: number, VY: number, VZ: number, K: number, EX: number, VOL: number, CUT: number, DR: number, TL: number, LD: number) => {
      const o = m * S;
      out[o] = X; out[o + 1] = Y; out[o + 2] = Z;
      out[o + 3] = VX; out[o + 4] = VY; out[o + 5] = VZ;
      out[o + 6] = K; out[o + 7] = EX; out[o + 8] = VOL; out[o + 9] = CUT; out[o + 10] = DR;
      out[o + 11] = TL; out[o + 12] = LD;
      m++;
    };
    let changed = false;
    for (let i = 0; i < n; i++) {
      const last = i === n - 1;
      const le = last ? 0 : len3(x[i + 1] - x[i], y[i + 1] - y[i], z[i + 1] - z[i]);
      // Merge: drop a free interior node whose two edges are both short.
      if (i > 0 && !last && kind[i] === FREE && !cut[i - 1] && !cut[i] && m > 0) {
        const lp = len3(x[i] - x[i - 1], y[i] - y[i - 1], z[i] - z[i - 1]);
        if (lp + le < 0.8 * target(i) && !drip[i]) {
          out[(m - 1) * S + 8] += vol[i];
          changed = true;
          continue;
        }
      }
      put(x[i], y[i], z[i], vx[i], vy[i], vz[i], kind[i], ext[i], vol[i], cut[i], drip[i], this.tland[i], this.spin[i]);
      if (!last && !cut[i] && le > 1.5 * target(i) && (kind[i] === FREE || kind[i + 1] === FREE) && m < this.cap - 2) {
        // Catmull-Rom midpoint through the neighbours, so splitting doesn't add kinks.
        const a = i > 0 && !cut[i - 1] ? i - 1 : i, d = i + 2 < n && !cut[i + 1] ? i + 2 : i + 1;
        const mx = (9 * (x[i] + x[i + 1]) - x[a] - x[d]) / 16;
        const my = (9 * (y[i] + y[i + 1]) - y[a] - y[d]) / 16;
        const mz = (9 * (z[i] + z[i + 1]) - z[a] - z[d]) / 16;
        const o = (m - 1) * S;
        out[o + 8] = vol[i] / 2;
        put(mx, my, mz, (vx[i] + vx[i + 1]) / 2, (vy[i] + vy[i + 1]) / 2, (vz[i] + vz[i + 1]) / 2, FREE, 0, vol[i] / 2, 0, 0, 0, (this.spin[i] + this.spin[i + 1]) / 2);
        changed = true;
      }
    }
    if (!changed) return;
    const M = Math.min(m, this.cap);
    for (let j = 0; j < M; j++) {
      const o = j * S;
      x[j] = out[o]; y[j] = out[o + 1]; z[j] = out[o + 2];
      vx[j] = out[o + 3]; vy[j] = out[o + 4]; vz[j] = out[o + 5];
      kind[j] = out[o + 6]; ext[j] = out[o + 7]; vol[j] = out[o + 8]; cut[j] = out[o + 9]; drip[j] = out[o + 10];
      this.tland[j] = out[o + 11]; this.spin[j] = out[o + 12];
    }
    this.n = M;
    if (M > 0) this.vol[M - 1] = 0;
  }

  /** Start of the live thread: the run of unlanded nodes that ends at the nozzle. */
  liveStart() {
    let s = this.n;
    while (s > 0 && this.kind[s - 1] !== STUCK) s--;
    return s;
  }

  /**
   * Landed edges more than KEEP nodes below the live thread join the pool. A free node caught in the
   * pile (a loop draped over older coils) goes with them if it is lying on the surface; one still in
   * the air (a snapped tail falling) holds the bake until it lands.
   */
  private bake(host: ThreadHost) {
    const upto = this.liveStart() - KEEP;
    if (upto <= 0) return;
    let k = 0;
    // (A long laid tail means something is hung up in it: bake regardless.)
    const force = upto > 120;
    while (k < upto && (force || this.kind[k] === STUCK || this.y[k] - host.surface(this.x[k], this.z[k]) < 0.003 + 2 * this.nodeRadius(k))) k++;
    if (k <= 0) return;
    for (let e = 0; e < k; e++) {
      if (!this.cut[e] && this.vol[e] > 0) host.bake(this.x[e], this.z[e], this.x[e + 1], this.z[e + 1], this.vol[e], this.edgeRadius(e));
    }
    this.removeFront(k);
  }

  private removeFront(k: number) {
    const n = this.n;
    for (const a of [this.x, this.y, this.z, this.vx, this.vy, this.vz, this.ext, this.vol, this.tland, this.spin]) a.copyWithin(0, k, n);
    for (const a of [this.kind, this.cut, this.drip]) a.copyWithin(0, k, n);
    this.n = n - k;
  }

  /** Mean speed and radius of the thread just above the landing point (Ribe's U1 and a1). */
  contact() {
    const first = this.liveStart();
    let sp = 0, a = 0, k = 0;
    for (let i = first; i < Math.min(this.n - 1, first + 6); i++) {
      if (this.kind[i] !== FREE || this.cut[i]) continue;
      sp += len3(this.vx[i], this.vy[i], this.vz[i]);
      a += this.nodeRadius(i);
      k++;
    }
    return k ? { U1: sp / k, a1: a / k, i: first } : { U1: 0, a1: 0, i: first };
  }
}

function len3(a: number, b: number, c: number) {
  return Math.sqrt(a * a + b * b + c * c);
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/** Angle about tb from frame a's u, carried from ta to tb by minimal rotation, to frame b's u. */
function refTwist(uax: number, uay: number, uaz: number, tax: number, tay: number, taz: number, ubx: number, uby: number, ubz: number, tbx: number, tby: number, tbz: number) {
  const c = tax * tbx + tay * tby + taz * tbz;
  let ux = uax, uy = uay, uz = uaz;
  if (c > -0.99) {
    const kx = tay * tbz - taz * tby, ky = taz * tbx - tax * tbz, kz = tax * tby - tay * tbx;
    const f = (kx * ux + ky * uy + kz * uz) / (1 + c);
    const rx = ux * c + (ky * uz - kz * uy) + kx * f, ry = uy * c + (kz * ux - kx * uz) + ky * f, rz = uz * c + (kx * uy - ky * ux) + kz * f;
    ux = rx; uy = ry; uz = rz;
  }
  const cx = uy * ubz - uz * uby, cy = uz * ubx - ux * ubz, cz = ux * uby - uy * ubx;
  return Math.atan2(cx * tbx + cy * tby + cz * tbz, ux * ubx + uy * uby + uz * ubz);
}
