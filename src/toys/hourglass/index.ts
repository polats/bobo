import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop } from '../../shell/sound';
import { Glass, HB, R, WALL } from './glass';
import { Grains, type Forces, type GrainCfg } from './grains';
import { Water } from './water';
import { HourglassView, type Look, type View2D } from './render';
import { crater, reposeAngle } from './measure';

export const hourglassToy: Toy = {
  id: 'hourglass',
  title: 'Hourglass',
  blurb: 'Turn your phone over and the sand runs. It pours at a steady rate however much is left above, heaps into a cone below and dimples into a crater on top. Switch to water and it gushes, then slows and glugs as the level drops. Narrow the neck and it clogs: shake it loose.',
  tech: '2D frictional grains (position-based contacts, Coulomb friction, rolling resistance, 12 substeps, stack mass scaling, extra passes at the neck) · Clavet double-density water with rising air bubbles · measured discharge drives the hiss and haptics · device-motion gravity · WebGL2',
  swatch: 'radial-gradient(ellipse 30% 22% at 50% 70%,#e2b877 0 60%,transparent 62%),linear-gradient(180deg,#3a2415 0 8%,#1b1411 9% 91%,#3a2415 92%)',
  refs: [
    {
      short: 'Beverloo 1961',
      title: 'The flow of granular solids through orifices (W. A. Beverloo, H. A. Leniger, J. van de Velde, Chemical Engineering Science 15, 1961)',
      url: 'https://doi.org/10.1016/0009-2509(61)85030-6',
      use: 'The law the grains are checked against: discharge set by the neck, W ∝ ρ√g (D − kd)^5/2 in 3D (^3/2 for this 2D slice), independent of the height of sand above. Nothing in the toy enforces it; the live graph shows it emerge.',
    },
    {
      short: 'Staron et al. 2012',
      title: 'The granular silo as a continuum plastic flow: the hour-glass vs the clepsydra (L. Staron, P.-Y. Lagrée, S. Popinet, Physics of Fluids 24, 2012; arXiv:1211.5916)',
      url: 'https://doi.org/10.1063/1.4757390',
      use: 'Why a frictional medium keeps a constant rate while a fluid slows with its head, and the funnel-shaped flow zone and crater above the orifice. The Water medium is the clepsydra side of the comparison.',
    },
    {
      short: 'Macklin et al. 2014',
      title: 'Unified Particle Physics for Real-Time Applications (M. Macklin, M. Müller, N. Chentanez, T.-Y. Kim, ACM Transactions on Graphics 33(4), 2014)',
      url: 'https://doi.org/10.1145/2601097.2601152',
      use: 'Position-based particle contacts with static/kinetic friction on the tangential slip, and height-based mass scaling so tall piles stand in one Gauss-Seidel sweep.',
    },
    {
      short: 'Macklin et al. 2019',
      title: 'Small Steps in Physics Simulation (M. Macklin, K. Storey, M. Lu, P. Terdiman, N. Chentanez, S. Jeschke, M. Müller, SCA 2019)',
      url: 'https://doi.org/10.1145/3309486.3340247',
      use: 'Many substeps with a single solver pass each instead of many iterations: 12 per frame here.',
    },
    {
      short: 'Clavet et al. 2005',
      title: 'Particle-based Viscoelastic Fluid Simulation (S. Clavet, P. Beaudoin, P. Poulin, SCA 2005)',
      url: 'https://doi.org/10.1145/1073368.1073400',
      use: 'Double-density relaxation and pairwise viscosity for the Water medium: its pressure grows with depth, so the jet slows as the bulb drains.',
    },
    {
      short: 'Zuriguel et al. 2005',
      title: 'Jamming during the discharge of granular matter from a silo (I. Zuriguel, A. Garcimartín, D. Maza, L. A. Pugnaloni, J. M. Pastor, Physical Review E 71, 2005)',
      url: 'https://doi.org/10.1103/physreve.71.051303',
      use: 'What to expect of the clog: arches across an outlet a few grains wide, with jams far more likely as D/d drops; and that a kick breaks them.',
    },
  ],
  async create(ctx) {
    return new Hourglass(ctx);
  },
};

type Medium = 'sand' | 'salt' | 'steel' | 'water';

interface MediumDef {
  label: string;
  cfg: GrainCfg;
  /** Relative size spread of the grains. */
  spread: number;
  tick: number;
  colour: string;
  sharp: number;
}

