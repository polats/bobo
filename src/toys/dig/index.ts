import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { BEDROCK, CLAY, DigSim, GRASS, GRAVEL, LOOSE, ROCK, SAND, SOIL, WATER } from './sim';

export const digToy: Toy = {
  id: 'dig',
  title: 'Dig Down',
  blurb: 'Scoop down through a backyard. Soil holds until you undercut it, then crumbles; dig up buried finds for your shelf.',
  tech: 'Cohesive falling-sand CA · Canvas 2D',
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
      use: 'Falling-sand cells updated bottom-up, with rigid ground that crumbles into loose particles.',
    },
    {
      short: 'Sandspiel',
      title: 'Sandspiel (Max Bittker, 2019)',
      url: 'https://sandspiel.club/',
      use: 'Per-material cellular-automaton rules; here each soil adds a cohesion rule for overhangs.',
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

interface Find {
  emoji: string;
  name: string;
  x: number;
  y: number;
  size: number;
  found: boolean;
  /** Seconds since it popped out, while it flies to the shelf. */
  fly: number;
}

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
];

class DigDown implements ToyInstance {
  private g: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private cs = 1; // cell size in device pixels
  private rows = 1; // visible rows
  private sim!: DigSim;
  private cam = 0;
  private camT = 0;
  private finds: Find[] = [];
  private layer: HTMLCanvasElement;
  private lg: CanvasRenderingContext2D;
  private img: ImageData | null = null;
  private chips: { x: number; y: number; vx: number; vy: number; life: number; c: string }[] = [];
  private last = new Map<number, [number, number]>();
  private deepest = 0;
  private lastHaptic = 0;
  private lastDigSound = 0;
  private time = 0;
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
    if (import.meta.env.DEV)
      (window as unknown as Record<string, unknown>).__dig = () => ({
        deepest: this.deepest,
        found: this.finds.filter((f) => f.found).length,
        cam: Math.round(this.cam),
        rows: this.sim.H,
      });
  }

  private reset() {
    this.cs = this.width / COLS;
    this.rows = Math.ceil(this.height / this.cs) + 1;
    const ground = Math.round(this.rows * 0.3);
    const H = Math.round(this.rows * DEPTH_SCREENS);
    this.sim = new DigSim(COLS, H, ground);
    this.cam = this.camT = 0;
    this.deepest = ground;
    this.done = false;
    this.chips = [];
    const depth = H - 14 - ground;
    this.finds = FINDS.map(([emoji, name, f]) => ({
      emoji,
      name,
      x: 14 + Math.random() * (COLS - 28),
      y: ground + 6 + depth * f,
      size: emoji === '👑' ? 16 : 11 + Math.random() * 3,
      found: false,
      fly: -1,
    }));
    this.layer.width = COLS;
    this.layer.height = this.rows;
    this.img = this.lg.createImageData(COLS, this.rows);
    this.shelf.innerHTML = this.finds.map((f) => `<i title="${f.name}"><span>${f.emoji}</span></i>`).join('');
    this.ctx.progress(0, 'deep');
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.input(dt);
    const s = this.sim;
    // Simulate what's on screen plus a margin, so falling dirt above and below keeps moving.
    const y0 = Math.floor(this.cam) - 30, y1 = Math.floor(this.cam) + this.rows + 30;
    s.step(y0, y1);
    this.cam += (this.camT - this.cam) * Math.min(1, dt * 5);
    this.stepFinds(dt);
    this.stepChips(dt);
    this.sounds();
    this.draw();
    const span = s.H - 14 - s.ground;
    this.ctx.progress(Math.min(1, (this.deepest - s.ground) / span), 'deep');
    const m = ((this.deepest - s.ground) * 0.05).toFixed(1);
    this.ctx.setStatus(`${m} m down · ${this.finds.filter((f) => f.found).length}/${this.finds.length} finds`);
  }

  private input(dt: number) {
    const { sim } = this;
    const seen = new Set<number>();
    const removed = new Array(9).fill(0);
    let dug = 0;
    for (const p of this.ctx.pointers.active.values()) {
      seen.add(p.id);
      const x = p.x * COLS, y = this.cam + (1 - p.y) * (this.height / this.cs);
      const prev = this.last.get(p.id) ?? [x, y];
      // Scrape along the whole stroke so fast swipes cut a continuous trench.
      const d = Math.hypot(x - prev[0], y - prev[1]);
      const steps = Math.max(1, Math.ceil(d / (DIG_R * 0.5)));
      for (let k = 1; k <= steps; k++) dug += sim.dig(prev[0] + ((x - prev[0]) * k) / steps, prev[1] + ((y - prev[1]) * k) / steps, DIG_R, removed);
      this.last.set(p.id, [x, y]);
      if (dug) this.deepest = Math.max(this.deepest, Math.min(y + DIG_R, sim.H - 14));
      // Camera follows the shovel: hold near the bottom edge to keep digging down.
      const sy = (1 - p.y) * this.rows;
      if (sy > this.rows * 0.72) this.camT = Math.min(sim.H - this.rows, this.camT + dt * 60 * ((sy / this.rows - 0.72) / 0.28));
      else if (sy < this.rows * 0.18 && this.camT > 0) this.camT = Math.max(0, this.camT - dt * 50 * ((0.18 - sy / this.rows) / 0.18));
      if (dug) this.spawnChips(x, y, removed, p.dx, p.dy);
    }
    for (const id of [...this.last.keys()]) if (!seen.has(id)) this.last.delete(id);
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

  private stepChips(dt: number) {
    for (const c of this.chips) {
      c.vy += 160 * dt;
      c.x += c.vx * dt;
      c.y += c.vy * dt;
      c.life -= dt;
    }
    this.chips = this.chips.filter((c) => c.life > 0);
  }

  /** Finds pop out once most of the dirt around them is gone, then fly to the shelf. */
  private stepFinds(dt: number) {
    const slots = this.shelf.children;
    for (let i = 0; i < this.finds.length; i++) {
      const f = this.finds[i];
      if (f.found) continue;
      if (f.fly >= 0) {
        f.fly += dt;
        if (f.fly > 0.75) {
          f.found = true;
          slots[i]?.classList.add('got');
          if (f.emoji === '👑') {
            this.done = true;
            this.ctx.celebrate('You found the buried crown!');
          }
        }
        continue;
      }
      if ((Math.floor(this.time * 60) + i) % 6) continue;
      const r = f.size * 0.3;
      if (this.sim.openness(Math.round(f.x - r), Math.round(f.y - r), Math.round(r * 2), Math.round(r * 2)) > 0.55) {
        f.fly = 0;
        this.ctx.haptic('medium');
        this.ctx.sound.play('pop', { pitch: 1.3 });
        this.ctx.sound.play('chime', { pitch: 1 + i * 0.04, gain: 0.35 });
        this.showToast(`${f.emoji} ${f.name}!`);
      }
    }
  }

  private showToast(text: string) {
    this.toast.textContent = text;
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
  }

  private sounds() {
    const s = this.sim;
    this.trickle.set(Math.min(1, s.moved / 120), 0.4 + Math.min(0.5, s.moved / 400));
    this.water.set(Math.min(1, s.flowed / 60), 0.5);
    // Cave-ins rumble through the phone.
    if (s.crumbled > 4) this.ctx.hapticLevel(Math.min(1, s.crumbled / 40), 0.15);
    if (s.crumbled > 10 && this.time - this.lastDigSound > 0.12) {
      this.lastDigSound = this.time;
      this.ctx.sound.play('crumble', { pitch: 0.7, gain: Math.min(1, s.crumbled / 40) });
      if (s.crumbled > 25) this.ctx.haptic('medium');
    }
  }

  // ---------------------------------------------------------------- draw

  private draw() {
    const { g, width, height, cs, sim } = this;
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

    // Buried finds sit behind the dirt and show through where it's dug away.
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    for (const f of this.finds) {
      if (f.found || f.fly >= 0) continue;
      const sy = (f.y - cam) * cs;
      if (sy < -40 * cs || sy > height + 40 * cs) continue;
      g.font = `${f.size * cs}px system-ui, sans-serif`;
      g.fillText(f.emoji, f.x * cs, sy);
    }

    this.paintCells(top);
    g.imageSmoothingEnabled = false;
    g.drawImage(this.layer, 0, -off, width, this.rows * cs);

    for (const c of this.chips) {
      g.fillStyle = c.c;
      g.globalAlpha = Math.min(1, c.life * 3);
      g.fillRect((c.x - 0.6) * cs, (c.y - cam - 0.6) * cs, cs * 1.2, cs * 1.2);
    }
    g.globalAlpha = 1;

    // Popped finds arc up to their shelf slot.
    const slots = this.shelf.children;
    const rect = this.ctx.canvas.getBoundingClientRect();
    const pr = width / Math.max(1, rect.width);
    this.finds.forEach((f, i) => {
      if (f.fly < 0 || f.found) return;
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
    const { cells, shade, W, H } = this.sim;
    d.fill(0);
    for (let r = 0; r < this.rows; r++) {
      const y = top + r;
      if (y < 0 || y >= H) continue;
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        const c = cells[k];
        if (!c) continue;
        const m = c & 0x7f;
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
