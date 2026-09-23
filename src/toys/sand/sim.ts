// Falling-sand cellular automaton: one material byte per cell plus a little state.
// Cells are updated bottom-to-top with alternating horizontal sweeps, and a per-tick
// stamp stops anything that moved from being processed twice in the same step.

export const EMPTY = 0;
export const WALL = 1;
export const SAND = 2;
export const WATER = 3;
export const WOOD = 4;
export const FIRE = 5;
export const SMOKE = 6;
export const STEAM = 7;
export const OIL = 8;
export const LAVA = 9;
export const ACID = 10;
export const PLANT = 11;
export const ICE = 12;
export const POWDER = 13;
export const EMBER = 14;
export const ROCK = 15;
export const MATERIAL_COUNT = 16;

const STATIC = 0;
const GRAIN = 1;
const LIQUID = 2;
const GAS = 3;

const KIND = new Uint8Array(MATERIAL_COUNT);
const DENSITY = new Int8Array(MATERIAL_COUNT);
for (const [m, k, d] of [
  [EMPTY, GAS, 0],
  [WALL, STATIC, 127],
  [SAND, GRAIN, 30],
  [WATER, LIQUID, 10],
  [WOOD, STATIC, 127],
  [FIRE, GAS, -2],
  [SMOKE, GAS, -3],
  [STEAM, GAS, -4],
  [OIL, LIQUID, 6],
  [LAVA, LIQUID, 28],
  [ACID, LIQUID, 11],
  [PLANT, STATIC, 127],
  [ICE, STATIC, 127],
  [POWDER, GRAIN, 25],
  [EMBER, GRAIN, 8],
  [ROCK, STATIC, 127],
] as const) {
  KIND[m] = k;
  DENSITY[m] = d;
}

/** How far a liquid looks sideways per step; bigger = runnier. */
const DISPERSION = new Uint8Array(MATERIAL_COUNT);
DISPERSION[WATER] = 5;
DISPERSION[OIL] = 3;
DISPERSION[ACID] = 4;
DISPERSION[LAVA] = 1;

const FLAMMABLE = new Uint8Array(MATERIAL_COUNT);
FLAMMABLE[WOOD] = 1;
FLAMMABLE[PLANT] = 1;
FLAMMABLE[OIL] = 1;
FLAMMABLE[POWDER] = 1;

/** Offsets for the 8 neighbours, in (dx, dy) pairs. */
const NX = [-1, 0, 1, -1, 1, -1, 0, 1];
const NY = [-1, -1, -1, 0, 0, 1, 1, 1];

export class Sim {
  readonly w: number;
  readonly h: number;
  readonly mat: Uint8Array;
  /** Per-cell countdown: fire/smoke/steam lifetime, or burn time for wood and plants. */
  readonly life: Uint16Array;
  /** Fixed per-cell colour variation, assigned at spawn. */
  readonly vari: Uint8Array;
  private readonly stamp: Uint16Array;
  private tick = 1;
  private seed = 0x9e3779b9;
  wrap = false;
  /** Explosions this step, so the host can flash, shake and buzz. */
  booms = 0;
  /** Largest blast radius this step (cells), for scaling the flash. */
  boomSize = 0;
  /** Gunpowder cells lit by a blast, detonated next step: a crackling chain that also runs underwater. */
  private fuse: number[] = [];

  constructor(w: number, h: number) {
    this.w = w;
    this.h = h;
    const n = w * h;
    this.mat = new Uint8Array(n);
    this.life = new Uint16Array(n);
    this.vari = new Uint8Array(n);
    this.stamp = new Uint16Array(n);
  }

  /** xorshift32: much cheaper than Math.random in the hot loop. */
  rand() {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s >>> 0;
    return this.seed / 4294967296;
  }

  private chance(p: number) {
    return this.rand() < p;
  }

  private randInt(lo: number, hi: number) {
    return lo + Math.floor(this.rand() * (hi - lo + 1));
  }

  /** Cell index, or -1 outside the grid (x wraps when `wrap` is on; the floor is always solid). */
  at(x: number, y: number) {
    if (y < 0 || y >= this.h) return -1;
    if (x < 0 || x >= this.w) {
      if (!this.wrap) return -1;
      x = (x + this.w) % this.w;
    }
    return x + y * this.w;
  }

  set(i: number, m: number, life = -1) {
    this.mat[i] = m;
    this.vari[i] = (this.rand() * 256) | 0;
    this.life[i] = life >= 0 ? life : this.spawnLife(m);
  }