const MEDIA: Record<Exclude<Medium, 'water'>, MediumDef> = {
  sand: { label: 'Sand', cfg: { mu: 0.5, muK: 0.4, wallMu: 0.3, roll: 5, bounce: 0 }, spread: 0.2, tick: 1, colour: '#e8b86a', sharp: 0.55 },
  // Salt's facets are stood in for by more friction; cubes are only how it is drawn.
  salt: { label: 'Salt', cfg: { mu: 0.65, muK: 0.55, wallMu: 0.4, roll: 5, bounce: 0.05 }, spread: 0.3, tick: 1.5, colour: '#f2f2ee', sharp: 0.75 },
  // Steel shot: round, smooth, near-uniform and a little bouncy.
  steel: { label: 'Steel shot', cfg: { mu: 0.1, muK: 0.08, wallMu: 0.15, roll: 0.02, bounce: 0.3 }, spread: 0.08, tick: 2.2, colour: '#b9c0c8', sharp: 0.9 },
};
const WATER_COLOUR = '#6fc3e8';

const MAX_GRAINS = 5200;
const MAX_WATER = 2600;
const FILL = 0.65;
const G = 9.81;
/** Sim step: substeps per 1/60 s. */
const SUB_GRAIN = 12;
const SUB_WATER = 8;
/** Window for the measured rate (s): shorter for water, which drains in a couple of seconds. */
const RATE_WIN = { grain: 0.5, water: 0.25 };

interface Run {
  medium: Medium;
  pts: number[];
}

