import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop, Slip } from '../../shell/sound';
import type { PlateShape } from './modes';
import { GRAV, HALF, Plate, type Contact } from './plate';
import { PlateView } from './render';
import { AIR, REST, Sand } from './sand';
import { PlateVoice } from './voice';

export const chladniToy: Toy = {
  id: 'chladni',
  title: 'Chladni Plate',
  blurb: 'A steel plate dusted with sand. Tap it, bow its edge with a drag, or sing to it: whichever modes are ringing make the sand hop, and it gathers on the lines that stay still. The tone you hear is those same modes, so every figure has its note.',
  tech: 'Ritz free-plate eigenmodes (Legendre basis, Jacobi eigensolver) · modal oscillators driven by taps, stick-slip bowing and mic pitch · sand hopping where acceleration beats gravity · per-mode sine bank · WebGL2',
  swatch: 'radial-gradient(circle at 50% 45%,#f1e2c0 0 6%,transparent 7%),linear-gradient(135deg,#2b2e33 0 30%,#6e747c 48%,#2b2e33 66%,#15171a 100%)',
  refs: [
    {
      short: 'Gander & Kwok 2012',
      title: 'Chladni Figures and the Tacoma Bridge: Motivating PDE Eigenvalue Problems via Vibrating Plates (SIAM Review 54(3), 2012)',
      url: 'https://doi.org/10.1137/10081931x',
      use: "The free-plate eigenproblem and Ritz's 1909 method: minimise the Kirchhoff bending energy (with Poisson's term) over a finite basis, the free edge coming out as the natural boundary condition.",
    },
    {
      short: 'Leissa 1973',
      title: 'The Free Vibration of Rectangular Plates (A. W. Leissa, Journal of Sound and Vibration 31(3), 1973)',
      url: 'https://doi.org/10.1016/s0022-460x(73)80371-2',
      use: 'Reference frequency parameters for the completely free square plate, used to check the solver (13.47, 19.60, 24.27, 34.80, 61.09 ... for Poisson ratio 0.3).',
    },
    {
      short: 'Müller 2013',
      title: 'Numerical Chladni Figures (T. Müller, European Journal of Physics 34, 2013)',
      url: 'https://doi.org/10.1088/0143-0807/34/4/1067',
      use: 'Sand as the witness of the nodal lines of a numerically solved plate mode.',
    },
    {
      short: 'van den Doel 1998',
      title: 'The Sounds of Physical Shapes (van den Doel & Pai, Presence 1998)',
      url: 'https://doi.org/10.1162/105474698565794',
      use: 'The sound as one sine per mode, each excited by its mode shape at the struck point.',
    },
  ],
  async create(ctx) {
    return new Chladni(ctx);
  },
};

const MAX_GRAINS = 9000;
/** Edge band for bowing, in plate half-sizes: this far inside the rim, and this far outside it. */
const BOW_IN = 0.12;
const BOW_OUT = 0.5;
const FINGER_R = 0.07;
/** Loudness of the plate's sine bank per m/s of mode velocity. */
const AUDIO = 6;
/** Frequency range of the mode ladder, Hz. */
const LADDER = [60, 2200];

interface Finger {
  kind: 'touch' | 'edge' | 'none';
  speed: number;
}

class Chladni implements ToyInstance {
  private view: PlateView;
  private plate: Plate;
  private plates = new Map<PlateShape, Plate>();
  private sand = new Sand(MAX_GRAINS);
  private voice = new PlateVoice();
  private fingers = new Map<number, Finger>();
  private trickle: Loop;
  private slip: Slip;
  private tune = { grains: 4000, damping: 2 };
  private shape: PlateShape = 'square';
  private w = 1;
  private h = 1;
  private cx = 0;
  private cy = 0;
  private half = 1;
  private peak = 0;
  private struck = false;
  private used = false;
  private levels: Float64Array;
  private style: HTMLStyleElement;
  private hint: HTMLDivElement;
  private dock: HTMLDivElement;
  private ladder: HTMLCanvasElement;
  private lg: CanvasRenderingContext2D;
  private readout: HTMLDivElement;
  private devSing = { f: 0, level: 0, until: 0 };
  private perf = { sim: 0, field: 0, draw: 0 };
  private t = 0;
  private wake = () => this.voice.wake();

