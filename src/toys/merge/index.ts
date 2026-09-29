import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { ShapeId } from '../jelly/shapes';
import { JellyWorld, type Body } from './sim';
import { JellyRenderer, type Fx } from './render';

export const mergeToy: Toy = {
  id: 'merge',
  title: 'Jelly Merge',
  blurb: 'Drop gummies into a jar. Two of the same squish into a bigger one — chase the giant Bobo gummy.',
  tech: 'Shape matching · WebGL2',
  swatch: 'linear-gradient(140deg,#ff2f6d,#ffb020 50%,#22c55e)',
  refs: [
    {
      short: 'Suika Game',
      title: 'Suika Game (Aladdin X, 2021) — the drop-and-merge design this toy riffs on',
      url: 'https://en.wikipedia.org/wiki/Suika_Game',
      use: 'Design inspiration: drop fruit into a jar, same sizes merge into the next size up.',
    },
    {
      short: 'Müller 2005',
      title: 'Müller et al. — Meshless Deformations Based on Shape Matching (SIGGRAPH 2005)',
      url: 'https://dl.acm.org/doi/10.1145/1073204.1073216',
      use: 'Every gummy is a particle cluster pulled toward its best-fit rest shape; merges grow that rest shape.',
    },
    {
      short: 'Müller 2007',
      title: 'Müller et al. — Position Based Dynamics (2007)',
      url: 'https://matthias-research.github.io/pages/publications/posBasedDyn.pdf',
      use: 'Position-based contacts and friction between gummies and the jar, with substepping.',
    },
  ],
  async create(ctx) {
    return new JellyMerge(ctx);
  },
};

type TierSet = 'fruit' | 'shapes';

interface Tier {
  name: string;
  size: number; // outline width for a jar 0.86 wide
  color: [number, number, number];
  firm: number;
}

const FRUIT: Tier[] = [
  { name: 'Cherry', size: 0.075, color: [0.95, 0.12, 0.26], firm: 0.6 },
  { name: 'Strawberry', size: 0.098, color: [1.0, 0.3, 0.38], firm: 0.58 },
  { name: 'Grape', size: 0.125, color: [0.6, 0.3, 1.0], firm: 0.55 },
  { name: 'Orange', size: 0.155, color: [1.0, 0.55, 0.1], firm: 0.52 },
  { name: 'Lemon', size: 0.19, color: [1.0, 0.85, 0.14], firm: 0.5 },
  { name: 'Apple', size: 0.23, color: [0.45, 0.9, 0.2], firm: 0.48 },
  { name: 'Peach', size: 0.275, color: [1.0, 0.62, 0.55], firm: 0.45 },
  { name: 'Blueberry pie', size: 0.325, color: [0.22, 0.5, 1.0], firm: 0.43 },
  { name: 'Melon', size: 0.38, color: [0.45, 0.95, 0.62], firm: 0.42 },
  { name: 'Watermelon', size: 0.44, color: [0.2, 0.75, 0.32], firm: 0.4 },
  { name: 'Giant Bobo', size: 0.52, color: [1.0, 0.42, 0.72], firm: 0.38 },
];
const LAST = FRUIT.length - 1;
const SHAPE_SET: ShapeId[] = ['ball', 'star', 'heart', 'cube', 'slab', 'ball', 'star', 'heart', 'cube', 'ball', 'bobo'];

/** Two matching gummies smoosh into each other for this long before they pop into one. */
const FUSE_TIME = 0.2;

interface Fusion {
  a: Body;
  b: Body;
  t: number;
  firm: [number, number];
  color: [[number, number, number], [number, number, number]];
}

