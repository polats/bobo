// A backyard cross-section as a falling-sand grid, one byte per cell. Packed ground never moves on
// its own: whether it stands is decided by the structural pass (islands.ts), which cuts unsupported
// regions free as rigid bodies (rigid.ts). LOOSE grains fall and slide into piles, water runs and
// levels, and BODY cells are a rigid body's pixels stamped into the grid, which grains and water treat
// as solid. Each step stamps the cells it moves into, so nothing moves twice in one step.

export const EMPTY = 0;
export const GRASS = 1;
export const SOIL = 2;
export const CLAY = 3;
export const SAND = 4;
export const GRAVEL = 5;
export const ROCK = 6;
export const BEDROCK = 7;
export const WATER = 8;
/** Material of a buried find's body (never in the grid except as a BODY stamp). */
export const FIND = 9;
/** Flag bit: a loose grain of its material rather than packed ground. */
export const LOOSE = 0x80;
/** Flag bit: a rigid body's pixel; `owner` holds which body. */
export const BODY = 0x40;
export const MAT = 0x3f;

/** Chance per step that a finger scrape removes a cell (rock needs chipping). */
export const DIGGABLE = [0, 1, 1, 0.8, 1, 0.9, 0.1, 0, 1, 0];
/** Chance per step that an undercut packed cell of a cohesionless material (sand, gravel) runs loose. */
const RAVEL = [0, 0, 0, 0, 0.3, 0.15, 0, 0, 0, 0];

const lut = (f: (c: number) => boolean) => {
  const t = new Uint8Array(256);
  for (let c = 0; c < 256; c++) t[c] = f(c) ? 1 : 0;
  return t;
};
/** Packed ground: the cells that carry load and make up islands. */
export const PACKED = lut((c) => c !== 0 && !(c & (LOOSE | BODY)) && (c & MAT) !== WATER);
/** What a rigid body collides with: packed ground and grains, not water or body stamps. Body masks hold bare materials, so the same table serves them. */
export const SOLID = lut((c) => c !== 0 && !(c & BODY) && (c & MAT) !== WATER);
/** Things packed ground can rest on besides ground: a grain pile, a pond, a body. */
export const PROP = lut((c) => c !== 0 && ((c & (LOOSE | BODY)) !== 0 || c === WATER));

export class DigSim {
  readonly cells: Uint8Array;
  /** Per-cell colour jitter, fixed at generation so the ground has grain. */
  readonly shade: Uint8Array;
  /** Which body (id & 0xffff) a BODY cell belongs to. */
  readonly owner: Uint16Array;
  /** Step stamp of the last move into each cell. */
  private mark: Uint16Array;
  private tick = 0;
  /** Loose grains that moved this step (drives the trickle sound). */
  moved = 0;
  /** Packed cells that ran loose this step (drives the collapse sound). */
  crumbled = 0;
  /** Water cells that moved this step. */
  flowed = 0;
  private flip = 0;
  /** Rows where packed ground lost something it rested on, for the next structural pass. */
  dirtyLo = Infinity;
  dirtyHi = -Infinity;
  /** Bodies whose support just moved away. */
  readonly wake: number[] = [];
  /** Boulders cut at generation, as lists of cell indices (the toy turns them into bodies). */
  readonly boulders: number[][] = [];

  constructor(
    readonly W: number,
    readonly H: number,
    readonly ground: number,
    readonly seed = (Math.random() * 2 ** 32) >>> 0,
  ) {
    this.cells = new Uint8Array(W * H);
    this.shade = new Uint8Array(W * H);
    this.owner = new Uint16Array(W * H);
    this.mark = new Uint16Array(W * H);
    this.generate();
  }

  // ---------------------------------------------------------------- terrain

