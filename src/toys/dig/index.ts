import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { BEDROCK, BODY, CLAY, GRASS, GRAVEL, LOOSE, PACKED, ROCK, SAND, SOIL, WATER } from './sim';
import { Kind, type PBody } from './rigid';
import { type Find, FindState, Yard } from './yard';

export const digToy: Toy = {
  id: 'dig',
  title: 'Dig Down',
  blurb: 'Scoop down through a backyard. Undercut the ground and it breaks off in slabs that tumble, smash and settle; boulders roll, and buried finds drop out for your shelf.',
  tech: 'Falling-sand CA + pixel rigid bodies (marching squares, soft-step solver) · Canvas 2D',
  swatch: 'linear-gradient(180deg,#8fd3ff 0 22%,#5cc05a 22% 26%,#7a4a2a 26% 60%,#c7783f 60% 80%,#6b6f78 80%)',
  refs: [
    {
      short: 'Digging a Hole',
      title: 'A Game About Digging a Hole (Rookie Rhino, 2025)',
      url: 'https://store.steampowered.com/app/3244220/A_Game_About_Digging_A_Hole/',
      use: 'Design inspiration: the simple joy of digging deeper and finding things on the way down.',
    },
    {
      short: 'Noita',
      title: 'Exploring the Tech and Design of Noita (Petri Purho, GDC 2019)',
      url: 'https://www.youtube.com/watch?v=prXuyMCgbTc',
      use: 'Static pixel ground plus falling-sand cells; a piece that comes free gets its outline traced and becomes a rigid body, which breaks back into particles.',
    },
    {
      short: 'Solver2D',
      title: 'Erin Catto — Solver2D (2024)',
      url: 'https://box2d.org/posts/2024/02/solver2d/',
      use: 'The Box2D v3 "soft step" solver (soft contacts, substeps, relax pass, warm starting), adapted from Demolition Tower.',
    },
    {
      short: 'Guendelman 2003',
      title: 'Guendelman, Bridson, Fedkiw — Nonconvex Rigid Bodies with Stacking (SIGGRAPH 2003)',
      url: 'https://doi.org/10.1145/882262.882358',
      use: 'Contacts as boundary points tested against the other shape’s signed distance, so concave slabs need no convex decomposition.',
    },
    {
      short: 'Marching cubes',
      title: 'Lorensen & Cline — Marching Cubes (SIGGRAPH 1987)',
      url: 'https://doi.org/10.1145/37401.37422',
      use: 'Its 2-D case, marching squares, traces each cut-free island’s outline from its cells.',
    },
    {
      short: 'Douglas–Peucker',
      title: 'Douglas & Peucker — Reduction of the Number of Points Required to Represent a Digitized Line (1973)',
      url: 'https://doi.org/10.3138/FM57-6770-U75U-7727',
      use: 'Simplifies the traced outline before it is resampled into collision points.',
    },
  ],
  async create(ctx) {
    return new DigDown(ctx);
  },
};

const COLS = 150;
/** World depth in screens. */
const DEPTH_SCREENS = 3.4;
const DIG_R = 5;
/** Seconds a find lies settled in the open before it flies to the shelf by itself. */
const COLLECT_AFTER = 0.8;

const FINDS: [string, string, number][] = [
  ['🪱', 'Earthworm', 0.03],
  ['🔑', 'Rusty key', 0.09],
  ['🧸', 'Lost teddy', 0.15],
  ['🪙', 'Old coin', 0.22],
  ['🐚', 'Seashell', 0.3],
  ['🏺', 'Clay pot', 0.38],
  ['🦴', 'Bone', 0.47],
  ['💍', 'Gold ring', 0.55],
  ['🦖', 'Dino fossil', 0.63],
  ['💎', 'Crystal', 0.72],
  ['🥚', 'Dino egg', 0.82],
  ['👑', 'Buried crown', 0.93],
];

/** Base colour per material, 0..255. */
const COLOR: [number, number, number][] = [
  [0, 0, 0],
  [92, 176, 74], // grass
  [122, 78, 44], // topsoil
  [196, 118, 64], // clay
  [226, 190, 112], // sand
  [138, 136, 132], // gravel
  [104, 108, 118], // rock
  [52, 50, 58], // bedrock
  [70, 142, 222], // water
  [200, 180, 120], // find (drawn as its emoji)
];

