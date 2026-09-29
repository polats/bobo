// Foundry cells: Dig Down's falling-sand grid (packed cells, a LOOSE flag for grains) plus a METAL
// cell that carries a temperature. Hot metal is a liquid that falls, slides and levels out; as it
// cools it gets sluggish (moves less often, spreads less far) and below FREEZE it is solid. Heat
// leaks into the sand and the air and diffuses between touching metal, so a steady pour stays hot
// while a paused one grows a cold skin. Hot metal that settles against cold metal leaves a cold
// shut: the two fronts never fused, and the casting rings dull there.

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
/** Metal colder than this where hot metal meets it doesn't fuse: a cold shut. */
export const SHUT_T = 0.5;
/** Above this, metal runs like water; it thickens between here and FREEZE. */
const FLUID_T = 0.8;

/** Each cell of cold-shut seam costs this many cells of quality. */
const SEAM_WEIGHT = 8;

export interface Assessment {
  fill: number;
  voids: number;
  /** Fraction of the cavity lying on cold-shut seams. */
  seams: number;
  quality: number;
  maxT: number;
}

/** flag bits */
const SHUT = 1;
const RIGHT = 2;
const MOVED = 4;
/** Cooled below SHUT_T while it was the open top of the pool: an oxide skin. */
const SKIN = 8;

export class FoundrySim {
  readonly cells: Uint8Array;
  readonly temp: Float32Array;
  readonly shade: Uint8Array;
  readonly flag: Uint8Array;
  /** 1 = mould cavity, 2 = pouring basin and sprue. */
  readonly mask: Uint8Array;
  /** Sand scorched black by hot metal next to it. */
  readonly scorch: Uint8Array;
  private tick: Uint8Array;
  private stamp = 0;
  private flip = 0;
  /** Heat lost per second per touching sand cell, and from an open top surface. */
  kSand = 0.04;
  kAir = 0.8;
  /** Multiplies all cooling; raised once the pour is over so it sets in seconds. */
  quench = 1;
  /**
   * 0..1: how hard the incoming stream is stirring the pool. A fed pool keeps its surface broken
   * and hot; once the stream stops, a skin forms within a second.
   */
  stir = 0;
  /** Extra uniform cooling per second (the casting setting once the pour is over). */
  bulk = 0;
  /** Fraction of the temperature gap to touching metal closed per step. */
  diffuse = 0.02;
  /** Whether settling metal can leave cold shuts (only while the pour is on). */
  shutOn = true;
  /** Packed sand crumbles loose (break-out). */
  collapse = false;
  /** Per-step counters for sound and visuals. */
  flowed = 0;
  crumbled = 0;
  drained = 0;
  /** Rows [lo, hi) that can hold moving cells; the rest is skipped. */
  lo = 0;
  hi = 0;

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
    for (let i = 0; i < n; i++) this.shade[i] = (Math.random() * 256) | 0;
    this.hi = H;
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
      this.flag[k] = MOVED | (Math.random() < 0.5 ? RIGHT : 0);
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
    this.crumbled = 0;
    this.drained = 0;
    this.flip ^= 1;
    this.stamp = this.stamp === 255 ? 1 : this.stamp + 1;
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
    let T = temp[k];
    // Heat exchange with the four neighbours.
    let sand = 0, air = 0, mn = 0, mt = 0;
    const n0 = x > 0 ? k - 1 : -1, n1 = x < W - 1 ? k + 1 : -1, n2 = k - W, n3 = k + W;
    for (let i = 0; i < 4; i++) {
      const n = i === 0 ? n0 : i === 1 ? n1 : i === 2 ? n2 : n3;
      if (n < 0 || n >= cells.length) continue;
      const c = cells[n];
      if (c === METAL) {
        mn++;
        mt += temp[n];
      } else if (c === EMPTY) {
        // Only an open top loses real heat (the skin on a pool); a falling stream barely cools.
        if (i === 2) air++;
      }
      else if ((c & 0x7f) === SAND) {
        sand++;
        if (T > 0.55 && this.scorch[n] < 200) this.scorch[n] += 2;
      }
    }
    if (mn) T += (mt / mn - T) * this.diffuse;
    T -= (this.kSand * sand * this.quench + this.bulk) * dt;
    // An open top skins over but, while the pour is on, stays just runny enough for new metal
    // to run over it: a pause leaves a cold lap rather than plugging the sprue.
    if (air) {
      const floor = this.shutOn ? FREEZE + 0.05 : 0;
      if (T > floor) T = Math.max(floor, T - this.kAir * air * (1 - 0.85 * this.stir) * this.quench * dt);
    }
    if (T < 0) T = 0;
    temp[k] = T;
    if (air && T < SHUT_T) flag[k] |= SKIN;
    if (T < FREEZE) {
      flag[k] &= ~MOVED;
      // A lone frozen drop still falls; frozen metal holding onto more metal stays put.
      if (n3 < cells.length && cells[n3] === EMPTY && !mn) this.move(k, n3);
      return;
    }
    const fl = T >= FLUID_T ? 1 : (T - FREEZE) / (FLUID_T - FREEZE);
    const below = n3 < cells.length ? cells[n3] : FLOOR;
    if (below === EMPTY) {
      this.move(k, n3);
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
          this.move(k, n3 + d);
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
    // Came to rest this step: hot metal settling against metal that has already skinned over
    // doesn't fuse with it, leaving a cold shut.
    if (flag[k] & MOVED) {
      flag[k] &= ~MOVED;
      if (!this.shutOn) return;
      for (let i = 0; i < 4; i++) {
        const n = i === 0 ? n0 : i === 1 ? n1 : i === 2 ? n2 : n3;
        if (n < 0 || n >= cells.length || cells[n] !== METAL) continue;
        if (flag[n] & SKIN && T - temp[n] > 0.1) {
          flag[k] |= SHUT;
          break;
        }
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

  /**
   * Grade the cavity: the fraction filled with metal, less a penalty for cold-shut seams. A lone
   * shut cell is noise; one touching another is part of a lap line that splits the casting.
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
    out.quality = Math.max(0, Math.min(1, (filled - SEAM_WEIGHT * seam) / n));
    out.maxT = maxT;
    return out;
  }
}