  constructor(private ctx: ToyContext) {
    this.view = new PlateView(ctx.canvas, MAX_GRAINS);
    this.plate = this.makePlate('square');
    this.levels = new Float64Array(this.plate.clusters.length);
    this.voice.setFrequencies(this.plate.clusters.map((c) => this.plate.freq[c[0]]));
    this.trickle = ctx.sound.loop('trickle');
    this.slip = ctx.sound.slip();
    ctx.canvas.addEventListener('pointerdown', this.wake);
    ctx.mic.offer('Sing or hum a note to the plate');

    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'chl-hint';
    this.hint.textContent = 'Tap the plate · drag along its edge to bow';
    this.dock = document.createElement('div');
    this.dock.className = 'chl-dock';
    this.readout = document.createElement('div');
    this.readout.className = 'chl-readout';
    this.ladder = document.createElement('canvas');
    this.ladder.className = 'chl-ladder';
    this.lg = this.ladder.getContext('2d')!;
    const sprinkle = document.createElement('button');
    sprinkle.type = 'button';
    sprinkle.className = 'chl-btn';
    sprinkle.textContent = 'Sprinkle';
    sprinkle.addEventListener('click', () => this.sand.sprinkle(Math.round(this.tune.grains / 3), this.shape));
    this.dock.append(this.ladder, sprinkle);
    ctx.overlay.append(this.hint, this.readout, this.dock);

    ctx.panel.choice('Plate', [{ value: 'square', label: 'Square' }, { value: 'circle', label: 'Circle' }], 'square', (v) => this.setShape(v));
    ctx.panel.slider(this.tune, 'grains', { label: 'Sand', min: 1000, max: MAX_GRAINS, step: 500, onChange: () => this.newSand() });
    ctx.panel.slider(this.tune, 'damping', { label: 'Damping (loss ×1000)', min: 0.5, max: 12, step: 0.5, onChange: (v) => (this.plate.eta = v / 1000) });
    ctx.panel.action('New sand', () => this.newSand());
    ctx.panel.action('Clear sand', () => this.sand.clear());
    this.newSand();

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__chladni = () => this.devState();
      w.__chladniDev = {
        tap: (x: number, y: number, s = 1) => this.strike(x, y, s),
        sing: (f: number, level = 0.7, secs = 3) => (this.devSing = { f, level, until: this.t + secs }),
        silence: () => this.plate.silence(),
        newSand: () => this.newSand(),
        shape: (s: PlateShape) => this.setShape(s),
        figure: () => this.figure(),
        toScreen: (x: number, y: number) => [(this.cx + x * this.half) / ctx.pixelRatio, (this.cy + y * this.half) / ctx.pixelRatio],
      };
    }
  }

  private makePlate(shape: PlateShape) {
    let p = this.plates.get(shape);
    if (!p) {
      p = new Plate(shape);
      this.plates.set(shape, p);
    }
    p.eta = this.tune.damping / 1000;
    return p;
  }

  private setShape(s: PlateShape) {
    if (s === this.shape) return;
    this.shape = s;
    this.plate.silence();
    this.plate = this.makePlate(s);
    this.plate.silence();
    this.levels = new Float64Array(this.plate.clusters.length);
    this.voice.setFrequencies(this.plate.clusters.map((c) => this.plate.freq[c[0]]));
    this.newSand();
  }

  private newSand() {
    this.sand.clear();
    this.sand.sprinkle(this.tune.grains, this.shape);
  }

  private strike(x: number, y: number, s = 1) {
    this.plate.tap(x, y, s * (0.85 + Math.random() * 0.3));
    this.voice.strike(s, Math.max(-1, Math.min(1, x * 0.6)));
    this.struck = true;
  }

  /** Signed distance to the rim (plate half-sizes, negative inside), nearest rim point and tangent. */
  private rim(x: number, y: number) {
    if (this.shape === 'circle') {
      const r = Math.hypot(x, y) || 1e-6;
      return { sd: r - 1, px: x / r, py: y / r, tx: -y / r, ty: x / r };
    }
    const ax = Math.abs(x), ay = Math.abs(y);
    const cl = (v: number) => Math.max(-1, Math.min(1, v));
    return ax > ay ? { sd: ax - 1, px: Math.sign(x), py: cl(y), tx: 0, ty: 1 } : { sd: ay - 1, px: cl(x), py: Math.sign(y), tx: 1, ty: 0 };
  }

  frame(dt: number, t: number) {
    this.t = t;
    const ctx = this.ctx;
    const t0 = performance.now();
    const bows: Contact[] = [], dampers: Contact[] = [], pushers: { x: number; y: number; r: number; dx: number; dy: number }[] = [];
    let bowSpeed = 0, bowPan = 0;
    for (const p of ctx.pointers.active.values()) {
      const x = (p.x * this.w - this.cx) / this.half, y = ((1 - p.y) * this.h - this.cy) / this.half;
      const dx = (p.dx * this.w) / this.half, dy = (-p.dy * this.h) / this.half;
      const rim = this.rim(x, y);
      let f = this.fingers.get(p.id);
      if (!f || p.justDown) {
        f = { kind: rim.sd < -BOW_IN ? 'touch' : rim.sd < BOW_OUT ? 'edge' : 'none', speed: 0 };
        this.fingers.set(p.id, f);
        if (rim.sd < 0) this.strike(x, y);
        if (f.kind !== 'none') this.used = true;
      }
      if (!p.down) continue;
      if (f.kind === 'edge' && rim.sd < -BOW_IN * 1.8) f.kind = 'touch';
      if (f.kind === 'edge') {
        // Bowing: speed along the rim, smoothed over a few frames (finger deltas are jumpy).
        const along = Math.abs(dx * rim.tx + dy * rim.ty) / Math.max(dt, 1e-3);
        f.speed += (along * HALF - f.speed) * 0.3;
        if (f.speed > 0.01 || p.held > 0.12) bows.push({ x: rim.px * 0.999, y: rim.py * 0.999, speed: f.speed });
        bowSpeed = Math.max(bowSpeed, f.speed);
        bowPan = rim.px * 0.6;
      } else if (f.kind === 'touch') {
        // A fingertip left on the plate damps every mode by its shape there: hold one on a node line
        // and that figure survives while others die (Chladni's own trick).
        const press = smooth(0.06, 0.22, p.held);
        if (press > 0) dampers.push({ x, y, press });
        if (Math.hypot(dx, dy) > 1e-4) pushers.push({ x, y, r: FINGER_R, dx, dy });
      }
    }
    for (const id of [...this.fingers.keys()]) if (!ctx.pointers.active.has(id)) this.fingers.delete(id);

    // The sung note (or the dev hook standing in for it).
    const mic = ctx.mic;
    if (mic.active && mic.pitch > 0) this.plate.sing(mic.pitch, mic.level);
    if (this.devSing.until > t) this.plate.sing(this.devSing.f, this.devSing.level);

    const plate = this.plate;
    plate.step(dt, bows, dampers);
    const t1 = performance.now();
    this.peak = plate.updateField();
    const t2 = performance.now();
    this.sand.step(Math.min(dt, 1 / 30), this.shape, (x, y) => plate.sample(plate.field, x, y), (x, y) => plate.sample(plate.vel, x, y), pushers);
    const t3 = performance.now();

    this.sound(bowSpeed, bowPan);
    this.draw(t);
    const t4 = performance.now();
    const k = 0.05;
    this.perf.sim += (t1 - t0 + (t3 - t2) - this.perf.sim) * k;
    this.perf.field += (t2 - t1 - this.perf.field) * k;
    this.perf.draw += (t4 - t3 - this.perf.draw) * k;

    // Haptics: the plate's buzz under the finger, sharper for higher modes.
    const e = plate.energy();
    const hz = this.loudestHz();
    const inten = Math.min(1, Math.sqrt(e / 0.004)) * 0.8;
    if (inten > 0.03) ctx.hapticLevel(inten, Math.max(0.1, Math.min(1, (hz - 60) / 1200)));

    // How settled the figure is: of the grains on the plate, the share at rest while it rings.
    const s = this.sand;
    if (this.peak > 1.1 && s.onPlate > 50) ctx.progress(s.resting / s.onPlate, 'settled');
    else ctx.progress(null);
    ctx.setStatus(`${s.onPlate} grains`);
    this.hint.classList.toggle('show', !this.used && t > 0.6);
    this.drawLadder();
  }

  private loudestHz() {
    const p = this.plate;
    let best = 0, hz = 0;
    for (let k = 0; k < p.n; k++) {
      const v = p.velocity(k);
      if (v > best) {
        best = v;
        hz = p.freq[k];
      }
    }
    const wd = p.driveOmega;
    return wd > 0 && this.driveVelocity() > best ? wd / (2 * Math.PI) : hz;
  }

  private driveVelocity() {
    const p = this.plate, wd = p.driveOmega;
    let s = 0;
    for (let k = 0; k < p.n; k++) s += p.bre[k] ** 2 + p.bim[k] ** 2;
    return wd * Math.sqrt(s);
  }

  private sound(bowSpeed: number, bowPan: number) {
    const p = this.plate;
    // Free ringing per cluster at its own frequency; the forced part plays at the sung pitch.
    for (let c = 0; c < p.clusters.length; c++) {
      let v2 = 0;
      for (const k of p.clusters[c]) v2 += (p.omega[k] * Math.hypot(p.are[k], p.aim[k])) ** 2;
      const f = p.freq[p.clusters[c][0]];
      this.levels[c] = AUDIO * Math.sqrt(v2) * radiation(f);
    }
    const wd = p.driveOmega, fd = wd / (2 * Math.PI);
    this.voice.update(this.levels, fd, wd > 0 ? AUDIO * this.driveVelocity() * radiation(fd) : 0, this.struck, this.ctx.mic.active ? 0.45 : 1);
    this.struck = false;
    // Rosin on steel: irregular slips while the bow hunts, locking to the ringing mode once it speaks.
    const lock = p.bowLock;
    const hz = this.loudestHz() || 800;
    const rate = lock > 0.6 ? hz : 60 + bowSpeed * 900;
    this.slip.set(bowSpeed > 0.01 ? Math.min(1, bowSpeed / 0.3) * (0.35 + 0.4 * (1 - lock)) : 0, rate, hz, bowPan);
    // Sand patter: the grains landing back on the plate.
    const s = this.sand;
    const pat = Math.min(1, (s.landings * 60) / 9000);
    this.trickle.set(pat * 0.7, 0.35 + 0.5 * Math.min(1, this.peak / 6));
  }

  private draw(t: number) {
    const s = this.sand, d = this.view.grains;
    let n = 0;
    for (let i = 0; i < s.n; i++) {
      if (s.state[i] === 3) continue;
      d[n * 4] = this.cx + s.x[i] * this.half;
      d[n * 4 + 1] = this.cy + s.y[i] * this.half;
      d[n * 4 + 2] = s.z[i];
      d[n * 4 + 3] = s.tint[i];
      n++;
    }
    const pr = this.ctx.pixelRatio;
    this.view.draw({ w: this.w, h: this.h, cx: this.cx, cy: this.cy, half: this.half, circle: this.shape === 'circle', t, shimmer: 1, field: this.plate.field, count: n, size: Math.max(2, 2.1 * pr * (this.half / (170 * pr))) });
  }

  /** The mode ladder: every mode on a log frequency axis, lit by how hard it rings; the sung pitch as a dot. */
  private drawLadder() {
    const c = this.ladder, g = this.lg, pr = this.ctx.pixelRatio;
    const W = c.clientWidth, H = c.clientHeight;
    if (!W) return;
    if (c.width !== Math.round(W * pr)) {
      c.width = Math.round(W * pr);
      c.height = Math.round(H * pr);
    }
    g.setTransform(pr, 0, 0, pr, 0, 0);
    g.clearRect(0, 0, W, H);
    const lx = (f: number) => 6 + ((W - 12) * Math.log(f / LADDER[0])) / Math.log(LADDER[1] / LADDER[0]);
    g.fillStyle = 'rgba(255,255,255,0.08)';
    g.fillRect(6, H - 9, W - 12, 1);
    const p = this.plate;
    for (let c2 = 0; c2 < p.clusters.length; c2++) {
      const f = p.freq[p.clusters[c2][0]];
      if (f > LADDER[1]) continue;
      let v = 0;
      for (const k of p.clusters[c2]) v = Math.max(v, p.omega[k] ** 2 * Math.hypot(p.are[k], p.aim[k], p.bre[k], p.bim[k]) / GRAV);
      const a = Math.min(1, v / 4);
      const x = lx(f);
      g.fillStyle = `rgba(${Math.round(200 + 55 * a)},${Math.round(200 + 30 * a)},${Math.round(190 - 60 * a)},${0.25 + 0.75 * a})`;
      const hgt = 4 + a * (H - 16);
      g.fillRect(x - 1, H - 9 - hgt, 2, hgt);
    }
    const sung = this.ctx.mic.active ? this.ctx.mic.pitch : this.devSing.until > this.t ? this.devSing.f : 0;
    if (sung > 0) {
      g.fillStyle = '#9fd8ff';
      g.beginPath();
      g.arc(lx(sung), H - 5, 3.2, 0, Math.PI * 2);
      g.fill();
    }
    const hz = this.peak > 0.3 ? this.loudestHz() : 0;
    this.readout.textContent = hz ? `${Math.round(hz)} Hz · ${noteName(hz)}` : sung ? `${Math.round(sung)} Hz` : '';
  }

  /** Which mode the sand has drawn: enrichment of resting grains on each mode's quiet lines. */
  private figure() {
    const p = this.plate, s = this.sand, G = p.modes.G;
    const out: { k: number; hz: number; score: number }[] = [];
    for (let k = 0; k < p.n; k++) {
      const grid = p.modes.modes[k].grid;
      let area = 0, cells = 0;
      for (let i = 0; i < grid.length; i++) if (p.modes.mask[i]) {
        cells++;
        if (Math.abs(grid[i]) < 0.3) area++;
      }
      let on = 0, tot = 0;
      for (let i = 0; i < s.n; i++) {
        if (s.state[i] !== REST) continue;
        const gx = Math.min(G - 1, Math.max(0, Math.floor(((s.x[i] + 1) / 2) * G)));
        const gy = Math.min(G - 1, Math.max(0, Math.floor(((s.y[i] + 1) / 2) * G)));
        tot++;
        if (Math.abs(grid[gy * G + gx]) < 0.3) on++;
      }
      out.push({ k, hz: Math.round(p.freq[k]), score: +(tot ? on / tot / (area / cells) : 0).toFixed(2) });
    }
    return out.sort((a, b) => b.score - a.score).slice(0, 4);
  }

  private devState() {
    const p = this.plate, s = this.sand;
    let air = 0;
    for (let i = 0; i < s.n; i++) if (s.state[i] === AIR) air++;
    return {
      shape: this.shape,
      modes: Array.from(p.freq, (f, k) => ({ hz: +f.toFixed(1), leissa: +p.modes.modes[k].leissa.toFixed(2), gamma: +((p.omega[k] ** 2 * Math.hypot(p.are[k], p.aim[k], p.bre[k], p.bim[k])) / GRAV).toFixed(2) })),
      peak: +this.peak.toFixed(2),
      loudestHz: Math.round(this.loudestHz()),
      drive: Math.round(p.driveOmega / (2 * Math.PI)),
      bowLock: +p.bowLock.toFixed(2),
      grains: { total: s.n, onPlate: s.onPlate, resting: s.resting, air, hops: s.hops },
      mic: { active: this.ctx.mic.active, pitch: Math.round(this.ctx.mic.pitch), level: +this.ctx.mic.level.toFixed(2) },
      audio: this.voice.running,
      audioPeak: +Math.max(...this.levels).toFixed(3),
      perf: { simMs: +this.perf.sim.toFixed(2), fieldMs: +this.perf.field.toFixed(2), drawMs: +this.perf.draw.toFixed(2) },
    };
  }

  resize(width: number, height: number) {
    this.w = width;
    this.h = height;
    this.half = Math.min(width * 0.42, height * 0.3);
    this.cx = width / 2;
    this.cy = height * 0.45;
    this.readout.style.top = `${(this.cy + this.half * 1.09) / this.ctx.pixelRatio}px`;
    this.dock.style.top = `${(this.cy + this.half * 1.09) / this.ctx.pixelRatio + 34}px`;
    this.hint.style.top = `${(this.cy - this.half * 1.12) / this.ctx.pixelRatio - 36}px`;
  }

  destroy() {
    this.ctx.canvas.removeEventListener('pointerdown', this.wake);
    this.trickle.stop();
    this.slip.stop();
    this.voice.destroy();
    this.view.destroy();
    this.hint.remove();
    this.dock.remove();
    this.readout.remove();
    this.style.remove();
    this.ctx.progress(null);
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      delete w.__chladni;
      delete w.__chladniDev;
    }
  }
}

