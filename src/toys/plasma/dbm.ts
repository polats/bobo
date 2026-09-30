// The dielectric breakdown model (Niemeyer, Pietronero & Wiesmann 1984) in continuous time, with the
// circuit that keeps a plasma globe's filaments alive. Every free cell next to a discharge channel
// breaks down at a rate ∝ |E|^η, where |E| is the potential drop from the channel to that cell (divided
// by the step length, so diagonal steps see a weaker field); choosing the next event in proportion to
// its rate is exactly the DBM's growth probability. New cells join the channel's tree and take its
// potential. Channels carry current (measured as the flux of the field into whatever grounds them:
// the glass, a finger, the other electrode's tree), current heats them, and a channel whose current
// dies away cools and goes out, taking the branches beyond it with it. That decay and regrowth is the
// flicker; charge piling up on the glass where a filament lands is what makes the filaments wander.
import { Field, FIXED, FREE } from './field';

export interface Electrode {
  /** Potential (the field is normalised: the globe's electrode sits at 1). */
  V: number;
  /** Grows discharge trees from its cells. */
  grows: boolean;
  /** Tree cells never go out (charred wood stays charred). */
  permanent: boolean;
  /** Capacitance: 0 = held at V; otherwise V charges by the current it collects and leaks back to V0. */
  C: number;
  V0: number;
  leak: number;
  /** Source impedance: a driven electrode sags to V0 / (1 + Rs I) under load. */
  Rs: number;
  cells: number[];
  /** Current into or out of this electrode this frame, and how many channel cells touch it. */
  I: number;
  contacts: number;
  prevContacts: number;
  alive: boolean;
}

export interface Params {
  eta: number;
  /** Voltage scale: multiplies |E|, so more cells clear the breakdown threshold. */
  volts: number;
  /** Breakdown threshold and reference field (rate = nu at E = Eref). */
  Ec: number;
  Eref: number;
  nu: number;
  /** Growth-rate boost from leftover ionisation (or old char). */
  memory: number;
  /** Conductance of a channel (cold, and extra per unit of slow heat) and of the surrounding medium. */
  sigma: number;
  sigmaT: number;
  sigmaMed: number;
  /** Charge a new cell carries back to the root (the streamer head's charging current). */
  qGrow: number;
  /** Fast glow h: gain per unit current and decay time; channels go out below hDie. */
  kh: number;
  tauH: number;
  hDie: number;
  hBirth: number;
  /** Slow heat T (0..1): gain and decay time. Thickens a channel that carries current for a while. */
  kT: number;
  tauT: number;
  /** Ionisation memory decay time. */
  tauIon: number;
  /** Anisotropy: growth-rate factor for steps along y (the grain). */
  grainY: number;
  /** Most breakdowns per second (the whole discharge), however strong the field. */
  sat: number;
  /** Channel resistivity: potential drops along a channel by I * rho / sigma per cell (0 = ideal conductor). */
  rho: number;
  /** Re-strike failure from the drop along a channel: rate grows as dropK (drop - dropOk)^2. */
  dropK: number;
  dropOk: number;
  /**
   * Re-strike failure: the drive is AC, so every half-cycle each filament must re-ignite; a weak one
   * sometimes fails and goes out whole, at a rate flick * exp(-I / Iflick) per second.
   */
  flick: number;
  Iflick: number;
  flickLen: number;
  /** Convection: the ionised gas a channel leaves behind rises at this speed (cells/s). */
  rise: number;
}

const MAX = 16000;
const MAXC = 40000;
const DIRS = [
  [1, 0, 1],
  [-1, 0, 1],
  [0, 1, 1],
  [0, -1, 1],
  [1, 1, Math.SQRT2],
  [-1, 1, Math.SQRT2],
  [1, -1, Math.SQRT2],
  [-1, -1, Math.SQRT2],
] as const;