  private generate() {
    const { W, H, ground, cells, shade } = this;
    const R = mulberry(this.seed);
    const rnd = (a: number, b: number) => a + R() * (b - a);
    const depth = H - ground;
    // This yard's strata: every seed picks its own layer thicknesses, waviness and roughness.
    const fr: number[] = [];
    let f = rnd(0.07, 0.13);
    fr.push(f); // topsoil ends
    fr.push((f += rnd(0.14, 0.26))); // clay ends
    fr.push((f += rnd(0.05, 0.12))); // gravel seam ends
    fr.push((f += rnd(0.12, 0.2))); // boulder clay ends
    fr.push((f += rnd(0.12, 0.22))); // deep clay (the water table) ends
    if (f > 0.93) for (let i = 0; i < fr.length; i++) fr[i] *= 0.93 / f;
    const deep = R() < 0.4 ? GRAVEL : SOIL;
    const mats = [SOIL, CLAY, GRAVEL, CLAY, CLAY, deep];
    const waves = fr.map(() => fbm1(R, W, rnd(24, 90), 3, rnd(0.35, 0.65)));
    const amps = fr.map(() => rnd(3, 14));
    const bedLine = fbm1(R, W, 40, 3, 0.5);
    const grassT = Math.round(rnd(2, 3.6));
    const b = new Array<number>(fr.length);
    for (let x = 0; x < W; x++) {
      for (let i = 0; i < fr.length; i++) b[i] = Math.max(i ? b[i - 1] + 2 : ground + grassT + 2, ground + depth * fr[i] + amps[i] * waves[i][x]);
      const bed = H - 12 + 4 * bedLine[x];
      for (let y = ground; y < H; y++) {
        let m = y < ground + grassT ? GRASS : y >= bed ? BEDROCK : mats[mats.length - 1];
        if (m !== GRASS && m !== BEDROCK)
          for (let i = 0; i < b.length; i++)
            if (y < b[i]) {
              m = mats[i];
              break;
            }
        cells[y * W + x] = m;
        shade[y * W + x] = Math.floor(R() * 256);
      }
    }
    const nseed = Math.floor(R() * 1e9);
    const band = (i: number) => ground + depth * fr[i];
    // Noise-edged pockets, so no two lenses share a shape.
    const blob = (cx: number, cy: number, rx: number, ry: number, m: number, only: number[]) => {
      for (let y = Math.max(ground + 4, Math.floor(cy - ry - 2)); y <= Math.min(H - 14, cy + ry + 2); y++)
        for (let x = Math.max(0, Math.floor(cx - rx - 2)); x <= Math.min(W - 1, cx + rx + 2); x++) {
          const k = y * W + x;
          const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 + (noise2(x * 0.2, y * 0.2, nseed) - 0.5) * 0.9;
          if (d > 1 || !only.includes(cells[k])) continue;
          cells[k] = m;
        }
    };
    const count = (a: number, c: number) => Math.round(rnd(a, c));
    for (let i = count(3, 9); i > 0; i--) blob(rnd(0, W), rnd(ground + depth * 0.04, band(1)), rnd(6, 22), rnd(2.5, 7), SAND, [SOIL, CLAY]);
    for (let i = count(2, 7); i > 0; i--) blob(rnd(0, W), rnd(band(3), band(4)), rnd(5, 15), rnd(3, 6), WATER, [CLAY]);
    for (let i = count(2, 6); i > 0; i--) blob(rnd(0, W), rnd(band(2), band(3)), rnd(5, 12), rnd(4, 8), SOIL, [CLAY]);
    for (let i = count(2, 6); i > 0; i--) blob(rnd(0, W), rnd(band(4), H - 20), rnd(6, 14), rnd(3, 6), GRAVEL, [SOIL, CLAY]);
    // Half the yards have an old stream bed: a meandering sand channel with a gravel floor.
    if (R() < 0.55) {
      const cy = rnd(band(0) + 4, band(1) - 4);
      const path = fbm1(R, W, 30, 2, 0.5);
      const x0 = Math.floor(rnd(-20, W * 0.4)), x1 = Math.floor(x0 + rnd(60, 160));
      const thick = rnd(3, 6);
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++)
        for (let t = 0; t < thick; t++) {
          const y = Math.round(cy + path[x] * 9 + t - thick / 2);
          const k = y * W + x;
          if (cells[k] === SOIL || cells[k] === CLAY) cells[k] = t > thick * 0.65 ? GRAVEL : SAND;
        }
    }
    // Boulders, mostly in the boulder clay, plus a few stray stones. Knobbly outlines so they tumble.
    const stone = (cx: number, cy: number, r: number) => {
      const p1 = R() * 7, p2 = R() * 7, k1 = rnd(0.06, 0.2), k2 = rnd(0.03, 0.1), sq = rnd(0.8, 1.25);
      const list: number[] = [];
      for (let y = Math.max(ground + 5, Math.floor(cy - r * 1.4)); y <= Math.min(H - 16, cy + r * 1.4); y++)
        for (let x = Math.max(2, Math.floor(cx - r * 1.4)); x <= Math.min(W - 3, cx + r * 1.4); x++) {
          const dx = x + 0.5 - cx, dy = (y + 0.5 - cy) * sq;
          const th = Math.atan2(dy, dx);
          const rr = r * (1 + k1 * Math.sin(3 * th + p1) + k2 * Math.sin(5 * th + p2));
          if (dx * dx + dy * dy > rr * rr) continue;
          const k = y * W + x;
          if (cells[k] === ROCK || cells[k] === BEDROCK || cells[k] === WATER) continue;
          cells[k] = ROCK;
          list.push(k);
        }
      if (list.length >= 12) this.boulders.push(list);
    };
    for (let i = count(5, 12); i > 0; i--) stone(rnd(4, W - 4), rnd(band(2), band(3)), rnd(3.5, 8.5));
    for (let i = count(1, 4); i > 0; i--) stone(rnd(4, W - 4), rnd(band(0), band(4)), rnd(2.5, 4));
  }

  // ---------------------------------------------------------------- bookkeeping

  markDirty(y: number) {
    if (y < this.dirtyLo) this.dirtyLo = y;
    if (y > this.dirtyHi) this.dirtyHi = y;
  }

  /** Cell k just emptied: whatever rested on it may have lost its support. */
  vacated(k: number) {
    const up = k - this.W;
    if (up < 0) return;
    const c = this.cells[up];
    if (!c) return;
    if (c & BODY) this.wake.push(this.owner[up]);
    else if (PACKED[c]) this.markDirty((up / this.W) | 0);
  }

  /** Scrape a disc; counts removed cells per material into `out` and the bodies it touched into `hit`. */
  dig(cx: number, cy: number, r: number, out: number[], hit: Set<number>) {
    const { W, H, cells } = this;
    let n = 0;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const k = y * W + x;
        const c = cells[k];
        if (!c) continue;
        if (c & BODY) {
          hit.add(this.owner[k]);
          continue;
        }
        const m = c & MAT;
        if (Math.random() > DIGGABLE[m]) continue;
        cells[k] = EMPTY;
        this.markDirty(y);
        this.vacated(k);
        out[m]++;
        n++;
      }
    return n;
  }

  // ---------------------------------------------------------------- CA

  /** One step over rows [y0, y1). Bottom-up so grains fall in a single pass. */
  step(y0: number, y1: number) {
    const { W, H, cells, mark } = this;
    this.moved = 0;
    this.crumbled = 0;
    this.flowed = 0;
    this.flip ^= 1;
    const t = (this.tick = (this.tick % 65535) + 1);
    const lo = Math.max(0, y0), hi = Math.min(H - 1, y1);
    for (let y = hi - 1; y >= lo; y--) {
      const ltr = (y + this.flip) & 1;
      for (let xi = 0; xi < W; xi++) {
        const x = ltr ? xi : W - 1 - xi;
        const k = y * W + x;
        const c = cells[k];
        if (!c || c & BODY || mark[k] === t) continue;
        if (c === WATER) this.flowWater(x, y, k, t);
        else if (c & LOOSE) this.fallGrain(x, k, c, t);
        else if (RAVEL[c] && !cells[k + W] && Math.random() < RAVEL[c]) {
          // Sand and gravel have no cohesion: an undercut face ravels grain by grain.
          cells[k] = c | LOOSE;
          this.crumbled++;
        }
      }
    }
  }

  private fallGrain(x: number, k: number, c: number, t: number) {
    const { W, cells, mark } = this;
    const below = k + W;
    const b = cells[below];
    if (!b || b === WATER) {
      cells[k] = b;
      cells[below] = c;
      mark[below] = mark[k] = t;
      if (!b) this.vacated(k);
      this.moved++;
      return;
    }
    // Slide off diagonally: sand runs readily, clumps of soil and clay less so (steeper piles).
    const m = c & MAT;
    if (m !== SAND && m !== GRAVEL && Math.random() < 0.55) return;
    const dir = Math.random() < 0.5 ? -1 : 1;
    for (const d of [dir, -dir]) {
      const nx = x + d;
      if (nx < 0 || nx >= W) continue;
      const tc = cells[below + d];
      if ((!tc || tc === WATER) && !cells[k + d]) {
        cells[k] = tc;
        cells[below + d] = c;
        mark[below + d] = mark[k] = t;
        if (!tc) this.vacated(k);
        this.moved++;
        return;
      }
    }
  }

  private flowWater(x: number, y: number, k: number, t: number) {
    const { W, cells, mark } = this;
    const below = k + W;
    if (!cells[below]) {
      cells[below] = WATER;
      cells[k] = EMPTY;
      mark[below] = t;
      this.vacated(k);
      this.flowed++;
      return;
    }
    const dir = Math.random() < 0.5 ? -1 : 1;
    for (const d of [dir, -dir]) {
      const nx = x + d;
      if (nx < 0 || nx >= W) continue;
      if (!cells[below + d] && !cells[k + d]) {
        cells[below + d] = WATER;
        cells[k] = EMPTY;
        mark[below + d] = t;
        this.vacated(k);
        this.flowed++;
        return;
      }
    }
    // Spread sideways a couple of cells so pools level out. The stamp stops it hopping again this step.
    for (const d of [dir, -dir])
      for (let s = 1; s <= 2; s++) {
        const nx = x + d * s;
        if (nx < 0 || nx >= W || cells[y * W + nx]) break;
        if (s === 2 || Math.random() < 0.5) {
          cells[y * W + nx] = WATER;
          cells[k] = EMPTY;
          mark[y * W + nx] = t;
          this.vacated(k);
          return;
        }
      }
  }
}

