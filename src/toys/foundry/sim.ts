// Foundry cells: a falling-sand grid (packed cells, a LOOSE flag for grains, bottom-up scan with
// alternating direction) where every sand and metal cell carries a temperature.
//
// Heat is exchanged pairwise between touching cells with symmetric fluxes, so what the metal loses
// the sand gains: the mould warms up around the metal and saturates, and only the open surfaces
// lose heat for good. Hot metal is a liquid that falls, slides and levels out; as it cools it gets
// sluggish and below FREEZE it is solid.
//
// Metal rises by hydrostatic pressure: every few steps the connected liquid regions are labelled,
// and where a region's free surface sits two or more rows below its highest surface (the head),
// metal is taken off the top and pushed in under the low surface, faster the bigger the head
// difference. That's a U-tube, so a mould can be bottom-gated: down the sprue, along a runner and
// up into the cavity. A surface that cools below FUSE_T grows an oxide skin; where a front arrives
// against a skinned front and their interface is below FUSE_T they don't fuse: a cold shut.

export const EMPTY = 0;
export const SAND = 1;
export const METAL = 2;
/** The flask's iron frame: static, keeps overflow puddled on top of the mould. */
export const FRAME = 3;
/** The foundry floor, a grate that loose sand drains through. */
export const FLOOR = 4;
export const LOOSE = 0x80;

/** Temperature (0..1, 1 = fresh from the crucible) below which metal stops flowing. */
export const FREEZE = 0.42;
/** Two fronts whose interface is colder than this don't fuse. */
export const FUSE_T = 0.56;
/** Above this, metal runs like water; it thickens between here and FREEZE. */
const FLUID_T = 0.8;

/** Heat capacity per cell. */
const CAP_METAL = 1;
const CAP_SAND = 0.5;
/** Conductance per second between touching cells. */
const G_METAL = 10;
const G_SAND = 0.06;
/** Pressure pass every this many steps; rise rate per cell per second per sqrt(row of head). */
const PRESS_EVERY = 3;
const RISE = 7;

export interface Assessment {
  fill: number;
  voids: number;
  /** Fraction of the cavity lying on cold-shut seams. */
  seams: number;
  maxT: number;
}

/** flag bits */
const SHUT = 1;
const RIGHT = 2;
const MOVED = 4;
/** An exposed surface that cooled below FUSE_T: an oxide skin. */
const SKIN = 8;
/** Fell this step: part of a stream, not of a pool under pressure. */
const FALL = 16;

export class FoundrySim {
  readonly cells: Uint8Array;
  readonly temp: Float32Array;
  readonly shade: Uint8Array;
  readonly flag: Uint8Array;
  /** 1 = mould cavity, 2 = gating (basin, sprue, runner, ingates, riser). */
  readonly mask: Uint8Array;
  /** Sand scorched black by getting hot. */
  readonly scorch: Uint8Array;
  private tick: Uint8Array;
  private region: Int32Array;
  private queue: Int32Array;
  private surf: Int32Array;
  private stamp = 0;
  private flip = 0;
  private steps = 0;
  /** Metal-sand conductance per second. */
  gSand = 0.55;
  /** Heat lost per second (fraction of T) from an open metal surface. */
  kAir = 0.8;
  /** Multiplies sand and air cooling; raised once the pour is over so it sets in seconds. */
  quench = 1;
  /**
   * 0..1: how hard the incoming stream is stirring the basin. A fed basin keeps its surface broken
   * and hot; once the stream stops, a skin forms.
   */
  stir = 0;
  /** Extra uniform cooling per second: the time-lapse once the pour is over. */
  bulk = 0;
  /** Whether arriving fronts can leave cold shuts (only while the pour is on). */
  shutOn = true;
  /** Packed sand crumbles loose (break-out). */
  collapse = false;
  /** Per-step counters for sound and visuals. */
  flowed = 0;
  rose = 0;
  crumbled = 0;
  drained = 0;
  /** Rows [lo, hi) that can hold moving cells; the rest is skipped. */
  lo = 0;
  hi = 0;
  /** Box that exchanges heat: [hx0, hx1) x [hy0, hy1). */
  hx0 = 0;
  hx1 = 0;
  hy0 = 0;
  hy1 = 0;

  constructor(
    readonly W: number,
    readonly H: number,
  ) {
    const n = W * H;
    this.cells = new Uint8Array(n);
    this.temp = new Float32Array(n);
    this.shade = new Uint8Array(n);
    this.flag = new Uint8Array(n);
    this.mask = new Uint8Array(n);
    this.scorch = new Uint8Array(n);
    this.tick = new Uint8Array(n);
    this.region = new Int32Array(n);
    this.queue = new Int32Array(n);
    this.surf = new Int32Array(n);
    for (let i = 0; i < n; i++) this.shade[i] = (Math.random() * 256) | 0;
    this.hi = H;
    this.hx1 = W;
    this.hy1 = H;
  }