export class Discharge {
  readonly f: Field;
  readonly W: number;
  readonly H: number;
  // Channel cells, parents always before children.
  n = 0;
  readonly cell = new Int32Array(MAX);
  readonly parent = new Int32Array(MAX);
  readonly tree = new Uint8Array(MAX);
  readonly h = new Float32Array(MAX);
  readonly T = new Float32Array(MAX);
  readonly I = new Float32Array(MAX);
  readonly Iown = new Float32Array(MAX);
  /** Current leaving each cell sideways into the medium or a contact (where Joule heat is made). */
  readonly Iloc = new Float32Array(MAX);
  readonly born = new Float32Array(MAX);
  /** Each channel cell's own potential (its electrode's, less the resistive drop along the path). */
  readonly Vs = new Float32Array(MAX);
  readonly slotOf: Int32Array;
  /** Which electrode owns a fixed cell (-1 none); ring cells are glass. */
  readonly owner: Int16Array;
  readonly ion: Float32Array;
  private stamp: Uint32Array;
  private stampN = 1;
  private remap = new Int32Array(MAX);
  private dead = new Uint8Array(MAX);
  private kids = new Uint16Array(MAX);
  private riseAcc = 0;
  private cand = new Int32Array(MAXC);
  private from = new Int32Array(MAXC);
  private cum = new Float64Array(MAXC);
  private field = new Float32Array(MAXC);

  electrodes: Electrode[] = [];
  /** Distance to the glass (cells); within wallBand, growth may only approach it (no creeping along it). */
  wallDist: Float32Array | null = null;
  wallBand = 3;
  /** Glass: ring cells (ordered by angle), their potential, the flux into each, and the glass capacitance. */
  ring = new Int32Array(0);
  ringV = new Float32Array(0);
  ringI = new Float32Array(0);
  glassC = 0.2;
  glassLeak = 0.6;
  /**
   * The glass isn't grounded (the room outside it is): its inner surface sits at glassBeta times the
   * potential just inside it, the exterior field of an ungrounded shell, plus its own surface charge.
   */
  glassBeta = 0.5;
  ringIn = new Int32Array(0);
  private ringAdd = new Float32Array(0);
  /** Foot radius on the glass (cells) and its normalised Gaussian kernel. */
  glassSpot = 3;
  private spotK = new Float32Array(0);

  // Per-frame stats and events.
  grown = 0;
  grownX = 0;
  died = 0;
  /** Growth events this frame with the field that drove them: [x, y, E] triples. */
  events: number[] = [];
  /** New contacts: [electrode index, x, y, current]. */
  zaps: number[] = [];

  constructor(f: Field, public p: Params) {
    this.f = f;
    this.W = f.W;
    this.H = f.H;
    const n = f.W * f.H;
    this.slotOf = new Int32Array(n).fill(-1);
    this.owner = new Int16Array(n).fill(-1);
    this.ion = new Float32Array(n);
    this.stamp = new Uint32Array(n);
  }

  addElectrode(e: Partial<Electrode> & { V: number; cells: number[] }) {
    const el: Electrode = { grows: false, permanent: false, C: 0, V0: e.V, leak: 0.1, Rs: 0, I: 0, contacts: 0, prevContacts: 0, alive: true, ...e };
    // Reuse a removed electrode's slot: tree ids are bytes.
    let id = this.electrodes.findIndex((x) => !x.alive);
    if (id < 0) id = this.electrodes.push(el) - 1;
    else this.electrodes[id] = el;
    this.claim(id, el.cells);
    return id;
  }

  /** Give an electrode new spot cells (a finger moving): old spot cells go back to the medium. */
  moveElectrode(id: number, cells: number[]) {
    const el = this.electrodes[id];
    const next = new Set(cells);
    const W = this.W;
    for (const c of el.cells) {
      if (next.has(c)) continue;
      // Sliding off a spot tears the old foot away: channel cells that only touched it go out.
      for (const nb of [c + 1, c - 1, c + W, c - W]) {
        const ns = this.slotOf[nb];
        if (ns < 0 || this.tree[ns] === id || next.has(nb + 1) || next.has(nb - 1) || next.has(nb + W) || next.has(nb - W)) continue;
        if (this.parent[ns] >= 0) this.kill(ns);
      }
      if (this.slotOf[c] >= 0 && this.tree[this.slotOf[c]] === id) this.kill(this.slotOf[c]);
      if (this.owner[c] === id) {
        this.owner[c] = -1;
        if (this.slotOf[c] < 0) this.f.set(c, FREE);
      }
    }
    el.cells = cells;
    this.claim(id, cells);
    this.compact();
  }

