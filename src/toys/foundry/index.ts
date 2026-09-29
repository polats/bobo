import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop } from '../../shell/sound';
import { BODY, INNER, area, areaBelow, place } from './crucible';
import { buildMould, layoutFor, type Layout, type Mould } from './mould';
import { C_METAL, C_SEAM, C_VOID, grade, modeFields, nearestNode, solveModes, strikePartials, type Grade, type ModalResult } from './modal';
import { SHAPES, makeShape, type Shape, type ShapeId } from './shapes';
import { FRAME, FREEZE, FoundrySim, LOOSE, METAL, SAND, type Assessment } from './sim';

export const foundryToy: Toy = {
  id: 'foundry',
  title: 'Foundry',
  blurb: 'Pour glowing bronze down the sprue and watch the head push it up into the mould from below, break it out, then tap the casting anywhere. It rings with its own computed modes, so a cold lap in the lip or a misrun at the crown changes the note.',
  tech: 'Falling-sand metal + conservative heat into sand · hydrostatic head (region labelling) for bottom gating · 2D FEM modal analysis (shift-invert Lanczos) → modal synthesis · Canvas 2D',
  swatch: 'linear-gradient(160deg,#1a100c 0 35%,#ff9a2a 50%,#fff1b8 56%,#b8733a 64%,#3a2418 100%)',
  refs: [
    {
      short: "O'Brien 2002",
      title: "Synthesizing Sounds from Rigid-Body Simulations (O'Brien, Shen & Gatchalian, SCA 2002)",
      url: 'https://doi.org/10.1145/545261.545290',
      use: 'Finite-element mesh of the object, eigen-decomposition of K and M into modes, Rayleigh damping, and a strike exciting each mode by its shape at the contact point.',
    },
    {
      short: 'van den Doel 1998',
      title: 'The Sounds of Physical Shapes (van den Doel & Pai, Presence 1998)',
      url: 'https://doi.org/10.1162/105474698565794',
      use: 'The note as a sum of exponentially decaying sines, one per mode, with amplitudes that depend on where the object is struck.',
    },
    {
      short: 'Ericsson & Ruhe 1980',
      title: 'The Spectral Transformation Lanczos Method for Large Sparse Generalized Symmetric Eigenvalue Problems (Math. Comp. 1980)',
      url: 'https://doi.org/10.1090/S0025-5718-1980-0583502-2',
      use: 'Shift-invert Lanczos on (K + sM)^-1 M to get the lowest modes from a banded Cholesky factor, with the rigid-body modes deflated.',
    },
    {
      short: 'Ungar & Kerwin 1962',
      title: 'Loss Factors of Viscoelastic Systems in Terms of Energy Concepts (JASA 1962)',
      url: 'https://doi.org/10.1121/1.1918227',
      use: "Each mode's extra damping from seams and voids, found by weighting each element's loss factor by its share of the mode's strain energy.",
    },
    {
      short: 'Noita',
      title: 'Exploring the Tech and Design of Noita (Petri Purho, GDC 2019)',
      url: 'https://www.youtube.com/watch?v=prXuyMCgbTc',
      use: 'The falling-sand update pattern: a bottom-up cell scan with alternating direction.',
    },
  ],
  async create(ctx) {
    return new Foundry(ctx);
  },
};

/** Sim steps per second, fixed so the metal behaves the same at any frame rate. */
const HZ = 120;
/** Crucible pour rate at full tilt, cells per second (before the tune slider). */
const MAX_RATE = 360;
const TILT_MAX = 1.95;
/** Crucible holds this much more than the mould needs, so a long pour overflows. */
const SPARE = 1.3;
/** Grade at which a casting rings true. */
const TRUE_Q = 0.85;
/** Milliseconds per frame the eigen-solves may use. */
const SOLVE_BUDGET = 2.5;
/** Padding around a casting's warp canvas, cells, and how far the strike wobble swings. */
const PAD = 3;
const WOBBLE = 2.2;
/** Seconds after the first ring before the casting flies up to the shelf. */
const FLY = 2.6;
const SPARKS = 160;
const CHIPS = 240;
const PUFFS = 36;
const SHELF_SLOTS = 5;

type Phase = 'enter' | 'pour' | 'cool' | 'break' | 'drop' | 'ring' | 'shelve';

interface Casting {
  shape: ShapeId;
  name: string;
  w: number;
  h: number;
  /** Local cell grid (the cavity's box): C_NONE, C_METAL, C_SEAM, or C_VOID where metal never got. */
  cell: Uint8Array;
  /** Rows down to the lowest metal (what it stands on). */
  foot: number;
  temp: Float32Array;
  lit: Float32Array;
  canvas: HTMLCanvasElement;
  cg: CanvasRenderingContext2D;
  img: ImageData;
  glow: HTMLCanvasElement;
  gg: CanvasRenderingContext2D;
  gimg: ImageData;
  /** Top-left in grid cells, velocity, tilt. */
  x: number;
  y: number;
  vy: number;
  a: number;
  va: number;
  /** Target angle once shelved (bowls are cast upside down). */
  flip: number;
  /** Grade from the modes (NaN until solved). */
  q: number;
  voids: number;
  seams: number;
  ringT: number;
  clarity: number;
  hot: boolean;
  /** Modal analysis (undefined while solving, null if nothing solid to ring), and its pitch scale. */
  modes?: ModalResult | null;
  scale: number;
  grade: Grade | null;
  /** Per-pixel mode shapes over the padded warp canvas, and the strike's wobble per mode. */
  fields: Float32Array[];
  fw: number;
  fh: number;
  wob: Float32Array;
  wobF: Float32Array;
  wobTau: Float32Array;
  warp: HTMLCanvasElement | null;
  wg: CanvasRenderingContext2D | null;
  wimg: ImageData | null;
  /** Where it was last struck, local cells. */
  hitX: number;
  hitY: number;
  landed: boolean;
}

/** Flawless castings of each mould (shape/thin), solved once; the scale comes from round 0. */
const templates = new Map<string, ModalResult | null>();

/** The cavity of a shape as a casting grid, every cell sound metal. */
function shapeMask(shape: Shape) {
  let x0 = 1e9, x1 = -1e9;
  for (let y = 0; y <= shape.h; y++) for (let x = -40; x <= 40; x++) if (shape.inside(x, y)) {
    x0 = Math.min(x0, x);
    x1 = Math.max(x1, x);
  }
  const w = x1 - x0 + 1, h = shape.h + 1;
  const cell = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = x0; x <= x1; x++) if (shape.inside(x, y)) cell[y * w + x - x0] = C_METAL;
  return { cell, w, h, x0 };
}

/** Heat to colour: dark bronze -> dull red -> orange -> yellow -> white. 256 entries x rgb. */
const METAL_RGB = new Uint8Array(256 * 3);
const GLOW_RGB = new Uint8Array(256 * 3);
{
  const stops: [number, number, number, number][] = [
    [0, 90, 20, 8],
    [0.25, 205, 48, 10],
    [0.5, 255, 122, 26],
    [0.75, 255, 206, 104],
    [1, 255, 250, 228],
  ];
  const ramp = (t: number, o: number[]) => {
    t = Math.max(0, Math.min(1, t));
    let i = 0;
    while (i < stops.length - 2 && t > stops[i + 1][0]) i++;
    const [a0, ...ca] = stops[i], [a1, ...cb] = stops[i + 1];
    const f = (t - a0) / (a1 - a0);
    for (let c = 0; c < 3; c++) o[c] = ca[c] + (cb[c] - ca[c]) * f;
  };
  const sm = (a: number, b: number, x: number) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const bronze = [172, 120, 64], oxide = [118, 52, 30], g = [0, 0, 0];
  for (let i = 0; i < 256; i++) {
    const T = i / 255;
    ramp((T - 0.3) / 0.7, g);
    const e = sm(0.32, 1, T);
    for (let c = 0; c < 3; c++) {
      const cold = bronze[c] + (oxide[c] - bronze[c]) * Math.min(1, T / 0.3);
      METAL_RGB[i * 3 + c] = cold + (g[c] - cold) * sm(0.3, 0.46, T);
      GLOW_RGB[i * 3 + c] = g[c] * e;
    }
  }
}

