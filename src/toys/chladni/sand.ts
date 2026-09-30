// Sand grains on the plate. A resting grain leaves the plate only where the plate's peak acceleration
// beats gravity (Gamma > 1, the real threshold); it then flies a hop whose height and sideways kick
// grow with the plate's local velocity: a random kick plus a drift down the amplitude gradient. Where
// the plate is still (the nodal lines) grains stop hopping, so they pile up there; grains just under
// the threshold chatter and creep toward the node, thinning the band into a line. The figure is never
// drawn: it is where the sand stops. Hops are slowed and enlarged for the eye: a real grain hops every
// cycle, hundreds of times a second, by a fraction of a millimetre.
import { inside, type PlateShape } from './modes';

export const REST = 0, AIR = 1, FALL = 2, GONE = 3;

/** Visual gravity (plate half-sizes / s^2); hop speed, random kick and drift at unit hop strength. */
const GV = 5.5;
const HOP = 0.36;
const KICK = 0.3;
const DRIFT = 0.35;
/** Creep speed of a chattering grain just under the threshold (half-sizes / s). */
const CREEP = 0.12;
/** Plate velocity (m/s) that makes a unit hop. */
const V0 = 0.05;

export class Sand {
  readonly max: number;
  n = 0;
  readonly x: Float32Array;
  readonly y: Float32Array;
  readonly z: Float32Array;
  readonly vx: Float32Array;
  readonly vy: Float32Array;
  readonly vz: Float32Array;
  readonly state: Uint8Array;
  /** Per-grain take-off threshold (grains differ in shape and friction) and tint. */
  readonly thr: Float32Array;
  readonly tint: Float32Array;
  /** Counts from the last step. */
  hops = 0;
  landings = 0;
  onPlate = 0;
  resting = 0;

  constructor(max: number) {
    this.max = max;
    this.x = new Float32Array(max);
    this.y = new Float32Array(max);
    this.z = new Float32Array(max);
    this.vx = new Float32Array(max);
    this.vy = new Float32Array(max);
    this.vz = new Float32Array(max);
    this.state = new Uint8Array(max);
    this.thr = new Float32Array(max);
    this.tint = new Float32Array(max);
  }

  clear() {
    this.n = 0;
  }

  /** Scatter `count` new grains from above, falling onto the plate over a moment. */
  sprinkle(count: number, shape: PlateShape) {
    const add = Math.min(count, this.max - this.n);
    for (let a = 0; a < add; a++) {
      const i = this.n++;
      let x = 0, y = 0;
      do {
        x = Math.random() * 1.9 - 0.95;
        y = Math.random() * 1.9 - 0.95;
      } while (!inside(shape, x / 0.97, y / 0.97));
      this.x[i] = x;
      this.y[i] = y;
      this.z[i] = 0.05 + Math.random() * 0.5;
      this.vx[i] = this.vy[i] = 0;
      this.vz[i] = -Math.random() * 0.4;
      this.state[i] = AIR;
      this.thr[i] = 1 + Math.random() * 0.18;
      this.tint[i] = Math.random();
    }
  }

