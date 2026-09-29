// Coloured sand art on a falling-sand grid. Only one material (sand) in 12 colours; grains fall
// with a little momentum, slide down slopes (angle of repose), follow a tilted gravity, and in
// Reveal mode lock in place when they come to rest on a picture pixel of their own colour.

export type Mode = 'jar' | 'reveal';

/** sRGB colours; index 0 is empty. Order is also the auto-cycle order for pouring strata. */
export const PALETTE: [number, number, number][] = [
  [0, 0, 0],
  [0.95, 0.9, 0.78], // 1 cream
  [1.0, 0.42, 0.66], // 2 pink
  [0.9, 0.24, 0.22], // 3 red
  [1.0, 0.6, 0.18], // 4 orange
  [1.0, 0.84, 0.25], // 5 yellow
  [0.33, 0.77, 0.4], // 6 green
  [0.13, 0.72, 0.69], // 7 teal
  [0.24, 0.47, 0.91], // 8 blue
  [0.55, 0.38, 0.96], // 9 violet
  [0.16, 0.14, 0.26], // 10 navy
  [0.98, 0.98, 0.97], // 11 white
  [0.55, 0.36, 0.24], // 12 brown
];
export const COLOR_NAMES = ['', 'Cream', 'Pink', 'Red', 'Orange', 'Yellow', 'Green', 'Teal', 'Blue', 'Violet', 'Navy', 'White', 'Brown'];
/** Pleasing order for auto-cycled strata. */
export const CYCLE = [2, 4, 5, 6, 7, 8, 9, 3, 1, 10, 11, 12];

const CHAR: Record<string, number> = { '.': 1, p: 2, r: 3, o: 4, y: 5, g: 6, t: 7, b: 8, v: 9, k: 10, w: 11, n: 12 };

/** 16-wide pixel art, top row first. */
export const PICTURES: Record<string, string[]> = {
  heart: [
    '................',
    '...rrr....rrr...',
    '..rrrrr..rrrrr..',
    '.rrwwrrrrrrrrrr.',
    '.rrwrrrrrrrrrrr.',
    '.rrrrrrrrrrrrrr.',
    '..rrrrrrrrrrrr..',
    '...rrrrrrrrrr...',
    '....rrrrrrrr....',
    '.....rrrrrr.....',
    '......rrrr......',
    '.......rr.......',
    '................',
  ],
  bobo: [
    '................',
    '.....pppppp.....',
    '...pppppppppp...',
    '..ppwwpppppppp..',
    '..pwwppppppppp..',
    '.pppppppppppppp.',
    '.pppkkppppkkppp.',
    '.pppkwppppkwppp.',
    '.pppkkppppkkppp.',
    '.prrpppppppprrp.',
    '.ppppppkkpppppp.',
    '.pppppppppppppp.',
    '..pppppppppppp..',
    '................',
  ],
  sunset: [
    'vvvvvvvvvvvvvvvv',
    'vvvvvvvvvvvvvvvv',
    'pppppppppppppppp',
    'pppppppyyppppppp',
    'ppppppyyyypppppp',
    'ooooooyyyyoooooo',
    'oooooyyyyyyooooo',
    'oooooyyyyyyooooo',
    'bbbbbbbbbbbbbbbb',
    'bbbbwwwbbbbbbbbb',
    'bbbbbbbbbbbwwwbb',
    'tttttttttttttttt',
    'ttttwwwwtttttttt',
    'tttttttttttttttt',
  ],
  fish: [
    'tttttttttttttttt',
    'ttttttwttttttttt',
    'tttttttttwtttttt',
    'tttttoooootttttt',
    'ttttoooooooottoo',
    'tttoowkoooooooot',
    'tttookkooooootoo',
    'ttttoooooooottoo',
    'tttttoooootttttt',
    'tttttttttttttttt',
    'tgtttttttttttgtt',
    'tggttttttttggttt',
    'ggggnnnnnnnngggg',
  ],
  mushroom: [
    'bbbbbbbbbbbbbbbb',
    'bbbbbrrrrrrbbbbb',
    'bbbrrwwrrrrrrbbb',
    'bbrrrwwrrrwwrrbb',
    'brrrrrrrrrwwrrrb',
    'brwwrrrrrrrrrrrb',
    'brwwrrrrrwwrrrrb',
    'bbbbbb....bbbbbb',
    'bbbbbb....bbbbbb',
    'bbbbbb....bbbbbb',
    'bbbbb......bbbbb',
    'gggggggggggggggg',
    'gggggggggggggggg',
  ],
};