class Foundry implements ToyInstance {
  private g: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private cs = 1;
  private cols = 1;
  private rows = 1;
  private sim!: FoundrySim;
  private L!: Layout;
  private mould!: Mould;
  private level = 0;
  private phase: Phase = 'pour';
  private phaseT = 0;
  private time = 0;
  private acc = 0;
  // Crucible
  private tilt = 0;
  private left = 0;
  private cap = 0;
  private areaScale = 1;
  private rate = 0;
  private pourAcc = 0;
  private poured = 0;
  private sinceHold = 99;
  private crucLift = 0;
  private readonly innerW = new Float32Array(8);
  private readonly bodyW = new Float32Array(8);
  private innerArea = area(Float32Array.from(INNER), 4);
  // Mould state
  private stat: Assessment = { fill: 0, voids: 1, seams: 0, maxT: 0 };
  /** Eigen-solves in flight, stepped a few milliseconds per frame. */
  private jobs: { key?: string; gen: Generator<void, ModalResult | null>; done: (r: ModalResult | null) => void }[] = [];
  private solveMs = 0;
  private hits = 0;
  private swipe = new Map<number, [number, number, number]>();
  private frameGone = -1;
  private boardGone = -1;
  private slide = 0;
  private casting: Casting | null = null;
  private shelf: Casting[] = [];
  private celebrated = false;
  private shake = 0;
  // Layers
  private bg: HTMLCanvasElement;
  private layer: HTMLCanvasElement;
  private lg: CanvasRenderingContext2D;
  private img!: ImageData;
  private glowA: HTMLCanvasElement;
  private ga: CanvasRenderingContext2D;
  private gimg!: ImageData;
  private mips: HTMLCanvasElement[] = [];
  private light: HTMLCanvasElement;
  private puffSprite: HTMLCanvasElement;
  private grain!: Uint8Array;
  // Particles (flat pools, no per-frame allocation)
  private sparks = new Float32Array(SPARKS * 5);
  private chips = new Float32Array(CHIPS * 6);
  private puffs = new Float32Array(PUFFS * 5);
  private sp = 0;
  private cp = 0;
  private pp = 0;
  // Sound
  private hiss: Loop;
  private trickle: Loop;
  private rumble: Loop;
  private crackle: Loop;
  private nextSizzle = 0;
  private nextBuzz = 0;
  private flowed = 0;
  private crumbled = 0;
  private lastCrumble = 0;
  private events: { at: number; fn: () => void }[] = [];
  // UI
  private style: HTMLStyleElement;
  private hint: HTMLElement;
  private toast: HTMLElement;
  private tune = { rate: 1 };
  /** Smoothed milliseconds per frame in the sim and in everything else. */
  private perf = { sim: 0, draw: 0, worst: 0 };
  private dev = {
    rings: [] as { mould: string; q: number; at: number[]; f: number[]; decay: number[]; amp: number[] }[],
    grades: [] as { mould: string; q: number; ring: number; detune: number; semis: number; fill: number; seams: number }[],
    celebrations: 0,
    cycles: [] as number[],
    pourStart: -1,
    worstSolveSlice: 0,
  };

  constructor(private ctx: ToyContext) {
    const g = ctx.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('Canvas 2D is not available.');
    this.g = g;
    this.bg = document.createElement('canvas');
    this.layer = document.createElement('canvas');
    this.lg = this.layer.getContext('2d')!;
    this.glowA = document.createElement('canvas');
    this.ga = this.glowA.getContext('2d')!;
    for (let i = 0; i < 3; i++) this.mips.push(document.createElement('canvas'));
    this.light = radial(128, [255, 150, 60]);
    this.puffSprite = radial(64, [70, 60, 56]);
    this.hiss = ctx.sound.loop('hiss');
    this.trickle = ctx.sound.loop('trickle');
    this.rumble = ctx.sound.loop('rumble');
    this.crackle = ctx.sound.loop('crackle');
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'fdy-hint';
    this.toast = document.createElement('div');
    this.toast.className = 'fdy-toast';
    ctx.overlay.append(this.hint, this.toast);
    ctx.panel.slider(this.tune, 'rate', { label: 'Pour rate', min: 0.4, max: 1.6, step: 0.05 });
    ctx.panel.action('Next mould', () => this.nextMould(true));
    ctx.panel.action('Pour this mould again', () => this.startMould(false));
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.reset();
    ctx.progress(0, 'filled');
    if (import.meta.env.DEV)
      (window as unknown as Record<string, unknown>).__foundry = () => ({
        phase: this.phase,
        mould: this.mould.shape.name,
        level: this.level,
        fill: +this.stat.fill.toFixed(3),
        rose: this.sim.rose,
        jobs: this.jobs.length,
        seams: +this.stat.seams.toFixed(3),
        maxT: +this.stat.maxT.toFixed(3),
        poured: this.poured,
        left: Math.round(this.left),
        rate: Math.round(this.rate),
        tilt: +this.tilt.toFixed(2),
        casting: this.casting ? { q: +this.casting.q.toFixed(3), y: +this.casting.y.toFixed(1), vy: +this.casting.vy.toFixed(1), solved: this.casting.modes !== undefined, screen: this.castingScreen() } : null,
        pourX: this.mould.pourX,
        cs: this.cs,
        solveMs: +this.solveMs.toFixed(1),
        shelf: this.shelf.map((c) => `${c.name} ${Math.round(c.q * 100)}%`),
        simMs: +this.perf.sim.toFixed(2),
        drawMs: +this.perf.draw.toFixed(2),
        worstMs: +this.perf.worst.toFixed(1),
        resetWorst: () => (this.perf.worst = 0),
        ...this.dev,
      });
  }

  // ---------------------------------------------------------------- setup

  private reset() {
    this.cs = Math.min(this.width / 120, this.height / 250);
    this.cols = Math.ceil(this.width / this.cs);
    this.rows = Math.ceil(this.height / this.cs);
    this.sim = new FoundrySim(this.cols, this.rows);
    this.L = layoutFor(this.rows, this.cols);
    this.layer.width = this.glowA.width = this.cols;
    this.layer.height = this.glowA.height = this.rows;
    this.img = this.lg.createImageData(this.cols, this.rows);
    this.gimg = this.ga.createImageData(this.cols, this.rows);
    this.mips.forEach((m, i) => {
      m.width = Math.ceil(this.cols / 2 ** (i + 1));
      m.height = Math.ceil(this.rows / 2 ** (i + 1));
    });
    this.grain = makeGrain(this.cols, this.rows);
    this.drawBackground();
    const pr = this.ctx.pixelRatio;
    this.hint.style.top = `${((this.L.floorY + 9) * this.cs) / pr}px`;
    this.toast.style.top = `${((this.L.flaskTop - 4) * this.cs) / pr}px`;
    this.startMould(false);
  }

  private startMould(slideIn: boolean) {
    const shape = makeShape(SHAPES[this.level % SHAPES.length], Math.floor(this.level / SHAPES.length));
    this.mould = buildMould(this.sim, this.L, shape);
    // Solve the flawless castings in the background while the player pours.
    this.template(shape.id, 0);
    this.template(shape.id, Math.floor(this.level / SHAPES.length));
    this.cap = this.mould.volume * SPARE;
    this.left = this.cap;
    // Metal starts a little below the rim, so the first bit of tilt already pours.
    this.areaScale = this.cap / (this.innerArea * 0.86);
    this.tilt = 0;
    this.rate = 0;
    this.poured = 0;
    this.pourAcc = 0;
    this.sinceHold = 99;
    this.hits = 0;
    this.frameGone = this.boardGone = -1;
    this.casting = null;
    this.celebrated = false;
    this.stat.fill = 0;
    this.stat.maxT = 0;
    this.dev.pourStart = -1;
    this.setPhase(slideIn ? 'enter' : 'pour');
    this.slide = slideIn ? this.cols : 0;
    this.crucLift = slideIn ? 70 : 0;
    this.ctx.progress(0, 'filled');
    this.setHint(slideIn ? '' : 'Hold to pour');
  }

  private nextMould(skip: boolean) {
    if (skip && this.casting && this.phase !== 'pour') this.shelve(this.casting);
    this.level++;
    this.startMould(true);
    this.ctx.sound.play('whoosh', { pitch: 0.7, gain: 0.6 });
  }

  private setPhase(p: Phase) {
    this.phase = p;
    this.phaseT = 0;
  }

  private setHint(text: string) {
    if (this.hint.textContent === text) return;
    this.hint.textContent = text;
    this.hint.classList.toggle('show', !!text);
  }

  private showToast(text: string, good: boolean) {
    this.toast.textContent = text;
    this.toast.classList.toggle('good', good);
    this.toast.classList.remove('show');
    void this.toast.offsetWidth;
    this.toast.classList.add('show');
  }

  private later(delay: number, fn: () => void) {
    this.events.push({ at: this.time + delay, fn });
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.phaseT += dt;
    for (let i = this.events.length - 1; i >= 0; i--)
      if (this.events[i].at <= t) {
        const e = this.events[i];
        this.events.splice(i, 1);
        e.fn();
      }
    const holding = this.input();
    this.crucible(dt, holding);
    // Fixed-rate sim steps (capped so a slow frame can't snowball).
    this.acc = Math.min(this.acc + dt, 4 / HZ);
    this.flowed = 0;
    this.crumbled = 0;
    const s = this.sim;
    const t0 = performance.now();
    while (this.acc >= 1 / HZ) {
      this.acc -= 1 / HZ;
      this.pourStep(1 / HZ);
      s.step(1 / HZ);
      this.flowed += s.flowed;
      this.crumbled += s.crumbled;
    }
    if ((Math.floor(t * 60) & 3) === 0 || this.phase === 'pour' || this.phase === 'cool') s.assess(this.mould.cav, this.stat);
    const t1 = performance.now();
    this.runJobs();
    this.advance(dt);
    this.stepCasting(dt);
    this.stepParticles(dt);
    this.sounds(dt);
    this.draw();
    const t2 = performance.now();
    this.perf.sim += (t1 - t0 - this.perf.sim) * 0.05;
    this.perf.draw += (t2 - t1 - this.perf.draw) * 0.05;
    this.perf.worst = Math.max(this.perf.worst, t2 - t0);
    if (this.phase === 'pour' || this.phase === 'cool' || this.phase === 'break') this.ctx.progress(Math.min(1, this.stat.fill), 'filled');
    const c = this.casting;
    this.ctx.setStatus(`${this.mould.shape.name} · mould ${this.level + 1}${c ? (c.q === c.q ? ` · ${Math.round(c.q * 100)}% sound` : ' · listening…') : ` · ${Math.round(this.stat.fill * 100)}% filled`}`);
  }

