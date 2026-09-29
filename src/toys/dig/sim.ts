// A backyard cross-section as a falling-sand grid with cohesion. Solid soil holds its shape until
// it's undercut: a cell with nothing beneath it detaches with a probability that depends on its
// material (sand runs, clay overhangs) and how many solid neighbours still hold it. Detached cells
// become loose grains that slide to their angle of repose; water pockets drain into the hole.

export const EMPTY = 0;
export const GRASS = 1;
export const SOIL = 2;
export const CLAY = 3;
export const SAND = 4;
export const GRAVEL = 5;
export const ROCK = 6;
export const BEDROCK = 7;
export const WATER = 8;
/** Flag bit: the cell is a loose grain of its material rather than packed ground. */
export const LOOSE = 0x80;

/** Chance per step that an undercut cell lets go once its span is too long. 0 = never. */
const CRUMBLE = [0, 0.25, 0.3, 0.2, 0.6, 0.45, 0, 0, 0];
/**
 * How far (cells) a material can bridge over a hole before it sags in: sand and gravel barely at
 * all, topsoil a short ledge, clay a real tunnel roof, and the grass mat holds the lawn together.
 */
const SPAN = [0, 6, 2, 7, 0, 0, 99, 99, 0];
/** Chance per step that a finger scrape removes a cell (rock needs chipping). */
export const DIGGABLE = [0, 1, 1, 0.8, 1, 0.9, 0.1, 0, 1];

export class DigSim {
  readonly cells: Uint8Array;
  /** Per-cell colour jitter, fixed at generation so the ground has grain. */
  readonly shade: Uint8Array;
  /** Loose grains and water that moved this step (drives the trickle sound). */
  moved = 0;
  /** Packed cells that crumbled loose this step (drives the collapse sound). */
  crumbled = 0;
  /** Water cells that moved this step. */
  flowed = 0;
  private flip = 0;

  constructor(
    readonly W: number,
    readonly H: number,
    readonly ground: number,
  ) {
    this.cells = new Uint8Array(W * H);
    this.shade = new Uint8Array(W * H);
    this.generate();
  }

  private generate() {
    const { W, H, ground, cells, shade } = this;
    const waves = (amp: number, seed: number) => {
      const ph = [Math.random() * 7, Math.random() * 7, Math.random() * 7];
      return (x: number) => amp * (Math.sin(x * 0.045 + ph[0] + seed) * 0.6 + Math.sin(x * 0.11 + ph[1]) * 0.3 + Math.sin(x * 0.27 + ph[2]) * 0.1);
    };
    const depth = H - ground;
    const soilEnd = waves(6, 1), clayEnd = waves(10, 2), gravelEnd = waves(8, 3), rockEnd = waves(14, 4), bedrock = waves(4, 5);
    for (let x = 0; x < W; x++) {
      const b = [
        ground + 2,
        ground + depth * 0.1 + soilEnd(x),
        ground + depth * 0.33 + clayEnd(x),
        ground + depth * 0.45 + gravelEnd(x),
        ground + depth * 0.78 + rockEnd(x),
        H - 12 + bedrock(x),
      ];
      for (let y = ground; y < H; y++) {
        let m = y < b[0] ? GRASS : y < b[1] ? SOIL : y < b[2] ? CLAY : y < b[3] ? GRAVEL : y < b[4] ? CLAY : y < b[5] ? SOIL : BEDROCK;
        // A band of rock between the clay layers, broken into boulders you can dig around.
        if (m === CLAY && y > b[3] && y < b[3] + depth * 0.14) m = ROCK;
        cells[y * W + x] = m;
        shade[y * W + x] = Math.floor(Math.random() * 256);
      }
    }
    // Pockets: sand lenses in the soil and clay, water in the deep clay, holes in the rock band.
    const blob = (cx: number, cy: number, rx: number, ry: number, m: number, only?: number[]) => {
      for (let y = Math.max(ground + 3, Math.floor(cy - ry)); y <= Math.min(H - 14, cy + ry); y++)
        for (let x = Math.max(0, Math.floor(cx - rx)); x <= Math.min(W - 1, cx + rx); x++) {
          const k = y * W + x;
          const d = ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2;
          if (d > 1 - Math.random() * 0.15) continue;
          if (only && !only.includes(cells[k])) continue;
          cells[k] = m;
        }
    };
    const rnd = (a: number, b: number) => a + Math.random() * (b - a);
    for (let i = 0; i < 7; i++) blob(rnd(0, W), rnd(ground + depth * 0.05, ground + depth * 0.4), rnd(8, 20), rnd(3, 7), SAND, [SOIL, CLAY]);
    for (let i = 0; i < 5; i++) blob(rnd(0, W), rnd(ground + depth * 0.6, ground + depth * 0.76), rnd(6, 14), rnd(3, 6), WATER, [CLAY]);
    for (let i = 0; i < 6; i++) blob(rnd(0, W), rnd(ground + depth * 0.47, ground + depth * 0.58), rnd(5, 12), rnd(4, 8), SOIL, [ROCK]);
    for (let i = 0; i < 4; i++) blob(rnd(0, W), rnd(ground + depth * 0.8, ground + depth * 0.95), rnd(6, 14), rnd(3, 6), GRAVEL, [SOIL]);
  }

