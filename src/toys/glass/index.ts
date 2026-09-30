import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop } from '../../shell/sound';
import { GlassAudio } from './audio';
import { SHAPES, makeGlass, profile, strain, waterRatio, STRAIN_LIMIT, type Glass, type ShapeId } from './glass';
import { shatter, type Shard } from './shatter';
import { DRY, RimSim, SR, WET, type Friction } from './sim';
import { WaterSurface } from './water';

export const glassToy: Toy = {
  id: 'glass',
  title: 'Singing Glass',
  blurb:
    'Dip a finger in the water and circle the rim. At the right speed and pressure the friction locks onto the glass’s own mode and the note swells; too slow, too fast or a dry finger just squeaks. Pour water to lower the pitch, watch the surface shiver and spray, and sing its note into the mic to shatter it.',
  tech: 'Stick-slip fingertip (velocity-weakening friction, implicit stick/slip solve) coupled to the (2,0) and (3,0) bending-mode doublets, integrated at 24 kHz and streamed as the sound · French’s water-loading law for pitch · driven-oscillator voice resonance with strain fatigue · Voronoi shatter · Canvas 2D',
  swatch: 'radial-gradient(ellipse at 50% 30%,#f4f8ff 0 6%,#9ec9e6 16%,#3a5a78 38%,#1a1418 70%)',
  refs: [
    {
      short: 'French 1983',
      title: 'In Vino Veritas: A study of wineglass acoustics (A. P. French, Am. J. Phys. 51, 688, 1983)',
      url: 'https://doi.org/10.1119/1.13147',
      use: 'The empty glass’s (2,0) frequency from wall thickness, radius and height, and how water lowers it: (f0/fh)² = 1 + (α/5)(ρl R / ρg a)(h/H)⁴, applied as extra modal mass.',
    },
    {
      short: 'McIntyre 1983',
      title: 'On the oscillations of musical instruments (McIntyre, Schumacher & Woodhouse, JASA 74, 1325, 1983)',
      url: 'https://doi.org/10.1121/1.390157',
      use: 'The bowed-resonator scheme: a nonlinear friction law at one contact point, solved each sample against the resonator’s response, with a friction curve falling from static to kinetic.',
    },
    {
      short: 'Mertz 2025',
      title: 'A stick slip model of the singing wineglass (Mertz, Orzolek & Jonson, JASA 157(4 Suppl.), A204, 2025; meeting abstract)',
      url: 'https://doi.org/10.1121/10.0037898',
      use: 'The single-mode stability criterion the lock-in rests on: damping versus normal load times the slope of friction with sliding speed.',
    },
    {
      short: 'Terwagne & Bush 2011',
      title: 'Tibetan singing bowls (Terwagne & Bush, Nonlinearity 24, R51, 2011; arXiv:1106.6348)',
      url: 'https://arxiv.org/abs/1106.6348',
      use: 'One node follows the rubbing point; edge Faraday waves at half the forcing frequency near the antinodes, then droplets from surface fracture as the forcing grows. Also the form of French’s law used here (α ≈ 1.25).',
    },
  ],
  async create(ctx) {
    return new SingingGlass(ctx);
  },
};

/** Ellipse squash of the view (rim seen from a little above). */
const K = 0.3;
/** Displayed wobble rate, Hz: the real 300–900 Hz shown slowed. */
const VIS_HZ = 4.5;
const NP = 30;
const BLOCK = 48;
const Q_EMPTY = 600;
/** Fatigue: strain above this fraction of the limit grows micro-cracks. */
const FATIGUE = 0.55;
const RESPAWN = 3.4;
const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];

interface Drop {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  life: number;
  /** Surface y it lands back on, or the table. */
  floor: number;
  spray: boolean;
}

interface Finger {
  id: number;
  mode: 'rub' | 'jug' | 'pipette' | 'tap' | 'none';
  phi: number;
  /** Unwrapped contact angle last frame (for the sub-block sweep). */
  phiPrev: number;
  vb: number;
  settle: number;
  onRim: boolean;
  downX: number;
  downY: number;
  moved: number;
  downT: number;
  x: number;
  y: number;
}

class SingingGlass implements ToyInstance {
  private g: CanvasRenderingContext2D;
  private bg: HTMLCanvasElement;
  private sprite: HTMLCanvasElement;
  private W = 1;
  private H = 1;
  private pr = 1;
  private tune = { shape: 'wine' as ShapeId, size: 1, water: 0.35, press: 1 };
  private glass: Glass;
  private fill = 0.35;
  private sim = new RimSim();
  private audio: GlassAudio;
  private bufL = new Float32Array(SR / 5);
  private bufR = new Float32Array(SR / 5);
  private lastGen = performance.now();
  private carry = 0;
  private water = new WaterSurface();
  // Layout, CSS px.
  private S = 2000;
  private cx = 0;
  private tableY = 0;
  private bowlBottom = 0;
  private rimY = 0;
  private Rpx = 1;
  private Hpx = 1;
  private ys = new Float32Array(NP);
  private rs = new Float32Array(NP);
  // Interaction.
  private fingers = new Map<number, Finger>();
  private rubId = -1;
  private wet = 0.12;
  private N = 0;
  private jug = 0;
  private pipette = 0;
  private pouring = false;
  private sipping = false;
  // Sim readouts.
  private amp = 0;
  private lock = 0;
  private stick = 0;
  private z = new Float64Array(4);
  private zn = new Float64Array(4);
  private visPhase = 0;
  private match = 0;
  private shimmer = 0;
  private cents = Infinity;
  private voiceF = 0;
  private damage = 0;
  private crackTicks = 0;
  private cracks: number[][] = [];
  // Break and respawn.
  private broken = false;
  private brokenT = 0;
  private appear = 1;
  private shards: Shard[] = [];
  private drops: Drop[] = [];
  private puddle = { r: 0, a: 0 };
  private tinkleAt = 0;
  private sprayAcc = 0;
  private hint: HTMLElement;
  private style: HTMLStyleElement;
  private hintState = 0;
  private hintT = 0;
  private trickle: Loop;
  private sipLoop: Loop;
  private faraday = 0;
  private frameNo = 0;
  private dev = { log: [] as { t: number; vb: number; N: number; amp: number; lock: number; stick: number; wet: number; f: number; match: number; voice: number; D: number }[], breaks: 0, maxAmp: 0, perf: { sim: 0, fx: 0, draw: 0 } };

