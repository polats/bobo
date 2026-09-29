// Paper over a candle: a small CPU heat grid on the sheet, after Campfire's Burn (src/toys/fire/burn.ts)
// but tuned for paper. Heat from the flame develops the hidden inks (irreversibly), and anything hotter
// than the scorch point bakes a "dose" into the fibres: 0..1 browns the paper, 1..IGNITE chars it, and at
// IGNITE the cell catches. Burning cells heat their neighbours and pass the fire on with a little less
// strength each time, so a catch eats a ragged hole and then gutters out unless the flame keeps feeding it.

export const IGNITE = 1.6;

export interface PaperCfg {
  /** Heat gained per second at full flame (equilibrium temperature is heat / cool). */
  heat: number;
  cool: number;
  /** Conduction, cells² per second. */
  diffuse: number;
  /** Ink A (lemon juice) and ink B (cobalt) start to develop above these temperatures. */
  thA: number;
  thB: number;
  develop: number;
  developB: number;
  /** Fibres scorch above this temperature, at this rate per degree. */
  thScorch: number;
  scorch: number;
  /** Dose per second a burning neighbour adds, and how much strength each hop keeps. */
  spread: number;
  decay: number;
  burnTime: number;
}

export class Paper {
  readonly n: number;
  T: Float32Array;
  private Tn: Float32Array;
  readonly src: Float32Array;
  readonly devA: Float32Array;
  readonly devB: Float32Array;
  readonly dose: Float32Array;
  /** 0 = not burning, 0..1 = burn progress. */
  readonly fire: Float32Array;
  readonly str: Float32Array;
  readonly hole: Uint8Array;
  /** Hidden-ink coverage per cell (0..1), from the letter's mask. */
  readonly mA: Float32Array;
  readonly mB: Float32Array;
  private inkSum = 1;
  /** RGBA8 uploads: (T, dose, fire, hole) and (devA, devB, -, -). */
  readonly tex1: Uint8Array;
  readonly tex2: Uint8Array;

  // Stats, refreshed by step().
  revealed = 0;
  /** Share of the hidden ink made unreadable by char or holes. */
  lost = 0;
  /** Share of the sheet charred or burnt through. */
  damage = 0;
  /** Share of the sheet noticeably browned. */
  browned = 0;
  burning = 0;
  /** Cells the flame itself lit this step (a fresh catch, not spread). */
  caught = 0;
  /** How hard the paper is charring right now (sum of dose gained above brown), for the crackle. */
  charring = 0;
  /** Hottest unburnt cell, for the warm-paper hiss. */
  hottest = 0;

  cfg: PaperCfg = {
    heat: 2.6,
    cool: 2.2,
    diffuse: 5,
    thA: 0.16,
    thB: 0.5,
    develop: 5.5,
    developB: 8,
    thScorch: 0.45,
    scorch: 0.75,
    spread: 3.2,
    decay: 0.88,
    burnTime: 0.5,
  };

  constructor(readonly w: number, readonly h: number) {
    const n = (this.n = w * h);
    this.T = new Float32Array(n);
    this.Tn = new Float32Array(n);
    this.src = new Float32Array(n);
    this.devA = new Float32Array(n);
    this.devB = new Float32Array(n);
    this.dose = new Float32Array(n);
    this.fire = new Float32Array(n);
    this.str = new Float32Array(n);
    this.hole = new Uint8Array(n);
    this.mA = new Float32Array(n);
    this.mB = new Float32Array(n);
    this.tex1 = new Uint8Array(n * 4);
    this.tex2 = new Uint8Array(n * 4);
  }

  inkReady() {
    let s = 0;
    for (let i = 0; i < this.n; i++) s += this.mA[i] + this.mB[i];
    this.inkSum = Math.max(1e-3, s);
  }

  /**
   * The flame's heat, in cell coordinates: a Gaussian around (cx, cy) that reaches further upward
   * (the hot plume rises) than down, leaning with the flame by `lean` cells per cell of height.
   */
  addHeat(cx: number, cy: number, sx: number, up: number, down: number, power: number, lean: number) {
    const { w, h, src } = this;
    const y0 = Math.max(0, Math.floor(cy - down * 3)), y1 = Math.min(h - 1, Math.ceil(cy + up * 3));
    for (let y = y0; y <= y1; y++) {
      const dy = y - cy;
      const sy = dy > 0 ? up : down;
      const fy = Math.exp((-dy * dy) / (2 * sy * sy)) * power;
      if (fy < 0.01) continue;
      const mx = cx + Math.max(0, dy) * lean;
      const x0 = Math.max(0, Math.floor(mx - sx * 3)), x1 = Math.min(w - 1, Math.ceil(mx + sx * 3));
      const inv = 1 / (2 * sx * sx);
      for (let x = x0; x <= x1; x++) {
        const dx = x - mx;
        src[y * w + x] += fy * Math.exp(-dx * dx * inv);
      }
    }
  }