  /** Returns whether the pour is being held. Taps drive breaking, ringing and the shelf. */
  private input() {
    const { cs } = this;
    let holding = false;
    for (const p of this.ctx.pointers.active.values()) {
      const gx = (p.x * this.width) / cs, gy = ((1 - p.y) * this.height) / cs;
      const onShelf = gy > this.L.floorY + 14;
      if (p.justDown && onShelf) {
        this.tapShelf(gx, gy);
        continue;
      }
      if (onShelf) continue;
      holding = true;
      if (this.phase === 'break') {
        const last = this.swipe.get(p.id);
        if (p.justDown || !last) {
          this.swipe.set(p.id, [gx, gy, 0]);
          if (p.justDown) this.hit(gx, gy, 1);
        } else {
          last[2] += Math.hypot(gx - last[0], gy - last[1]);
          last[0] = gx;
          last[1] = gy;
          if (last[2] > 9) {
            last[2] = 0;
            this.hit(gx, gy, 0.8);
          }
        }
      } else if (p.justDown && (this.phase === 'ring' || (this.phase === 'shelve' && this.phaseT < FLY - 0.1)) && this.casting) {
        const c = this.casting;
        const [lx, ly] = this.toLocal(c, gx, gy, c.x + c.w / 2, c.y + c.h / 2, 1);
        this.ring(c, 1, lx, ly, (gx / this.cols - 0.5) * 0.6);
      }
      else if (p.justDown && this.phase === 'cool') this.setHint('Let it set…');
    }
    if (!this.ctx.pointers.active.size) this.swipe.clear();
    return holding && this.phase === 'pour';
  }

  // ---------------------------------------------------------------- pour

  private crucible(dt: number, holding: boolean) {
    // Hold to tip; let go and it rights itself quicker than it tipped.
    if (holding && this.left > 0.5) this.tilt = Math.min(TILT_MAX, this.tilt + dt * (2.2 - this.tilt * 0.6));
    else this.tilt = Math.max(0, this.tilt - dt * 2.6);
    if (holding) this.sinceHold = 0;
    else this.sinceHold += dt;
    const lift = this.phase === 'enter' || this.phase === 'pour' ? 0 : 70;
    this.crucLift += (lift - this.crucLift) * Math.min(1, dt * (lift ? 1.8 : 3.2));
    const lx = this.mould.pourX + 0.5, ly = this.L.lipY - this.crucLift;
    place(INNER, this.tilt, lx, ly, this.innerW);
    place(BODY, this.tilt, lx, ly, this.bodyW);
    // Whatever no longer fits below the lip line spills over it.
    const fits = areaBelow(this.innerW, 4, ly) * this.areaScale;
    const excess = this.left - fits;
    const max = MAX_RATE * this.tune.rate;
    const want = this.phase === 'pour' && excess > 0 ? Math.min(max, excess * 7) : 0;
    this.rate += (want - this.rate) * Math.min(1, dt * 14);
    if (this.rate < 4 && want === 0) this.rate = 0;
  }

  private pourStep(h: number) {
    const s = this.sim;
    s.stir += ((this.rate > 30 ? 1 : 0) - s.stir) * Math.min(1, h * 8);
    if (this.phase !== 'pour' || this.rate <= 0) return;
    this.pourAcc += this.rate * h;
    const n = Math.min(this.left, Math.floor(this.pourAcc));
    if (n < 1) return;
    this.pourAcc -= n;
    const w = this.rate > 240 ? 3 : this.rate > 110 ? 2 : 1;
    const placed = s.pour(this.mould.pourX - (w >> 1), this.L.lipY + 1, w, n);
    this.left -= placed;
    this.poured += placed;
    if (this.dev.pourStart < 0) this.dev.pourStart = this.time;
  }

  // ---------------------------------------------------------------- phases

  private advance(dt: number) {
    const s = this.sim;
    switch (this.phase) {
      case 'enter': {
        const k = Math.min(1, this.phaseT / 0.7);
        this.slide = this.cols * (1 - k) ** 3;
        if (k >= 1) {
          this.slide = 0;
          this.setPhase('pour');
          this.setHint('Hold to pour');
          this.ctx.sound.play('thud', { pitch: 0.8, gain: 0.5 });
        }
        break;
      }
      case 'pour': {
        if (this.poured > 0) this.setHint(this.stat.fill >= 0.995 ? 'Full — let go' : this.rate > 0 ? 'Keep it steady…' : 'Hold to pour');
        // Pour is over when the crucible is empty, or it's been set down for a moment.
        const full = this.stat.fill >= 0.995;
        const done = this.left < 1 || (this.poured > 0 && this.rate === 0 && this.sinceHold > (full ? 0.35 : 1.3) && this.stat.fill > 0.05);
        if (done) {
          this.setPhase('cool');
          this.setHint('');
        }
        break;
      }
      case 'cool': {
        // Speed the set up once the pour is over, so it goes white -> orange -> dark in seconds.
        s.quench = Math.min(3, s.quench + dt * 3);
        s.bulk = 0.25;
        s.stir = 0;
        s.shutOn = false;
        if (this.phaseT > 0.5 && this.stat.maxT < FREEZE && this.gateSolid()) {
          this.setPhase('break');
          this.setHint('Tap to break the mould');
          this.ctx.sound.play('tick', { pitch: 0.8 });
        } else if (this.phaseT > 0.4) this.setHint('Setting…');
        break;
      }
      case 'break':
        if (this.hits >= 3 || (this.hits > 0 && this.packedLeft() < 0.6)) this.collapse();
        break;
      case 'ring':
        break;
    }
  }

  private gateSolid() {
    const { cells, temp } = this.sim;
    for (const k of this.mould.gate) if (cells[k] === METAL && temp[k] >= FREEZE) return false;
    return true;
  }

  private packedLeft() {
    const { cells, W } = this.sim;
    const { flaskTop, flaskBot, cx, half } = this.L;
    let n = 0;
    for (let y = flaskTop; y < flaskBot; y += 2) for (let x = cx - half; x <= cx + half; x += 2) if (cells[y * W + x] === SAND) n++;
    return (n * 4) / this.mould.sand;
  }

  // ---------------------------------------------------------------- break-out

  private hit(gx: number, gy: number, strength: number) {
    const { flaskTop, flaskBot, cx, half } = this.L;
    if (gy < flaskTop - 12 || gy > flaskBot + 6 || Math.abs(gx - cx) > half + 10) return;
    const x = Math.max(cx - half, Math.min(cx + half, gx)), y = Math.max(flaskTop, Math.min(flaskBot - 1, gy));
    const n = this.sim.loosen(x, y, 12 * strength);
    this.hits += strength >= 1 ? 1 : 0.5;
    this.shake = Math.max(this.shake, 0.5);
    this.spawnChips(x, y, 14);
    this.ctx.haptic('medium');
    this.ctx.sound.play('thud', { pitch: 1.1 + Math.random() * 0.2, gain: 0.7 });
    this.ctx.sound.play('crumble', { pitch: 0.9 + Math.random() * 0.3, gain: Math.min(1, 0.4 + n / 300) });
    if (this.frameGone < 0) {
      // First blow knocks the flask frame off.
      this.frameGone = this.time;
      this.clearFrame(false);
      this.ctx.sound.play('knock', { pitch: 0.55, gain: 0.9 });
      this.ctx.sound.play('whoosh', { pitch: 0.9, gain: 0.5 });
    }
  }

  private clearFrame(board: boolean) {
    const { cells, W, H } = this.sim;
    const { flaskTop, flaskBot, cx, half } = this.L;
    for (let y = Math.max(0, flaskTop - 3); y <= Math.min(H - 1, flaskBot); y++)
      for (let x = cx - half - 2; x <= cx + half + 2; x++) {
        const k = y * W + x;
        if (cells[k] !== FRAME) continue;
        if (board || y < flaskBot) cells[k] = 0;
      }
  }

  private collapse() {
    const s = this.sim;
    s.collapse = true;
    this.boardGone = this.time;
    this.clearFrame(true);
    this.setHint('');
    this.ctx.sound.play('crumble', { pitch: 0.7, gain: 1 });
    this.ctx.sound.play('snap', { pitch: 0.8, gain: 0.7 });
    // The casting is everything in the cavity; the gate and any overflow snap off as scrap.
    const { cells, W } = s;
    s.assess(this.mould.cav, this.stat);
    // The casting's grid is the cavity's box, aligned with the flawless template's mesh.
    const shape = this.mould.shape, box = shapeMask(shape);
    const x0 = this.mould.cavX + box.x0, y0 = this.mould.cavTop, w = box.w, h = box.h;
    let metal = 0;
    for (const k of this.mould.cav) if (cells[k] === METAL) metal++;
    if (metal > 0) {
      const c = makeCasting(shape.id, shape.name, w, h, x0, y0, this.stat);
      for (const k of this.mould.cav) {
        const i = ((k / W) | 0) - y0, j = (k % W) - x0;
        if (cells[k] !== METAL) {
          c.cell[i * w + j] = C_VOID;
          continue;
        }
        c.cell[i * w + j] = s.isShut(k) ? C_SEAM : C_METAL;
        c.temp[i * w + j] = s.temp[k];
        c.foot = Math.max(c.foot, i + 1);
        cells[k] = 0;
      }
      shadeCasting(c);
      this.casting = c;
      this.solveCasting(c, shape, Math.floor(this.level / SHAPES.length));
    }
    for (let k = 0; k < cells.length; k++) if (cells[k] === METAL) cells[k] = METAL | LOOSE;
    this.setPhase('drop');
    this.dropDelay = 0.28;
  }

  private dropDelay = 0;

