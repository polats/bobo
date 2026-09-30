// Granular medium: a few thousand frictional disks, solved as position-based contacts with many small
// substeps (Macklin et al. 2014 friction; Macklin et al. 2019 substepping). Each substep predicts,
// rebuilds a counting-sort spatial hash, then projects every overlapping pair apart Gauss-Seidel style,
// sweeping from the gravity-down end so support propagates up the pile within one pass. Coulomb friction
// acts on the tangential slip of each contact: slip below mu_s × overlap is cancelled (static), above
// it is reduced by mu_k × overlap (kinetic). Nothing about the flow rate is scripted: arches, the pile
// slope, the crater and the neck discharge all come out of these contacts.
import { CELL, Glass } from './glass';

export interface Forces {
  /** Gravity plus the glass's own acceleration, in the glass frame (m/s²). */
  gx: number;
  gy: number;
  /** Glass angular velocity and acceleration (rad/s, rad/s²) for the frame's inertial forces. */
  w: number;
  alpha: number;
  /** Coulomb drag from the back pane (m/s²): the part of gravity pressing grains against the glass, times its friction. */
  face: number;
}

export interface GrainCfg {
  /** Static and kinetic grain-grain friction, and grain-glass friction. */
  mu: number;
  muK: number;
  wallMu: number;
  /** Rolling resistance: a contact resists relative rolling up to roll × overlap (in grain radii). */
  roll: number;
  /** Normal restitution on fast impacts (steel shot bounces a little). */
  bounce: number;
}

export class Grains {
  n = 0;
  readonly max: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  readonly r: Float64Array;
  readonly w: Float64Array;
  readonly tint: Float32Array;
  /** Spin angle (rad) and rate: grains roll, and friction acts on the contact point, not the centre. */
  readonly th: Float64Array;
  readonly om: Float64Array;
  private pth: Float64Array;
  /** Contacts in the last substep. */
  readonly contacts: Uint8Array;
  private px: Float64Array;
  private py: Float64Array;
  private cellOf: Int32Array;
  private items: Int32Array;
  private start = new Int32Array(1);
  private gw = 1;
  private gh = 1;
  private cs = 0.001;
  private gx0 = 0;
  private gy0 = 0;
  private tmp = new Float32Array(3);
  rMax = 0.0005;
  cfg: GrainCfg = { mu: 0.5, muK: 0.4, wallMu: 0.3, roll: 5, bounce: 0 };
  /** Neck plug for settling the initial fill. */
  plug = false;

  constructor(max: number) {
    this.max = max;
    this.x = new Float64Array(max);
    this.y = new Float64Array(max);
    this.vx = new Float64Array(max);
    this.vy = new Float64Array(max);
    this.r = new Float64Array(max);
    this.w = new Float64Array(max);
    this.tint = new Float32Array(max);
    this.th = new Float64Array(max);
    this.om = new Float64Array(max);
    this.pth = new Float64Array(max);
    this.contacts = new Uint8Array(max);
    this.px = new Float64Array(max);
    this.py = new Float64Array(max);
    this.cellOf = new Int32Array(max);
    this.items = new Int32Array(max);
    this.nearWall = new Uint8Array(max);
    this.zone = new Uint8Array(max);
    this.ovx = new Float64Array(max);
    this.ovy = new Float64Array(max);
    this.cI = new Int32Array(max * 5);
    this.cJ = new Int32Array(max * 5);
    this.cNx = new Float64Array(max * 5);
    this.cNy = new Float64Array(max * 5);
    this.zoneList = new Int32Array(max);
    this.stack = 0.8;
  }

