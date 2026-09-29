import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { JellyWorld, MAX_BODIES, type Body, type Handle } from './sim';
import { JellyRenderer, type Fx } from './render';
import { SHAPES, type ShapeId } from './shapes';

export const jellyToy: Toy = {
  id: 'jelly',
  title: 'Jelly Stack',
  blurb: 'Tap to drop gummy jellies, stack a wobbly tower, then grab, fling and slap it down.',
  tech: 'Shape matching · WebGL2',
  swatch: 'linear-gradient(135deg,#ff3d7f,#ff8a1c 50%,#8b3cff)',
  refs: [
    {
      short: 'Müller 2005',
      title: 'Müller et al. — Meshless Deformations Based on Shape Matching (SIGGRAPH 2005)',
      url: 'https://dl.acm.org/doi/10.1145/1073204.1073216',
      use: 'The jelly: each body is pulled toward the best-fit rotation + linear blend of its rest shape.',
    },
    {
      short: 'Müller 2007',
      title: 'Müller et al. — Position Based Dynamics (2007)',
      url: 'https://matthias-research.github.io/pages/publications/posBasedDyn.pdf',
      use: 'Position-based contacts and friction between jelly particles, and substepping.',
    },
    {
      short: '2MP',
      title: 'Two Minute Papers — Soft Body Wiggles And Jiggles… Effortlessly! (Complementary Dynamics)',
      url: 'https://www.youtube.com/watch?v=s8Nm_ytwO6w',
      use: 'Inspiration for the squash-and-stretch jiggle; not the method used here.',
    },
    {
      short: 'Zhang 2020',
      title: 'Zhang, Bang, Levin, Jacobson — Complementary Dynamics (SIGGRAPH Asia 2020)',
      url: 'https://doi.org/10.1145/3414685.3417819',
      use: 'The idea of layering secondary jiggle on top of the primary motion; here a damped squash-and-stretch spring kicked by changes in velocity.',
    },
  ],
  async create(ctx) {
    return new JellyStack(ctx);
  },
};

type ColorId = 'mix' | 'cherry' | 'lime' | 'tangerine' | 'grape' | 'blue' | 'lemon' | 'mint' | 'bubblegum';

const COLORS: Record<Exclude<ColorId, 'mix'>, [number, number, number]> = {
  cherry: [1.0, 0.16, 0.32],
  lime: [0.42, 0.92, 0.2],
  tangerine: [1.0, 0.5, 0.08],
  grape: [0.58, 0.28, 1.0],
  blue: [0.15, 0.6, 1.0],
  lemon: [1.0, 0.84, 0.12],
  mint: [0.16, 0.9, 0.68],
  bubblegum: [1.0, 0.42, 0.72],
};
const COLOR_IDS = Object.keys(COLORS) as Exclude<ColorId, 'mix'>[];

const SIZE: Record<ShapeId, number> = { cube: 0.17, slab: 0.19, ball: 0.15, star: 0.2, heart: 0.19, bobo: 0.2 };
/** Gummy blocks are firm; balls and hearts are loose and wobbly. */
const FIRM: Record<ShapeId, number> = { cube: 0.7, slab: 0.65, ball: 0.35, star: 0.5, heart: 0.3, bobo: 0.45 };

interface Touch {
  mode: 'grab' | 'swipe';
  handle?: Handle;
  sx: number;
  sy: number;
  lx: number;
  ly: number;
  t: number;
  travel: number;
  /** Smoothed finger speed (world units/s), for the fling whoosh on release. */
  speed: number;
  /** Time of the last slap sound, so a long swipe doesn't machine-gun. */
  slapAt: number;
}

