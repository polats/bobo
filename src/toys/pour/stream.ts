// The pour stream: a small 2D particle liquid in screen space (CSS px, y up). Only the stream is
// simulated; liquid resting in a tube is just a number in the layer stack. Particles use the same
// Clavet et al. 2005 double-density relaxation core as Ferro Blob (src/toys/ferro/sim.ts): pressure
// plus near-pressure makes them cohesive, so the stream necks and drips instead of spraying.
// A particle that has rested on the target tube's surface for a moment is absorbed into its top layer.

export const STREAM_CAP = 700;

/** Collision view of one tube: upright, open at the top, round at the bottom. */
export interface Vessel {
  cx: number;
  /** World y of the bottom of the round. */
  by: number;
  r: number;
  /** Interior height (bottom of round to rim). */
  h: number;
  /** Glass thickness. */
  g: number;
  /** Surface height above `by`, plus two slosh modes (tilt and bulge) in px. */
  level: number;
  m1: number;
  m2: number;
  /** False while the tube is lifted or pouring: nothing lands in it. */
  solid: boolean;
}

export class Stream {
  n = 0;
  readonly px = new Float32Array(STREAM_CAP);
  readonly py = new Float32Array(STREAM_CAP);
  readonly vx = new Float32Array(STREAM_CAP);
  readonly vy = new Float32Array(STREAM_CAP);
  private ox = new Float32Array(STREAM_CAP);
  private oy = new Float32Array(STREAM_CAP);
  readonly liq = new Int16Array(STREAM_CAP);
  readonly tgt = new Int16Array(STREAM_CAP);
  private rest = new Float32Array(STREAM_CAP);
  private age = new Float32Array(STREAM_CAP);
  private landed = new Uint8Array(STREAM_CAP);
  /** Interaction radius (px). */
  readonly H = 9;
  readonly radius = 3;
  cfg = { cohesion: 1, viscosity: 0.35, gravity: 1500, restTime: 0.3 };
  // Counting-sort neighbour grid over the screen with cell size = H.
  private gw = 1;
  private gh = 1;
  private cellStart = new Int32Array(2);
  private cellItems = new Int32Array(STREAM_CAP);
  private cellOf = new Int32Array(STREAM_CAP);
  private nbr = new Int32Array(64);
  private nbq = new Float32Array(64);

  resize(w: number, h: number) {
    this.gw = Math.max(1, Math.ceil(w / this.H) + 2);
    this.gh = Math.max(1, Math.ceil(h / this.H) + 2);
    this.cellStart = new Int32Array(this.gw * this.gh + 1);
  }

  clear() {
    this.n = 0;
  }

  spawn(x: number, y: number, vx: number, vy: number, liq: number, tgt: number) {
    if (this.n >= STREAM_CAP) return;
    const k = this.n++;
    this.px[k] = x;
    this.py[k] = y;
    this.vx[k] = vx;
    this.vy[k] = vy;
    this.liq[k] = liq;
    this.tgt[k] = tgt;
    this.rest[k] = 0;
    this.age[k] = 0;
    this.landed[k] = 0;
  }

  /** Particles still in flight towards tube `t`. */
  inFlight(t: number) {
    let c = 0;
    for (let i = 0; i < this.n; i++) if (this.tgt[i] === t) c++;
    return c;
  }

  /**
   * Advance the stream. `absorb(tube, liquid)` fires per particle taken in by a tube;
   * `hit(tube, speed, x)` fires the first time a particle touches a tube's liquid.
   */
  step(dt: number, vessels: Vessel[], absorb: (t: number, liq: number) => void, hit: (t: number, speed: number, x: number) => void) {
    if (!this.n) return;
    const sub = 2;
    const h = dt / sub;
    for (let s = 0; s < sub; s++) this.liquid(h, vessels, hit);
    // Absorb what has rested on a surface, drop what fell off the world.
    for (let i = this.n - 1; i >= 0; i--) {
      this.age[i] += dt;
      const t = this.tgt[i];
      const v = vessels[t];
      // Resting counts once a drop has touched the liquid or is idling inside the tube (on the pile).
      if (v && Math.abs(this.px[i] - v.cx) < v.r && this.py[i] < v.by + v.h) {
        if (this.landed[i] || this.vx[i] ** 2 + this.vy[i] ** 2 < 80 * 80) this.rest[i] += dt;
      } else if (this.vx[i] ** 2 + this.vy[i] ** 2 < 30 * 30) this.age[i] += dt * 4; // stray drop stuck on a rim: fade it out
      const settled = this.rest[i] > this.cfg.restTime;
      const sunk = v && this.landed[i] && this.py[i] < v.by + v.level - this.radius;
      if (settled || sunk) {
        absorb(t, this.liq[i]);
        this.kill(i);
      } else if (this.py[i] < -40 || this.age[i] > 4) this.kill(i);
    }
  }

