import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { PICTURES, type Picture } from './pictures';

export const spoolToy: Toy = {
  id: 'spool',
  title: 'Spool Sort',
  blurb: 'Tap a spool and it reels its colour out of a knitted picture, unravelling it stitch by stitch.',
  tech: 'Mass-spring knit + verlet yarn · Canvas 2D',
  swatch: 'linear-gradient(135deg,#e8364f,#fff4e6 45%,#5cc05a)',
  refs: [
    {
      short: 'Knit Out',
      title: 'Knit Out and the 2025 yarn-sort wave (Yarn Loop, Wool Crush)',
      url: 'https://www.pocketgamer.biz/',
      use: 'Design inspiration: sort colours out of a knitted picture onto spools.',
    },
    {
      short: 'Yuksel 2012',
      title: 'Yuksel et al. — Stitch Meshes for Modeling Knitted Clothing (SIGGRAPH 2012)',
      url: 'https://www.cemyuksel.com/research/stitchmeshes/',
      use: 'A picture as a grid of stitches whose connections decide what holds and what falls away.',
    },
    {
      short: 'Jakobsen 2001',
      title: 'Jakobsen — Advanced Character Physics (GDC 2001)',
      url: 'https://www.cs.cmu.edu/afs/cs/academic/class/15462-s13/www/lec_slides/Jakobsen.pdf',
      use: 'Verlet particles with distance constraints for both the hanging knit and the yarn strands.',
    },
    {
      short: 'Kaldor 2008',
      title: 'Kaldor, Marschner, James — Simulating Knitted Cloth at the Yarn Level (SIGGRAPH 2008)',
      url: 'https://www.cs.cornell.edu/~srm/publications/SG08-knit-lr.pdf',
      use: 'Feel reference: pulling a yarn tugs the neighbouring stitches before they let go.',
    },
  ],
  async create(ctx) {
    return new SpoolSort(ctx);
  },
};

const SLOTS = 4;
const ROPE_N = 16;
const ITER = 14;
/** Per-frame pull of each stitch back toward its place in the chart: the knit is loosely pinned to a board. */
const HOLD = 0.06;

interface Spool {
  color: string;
  capacity: number;
  /** Stitches wound on so far, and stitches claimed but still on their way. */
  count: number;
  queue: number[];
  /** Stitch the yarn is currently pulling out, or -1. */
  head: number;
  pull: number;
  spin: number;
  spinV: number;
  /** 0..1 slide-in, then 1; after full, pop-out timer counts up. */
  enter: number;
  popT: number;
  nope: number;
  rope: Rope | null;
  gone: boolean;
}

interface Rope {
  x: Float32Array;
  y: Float32Array;
  px: Float32Array;
  py: Float32Array;
  /** Fraction of the rope still out (drops to 0 as the loose end is reeled in). */
  out: number;
  loose: boolean;
  hx: number;
  hy: number;
}

class SpoolSort implements ToyInstance {
  private g: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private u = 1; // one CSS pixel in device pixels
  // Knit: one verlet node per stitch.
  private W = 16;
  private H = 16;
  private pitch = 20;
  private originX = 0;
  private originY = 0;
  private x = new Float32Array(0);
  private y = new Float32Array(0);
  private px = new Float32Array(0);
  private py = new Float32Array(0);
  private color: string[] = [];
  /** 0 gone, 1 knitted in, 2 falling away (cut loose). */
  private state = new Uint8Array(0);
  private claimed = new Uint8Array(0);
  private springs: Int32Array = new Int32Array(0);
  private rest: Float32Array = new Float32Array(0);
  private total = 0;
  private cleared = 0;
  private picIndex = 0;
  private pic!: Picture;
  private spools: (Spool | null)[] = [];
  private refill: number[] = [];
  private grab: { id: number; node: number } | null = null;
  private done = 0;
  private dropIn = 0;
  private time = 0;
  private yarnLoop;
  private lastTick = 0;