class JellyMerge implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private world = new JellyWorld();
  private held = new JellyWorld();
  private renderer: JellyRenderer;
  private width = 1;
  private height = 1;
  private scale = 1;
  private jar: [number, number, number, number] = [0, 1, 0.3, 1.5];
  private holderY = 1.7;
  private tiers = new Map<Body, number>();
  /** Newly merged gummies spring from their parents' size up to their tier: scale and its rate. */
  private growing = new Map<Body, { s: number; v: number }>();
  private fusing: Fusion[] = [];
  private hitstop = 0;
  private quake = 0;
  private fx: Fx[] = [];
  private heldTier = 0;
  private nextTier = 0;
  private aimX = 0.5;
  private cooldown = 0;
  private pointerId: number | null = null;
  private score = 0;
  private best = 0;
  private combo = 0;
  private comboClock = 0;
  private maxTier = 0;
  private overfull = 0;
  private full = false;
  private time = 0;
  private hud: HTMLElement;
  private scoreEl!: HTMLElement;
  private comboEl!: HTMLElement;
  private nextEl!: HTMLElement;
  private ladder!: HTMLElement;
  private card!: HTMLElement;
  private style: HTMLStyleElement;
  /** Dev-only: disable merging to stress-test a full jar. */
  private noMerge = false;

  readonly cfg = { tierSet: 'fruit' as TierSet, zen: false };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.renderer = new JellyRenderer(gl);
    try {
      this.best = Number(localStorage.getItem('bobo.merge.best') ?? 0) || 0;
    } catch {
      this.best = 0;
    }
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hud = this.buildHud();
    this.buildPanel();
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.layout();
    this.reset();
    if (import.meta.env.DEV) {
      // Dev-only probe for headless tests: pour in n random gummies, report body stats.
      (window as unknown as Record<string, unknown>).__merge = (n: number, noMerge = false) => {
        this.noMerge = noMerge;
        const [l, r, floor, top] = this.jar;
        for (let k = 0; k < n; k++) {
          const t = Math.floor(Math.random() * 7);
          this.spawnTier(t, l + this.radius(t) + Math.random() * (r - l - 2 * this.radius(t)), floor + 0.1 + ((top - floor) * k) / n);
        }
        return { bodies: this.world.bodies.length, particles: this.world.n };
      };
      (window as unknown as Record<string, unknown>).__spawn = (t: number, x: number, y: number) => void this.spawnTier(t, x, y);
      (window as unknown as Record<string, unknown>).__mergeStats = () => ({
        bodies: this.world.bodies.length,
        particles: this.world.n,
        asleep: this.world.bodies.filter((b) => b.asleep).length,
        maxSpeed: Math.max(0, ...this.world.bodies.map((b) => Math.hypot(b.vx, b.vy))),
        full: this.full,
      });
    }
  }

  // ---------------------------------------------------------------- setup

  private layout() {
    const aspect = this.width / this.height;
    const wW = aspect >= 1 ? aspect : 1;
    const wH = aspect >= 1 ? 1 : 1 / aspect;
    const J = Math.min(0.86 * wW, 0.62 * wH);
    this.scale = J / 0.86;
    const floor = aspect >= 1 ? 0.1 : Math.max(0.2, wH * 0.13);
    const top = Math.min(wH - (aspect >= 1 ? 0.3 : 0.62), floor + J * 1.45);
    this.jar = [(wW - J) / 2, (wW + J) / 2, floor, top];
    this.holderY = top + (aspect >= 1 ? (wH - top) * 0.5 : 0.2);
    for (const w of [this.world, this.held]) {
      w.resize(wW, wH, floor);
      w.left = this.jar[0];
      w.right = this.jar[1];
    }
    this.renderer.jar = this.jar;
    this.renderer.worldW = wW;
    this.renderer.worldH = wH;
    this.aimX = wW / 2;
  }

  private tier(t: number) {
    const base = FRUIT[t];
    return { ...base, size: base.size * this.scale, shape: this.cfg.tierSet === 'fruit' ? (t === LAST ? 'bobo' : 'ball') : SHAPE_SET[t] } as Tier & { shape: ShapeId };
  }

  private radius(t: number) {
    return this.tier(t).size / 2;
  }

  private reset() {
    this.world.clear();
    this.held.clear();
    this.tiers.clear();
    this.growing.clear();
    this.fusing = [];
    this.score = 0;
    this.combo = 0;
    this.maxTier = 0;
    this.overfull = 0;
    this.full = false;
    this.card.hidden = true;
    // A few gummies already in the jar so the first drop can merge.
    const [l, r, floor] = this.jar;
    const starters = [0, 1, 0, 2, 1];
    starters.forEach((t, k) => {
      const x = l + (r - l) * (0.18 + 0.16 * k);
      this.spawnTier(t, x, floor + this.radius(t) + 0.02 + (k % 2) * 0.05);
    });
    this.heldTier = this.randomDropTier();
    this.nextTier = this.randomDropTier();
    this.loadHeld();
    this.updateHud();
  }

  private randomDropTier() {
    // Like Suika, only the five smallest sizes are ever dropped.
    return Math.floor(Math.random() * 5);
  }

  private spawnTier(t: number, x: number, y: number, into = this.world): Body | null {
    const tr = this.tier(t);
    const b = into.spawn(tr.shape, x, y, tr.size, tr.color, tr.firm, (Math.random() - 0.5) * 0.3);
    if (b && into === this.world) this.tiers.set(b, t);
    return b;
  }

  private loadHeld() {
    this.held.clear();
    const b = this.spawnTier(this.heldTier, this.aimX, this.holderY, this.held);
    if (b) this.moveHeld(b);
    this.nextEl.style.setProperty('--c', css(FRUIT[this.nextTier].color));
    this.nextEl.style.setProperty('--s', `${10 + this.nextTier * 3}px`);
  }

  private moveHeld(b: Body) {
    const w = this.held;
    const r = this.radius(this.heldTier);
    const x = Math.min(this.jar[1] - r - 0.005, Math.max(this.jar[0] + r + 0.005, this.aimX));
    let cx = 0, cy = 0;
    for (let i = b.start; i < b.start + b.count; i++) {
      cx += w.pos[i * 2];
      cy += w.pos[i * 2 + 1];
    }
    cx /= b.count;
    cy /= b.count;
    // Gentle bob while waiting in the holder.
    const dy = this.holderY + Math.sin(this.time * 2.2) * 0.008 - cy;
    const dx = x - cx;
    for (let i = b.start; i < b.start + b.count; i++) {
      w.pos[i * 2] += dx;
      w.pos[i * 2 + 1] += dy;
    }
  }

  // ---------------------------------------------------------------- UI

  private buildHud() {
    const hud = document.createElement('div');
    hud.className = 'merge-hud';
    hud.innerHTML = `
      <div class="merge-score"><b>0</b><span>best 0</span></div>
      <div class="merge-next"><span>next</span><i></i></div>
      <div class="merge-combo"></div>
      <div class="merge-ladder"></div>
      <div class="merge-card" hidden>
        <b>Jar full!</b><span></span>
        <div><button type="button" data-a="shake">Shake it</button><button type="button" data-a="reset">New jar</button></div>
      </div>`;
    this.ctx.overlay.appendChild(hud);
    this.scoreEl = hud.querySelector('.merge-score')!;
    this.comboEl = hud.querySelector('.merge-combo')!;
    this.nextEl = hud.querySelector('.merge-next i')!;
    this.ladder = hud.querySelector('.merge-ladder')!;
    this.card = hud.querySelector('.merge-card')!;
    this.ladder.innerHTML = FRUIT.map((t, i) => `<i style="--c:${css(t.color)};--s:${6 + i * 1.6}px" title="${t.name}"></i>`).join('');
    hud.querySelector('[data-a=shake]')!.addEventListener('click', () => this.shake());
    hud.querySelector('[data-a=reset]')!.addEventListener('click', () => this.reset());
    return hud;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.world.cfg;
    const syncHeld = () => Object.assign(this.held.cfg, c);
    panel.slider(c, 'gravity', { label: 'Gravity', min: 2, max: 16, step: 0.1, onChange: syncHeld });
    panel.slider(c, 'bounce', { label: 'Bounciness', min: 0, max: 0.9, step: 0.01, onChange: syncHeld });
    panel.slider(c, 'wobble', { label: 'Wobble', min: 0, max: 1, step: 0.01, onChange: syncHeld });
    panel.choice<TierSet>(
      'Gummies',
      [
        { value: 'fruit', label: 'Fruit' },
        { value: 'shapes', label: 'Shapes' },
      ],
      this.cfg.tierSet,
      (v) => {
        this.cfg.tierSet = v;
        this.reset();
      },
    );
    panel.toggleSwitch(this.cfg, 'zen', 'Zen mode (never fills up)');
    panel.action('New jar', () => this.reset());
  }

  private updateHud() {
    this.scoreEl.querySelector('b')!.textContent = String(this.score);
    this.scoreEl.querySelector('span')!.textContent = `best ${this.best}`;
    this.ladder.querySelectorAll('i').forEach((el, i) => el.classList.toggle('on', i <= this.maxTier));
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    if (import.meta.env.DEV) dt *= (window as unknown as { __slow?: number }).__slow ?? 1;
    this.time = t;
    this.handleInput(dt);
    const t0 = performance.now();
    // Hit-stop: the world holds its breath for a few frames when two gummies pop.
    this.hitstop -= dt;
    if (this.hitstop <= 0) {
      this.pullFusing(dt);
      this.world.step(dt);
      this.grow(dt);
      this.mergeTouching();
      this.stepFusing(dt);
    }
    const simMs = performance.now() - t0;
    this.stepShake(dt);
    this.checkFull(dt);
    this.react();
    this.stepFx(dt);
    if (this.held.bodies[0]) this.moveHeld(this.held.bodies[0]);
    this.comboClock -= dt;
    if (this.comboClock <= 0 && this.combo) {
      this.combo = 0;
      this.comboEl.classList.remove('show');
    }
    this.renderer.time = t;
    this.renderer.warn = Math.min(1, this.overfull / 2);
    this.renderer.draw(this.world, this.width, this.height, this.fx, [this.held]);
    this.ctx.progress(this.maxTier / LAST, `to ${FRUIT[LAST].name}`);
    this.ctx.setStatus(`score ${this.score} · best ${this.best} · ${this.world.bodies.length} gummies · sim ${simMs.toFixed(1)}ms`);
  }

  private handleInput(dt: number) {
    this.cooldown -= dt;
    const aspect = this.width / this.height;
    const wW = aspect >= 1 ? aspect : 1;
    let seen = false;
    for (const p of this.ctx.pointers.active.values()) {
      if (this.pointerId === null && p.justDown) this.pointerId = p.id;
      if (p.id !== this.pointerId) continue;
      seen = true;
      this.aimX = p.x * wW;
    }
    // Drop on release.
    if (this.pointerId !== null && !seen) {
      this.pointerId = null;
      this.drop();
    }
  }

  private drop() {
    if (this.full || this.cooldown > 0 || !this.held.bodies[0]) return;
    const hb = this.held.bodies[0];
    const [cx, cy] = this.held.transform(hb);
    const b = this.spawnTier(this.heldTier, cx, cy);
    if (!b) return;
    this.cooldown = 0.45;
    this.heldTier = this.nextTier;
    this.nextTier = this.randomDropTier();
    this.held.clear();
    this.ctx.haptic('light');
    // Reload the holder after a beat, so the drop reads.
    setTimeout(() => {
      if (!this.full) this.loadHeld();
    }, 260);
  }

  /**
   * Newly merged gummies start at their parents' size and spring up into their tier, overshooting
   * a little. The rest shape itself grows, so the swell physically shoves the neighbours aside.
   */
  private grow(dt: number) {
    for (const [b, g] of this.growing) {
      g.v += (380 * (1 - g.s) - 15 * g.v) * dt;
      const ns = Math.min(1.16, Math.max(0.4, g.s + g.v * dt));
      scaleBody(b, ns / g.s);
      g.s = ns;
      if (Math.abs(1 - g.s) < 0.004 && Math.abs(g.v) < 0.05) {
        scaleBody(b, 1 / g.s);
        this.growing.delete(b);
      }
    }
  }

  private mergeTouching() {
    if (this.noMerge) return;
    const bodies = this.world.bodies;
    const used = new Set<Body>();
    const pairs: [Body, Body][] = [];
    for (let i = 0; i < bodies.length; i++) {
      const a = bodies[i];
      const ta = this.tiers.get(a);
      if (ta === undefined || used.has(a) || this.isFusing(a)) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const b = bodies[j];
        if (used.has(b) || this.tiers.get(b) !== ta || this.isFusing(b)) continue;
        const reach = (this.radius(ta) * this.sizeOf(a) + this.radius(ta) * this.sizeOf(b)) * 1.06 + this.world.r * 2;
        if (Math.hypot(a.cx - b.cx, a.cy - b.cy) > reach) continue;
        used.add(a);
        used.add(b);
        pairs.push([a, b]);
        break;
      }
    }
    for (const [a, b] of pairs) this.startFusion(a, b);
  }

  private sizeOf(b: Body) {
    return this.growing.get(b)?.s ?? 1;
  }

  private isFusing(b: Body) {
    return this.fusing.some((f) => f.a === b || f.b === b);
  }

  /** Two matching gummies touched: they go soft and start squeezing into each other. */
  private startFusion(a: Body, b: Body) {
    this.fusing.push({ a, b, t: 0, firm: [a.firm, b.firm], color: [a.color, b.color] });
    for (const x of [a, b]) {
      this.world.wake(x);
      x.firm = 0;
    }
    this.ctx.haptic('light');
  }

  /**
   * Draw each fusing pair together along the line between their centres. Contacts stay on, so
   * they flatten against each other into a squeezed double blob instead of passing through.
   */
  private pullFusing(dt: number) {
    const w = this.world;
    for (const f of this.fusing) {
      const { a, b } = f;
      let nx = b.cx - a.cx, ny = b.cy - a.cy;
      const d = Math.hypot(nx, ny) || 1e-6;
      nx /= d;
      ny /= d;
      const reach = a.halfWidth + b.halfWidth;
      const left = Math.max(0.04, FUSE_TIME - f.t);
      // Close the gap to 45% of touching distance by the time the fuse runs out.
      const want = Math.max(0, d - reach * 0.45) / left / 2;
      const rel = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
      const kick = Math.max(0, want + rel / 2) * Math.min(1, dt * 30);
      for (const [x, sgn] of [[a, 1], [b, -1]] as const) {
        w.wake(x);
        for (let i = x.start; i < x.start + x.count; i++) {
          w.vel[i * 2] += nx * kick * sgn;
          w.vel[i * 2 + 1] += ny * kick * sgn;
        }
      }
    }
  }

  private stepFusing(dt: number) {
    const bodies = new Set(this.world.bodies);
    const done: Fusion[] = [];
    this.fusing = this.fusing.filter((f) => {
      // Poofed or knocked out mid-squeeze (Zen mode, shake): let the survivor be.
      if (!bodies.has(f.a) || !bodies.has(f.b)) {
        for (const [k, x] of [f.a, f.b].entries()) if (bodies.has(x)) {
          x.firm = f.firm[k];
          x.color = f.color[k];
        }
        return false;
      }
      f.t += dt;
      // Heat up as the pressure builds: brighter, with a quickening pulse.
      const k = Math.min(1, f.t / FUSE_TIME);
      const glow = k * (0.3 + 0.25 * k + 0.12 * Math.sin(f.t * 55));
      for (const [j, x] of [f.a, f.b].entries()) {
        const c = f.color[j];
        x.color = [c[0] + (1 - c[0]) * glow, c[1] + (1 - c[1]) * glow, c[2] + (1 - c[2]) * glow];
        x.jkv += (j ? -1 : 1) * 0.6;
      }
      const d = Math.hypot(f.b.cx - f.a.cx, f.b.cy - f.a.cy);
      if (f.t >= FUSE_TIME || d < (f.a.halfWidth + f.b.halfWidth) * 0.42) {
        done.push(f);
        return false;
      }
      return true;
    });
    for (const f of done) this.merge(f.a, f.b);
  }

  private stepShake(dt: number) {
    this.quake = Math.max(0, this.quake - dt * 3);
    const c = this.ctx.canvas;
    if (this.quake <= 0) {
      if (c.style.transform) c.style.transform = '';
      return;
    }
    const a = this.quake * this.quake * 7;
    c.style.transform = `translate(${(Math.sin(this.time * 91) * a).toFixed(2)}px, ${(Math.cos(this.time * 77) * a).toFixed(2)}px)`;
  }

  private merge(a: Body, b: Body) {
    const w = this.world;
    const t = this.tiers.get(a)!;
    const ma = a.count, mb = b.count;
    const cx = (a.cx * ma + b.cx * mb) / (ma + mb);
    const cy = (a.cy * ma + b.cy * mb) / (ma + mb);
    const vx = (a.vx * ma + b.vx * mb) / (ma + mb);
    const vy = (a.vy * ma + b.vy * mb) / (ma + mb);
    let ax = b.cx - a.cx, ay = b.cy - a.cy;
    const al = Math.hypot(ax, ay) || 1;
    ax /= al;
    ay /= al;
    for (const x of [a, b]) {
      this.tiers.delete(x);
      this.growing.delete(x);
    }
    const ia = w.bodies.indexOf(a), ib = w.bodies.indexOf(b);
    w.remove(Math.max(ia, ib));
    w.remove(Math.min(ia, ib));
    this.combo += 1;
    this.comboClock = 1.3;
    if (t === LAST) {
      // Two giant Bobos pop into confetti.
      this.burst(cx, cy, 70, FRUIT[LAST].color, 0.5);
      this.score += 200;
      this.ctx.haptic('heavy');
      this.ctx.celebrate('Double Bobo!');
    } else {
      const nt = t + 1;
      const nb = this.spawnTier(nt, cx, cy);
      if (nb) {
        const s0 = Math.max(0.55, this.radius(t) / this.radius(nt));
        // Start at the parents' size, stretched along the line they met on (area kept), so the
        // new gummy visibly springs round out of the squeezed pair; grow() then swells it up.
        const along = 1.38, across = 1 / along;
        for (let i = nb.start; i < nb.start + nb.count; i++) {
          for (const arr of [w.pos, w.prev]) {
            const px = (arr[i * 2] - cx) * s0, py = (arr[i * 2 + 1] - cy) * s0;
            const u = px * ax + py * ay, v = -px * ay + py * ax;
            arr[i * 2] = cx + ax * u * along - ay * v * across;
            arr[i * 2 + 1] = cy + ay * u * along + ax * v * across;
          }
          w.vel[i * 2] = vx;
          w.vel[i * 2 + 1] = vy + 0.4;
        }
        scaleBody(nb, s0);
        nb.cx = cx;
        nb.cy = cy;
        w.evict(nb);
        this.growing.set(nb, { s: s0, v: 2.5 });
        nb.jsv = 1.2 + nt * 0.12;
        nb.age = 0.31;
        w.wakeAround(nb);
        this.shockwave(nb, cx, cy, this.radius(nt), nt);
      }
      this.score += ((nt + 1) * (nt + 2)) / 2;
      this.burst(cx, cy, 10 + nt * 3, FRUIT[nt].color, this.radius(nt));
      this.fx.push({ x: cx, y: cy, vx: 0, vy: 0, life: 0, max: 0.32 + nt * 0.015, size: this.radius(nt) * 2.2, kind: 3, color: [1, 1, 1] });
      this.hitstop = 0.035 + nt * 0.006;
      if (nt >= 5) this.quake = Math.min(1, 0.35 + (nt - 5) * 0.12);
      this.ctx.haptic(nt >= 7 ? 'heavy' : nt >= 4 ? 'medium' : 'light');
      if (nt > this.maxTier) {
        this.maxTier = nt;
        if (nt === LAST) this.ctx.celebrate(`${FRUIT[LAST].name}!`);
        else if (nt >= 7) this.ctx.celebrate(`New: ${FRUIT[nt].name}`);
      }
    }
    if (this.combo >= 2) {
      this.comboEl.textContent = `combo ×${this.combo}`;
      this.comboEl.classList.remove('show');
      void this.comboEl.offsetWidth;
      this.comboEl.classList.add('show');
    }
    if (this.score > this.best) {
      this.best = this.score;
      try {
        localStorage.setItem('bobo.merge.best', String(this.best));
      } catch {
        /* private mode: best just isn't remembered */
      }
    }
    this.updateHud();
  }

  /** The pop pushes nearby gummies away, strongest up close: the pile visibly jolts and jiggles. */
  private shockwave(nb: Body, x: number, y: number, radius: number, tier: number) {
    const w = this.world;
    const R = radius * 2.4 + 0.05;
    const kick = 0.9 + tier * 0.12;
    const hit = new Set<Body>();
    for (const o of w.bodies) {
      if (o === nb || Math.hypot(o.cx - x, o.cy - y) > R + o.ext) continue;
      for (let i = o.start; i < o.start + o.count; i++) {
        const dx = w.pos[i * 2] - x, dy = w.pos[i * 2 + 1] - y;
        const d = Math.hypot(dx, dy);
        if (d > R || d < 1e-6) continue;
        const f = kick * (1 - d / R) ** 2;
        w.vel[i * 2] += (dx / d) * f;
        w.vel[i * 2 + 1] += (dy / d) * f + f * 0.3;
        hit.add(o);
      }
    }
    for (const o of hit) {
      w.wake(o);
      o.jsv += kick * 1.5;
    }
  }

  private burst(x: number, y: number, n: number, color: [number, number, number], radius: number) {
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.4 + Math.random() * 1.2;
      this.fx.push({
        x: x + Math.cos(a) * radius * 0.6,
        y: y + Math.sin(a) * radius * 0.6,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp + 0.4,
        life: 0,
        max: 0.5 + Math.random() * 0.5,
        size: 0.008 + Math.random() * 0.012,
        kind: 2,
        color: k % 3 === 0 ? [1, 1, 1] : [Math.min(1, color[0] + 0.3), Math.min(1, color[1] + 0.3), Math.min(1, color[2] + 0.3)],
      });
    }
    if (this.fx.length > 400) this.fx.splice(0, this.fx.length - 400);
  }

  /** Overfull for two seconds: in Zen mode the smallest gummy poofs away, otherwise the jar is full. */
  private checkFull(dt: number) {
    const top = this.jar[3];
    let over = false;
    for (const b of this.world.bodies) if (b.age > 1.5 && b.cy + b.halfHeight > top && Math.hypot(b.vx, b.vy) < 0.6) over = true;
    this.overfull = over ? this.overfull + dt : Math.max(0, this.overfull - dt * 2);
    if (this.overfull < 2 || this.full) return;
    if (this.cfg.zen) {
      let smallest = -1;
      let st = Infinity;
      this.world.bodies.forEach((b, i) => {
        const t = this.tiers.get(b) ?? 0;
        if (t < st) {
          st = t;
          smallest = i;
        }
      });
      if (smallest >= 0) {
        const b = this.world.bodies[smallest];
        this.burst(b.cx, b.cy, 12, b.color, this.radius(st));
        this.tiers.delete(b);
        this.growing.delete(b);
        this.world.remove(smallest);
      }
      this.overfull = 1;
      return;
    }
    this.full = true;
    this.held.clear();
    this.card.querySelector('span')!.textContent = `score ${this.score}`;
    this.card.hidden = false;
    this.ctx.haptic('medium');
  }

  private shake() {
    const w = this.world;
    // Knock the top few smallest gummies out and give the rest a good jiggle.
    const order = w.bodies.map((b, i) => [this.tiers.get(b) ?? 0, i] as const).sort((x, y) => x[0] - y[0]);
    const drop = order.slice(0, 4).map(([, i]) => i).sort((a, b) => b - a);
    for (const i of drop) {
      const b = w.bodies[i];
      this.burst(b.cx, b.cy, 8, b.color, 0.05);
      this.tiers.delete(b);
      this.growing.delete(b);
      w.remove(i);
    }
    for (const b of w.bodies) {
      w.wake(b);
      const kx = (Math.random() - 0.5) * 2.5;
      for (let i = b.start; i < b.start + b.count; i++) {
        w.vel[i * 2] += kx;
        w.vel[i * 2 + 1] += 2.5;
      }
    }
    this.full = false;
    this.overfull = 0;
    this.card.hidden = true;
    this.loadHeld();
    this.ctx.haptic('heavy');
  }

  /** Landings: soft dust and a tick scaled by impact speed. */
  private react() {
    const w = this.world;
    for (const im of w.impacts) {
      if (im.strength > 1.2) this.ctx.haptic(im.strength > 3 ? 'medium' : 'light');
      if (im.ground && im.strength > 1.5)
        for (let k = 0; k < 4; k++)
          this.fx.push({
            x: im.x + (Math.random() - 0.5) * 0.08,
            y: im.y + 0.01,
            vx: (Math.random() - 0.5) * 0.3,
            vy: 0.1 + Math.random() * 0.15,
            life: 0,
            max: 0.5,
            size: 0.02,
            kind: 1,
            color: [1, 0.95, 0.92],
          });
    }
    w.impacts.length = 0;
  }

  private stepFx(dt: number) {
    for (const f of this.fx) {
      f.life += dt;
      if (f.kind !== 3) f.vy -= 1.5 * dt;
      f.x += f.vx * dt;
      f.y += f.vy * dt;
    }
    this.fx = this.fx.filter((f) => f.life < f.max);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.layout();
    this.reset();
  }

  destroy() {
    this.hud.remove();
    this.style.remove();
    this.ctx.canvas.style.transform = '';
    this.renderer.destroy();
  }
}