  private kill(i: number) {
    const k = --this.n;
    if (i === k) return;
    this.px[i] = this.px[k];
    this.py[i] = this.py[k];
    this.vx[i] = this.vx[k];
    this.vy[i] = this.vy[k];
    this.liq[i] = this.liq[k];
    this.tgt[i] = this.tgt[k];
    this.rest[i] = this.rest[k];
    this.age[i] = this.age[k];
    this.landed[i] = this.landed[k];
  }

  private liquid(h: number, vessels: Vessel[], hit: (t: number, speed: number, x: number) => void) {
    const { px, py, vx, vy, ox, oy } = this;
    const n = this.n;
    const H = this.H;
    // Ferro's constants were tuned with H = 0.075 world units; displacements scale with H.
    const S = H / 0.075;
    const rho0 = 3.2;
    const k = 0.9;
    const kNear = 3.2 * this.cfg.cohesion;
    const g = this.cfg.gravity;
    for (let i = 0; i < n; i++) {
      vy[i] -= g * h;
      vx[i] *= 1 - 0.3 * h;
    }
    this.buildGrid();
    this.viscosity(h);
    for (let i = 0; i < n; i++) {
      ox[i] = px[i];
      oy[i] = py[i];
      px[i] += vx[i] * h;
      py[i] += vy[i] * h;
    }
    this.buildGrid();
    const { gw, gh, cellStart, cellItems, cellOf, nbr, nbq } = this;
    const inv = 1 / H;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      const cx = c % gw;
      const cy = (c / gw) | 0;
      let rho = 0;
      let rhoN = 0;
      let m = 0;
      for (let b = Math.max(0, cy - 1); b <= Math.min(gh - 1, cy + 1); b++)
        for (let a = Math.max(0, cx - 1); a <= Math.min(gw - 1, cx + 1); a++) {
          const cc = b * gw + a;
          for (let s = cellStart[cc]; s < cellStart[cc + 1]; s++) {
            const j = cellItems[s];
            if (j === i) continue;
            const q = Math.hypot(px[j] - px[i], py[j] - py[i]) * inv;
            if (q < 1) {
              const w = 1 - q;
              rho += w * w;
              rhoN += w * w * w;
              if (m < 64) {
                nbr[m] = j;
                nbq[m++] = q;
              }
            }
          }
        }
      // Cohesion pulls where the stream is thin (this is what keeps it a rope); clamped so it necks, not collapses.
      const P = k * Math.max(rho - rho0, -2.2 * this.cfg.cohesion);
      const PN = kNear * rhoN;
      let dxi = 0;
      let dyi = 0;
      for (let t = 0; t < m; t++) {
        const j = nbr[t];
        const q = nbq[t];
        const rx = px[j] - px[i];
        const ry = py[j] - py[i];
        const r = q * H;
        if (r < 1e-4) continue;
        const w = 1 - q;
        const D = S * Math.max(-0.004, Math.min(0.004, h * h * (P * w + PN * w * w) * 30));
        const ux = (rx / r) * D;
        const uy = (ry / r) * D;
        px[j] += ux;
        py[j] += uy;
        dxi -= ux;
        dyi -= uy;
      }
      px[i] += dxi;
      py[i] += dyi;
    }
    for (let i = 0; i < n; i++) {
      // Drops already in the pile lose most of their velocity: it's settling, not splashing.
      if (this.landed[i]) {
        ox[i] += (px[i] - ox[i]) * 0.25;
        oy[i] += (py[i] - oy[i]) * 0.25;
      }
      this.collide(i, vessels, h, hit);
      vx[i] = (px[i] - ox[i]) / h;
      vy[i] = (py[i] - oy[i]) / h;
    }
  }

  /** Keep a particle out of glass walls and on top of the liquid it lands in. */
  private collide(i: number, vessels: Vessel[], h: number, hit: (t: number, speed: number, x: number) => void) {
    const { px, py, ox } = this;
    const pr = this.radius;
    for (let t = 0; t < vessels.length; t++) {
      const v = vessels[t];
      if (!v.solid) continue;
      const lx = px[i] - v.cx;
      const ly = py[i] - v.by;
      if (ly > v.h + pr || ly < -v.g - pr || Math.abs(lx) > v.r + v.g + pr) continue;
      const inside = Math.abs(ox[i] - v.cx) < v.r;
      if (!inside) {
        // Outside the glass: slide off the rim or the outer wall.
        if (ly > v.h - pr) py[i] = v.by + v.h + pr;
        else px[i] = v.cx + Math.sign(lx || 1) * (v.r + v.g + pr);
        continue;
      }
      const lim = v.r - pr;
      if (lx > lim) px[i] = v.cx + lim;
      else if (lx < -lim) px[i] = v.cx - lim;
      const qx = (px[i] - v.cx) / v.r;
      const surf = v.level + v.m1 * qx + v.m2 * Math.cos(Math.PI * qx);
      if (v.level > 0.5 && ly < surf + pr) {
        // Land inelastically: liquid meeting liquid doesn't bounce.
        py[i] = v.by + surf + pr;
        this.oy[i] = py[i];
        ox[i] = px[i] - (px[i] - ox[i]) * 0.5;
        if (!this.landed[i]) {
          this.landed[i] = 1;
          // A stray drop in the wrong tube just vanishes: only the target's stack may change.
          if (this.tgt[i] !== t) this.age[i] = 99;
          else hit(t, -this.vy[i], px[i]);
        }
      } else if (ly < v.r) {
        // Empty tube: the round bottom.
        const dx = px[i] - v.cx;
        const dy = py[i] - (v.by + v.r);
        const d = Math.hypot(dx, dy);
        if (d > lim && d > 1e-4) {
          px[i] = v.cx + (dx / d) * lim;
          py[i] = v.by + v.r + (dy / d) * lim;
          this.oy[i] = py[i];
          ox[i] = px[i] - (px[i] - ox[i]) * 0.5;
          if (!this.landed[i]) {
            this.landed[i] = 1;
            if (this.tgt[i] !== t) this.age[i] = 99;
            else hit(t, -this.vy[i], px[i]);
          }
        }
      }
      return;
    }
  }

  private viscosity(h: number) {
    const { px, py, vx, vy, gw, gh, cellStart, cellItems, cellOf } = this;
    const sigma = this.cfg.viscosity * 6;
    const inv = 1 / this.H;
    for (let i = 0; i < this.n; i++) {
      const c = cellOf[i];
      const cx = c % gw;
      const cy = (c / gw) | 0;
      for (let b = Math.max(0, cy - 1); b <= Math.min(gh - 1, cy + 1); b++)
        for (let a = Math.max(0, cx - 1); a <= Math.min(gw - 1, cx + 1); a++) {
          const cc = b * gw + a;
          for (let s = cellStart[cc]; s < cellStart[cc + 1]; s++) {
            const j = cellItems[s];
            if (j <= i) continue;
            const rx = px[j] - px[i];
            const ry = py[j] - py[i];
            const r = Math.hypot(rx, ry);
            const q = r * inv;
            if (q >= 1 || r < 1e-4) continue;
            const ux = rx / r;
            const uy = ry / r;
            const u = (vx[i] - vx[j]) * ux + (vy[i] - vy[j]) * uy;
            if (u <= 0) continue;
            const I = Math.min(u * 0.5, h * (1 - q) * sigma * u * 4);
            vx[i] -= I * ux;
            vy[i] -= I * uy;
            vx[j] += I * ux;
            vy[j] += I * uy;
          }
        }
    }
  }

  private buildGrid() {
    const { gw, gh, cellStart, cellItems, cellOf } = this;
    const inv = 1 / this.H;
    cellStart.fill(0);
    for (let i = 0; i < this.n; i++) {
      const cx = Math.min(gw - 1, Math.max(0, Math.floor(this.px[i] * inv) + 1));
      const cy = Math.min(gh - 1, Math.max(0, Math.floor(this.py[i] * inv) + 1));
      const c = cy * gw + cx;
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < gw * gh; c++) cellStart[c + 1] += cellStart[c];
    const fill = cellStart.slice(0, gw * gh);
    for (let i = 0; i < this.n; i++) cellItems[fill[cellOf[i]]++] = i;
  }
}