class DigDown implements ToyInstance {
  private g: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private cs = 1; // cell size in device pixels
  private rows = 1; // visible rows
  private yard!: Yard;
  private cam = 0;
  private camT = 0;
  private finds: Find[] = [];
  private layer: HTMLCanvasElement;
  private lg: CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private chips: { x: number; y: number; vx: number; vy: number; life: number; c: string }[] = [];
  private last = new Map<number, [number, number]>();
  /** Pointers that went down on a find: they collect, they don't dig. */
  private taps = new Set<number>();
  private deepest = 0;
  private lastHaptic = 0;
  private lastDigSound = 0;
  private lastThud = 0;
  private rumble = 0;
  private time = 0;
  private simMs = 0;
  private shelf: HTMLElement;
  private toast: HTMLElement;
  private style: HTMLStyleElement;
  private trickle;
  private water;
  private done = false;

  constructor(private ctx: ToyContext) {
    const g = ctx.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('Canvas 2D is not available.');
    this.g = g;
    this.layer = document.createElement('canvas');
    this.lg = this.layer.getContext('2d')!;
    this.trickle = ctx.sound.loop('trickle');
    this.water = ctx.sound.loop('bubble');
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.shelf = document.createElement('div');
    this.shelf.className = 'dig-shelf';
    this.toast = document.createElement('div');
    this.toast.className = 'dig-toast';
    ctx.overlay.append(this.shelf, this.toast);
    ctx.panel.action('New backyard', () => this.reset());
    ctx.panel.action('Back to the surface', () => (this.camT = 0));
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.reset();
    if (import.meta.env.DEV) this.devHook();
  }

  private reset(seed?: number) {
    this.cs = this.width / COLS;
    this.rows = Math.ceil(this.height / this.cs) + 1;
    const ground = Math.round(this.rows * 0.3);
    const H = Math.round(this.rows * DEPTH_SCREENS);
    this.finds = [];
    this.yard = new Yard(COLS, H, ground, this.finds, seed);
    const { cells, W } = this.yard.sim;
    this.cam = this.camT = 0;
    this.deepest = ground;
    this.done = false;
    this.chips = [];
    const depth = H - 14 - ground;
    for (const [emoji, name, f] of FINDS) {
      const size = emoji === '👑' ? 16 : 11 + Math.random() * 3;
      const r = size * 0.4;
      // Bury it in plain ground, not in a pond or a boulder.
      let x = 0, y = 0;
      for (let tries = 0; tries < 20; tries++) {
        x = 14 + Math.random() * (COLS - 28);
        y = ground + 6 + depth * f + (tries ? (Math.random() - 0.5) * 12 : 0);
        let ok = true;
        for (let a = 0; a < 8 && ok; a++) {
          const k = Math.floor(y + Math.sin(a) * r) * W + Math.floor(x + Math.cos(a) * r);
          if (!PACKED[cells[k]] || cells[k] === ROCK) ok = false;
        }
        if (ok) break;
      }
      this.finds.push({ emoji, name, x, y, r, size, state: FindState.Buried, body: null, exposure: 0, open: 0, fly: -1, a: 0 });
    }
    this.layer.width = COLS;
    this.layer.height = this.rows;
    this.img = this.lg.createImageData(COLS, this.rows);
    this.shelf.innerHTML = this.finds.map((f) => `<i title="${f.name}"><span>${f.emoji}</span></i>`).join('');
    this.ctx.progress(0, 'deep');
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    const t0 = performance.now();
    this.input(dt);
    const s = this.yard.sim;
    // The CA runs on what's on screen plus a margin; bodies simulate everywhere.
    const y0 = Math.floor(this.cam) - 30, y1 = Math.floor(this.cam) + this.rows + 30;
    this.yard.step(dt, y0, y1, t);
    this.simMs = this.simMs * 0.92 + (performance.now() - t0) * 0.08;
    this.cam += (this.camT - this.cam) * Math.min(1, dt * 5);
    this.stepFinds(dt);
    this.stepChips(dt);
    this.sounds(dt);
    this.draw();
    const span = s.H - 14 - s.ground;
    this.ctx.progress(Math.min(1, (this.deepest - s.ground) / span), 'deep');
    const m = ((this.deepest - s.ground) * 0.05).toFixed(1);
    const bodies = this.yard.world.bodies;
    const awake = bodies.reduce((n, b) => n + (b.sleeping ? 0 : 1), 0);
    this.ctx.setStatus(`${m} m down · ${this.finds.filter((f) => f.state === FindState.Found).length}/${this.finds.length} finds · ${awake}/${bodies.length} bodies · sim ${this.simMs.toFixed(1)}ms`);
  }

