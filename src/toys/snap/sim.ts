// Brittle elastic rods in the plane of the screen: a discrete Kirchhoff rod (inextensible centreline,
// Euler-Bernoulli bending, a twist angle per node), explicit in time so bending waves travel at their
// true, dispersive speed. Heisser et al. 2018 show that for a planar, gently bent rod bending and
// twist decouple: the centreline obeys EI y'''' + ρA ÿ = 0 and the twist a critically damped wave
// equation. They meet in the fracture criterion, an effective stress σ² = ¼E²r²κ² + ½µ²r²θ'².
// Nothing here decides how many pieces a strand breaks into: the first crack releases the moment,
// the snap-back wave raises curvature further along, and wherever it crosses a node's strength the
// rod breaks again. Twist lowers the curvature the first crack needs, then unwinds from the new free
// ends much faster than the bending wave arrives, so the survivors meet the wave with their full
// strength back.

import { derived, type Mat } from './materials';

/** Bending substep as a fraction of ds²/c (the explicit limit is 0.5 in the interior; free ends carry half mass). */
const ALPHA = 0.28;
/** Twist substep Courant number (a free end is a half cell). */
const TW_CFL = 0.6;
const G = 9.81;
/**
 * A grip chases its finger at the finger's own speed plus this (m/s of sim time), so in slow motion the
 * hands move in slow motion too and catch up gently afterwards, instead of quenching the rod.
 */
const GRIP_CATCHUP = 0.12;
/** Most substeps one rod may take in a frame. */
const CAP = 600;
/**
 * Softest a time-scaled rod may get. Below this it would lag its fingers visibly (and carry that lag
 * into the true stiffness when a crack switches it back), so an overloaded frame simulates less time.
 */
const SIG_MIN = 0.04;

export interface Finger {
  x: number;
  y: number;
  /** Twist the finger has applied, radians. */
  tw: number;
  /** Where it was at the start of the frame: grips follow it smoothly across the substeps. */
  lx?: number;
  ly?: number;
  ltw?: number;
  /** Wall-clock speed (m/s, smoothed): a grip never moves faster than its finger, even in slow motion. */
  vr?: number;
  px?: number;
  py?: number;
}

export interface Grip {
  node: number;
  finger: number;
  /** Node offset from the finger (keeps a bundle's spread). */
  ox: number;
  oy: number;
  /** Where the grip is now; it chases the finger at a capped speed. */
  gx: number;
  gy: number;
  /** Its velocity last substep (for the inertial compensation of time-scaled rods). */
  vx?: number;
  vy?: number;
  /** End grips clamp: the outward tangent angle they hold, until the moment exceeds what a pinch can take. */
  clamp: boolean;
  ang: number;
  /** Twist at the node and the finger's twist when grabbed. */
  th0: number;
  tw0: number;
}

export interface Crack {
  x: number;
  y: number;
  rod: Rod;
  a: Rod;
  b: Rod;
  /** Energy stored at the node when it went (J), and whether it began a cascade. */
  energy: number;
  first: boolean;
  /** Curvature and twist rate at the node. */
  kappa: number;
  twist: number;
  t: number;
}

export interface Micro {
  x: number;
  y: number;
  energy: number;
  rod: Rod;
  t: number;
}

export interface Hit {
  rod: Rod;
  node: number;
  speed: number;
}

export interface Crumb {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
  color: string;
  depth: number;
}

/** Target segment length (m). */
export const SEG = { len: 0.0075 };

let ids = 1;
// Shared scratch for the per-substep solves.
let S = scratch(64);
function scratch(n: number) {
  return {
    n,
    fx: new Float64Array(n),
    fy: new Float64Array(n),
    px: new Float64Array(n),
    py: new Float64Array(n),
    nx: new Float64Array(n),
    ny: new Float64Array(n),
    c: new Float64Array(n),
    cp: new Float64Array(n),
    dp: new Float64Array(n),
    lam: new Float64Array(n),
    tg: new Float64Array(n),
    hit: new Uint8Array(n),
    vin: new Float64Array(n),
  };
}

export class Rod {
  readonly id = ids++;
  readonly n: number;
  readonly ds: number;
  readonly mat: Mat;
  readonly EI: number;
  readonly cb: number;
  readonly ct: number;
  /** Which strand this piece came from, and its depth on the table (drawing only). */
  readonly strand: number;
  depth: number;
  x: Float64Array;
  y: Float64Array;
  vx: Float64Array;
  vy: Float64Array;
  /** Twist angle about the tangent and its rate. */
  th: Float64Array;
  om: Float64Array;
  /** Crack depth (fraction of the section), layers cracked, flaw strength, and each layer's threshold. */
  D: Float32Array;
  lay: Uint8Array;
  str: Float32Array;
  thr: Float32Array;
  /** Depth of each layer (fraction of the section). */
  dep: Float32Array;
  m: Float64Array;
  w: Float64Array;
  grips: Grip[] = [];
  /** Sim time at which end 0 / end n−1 became a fracture face. */
  age0 = -1e9;
  age1 = -1e9;
  /** Stiffness scale this frame (1 = true material; < 1 while time-scaled quasi-statics suffice). */
  sigma = 1;
  /** Until this sim time the rod rings freely (no numerical damping beyond its material Q). */
  hotUntil = -1;
  /** Minimum fragment length for the cascade this piece is part of. */
  lambda = 0;
  /** Largest stress ratio (to the next thing that would crack) this frame, and where. */
  maxS = 0;
  maxNode = 0;
  /** End-to-end approach speed (m/s, smoothed) while held at two points. */
  vq = 0;
  private gap = -1;
  asleep = false;
  still = 0;
  /** Substep plan for this frame (set by World.allocate). */
  need = 1;
  dt1 = 1;
  substeps = 1;
  dtSub = 0;

