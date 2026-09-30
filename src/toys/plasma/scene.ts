// Scene setup and the per-frame simulation step, shared by the toy and headless tests.
import { Field, FIXED } from './field';
import { Discharge, type Params } from './dbm';

export const GLOBE_N = 128;
export const GLOBE_R = 60;
export const ELECTRODE_R = 8;
export const BOARD_W = 96;
export const SUBSTEPS = 3;

export const GLOBE: Params = {
  eta: 2, volts: 1.2, Ec: 0.018, Eref: 0.06, nu: 200, memory: 3, sigma: 1, sigmaT: 2, sigmaMed: 0,
  qGrow: 0, kh: 7, tauH: 0.1, hDie: 0.4, hBirth: 0.8, kT: 0.12, tauT: 1.4, tauIon: 0.35, grainY: 1, sat: 6000, flick: 2, Iflick: 0.8, flickLen: 30, rise: 4, rho: 0.002, dropK: 20, dropOk: 0.25,
};
export const WOOD: Params = {
  eta: 2.5, volts: 1, Ec: 0.008, Eref: 0.03, nu: 1.2, memory: 4, sigma: 3, sigmaT: 2, sigmaMed: 1,
  qGrow: 0, kh: 1.5, tauH: 0.4, hDie: -1, hBirth: 0.6, kT: 0.6, tauT: 3, tauIon: 0, grainY: 1.5, sat: 30, flick: 0, Iflick: 1, flickLen: 30, rise: 0, rho: 0, dropK: 0, dropOk: 1,
};
export const ACRYLIC: Params = {
  eta: 2, volts: 1, Ec: 0.03, Eref: 0.06, nu: 200, memory: 0, sigma: 1, sigmaT: 1, sigmaMed: 0,
  qGrow: 0, kh: 1.6, tauH: 0.25, hDie: -1, hBirth: 0.9, kT: 0.5, tauT: 1, tauIon: 0, grainY: 1, sat: 3000, flick: 0, Iflick: 1, flickLen: 30, rise: 0, rho: 0, dropK: 0, dropOk: 1,
};

/** Glass and body constants for the globe (dev hook can override). */
export const GLASS = { C: 0.1, leak: 0.5, spot: 4, Rs: 0.01, bodyC: 4, bodyLeak: 0.1, beta: 0.5, band: 12, electrode: ELECTRODE_R };

export function buildGlobe(p: Params) {
  const N = GLOBE_N, c0 = N / 2;
  const f = new Field(N, N, false);
  const d = new Discharge(f, p);
  const inside = (x: number, y: number) => Math.hypot(x + 0.5 - c0, y + 0.5 - c0) < GLOBE_R;
  const ring: [number, number][] = [];
  const core: number[] = [];
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      const i = y * N + x;
      const r = Math.hypot(x + 0.5 - c0, y + 0.5 - c0);
      if (inside(x, y)) {
        f.phi[i] = Math.max(0, Math.min(1, Math.log(GLOBE_R / r) / Math.log(GLOBE_R / GLASS.electrode)));
        if (r < GLASS.electrode) core.push(i);
      } else if (inside(x + 1, y) || inside(x - 1, y) || inside(x, y + 1) || inside(x, y - 1)) ring.push([Math.atan2(y + 0.5 - c0, x + 0.5 - c0), i]);
      else f.set(i, FIXED, 0);
    }
  ring.sort((a, b) => a[0] - b[0]);
  const wd = new Float32Array(N * N);
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) wd[y * N + x] = GLOBE_R - Math.hypot(x + 0.5 - c0, y + 0.5 - c0);
  d.wallDist = wd;
  d.wallBand = GLASS.band;
  // Each glass cell's inner neighbour: the 4-neighbour nearest the centre.
  const inner = ring.map(([, i]) => {
    let best = i, bd = Infinity;
    for (const nb of [i + 1, i - 1, i + N, i - N]) {
      const r = Math.hypot((nb % N) + 0.5 - c0, ((nb / N) | 0) + 0.5 - c0);
      if (r < bd) (bd = r), (best = nb);
    }
    return best;
  });
  d.setRing(ring.map((r) => r[1]), inner);
  d.glassBeta = GLASS.beta;
  d.glassC = GLASS.C;
  d.glassLeak = GLASS.leak;
  d.setSpot(GLASS.spot);
  const nail = d.addElectrode({ V: 1, grows: true, Rs: GLASS.Rs, cells: core });
  for (let k = 0; k < 8; k++) f.vcycle();
  return { f, d, nail };
}

/** A board W x H cells (H a multiple of 16): wood has insulating edges and grain; acrylic grounded edges. */
export function buildBoard(p: Params, GH: number, wood: boolean) {
  const f = new Field(BOARD_W, GH, wood);
  const d = new Discharge(f, p);
  let nail = -1;
  if (wood) {
    f.ay = 1.6;
    f.phi.fill(1);
    nail = d.addElectrode({ V: 1, grows: true, permanent: true, Rs: 0.05, cells: disc(d, BOARD_W / 2, Math.round(GH * 0.8), 1.6) });
  } else {
    for (let x = 0; x < BOARD_W; x++) f.set(x, FIXED, 0), f.set((GH - 1) * BOARD_W + x, FIXED, 0);
    for (let y = 0; y < GH; y++) f.set(y * BOARD_W, FIXED, 0), f.set(y * BOARD_W + BOARD_W - 1, FIXED, 0);
  }
  return { f, d, nail };
}

/** Cells within radius r of (x, y) inside the domain (not glass or the outside). */
export function disc(d: Discharge, x: number, y: number, r: number) {
  const out: number[] = [];
  const f = d.f, W = f.W, H = f.H;
  for (let j = Math.floor(y - r); j <= Math.ceil(y + r); j++)
    for (let i = Math.floor(x - r); i <= Math.ceil(x + r); i++) {
      if (i < 1 || j < 1 || i >= W - 1 || j >= H - 1) continue;
      if ((i - x) ** 2 + (j - y) ** 2 > r * r) continue;
      const c = j * W + i;
      if (d.ring.length && f.kind[c] === FIXED && d.owner[c] < 0 && d.slotOf[c] < 0) continue;
      out.push(c);
    }
  return out;
}

/** One frame: growth substeps with an SOR sweep after each, the circuit, then a V-cycle. */
export function step(d: Discharge, dt: number, t: number, extra?: () => void) {
  d.beginFrame();
  const sub = dt / SUBSTEPS;
  for (let k = 0; k < SUBSTEPS; k++) {
    d.grow(sub, t);
    d.f.sweep(1.6);
  }
  extra?.();
  d.circuit(dt);
  d.f.vcycle();
}