  private toGrid(p: { x: number; y: number }): [number, number] {
    return [p.x * COLS, this.cam + (1 - p.y) * (this.height / this.cs)];
  }

  private input(dt: number) {
    const { yard } = this;
    const sim = yard.sim;
    const seen = new Set<number>();
    const removed = new Array(10).fill(0);
    let dug = 0;
    for (const p of this.ctx.pointers.active.values()) {
      seen.add(p.id);
      const [x, y] = this.toGrid(p);
      if (p.justDown) {
        const f = this.findAt(x, y);
        if (f) {
          this.collect(f);
          this.taps.add(p.id);
        }
      }
      if (this.taps.has(p.id)) continue;
      const prev = this.last.get(p.id) ?? [x, y];
      // Scrape along the whole stroke so fast swipes cut a continuous trench.
      const d = Math.hypot(x - prev[0], y - prev[1]);
      const steps = Math.max(1, Math.ceil(d / (DIG_R * 0.5)));
      const sdx = (x - prev[0]) / steps, sdy = (y - prev[1]) / steps;
      for (let k = 1; k <= steps; k++) dug += yard.dig(prev[0] + sdx * k, prev[1] + sdy * k, DIG_R, removed, x - prev[0], y - prev[1]);
      this.last.set(p.id, [x, y]);
      if (dug) this.deepest = Math.max(this.deepest, Math.min(y + DIG_R, sim.H - 14));
      // Camera follows the shovel: hold near the bottom edge to keep digging down.
      const sy = (1 - p.y) * this.rows;
      if (sy > this.rows * 0.72) this.camT = Math.min(sim.H - this.rows, this.camT + dt * 60 * ((sy / this.rows - 0.72) / 0.28));
      else if (sy < this.rows * 0.18 && this.camT > 0) this.camT = Math.max(0, this.camT - dt * 50 * ((0.18 - sy / this.rows) / 0.18));
      if (dug) this.spawnChips(x, y, removed, p.dx, p.dy);
    }
    for (const id of [...this.last.keys()]) if (!seen.has(id)) this.last.delete(id);
    for (const id of [...this.taps]) if (!seen.has(id)) this.taps.delete(id);
    yard.digging = this.last.size > 0;
    if (!dug) return;
    // Scraping: a grainy buzz with the amount of dirt coming away, sharper on rock.
    this.ctx.hapticLevel(Math.min(1, 0.2 + dug / 60), removed[ROCK] ? 0.9 : 0.35);
    const now = this.time;
    const rock = removed[ROCK];
    if (now - this.lastHaptic > (rock ? 0.06 : 0.09)) {
      this.lastHaptic = now;
      this.ctx.haptic(rock ? 'medium' : 'light');
    }
    if (now - this.lastDigSound > 0.07) {
      this.lastDigSound = now;
      // The loudest material in the scoop sets the sound: clay thuds, sand hisses, rock knocks.
      let top = SOIL, n = 0;
      removed.forEach((c, m) => c > n && ([top, n] = [m, c]));
      const gain = Math.min(1, 0.25 + dug / 40);
      if (top === ROCK) this.ctx.sound.play('knock', { pitch: 0.9 + Math.random() * 0.3, gain });
      else if (top === WATER) this.ctx.sound.play('splash', { pitch: 1.4, gain: gain * 0.5 });
      else this.ctx.sound.play('crumble', { pitch: top === CLAY ? 0.75 : top === SAND ? 1.4 : top === GRAVEL ? 1.15 : 1, gain });
    }
  }

  /** An uncovered find under the finger. */
  private findAt(x: number, y: number) {
    for (const f of this.finds)
      if (f.state === FindState.Loose && f.body && f.exposure > 0.12 && Math.hypot(f.body.x - x, f.body.y - y) < f.r + 3.5) return f;
    return null;
  }

  private collect(f: Find) {
    this.yard.collect(f);
    const i = this.finds.indexOf(f);
    this.ctx.haptic('medium');
    this.ctx.sound.play('pop', { pitch: 1.3 });
    this.ctx.sound.play('chime', { pitch: 1 + i * 0.04, gain: 0.35 });
    this.showToast(`${f.emoji} ${f.name}!`);
  }

