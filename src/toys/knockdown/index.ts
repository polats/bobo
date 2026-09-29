import type { PlayOpts, Voice } from '../../shell/sound';
import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Kind, Shape, World, type Body } from './physics';
import { DECAL, DECAL_RECT, FLOATS, KnockdownRenderer, Sprite } from './render';
import { shatterPatterns } from './shatter';
import { COUNTER, FLOOR, MATERIALS, randomStall, shotsFor, type Mat, type ShelfSpec, type StallSpec } from './stall';

export const knockdownToy: Toy = {
  id: 'knockdown',
  title: 'Knockdown',
  blurb: 'A fairground stall of tin cans, jam jars and crates. Pull back the slingshot and clear every shelf; glass shatters, jam splats.',
  tech: 'Soft-step rigid bodies · Voronoi shatter · WebGL2',
  swatch: 'repeating-linear-gradient(90deg,#dd2433 0 18px,#f6eee0 18px 36px)',
  refs: [
    {
      short: 'Box2D v3',
      title: 'Erin Catto — Releasing Box2D 3.0 (2024)',
      url: 'https://box2d.org/posts/2024/08/releasing-box2d-3.0/',
      use: 'The soft-step solver shared with Demolition Tower, and its restitution pass run after the substeps.',
    },
    {
      short: 'Box2D 3.1',
      title: 'Erin Catto — Box2D 3.1 (2025)',
      url: 'https://box2d.org/posts/2025/04/box2d-3.1/',
      use: 'Rolling resistance per material: cans roll away, crates stay put.',
    },
    {
      short: 'DeepFracture',
      title: 'DeepFracture: a generative approach for predicting brittle fractures (Huang et al.)',
      url: 'https://nikoloside.graphics/deepfracture/',
      use: 'Picking a fracture pattern by where the blow lands; here three pre-baked Voronoi patterns per jar.',
    },
    {
      short: 'Juice it',
      title: 'Juice it or lose it (Jonasson & Purho, 2012)',
      url: 'https://www.youtube.com/watch?v=Fy0aCDmgnxg',
      use: 'Hit-stop, slow motion on the last item, screen shake and particles that sell each impact.',
    },
  ],
  async create(ctx) {
    return new Knockdown(ctx);
  },
};

interface Item {
  body: Body;
  mat: Mat;
  color: number;
  /** Can label style, a jar's jam fill level, or 1 once a crate has cracked. */
  alt: number;
  cleared: boolean;
  broken: boolean;
  clearedAt: number;
  fade: number;
  lastHit: number;
  /** How far back on its shelf it has been knocked (m), and how fast it's sliding back. */
  z: number;
  vz: number;
  /** Knocked off the back of the shelf: falling out of sight behind it. */
  behind: boolean;
  /** Ball hits taken (crates crack on the first). */
  hits: number;
  /** Tip-back angle (radians, about the item's horizontal axis) for drawing it tumbling away. */
  tumble: number;
}

interface Debris {
  body: Body;
  kind: 'shard' | 'plank' | 'lid';
  life: number;
  color: number;
  shape: number;
  /** Shards from the jam-filled bottom of a jar carry a smear of it. */
  jam: boolean;
  lastHit: number;
}

interface Ball {
  body: Body;
  age: number;
  /** Launch vy: while rising the ball is in front of the stall, drawn bigger the nearer it is. */
  vy0: number;
  /** Speed into the stall (m/s), spent on what it hits. */
  vf: number;
  /** Items it has already struck (each takes one forward hit). */
  hit: Set<Item>;
  /** Hit something face-on as it arrived and bounced back out of the stall: stays a ghost. */
  bounced: boolean;
}

const enum P {
  Drop = 0,
  Spark = 1,
  Chip = 2,
}

interface Particle {
  alive: boolean;
  type: P;
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  r: number;
  g: number;
  b: number;
  a: number;
  va: number;
}

interface Pending {
  at: number;
  voice: Voice;
  opts: PlayOpts;
}

type State = 'play' | 'done' | 'over';

const MAX_PARTICLES = 700;
const MAX_DEBRIS = 150;
const BALL_R = 0.24;
const REST: [number, number] = [0, 2.15];
const TIPS: [number, number][] = [
  [-0.44, 2.3],
  [0.44, 2.3],
];
const MAX_PULL = 1.5;
/** Launch speed per metre of pull (m/s); full pull is 24 m/s, enough to lob onto the top shelf. */
const POWER = 16;
/** The thrown ball falls this much faster than the stall's contents: a snappy arc, not a floaty one. */
const BALL_G = 2.2;
const STAMP = 32;
/** Shelf depth (m): knock an item back further than this and it drops off the back. */
const DEPTH = 0.5;
/** The ball's speed into the stall: a base plus a share of the throw's in-plane speed. */
const FORWARD = 6;
const FORWARD_K = 0.2;
/** Restitution of the forward hit. */
const FORWARD_E = 0.3;
/** Share of a shove passed on to each touching neighbour. */
const SPREAD = 0.7;
/** Extra size of the ball when it leaves the slingshot, nearest the viewer. */
const NEAR = 0.35;