  private stepCasting(dt: number) {
    const c = this.casting;
    if (c) {
      if (this.phase === 'drop') {
        this.dropDelay -= dt;
        if (this.dropDelay <= 0) {
          c.vy += 260 * dt;
          c.y += c.vy * dt;
          const floor = this.L.floorY - c.foot;
          if (c.y >= floor) {
            c.y = floor;
            const hard = c.vy > 30;
            if (hard) {
              this.ctx.haptic('heavy');
              this.ctx.sound.play('thud', { pitch: 0.55 + 20 / c.h, gain: Math.min(1, c.vy / 90) });
              this.ctx.sound.play('knock', { pitch: 0.5, gain: Math.min(1, c.vy / 120) });
              this.shake = Math.max(this.shake, Math.min(1, c.vy / 80));
              c.va += (Math.random() - 0.5) * 1.2;
              this.spawnChips(c.x + c.w / 2, this.L.floorY - 1, 18);
            }
            c.vy = -c.vy * 0.28;
            if (!hard) {
              c.vy = 0;
              c.landed = true;
            }
          }
        }
        // Ready to ring once it has settled and its modes are in.
        if (c.landed && c.modes !== undefined) {
          this.setPhase('ring');
          this.setHint('Tap it anywhere to ring it');
        }
      }
      // Wobble settles flat (or towards upright on the way to the shelf).
      c.va += (-(c.a - (this.phase === 'shelve' && this.phaseT > FLY ? c.flip : 0)) * 70 - c.va * 7) * dt;
      c.a += c.va * dt;
      if (c.ringT >= 0) c.ringT += dt;
      this.coolCasting(c, dt);
    }
    for (const s of this.shelf) if (s.ringT >= 0) s.ringT += dt;
  }

  private coolCasting(c: Casting, dt: number) {
    if (!c.hot) return;
    let hot = false;
    for (let i = 0; i < c.temp.length; i++) {
      if (!c.cell[i]) continue;
      const T = Math.max(0, c.temp[i] - dt * 0.22);
      c.temp[i] = T;
      if (T > 0.01) hot = true;
    }
    paintCasting(c);
    c.hot = hot;
  }

  // ---------------------------------------------------------------- ring

  /**
   * Strike a casting at a point (local cells). The note is the casting's own modes, each as loud as
   * the mode shape moves at the strike point along the blow, so every spot sounds a bit different.
   */
  private ring(c: Casting, gain: number, lx: number, ly: number, pan: number) {
    const m = c.modes;
    const snd = this.ctx.sound;
    c.ringT = 0;
    this.ctx.haptic('light');
    if (!m) {
      // Nothing whole enough to ring: a dead clunk.
      snd.play('knock', { pitch: 0.6, gain: gain * 0.8 });
      snd.play('thud', { pitch: 1.1, gain: gain * 0.6 });
      c.clarity = 0;
    } else {
      const n = nearestNode(m, lx, ly);
      const [dx, dy] = this.inward(c, lx, ly);
      const parts = strikePartials(m, n, dx, dy, c.scale);
      // A damped casting sheds its energy fast; lift it a little so a dull clunk still carries.
      snd.modes(parts, { gain: Math.min(1, gain * (0.8 + 0.4 * (1 - (c.q === c.q ? c.q : 1)))), pan, strike: 0.55 });
      // The same modes, slowed to a visible wobble.
      let tot = 0, top = 0;
      for (const p of parts) {
        tot += p.amp;
        top = Math.max(top, p.amp);
      }
      for (let k = 0; k < parts.length; k++) {
        c.wob[k] = parts[k].amp / (top || 1);
        c.wobF[k] = 5 * Math.sqrt(parts[k].freq / parts[0].freq);
        c.wobTau[k] = Math.min(1.1, 0.12 + parts[k].decay * 0.25);
      }
      c.hitX = lx;
      c.hitY = ly;
      c.clarity = c.q;
      if (import.meta.env.DEV)
        this.dev.rings.push({
          mould: c.name, q: +c.q.toFixed(3), at: [Math.round(lx), Math.round(ly)],
          f: parts.map((p) => Math.round(p.freq)), decay: parts.map((p) => +p.decay.toFixed(2)), amp: parts.map((p) => +(p.amp / (tot || 1)).toFixed(3)),
        });
    }
    if (c !== this.casting || this.phase !== 'ring') return;
    const q = c.q, gr = c.grade;
    const pct = Math.round(q * 100);
    const where = gr && gr.flawY === gr.flawY ? makeShape(c.shape, 0).part(gr.flawY) : this.voidPart(c);
    let verdict = 'Rang true!';
    if (q < TRUE_Q) {
      if (!gr) verdict = 'Clunk. Misrun';
      else if (c.seams > 0.002 && gr.ring < 0.8) verdict = `Cold shut at the ${where}: a short ring`;
      else if (c.voids > 0.01) verdict = `Short of metal at the ${where}: rings ${gr.semis < 0 ? 'flat' : 'sharp'}`;
      else verdict = 'Rang a little sour';
    }
    this.showToast(`${verdict} ${pct}%`, q >= TRUE_Q);
    if (q >= TRUE_Q && !this.celebrated) {
      this.celebrated = true;
      this.later(0.9, () => {
        this.dev.celebrations++;
        this.ctx.celebrate('Rang true!');
      });
    }
    this.setPhase('shelve');
    this.setHint('Tap again to hear another spot');
    if (this.dev.pourStart >= 0) this.dev.cycles.push(+(this.time - this.dev.pourStart).toFixed(1));
    this.later(FLY + 0.7, () => {
      if (this.casting === c) this.shelve(c);
      this.nextMould(false);
    });
  }

  /** Direction a blow at a point pushes the metal: into the casting, away from the open side. */
  private inward(c: Casting, lx: number, ly: number): [number, number] {
    let sx = 0, sy = 0;
    const i0 = Math.round(ly - 0.5), j0 = Math.round(lx - 0.5);
    for (let i = i0 - 3; i <= i0 + 3; i++)
      for (let j = j0 - 3; j <= j0 + 3; j++) {
        if (i < 0 || j < 0 || i >= c.h || j >= c.w) continue;
        const v = c.cell[i * c.w + j];
        if (v !== C_METAL && v !== C_SEAM) continue;
        sx += j + 0.5 - lx;
        sy += i + 0.5 - ly;
      }
    return Math.hypot(sx, sy) > 0.5 ? [sx, sy] : [1, 0.3];
  }

  /** Which part of the casting the metal never reached. */
  private voidPart(c: Casting) {
    let y = 0, n = 0;
    for (let k = 0; k < c.cell.length; k++)
      if (c.cell[k] === C_VOID) {
        y += (k / c.w) | 0;
        n++;
      }
    return makeShape(c.shape, 0).part(n ? y / n : c.h / 2);
  }

  /** Solve the flawless casting of a mould once, in the background. */
  private template(id: ShapeId, thin: number) {
    const key = `${id}/${thin}`;
    if (templates.has(key) || this.jobs.some((j) => j.key === key)) return;
    const box = shapeMask(makeShape(id, thin));
    const job = { key, gen: solveModes(box.cell, box.w, box.h), done: (r: ModalResult | null) => templates.set(key, r) };
    this.jobs.push(job);
  }

  /** Queue the casting's own solve behind its templates; grade it against them when done. */
  private solveCasting(c: Casting, shape: Shape, thin: number) {
    const tplKey = `${shape.id}/${thin}`;
    this.template(shape.id, 0);
    this.template(shape.id, thin);
    this.jobs.push({
      gen: solveModes(c.cell, c.w, c.h),
      done: (r) => {
        const base = templates.get(`${shape.id}/0`), tpl = templates.get(tplKey);
        c.scale = base ? shape.f1 / Math.sqrt(base.lambda[0]) : 1;
        c.modes = r;
        if (r && tpl) {
          c.grade = grade(r, tpl, c.scale);
          c.q = c.grade.q;
          const f = modeFields(r, c.cell, PAD);
          c.fields = f.fields;
          c.fw = f.W;
          c.fh = f.H;
          c.warp = document.createElement('canvas');
          c.warp.width = f.W;
          c.warp.height = f.H;
          c.wg = c.warp.getContext('2d')!;
          c.wimg = c.wg.createImageData(f.W, f.H);
          if (import.meta.env.DEV)
            this.dev.grades.push({
              mould: c.name, q: +c.q.toFixed(3), ring: +c.grade.ring.toFixed(3), detune: +c.grade.detune.toFixed(4), semis: +c.grade.semis.toFixed(2), fill: +(1 - c.voids).toFixed(3), seams: +c.seams.toFixed(3),
            });
        } else c.q = 0;
      },
    });
  }

  /** Step queued solves within the frame budget; a job that must finish now can be forced. */
  private runJobs(force = false) {
    const t0 = performance.now();
    while (this.jobs.length) {
      const job = this.jobs[0];
      const s0 = performance.now();
      const r = job.gen.next();
      const slice = performance.now() - s0;
      if (import.meta.env.DEV) this.dev.worstSolveSlice = Math.max(this.dev.worstSolveSlice, slice);
      if (r.done) {
        this.jobs.shift();
        job.done(r.value);
      }
      if (!force && performance.now() - t0 > SOLVE_BUDGET) break;
    }
    this.solveMs += (performance.now() - t0 - this.solveMs) * 0.1;
  }