// ---------------------------------------------------------------- noise

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 1-D fractal value noise sampled at 0..n-1, roughly in [-1, 1]. */
function fbm1(rand: () => number, n: number, scale: number, octaves: number, rough: number) {
  const out = new Float32Array(n);
  let amp = 1, total = 0, sc = scale;
  for (let o = 0; o < octaves; o++) {
    const lat = Array.from({ length: Math.ceil(n / sc) + 2 }, () => rand() * 2 - 1);
    for (let x = 0; x < n; x++) {
      const u = x / sc, i = Math.floor(u), f = u - i, s = f * f * (3 - 2 * f);
      out[x] += amp * (lat[i] + (lat[i + 1] - lat[i]) * s);
    }
    total += amp;
    amp *= rough;
    sc /= 2;
  }
  for (let x = 0; x < n; x++) out[x] /= total;
  return out;
}

function hash2(x: number, y: number, seed: number) {
  let h = (Math.imul(x, 374761393) + Math.imul(y, 668265263) + seed) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** 2-D value noise in [0, 1]. */
function noise2(x: number, y: number, seed: number) {
  const i = Math.floor(x), j = Math.floor(y);
  const fx = x - i, fy = y - j;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash2(i, j, seed), b = hash2(i + 1, j, seed), c = hash2(i, j + 1, seed), d = hash2(i + 1, j + 1, seed);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}