/** Small plates radiate their low modes poorly; the top is softened a little. */
function radiation(f: number) {
  return (f / (f + 120)) / (1 + (f / 5000) ** 2);
}

const NOTES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
function noteName(f: number) {
  const m = Math.round(69 + 12 * Math.log2(f / 440));
  return `${NOTES[((m % 12) + 12) % 12]}${Math.floor(m / 12) - 1}`;
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

const STYLE = `
.chl-hint { position: absolute; left: 50%; transform: translateX(-50%); padding: 7px 14px; border-radius: 999px; background: rgba(20, 22, 26, 0.6); color: #e8e2d4; font: 600 14px/1 ui-rounded, system-ui, sans-serif; opacity: 0; transition: opacity .3s; pointer-events: none; white-space: nowrap; backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); }
.chl-hint.show { opacity: 1; }
.chl-dock { position: absolute; left: 50%; transform: translateX(-50%); width: min(380px, calc(100% - 32px)); display: flex; gap: 12px; align-items: flex-end; pointer-events: none; }
.chl-readout { position: absolute; left: 0; right: 0; text-align: center; pointer-events: none; color: #d9d2c2; font: 600 13px/1.2 ui-rounded, system-ui, sans-serif; letter-spacing: .03em; min-height: 16px; opacity: .85; font-variant-numeric: tabular-nums; }
.chl-dock .chl-ladder { position: static; display: block; flex: 1; min-width: 0; width: auto; height: 44px; }
.chl-btn { flex: none; width: auto; pointer-events: auto; padding: 10px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.14); background: rgba(40, 38, 34, 0.75); color: #efe4c8; font: 600 14px/1 ui-rounded, system-ui, sans-serif; }
.chl-btn:active { transform: scale(.96); }
`;