  constructor(mat: Mat, n: number, strand: number, depth: number) {
    this.mat = mat;
    this.n = n;
    this.ds = mat.L / Math.round(mat.L / SEG.len);
    const d = derived(mat);
    this.EI = d.EI;
    this.cb = d.cb;
    this.ct = d.ct;
    this.strand = strand;
    this.depth = depth;
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.vx = new Float64Array(n);
    this.vy = new Float64Array(n);
    this.th = new Float64Array(n);
    this.om = new Float64Array(n);
    this.D = new Float32Array(n);
    this.lay = new Uint8Array(n);
    this.str = new Float32Array(n);
    this.thr = new Float32Array(n * mat.layers);
    this.dep = new Float32Array(n * mat.layers);
    this.m = new Float64Array(n);
    this.w = new Float64Array(n);
    if (n > S.n) S = scratch(n * 2);
  }

  /** A whole straight strand from (x, y) along angle a, with flaws drawn from `rnd`. */
  static strand(mat: Mat, x: number, y: number, a: number, strand: number, depth: number, rnd: () => number) {
    const segs = Math.round(mat.L / SEG.len);
    const r = new Rod(mat, segs + 1, strand, depth);
    const ca = Math.cos(a), sa = Math.sin(a);
    // Dry rods are never quite straight: a faint random bow.
    const bow = (rnd() - 0.5) * 0.0012;
    const { rhoA } = derived(mat);
    const K = mat.layers;
    for (let i = 0; i <= segs; i++) {
      const s = i * r.ds, u = i / segs;
      const off = bow * Math.sin(Math.PI * u);
      r.x[i] = x + ca * s - sa * off;
      r.y[i] = y + sa * s + ca * off;
      r.m[i] = rhoA * r.ds * (i === 0 || i === segs ? 0.5 : 1);
      r.w[i] = 1 / r.m[i];
      // Flaws: Gaussian scatter, shifted so the weakest of a strand's nodes sits near the measured limit.
      r.str[i] = Math.max(0.8, Math.min(1.35, 1 + mat.cov * (gauss(rnd) + 2)));
      for (let k = 0; k < K; k++) {
        const f = K > 1 ? k / (K - 1) : 0;
        r.thr[i * K + k] = r.str[i] * (mat.layerStart + (mat.layerEnd - mat.layerStart) * f) * (1 + 0.04 * gauss(rnd));
        // Fibrous sections crack in even layers (Tsai et al.); a brittle skin's micro-flaws have power-law
        // depths (Pareto, α = 0.4), so their energies follow Gutenberg–Richter with b ≈ 1.4.
        r.dep[i * K + k] = mat.fibrous ? mat.layerDepth : Math.min(mat.layerDepth * 3, mat.layerDepth * 0.02 * Math.pow(Math.max(1e-6, rnd()), -1 / 0.4));
      }
    }
    return r;
  }

  /** Copy nodes [a, b] into a new piece. */
  slice(a: number, b: number) {
    const n = b - a + 1;
    const p = new Rod(this.mat, n, this.strand, this.depth);
    const K = this.mat.layers;
    p.x.set(this.x.subarray(a, b + 1));
    p.y.set(this.y.subarray(a, b + 1));
    p.vx.set(this.vx.subarray(a, b + 1));
    p.vy.set(this.vy.subarray(a, b + 1));
    p.th.set(this.th.subarray(a, b + 1));
    p.om.set(this.om.subarray(a, b + 1));
    p.D.set(this.D.subarray(a, b + 1));
    p.lay.set(this.lay.subarray(a, b + 1));
    p.str.set(this.str.subarray(a, b + 1));
    p.thr.set(this.thr.subarray(a * K, (b + 1) * K));
    p.dep.set(this.dep.subarray(a * K, (b + 1) * K));
    p.m.set(this.m.subarray(a, b + 1));
    p.w.set(this.w.subarray(a, b + 1));
    p.sigma = this.sigma;
    p.hotUntil = this.hotUntil;
    p.lambda = this.lambda;
    return p;
  }

  get length() {
    return (this.n - 1) * this.ds;
  }

  isGrip(i: number) {
    for (const g of this.grips) if (g.node === i) return true;
    return false;
  }

