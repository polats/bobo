// The vibrating plate as a bank of modal oscillators, one per Ritz mode. Each mode carries a complex
// amplitude A (its free motion, q = Re[A e^{i w t}]) that taps, the bow and damping fingers act on,
// and a driven part B that a sung note holds at steady state. The same amplitudes feed the sound
// (voice.ts) and the peak acceleration field the sand hops on (Gamma = |a| / g), so what you hear is
// what moves the sand.
import { basisAt, evalMode, solveModes, type PlateModes, type PlateShape } from './modes';

/** Half the plate's side (or its radius), metres: a 24 cm plate. */
export const HALF = 0.12;
/** Steel, 1.5 mm: flexural rigidity D = E h^3 / 12(1 - nu^2) and mass per area rho h. */
const E = 200e9, RHO = 7850, H = 0.0015;
const D = (E * H ** 3) / (12 * (1 - 0.3 ** 2));
const RHO_H = RHO * H;
/** omega = sqrt(lambda) * this, for lambda in half-size units. */
const W_SCALE = Math.sqrt(D / RHO_H) / (HALF * HALF);
export const GRAV = 9.81;
/** Ritz degree, field grid and mode count. */
const DEGREE = 20;
export const GRID = 72;
const MAX_MODES = 30;

/** Finger impact: impulse (N s) and contact time (s); the contact's spectrum rolls off above ~1/tau. */
const TAP_J = 0.035;
const TAP_TAU = 0.0011;
/**
 * Bow: negative friction slope (N s/m), the fraction of bow speed the contact point may reach, and
 * the most friction force it can apply (N). The force cap makes a bowed mode settle where its losses
 * eat what the bow gives, so its acceleration comes out about the same at any pitch.
 */
const BOW_R = 7;
const BOW_SAT = 0.5;
const BOW_F = 0.03;
/** A finger pressed on the plate: dashpot (N s/m). */
const FINGER_C = 16;
/** Sung drive force at full loudness (N), and the voice's effective line width (fraction of pitch). */
const SING_F = 0.55;
const SING_W = 0.012;

export interface Contact {
  x: number;
  y: number;
  /** Bow speed along the edge, m/s (bows only). */
  speed?: number;
  /** 0..1 how firmly it presses (dampers only). */
  press?: number;
}

export class Plate {
  readonly modes: PlateModes;
  readonly n: number;
  readonly omega: Float64Array;
  readonly freq: Float64Array;
  /** Degenerate (or nearly) modes ring together coherently: cluster id per mode. */
  readonly cluster: Int32Array;
  readonly clusters: number[][];
  readonly mass: number;
  readonly are: Float64Array;
  readonly aim: Float64Array;
  readonly bre: Float64Array;
  readonly bim: Float64Array;
  /** Peak acceleration over g, and peak velocity (m/s), at the grid cell centres. */
  readonly field: Float32Array;
  readonly vel: Float32Array;
  /** Loss factor; the ring time of a mode at f Hz is about 2.2 / (eta f) seconds. */
  eta = 0.002;
  /** Last frame's bow state, for sound: 0 while the bow hunts, 1 once a mode has locked to it. */
  bowLock = 0;
  private fre: Float32Array;
  private fim: Float32Array;
  private drive = { omega: 0, level: 0, idle: 1 };

  constructor(readonly shape: PlateShape) {
    this.modes = solveModes(shape, DEGREE, GRID, MAX_MODES);
    const n = (this.n = this.modes.modes.length);
    this.omega = Float64Array.from(this.modes.modes, (m) => Math.sqrt(m.lambda) * W_SCALE);
    this.freq = this.omega.map((w) => w / (2 * Math.PI));
    this.mass = RHO_H * HALF * HALF * (shape === 'square' ? 4 : Math.PI);
    this.cluster = new Int32Array(n);
    this.clusters = [];
    for (let k = 0; k < n; k++) {
      const last = this.clusters[this.clusters.length - 1];
      if (last && Math.abs(this.freq[k] / this.freq[last[0]] - 1) < 0.004) last.push(k);
      else this.clusters.push([k]);
      this.cluster[k] = this.clusters.length - 1;
    }
    this.are = new Float64Array(n);
    this.aim = new Float64Array(n);
    this.bre = new Float64Array(n);
    this.bim = new Float64Array(n);
    this.field = new Float32Array(GRID * GRID);
    this.vel = new Float32Array(GRID * GRID);
    this.fre = new Float32Array(GRID * GRID);
    this.fim = new Float32Array(GRID * GRID);
  }

