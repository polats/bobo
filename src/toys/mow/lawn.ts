// CPU mirror of the lawn: an R8 length map, an RG8 lean map and a static kind mask. The mower
// stamps its deck into these every frame and only the dirty rect goes up to the GPU, so the
// "% mown" meter is a plain counter here and never needs a readback.

/** Lawn texture size; square texels over a lawn LX wide and LZ deep (world units). */
export const TW = 200;
export const TH = 320;
export const LX = 1;
export const LZ = TH / TW;

export const KIND_LAWN = 0;
export const KIND_BED = 128;
export const KIND_STONE = 255;

export interface Bed {
  x: number;
  z: number;
  r: number;
}

export interface Flower {
  x: number;
  z: number;
  h: number;
  color: [number, number, number];
  alive: boolean;
}

export interface Layout {
  beds: Bed[];
  flowers: Flower[];
  stone: { x: number; z: number; r: number };
  cat: { x: number; z: number; heading: number };
}

/** Small seeded PRNG (mulberry32) so a lawn can be regenerated from its seed. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FLOWER_COLORS: [number, number, number][] = [
  [1, 0.35, 0.55],
  [1, 0.85, 0.2],
  [0.95, 0.95, 1],
  [0.75, 0.4, 1],
  [1, 0.5, 0.2],
];

/** Two flower beds, a stone and a sleeping cat, none overlapping and none hugging an edge. */
export function makeLayout(seed: number): Layout {
  const rand = rng(seed);
  const placed: { x: number; z: number; r: number }[] = [];
  const place = (r: number, margin: number) => {
    for (let k = 0; k < 200; k++) {
      const x = (rand() - 0.5) * (LX - 2 * margin);
      const z = (rand() - 0.5) * (LZ - 2 * margin);
      if (placed.every((o) => Math.hypot(o.x - x, o.z - z) > o.r + r + 0.14)) {
        placed.push({ x, z, r });
        return { x, z };
      }
    }
    placed.push({ x: 0, z: 0, r });
    return { x: 0, z: 0 };
  };
  const beds: Bed[] = [];
  const flowers: Flower[] = [];
  for (let b = 0; b < 2; b++) {
    const r = 0.09 + rand() * 0.04;
    const p = place(r, r + 0.1);
    beds.push({ x: p.x, z: p.z, r });
    const n = Math.round(r * 150);
    const hue = Math.floor(rand() * FLOWER_COLORS.length);
    for (let i = 0; i < n; i++) {
      // Sunflower spiral, kept 3.5 cm inside the soil edge.
      const a = i * 2.39996 + rand() * 0.3;
      const d = Math.sqrt((i + 0.5) / n) * (r - 0.035);
      flowers.push({
        x: p.x + Math.cos(a) * d,
        z: p.z + Math.sin(a) * d,
        h: 0.03 + rand() * 0.025,
        color: FLOWER_COLORS[(hue + (rand() < 0.3 ? 1 : 0)) % FLOWER_COLORS.length],
        alive: true,
      });
    }
  }
  const sr = 0.04;
  const sp = place(sr, 0.12);
  const cp = place(0.06, 0.12);
  return { beds, flowers, stone: { x: sp.x, z: sp.z, r: sr }, cat: { x: cp.x, z: cp.z, heading: rand() * Math.PI * 2 } };
}

export class Lawn {
  readonly len = new Uint8Array(TW * TH);
  readonly lean = new Uint8Array(TW * TH * 2);
  readonly kind = new Uint8Array(TW * TH);
  lawnTexels = 1;
  cutTexels = 0;
  /** Stubble length (0..255) the deck leaves behind. */
  cutLevel = 64;
  /** Dirty rect in texels, inclusive min / exclusive max; empty when x0 >= x1. */
  dx0 = 0;
  dy0 = 0;
  dx1 = TW;
  dy1 = TH;

  reset(layout: Layout, seed: number) {
    const rand = rng(seed ^ 0x9e3779b9);
    // Low-frequency patchiness in the uncut length: a few random blobs summed.
    const blobs: number[] = [];
    for (let i = 0; i < 14; i++) blobs.push((rand() - 0.5) * LX, (rand() - 0.5) * LZ, 0.08 + rand() * 0.15, rand() - 0.5);
    let lawn = 0;
    for (let j = 0; j < TH; j++) {
      for (let i = 0; i < TW; i++) {
        const [x, z] = texelToWorld(i, j);
        const k = j * TW + i;
        let kind = KIND_LAWN;
        for (const b of layout.beds) if (Math.hypot(x - b.x, z - b.z) < b.r) kind = KIND_BED;
        if (Math.hypot(x - layout.stone.x, z - layout.stone.z) < layout.stone.r * 1.1) kind = KIND_STONE;
        this.kind[k] = kind;
        let n = 0;
        for (let q = 0; q < blobs.length; q += 4) {
          const d = Math.hypot(x - blobs[q], z - blobs[q + 1]) / blobs[q + 2];
          if (d < 1) n += blobs[q + 3] * (1 - d * d);
        }
        this.len[k] = kind === KIND_LAWN ? clamp8(228 + n * 60) : 0;
        this.lean[k * 2] = 128;
        this.lean[k * 2 + 1] = 128;
        if (kind === KIND_LAWN) lawn++;
      }
    }
    this.lawnTexels = Math.max(1, lawn);
    this.recount();
    this.markAll();
  }