  /** The current casting's centre on screen in CSS pixels (for tests). */
  private castingScreen() {
    const c = this.casting;
    if (!c) return null;
    const pr = this.ctx.pixelRatio;
    return { x: ((c.x + c.w / 2) * this.cs) / pr, y: ((c.y + c.h / 2) * this.cs) / pr, w: (c.w * this.cs) / pr, h: (c.h * this.cs) / pr };
  }

  /** A point in grid cells to a casting's local cells, given where and how it is drawn. */
  private toLocal(c: Casting, gx: number, gy: number, cx: number, cy: number, scale: number): [number, number] {
    const dx = (gx - cx) / scale, dy = (gy - cy) / scale;
    const cos = Math.cos(c.a), sin = Math.sin(c.a);
    return [dx * cos + dy * sin + c.w / 2, -dx * sin + dy * cos + c.h / 2];
  }

  private shelve(c: Casting) {
    c.a = c.flip;
    c.va = 0;
    this.shelf.push(c);
    if (this.shelf.length > SHELF_SLOTS) this.shelf.shift();
    if (this.casting === c) this.casting = null;
    this.ctx.sound.play('knock', { pitch: 1.3, gain: 0.4 });
  }

  private tapShelf(gx: number, gy: number) {
    const i = Math.floor(((gx - this.shelfX0()) / this.shelfW()) * SHELF_SLOTS);
    const c = this.shelf[i];
    if (!c) return;
    const s = this.slotScale(c) / this.cs, px = this.slotX(i) / this.cs;
    const [lx, ly] = this.toLocal(c, gx, gy, px, this.L.shelfY - (c.h * s) / 2, s);
    this.ring(c, 0.8, lx, ly, (px / this.cols - 0.5) * 0.6);
  }

  private shelfW() {
    return Math.min(this.cols - 8, 110);
  }

  private shelfX0() {
    return (this.cols - this.shelfW()) / 2;
  }

  // ---------------------------------------------------------------- particles & sound

  private spawnChips(x: number, y: number, n: number) {
    const c = this.chips;
    for (let i = 0; i < n; i++) {
      const o = this.cp * 6;
      this.cp = (this.cp + 1) % CHIPS;
      const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.6;
      const v = 20 + Math.random() * 45;
      c[o] = x + (Math.random() - 0.5) * 6;
      c[o + 1] = y + (Math.random() - 0.5) * 6;
      c[o + 2] = Math.cos(a) * v;
      c[o + 3] = Math.sin(a) * v;
      c[o + 4] = 0.5 + Math.random() * 0.5;
      c[o + 5] = Math.random();
    }
  }

  private stepParticles(dt: number) {
    const { sparks, chips, puffs } = this;
    // Sparks spit out of the basin while the stream hits it.
    if (this.rate > 20 && this.crucLift < 5) {
      const n = Math.random() < this.rate / 250 ? 2 : Math.random() < 0.4 ? 1 : 0;
      for (let i = 0; i < n; i++) {
        const o = this.sp * 5;
        this.sp = (this.sp + 1) % SPARKS;
        const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
        const v = 25 + Math.random() * 55;
        sparks[o] = this.mould.pourX + 0.5 + (Math.random() - 0.5) * 3;
        sparks[o + 1] = this.L.flaskTop - 0.5;
        sparks[o + 2] = Math.cos(a) * v;
        sparks[o + 3] = Math.sin(a) * v;
        sparks[o + 4] = 0.3 + Math.random() * 0.5;
      }
    }
    // Binder smoke curls off the mould while it's hot.
    if ((this.phase === 'pour' || this.phase === 'cool') && this.poured > 0 && Math.random() < dt * (4 + this.stat.maxT * 10)) {
      const o = this.pp * 5;
      this.pp = (this.pp + 1) % PUFFS;
      // From the basin and the riser, where the metal meets the air.
      puffs[o] = (Math.random() < 0.5 ? this.mould.pourX : this.mould.cavX + this.mould.shape.riser) + (Math.random() - 0.5) * 8;
      puffs[o + 1] = this.L.flaskTop - 1;
      puffs[o + 2] = (Math.random() - 0.5) * 4;
      puffs[o + 3] = 0;
      puffs[o + 4] = 1;
    }
    for (let i = 0; i < SPARKS; i++) {
      const o = i * 5;
      if (sparks[o + 4] <= 0) continue;
      sparks[o + 3] += 140 * dt;
      sparks[o] += sparks[o + 2] * dt;
      sparks[o + 1] += sparks[o + 3] * dt;
      sparks[o + 4] -= dt;
    }
    for (let i = 0; i < CHIPS; i++) {
      const o = i * 6;
      if (chips[o + 4] <= 0) continue;
      chips[o + 3] += 180 * dt;
      chips[o] += chips[o + 2] * dt;
      chips[o + 1] += chips[o + 3] * dt;
      chips[o + 4] -= dt;
    }
    for (let i = 0; i < PUFFS; i++) {
      const o = i * 5;
      if (puffs[o + 4] <= 0) continue;
      puffs[o] += puffs[o + 2] * dt;
      puffs[o + 1] -= 9 * dt;
      puffs[o + 4] -= dt * 0.45;
    }
    this.shake = Math.max(0, this.shake - dt * 3);
  }

  private sounds(dt: number) {
    const snd = this.ctx.sound;
    const r = this.rate / MAX_RATE;
    this.hiss.set(Math.min(1, r * 1.2), 0.5 + 0.4 * r);
    // Heavy molten metal pouring: a low, steady rumble.
    if (r > 0.02) this.ctx.hapticLevel(0.15 + 0.45 * Math.min(1, r), 0.2);
    this.trickle.set(Math.min(1, this.flowed / 900), 0.35 + Math.min(0.5, this.flowed / 3000));
    const hot = this.phase === 'pour' || this.phase === 'cool' ? this.stat.maxT : 0;
    this.rumble.set(this.crucLift < 5 && this.left > 1 ? 0.25 + r * 0.5 : 0, 0.3 + r * 0.4);
    this.crackle.set(this.phase === 'cool' ? Math.min(1, hot * 1.4) : this.poured > 0 && this.phase === 'pour' ? 0.3 : 0, 0.5);
    if (this.rate > 20 && this.time > this.nextSizzle) {
      this.nextSizzle = this.time + 0.18 + Math.random() * 0.22;
      snd.play('sizzle', { pitch: 0.8 + Math.random() * 0.5, gain: 0.35 + 0.5 * r });
    }
    if (this.rate > 60 && this.time > this.nextBuzz) {
      this.nextBuzz = this.time + 0.28;
      this.ctx.haptic('light');
    }
    if (this.crumbled > 12 && this.time - this.lastCrumble > 0.1) {
      this.lastCrumble = this.time;
      snd.play('crumble', { pitch: 0.6 + Math.random() * 0.3, gain: Math.min(1, this.crumbled / 60) });
    }
    void dt;
  }

  // ---------------------------------------------------------------- draw