  /**
   * Advance `steps` substeps of `dt`. Returns the node that fractured (and the steps done), or -1.
   * The rod's own stiffness is scaled by `sigma` (with gravity, while it is held, so its
   * quasi-static shape doesn't change).
   */
  advance(w: World, steps: number, dt: number): { cut: number; done: number } {
    for (let s = 0; s < steps; s++) {
      w.frac = Math.min(1, w.frac + dt / Math.max(1e-12, w.frameSim));
      this.substep(w, dt);
      w.time += dt;
      const c = this.fracture(w);
      if (c >= 0) return { cut: c, done: s + 1 };
    }
    return { cut: -1, done: steps };
  }

  private substep(w: World, dt: number) {
    const { n, ds, mat, grips } = this;
    const { x, y, vx, vy, m, D } = this;
    const sg = this.sigma;
    const k = (this.EI * sg) / (ds * ds * ds);
    const held = grips.length > 0;
    const g = held ? G * sg : G;
    const { fx, fy, px, py } = S;
    // Two grips can't pull the rod longer than it is: slide their targets together.
    if (grips.length === 2) w.feasible(this, grips[0], grips[1]);

    for (let i = 0; i < n; i++) {
      fx[i] = 0;
      fy[i] = -m[i] * g;
    }
    // Bending: E = Σ EIᵢ/(2ds³) |xᵢ₋₁ − 2xᵢ + xᵢ₊₁|², with a cracked node's stiffness falling as (1 − D)³.
    const soft = mat.soften;
    for (let i = 1; i < n - 1; i++) {
      const ki = D[i] > 0 ? k * Math.pow(1 - D[i], soft) : k;
      const ax = ki * (x[i - 1] - 2 * x[i] + x[i + 1]);
      const ay = ki * (y[i - 1] - 2 * y[i] + y[i + 1]);
      fx[i - 1] -= ax;
      fy[i - 1] -= ay;
      fx[i] += 2 * ax;
      fy[i] += 2 * ay;
      fx[i + 1] -= ax;
      fy[i + 1] -= ay;
    }
    // Grips: move toward the finger; end grips clamp through a ghost node, up to a slip moment.
    for (const gr of grips) {
      const f = w.fingers.get(gr.finger);
      if (f) {
        const u = w.frac, lx = f.lx ?? f.x, ly = f.ly ?? f.y;
        const tx = lx + (f.x - lx) * u + gr.ox, ty = ly + (f.y - ly) * u + gr.oy;
        const dx = tx - gr.gx, dy = ty - gr.gy;
        const d = Math.hypot(dx, dy), lim = ((f.vr ?? 0) + GRIP_CATCHUP) * dt;
        const s2 = d > lim ? lim / d : 1;
        gr.gx += dx * s2;
        gr.gy += dy * s2;
      }
      if (!gr.clamp) continue;
      const e = gr.node, nb = e === 0 ? 1 : n - 2;
      const phi = Math.atan2(y[e] - y[nb], x[e] - x[nb]);
      let dg = wrap(gr.ang - phi);
      const slip = w.slip * mat.kc * ds;
      if (Math.abs(dg) > slip) {
        dg = Math.sign(dg) * slip;
        gr.ang = phi + dg;
      }
      const gx = x[e] + ds * Math.cos(gr.ang), gy = y[e] + ds * Math.sin(gr.ang);
      fx[nb] -= k * (x[nb] - 2 * x[e] + gx);
      fy[nb] -= k * (y[nb] - 2 * y[e] + gy);
    }
    // A time-scaled rod (sg < 1) has its gravity scaled so its held shape is the true one; the inertia
    // of being carried around by the fingers is scaled the same way, or a quick lift would bend it 1/sg
    // times too much.
    if (held && sg < 1) {
      let ax = 0, ay = 0;
      for (const gr of grips) {
        const gvx = (gr.gx - x[gr.node]) / dt, gvy = (gr.gy - y[gr.node]) / dt;
        if (gr.vx !== undefined) {
          ax += (gvx - gr.vx) / dt;
          ay += (gvy - (gr.vy ?? 0)) / dt;
        }
        gr.vx = gvx;
        gr.vy = gvy;
      }
      ax *= (1 - sg) / grips.length;
      ay *= (1 - sg) / grips.length;
      for (let i = 0; i < n; i++) {
        fx[i] += m[i] * ax;
        fy[i] += m[i] * ay;
      }
    } else for (const gr of grips) gr.vx = gr.vy = undefined;
    // Velocities; grip nodes are kinematic.
    const inv = this.w;
    for (let i = 0; i < n; i++) {
      vx[i] += dt * fx[i] * inv[i];
      vy[i] += dt * fy[i] * inv[i];
    }
    // Damping as velocity smoothing: its rate grows with k², i.e. with frequency for a beam, so it is a
    // constant quality factor Q = dt·c / (β ds²). Material Q while ringing; heavily damped while held.
    const hot = w.time < this.hotUntil;
    const Q = hot ? mat.Q : held ? 1.5 : 5;
    const beta = Math.min(0.45, (dt * this.cb * Math.sqrt(sg)) / (Q * ds * ds));
    if (beta > 1e-5) {
      let pxv = vx[0], pyv = vy[0];
      vx[0] += beta * 0.5 * (vx[1] - vx[0]);
      vy[0] += beta * 0.5 * (vy[1] - vy[0]);
      for (let i = 1; i < n - 1; i++) {
        const cx = vx[i], cy = vy[i];
        vx[i] += beta * 0.5 * (pxv + vx[i + 1] - 2 * cx);
        vy[i] += beta * 0.5 * (pyv + vy[i + 1] - 2 * cy);
        pxv = cx;
        pyv = cy;
      }
      vx[n - 1] += beta * 0.5 * (pxv - vx[n - 1]);
      vy[n - 1] += beta * 0.5 * (pyv - vy[n - 1]);
    }
    if (!held) {
      const drag = 1 - 0.4 * dt;
      for (let i = 0; i < n; i++) {
        vx[i] *= drag;
        vy[i] *= drag;
      }
    }
    for (let i = 0; i < n; i++) {
      px[i] = x[i] + dt * vx[i];
      py[i] = y[i] + dt * vy[i];
    }
    for (const gr of grips) {
      px[gr.node] = gr.gx;
      py[gr.node] = gr.gy;
    }
    this.inextensible(px, py, dt);
    this.contacts(w, px, py, dt);
    for (let i = 0; i < n; i++) {
      vx[i] = (px[i] - x[i]) / dt;
      vy[i] = (py[i] - y[i]) / dt;
      x[i] = px[i];
      y[i] = py[i];
    }
    // Restitution for nodes that struck the table or a wall this substep.
    const e = mat.bounce;
    for (let i = 0; i < n; i++) {
      if (S.hit[i] === 1) vy[i] = Math.min(vy[i], e * S.vin[i]);
      else if (S.hit[i] === 2) vx[i] = -e * S.vin[i];
    }
    this.twist(w, dt);
  }