  private claim(id: number, cells: number[]) {
    const el = this.electrodes[id];
    // A finger pressed onto a channel cuts it there; the part beyond goes out.
    for (const c of cells) {
      const s = this.slotOf[c];
      if (s >= 0 && this.tree[s] !== id) this.kill(s);
    }
    this.compact();
    for (const c of cells) {
      this.owner[c] = id;
      this.f.set(c, FIXED, el.V);
      if (el.grows && this.slotOf[c] < 0) this.push(c, -1, id, 1, 0);
    }
    this.compact();
  }

  /** Remove an electrode; its tree either goes out or (charred wood) stays as plain medium. */
  removeElectrode(id: number) {
    const el = this.electrodes[id];
    el.alive = false;
    for (let s = 0; s < this.n; s++) if (this.tree[s] === id) this.dead[s] = 1;
    for (const c of el.cells) if (this.owner[c] === id) this.owner[c] = -1;
    this.compact();
    for (const c of el.cells) if (this.slotOf[c] < 0 && this.owner[c] < 0) this.f.set(c, FREE);
    el.cells = [];
  }

  setRing(cells: number[], inner: number[]) {
    this.ring = Int32Array.from(cells);
    this.ringIn = Int32Array.from(inner);
    this.ringV = new Float32Array(cells.length);
    this.ringI = new Float32Array(cells.length);
    this.ringAdd = new Float32Array(cells.length);
    this.setSpot(this.glassSpot);
    for (const c of cells) this.f.set(c, FIXED, 0);
  }

  setSpot(w: number) {
    this.glassSpot = w = Math.max(1, Math.round(w));
    this.spotK = new Float32Array(4 * w + 1);
    let tot = 0;
    for (let j = -2 * w; j <= 2 * w; j++) tot += this.spotK[j + 2 * w] = Math.exp(-(j * j) / (w * w));
    for (let j = 0; j < this.spotK.length; j++) this.spotK[j] /= tot;
  }

  private push(c: number, parent: number, tree: number, h: number, t: number) {
    if (this.n >= MAX) return -1;
    const s = this.n++;
    this.cell[s] = c;
    this.parent[s] = parent;
    this.tree[s] = tree;
    this.h[s] = h;
    this.T[s] = parent >= 0 ? this.T[parent] * 0.5 : 0;
    this.I[s] = 0;
    this.Iown[s] = 0;
    this.Iloc[s] = 0;
    this.born[s] = t;
    this.Vs[s] = parent >= 0 ? this.Vs[parent] : this.electrodes[tree].V;
    this.dead[s] = 0;
    this.slotOf[c] = s;
    return s;
  }

  private kill(s: number) {
    this.dead[s] = 1;
  }

  /** Drop dead cells and everything beyond them; keep order so parents still precede children. */
  private compact() {
    let any = false;
    for (let s = 0; s < this.n; s++) {
      const p = this.parent[s];
      if (!this.dead[s] && p >= 0 && this.dead[p]) this.dead[s] = 1;
      if (this.dead[s]) any = true;
    }
    if (!any) return;
    let k = 0;
    for (let s = 0; s < this.n; s++) {
      const c = this.cell[s];
      if (this.dead[s]) {
        this.slotOf[c] = -1;
        this.remap[s] = -1;
        if (this.owner[c] < 0) this.f.set(c, FREE);
        this.died++;
        continue;
      }
      this.remap[s] = k;
      if (k !== s) {
        this.cell[k] = c;
        this.parent[k] = this.parent[s] >= 0 ? this.remap[this.parent[s]] : -1;
        this.tree[k] = this.tree[s];
        this.h[k] = this.h[s];
        this.T[k] = this.T[s];
        this.I[k] = this.I[s];
        this.Iown[k] = this.Iown[s];
        this.Iloc[k] = this.Iloc[s];
        this.born[k] = this.born[s];
        this.Vs[k] = this.Vs[s];
      } else if (this.parent[s] >= 0) this.parent[k] = this.remap[this.parent[s]];
      this.dead[k] = 0;
      this.slotOf[c] = k;
      k++;
    }
    this.n = k;
    this.f.touch();
  }