  private draw() {
    const { g, width, height, cs } = this;
    const sx = this.shake > 0 ? (Math.random() - 0.5) * this.shake * cs * 1.6 : 0;
    const sy = this.shake > 0 ? (Math.random() - 0.5) * this.shake * cs * 1.6 : 0;
    g.setTransform(1, 0, 0, 1, sx, sy);
    g.globalCompositeOperation = 'source-over';
    g.globalAlpha = 1;
    g.drawImage(this.bg, 0, 0);
    const ox = this.slide * cs;

    // Warm light thrown on the wall by the molten metal.
    const heat = Math.min(1, this.stat.maxT * Math.min(1, this.stat.fill * 4));
    const cr = this.crucLift < 60 ? 1 - this.crucLift / 60 : 0;
    g.globalCompositeOperation = 'lighter';
    g.globalAlpha = 0.16 + 0.1 * cr + 0.12 * (this.rate / MAX_RATE);
    const lr = 70 * cs;
    g.drawImage(this.light, (this.mould.pourX - 8) * cs - lr, (this.L.lipY - this.crucLift + 4) * cs - lr, lr * 2, lr * 2);
    if (heat > 0.02) {
      g.globalAlpha = 0.35 * heat;
      const mr = 80 * cs;
      g.drawImage(this.light, this.mould.cavX * cs + ox - mr, (this.L.flaskTop + 60) * cs - mr, mr * 2, mr * 2);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';

    this.drawStand(ox);
    this.paintCells();
    g.imageSmoothingEnabled = false;
    g.drawImage(this.layer, ox, 0, this.cols * cs, this.rows * cs);
    this.drawFrame(ox);
    this.drawCrucible();
    this.drawShelf();
    const c = this.casting;
    if (c) {
      let px = (c.x + c.w / 2) * cs, py = (c.y + c.h / 2) * cs, s = cs;
      // Fly up onto the shelf.
      if (this.phase === 'shelve' && this.phaseT > FLY) {
        const k = smooth(FLY, FLY + 0.7, this.phaseT);
        const i = Math.min(this.shelf.length, SHELF_SLOTS - 1);
        const ts = this.slotScale(c);
        px += (this.slotX(i) - px) * k;
        py += (this.L.shelfY * cs - (c.h * ts) / 2 - py) * k - Math.sin(k * Math.PI) * 24 * cs;
        s += (ts - s) * k;
      }
      this.drawCasting(c, px, py, s, g);
    }
    this.drawParticles();
    this.bloom(ox);
    this.drawCues();
    g.setTransform(1, 0, 0, 1, 0, 0);
    void width;
    void height;
  }

  /** Cells to pixels: rammed sand with grain and scorch, dark cavity, metal coloured by heat. */
  private paintCells() {
    const d = this.img.data, e = this.gimg.data;
    const { cells, temp, shade, mask, scorch, flag, W } = this.sim;
    const grain = this.grain;
    const y0 = Math.max(0, this.L.lipY - 90), y1 = Math.min(this.rows, this.L.floorY + 1);
    d.fill(0);
    e.fill(0);
    for (let y = y0; y < y1; y++) {
      const band = y % 7 === 0 ? 0.95 : 1;
      for (let x = 0; x < W; x++) {
        const k = y * W + x;
        const c = cells[k];
        const o = k * 4;
        if (c === 0) {
          if (!mask[k] || this.phase === 'drop' || this.phase === 'ring' || this.phase === 'shelve') continue;
          // The open cavity: the back half of the mould, in shadow under its roof.
          const roof = cells[k - W] === SAND ? 0.55 : 1;
          const lip = cells[k + W] === SAND ? 1.35 : 1;
          const f = (0.3 + (shade[k] & 15) / 160) * roof * lip * (1 - scorch[k] / 400);
          d[o] = 92 * f;
          d[o + 1] = 70 * f;
          d[o + 2] = 54 * f;
          d[o + 3] = 255;
          continue;
        }
        const m = c & 0x7f;
        if (m === SAND) {
          let f = (0.72 + shade[k] / 900 + (grain[k] - 128) / 640) * band;
          if (c & LOOSE) f *= 1.08;
          else {
            // A lit top face where sand meets open air, and a dark lip over hollows.
            const up = cells[k - W];
            if (up === 0 && !mask[k - W]) f *= 1.25;
            else if (mask[k - W] && up === 0) f *= 1.12;
            if (cells[k + W] === 0 && mask[k + W]) f *= 0.6;
          }
          const s = scorch[k] / 255;
          d[o] = (112 - 76 * s) * f;
          d[o + 1] = (86 - 60 * s) * f;
          d[o + 2] = (62 - 40 * s) * f;
          d[o + 3] = 255;
        } else if (m === METAL) {
          const ti = Math.min(255, (temp[k] * 255) | 0);
          let f = 0.93 + (shade[k] & 31) / 250;
          if (ti < 110 && cells[k - W] !== METAL) f *= 1.22;
          const i3 = ti * 3;
          seamTint(METAL_RGB[i3] * f, METAL_RGB[i3 + 1] * f, METAL_RGB[i3 + 2] * f, (flag[k] & 1) !== 0, d, o);
          if (ti > 80) {
            const s = flag[k] & 1 ? 0.4 : 1;
            e[o] = GLOW_RGB[i3] * s;
            e[o + 1] = GLOW_RGB[i3 + 1] * s;
            e[o + 2] = GLOW_RGB[i3 + 2] * s;
            e[o + 3] = 255;
          }
        }
      }
    }
    this.lg.putImageData(this.img, 0, 0);
    this.ga.putImageData(this.gimg, 0, 0);
  }

  private drawStand(ox: number) {
    const { g, cs } = this;
    const { cx, half, flaskBot, floorY } = this.L;
    g.fillStyle = '#16100e';
    for (const s of [-1, 1]) {
      const x = (cx + s * (half + 1)) * cs + ox;
      g.fillRect(x - 1.6 * cs, (flaskBot + 1) * cs, 3.2 * cs, (floorY - flaskBot - 1) * cs);
      g.fillStyle = '#2a211d';
      g.fillRect(x - 1.6 * cs, (flaskBot + 1) * cs, 0.8 * cs, (floorY - flaskBot - 1) * cs);
      g.fillStyle = '#16100e';
    }
  }

  private drawFrame(ox: number) {
    const { g, cs } = this;
    const { cx, half, flaskTop, flaskBot } = this.L;
    const top = (flaskTop - 3) * cs, h = (flaskBot - flaskTop + 4) * cs;
    const k = this.frameGone < 0 ? 0 : (this.time - this.frameGone) / 0.7;
    if (k < 1) {
      for (const s of [-1, 1]) {
        const e = k * k;
        const x = (cx + s * (half + 1.5)) * cs + ox + s * e * 40 * cs;
        const y = top + e * 30 * cs - Math.sin(k * Math.PI) * 10 * cs;
        g.save();
        g.globalAlpha = 1 - k;
        g.translate(x, y + h / 2);
        g.rotate(s * e * 0.8);
        steel(g, -1.1 * cs, -h / 2, 2.2 * cs, h);
        // Handles and pins.
        g.fillStyle = '#3b3431';
        g.fillRect(s > 0 ? 1.1 * cs : -3.3 * cs, -h * 0.28, 2.2 * cs, 3 * cs);
        g.fillRect(s > 0 ? 1.1 * cs : -3.3 * cs, h * 0.12, 2.2 * cs, 3 * cs);
        g.fillStyle = '#7b706a';
        for (let r = 0; r < 6; r++) g.fillRect(-0.35 * cs, -h / 2 + (r + 0.5) * (h / 6), 0.7 * cs, 0.7 * cs);
        g.restore();
      }
    }
    const kb = this.boardGone < 0 ? 0 : (this.time - this.boardGone) / 0.6;
    if (kb < 1) {
      g.save();
      g.globalAlpha = 1 - kb;
      g.translate(0, kb * kb * 16 * cs);
      steel(g, (cx - half - 2) * cs + ox, flaskBot * cs, (2 * half + 5) * cs, 1.2 * cs);
      g.restore();
    }
    // Parting line between cope and drag while the flask is whole.
    if (this.frameGone < 0) {
      g.fillStyle = 'rgba(0,0,0,0.25)';
      g.fillRect((cx - half) * cs + ox, (this.mould.cavTop - 2) * cs, (2 * half + 1) * cs, 0.35 * cs);
    }
  }

  private drawCrucible() {
    if (this.crucLift > 68) return;
    const { g, cs } = this;
    const lx = (this.mould.pourX + 0.5) * cs, ly = (this.L.lipY - this.crucLift) * cs;
    // Hoist chain and bail.
    g.strokeStyle = '#3a3230';
    g.lineWidth = cs * 0.9;
    g.setLineDash([cs * 1.4, cs * 0.6]);
    g.beginPath();
    g.moveTo(lx - 9 * cs, 0);
    g.lineTo(lx - 9 * cs, ly - 10 * cs);
    g.stroke();
    g.setLineDash([]);
    g.lineWidth = cs * 1.1;
    g.strokeStyle = '#4a403c';
    g.beginPath();
    g.moveTo(lx - 9 * cs, ly - 10 * cs);
    g.lineTo(lx, ly);
    g.moveTo(lx - 9 * cs, ly - 10 * cs);
    g.lineTo(this.bodyW[0] * cs, this.bodyW[1] * cs);
    g.stroke();
    // Clay crucible, drawn in its own tipped frame; the mouth shows the melt.
    const full = Math.min(1, this.left / Math.max(1, this.cap));
    g.save();
    g.translate(lx, ly);
    g.rotate(this.tilt);
    g.scale(cs, cs);
    g.beginPath();
    g.moveTo(-21, -0.8);
    g.lineTo(0.9, -0.8);
    g.lineTo(-1.2, 17);
    g.quadraticCurveTo(-2.4, 23.2, -10, 23.6);
    g.quadraticCurveTo(-17.6, 23.2, -18.8, 17);
    g.closePath();
    const [clay, heat] = this.crucibleFills();
    g.fillStyle = clay;
    g.fill();
    // Heat creeping up the clay from the melt inside.
    g.globalAlpha = full;
    g.fillStyle = heat;
    g.fill();
    g.globalAlpha = 1;
    g.fillStyle = '#2b2522';
    g.fillRect(-20.3, 4.5, 20.4, 1.6);
    g.fillStyle = '#4a423e';
    g.fillRect(-20.3, 4.5, 20.4, 0.45);
    g.beginPath();
    g.ellipse(-10, -0.8, 11.2, 2.6, 0, 0, Math.PI * 2);
    g.fillStyle = '#2a1c16';
    g.fill();
    if (this.left > 0.5) {
      g.beginPath();
      g.ellipse(-10, -0.7, 9.8 * (0.55 + 0.45 * full), 1.9, 0, 0, Math.PI * 2);
      g.fillStyle = '#ffe6a6';
      g.fill();
      g.fillStyle = 'rgba(190,70,20,0.6)';
      for (let i = 0; i < 4; i++) {
        const t = (this.time * 0.12 + i * 0.27) % 1;
        g.fillRect(-18 + 15 * t, -1.2 + ((i * 7) % 3) * 0.4, 1.3, 0.5);
      }
    }
    g.restore();
    if (this.left > 0.5) {
      const a = this.ga;
      a.save();
      a.translate(lx / cs, ly / cs);
      a.rotate(this.tilt);
      a.beginPath();
      a.ellipse(-10, -0.7, 10, 2.6, 0, 0, Math.PI * 2);
      a.fillStyle = `rgba(255,170,80,${0.5 + 0.5 * full})`;
      a.fill();
      a.restore();
    }
    // Hot rim at the lip.
    g.fillStyle = '#ff9a3a';
    g.globalAlpha = 0.5 + 0.5 * Math.min(1, this.left / this.cap);
    g.fillRect(lx - 1.2 * cs, ly - 0.9 * cs, 2.2 * cs, 1.2 * cs);
    g.globalAlpha = 1;
  }

  private fills: [CanvasGradient, CanvasGradient] | null = null;

  /** Crucible gradients live in its own frame, so they're built once. */
  private crucibleFills() {
    if (this.fills) return this.fills;
    const g = this.g;
    const clay = g.createLinearGradient(-21, 0, 1, 0);
    clay.addColorStop(0, '#1d1411');
    clay.addColorStop(0.55, '#3d2a22');
    clay.addColorStop(0.85, '#5a3524');
    clay.addColorStop(1, '#2a1a14');
    const heat = g.createLinearGradient(0, 24, 0, 4);
    heat.addColorStop(0, 'rgba(255,90,20,0.28)');
    heat.addColorStop(1, 'rgba(255,90,20,0)');
    return (this.fills = [clay, heat]);
  }

  private drawCasting(c: Casting, cxp: number, cyp: number, scale: number, g: CanvasRenderingContext2D) {
    const ring = c.ringT >= 0 ? Math.exp(-c.ringT / (0.25 + 1.4 * c.clarity)) : 0;
    const warped = this.warpCasting(c);
    g.save();
    g.translate(cxp, cyp);
    g.rotate(c.a);
    g.imageSmoothingEnabled = false;
    if (warped && c.warp) g.drawImage(c.warp, (-c.w / 2 - PAD) * scale, (-c.h / 2 - PAD) * scale, c.fw * scale, c.fh * scale);
    else g.drawImage(c.canvas, (-c.w / 2) * scale, (-c.h / 2) * scale, c.w * scale, c.h * scale);
    // A spark of light where it was struck.
    if (ring > 0.05 && c.ringT < 0.25) {
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = `rgba(255,236,190,${(1 - c.ringT / 0.25) * 0.8})`;
      g.beginPath();
      g.arc((c.hitX - c.w / 2) * scale, (c.hitY - c.h / 2) * scale, scale * (1.2 + c.ringT * 8), 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'source-over';
    }
    g.restore();
    if (c.hot && c === this.casting) {
      const a = this.ga;
      a.save();
      a.globalCompositeOperation = 'lighter';
      a.translate(c.x + c.w / 2, c.y + c.h / 2);
      a.rotate(c.a);
      a.drawImage(c.glow, -c.w / 2, -c.h / 2);
      a.restore();
    }
    // Sound rings: bright, many and slow for a true casting; one faint puff for a dud.
    if (ring > 0.02) {
      const n = c.clarity > 0.8 ? 3 : 1;
      g.lineWidth = scale * 0.5;
      for (let i = 0; i < n; i++) {
        const t = (c.ringT * (0.9 + 0.4 * c.clarity) + i * 0.33) % 1;
        g.strokeStyle = `rgba(255,${200 + 55 * c.clarity},${150 + 80 * c.clarity},${(1 - t) * ring * (0.25 + 0.6 * c.clarity)})`;
        g.beginPath();
        g.ellipse(cxp, cyp, (c.w / 2 + 3 + t * 22) * scale, (c.h / 2 + 3 + t * 22) * scale, 0, 0, Math.PI * 2);
        g.stroke();
      }
    }
  }

  /**
   * While it rings, bend the casting by its own mode shapes (slowed and exaggerated): every pixel
   * of the padded warp canvas samples the casting back through the summed displacement field.
   * Returns false once the wobble has died away.
   */
  private warpCasting(c: Casting) {
    if (!c.wimg || !c.fields.length || c.ringT < 0 || c.ringT > 2.5) return false;
    const t = c.ringT, K = c.fields.length;
    const coef = this.coef;
    let live = 0;
    for (let k = 0; k < K; k++) {
      coef[k] = WOBBLE * c.wob[k] * Math.exp(-t / c.wobTau[k]) * Math.sin(2 * Math.PI * c.wobF[k] * t) * Math.min(1, t * 30);
      live += Math.abs(coef[k]);
    }
    if (live < 0.03 && t > 0.1) return false;
    const { fw, fh, w, h } = c;
    const src = c.img.data, dst = c.wimg.data;
    for (let y = 0; y < fh; y++)
      for (let x = 0; x < fw; x++) {
        const p = y * fw + x;
        let ux = 0, uy = 0;
        for (let k = 0; k < K; k++) {
          const f = c.fields[k];
          ux += coef[k] * f[p * 2];
          uy += coef[k] * f[p * 2 + 1];
        }
        const sx = Math.round(x - PAD - ux), sy = Math.round(y - PAD - uy);
        const o = p * 4;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) {
          dst[o + 3] = 0;
          continue;
        }
        const q = (sy * w + sx) * 4;
        dst[o] = src[q];
        dst[o + 1] = src[q + 1];
        dst[o + 2] = src[q + 2];
        dst[o + 3] = src[q + 3];
      }
    c.wg!.putImageData(c.wimg, 0, 0);
    return true;
  }

  private coef = new Float32Array(12);

  private drawShelf() {
    const { g, cs } = this;
    const y = this.L.shelfY * cs;
    g.font = `600 ${Math.round(cs * 3.2)}px ui-rounded, system-ui, sans-serif`;
    g.textAlign = 'center';
    g.textBaseline = 'top';
    for (let i = 0; i < this.shelf.length; i++) {
      const c = this.shelf[i];
      const s = this.slotScale(c), px = this.slotX(i);
      this.drawCasting(c, px, y - (c.h * s) / 2, s, g);
      g.fillStyle = c.q >= TRUE_Q ? '#ffd9a0' : 'rgba(255,230,210,0.5)';
      if (c.q === c.q) g.fillText(`${Math.round(c.q * 100)}%`, px, y + cs * 2.2);
    }
  }

  private slotX(i: number) {
    return (this.shelfX0() + (this.shelfW() / SHELF_SLOTS) * (i + 0.5)) * this.cs;
  }

  private slotScale(c: Casting) {
    return Math.min(((this.shelfW() / SHELF_SLOTS) * 0.82) / c.w, 20 / c.h) * this.cs;
  }

  private drawParticles() {
    const { g, cs, sparks, chips, puffs } = this;
    g.globalCompositeOperation = 'source-over';
    for (let i = 0; i < PUFFS; i++) {
      const o = i * 5, l = puffs[o + 4];
      if (l <= 0) continue;
      const r = (4 + (1 - l) * 14) * cs;
      g.globalAlpha = l * 0.22;
      g.drawImage(this.puffSprite, puffs[o] * cs - r, puffs[o + 1] * cs - r, r * 2, r * 2);
    }
    for (let i = 0; i < CHIPS; i++) {
      const o = i * 6, l = chips[o + 4];
      if (l <= 0) continue;
      g.globalAlpha = Math.min(1, l * 3);
      g.fillStyle = chips[o + 5] < 0.5 ? '#7a5c40' : chips[o + 5] < 0.8 ? '#95714f' : '#3a2a20';
      g.fillRect((chips[o] - 0.6) * cs, (chips[o + 1] - 0.6) * cs, cs * 1.2, cs * 1.2);
    }
    g.globalAlpha = 1;
    const a = this.ga;
    a.fillStyle = '#ffc060';
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = '#ffd890';
    g.lineWidth = cs * 0.45;
    g.beginPath();
    for (let i = 0; i < SPARKS; i++) {
      const o = i * 5;
      if (sparks[o + 4] <= 0) continue;
      const x = sparks[o], y = sparks[o + 1];
      g.moveTo(x * cs, y * cs);
      g.lineTo((x - sparks[o + 2] * 0.02) * cs, (y - sparks[o + 3] * 0.02) * cs);
      a.fillRect(x - 0.5, y - 0.5, 1, 1);
    }
    g.stroke();
    g.globalCompositeOperation = 'source-over';
  }

  /** Cheap bloom: the emission layer blurred by repeated half-size copies, added back on top. */
  private bloom(ox: number) {
    const { g, cs } = this;
    let src: HTMLCanvasElement = this.glowA;
    for (const m of this.mips) {
      const mg = m.getContext('2d')!;
      mg.imageSmoothingEnabled = true;
      mg.clearRect(0, 0, m.width, m.height);
      mg.drawImage(src, 0, 0, m.width, m.height);
      src = m;
    }
    g.globalCompositeOperation = 'lighter';
    g.imageSmoothingEnabled = true;
    const W = this.cols * cs, H = this.rows * cs;
    g.globalAlpha = 0.35;
    g.drawImage(this.glowA, ox, 0, W, H);
    const alphas = [0.55, 0.6, 0.7];
    for (let i = 0; i < this.mips.length; i++) {
      g.globalAlpha = alphas[i];
      g.drawImage(this.mips[i], ox, 0, W, H);
    }
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    // The emission layer is rebuilt next frame; clear what was drawn into it by hand.
    this.ga.clearRect(0, 0, this.cols, this.rows);
  }

  /** Wordless cues: a pulsing press ring on the crucible, a hammer over the mould, a strike mark. */
  private drawCues() {
    const { g, cs, time } = this;
    let x = 0, y = 0, show = false;
    if (this.phase === 'pour' && this.rate === 0 && this.stat.fill < 0.9) {
      x = (this.mould.pourX - 9) * cs;
      y = (this.L.lipY + 9) * cs;
      show = true;
    } else if (this.phase === 'break' && this.phaseT > 0.3) {
      x = this.L.cx * cs;
      y = (this.L.flaskTop + 55) * cs;
      show = true;
    } else if (this.phase === 'ring' && this.casting && this.phaseT > 0.4) {
      x = (this.casting.x + this.casting.w / 2) * cs;
      y = (this.casting.y + this.casting.h / 2) * cs;
      show = true;
    }
    if (!show) return;
    const t = (time * 0.9) % 1;
    g.strokeStyle = `rgba(255,236,200,${0.55 * (1 - t)})`;
    g.lineWidth = cs * 0.7;
    g.beginPath();
    g.arc(x, y, (4 + t * 10) * cs, 0, Math.PI * 2);
    g.stroke();
    g.fillStyle = `rgba(255,236,200,${0.35 + 0.25 * Math.sin(time * 6)})`;
    g.beginPath();
    g.arc(x, y, 2.4 * cs, 0, Math.PI * 2);
    g.fill();
  }

  private drawBackground() {
    const { width, height, cs } = this;
    const b = this.bg;
    b.width = width;
    b.height = height;
    const g = b.getContext('2d')!;
    const floorY = this.L.floorY * cs;
    const wall = g.createLinearGradient(0, 0, 0, floorY);
    wall.addColorStop(0, '#0c0807');
    wall.addColorStop(0.6, '#1a110d');
    wall.addColorStop(1, '#22160f');
    g.fillStyle = wall;
    g.fillRect(0, 0, width, floorY);
    // Soot-dark brick.
    const bw = 11 * cs, bh = 4.4 * cs;
    for (let r = 0, y = 0; y < floorY; r++, y += bh) {
      for (let x = (r & 1) * -bw * 0.5; x < width; x += bw) {
        const v = 26 + Math.random() * 16;
        g.fillStyle = `rgba(${v + 14},${v * 0.62},${v * 0.46},${0.28 + (y / floorY) * 0.4})`;
        g.fillRect(x + cs * 0.35, y + cs * 0.35, bw - cs * 0.7, bh - cs * 0.7);
      }
    }
    // Grate floor, and the dark pit it drains into.
    g.fillStyle = '#0b0807';
    g.fillRect(0, floorY, width, height - floorY);
    g.fillStyle = '#2a211d';
    g.fillRect(0, floorY, width, cs * 1.2);
    g.fillStyle = '#17110f';
    for (let x = 0; x < width; x += cs * 3) g.fillRect(x, floorY + cs * 1.2, cs * 1.2, cs * 3);
    g.fillStyle = '#231a16';
    g.fillRect(0, floorY + cs * 4.2, width, cs * 0.8);
    // Shelf plank with brackets.
    const sy = this.L.shelfY * cs, x0 = this.shelfX0() * cs, sw = this.shelfW() * cs;
    g.fillStyle = '#1e140e';
    g.fillRect(x0 + sw * 0.1, sy, cs * 1.5, cs * 6);
    g.fillRect(x0 + sw * 0.9 - cs * 1.5, sy, cs * 1.5, cs * 6);
    const pl = g.createLinearGradient(0, sy, 0, sy + cs * 2.2);
    pl.addColorStop(0, '#8a5d38');
    pl.addColorStop(1, '#4a2f1c');
    g.fillStyle = pl;
    g.fillRect(x0, sy, sw, cs * 2.2);
    // Vignette.
    const v = g.createRadialGradient(width / 2, height * 0.42, height * 0.2, width / 2, height * 0.45, height * 0.75);
    v.addColorStop(0, 'rgba(0,0,0,0)');
    v.addColorStop(1, 'rgba(0,0,0,0.6)');
    g.fillStyle = v;
    g.fillRect(0, 0, width, height);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.reset();
  }

  destroy() {
    this.hiss.stop();
    this.trickle.stop();
    this.rumble.stop();
    this.crackle.stop();
    this.events.length = 0;
    this.hint.remove();
    this.toast.remove();
    this.style.remove();
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__foundry;
  }
}

// ------------------------------------------------------------------ helpers

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function radial(size: number, rgb: number[]) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},1)`);
  grd.addColorStop(0.4, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35)`);
  grd.addColorStop(1, `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0)`);
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  return c;
}