  /**
   * Direct solve of the linearised length constraints: a chain gives a tridiagonal system (Thomas
   * algorithm). Each constraint carries the rod's true axial compliance ds/EA (XPBD), which also keeps
   * the system regular when a straight chain is pushed end to end.
   */
  private inextensible(px: Float64Array, py: Float64Array, dt: number) {
    const n = this.n, ds = this.ds, w = this.w;
    const alpha = ds / (this.mat.E * Math.PI * this.mat.r * this.mat.r) / (dt * dt);
    const { nx, ny, c, cp, dp, lam } = S;
    const m = n - 1;
    for (let j = 0; j < m; j++) {
      const dx = px[j + 1] - px[j], dy = py[j + 1] - py[j];
      const l = Math.hypot(dx, dy) || 1e-12;
      nx[j] = dx / l;
      ny[j] = dy / l;
      c[j] = l - ds;
    }
    // Rows: (w_j + w_{j+1}) λ_j − w_{j+1}(n_j·n_{j+1}) λ_{j+1} − w_j(n_{j−1}·n_j) λ_{j−1} = −C_j.
    let bPrev = 0;
    for (let j = 0; j < m; j++) {
      const a = w[j] + w[j + 1] + alpha;
      const b = j < m - 1 ? -w[j + 1] * (nx[j] * nx[j + 1] + ny[j] * ny[j + 1]) : 0;
      const den = j === 0 ? a : a - bPrev * cp[j - 1];
      cp[j] = b / den;
      dp[j] = (-c[j] - (j === 0 ? 0 : bPrev * dp[j - 1])) / den;
      bPrev = b;
    }
    lam[m - 1] = dp[m - 1];
    for (let j = m - 2; j >= 0; j--) lam[j] = dp[j] - cp[j] * lam[j + 1];
    for (let i = 0; i < n; i++) {
      let dx = 0, dy = 0;
      if (i < m) {
        dx -= nx[i] * lam[i];
        dy -= ny[i] * lam[i];
      }
      if (i > 0) {
        dx += nx[i - 1] * lam[i - 1];
        dy += ny[i - 1] * lam[i - 1];
      }
      px[i] += w[i] * dx;
      py[i] += w[i] * dy;
    }
  }

  private contacts(w: World, px: Float64Array, py: Float64Array, dt: number) {
    const n = this.n, r = this.mat.r, fr = this.mat.friction;
    const { x, y } = this;
    const floor = w.floor + r, L = w.left + r, R = w.right - r;
    let best = 0, bestNode = -1;
    for (let i = 0; i < n; i++) {
      S.hit[i] = 0;
      if (this.w[i] === 0) continue;
      if (py[i] < floor) {
        const vin = (y[i] - py[i]) / dt;
        py[i] = floor;
        // Coulomb-ish: sliding is cut back in proportion to how hard it landed.
        const slide = px[i] - x[i];
        px[i] = x[i] + slide * Math.max(0, 1 - fr * (0.3 + Math.min(1, (Math.max(0, vin) * dt) / (Math.abs(slide) + 1e-9))));
        // Pushing a node out of the table must not launch it: its bounce is capped below.
        S.hit[i] = 1;
        S.vin[i] = Math.max(0, vin);
        if (vin > 0.05 && vin > best) (best = vin), (bestNode = i);
      }
      if (px[i] < L || px[i] > R) {
        const vin = (px[i] - x[i]) / dt;
        px[i] = px[i] < L ? L : R;
        S.hit[i] = 2;
        S.vin[i] = vin;
        if (Math.abs(vin) > best) (best = Math.abs(vin)), (bestNode = i);
      }
    }
    if (bestNode >= 0) w.hit(this, bestNode, best);
  }

