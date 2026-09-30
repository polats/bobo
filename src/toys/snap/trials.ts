// Headless break trials: Heisser et al.'s protocol run through the toy's own World and grips.
// Hold a strand at both ends, twist it, push the ends together at a steady speed until it breaks,
// let the cascade play out, and count the pieces. Nothing here touches the cascade itself.

import { MATS, type MatId } from './materials';
import { Rod, World, rng } from './sim';

export interface TrialOpts {
  mat?: MatId;
  /** Total twist applied before bending, degrees. */
  twist?: number;
  /** End-to-end approach speed, m/s. */
  speed?: number;
  seed?: number;
  /** Grip slip moment as a fraction of the limit curvature (0 = pivoting ends). */
  slip?: number;
  slowmo?: 'off' | 'slow' | 'deep';
  /** Stop after the first crack and report the curvature overshoot C instead. */
  firstOnly?: boolean;
  bundle?: number;
}

export interface TrialResult {
  pieces: number[];
  lengths: number[][];
  /** Curvature (1/m) and total twist (deg) at the first crack. */
  kappa: number;
  twistAt: number;
  /** Largest curvature while ringing / curvature at the first crack. */
  overshoot: number;
  lambda: number;
  micro: number[];
  crackTimes: number[];
  simTime: number;
}

export function trial(o: TrialOpts = {}): TrialResult {
  const mat = MATS[o.mat ?? 'spaghetti'];
  const rnd = rng(o.seed ?? 1);
  const w = new World();
  w.slowmo = o.slowmo ?? 'deep';
  w.slip = o.slip ?? 0.4;
  w.left = -1;
  w.right = 1;
  w.floor = -1;
  if (o.firstOnly) w.maxCuts = 1;
  const nb = o.bundle ?? 1;
  const rods: Rod[] = [];
  for (let k = 0; k < nb; k++) {
    const r = Rod.strand(mat, -mat.L / 2, 0.2 + k * 0.002, 0, k, 0.5, rnd);
    rods.push(r);
    w.rods.push(r);
  }
  w.fingers.set(1, { x: -mat.L / 2, y: 0.2, tw: 0 });
  w.fingers.set(2, { x: mat.L / 2, y: 0.2, tw: 0 });
  for (const r of rods) {
    w.grab(r, 0, 1);
    w.grab(r, r.n - 1, 2);
  }
  const dt = 1 / 60;
  const tw = ((o.twist ?? 0) * Math.PI) / 180;
  let first = -1, kappa = 0, twistAt = 0, lambda = 0;
  const micro: number[] = [];
  const crackTimes: number[] = [];
  const record = (c: { t: number; kappa: number; twist: number; a: Rod }) => {
    crackTimes.push(c.t);
    if (first >= 0) return;
    first = c.t;
    kappa = c.kappa;
    twistAt = (Math.abs(c.twist) * mat.L * 180) / Math.PI;
    lambda = c.a.lambda;
  };
  const v = o.speed ?? 0.003;
  const fa = w.fingers.get(1)!, fb = w.fingers.get(2)!;
  // Twist over half a second, settle, then bend.
  let t = 0;
  for (; t < 0.8; t += dt) {
    const u = Math.min(1, t / 0.5);
    fa.tw = -tw * u * 0.5;
    fb.tw = tw * u * 0.5;
    w.step(dt);
    for (const m of w.micros) micro.push(m.energy);
    for (const c of w.cracks) record(c);
  }
  let after = 0;
  for (let f = 0; f < 60 * 120; f++) {
    if (first < 0) {
      // Stop pushing once the ends nearly meet.
      if (fb.x - fa.x > mat.L * 0.2) {
        fa.x += (v / 2) * dt;
        fb.x -= (v / 2) * dt;
      }
    }
    w.step(dt);
    for (const m of w.micros) micro.push(m.energy);
    for (const c of w.cracks) record(c);
    if (first >= 0) {
      after += dt;
      // Wait out the slow motion and the ring-down.
      if (w.rate >= 1 && after > 1.5) break;
    }
  }
  return {
    pieces: rods.map((r) => w.pieces(r.strand)),
    lengths: rods.map((r) => w.rods.filter((p) => p.strand === r.strand).map((p) => +(p.length * 100).toFixed(1))),
    kappa,
    twistAt,
    overshoot: kappa > 0 ? w.peakKappa / kappa : 0,
    lambda,
    micro,
    crackTimes,
    simTime: w.time,
  };
}

/** Many trials: histogram of pieces per strand, mean, and the limit curvature. */
export function trials(o: TrialOpts & { n?: number } = {}) {
  const n = o.n ?? 30;
  const hist: Record<number, number> = {};
  let sum = 0, count = 0, ksum = 0, osum = 0, lsum = 0;
  const micro: number[] = [];
  for (let i = 0; i < n; i++) {
    const r = trial({ ...o, seed: (o.seed ?? 1) * 1000 + i });
    for (const p of r.pieces) {
      hist[p] = (hist[p] ?? 0) + 1;
      sum += p;
      count++;
    }
    ksum += r.kappa;
    osum += r.overshoot;
    lsum += r.lambda;
    micro.push(...r.micro);
  }
  return {
    n,
    mat: o.mat ?? 'spaghetti',
    twist: o.twist ?? 0,
    speed: o.speed ?? 0.003,
    hist,
    mean: +(sum / Math.max(1, count)).toFixed(2),
    binary: +((hist[2] ?? 0) / Math.max(1, count)).toFixed(2),
    kappa: +(ksum / n).toFixed(2),
    overshoot: +(osum / n).toFixed(2),
    lambdaCm: +((lsum / n) * 100).toFixed(2),
    microCount: micro.length,
    microB: powerLawB(micro),
  };
}

/** Maximum-likelihood power-law exponent b of P(E) ∝ E^−b above the median energy (Clauset et al.). */
export function powerLawB(e: number[]) {
  const s = e.filter((x) => x > 0).sort((a, b) => a - b);
  if (s.length < 20) return 0;
  const xmin = s[Math.floor(s.length / 2)];
  const tail = s.filter((x) => x >= xmin);
  const sum = tail.reduce((a, x) => a + Math.log(x / xmin), 0);
  return +(1 + tail.length / sum).toFixed(2);
}