  /**
   * Fill one bulb (side +1 = y > 0) to `frac` of its area with disks of mean diameter d and relative
   * size spread `spread`, packed from the neck outward as if already settled there.
   */
  fill(glass: Glass, frac: number, d: number, spread: number, side: 1 | -1) {
    const rm = d / 2;
    this.rMax = rm * (1 + spread);
    const want = Math.min(this.max, Math.floor((frac * glass.bulbArea * 0.8) / (Math.PI * rm * rm)));
    const sp = this.rMax * 2.02, row = sp * 0.866;
    let n = 0;
    for (let k = 0; n < want; k++) {
      const yy = side * (0.004 + this.rMax + k * row);
      if (Math.abs(yy) > 0.08) break;
      const w = glass.width(yy) - this.rMax * 1.2;
      const off = (k & 1) * sp * 0.5;
      for (let xx = -Math.floor(w / sp) * sp + off; xx <= w && n < want; xx += sp) {
        if (glass.sample(xx, yy, this.tmp) > -this.rMax * 1.1) continue;
        const r = rm * (1 + spread * (Math.random() * 2 - 1));
        this.x[n] = xx + (Math.random() - 0.5) * 0.1 * rm;
        this.y[n] = yy;
        this.vx[n] = this.vy[n] = 0;
        this.th[n] = Math.random() * 6.283;
        this.om[n] = 0;
        this.r[n] = r;
        this.w[n] = (rm * rm) / (r * r);
        this.tint[n] = Math.random();
        n++;
      }
    }
    this.n = n;
    this.cs = this.rMax * 2;
    this.gx0 = glass.x0;
    this.gy0 = glass.y0;
    this.gw = Math.ceil((glass.nx * 0.0004) / this.cs) + 2;
    this.gh = Math.ceil((glass.ny * 0.0004) / this.cs) + 2;
    this.start = new Int32Array(this.gw * this.gh + 1);
  }

  step(glass: Glass, dt: number, substeps: number, f: Forces) {
    const h = dt / substeps;
    for (let s = 0; s < substeps; s++) this.substep(glass, h, f);
  }

  private substep(glass: Glass, h: number, f: Forces) {
    const { n, x, y, vx, vy, px, py } = this;
    const w2 = f.w * f.w;
    const gl = Math.hypot(f.gx, f.gy) || 1;
    const dir = f.gy < 0 ? 1 : -1, ux0 = -f.gx / gl, uy0 = -f.gy / gl;
    // Speed cap: at most ~0.9 grain radius per substep, so nothing tunnels through a pile.
    const vmax = (0.9 * this.rMax) / h;
    for (let i = 0; i < n; i++) {
      // Gravity, plus centrifugal, Euler and Coriolis terms while the glass is turning.
      const ax = f.gx + w2 * x[i] + f.alpha * y[i] + 2 * f.w * vy[i];
      const ay = f.gy + w2 * y[i] - f.alpha * x[i] - 2 * f.w * vx[i];
      let ux = vx[i] + ax * h, uy = vy[i] + ay * h;
      if (f.face > 0) {
        const v = Math.sqrt(ux * ux + uy * uy), dv = f.face * h;
        const k = v > dv ? 1 - dv / v : 0;
        ux *= k;
        uy *= k;
      }
      const sp = ux * ux + uy * uy;
      if (sp > vmax * vmax) {
        const k = vmax / Math.sqrt(sp);
        ux *= k;
        uy *= k;
      }
      vx[i] = ux;
      vy[i] = uy;
      px[i] = x[i];
      py[i] = y[i];
      x[i] += ux * h;
      y[i] += uy * h;
      this.pth[i] = this.th[i];
      this.th[i] += this.om[i] * h;
    }
    this.hash();
    this.ux = ux0;
    this.uy = uy0;
    this.contacts.fill(0, 0, n);
    this.nC = 0;
    this.solveWalls(glass, true);
    this.recording = true;
    this.solvePairs(dir);
    this.solveWalls(glass, false);
    this.recording = false;
    if (this.neckIters) this.solveNeck(glass, this.neckIters);
    const { th, pth, om, ovx, ovy } = this;
    for (let i = 0; i < n; i++) {
      om[i] = (th[i] - pth[i]) / h;
      ovx[i] = vx[i];
      ovy[i] = vy[i];
      vx[i] = (x[i] - px[i]) / h;
      vy[i] = (y[i] - py[i]) / h;
    }
    this.contactVelocities();
  }

