import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop } from '../../shell/sound';
import { TubeShape } from './geom';
import { Stream, STREAM_CAP, type Vessel } from './stream';
import { Renderer, type TubeDraw } from './render';
import { applyPour, canPour, generate, plan, solve, solved, tubeSolved, type Puzzle } from './logic';

export const pourToy: Toy = {
  id: 'pour',
  title: 'Pour Sort',
  blurb: 'Tap a tube, then another, and it tips and pours a real stream. Sort every colour — oil floats, syrup sinks.',
  tech: 'Clavet particle stream · density layers · WebGL2',
  swatch: 'linear-gradient(135deg,#f8405a,#ffd23f 45%,#2f7fff)',
  refs: [
    {
      short: 'Clavet 2005',
      title: 'Clavet, Beaudoin, Poulin — Particle-based Viscoelastic Fluid Simulation (SCA 2005)',
      url: 'https://dl.acm.org/doi/10.1145/1073368.1073400',
      use: 'Double-density relaxation for the pour stream, ported from Ferro Blob: cohesive, so it necks and drips.',
    },
    {
      short: 'Buoyancy 2026',
      title: 'Buoyancy-driven phase separation (SIGGRAPH 2026 papers)',
      url: 'https://s2026.conference-schedule.org/?post_type=page&p=15&id=papers_363&sess=sess108',
      use: 'Design twist: liquids carry densities, so a light layer poured under a heavy one rises through it.',
    },
    {
      short: 'Rayleigh–Taylor',
      title: 'Rayleigh–Taylor instability (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Rayleigh%E2%80%93Taylor_instability',
      use: 'Why the lighter layer climbs as a column of blobs rather than a flat sheet.',
    },
    {
      short: 'Sutherland–Hodgman',
      title: 'Sutherland–Hodgman polygon clipping (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Sutherland%E2%80%93Hodgman_algorithm',
      use: 'Exact liquid volume in a tilted tube: clip the tube outline by the level surface, bisect for the height.',
    },
    {
      short: 'Helmholtz',
      title: 'Helmholtz resonance (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Helmholtz_resonance',
      use: 'The pour sound brightens as the target fills and its air column shortens.',
    },
  ],
  async create(ctx) {
    return new PourSort(ctx);
  },
};

/** Stream particles per unit of liquid. */
const PPU = 65;
const GLASS = 3;
const MAX_L = 8;

interface Layer {
  liq: number;
  vol: number;
}

/** A lighter layer climbing through the one above it, as blobs. */
interface Rise {
  /** Index of the climbing (shrinking) layer; the growing copy sits two above it. */
  i: number;
  v0: number;
  t: number;
  dur: number;
}

type Busy = 'idle' | 'src' | 'dst';

interface VTube {
  layers: Layer[];
  home: [number, number];
  tx: number;
  ty: number;
  ang: number;
  lift: number;
  liftV: number;
  liftT: number;
  wob: number;
  enter: number;
  enterV: number;
  m1: number;
  v1: number;
  m2: number;
  v2: number;
  lastX: number;
  lastVX: number;
  lastY: number;
  lastVY: number;
  corked: boolean;
  cork: number;
  corkY: number;
  corkV: number;
  shimmer: number;
  busy: Busy;
  rise: Rise | null;
  draw: TubeDraw;
}

interface Pour {
  a: number;
  b: number;
  n: number;
  liq: number;
  /** Lip side the liquid leaves over: +1 right, -1 left. */
  s: number;
  phase: 0 | 1 | 2 | 3; // move over, pour, return, done
  t: number;
  emitted: number;
  acc: number;
  mag: number;
  stall: number;
  flow: number;
  from: [number, number, number];
  hit: boolean;
  bBefore: number[];
  since: number;
  finalized: boolean;
}