  private spawnLife(m: number) {
    switch (m) {
      case FIRE: return this.randInt(20, 50);
      case SMOKE: return this.randInt(60, 150);
      case STEAM: return this.randInt(120, 260);
      case EMBER: return this.randInt(40, 90);
      default: return 0;
    }
  }

  clear() {
    this.mat.fill(0);
    this.life.fill(0);
    this.fuse.length = 0;
  }

  count() {
    let n = 0;
    for (let i = 0; i < this.mat.length; i++) if (this.mat[i] !== EMPTY) n++;
    return n;
  }

  /** Copy another grid in, anchored bottom-left (used when the canvas is resized). */
  copyFrom(o: Sim) {
    const w = Math.min(this.w, o.w);
    const h = Math.min(this.h, o.h);
    for (let y = 0; y < h; y++) {
      const a = y * this.w;
      const b = y * o.w;
      this.mat.set(o.mat.subarray(b, b + w), a);
      this.life.set(o.life.subarray(b, b + w), a);
      this.vari.set(o.vari.subarray(b, b + w), a);
    }
  }

  // ------------------------------------------------------------------ stepping

  step() {
    this.tick = this.tick === 65535 ? 1 : this.tick + 1;
    this.booms = 0;
    this.boomSize = 0;
    if (this.fuse.length) {
      const lit = this.fuse.splice(0, Math.min(this.fuse.length, 48));
      for (const j of lit) if (this.mat[j] === POWDER) this.explode(j % this.w, (j / this.w) | 0);
    }
    const { w, h, mat, stamp, tick } = this;
    const ltr = (tick & 1) === 0;
    for (let y = 0; y < h; y++) {
      for (let k = 0; k < w; k++) {
        const x = ltr ? k : w - 1 - k;
        const i = x + y * w;
        const m = mat[i];
        if (m === EMPTY || m === WALL || m === ROCK || stamp[i] === tick) continue;
        switch (m) {
          case SAND:
            this.grain(i, x, y, 0.08);
            break;
          case POWDER:
            this.grain(i, x, y, 0.02);
            break;
          case WATER:
            this.liquid(i, x, y);
            break;
          case OIL:
            this.liquid(i, x, y);
            break;
          case ACID:
            this.acid(i, x, y);
            break;
          case LAVA:
            this.lava(i, x, y);
            break;
          case FIRE:
            this.fire(i, x, y);
            break;
          case SMOKE:
            this.smoke(i, x, y);
            break;
          case STEAM:
            this.steam(i, x, y);
            break;
          case EMBER:
            this.ember(i, x, y);
            break;
          case WOOD:
            if (this.life[i] > 0) this.burning(i, x, y, 0.35, 0.03);
            break;
          case PLANT:
            if (this.life[i] > 0) this.burning(i, x, y, 0.5, 0.12);
            else this.plant(i, x, y);
            break;
          case ICE:
            this.ice(i, x, y);
            break;
        }
      }
    }
  }

  private swap(i: number, j: number) {
    const { mat, life, vari, stamp } = this;
    const m = mat[i];
    mat[i] = mat[j];
    mat[j] = m;
    const l = life[i];
    life[i] = life[j];
    life[j] = l;
    const v = vari[i];
    vari[i] = vari[j];
    vari[j] = v;
    stamp[i] = this.tick;
    stamp[j] = this.tick;
  }

  /** Can material `m` sink into cell j? */
  private sinks(m: number, j: number) {
    if (j < 0) return false;
    const t = this.mat[j];
    return KIND[t] !== STATIC && DENSITY[t] < DENSITY[m];
  }

  /** Can gas `m` rise into cell j? Gases bubble up through liquids too. */
  private rises(m: number, j: number) {
    if (j < 0) return false;
    const t = this.mat[j];
    // Flames never travel through liquid; smoke and steam bubble up through it.
    if (m === FIRE && KIND[t] === LIQUID) return false;
    return KIND[t] !== STATIC && KIND[t] !== GRAIN && DENSITY[t] > DENSITY[m];
  }

  private grain(i: number, x: number, y: number, stickiness: number) {
    const m = this.mat[i];
    const below = this.at(x, y - 1);
    if (this.sinks(m, below)) {
      // Grains sink through liquid more slowly than they fall through air.
      if (this.mat[below] === EMPTY || this.chance(0.5)) this.swap(i, below);
      return;
    }
    if (this.chance(stickiness)) return;
    const d = this.chance(0.5) ? 1 : -1;
    const a = this.at(x + d, y - 1);
    if (this.sinks(m, a) && this.sinks(m, this.at(x + d, y))) return this.swap(i, a);
    const b = this.at(x - d, y - 1);
    if (this.sinks(m, b) && this.sinks(m, this.at(x - d, y))) this.swap(i, b);
  }