  /** Twist: damped wave equation θ_tt = c² θ_ss − 2b θ_t (critically damped, b = πc/L), free ends torque-free. */
  private twist(w: World, dt: number) {
    const { n, ds, th, om, grips } = this;
    const c = this.ct * Math.sqrt(this.sigma);
    const b = (Math.PI * c) / this.mat.L;
    const sub = Math.max(1, Math.ceil((dt * c) / (TW_CFL * ds)));
    const h = dt / sub;
    const c2 = (c * c) / (ds * ds);
    const tg = S.tg;
    for (const gr of grips) {
      const f = w.fingers.get(gr.finger);
      const ftw = f ? (f.ltw ?? f.tw) + (f.tw - (f.ltw ?? f.tw)) * w.frac : 0;
      tg[gr.node] = gr.th0 + (f ? ftw - gr.tw0 : 0);
    }
    for (let s = 0; s < sub; s++) {
      let prev = th[0];
      om[0] += h * (c2 * 2 * (th[1] - th[0]) - 2 * b * om[0]);
      for (let i = 1; i < n - 1; i++) {
        const cur = th[i];
        om[i] += h * (c2 * (prev - 2 * cur + th[i + 1]) - 2 * b * om[i]);
        prev = cur;
      }
      om[n - 1] += h * (c2 * 2 * (prev - th[n - 1]) - 2 * b * om[n - 1]);
      for (let i = 0; i < n; i++) th[i] += h * om[i];
      for (const gr of grips) {
        const i = gr.node, t = tg[i];
        om[i] = (t - th[i]) / h;
        th[i] = t;
      }
    }
  }

  /** Stress at each node against its layers and core; returns a node to cut, or -1. */
  private fracture(w: World): number {
    const { n, ds, mat, x, y, th, D, lay, thr, str } = this;
    const K = mat.layers;
    const kc = mat.kc, tc = mat.tc;
    const inv = 1 / (ds * ds);
    let best = -1, bestR = 1, maxS = 0, maxNode = 0;
    const lam = this.lambda || w.lambda0;
    // The cascade's minimum fragment length (Heisser et al.): a node can't go within λ of a fresh crack.
    const young = w.youngTime(this);
    const y0 = w.time - this.age0 < young, y1 = w.time - this.age1 < young;
    for (let i = 1; i < n - 1; i++) {
      const ax = x[i - 1] - 2 * x[i] + x[i + 1], ay = y[i - 1] - 2 * y[i] + y[i + 1];
      const kap = Math.sqrt(ax * ax + ay * ay) * inv;
      const tw = (th[i + 1] - th[i - 1]) / (2 * ds);
      if (kap > w.peakKappa && w.time < this.hotUntil) w.peakKappa = kap;
      let l = 1 - D[i];
      let s = Math.hypot((kap * l) / kc, (tw * l) / tc);
      // Layers crack one by one as the stress on the outermost intact one passes its threshold.
      while (lay[i] < K && s > thr[i * K + lay[i]] && !this.isGrip(i)) {
        const l0 = l;
        D[i] = Math.min(0.95, D[i] + this.dep[i * K + lay[i]]);
        lay[i]++;
        l = 1 - D[i];
        const p = mat.soften;
        const e = 0.5 * this.EI * (l0 ** p - l ** p) * kap * kap * ds + 0.25 * mat.mu * Math.PI * mat.r ** 4 * (l0 ** 4 - l ** 4) * tw * tw * ds;
        w.micro(this, i, e);
        s = Math.hypot((kap * l) / kc, (tw * l) / tc);
      }
      // Brittle: the crack runs through once the skin-weakened core is overloaded (strength falls with crack depth).
      // Fibrous: the last layers pull apart only when every layer has gone.
      const weak = str[i] * (1 - 0.5 * D[i]);
      const core = mat.fibrous ? (lay[i] >= K ? 0 : Infinity) : weak;
      // Stress against whatever gives next (a layer or the core): 1 means something cracks now.
      const next = lay[i] < K ? Math.min(thr[i * K + lay[i]], mat.fibrous ? Infinity : weak) : mat.fibrous ? 1 : weak;
      const ratio = s / next;
      if (ratio > maxS) (maxS = ratio), (maxNode = i);
      const rr = s / Math.max(core, 1e-6);
      if (rr > bestR && !this.isGrip(i)) {
        if (y0 && i * ds < lam) continue;
        if (y1 && (n - 1 - i) * ds < lam) continue;
        bestR = rr;
        best = i;
      }
    }
    this.maxS = Math.max(this.maxS, maxS);
    this.maxNode = maxNode;
    return w.maxCuts > 0 ? best : -1;
  }