  clear() {
    this.cells.fill(0);
    this.temp.fill(0);
    this.flag.fill(0);
    this.mask.fill(0);
    this.scorch.fill(0);
    this.collapse = false;
    this.shutOn = true;
    this.quench = 1;
    this.bulk = 0;
    this.stir = 0;
  }

  /** Drop fresh metal into empty cells of row y across [x0, x0 + w). */
  pour(x0: number, y: number, w: number, n: number) {
    const { W, cells } = this;
    let placed = 0;
    for (let i = 0; i < n * 2 && placed < n; i++) {
      const x = x0 + ((Math.random() * w) | 0);
      if (x < 0 || x >= W) continue;
      const k = y * W + x;
      if (cells[k]) continue;
      cells[k] = METAL;
      this.temp[k] = 1;
      this.flag[k] = MOVED | FALL | (Math.random() < 0.5 ? RIGHT : 0);
      placed++;
    }
    return placed;
  }

  /** Knock packed sand in a disc loose (a hammer blow on the mould). */
  loosen(cx: number, cy: number, r: number) {
    const { W, H, cells } = this;
    let n = 0;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
        const d = (x - cx) ** 2 + (y - cy) ** 2;
        const k = y * W + x;
        // Ragged edge: the outer ring of the blow only partly breaks.
        if (cells[k] !== SAND || d > r * r || (d > r * r * 0.55 && Math.random() < 0.5)) continue;
        cells[k] = SAND | LOOSE;
        n++;
      }
    return n;
  }

  step(dt: number) {
    const { W, cells } = this;
    this.flowed = 0;
    this.rose = 0;
    this.crumbled = 0;
    this.drained = 0;
    this.flip ^= 1;
    this.stamp = this.stamp === 255 ? 1 : this.stamp + 1;
    this.conduct(dt);
    const lo = Math.max(0, this.lo), hi = Math.min(this.H - 1, this.hi);
    for (let y = hi - 1; y >= lo; y--) {
      const ltr = (y + this.flip) & 1;
      for (let xi = 0; xi < W; xi++) {
        const x = ltr ? xi : W - 1 - xi;
        const k = y * W + x;
        const c = cells[k];
        if (c === EMPTY || c === FRAME || c === FLOOR) continue;
        if (c === SAND) {
          if (this.collapse) this.crumble(k);
          continue;
        }
        if (this.tick[k] === this.stamp) continue;
        if (c === METAL) this.metal(x, y, k, dt);
        else this.grain(x, k, c);
      }
    }
    if (++this.steps % PRESS_EVERY === 0) this.pressure(dt * PRESS_EVERY);
  }

  /**
   * Pairwise conduction (right and down neighbour of every cell), symmetric so heat is conserved:
   * metal-metal fast, metal-sand at gSand, sand-sand slowly, so the mould saturates near the metal.
   */
  private conduct(dt: number) {
    const { W, cells, temp, scorch } = this;
    const gMS = this.gSand * this.quench * dt, gMM = G_METAL * dt, gSS = G_SAND * dt;
    const y1 = Math.min(this.hy1, this.H - 1), x1 = Math.min(this.hx1, W - 1);
    for (let y = Math.max(0, this.hy0); y < y1; y++) {
      for (let x = Math.max(0, this.hx0); x < x1; x++) {
        const k = y * W + x;
        const a = cells[k] & 0x7f;
        if (a !== METAL && a !== SAND) continue;
        const ca = a === METAL ? CAP_METAL : CAP_SAND;
        for (let d = 0; d < 2; d++) {
          const n = d ? k + W : k + 1;
          const b = cells[n] & 0x7f;
          if (b !== METAL && b !== SAND) continue;
          const g = a === METAL && b === METAL ? gMM : a === SAND && b === SAND ? gSS : gMS;
          const cb = b === METAL ? CAP_METAL : CAP_SAND;
          const f = g * (temp[k] - temp[n]);
          temp[k] -= f / ca;
          temp[n] += f / cb;
        }
        if (a === SAND && temp[k] > 0.3) {
          const s = Math.min(255, (temp[k] - 0.3) * 700);
          if (s > scorch[k]) scorch[k] = s;
        }
      }
    }
  }

  private crumble(k: number) {
    const b = this.cells[k + this.W];
    // Undercut sand goes fast; the rest flakes off at random so the mould falls apart in chunks.
    const p = b === EMPTY || b & LOOSE ? 0.35 : 0.02;
    if (Math.random() < p) {
      this.cells[k] = SAND | LOOSE;
      this.crumbled++;
    }
  }

  private move(a: number, b: number) {
    const { cells, temp, flag, shade } = this;
    cells[b] = cells[a];
    cells[a] = EMPTY;
    temp[b] = temp[a];
    temp[a] = 0;
    flag[b] = flag[a] | MOVED;
    flag[a] = 0;
    const s = shade[a];
    shade[a] = shade[b];
    shade[b] = s;
    this.tick[b] = this.stamp;
  }

  private metal(x: number, y: number, k: number, dt: number) {
    const { W, cells, temp, flag } = this;
    flag[k] &= ~FALL;
    let T = temp[k];
    const up = k - W >= 0 ? cells[k - W] : EMPTY;
    // Open surfaces lose heat to the air; a stirred basin barely skins, a closed cavity keeps warm.
    if (up === EMPTY) {
      const m = this.mask[k];
      const open = m === 1 ? 0.35 : m === 2 ? 1 - 0.85 * this.stir : 1;
      T -= this.kAir * T * open * this.quench * dt;
      if (T < FUSE_T) flag[k] |= SKIN;
    }
    if (T > FUSE_T + 0.1) flag[k] &= ~SKIN;
    T -= this.bulk * dt;
    if (T < 0) T = 0;
    temp[k] = T;
    const n3 = k + W;
    const below = n3 < cells.length ? cells[n3] : FLOOR;
    if (T < FREEZE) {
      flag[k] &= ~MOVED;
      // A lone frozen drop still falls; frozen metal touching other metal stays put.
      if (below === EMPTY && !this.touchesMetal(x, k)) this.fall(k, n3);
      return;
    }
    const fl = T >= FLUID_T ? 1 : (T - FREEZE) / (FLUID_T - FREEZE);
    if (below === EMPTY) {
      this.fall(k, n3);
      this.flowed++;
      return;
    }
    // Thick metal hesitates: the colder it is, the fewer steps it gets to move.
    if (Math.random() < 0.25 + 0.75 * fl) {
      let d = flag[k] & RIGHT ? 1 : -1;
      for (let pass = 0; pass < 2; pass++, d = -d) {
        const nx = x + d;
        if (nx < 0 || nx >= W || cells[k + d] !== EMPTY) continue;
        if (n3 + d < cells.length && cells[n3 + d] === EMPTY) {
          this.fall(k, n3 + d);
          this.setDir(n3 + d, d);
          this.flowed++;
          return;
        }
      }
      // Level out: run sideways, further when hot, keeping direction until blocked.
      const reach = 1 + ((fl * 3.99) | 0);
      d = flag[k] & RIGHT ? 1 : -1;
      for (let pass = 0; pass < 2; pass++, d = -d) {
        let s = 0;
        for (let j = 1; j <= reach; j++) {
          const nx = x + d * j;
          if (nx < 0 || nx >= W || cells[k + d * j] !== EMPTY) break;
          s = j;
          if (n3 + d * j < cells.length && cells[n3 + d * j] === EMPTY) break;
        }
        if (s) {
          this.move(k, k + d * s);
          this.setDir(k + d * s, d);
          this.flowed++;
          return;
        }
        flag[k] ^= RIGHT;
      }
    }
    // Came to rest this step: check whether it fused with the metal it arrived against.
    if (flag[k] & MOVED) {
      flag[k] &= ~MOVED;
      this.arrive(k);
    }
  }

  private fall(a: number, b: number) {
    this.move(a, b);
    this.flag[b] |= FALL;
  }

  private touchesMetal(x: number, k: number) {
    const { cells, W } = this;
    return (x > 0 && cells[k - 1] === METAL) || (x < W - 1 && cells[k + 1] === METAL) || cells[k - W] === METAL || cells[k + W] === METAL;
  }

  /**
   * A front has just arrived at k. If it lies against a skinned front and the interface between
   * them is below the fusion temperature, the two never weld: a cold shut.
   */
  private arrive(k: number) {
    if (!this.shutOn) return;
    const { W, cells, temp, flag } = this;
    const x = k % W;
    for (let i = 0; i < 4; i++) {
      const n = i === 0 ? (x > 0 ? k - 1 : -1) : i === 1 ? (x < W - 1 ? k + 1 : -1) : i === 2 ? k - W : k + W;
      if (n < 0 || n >= cells.length || cells[n] !== METAL || !(flag[n] & SKIN)) continue;
      if ((temp[k] + temp[n]) * 0.5 < FUSE_T) {
        flag[k] |= SHUT;
        return;
      }
    }
  }

  /**
   * Hydrostatic head: label connected liquid (resting, above FREEZE) metal, and in each region move
   * metal from its highest surface to under its low surfaces. The low surface cell is lifted one
   * row (its skin rides on top, as it does on a rising front) and the metal slides in beneath it.
   */
  private pressure(dt: number) {
    const { W, cells, temp, flag, region, queue, surf } = this;
    const lo = Math.max(1, this.lo), hi = Math.min(this.H - 1, this.hi);
    region.fill(-1, lo * W, hi * W);
    const liquid = (k: number) => cells[k] === METAL && temp[k] >= FREEZE && !(flag[k] & FALL);
    let id = 0;
    for (let s = lo * W; s < hi * W; s++) {
      if (region[s] >= 0 || !liquid(s)) continue;
      let qh = 0, qt = 0, ns = 0;
      queue[qt++] = s;
      region[s] = id;
      while (qh < qt) {
        const k = queue[qh++], x = k % W;
        const up = k - W;
        // Free surface: open above, or under a falling stream (which can only feed it).
        if (cells[up] === EMPTY || (cells[up] === METAL && flag[up] & FALL)) surf[ns++] = k;
        for (let i = 0; i < 4; i++) {
          const n = i === 0 ? (x > 0 ? k - 1 : -1) : i === 1 ? (x < W - 1 ? k + 1 : -1) : i === 2 ? up : k + W;
          if (n < lo * W || n >= hi * W || region[n] >= 0 || !liquid(n)) continue;
          region[n] = id;
          queue[qt++] = n;
        }
      }
      id++;
      if (ns < 2) continue;
      // Sorting by index sorts by row: sources (highest) first, targets (lowest) last.
      const list = surf.subarray(0, ns).sort();
      let i = 0;
      for (let j = ns - 1; j > i; j--) {
        const t = list[j], src = list[i];
        const dh = ((t / W) | 0) - ((src / W) | 0);
        if (dh < 2) break;
        if (cells[t - W] !== EMPTY || cells[t] !== METAL || cells[src] !== METAL) continue;
        if (Math.random() > Math.min(1, RISE * Math.sqrt(dh) * dt)) continue;
        this.move(t, t - W);
        this.move(src, t);
        flag[t] &= ~(SKIN | SHUT | FALL);
        flag[t - W] &= ~MOVED;
        this.arrive(t - W);
        this.rose++;
        i++;
      }
    }
  }

  private setDir(k: number, d: number) {
    if (d > 0) this.flag[k] |= RIGHT;
    else this.flag[k] &= ~RIGHT;
  }

  private grain(x: number, k: number, c: number) {
    const { W, cells } = this;
    const below = k + W;
    const b = below < cells.length ? cells[below] : FLOOR;
    if (b === FLOOR) {
      // Through the grate.
      if (Math.random() < 0.7) {
        cells[k] = EMPTY;
        this.flag[k] = 0;
        this.temp[k] = 0;
        this.drained++;
      }
      return;
    }
    // Grains hesitate a little so a falling slab breaks up into streaks and clods.
    if (b === EMPTY) {
      if (Math.random() < 0.85) this.move(k, below);
      return;
    }
    const d = Math.random() < 0.5 ? -1 : 1;
    for (let pass = 0; pass < 2; pass++) {
      const e = pass ? -d : d;
      const nx = x + e;
      if (nx < 0 || nx >= W) continue;
      if (cells[below + e] === EMPTY && cells[k + e] === EMPTY) {
        this.move(k, below + e);
        return;
      }
    }
    void c;
  }

  isShut(k: number) {
    return this.cells[k] === METAL && (this.flag[k] & SHUT) !== 0;
  }

  /** Total heat in metal and sand (for tests: conduction alone must conserve it). */
  heat() {
    const { cells, temp } = this;
    let q = 0;
    for (let k = 0; k < cells.length; k++) {
      const m = cells[k] & 0x7f;
      if (m === METAL) q += temp[k] * CAP_METAL;
      else if (m === SAND) q += temp[k] * CAP_SAND;
    }
    return q;
  }

  /**
   * How the cavity came out: the fraction filled with metal and the fraction on cold-shut seams (a
   * lone shut cell is noise; one touching another is part of a lap line).
   */
  assess(cav: Int32Array, out: Assessment) {
    const { W, cells } = this;
    let filled = 0, seam = 0, maxT = 0;
    for (let i = 0; i < cav.length; i++) {
      const k = cav[i];
      if (cells[k] !== METAL) continue;
      filled++;
      if (this.temp[k] > maxT) maxT = this.temp[k];
      if (!this.isShut(k)) continue;
      if (this.isShut(k - 1) || this.isShut(k + 1) || this.isShut(k - W) || this.isShut(k + W) || this.isShut(k - W - 1) || this.isShut(k - W + 1) || this.isShut(k + W - 1) || this.isShut(k + W + 1)) seam++;
    }
    const n = Math.max(1, cav.length);
    out.fill = filled / n;
    out.voids = 1 - filled / n;
    out.seams = seam / n;
    out.maxT = maxT;
    return out;
  }
}