  constructor(private ctx: ToyContext) {
    const g = ctx.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('Canvas 2D is not available.');
    this.g = g;
    this.yarnLoop = ctx.sound.loop('trickle');
    ctx.panel.action('Next picture', () => this.load(this.picIndex + 1));
    ctx.panel.action('Start over', () => this.load(this.picIndex));
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.load(0);
    if (import.meta.env.DEV)
      (window as unknown as Record<string, unknown>).__spool = () => ({
        left: this.total - this.cleared,
        spools: this.spools.map((s) => s && `${s.color}:${s.count}/${s.capacity}`),
      });
  }

  // ---------------------------------------------------------------- setup

  private load(index: number) {
    this.picIndex = ((index % PICTURES.length) + PICTURES.length) % PICTURES.length;
    this.pic = PICTURES[this.picIndex];
    const rows = this.pic.rows;
    this.H = rows.length;
    this.W = Math.max(...rows.map((r) => r.length));
    const n = this.W * this.H;
    this.x = new Float32Array(n);
    this.y = new Float32Array(n);
    this.px = new Float32Array(n);
    this.py = new Float32Array(n);
    this.state = new Uint8Array(n).fill(1);
    this.claimed = new Uint8Array(n);
    this.color = [];
    for (let j = 0; j < this.H; j++)
      for (let i = 0; i < this.W; i++) {
        const ch = rows[j][i] ?? rows[j][0];
        this.color.push(this.pic.palette[ch] ?? '#ccc');
      }
    // Structural links hold the grid; shear links keep it from folding like a curtain.
    const sp: number[] = [];
    const rl: number[] = [];
    const link = (a: number, b: number, l: number) => {
      sp.push(a, b);
      rl.push(l);
    };
    for (let j = 0; j < this.H; j++)
      for (let i = 0; i < this.W; i++) {
        const k = j * this.W + i;
        if (i + 1 < this.W) link(k, k + 1, 1);
        if (j + 1 < this.H) link(k, k + this.W, 1);
        if (i + 1 < this.W && j + 1 < this.H) link(k, k + this.W + 1, Math.SQRT2);
        if (i > 0 && j + 1 < this.H) link(k, k + this.W - 1, Math.SQRT2);
      }
    this.springs = Int32Array.from(sp);
    this.rest = Float32Array.from(rl);
    this.total = n;
    this.cleared = 0;
    this.done = 0;
    this.grab = null;
    for (const s of this.spools) s?.rope && (s.rope = null);
    this.spools = [];
    this.refill = [];
    this.layout();
    // The new picture drops in from above on its needle.
    this.dropIn = 1;
    for (let k = 0; k < n; k++) {
      const [hx, hy] = this.home(k);
      this.x[k] = this.px[k] = hx;
      this.y[k] = this.py[k] = hy;
    }
    for (let s = 0; s < SLOTS; s++) this.spools.push(this.newSpool(s * 0.12));
    this.ctx.progress(0, 'unravelled');
  }

  private layout() {
    const { width, height } = this;
    this.u = this.ctx.pixelRatio;
    // Clear of the HUD and progress pill at the top, and of the spool shelf at the bottom.
    const top = 138 * this.u;
    const [, shelfY] = this.spoolRect(0);
    const room = shelfY - top - 30 * this.u;
    this.pitch = Math.min((width * 0.84) / this.W, room / (this.H + 0.5));
    this.originX = (width - this.pitch * (this.W - 1)) / 2;
    // Hang it a little above the middle of the free space: the knit sags a bit under gravity.
    this.originY = top + Math.max(0, (room - this.pitch * this.H) * 0.18) + this.pitch * 0.5;
  }

  private home(k: number): [number, number] {
    const i = k % this.W, j = Math.floor(k / this.W);
    return [this.originX + i * this.pitch, this.originY + j * this.pitch];
  }

  /** Needle bar height; bounces a little as the picture lands. */
  private needleY() {
    return this.originY - this.pitch * 0.55 - this.dropIn * this.dropIn * this.height * 0.6;
  }

  // ---------------------------------------------------------------- spools

  private newSpool(delay = 0): Spool | null {
    const color = this.pickColor();
    if (!color) return null;
    return {
      color,
      capacity: 18 + Math.floor(Math.random() * 3) * 3,
      count: 0,
      queue: [],
      head: -1,
      pull: 0,
      spin: 0,
      spinV: 0,
      enter: -delay * 4,
      popT: -1,
      nope: 0,
      rope: null,
      gone: false,
    };
  }