  /**
   * One frame. gamma(x, y) is the plate's peak acceleration over g, vel(x, y) its peak velocity (m/s).
   * Pushers are fingers dragged through the sand (plate coords, radius, and motion this frame).
   */
  step(dt: number, shape: PlateShape, gamma: (x: number, y: number) => number, vel: (x: number, y: number) => number, pushers: { x: number; y: number; r: number; dx: number; dy: number }[]) {
    const { x, y, z, vx, vy, vz, state, thr } = this;
    let hops = 0, landings = 0, on = 0, rest = 0;
    for (let i = 0; i < this.n; i++) {
      const s = state[i];
      if (s === GONE) continue;
      if (s === REST) {
        const G = gamma(x[i], y[i]);
        if (G > thr[i]) {
          // Hop size follows the plate's velocity (a high mode at the same Gamma throws grains less
          // far); the kick is random plus a drift down the amplitude gradient, toward quieter plate.
          const e = Math.min(2.5, Math.pow(vel(x[i], y[i]) / V0, 0.75)) * Math.min(1, (G - 1) * 2);
          vz[i] = HOP * (0.3 + e) * (0.45 + 0.55 * Math.random());
          const h = 0.015;
          const gx = gamma(x[i] + h, y[i]) - gamma(x[i] - h, y[i]), gy = gamma(x[i], y[i] + h) - gamma(x[i], y[i] - h);
          const gl = Math.hypot(gx, gy) + 1e-6, pull = (DRIFT * e * Math.min(1, gl / (2 * h) / 4)) / gl;
          const a = Math.random() * Math.PI * 2, k = KICK * e * Math.random();
          vx[i] = Math.cos(a) * k - gx * pull;
          vy[i] = Math.sin(a) * k - gy * pull;
          state[i] = AIR;
          hops++;
        } else {
          rest++;
          // Just under the threshold a grain chatters and creeps down the gradient toward the node,
          // which is what thins a broad quiet band into a line.
          const c = G / thr[i] - 0.5;
          if (c > 0) {
            const h = 0.015;
            const gx = gamma(x[i] + h, y[i]) - gamma(x[i] - h, y[i]), gy = gamma(x[i], y[i] + h) - gamma(x[i], y[i] - h);
            const gl = Math.hypot(gx, gy) + 1e-6, m = (CREEP * c * dt) / gl;
            x[i] += -gx * m + (Math.random() - 0.5) * c * 0.004;
            y[i] += -gy * m + (Math.random() - 0.5) * c * 0.004;
            if (!inside(shape, x[i], y[i])) state[i] = FALL;
          }
        }
      }
      if (state[i] === AIR || state[i] === FALL) {
        x[i] += vx[i] * dt;
        y[i] += vy[i] * dt;
        vz[i] -= GV * dt;
        z[i] += vz[i] * dt;
        if (state[i] === AIR && z[i] <= 0) {
          if (inside(shape, x[i], y[i])) {
            z[i] = 0;
            state[i] = REST;
            landings++;
          } else state[i] = FALL;
        }
        if (state[i] === FALL && z[i] < -0.6) state[i] = GONE;
      }
      if (state[i] !== FALL && state[i] !== GONE) on++;
    }
    // Fingers plough through the sand: grains in the way are shoved aside and along.
    for (const p of pushers) {
      const r2 = p.r * p.r;
      for (let i = 0; i < this.n; i++) {
        if (state[i] !== REST) continue;
        const dx = x[i] - p.x, dy = y[i] - p.y, d2 = dx * dx + dy * dy;
        if (d2 >= r2) continue;
        const d = Math.sqrt(d2) + 1e-6;
        const push = (p.r - d) * (0.6 + 0.4 * Math.random());
        x[i] += (dx / d) * push + p.dx * 0.5;
        y[i] += (dy / d) * push + p.dy * 0.5;
        if (!inside(shape, x[i], y[i])) {
          state[i] = FALL;
          vx[i] = p.dx / Math.max(dt, 1e-3) * 0.3;
          vy[i] = p.dy / Math.max(dt, 1e-3) * 0.3;
          vz[i] = 0;
        }
      }
    }
    // Compact away grains that are gone so the buffers stay dense.
    if (this.n > 0 && this.n - on > 256) {
      let w = 0;
      for (let i = 0; i < this.n; i++) {
        if (state[i] === GONE) continue;
        if (w !== i) {
          x[w] = x[i];
          y[w] = y[i];
          z[w] = z[i];
          vx[w] = vx[i];
          vy[w] = vy[i];
          vz[w] = vz[i];
          state[w] = state[i];
          thr[w] = thr[i];
          this.tint[w] = this.tint[i];
        }
        w++;
      }
      this.n = w;
    }
    this.hops = hops;
    this.landings = landings;
    this.onPlate = on;
    this.resting = rest;
  }
}
