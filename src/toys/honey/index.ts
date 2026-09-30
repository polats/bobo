import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop, Slip } from '../../shell/sound';
import { LIQUIDS, type Liquid, type LiquidId } from './liquids';
import { Pool, type Base } from './pool';
import { FREE, NOZZLE, STUCK, Thread, type ThreadHost } from './thread';
import { HEAD_LEN, HEAD_R, LIGHT, Renderer, headEnv, norm, woodR, type DipperPose, type Ribbon, type Vec3 } from './render';

export const honeyToy: Toy = {
  id: 'honey',
  title: 'Honey Drizzle',
  blurb: 'Hold a honey dipper over toast. The falling thread coils on its own, faster and tighter the higher you lift it. Drag it along and the coils stretch into loops, figure-eights and meanders, then a straight line once you outrun the thread. It all pools and soaks in. Try syrup, chocolate or condensed milk.',
  tech: 'Discrete viscous thread (stretch 3μA, bend 3μI on strain rates, volume per edge; optional twist μJ) · XPBD with an exact banded solve · adaptive nodes, stick-on-landing · lubrication-flow honey film, implicit · WebGL2 refraction',
  swatch: 'radial-gradient(circle at 50% 62%,#ffcf5a 0 9%,#e79a1c 16%,transparent 26%),linear-gradient(180deg,#3b2414 0 38%,#d59a4c 39% 86%,#8a5222 87%)',
  refs: [
    {
      short: 'Bergou et al. 2010',
      title: 'Discrete Viscous Threads (Bergou, Audoly, Vouga, Wardetzky, Grinspun, ACM SIGGRAPH 2010 / ACM TOG 29(4))',
      url: 'https://doi.org/10.1145/1778765.1778853',
      use: 'The model: a viscous thread as a discrete rod whose rest shape is its own shape a moment earlier, so forces follow strain rates (Trouton stretching 3μA, bending 3μI); fixed volume per edge, so it thins as it stretches; nodes born at a nozzle. Twisting viscosity (μJ) is an experimental option, off by default.',
    },
    {
      short: 'Macklin et al. 2016',
      title: 'XPBD: Position-Based Simulation of Compliant Constrained Dynamics (Macklin, Müller, Chentanez, MIG 2016)',
      url: 'https://doi.org/10.1145/2994258.2994272',
      use: 'The integrator: each viscous term is a compliant constraint (compliance = length / (3μ · section · substep)), reset to the current shape every substep.',
    },
    {
      short: 'Deul et al. 2018',
      title: 'Direct Position-Based Solver for Stiff Rods (Deul, Kugelstadt, Weiler, Bender, Computer Graphics Forum 2018)',
      url: 'https://doi.org/10.1111/cgf.13326',
      use: 'Solving a rod’s constraints directly instead of by Gauss-Seidel: here stretch and bend rows are interleaved into a banded system and factorised exactly each iteration. Viscous bending is near-rigid within a substep, and without this the coils shrank to the node spacing.',
    },
    {
      short: 'Ribe 2004',
      title: 'Coiling of viscous jets (N. M. Ribe, Proc. R. Soc. A 460, 2004)',
      url: 'https://doi.org/10.1098/rspa.2004.1353',
      use: 'The viscous, gravitational and inertial coiling regimes the sim is checked against: coils get smaller and faster as the fall height grows. The HUD shows the measured coiling rate.',
    },
    {
      short: 'Chiu-Webster & Lister 2006',
      title: 'The fall of a viscous thread onto a moving surface: a ‘fluid-mechanical sewing machine’ (J. Fluid Mech. 569, 2006)',
      url: 'https://doi.org/10.1017/s0022112006002503',
      use: 'The patterns to expect when the dipper moves: straight when faster than the thread falls, then meanders, loops and translated coils as you slow down.',
    },
    {
      short: 'Brun, Ribe & Audoly 2012',
      title: 'A numerical investigation of the fluid mechanical sewing machine (Physics of Fluids 24, 2012)',
      url: 'https://doi.org/10.1063/1.3703316',
      use: 'Evidence that a discrete viscous rod on its own reproduces the sewing-machine patterns, which is what this toy relies on.',
    },
    {
      short: 'Huppert 1982',
      title: 'The propagation of two-dimensional and axisymmetric viscous gravity currents over a rigid horizontal surface (J. Fluid Mech. 121, 1982)',
      url: 'https://doi.org/10.1017/s0022112082001797',
      use: 'How the laid honey spreads: a thin viscous film with flux (ρg h³/3μ)∇(h + bread), stepped implicitly, so coil piles slump and run into the crumb.',
    },
  ],
  async create(ctx) {
    return new Honey(ctx);
  },
};

/** Dipper holds this much honey when full (m³). */
const LOAD_CAP = 6e-6;
/** Flow off a full dipper of honey (m³/s); film drainage scales as 1/μ. */
const Q_REF = 3e-7;
const H_MIN = 0.004;
const H_MAX = 0.14;
const CORNERS = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
const BLOB_INDEX = new Uint32Array([0, 2, 1, 1, 2, 3]);
/** Shadow strip: five vertices across (soft edge, dark band, bright focus). */
const ACROSS = [-1, -0.45, 0, 0.45, 1];
/** Merged rope stays visible this long (s). */
const ECHO = 0.35;
/** How far from the bread's centre the dipper can pour (m). */
const REACH = 0.054;

interface Finger {
  role: 'dipper' | 'plate';
  grab: Vec3;
}