  /** Track the end-to-end approach speed while held at two points (Heisser's quench speed v). */
  trackQuench(dtSim: number) {
    if (this.grips.length !== 2 || dtSim <= 0) {
      this.gap = -1;
      return;
    }
    const a = this.grips[0], b = this.grips[1];
    const d = Math.hypot(a.gx - b.gx, a.gy - b.gy);
    if (this.gap >= 0) {
      const v = Math.abs(d - this.gap) / dtSim;
      const k = Math.min(1, dtSim / 0.12);
      this.vq += (v - this.vq) * k;
    }
    this.gap = d;
  }
}

export class World {
  rods: Rod[] = [];
  fingers = new Map<number, Finger>();
  /** Sim time (s) and its rate against the wall clock. */
  time = 0;
  rate = 1;
  private slowLeft = 0;
  slowmo: 'off' | 'slow' | 'deep' = 'deep';
  floor = 0;
  left = -0.14;
  right = 0.14;
  /** Node-substeps per frame across all rods; the quasi-static rest shares what the ringing rods leave. */
  budget = 60000;
  /** Grip slip moment as a fraction of the limit curvature (0 = freely pivoting ends, as in Heisser's rig). */
  slip = 0.4;
  /** Minimum fragment length at 3 mm/s (Heisser et al.: λ₀ ≈ 3 cm), scaling as v^(−1/4). */
  lambda0 = 0.03;
  /** Diagnostics: stop fracturing after this many cracks, and the largest curvature seen while ringing. */
  maxCuts = Infinity;
  peakKappa = 0;
  cracks: Crack[] = [];
  micros: Micro[] = [];
  hits: Hit[] = [];
  crumbs: Crumb[] = [];
  /** Substeps actually taken this frame (node-substeps). */
  work = 0;
  /** Fraction of this frame's sim time the current rod has covered, and the frame's sim time. */
  frac = 0;
  frameSim = 1;
  private hitBest = new Map<Rod, Hit>();

  youngTime(r: Rod) {
    // A few percent of the strand's bending time L²/c: much longer than a cascade (≈0.2 ms for spaghetti).
    return (0.02 * r.mat.L * r.mat.L) / (r.cb * Math.sqrt(r.sigma));
  }

  micro(r: Rod, i: number, energy: number) {
    this.micros.push({ x: r.x[i], y: r.y[i], energy, rod: r, t: this.time });
  }

  hit(r: Rod, node: number, speed: number) {
    const h = this.hitBest.get(r);
    if (!h || speed > h.speed) this.hitBest.set(r, { rod: r, node, speed });
  }

  feasible(r: Rod, a: Grip, b: Grip) {
    const fa = this.fingers.get(a.finger), fb = this.fingers.get(b.finger);
    if (!fa || !fb) return;
    const arc = Math.abs(a.node - b.node) * r.ds;
    // Fingers further apart than the rod is long: they slide along it (their offsets give), it stays taut.
    const dx = fb.x + b.ox - fa.x - a.ox, dy = fb.y + b.oy - fa.y - a.oy;
    const d = Math.hypot(dx, dy);
    if (d > arc * 1.0005) {
      const s = (d - arc) / (2 * d);
      a.ox += dx * s;
      a.oy += dy * s;
      b.ox -= dx * s;
      b.oy -= dy * s;
    }
    const gx = b.gx - a.gx, gy = b.gy - a.gy, gd = Math.hypot(gx, gy);
    if (gd > arc * 1.0005) {
      const s = (gd - arc) / (2 * gd);
      a.gx += gx * s;
      a.gy += gy * s;
      b.gx -= gx * s;
      b.gy -= gy * s;
    }
  }

  /** Real-to-sim slow motion after a crack in a quasi-static rod: how slow, and for how long. */
  private slowFor(r: Rod, frameDt: number) {
    const dt1 = (ALPHA * r.ds * r.ds) / r.cb;
    const afford = Math.min(1, (CAP * 0.8 * dt1) / frameDt);
    const want = this.slowmo === 'deep' ? 1 / 1000 : this.slowmo === 'slow' ? 1 / 60 : 1;
    const hold = this.slowmo === 'deep' ? 0.45 : this.slowmo === 'slow' ? 0.2 : 0.05;
    return { rate: Math.min(want, afford), hold };
  }