/** A bar of dark iron: lit edge, body, shadowed edge. */
function steel(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  const across = w > h;
  g.fillStyle = '#2c2624';
  g.fillRect(x, y, w, h);
  g.fillStyle = '#4c4541';
  if (across) g.fillRect(x, y, w, h * 0.3);
  else g.fillRect(x, y, w * 0.3, h);
  g.fillStyle = '#141110';
  if (across) g.fillRect(x, y + h * 0.7, w, h * 0.3);
  else g.fillRect(x + w * 0.7, y, w * 0.3, h);
}

/** Low-frequency packing variation so rammed sand isn't flat noise. */
function makeGrain(W: number, H: number) {
  const out = new Uint8Array(W * H);
  const ph = [Math.random() * 9, Math.random() * 9, Math.random() * 9];
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = Math.sin(x * 0.21 + ph[0]) * Math.sin(y * 0.17 + ph[1]) + Math.sin((x + y) * 0.09 + ph[2]) * 0.6 + Math.sin(x * 0.7 - y * 0.5) * 0.25;
      out[y * W + x] = Math.max(0, Math.min(255, 128 + v * 70));
    }
  return out;
}

function makeCasting(shape: ShapeId, name: string, w: number, h: number, x: number, y: number, a: Assessment): Casting {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const glow = document.createElement('canvas');
  glow.width = w;
  glow.height = h;
  const cg = canvas.getContext('2d')!, gg = glow.getContext('2d')!;
  return {
    shape, name, w, h,
    cell: new Uint8Array(w * h),
    temp: new Float32Array(w * h),
    lit: new Float32Array(w * h),
    canvas, cg, img: cg.createImageData(w, h),
    glow, gg, gimg: gg.createImageData(w, h),
    x, y, vy: 0, a: 0, va: 0,
    flip: 0,
    q: NaN, voids: a.voids, seams: a.seams,
    ringT: -1, clarity: 0, hot: true,
    foot: 0, scale: 1, grade: null,
    fields: [], fw: 0, fh: 0,
    wob: new Float32Array(12), wobF: new Float32Array(12), wobTau: new Float32Array(12),
    warp: null, wg: null, wimg: null,
    hitX: w / 2, hitY: h / 2, landed: false,
  };
}