class Honey implements ToyInstance {
  private view: Renderer;
  private pool = new Pool(256, 0.064);
  private thread = new Thread(1600);
  private liquid: Liquid = LIQUIDS.honey;
  private tune = { mu: 10, flow: 1, tilt: 0, slow: 1, bottomless: 0 };
  private base: Base = 'toast';
  private w = 1;
  private h = 1;
  /** Nozzle: where the finger wants it, and where it is (smoothed). */
  private target: Vec3 = [0, 0.045, 0];
  private noz: Vec3 = [0, 0.045, 0];
  private prevNoz: Vec3 = [0, 0.045, 0];
  private nozVel: Vec3 = [0, 0, 0];
  private offset: [number, number] = [0, 0];
  private offsetTarget: [number, number] = [0, 0];
  private load = 1;
  private lean = 0;
  private pose: DipperPose = { origin: [0, 0, 0], ax: [1, 0, 0], ay: [0, 1, 0], az: [0, 0, 1] };
  private fingers = new Map<number, Finger>();
  private used = false;
  private t = 0;
  private simT = 0;
  // Landings: a ring of (sim time, x, z relative to the nozzle's ground point) for the coil counter.
  private landT = new Float64Array(8192);
  private landX = new Float64Array(8192);
  private landZ = new Float64Array(8192);
  private landA = new Float64Array(8192);
  private landN = 0;
  private coilHz = 0;
  private landRate = 0;
  private landCount = 0;
  private drips = 0;
  private dipped = false;
  private host: ThreadHost;
  private slip: Slip;
  private pour: Loop;
  private dev = { drive: 0, driveZ: 0 };
  private snapLog: number[][] = [];
  private lastDt = 0;
  private perf = { sim: 0, pool: 0, draw: 0 };
  private ribbon = { data: new Float32Array(1), index: new Uint32Array(1) };
  // Rope just merged into the film, drawn a moment longer as it slumps (render only; its volume is
  // already in the film): toast-local x0 z0 x1 z1, surface y, radius, sim time.
  private echoBuf = new Float64Array(1024 * 7);
  private echoN = 0;
  private shadowBuf = { data: new Float32Array(1), index: new Uint32Array(1) };
  private blobData = new Float32Array(4 * 7);
  private style: HTMLStyleElement;
  private hint: HTMLDivElement;
  private dock: HTMLDivElement;
  private readout: HTMLDivElement;
  private loadBar: HTMLDivElement;