  private spawnChips(x: number, y: number, removed: number[], dx: number, dy: number) {
    let budget = 5;
    removed.forEach((c, m) => {
      for (let k = 0; k < Math.min(c, 3) && budget > 0; k++, budget--) {
        const [r, gg, b] = COLOR[m];
        this.chips.push({
          x: x + (Math.random() - 0.5) * DIG_R,
          y: y + (Math.random() - 0.5) * DIG_R,
          vx: (Math.random() - 0.5) * 40 + dx * COLS * 8,
          vy: -30 - Math.random() * 50 - dy * 200,
          life: 0.5 + Math.random() * 0.4,
          c: `rgb(${r},${gg},${b})`,
        });
      }
      removed[m] = 0;
    });
    if (this.chips.length > 260) this.chips.splice(0, this.chips.length - 260);
  }

  /** Dust puffed out where a slab smashes. */
  private dust(x: number, y: number, mat: number, n: number) {
    const [r, gg, b] = COLOR[mat] ?? COLOR[SOIL];
    for (let i = 0; i < n; i++)
      this.chips.push({
        x: x + (Math.random() - 0.5) * 6,
        y: y - Math.random() * 2,
        vx: (Math.random() - 0.5) * 90,
        vy: -20 - Math.random() * 70,
        life: 0.4 + Math.random() * 0.5,
        c: `rgb(${r},${gg},${b})`,
      });
    if (this.chips.length > 260) this.chips.splice(0, this.chips.length - 260);
  }

  private stepChips(dt: number) {
    for (const c of this.chips) {
      c.vy += 160 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.life -= dt;
    }
    this.chips = this.chips.filter((c) => c.life > 0);
  }

  /** Settled finds out in the open collect themselves; collected ones fly to the shelf. */
  private stepFinds(dt: number) {
    const slots = this.shelf.children;
    for (let i = 0; i < this.finds.length; i++) {
      const f = this.finds[i];
      if (f.state === FindState.Loose && f.open > COLLECT_AFTER) this.collect(f);
      if (f.state !== FindState.Flying) continue;
      f.fly += dt;
      if (f.fly > 0.75) {
        f.state = FindState.Found;
        slots[i]?.classList.add('got');
        if (f.emoji === '👑' && !this.done) {
          this.done = true;
          this.ctx.celebrate('You found the buried crown!');
        }
      }
    }
  }

  private showToast(text: string) {
    this.toast.textContent = text;
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
  }