  /**
   * Velocity pass over this substep's contacts. Pushing an overlap apart also gives the pair the push
   * as velocity; left alone, that pumps energy into resting piles (they shiver, loosen and slump).
   * So no contact may separate faster than it was already separating before the solve, plus
   * restitution on real impacts (steel shot bounces, sand doesn't).
   */
  private contactVelocities() {
    const { vx, vy, ovx, ovy, w, cI, cJ, cNx, cNy, nC } = this;
    const e = this.cfg.bounce;
    for (let c = 0; c < nC; c++) {
      const i = cI[c], j = cJ[c], nx = cNx[c], ny = cNy[c];
      if (j < 0) {
        // Glass: n points into the wall; separation is motion against it.
        const was = -(ovx[i] * nx + ovy[i] * ny), now = -(vx[i] * nx + vy[i] * ny);
        const cap = Math.max(was, 0) + (was < -0.05 ? -e * was : 0);
        if (now > cap) {
          vx[i] += (now - cap) * nx;
          vy[i] += (now - cap) * ny;
        }
        continue;
      }
      const was = (ovx[j] - ovx[i]) * nx + (ovy[j] - ovy[i]) * ny;
      const now = (vx[j] - vx[i]) * nx + (vy[j] - vy[i]) * ny;
      const cap = Math.max(was, 0) + (was < -0.05 ? -e * was : 0);
      if (now > cap) {
        const ex = (now - cap) / (w[i] + w[j]);
        vx[i] += ex * w[i] * nx;
        vy[i] += ex * w[i] * ny;
        vx[j] -= ex * w[j] * nx;
        vy[j] -= ex * w[j] * ny;
      }
    }
  }

  private record(i: number, j: number, nx: number, ny: number) {
    const c = this.nC;
    if (c >= this.cI.length) return;
    this.cI[c] = i;
    this.cJ[c] = j;
    this.cNx[c] = nx;
    this.cNy[c] = ny;
    this.nC = c + 1;
  }

  private mirror = false;