  constructor(private ctx: ToyContext) {
    this.view = new Renderer(ctx.canvas, this.pool);
    this.slip = ctx.sound.slip();
    this.pour = ctx.sound.loop('trickle');
    this.host = {
      surface: (x, z) => this.pool.height(x - this.offset[0], z - this.offset[1]),
      land: (x, z, speed, a, fromBreak) => this.onLand(x, z, speed, a, fromBreak),
      bake: (x0, z0, x1, z1, vol, a) => {
        this.echo(x0, z0, x1, z1, a);
        this.pool.deposit(x0 - this.offset[0], z0 - this.offset[1], x1 - this.offset[0], z1 - this.offset[1], vol, a);
      },
      snap: (x, y, z) => {
        if (import.meta.env.DEV && this.snapLog.length < 200) this.snapLog.push([+this.thread.time.toFixed(3), +(y * 1000).toFixed(2), this.thread.substeps, +this.lastDt.toFixed(4)]);
      },
    };
    this.setLiquid('honey');

    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'hon-hint';
    this.hint.textContent = 'Lift the dipper · drag it · slide the plate';
    this.readout = document.createElement('div');
    this.readout.className = 'hon-readout';
    this.dock = document.createElement('div');
    this.dock.className = 'hon-dock';
    const chips = document.createElement('div');
    chips.className = 'hon-chips';
    const chipEls: HTMLButtonElement[] = [];
    for (const l of Object.values(LIQUIDS)) {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'hon-chip';
      b.textContent = l.chip;
      b.style.setProperty('--c', `rgb(${l.scatter.map((c) => Math.round(c * 255)).join(',')})`);
      b.setAttribute('aria-pressed', String(l.id === 'honey'));
      b.addEventListener('click', () => {
        chipEls.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        this.setLiquid(l.id);
        this.dip();
      });
      chipEls.push(b);
      chips.appendChild(b);
    }
    const dipBtn = document.createElement('button');
    dipBtn.type = 'button';
    dipBtn.className = 'hon-dip';
    this.loadBar = document.createElement('div');
    this.loadBar.className = 'hon-load';
    dipBtn.append('Dip', this.loadBar);
    dipBtn.addEventListener('click', () => this.dip());
    this.dock.append(chips, dipBtn);
    ctx.overlay.append(this.hint, this.readout, this.dock);

    ctx.panel.slider(this.tune, 'mu', { label: 'Viscosity (Pa·s)', min: 1, max: 80, step: 1, onChange: (v) => this.setMu(v) });
    ctx.panel.slider(this.tune, 'flow', { label: 'Flow ×', min: 0.2, max: 3, step: 0.1 });
    ctx.panel.slider(this.tune, 'tilt', { label: 'Tip the dipper (°)', min: 0, max: 40, step: 1 });
    ctx.panel.choice('Time', [{ value: '1', label: '1×' }, { value: '0.5', label: '½×' }, { value: '0.25', label: '¼×' }], '1', (v) => (this.tune.slow = Number(v)));
    ctx.panel.choice('Under it', [{ value: 'toast', label: 'Toast' }, { value: 'pancake', label: 'Pancake' }], 'toast', (v) => this.setBase(v));
    ctx.panel.choice('Dipper', [{ value: 'drains', label: 'Drains' }, { value: 'full', label: 'Never empties' }], 'drains', (v) => (this.tune.bottomless = v === 'full' ? 1 : 0));
    ctx.panel.choice('Twist (experimental)', [{ value: 'locked', label: 'Locked' }, { value: 'viscous', label: 'Viscous' }], 'locked', (v) => (this.thread.twist = v === 'viscous'));
    ctx.panel.action('Fresh slice', () => this.clearPlate());

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__honey = () => this.devState();
      w.__honeyDev = {
        /** Nozzle at x (cm from the bread's centre line) and height (cm above the toast top). */
        place: (xcm: number, hcm: number, zcm = 0) => {
          // The nozzle eases there (the thread sim sees the motion, not a jump).
          this.target = [xcm / 100, hcm / 100, zcm / 100];
        },
        drive: (vxcm: number, vzcm = 0) => (this.dev = { drive: vxcm / 100, driveZ: vzcm / 100 }),
        stop: () => (this.dev = { drive: 0, driveZ: 0 }),
        liquid: (id: LiquidId) => this.setLiquid(id),
        mu: (v: number) => this.setMu(v),
        flow: (f: number) => (this.tune.flow = f),
        tilt: (d: number) => (this.tune.tilt = d),
        slow: (f: number) => (this.tune.slow = f),
        full: (on = true) => (this.tune.bottomless = on ? 1 : 0),
        load: (v: number) => (this.load = v),
        dip: () => this.dip(),
        base: (b: Base) => this.setBase(b),
        clear: () => this.clearPlate(),
        plate: (xcm: number, zcm: number) => (this.offsetTarget = [xcm / 100, zcm / 100]),
        measure: (secs = 1.5) => this.measure(secs),
        snaps: () => this.snapLog,
        twist: (on = true) => (this.thread.twist = on),
        camera: (deg: number) => {
          this.view.elevation = deg;
          this.view.camera();
        },
        toScreen: (x: number, y: number, z: number) => {
          const p = this.view.project([x, y, z]);
          return [p[0] / ctx.pixelRatio, p[1] / ctx.pixelRatio];
        },
      };
    }
  }

  private setLiquid(id: LiquidId) {
    this.liquid = LIQUIDS[id];
    this.setMu(this.liquid.mu);
    this.thread.rho = this.pool.rho = this.liquid.rho;
    this.pool.soakRate = this.liquid.soak;
  }

  private setMu(v: number) {
    this.tune.mu = v;
    this.thread.mu = v;
    this.pool.mu = v;
  }

  private setBase(b: Base) {
    this.base = b;
    this.pool.setBase(b);
    this.view.setBase(this.pool);
    this.thread.clear();
  }

  private clearPlate() {
    this.pool.clear();
    this.thread.clear();
  }

  private dip() {
    this.load = 1;
    this.ctx.sound.play('squish', { gain: 0.5, pitch: 0.7 });
    this.ctx.haptic('light');
  }

  /**
   * Volume flux off the dipper: film drainage, faster with a fuller coat and when tipped. Drainage at
   * a given film goes as 1/μ, but a thicker liquid also coats the dipper thicker, so it's softened.
   */
  private flow() {
    const tip = 1 + 1.4 * Math.sin((this.tune.tilt * Math.PI) / 180);
    return Q_REF * this.tune.flow * Math.pow(10 / this.tune.mu, 0.6) * Math.pow(this.load, 2.2) * tip;
  }

  private onLand(x: number, z: number, speed: number, a: number, fromBreak: boolean) {
    const k = this.landN % 8192;
    const rx = x - this.noz[0], rz = z - this.noz[2];
    this.landT[k] = this.thread.time;
    this.landX[k] = rx;
    this.landZ[k] = rz;
    // Unwrapped angle about the centroid of the last 48 landings: the coil counter.
    const M = Math.min(48, this.landN);
    let cx = rx, cz = rz;
    for (let q = 1; q <= M; q++) {
      const j = (this.landN - q + 8192) % 8192;
      cx += this.landX[j];
      cz += this.landZ[j];
    }
    cx /= M + 1;
    cz /= M + 1;
    const ang = Math.atan2(rz - cz, rx - cx);
    if (this.landN > 0) {
      const j = (this.landN - 1 + 8192) % 8192;
      const prev = this.landA[j];
      let d = ang - wrapAngle(prev);
      d = wrapAngle(d);
      this.landA[k] = prev + d;
    } else this.landA[k] = ang;
    this.landN++;
    this.landCount++;
    if (fromBreak) {
      this.drips++;
      const pan = Math.max(-1, Math.min(1, x * 12));
      this.ctx.sound.play('plop', { pitch: 0.55 + 0.5 * Math.min(1, 0.6e-3 / Math.max(a, 1e-4)), gain: 0.35 + 0.4 * Math.min(1, speed), pan });
      this.ctx.sound.bubble(Math.max(0.0015, a * 3), { gain: 0.25, pan });
    }
  }

  /** Coiling rate from the landing ring: net turns over the last `secs` of sim time. */
  private coilRate(secs: number) {
    if (this.landN < 30) return 0;
    const last = (this.landN - 1) % 8192;
    const tEnd = this.landT[last];
    let j = last, steps = 0;
    while (steps < Math.min(this.landN - 1, 8000)) {
      const p = (j - 1 + 8192) % 8192;
      if (this.landT[p] < tEnd - secs) break;
      j = p;
      steps++;
    }
    const span = tEnd - this.landT[j];
    if (span < secs * 0.5 || steps < 20) return 0;
    return Math.abs(this.landA[last] - this.landA[j]) / (2 * Math.PI) / span;
  }

  /** Offline count for the dev hook: centre each landing on its neighbours (±40) first. */
  private measure(secs: number) {
    const n = Math.min(this.landN, 8000);
    const idx: number[] = [];
    const tEnd = this.landT[(this.landN - 1) % 8192];
    for (let q = n; q >= 1; q--) {
      const j = (this.landN - q) % 8192;
      if (this.landT[j] >= tEnd - secs) idx.push(j);
    }
    const W = 40;
    let ang = 0, prev = NaN, r = 0, rn = 0;
    for (let k = W; k < idx.length - W; k++) {
      let mx = 0, mz = 0;
      for (let q = k - W; q <= k + W; q++) {
        mx += this.landX[idx[q]];
        mz += this.landZ[idx[q]];
      }
      mx /= 2 * W + 1;
      mz /= 2 * W + 1;
      const dx = this.landX[idx[k]] - mx, dz = this.landZ[idx[k]] - mz;
      r += Math.hypot(dx, dz);
      rn++;
      const a = Math.atan2(dz, dx);
      if (!isNaN(prev)) ang += wrapAngle(a - prev);
      prev = a;
    }
    const span = idx.length > 2 * W + 2 ? this.landT[idx[idx.length - 1 - W]] - this.landT[idx[W]] : 0;
    const c = this.thread.contact();
    return {
      hz: span > 0 ? +(Math.abs(ang) / (2 * Math.PI) / span).toFixed(2) : 0,
      coilRadiusMm: rn ? +((r / rn) * 1000).toFixed(2) : 0,
      landings: idx.length,
      heightCm: +((this.noz[1] - this.surfaceUnderNozzle()) * 100).toFixed(2),
      nozzleCm: +(this.noz[1] * 100).toFixed(2),
      U1: +c.U1.toFixed(3),
      a1mm: +(c.a1 * 1000).toFixed(3),
      Q_mLs: +(this.thread.Q * 1e6).toFixed(3),
    };
  }

  private echo(x0: number, z0: number, x1: number, z1: number, a: number) {
    const [ox, oz] = this.offset;
    const k = (this.echoN++ % 1024) * 7, e = this.echoBuf;
    e[k] = x0 - ox; e[k + 1] = z0 - oz; e[k + 2] = x1 - ox; e[k + 3] = z1 - oz;
    e[k + 4] = this.pool.height(x0 - ox, z0 - oz);
    e[k + 5] = a;
    e[k + 6] = this.thread.time;
  }

  private surfaceUnderNozzle() {
    return this.pool.height(this.noz[0] - this.offset[0], this.noz[2] - this.offset[1]);
  }

  frame(dt: number, t: number) {
    this.t = t;
    this.lastDt = dt;
    const ctx = this.ctx;
    const t0 = performance.now();
    this.input(dt);

    // Dev drive: constant dipper speed along x (and z), wrapping at the bread's edge.
    if (this.dev.drive || this.dev.driveZ) {
      this.target[0] += this.dev.drive * dt * this.tune.slow;
      this.target[2] += this.dev.driveZ * dt * this.tune.slow;
      this.noz[0] = this.target[0];
      this.noz[2] = this.target[2];
    }

    // Smooth the nozzle toward the finger (a hand has some mass) and the plate toward its target.
    const k = 1 - Math.exp(-dt / 0.035);
    for (let i = 0; i < 3; i++) this.noz[i] += (this.target[i] - this.noz[i]) * k;
    const kp = 1 - Math.exp(-dt / 0.05);
    const dox = (this.offsetTarget[0] - this.offset[0]) * kp, doz = (this.offsetTarget[1] - this.offset[1]) * kp;
    if (dox || doz) {
      this.offset[0] += dox;
      this.offset[1] += doz;
      this.thread.shiftStuck(dox, doz);
    }
    // Never below the surface under it (plus a little), never off the reachable bread.
    const under = this.surfaceUnderNozzle();
    this.noz[1] = Math.max(under + 0.003, Math.min(H_MAX, this.noz[1]));
    this.noz[0] = Math.max(this.offset[0] - REACH, Math.min(this.offset[0] + REACH, this.noz[0]));
    this.noz[2] = Math.max(this.offset[1] - REACH, Math.min(this.offset[1] + REACH, this.noz[2]));

    // Flow and load.
    const simDt = dt * this.tune.slow;
    const Q = this.flow();
    if (!this.tune.bottomless) this.load = Math.max(0, this.load - (Q * simDt) / LOAD_CAP);
    const th = this.thread;
    th.Q = this.load > 0.02 ? Q : 0;
    th.a0 = 0.0007 + 0.0011 * Math.sqrt(this.load);
    th.ceiling = this.pool.peak + 0.004;
    const landsBefore = this.landCount;
    th.step(simDt, this.prevNoz[0], this.prevNoz[1], this.prevNoz[2], this.noz[0], this.noz[1], this.noz[2], this.host);
    for (let i = 0; i < 3; i++) this.nozVel[i] += ((this.noz[i] - this.prevNoz[i]) / Math.max(1e-4, simDt) - this.nozVel[i]) * 0.2;
    this.prevNoz = [...this.noz];
    const t1 = performance.now();
    this.pool.step(simDt);
    const t2 = performance.now();
    this.simT += simDt;

    // Coil counter and landing rate.
    const landed = this.landCount - landsBefore;
    this.landRate += (landed / dt - this.landRate) * 0.1;
    const moving = Math.hypot(this.nozVel[0], this.nozVel[2]);
    const hz = this.coilRate(0.5);
    this.coilHz += (hz - this.coilHz) * 0.15;

    this.buildGeometry();
    this.view.uploadHoney(this.pool);
    this.view.draw({ offset: this.offset, pose: this.pose, liquid: this.liquid, pancake: this.base === 'pancake', half: this.pool.half, thickness: this.pool.thickness, coat: true });
    const t3 = performance.now();
    const a = 0.05;
    this.perf.sim += (t1 - t0 - this.perf.sim) * a;
    this.perf.pool += (t2 - t1 - this.perf.pool) * a;
    this.perf.draw += (t3 - t2 - this.perf.draw) * a;

    this.sound(moving);
    const H = (this.noz[1] - under) * 100;
    this.readout.textContent = `${H.toFixed(1)} cm up` + (this.coilHz > 0.5 && moving < 0.012 ? ` · coiling ${this.coilHz < 10 ? this.coilHz.toFixed(1) : Math.round(this.coilHz)} Hz` : moving >= 0.012 ? ` · moving ${Math.round(moving * 100)} cm/s` : '');
    this.loadBar.style.transform = `scaleX(${this.load.toFixed(3)})`;
    this.hint.classList.toggle('show', !this.used && t > 0.8);
    ctx.setStatus(`${th.n} nodes · ${th.substeps} substeps · ${(th.Q * 1e6).toFixed(2)} mL/s`);
  }

  private input(dt: number) {
    const ctx = this.ctx, v = this.view, pr = ctx.pixelRatio;
    for (const p of ctx.pointers.active.values()) {
      const px = p.x * this.w, py = (1 - p.y) * this.h;
      const ray = v.ray(px, py);
      let f = this.fingers.get(p.id);
      if (!f || p.justDown) {
        // Near the dipper (or above the bread's far edge) grabs the dipper; on the plate slides it.
        const n = v.project(this.noz);
        const head = v.project(this.pose.origin.map((o, i) => o + this.pose.ax[i] * HEAD_LEN * 0.5) as Vec3);
        const near = Math.min(Math.hypot(px - n[0], py - n[1]), Math.hypot(px - head[0], py - head[1])) < 110 * pr;
        const far = v.project([this.offset[0], 0, this.offset[1] - 0.06]);
        const role = near || py < far[1] ? 'dipper' : 'plate';
        const hit = role === 'dipper' ? hitZ(ray, this.target[2]) : hitY(ray, 0);
        const grab: Vec3 = role === 'dipper' ? [this.target[0] - hit[0], this.target[1] - hit[1], 0] : [this.offsetTarget[0] - hit[0], 0, this.offsetTarget[1] - hit[2]];
        f = { role, grab };
        this.fingers.set(p.id, f);
        this.used = true;
        if (role === 'dipper') ctx.haptic('light');
      }
      if (!p.down) continue;
      if (f.role === 'dipper') {
        const hit = hitZ(ray, this.target[2]);
        this.target[0] = Math.max(this.offsetTarget[0] - REACH, Math.min(this.offsetTarget[0] + REACH, hit[0] + f.grab[0]));
        this.target[1] = Math.max(H_MIN, Math.min(H_MAX, hit[1] + f.grab[1]));
      } else {
        const hit = hitY(ray, 0);
        // Slide the plate, keeping the dipper over the bread.
        this.offsetTarget[0] = Math.max(this.noz[0] - REACH, Math.min(this.noz[0] + REACH, hit[0] + f.grab[0]));
        this.offsetTarget[1] = Math.max(this.noz[2] - REACH, Math.min(this.noz[2] + REACH, hit[2] + f.grab[2]));
      }
    }
    for (const id of [...this.fingers.keys()]) if (!ctx.pointers.active.has(id)) this.fingers.delete(id);
    void dt;
  }

  /** Dipper pose, its honey coat, the thread ribbons and the shadows. */
  private buildGeometry() {
    const v = this.view;
    // Axis: handle up to the right and toward us; tipping lifts the handle; it trails when dragged.
    this.lean += (Math.max(-0.5, Math.min(0.5, -this.nozVel[0] * 2.5)) - this.lean) * 0.12;
    const pitch = ((14 + this.tune.tilt) * Math.PI) / 180;
    const yaw = (28 * Math.PI) / 180;
    const ax = norm([Math.cos(pitch) * Math.cos(yaw) + this.lean * 0.3, Math.sin(pitch), Math.cos(pitch) * Math.sin(yaw)]);
    const up: Vec3 = [0, 1, 0];
    const d0 = up[0] * ax[0] + up[1] * ax[1] + up[2] * ax[2];
    const ay = norm([up[0] - ax[0] * d0, up[1] - ax[1] * d0, up[2] - ax[2] * d0]);
    const az: Vec3 = [ax[1] * ay[2] - ax[2] * ay[1], ax[2] * ay[0] - ax[0] * ay[2], ax[0] * ay[1] - ax[1] * ay[0]];
    // Straight down across the axis is -ay; the lowest point of the coat sets where the thread leaves.
    const L = this.load, tl = 0.00025 + 0.0022 * L;
    const fill = (s: number) => {
      if (s < 0) return (tl + 0.0012) * Math.sqrt(Math.max(0, 1 - (s / 0.0015) ** 2));
      if (s > HEAD_LEN) return Math.max(woodR(s) + tl * 0.3 * Math.max(0, 1 - (s - HEAD_LEN) / 0.004), 0);
      return Math.max(woodR(s) + tl * 0.35, headEnv(s) * 0.9 + tl * 0.8);
    };
    const sag = tl * 1.1;
    const nd = Math.sqrt(Math.max(0, 1 - ax[1] * ax[1]));
    let sBest = 0.01, yBest = Infinity;
    for (let s = 0.004; s <= HEAD_LEN - 0.004; s += 0.0005) {
      const y = s * ax[1] - (fill(s) + sag) * nd;
      if (y < yBest) {
        yBest = y;
        sBest = s;
      }
    }
    const neck = 0.0012 + 0.004 * L * Math.min(1, this.thread.Q / Q_REF + 0.2);
    const t = this.t;
    const coat = (s: number, down: number, phi: number) => {
      let r = fill(s) + sag * down * down;
      if (s >= 0 && s <= HEAD_LEN) {
        // Drops hanging off the lowest point of each ring, slowly swelling and letting go.
        const ring = Math.round((s - 0.003) / 0.0046);
        const sc = 0.003 + ring * 0.0046;
        const ph = Math.sin(t * (0.7 + 0.13 * ring) + ring * 2.1);
        const drop = L * 0.0022 * (0.55 + 0.45 * ph) * Math.exp(-(((s - sc) / 0.0011) ** 2));
        r += drop * Math.pow(down, 10);
      }
      // The neck the thread leaves from.
      r += neck * Math.exp(-(((s - sBest) / 0.0024) ** 2)) * Math.pow(down, 8);
      void phi;
      return r;
    };
    const drop: Vec3 = [-ay[0], -ay[1], -ay[2]];
    const reach = fill(sBest) + sag + neck;
    const origin: Vec3 = [this.noz[0] - ax[0] * sBest - drop[0] * reach, this.noz[1] - ax[1] * sBest - drop[1] * reach, this.noz[2] - ax[2] * sBest - drop[2] * reach];
    this.pose = { origin, ax, ay, az };
    v.setCoat(this.pose, coat);
    v.setThread(this.threadRibbon());
    v.setShadow(this.shadowRibbon());
    v.setBlob(this.blobQuad());
  }

  private threadRibbon(): Ribbon {
    const th = this.thread, n = th.n, v = this.view, eye = v.eye;
    const F = 9;
    const maxV = (n + 8) * 2 + 8 + 1024 * 4;
    if (this.ribbon.data.length < maxV * F) {
      this.ribbon.data = new Float32Array(maxV * F * 2);
      this.ribbon.index = new Uint32Array(maxV * 6 * 2);
    }
    const d = this.ribbon.data, idx = this.ribbon.index;
    let vtx = 0, ic = 0;
    const put = (x: number, y: number, z: number, sx: number, sy: number, sz: number, r: number, rd: number) => {
      const cover = Math.min(1, r / rd);
      for (const s of [-1, 1]) {
        const o = vtx * F;
        d[o] = x + sx * rd * s;
        d[o + 1] = y + sy * rd * s;
        d[o + 2] = z + sz * rd * s;
        d[o + 3] = sx; d[o + 4] = sy; d[o + 5] = sz;
        d[o + 6] = s;
        d[o + 7] = r;
        d[o + 8] = cover;
        vtx++;
      }
    };
    const link = () => {
      const a = vtx - 4;
      idx[ic++] = a; idx[ic++] = a + 1; idx[ic++] = a + 2;
      idx[ic++] = a + 1; idx[ic++] = a + 3; idx[ic++] = a + 2;
    };
    let seg = 0;
    for (let i = 0; i < n; i++) {
      const prevOk = i > 0 && !th.cut[i - 1];
      const nextOk = i < n - 1 && !th.cut[i];
      if (!prevOk && !nextOk) continue;
      const a = prevOk ? i - 1 : i, b = nextOk ? i + 1 : i;
      let tx = th.x[b] - th.x[a], ty = th.y[b] - th.y[a], tz = th.z[b] - th.z[a];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      const x = th.x[i], z = th.z[i];
      let y = th.y[i], r = th.nodeRadius(i);
      const ex = eye[0] - x, ey = eye[1] - y, ez = eye[2] - z;
      const dist = Math.hypot(ex, ey, ez);
      let sx = ty * ez - tz * ey, sy = tz * ex - tx * ez, sz = tx * ey - ty * ex;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl; sy /= sl; sz /= sl;
      const rd = Math.max(r, 0.75 * dist * v.pxScale);
      // A free end gets a rounded tip: one extra, narrower pair just past it.
      const freeEnd = th.kind[i] === FREE;
      if (!prevOk && freeEnd) {
        put(x - tx * r * 0.8, y - ty * r * 0.8, z - tz * r * 0.8, sx, sy, sz, r * 0.45, Math.max(r * 0.45, rd * 0.5));
        seg = 1;
      }
      put(x, y, z, sx, sy, sz, r, rd);
      if (prevOk || seg) link();
      seg = 0;
      if (!nextOk && freeEnd) {
        put(x + tx * r * 0.8, y + ty * r * 0.8, z + tz * r * 0.8, sx, sy, sz, r * 0.45, Math.max(r * 0.45, rd * 0.5));
        link();
      }
    }
    // The echo: recently merged rope, sinking into the film and fading over ECHO seconds.
    const e = this.echoBuf, [ox, oz] = this.offset, now = th.time;
    const first = Math.max(0, this.echoN - 1024);
    let px = NaN, pz = NaN;
    for (let q = first; q < this.echoN; q++) {
      const k = (q % 1024) * 7;
      const age = now - e[k + 6];
      if (age > ECHO || age < 0) {
        px = NaN;
        continue;
      }
      const sink = age / ECHO, a = e[k + 5];
      const r = a * (1 - 0.45 * sink), yc = e[k + 4] + a * 0.8 * (1 - sink) - a * 0.3 * sink;
      const x0 = e[k] + ox, z0 = e[k + 1] + oz, x1 = e[k + 2] + ox, z1 = e[k + 3] + oz;
      let tx = x1 - x0, tz = z1 - z0;
      const tl = Math.hypot(tx, tz) || 1;
      tx /= tl; tz /= tl;
      const cont = Math.abs(x0 - px) < 1e-9 && Math.abs(z0 - pz) < 1e-9;
      for (const [x, z, first2] of [[x0, z0, 1], [x1, z1, 0]] as [number, number, number][]) {
        if (first2 && cont) continue;
        const ex = eye[0] - x, ey = eye[1] - yc, ez = eye[2] - z;
        const dist = Math.hypot(ex, ey, ez);
        let sx = -tz * ey, sy = tz * ex - tx * ez, sz = tx * ey;
        const sl = Math.hypot(sx, sy, sz) || 1;
        sx /= sl; sy /= sl; sz /= sl;
        const rd = Math.max(r, 0.75 * dist * v.pxScale);
        put(x, yc, z, sx, sy, sz, r * (1 - sink * 0.5), rd);
        if (!first2 || cont) link();
      }
      px = x1;
      pz = z1;
    }
    return { data: d, index: idx, floats: vtx * F, count: ic };
  }

  /** The thread's shadow on the surface: an amber-tinted line with a bright focus down its middle. */
  private shadowRibbon(): Ribbon {
    const th = this.thread, n = th.n, L = LIGHT, liq = this.liquid;
    const F = 7;
    const maxV = n * 5 + 5;
    if (this.shadowBuf.data.length < maxV * F) {
      this.shadowBuf.data = new Float32Array(maxV * F * 2);
      this.shadowBuf.index = new Uint32Array(maxV * 24 * 2);
    }
    const d = this.shadowBuf.data, idx = this.shadowBuf.index;
    let vtx = 0, ic = 0, prev = -1;
    const px = new Float64Array(3);
    for (let i = 0; i < n; i++) {
      if (th.kind[i] === STUCK || (i > 0 && th.cut[i - 1] && (i === n - 1 || th.cut[i]))) {
        prev = -1;
        continue;
      }
      // March the point down the light direction onto the surface (two refinements).
      let sy = this.host.surface(th.x[i], th.z[i]);
      for (let it = 0; it < 2; it++) {
        const k = (th.y[i] - sy) / L[1];
        px[0] = th.x[i] - L[0] * k;
        px[2] = th.z[i] - L[2] * k;
        sy = this.host.surface(px[0], px[2]);
      }
      const hgt = Math.max(0, th.y[i] - sy);
      px[1] = sy + 0.0002;
      const r = th.nodeRadius(i);
      const blur = 0.035 * hgt;
      const hw = r * 1.1 + blur;
      const k = Math.min(0.5, (0.5 * r) / hw) * (0.55 + 0.45 * liq.cloud);
      const T0 = Math.exp(-liq.absorb[0] * 2000 * r), T1 = Math.exp(-liq.absorb[1] * 2000 * r), T2 = Math.exp(-liq.absorb[2] * 2000 * r);
      const focus = 0.9 * (1 - liq.cloud) * Math.min(1, (r / hw) * 1.4);
      // Across direction: perpendicular to the shadow's own direction on the ground.
      const j = i < n - 1 && !th.cut[i] ? i + 1 : i - 1;
      let gx = th.x[j] - th.x[i], gz = th.z[j] - th.z[i];
      const gl = Math.hypot(gx, gz);
      if (gl < 1e-7) {
        gx = 1;
        gz = 0;
      } else {
        gx /= gl;
        gz /= gl;
      }
      const cx = -gz, cz = gx;
      for (let q = 0; q < 5; q++) {
        const o = vtx * F;
        d[o] = px[0] + cx * hw * ACROSS[q];
        d[o + 1] = px[1];
        d[o + 2] = px[2] + cz * hw * ACROSS[q];
        const edge = q === 0 || q === 4;
        const mid = q === 2;
        const f = mid ? 1 + focus : 0.35;
        d[o + 3] = T0 * f; d[o + 4] = T1 * f; d[o + 5] = T2 * f;
        d[o + 6] = edge ? 0 : k;
        vtx++;
      }
      if (prev >= 0) {
        for (let q = 0; q < 4; q++) {
          const a = prev + q, b = prev + q + 1, c = vtx - 5 + q, e = vtx - 5 + q + 1;
          idx[ic++] = a; idx[ic++] = c; idx[ic++] = b;
          idx[ic++] = b; idx[ic++] = c; idx[ic++] = e;
        }
      }
      prev = vtx - 5;
      if (i < n - 1 && th.cut[i]) prev = -1;
    }
    return { data: d, index: idx, floats: vtx * F, count: ic };
  }

  /** Soft shadow of the dipper's head on the surface. */
  private blobQuad(): Ribbon {
    const p = this.pose, L = LIGHT;
    const c: Vec3 = [p.origin[0] + p.ax[0] * HEAD_LEN * 0.5, p.origin[1] + p.ax[1] * HEAD_LEN * 0.5, p.origin[2] + p.ax[2] * HEAD_LEN * 0.5];
    let sy = this.host.surface(c[0], c[2]);
    let gx = c[0], gz = c[2];
    for (let it = 0; it < 2; it++) {
      const k = (c[1] - sy) / L[1];
      gx = c[0] - L[0] * k;
      gz = c[2] - L[2] * k;
      sy = this.host.surface(gx, gz);
    }
    const hgt = Math.max(0.001, c[1] - sy);
    const blur = 0.3 * hgt;
    const ux = p.ax[0], uz = p.ax[2], ul = Math.hypot(ux, uz) || 1;
    const a1 = HEAD_LEN * 0.55 + blur, a2 = HEAD_R + blur;
    const strength = 0.5 * Math.min(1, (HEAD_R * 2.2) / (HEAD_R + blur));
    const d = this.blobData;
    CORNERS.forEach(([s, t], q) => {
      const o = q * 7;
      d[o] = gx + (ux / ul) * a1 * s - (uz / ul) * a2 * t;
      d[o + 1] = sy + 0.0003;
      d[o + 2] = gz + (uz / ul) * a1 * s + (ux / ul) * a2 * t;
      d[o + 3] = s;
      d[o + 4] = t;
      d[o + 5] = strength;
      d[o + 6] = 0;
    });
    return { data: d, index: BLOB_INDEX, floats: 28, count: 6 };
  }

  private sound(moving: number) {
    const ctx = this.ctx, th = this.thread;
    const c = th.contact();
    // Sticky patter where the coils land: pulses at the coiling rate, deeper for a thicker thread.
    const flux = Math.min(1, this.landRate / 900);
    const level = th.Q > 0 ? Math.min(1, Math.sqrt(flux)) * 0.55 : 0;
    const rate = Math.max(5, Math.min(45, this.coilHz > 0.5 && moving < 0.02 ? this.coilHz * 2 : 8 + moving * 120));
    const f = 260 + 380 * Math.max(0, 1 - c.a1 / 0.0012);
    this.slip.set(level, rate, f, Math.max(-1, Math.min(1, this.noz[0] * 12)));
    this.pour.set(th.Q > 0 ? Math.min(1, th.Q / 6e-7) * 0.12 : 0, 0.15);
    if (level > 0.02 && ctx.pointers.active.size) ctx.hapticLevel(0.06 + 0.3 * level, 0.12);
    // Dunking the dipper into the pile.
    const into = this.noz[1] - this.surfaceUnderNozzle() < 0.0035 && this.pool.depth(this.noz[0] - this.offset[0], this.noz[2] - this.offset[1]) > 0.0003;
    if (into && !this.dipped) {
      ctx.sound.play('squish', { gain: 0.35, pitch: 0.8 });
      ctx.haptic('light');
    }
    this.dipped = into;
  }

  private devState() {
    const th = this.thread;
    let free = 0, stuck = 0, noz = 0, cuts = 0;
    for (let i = 0; i < th.n; i++) {
      if (th.kind[i] === FREE) free++;
      else if (th.kind[i] === STUCK) stuck++;
      else if (th.kind[i] === NOZZLE) noz++;
      if (i < th.n - 1 && th.cut[i]) cuts++;
    }
    const c = th.contact();
    return {
      liquid: this.liquid.id,
      mu: this.tune.mu,
      nozzle: this.noz.map((x) => +(x * 100).toFixed(2)),
      heightCm: +((this.noz[1] - this.surfaceUnderNozzle()) * 100).toFixed(2),
      load: +this.load.toFixed(3),
      Q_mLs: +(th.Q * 1e6).toFixed(3),
      nodes: { n: th.n, free, stuck, noz, cuts },
      substeps: th.substeps,
      coilHz: +this.coilHz.toFixed(2),
      landRate: Math.round(this.landRate),
      drips: this.drips,
      U1: +c.U1.toFixed(3),
      a1mm: +(c.a1 * 1000).toFixed(3),
      pool: { volume_mL: +(this.pool.volume * 1e6).toFixed(3), peakMm: +(this.pool.peak * 1000).toFixed(2) },
      offset: this.offset.map((x) => +(x * 100).toFixed(2)),
      perf: { simMs: +this.perf.sim.toFixed(2), poolMs: +this.perf.pool.toFixed(2), drawMs: +this.perf.draw.toFixed(2) },
      simTime: +this.simT.toFixed(2),
    };
  }

  resize(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.view.resize(width, height);
  }

  destroy() {
    this.slip.stop();
    this.pour.stop();
    this.view.destroy();
    this.hint.remove();
    this.dock.remove();
    this.readout.remove();
    this.style.remove();
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      delete w.__honey;
      delete w.__honeyDev;
    }
  }
}

