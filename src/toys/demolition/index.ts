import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Kind, Shape, World, type Body, type Grab, type Rope } from './physics';
import { DemolitionRenderer, FLOATS, Sprite } from './render';
import { BUILD_COLORS, buildScene, type SceneId } from './scenes';

export const demolitionToy: Toy = {
  id: 'demolition',
  title: 'Demolition Tower',
  blurb: 'Swing a wrecking ball through brick towers, castles and pyramids. Bombs, cannonballs, flying bricks.',
  tech: 'Soft-step rigid bodies · WebGL2',
  swatch: 'linear-gradient(135deg,#ff7a1a,#d93b2b 50%,#4a2bd9)',
  refs: [
    {
      short: 'Box2D v3',
      title: 'Erin Catto — Releasing Box2D 3.0 (2024)',
      url: 'https://box2d.org/posts/2024/08/releasing-box2d-3.0/',
      use: 'The solver design: soft step (substeps, soft contacts, relax pass), warm starting and sleeping.',
    },
    {
      short: 'Solver2D',
      title: 'Erin Catto — Solver2D (2024)',
      url: 'https://box2d.org/posts/2024/02/solver2d/',
      use: 'Why soft step keeps tall stacks and pyramids standing, and its softness parameters.',
    },
    {
      short: 'Box2D Lite',
      title: 'Erin Catto — Box2D Lite',
      url: 'https://github.com/erincatto/box2d-lite',
      use: 'Box–box contact manifolds: separating-axis test, incident edge clipping and feature IDs.',
    },
  ],
  async create(ctx) {
    return new Demolition(ctx);
  },
};

type Tool = 'wreck' | 'bomb' | 'cannon' | 'grab' | 'build';

const TOOLS: { id: Tool; label: string; glyph: string; swatch: string }[] = [
  { id: 'wreck', label: 'Wrecking ball', glyph: '🏗️', swatch: '#ffc145' },
  { id: 'bomb', label: 'Bomb', glyph: '💣', swatch: '#ff5d73' },
  { id: 'cannon', label: 'Cannonball', glyph: '🎯', swatch: '#8fa3b8' },
  { id: 'grab', label: 'Grab', glyph: '✋', swatch: '#f1eee8' },
  { id: 'build', label: 'Build', glyph: '🧱', swatch: '#7bdc6b' },
];

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  grow: number;
  r: number;
  g: number;
  b: number;
  chip: boolean;
  a: number;
  va: number;
}

interface Bomb {
  x: number;
  y: number;
  fuse: number;
}

const MAX_PARTICLES = 1400;

