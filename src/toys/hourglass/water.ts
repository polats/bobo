// Water for comparison: a 2D particle liquid with Clavet et al. 2005 double-density relaxation
// (pressure from local density, near-pressure against clumping) and their pairwise viscosity. Unlike
// the grains, pressure here grows with depth and turns straight into outflow speed, so the jet
// through the neck slows as the head above it drops (Torricelli), with no rule saying so.
// The glass is sealed, so every bubble-sized parcel of water that falls must be paid back by a bubble
// of air going up through the neck: that is the glug. Bubbles are disks that rise and push water aside.
import { Glass, NECK_L } from './glass';
import type { Forces } from './grains';

export interface Bubble {
  x: number;
  y: number;
  r: number;
  /** Seconds alive; wobble phase. */
  age: number;
  phase: number;
}

export class Water {
  n = 0;
  readonly max: number;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly vx: Float64Array;
  readonly vy: Float64Array;
  private px: Float64Array;
  private py: Float64Array;
  private cellOf: Int32Array;
  private items: Int32Array;
  private start = new Int32Array(1);
  private gw = 1;
  private gh = 1;
  private gx0 = 0;
  private gy0 = 0;
  private tmp = new Float32Array(3);
  /** Rest spacing and interaction radius (m). */
  s = 0.0014;
  H = 0.0014 * 2.2;
  cfg = { k: 150, kNear: 450, rho0: 0, sigma: 0.3, beta: 0.02 };
  readonly bubbles: Bubble[] = [];
  /** Water area that has crossed the neck but not yet been paid back with air (m²). */
  airDebt = 0;
  /** Bubbles released since the last read (for sound). */
  released: Bubble[] = [];
  plug = false;
  private nbr = new Int32Array(1 << 16);
  private nStart: Int32Array;

  constructor(max: number) {
    this.max = max;
    this.x = new Float64Array(max);
    this.y = new Float64Array(max);
    this.vx = new Float64Array(max);
    this.vy = new Float64Array(max);
    this.px = new Float64Array(max);
    this.py = new Float64Array(max);
    this.cellOf = new Int32Array(max);
    this.items = new Int32Array(max);
    this.nStart = new Int32Array(max + 1);
  }

  get radius() {
    return this.s * 0.5;
  }

  fill(glass: Glass, frac: number, s: number, side: 1 | -1) {
    this.s = s;
    this.H = s * 2.2;
    const want = Math.min(this.max, Math.floor((frac * glass.bulbArea) / (s * s)));
    let n = 0;
    for (let k = 0; n < want; k++) {
      const yy = side * (0.003 + s + k * s);
      if (Math.abs(yy) > 0.08) break;
      const w = glass.width(yy) - s * 0.6;
      for (let xx = -Math.floor(w / s) * s + (k & 1) * s * 0.5; xx <= w && n < want; xx += s) {
        if (glass.sample(xx, yy, this.tmp) > -s * 0.55) continue;
        this.x[n] = xx;
        this.y[n] = yy;
        this.vx[n] = this.vy[n] = 0;
        n++;
      }
    }
    this.n = n;
    // Rest density of a square lattice at spacing s, measured with the kernel itself.
    let rho = 0;
    const r = Math.ceil(this.H / s);
    for (let a = -r; a <= r; a++) for (let b = -r; b <= r; b++) {
      if (!a && !b) continue;
      const q = Math.hypot(a, b) * s / this.H;
      if (q < 1) rho += (1 - q) * (1 - q);
    }
    this.cfg.rho0 = rho;
    this.gx0 = glass.x0;
    this.gy0 = glass.y0;
    this.gw = Math.ceil((glass.nx * 0.0004) / this.H) + 2;
    this.gh = Math.ceil((glass.ny * 0.0004) / this.H) + 2;
    this.start = new Int32Array(this.gw * this.gh + 1);
    this.bubbles.length = 0;
    this.airDebt = 0;
    this.nStart.fill(0);
  }

  /** Net water particles that crossed the neck downhill this frame; `up` is the upper bulb's side. */
  owe(count: number, glass: Glass, up: number) {
    this.airDebt += count * this.s * this.s;
    const rb = Math.min(glass.neck * 0.42, 0.004);
    const area = Math.PI * rb * rb;
    // Pay the debt back as bubbles entering the upper bulb at the neck mouth.
    while (this.airDebt > area && this.bubbles.length < 20) {
      this.airDebt -= area;
      const b: Bubble = { x: (Math.random() - 0.5) * glass.neck * 0.3, y: up * (NECK_L + rb * 0.8), r: rb, age: 0, phase: Math.random() * 6.28 };
      this.bubbles.push(b);
      this.released.push(b);
    }
    if (this.airDebt < -area) this.airDebt = -area;
  }