  /** The colour most in need of a spool: stitches left minus room already on the rack. */
  private pickColor(): string | null {
    const left = new Map<string, number>();
    for (let k = 0; k < this.total; k++) if (this.state[k] === 1 && !this.claimed[k]) left.set(this.color[k], (left.get(this.color[k]) ?? 0) + 1);
    for (const s of this.spools) if (s && s.popT < 0) left.set(s.color, (left.get(s.color) ?? 0) - (s.capacity - s.count));
    let best: string | null = null;
    let bestN = 0;
    for (const [c, n] of left) if (n > bestN) [best, bestN] = [c, n];
    return best;
  }

  private spoolRect(slot: number): [number, number, number, number] {
    const w = Math.min(this.width / (SLOTS + 1.4), 92 * this.u);
    const h = w * 1.25;
    const gap = (this.width - w * SLOTS) / (SLOTS + 1);
    const x = gap + slot * (w + gap);
    const y = this.height - h - Math.max(26 * this.u, this.height * 0.05);
    return [x, y, w, h];
  }

  /** Where the yarn meets the spool core. */
  private spoolMouth(slot: number): [number, number] {
    const [x, y, w, h] = this.spoolRect(slot);
    return [x + w / 2, y + h * 0.3];
  }

  /** Like real knitting, a stitch can only come out once the one below it has: the picture unravels from the bottom up. */
  private exposed(k: number) {
    const j = Math.floor(k / this.W);
    return j === this.H - 1 || this.state[k + this.W] !== 1;
  }