function wrapAngle(a: number) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

/** Ray hit on the vertical plane z = z0 (facing the camera). */
function hitZ(r: { o: Vec3; d: Vec3 }, z0: number): Vec3 {
  const t = Math.abs(r.d[2]) > 1e-6 ? (z0 - r.o[2]) / r.d[2] : 0;
  return [r.o[0] + r.d[0] * t, r.o[1] + r.d[1] * t, z0];
}

/** Ray hit on the horizontal plane y = y0. */
function hitY(r: { o: Vec3; d: Vec3 }, y0: number): Vec3 {
  const t = Math.abs(r.d[1]) > 1e-6 ? (y0 - r.o[1]) / r.d[1] : 0;
  return [r.o[0] + r.d[0] * t, y0, r.o[2] + r.d[2] * t];
}

const STYLE = `
.hon-hint { position: absolute; left: 50%; bottom: calc(122px + env(safe-area-inset-bottom)); transform: translateX(-50%); padding: 7px 14px; border-radius: 999px; background: rgba(28, 18, 10, 0.62); color: #f4e4c6; font: 600 14px/1 ui-rounded, system-ui, sans-serif; opacity: 0; transition: opacity .3s; pointer-events: none; white-space: nowrap; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.hon-hint.show { opacity: 1; }
.hon-readout { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(80px + env(safe-area-inset-bottom)); padding: 5px 12px; border-radius: 999px; background: rgba(28, 18, 10, 0.55); pointer-events: none; color: #f3e2c2; font: 600 13px/1.2 ui-rounded, system-ui, sans-serif; letter-spacing: .03em; font-variant-numeric: tabular-nums; white-space: nowrap; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.hon-dock { position: absolute; left: 50%; bottom: calc(22px + env(safe-area-inset-bottom)); transform: translateX(-50%); width: min(420px, calc(100% - 32px)); display: flex; gap: 8px; align-items: center; pointer-events: none; }
.hon-chips { display: flex; gap: 5px; flex: 1; min-width: 0; overflow-x: auto; scrollbar-width: none; }
.hon-chip, .hon-dip { pointer-events: auto; flex: none; padding: 9px 10px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(38, 26, 16, 0.78); color: #f1e2c4; font: 600 13px/1 ui-rounded, system-ui, sans-serif; }
.hon-chip { display: inline-flex; align-items: center; gap: 5px; }
.hon-chip::before { content: ''; width: 9px; height: 9px; border-radius: 50%; background: var(--c); box-shadow: inset 0 -2px 3px rgba(0,0,0,.25); }
.hon-chip[aria-pressed="true"] { background: rgba(120, 76, 24, 0.9); border-color: rgba(255, 210, 140, 0.5); }
.hon-dip { position: relative; overflow: hidden; padding: 10px 16px; background: rgba(150, 92, 22, 0.9); }
.hon-load { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: #ffd27a; transform-origin: left; }
.hon-chip:active, .hon-dip:active { transform: scale(.96); }
`;