class PourSort implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private renderer: Renderer;
  private stream = new Stream();
  private width = 1;
  private height = 1;
  private vw = 1;
  private vh = 1;
  private level = 1;
  private puzzle!: Puzzle;
  private logic: number[][] = [];
  private history: number[][][] = [];
  private tubes: VTube[] = [];
  private shape!: TubeShape;
  private slot = 60;
  private shelves: [number, number] = [-1, -1];
  private shelfW = 100;
  private pours: Pour[] = [];
  private sel = -1;
  private moves = 0;
  private time = 0;
  private doneAt = -1;
  private celebrated = false;
  private celebrations = 0;
  private parts = new Float32Array(STREAM_CAP * 3 * 5);
  private trickle: Loop;
  private bubble: Loop;
  private buzz = 0;
  private hud: HTMLElement;
  private levelEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private undoEl!: HTMLButtonElement;
  private style: HTMLStyleElement;
  private tiltX = 0;
  private motion: [number, number] | null = null;
  private tiltButton: HTMLButtonElement | null = null;
  private offMotion: (() => void) | null = null;
  readonly cfg = { speed: 1, cohesion: 1, slosh: 1 };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, premultipliedAlpha: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.renderer = new Renderer(gl);
    this.trickle = ctx.sound.loop('trickle');
    this.bubble = ctx.sound.loop('bubble');
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hud = this.buildHud();
    this.buildPanel();
    this.setupTilt();
    try {
      this.level = Math.max(1, Number(localStorage.getItem('bobo.pour.level') ?? 1) || 1);
    } catch {
      this.level = 1;
    }
    this.resize(ctx.canvas.width, ctx.canvas.height);
    this.load(this.level);
    if (import.meta.env.DEV) {
      // Dev-only probe for headless tests: state, a solver, and where to tap each tube.
      (window as unknown as Record<string, unknown>).__pour = {
        info: () => ({
          level: this.level,
          moves: this.moves,
          cap: this.puzzle.cap,
          liquids: this.puzzle.liquids.map((l) => l.name),
          tubes: this.logic.map((t) => t.slice()),
          busy: this.busy(),
          solved: solved(this.puzzle, this.logic),
          selected: this.sel,
          celebrations: this.celebrations,
          particles: this.stream.n,
          corked: this.tubes.filter((t) => t.corked).length,
        }),
        solve: () => solve(this.puzzle, this.logic),
        tubeXY: (i: number) => {
          const r = this.ctx.canvas.getBoundingClientRect();
          const t = this.tubes[i];
          return [r.left + t.home[0], r.top + this.vh - (t.home[1] + this.shape.h * 0.45)];
        },
        load: (lv: number) => this.load(lv),
        cfg: this.cfg,
      };
    }
  }

  // ---------------------------------------------------------------- setup

  private buildHud() {
    const hud = document.createElement('div');
    hud.className = 'pour-hud';
    hud.innerHTML = `
      <div class="pour-hint"></div>
      <div class="pour-bar">
        <button type="button" data-a="undo" aria-label="Undo">${UNDO_ICON}Undo</button>
        <span class="pour-level"></span>
        <button type="button" data-a="restart" aria-label="Restart level">${RESTART_ICON}</button>
      </div>`;
    this.ctx.overlay.appendChild(hud);
    this.levelEl = hud.querySelector('.pour-level')!;
    this.hintEl = hud.querySelector('.pour-hint')!;
    this.undoEl = hud.querySelector('[data-a=undo]')!;
    this.undoEl.addEventListener('click', () => this.undo());
    hud.querySelector('[data-a=restart]')!.addEventListener('click', () => this.load(this.level));
    return hud;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    panel.action('Undo', () => this.undo());
    panel.action('Restart level', () => this.load(this.level));
    panel.action('Skip to next level', () => this.load(this.level + 1));
    panel.slider(this.cfg, 'speed', { label: 'Pour speed', min: 0.4, max: 2.5, step: 0.05 });
    panel.slider(this.cfg, 'cohesion', {
      label: 'Stream stickiness',
      min: 0.2,
      max: 2,
      step: 0.05,
      onChange: (v) => (this.stream.cfg.cohesion = v),
    });
    panel.slider(this.cfg, 'slosh', { label: 'Slosh', min: 0, max: 2, step: 0.05 });
  }

  /** Phone tilt sloshes every tube (Splash Tank's devicemotion path, including iOS's permission prompt). */
  private setupTilt() {
    const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null) return;
      const sign = isIOS ? 1 : -1;
      let x = (a.x * sign) / 9.81;
      let y = (a.y * sign) / 9.81;
      const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
      const r = (-angle * Math.PI) / 180;
      [x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
      this.motion = [x, y];
      this.tiltButton?.remove();
      this.tiltButton = null;
    };
    const listen = () => {
      addEventListener('devicemotion', onMotion);
      this.offMotion = () => removeEventListener('devicemotion', onMotion);
    };
    const DME = typeof DeviceMotionEvent !== 'undefined' ? (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }) : null;
    const touch = navigator.maxTouchPoints > 0;
    if (DME && typeof DME.requestPermission === 'function' && touch) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hud-btn pour-tilt';
      b.textContent = 'Enable tilt';
      b.addEventListener('click', async () => {
        try {
          if ((await DME.requestPermission!()) === 'granted') listen();
        } catch {
          /* denied */
        }
        b.remove();
        this.tiltButton = null;
      });
      this.ctx.overlay.appendChild(b);
      this.tiltButton = b;
    } else if (touch) listen();
  }

  private load(level: number) {
    this.level = Math.max(1, level);
    try {
      localStorage.setItem('bobo.pour.level', String(this.level));
    } catch {
      /* private mode */
    }
    this.puzzle = generate(this.level);
    this.logic = this.puzzle.tubes.map((t) => t.slice());
    this.history = [];
    this.pours = [];
    this.stream.clear();
    this.sel = -1;
    this.moves = 0;
    this.doneAt = -1;
    this.celebrated = false;
    this.tubes = this.logic.map((t, i) => this.newTube(t, i));
    this.layout();
    this.levelEl.textContent = `Level ${this.level}`;
    const pl = plan(this.level);
    const fresh = (pl.oil && !plan(this.level - 1).oil) || (pl.syrup && !plan(this.level - 1).syrup);
    const hint = pl.oil && pl.syrup ? 'Oil floats · syrup sinks' : pl.oil ? 'Oil floats on water' : pl.syrup ? 'Syrup sinks under water' : 'Tap a tube, then where to pour';
    this.showHint(this.level === 1 || fresh ? hint : '');
    this.ctx.progress(0, 'sorted');
  }

  private showHint(text: string) {
    this.hintEl.textContent = text;
    this.hintEl.classList.toggle('show', !!text);
  }

  private newTube(t: number[], i: number): VTube {
    const draw: TubeDraw = {
      tx: 0,
      ty: 0,
      ang: 0,
      r: 1,
      h: 1,
      g: GLASS,
      d: new Float32Array(MAX_L),
      c: new Float32Array(MAX_L * 4),
      nl: 0,
      m1: 0,
      m2: 0,
      blobs: new Float32Array(24),
      blobC: [0, 0, 0, 0],
      nb: 0,
      cork: 0,
      corkY: 0,
      sel: 0,
      shimmer: -1,
    };
    return {
      layers: layersOf(t),
      home: [0, 0],
      tx: 0,
      ty: 0,
      ang: 0,
      lift: 0,
      liftV: 0,
      liftT: 0,
      wob: 0,
      // New levels drop in from above, staggered.
      enter: 520 + i * 60,
      enterV: 0,
      m1: 0,
      v1: 0,
      m2: 0,
      v2: 0,
      lastX: 0,
      lastVX: 0,
      lastY: 0,
      lastVY: 0,
      corked: false,
      cork: 0,
      corkY: 0,
      corkV: 0,
      shimmer: -1,
      busy: 'idle',
      rise: null,
      draw,
    };
  }

  private layout() {
    if (!this.puzzle) return;
    const W = this.vw, H = this.vh;
    const n = this.tubes.length;
    const cap = this.puzzle.cap;
    const rows = n > 5 && W < n * 84 ? 2 : 1;
    const perTop = Math.ceil(n / rows);
    const per = rows === 1 ? [n] : [perTop, n - perTop];
    const top = 150;
    const bottom = 96;
    const avail = Math.max(200, H - top - bottom);
    const rowGap = 70;
    this.slot = Math.min(88, (W - 24) / per[0]);
    const r = Math.min(26, this.slot * 0.31);
    const rowH = (avail - (rows - 1) * rowGap) / rows - 34;
    const unitH = Math.max(16, Math.min(64, (rowH - r * 0.3) / (cap + 0.6)));
    this.shape = new TubeShape(r, unitH, cap);
    const block = rows * this.shape.h + (rows - 1) * rowGap;
    const y0 = bottom + Math.max(0, (avail - block) / 2) + 10;
    let k = 0;
    const shelves: [number, number] = [-1, -1];
    for (let row = 0; row < rows; row++) {
      const yb = y0 + (rows - 1 - row) * (this.shape.h + rowGap);
      shelves[row] = yb - GLASS;
      for (let j = 0; j < per[row]; j++, k++) {
        const x = W / 2 + (j - (per[row] - 1) / 2) * this.slot;
        this.tubes[k].home = [x, yb];
      }
    }
    this.shelves = shelves;
    this.shelfW = (per[0] * this.slot) / 2 + 6;
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.vw = width / this.ctx.pixelRatio;
    this.vh = height / this.ctx.pixelRatio;
    this.renderer.resize(width, height);
    this.stream.resize(this.vw, this.vh);
    if (this.puzzle) {
      // Snap any pour in progress so geometry never straddles two layouts.
      this.snap();
      this.layout();
    }
  }

  // ---------------------------------------------------------------- input & moves

  private input() {
    for (const p of this.ctx.pointers.active.values()) if (p.justDown) this.tap(p.x * this.vw, p.y * this.vh);
  }

  private hit(x: number, y: number) {
    const hs = this.slot / 2;
    return this.tubes.findIndex((t) => Math.abs(x - t.home[0]) < hs && y > t.home[1] - 20 && y < t.home[1] + this.shape.h + 44);
  }

  private tap(x: number, y: number) {
    const i = this.hit(x, y);
    if (i < 0) {
      this.select(-1);
      return;
    }
    const t = this.tubes[i];
    if (this.sel < 0) {
      if (t.busy !== 'idle' || !this.logic[i].length || t.corked) return this.nope(i);
      return this.select(i);
    }
    if (this.sel === i) return this.select(-1);
    if (t.busy !== 'idle' || !canPour(this.puzzle, this.logic, this.sel, i)) {
      this.nope(this.sel);
      this.select(-1);
      return;
    }
    this.startPour(this.sel, i);
  }

  private select(i: number) {
    if (this.sel >= 0 && this.tubes[this.sel].busy === 'idle') this.tubes[this.sel].liftT = 0;
    this.sel = i;
    if (i < 0) return;
    this.tubes[i].liftT = 24;
    this.ctx.sound.play('tick', { pitch: 3, gain: 0.5, pan: this.pan(i) });
    this.ctx.haptic('light');
  }

  private nope(i: number) {
    this.tubes[i].wob = 1;
    this.ctx.sound.play('knock', { pitch: 1.6, gain: 0.35, pan: this.pan(i) });
    this.ctx.haptic('light');
  }

  private pan(i: number) {
    return (this.tubes[i].home[0] / this.vw - 0.5) * 1.4;
  }

  private startPour(a: number, b: number) {
    const before = this.logic;
    const { tubes, n, liq } = applyPour(this.puzzle, before, a, b);
    this.history.push(before);
    this.logic = tubes;
    this.moves++;
    this.sel = -1;
    const A = this.tubes[a], B = this.tubes[b];
    A.busy = 'src';
    B.busy = 'dst';
    // Tip over the side facing the middle of the screen so the tube body stays on-screen.
    const s = B.home[0] > this.vw / 2 ? 1 : B.home[0] < this.vw / 2 - 1 ? -1 : A.home[0] < B.home[0] ? 1 : -1;
    const lip = this.lipWorld(A, s);
    this.pours.push({
      a,
      b,
      n,
      liq,
      s,
      phase: 0,
      t: 0,
      emitted: 0,
      acc: 0,
      mag: 0,
      stall: 0,
      flow: 0,
      from: [lip[0], lip[1], A.ang],
      hit: false,
      bBefore: before[b].slice(),
      since: 0,
      finalized: false,
    });
    this.ctx.sound.play('whoosh', { pitch: 1.8, gain: 0.18, pan: this.pan(a) });
  }

  private undo() {
    if (!this.history.length || this.doneAt >= 0) return;
    this.snap();
    this.logic = this.history.pop()!;
    this.moves = Math.max(0, this.moves - 1);
    this.tubes.forEach((t, i) => {
      t.layers = layersOf(this.logic[i]);
      t.v2 += 30;
    });
    this.select(-1);
    this.ctx.sound.play('whoosh', { pitch: 0.8, gain: 0.25 });
  }

  /** Finish every animation at once (undo, resize): visuals jump to the logic state. */
  private snap() {
    this.stream.clear();
    this.pours = [];
    this.tubes.forEach((t, i) => {
      t.busy = 'idle';
      t.rise = null;
      t.ang = 0;
      t.liftT = 0;
      t.layers = layersOf(this.logic[i]);
    });
  }

  private busy() {
    return this.pours.length > 0 || this.stream.n > 0 || this.tubes.some((t) => t.busy !== 'idle' || t.rise || t.enter > 1);
  }

  // ---------------------------------------------------------------- geometry helpers

  private lipWorld(t: VTube, s: number): [number, number] {
    const { r, h } = this.shape;
    const c = Math.cos(t.ang), sn = Math.sin(t.ang);
    const lx = s * r, ly = h;
    return [t.tx + c * lx - sn * ly, t.ty + sn * lx + c * ly];
  }

  private setFromLip(t: VTube, s: number, px: number, py: number, ang: number) {
    const { r, h } = this.shape;
    const c = Math.cos(ang), sn = Math.sin(ang);
    const lx = s * r, ly = h;
    t.ang = ang;
    t.tx = px - (c * lx - sn * ly);
    t.ty = py - (sn * lx + c * ly);
  }

  private volume(t: VTube) {
    let v = 0;
    for (const l of t.layers) v += l.vol;
    return v;
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.input();
    this.stepTilt(dt);
    this.stepTubes(dt);
    this.stepPours(dt);
    const vessels = this.vessels();
    this.stream.step(
      dt,
      vessels,
      (ti, liq) => this.absorb(ti, liq),
      (ti, speed, x) => this.splashIn(ti, speed, x),
    );
    this.stepFinalize(dt);
    this.stepRise(dt);
    this.stepCorks(dt);
    this.stepAudio(dt);
    this.checkDone();
    this.render();
    this.undoEl.disabled = !this.history.length;
    this.ctx.setStatus(`${this.stream.n} drops · ${this.moves} moves`);
  }

  private stepTilt(dt: number) {
    // Screen-space gravity: its sideways part tilts every surface (kept level with the world).
    const gx = this.motion ? this.motion[0] : 0;
    const gy = this.motion ? this.motion[1] : -1;
    const target = Math.atan2(gx, Math.max(0.2, -gy));
    this.tiltX += (Math.max(-0.7, Math.min(0.7, target)) - this.tiltX) * (1 - Math.exp(-dt * 8));
  }

  private stepTubes(dt: number) {
    const { r } = this.shape;
    const k = this.cfg.slosh;
    for (let i = 0; i < this.tubes.length; i++) {
      const t = this.tubes[i];
      t.liftV += ((t.liftT - t.lift) * 260 - t.liftV * 20) * dt;
      t.lift += t.liftV * dt;
      t.wob = Math.max(0, t.wob - dt * 2.8);
      if (t.enter > 0 || t.enterV) {
        t.enterV -= 2600 * dt;
        t.enter += t.enterV * dt;
        if (t.enter < 0) {
          t.enter = 0;
          const bounce = -t.enterV * 0.28;
          if (-t.enterV > 250) this.ctx.sound.play('tick', { pitch: 2.4 + Math.random() * 0.5, gain: 0.35, pan: this.pan(i) });
          t.v2 += Math.min(60, -t.enterV * 0.06);
          t.enterV = bounce > 60 ? bounce : 0;
        }
      }
      if (t.busy !== 'src') {
        const shake = Math.sin(t.wob * 30) * t.wob * 5;
        t.tx = t.home[0] + shake;
        t.ty = t.home[1] + t.lift + t.enter;
        t.ang = 0;
      }
      // Two damped slosh modes, driven by tube motion and phone tilt.
      const vx = (t.tx - t.lastX) / dt;
      const vy = (t.ty - t.lastY) / dt;
      const ax = (vx - t.lastVX) / dt;
      const ay = (vy - t.lastVY) / dt;
      t.lastX = t.tx;
      t.lastY = t.ty;
      t.lastVX = vx;
      t.lastVY = vy;
      const m1T = r * Math.tan(this.tiltX) * 0.9;
      const w1 = 2 * Math.PI * 1.7, w2 = 2 * Math.PI * 2.8;
      t.v1 += (-(t.m1 - m1T) * w1 * w1 - t.v1 * 2 * 0.09 * w1 - Math.max(-9000, Math.min(9000, ax)) * 0.006 * k) * dt;
      t.v2 += (-t.m2 * w2 * w2 - t.v2 * 2 * 0.11 * w2 - Math.max(-9000, Math.min(9000, ay)) * 0.002 * k) * dt;
      t.m1 = Math.max(-r * 0.6, Math.min(r * 0.6, t.m1 + t.v1 * dt));
      t.m2 = Math.max(-5, Math.min(5, t.m2 + t.v2 * dt));
    }
  }

  private stepPours(dt: number) {
    const sp = this.cfg.speed;
    const shape = this.shape;
    const ua = shape.unitArea;
    for (const p of this.pours) {
      const A = this.tubes[p.a], B = this.tubes[p.b];
      p.t += dt;
      const target: [number, number] = [B.home[0] - p.s * shape.r * 0.15, B.home[1] + shape.h + 30];
      if (p.phase === 0) {
        const dur = 0.42 / Math.sqrt(sp);
        const e = ease(Math.min(1, p.t / dur));
        const mag0 = shape.spillAngle(this.volume(A) * ua, p.s) * 0.9;
        // Arc up and over, then tip to just before the liquid reaches the lip.
        const arc = Math.sin(e * Math.PI) * 26;
        this.setFromLip(A, p.s, lerp(p.from[0], target[0], e), lerp(p.from[1], target[1], e) + arc, lerp(p.from[2], -p.s * mag0, e));
        p.mag = Math.abs(A.ang);
        if (p.t >= dur) {
          p.phase = 1;
          p.t = 0;
        }
      } else if (p.phase === 1) {
        const V = this.volume(A);
        const spill = shape.spillAngle(V * ua, p.s);
        const goal = Math.min(2.35, spill + 0.1 + 0.16 * sp);
        p.mag += (goal - p.mag) * (1 - Math.exp(-dt * 5 * sp));
        this.setFromLip(A, p.s, target[0], target[1], -p.s * p.mag);
        // Flow follows the tilt: what sits above the lip line runs out.
        const excess = V - shape.capacity(-p.s * p.mag, p.s) / ua;
        let flow = Math.max(0, Math.min(3.2 * sp, excess * 7 * sp));
        if (flow < 0.08) p.stall += dt;
        else p.stall = 0;
        if (p.stall > 0.8) flow = 1.5 * sp;
        const emit = Math.min(flow * dt, p.n - p.emitted);
        p.flow = flow;
        if (emit > 0) {
          p.emitted += emit;
          const top = A.layers[A.layers.length - 1];
          if (top) top.vol = Math.max(0, top.vol - emit);
          this.emit(p, A, emit, flow);
        }
        if (p.emitted >= p.n - 1e-6) {
          p.phase = 2;
          p.t = 0;
          p.flow = 0;
          p.from = [target[0], target[1], A.ang];
          A.layers = layersOf(this.logic[p.a]);
        }
      } else if (p.phase === 2) {
        const dur = 0.4 / Math.sqrt(sp);
        const e = ease(Math.min(1, p.t / dur));
        const home = [A.home[0] + p.s * shape.r, A.home[1] + shape.h];
        this.setFromLip(A, p.s, lerp(p.from[0], home[0], e), lerp(p.from[1], home[1], e) + Math.sin(e * Math.PI) * 20, lerp(p.from[2], 0, e));
        if (p.t >= dur) {
          p.phase = 3;
          A.busy = 'idle';
          A.lift = A.liftT = A.liftV = 0;
          A.ang = 0;
          A.v1 += p.s * 40;
          this.ctx.sound.play('tick', { pitch: 3, gain: 0.45, pan: this.pan(p.a) });
        }
      }
    }
    this.pours = this.pours.filter((p) => p.phase < 3 || !p.finalized);
  }

  private emit(p: Pour, A: VTube, units: number, flow: number) {
    const liq = p.liq;
    const [lx, ly] = this.lipWorld(A, p.s);
    const c = Math.cos(A.ang), s = Math.sin(A.ang);
    // Axis (out of the mouth) and mouth direction (from this lip toward the other) in world space.
    const ax = -s, ay = c;
    const mx = -p.s * c, my = -p.s * s;
    p.acc += units * PPU;
    const width = Math.min(this.shape.r * 0.4, 3 + flow * 2);
    while (p.acc >= 1) {
      p.acc -= 1;
      // Leave the lip already falling, and spread spawns along the first few ms of the path: packed
      // tighter than the rest density, the near-pressure would blow the stream apart.
      const j = 1 + Math.random() * width;
      const vx = ax * (10 + 8 * flow) + (Math.random() - 0.5) * 4;
      const vy = ay * (10 + 8 * flow) - 200 - 30 * flow;
      const back = Math.random() * 0.016;
      this.stream.spawn(lx + mx * j + ax * 2 + vx * back, ly + my * j + ay * 2 + vy * back, vx, vy, liq, p.b);
    }
  }

  private vessels(): Vessel[] {
    const { r, h } = this.shape;
    return this.tubes.map((t) => ({
      cx: t.tx,
      by: t.ty,
      r,
      h,
      g: GLASS,
      level: this.shape.levelAt(this.volume(t)),
      m1: t.m1,
      m2: t.m2,
      solid: t.busy !== 'src' && t.lift < 3 && t.enter < 1,
    }));
  }

  private absorb(ti: number, liq: number) {
    const t = this.tubes[ti];
    const top = t.layers[t.layers.length - 1];
    if (top && top.liq === liq) top.vol += 1 / PPU;
    else t.layers.push({ liq, vol: 1 / PPU });
  }

  private splashIn(ti: number, speed: number, x: number) {
    const t = this.tubes[ti];
    t.v2 -= Math.min(30, speed * 0.03) * this.cfg.slosh;
    t.v1 += ((x - t.tx) / this.shape.r) * Math.min(20, speed * 0.02) * this.cfg.slosh;
    const p = this.pours.find((q) => q.b === ti && !q.hit);
    if (p) {
      p.hit = true;
      const fill = this.volume(t) / this.puzzle.cap;
      this.ctx.sound.play('plop', { pitch: 0.9 + fill * 0.6, gain: 0.5, pan: this.pan(ti) });
    }
  }

  /** Once the stream has landed, the target's stack becomes exact and re-orders by density. */
  private stepFinalize(dt: number) {
    for (const p of this.pours) {
      if (p.finalized || p.phase < 2) continue;
      p.since += dt;
      if (this.stream.inFlight(p.b) > 0 && p.since < 2.5) continue;
      p.finalized = true;
      const B = this.tubes[p.b];
      const raw = p.bBefore.concat(Array(p.n).fill(p.liq));
      B.layers = layersOf(raw);
    }
    for (let i = 0; i < this.tubes.length; i++) {
      const t = this.tubes[i];
      if (t.busy !== 'dst' || t.rise) continue;
      if (this.pours.some((p) => p.b === i && !p.finalized)) continue;
      if (!this.startRise(t)) {
        t.busy = 'idle';
        t.layers = layersOf(this.logic[i]);
      }
    }
  }

  private startRise(t: VTube) {
    const L = this.puzzle.liquids;
    for (let i = t.layers.length - 2; i >= 0; i--) {
      if (L[t.layers[i].liq].density < L[t.layers[i + 1].liq].density) {
        const v0 = t.layers[i].vol;
        t.layers.splice(i + 2, 0, { liq: t.layers[i].liq, vol: 0 });
        t.rise = { i, v0, t: 0, dur: 0.55 + 0.12 * v0 + 0.1 * t.layers[i + 1].vol };
        return true;
      }
    }
    return false;
  }

  private stepRise(dt: number) {
    for (const t of this.tubes) {
      const R = t.rise;
      if (!R) continue;
      R.t += dt * Math.sqrt(this.cfg.speed);
      const e = smoothstep(0, 1, Math.min(1, R.t / R.dur));
      t.layers[R.i].vol = R.v0 * (1 - e);
      t.layers[R.i + 2].vol = R.v0 * e;
      if (R.t >= R.dur) {
        t.rise = null;
        t.layers.splice(R.i, 1);
        t.layers = mergeLayers(t.layers);
        t.v2 += 12;
      }
    }
  }

  private stepCorks(dt: number) {
    let solvedCount = 0;
    for (let i = 0; i < this.tubes.length; i++) {
      const t = this.tubes[i];
      const done = tubeSolved(this.puzzle, this.logic[i]);
      if (done && t.busy === 'idle' && !t.rise && !t.corked && t.enter <= 0) {
        t.corked = true;
        t.corkY = 34;
        t.corkV = 0;
        t.shimmer = 0;
        this.ctx.sound.play('pop', { pitch: 1.1, gain: 0.7, pan: this.pan(i) });
        this.ctx.sound.play('chime', { pitch: 1 + solvedCount * 0.12, gain: 0.45, pan: this.pan(i) });
        this.ctx.haptic('medium');
      } else if (!done && t.corked) t.corked = false;
      t.cork += ((t.corked ? 1 : 0) - t.cork) * (1 - Math.exp(-dt * 14));
      if (t.corked) {
        t.corkV -= 1400 * dt;
        t.corkY += t.corkV * dt;
        if (t.corkY < 0) {
          t.corkY = 0;
          t.corkV = -t.corkV * 0.3;
          if (t.corkV < 40) t.corkV = 0;
        }
        solvedCount++;
      }
      if (t.shimmer >= 0) {
        t.shimmer += dt / 1.1;
        if (t.shimmer > 1) t.shimmer = -1;
      }
    }
    this.ctx.progress(solvedCount / this.puzzle.liquids.length, 'sorted');
  }

  private stepAudio(dt: number) {
    let flow = 0;
    let fill = 0;
    for (const p of this.pours) {
      if (p.phase !== 1) continue;
      flow = Math.max(flow, p.flow);
      fill = Math.max(fill, this.volume(this.tubes[p.b]) / this.puzzle.cap);
    }
    const f = Math.min(1, flow / 2.5);
    // Brightness climbs as the target fills: the air column above the liquid shortens.
    this.trickle.set(f * 0.85, 0.25 + fill * 0.75);
    this.bubble.set(this.tubes.some((t) => t.rise) ? 0.55 : 0, 0.6);
    if (f > 0.05) {
      this.buzz += dt * 8 * f;
      if (this.buzz >= 1) {
        this.buzz -= 1;
        this.ctx.haptic('light');
      }
    } else this.buzz = 0;
  }

  private checkDone() {
    if (!solved(this.puzzle, this.logic) || this.busy()) return;
    if (!this.tubes.every((t) => !this.logic[this.tubes.indexOf(t)].length || (t.corked && t.corkY === 0))) return;
    if (this.doneAt < 0) this.doneAt = this.time;
    if (!this.celebrated && this.time - this.doneAt > 0.35) {
      this.celebrated = true;
      this.celebrations++;
      this.ctx.celebrate('Sorted!');
    }
    if (this.time - this.doneAt > 2.6) this.load(this.level + 1);
  }

  // ---------------------------------------------------------------- render

  private render() {
    const { r, h } = this.shape;
    const L = this.puzzle.liquids;
    const draws: TubeDraw[] = [];
    const order = this.tubes.map((_, i) => i).sort((a, b) => rank(this.tubes[a]) - rank(this.tubes[b]));
    for (const i of order) {
      const t = this.tubes[i];
      const d = t.draw;
      d.tx = t.tx;
      d.ty = t.ty;
      d.ang = t.ang;
      d.r = r;
      d.h = h;
      d.m1 = t.m1;
      d.m2 = t.m2;
      d.sel = t.lift > 1 && t.busy === 'idle' ? Math.min(1, t.lift / 20) : 0;
      d.cork = t.cork;
      d.corkY = t.corkY;
      d.shimmer = t.shimmer;
      const pour = t.busy === 'src' ? this.pours.find((p) => p.a === i) : undefined;
      const lipD = pour ? this.shape.lipD(t.ang, pour.s) : Infinity;
      let cum = 0;
      let nl = 0;
      for (const l of t.layers) {
        if (l.vol < 0.004 || nl >= MAX_L) continue;
        cum += l.vol;
        const off = t.ang === 0 ? this.shape.levelAt(cum) : Math.min(lipD, this.shape.surface(t.ang, cum * this.shape.unitArea));
        d.d[nl] = off;
        const liq = L[l.liq];
        d.c.set([liq.rgb[0], liq.rgb[1], liq.rgb[2], liq.kind], nl * 4);
        nl++;
      }
      d.nl = nl;
      d.nb = 0;
      const R = t.rise;
      if (R) {
        // Blobs climb from the top of the shrinking layer to the bottom of the growing one.
        let below = 0;
        for (let k = 0; k < R.i; k++) below += t.layers[k].vol;
        const y0 = this.shape.levelAt(below + t.layers[R.i].vol);
        const y1 = this.shape.levelAt(below + t.layers[R.i].vol + t.layers[R.i + 1].vol);
        const u = R.t / R.dur;
        const env = Math.min(1, u * 5, (1 - u) * 5);
        const liq = L[t.layers[R.i].liq];
        d.blobC = [liq.rgb[0], liq.rgb[1], liq.rgb[2], liq.kind];
        for (let k = 0; k < 6; k++) {
          const ph = (R.t * 2.3 + k / 6) % 1;
          d.blobs[k * 4] = Math.sin(k * 2.1 + this.time * 3 + ph * 4) * r * 0.42;
          d.blobs[k * 4 + 1] = lerp(y0 - 2, y1 + 3, ph);
          d.blobs[k * 4 + 2] = r * (0.25 + 0.08 * Math.sin(k * 1.7)) * env * (1 - ph * 0.3);
          d.blobs[k * 4 + 3] = 0;
        }
        d.nb = 6;
      }
      draws.push(d);
    }
    const s = this.stream;
    const P = this.parts;
    // Each drop splats three times along its velocity: a cheap motion streak that keeps a fast,
    // thinning stream reading as one rope of liquid instead of a dotted line.
    let np = 0;
    for (let i = 0; i < s.n; i++) {
      const liq = L[s.liq[i]];
      for (let k = 0; k < 3; k++) {
        const o = np++ * 5;
        P[o] = s.px[i] - s.vx[i] * 0.005 * k;
        P[o + 1] = s.py[i] - s.vy[i] * 0.005 * k;
        P[o + 2] = liq.rgb[0];
        P[o + 3] = liq.rgb[1];
        P[o + 4] = liq.rgb[2];
      }
    }
    this.renderer.draw({
      view: [this.vw, this.vh],
      shelves: this.shelves,
      shelfW: this.shelfW,
      tubes: draws,
      parts: P,
      np,
      dropR: 7.5,
      time: this.time,
    });
  }

  destroy() {
    this.trickle.stop();
    this.bubble.stop();
    this.offMotion?.();
    this.renderer.destroy();
    this.hud.remove();
    this.tiltButton?.remove();
    this.style.remove();
    this.ctx.progress(null);
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__pour;
  }
}