  /** Mode values at a plate point (x, y in [-1, 1], y down). */
  shapesAt(x: number, y: number, out = new Float64Array(this.n)) {
    const b = basisAt(this.modes.N, x, y);
    for (let k = 0; k < this.n; k++) out[k] = evalMode(this.modes.modes[k], b);
    return out;
  }

  /** Damping rate of mode k's amplitude, 1/s: material loss plus air. */
  gamma(k: number) {
    return (this.eta * this.omega[k]) / 2 + 0.05;
  }

  /** Strike at (x, y): an impulse, each mode excited by its shape there (a node stays silent). */
  tap(x: number, y: number, strength = 1) {
    const phi = this.shapesAt(x, y);
    const J = TAP_J * strength;
    const wc = 2.5 / TAP_TAU;
    for (let k = 0; k < this.n; k++) {
      const w = this.omega[k];
      const s = 1 / Math.sqrt(1 + (w / wc) ** 4);
      // An impulse J gives velocity J phi / M, displacement amplitude J phi / (M w), a quarter period behind.
      this.aim[k] -= (J * phi[k] * s) / (this.mass * w);
    }
  }

  /** Sung note: frequency (Hz, 0 for none) and loudness 0..1. */
  sing(freq: number, level: number) {
    if (freq > 0) {
      this.drive.omega = 2 * Math.PI * freq;
      this.drive.level = level;
      this.drive.idle = 0;
    }
  }

  /** Nudge every mode a little (sand landing, a bow's first touch) so self-excitation has a seed. */
  private seed(phi: Float64Array, amount: number) {
    for (let k = 0; k < this.n; k++) {
      const w = this.omega[k], a = Math.random() * Math.PI * 2, m = (amount * phi[k]) / (this.mass * w) / (1 + (w / 3000) ** 2);
      this.are[k] += m * Math.cos(a);
      this.aim[k] += m * Math.sin(a);
    }
  }

  step(dt: number, bows: Contact[], dampers: Contact[]) {
    const n = this.n, M = this.mass;
    const extra = new Float64Array(n);
    for (const d of dampers) {
      const phi = this.shapesAt(d.x, d.y);
      for (let k = 0; k < n; k++) extra[k] += (FINGER_C * (d.press ?? 1) * phi[k] * phi[k]) / (2 * M);
    }
    // Bowing: stick-slip friction is a negative resistance at the contact, pumping every mode by its
    // shape squared there, until the contact point moves nearly as fast as the bow (then friction can
    // no longer feed it). Modes compete for that shared limit, so the best-placed one takes over.
    const growth = new Float64Array(n);
    this.bowLock = 0;
    for (const b of bows) {
      const phi = this.shapesAt(b.x, b.y);
      const u = b.speed ?? 0;
      let v2 = 0;
      for (let k = 0; k < n; k++) {
        const w = this.omega[k];
        v2 += w * w * (this.are[k] ** 2 + this.aim[k] ** 2 + this.bre[k] ** 2 + this.bim[k] ** 2) * phi[k] * phi[k];
      }
      const vc = Math.sqrt(v2);
      const R = BOW_R * smooth(0.01, 0.08, u);
      // Friction pumps until the contact runs nearly as fast as the bow, or the friction force tops out.
      const lockV = vc / Math.max(1e-4, BOW_SAT * Math.min(u, 0.35));
      const lockF = (R * vc) / BOW_F;
      this.bowLock = Math.max(this.bowLock, Math.min(1, Math.max(lockV, lockF)));
      const f = R > 0 ? Math.min(1, 1 / Math.max(lockF, 1e-6)) * Math.max(-1, 1 - lockV * lockV) : 0;
      // A bow resting on the rim without moving just grips it (a damper there).
      const grip = u < 0.02 ? (BOW_R * 0.5 * (1 - u / 0.02)) / (2 * M) : 0;
      for (let k = 0; k < n; k++) {
        const p2 = phi[k] * phi[k];
        const g = (R * p2) / (2 * M);
        growth[k] += g * f - grip * p2;
      }
      if (u > 0.01) this.seed(phi, 0.00008 * Math.min(1, u / 0.2) * dt * 60);
    }
    // Free parts: exact exponential growth or decay over the frame.
    for (let k = 0; k < n; k++) {
      const s = Math.exp((growth[k] - this.gamma(k) - extra[k]) * dt);
      this.are[k] *= s;
      this.aim[k] *= s;
    }
    // Driven parts relax to the forced response: a Lorentzian in the detuning, widened by the voice's
    // own wobble. When the note stops they carry on as free ringing.
    const dr = this.drive;
    dr.idle += dt;
    if (dr.idle < 0.15 && dr.omega > 0) {
      const F = SING_F * Math.min(1, dr.level * 1.6);
      for (let k = 0; k < n; k++) {
        const w = this.omega[k];
        const G = this.gamma(k) + extra[k] + SING_W * dr.omega;
        const det = w - dr.omega;
        const m = F / (2 * M * w) / (G * G + det * det);
        const tr = m * G, ti = -m * det;
        const r = 1 - Math.exp(-(this.gamma(k) + extra[k] + 5) * dt);
        this.bre[k] += (tr - this.bre[k]) * r;
        this.bim[k] += (ti - this.bim[k]) * r;
      }
    } else {
      for (let k = 0; k < n; k++) {
        this.are[k] += this.bre[k];
        this.aim[k] += this.bim[k];
        this.bre[k] = this.bim[k] = 0;
      }
      dr.omega = 0;
    }
  }