  /** Scrape a disc; returns how many cells of each material came out. */
  dig(cx: number, cy: number, r: number, out: number[]) {
    const { W, H, cells } = this;
    let n = 0;
    for (let y = Math.max(0, Math.floor(cy - r)); y <= Math.min(H - 1, Math.ceil(cy + r)); y++)
      for (let x = Math.max(0, Math.floor(cx - r)); x <= Math.min(W - 1, Math.ceil(cx + r)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > r * r) continue;
        const k = y * W + x;
        const c = cells[k];
        if (!c) continue;
        const m = c & 0x7f;
        if (Math.random() > DIGGABLE[m]) continue;
        cells[k] = EMPTY;
        out[m]++;
        n++;
      }
    return n;
  }

  /** One step over rows [y0, y1). Bottom-up so grains fall in a single pass. */
  step(y0: number, y1: number) {
    const { W, cells } = this;
    this.moved = 0;
    this.crumbled = 0;
    this.flowed = 0;
    this.flip ^= 1;
    const lo = Math.max(0, y0), hi = Math.min(this.H - 1, y1);
    for (let y = hi - 1; y >= lo; y--) {
      const ltr = (y + this.flip) & 1;
      for (let xi = 0; xi < W; xi++) {
        const x = ltr ? xi : W - 1 - xi;
        const k = y * W + x;
        const c = cells[k];
        if (!c) continue;
        const below = k + W;
        const m = c & 0x7f;
        if (m === WATER) {
          this.flowWater(x, y, k);
          continue;
        }
        if (c & LOOSE) {
          this.fallGrain(x, k, c);
          continue;
        }
        // Packed ground: only undercut cells can crumble (not ones resting on a water pocket).
        if (below >= cells.length || cells[below]) continue;
        const p = CRUMBLE[m];
        if (!p) continue;
        // Distance along the row to ground that's still standing on something.
        const span = SPAN[m];
        let reach = span + 1;
        for (let d = 1; d <= span; d++) {
          if ((x - d >= 0 && cells[k - d] && solid(cells[k - d]) && solid(cells[below - d])) || (x + d < W && cells[k + d] && solid(cells[k + d]) && solid(cells[below + d]))) {
            reach = d;
            break;
          }
          // A gap in the row itself means this bit hangs by the cells above only.
        }
        const hung = !solid(cells[k - W]);
        // Within span it holds (the odd grain trickles off); past it, the roof comes down.
        const chance = reach > span ? p : hung ? p * 0.5 : 0.004;
        if (Math.random() < chance) {
          cells[k] = c | LOOSE;
          this.crumbled++;
          // Ground tends to go in slabs: an undercut neighbour often comes down with it.
          for (const d of [-1, 1]) {
            const n = k + d;
            if (x + d < 0 || x + d >= W || !solid(cells[n]) || cells[n + W] || CRUMBLE[cells[n]] === 0 || Math.random() > 0.45) continue;
            cells[n] = cells[n] | LOOSE;
            this.crumbled++;
          }
        }
      }
    }
  }

  private fallGrain(x: number, k: number, c: number) {
    const { W, cells } = this;
    const below = k + W;
    if (below >= cells.length) return;
    const b = cells[below];
    if (!b || (b & 0x7f) === WATER) {
      cells[k] = b;
      cells[below] = c;
      this.moved++;
      return;
    }
    // Slide off diagonally: sand runs readily, clumps of soil and clay less so (steeper piles).
    const m = c & 0x7f;
    if (m !== SAND && m !== GRAVEL && Math.random() < 0.55) return;
    const dir = Math.random() < 0.5 ? -1 : 1;
    for (const d of [dir, -dir]) {
      const nx = x + d;
      if (nx < 0 || nx >= W) continue;
      const t = cells[below + d];
      if ((!t || (t & 0x7f) === WATER) && !cells[k + d]) {
        cells[k] = t;
        cells[below + d] = c;
        this.moved++;
        return;
      }
    }
  }

  private flowWater(x: number, y: number, k: number) {
    const { W, cells } = this;
    const below = k + W;
    if (below < cells.length && !cells[below]) {
      cells[below] = WATER;
      cells[k] = EMPTY;
      this.flowed++;
      return;
    }
    const dir = Math.random() < 0.5 ? -1 : 1;
    for (const d of [dir, -dir]) {
      const nx = x + d;
      if (nx < 0 || nx >= W) continue;
      if (below < cells.length && !cells[below + d] && !cells[k + d]) {
        cells[below + d] = WATER;
        cells[k] = EMPTY;
        this.flowed++;
        return;
      }
    }
    // Spread sideways a couple of cells so pools level out.
    for (const d of [dir, -dir])
      for (let s = 1; s <= 2; s++) {
        const nx = x + d * s;
        if (nx < 0 || nx >= W || cells[y * W + nx]) break;
        if (s === 2 || Math.random() < 0.5) {
          cells[y * W + nx] = WATER;
          cells[k] = EMPTY;
          return;
        }
      }
  }

  /** Fraction of a rectangle that's open (dug out or drained). */
  openness(x0: number, y0: number, w: number, h: number) {
    let open = 0, n = 0;
    for (let y = Math.max(0, y0); y < Math.min(this.H, y0 + h); y++)
      for (let x = Math.max(0, x0); x < Math.min(this.W, x0 + w); x++) {
        n++;
        const c = this.cells[y * this.W + x];
        if (!c || (c & 0x7f) === WATER) open++;
      }
    return n ? open / n : 0;
  }
}

function solid(c: number) {
  return c !== 0 && (c & LOOSE) === 0 && (c & 0x7f) !== WATER;
}