class Knockdown implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private renderer: KnockdownRenderer;
  private world!: World;
  private stall!: StallSpec;
  private width = 1;
  private height = 1;
  private viewW = 8.4;
  private viewH = 20;
  private cx = 0;
  private cy = 10;
  private items: Item[] = [];
  private owner = new Map<Body, Item>();
  private debris: Debris[] = [];
  private debrisOf = new Map<Body, Debris>();
  private balls: Ball[] = [];
  private particles: Particle[] = [];
  private pending: Pending[] = [];
  private inst = new Float32Array(2048 * FLOATS);
  private count = 0;
  private time = 0;
  private simMs = 0;
  private shake = 0;
  private hitStop = 0;
  private slow = 0;
  private finalFx = false;
  private shots = 0;
  private bonusUsed = false;
  private reload = 0;
  private settle = 0;
  private sinceLaunch = 0;
  private state: State = 'play';
  private stateTime = 0;
  private cleared = 0;
  private celebrated = false;
  private lowestShelf = 0;
  private lastSplash = 0;
  private bannerUntil = Infinity;
  private rollCool = 0;
  private splatDiscs: number[] = [];
  /** Dev-only: the biggest per-step velocity jump a breakable item has taken. */
  private maxDv = 0;
  /** Dev-only: items each finished ball struck. */
  private hitLog: number[] = [];
  private aim: { id: number; sx: number; sy: number; ox: number; oy: number } | null = null;
  private hud: HTMLElement;
  private ballsEl!: HTMLElement;
  private banner!: HTMLElement;
  private newBtn!: HTMLButtonElement;
  private style: HTMLStyleElement;

  readonly cfg = { power: 1, gravity: 10, glass: 1, endless: false };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.renderer = new KnockdownRenderer(gl);
    for (let i = 0; i < MAX_PARTICLES; i++)
      this.particles.push({ alive: false, type: P.Drop, x: 0, y: 0, vx: 0, vy: 0, life: 0, max: 1, size: 0, r: 0, g: 0, b: 0, a: 0, va: 0 });
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hud = this.buildHud();
    this.buildPanel();
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.fitView();
    this.newStall();
    if (import.meta.env.DEV) {
      // Dev-only probes for headless tests.
      (window as unknown as Record<string, unknown>).__knockdown = {
        stats: () => ({
          layout: this.stall.layout,
          total: this.items.length,
          cleared: this.cleared,
          shots: this.shots,
          bonusUsed: this.bonusUsed,
          state: this.state,
          celebrated: this.celebrated,
          bodies: this.world.bodies.length,
          debris: this.debris.length,
          balls: this.balls.length,
          asleep: this.world.sleepingCount,
          broken: this.items.filter((i) => i.broken).length,
          sim: +this.simMs.toFixed(2),
          maxDv: +this.maxDv.toFixed(2),
          hitLog: this.hitLog.join(','),
        }),
        targets: () => this.items.filter((i) => !i.cleared).map((i) => [i.body.x, i.body.y, i.mat]),
        fire: (vx: number, vy: number) => this.launch(REST[0], REST[1], vx, vy),
        endless: (on: boolean) => {
          this.cfg.endless = on;
          this.updateHud();
        },
        rest: () => REST,
        gravity: () => this.cfg.gravity * BALL_G,
        newStall: () => this.newStall(),
        snap: () => this.items.filter((i) => i.body.alive).map((i) => [i.body.x, i.body.y, i.body.a, i.body.sleeping]),
      };
    }
  }

  // ------------------------------------------------------------------ setup

  private fitView() {
    const aspect = this.width / this.height;
    if (aspect < 0.62) {
      this.viewW = 8.4;
      this.viewH = this.viewW / aspect;
    } else {
      this.viewH = 17;
      this.viewW = this.viewH * aspect;
    }
    this.cx = 0;
    this.cy = this.viewH / 2;
  }

  private newStall() {
    const w = new World();
    w.substeps = 4;
    w.gravity = -this.cfg.gravity;
    this.world = w;
    this.stall = randomStall(this.stall?.layout ?? -1);
    // The stall floor behind the counter, then the shelves; balls fly up through both.
    w.add({ shape: Shape.Box, kind: Kind.Static, x: 0, y: FLOOR - 0.5, hx: 40, hy: 0.5, friction: 0.7, oneWay: true });
    this.lowestShelf = Infinity;
    for (const s of this.stall.shelves) {
      w.add({ shape: Shape.Box, kind: Kind.Static, x: (s.x0 + s.x1) / 2, y: s.y - 0.09, hx: (s.x1 - s.x0) / 2, hy: 0.09, friction: 0.7, oneWay: true });
      this.lowestShelf = Math.min(this.lowestShelf, s.y);
    }
    this.items = [];
    this.owner.clear();
    for (const it of this.stall.items) {
      const m = MATERIALS[it.mat];
      const body = w.add({
        shape: Shape.Box,
        x: it.x,
        y: it.y + 0.001,
        hx: it.hx,
        hy: it.hy,
        density: m.density,
        friction: m.friction,
        restitution: m.restitution,
        rolling: m.rolling,
        sleeping: true,
      });
      const item: Item = {
        body,
        mat: it.mat,
        color: it.color,
        alt: it.mat === 'jar' ? 0.62 + Math.random() * 0.14 : it.mat === 'can' && Math.random() < 0.5 ? 1 : 0,
        cleared: false,
        broken: false,
        clearedAt: 0,
        fade: 1,
        lastHit: 0,
        z: 0,
        vz: 0,
        behind: false,
        hits: 0,
        tumble: 0,
      };
      this.items.push(item);
      this.owner.set(body, item);
    }
    this.debris = [];
    this.debrisOf.clear();
    this.balls = [];
    for (const p of this.particles) p.alive = false;
    this.pending.length = 0;
    this.renderer.clearDecal();
    this.shots = shotsFor(this.items.length);
    if (import.meta.env.DEV) this.hitLog = [];
    this.bonusUsed = false;
    this.cleared = 0;
    this.celebrated = false;
    this.finalFx = false;
    this.hitStop = this.slow = 0;
    this.reload = 0.2;
    this.settle = 0;
    this.aim = null;
    this.setState('play');
    this.hideBanner();
    this.updateHud();
  }

  private setState(s: State) {
    this.state = s;
    this.stateTime = 0;
    this.newBtn.classList.toggle('pulse', s !== 'play');
  }

  private buildHud() {
    const hud = document.createElement('div');
    hud.className = 'kd-hud';
    this.ballsEl = document.createElement('div');
    this.ballsEl.className = 'kd-balls';
    this.banner = document.createElement('div');
    this.banner.className = 'kd-banner';
    this.banner.hidden = true;
    this.newBtn = document.createElement('button');
    this.newBtn.type = 'button';
    this.newBtn.className = 'kd-new';
    this.newBtn.textContent = '↻ New stall';
    this.newBtn.addEventListener('click', () => this.newStall());
    hud.append(this.ballsEl, this.banner, this.newBtn);
    this.ctx.overlay.appendChild(hud);
    return hud;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.slider(c, 'power', { label: 'Slingshot power', min: 0.6, max: 1.5, step: 0.05 });
    panel.slider(c, 'gravity', { label: 'Gravity', min: 4, max: 20, step: 0.5, onChange: () => (this.world.gravity = -c.gravity) });
    panel.slider(c, 'glass', { label: 'Glass strength', min: 0.4, max: 3, step: 0.05 });
    panel.toggleSwitch(c, 'endless', 'Endless balls', () => this.updateHud());
    panel.action('New stall', () => this.newStall());
  }

  private updateHud() {
    const n = this.cfg.endless ? 0 : this.shots;
    let html = '';
    for (let i = 0; i < n; i++) html += `<i class="${this.bonusUsed ? 'bonus' : ''}"></i>`;
    this.ballsEl.innerHTML = this.cfg.endless ? '<span>∞</span>' : html;
  }

  private showBanner(title: string, sub: string, hold = Infinity) {
    this.bannerUntil = this.time + hold;
    this.banner.innerHTML = `<b>${title}</b><span>${sub}</span>`;
    this.banner.hidden = false;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth;
    this.banner.classList.add('show');
  }

  private hideBanner() {
    this.banner.hidden = true;
    this.banner.classList.remove('show');
  }

  // ------------------------------------------------------------------ frame

  frame(dt: number, t: number) {
    this.time = t;
    this.stateTime += dt;
    this.handleInput();
    // Time: a dead stop for the hit-stop, then slow motion while the last item falls.
    let scale = 1;
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      scale = 0;
    } else if (this.slow > 0) {
      this.slow -= dt;
      scale = 0.35;
    }
    if (import.meta.env.DEV) scale *= (window as unknown as { __slow?: number }).__slow ?? 1;
    const sdt = dt * scale;
    const t0 = performance.now();
    if (sdt > 0) {
      this.world.step(sdt);
      this.breaks(sdt);
      this.pushBack();
      this.impactSounds();
    }
    this.simMs = this.simMs * 0.9 + (performance.now() - t0) * 0.1;
    this.updateItems(dt, sdt);
    this.updateDebris(sdt);
    this.updateParticles(sdt);
    this.world.compact();
    this.playPending();
    this.turn(dt);
    if (this.time > this.bannerUntil) this.hideBanner();
    this.shake *= Math.exp(-dt * 10);
    this.render(t);
    this.ctx.progress(this.items.length ? this.cleared / this.items.length : 0, 'cleared');
    this.ctx.setStatus(
      `${this.items.length - this.cleared}/${this.items.length} left · ${this.cfg.endless ? '∞' : this.shots} balls · ${this.world.bodies.length} bodies · sim ${this.simMs.toFixed(1)}ms`,
    );
  }

  private toWorld(u: number, v: number): [number, number] {
    return [this.cx + (u - 0.5) * this.viewW, this.cy + (v - 0.5) * this.viewH];
  }

  private handleInput() {
    const ptrs = this.ctx.pointers.active;
    for (const p of ptrs.values()) {
      if (!p.justDown || this.aim) continue;
      const [x, y] = this.toWorld(p.x, p.y);
      if (this.state !== 'play') {
        // After a clear or the last ball, a tap re-racks.
        if (this.stateTime > 0.8) this.newStall();
        return;
      }
      if (this.canShoot()) {
        this.aim = { id: p.id, sx: x, sy: y, ox: 0, oy: 0 };
        this.ctx.sound.play('tick', { pitch: 0.9, gain: 0.35 });
      }
    }
    const a = this.aim;
    if (!a) return;
    const p = ptrs.get(a.id);
    if (p) {
      // Relative drag from wherever the finger went down; the pouch can't be pushed forward.
      const [x, y] = this.toWorld(p.x, p.y);
      let ox = x - a.sx, oy = Math.min(0.2, y - a.sy);
      const l = Math.hypot(ox, oy);
      if (l > MAX_PULL) {
        ox *= MAX_PULL / l;
        oy *= MAX_PULL / l;
      }
      oy = Math.max(oy, 0.65 - REST[1]);
      a.ox = ox;
      a.oy = oy;
      return;
    }
    // Released.
    this.aim = null;
    if (Math.hypot(a.ox, a.oy) < 0.3 || !this.canShoot()) return;
    const k = POWER * this.cfg.power;
    this.launch(REST[0] + a.ox, REST[1] + a.oy, -a.ox * k, -a.oy * k);
  }

  private canShoot() {
    return this.state === 'play' && (this.shots > 0 || this.cfg.endless) && this.reload <= 0;
  }

  private launch(x: number, y: number, vx: number, vy: number) {
    if (!this.canShoot()) return false;
    const body = this.world.add({
      shape: Shape.Circle,
      kind: Kind.Cannonball,
      r: BALL_R,
      x,
      y,
      vx,
      vy,
      w: (Math.random() - 0.5) * 6,
      density: 5,
      friction: 0.5,
      restitution: 0.3,
      rolling: 0.08,
      gravityScale: BALL_G,
      // A thrown ball flies into the stall: it passes in front of everything while rising and
      // reaches the shelves' plane at the top of its arc.
      ghost: vy > 0,
    });
    const sp0 = Math.hypot(vx, vy);
    this.balls.push({ body, age: 0, vy0: Math.max(1, vy), vf: FORWARD + FORWARD_K * sp0, hit: new Set(), bounced: false });
    if (!this.cfg.endless) this.shots--;
    this.reload = 0.35;
    this.sinceLaunch = 0;
    this.settle = 0;
    this.updateHud();
    const sp = Math.hypot(vx, vy);
    this.ctx.sound.play('whoosh', { pitch: 0.8 + Math.min(0.6, sp * 0.025), gain: Math.min(1, 0.3 + sp / 25), pan: this.pan(x) });
    this.ctx.sound.play('snap', { pitch: 0.7, gain: 0.25, pan: this.pan(x) });
    this.ctx.haptic('light');
    return true;
  }

  // ------------------------------------------------------------------ breaking

  /** Per-material break test: the velocity jump this step, minus gravity. */
  private breaks(sdt: number) {
    const g = this.world.gravity;
    for (const it of this.items) {
      const b = it.body;
      if (it.broken || !b.alive || b.sleeping || b.age < 0.15) continue;
      const lim = MATERIALS[it.mat].breakDv * (it.mat === 'jar' ? this.cfg.glass : 1);
      if (lim === Infinity) continue;
      const dv = Math.hypot(b.vx - b.svx, b.vy - (b.svy + g * sdt));
      if (import.meta.env.DEV) this.maxDv = Math.max(this.maxDv, dv);
      if (dv < lim) continue;
      const [px, py] = this.hitPoint(b);
      if (it.mat === 'jar') this.shatter(it, px, py, dv);
      else this.splinter(it, dv);
    }
  }

  /**
   * The third dimension of a fairground throw: the ball is flying into the stall, and the first
   * time it touches an item it hands over part of that forward speed (a 1D collision with the
   * masses of both). The item slides back along its shelf and, past the back edge, drops out of
   * sight. The same velocity jump shatters glass; crates crack on the first hit, splinter on the
   * second. An item shoved back hard drags its neighbours part of the way.
   */
  private pushBack() {
    for (const m of this.world.manifolds.values()) {
      const a = m.a, b = m.b;
      if ((a.sleeping || a.invMass === 0) && (b.sleeping || b.invMass === 0)) continue;
      let imp = 0, px = 0, py = 0;
      for (const p of m.points)
        if (p.maxImp > imp) {
          imp = p.maxImp;
          px = p.px;
          py = p.py;
        }
      if (imp <= 0) continue;
      const ia = this.owner.get(a), ib = this.owner.get(b);
      const ballBody = a.kind === Kind.Cannonball ? a : b.kind === Kind.Cannonball ? b : null;
      if (ballBody) {
        const it = ia ?? ib;
        const bl = this.balls.find((x) => x.body === ballBody);
        if (it && bl) this.strike(bl, it, px, py);
      } else if (ia && ib && !ia.behind && !ib.behind) {
        if (ia.vz > 1.2) ib.vz = Math.max(ib.vz, ia.vz * 0.5);
        if (ib.vz > 1.2) ia.vz = Math.max(ia.vz, ib.vz * 0.5);
      }
    }
  }

  /** One forward hit of a ball on an item (at most once per pair). */
  private strike(bl: Ball, it: Item, px: number, py: number) {
    if (it.behind || it.broken || bl.hit.has(it)) return;
    bl.hit.add(it);
    const mb = bl.body.mass, mi = it.body.mass;
    const dv = (bl.vf * (1 + FORWARD_E) * mb) / (mb + mi);
    bl.vf = Math.max(0, (bl.vf * (mb - FORWARD_E * mi)) / (mb + mi));
    it.hits++;
    const mat = MATERIALS[it.mat];
    const lim = mat.breakDv * (it.mat === 'jar' ? this.cfg.glass : 1);
    if (dv > lim || (mat.hits && it.hits >= mat.hits)) {
      // Flying glass and splinters shove the neighbours too.
      this.spread(it, dv * 0.8);
      if (it.mat === 'jar') this.shatter(it, px, py, dv);
      else this.splinter(it, dv);
      return;
    }
    it.vz += dv;
    this.spread(it, dv);
    this.voice(it.body, 4 + dv, px, py);
    if (it.mat === 'crate') {
      // First hit on a crate: it cracks.
      it.alt = 1;
      this.ctx.sound.play('snap', { pitch: 1.1, gain: 0.45, pan: this.pan(px) });
    }
    this.ctx.haptic(dv > 6 ? 'medium' : 'light');
  }

  /**
   * A shoved item knocks back what it touches, and those knock the next: a share of the push goes
   * to each neighbour within reach, scaled by their masses, until it's too weak to matter.
   */
  private spread(from: Item, dv: number) {
    const q: [Item, number][] = [[from, dv]];
    const seen = new Set<Item>([from]);
    while (q.length) {
      const [a, v] = q.shift()!;
      const A = a.body;
      this.world.wake(A);
      for (const it of this.items) {
        if (seen.has(it) || it.behind || it.broken || !it.body.alive) continue;
        const B = it.body;
        // Gap between the two outlines (upright boxes; close enough for resting stacks).
        const gx = Math.abs(B.x - A.x) - extX(A) - extX(B), gy = Math.abs(B.y - A.y) - extY(A) - extY(B);
        if (Math.max(gx, gy) > 0.12) continue;
        const share = v * SPREAD * Math.min(1.2, Math.sqrt(A.mass / B.mass));
        if (share < 1) continue;
        seen.add(it);
        it.vz = Math.max(it.vz, share);
        q.push([it, share]);
      }
    }
  }

  /** The item whose outline the point is over, if any. */
  private itemAt(x: number, y: number, pad: number): Item | null {
    for (const it of this.items) {
      const b = it.body;
      if (!b.alive || it.behind) continue;
      const dx = x - b.x, dy = y - b.y;
      const lx = b.c * dx + b.s * dy, ly = -b.s * dx + b.c * dy;
      if (Math.abs(lx) < b.hx + pad && Math.abs(ly) < b.hy + pad) return it;
    }
    return null;
  }

  /** Where the body took its hardest contact this step. */
  private hitPoint(b: Body): [number, number] {
    let best = -1, px = b.x, py = b.y;
    for (const m of this.world.manifolds.values()) {
      if (m.a !== b && m.b !== b) continue;
      for (const p of m.points)
        if (p.maxImp > best) {
          best = p.maxImp;
          px = p.px;
          py = p.py;
        }
    }
    return [px, py];
  }

  private shatter(it: Item, px: number, py: number, dv: number) {
    const w = this.world, b = it.body;
    it.broken = true;
    w.remove(b);
    const lx = b.c * (px - b.x) + b.s * (py - b.y);
    const pattern = shatterPatterns(b.hx, b.hy)[lx < -0.3 * b.hx ? 0 : lx > 0.3 * b.hx ? 2 : 1];
    const fill = b.hy * (it.alt * 2 - 1) - b.hy * 0.14;
    const burst = Math.min(1.6, 0.6 + dv * 0.12);
    for (const pc of pattern) {
      if (this.debris.length >= MAX_DEBRIS) break;
      const x = b.x + b.c * pc.x - b.s * pc.y, y = b.y + b.s * pc.x + b.c * pc.y;
      let dx = x - px, dy = y - py;
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      const sp = (1.5 + Math.random() * 2.5) * burst;
      const body = w.add({
        shape: Shape.Box,
        x,
        y,
        a: b.a + pc.a,
        hx: pc.hx,
        hy: pc.hy,
        vx: b.vx * 0.5 + dx * sp,
        vy: b.vy * 0.5 + dy * sp + 1.2,
        w: (Math.random() - 0.5) * 16,
        density: 1.2,
        friction: 0.4,
        restitution: 0.25,
      });
      this.addDebris({ body, kind: 'shard', life: 1.5 + Math.random() * 0.3, color: it.color, shape: pc.shape / 3 + 0.1, jam: pc.y < fill, lastHit: 0 });
    }
    // The gingham lid pops off.
    if (this.debris.length < MAX_DEBRIS) {
      const lx2 = -b.s * b.hy * 0.84, ly2 = b.c * b.hy * 0.84;
      const lid = w.add({
        shape: Shape.Box,
        x: b.x + lx2,
        y: b.y + ly2,
        a: b.a,
        hx: b.hx * 0.86,
        hy: b.hy * 0.16,
        vx: b.vx * 0.5 + (Math.random() - 0.5) * 3,
        vy: b.vy * 0.5 + 3 + Math.random() * 2,
        w: (Math.random() - 0.5) * 14,
        density: 0.6,
        friction: 0.6,
        restitution: 0.2,
      });
      this.addDebris({ body: lid, kind: 'lid', life: 2.5, color: 0xc41a2c, shape: 0, jam: false, lastHit: 0 });
    }
    // Jam: 20-40 ballistic droplets that splat onto the wall or the shelves.
    const [r, g, bl] = rgb(it.color);
    const n = 20 + Math.round(Math.min(20, dv * 2));
    for (let i = 0; i < n; i++) {
      const a = Math.PI * (0.05 + Math.random() * 0.9) + (Math.random() < 0.25 ? Math.PI : 0);
      const sp = (1.5 + Math.random() * 4.5) * burst;
      this.spawn(P.Drop, b.x + (Math.random() - 0.5) * b.hx, b.y - b.hy * 0.3 + Math.random() * b.hy * 0.5, b.vx * 0.3 + Math.cos(a) * sp, b.vy * 0.3 + Math.sin(a) * sp, 0.45 + Math.random() * 0.7, 0.04 + Math.random() * 0.06, r, g, bl);
    }
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1 + Math.random() * 4;
      this.spawn(P.Spark, px, py, Math.cos(a) * sp, Math.sin(a) * sp, 0.25 + Math.random() * 0.25, 0.08 + Math.random() * 0.08, 0.9, 0.97, 1);
    }
    const pan = this.pan(b.x);
    const snd = this.ctx.sound;
    snd.play('snap', { pitch: 1.4, gain: 0.9, pan });
    snd.play('crumble', { pitch: 2, gain: 0.5, pan });
    this.queue(0.04, 'chime', { pitch: 1.5 + Math.random() * 0.3, gain: 0.22, pan });
    this.ctx.haptic('heavy');
    this.shake = Math.min(1, this.shake + 0.25);
    this.hitStopFor(it);
  }

  private splinter(it: Item, dv: number) {
    const w = this.world, b = it.body;
    it.broken = true;
    w.remove(b);
    const n = Math.random() < 0.5 ? 3 : 4;
    const ph = b.hy / n;
    const [r, g, bl] = rgb(it.color);
    for (let i = 0; i < n; i++) {
      if (this.debris.length >= MAX_DEBRIS) break;
      const ly = -b.hy + ph * (2 * i + 1);
      const x = b.x - b.s * ly, y = b.y + b.c * ly;
      const body = w.add({
        shape: Shape.Box,
        x,
        y,
        a: b.a + (Math.random() - 0.5) * 0.2,
        hx: b.hx * (0.8 + Math.random() * 0.2),
        hy: ph * 0.85,
        vx: b.vx * 0.6 + (Math.random() - 0.5) * 3,
        vy: b.vy * 0.6 + ly * 4 + 1 + Math.random() * 1.5,
        w: (Math.random() - 0.5) * 10,
        density: 1.2,
        friction: 0.7,
        restitution: 0.05,
      });
      this.addDebris({ body, kind: 'plank', life: 2.6 + Math.random() * 0.6, color: it.color, shape: Math.random(), jam: false, lastHit: 0 });
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2, sp = 1.5 + Math.random() * 5;
      this.spawn(P.Chip, b.x, b.y, b.vx * 0.3 + Math.cos(a) * sp, b.vy * 0.3 + Math.sin(a) * sp + 2, 0.9 + Math.random() * 0.6, 0.03 + Math.random() * 0.05, r * 1.1, g * 1.1, bl * 1.1);
    }
    const pan = this.pan(b.x);
    this.ctx.sound.play('snap', { pitch: 0.75, gain: Math.min(1, 0.5 + dv * 0.04), pan });
    this.ctx.sound.play('thud', { pitch: 0.8, gain: 0.8, pan });
    this.ctx.sound.play('knock', { pitch: 0.7, gain: 0.7, pan });
    this.ctx.haptic('medium');
    this.shake = Math.min(1, this.shake + 0.3);
    this.hitStopFor(it);
  }

  private addDebris(d: Debris) {
    this.debris.push(d);
    this.debrisOf.set(d.body, d);
  }

  /** Breaking the last item on the shelves gets the slow-mo payoff right away. */
  private hitStopFor(it: Item) {
    if (!it.cleared && this.items.length - this.cleared === 1) this.startFinal();
  }

  private startFinal() {
    if (this.finalFx) return;
    this.finalFx = true;
    this.hitStop = 0.06;
    this.slow = 0.6;
  }

  // ------------------------------------------------------------------ sound

  /**
   * Voices for this step's hardest contacts: each material has its own (a ringing can, a glass
   * clink, a wooden thud), gain follows the impact speed and pan the x position.
   */
  private impactSounds() {
    let n = 0;
    let hardest = 0;
    for (const m of this.world.manifolds.values()) {
      const a = m.a, b = m.b;
      if ((a.sleeping || a.invMass === 0) && (b.sleeping || b.invMass === 0)) continue;
      let imp = 0, px = 0, py = 0;
      for (const p of m.points)
        if (p.maxImp > imp) {
          imp = p.maxImp;
          px = p.px;
          py = p.py;
        }
      if (imp <= 0) continue;
      const ma = a.invMass > 0 ? a.mass : Infinity, mb = b.invMass > 0 ? b.mass : Infinity;
      const speed = imp / Math.min(ma, mb);
      if (speed < 1.8) continue;
      // Voice the lighter of the two that isn't a ball or a shelf.
      const cand = (x: Body) => (x.invMass > 0 && x.kind !== Kind.Cannonball ? x : null);
      const ca = cand(a), cb = cand(b);
      const body = ca && cb ? (ca.mass < cb.mass ? ca : cb) : (ca ?? cb);
      if (!this.voice(body, speed, px, py)) continue;
      hardest = Math.max(hardest, speed);
      if (++n >= 4) break;
    }
    if (hardest > 7) this.ctx.haptic('medium');
    else if (hardest > 4) this.ctx.haptic('light');
  }

  private voice(body: Body | null, speed: number, x: number, y: number): boolean {
    const snd = this.ctx.sound;
    const gain = Math.max(0.08, Math.min(1, (speed - 1.5) / 8));
    const pan = this.pan(x);
    const t = this.time;
    if (!body) {
      // A ball on a shelf: a dull wooden knock.
      snd.play('knock', { pitch: 0.9, gain: gain * 0.6, pan });
      return true;
    }
    const it = this.owner.get(body);
    if (it) {
      if (t - it.lastHit < 0.08) return false;
      it.lastHit = t;
      if (it.mat === 'can') {
        if (it.cleared && y < COUNTER) snd.play('tick', { pitch: 1.5 + Math.random() * 0.4, gain: gain * 0.5, pan });
        else {
          snd.play('knock', { pitch: 1.6 + Math.random() * 0.4, gain: gain * 0.85, pan });
          // The tin rings on.
          this.queue(0.035, 'tick', { pitch: 2.6 + Math.random() * 0.3, gain: gain * 0.45, pan });
          this.queue(0.1, 'tick', { pitch: 2.9 + Math.random() * 0.3, gain: gain * 0.25, pan });
        }
      } else if (it.mat === 'jar') {
        snd.play('knock', { pitch: 1.35, gain: gain * 0.6, pan });
        snd.play('tick', { pitch: 3.2 + Math.random() * 0.4, gain: gain * 0.5, pan });
      } else {
        snd.play('thud', { pitch: 0.95 + Math.random() * 0.15, gain, pan });
        snd.play('knock', { pitch: 0.7, gain: gain * 0.7, pan });
      }
      return true;
    }
    const d = this.debrisOf.get(body);
    if (!d || t - d.lastHit < 0.06) return false;
    d.lastHit = t;
    if (d.kind === 'shard') snd.play('tick', { pitch: 2.8 + Math.random() * 0.9, gain: gain * 0.3, pan });
    else snd.play('knock', { pitch: d.kind === 'lid' ? 1.2 : 0.8, gain: gain * 0.5, pan });
    return true;
  }

  private queue(delay: number, voice: Voice, opts: PlayOpts) {
    if (this.pending.length < 24) this.pending.push({ at: this.time + delay, voice, opts });
  }

  private playPending() {
    for (let i = this.pending.length - 1; i >= 0; i--) {
      const p = this.pending[i];
      if (p.at > this.time) continue;
      this.ctx.sound.play(p.voice, p.opts);
      this.pending.splice(i, 1);
    }
  }

  private pan(x: number) {
    return Math.max(-1, Math.min(1, ((x - this.cx) / this.viewW) * 1.6));
  }

  // ------------------------------------------------------------------ bookkeeping

  private updateItems(dt: number, sdt: number) {
    const w = this.world;
    const off = this.viewW / 2 + 0.6;
    let cleared = 0;
    let lastLeft: Item | null = null;
    this.rollCool -= dt;
    for (const it of this.items) {
      const b = it.body;
      if (!it.behind && b.alive && it.vz > 0) {
        it.z += it.vz * sdt;
        it.vz = Math.max(0, it.vz - MATERIALS[it.mat].slide * sdt);
        if (it.z > DEPTH) this.fallBehind(it);
      }
      if (it.behind && b.alive) {
        it.tumble += sdt * (it.mat === 'crate' ? 6 : 10);
        if (b.y < FLOOR + b.hy) this.landBehind(it);
      }
      if (!it.cleared) {
        if (it.behind || it.broken || !b.alive || b.y < this.lowestShelf - 0.15 || Math.abs(b.x) > off) {
          it.cleared = true;
          it.clearedAt = this.time;
        } else lastLeft = it;
      }
      if (it.cleared) cleared++;
      if (!b.alive) continue;
      // Knocked-off items rest a moment behind the counter, then fade away.
      if (it.cleared && (b.sleeping || this.time - it.clearedAt > 3)) it.fade -= sdt * 2.5;
      if (it.fade <= 0) w.remove(b);
      // Cans rolling on the stall floor tick along.
      if (it.mat === 'can' && it.cleared && !b.sleeping && b.y < COUNTER && Math.abs(b.vx) > 1 && this.rollCool <= 0) {
        this.rollCool = 0.14;
        this.ctx.sound.play('tick', { pitch: 1.3 + Math.random() * 0.3, gain: 0.15, pan: this.pan(b.x) });
      }
    }
    const remaining = this.items.length - cleared;
    // The last item on the shelves just took a hit: freeze, then play its fall in slow motion.
    if (remaining === 1 && lastLeft && ((!lastLeft.body.sleeping && Math.hypot(lastLeft.body.vx, lastLeft.body.vy) > 1.5) || lastLeft.vz > 1)) this.startFinal();
    if (cleared !== this.cleared) {
      this.cleared = cleared;
      if (remaining === 0 && !this.celebrated) {
        this.startFinal();
        this.celebrated = true;
        const left = this.cfg.endless ? 0 : this.shots;
        this.ctx.celebrate(left ? `Clean sweep! +${left}` : 'Cleared!');
        this.setState('done');
        this.hideBanner();
      }
    }
    for (const bl of this.balls) {
      bl.age += sdt;
      const b = bl.body;
      if (b.ghost && b.vy <= 0 && !bl.bounced) {
        // Reaching the shelves at the top of its arc: over an item, it strikes its front face and
        // bounces back out toward the viewer; otherwise it drops into the stall, solid.
        const it = this.itemAt(b.x, b.y, b.r * 0.6);
        if (it) {
          this.strike(bl, it, b.x, b.y);
          bl.bounced = true;
          b.vx *= 0.3;
          b.vy = -1.5;
        } else if (!this.itemAt(b.x, b.y, b.r)) b.ghost = false;
      }
      // Once it's in the stall its forward speed soon runs out: a ball rolling along a shelf won't knock.
      if (!b.ghost) bl.vf *= Math.exp(-sdt * 2.5);
      if (b.y < -1 || Math.abs(b.x) > this.viewW / 2 + 2 || bl.age > 7 || (bl.age > 1 && b.sleeping)) {
        w.remove(b);
        if (import.meta.env.DEV) this.hitLog.push(bl.hit.size);
      }
    }
    if (this.balls.some((bl) => !bl.body.alive)) this.balls = this.balls.filter((bl) => bl.body.alive);
  }

  private fallBehind(it: Item) {
    const b = it.body;
    it.behind = true;
    it.vz = 0;
    // Out of the shelf's plane: it falls through everything (whatever it held up now drops).
    b.ghost = true;
    this.world.wake(b);
    this.world.wakeRadius(b.x, b.y, Math.max(b.hx, b.hy) + 0.5);
    b.vy = Math.min(b.vy, 0.5);
    b.w += (Math.random() - 0.5) * 3;
    this.ctx.sound.play('tick', { pitch: it.mat === 'crate' ? 0.8 : 1.6, gain: 0.3, pan: this.pan(b.x) });
  }

  /** A knocked-back item hits the stall floor out of sight: a muffled crash, then it's gone. */
  private landBehind(it: Item) {
    const b = it.body;
    const pan = this.pan(b.x);
    const gain = Math.min(0.6, 0.2 + Math.abs(b.vy) * 0.04);
    const snd = this.ctx.sound;
    if (it.mat === 'jar') {
      snd.play('snap', { pitch: 1.2, gain: gain * 0.8, pan });
      snd.play('crumble', { pitch: 1.8, gain: gain * 0.6, pan });
    } else if (it.mat === 'can') {
      snd.play('knock', { pitch: 1.5, gain, pan });
      this.queue(0.05, 'tick', { pitch: 2.4, gain: gain * 0.4, pan });
      this.queue(0.16, 'tick', { pitch: 2.2, gain: gain * 0.25, pan });
    } else snd.play('thud', { pitch: 0.8, gain, pan });
    this.world.remove(b);
  }

  private updateDebris(sdt: number) {
    let dead = false;
    for (const d of this.debris) {
      d.life -= sdt;
      if (d.life <= 0 || d.body.y < -1 || !d.body.alive) {
        if (d.body.alive) this.world.remove(d.body);
        this.debrisOf.delete(d.body);
        dead = true;
      }
    }
    if (dead) this.debris = this.debris.filter((d) => d.body.alive);
  }

  /** Turn flow: reload between shots; when the last ball has settled, a bonus ball or a re-rack. */
  private turn(dt: number) {
    this.reload -= dt;
    this.sinceLaunch += dt;
    if (this.state !== 'play' || this.shots > 0 || this.cfg.endless || this.aim) return;
    let busy = false;
    for (const bl of this.balls) if (!bl.body.sleeping && Math.hypot(bl.body.vx, bl.body.vy) > 0.4 && bl.body.y > FLOOR + 0.3) busy = true;
    for (const it of this.items) if (!it.cleared && !it.body.sleeping && Math.hypot(it.body.vx, it.body.vy) > 0.25) busy = true;
    this.settle = busy && this.sinceLaunch < 8 ? 0 : this.settle + dt;
    if (this.settle < 0.7) return;
    const left = this.items.length - this.cleared;
    if (left === 0) return;
    if (!this.bonusUsed) {
      // Near-miss tension without a fail state: one free ball.
      this.bonusUsed = true;
      this.shots = 1;
      this.reload = 0.3;
      this.updateHud();
      this.showBanner(`So close! ${left} left`, 'Here’s a bonus ball', 2.4);
      this.ctx.sound.play('pop', { pitch: 1.2, gain: 0.6 });
      this.ctx.haptic('light');
    } else {
      this.setState('over');
      this.showBanner(`${left} left standing`, 'Tap for a new stall');
      this.ctx.sound.play('plop', { pitch: 0.8, gain: 0.5 });
    }
  }

  // ------------------------------------------------------------------ particles

  private spawn(type: P, x: number, y: number, vx: number, vy: number, life: number, size: number, r: number, g: number, b: number) {
    let p: Particle | undefined;
    for (const q of this.particles)
      if (!q.alive) {
        p = q;
        break;
      }
    if (!p) return;
    p.alive = true;
    p.type = type;
    p.x = x;
    p.y = y;
    p.vx = vx;
    p.vy = vy;
    p.life = p.max = life;
    p.size = size;
    p.r = r;
    p.g = g;
    p.b = b;
    p.a = Math.random() * 6;
    p.va = (Math.random() - 0.5) * 20;
  }

  private updateParticles(dt: number) {
    if (dt <= 0) return;
    const g = this.world.gravity;
    const shelves = this.stall.shelves;
    for (const p of this.particles) {
      if (!p.alive) continue;
      p.life -= dt;
      const py = p.y;
      if (p.type === P.Spark) {
        p.vx *= Math.exp(-dt * 4);
        p.vy *= Math.exp(-dt * 4);
      } else p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.a += p.va * dt;
      if (p.type === P.Drop) {
        // Lands on a shelf top, hits the back wall when its flight time runs out, or drops out of sight.
        let hit: ShelfSpec | null = null;
        if (p.vy < 0) for (const s of shelves) if (p.x > s.x0 && p.x < s.x1 && py >= s.y && p.y < s.y) hit = s;
        if (hit) this.splat(p.x, hit.y + 0.02, p.size * 1.8, p, 0.45);
        else if (p.life <= 0 && p.y > COUNTER) this.splat(p.x, p.y, p.size * 2.2, p, 1);
        if (hit || p.life <= 0 || p.y < FLOOR) p.alive = false;
      } else if (p.type === P.Chip && p.y < FLOOR) {
        p.y = FLOOR;
        p.vy = Math.abs(p.vy) * 0.3;
        p.vx *= 0.5;
      }
      if (p.life <= 0) p.alive = false;
    }
  }

  /** Stamp a jam splat into the decal: a blob, a few satellite drops, one 32² texture upload. */
  private splat(x: number, y: number, r: number, c: Particle, squash: number) {
    const [X0, Y0, W, H] = DECAL_RECT;
    const sx = DECAL / W, sy = DECAL / H;
    const ci = (x - X0) * sx, cj = (y - Y0) * sy;
    const bx = Math.max(0, Math.min(DECAL - STAMP, Math.round(ci) - STAMP / 2));
    const by = Math.max(0, Math.min(DECAL - STAMP, Math.round(cj) - STAMP / 2));
    if (ci < 0 || cj < 0 || ci >= DECAL || cj >= DECAL) return;
    const d = this.renderer.decal;
    const cr = c.r * 0.85, cg = c.g * 0.85, cb = c.b * 0.85;
    // A blob smeared along the droplet's flight, then satellites around it.
    const sp = Math.hypot(c.vx, c.vy) || 1;
    const ux = c.vx / sp, uy = c.vy / sp;
    const sat = this.splatDiscs;
    sat.length = 0;
    sat.push(0, 0, r, ux * r * 0.7, uy * r * 0.7 * squash, r * 0.75, ux * r * 1.3, uy * r * 1.3 * squash, r * 0.45);
    const n = 2 + ((Math.random() * 3) | 0);
    for (let k = 0; k < n; k++) {
      const a = Math.random() * Math.PI * 2, dist = r * (1.1 + Math.random() * 0.9);
      sat.push(Math.cos(a) * dist, Math.sin(a) * dist * squash, r * (0.2 + Math.random() * 0.3));
    }
    for (let j = 0; j < STAMP; j++)
      for (let i = 0; i < STAMP; i++) {
        const wx = (bx + i + 0.5 - ci) / sx, wy = (by + j + 0.5 - cj) / sy;
        let cov = 0;
        for (let k = 0; k < sat.length; k += 3) {
          const dx = wx - sat[k], dy = (wy - sat[k + 1]) / squash;
          const e = sat[k + 2] - Math.hypot(dx, dy);
          cov = Math.max(cov, Math.min(1, e * sx * 0.8 + 0.5));
        }
        if (cov <= 0) continue;
        const a = cov * 0.92;
        const o = ((by + j) * DECAL + bx + i) * 4;
        const keep = 1 - a;
        d[o] = Math.min(255, cr * 255 * a + d[o] * keep);
        d[o + 1] = Math.min(255, cg * 255 * a + d[o + 1] * keep);
        d[o + 2] = Math.min(255, cb * 255 * a + d[o + 2] * keep);
        d[o + 3] = Math.min(255, 255 * a + d[o + 3] * keep);
      }
    this.renderer.uploadDecal(bx, by, STAMP, STAMP);
    if (this.time - this.lastSplash > 0.12) {
      this.lastSplash = this.time;
      this.ctx.sound.play('splash', { pitch: 1.2 + Math.random() * 0.4, gain: 0.4, pan: this.pan(x) });
    }
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

  private band(ax: number, ay: number, bx: number, by: number, thick: number, r: number, g: number, b: number) {
    const dx = bx - ax, dy = by - ay;
    this.push((ax + bx) / 2, (ay + by) / 2, Math.hypot(dx, dy) / 2 + thick, thick, Math.atan2(dy, dx), Sprite.Band, 0, 1, r, g, b);
  }

  private render(t: number) {
    this.count = 0;
    const SH = 0.1, SV = -0.13;
    // Shadows on the back wall.
    for (const s of this.stall.shelves) this.push((s.x0 + s.x1) / 2 + SH, s.y - 0.09 + SV, (s.x1 - s.x0) / 2, 0.09, 0, Sprite.Shadow, 0, 0.35, 0, 0, 0, 0.04);
    for (const it of this.items) {
      const b = it.body;
      if (b.alive && b.y > COUNTER - 0.5) this.push(b.x + SH, b.y + SV, b.hx, b.hy, b.a, Sprite.Shadow, 0, 0.3 * it.fade, 0, 0, 0, 0.05);
    }
    // Items falling behind the shelves, shrunk and shaded by distance.
    for (const it of this.items) if (it.behind && it.body.alive) this.pushItem(it);
    // Shelves on their brackets.
    for (const s of this.stall.shelves) {
      for (const bx of [s.x0 + 0.35, s.x1 - 0.35]) this.push(bx, s.y - 0.4, 0.06, 0.26, 0, Sprite.Wood, 0.3, 1, 0.36, 0.22, 0.13);
      this.push((s.x0 + s.x1) / 2, s.y - 0.09, (s.x1 - s.x0) / 2, 0.09, 0, Sprite.Wood, s.y * 0.37, 1, 0.66, 0.43, 0.24);
    }
    // Balls that have reached the stall are behind the counter.
    for (const bl of this.balls) if (!bl.body.ghost) this.pushBall(bl.body, 1);
    // Items.
    for (const it of this.items) if (!it.behind && it.body.alive) this.pushItem(it);
    // Debris.
    for (const d of this.debris) {
      const b = d.body;
      const a = Math.min(1, d.life / 0.4);
      const [r, g, bl] = rgb(d.color);
      if (d.kind === 'shard') this.push(b.x, b.y, b.hx, b.hy, b.a, Sprite.Shard, d.shape, a, r, g, bl, d.jam ? 1 : 0);
      else if (d.kind === 'lid') this.push(b.x, b.y, b.hx, b.hy, b.a, Sprite.Band, 0, a, r, g, bl);
      else this.push(b.x, b.y, b.hx, b.hy, b.a, Sprite.Wood, d.shape, a, r, g, bl, 1);
    }
    // Particles.
    for (const p of this.particles) {
      if (!p.alive) continue;
      const f = Math.max(0, p.life / p.max);
      if (p.type === P.Drop) this.push(p.x, p.y, p.size, p.size, 0, Sprite.Dot, 0, 1, p.r, p.g, p.b, 0);
      else if (p.type === P.Spark) this.push(p.x, p.y, p.size, p.size, 0, Sprite.Dot, 0, f, p.r, p.g, p.b, 1);
      else this.push(p.x, p.y, p.size, p.size * 0.6, p.a, Sprite.Wood, 0.5, Math.min(1, f * 2), p.r, p.g, p.b);
    }
    // Counter front.
    this.push(0, COUNTER / 2, this.viewW / 2 + 0.5, COUNTER / 2, 0, Sprite.Counter, 0, 1, 0, 0, 0);
    this.renderSlingshot(t);
    // Rising balls are nearer the viewer: in front of everything, shrinking to full depth at the apex.
    for (const bl of this.balls) if (bl.body.ghost) this.pushBall(bl.body, bl.bounced ? 1.08 : 1 + NEAR * Math.max(0, bl.body.vy / bl.vy0));
    const jx = (Math.random() - 0.5) * this.shake * 0.3, jy = (Math.random() - 0.5) * this.shake * 0.3;
    const cssH = this.height / this.ctx.pixelRatio;
    const awning = this.cy + this.viewH / 2 - (118 / cssH) * this.viewH;
    const half = Math.max(3.9, Math.min(this.viewW / 2 - 0.3, 4.4));
    this.renderer.draw(this.width, this.height, [this.cx + jx, this.cy + jy, this.viewW, this.viewH], t, awning, half, this.inst, this.count);
  }

  private pushItem(it: Item) {
    const b = it.body;
    // Further back is a little smaller and darker; scaled about its base so it stays on the shelf.
    const d = it.behind ? 1 : Math.min(1, it.z / DEPTH);
    const s = 1 - 0.12 * d, shade = 1 - (it.behind ? 0.45 : 0.25 * d);
    // Tipping back foreshortens it; behind the shelf it keeps tumbling end over end.
    const tip = it.behind ? 0.9 + it.tumble : d * 0.9;
    const sy = s * Math.max(0.2, Math.abs(Math.cos(tip)));
    const [r, g, bl] = rgb(it.color);
    const a = Math.max(0, Math.min(1, it.fade)) * (it.behind ? 0.9 : 1);
    const kind = it.mat === 'can' ? Sprite.Can : it.mat === 'jar' ? Sprite.Jar : Sprite.Crate;
    const dy = b.hy * (1 - sy);
    this.push(b.x + b.s * dy, b.y - b.c * dy, b.hx * s, b.hy * sy, b.a, kind, shade, a, r, g, bl, it.alt);
  }

  private pushBall(b: Body, scale: number) {
    const r = b.r * scale;
    if (scale > 1) this.push(b.x + 0.12 * scale, b.y - 0.16 * scale, r, r, 0, Sprite.Shadow, 0, 0.25, 0, 0, 0, r);
    this.push(b.x, b.y, r, r, b.a, Sprite.Ball, 0, 1, 1, 1, 1);
  }

  private renderSlingshot(t: number) {
    const [rx, ry] = REST;
    const a = this.aim;
    const px = rx + (a?.ox ?? 0), py = ry + (a?.oy ?? 0);
    const loaded = this.canShoot() || (!!a && (this.shots > 0 || this.cfg.endless));
    // Handle and fork arms.
    this.push(0, 0.95, 0.1, 0.62, 0, Sprite.Wood, 0.2, 1, 0.42, 0.26, 0.14);
    for (const [tx, ty] of TIPS) {
      const bx = 0, by = 1.5;
      const dx = tx - bx, dy = ty - by;
      this.push((tx + bx) / 2, (ty + by) / 2, Math.hypot(dx, dy) / 2 + 0.06, 0.08, Math.atan2(dy, dx), Sprite.Wood, 0.7, 1, 0.48, 0.3, 0.16);
    }
    const [lx, ly] = TIPS[0], [qx, qy] = TIPS[1];
    // Aim arc: where the ball would fly (ballistic, no collisions).
    if (a && Math.hypot(a.ox, a.oy) >= 0.3) {
      const k = POWER * this.cfg.power;
      const vx = -a.ox * k, vy = -a.oy * k, g = this.world.gravity * BALL_G;
      let apex = false;
      for (let i = 1; i <= 36; i++) {
        const s = i * 0.034;
        const x = px + vx * s, y = py + vy * s + 0.5 * g * s * s;
        const falling = vy + g * s < 0;
        if (falling && !apex) {
          // Mark the top of the arc: where the ball reaches the shelves.
          apex = true;
          const ts = -vy / g;
          this.push(px + vx * ts, py + vy * ts + 0.5 * g * ts * ts, 0.2, 0.2, 0, Sprite.Dot, 0, 0.45, 1, 0.85, 0.4, 1);
        }
        if (y < COUNTER && falling) break;
        const f = 1 - i / 38;
        const sz = falling ? 0.075 : 0.045;
        this.push(x, y, sz, sz, 0, Sprite.Dot, 0, (falling ? 1 : 0.45) * f, 1, falling ? 0.9 : 0.97, falling ? 0.55 : 0.9, 0);
      }
    }
    const bandY = loaded ? py - BALL_R * 0.3 : py;
    this.band(lx, ly, px - (loaded ? BALL_R * 0.8 : 0.2), bandY, 0.045, 0.45, 0.12, 0.1);
    if (loaded) {
      // Bob the waiting ball gently so it reads as "ready".
      const bob = a ? 0 : Math.sin(t * 3) * 0.02;
      this.push(px, py + bob, BALL_R * (1 + NEAR), BALL_R * (1 + NEAR), 0, Sprite.Ball, 0, 1, 1, 1, 1);
    }
    this.push(px, bandY - (loaded ? BALL_R * 0.6 : 0), loaded ? BALL_R * 0.95 : 0.2, 0.07, 0, Sprite.Band, 0, 1, 0.32, 0.2, 0.13);
    this.band(px + (loaded ? BALL_R * 0.8 : 0.2), bandY, qx, qy, 0.045, 0.56, 0.16, 0.12);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.fitView();
  }

  destroy() {
    this.hud.remove();
    this.style.remove();
    this.renderer.destroy();
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__knockdown;
  }
}