  /** Is the note being held (and at what angular frequency)? */
  get driveOmega() {
    return this.drive.idle < 0.15 ? this.drive.omega : 0;
  }

  /** Velocity amplitude of mode k (m/s at a point where phi = 1), free and driven parts. */
  velocity(k: number) {
    return this.omega[k] * Math.hypot(this.are[k], this.aim[k], this.bre[k], this.bim[k]);
  }

  /**
   * Peak acceleration / g over the grid: modes at different frequencies beat and add in energy,
   * degenerate ones and the driven parts (all at the sung frequency) add as complex amplitudes.
   */
  updateField() {
    const f = this.field, v = this.vel, re = this.fre, im = this.fim, G2 = GRID * GRID;
    f.fill(0);
    v.fill(0);
    const ms = this.modes.modes;
    for (const c of this.clusters) {
      let any = false;
      re.fill(0);
      im.fill(0);
      for (const k of c) {
        const w2 = (this.omega[k] * this.omega[k]) / GRAV;
        const ar = this.are[k] * w2, ai = this.aim[k] * w2;
        if (ar * ar + ai * ai < 1e-6) continue;
        any = true;
        const g = ms[k].grid;
        for (let i = 0; i < G2; i++) {
          re[i] += ar * g[i];
          im[i] += ai * g[i];
        }
      }
      const iw = (GRAV / this.omega[c[0]]) ** 2;
      if (any)
        for (let i = 0; i < G2; i++) {
          const e = re[i] * re[i] + im[i] * im[i];
          f[i] += e;
          v[i] += e * iw;
        }
    }
    let any = false;
    re.fill(0);
    im.fill(0);
    const wd = this.driveOmega || 1;
    for (let k = 0; k < this.n; k++) {
      const w2 = (wd * wd) / GRAV;
      const br = this.bre[k] * w2, bi = this.bim[k] * w2;
      if (br * br + bi * bi < 1e-6) continue;
      any = true;
      const g = ms[k].grid;
      for (let i = 0; i < G2; i++) {
        re[i] += br * g[i];
        im[i] += bi * g[i];
      }
    }
    const iw = (GRAV / wd) ** 2;
    if (any)
      for (let i = 0; i < G2; i++) {
        const e = re[i] * re[i] + im[i] * im[i];
        f[i] += e;
        v[i] += e * iw;
      }
    let peak = 0;
    for (let i = 0; i < G2; i++) {
      f[i] = Math.sqrt(f[i]);
      v[i] = Math.sqrt(v[i]);
      if (this.modes.mask[i] && f[i] > peak) peak = f[i];
    }
    return peak;
  }

  /** Bilinear sample of a grid field at a plate point. */
  sample(f: Float32Array, x: number, y: number) {
    const gx = Math.max(0, Math.min(GRID - 1.001, ((x + 1) * GRID) / 2 - 0.5));
    const gy = Math.max(0, Math.min(GRID - 1.001, ((y + 1) * GRID) / 2 - 0.5));
    const ix = gx | 0, iy = gy | 0, fx = gx - ix, fy = gy - iy, o = iy * GRID + ix;
    return (f[o] * (1 - fx) + f[o + 1] * fx) * (1 - fy) + (f[o + GRID] * (1 - fx) + f[o + GRID + 1] * fx) * fy;
  }

  /** Kinetic energy (J), for haptics. */
  energy() {
    let e = 0;
    for (let k = 0; k < this.n; k++) e += 0.5 * this.mass * this.velocity(k) ** 2;
    return e;
  }

  silence() {
    this.are.fill(0);
    this.aim.fill(0);
    this.bre.fill(0);
    this.bim.fill(0);
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}