  /** Hold every channel and electrode cell at its electrode's potential. */
  private pin() {
    const phi = this.f.phi;
    for (let s = 0; s < this.n; s++) phi[this.cell[s]] = this.Vs[s];
    for (const el of this.electrodes) if (el.alive) for (const c of el.cells) phi[c] = el.V;
    for (let k = 0; k < this.ring.length; k++) phi[this.ring[k]] = this.glassBeta * phi[this.ringIn[k]] + this.ringV[k];
  }

  /**
   * One growth substep: every free neighbour of a growing tree breaks down with probability
   * 1 - exp(-rate dt), rate = nu (|E| / Eref)^eta once |E| clears the threshold Ec.
   */
  grow(dt: number, t: number) {
    const { p, f, W } = this;
    const phi = f.phi, kind = f.kind;
    const stamp = this.stamp;
    const sN = ++this.stampN;
    const eta = p.eta, inv = 1 / p.Eref, Ec = p.Ec;
    const cand = this.cand, from = this.from, cum = this.cum, field = this.field;
    let m = 0, tot = 0;
    for (let s = 0; s < this.n && m < MAXC; s++) {
      const el = this.electrodes[this.tree[s]];
      if (!el.grows) continue;
      const c = this.cell[s];
      const V = this.Vs[s];
      // Breakdown runs with the field: out of a high electrode's channels, into a low one's.
      const sg = el.V0 >= 0.5 ? 1 : -1;
      for (let d = 0; d < 8; d++) {
        const D = DIRS[d];
        const nb = c + D[0] + D[1] * W;
        if (kind[nb] !== FREE || stamp[nb] === sN) continue;
        const wd = this.wallDist;
        if (wd && wd[nb] < this.wallBand && wd[nb] > wd[c] - 0.5) continue;
        const E = ((sg * (V - phi[nb])) / D[2]) * p.volts;
        if (E < Ec) continue;
        stamp[nb] = sN;
        let w = Math.pow(E * inv, eta) * (1 + p.memory * this.ion[nb]);
        if (D[1] !== 0 && D[0] === 0) w *= p.grainY;
        tot += w;
        cand[m] = nb;
        from[m] = s;
        field[m] = E;
        cum[m++] = tot;
        if (m >= MAXC) break;
      }
    }
    if (!m) return;
    // DBM selection: the number of breakdowns this substep follows the total rate nu * sum(w)
    // (capped at sat cells/s, how fast the gas can break down), and each one picks its site with
    // probability w / sum(w), exactly Niemeyer et al.'s rule.
    const rate = p.nu * tot;
    const expect = (rate / (1 + rate / p.sat)) * dt;
    let k = Math.floor(expect) + (Math.random() < expect % 1 ? 1 : 0);
    k = Math.min(k, m);
    const sN2 = ++this.stampN;
    for (let e = 0; e < k * 3 && k > 0; e++) {
      const r = Math.random() * tot;
      let lo = 0, hi = m - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cum[mid] < r) lo = mid + 1;
        else hi = mid;
      }
      const nb = cand[lo];
      if (stamp[nb] === sN2 || kind[nb] !== FREE) continue;
      stamp[nb] = sN2;
      const s = from[lo];
      const ns = this.push(nb, s, this.tree[s], p.hBirth, t);
      if (ns < 0) return;
      f.set(nb, FIXED, this.Vs[s]);
      this.Iown[ns] += p.qGrow / dt;
      this.grown++;
      const x = nb % W, y = (nb / W) | 0;
      this.grownX += x;
      if (this.events.length < 600) this.events.push(x, y, field[lo]);
      k--;
    }
  }

  /**
   * Currents, heating, decay and the glass. Current into each channel cell is the field's flux
   * through its faces: large where it touches something at a different potential (a finger, charged
   * or uncharged glass, the other electrode's tree), tiny through the gas.
   */
  circuit(dt: number) {
    const { p, f, W } = this;
    const phi = f.phi, kind = f.kind;
    const sig0 = p.sigma, sigT = p.sigmaT, sigM = p.sigmaMed;
    for (const el of this.electrodes) {
      el.prevContacts = el.contacts;
      el.contacts = 0;
      el.I = 0;
    }
    this.ringI.fill(0);
    // Flux out of every channel cell.
    for (let s = 0; s < this.n; s++) {
      const c = this.cell[s];
      const tr = this.tree[s];
      const V = this.Vs[s];
      const sig = sig0 * (1 + sigT * this.T[s]);
      let I = this.Iown[s];
      this.Iown[s] = 0;
      // A cell touching a conductor on several faces still passes only its own conductance's worth.
      let best = 0, bestNb = -1;
      for (let d = 0; d < 4; d++) {
        const D = DIRS[d];
        const nb = c + D[0] + D[1] * W;
        const k = kind[nb];
        if (k === FREE) {
          I += sigM * Math.abs(V - phi[nb]);
          continue;
        }
        if (k !== FIXED) continue;
        const ns = this.slotOf[nb];
        if (ns >= 0 && this.tree[ns] === tr) continue;
        if (this.owner[nb] === tr) continue;
        const dV = Math.abs(V - phi[nb]);
        if (dV > best) (best = dV), (bestNb = nb);
      }
      if (bestNb >= 0) {
        // Touching another conductor: the channel's own conductance limits the current.
        const nb = bestNb, ns = this.slotOf[nb];
        const dI = sig * best;
        I += dI;
        const o = ns >= 0 ? this.tree[ns] : this.owner[nb];
        if (o >= 0 && o !== tr) {
          const el = this.electrodes[o];
          el.I += dI;
          el.contacts++;
        } else if (o < 0) {
          const r = this.ringIndex(nb);
          if (r >= 0) this.ringI[r] += sig * (V - phi[nb]);
        }
      }
      this.I[s] = I;
      this.Iloc[s] = I;
    }
    // Sum currents from the tips back to the roots.
    for (let s = this.n - 1; s >= 0; s--) {
      const pa = this.parent[s];
      if (pa >= 0) this.I[pa] += this.I[s];
    }
    for (let s = 0; s < this.n; s++) this.electrodes[this.tree[s]].I += this.parent[s] < 0 ? this.I[s] : 0;
    // Resistive drop from the roots out: a long detour ends at a lower potential than a direct path.
    for (let s = 0; s < this.n; s++) {
      const pa = this.parent[s];
      const el = this.electrodes[this.tree[s]];
      if (pa < 0 || p.rho <= 0) {
        this.Vs[s] = pa < 0 ? el.V : this.Vs[pa];
        continue;
      }
      const drop = (this.I[s] * p.rho) / (sig0 * (1 + sigT * this.T[s]));
      this.Vs[s] = el.V >= 0.5 ? Math.max(0, this.Vs[pa] - drop) : Math.min(1, this.Vs[pa] + drop);
    }
    // Heat: a fast glow that follows the current, and slow heat that builds while it keeps flowing.
    const eh = Math.exp(-dt / p.tauH), eT = Math.exp(-dt / p.tauT);
    for (let s = 0; s < this.n; s++) {
      const I = this.I[s];
      this.h[s] = this.h[s] * eh + p.kh * I * dt;
      this.T[s] = Math.min(1, this.T[s] * eT + p.kT * I * (1 - this.T[s]) * dt);
    }
    // Channels go out from the tips inward: a cold cell dies once nothing live hangs off it, so a
    // cold channel collapses in one go but a hot head still holds its channel open.
    // Any weak stretch can fail to re-strike, cutting off everything beyond it (rate per cell, so a
    // filament of flickLen cells fails at about flick per second when its current is small).
    if (p.flick > 0) {
      const k = (p.flick / p.flickLen) * dt;
      for (let s = 0; s < this.n; s++) {
        if (this.parent[s] < 0 || this.electrodes[this.tree[s]].permanent) continue;
        // A long resistive column needs more voltage to re-ignite: the drop along it adds to the risk.
        const drop = Math.max(0, Math.abs(this.electrodes[this.tree[s]].V - this.Vs[s]) - p.dropOk);
        if (Math.random() < k * (Math.exp(-this.I[s] / p.Iflick) + p.dropK * drop * drop)) this.dead[s] = 1;
      }
    }
    const kids = this.kids;
    kids.fill(0, 0, this.n);
    for (let s = this.n - 1; s >= 0; s--) {
      const pa = this.parent[s];
      if (pa < 0) continue;
      if (kids[s] === 0 && this.h[s] < p.hDie && !this.electrodes[this.tree[s]].permanent) this.dead[s] = 1;
      else kids[pa]++;
    }
    this.compact();
    // Ionisation memory: a channel that just went out leaves a path that breaks down again easily.
    const ion = this.ion;
    if (p.tauIon > 0) {
      const ei = Math.exp(-dt / p.tauIon);
      for (let i = 0; i < ion.length; i++) ion[i] *= ei;
    }
    if (p.rise > 0) {
      // Semi-Lagrangian shift upward (+y) by rise * dt cells.
      this.riseAcc += p.rise * dt;
      const a = Math.min(1, this.riseAcc);
      this.riseAcc -= a;
      const W = this.W;
      for (let i = ion.length - 1; i >= W; i--) ion[i] = ion[i] * (1 - a) + ion[i - W] * a;
    }
    for (let s = 0; s < this.n; s++) {
      const c = this.cell[s];
      ion[c] = Math.max(ion[c], Math.min(1, this.h[s]));
    }
    // Glass: current landing on it charges a spot the size of the filament's foot (at the drive's
    // frequency the charge spreads over the foot within a half-cycle), then leaks back.
    const R = this.ring.length;
    if (R) {
      const ec = Math.exp(-dt / this.glassLeak);
      const v = this.ringV, src = this.ringI, w = this.glassSpot;
      const add = this.ringAdd;
      add.fill(0);
      for (let k = 0; k < R; k++) {
        const q = src[k];
        if (q === 0) continue;
        for (let j = -w * 2; j <= w * 2; j++) add[(k + j + R) % R] += q * this.spotK[j + w * 2];
      }
      for (let k = 0; k < R; k++) v[k] = Math.max(-1, Math.min(1, v[k] * ec + (add[k] / this.glassC) * dt));
    }
    // Floating electrodes (a finger: the body is a big capacitor to ground).
    for (const el of this.electrodes) {
      if (el.alive && el.Rs > 0) el.V += (el.V0 / (1 + el.Rs * el.I) - el.V) * Math.min(1, dt * 20);
      if (!el.alive || el.C <= 0) continue;
      el.V = el.V0 + (el.V - el.V0) * Math.exp(-dt / el.leak) + (el.I / el.C) * dt;
    }
    for (let i = 0; i < this.electrodes.length; i++) {
      const el = this.electrodes[i];
      if (el.alive && el.contacts > 0 && el.prevContacts === 0) {
        let sx = 0, sy = 0;
        for (const c of el.cells) {
          sx += c % W;
          sy += (c / W) | 0;
        }
        const m = Math.max(1, el.cells.length);
        this.zaps.push(i, sx / m, sy / m, el.I);
      }
    }
    this.pin();
  }

  private ringLookup: Map<number, number> | null = null;
  private ringIndex(c: number) {
    if (!this.ringLookup) {
      this.ringLookup = new Map();
      this.ring.forEach((cell, k) => this.ringLookup!.set(cell, k));
    }
    return this.ringLookup.get(c) ?? -1;
  }

  beginFrame() {
    this.grown = 0;
    this.grownX = 0;
    this.died = 0;
    this.events.length = 0;
    this.zaps.length = 0;
    this.pin();
  }

  /** Clear all channels (keeps electrodes' root cells). */
  clear() {
    for (let s = 0; s < this.n; s++) if (this.parent[s] >= 0) this.dead[s] = 1;
    this.compact();
    this.ion.fill(0);
    this.ringV.fill(0);
  }
}