const extX = (b: Body) => Math.abs(b.hx * b.c) + Math.abs(b.hy * b.s);
const extY = (b: Body) => Math.abs(b.hx * b.s) + Math.abs(b.hy * b.c);

function rgb(c: number): [number, number, number] {
  return [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
}

const STYLE = `
.kd-hud { position: absolute; inset: 0; pointer-events: none; font-family: ui-rounded, -apple-system, system-ui, sans-serif; }
.kd-balls { position: absolute; left: calc(16px + env(safe-area-inset-left, 0px)); bottom: calc(18px + env(safe-area-inset-bottom, 0px)); display: flex; gap: 6px; padding: 7px 9px; border-radius: 99px; background: rgba(40,12,14,0.55); backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); min-height: 18px; align-items: center; }
.kd-balls:empty { display: none; }
.kd-balls i { display: block; width: 16px; height: 16px; border-radius: 50%; background: radial-gradient(circle at 35% 30%, #fff 0 25%, #efe6d2 60%, #c9bea5); box-shadow: inset 0 0 0 1.5px rgba(200,30,30,0.55); }
.kd-balls i.bonus { background: radial-gradient(circle at 35% 30%, #fff8d0 0 25%, #ffd166 60%, #d9a21e); }
.kd-balls span { color: #fff; font-weight: 800; font-size: 16px; padding: 0 4px; }
.kd-new { position: absolute; right: calc(16px + env(safe-area-inset-right, 0px)); bottom: calc(16px + env(safe-area-inset-bottom, 0px)); pointer-events: auto; border: 0; padding: 10px 14px; border-radius: 14px; background: rgba(255,248,236,0.92); color: #7a1520; font: 800 14px/1 ui-rounded, -apple-system, system-ui, sans-serif; box-shadow: 0 4px 14px rgba(40,5,10,0.35); cursor: pointer; }
.kd-new.pulse { animation: kd-pulse 1.1s ease-in-out infinite; background: #ffd166; }
@keyframes kd-pulse { 50% { transform: scale(1.08); } }
.kd-banner { position: absolute; left: 50%; top: 24%; transform: translateX(-50%); padding: 12px 18px; border-radius: 16px; background: rgba(255,248,236,0.94); color: #5a1018; text-align: center; box-shadow: 0 10px 30px rgba(40,5,10,0.35); white-space: nowrap; }
.kd-banner[hidden] { display: none; }
.kd-banner b { display: block; font-size: 22px; font-weight: 800; letter-spacing: -0.02em; }
.kd-banner span { display: block; margin-top: 3px; font-size: 13px; font-weight: 700; opacity: 0.7; }
.kd-banner.show { animation: kd-in .35s cubic-bezier(.2,1.4,.4,1); }
@keyframes kd-in { from { opacity: 0; transform: translate(-50%, 10px) scale(.9); } }
`;