  constructor(private ctx: ToyContext) {
    const g = ctx.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('Canvas 2D is not available.');
    this.g = g;
    this.bg = document.createElement('canvas');
    this.sprite = glint(64);
    this.glass = makeGlass(this.tune.shape, this.tune.size);
    this.fill = this.tune.water;
    this.audio = new GlassAudio(SR, ctx.canvas);
    this.trickle = ctx.sound.loop('trickle');
    this.sipLoop = ctx.sound.loop('bubble');
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'gls-hint';
    ctx.overlay.append(this.hint);
    ctx.mic.offer('Sing the glass’s note', { echoCancel: true });
    ctx.panel.choice(
      'Glass',
      (Object.keys(SHAPES) as ShapeId[]).map((k) => ({ value: k, label: SHAPES[k].label })),
      this.tune.shape,
      (v) => {
        this.tune.shape = v;
        this.newGlass();
      },
    );
    ctx.panel.slider(this.tune, 'size', { label: 'Size', min: 0.85, max: 1.2, step: 0.01, onChange: () => this.reshape() });
    ctx.panel.slider(this.tune, 'water', { label: 'Water', min: 0, max: 0.85, step: 0.01 });
    ctx.panel.slider(this.tune, 'press', { label: 'Finger pressure', min: 0.5, max: 1.6, step: 0.05 });
    ctx.panel.action('New glass', () => this.newGlass());
    this.W = ctx.canvas.width / ctx.pixelRatio;
    this.H = ctx.canvas.height / ctx.pixelRatio;
    this.pr = ctx.pixelRatio;
    this.layout();
    this.setModes();
    this.newCracks();
    this.showHint('Dip a finger in the water, then circle the rim');
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__glass = () => ({
        f: this.freq(),
        f0: this.glass.f0,
        fill: this.fill,
        amp: this.amp,
        ampRatio: this.amp / this.glass.breakAmp,
        strain: strain(this.glass, this.amp) / STRAIN_LIMIT,
        lock: this.lock,
        stick: this.stick,
        wet: this.wet,
        N: this.N,
        vb: this.fingers.get(this.rubId)?.vb ?? 0,
        match: this.match,
        cents: this.cents,
        voiceF: this.voiceF,
        damage: this.damage,
        broken: this.broken,
        breaks: this.dev.breaks,
        maxAmp: this.dev.maxAmp,
        perf: this.dev.perf,
        mic: { active: ctx.mic.active, pitch: ctx.mic.pitch, level: ctx.mic.level },
        audio: this.audio.live,
        rim: { cx: this.cx, rimY: this.rimY, R: this.Rpx, K, W: this.W, H: this.H, waterY: this.waterY(), waterR: this.waterR() },
        log: this.dev.log.slice(-600),
      });
      w.__glassDev = {
        wet: (v: number) => (this.wet = v),
        fill: (v: number) => {
          this.fill = this.tune.water = v;
          this.setModes();
        },
        clearLog: () => ((this.dev.log.length = 0), (this.dev.maxAmp = 0)),
      };
    }
  }

  // ---------------------------------------------------------------- glass state

  private freq() {
    return this.glass.f0 * waterRatio(this.glass, this.fill);
  }

  private q() {
    return Q_EMPTY / (1 + 0.8 * this.fill);
  }

  private setModes() {
    const r = waterRatio(this.glass, this.fill);
    this.sim.setModes({ f: this.glass.f0 * r, r3: this.glass.r3, M: this.glass.M0 / (r * r), Q: this.q(), split: this.glass.split });
  }

  private newGlass() {
    this.glass = makeGlass(this.tune.shape, this.tune.size);
    this.fill = this.tune.water;
    this.sim.reset();
    this.damage = 0;
    this.crackTicks = 0;
    this.broken = false;
    this.appear = 0;
    this.layout();
    this.setModes();
    this.newCracks();
  }

  /** Size slider: reshape the same glass live, so a ringing note glides. */
  private reshape() {
    const split = this.glass.split;
    this.glass = makeGlass(this.tune.shape, this.tune.size);
    this.glass.split = split;
    this.layout();
    this.setModes();
  }

  private newCracks() {
    // Where fatigue shows first: near the front antinode of the voice-driven orientation.
    this.cracks = [];
    for (let c = 0; c < 4; c++) {
      const pts: number[] = [];
      let th = Math.PI / 2 + (Math.random() - 0.5) * 0.9;
      let t = 1;
      pts.push(th, t);
      for (let s = 0; s < 9; s++) {
        th += (Math.random() - 0.5) * 0.12;
        t -= 0.05 + Math.random() * 0.05;
        pts.push(th, t);
      }
      this.cracks.push(pts);
    }
  }

  // ---------------------------------------------------------------- layout

  private layout() {
    const W = this.W, H = this.H;
    this.S = Math.min((W * 0.74) / (2 * 0.0565), (H * 0.6) / 0.25);
    this.cx = W / 2;
    this.tableY = H * 0.82;
    const gl = this.glass;
    const stem = gl.def.stem * gl.size * this.S;
    this.bowlBottom = this.tableY - 0.006 * this.S - stem;
    this.Hpx = gl.H * this.S;
    this.rimY = this.bowlBottom - this.Hpx;
    this.Rpx = gl.R * this.S;
    for (let i = 0; i < NP; i++) {
      const t = i / (NP - 1);
      this.ys[i] = this.bowlBottom - t * this.Hpx;
      this.rs[i] = this.Rpx * profile(gl.def, t);
    }
  }

  private waterY() {
    return this.bowlBottom - this.fill * this.Hpx;
  }

  private waterR() {
    return this.Rpx * profile(this.glass.def, this.fill);
  }

  resize(width: number, height: number) {
    this.pr = this.ctx.pixelRatio;
    this.W = width / this.pr;
    this.H = height / this.pr;
    this.layout();
    this.paintBackground(width, height);
  }

  private paintBackground(width: number, height: number) {
    const c = this.bg;
    c.width = width;
    c.height = height;
    const g = c.getContext('2d')!;
    const W = this.W, H = this.H, pr = this.pr;
    g.setTransform(pr, 0, 0, pr, 0, 0);
    const sky = g.createLinearGradient(0, 0, 0, H);
    sky.addColorStop(0, '#221a1b');
    sky.addColorStop(0.62, '#120e12');
    sky.addColorStop(1, '#0a0809');
    g.fillStyle = sky;
    g.fillRect(0, 0, W, H);
    // Out-of-focus room lights: what the glass and the water refract and reflect.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const tints = ['255,176,96', '255,120,90', '110,200,220', '255,220,160', '160,140,255'];
    for (let i = 0; i < 16; i++) {
      const x = rnd() * W, y = H * (0.06 + rnd() * 0.5), r = 20 + rnd() * 60;
      const grd = g.createRadialGradient(x, y, 0, x, y, r);
      const t = tints[i % tints.length];
      const a = 0.08 + rnd() * 0.16;
      grd.addColorStop(0, `rgba(${t},${a})`);
      grd.addColorStop(0.7, `rgba(${t},${a * 0.7})`);
      grd.addColorStop(1, `rgba(${t},0)`);
      g.fillStyle = grd;
      g.fillRect(x - r, y - r, 2 * r, 2 * r);
    }
    // Table.
    const top = H * 0.66;
    const tb = g.createLinearGradient(0, top, 0, H);
    tb.addColorStop(0, '#2c1f18');
    tb.addColorStop(0.3, '#1f1510');
    tb.addColorStop(1, '#0d0907');
    g.fillStyle = tb;
    g.fillRect(0, top, W, H - top);
    g.fillStyle = 'rgba(255,200,150,0.08)';
    g.fillRect(0, top, W, 1.5);
    for (let i = 0; i < 26; i++) {
      g.fillStyle = `rgba(0,0,0,${0.05 + rnd() * 0.08})`;
      g.fillRect(0, top + (H - top) * rnd(), W, 0.7 + rnd());
    }
  }

  // ---------------------------------------------------------------- input

  private toPx(p: { x: number; y: number }) {
    return [p.x * this.W, (1 - p.y) * this.H];
  }

  /** Rim-relative polar coords of a screen point: contact angle and signed distance from the rim, px. */
  private rimPolar(x: number, y: number) {
    const ex = (x - this.cx) / this.Rpx, ey = (y - this.rimY) / (K * this.Rpx);
    const phi = Math.atan2(ey, ex);
    const rho = Math.hypot(ex, ey);
    const local = this.Rpx * Math.hypot(Math.cos(phi), K * Math.sin(phi));
    return { phi, d: (rho - 1) * local };
  }

  private jugRest() {
    return { x: this.cx - this.Rpx - 62, y: this.tableY - 4 };
  }

  private pipetteRest() {
    return { x: this.cx + this.Rpx + 58, y: this.tableY - 4 };
  }

  private hitJug(x: number, y: number) {
    const j = this.jugRest();
    return Math.abs(x - j.x) < 40 && y > j.y - 90 && y < j.y + 10;
  }

  private hitPipette(x: number, y: number) {
    const p = this.pipetteRest();
    return Math.abs(x - p.x) < 26 && y > p.y - 120 && y < p.y + 10;
  }

  private inBowl(x: number, y: number) {
    if (y < this.rimY - K * this.Rpx || y > this.bowlBottom + 6) return false;
    const t = (this.bowlBottom - y) / this.Hpx;
    return Math.abs(x - this.cx) < this.Rpx * profile(this.glass.def, t) + 4;
  }

  private inWater(x: number, y: number) {
    if (this.fill < 0.03) return false;
    const wy = this.waterY(), wr = this.waterR();
    const ex = (x - this.cx) / wr, ey = (y - wy) / (K * wr);
    if (ex * ex + ey * ey < 1.15) return true;
    return y > wy && this.inBowl(x, y);
  }

  private input(dt: number) {
    const live = new Set<number>();
    for (const p of this.ctx.pointers.active.values()) {
      live.add(p.id);
      const [x, y] = this.toPx(p);
      let f = this.fingers.get(p.id);
      if (!f) {
        if (!p.down) continue;
        f = { id: p.id, mode: 'none', phi: 0, phiPrev: 0, vb: 0, settle: 0, onRim: false, downX: x, downY: y, moved: 0, downT: performance.now(), x, y };
        const rp = this.rimPolar(x, y);
        if (!this.broken && Math.abs(rp.d) < 36 && this.rubId < 0) {
          f.mode = 'rub';
          f.phi = f.phiPrev = rp.phi;
          this.rubId = p.id;
          this.sim.touch();
        } else if (this.hitJug(x, y)) f.mode = 'jug';
        else if (this.hitPipette(x, y)) f.mode = 'pipette';
        else if (!this.broken && this.inWater(x, y)) {
          f.mode = 'tap';
          this.dip(x, y);
        } else if (!this.broken && this.inBowl(x, y)) f.mode = 'tap';
        this.fingers.set(p.id, f);
      }
      f.moved += Math.hypot(x - f.x, y - f.y);
      f.x = x;
      f.y = y;
      if (f.mode === 'rub') this.rub(f, x, y, dt);
    }
    for (const [id, f] of this.fingers) {
      if (live.has(id)) continue;
      // A quick tap on the glass (not the water) strikes it: a ting at the current pitch.
      const quick = f.moved < 10 && performance.now() - f.downT < 300;
      if (quick && (f.mode === 'rub' || (f.mode === 'tap' && !this.inWater(f.downX, f.downY) && this.inBowl(f.downX, f.downY)))) this.strike(f.downX, f.downY);
      if (id === this.rubId) this.rubId = -1;
      this.fingers.delete(id);
    }
  }

  private rub(f: Finger, x: number, y: number, dt: number) {
    const rp = this.rimPolar(x, y);
    f.onRim = Math.abs(rp.d) < 44;
    // Unwrap so the sweep between frames goes the short way round.
    let d = rp.phi - (f.phi % (2 * Math.PI));
    d = Math.atan2(Math.sin(d), Math.cos(d));
    f.phiPrev = f.phi;
    f.phi += d;
    // Finger speed along the real rim: the parametric angle of the projected ellipse is the true angle.
    const vb = dt > 0 ? (d * this.glass.R) / dt : 0;
    f.vb += (vb - f.vb) * (1 - Math.exp(-dt / 0.05));
    // Pressure proxy: the pad settles in as you dwell on the rim; hugging inside the rim line presses
    // harder, drifting outside skims.
    f.settle = f.onRim ? Math.min(1, f.settle + dt / 0.35) : Math.max(0, f.settle - dt / 0.08);
    const lean = Math.max(0.35, Math.min(2, 1 - rp.d / 26));
    const target = f.onRim ? 2.4 * this.tune.press * lean * (0.3 + 0.7 * f.settle) : 0;
    this.N += (target - this.N) * (1 - Math.exp(-dt / 0.04));
  }

  private dip(x: number, y: number) {
    this.wet = 1;
    const wr = this.waterR();
    const u = Math.max(-0.9, Math.min(0.9, (x - this.cx) / wr)), v = Math.max(-0.9, Math.min(0.9, (y - this.waterY()) / (K * wr)));
    this.water.rings.push({ u, v, age: 0, amp: 0.8 });
    this.ctx.sound.play('plop', { gain: 0.35, pitch: 1.3 });
    this.ctx.haptic('light');
    if (this.hintState === 0) this.showHint('Now circle the rim, not too fast', 1);
  }

  private strike(x: number, y: number) {
    const ex = (x - this.cx) / this.Rpx;
    const theta = Math.acos(Math.max(-1, Math.min(1, ex))) * (y > this.rimY ? 1 : -1);
    this.sim.strike(theta, 0.004);
    this.ctx.sound.play('tick', { gain: 0.25, pitch: 1.8 });
    this.ctx.haptic('light');
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    const t0 = performance.now();
    this.input(dt);
    this.updateWater(dt);
    this.voice(dt);
    this.integrate();
    this.fatigue(dt);
    const t1 = performance.now();
    this.effects(dt, t);
    const t2 = performance.now();
    this.draw(t);
    this.feel();
    this.status();
    if (import.meta.env.DEV) {
      const p = this.dev.perf, t3 = performance.now();
      p.sim += (t1 - t0 - p.sim) * 0.05;
      p.fx += (t2 - t1 - p.fx) * 0.05;
      p.draw += (t3 - t2 - p.draw) * 0.05;
    }
  }

  private updateWater(dt: number) {
    let pour = false, sip = false;
    for (const f of this.fingers.values()) {
      if (f.mode === 'jug') pour = true;
      if (f.mode === 'pipette') sip = true;
    }
    this.jug += ((pour ? 1 : 0) - this.jug) * (1 - Math.exp(-dt / 0.15));
    this.pipette += ((sip ? 1 : 0) - this.pipette) * (1 - Math.exp(-dt / 0.15));
    this.pouring = !this.broken && this.jug > 0.75 && this.fill < 0.88;
    this.sipping = !this.broken && this.pipette > 0.8 && this.fill > 0.005;
    const old = this.fill;
    if (this.pouring) this.fill = Math.min(0.88, this.fill + 0.07 * dt);
    if (this.sipping) this.fill = Math.max(0, this.fill - 0.06 * dt);
    if (this.pouring || this.sipping) this.tune.water = this.fill;
    else if (!this.broken && Math.abs(this.tune.water - this.fill) > 0.002) this.fill += Math.sign(this.tune.water - this.fill) * Math.min(Math.abs(this.tune.water - this.fill), 0.25 * dt);
    if (this.fill !== old) this.setModes();
    this.trickle.set(this.pouring ? 0.55 : 0, 0.55 + this.fill * 0.3);
    this.sipLoop.set(this.sipping ? 0.3 : 0, 0.4);
    if (this.pouring && Math.random() < dt * 14) {
      this.water.rings.push({ u: -0.35 + Math.random() * 0.15, v: (Math.random() - 0.5) * 0.3, age: 0, amp: 0.5 });
      if (Math.random() < 0.4) this.ctx.sound.bubble(0.0015 + Math.random() * 0.003, { gain: 0.3, pan: -0.2 });
    }
    // Wetness: evaporates slowly, and rubbing wipes it onto the rim faster.
    const rubbing = this.rubId >= 0 && this.N > 0.05;
    this.wet = Math.max(0, this.wet - dt * this.wet * (rubbing ? 1 / 22 : 1 / 60));
  }

  private voice(dt: number) {
    const mic = this.ctx.mic;
    const f = this.freq(), Q = this.q();
    let best = 0, cents = Infinity;
    if (mic.active && mic.pitch > 0) {
      // The shell reads pitch as (rate/4)/lag: at 500 Hz one lag step is ~20 Hz, far wider than
      // the glass's bandwidth f/Q. Any sung note whose reading is consistent with the mode within
      // that resolution counts as on it; outside it, the driven response falls off as 1/√(1+x²).
      const p = mic.pitch;
      const W = [1, 0.6, 0.35];
      for (let k = 1; k <= 3; k++) {
        const fk = k * p;
        const tol = Math.max(f / (2 * Q), (k * p * p) / (2 * 12000) + 0.004 * f);
        const x = Math.max(0, Math.abs(fk - f) / tol - 1);
        best = Math.max(best, W[k - 1] / Math.sqrt(1 + x * x * 16));
        cents = Math.min(cents, Math.abs(1200 * Math.log2(fk / f)));
      }
    }
    this.cents = cents;
    this.match += (best - this.match) * (1 - Math.exp(-dt / 0.08));
    // Loudness in dB above the room maps to sound pressure; the force is scaled per glass so a loud
    // (level ~1) held note on pitch drives the wall to ~85% of its strain limit.
    const w = 2 * Math.PI * f;
    const M = this.glass.M0 / waterRatio(this.glass, this.fill) ** 2;
    const Fref = (0.85 * this.glass.breakAmp * M * w * w) / Q;
    const lvl = mic.active ? mic.level : 0;
    this.voiceF = !this.broken && lvl > 0.05 ? Fref * Math.pow(10, 1.5 * (lvl - 1)) * this.match : 0;
    this.sim.voice = this.voiceF;
    const near = mic.active && mic.pitch > 0 ? lvl * Math.exp(-((cents / 110) ** 2)) : 0;
    this.shimmer += (near - this.shimmer) * (1 - Math.exp(-dt / (near > this.shimmer ? 0.1 : 0.5)));
  }

  /** Integrate the rim for the wall-clock time since the last frame and stream the samples. */
  private integrate() {
    const now = performance.now();
    const want = Math.min(this.bufL.length, (now - this.lastGen) * 0.001 * SR + this.carry);
    this.lastGen = now;
    const n = Math.max(0, Math.floor(want));
    this.carry = Math.min(1, want - n);
    const sim = this.sim;
    const f = this.fingers.get(this.rubId);
    const rubbing = !!f && !this.broken;
    const blend = Math.pow(this.wet, 0.7);
    const fr: Friction = {
      us: DRY.us + (WET.us - DRY.us) * blend,
      ud: DRY.ud + (WET.ud - DRY.ud) * blend,
      v0: DRY.v0 + (WET.v0 - DRY.v0) * blend,
      rough: DRY.rough + (WET.rough - DRY.rough) * blend,
      // The oil film only matters on a properly dry finger; any water floods it.
      visc: WET.visc + (DRY.visc - WET.visc) * (1 - this.wet) ** 3,
    };
    sim.fr = fr;
    if (!rubbing) this.N = Math.max(0, this.N - 0.2);
    sim.vb = rubbing ? f.vb : 0;
    const blocks = Math.ceil(n / BLOCK);
    let slips = 0, stick = 0;
    for (let b = 0, off = 0; b < blocks; b++) {
      const c = Math.min(BLOCK, n - off);
      if (rubbing) sim.phi = f.phiPrev + (f.phi - f.phiPrev) * ((b + 0.5) / blocks);
      sim.N = rubbing ? this.N : 0;
      sim.run(c, this.bufL, this.bufR, off);
      slips += sim.slips;
      stick += sim.stickFrac * c;
      off += c;
    }
    if (f) f.phiPrev = f.phi;
    // Radiated level: rim velocity (m/s) to a comfortable output, with a little of the contact noise.
    for (let i = 0; i < n; i++) {
      this.bufL[i] *= 0.55;
      this.bufR[i] *= 0.55;
    }
    if (n) this.audio.push(this.bufL.subarray(0, n), this.bufR.subarray(0, n));
    this.amp = this.broken ? 0 : sim.amp2();
    this.dev.maxAmp = Math.max(this.dev.maxAmp, this.amp);
    const periods = (n / SR) * this.freq();
    const p = periods > 0 && rubbing ? slips / periods : 0;
    this.lock += (p - this.lock) * 0.2;
    this.stick = n ? stick / n : 0;
    sim.pattern(this.z);
    const ab = this.glass.breakAmp;
    for (let i = 0; i < 4; i++) this.zn[i] = this.z[i] / ab;
    if (import.meta.env.DEV) {
      this.dev.log.push({ t: now / 1000, vb: rubbing ? f.vb : 0, N: sim.N, amp: this.amp, lock: p, stick: this.stick, wet: this.wet, f: this.freq(), match: this.match, voice: this.voiceF, D: this.damage });
      if (this.dev.log.length > 2400) this.dev.log.splice(0, 600);
    }
  }

  private fatigue(dt: number) {
    if (this.broken) return;
    const e = strain(this.glass, this.amp) / STRAIN_LIMIT;
    if (e > FATIGUE) this.damage = Math.min(1, this.damage + ((e - FATIGUE) / (1 - FATIGUE)) ** 2 * 0.5 * dt);
    // Micro-cracks grow in audible, visible steps.
    const ticks = Math.floor(this.damage / 0.07);
    if (ticks > this.crackTicks) {
      this.crackTicks = ticks;
      this.ctx.sound.crumple(0.5, { stiffness: 1 });
      this.ctx.haptic('light');
    }
    if (e > 1 - 0.4 * this.damage || this.damage >= 1) this.shatter();
  }

  private shatter() {
    this.broken = true;
    this.brokenT = 0;
    this.dev.breaks++;
    const outline = this.outline(0, 0);
    // Break at the most strained point on the front of the rim.
    const th = this.antinode();
    const hx = this.cx + this.Rpx * Math.cos(th), hy = this.rimY + K * this.Rpx * Math.abs(Math.sin(th)) + this.Hpx * 0.15;
    this.shards = shatter(outline, 30, hx, hy, this.cx, this.bowlBottom - this.Hpx * 0.5);
    // The water leaves in a burst.
    const wy = this.waterY();
    const nDrops = Math.round(40 + 160 * this.fill);
    for (let i = 0; i < nDrops && this.fill > 0.02; i++) {
      const t = Math.random() * this.fill;
      const y = this.bowlBottom - t * this.Hpx;
      const r = this.Rpx * profile(this.glass.def, t);
      const x = this.cx + (Math.random() * 2 - 1) * r;
      const out = (x - this.cx) / Math.max(1, r);
      this.drops.push({ x, y: Math.max(y, wy), vx: out * (120 + Math.random() * 260), vy: -80 - Math.random() * 260, r: 0.8 + Math.random() * 1.8, life: 2, floor: this.tableY + Math.random() * 30, spray: false });
    }
    this.puddle = { r: 0, a: Math.min(1, this.fill * 1.6) };
    const snd = this.ctx.sound;
    snd.impact('glass', 0.07, 1);
    snd.impact('glass', 0.03, 0.9, { pan: -0.3 });
    snd.impact('glass', 0.02, 0.8, { pan: 0.3 });
    if (this.fill > 0.02) {
      snd.play('splash', { gain: 0.4 + this.fill * 0.6 });
      snd.bubbles(12, 0.001, 0.005, { gain: 0.5 });
    }
    this.ctx.haptic('heavy');
    this.sim.reset();
    this.sim.voice = 0;
    this.damage = 0;
    this.hideHint();
  }

  private antinode() {
    // Front-facing antinode of the current (2,0) pattern.
    const [a, b, c, d] = this.z;
    let best = Math.PI / 2, bv = -1;
    for (let k = 0; k < 16; k++) {
      const th = (k / 16) * Math.PI;
      const v = Math.hypot(a * Math.cos(2 * th) + c * Math.sin(2 * th), b * Math.cos(2 * th) + d * Math.sin(2 * th));
      if (v > bv) [bv, best] = [v, th];
    }
    return best;
  }

  private effects(dt: number, t: number) {
    this.visPhase += 2 * Math.PI * VIS_HZ * dt;
    const mag = this.amp / this.glass.breakAmp;
    // Edge Faraday waves once the wall shakes hard enough; spray above a higher threshold.
    const fTarget = Math.max(0, Math.min(1, (mag - 0.1) / 0.25));
    this.faraday += (fTarget - this.faraday) * (1 - Math.exp(-dt / 0.2));
    if (!this.broken && this.fill > 0.04 && mag > 0.26) {
      this.sprayAcc += dt * (mag - 0.26) * 140;
      const wy = this.waterY(), wr = this.waterR();
      const [a, b, c, d] = this.z;
      const pmax = Math.hypot(a, b, c, d) || 1;
      while (this.sprayAcc > 1) {
        this.sprayAcc -= 1;
        // Droplets leave where the edge moves most: sample the angle by the pattern's strength.
        let th = 0;
        for (let k = 0; k < 8; k++) {
          th = Math.random() * 2 * Math.PI;
          const v = Math.hypot(a * Math.cos(2 * th) + c * Math.sin(2 * th), b * Math.cos(2 * th) + d * Math.sin(2 * th)) / pmax;
          if (Math.random() < v ** 4) break;
        }
        const x = this.cx + wr * 0.9 * Math.cos(th), y = wy + K * wr * 0.9 * Math.sin(th);
        const up = 160 + Math.random() * 380 * Math.min(1.5, mag * 2);
        this.drops.push({ x, y, vx: -Math.cos(th) * 30 * Math.random(), vy: -up, r: 0.8 + Math.random() * 1.6, life: 1.5, floor: y, spray: true });
      }
    }
    this.water.step(dt);
    // The slowed ripples read fine at 30 Hz; alternate frames keep the texture cheap on phones.
    if ((this.frameNo++ & 1) === 0) this.water.update(this.zn, this.visPhase, this.broken ? 0 : this.faraday, [120, 175, 215]);
    const g = 1800;
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const p = this.drops[i];
      p.vy += g * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt;
      if (p.vy > 0 && p.y > p.floor) {
        if (p.spray && !this.broken) {
          const wr = this.waterR();
          const u = (p.x - this.cx) / wr;
          if (Math.abs(u) < 0.95) this.water.rings.push({ u, v: 0.2, age: 0, amp: 0.15 });
          if (Math.random() < 0.15) this.ctx.sound.bubble(0.0008 + Math.random() * 0.0012, { gain: 0.15 });
        }
        this.drops.splice(i, 1);
        continue;
      }
      if (p.life < 0) this.drops.splice(i, 1);
    }
    if (this.broken) {
      this.brokenT += dt;
      this.puddle.r = Math.min(1, this.puddle.r + dt * 2.2);
      for (const s of this.shards) {
        if (s.resting) continue;
        s.vy += g * dt;
        s.x += s.vx * dt;
        s.y += s.vy * dt;
        s.a += s.va * dt;
        const floor = this.tableY + 6 + s.shade * 26;
        if (s.y > floor) {
          s.y = floor;
          const hit = s.vy;
          s.vy *= -0.3;
          s.vx *= 0.55;
          s.va *= 0.5;
          if (hit > 160 && t - this.tinkleAt > 0.03) {
            this.tinkleAt = t;
            this.ctx.sound.impact('glass', Math.max(0.008, (s.size / this.S) * 1.2), Math.min(1, hit / 900) * 0.6, { pan: (s.x / this.W) * 2 - 1 });
          }
          if (Math.abs(s.vy) < 40) {
            s.resting = true;
            s.vy = 0;
          }
        }
      }
      if (this.brokenT > RESPAWN) {
        this.shards = [];
        this.newGlass();
        this.ctx.sound.play('chime', { gain: 0.2, pitch: this.freq() / 700 });
      }
    }
    if (this.appear < 1) this.appear = Math.min(1, this.appear + dt / 0.7);
  }

  private feel() {
    const mag = this.amp / this.glass.breakAmp;
    const rubbing = this.rubId >= 0 && this.N > 0.05;
    if (rubbing) {
      // Locked (one slip per cycle) buzzes crisply; ragged stick-slip rumbles.
      const clean = Math.exp(-((this.lock - 1) ** 2) / 0.05);
      const i = Math.min(1, Math.pow(mag / 0.35, 0.7) + (1 - clean) * this.stick * 0.4);
      this.ctx.hapticLevel(i, 0.3 + 0.6 * clean);
    } else if (mag > 0.08) this.ctx.hapticLevel(Math.min(1, mag * 1.2), 0.85);
  }

  private status() {
    const f = this.freq();
    const midi = 69 + 12 * Math.log2(f / 440);
    const m = Math.round(midi);
    const note = `${NOTES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
    const w = this.wet > 0.55 ? 'wet' : this.wet > 0.25 ? 'damp' : 'dry';
    this.ctx.setStatus(`${note} · ${f.toFixed(0)} Hz · finger ${w}`);
    // Once it has sung, the hint has done its job.
    const singing = (this.rubId >= 0 && this.lock > 0.8) || this.voiceF > 0;
    if (this.hintState < 2 && singing && this.amp / this.glass.breakAmp > 0.12) {
      this.hintState = 2;
      this.hintT = performance.now();
    }
    if (this.hintState === 2 && performance.now() - this.hintT > 1500) {
      this.hintState = 3;
      this.hideHint();
    }
  }

  private showHint(text: string, state = 0) {
    this.hint.textContent = text;
    this.hint.classList.add('show');
    this.hintState = state;
  }

  private hideHint() {
    this.hint.classList.remove('show');
  }

  // ---------------------------------------------------------------- drawing

  /** Displayed radial wall displacement at angle θ on the rim, px (exaggerated, slowed). */
  private wob(th: number) {
    const z = this.zn;
    const mag = Math.hypot(z[0], z[1], z[2], z[3]);
    if (mag < 1e-5) return 0;
    const c = Math.cos(2 * th), s = Math.sin(2 * th);
    const re = z[0] * c + z[2] * s, im = z[1] * c + z[3] * s;
    const k = (this.Rpx * 0.13 * Math.pow(Math.min(1.3, mag), 0.6)) / mag;
    return k * (re * Math.cos(this.visPhase) - im * Math.sin(this.visPhase));
  }

  private rimPt(th: number, w = 1) {
    const r = this.Rpx + this.wob(th) * w;
    return [this.cx + r * Math.cos(th), this.rimY + K * r * Math.sin(th)];
  }

  /** Silhouette: left wall down, right wall up, back rim arc across the top. */
  private outline(uL: number, uR: number) {
    const pts: number[] = [];
    for (let i = NP - 1; i >= 0; i--) {
      const t = i / (NP - 1);
      pts.push(this.cx - this.rs[i] - uL * t * t, this.ys[i]);
    }
    for (let i = 0; i < NP; i++) {
      const t = i / (NP - 1);
      pts.push(this.cx + this.rs[i] + uR * t * t, this.ys[i]);
    }
    for (let k = 1; k < 24; k++) {
      const [x, y] = this.rimPt(-(k / 24) * Math.PI);
      pts.push(x, y);
    }
    return pts;
  }

  private draw(t: number) {
    const g = this.g, pr = this.pr;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.drawImage(this.bg, 0, 0);
    g.setTransform(pr, 0, 0, pr, 0, 0);
    this.drawTable();
    this.drawProps(t);
    if (this.broken) {
      this.drawStem(1);
      this.drawShards();
    } else {
      g.globalAlpha = this.appear;
      this.drawStem(this.appear);
      this.drawGlass(t);
      g.globalAlpha = 1;
    }
    this.drawDrops();
    this.drawStream(t);
  }

  private drawTable() {
    const g = this.g, cx = this.cx, ty = this.tableY, R = this.Rpx;
    // Shadow, and the caustic the water lens throws forward onto the table.
    g.fillStyle = 'rgba(0,0,0,0.35)';
    g.beginPath();
    g.ellipse(cx + 6, ty + 4, R * 0.95, R * K * 0.8, 0, 0, Math.PI * 2);
    g.fill();
    if (!this.broken && this.fill > 0.03) {
      const a = Math.min(0.35, this.fill * 0.5) * this.appear * (1 + this.shimmer * 0.8);
      const x = cx - R * 0.2, y = ty + R * K * 0.9;
      const grd = g.createRadialGradient(x, y, 0, x, y, R * 0.7);
      grd.addColorStop(0, `rgba(255,236,190,${a})`);
      grd.addColorStop(0.5, `rgba(190,225,255,${a * 0.4})`);
      grd.addColorStop(1, 'rgba(190,225,255,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(x, y, R * 0.7, R * K * 0.7, 0, 0, Math.PI * 2);
      g.fill();
    }
    if (this.puddle.a > 0.01) {
      const pr = this.puddle.r;
      const a = 0.16 * this.puddle.a * Math.max(0, 1 - Math.max(0, this.brokenT - 2.2) / 1.2);
      const pw = R * (0.6 + 1.3 * pr), ph = R * K * (0.6 + 1.1 * pr);
      const grd = g.createRadialGradient(cx, ty + 10, 0, cx, ty + 10, pw);
      grd.addColorStop(0, `rgba(120,160,200,${a})`);
      grd.addColorStop(0.85, `rgba(150,190,230,${a})`);
      grd.addColorStop(1, `rgba(220,240,255,${a * 2})`);
      g.fillStyle = grd;
      g.beginPath();
      g.ellipse(cx, ty + 10, pw, ph, 0, 0, Math.PI * 2);
      g.fill();
    }
  }

  private drawStem(alpha: number) {
    const g = this.g, cx = this.cx, ty = this.tableY, R = this.Rpx;
    g.save();
    g.globalAlpha = alpha;
    // Foot.
    const fr = R * 0.82;
    g.fillStyle = 'rgba(210,230,255,0.07)';
    g.strokeStyle = 'rgba(230,242,255,0.5)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.ellipse(cx, ty - 2, fr, fr * K * 0.85, 0, 0, Math.PI * 2);
    g.fill();
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.8)';
    g.beginPath();
    g.ellipse(cx, ty - 2, fr, fr * K * 0.85, 0, 0.15 * Math.PI, 0.55 * Math.PI);
    g.stroke();
    // Stem: a solid rod, a bright core between dark refracted edges.
    const top = this.bowlBottom, bot = ty - 4, w = Math.max(3, R * 0.07);
    const grd = g.createLinearGradient(cx - w, 0, cx + w, 0);
    grd.addColorStop(0, 'rgba(255,255,255,0.35)');
    grd.addColorStop(0.3, 'rgba(40,50,70,0.35)');
    grd.addColorStop(0.55, 'rgba(255,255,255,0.75)');
    grd.addColorStop(0.8, 'rgba(40,50,70,0.3)');
    grd.addColorStop(1, 'rgba(255,255,255,0.3)');
    g.fillStyle = grd;
    g.beginPath();
    g.moveTo(cx - w * 1.6, top);
    g.quadraticCurveTo(cx - w, top + 10, cx - w, top + 18);
    g.lineTo(cx - w * 0.9, bot - 8);
    g.quadraticCurveTo(cx - w * 1.2, bot, cx - w * 3, bot);
    g.lineTo(cx + w * 3, bot);
    g.quadraticCurveTo(cx + w * 1.2, bot, cx + w * 0.9, bot - 8);
    g.lineTo(cx + w, top + 18);
    g.quadraticCurveTo(cx + w, top + 10, cx + w * 1.6, top);
    g.closePath();
    g.fill();
    g.restore();
  }

  private drawGlass(t: number) {
    const g = this.g, cx = this.cx, R = this.Rpx;
    const uL = this.wob(Math.PI), uR = this.wob(0);
    const out = this.outline(uL, uR);
    const path = new Path2D();
    path.moveTo(out[0], out[1]);
    for (let i = 2; i < out.length; i += 2) path.lineTo(out[i], out[i + 1]);
    path.closePath();
    // Body: a faint cool fill, brighter toward the walls (more glass along the line of sight).
    const body = g.createLinearGradient(cx - R * 1.2, 0, cx + R * 1.2, 0);
    body.addColorStop(0, 'rgba(210,230,255,0.16)');
    body.addColorStop(0.2, 'rgba(210,230,255,0.04)');
    body.addColorStop(0.8, 'rgba(210,230,255,0.04)');
    body.addColorStop(1, 'rgba(210,230,255,0.14)');
    g.fillStyle = body;
    g.fill(path);
    // Back rim.
    g.strokeStyle = 'rgba(230,240,255,0.3)';
    g.lineWidth = 1;
    g.beginPath();
    for (let k = 0; k <= 32; k++) {
      const [x, y] = this.rimPt(-(k / 32) * Math.PI);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    if (this.fill > 0.01) this.drawWater(uL, uR);
    // Walls at the silhouette: seen edge-on, a thick bright band with a dark refracted inner line.
    g.lineJoin = 'round';
    for (const side of [-1, 1]) {
      const u = side < 0 ? uL : uR;
      g.beginPath();
      for (let i = 0; i < NP; i++) {
        const tt = i / (NP - 1);
        const x = cx + side * (this.rs[i] + u * tt * tt), y = this.ys[i];
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.strokeStyle = 'rgba(200,220,255,0.18)';
      g.lineWidth = 4;
      g.stroke();
      g.strokeStyle = side < 0 ? 'rgba(245,250,255,0.7)' : 'rgba(235,245,255,0.5)';
      g.lineWidth = 1.1;
      g.stroke();
    }
    // Window highlights curving with the bowl.
    this.streak(-0.74, -0.6, 0.2, 0.93, 0.13);
    this.streak(-0.5, -0.46, 0.35, 0.85, 0.08);
    this.streak(0.52, 0.6, 0.3, 0.8, 0.06);
    // Micro-cracks from fatigue.
    if (this.damage > 0.01) {
      g.strokeStyle = `rgba(255,255,255,${0.3 + this.damage * 0.5})`;
      g.lineWidth = 0.8;
      for (const c of this.cracks) {
        const n = Math.max(2, Math.round((c.length / 2) * Math.min(1, this.damage * 1.6)));
        g.beginPath();
        for (let k = 0; k < n; k++) {
          const th = c[2 * k], tt = c[2 * k + 1];
          const r = R * profile(this.glass.def, tt);
          const x = cx + r * Math.cos(th), y = this.bowlBottom - tt * this.Hpx + K * r * Math.sin(th);
          k ? g.lineTo(x, y) : g.moveTo(x, y);
        }
        g.stroke();
      }
    }
    // Front rim.
    const sh = this.shimmer;
    g.strokeStyle = `rgba(255,255,255,${0.75 + 0.25 * sh})`;
    g.lineWidth = 1.6;
    g.beginPath();
    for (let k = 0; k <= 40; k++) {
      const [x, y] = this.rimPt((k / 40) * Math.PI);
      k ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    // Glints; when you sing near the note the rim shimmers, more the closer you get.
    g.globalCompositeOperation = 'lighter';
    const gl = (th: number, s: number, a: number) => {
      const [x, y] = this.rimPt(th);
      g.globalAlpha = Math.min(1, a) * this.appear;
      g.drawImage(this.sprite, x - s / 2, y - s / 2, s, s);
    };
    gl(0.28 * Math.PI, 26 + 8 * Math.sin(t * 1.3), 0.9);
    gl(-0.8 * Math.PI, 14, 0.5);
    if (sh > 0.02) {
      for (let k = 0; k < 14; k++) {
        const th = (k / 14) * 2 * Math.PI + t * 0.4;
        const tw = 0.5 + 0.5 * Math.sin(t * (7 + k) + k * 2.1);
        gl(th, 10 + 14 * tw * sh, sh * tw * (th % (2 * Math.PI) < Math.PI ? 1 : 0.5));
      }
    }
    // The fingertip on the rim.
    const f = this.fingers.get(this.rubId);
    if (f && f.onRim) {
      const [x, y] = this.rimPt(f.phi);
      g.globalAlpha = 0.25 + 0.3 * this.wet;
      g.drawImage(this.sprite, x - 18, y - 18, 36, 36);
    }
    g.globalAlpha = this.appear;
    g.globalCompositeOperation = 'source-over';
  }

  private streak(a: number, b: number, t0: number, t1: number, alpha: number) {
    const g = this.g, cx = this.cx;
    g.beginPath();
    const i0 = Math.round(t0 * (NP - 1)), i1 = Math.round(t1 * (NP - 1));
    for (let i = i0; i <= i1; i++) g.lineTo(cx + this.rs[i] * a, this.ys[i]);
    for (let i = i1; i >= i0; i--) g.lineTo(cx + this.rs[i] * b, this.ys[i]);
    g.closePath();
    const grd = g.createLinearGradient(0, this.ys[i1], 0, this.ys[i0]);
    grd.addColorStop(0, 'rgba(255,255,255,0)');
    grd.addColorStop(0.3, `rgba(255,255,255,${alpha})`);
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd;
    g.fill();
  }

  private drawWater(uL: number, uR: number) {
    const g = this.g, cx = this.cx;
    const wy = this.waterY(), f = this.fill;
    const wr = this.waterR();
    const iw = Math.round(f * (NP - 1));
    const path = new Path2D();
    // Water body: walls from the surface down, closed by the back half of the surface ellipse.
    path.moveTo(cx - wr - uL * f * f, wy);
    for (let i = iw; i >= 0; i--) {
      const tt = i / (NP - 1);
      path.lineTo(cx - this.rs[i] * 0.97 - uL * tt * tt, this.ys[i]);
    }
    for (let i = 0; i <= iw; i++) {
      const tt = i / (NP - 1);
      path.lineTo(cx + this.rs[i] * 0.97 + uR * tt * tt, this.ys[i]);
    }
    path.lineTo(cx + wr + uR * f * f, wy);
    path.ellipse(cx, wy, wr, wr * K, 0, 0, -Math.PI, true);
    path.closePath();
    g.save();
    g.clip(path);
    // A water-filled bowl is a cylindrical lens: the room behind shows flipped and magnified.
    g.setTransform(-1.6 * this.pr, 0, 0, this.pr, cx * this.pr * 2.6, 0);
    g.globalAlpha = 0.85 * this.appear;
    g.drawImage(this.bg, 0, 0, this.bg.width / this.pr, this.bg.height / this.pr);
    g.setTransform(this.pr, 0, 0, this.pr, 0, 0);
    g.globalAlpha = this.appear;
    const tint = g.createLinearGradient(0, wy, 0, this.bowlBottom);
    tint.addColorStop(0, 'rgba(90,150,200,0.28)');
    tint.addColorStop(1, 'rgba(20,50,90,0.5)');
    g.fillStyle = tint;
    g.fillRect(cx - this.Rpx * 1.5, wy - this.Rpx, this.Rpx * 3, this.bowlBottom - wy + this.Rpx * 1.2);
    g.restore();
    // Surface.
    const rx = wr + (uL + uR) * 0.5 * f * f;
    g.drawImage(this.water.canvas, cx - rx, wy - rx * K, rx * 2, rx * 2 * K);
    // Meniscus: the water climbs the wall and catches the light in a thin bright line.
    g.strokeStyle = 'rgba(220,240,255,0.55)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.ellipse(cx, wy, rx, rx * K, 0, 0, Math.PI);
    g.stroke();
    g.strokeStyle = 'rgba(220,240,255,0.25)';
    g.beginPath();
    g.ellipse(cx, wy, rx, rx * K, 0, Math.PI, 2 * Math.PI);
    g.stroke();
  }

  private drawShards() {
    const g = this.g;
    const fade = 1 - Math.max(0, this.brokenT - (RESPAWN - 0.8)) / 0.8;
    g.save();
    g.globalAlpha = Math.max(0, fade);
    for (const s of this.shards) {
      g.save();
      g.translate(s.x, s.y);
      g.rotate(s.a);
      g.beginPath();
      for (let i = 0; i < s.poly.length; i += 2) i ? g.lineTo(s.poly[i], s.poly[i + 1]) : g.moveTo(s.poly[i], s.poly[i + 1]);
      g.closePath();
      // Each shard catches the light as it turns.
      const flash = Math.abs(Math.sin(s.a * 1.7 + s.shade * 6));
      g.fillStyle = `rgba(200,225,255,${0.06 + 0.1 * s.shade + 0.25 * flash ** 6})`;
      g.fill();
      g.strokeStyle = `rgba(245,250,255,${0.35 + 0.6 * flash})`;
      g.lineWidth = 0.9;
      g.stroke();
      g.restore();
    }
    g.restore();
  }

  private drawDrops() {
    const g = this.g;
    // Drops: a faint body with a bright catch-light, so they read as water, not beads.
    g.fillStyle = 'rgba(170,210,245,0.45)';
    for (const p of this.drops) {
      g.beginPath();
      g.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.9)';
    for (const p of this.drops) g.fillRect(p.x - p.r * 0.45, p.y - p.r * 0.5, Math.max(0.8, p.r * 0.5), Math.max(0.8, p.r * 0.5));
  }

  private jugPose() {
    const rest = this.jugRest();
    const j = this.jug;
    // Lifted up beside the rim and tipped toward the glass.
    return { x: rest.x + (this.cx - this.Rpx * 0.55 - 40 - rest.x) * j, y: rest.y + (this.rimY - 30 - rest.y) * j, a: j * 1.05 };
  }

  private drawProps(t: number) {
    const g = this.g;
    // Jug.
    const jp = this.jugPose();
    g.save();
    g.translate(jp.x, jp.y);
    g.rotate(jp.a);
    g.fillStyle = 'rgba(210,225,240,0.12)';
    g.strokeStyle = 'rgba(235,245,255,0.6)';
    g.lineWidth = 1.3;
    g.beginPath();
    g.moveTo(-22, 0);
    g.quadraticCurveTo(-30, -40, -20, -62);
    g.lineTo(18, -66);
    g.lineTo(30, -72);
    g.lineTo(22, -58);
    g.quadraticCurveTo(30, -30, 22, 0);
    g.closePath();
    g.fill();
    g.stroke();
    // Water inside the jug.
    g.fillStyle = 'rgba(110,170,220,0.3)';
    g.beginPath();
    g.moveTo(-21, -2);
    g.quadraticCurveTo(-27, -22, -25, -34);
    g.lineTo(26, -34);
    g.quadraticCurveTo(28, -18, 21, -2);
    g.closePath();
    g.fill();
    g.beginPath();
    g.strokeStyle = 'rgba(235,245,255,0.45)';
    g.arc(-30, -34, 12, Math.PI * 0.5, Math.PI * 1.5);
    g.stroke();
    g.restore();
    // Pipette.
    const pr = this.pipetteRest();
    const p = this.pipette;
    const px = pr.x + (this.cx + this.Rpx * 0.45 - pr.x) * p;
    const tipY = pr.y + (this.waterY() + 14 - pr.y) * p;
    const len = 104;
    g.strokeStyle = 'rgba(235,245,255,0.6)';
    g.fillStyle = 'rgba(210,225,240,0.12)';
    g.lineWidth = 1.2;
    g.beginPath();
    g.moveTo(px - 1.5, tipY);
    g.lineTo(px - 5, tipY - len * 0.7);
    g.lineTo(px + 5, tipY - len * 0.7);
    g.lineTo(px + 1.5, tipY);
    g.closePath();
    g.fill();
    g.stroke();
    const squeeze = this.sipping ? 0.75 + 0.1 * Math.sin(t * 9) : 1;
    g.fillStyle = '#b8453a';
    g.beginPath();
    g.ellipse(px, tipY - len * 0.7 - 16, 9 * squeeze, 17, 0, 0, Math.PI * 2);
    g.fill();
    g.fillStyle = 'rgba(255,220,210,0.35)';
    g.beginPath();
    g.ellipse(px - 3, tipY - len * 0.7 - 21, 2.5, 6, 0, 0, Math.PI * 2);
    g.fill();
    if (this.sipping || (this.pipette > 0.2 && this.fill > 0)) {
      g.fillStyle = 'rgba(110,170,220,0.45)';
      g.fillRect(px - 2.5, tipY - len * 0.5 * this.pipette, 5, len * 0.5 * this.pipette);
    }
  }

  private drawStream(t: number) {
    if (!this.pouring) return;
    const g = this.g;
    const jp = this.jugPose();
    // Spout in world space.
    const sx = jp.x + 30 * Math.cos(jp.a) + 72 * Math.sin(jp.a), sy = jp.y + 30 * Math.sin(jp.a) - 72 * Math.cos(jp.a);
    const ex = this.cx - this.waterR() * 0.3, ey = this.waterY();
    g.strokeStyle = 'rgba(190,225,255,0.55)';
    g.lineWidth = 3 + Math.sin(t * 30) * 0.6;
    g.lineCap = 'round';
    g.beginPath();
    g.moveTo(sx, sy);
    g.quadraticCurveTo(sx + 16, sy + 10, ex, ey);
    g.stroke();
    g.lineCap = 'butt';
  }

  destroy() {
    this.audio.destroy();
    this.trickle.stop();
    this.sipLoop.stop();
    this.hint.remove();
    this.style.remove();
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      delete w.__glass;
      delete w.__glassDev;
    }
  }
}

function glint(size: number) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  const h = size / 2;
  const grd = g.createRadialGradient(h, h, 0, h, h, h);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.15, 'rgba(235,245,255,0.7)');
  grd.addColorStop(0.45, 'rgba(180,215,255,0.15)');
  grd.addColorStop(1, 'rgba(180,215,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, size, size);
  // A four-point star so it reads as a glint, not a blob.
  g.globalCompositeOperation = 'lighter';
  g.fillStyle = 'rgba(255,255,255,0.5)';
  g.fillRect(h - 0.75, 2, 1.5, size - 4);
  g.fillRect(2, h - 0.75, size - 4, 1.5);
  return c;
}

const STYLE = `
.gls-hint { position: absolute; left: 50%; bottom: 9%; transform: translateX(-50%); padding: 7px 14px; border-radius: 999px; background: rgba(20, 24, 34, 0.6); color: #dfeeff; font: 600 15px/1.2 ui-rounded, system-ui, sans-serif; letter-spacing: .02em; opacity: 0; transition: opacity .4s; pointer-events: none; white-space: nowrap; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.gls-hint.show { opacity: 1; }
`;