  private sounds(dt: number) {
    const { ctx, yard } = this;
    const s = yard.sim;
    this.trickle.set(Math.min(1, s.moved / 120), 0.4 + Math.min(0.5, s.moved / 400));
    this.water.set(Math.min(1, s.flowed / 60), 0.5);
    const now = this.time;
    const tap = (level: 'light' | 'medium' | 'heavy') => {
      if (now - this.lastHaptic < 0.05) return;
      this.lastHaptic = now;
      ctx.haptic(level);
    };
    for (const e of yard.events) {
      const big = Math.min(1, Math.sqrt(e.mass) / 25);
      const pan = Math.max(-1, Math.min(1, (e.x / COLS) * 2 - 1));
      switch (e.type) {
        case 'detach':
          // The ground lets go: a crack of crumbling earth, deeper for bigger slabs.
          ctx.sound.play('crumble', { pitch: e.mat === CLAY ? 0.7 : e.mat === ROCK ? 0.55 : 0.9 - big * 0.25, gain: Math.min(1, 0.3 + big * 0.7), pan });
          if (e.kind === Kind.Boulder) ctx.sound.play('knock', { pitch: 0.6, gain: 0.5, pan });
          this.rumble = Math.max(this.rumble, 0.25 + big * 0.6);
          tap(big > 0.6 ? 'heavy' : big > 0.3 ? 'medium' : 'light');
          break;
        case 'impact': {
          const hard = Math.min(1, e.speed / 140) * (0.35 + big * 0.65);
          if (now - this.lastThud < 0.04 && hard < 0.5) break;
          this.lastThud = now;
          if (e.kind === Kind.Find) ctx.sound.play('knock', { pitch: 1.6 + Math.random() * 0.3, gain: Math.min(0.6, e.speed / 150), pan });
          else {
            ctx.sound.play('thud', { pitch: Math.max(0.45, 1.4 - big * 0.9) * (0.9 + Math.random() * 0.2), gain: Math.min(1, 0.15 + hard), pan });
            if (e.kind === Kind.Boulder) ctx.sound.play('knock', { pitch: 0.7 + Math.random() * 0.25, gain: Math.min(1, 0.2 + hard), pan });
          }
          this.rumble = Math.max(this.rumble, hard);
          if (hard > 0.12) tap(hard > 0.6 ? 'heavy' : hard > 0.3 ? 'medium' : 'light');
          break;
        }
        case 'shatter':
          ctx.sound.play('crumble', { pitch: 0.75 + Math.random() * 0.2, gain: Math.min(1, 0.35 + big * 0.65), pan });
          this.dust(e.x, e.y, e.mat, 4 + Math.round(big * 10));
          this.rumble = Math.max(this.rumble, 0.4 + big * 0.5);
          tap(big > 0.5 ? 'heavy' : 'medium');
          break;
        case 'roll':
          ctx.sound.play('knock', { pitch: 0.55 + Math.random() * 0.3, gain: Math.min(0.55, 0.12 + e.speed / 120), pan });
          ctx.hapticLevel(Math.min(0.6, e.speed / 80), 0.5);
          break;
        case 'reveal':
          ctx.sound.play('pop', { pitch: 1.05, gain: 0.45, pan });
          tap('light');
          break;
        case 'bake':
          ctx.sound.play('crumble', { pitch: 0.6, gain: 0.12, pan });
          break;
      }
    }
    // Rumble: collapses in progress, plus the mass on the move.
    let ke = 0;
    for (const b of yard.world.bodies) if (b.active && b.kind !== Kind.Find) ke += b.mass * (b.vx * b.vx + b.vy * b.vy);
    const moving = Math.min(0.7, Math.sqrt(ke) / 3000);
    this.rumble *= Math.exp(-dt * 5);
    const level = Math.max(this.rumble, moving);
    if (level > 0.03) ctx.hapticLevel(level, 0.12);
    // Loose crumbling (sand running, crumbs of a smash).
    if (s.crumbled > 10 && now - this.lastDigSound > 0.12) {
      this.lastDigSound = now;
      ctx.sound.play('crumble', { pitch: 1.1, gain: Math.min(0.8, s.crumbled / 60) });
    }
  }

  // ---------------------------------------------------------------- draw

  private draw() {
    const { g, width, height, cs } = this;
    const sim = this.yard.sim;
    const cam = this.cam;
    const top = Math.floor(cam);
    const off = (cam - top) * cs;
    // Sky above the lawn, a dark earthen back wall behind everything dug out.
    const groundY = (sim.ground - cam) * cs;
    if (groundY > 0) {
      const sky = g.createLinearGradient(0, 0, 0, groundY);
      sky.addColorStop(0, '#7cc4f5');
      sky.addColorStop(1, '#d6efff');
      g.fillStyle = sky;
      g.fillRect(0, 0, width, groundY);
    }
    const wallTop = Math.max(0, groundY);
    const wall = g.createLinearGradient(0, wallTop, 0, height);
    const deep = Math.min(1, cam / sim.H);
    wall.addColorStop(0, `rgb(${58 - deep * 30},${38 - deep * 20},${26 - deep * 12})`);
    wall.addColorStop(1, `rgb(${40 - deep * 22},${26 - deep * 14},${20 - deep * 10})`);
    g.fillStyle = wall;
    g.fillRect(0, wallTop, width, height - wallTop);

    // Bodies go under the grid layer (their own cells there are transparent), so rubble that
    // lands on a slab or buries a find covers it.
    g.imageSmoothingEnabled = false;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const b of this.yard.world.bodies) {
      if (!b.alive) continue;
      const sy = (b.y - cam) * cs;
      if (sy < -b.rad * cs || sy > height + b.rad * cs) continue;
      if (b.kind === Kind.Find) {
        const f = this.finds[b.find];
        g.setTransform(b.c, b.s, -b.s, b.c, b.x * cs, sy);
        g.font = `${f.size * cs}px system-ui, sans-serif`;
        g.fillText(f.emoji, 0, f.size * cs * 0.06);
      } else {
        b.canvas ??= bodyCanvas(b);
        g.setTransform(b.c * cs, b.s * cs, -b.s * cs, b.c * cs, b.x * cs, sy);
        g.drawImage(b.canvas, -b.cx, -b.cy);
      }
    }
    g.setTransform(1, 0, 0, 1, 0, 0);