  /** Step one frame of wall-clock time `frameDt`. */
  step(frameDt: number) {
    if (this.slowLeft > 0) this.slowLeft -= frameDt;
    else this.rate = Math.min(1, this.rate * Math.exp(frameDt / 0.16));
    const dtSim = frameDt * this.rate;
    for (const f of this.fingers.values()) {
      const v = f.px === undefined ? 0 : Math.hypot(f.x - f.px, f.y - (f.py ?? f.y)) / frameDt;
      f.vr = Math.max(v, (f.vr ?? 0) * Math.exp(-frameDt / 0.1));
      f.px = f.x;
      f.py = f.y;
    }
    this.cracks.length = 0;
    this.micros.length = 0;
    this.hits.length = 0;
    this.hitBest.clear();
    for (const r of this.rods) {
      r.maxS = 0;
      r.trackQuench(dtSim);
    }
    this.allocate(dtSim);
    this.frameSim = dtSim;
    const t0 = this.time;
    // Each rod runs its own substeps over the same slice of sim time; pieces born mid-frame finish it.
    const queue: { r: Rod; left: number; dt: number }[] = [];
    for (const r of this.rods) if (!r.asleep) queue.push({ r, left: r.substeps, dt: r.dtSub });
    let work = 0;
    // A crack that starts slow motion ends the frame at its own instant.
    let stopAt = Infinity;
    while (queue.length) {
      const q = queue.pop()!;
      const r = q.r;
      this.time = t0 + (r.substeps - q.left) * q.dt;
      this.frac = (this.time - t0) / Math.max(1e-12, dtSim);
      const res = r.advance(this, q.left, q.dt);
      work += res.done * r.n;
      if (res.cut < 0) continue;
      const quasi = r.sigma < 0.999 || this.time >= r.hotUntil;
      const [a, b] = this.cut(r, res.cut, quasi, frameDt);
      // A crack in a slowly bent rod starts slow motion; its pieces wait for the next frame, at full stiffness.
      if (quasi && this.slowmo !== 'off') stopAt = Math.min(stopAt, this.time);
      else {
        const left = q.left - res.done;
        if (left > 0) {
          a.substeps = b.substeps = r.substeps;
          queue.push({ r: a, left, dt: q.dt }, { r: b, left, dt: q.dt });
        }
      }
    }
    this.time = Math.min(t0 + dtSim, stopAt);
    this.work = work;
    // The fingers' motion this frame has been fed in (all of it, or up to a crack that froze time).
    const done = stopAt < Infinity ? (stopAt - t0) / Math.max(1e-12, dtSim) : 1;
    for (const f of this.fingers.values()) {
      const lx = f.lx ?? f.x, ly = f.ly ?? f.y, ltw = f.ltw ?? f.tw;
      f.lx = lx + (f.x - lx) * done;
      f.ly = ly + (f.y - ly) * done;
      f.ltw = ltw + (f.tw - ltw) * done;
    }
    for (const h of this.hitBest.values()) this.hits.push(h);
    this.stepCrumbs(dtSim);
    this.sleepCheck(frameDt);
  }