class Demolition implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private renderer: DemolitionRenderer;
  private world!: World;
  private width = 1;
  private height = 1;
  private viewW = 12;
  private viewH = 24;
  private cx = 0;
  private cy = 11;
  private tool: Tool = 'wreck';
  private dock: HTMLElement;
  private dockButtons: HTMLButtonElement[] = [];
  private particles: Particle[] = [];
  private bombs: Bomb[] = [];
  private inst = new Float32Array(4096 * FLOATS);
  private count = 0;
  private shake = 0;
  private hitStop = 0;
  private slowRamp = 1;
  private crane!: { rope: Rope; ball: Body; tx: number; ty: number; home: [number, number] };
  private drags = new Map<number, { sx: number; sy: number; ax: number; ay: number; t: number; grab?: Grab; lastBuild: number }>();
  private simMs = 0;
  private breaksThisSecond = 0;

  readonly cfg = {
    scene: 'tower' as SceneId,
    gravity: 10,
    substeps: 8,
    strength: 1,
    slowmo: false,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.renderer = new DemolitionRenderer(gl);
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.fitView();
    this.dock = this.buildDock();
    this.buildPanel();
    this.reset();
    if (import.meta.env.DEV) {
      // Dev-only probes for headless tests.
      const win = window as unknown as Record<string, unknown>;
      win.__demoWake = () => this.world.bodies.forEach((b) => this.world.wake(b));
      win.__demoSnap = () => this.world.bodies.filter((b) => b.kind === Kind.Block).map((b) => [b.x, b.y, b.a]);
      win.__demoStats = () => ({ bodies: this.world.bodies.length, asleep: this.world.sleepingCount, sim: this.simMs });
      win.__demoScene = (id: SceneId) => {
        this.cfg.scene = id;
        this.reset();
      };
      win.__demoTool = (t: Tool) => this.setTool(t);
      win.__demoBomb = (x: number, y: number) => this.explode(x, y);
      win.__demoBallX = () => this.crane.ball.x;
    }
  }

  // ------------------------------------------------------------------ setup

  private fitView() {
    const aspect = this.width / this.height;
    if (aspect < 1) {
      this.viewW = 12.5;
      this.viewH = this.viewW / aspect;
    } else {
      this.viewH = 17;
      this.viewW = this.viewH * aspect;
    }
    this.cx = 0;
    this.cy = this.viewH / 2 - 1.3;
  }

  private reset() {
    this.world = new World();
    this.sync();
    buildScene(this.world, this.cfg.scene);
    this.particles.length = 0;
    this.bombs.length = 0;
    this.drags.clear();
    this.shake = 0;
    // Crane hook on the right; the ball hangs beside the building at about half its height.
    let sceneTop = 2;
    for (const b of this.world.bodies) if (b.kind === Kind.Block) sceneTop = Math.max(sceneTop, b.y + b.hy);
    const ax = Math.min(this.viewW / 2 - 1.2, 5);
    const length = Math.max(4, Math.min(8, sceneTop * 0.55));
    const ay = Math.min(sceneTop * 0.55 + length, this.jibY - 0.6);
    const ball = this.world.add({ shape: Shape.Circle, kind: Kind.Wrecker, r: 0.65, x: ax, y: ay - length, density: 14, friction: 0.4, color: 0x3a3f4a });
    const rope: Rope = { ax, ay, avx: 0, avy: 0, body: ball, length, imp: 0 };
    this.world.ropes.push(rope);
    this.crane = { rope, ball, tx: ax, ty: ay, home: [ax, ay] };
  }

  private sync() {
    const w = this.world;
    if (!w) return;
    w.gravity = -this.cfg.gravity;
    w.substeps = this.cfg.substeps;
    w.breakSpeed = 7 * this.cfg.strength;
  }

  private buildDock() {
    const dock = document.createElement('div');
    dock.className = 'dock';
    this.dockButtons = TOOLS.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.glyph;
      b.setAttribute('aria-label', t.label);
      b.title = t.label;
      b.style.setProperty('--swatch', t.swatch);
      b.addEventListener('click', () => this.setTool(t.id));
      return b;
    });
    dock.append(...this.dockButtons);
    this.ctx.overlay.appendChild(dock);
    this.setTool(this.tool);
    return dock;
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.dockButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(TOOLS[i].id === t)));
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice<SceneId>(
      'Scene',
      [
        { value: 'tower', label: 'Tower' },
        { value: 'castle', label: 'Castle' },
        { value: 'pyramid', label: 'Pyramid' },
        { value: 'jenga', label: 'Jenga' },
      ],
      c.scene,
      (v) => {
        c.scene = v;
        this.reset();
      },
    );
    panel.toggleSwitch(c, 'slowmo', 'Slow motion (¼×)');
    panel.slider(c, 'strength', { label: 'Block strength', min: 0.3, max: 3, step: 0.05, onChange: () => this.sync() });
    panel.slider(c, 'gravity', { label: 'Gravity', min: 0, max: 25, step: 0.5, onChange: () => this.sync() });
    panel.slider(c, "substeps", { label: "Substeps", min: 2, max: 12, step: 1, onChange: () => this.sync() });
    panel.action('Rebuild', () => this.reset());
  }

  // ------------------------------------------------------------------ frame

  frame(dt: number, t: number) {
    this.handleInput(dt);
    // Time scale: slow-mo toggle, hit-stop on big hits, then a short ramp back up.
    let scale = this.cfg.slowmo ? 0.25 : 1;
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      scale *= 0.06;
    } else scale *= this.slowRamp;
    this.slowRamp = Math.min(1, this.slowRamp + dt * 1.1);
    const sdt = dt * scale;
    this.updateCrane(dt);
    this.updateBombs(sdt);
    const t0 = performance.now();
    this.world.step(sdt);
    this.fracture();
    this.simMs = this.simMs * 0.9 + (performance.now() - t0) * 0.1;
    this.impacts();
    this.updateParticles(sdt);
    this.world.compact();
    this.breaksThisSecond = Math.max(0, this.breaksThisSecond - dt * 8);
    this.shake *= Math.exp(-dt * 9);
    this.render(t);
    const w = this.world;
    this.ctx.setStatus(`${w.bodies.length - 1} bodies · ${w.sleepingCount} asleep · sim ${this.simMs.toFixed(1)}ms`);
  }

  /** The crane jib runs just below the HUD buttons (~120 CSS px from the top). */
  private get jibY() {
    const cssH = this.height / this.ctx.pixelRatio;
    return this.cy + this.viewH / 2 - (125 / cssH) * this.viewH;
  }

  private toWorld(u: number, v: number): [number, number] {
    return [this.cx + (u - 0.5) * this.viewW, this.cy + (v - 0.5) * this.viewH];
  }

  private handleInput(dt: number) {
    const w = this.world;
    for (const p of this.ctx.pointers.active.values()) {
      const [x, y] = this.toWorld(p.x, p.y);
      if (p.justDown) {
        const d = { sx: x, sy: y, ax: this.crane.tx, ay: this.crane.ty, t: 0, grab: undefined as Grab | undefined, lastBuild: -1 };
        if (this.tool === 'grab') {
          const b = this.bodyAt(x, y);
          if (b) {
            const dx = x - b.x, dy = y - b.y;
            d.grab = { body: b, lx: b.c * dx + b.s * dy, ly: -b.s * dx + b.c * dy, tx: x, ty: y, ix: 0, iy: 0 };
            w.grabs.push(d.grab);
            w.wake(b);
            this.ctx.haptic('light');
          }
        } else if (this.tool === 'bomb') {
          this.bombs.push({ x, y, fuse: 0.45 });
          this.ctx.haptic('light');
        }
        this.drags.set(p.id, d);
      }
      const d = this.drags.get(p.id);
      if (!d) continue;
      d.t += dt;
      if (this.tool === 'wreck') {
        // Relative drag: move the crane hook by the finger's travel, from anywhere on screen.
        this.crane.tx = d.ax + (x - d.sx);
        this.crane.ty = d.ay + (y - d.sy);
      } else if (d.grab) {
        d.grab.tx = x;
        d.grab.ty = y;
      } else if (this.tool === 'build' && d.t - d.lastBuild > 0.14) {
        d.lastBuild = d.t;
        const col = BUILD_COLORS[(Math.random() * BUILD_COLORS.length) | 0];
        const wide = Math.random() < 0.6;
        w.add({ shape: Shape.Box, x, y, hx: wide ? 0.45 : 0.25, hy: 0.25, a: (Math.random() - 0.5) * 0.3, color: col, breakable: true });
      } else if (this.tool === 'cannon') {
        d.ax = x;
        d.ay = y;
      }
    }
    for (const [id, d] of [...this.drags]) {
      if (this.ctx.pointers.active.has(id)) continue;
      this.drags.delete(id);
      if (d.grab) w.grabs = w.grabs.filter((g) => g !== d.grab);
      if (this.tool === 'cannon') {
        // Flick from press to release; the ball launches from where you pressed, toward the drag.
        const vx = (d.ax - d.sx) * 3.2, vy = (d.ay - d.sy) * 3.2;
        const sp = Math.hypot(vx, vy);
        const k = sp > 45 ? 45 / sp : 1;
        const tap = sp < 1.5;
        w.add({
          shape: Shape.Circle,
          kind: Kind.Cannonball,
          r: 0.32,
          x: d.sx,
          y: d.sy,
          vx: tap ? (d.sx < 0 ? 22 : -22) : vx * k,
          vy: tap ? 4 : vy * k,
          density: 10,
          color: 0x22252c,
        });
        this.ctx.haptic('medium');
      }
    }
  }

  private bodyAt(x: number, y: number): Body | null {
    for (const b of this.world.bodies) {
      if (b.kind === Kind.Static || !b.alive) continue;
      const dx = x - b.x, dy = y - b.y;
      if (b.shape === Shape.Circle) {
        if (dx * dx + dy * dy < (b.r + 0.2) ** 2) return b;
        continue;
      }
      const lx = b.c * dx + b.s * dy, ly = -b.s * dx + b.c * dy;
      if (Math.abs(lx) < b.hx + 0.15 && Math.abs(ly) < b.hy + 0.15) return b;
    }
    return null;
  }

  private updateCrane(dt: number) {
    const r = this.crane.rope;
    // The hook chases the target at a crane-like top speed; its velocity feeds the rope constraint.
    const top = this.jibY - 0.6;
    const tx = Math.max(this.cx - this.viewW / 2 - 4, Math.min(this.cx + this.viewW / 2 + 4, this.crane.tx));
    const ty = Math.max(2, Math.min(top, this.crane.ty));
    let dx = tx - r.ax, dy = ty - r.ay;
    const d = Math.hypot(dx, dy);
    const maxStep = 28 * dt;
    if (d > maxStep) {
      dx *= maxStep / d;
      dy *= maxStep / d;
    }
    r.avx = dt > 0 ? dx / dt : 0;
    r.avy = dt > 0 ? dy / dt : 0;
    r.ax += dx;
    r.ay += dy;
  }

  private updateBombs(dt: number) {
    for (const b of this.bombs) {
      b.fuse -= dt;
      if (b.fuse <= 0) this.explode(b.x, b.y);
    }
    this.bombs = this.bombs.filter((b) => b.fuse > 0);
  }

  private explode(x: number, y: number) {
    const w = this.world;
    const R = 3.2;
    w.wakeRadius(x, y, R + 1);
    for (const b of w.bodies) {
      if (b.invMass === 0 || !b.alive) continue;
      const dx = b.x - x, dy = b.y - y;
      const d = Math.hypot(dx, dy);
      if (d > R) continue;
      const f = 1 - d / R;
      const sp = 26 * f;
      const nx = d > 1e-3 ? dx / d : 0, ny = d > 1e-3 ? dy / d : 1;
      b.vx += nx * sp;
      b.vy += ny * sp + 5 * f;
      b.w += (Math.random() - 0.5) * 14 * f;
      if (d < 1.4 && b.breakable) w.broken.push(b);
    }
    this.fracture();
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 9;
      this.puff(x, y, Math.cos(a) * s, Math.sin(a) * s, 0.4 + Math.random() * 0.7, i < 14 ? [1, 0.75, 0.3] : [0.55, 0.5, 0.46], 1.1);
    }
    this.shake = Math.min(1.2, this.shake + 0.8);
    this.hitStop = 0.08;
    this.slowRamp = 0.3;
    this.ctx.haptic('heavy');
  }

  /** Blocks that took a big hit split into 2–4 pieces that fly apart. */
  private fracture() {
    const w = this.world;
    const broken = [...new Set(w.broken)];
    w.broken.length = 0;
    let n = 0;
    for (const b of broken) {
      if (!b.alive || !b.breakable || b.shape !== Shape.Box) continue;
      if (w.bodies.length > w.maxBodies) break;
      const pieces = this.split(b);
      if (!pieces) continue;
      n++;
      const [r, g, bl] = rgb(b.color);
      for (let i = 0; i < 7; i++) this.chip(b.x, b.y, b.vx, b.vy, [r, g, bl]);
      this.puff(b.x, b.y, b.vx * 0.2, b.vy * 0.2 + 0.5, 0.35 + Math.random() * 0.2, [0.78, 0.72, 0.64], 0.8);
    }
    if (n) {
      this.breaksThisSecond += n;
      this.shake = Math.min(1, this.shake + 0.05 * Math.min(6, n));
      this.ctx.haptic(n >= 4 ? 'heavy' : 'medium');
      if (n >= 5 && this.hitStop <= 0 && this.breaksThisSecond < 20) {
        this.hitStop = 0.05;
        this.slowRamp = Math.min(this.slowRamp, 0.5);
      }
    }
  }

  private split(b: Body): Body[] | null {
    const w = this.world;
    const MIN = 0.1;
    let nx = 1, ny = 1;
    if (b.hx > b.hy * 1.6) nx = b.hx > b.hy * 3 ? 3 : 2;
    else if (b.hy > b.hx * 1.6) ny = b.hy > b.hx * 3 ? 3 : 2;
    else {
      nx = 2;
      ny = 2;
    }
    const phx = b.hx / nx, phy = b.hy / ny;
    if (phx < MIN || phy < MIN) return null;
    w.remove(b);
    const out: Body[] = [];
    const [r, g, bl] = rgb(b.color);
    for (let i = 0; i < nx; i++)
      for (let j = 0; j < ny; j++) {
        const lx = -b.hx + phx * (2 * i + 1), ly = -b.hy + phy * (2 * j + 1);
        const px = b.x + b.c * lx - b.s * ly, py = b.y + b.s * lx + b.c * ly;
        const jitter = 1.5;
        const shade = 0.9 + Math.random() * 0.2;
        const piece = w.add({
          shape: Shape.Box,
          x: px,
          y: py,
          a: b.a,
          hx: phx * 0.97,
          hy: phy * 0.97,
          vx: b.vx - b.w * (py - b.y) + (Math.random() - 0.5) * jitter + lx * 2,
          vy: b.vy + b.w * (px - b.x) + (Math.random() - 0.5) * jitter + ly * 2,
          w: b.w + (Math.random() - 0.5) * 6,
          color: packRgb(r * shade, g * shade, bl * shade),
          breakable: Math.min(phx, phy) > 0.16,
        });
        out.push(piece);
      }
    return out;
  }

  private impacts() {
    let k = 0;
    for (const im of this.world.impacts) {
      if (im.speed < 4) continue;
      if (k++ > 10) break;
      this.puff(im.x, im.y, (Math.random() - 0.5) * 2, 0.8 + Math.random(), 0.2 + Math.min(0.4, im.speed * 0.02), [0.8, 0.75, 0.66], 0.6);
      if (im.speed > 9) this.shake = Math.min(1, this.shake + 0.04);
    }
  }

  // ------------------------------------------------------------------ particles

  private puff(x: number, y: number, vx: number, vy: number, size: number, c: number[], life: number) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    this.particles.push({ x, y, vx, vy, life, max: life, size, grow: 1.2 + Math.random(), r: c[0], g: c[1], b: c[2], chip: false, a: 0, va: 0 });
  }

  private chip(x: number, y: number, vx: number, vy: number, c: number[]) {
    if (this.particles.length >= MAX_PARTICLES) this.particles.shift();
    const a = Math.random() * Math.PI * 2, s = 2 + Math.random() * 6;
    this.particles.push({
      x,
      y,
      vx: vx * 0.5 + Math.cos(a) * s,
      vy: vy * 0.5 + Math.sin(a) * s + 3,
      life: 1.2 + Math.random(),
      max: 2.2,
      size: 0.05 + Math.random() * 0.07,
      grow: 0,
      r: c[0],
      g: c[1],
      b: c[2],
      chip: true,
      a: Math.random() * 6,
      va: (Math.random() - 0.5) * 20,
    });
  }

  private updateParticles(dt: number) {
    const g = this.world.gravity;
    for (const p of this.particles) {
      p.life -= dt;
      if (p.chip) {
        p.vy += g * dt;
        p.a += p.va * dt;
        if (p.y < p.size) {
          p.y = p.size;
          p.vy = Math.abs(p.vy) * 0.3;
          p.vx *= 0.6;
          p.va *= 0.5;
        }
      } else {
        const drag = Math.exp(-dt * 3);
        p.vx *= drag;
        p.vy = p.vy * drag + 0.6 * dt;
        p.size += p.grow * dt * 0.6;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.particles = this.particles.filter((p) => p.life > 0);
  }

  // ------------------------------------------------------------------ render

  private push(x: number, y: number, hx: number, hy: number, a: number, kind: number, v: number, alpha: number, r: number, g: number, b: number, extra = 0) {
    if ((this.count + 1) * FLOATS > this.inst.length) {
      const n = new Float32Array(this.inst.length * 2);
      n.set(this.inst);
      this.inst = n;
    }
    const o = this.count++ * FLOATS;
    const d = this.inst;
    d[o] = x;
    d[o + 1] = y;
    d[o + 2] = hx;
    d[o + 3] = hy;
    d[o + 4] = a;
    d[o + 5] = kind;
    d[o + 6] = v;
    d[o + 7] = alpha;
    d[o + 8] = r;
    d[o + 9] = g;
    d[o + 10] = b;
    d[o + 11] = extra;
  }

  private render(t: number) {
    this.count = 0;
    const bodies = this.world.bodies;
    // Contact shadows, offset down-right.
    for (const b of bodies) {
      if (b.kind === Kind.Static) continue;
      const hx = b.shape === Shape.Circle ? b.r : b.hx, hy = b.shape === Shape.Circle ? b.r : b.hy;
      this.push(b.x + 0.07, b.y - 0.09, hx, hy, b.a, Sprite.Shadow, 0, 0.28, 0, 0, 0);
    }
    // Motion streaks for fast debris.
    for (const b of bodies) {
      if (b.kind === Kind.Static || b.sleeping) continue;
      const sp = Math.hypot(b.vx, b.vy);
      if (sp < 7) continue;
      const len = Math.min(1.6, sp * 0.035);
      const ang = Math.atan2(b.vy, b.vx);
      const size = b.shape === Shape.Circle ? b.r : Math.min(b.hx, b.hy);
      const [r, g, bl] = rgb(b.color);
      this.push(b.x - Math.cos(ang) * len, b.y - Math.sin(ang) * len, len + size, size * 0.9, ang, Sprite.Streak, 0, 0.35, r * 0.35, g * 0.35, bl * 0.35);
    }
    // The crane: jib across the top, trolley at the hook, chain links down to the ball.
    const rope = this.crane.rope;
    // Fixed jib along the top; a trolley rides it above the hook, with a cable down to the hook.
    const jib = this.jibY;
    this.push(this.cx, jib, this.viewW / 2 + 5, 0.16, 0, Sprite.Block, 0.5, 1, 0.98, 0.72, 0.16);
    for (let x = Math.floor((this.cx - this.viewW / 2) / 1.2) * 1.2; x < this.cx + this.viewW / 2 + 1.2; x += 1.2)
      this.push(x, jib, 0.05, 0.13, 0.6, Sprite.Block, 0.5, 1, 0.78, 0.52, 0.08);
    this.push(rope.ax, jib - 0.28, 0.36, 0.16, 0, Sprite.Block, 0.3, 1, 0.3, 0.32, 0.38);
    const cable = jib - 0.44 - rope.ay;
    if (cable > 0.05) this.push(rope.ax, rope.ay + cable / 2, 0.025, cable / 2, 0, Sprite.Block, 0, 1, 0.2, 0.21, 0.24);
    const ball = this.crane.ball;
    const dx = ball.x - rope.ax, dy = ball.y - rope.ay;
    const L = Math.hypot(dx, dy);
    const ang = Math.atan2(dy, dx);
    const links = Math.max(4, Math.round(L / 0.32));
    for (let i = 0; i < links; i++) {
      const f = (i + 0.5) / links;
      const lx = rope.ax + dx * f, ly = rope.ay + dy * f;
      const shade = i % 2 ? 0.62 : 0.78;
      this.push(lx, ly, 0.2, i % 2 ? 0.07 : 0.1, ang, Sprite.Link, 0, 1, shade, shade, shade * 1.05);
    }
    this.push(rope.ax, rope.ay, 0.12, 0.12, 0, Sprite.Metal, 0, 1, 0.5, 0.52, 0.56);
    // Bodies.
    for (const b of bodies) {
      if (b.kind === Kind.Static) continue;
      const [r, g, bl] = rgb(b.color);
      if (b.shape === Shape.Circle) this.push(b.x, b.y, b.r, b.r, b.a, Sprite.Metal, 0, 1, r, g, bl);
      else this.push(b.x, b.y, b.hx, b.hy, b.a, Sprite.Block, ((b.id * 0.618) % 1) * 1, 1, r, g, bl);
    }
    // Lit bombs blink faster as the fuse runs down.
    for (const bm of this.bombs) {
      const blink = Math.sin(t * (30 + (0.45 - bm.fuse) * 60)) > 0 ? 1 : 0.35;
      this.push(bm.x, bm.y, 0.32, 0.32, 0, Sprite.Metal, 0, 1, 0.9 * blink + 0.1, 0.15, 0.12);
      this.push(bm.x + 0.15, bm.y + 0.38, 0.14, 0.14, 0, Sprite.Dust, 0, 0.9, 1, 0.8 * blink, 0.3);
    }
    // Dust and chips on top.
    for (const p of this.particles) {
      const f = Math.max(0, p.life / p.max);
      if (p.chip) this.push(p.x, p.y, p.size, p.size * 0.7, p.a, Sprite.Block, 0.5, Math.min(1, f * 2), p.r, p.g, p.b);
      else this.push(p.x, p.y, p.size, p.size, 0, Sprite.Dust, 0, f * 0.55, p.r, p.g, p.b);
    }
    const jx = (Math.random() - 0.5) * this.shake * 0.35, jy = (Math.random() - 0.5) * this.shake * 0.35;
    this.renderer.draw(this.width, this.height, [this.cx + jx, this.cy + jy, this.viewW, this.viewH], t, this.inst, this.count);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.fitView();
  }

  destroy() {
    this.dock.remove();
    this.renderer.destroy();
  }
}

function rgb(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

function packRgb(r: number, g: number, b: number) {
  const q = (v: number) => Math.max(0, Math.min(255, Math.round(v * 255)));
  return (q(r) << 16) | (q(g) << 8) | q(b);
}