class Hourglass implements ToyInstance {
  private glass: Glass;
  private grains = new Grains(MAX_GRAINS);
  private water = new Water(MAX_WATER);
  private view: HourglassView;
  private medium: Medium = 'sand';
  private tune = { neck: 4.5, grain: 1.0 };
  private side = new Int8Array(Math.max(MAX_GRAINS, MAX_WATER));
  private src: 1 | -1 = 1;
  // Glass pose on screen.
  private angle = 0;
  private omega = 0;
  private alpha = 0;
  private flip: { from: number; to: number; t: number; dur: number } | null = null;
  private drag: { id: number; start: number; moved: boolean; x: number; y: number; t: number } | null = null;
  // Gravity from the phone, screen frame (x right, y up), m/s².
  private motion: [number, number, number] | null = null;
  private motionSeen = false;
  private devGravity: [number, number] | null = null;
  private devShake = { until: 0, amp: 0, f: 7 };
  private jolt = { x: 0, y: 0, t: 0 };
  private sAxisPrev = 0;
  private settleKnock = -1;
  private plugUntil = 0;
  // Measurement.
  private flux: number[] = [];
  private fluxT: number[] = [];
  private rate = 0;
  private runs: Run[] = [];
  private runT = 0;
  private lastSample = 0;
  private lastCross = 0;
  private jammed = false;
  private pile = { angle: NaN, crater: NaN, craterAngle: NaN, t: -1 };
  private avalanche = 0;
  private tickDebt = 0;
  private bubbleKick = 0;
  private lastGlug = 0;
  /** What the sound and haptics were last told, for the dev hook. */
  private out = { hiss: 0, bright: 0, ticks: 0, glugs: 0, knocks: 0, haptic: 0 };
  // Output.
  private trickle: Loop;
  private t = 0;
  private w = 1;
  private h = 1;
  private vw: View2D = { cx: 0, cy: 0, scale: 1, angle: 0 };
  private style: HTMLStyleElement;
  private dock: HTMLDivElement;
  private graph: HTMLCanvasElement;
  private gg: CanvasRenderingContext2D;
  private readout: HTMLDivElement;
  private hint: HTMLDivElement;
  private tiltButton: HTMLButtonElement | null = null;
  private used = false;
  private hintText = navigator.maxTouchPoints > 0 ? 'Turn your phone over · or tap Flip' : 'Drag to turn the glass · tap to knock it';
  private perf = { sim: 0, draw: 0 };
  private isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  constructor(private ctx: ToyContext) {
    this.glass = new Glass(this.tune.neck / 1000);
    this.view = new HourglassView(ctx.canvas, Math.max(MAX_GRAINS, MAX_WATER));
    this.trickle = ctx.sound.loop('trickle');

    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'hg-hint';
    this.hint.textContent = this.hintText;
    this.dock = document.createElement('div');
    this.dock.className = 'hg-dock';
    this.readout = document.createElement('div');
    this.readout.className = 'hg-readout';
    this.graph = document.createElement('canvas');
    this.graph.className = 'hg-graph';
    this.gg = this.graph.getContext('2d')!;
    const flipBtn = document.createElement('button');
    flipBtn.type = 'button';
    flipBtn.className = 'hg-btn';
    flipBtn.textContent = 'Flip';
    flipBtn.addEventListener('click', () => this.startFlip());
    const col = document.createElement('div');
    col.className = 'hg-col';
    col.append(this.readout, this.graph);
    this.dock.append(col, flipBtn);
    ctx.overlay.append(this.hint, this.dock);

    ctx.panel.choice<Medium>('Medium', [
      { value: 'sand', label: 'Sand' },
      { value: 'salt', label: 'Salt' },
      { value: 'steel', label: 'Steel' },
      { value: 'water', label: 'Water' },
    ], 'sand', (m) => this.setMedium(m));
    ctx.panel.slider(this.tune, 'neck', { label: 'Neck width (mm)', min: 1.5, max: 8, step: 0.25, onChange: (v) => this.glass.setNeck(v / 1000) });
    ctx.panel.slider(this.tune, 'grain', { label: 'Grain size (mm)', min: 0.85, max: 1.6, step: 0.05, onChange: () => this.refill() });
    ctx.panel.action('Flip', () => this.startFlip());
    ctx.panel.action('Refill the top', () => this.refill());

    this.setupMotion();
    ctx.canvas.addEventListener('pointerdown', this.onDown);
    this.refill();

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__hourglass = () => this.devState();
      w.__hourglassDev = {
        /** Gravity direction in the screen frame, degrees from straight down (0 = upright, 180 = upside down), and strength in g. */
        gravity: (deg: number, g = 1) => (this.devGravity = [Math.sin((deg * Math.PI) / 180) * g * G, -Math.cos((deg * Math.PI) / 180) * g * G]),
        clearGravity: () => (this.devGravity = null),
        shake: (amp = 2, secs = 0.5, f = 7) => (this.devShake = { until: this.t + secs, amp, f }),
        flip: () => this.startFlip(),
        knock: () => this.knock(0, 0),
        medium: (m: Medium) => this.setMedium(m),
        neck: (mm: number) => {
          this.tune.neck = mm;
          this.glass.setNeck(mm / 1000);
        },
        grain: (mm: number) => {
          this.tune.grain = mm;
          this.refill();
        },
        refill: () => this.refill(),
        runs: () => this.runs.map((r) => ({ medium: r.medium, pts: r.pts.map((v) => +v.toFixed(3)) })),
      };
    }
  }

  // ---------------------------------------------------------------- setup

  private setupMotion() {
    const onMotion = (e: DeviceMotionEvent) => {
      const a = e.accelerationIncludingGravity;
      if (!a || a.x == null || a.y == null || a.z == null) return;
      // Device frame: x right, y up the screen, z out of it. iOS reports gravity as it points;
      // other platforms the reaction, so flip. Linear acceleration (a shake) comes along with it.
      const sign = this.isIOS ? 1 : -1;
      let x = a.x * sign, y = a.y * sign;
      const z = a.z * sign;
      const ang = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
      const r = (-ang * Math.PI) / 180;
      [x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
      this.motion = [x, y, z];
      if (!this.motionSeen) {
        this.motionSeen = true;
        this.hideTilt();
      }
    };
    this.onMotion = onMotion;
    const DME = typeof DeviceMotionEvent !== 'undefined' ? (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }) : null;
    const touch = navigator.maxTouchPoints > 0;
    if (DME && typeof DME.requestPermission === 'function' && touch) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hud-btn';
      b.textContent = 'Enable tilt';
      Object.assign(b.style, { left: '50%', transform: 'translateX(-50%)', top: 'calc(96px + var(--safe-top))' });
      b.addEventListener('click', async () => {
        try {
          const res = await DME.requestPermission!();
          if (res === 'granted') {
            addEventListener('devicemotion', onMotion);
            b.textContent = 'Turn your phone over';
            setTimeout(() => !this.motionSeen && this.hideTilt(), 2500);
          } else {
            b.textContent = 'Tilt blocked · use Flip or drag';
            setTimeout(() => this.hideTilt(), 2500);
          }
        } catch {
          b.textContent = 'Use Flip or drag the glass';
          setTimeout(() => this.hideTilt(), 2500);
        }
      });
      this.tiltButton = b;
      this.ctx.overlay.appendChild(b);
    } else if (touch) {
      addEventListener('devicemotion', onMotion);
    }
  }

  private onMotion: ((e: DeviceMotionEvent) => void) | null = null;

  private hideTilt() {
    this.tiltButton?.remove();
    this.tiltButton = null;
  }

  private setMedium(m: Medium) {
    this.medium = m;
    this.refill();
  }

  /** Put everything back in the upper bulb (relative to gravity now), settled, and start a run. */
  private refill() {
    const g = this.glassGravity();
    this.src = g[1] <= 0 ? 1 : -1;
    const sim = this.medium === 'water' ? this.water : this.grains;
    if (this.medium === 'water') this.water.fill(this.glass, FILL, 0.0014, this.src);
    else {
      const def = MEDIA[this.medium];
      this.grains.cfg = { ...def.cfg };
      this.grains.fill(this.glass, FILL, this.tune.grain / 1000, def.spread, this.src);
    }
    // Settle against a temporary plug in the neck for a moment so it starts as a packed bed.
    this.grains.plug = this.water.plug = false;
    sim.plug = true;
    this.plugUntil = this.t + 0.4;
    for (let i = 0; i < sim.n; i++) this.side[i] = sim.y[i] >= 0 ? 1 : -1;
    this.newRun();
  }

  private newRun(push = true) {
    if (push || !this.runs.length) this.runs.push({ medium: this.medium, pts: [] });
    else this.runs[this.runs.length - 1].pts.length = 0;
    if (this.runs.length > 4) this.runs.shift();
    this.runT = this.t;
    this.flux.length = 0;
    this.fluxT.length = 0;
    this.lastCross = this.t;
    this.jammed = false;
  }

  private startFlip() {
    if (this.flip) return;
    this.used = true;
    const to = Math.round((this.angle + Math.PI) / Math.PI) * Math.PI;
    this.flip = { from: this.angle, to, t: 0, dur: 0.75 };
  }

  private knock(x: number, y: number) {
    // A knuckle on the glass: a short sharp jolt to everything inside, and the glass rings.
    const a = Math.atan2(y, x) + Math.PI + (Math.random() - 0.5);
    this.jolt = { x: Math.cos(a) * 3 * G, y: Math.sin(a) * 3 * G, t: 0.05 };
    this.ctx.sound.impact('glass', 0.11, 0.55, { pan: Math.max(-1, Math.min(1, x / R)) * 0.5 });
    this.out.knocks++;
    this.ctx.haptic('light');
    this.used = true;
  }

  private onDown = () => {
    this.used = true;
  };

  // ---------------------------------------------------------------- per frame

  /** Gravity plus felt acceleration in the glass frame (m/s²), and the part pressing on the back pane. */
  private glassGravity(): [number, number, number] {
    let gx = 0, gy = -G, gz = 0;
    if (this.devGravity) [gx, gy] = this.devGravity;
    else if (this.motion) [gx, gy, gz] = this.motion;
    if (this.devShake.until > this.t) {
      const ph = 2 * Math.PI * this.devShake.f * this.t;
      gx += this.devShake.amp * G * Math.sin(ph);
      gy += 0.5 * this.devShake.amp * G * Math.sin(ph * 1.3 + 1);
    }
    if (this.jolt.t > 0) {
      gx += this.jolt.x;
      gy += this.jolt.y;
    }
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    return [c * gx + s * gy, -s * gx + c * gy, gz];
  }

  private input(dt: number) {
    const ptr = this.ctx.pointers;
    const pr = this.ctx.pixelRatio;
    for (const p of ptr.active.values()) {
      const px = p.x * this.w, py = (1 - p.y) * this.h;
      const a = Math.atan2(-(py - this.vw.cy), px - this.vw.cx);
      if (p.justDown && !this.drag) this.drag = { id: p.id, start: a, moved: false, x: px, y: py, t: this.t };
      if (!this.drag || this.drag.id !== p.id) continue;
      if (Math.hypot(px - this.drag.x, py - this.drag.y) > 10 * pr) this.drag.moved = true;
      if (this.drag.moved && !this.flip) {
        let d = a - this.drag.start;
        d = Math.atan2(Math.sin(d), Math.cos(d));
        this.drag.start = a;
        this.angle += d;
      }
    }
    if (this.drag && !ptr.active.has(this.drag.id)) {
      const d = this.drag;
      // A quick tap on the glass is a knock.
      if (!d.moved && this.t - d.t < 0.35) {
        const gx = (d.x - this.vw.cx) / this.vw.scale, gy = -(d.y - this.vw.cy) / this.vw.scale;
        const c = Math.cos(-this.angle), s = Math.sin(-this.angle);
        const lx = c * gx - s * gy, ly = s * gx + c * gy;
        if (Math.abs(lx) < R + 0.01 && Math.abs(ly) < HB + 0.01) this.knock(lx, ly);
      }
      this.drag = null;
    }
    if (this.flip) {
      const f = this.flip;
      f.t += dt;
      const u = Math.min(1, f.t / f.dur);
      // Pick it up, turn it, set it down.
      const e = u < 0.5 ? 4 * u * u * u : 1 - Math.pow(-2 * u + 2, 3) / 2;
      this.angle = f.from + (f.to - f.from) * e;
      if (u >= 1) {
        this.flip = null;
        this.ctx.sound.impact('glass', 0.12, 0.7);
        this.ctx.sound.impact('wood', 0.16, 0.5);
        this.out.knocks++;
        this.ctx.haptic('medium');
      }
    }
  }

  frame(dt: number, t: number) {
    this.t = t;
    const ctx = this.ctx;
    const prevAngle = this.angle, prevOmega = this.omega;
    this.input(dt);
    // Frame angular velocity and acceleration, lightly smoothed (drag is noisy).
    const om = (this.angle - prevAngle) / dt;
    this.omega += (om - this.omega) * 0.5;
    this.alpha = Math.max(-400, Math.min(400, (this.omega - prevOmega) / dt));
    if (this.jolt.t > 0) this.jolt.t -= dt;

    const [gx, gy, gz] = this.glassGravity();
    const t0 = performance.now();
    const water = this.medium === 'water';
    const sim = water ? this.water : this.grains;
    const steps = Math.max(1, Math.round(dt * 60));
    const sub = water ? SUB_WATER : SUB_GRAIN;
    // Grains lying against the back pane feel Coulomb drag from the gravity pushing them into it.
    const f: Forces = { gx, gy, w: this.omega, alpha: this.alpha, face: water ? 0 : 0.25 * Math.abs(gz) };
    if (sim.plug && t > this.plugUntil) {
      sim.plug = false;
      this.newRun(false);
    }
    for (let s = 0; s < steps; s++) sim.step(this.glass, dt / steps, sub, f);
    const t1 = performance.now();

    // Which bulb is on top now? A flip starts a new run.
    const gl = Math.hypot(gx, gy);
    const axis = gl > 0.5 ? gy / gl : 0;
    const src: 1 | -1 = axis < 0 ? 1 : -1;
    if (Math.abs(axis) > 0.5 && src !== this.src) {
      this.src = src;
      this.newRun();
      if (this.motion && !this.flip) this.settleKnock = t;
    }
    // Set down after turning the phone over: knock once the felt gravity steadies.
    if (this.settleKnock >= 0 && Math.abs(axis - this.sAxisPrev) < 0.01 && t - this.settleKnock > 0.25) {
      this.settleKnock = -1;
      ctx.sound.impact('glass', 0.12, 0.5);
      ctx.haptic('medium');
      this.out.knocks++;
    }
    this.sAxisPrev = axis;

    // Count crossings of the neck's midline (with a little hysteresis) toward the lower bulb.
    const n = sim.n, y = sim.y, side = this.side;
    let cross = 0, above = 0;
    for (let i = 0; i < n; i++) {
      const yy = y[i];
      if (side[i] > 0 && yy < -0.0005) {
        side[i] = -1;
        cross += this.src;
      } else if (side[i] < 0 && yy > 0.0005) {
        side[i] = 1;
        cross -= this.src;
      }
      if (side[i] === this.src) above++;
    }
    if (water) this.water.owe(cross, this.glass, this.src);
    this.flux.push(cross);
    this.fluxT.push(t);
    const win = water ? RATE_WIN.water : RATE_WIN.grain;
    while (this.fluxT.length && this.fluxT[0] < t - win) {
      this.fluxT.shift();
      this.flux.shift();
    }
    let sum = 0;
    for (const c of this.flux) sum += c;
    const span = Math.min(win, Math.max(1 / 60, t - this.runT));
    this.rate = Math.max(0, sum / span);
    if (cross > 0) this.lastCross = t;
    const left = n ? above / n : 0;
    const run = this.runs[this.runs.length - 1];
    if (t - this.runT > win && t - this.lastSample > (water ? 0.05 : 0.1) && left > 0.005 && run.pts.length < 800) {
      this.lastSample = t;
      run.pts.push(left, this.rate);
    }
    // Clogged: sand waiting above, gravity along the axis, nothing through for a while.
    this.jammed = !water && left > 0.03 && Math.abs(axis) > 0.8 && t - this.lastCross > 1.2 && t - this.runT > 1;

    this.writeParticles(gx, gy);
    const t2 = performance.now();
    this.vw = this.pose();
    this.view.draw(this.glass, this.vw, water ? 'water' : (this.medium as Look), n, water ? this.water.bubbles : []);
    const t3 = performance.now();
    this.perf.sim += (t1 - t0 - this.perf.sim) * 0.05;
    this.perf.draw += (t3 - t2 - this.perf.draw) * 0.05;

    if (t - this.pile.t > 0.5 && !water) this.measurePile();
    this.sound(dt);
    this.drawGraph();
    this.hint.textContent = this.jammed ? 'Clogged · shake it or tap the glass' : this.hintText;
    this.hint.classList.toggle('show', this.jammed || (!this.used && t > 0.8 && t < 12));
    ctx.setStatus(`${n} ${water ? 'water particles' : 'grains'}`);
  }

  /** Screen placement: fit the frame, rotated, between the HUD and the dock. */
  private pose(): View2D {
    const pr = this.ctx.pixelRatio;
    const top = 64 * pr, bottom = this.h - 132 * pr;
    const bw = 2 * (R + 0.016), bh = 2 * (HB + WALL + 0.012);
    const c = Math.abs(Math.cos(this.angle)), s = Math.abs(Math.sin(this.angle));
    const availW = this.w - 24 * pr, availH = bottom - top;
    const scale = Math.min(availW / (c * bw + s * bh), availH / (s * bw + c * bh));
    return { cx: this.w / 2, cy: (top + bottom) / 2, scale, angle: this.angle };
  }

  private writeParticles(gx: number, gy: number) {
    const d = this.view.data, sh = this.view.shade;
    const water = this.medium === 'water';
    let aval = 0;
    if (water) {
      const w = this.water, rr = w.s * 1.25;
      for (let i = 0; i < w.n; i++) {
        d[i * 4] = w.x[i];
        d[i * 4 + 1] = w.y[i];
        d[i * 4 + 2] = rr;
        d[i * 4 + 3] = 0;
        sh[i * 2] = 1;
        sh[i * 2 + 1] = 0;
      }
    } else {
      const g = this.grains, recv = -this.src;
      const gl = Math.hypot(gx, gy) || 1;
      for (let i = 0; i < g.n; i++) {
        d[i * 4] = g.x[i];
        d[i * 4 + 1] = g.y[i];
        d[i * 4 + 2] = g.r[i];
        d[i * 4 + 3] = g.tint[i];
        // Buried grains sit in their neighbours' shade.
        const c = g.contacts[i];
        sh[i * 2] = 1.06 - Math.min(0.3, c * 0.045);
        sh[i * 2 + 1] = g.th[i];
        // Avalanching: grains in the lower bed sliding downhill (supported, moving, not in free fall).
        if (c >= 2 && g.y[i] * recv > 0.004) {
          const v2 = g.vx[i] * g.vx[i] + g.vy[i] * g.vy[i];
          if (v2 > 0.03 * 0.03 && v2 < 0.35 * 0.35 && (g.vx[i] * gx + g.vy[i] * gy) / gl > 0) aval++;
        }
      }
    }
    this.avalanche = aval;
  }

  private measurePile() {
    const g = this.grains, d = this.tune.grain / 1000;
    const rep = reposeAngle(this.glass, g.x, g.y, g.vx, g.vy, g.n, this.src, d);
    const cr = crater(this.glass, g.x, g.y, g.vx, g.vy, g.n, this.src, d);
    this.pile = { angle: rep.mean, crater: cr.depth, craterAngle: cr.angle, t: this.t };
  }

  private sound(dt: number) {
    const ctx = this.ctx, water = this.medium === 'water';
    const q = this.rate;
    if (water) {
      // Running water: a darker trickle, plus the glug of each bubble of air that goes up.
      this.out.hiss = Math.min(1, q / 900) * 0.45;
      this.out.bright = 0.15;
      this.trickle.set(this.out.hiss, this.out.bright);
      // One glug per bubble, but no closer than 45 ms: at full flow the bubbles come faster than
      // separate glugs can be heard, and the neck sounds like a gargle instead.
      const rel = this.water.released;
      if (rel.length && this.t - this.lastGlug > 0.045) {
        const b = rel[rel.length - 1];
        ctx.sound.bubble(b.r * 1.3, { gain: 0.5 + 0.1 * Math.min(4, rel.length), pan: b.x / R });
        this.bubbleKick = 1;
        this.lastGlug = this.t;
        this.out.glugs++;
        rel.length = 0;
      } else if (rel.length > 8) rel.length = 0;
    } else {
      const def = MEDIA[this.medium as Exclude<Medium, 'water'>];
      // The hiss follows the measured discharge: grains through the neck per second.
      const level = Math.min(1, Math.pow(q / 1000, 0.75)) * 0.9;
      const bright = Math.max(0, Math.min(1, 0.35 + (1.3 - this.tune.grain) * 0.6 + (this.medium === 'salt' ? 0.15 : 0)));
      this.trickle.set(level, bright);
      this.out.hiss = level;
      this.out.bright = bright;
      // Ticks from grains sliding down the pile's flanks.
      this.tickDebt += Math.min(40, this.avalanche) * dt * 1.2;
      let k = 0;
      while (this.tickDebt >= 1 && k < 3) {
        this.tickDebt -= 1;
        k++;
        this.out.ticks++;
        ctx.sound.play('tick', { pitch: def.tick * (0.8 + Math.random() * 0.5) / Math.sqrt(this.tune.grain), gain: 0.25 + Math.random() * 0.3, pan: (Math.random() - 0.5) * 0.6 });
      }
      if (this.tickDebt > 3) this.tickDebt = 3;
    }
    // Haptics: a faint, steady buzz that follows the flow; a bump per glug for water.
    this.bubbleKick *= Math.exp(-dt * 18);
    const inten = Math.min(1, q / (water ? 1200 : 700)) * 0.5 + this.bubbleKick * 0.35;
    const sharp = water ? 0.25 : MEDIA[this.medium as Exclude<Medium, 'water'>].sharp;
    this.out.haptic = inten > 0.03 ? inten : 0;
    if (inten > 0.03) ctx.hapticLevel(inten, sharp);
  }

  private drawGraph() {
    const c = this.graph, g = this.gg, pr = this.ctx.pixelRatio;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    if (c.width !== Math.round(W * pr)) {
      c.width = Math.round(W * pr);
      c.height = Math.round(H * pr);
    }
    g.setTransform(pr, 0, 0, pr, 0, 0);
    g.clearRect(0, 0, W, H);
    const pad = 6, bottom = H - 12;
    let ymax = 60;
    for (const r of this.runs) for (let i = 1; i < r.pts.length; i += 2) ymax = Math.max(ymax, r.pts[i] * 1.15);
    const X = (f: number) => pad + (W - 2 * pad) * (1 - f);
    const Y = (q: number) => bottom - (bottom - 17) * (q / ymax);
    g.strokeStyle = 'rgba(255,255,255,0.12)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(pad, bottom + 0.5);
    g.lineTo(W - pad, bottom + 0.5);
    g.stroke();
    g.fillStyle = 'rgba(230,220,200,0.5)';
    g.font = '600 9px ui-rounded, system-ui, sans-serif';
    g.textBaseline = 'alphabetic';
    g.fillText('full', pad, H - 2);
    g.textAlign = 'right';
    g.fillText('empty', W - pad, H - 2);
    g.textAlign = 'center';
    g.fillText('rate vs what is left above', W / 2, H - 2);
    g.textAlign = 'left';
    this.runs.forEach((r, k) => {
      const last = k === this.runs.length - 1;
      g.strokeStyle = r.medium === 'water' ? WATER_COLOUR : MEDIA[r.medium].colour;
      g.globalAlpha = last ? 1 : 0.35;
      g.lineWidth = last ? 2 : 1.5;
      g.beginPath();
      for (let i = 0; i < r.pts.length; i += 2) {
        const x = X(r.pts[i]), y = Y(r.pts[i + 1]);
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    });
    g.globalAlpha = 1;
    // Legend (one entry per medium shown) and the scale.
    g.font = '600 9px ui-rounded, system-ui, sans-serif';
    g.textBaseline = 'top';
    let lx = pad + 2;
    const seen = new Set<Medium>();
    for (let k = this.runs.length - 1; k >= 0; k--) {
      const m = this.runs[k].medium;
      if (seen.has(m)) continue;
      seen.add(m);
      const label = m === 'water' ? 'Water' : MEDIA[m].label;
      g.fillStyle = m === 'water' ? WATER_COLOUR : MEDIA[m].colour;
      g.globalAlpha = k === this.runs.length - 1 ? 1 : 0.55;
      g.fillText(label, lx, 4);
      lx += g.measureText(label).width + 8;
    }
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(230,220,200,0.45)';
    g.textAlign = 'right';
    g.fillText(`${Math.round(ymax)}/s`, W - pad, 4);
    g.textAlign = 'left';
    g.textBaseline = 'alphabetic';
    const water = this.medium === 'water';
    const unit = water ? 'particles/s' : 'grains/s';
    const left = this.runs.length ? this.runs[this.runs.length - 1].pts : [];
    const pct = left.length ? Math.round(left[left.length - 2] * 100) : 100;
    let extra = '';
    if (!water && Number.isFinite(this.pile.angle)) extra = ` · pile ${Math.round(this.pile.angle)}°`;
    this.readout.textContent = `${Math.round(this.rate)} ${unit} · ${pct}% above${extra}`;
  }

  private devState() {
    const water = this.medium === 'water';
    const sim = water ? this.water : this.grains;
    let above = 0;
    for (let i = 0; i < sim.n; i++) if (this.side[i] === this.src) above++;
    const g = this.glassGravity();
    return {
      medium: this.medium,
      neckMm: this.tune.neck,
      grainMm: this.tune.grain,
      n: sim.n,
      above,
      left: +(above / Math.max(1, sim.n)).toFixed(3),
      rate: Math.round(this.rate),
      jammed: this.jammed,
      src: this.src,
      angleDeg: +((this.angle * 180) / Math.PI).toFixed(1),
      gravity: g.map((v) => +v.toFixed(2)),
      pile: { reposeDeg: +this.pile.angle.toFixed(1), craterMm: +(this.pile.crater * 1000).toFixed(2), craterDeg: +this.pile.craterAngle.toFixed(1) },
      avalanche: this.avalanche,
      out: { ...this.out, hiss: +this.out.hiss.toFixed(3), bright: +this.out.bright.toFixed(2), haptic: +this.out.haptic.toFixed(3) },
      bubbles: water ? this.water.bubbles.length : 0,
      perf: { simMs: +this.perf.sim.toFixed(2), drawMs: +this.perf.draw.toFixed(2) },
    };
  }

  resize(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.vw = this.pose();
  }

  destroy() {
    this.ctx.canvas.removeEventListener('pointerdown', this.onDown);
    if (this.onMotion) removeEventListener('devicemotion', this.onMotion);
    this.trickle.stop();
    this.view.destroy();
    this.hint.remove();
    this.dock.remove();
    this.hideTilt();
    this.style.remove();
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      delete w.__hourglass;
      delete w.__hourglassDev;
    }
  }
}