    this.paintCells(top);
    g.drawImage(this.layer, 0, -off, width, this.rows * cs);

    for (const c of this.chips) {
      g.fillStyle = c.c;
      g.globalAlpha = Math.min(1, c.life * 3);
      g.fillRect((c.x - 0.6) * cs, (c.y - cam - 0.6) * cs, cs * 1.2, cs * 1.2);
    }
    g.globalAlpha = 1;

    // Collected finds arc up to their shelf slot.
    const slots = this.shelf.children;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const pr = width / Math.max(1, rect.width);
    this.finds.forEach((f, i) => {
      if (f.state !== FindState.Flying) return;
      const t = Math.min(1, f.fly / 0.75);
      const e = t * t * (3 - 2 * t);
      const sr = (slots[i] as HTMLElement | undefined)?.getBoundingClientRect();
      const tx = sr ? (sr.left + sr.width / 2 - rect.left) * pr : width / 2;
      const ty = sr ? (sr.top + sr.height / 2 - rect.top) * pr : height;
      const sx = f.x * cs, sy = (f.y - cam) * cs;
      const x = sx + (tx - sx) * e;
      const y = sy + (ty - sy) * e - Math.sin(t * Math.PI) * height * 0.18;
      const size = f.size * cs * (1 + Math.sin(Math.min(1, t * 2.5) * Math.PI) * 0.6) * (1 - 0.45 * e);
      g.font = `${size}px system-ui, sans-serif`;
      g.fillText(f.emoji, x, y);
    });
  }

  /** Fill the pixel layer from the grid: material colour, per-cell grain, lit tops and shaded undersides. */
  private paintCells(top: number) {
    const img = this.img!;
    const d = img.data;
    const { cells, shade, W, H } = this.yard.sim;
    d.fill(0);
    for (let r = 0; r < this.rows; r++) {
      const y = top + r;
      if (y < 0 || y >= H) continue;
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        const c = cells[k];
        if (!c || c & BODY) continue;
        const m = c & 0x3f;
        const base = COLOR[m];
        let f = 0.9 + (shade[k] / 255) * 0.2;
        const above = y > 0 ? cells[k - W] : 0;
        const below = y + 1 < H ? cells[k + W] : 1;
        if (m === WATER) {
          f = above ? 0.95 : 1.25;
        } else {
          if (!above) f *= m === GRASS ? 1.2 : 1.28;
          else if (!below) f *= 0.62;
          if (c & LOOSE) f *= 1.08;
          if (m === GRAVEL && shade[k] > 200) f *= 1.3;
          if (m === ROCK && (shade[k] & 31) === 0) f *= 1.35;
          if (m === BEDROCK) f *= 0.9 + ((x * 7 + y * 3) % 5) * 0.04;
        }
        const o = (r * W + x) * 4;
        d[o] = Math.min(255, base[0] * f);
        d[o + 1] = Math.min(255, base[1] * f);
        d[o + 2] = Math.min(255, base[2] * f);
        d[o + 3] = m === WATER ? 215 : 255;
      }
    }
    this.lg.putImageData(img, 0, 0);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.reset();
  }

  destroy() {
    this.trickle.stop();
    this.water.stop();
    this.shelf.remove();
    this.toast.remove();
    this.style.remove();
  }

  /** window.__dig: stats when called, plus helpers for headless tests. */
  private devHook() {
    const self = this;
    const hook = () => {
      const y = self.yard;
      const bodies = y.world.bodies;
      return {
        deepest: self.deepest,
        found: self.finds.filter((f) => f.state === FindState.Found).length,
        cam: Math.round(self.cam),
        rows: y.sim.H,
        ground: y.sim.ground,
        seed: y.sim.seed,
        bodies: bodies.length,
        awake: bodies.filter((b) => !b.sleeping).length,
        contacts: y.world.contacts,
        simMs: +self.simMs.toFixed(2),
        ...y.stats,
      };
    };
    Object.assign(hook, {
      reset: (seed?: number) => self.reset(seed),
      yard: () => self.yard,
      carve: (x0: number, y0: number, x1: number, y1: number) => self.yard.carve(x0, y0, x1, y1),
      cam: (y: number) => (self.cam = self.camT = y),
      list: () =>
        self.yard.world.bodies.map((b: PBody) => ({ id: b.id, kind: b.kind, x: +b.x.toFixed(1), y: +b.y.toFixed(1), a: +b.a.toFixed(2), vx: +b.vx.toFixed(1), vy: +b.vy.toFixed(1), sleeping: b.sleeping, cells: b.cells, mat: b.mat })),
      finds: () => self.finds.map((f) => ({ name: f.name, state: f.state, x: +f.x.toFixed(1), y: +f.y.toFixed(1), r: f.r, exposure: f.exposure, open: +f.open.toFixed(2) })),
      /** Packed cells over the whole yard that nothing holds up (should be 0 once things settle). */
      floating: () => self.yard.structure.unheld(0, self.yard.sim.H),
      cell: (x: number, y: number) => self.yard.sim.cells[Math.floor(y) * COLS + Math.floor(x)],
      /** Grid point to CSS pixels, for driving the mouse. */
      toScreen: (x: number, y: number) => {
        const r = self.ctx.canvas.getBoundingClientRect();
        return [r.left + (x / COLS) * r.width, r.top + (((y - self.cam) * self.cs) / self.height) * r.height];
      },
    });
    (window as unknown as Record<string, unknown>).__dig = hook;
  }
}