// 8 neighbour directions, rotating from straight down toward +x.
const DX = [0, 1, 1, 1, 0, -1, -1, -1];
const DY = [-1, -1, 0, 1, 1, 1, 0, -1];

export const LOCKED = 1;

export interface JarShape {
  cx: number;
  half: number; // body half-width
  neck: number; // mouth half-width
  y0: number; // floor (top of the table)
  yS: number; // shoulder
  yTop: number; // rim
  r: number; // bottom corner radius
}

export class JarSim {
  readonly n: number;
  readonly col: Uint8Array;
  readonly vari: Uint8Array;
  readonly vel: Uint8Array;
  readonly flags: Uint8Array;
  readonly stamp: Uint8Array;
  /** 0 = solid/outside, 1 = open (sand may be here), 2 = glass or frame (drawn, solid). */
  readonly mask: Uint8Array;
  /** Reveal mode: target colour per cell (0 = none). */
  readonly target: Uint8Array;
  jar: JarShape;
  frame = { x0: 0, x1: 0, y0: 0, y1: 0, px: 0, pw: 0, ph: 0, ox: 0, oy: 0 };
  openCount = 0;
  targetCount = 0;
  matched = 0;
  filled = 0;
  tilt = 0; // radians; positive pulls grains toward +x
  slide = 0.9;
  private tick = 0;
  movedThisStep = 0;

  constructor(
    readonly W: number,
    readonly H: number,
    readonly mode: Mode,
    readonly picture: string,
  ) {
    const n = (this.n = W * H);
    this.col = new Uint8Array(n);
    this.vari = new Uint8Array(n);
    this.vel = new Uint8Array(n);
    this.flags = new Uint8Array(n);
    this.stamp = new Uint8Array(n);
    this.mask = new Uint8Array(n);
    this.target = new Uint8Array(n);
    const jarW = Math.min(0.8 * W, 0.6 * H);
    const y0 = Math.round(0.145 * H);
    const jarH = Math.min(0.68 * H, jarW * 2.1);
    this.jar = {
      cx: W / 2,
      half: jarW / 2,
      neck: (jarW / 2) * 0.64,
      y0,
      yS: y0 + jarH * 0.8,
      yTop: y0 + jarH,
      r: jarW * 0.16,
    };
    if (mode === 'jar') this.buildJar();
    else this.buildFrame();
  }

  /** Signed distance to the jar's inner surface (negative inside), in cells. */
  jarSdf(x: number, y: number) {
    const j = this.jar;
    // Body: rounded box from the floor up to the shoulder.
    const bh = (j.yS - j.y0) / 2;
    const by = j.y0 + bh;
    const qx = Math.abs(x - j.cx) - (j.half - j.r);
    const qy = Math.abs(y - by) - (bh - j.r);
    const body = Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - j.r;
    // Neck: straight tube from the shoulder to the rim, blended in with a soft shoulder.
    const nx = Math.abs(x - j.cx) - j.neck;
    const ny = Math.abs(y - (j.yS + j.yTop) / 2) - (j.yTop - j.yS) / 2 - j.r;
    const neck = Math.max(nx, ny);
    const k = j.r * 0.9;
    const h = Math.max(k - Math.abs(body - neck), 0) / k;
    return Math.min(body, neck) - h * h * k * 0.25;
  }