class JellyStack implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private world = new JellyWorld();
  private renderer: JellyRenderer;
  private width = 1;
  private height = 1;
  private shape: ShapeId = 'cube';
  private color: ColorId = 'mix';
  private colorTurn = 0;
  private touches = new Map<number, Touch>();
  private fx: Fx[] = [];
  private dock: HTMLElement;
  private shapeButtons: HTMLButtonElement[] = [];
  private colorButton!: HTMLButtonElement;
  private time = 0;

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.renderer = new JellyRenderer(gl);
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.fitWorld();
    this.dock = this.buildDock();
    this.buildPanel();
    this.startScene();
  }

  // ---------------------------------------------------------------- setup

  private fitWorld() {
    const aspect = this.width / this.height;
    const wW = aspect >= 1 ? aspect : 1;
    const wH = aspect >= 1 ? 1 : 1 / aspect;
    this.world.resize(wW, wH, Math.max(0.16, wH * 0.14));
    this.renderer.worldW = wW;
    this.renderer.worldH = wH;
  }

  private startScene() {
    const w = this.world;
    w.clear();
    const x = w.wW * 0.36;
    let top = w.groundY;
    for (const s of ['slab', 'cube', 'slab', 'cube', 'bobo'] as ShapeId[]) top = this.place(s, x, top) + 0.004;
    this.place('heart', w.wW * 0.8, w.groundY);
    this.place('star', w.wW * 0.78, w.groundY + 0.22);
    this.place('ball', w.wW * 0.62, w.groundY);
  }

  /** Spawn a jelly resting with its bottom at `bottom`; returns its top. */
  private place(shape: ShapeId, x: number, bottom: number, color?: [number, number, number]) {
    const b = this.world.spawn(shape, x, bottom + 0.3, SIZE[shape], color ?? this.pickColor(), FIRM[shape]);
    if (!b) return bottom;
    let minY = Infinity;
    for (let i = b.start; i < b.start + b.count; i++) minY = Math.min(minY, this.world.pos[i * 2 + 1]);
    const dy = bottom + this.world.r - minY;
    for (let i = b.start; i < b.start + b.count; i++) {
      this.world.pos[i * 2 + 1] += dy;
      this.world.prev[i * 2 + 1] += dy;
    }
    return bottom + b.halfHeight * 2;
  }

  private pickColor(): [number, number, number] {
    if (this.color !== 'mix') return COLORS[this.color];
    this.colorTurn = (this.colorTurn + 1 + Math.floor(Math.random() * 3)) % COLOR_IDS.length;
    return COLORS[COLOR_IDS[this.colorTurn]];
  }

  private buildDock() {
    const dock = document.createElement('div');
    dock.className = 'dock';
    dock.style.gap = '4px';
    this.shapeButtons = SHAPES.map((s) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.glyph;
      b.setAttribute('aria-label', s.label);
      b.style.setProperty('--swatch', '#ffd6e8');
      Object.assign(b.style, { fontSize: '17px', minWidth: '34px', width: '34px', height: '34px', padding: '0' });
      b.addEventListener('click', () => this.setShape(s.id));
      return b;
    });
    this.colorButton = document.createElement('button');
    this.colorButton.type = 'button';
    this.colorButton.className = 'swatch';
    this.colorButton.setAttribute('aria-label', 'Colour');
    this.colorButton.setAttribute('aria-pressed', 'true');
    Object.assign(this.colorButton.style, { minWidth: '34px', width: '34px', height: '34px' });
    this.colorButton.addEventListener('click', () => {
      const all: ColorId[] = ['mix', ...COLOR_IDS];
      this.setColor(all[(all.indexOf(this.color) + 1) % all.length]);
    });
    dock.append(...this.shapeButtons, this.colorButton);
    this.ctx.overlay.appendChild(dock);
    this.setShape(this.shape);
    this.setColor(this.color);
    return dock;
  }

  private setShape(s: ShapeId) {
    this.shape = s;
    this.shapeButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(SHAPES[i].id === s)));
  }

  private setColor(c: ColorId) {
    this.color = c;
    const css = (rgb: [number, number, number]) => `rgb(${rgb.map((v) => Math.round(v * 255)).join(',')})`;
    this.colorButton.style.setProperty(
      '--swatch',
      c === 'mix' ? 'conic-gradient(#ff2a52,#ffd61f,#6aeb33,#27e6ad,#2699ff,#9447ff,#ff6bb8,#ff2a52)' : css(COLORS[c]),
    );
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.world.cfg;
    panel.slider(c, 'wobble', { label: 'Wobbliness', min: 0, max: 1, step: 0.01 });
    panel.slider(c, 'bounce', { label: 'Bounciness', min: 0, max: 0.9, step: 0.01 });
    panel.slider(c, 'friction', { label: 'Stickiness (friction)', min: 0, max: 1.5, step: 0.01 });
    panel.slider(c, 'gravity', { label: 'Gravity', min: 1, max: 16, step: 0.1 });
    panel.slider(c, 'substeps', { label: 'Substeps', min: 3, max: 14, step: 1 });
    panel.choice<ShapeId>('Shape', SHAPES.map((s) => ({ value: s.id, label: s.label })), this.shape, (v) => this.setShape(v));
    panel.choice<ColorId>(
      'Colour',
      [{ value: 'mix', label: 'Mix' }, ...COLOR_IDS.map((id) => ({ value: id, label: id[0].toUpperCase() + id.slice(1) }))],
      this.color,
      (v) => this.setColor(v),
    );
    panel.action('Build a tower', () => this.buildTower());
    panel.action('Clear', () => this.world.clear());
  }

  private buildTower() {
    const w = this.world;
    w.clear();
    let top = w.groundY;
    const seq: ShapeId[] = ['slab', 'cube', 'slab', 'cube', 'slab', 'cube', 'slab', 'bobo'];
    for (const s of seq) {
      if (top > w.wH - 0.3) break;
      top = this.place(s, w.wW / 2, top) + 0.004;
    }
    this.ctx.haptic('medium');
    this.ctx.sound.play('boing', { pitch: 0.7, gain: 0.6 });
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number) {
    this.time += dt;
    this.handleInput(dt);
    const t0 = performance.now();
    this.world.step(dt);
    const simMs = performance.now() - t0;
    this.react();
    this.stepFx(dt);
    this.renderer.draw(this.world, this.width, this.height, this.fx);
    const cm = Math.round(this.world.towerHeight() * 45);
    this.ctx.setStatus(`${this.world.bodies.length} jellies · tower ${cm} cm · sim ${simMs.toFixed(1)}ms`);
  }

  private toWorld(u: number, v: number): [number, number] {
    return [u * this.world.wW, v * this.world.wH];
  }

  private handleInput(dt: number) {
    const w = this.world;
    for (const p of this.ctx.pointers.active.values()) {
      const [x, y] = this.toWorld(p.x, p.y);
      let t = this.touches.get(p.id);
      if (!t) {
        const bi = w.pick(x, y, 0.035);
        t = { mode: bi >= 0 ? 'grab' : 'swipe', sx: x, sy: y, lx: x, ly: y, t: 0, travel: 0, speed: 0, slapAt: -1 };
        if (bi >= 0) {
          t.handle = w.grab(bi, x, y);
          this.ctx.haptic('light');
          this.ctx.sound.play('squish', { pitch: this.sizePitch(w.bodies[bi].halfHeight) * 1.1, gain: 0.55, pan: this.pan(x) });
        }
        this.touches.set(p.id, t);
      }
      const mx = x - t.lx;
      const my = y - t.ly;
      const moved = Math.hypot(mx, my);
      t.travel += moved;
      t.t += dt;
      t.speed += (moved / Math.max(dt, 1e-3) - t.speed) * Math.min(1, dt * 20);
      if (t.mode === 'grab' && t.handle) {
        t.handle.tx = x;
        t.handle.ty = y;
      } else if (t.mode === 'swipe') {
        // A fast swipe through a jelly slaps it along the swipe.
        const speed = moved / Math.max(dt, 1e-3);
        if (speed > 1.2) {
          const k = Math.min(speed, 10) * 0.8;
          const hit = w.slap(x, y, (mx / moved) * k, (my / moved) * k, 0.09);
          if (hit > 6) this.ctx.haptic(speed > 5 ? 'medium' : 'light');
          if (hit > 6 && this.time - t.slapAt > 0.15) {
            t.slapAt = this.time;
            const g = Math.min(1, speed / 7);
            this.ctx.sound.play('squish', { pitch: 0.8 + g * 0.3, gain: 0.4 + g * 0.5, pan: this.pan(x) });
            if (speed > 4) this.ctx.sound.play('whoosh', { pitch: 0.9 + g * 0.4, gain: g * 0.5, pan: this.pan(x) });
          }
        }
      }
      t.lx = x;
      t.ly = y;
    }
    for (const [id, t] of [...this.touches]) {
      if (this.ctx.pointers.active.has(id)) continue;
      this.touches.delete(id);
      if (t.handle) {
        w.release(t.handle);
        // A fast release is a fling: a puff of air behind it.
        if (t.speed > 2.5) this.ctx.sound.play('whoosh', { pitch: 0.8 + Math.min(t.speed, 10) * 0.05, gain: Math.min(0.7, t.speed / 10), pan: this.pan(t.lx) });
      }
      else if (t.t < 0.35 && t.travel < 0.03) this.spawnAt(t.sx, t.sy);
    }
  }

  /** Drop the selected jelly at the tap, nudged up until it's clear of the others. */
  private spawnAt(x: number, y: number) {
    const w = this.world;
    if (w.bodies.length >= MAX_BODIES) w.remove(0);
    const size = SIZE[this.shape];
    const half = size * 0.55;
    x = Math.min(w.wW - half, Math.max(half, x));
    y = Math.max(y, w.groundY + half + 0.01);
    const clear = (cx: number, cy: number) => {
      for (let i = 0; i < w.n; i++) if (Math.hypot(w.pos[i * 2] - cx, w.pos[i * 2 + 1] - cy) < half + w.r * 2) return false;
      return true;
    };
    for (let k = 0; k < 60 && !clear(x, y); k++) y += 0.02;
    const b = w.spawn(this.shape, x, y, size, this.pickColor(), FIRM[this.shape], (Math.random() - 0.5) * 0.5);
    if (b) this.pop(b);
  }

  /** A little squash-in on spawn so new jellies arrive with a wobble. */
  private pop(b: Body) {
    const w = this.world;
    for (let k = 0; k < b.count; k++) {
      const i = b.start + k;
      w.vel[i * 2] += -b.q[k * 2] * 3;
      w.vel[i * 2 + 1] += b.q[k * 2 + 1] * 3;
    }
    this.ctx.haptic('light');
    this.ctx.sound.play('plop', { pitch: this.sizePitch(b.halfHeight), gain: 0.35, pan: this.pan(b.cx) });
  }

  /** Impacts become haptics, dust on the table and sparkles on the big ones. */
  private react() {
    const w = this.world;
    let strongest = 0;
    let loud: (typeof w.impacts)[number] | null = null;
    for (const im of w.impacts) {
      strongest = Math.max(strongest, im.strength);
      if (!loud || im.strength > loud.strength) loud = im;
      if (im.ground && im.strength > 0.9) {
        const n = Math.min(10, Math.round(im.strength * 3));
        for (let k = 0; k < n; k++) {
          const side = k % 2 ? 1 : -1;
          this.fx.push({
            x: im.x + side * (0.02 + Math.random() * 0.06),
            y: im.y + 0.01,
            vx: side * (0.2 + Math.random() * 0.5) * Math.min(2, im.strength / 2),
            vy: 0.05 + Math.random() * 0.15,
            life: 0,
            max: 0.5 + Math.random() * 0.3,
            size: 0.012 + Math.random() * 0.012,
            kind: 1,
            color: [1, 0.95, 0.9],
          });
        }
      }
      if (im.strength > 2.2)
        for (let k = 0; k < 3; k++)
          this.fx.push({
            x: im.x + (Math.random() - 0.5) * 0.12,
            y: im.y + 0.03 + Math.random() * 0.08,
            vx: 0,
            vy: 0.1,
            life: 0,
            max: 0.35 + Math.random() * 0.2,
            size: 0.02 + Math.random() * 0.015,
            kind: 2,
            color: [1, 1, 0.92],
          });
    }
    if (strongest > 2.6) this.ctx.haptic('heavy');
    else if (strongest > 1.4) this.ctx.haptic('medium');
    else if (strongest > 0.7) this.ctx.haptic('light');
    // One sound per frame for the hardest hit: a boing pitched by size, plus a thud under the big ones.
    if (loud && loud.strength > 0.7) {
      const p = this.sizePitch(loud.size);
      this.ctx.sound.play('boing', { pitch: p, gain: Math.min(1, (loud.strength - 0.4) / 2.5), pan: this.pan(loud.x) });
      if (loud.strength > 2.2) this.ctx.sound.play('thud', { pitch: p * 0.9, gain: Math.min(1, (loud.strength - 1.6) / 2.5), pan: this.pan(loud.x) });
    }
    w.impacts.length = 0;
  }

  /** Bigger jellies sound lower. */
  private sizePitch(halfHeight: number) {
    return Math.min(1.8, Math.max(0.6, 0.1 / halfHeight));
  }

  /** Stereo position for a world x. */
  private pan(x: number) {
    return (x / this.world.wW - 0.5) * 1.2;
  }

  private stepFx(dt: number) {
    for (const f of this.fx) {
      f.life += dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
      f.vx *= Math.exp(-dt * 4);
      f.vy *= Math.exp(-dt * 3);
    }
    this.fx = this.fx.filter((f) => f.life < f.max).slice(-160);
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.fitWorld();
  }

  destroy() {
    this.dock.remove();
    this.renderer.destroy();
  }
}