  private allocate(dtSim: number) {
    const awake = this.rods.filter((r) => !r.asleep);
    let fixed = 0;
    const flex: Rod[] = [];
    for (const r of awake) {
      const dt1 = (ALPHA * r.ds * r.ds) / r.cb;
      r.need = Math.max(1, Math.ceil(dtSim / dt1));
      r.dt1 = dt1;
      // Ringing rods get their true stiffness first: the cascade must not be time-scaled.
      if (this.time < r.hotUntil) fixed += Math.min(r.need, CAP) * r.n;
      else flex.push(r);
    }
    const left = Math.max(0, this.budget - fixed);
    let cap = CAP;
    const cost = (c: number) => flex.reduce((a, r) => a + Math.min(r.need, c) * r.n, 0);
    if (cost(cap) > left) {
      let lo = 1, hi = CAP;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cost(mid) <= left) lo = mid;
        else hi = mid - 1;
      }
      cap = lo;
    }
    for (const r of awake) {
      const c = this.time < r.hotUntil ? CAP : cap;
      r.substeps = Math.min(r.need, c);
      r.dtSub = Math.min(dtSim / r.substeps, r.dt1 / Math.sqrt(SIG_MIN));
      const ratio = r.dt1 / r.dtSub;
      r.sigma = Math.min(1, ratio * ratio);
    }
  }

  private cut(r: Rod, i: number, quasi: boolean, frameDt: number): [Rod, Rod] {
    this.maxCuts--;
    const a = r.slice(0, i), b = r.slice(i, r.n - 1);
    const mi = r.m[i] * 0.5;
    a.m[i] = mi;
    a.w[i] = r.w[i] === 0 ? 0 : 1 / mi;
    b.m[0] = mi;
    b.w[0] = r.w[i] === 0 ? 0 : 1 / mi;
    a.age0 = r.age0;
    a.age1 = this.time;
    b.age0 = this.time;
    b.age1 = r.age1;
    for (const g of r.grips) {
      if (g.node < i) a.grips.push(g);
      else {
        g.node -= i;
        b.grips.push(g);
      }
    }
    // A fresh cascade: its minimum fragment length follows the end-to-end speed, λ = λ₀ (v / 3 mm/s)^(−1/4).
    const hot = this.time < r.hotUntil;
    if (!hot) {
      // Clamped to the measured range (1–500 mm/s).
      const v = Math.min(0.5, Math.max(0.001, r.vq));
      a.lambda = b.lambda = Math.max(1.2 * r.ds, this.lambda0 * Math.pow(v / 0.003, -0.25));
    }
    const hotFor = (0.1 * r.mat.L * r.mat.L) / r.cb;
    a.hotUntil = b.hotUntil = this.time + hotFor;
    // Energy that was stored at the node (real stiffness, for sound).
    const ax = r.x[i - 1] - 2 * r.x[i] + r.x[i + 1], ay = r.y[i - 1] - 2 * r.y[i] + r.y[i + 1];
    const kap = Math.hypot(ax, ay) / (r.ds * r.ds);
    const tw = (r.th[i + 1] - r.th[i - 1]) / (2 * r.ds);
    const l = Math.pow(1 - r.D[i], r.mat.soften);
    const energy = 0.5 * r.EI * l * kap * kap * r.mat.L * 0.5 + 0.25 * r.mat.mu * Math.PI * r.mat.r ** 4 * tw * tw * r.mat.L * 0.5;
    const k = this.rods.indexOf(r);
    if (k >= 0) this.rods.splice(k, 1, a, b);
    this.cracks.push({ x: r.x[i], y: r.y[i], rod: r, a, b, energy, first: !hot, kappa: kap, twist: tw, t: this.time });
    if (quasi && !hot) {
      const s = this.slowFor(r, frameDt);
      if (s.rate < this.rate) this.rate = s.rate;
      this.slowLeft = Math.max(this.slowLeft, s.hold);
    }
    this.spray(r, i, energy);
    return [a, b];
  }

  /** Crumbs of the broken face: a few flecks, more for a bigger crack. */
  private spray(r: Rod, i: number, energy: number) {
    const count = Math.min(14, 3 + Math.round(Math.sqrt(energy / (r.EI * r.mat.kc * r.mat.kc * 0.01)) * 2));
    for (let k = 0; k < count; k++) {
      const a = Math.random() * Math.PI * 2, s = 0.3 + Math.random() * 1.6;
      this.crumbs.push({
        x: r.x[i],
        y: r.y[i],
        vx: Math.cos(a) * s,
        vy: Math.sin(a) * s + 0.4,
        life: 1,
        size: r.mat.r * (0.25 + Math.random() * 0.5),
        color: r.mat.crumb,
        depth: r.depth + (Math.random() - 0.5) * 0.2,
      });
    }
    if (this.crumbs.length > 300) this.crumbs.splice(0, this.crumbs.length - 300);
  }

  private stepCrumbs(dt: number) {
    for (const c of this.crumbs) {
      c.vy -= G * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      if (c.y < this.floor) {
        c.y = this.floor;
        c.vy *= -0.3;
        c.vx *= 0.6;
      }
      if (c.x < this.left || c.x > this.right) c.vx *= -0.5;
    }
  }

  /** Pieces lying still on the table stop simulating until touched. */
  private sleepCheck(frameDt: number) {
    for (const r of this.rods) {
      if (r.grips.length || r.asleep || this.time < r.hotUntil) {
        r.still = 0;
        continue;
      }
      let vmax = 0, low = true;
      for (let i = 0; i < r.n; i++) {
        vmax = Math.max(vmax, Math.abs(r.vx[i]) + Math.abs(r.vy[i]));
        if (r.y[i] > this.floor + r.mat.r * 1.5) low = false;
      }
      if (vmax < 0.004 && low) r.still += frameDt;
      else r.still = 0;
      if (r.still > 0.4) {
        r.asleep = true;
        r.vx.fill(0);
        r.vy.fill(0);
        r.om.fill(0);
      }
    }
  }

  // ---------------------------------------------------------------- grips

  grab(r: Rod, node: number, finger: number) {
    const f = this.fingers.get(finger);
    if (!f) return;
    r.asleep = false;
    r.still = 0;
    const clamp = node === 0 || node === r.n - 1;
    const nb = node === 0 ? 1 : r.n - 2;
    r.grips.push({
      node,
      finger,
      ox: r.x[node] - f.x,
      oy: r.y[node] - f.y,
      gx: r.x[node],
      gy: r.y[node],
      clamp,
      ang: clamp ? Math.atan2(r.y[node] - r.y[nb], r.x[node] - r.x[nb]) : 0,
      th0: r.th[node],
      tw0: f.tw,
    });
    r.w[node] = 0;
  }

  release(finger: number) {
    for (const r of this.rods) {
      const keep: Grip[] = [];
      for (const g of r.grips) {
        if (g.finger === finger) r.w[g.node] = 1 / r.m[g.node];
        else keep.push(g);
      }
      r.grips = keep;
    }
    this.fingers.delete(finger);
  }

  /** Rotate the clamp angles of a finger's grips (the hands turn with the finger pair). */
  turnGrips(finger: number, da: number) {
    for (const r of this.rods) for (const g of r.grips) if (g.finger === finger) g.ang += da;
  }

  /** Strands per lineage (for counting pieces). */
  pieces(strand: number) {
    return this.rods.filter((r) => r.strand === strand).length;
  }
}

function wrap(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

function gauss(rnd: () => number) {
  const u = Math.max(1e-9, rnd()), v = rnd();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/** Small seeded PRNG (mulberry32) for repeatable trials. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