  /** Returns true if the liquid moved. */
  private liquid(i: number, x: number, y: number) {
    const m = this.mat[i];
    const below = this.at(x, y - 1);
    if (this.sinks(m, below)) {
      this.swap(i, below);
      return true;
    }
    const d = this.chance(0.5) ? 1 : -1;
    const a = this.at(x + d, y - 1);
    if (this.sinks(m, a)) {
      this.swap(i, a);
      return true;
    }
    const b = this.at(x - d, y - 1);
    if (this.sinks(m, b)) {
      this.swap(i, b);
      return true;
    }
    // Flow sideways into air/gas only, so layered liquids stay calm.
    const reach = DISPERSION[m];
    for (const dir of [d, -d]) {
      let target = -1;
      for (let s = 1; s <= reach; s++) {
        const j = this.at(x + dir * s, y);
        if (j < 0 || KIND[this.mat[j]] !== GAS || this.mat[j] === FIRE) break;
        target = j;
      }
      if (target >= 0) {
        this.swap(i, target);
        return true;
      }
    }
    return false;
  }

  private gas(i: number, x: number, y: number, rise: number) {
    const m = this.mat[i];
    if (this.chance(rise)) {
      const up = this.at(x, y + 1);
      if (this.rises(m, up)) return this.swap(i, up);
    }
    const d = this.chance(0.5) ? 1 : -1;
    const a = this.at(x + d, y + 1);
    if (this.rises(m, a)) return this.swap(i, a);
    const s = this.at(x + d, y);
    if (s >= 0 && this.mat[s] === EMPTY && this.chance(0.5)) this.swap(i, s);
  }

  private randomNeighbour(x: number, y: number) {
    const k = (this.rand() * 8) | 0;
    return this.at(x + NX[k], y + NY[k]);
  }

  /** Set fire to cell j if it can burn. Returns true if something caught. */
  ignite(j: number) {
    if (j < 0) return false;
    switch (this.mat[j]) {
      case WOOD:
        if (this.life[j] === 0) this.life[j] = this.randInt(90, 200);
        return true;
      case PLANT:
        if (this.life[j] === 0) this.life[j] = this.randInt(25, 55);
        return true;
      case OIL:
        this.set(j, FIRE, this.randInt(50, 100));
        return true;
      case POWDER:
        this.explode(j % this.w, (j / this.w) | 0);
        return true;
      case ICE:
        this.set(j, WATER);
        return true;
    }
    return false;
  }