const STYLE = `
.hg-hint { position: absolute; left: 50%; bottom: calc(128px + var(--safe-bottom, 0px)); transform: translateX(-50%); padding: 7px 14px; border-radius: 999px; background: rgba(24, 18, 14, 0.62); color: #eee2cc; font: 600 14px/1 ui-rounded, system-ui, sans-serif; opacity: 0; transition: opacity .3s; pointer-events: none; white-space: nowrap; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.hg-hint.show { opacity: 1; }
.hg-dock { position: absolute; left: 50%; bottom: calc(14px + var(--safe-bottom, 0px)); transform: translateX(-50%); width: min(400px, calc(100% - 32px)); display: flex; gap: 12px; align-items: flex-end; pointer-events: none; }
.hg-col { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.hg-readout { color: #eadcc2; font: 600 13px/1.2 ui-rounded, system-ui, sans-serif; letter-spacing: .02em; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.hg-dock .hg-graph { position: static; display: block; width: 100%; height: 70px; border-radius: 10px; background: rgba(20, 15, 12, 0.55); }
.hg-btn { flex: none; pointer-events: auto; height: 48px; padding: 0 20px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.16); background: rgba(52, 38, 26, 0.85); color: #f3e3c4; font: 700 15px/1 ui-rounded, system-ui, sans-serif; }
.hg-btn:active { transform: scale(.96); }
`;