  /** Tap: reel in every exposed stitch of this spool's colour, following it inward through the knit. */
  private reel(slot: number) {
    const s = this.spools[slot];
    if (!s || s.popT >= 0 || s.enter < 1) return;
    const room = s.capacity - s.count - s.queue.length;
    if (room <= 0) return;
    const seen = new Uint8Array(this.total);
    const frontier: number[] = [];
    for (let k = 0; k < this.total; k++)
      if (this.state[k] === 1 && !this.claimed[k] && this.color[k] === s.color && this.exposed(k)) {
        frontier.push(k);
        seen[k] = 1;
      }
    if (!frontier.length) {
      s.nope = 1;
      this.ctx.haptic('light');
      this.ctx.sound.play('knock', { pitch: 0.7, gain: 0.5, pan: this.pan(slot) });
      return;
    }
    // Start nearest the spool, then walk the colour patch breadth-first so the yarn runs continuously.
    const [mx] = this.spoolMouth(slot);
    frontier.sort((a, b) => Math.abs(this.x[a] - mx) - Math.abs(this.x[b] - mx) + (this.y[b] - this.y[a]) * 0.5);
    const order: number[] = [];
    for (let q = 0; q < frontier.length && order.length < room; q++) {
      const k = frontier[q];
      order.push(k);
      const i = k % this.W, j = Math.floor(k / this.W);
      for (const [di, dj] of [[0, -1], [-1, 0], [1, 0], [0, 1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || ii >= this.W || jj < 0 || jj >= this.H) continue;
        const kk = jj * this.W + ii;
        if (seen[kk] || this.state[kk] !== 1 || this.claimed[kk] || this.color[kk] !== s.color) continue;
        // Only follow into stitches that will be free by the time the yarn reaches them.
        const below = kk + this.W;
        if (jj < this.H - 1 && this.state[below] === 1 && !seen[below]) continue;
        seen[kk] = 1;
        frontier.push(kk);
      }
    }
    for (const k of order) this.claimed[k] = 1;
    s.queue.push(...order);
    this.ctx.haptic('light');
    this.ctx.sound.play('whoosh', { pitch: 1.6, gain: 0.3, pan: this.pan(slot) });
  }

  private pan(slot: number) {
    return ((slot + 0.5) / SLOTS - 0.5) * 1.2;
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.input();
    this.dropIn = Math.max(0, this.dropIn - dt * 2.2);
    this.stepSpools(dt);
    this.stepKnit(dt);
    this.stepRopes(dt);
    this.draw();
    const frac = this.cleared / this.total;
    this.ctx.progress(frac, 'unravelled');
    if (frac >= 1 && !this.done) {
      this.done = t;
      this.ctx.celebrate(`${this.pic.name} unravelled!`);
    }
    if (this.done && t - this.done > 2.2) this.load(this.picIndex + 1);
    this.ctx.setStatus(`${this.total - this.cleared} stitches left`);
  }

  private input() {
    const { width, height } = this;
    for (const p of this.ctx.pointers.active.values()) {
      const x = p.x * width, y = (1 - p.y) * height;
      if (p.justDown) {
        const slot = this.spools.findIndex((_, s) => {
          const [rx, ry, rw, rh] = this.spoolRect(s);
          return x > rx - 8 * this.u && x < rx + rw + 8 * this.u && y > ry - 14 * this.u && y < ry + rh + 8 * this.u;
        });
        if (slot >= 0) {
          this.reel(slot);
          continue;
        }
        // Otherwise grab the knit and give it a shake.
        let best = -1;
        let bd = (this.pitch * 1.6) ** 2;
        for (let k = 0; k < this.total; k++) {
          if (this.state[k] !== 1) continue;
          const d = (this.x[k] - x) ** 2 + (this.y[k] - y) ** 2;
          if (d < bd) [best, bd] = [k, d];
        }
        if (best >= 0) {
          this.grab = { id: p.id, node: best };
          this.ctx.sound.play('squish', { pitch: 1.8, gain: 0.25 });
        }
      }
      if (this.grab && this.grab.id === p.id && this.state[this.grab.node] === 1) {
        const k = this.grab.node;
        this.x[k] += (x - this.x[k]) * 0.35;
        this.y[k] += (y - this.y[k]) * 0.35;
      }
    }
    if (this.grab && !this.ctx.pointers.active.has(this.grab.id)) this.grab = null;
  }

  private stepSpools(dt: number) {
    let pulling = 0;
    for (let slot = 0; slot < SLOTS; slot++) {
      const s = this.spools[slot];
      if (!s) {
        // Empty slot: wait for a colour that still needs a home.
        if (Math.random() < dt * 2) this.spools[slot] = this.newSpool();
        continue;
      }
      s.enter = Math.min(1, s.enter + dt * 4);
      s.nope = Math.max(0, s.nope - dt * 3);
      s.spin += s.spinV * dt;
      s.spinV *= Math.exp(-dt * 4);
      if (s.popT >= 0) {
        s.popT += dt;
        if (s.popT > 0.45) {
          this.spools[slot] = null;
          const next = this.newSpool();
          if (next) next.enter = -0.3;
          this.spools[slot] = next;
        }
        continue;
      }
      // Pull the next stitch out: the yarn tugs it toward the spool, then it lets go.
      if (s.head < 0 && s.queue.length) {
        s.head = s.queue.shift()!;
        s.pull = 0;
        if (!s.rope) s.rope = this.makeRope(slot, s.head);
        s.rope.loose = false;
      }
      if (s.head >= 0) {
        const k = s.head;
        pulling++;
        // Speeds up the longer the run: slow first tug, then a satisfying zip.
        const rate = 9 + Math.min(26, s.count * 1.6);
        s.pull += dt * rate;
        const [mx, my] = this.spoolMouth(slot);
        const dx = mx - this.x[k], dy = my - this.y[k];
        const d = Math.hypot(dx, dy) || 1;
        const tug = this.pitch * 0.9 * dt * rate;
        this.x[k] += (dx / d) * tug;
        this.y[k] += (dy / d) * tug;
        if (s.pull >= 1) {
          this.unknit(k, dx / d, dy / d);
          s.count++;
          s.spinV += 14;
          s.head = -1;
          const now = this.time;
          if (now - this.lastTick > 0.03) {
            this.lastTick = now;
            this.ctx.sound.play('tick', { pitch: 0.8 + Math.min(1.2, s.count * 0.05), gain: 0.5, pan: this.pan(slot) });
          }
          if (s.count >= s.capacity) this.finishSpool(slot);
          else if (!s.queue.length && s.rope) s.rope.loose = true;
        }
      }
    }
    this.yarnLoop.set(Math.min(1, pulling * 0.45), 0.6);
    // Spools whose colour is all gone leave the rack.
    for (let slot = 0; slot < SLOTS; slot++) {
      const s = this.spools[slot];
      if (!s || s.popT >= 0 || s.queue.length || s.head >= 0 || s.enter < 1) continue;
      if (!this.color.some((c, k) => c === s.color && this.state[k] === 1 && !this.claimed[k])) {
        if (s.count > 0) this.finishSpool(slot);
        else s.popT = 0.2;
      }
    }
  }

  private finishSpool(slot: number) {
    const s = this.spools[slot]!;
    s.popT = 0;
    if (s.rope) s.rope.loose = true;
    for (const k of s.queue) this.claimed[k] = 0;
    s.queue = [];
    this.ctx.haptic('medium');
    this.ctx.sound.play('pop', { pitch: 1.2, pan: this.pan(slot) });
    this.ctx.sound.play('chime', { pitch: 1 + slot * 0.12, gain: 0.35 });
  }

  /** A stitch lets go: its neighbours get yanked along the yarn, and anything cut loose falls. */
  private unknit(k: number, nx: number, ny: number) {
    this.state[k] = 0;
    this.claimed[k] = 0;
    this.cleared++;
    const i = k % this.W, j = Math.floor(k / this.W);
    for (let dj = -1; dj <= 1; dj++)
      for (let di = -1; di <= 1; di++) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || ii >= this.W || jj < 0 || jj >= this.H) continue;
        const kk = jj * this.W + ii;
        if (this.state[kk] !== 1) continue;
        this.px[kk] -= nx * this.pitch * 0.12;
        this.py[kk] -= ny * this.pitch * 0.12;
      }
    this.dropLoose();
  }

  /** Flood from the needle; stitches that no longer connect to it fall off in chunks. */
  private dropLoose() {
    const reach = new Uint8Array(this.total);
    const stack: number[] = [];
    for (let i = 0; i < this.W; i++) if (this.state[i] === 1) {
      reach[i] = 1;
      stack.push(i);
    }
    while (stack.length) {
      const k = stack.pop()!;
      const i = k % this.W, j = Math.floor(k / this.W);
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const ii = i + di, jj = j + dj;
        if (ii < 0 || ii >= this.W || jj < 0 || jj >= this.H) continue;
        const kk = jj * this.W + ii;
        if (reach[kk] || this.state[kk] !== 1) continue;
        reach[kk] = 1;
        stack.push(kk);
      }
    }
    let fell = 0;
    for (let k = 0; k < this.total; k++)
      if (this.state[k] === 1 && !reach[k] && !this.claimed[k]) {
        this.state[k] = 2;
        fell++;
      }
    if (fell) {
      this.ctx.haptic(fell > 12 ? 'heavy' : 'medium');
      this.ctx.sound.play('whoosh', { pitch: 0.8, gain: Math.min(1, 0.3 + fell / 30) });
    }
  }

  private stepKnit(dt: number) {
    const { x, y, px, py, state } = this;
    if (this.dropIn > 0) {
      // Carried down whole on its needle, so the knit can't tangle before it lands.
      const off = this.needleY() - (this.originY - this.pitch * 0.55);
      for (let k = 0; k < this.total; k++) {
        const [hx, hy] = this.home(k);
        x[k] = px[k] = hx;
        y[k] = hy + off;
        py[k] = y[k] - off * 0.04;
      }
      return;
    }
    const g = this.pitch * 30;
    const damp = Math.exp(-dt * 2.2);
    const needle = this.needleY();
    for (let k = 0; k < this.total; k++) {
      if (!state[k]) continue;
      const vx = (x[k] - px[k]) * damp, vy = (y[k] - py[k]) * damp;
      px[k] = x[k];
      py[k] = y[k];
      x[k] += vx;
      y[k] += vy + g * dt * dt;
    }
    const { springs, rest } = this;
    const L = this.pitch;
    for (let k = 0; k < this.total; k++) {
      if (state[k] !== 1) continue;
      const [hx, hy] = this.home(k);
      x[k] += (hx - x[k]) * HOLD;
      y[k] += (hy - y[k]) * HOLD;
    }
    for (let it = 0; it < ITER; it++) {
      for (let s = 0; s < rest.length; s++) {
        const a = springs[s * 2], b = springs[s * 2 + 1];
        // Links only hold between two stitches that are both still knitted in (or both falling).
        if (!state[a] || state[a] !== state[b]) continue;
        const dx = x[b] - x[a], dy = y[b] - y[a];
        const d = Math.hypot(dx, dy) || 1e-6;
        const diff = ((d - rest[s] * L) / d) * 0.5;
        x[a] += dx * diff;
        y[a] += dy * diff;
        x[b] -= dx * diff;
        y[b] -= dy * diff;
      }
      // Top row rides the needle.
      for (let i = 0; i < this.W; i++) {
        if (state[i] !== 1) continue;
        x[i] = this.originX + i * L;
        y[i] = needle + L * 0.55;
      }
    }
    // Loose chunks fall off the bottom of the screen and count as unravelled.
    for (let k = 0; k < this.total; k++)
      if (state[k] === 2 && y[k] > this.height + L * 2) {
        state[k] = 0;
        this.cleared++;
      }
  }

  // ---------------------------------------------------------------- yarn

  private makeRope(slot: number, k: number): Rope {
    const [mx, my] = this.spoolMouth(slot);
    const r: Rope = { x: new Float32Array(ROPE_N), y: new Float32Array(ROPE_N), px: new Float32Array(ROPE_N), py: new Float32Array(ROPE_N), out: 1, loose: false, hx: this.x[k], hy: this.y[k] };
    for (let n = 0; n < ROPE_N; n++) {
      const t = n / (ROPE_N - 1);
      r.x[n] = r.px[n] = this.x[k] + (mx - this.x[k]) * t;
      r.y[n] = r.py[n] = this.y[k] + (my - this.y[k]) * t;
    }
    return r;
  }

  private stepRopes(dt: number) {
    const g = this.pitch * 40;
    for (let slot = 0; slot < SLOTS; slot++) {
      const s = this.spools[slot];
      const r = s?.rope;
      if (!s || !r) continue;
      const [mx, my] = this.spoolMouth(slot);
      // The end follows the stitch being pulled; once loose it whips in toward the spool.
      if (!r.loose && s.head >= 0) {
        r.hx = this.x[s.head];
        r.hy = this.y[s.head];
      }
      if (r.loose) {
        r.out -= dt * 3.2;
        if (r.out <= 0) {
          s.rope = null;
          continue;
        }
      }
      const span = Math.hypot(r.hx - mx, r.hy - my);
      const seg = (span * (r.loose ? r.out : 1.06)) / (ROPE_N - 1);
      for (let n = 0; n < ROPE_N; n++) {
        const vx = (r.x[n] - r.px[n]) * 0.96, vy = (r.y[n] - r.py[n]) * 0.96;
        r.px[n] = r.x[n];
        r.py[n] = r.y[n];
        r.x[n] += vx;
        r.y[n] += vy + g * dt * dt;
      }
      for (let it = 0; it < 8; it++) {
        if (!r.loose) {
          r.x[0] = r.hx;
          r.y[0] = r.hy;
        }
        r.x[ROPE_N - 1] = mx;
        r.y[ROPE_N - 1] = my;
        for (let n = 0; n + 1 < ROPE_N; n++) {
          const dx = r.x[n + 1] - r.x[n], dy = r.y[n + 1] - r.y[n];
          const d = Math.hypot(dx, dy) || 1e-6;
          const diff = (d - seg) / d / 2;
          r.x[n] += dx * diff;
          r.y[n] += dy * diff;
          r.x[n + 1] -= dx * diff;
          r.y[n + 1] -= dy * diff;
        }
      }
    }
  }

  // ---------------------------------------------------------------- draw

  private draw() {
    const { g, width, height, u } = this;
    const bg = g.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#fbe9dc');
    bg.addColorStop(1, '#f1cdb8');
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
    // Shelf the spools sit on.
    const [, sy, , sh] = this.spoolRect(0);
    g.fillStyle = '#d9a37f';
    g.fillRect(0, sy + sh - 4 * u, width, height);
    g.fillStyle = 'rgba(120,60,30,0.18)';
    g.fillRect(0, sy + sh - 4 * u, width, 5 * u);

    this.drawNeedle();
    this.drawStitches();
    for (let slot = 0; slot < SLOTS; slot++) this.drawSpool(slot);
    for (let slot = 0; slot < SLOTS; slot++) this.drawRope(slot);
  }

  private drawNeedle() {
    const { g, u } = this;
    const y = this.needleY();
    const x0 = this.originX - this.pitch * 1.2, x1 = this.originX + this.pitch * (this.W - 1) + this.pitch * 1.6;
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(90,50,30,0.25)';
    g.lineWidth = 9 * u;
    g.beginPath();
    g.moveTo(x0, y + 3 * u);
    g.lineTo(x1, y + 3 * u);
    g.stroke();
    g.strokeStyle = '#c98b5a';
    g.lineWidth = 8 * u;
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(x1, y);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.lineWidth = 2 * u;
    g.beginPath();
    g.moveTo(x0, y - 2 * u);
    g.lineTo(x1, y - 2 * u);
    g.stroke();
    g.fillStyle = '#8f5a3a';
    g.beginPath();
    g.arc(x1, y, 7 * u, 0, Math.PI * 2);
    g.fill();
  }

  /** Every stitch is a knit "V": two slanted loops. Batched into one path per colour and pass. */
  private drawStitches() {
    const { g, x, y, state, pitch: p } = this;
    const byColor = new Map<string, number[]>();
    for (let k = 0; k < this.total; k++) {
      if (!state[k]) continue;
      const c = this.color[k];
      let list = byColor.get(c);
      if (!list) byColor.set(c, (list = []));
      list.push(k);
    }
    const lobes = (ks: number[], scale: number, ox: number, oy: number) => {
      g.beginPath();
      for (const k of ks) {
        // Orientation from the neighbour to the right (or left), so stitches follow the sag.
        const i = k % this.W;
        let ax = p, ay = 0;
        const r = i + 1 < this.W && state[k + 1] ? k + 1 : i > 0 && state[k - 1] ? k - 1 : -1;
        if (r >= 0) {
          ax = (x[r] - x[k]) * (r > k ? 1 : -1);
          ay = (y[r] - y[k]) * (r > k ? 1 : -1);
        }
        const rot = Math.atan2(ay, ax);
        const c = Math.cos(rot), s = Math.sin(rot);
        for (const side of [-1, 1]) {
          const cx = x[k] + c * side * p * 0.22 + ox, cy = y[k] + s * side * p * 0.22 + oy;
          const a = rot + Math.PI / 2 - side * 0.5;
          const rx = p * 0.52 * scale, ry = p * 0.27 * scale;
          g.moveTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * rx);
          g.ellipse(cx, cy, rx, ry, a, 0, Math.PI * 2);
        }
      }
    };
    const all: number[] = [];
    for (const ks of byColor.values()) all.push(...ks);
    g.fillStyle = 'rgba(70,30,30,0.28)';
    lobes(all, 1.02, 0, p * 0.1);
    g.fill();
    for (const [c, ks] of byColor) {
      g.fillStyle = c;
      lobes(ks, 1, 0, 0);
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.28)';
    lobes(all, 0.55, -p * 0.05, -p * 0.1);
    g.fill();
  }

  private drawSpool(slot: number) {
    const s = this.spools[slot];
    if (!s) return;
    const { g, u } = this;
    let [x, y, w, h] = this.spoolRect(slot);
    const e = Math.max(0, s.enter);
    const ease = 1 - (1 - e) ** 3;
    y += (1 - ease) * h * 1.6;
    x += Math.sin(s.nope * 30) * s.nope * 6 * u;
    let scale = 1;
    let alpha = 1;
    if (s.popT >= 0) {
      const t = s.popT / 0.45;
      scale = 1 + Math.sin(Math.min(1, t * 2) * Math.PI) * 0.18;
      y -= t * t * h * 1.4;
      alpha = 1 - t * t;
    }
    if (s.enter < 0) return;
    g.save();
    g.globalAlpha = alpha;
    g.translate(x + w / 2, y + h / 2);
    g.scale(scale, scale);
    const fw = w, fh = h * 0.13;
    const core = w * 0.42;
    // Wound yarn: fattens as it fills, with wrap lines scrolling as the spool turns.
    const fill = Math.min(1, (s.count + (s.head >= 0 ? s.pull : 0)) / s.capacity);
    const yw = core + (fw * 0.9 - core) * Math.sqrt(fill);
    g.fillStyle = '#e9c9a0';
    g.fillRect(-core / 2, -h / 2 + fh, core, h - 2 * fh);
    // A first few wraps of colour on the bare core, so an empty spool still says what it wants.
    g.globalAlpha = alpha * 0.5;
    g.fillStyle = s.color;
    g.fillRect(-core / 2, -h / 2 + fh, core, h - 2 * fh);
    g.globalAlpha = alpha;
    if (fill > 0) {
      g.fillStyle = s.color;
      rounded(g, -yw / 2, -h / 2 + fh, yw, h - 2 * fh, yw * 0.12);
      g.fill();
      g.save();
      g.clip();
      g.strokeStyle = 'rgba(0,0,0,0.16)';
      g.lineWidth = 1.5 * u;
      const step = 5 * u;
      const off = (s.spin * 3 * u) % step;
      for (let yy = -h / 2 + fh - step + off; yy < h / 2 - fh; yy += step) {
        g.beginPath();
        g.moveTo(-yw / 2, yy);
        g.lineTo(yw / 2, yy + step * 0.6);
        g.stroke();
      }
      const shine = g.createLinearGradient(-yw / 2, 0, yw / 2, 0);
      shine.addColorStop(0, 'rgba(0,0,0,0.22)');
      shine.addColorStop(0.35, 'rgba(255,255,255,0.22)');
      shine.addColorStop(1, 'rgba(0,0,0,0.25)');
      g.fillStyle = shine;
      g.fillRect(-yw / 2, -h / 2, yw, h);
      g.restore();
    }
    // Wooden flanges top and bottom, tinted with the spool's colour so it reads before it's wound.
    for (const fy of [-h / 2, h / 2 - fh]) {
      g.fillStyle = '#b87a4b';
      rounded(g, -fw / 2, fy, fw, fh, fh * 0.45);
      g.fill();
      g.fillStyle = s.color;
      g.globalAlpha = alpha * 0.55;
      rounded(g, -fw / 2 + 3 * u, fy + fh * 0.3, fw - 6 * u, fh * 0.4, fh * 0.2);
      g.fill();
      g.globalAlpha = alpha;
    }
    // Capacity pips under the spool.
    const left = s.capacity - s.count;
    g.fillStyle = 'rgba(80,40,30,0.55)';
    g.font = `700 ${12 * u}px ui-rounded, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.fillText(left > 0 ? String(left) : '✓', 0, h / 2 + 16 * u);
    g.restore();
  }

  private drawRope(slot: number) {
    const s = this.spools[slot];
    const r = s?.rope;
    if (!s || !r) return;
    const { g, u } = this;
    const n0 = r.loose ? Math.floor((1 - r.out) * (ROPE_N - 1)) : 0;
    g.lineCap = 'round';
    g.lineJoin = 'round';
    const path = () => {
      g.beginPath();
      g.moveTo(r.x[n0], r.y[n0]);
      for (let n = n0 + 1; n < ROPE_N; n++) g.lineTo(r.x[n], r.y[n]);
    };
    g.strokeStyle = s.color;
    g.lineWidth = Math.max(3 * u, this.pitch * 0.22);
    path();
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.lineWidth = Math.max(1 * u, this.pitch * 0.07);
    path();
    g.stroke();
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.layout();
    for (let k = 0; k < this.total; k++) {
      const [hx, hy] = this.home(k);
      this.x[k] = this.px[k] = hx;
      this.y[k] = this.py[k] = hy;
    }
    for (const s of this.spools) if (s) s.rope = null;
  }

  destroy() {
    this.yarnLoop.stop();
    this.ctx.progress(null);
  }
}

function rounded(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}