  step(glass: Glass, dt: number, substeps: number, f: Forces) {
    const h = dt / substeps;
    for (let s = 0; s < substeps; s++) this.substep(glass, h, f);
    this.moveBubbles(glass, dt, f);
  }

  private substep(glass: Glass, h: number, f: Forces) {
    const { n, x, y, vx, vy, px, py } = this;
    const w2 = f.w * f.w;
    const vmax = (0.5 * this.s) / h;
    for (let i = 0; i < n; i++) {
      vx[i] += (f.gx + w2 * x[i] + f.alpha * y[i] + 2 * f.w * vy[i]) * h;
      vy[i] += (f.gy + w2 * y[i] - f.alpha * x[i] - 2 * f.w * vx[i]) * h;
    }
    if (this.nStart[n] > 0) this.viscosity(h);
    for (let i = 0; i < n; i++) {
      const sp = vx[i] * vx[i] + vy[i] * vy[i];
      if (sp > vmax * vmax) {
        const k = vmax / Math.sqrt(sp);
        vx[i] *= k;
        vy[i] *= k;
      }
      px[i] = x[i];
      py[i] = y[i];
      x[i] += vx[i] * h;
      y[i] += vy[i] * h;
    }
    this.hash();
    this.buildPairs();
    this.relax(h);
    this.pushBubbles();
    this.walls(glass);
    for (let i = 0; i < n; i++) {
      vx[i] = (x[i] - px[i]) / h;
      vy[i] = (y[i] - py[i]) / h;
    }
  }