  explode(cx: number, cy: number) {
    this.booms++;
    const r = this.randInt(6, 10);
    this.boomSize = Math.max(this.boomSize, r);
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        const j = this.at(cx + dx, cy + dy);
        if (j < 0) continue;
        const t = this.mat[j];
        if (t === WALL) continue;
        if (t === POWDER && d2 > 1) {
          // Neighbouring powder goes off next step: a crackling chain, not one giant pop.
          this.fuse.push(j);
          continue;
        }
        if (t === ROCK && this.chance(0.6)) continue;
        // Water in the blast flashes to steam instead of catching fire.
        if (t === WATER || t === ICE) {
          if (this.chance(0.6)) this.set(j, STEAM);
          this.stamp[j] = this.tick;
          continue;
        }
        if (d2 > (r - 1) * (r - 1) && this.chance(0.35)) this.set(j, EMBER);
        else if (d2 < r2 * 0.45 || this.chance(0.6)) this.set(j, FIRE, this.randInt(6, 22));
        else this.set(j, SMOKE);
        this.stamp[j] = this.tick;
      }
    }
    this.shockwave(cx, cy, r);
  }

  /** Throws loose powders and liquids outward from a blast, up to a few cells, into empty space. */
  private shockwave(cx: number, cy: number, r: number) {
    const R = r * 2;
    for (let dy = -R; dy <= R; dy++) {
      for (let dx = -R; dx <= R; dx++) {
        const d2 = dx * dx + dy * dy;
        if (d2 <= r * r || d2 > R * R) continue;
        const j = this.at(cx + dx, cy + dy);
        if (j < 0) continue;
        const k = KIND[this.mat[j]];
        if (k !== GRAIN && k !== LIQUID) continue;
        const d = Math.sqrt(d2);
        // Push hardest near the blast; bias upward so debris arcs rather than just sliding.
        const push = Math.round((1 - (d - r) / (R - r)) * 4) + 1;
        const ux = dx / d;
        const uy = dy / d + 0.35;
        let target = -1;
        for (let s = 1; s <= push; s++) {
          const t = this.at(cx + dx + Math.round(ux * s), cy + dy + Math.round(uy * s));
          if (t < 0 || this.mat[t] !== EMPTY) break;
          target = t;
        }
        if (target >= 0) this.swap(j, target);
      }
    }
  }

  private fire(i: number, x: number, y: number) {
    const life = --this.life[i];
    if (life <= 0) {
      if (this.chance(0.3)) this.set(i, SMOKE);
      else this.mat[i] = EMPTY;
      return;
    }
    for (let n = 0; n < 2; n++) {
      const j = this.randomNeighbour(x, y);
      if (j < 0) continue;
      const t = this.mat[j];
      if (t === WATER) {
        this.set(i, STEAM);
        if (this.chance(0.3)) this.set(j, STEAM);
        return;
      }
      if (FLAMMABLE[t] || t === ICE) {
        const p = t === WOOD ? 0.06 : t === PLANT ? 0.2 : 0.5;
        if (this.chance(p)) this.ignite(j);
      }
    }
    // Flames lick upward with a flicker.
    this.gas(i, x, y, 0.7);
  }

  private burning(i: number, x: number, y: number, flame: number, spread: number) {
    const life = --this.life[i];
    if (life <= 0) {
      if (this.chance(0.25)) this.set(i, EMBER);
      else if (this.chance(0.4)) this.set(i, SMOKE);
      else this.mat[i] = EMPTY;
      return;
    }
    const j = this.randomNeighbour(x, y);
    if (j < 0) return;
    const t = this.mat[j];
    if (t === WATER && this.chance(0.25)) {
      this.life[i] = 0;
      this.set(j, STEAM);
      return;
    }
    if (t === EMPTY && this.chance(flame)) {
      // Prefer spawning the flame above so burning wood looks like it is on fire, not melting.
      const up = this.at(x, y + 1);
      const k = up >= 0 && this.mat[up] === EMPTY ? up : j;
      this.set(k, FIRE, this.randInt(8, 24));
      this.stamp[k] = this.tick;
    } else if ((FLAMMABLE[t] || t === ICE) && this.chance(spread)) {
      this.ignite(j);
    }
  }

  private plant(i: number, x: number, y: number) {
    if (!this.chance(0.15)) return;
    const j = this.randomNeighbour(x, y);
    if (j >= 0 && this.mat[j] === WATER && this.chance(0.25)) {
      this.set(j, PLANT);
      this.stamp[j] = this.tick;
    }
  }

  private ice(i: number, x: number, y: number) {
    if (!this.chance(0.02)) return;
    const j = this.randomNeighbour(x, y);
    if (j >= 0 && this.mat[j] === WATER && this.chance(0.06)) this.set(j, ICE);
  }

  private lava(i: number, x: number, y: number) {
    // Molten rock sets off gunpowder it touches, even wet powder at the bottom of a pool.
    for (let k = 0; k < 8; k++) {
      const j = this.at(x + NX[k], y + NY[k]);
      if (j >= 0 && this.mat[j] === POWDER) {
        this.explode(j % this.w, (j / this.w) | 0);
        return;
      }
    }
    for (let n = 0; n < 2; n++) {
      const j = this.randomNeighbour(x, y);
      if (j < 0) continue;
      const t = this.mat[j];
      if (t === WATER) {
        // Hardens over a few steps rather than instantly, so lava can sink through a pool.
        if (this.chance(0.07)) {
          this.set(i, ROCK);
          this.set(j, STEAM);
          return;
        }
        if (this.chance(0.25)) this.set(j, STEAM);
        continue;
      }
      if (t === ICE) this.set(j, WATER);
      else if (FLAMMABLE[t] && this.chance(0.5)) this.ignite(j);
    }
    const up = this.at(x, y + 1);
    if (up >= 0 && this.mat[up] === EMPTY) {
      if (this.chance(0.003)) this.set(up, EMBER);
      else if (this.chance(0.004)) this.set(up, SMOKE);
    }
    // Lava is thick: it only flows some of the time, but it drops straight through water.
    const below = this.at(x, y - 1);
    if (below >= 0 && this.mat[below] === WATER) this.swap(i, below);
    else if (this.chance(0.35)) this.liquid(i, x, y);
  }

  private acid(i: number, x: number, y: number) {
    const j = this.randomNeighbour(x, y);
    if (j >= 0) {
      const t = this.mat[j];
      // Acid slowly spends itself: faster against stone it can't eat, so floor puddles fizzle away.
      if ((t === WALL && this.chance(0.006)) || this.chance(0.001)) {
        this.set(i, this.chance(0.5) ? SMOKE : STEAM);
        return;
      }
      const eats = t !== EMPTY && t !== WALL && t !== ACID && KIND[t] !== GAS && (t !== ROCK || this.chance(0.15));
      if (eats && this.chance(0.3)) {
        if (this.chance(0.3)) this.set(j, SMOKE);
        else this.mat[j] = EMPTY;
        if (this.chance(0.3)) {
          if (this.chance(0.5)) this.set(i, SMOKE);
          else this.mat[i] = EMPTY;
          return;
        }
      }
    }
    this.liquid(i, x, y);
  }

  private smoke(i: number, x: number, y: number) {
    // Smoke pooled against the top of the screen thins out quickly instead of forming a lid.
    if (y === this.h - 1) this.life[i] = Math.max(1, this.life[i] - 4);
    if (--this.life[i] <= 0) {
      this.mat[i] = EMPTY;
      return;
    }
    this.gas(i, x, y, 0.8);
  }

  private steam(i: number, x: number, y: number) {
    const up = this.at(x, y + 1);
    if (--this.life[i] <= 0) {
      // Some steam rains back down; steam that reached the top of the screen just dissipates.
      if (up >= 0 && this.chance(0.15)) this.set(i, WATER);
      else this.mat[i] = EMPTY;
      return;
    }
    if (up < 0) this.life[i] = Math.max(1, this.life[i] - 3);
    // Steam trapped under a ceiling condenses into drips.
    else if (KIND[this.mat[up]] === STATIC && this.chance(0.004)) return this.set(i, WATER);
    this.gas(i, x, y, 0.9);
  }

  private ember(i: number, x: number, y: number) {
    if (--this.life[i] <= 0) {
      this.mat[i] = this.chance(0.3) ? SMOKE : EMPTY;
      if (this.mat[i] === SMOKE) this.life[i] = this.randInt(30, 60);
      return;
    }
    const j = this.randomNeighbour(x, y);
    if (j >= 0) {
      const t = this.mat[j];
      if (t === WATER) {
        this.set(i, STEAM, this.randInt(40, 80));
        return;
      }
      if (FLAMMABLE[t] && this.chance(0.3)) this.ignite(j);
    }
    // Sparks drift as they fall.
    if (this.chance(0.3)) {
      const s = this.at(x + (this.chance(0.5) ? 1 : -1), y);
      if (s >= 0 && this.mat[s] === EMPTY) return this.swap(i, s);
    }
    this.grain(i, x, y, 0);
  }

  // ------------------------------------------------------------------ painting

  /** Paint material m in a disc. Flowing materials sprinkle; solids and the eraser fill. */
  paint(cx: number, cy: number, r: number, m: number) {
    const solid = m === EMPTY || KIND[m] === STATIC;
    const rate = solid ? 1 : m === FIRE ? 0.5 : KIND[m] === GAS ? 0.35 : 0.3;
    const r2 = r * r;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r2) continue;
        const j = this.at(Math.round(cx) + dx, Math.round(cy) + dy);
        if (j < 0) continue;
        const t = this.mat[j];
        if (m === EMPTY) {
          this.mat[j] = EMPTY;
          continue;
        }
        if (m === FIRE && FLAMMABLE[t]) {
          if (this.chance(0.3)) this.ignite(j);
          continue;
        }
        if (!this.chance(rate)) continue;
        // Solids draw over fluids; everything else only fills empty space.
        if (t === EMPTY || (solid && KIND[t] !== STATIC)) this.set(j, m);
      }
    }
  }

  /** Fill a rectangle in grid cells (used by scene building). */
  rect(x0: number, y0: number, x1: number, y1: number, m: number, p = 1) {
    for (let y = Math.max(0, y0); y <= Math.min(this.h - 1, y1); y++) {
      for (let x = Math.max(0, x0); x <= Math.min(this.w - 1, x1); x++) {
        if (p >= 1 || this.chance(p)) this.set(x + y * this.w, m);
      }
    }
  }
}