  private buildJar() {
    const { W, H, mask, jar } = this;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const px = x + 0.5, py = y + 0.5;
        if (py > jar.yTop) {
          // Open air above the mouth, so you can pour from above the jar.
          mask[i] = Math.abs(px - jar.cx) < jar.neck ? 1 : 0;
          continue;
        }
        const d = this.jarSdf(px, py);
        mask[i] = d < 0 ? 1 : d < 2.2 ? 2 : 0;
      }
    this.openCount = 0;
    for (let i = 0; i < this.n; i++) if (mask[i] === 1 && Math.floor(i / W) + 0.5 <= jar.yTop) this.openCount++;
  }

  private buildFrame() {
    const { W, H, mask, target } = this;
    const x0 = Math.round(W * 0.06), x1 = Math.round(W * 0.94);
    const y0 = Math.round(H * 0.145);
    const b = 3; // frame thickness
    // The frame hugs the picture, with a little headroom for the last layer.
    const art0 = PICTURES[this.picture] ?? PICTURES.heart;
    const px0 = Math.floor((x1 - x0) / 16);
    const y1 = Math.min(Math.round(H * 0.84), y0 + px0 * art0.length + Math.max(4, px0));
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const i = y * W + x;
        const inX = x >= x0 && x < x1;
        if (inX && y >= y0) mask[i] = 1; // the frame's inside, and the air above its opening
        else if (x >= x0 - b && x < x1 + b && y >= y0 - b && y < y1 + b) mask[i] = 2;
        else mask[i] = 0;
      }
    const art = PICTURES[this.picture] ?? PICTURES.heart;
    const innerW = x1 - x0;
    const px = Math.floor(innerW / 16);
    const pw = px * 16, ph = px * art.length;
    const ox = x0 + Math.floor((innerW - pw) / 2), oy = y0;
    this.frame = { x0, x1, y0, y1, px, pw, ph, ox, oy };
    this.targetCount = 0;
    for (let r = 0; r < art.length; r++) {
      const row = art[r].padEnd(16, '.').slice(0, 16);
      for (let c = 0; c < 16; c++) {
        const t = CHAR[row[c]] ?? 1;
        for (let yy = 0; yy < px; yy++)
          for (let xx = 0; xx < px; xx++) {
            const gx = ox + c * px + xx;
            const gy = oy + (art.length - 1 - r) * px + yy;
            if (gx < 0 || gx >= W || gy < 0 || gy >= H) continue;
            target[gy * W + gx] = t;
            this.targetCount++;
          }
      }
    }
    this.openCount = (x1 - x0) * (y1 - y0);
  }

  isOpen(x: number, y: number) {
    return x >= 0 && y >= 0 && x < this.W && y < this.H && this.mask[y * this.W + x] === 1;
  }

  /** Pour `count` grains around (fx, fy), nudging the spout inside the jar mouth if needed. */
  spawn(fx: number, fy: number, color: number, count: number, scatter: number) {
    let made = 0;
    for (let k = 0; k < count; k++) {
      let x = Math.round(fx + (Math.random() - 0.5) * 2 * scatter);
      const y = Math.round(fy + Math.random() * 2.5);
      if (y < 0 || y >= this.H) continue;
      // Slide toward the centre until the grain is inside an opening.
      const cx = Math.round(this.W / 2);
      for (let s = 0; s < this.W && !this.isOpen(x, y); s++) x += x < cx ? 1 : -1;
      if (!this.isOpen(x, y)) continue;
      const i = y * this.W + x;
      if (this.col[i]) continue;
      this.col[i] = color;
      this.vari[i] = (Math.random() * 255) | 0;
      this.vel[i] = 2;
      this.flags[i] = 0;
      made++;
    }
    return made;
  }

  /** Stick: push grains out of a small disc so the layers above slump into the hole (scallops). */
  poke(fx: number, fy: number, r: number) {
    const { W, col } = this;
    let pushed = 0;
    const r2 = r * r;
    for (let y = Math.floor(fy - r); y <= Math.ceil(fy + r); y++)
      for (let x = Math.floor(fx - r); x <= Math.ceil(fx + r); x++) {
        if (!this.isOpen(x, y) || (x - fx) ** 2 + (y - fy) ** 2 > r2) continue;
        const i = y * W + x;
        if (!col[i] || this.flags[i] & LOCKED) continue;
        // Nearest free cell just outside the disc, sideways or upward.
        let best = -1, bestD = 1e9;
        const R = Math.ceil(r) + 5;
        for (let dy = 0; dy <= R; dy++)
          for (let dx = -R; dx <= R; dx++) {
            const nx = x + dx, ny = y + dy;
            const d2 = (nx - fx) ** 2 + (ny - fy) ** 2;
            if (d2 <= r2 || !this.isOpen(nx, ny)) continue;
            const j = ny * W + nx;
            if (col[j]) continue;
            const cost = dx * dx + dy * dy * 1.5;
            if (cost < bestD) { bestD = cost; best = j; }
          }
        const moved = best >= 0;
        if (moved) this.move(i, best);
        if (moved) pushed++;
      }
    return pushed;
  }

  scoop(fx: number, fy: number, r: number) {
    const { W, col } = this;
    let removed = 0;
    for (let y = Math.floor(fy - r); y <= Math.ceil(fy + r); y++)
      for (let x = Math.floor(fx - r); x <= Math.ceil(fx + r); x++) {
        if (!this.isOpen(x, y) || (x - fx) ** 2 + (y - fy) ** 2 > r * r) continue;
        const i = y * W + x;
        if (!col[i]) continue;
        if (this.flags[i] & LOCKED) this.matched--;
        col[i] = 0;
        this.flags[i] = 0;
        removed++;
      }
    return removed;
  }

  empty() {
    this.col.fill(0);
    this.flags.fill(0);
    this.matched = 0;
  }

  /** Paint the finished picture into the frame (the reveal payoff). */
  completeReveal() {
    const { target, col, flags, vari } = this;
    for (let i = 0; i < this.n; i++) {
      if (!target[i]) continue;
      if (!col[i]) vari[i] = (Math.random() * 255) | 0;
      col[i] = target[i];
      flags[i] = LOCKED;
    }
    this.matched = this.targetCount;
  }

  private move(i: number, j: number) {
    this.col[j] = this.col[i];
    this.vari[j] = this.vari[i];
    this.vel[j] = this.vel[i];
    this.flags[j] = this.flags[i];
    this.col[i] = 0;
    this.flags[i] = 0;
  }

  step() {
    const { W, H, col, vel, flags, stamp, mask, target } = this;
    const cur = (this.tick = (this.tick + 1) & 255) || 1;
    const f = this.tilt / (Math.PI / 4);
    const k0 = Math.floor(f);
    const frac = f - k0;
    const slide = this.slide;
    const reveal = this.mode === 'reveal';
    let moved = 0;
    for (let y = 0; y < H; y++) {
      const ltr = ((y + cur) & 1) === 0;
      for (let xi = 0; xi < W; xi++) {
        const x = ltr ? xi : W - 1 - xi;
        const i = y * W + x;
        const c = col[i];
        if (!c || stamp[i] === cur || flags[i] & LOCKED) continue;
        // Primary direction: the 8-neighbour nearest the tilted gravity, dithered between two.
        const k = (((Math.random() < frac ? k0 + 1 : k0) % 8) + 8) % 8;
        let v = vel[i];
        let tx = x, ty = y;
        let steps = 0;
        while (steps < v) {
          const nx = tx + DX[k], ny = ty + DY[k];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) break;
          const j = ny * W + nx;
          if (mask[j] !== 1 || col[j]) break;
          tx = nx;
          ty = ny;
          steps++;
        }
        if (steps > 0) {
          const j = ty * W + tx;
          this.move(i, j);
          vel[j] = Math.min(7, v + (cur & 1));
          stamp[j] = cur;
          moved++;
          continue;
        }
        // Blocked: slide down one of the two neighbouring directions (angle of repose).
        const first = Math.random() < 0.5 ? 1 : 7;
        let slid = false;
        for (let s = 0; s < 2 && !slid; s++) {
          if (Math.random() > slide) continue;
          const kk = (k + (s === 0 ? first : 8 - first)) % 8;
          const nx = x + DX[kk], ny = y + DY[kk];
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const j = ny * W + nx;
          if (mask[j] !== 1 || col[j]) continue;
          // Diagonal slides need the side cell free too, or grains leak through corners.
          const side = y * W + nx;
          if (DY[kk] !== 0 && (mask[side] !== 1 || col[side])) continue;
          this.move(i, j);
          vel[j] = 1;
          stamp[j] = cur;
          slid = true;
          moved++;
        }
        if (slid) continue;
        vel[i] = 1;
        // At rest: in Reveal mode a grain sitting on its own colour sticks for good.
        if (reveal && target[i] === c) {
          flags[i] |= LOCKED;
          this.matched++;
        }
      }
    }
    this.movedThisStep = moved;
  }

  /** Count grains inside the jar / frame (for the fill meter). */
  countFilled() {
    let f = 0;
    const lim = this.mode === 'jar' ? Math.floor(this.jar.yTop) : this.frame.y1;
    for (let y = 0; y < lim; y++) for (let x = 0; x < this.W; x++) if (this.col[y * this.W + x] && this.mask[y * this.W + x] === 1) f++;
    this.filled = f;
    return f;
  }
}