/** Draw order: resting tubes, then the ones being poured into, then the pouring ones on top. */
function rank(t: VTube) {
  return t.busy === 'src' ? 2 : t.busy === 'dst' ? 1 : 0;
}

function layersOf(t: number[]): Layer[] {
  const out: Layer[] = [];
  for (const u of t) {
    const top = out[out.length - 1];
    if (top && top.liq === u) top.vol++;
    else out.push({ liq: u, vol: 1 });
  }
  return out;
}

function mergeLayers(ls: Layer[]) {
  const out: Layer[] = [];
  for (const l of ls) {
    if (l.vol <= 1e-4) continue;
    const top = out[out.length - 1];
    if (top && top.liq === l.liq) top.vol += l.vol;
    else out.push({ ...l });
  }
  return out;
}

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const UNDO_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/></svg>`;
const RESTART_ICON = `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>`;

const STYLE = `
.pour-hud { position: absolute; inset: 0; pointer-events: none; font-family: ui-rounded, -apple-system, system-ui, sans-serif; }
.pour-bar { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(16px + env(safe-area-inset-bottom, 0px)); display: flex; align-items: center; gap: 10px; padding: 6px; border-radius: 99px; background: rgba(10,10,16,0.55); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,0.12); pointer-events: auto; }
.pour-bar button { white-space: nowrap; height: 38px; min-width: 44px; padding: 0 14px; border: 0; border-radius: 99px; background: rgba(255,255,255,0.12); color: #fff; font: 700 14px/1 inherit; cursor: pointer; }
.pour-bar button { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.pour-bar svg { width: 18px; height: 18px; fill: none; stroke: currentColor; stroke-width: 2.4; stroke-linecap: round; stroke-linejoin: round; }
.pour-bar button:disabled { opacity: 0.35; cursor: default; }
.pour-level { min-width: 72px; text-align: center; color: #fff; font-weight: 800; font-size: 15px; letter-spacing: -0.01em; }
.pour-hint { position: absolute; left: 50%; bottom: calc(76px + env(safe-area-inset-bottom, 0px)); transform: translate(-50%, 8px); padding: 7px 14px; border-radius: 99px; background: rgba(255,255,255,0.14); color: #fff; font-weight: 700; font-size: 13px; white-space: nowrap; opacity: 0; transition: opacity .4s, transform .4s; }
.pour-hint.show { opacity: 1; transform: translate(-50%, 0); }
.pour-tilt { left: 50%; transform: translateX(-50%); bottom: calc(120px + env(safe-area-inset-bottom, 0px)); pointer-events: auto; }
`;