/** Uniformly scale a body's rest shape (particles follow through shape matching). */
function scaleBody(b: Body, f: number) {
  for (let k = 0; k < b.q.length; k++) b.q[k] *= f;
  for (let k = 0; k < b.verts.length; k++) b.verts[k] *= f;
  b.ext *= f;
  b.halfWidth *= f;
  b.halfHeight *= f;
}

function css(c: [number, number, number]) {
  return `rgb(${c.map((v) => Math.round(v * 255)).join(',')})`;
}

const STYLE = `
.merge-hud { position: absolute; inset: 0; pointer-events: none; font-family: ui-rounded, -apple-system, system-ui, sans-serif; }
.merge-score { position: absolute; left: calc(16px + env(safe-area-inset-left, 0px)); top: calc(60px + env(safe-area-inset-top, 0px)); color: #3b1a3a; }
.merge-score b { display: block; font-size: 34px; font-weight: 800; letter-spacing: -0.03em; line-height: 1; text-shadow: 0 2px 0 rgba(255,255,255,0.7); }
.merge-score span { font-size: 12px; font-weight: 700; opacity: 0.55; }
.merge-next { position: absolute; right: calc(20px + env(safe-area-inset-right, 0px)); top: calc(112px + env(safe-area-inset-top, 0px)); display: flex; flex-direction: column; align-items: center; gap: 4px; color: #3b1a3a; font-size: 11px; font-weight: 700; opacity: 0.8; }
.merge-next i { display: block; width: var(--s); height: var(--s); border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff8 0 20%, transparent 45%), var(--c); box-shadow: 0 2px 6px rgba(60,20,50,0.3); transition: all .2s; }
.merge-combo { position: absolute; left: calc(16px + env(safe-area-inset-left, 0px)); top: calc(112px + env(safe-area-inset-top, 0px)); transform-origin: left center; transform: scale(0.6); opacity: 0; font-size: 18px; font-weight: 800; color: #ff2f6d; text-shadow: 0 2px 0 #fff; }
.merge-combo.show { animation: merge-pop 1.2s ease-out forwards; }
@keyframes merge-pop { 0% { opacity: 0; transform: translateY(6px) scale(0.6); } 15% { opacity: 1; transform: translateY(0) scale(1.15); } 70% { opacity: 1; transform: translateY(-4px) scale(1); } 100% { opacity: 0; transform: translateY(-10px) scale(1); } }
.merge-ladder { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(14px + env(safe-area-inset-bottom, 0px)); display: flex; align-items: center; gap: 5px; padding: 6px 10px; border-radius: 99px; background: rgba(255,255,255,0.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.merge-ladder i { display: block; width: var(--s); height: var(--s); border-radius: 50%; background: var(--c); opacity: 0.25; transition: opacity .3s, transform .3s; }
.merge-ladder i.on { opacity: 1; transform: scale(1.1); }
.merge-card { position: absolute; left: 50%; top: 42%; transform: translate(-50%, -50%); pointer-events: auto; padding: 18px 20px; border-radius: 20px; background: rgba(255,255,255,0.92); box-shadow: 0 12px 40px rgba(60,20,50,0.25); text-align: center; color: #3b1a3a; }
.merge-card[hidden] { display: none; }
.merge-card b { display: block; font-size: 24px; font-weight: 800; }
.merge-card span { display: block; margin: 4px 0 12px; opacity: 0.7; font-weight: 700; }
.merge-card button { margin: 0 4px; padding: 10px 14px; border: 0; border-radius: 12px; background: #ff2f6d; color: #fff; font: 700 14px/1 inherit; cursor: pointer; }
.merge-card button + button { background: #3b1a3a; }
`;