/** A body's cells as a tiny image: its materials with grain, lit where it faced up, darker at its rim. */
function bodyCanvas(b: PBody): HTMLCanvasElement {
  const cv = document.createElement('canvas');
  cv.width = b.mw;
  cv.height = b.mh;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(b.mw, b.mh);
  const { mw, mh, mask, shade } = b;
  for (let j = 0; j < mh; j++)
    for (let i = 0; i < mw; i++) {
      const v = mask[j * mw + i];
      if (!v) continue;
      const base = COLOR[v];
      let f = 0.9 + (shade[j * mw + i] / 255) * 0.2;
      const up = j > 0 && mask[(j - 1) * mw + i], dn = j + 1 < mh && mask[(j + 1) * mw + i];
      const lf = i > 0 && mask[j * mw + i - 1], rt = i + 1 < mw && mask[j * mw + i + 1];
      if (!up) f *= v === GRASS ? 1.15 : 1.2;
      else if (!dn) f *= 0.68;
      else if (!lf || !rt) f *= 0.85;
      if (v === ROCK && (shade[j * mw + i] & 31) === 0) f *= 1.35;
      if (v === GRAVEL && shade[j * mw + i] > 200) f *= 1.3;
      const o = (j * mw + i) * 4;
      img.data[o] = Math.min(255, base[0] * f);
      img.data[o + 1] = Math.min(255, base[1] * f);
      img.data[o + 2] = Math.min(255, base[2] * f);
      img.data[o + 3] = 255;
    }
  g.putImageData(img, 0, 0);
  return cv;
}

const STYLE = `
.dig-shelf { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(12px + env(safe-area-inset-bottom, 0px)); display: grid; grid-template-columns: repeat(6, 1fr); gap: 4px; padding: 6px 8px; border-radius: 16px; background: rgba(60, 36, 22, 0.55); backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px); pointer-events: none; }
.dig-shelf i { width: 38px; height: 34px; display: grid; place-items: center; border-radius: 10px; background: rgba(255, 255, 255, 0.08); font-style: normal; }
.dig-shelf i span { font-size: 22px; filter: grayscale(1) brightness(0.25); opacity: 0.55; transition: filter .3s, opacity .3s, transform .3s; }
.dig-shelf i.got { background: rgba(255, 220, 150, 0.22); }
.dig-shelf i.got span { filter: none; opacity: 1; animation: dig-got .5s cubic-bezier(.2,1.6,.4,1); }
@keyframes dig-got { 0% { transform: scale(1.8); } 100% { transform: scale(1); } }
.dig-toast { position: absolute; left: 50%; top: calc(128px + env(safe-area-inset-top, 0px)); transform: translateX(-50%); padding: 8px 14px; border-radius: 999px; background: rgba(255, 248, 235, 0.92); color: #4a2a16; font: 700 16px/1 ui-rounded, system-ui, sans-serif; opacity: 0; pointer-events: none; white-space: nowrap; }
.dig-toast.show { animation: dig-toast 1.8s ease-out forwards; }
@keyframes dig-toast { 0% { opacity: 0; transform: translate(-50%, 8px) scale(.9); } 12% { opacity: 1; transform: translate(-50%, 0) scale(1.05); } 80% { opacity: 1; transform: translate(-50%, 0) scale(1); } 100% { opacity: 0; transform: translate(-50%, -6px); } }
`;