  private hash() {
    this.mirror = !this.mirror;
    const { n, x, y, cellOf, items, start, gw, gh, cs } = this;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      let cx = Math.max(0, Math.min(gw - 1, ((x[i] - this.gx0) / cs) | 0));
      const cy = Math.max(0, Math.min(gh - 1, ((y[i] - this.gy0) / cs) | 0));
      // Every other substep the rows are walked right to left, so Gauss-Seidel has no handedness.
      if (this.mirror) cx = gw - 1 - cx;
      const c = cy * gw + cx;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < gw * gh; c++) start[c + 1] += start[c];
    // Scatter with a running cursor per cell (reuse start shifted by one).
    for (let i = 0; i < n; i++) items[start[cellOf[i]]++] = i;
    for (let c = gw * gh; c > 0; c--) start[c] = start[c - 1];
    start[0] = 0;
  }

  /** Height scaling for stacking (Macklin et al. 2014 §5.1): the lower grain of a pair, along (ux, uy)
   *  = up, counts as heavier, so one sweep carries the weight of the pile down to the glass. */
  set stack(k: number) {
    for (let i = 0; i <= 64; i++) this.expTab[i] = Math.exp(k * (i / 32 - 1));
  }
  private expTab = new Float64Array(65);
  private stencil = new Int32Array(4);
  private nearWall: Uint8Array;
  private zone: Uint8Array;
  private ovx: Float64Array;
  private ovy: Float64Array;
  /** Contacts of the main sweep this substep: pair (j = -1 for the glass) and normal. */
  private cI: Int32Array;
  private cJ: Int32Array;
  private cNx: Float64Array;
  private cNy: Float64Array;
  private nC = 0;
  private recording = false;
  private zoneList: Int32Array;
  private ux = 0;
  private uy = 1;
  /** Extra solver passes near the neck per substep. */
  neckIters = 4;

  private solvePairs(dir: number) {
    const { n, items, start, cellOf, gw, gh, x, y, r } = this;
    // Sorted order is row-major from the bottom; walk it from whichever end gravity points at, and
    // take each pair once with a half stencil: the rest of this cell, the next cell in the row, and
    // the three cells of the next row (all mirrored when walking down).
    const off = this.stencil;
    off[0] = dir;
    off[1] = dir * (gw - 1);
    off[2] = dir * gw;
    off[3] = dir * (gw + 1);
    for (let t = 0; t < n; t++) {
      const k = dir > 0 ? t : n - 1 - t;
      const i = items[k];
      const ci = cellOf[i];
      const cx = ci % gw, cy = (ci / gw) | 0;
      for (let s = -1; s < 4; s++) {
        let m0: number, m1: number;
        if (s < 0) {
          // Same cell: partners after k in walk order.
          m0 = dir > 0 ? k + 1 : start[ci];
          m1 = dir > 0 ? start[ci + 1] : k;
        } else {
          const col = cx + (s === 0 ? dir : s === 1 ? -dir : s === 2 ? 0 : dir), row = cy + (s === 0 ? 0 : dir);
          if (col < 0 || col >= gw || row < 0 || row >= gh) continue;
          const c = ci + off[s];
          m0 = start[c];
          m1 = start[c + 1];
        }
        for (let m = m0; m < m1; m++) {
          // Cheap reject before the full contact.
          const j = items[m];
          const dx = x[j] - x[i], dy = y[j] - y[i], rr = r[i] + r[j];
          if (dx * dx + dy * dy < rr * rr) this.contact(i, j);
        }
      }
    }
  }

  /**
   * Extra Gauss-Seidel passes over the grains near the neck. Arches there carry the load of the dome
   * above them through only a few contacts, and a single sweep lets walls and neighbours fight
   * (squeezing grains through each other); a converged solve here lets arches stand, so the neck clogs.
   */
  private solveNeck(glass: Glass, iters: number) {
    const { n, y, items, start, cellOf, gw, gh, zone, zoneList } = this;
    const band = glass.neck * 0.5 + 0.003;
    let z = 0;
    for (let i = 0; i < n; i++) {
      const inZone = Math.abs(y[i]) < band ? 1 : 0;
      zone[i] = inZone;
      if (inZone) zoneList[z++] = i;
    }
    if (!z) return;
    for (let it = 0; it < iters; it++) {
      for (let q = 0; q < z; q++) {
        const i = zoneList[q];
        const ci = cellOf[i];
        const cx = ci % gw, cy = (ci / gw) | 0;
        for (let oy = -1; oy <= 1; oy++) {
          if (cy + oy < 0 || cy + oy >= gh) continue;
          for (let ox = -1; ox <= 1; ox++) {
            if (cx + ox < 0 || cx + ox >= gw) continue;
            const c = ci + oy * gw + ox;
            for (let m = start[c], e = start[c + 1]; m < e; m++) {
              const j = items[m];
              if (j === i || (zone[j] && j < i)) continue;
              this.contact(i, j);
            }
          }
        }
      }
      this.solveWalls(glass, false, zoneList, z);
    }
  }

  /**
   * Project one pair apart. Friction acts on the slip of the contact point (centre motion plus spin),
   * split between sliding and turning by each disk's mass and inertia; a rolling-resistance limit
   * then caps how freely the two roll over each other.
   */
  private contact(i: number, j: number) {
    const { x, y, px, py, r, w, th, pth } = this;
    const dx = x[j] - x[i], dy = y[j] - y[i];
    const ri = r[i], rj = r[j], rr = ri + rj;
    const d2 = dx * dx + dy * dy;
    if (d2 >= rr * rr || d2 < 1e-18) return;
    const d = Math.sqrt(d2);
    const nx = dx / d, ny = dy / d;
    const pen = rr - d;
    if (this.recording) this.record(i, j, nx, ny);
    // Up-component of the offset i→j (in contact distances) sets the mass ratio.
    const sc = this.expTab[(((dx * this.ux + dy * this.uy) / rr + 1) * 32 + 0.5) | 0];
    const wj = w[j] * sc, wi = w[i] / sc, ws = wi + wj;
    let cx = (nx * pen) / ws, cy = (ny * pen) / ws;
    x[i] -= cx * wi;
    y[i] -= cy * wi;
    x[j] += cx * wj;
    y[j] += cy * wj;
    const cfg = this.cfg;
    // Rolling resistance first: relative spin (as an arc at the effective radius) below roll × overlap
    // is cancelled and the pair turns as one; above it, it is reduced by that much.
    const re = (ri * rj) / rr;
    const Ii = (ri * ri) / (2 * wi), Ij = (rj * rj) / (2 * wj);
    const roll = (th[i] - pth[i] - th[j] + pth[j]) * re, lim = cfg.roll * pen;
    const locked = roll <= lim && roll >= -lim;
    const cut = (locked ? roll : roll > 0 ? lim : -lim) / re / (1 / Ii + 1 / Ij);
    th[i] -= cut / Ii;
    th[j] += cut / Ij;
    // Coulomb friction on the tangential slip of the contact point (t is n turned +90°).
    const tx = -ny, ty = nx;
    const slip = (x[j] - px[j] - x[i] + px[i]) * tx + (y[j] - py[j] - y[i] + py[i]) * ty - rj * (th[j] - pth[j]) - ri * (th[i] - pth[i]);
    let fix = -slip;
    if (Math.abs(slip) > cfg.mu * pen) fix *= (cfg.muK * pen) / Math.abs(slip);
    // Shared between sliding and turning by mass and inertia: locked pairs turn together.
    const rot = locked ? (rr * rr) / (Ii + Ij) : (ri * ri) / Ii + (rj * rj) / Ij;
    const lam = fix / (ws + rot);
    cx = lam * tx;
    cy = lam * ty;
    x[i] -= cx * wi;
    y[i] -= cy * wi;
    x[j] += cx * wj;
    y[j] += cy * wj;
    if (locked) {
      const dt = (lam * rr) / (Ii + Ij);
      th[i] -= dt;
      th[j] -= dt;
    } else {
      th[i] -= (lam * ri) / Ii;
      th[j] -= (lam * rj) / Ij;
    }
    this.contacts[i]++;
    this.contacts[j]++;
  }

  private solveWalls(glass: Glass, first: boolean, list?: Int32Array, count = this.n) {
    const { x, y, px, py, r, tmp, contacts, nearWall } = this;
    const mu = this.cfg.wallMu;
    const sdf = glass.sdf, gnx = glass.nx, x0 = glass.x0, y0 = glass.y0, inv = 1 / CELL;
    const margin = 3 * CELL + this.rMax;
    for (let q = 0; q < count; q++) {
      const i = list ? list[q] : q;
      if (first) {
        // Cheap nearest-cell look first; most grains are nowhere near the glass.
        const ix = ((x[i] - x0) * inv + 0.5) | 0, iy = ((y[i] - y0) * inv + 0.5) | 0;
        const v = ix >= 0 && iy >= 0 && ix < gnx && iy < glass.ny ? sdf[iy * gnx + ix] : 1;
        nearWall[i] = v > -margin ? 1 : 0;
      }
      if (!nearWall[i] && !list) continue;
      const phi = glass.sample(x[i], y[i], tmp) + r[i];
      if (phi > 0) {
        const nx = tmp[1], ny = tmp[2];
        if (this.recording) this.record(i, -1, nx, ny);
        x[i] -= nx * phi;
        y[i] -= ny * phi;
        // Against the glass: rolling resistance first, then friction on the contact point's slip,
        // shared with spin only if the grain is free to roll (t = n turned +90°).
        const tx = -ny, ty = nx, ri = r[i];
        let dth = this.th[i] - this.pth[i];
        const lim = (this.cfg.roll * phi) / ri;
        const locked = dth <= lim && dth >= -lim;
        dth = locked ? 0 : dth > 0 ? dth - lim : dth + lim;
        const slip = (x[i] - px[i]) * tx + (y[i] - py[i]) * ty + ri * dth;
        let fix = -slip;
        if (Math.abs(slip) > mu * phi) fix *= (mu * 0.8 * phi) / Math.abs(slip);
        const share = locked ? 1 : 1 / 3;
        x[i] += fix * share * tx;
        y[i] += fix * share * ty;
        if (!locked) dth += (2 * fix) / (3 * ri);
        this.th[i] = this.pth[i] + dth;
        contacts[i]++;
      }
      if (this.plug && Math.abs(y[i]) < 0.004 + r[i]) {
        // A temporary floor across the neck while the first fill settles.
        y[i] = (y[i] >= 0 ? 1 : -1) * (0.004 + r[i]);
      }
    }
  }

}