  step(dt: number) {
    const { w, h, T, Tn, src, devA, devB, dose, fire, str, hole, mA, mB, cfg } = this;
    let rev = 0, lost = 0, dmg = 0, brown = 0, burning = 0, caught = 0, charring = 0, hottest = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (hole[i]) {
          Tn[i] = 0;
          lost += mA[i] + mB[i];
          dmg++;
          continue;
        }
        const t = T[i];
        // Open edges and holes read as cold neighbours: paper loses heat there.
        const l = x > 0 ? T[i - 1] : 0, r = x < w - 1 ? T[i + 1] : 0;
        const d = y > 0 ? T[i - w] : 0, u = y < h - 1 ? T[i + w] : 0;
        let v = t + (src[i] * cfg.heat - cfg.cool * t + cfg.diffuse * (l + r + u + d - 4 * t)) * dt;
        let nb = 0;
        if (x > 0 && fire[i - 1] > 0) nb = str[i - 1];
        if (x < w - 1 && fire[i + 1] > 0 && str[i + 1] > nb) nb = str[i + 1];
        if (y > 0 && fire[i - w] > 0 && str[i - w] > nb) nb = str[i - w];
        // Fire climbs: a flame below passes on at full strength, one above creeps down weaker.
        if (y < h - 1 && fire[i + w] > 0 && str[i + w] * 0.7 > nb) nb = str[i + w] * 0.7;
        if (fire[i] > 0) {
          if (v < 1.35) v = 1.35;
          fire[i] += dt / cfg.burnTime;
          burning++;
          if (fire[i] >= 1) {
            fire[i] = 0;
            hole[i] = 1;
            v = 0;
          }
        } else {
          let dd = 0;
          if (v > cfg.thScorch) dd += (v - cfg.thScorch) * cfg.scorch * dt;
          if (nb > 0) dd += cfg.spread * nb * dt;
          if (dd > 0) {
            const before = dose[i];
            let after = before + dd;
            if (after >= IGNITE) {
              const s = src[i] > 0.3 ? 1 : nb * cfg.decay;
              if (s >= 0.28) {
                fire[i] = 1e-3;
                str[i] = s;
                if (s === 1) caught++;
              } else after = IGNITE - 0.01; // charred black, but too weak to catch
            }
            dose[i] = after;
            if (after > 0.9) charring += after - Math.max(before, 0.9);
          }
        }
        if (v > cfg.thA && devA[i] < 1) devA[i] = Math.min(1, devA[i] + (v - cfg.thA) * cfg.develop * dt);
        if (v > cfg.thB && devB[i] < 1) devB[i] = Math.min(1, devB[i] + (v - cfg.thB) * cfg.developB * dt);
        Tn[i] = v;
        if (v > hottest) hottest = v;
        const ds = dose[i];
        // Legible while brown; char and fire take the words with them.
        const leg = ds < 1 ? 1 : ds > 1.45 ? 0 : 1 - (ds - 1) / 0.45;
        const ink = mA[i] + mB[i];
        if (ink > 0) {
          rev += (mA[i] * devA[i] + mB[i] * devB[i]) * leg;
          lost += ink * (1 - leg);
        }
        if (ds > 1.15 || fire[i] > 0) dmg++;
        else if (ds > 0.35) brown++;
      }
    }
    this.T = Tn;
    this.Tn = T;
    src.fill(0);
    this.revealed = rev / this.inkSum;
    this.lost = lost / this.inkSum;
    this.damage = dmg / this.n;
    this.browned = brown / this.n;
    this.burning = burning;
    this.caught = caught;
    this.charring = charring;
    this.hottest = hottest;
  }

  /** One word's ink over a cell rectangle: sets wordShown (share that reads) and wordLost (share burnt). */
  wordShown = 0;
  wordLost = 0;
  word(x0: number, y0: number, x1: number, y1: number, inkB: boolean) {
    const { w, mA, mB, devA, devB, dose, hole } = this;
    const m = inkB ? mB : mA, dv = inkB ? devB : devA;
    let s = 0, lost = 0, tot = 0;
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const i = y * w + x;
        const k = m[i];
        if (!k) continue;
        tot += k;
        if (hole[i] || dose[i] > 1.2) lost += k;
        else s += k * dv[i];
      }
    this.wordShown = tot > 0 ? s / tot : 1;
    this.wordLost = tot > 0 ? lost / tot : 0;
  }

  pack() {
    const { n, T, dose, fire, hole, devA, devB, tex1, tex2 } = this;
    for (let i = 0, o = 0; i < n; i++, o += 4) {
      tex1[o] = Math.min(255, T[i] * 170);
      tex1[o + 1] = Math.min(255, dose[i] * 127.5);
      tex1[o + 2] = fire[i] > 0 ? 40 + fire[i] * 215 : 0;
      tex1[o + 3] = hole[i] * 255;
      tex2[o] = devA[i] * 255;
      tex2[o + 1] = devB[i] * 255;
    }
  }
}