/** Fixed per-cell lighting for a casting: a bright top-left rim, shadowed underside, seams dark. */
function shadeCasting(c: Casting) {
  const { w, h, cell, lit } = c;
  const solid = (k: number) => cell[k] === C_METAL || cell[k] === C_SEAM;
  for (let i = 0; i < h; i++)
    for (let j = 0; j < w; j++) {
      const k = i * w + j;
      if (!solid(k)) continue;
      // Soft top light plus a diagonal sheen across the metal.
      const u = j / w - (i / h) * 0.6 - 0.15;
      let f = 0.88 + Math.random() * 0.08 + 0.16 * (1 - i / h) + 0.3 * Math.exp(-u * u * 90);
      if (i === 0 || !solid(k - w)) f *= 1.3;
      else if (j === 0 || !solid(k - 1)) f *= 1.15;
      if (i === h - 1 || !solid(k + w)) f *= 0.7;
      lit[k] = f;
    }
  paintCasting(c);
}

/** Write a metal pixel; cold-shut cells show as a dark grey oxide line where the fronts never fused. */
function seamTint(r: number, g: number, b: number, seam: boolean, d: Uint8ClampedArray, o: number) {
  if (seam) {
    const l = (r + g + b) / 3;
    r = 26 + l * 0.22;
    g = 28 + l * 0.22;
    b = 34 + l * 0.26;
  }
  d[o] = Math.min(255, r);
  d[o + 1] = Math.min(255, g);
  d[o + 2] = Math.min(255, b);
  d[o + 3] = 255;
}

function paintCasting(c: Casting) {
  const d = c.img.data, e = c.gimg.data;
  for (let k = 0; k < c.cell.length; k++) {
    const o = k * 4;
    const v = c.cell[k];
    if (v !== C_METAL && v !== C_SEAM) {
      d[o + 3] = 0;
      e[o + 3] = 0;
      continue;
    }
    const ti = Math.min(255, (c.temp[k] * 255) | 0), i3 = ti * 3, f = c.lit[k];
    seamTint(METAL_RGB[i3] * f, METAL_RGB[i3 + 1] * f, METAL_RGB[i3 + 2] * f, v === C_SEAM, d, o);
    e[o] = GLOW_RGB[i3];
    e[o + 1] = GLOW_RGB[i3 + 1];
    e[o + 2] = GLOW_RGB[i3 + 2];
    e[o + 3] = 255;
  }
  c.cg.putImageData(c.img, 0, 0);
  c.gg.putImageData(c.gimg, 0, 0);
}

const STYLE = `
.fdy-hint { position: absolute; left: 50%; transform: translateX(-50%); padding: 7px 14px; border-radius: 999px; background: rgba(30, 18, 12, 0.6); color: #ffe2c0; font: 600 15px/1 ui-rounded, system-ui, sans-serif; letter-spacing: .02em; opacity: 0; transition: opacity .25s; pointer-events: none; white-space: nowrap; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.fdy-hint.show { opacity: 1; }
.fdy-toast { position: absolute; left: 50%; transform: translateX(-50%); padding: 9px 16px; border-radius: 999px; background: rgba(40, 26, 20, 0.88); color: #f3d9c4; font: 700 17px/1 ui-rounded, system-ui, sans-serif; opacity: 0; pointer-events: none; white-space: nowrap; }
.fdy-toast.good { background: rgba(255, 214, 140, 0.95); color: #4a2410; }
.fdy-toast.show { animation: fdy-toast 2.2s ease-out forwards; }
@keyframes fdy-toast { 0% { opacity: 0; transform: translate(-50%, 8px) scale(.9); } 10% { opacity: 1; transform: translate(-50%, 0) scale(1.06); } 80% { opacity: 1; transform: translate(-50%, 0) scale(1); } 100% { opacity: 0; transform: translate(-50%, -6px); } }
`;