  private hash() {
    const { n, x, y, cellOf, items, start, gw, gh, H } = this;
    start.fill(0);
    for (let i = 0; i < n; i++) {
      const cx = Math.max(0, Math.min(gw - 1, ((x[i] - this.gx0) / H) | 0));
      const cy = Math.max(0, Math.min(gh - 1, ((y[i] - this.gy0) / H) | 0));
      const c = cy * gw + cx;
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (let c = 0; c < gw * gh; c++) start[c + 1] += start[c];
    for (let i = 0; i < n; i++) items[start[cellOf[i]]++] = i;
    for (let c = gw * gh; c > 0; c--) start[c] = start[c - 1];
    start[0] = 0;
  }

  /** Neighbour lists (CSR) within H, rebuilt once per substep after advection. */
  private buildPairs() {
    const { n, x, y, items, start, cellOf, gw, gh, H } = this;
    let p = 0;
    const H2 = H * H;
    for (let i = 0; i < n; i++) {
      this.nStart[i] = p;
      const ci = cellOf[i], cx = ci % gw, cy = (ci / gw) | 0;
      for (let oy = -1; oy <= 1; oy++) {
        if (cy + oy < 0 || cy + oy >= gh) continue;
        for (let ox = -1; ox <= 1; ox++) {
          if (cx + ox < 0 || cx + ox >= gw) continue;
          const c = ci + oy * gw + ox;
          for (let m = start[c], e = start[c + 1]; m < e; m++) {
            const j = items[m];
            if (j === i) continue;
            const dx = x[j] - x[i], dy = y[j] - y[i];
            if (dx * dx + dy * dy >= H2) continue;
            if (p >= this.nbr.length) this.grow();
            this.nbr[p++] = j;
          }
        }
      }
    }
    this.nStart[n] = p;
  }

  private grow() {
    const b = new Int32Array(this.nbr.length * 2);
    b.set(this.nbr);
    this.nbr = b;
  }

  /** Clavet's pairwise viscosity impulses along the line of centres (linear sigma, quadratic beta). */
  private viscosity(h: number) {
    const { n, x, y, vx, vy, nbr, nStart, H } = this;
    const { sigma, beta } = this.cfg;
    for (let i = 0; i < n; i++) {
      for (let p = nStart[i], e = nStart[i + 1]; p < e; p++) {
        const j = nbr[p];
        if (j < i) continue;
        const dx = x[j] - x[i], dy = y[j] - y[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= H * H || d2 < 1e-18) continue;
        const d = Math.sqrt(d2), q = d / H;
        const nx = dx / d, ny = dy / d;
        const u = (vx[i] - vx[j]) * nx + (vy[i] - vy[j]) * ny;
        if (u <= 0) continue;
        // sigma per second, beta per metre, as in the paper but in SI.
        const I = Math.min(u * 0.5, h * (1 - q) * (sigma * 60 * u + (beta * u * u) / this.s));
        vx[i] -= I * nx;
        vy[i] -= I * ny;
        vx[j] += I * nx;
        vy[j] += I * ny;
      }
    }
  }

  private relax(h: number) {
    const { n, x, y, nbr, nStart, H } = this;
    const { k: K, kNear, rho0 } = this.cfg;
    // Clavet's displacement dt²·(P(1-q) + P_near(1-q)²): pressures here are accelerations (m/s²).
    const scale = h * h * 0.5;
    const dmax = this.s * 0.2;
    for (let i = 0; i < n; i++) {
      const p0 = nStart[i], p1 = nStart[i + 1];
      let rho = 0, rhoN = 0;
      for (let p = p0; p < p1; p++) {
        const j = nbr[p];
        const dx = x[j] - x[i], dy = y[j] - y[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= H * H) continue;
        const q = 1 - Math.sqrt(d2) / H;
        rho += q * q;
        rhoN += q * q * q;
      }
      const P = K * (rho - rho0), PN = kNear * rhoN;
      let ax = 0, ay = 0;
      for (let p = p0; p < p1; p++) {
        const j = nbr[p];
        const dx = x[j] - x[i], dy = y[j] - y[i];
        const d2 = dx * dx + dy * dy;
        if (d2 >= H * H || d2 < 1e-18) continue;
        const d = Math.sqrt(d2), q = 1 - d / H;
        let D = scale * (P * q + PN * q * q);
        if (D > dmax) D = dmax;
        else if (D < -dmax) D = -dmax;
        const mx = (dx / d) * D, my = (dy / d) * D;
        x[j] += mx;
        y[j] += my;
        ax -= mx;
        ay -= my;
      }
      x[i] += ax;
      y[i] += ay;
    }
  }

  private walls(glass: Glass) {
    const { n, x, y, px, py, tmp } = this;
    const r = this.radius;
    for (let i = 0; i < n; i++) {
      const phi = glass.sample(x[i], y[i], tmp) + r;
      if (phi > 2 * r + 0.001) {
        // Pushed clean through the glass: put it back where it was.
        x[i] = px[i];
        y[i] = py[i];
        continue;
      }
      if (phi > 0) {
        const nx = tmp[1], ny = tmp[2];
        x[i] -= nx * phi;
        y[i] -= ny * phi;
        // A little wall drag (no-slip is too sticky at this resolution).
        const sx = x[i] - px[i], sy = y[i] - py[i];
        const sn = sx * nx + sy * ny;
        x[i] -= (sx - sn * nx) * 0.1;
        y[i] -= (sy - sn * ny) * 0.1;
      }
      if (this.plug && Math.abs(y[i]) < 0.003 + r) y[i] = (y[i] >= 0 ? 1 : -1) * (0.003 + r);
    }
  }

  /** Bubbles are voids: water inside one is pushed to its rim. */
  private pushBubbles() {
    const { x, y } = this;
    for (const b of this.bubbles) {
      const rr = b.r + this.radius;
      for (let i = 0; i < this.n; i++) {
        const dx = x[i] - b.x, dy = y[i] - b.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr) continue;
        const d = Math.sqrt(d2) || 1e-6;
        x[i] = b.x + (dx / d) * rr;
        y[i] = b.y + (dy / d) * rr;
      }
    }
  }

  private moveBubbles(glass: Glass, dt: number, f: Forces) {
    const g = Math.hypot(f.gx, f.gy) || 1;
    const ux = -f.gx / g, uy = -f.gy / g;
    const { x, y } = this;
    for (let k = this.bubbles.length - 1; k >= 0; k--) {
      const b = this.bubbles[k];
      b.age += dt;
      // Rise at a small bubble's terminal speed, zig-zagging a little, against the local gravity.
      const v = Math.min(0.26, 0.11 * Math.sqrt(g / 9.81) * Math.sqrt(b.r / 0.002) * 1.5);
      const wob = Math.sin(b.phase + b.age * 26) * 0.35;
      b.x += (ux - uy * wob) * v * dt;
      b.y += (uy + ux * wob) * v * dt;
      const phi = glass.sample(b.x, b.y, this.tmp) + b.r;
      if (phi > 0) {
        b.x -= this.tmp[1] * phi;
        b.y -= this.tmp[2] * phi;
      }
      // Pop once no water surrounds it: count water within 1.6 r.
      let wet = 0;
      const R2 = (b.r * 1.9) ** 2;
      for (let i = 0; i < this.n && wet < 6; i++) {
        const dx = x[i] - b.x, dy = y[i] - b.y;
        if (dx * dx + dy * dy < R2) wet++;
      }
      if ((wet < 6 && b.age > 0.08) || b.age > 6) this.bubbles.splice(k, 1);
    }
  }
}