  /** A texel counts as mown until it regrows this far past the cut. */
  get threshold() {
    return this.cutLevel + 40;
  }

  /** Recount cut texels (after the cut height changes). */
  recount() {
    const th = this.threshold;
    let n = 0;
    for (let k = 0; k < this.len.length; k++) if (this.kind[k] === KIND_LAWN && this.len[k] <= th) n++;
    this.cutTexels = n;
  }

  markAll() {
    this.dx0 = 0;
    this.dy0 = 0;
    this.dx1 = TW;
    this.dy1 = TH;
  }

  clearDirty() {
    this.dx0 = TW;
    this.dy0 = TH;
    this.dx1 = 0;
    this.dy1 = 0;
  }

  /**
   * Stamp the deck swept from a to b (a capsule of radius r): length = min(length, cut) and,
   * when moving, lean = travel direction. Returns the total length removed (0..255 per texel),
   * which is the motor's load.
   */
  stamp(ax: number, az: number, bx: number, bz: number, r: number, dirX: number, dirZ: number, lean: boolean) {
    const [ai, aj] = worldToTexel(ax, az);
    const [bi, bj] = worldToTexel(bx, bz);
    const rt = (r * TW) / LX;
    const i0 = Math.max(0, Math.floor(Math.min(ai, bi) - rt));
    const i1 = Math.min(TW - 1, Math.ceil(Math.max(ai, bi) + rt));
    const j0 = Math.max(0, Math.floor(Math.min(aj, bj) - rt));
    const j1 = Math.min(TH - 1, Math.ceil(Math.max(aj, bj) + rt));
    if (i0 > i1 || j0 > j1) return 0;
    const sx = bi - ai, sy = bj - aj;
    const ss = sx * sx + sy * sy;
    const r2 = rt * rt;
    const cut = this.cutLevel;
    const th = this.threshold;
    const lx = Math.round(128 + dirX * 127);
    const ly = Math.round(128 + dirZ * 127);
    let removed = 0;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        const px = i - ai, py = j - aj;
        const t = ss > 0 ? Math.max(0, Math.min(1, (px * sx + py * sy) / ss)) : 0;
        const ex = px - t * sx, ey = py - t * sy;
        if (ex * ex + ey * ey > r2) continue;
        const k = j * TW + i;
        if (this.kind[k] !== KIND_LAWN) continue;
        const l = this.len[k];
        if (l > cut) {
          removed += l - cut;
          if (l > th) this.cutTexels++;
          this.len[k] = cut;
        }
        if (lean) {
          this.lean[k * 2] = lx;
          this.lean[k * 2 + 1] = ly;
        }
      }
    }
    this.dx0 = Math.min(this.dx0, i0);
    this.dy0 = Math.min(this.dy0, j0);
    this.dx1 = Math.max(this.dx1, i1 + 1);
    this.dy1 = Math.max(this.dy1, j1 + 1);
    return removed;
  }

  /** Slow regrowth: every call grows cut grass a notch and relaxes its lean toward upright. */
  regrow(step: number) {
    const th = this.threshold;
    for (let k = 0; k < this.len.length; k++) {
      if (this.kind[k] !== KIND_LAWN) continue;
      const l = this.len[k];
      if (l < 228) {
        const n = Math.min(228, l + step);
        if (l <= th && n > th) this.cutTexels--;
        this.len[k] = n;
      }
      for (let c = 0; c < 2; c++) {
        const v = this.lean[k * 2 + c];
        if (v !== 128) this.lean[k * 2 + c] = v > 128 ? v - 1 : v + 1;
      }
    }
    this.markAll();
  }

  lengthAt(x: number, z: number) {
    const [i, j] = worldToTexel(x, z);
    const ii = Math.round(i), jj = Math.round(j);
    if (ii < 0 || jj < 0 || ii >= TW || jj >= TH) return 0;
    return this.len[jj * TW + ii];
  }
}

export function texelToWorld(i: number, j: number): [number, number] {
  return [((i + 0.5) / TW - 0.5) * LX, ((j + 0.5) / TH - 0.5) * LZ];
}

export function worldToTexel(x: number, z: number): [number, number] {
  return [(x / LX + 0.5) * TW - 0.5, (z / LZ + 0.5) * TH - 0.5];
}

function clamp8(v: number) {
  return Math.max(0, Math.min(255, Math.round(v)));
}
