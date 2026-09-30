import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { SnapAudio } from './audio';
import { MATS, type MatId } from './materials';
import { Painter, makeView, worldHalfWidth, type View } from './render';
import { Rod, World } from './sim';
import { trial, trials, type TrialOpts } from './trials';

export const snapToy: Toy = {
  id: 'snap',
  title: 'Snap!',
  blurb:
    'Pinch both ends of dry spaghetti and bend. It almost never breaks in two: the snap-back wave from the first crack breaks it again. Twist it first and it snaps cleanly in half. Try a bundle, a twig, a chopstick or pencil lead.',
  tech: 'Discrete Kirchhoff rods (explicit Euler-Bernoulli bending, damped twist waves, direct inextensibility solve) with a combined bend-twist fracture stress · Canvas 2D',
  swatch: 'linear-gradient(160deg,#e9d3b2 0 55%,#f1d27e 55% 58%,#e9d3b2 58% 70%,#b07a48 70%)',
  refs: [
    {
      short: 'Audoly & Neukirch 2005',
      title: 'Audoly & Neukirch — Fragmentation of Rods by Cascading Cracks: Why Spaghetti Does Not Break in Half (PRL 2005)',
      url: 'https://doi.org/10.1103/PhysRevLett.95.095505',
      use: 'The mechanism the sim reproduces rather than scripts: releasing a bent rod at a crack sends a flexural wave that raises the curvature further along and breaks it again.',
    },
    {
      short: 'Heisser et al. 2018',
      title: 'Heisser, Patil, Stoop, Villermaux & Dunkel — Controlling Fracture Cascades through Twisting and Quenching (PNAS 2018)',
      url: 'https://doi.org/10.1073/pnas.1802831115',
      use: 'The model: planar Kirchhoff rod, critically damped twist wave, effective stress σ² = ¼E²r²κ² + ½µ²r²θ′², minimum fragment length λ₀ ≈ 3 cm scaling as v^(−1/4), and the measured spaghetti properties.',
    },
    {
      short: 'Tsai et al. 2016',
      title: 'Tsai et al. — Acoustic Emission from Breaking a Bamboo Chopstick (PRL 2016)',
      url: 'https://doi.org/10.1103/PhysRevLett.116.035501',
      use: 'The crackle before the break: a layered, fibrous cross-section cracking layer by layer, each layer’s released energy a click.',
    },
    {
      short: 'Deul et al. 2018',
      title: 'Deul, Kugelstadt, Weiler & Bender — Direct Position-Based Solver for Stiff Rods (CGF 2018)',
      url: 'https://doi.org/10.1111/cgf.13326',
      use: 'Solving a rod’s constraints directly in linear time: here the length constraints of each chain as one tridiagonal system per substep, with the true axial compliance.',
    },
    {
      short: 'van den Doel 1998',
      title: 'The Sounds of Physical Shapes (van den Doel & Pai, Presence 1998)',
      url: 'https://doi.org/10.1162/105474698565794',
      use: 'Each piece rings as a sum of decaying free-free bar modes (f ∝ 1/L²), weighted by the mode shape where it is struck.',
    },
  ],
  async create(ctx) {
    return new Snap(ctx);
  },
};

const GRAB_CSS = 30;
/** Twist added per radian the finger pair turns (hands wring the ends in opposite directions). */
const TWIST_GAIN = 3;

interface Settings extends Record<string, unknown> {
  mat: MatId;
  bundle: number;
  pretwist: number;
  slowmo: 'off' | 'slow' | 'deep';
}

class Snap implements ToyInstance {
  private g: CanvasRenderingContext2D;
  private view: View;
  private world = new World();
  private painter: Painter;
  private audio: SnapAudio;
  private s: Settings = { mat: 'spaghetti', bundle: 1, pretwist: 0, slowmo: 'deep' };
  private pair: { a: number; b: number; psi: number } | null = null;
  private pre: { a: number; b: number; left: number } | null = null;
  private simMs = 0;
  private hint: HTMLElement;
  private style: HTMLStyleElement;
  private strands = 0;
  private cracksTotal = 0;
  private time = 0;
  private log: Record<string, unknown>[] = [];

  constructor(private ctx: ToyContext) {
    const g = ctx.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('Canvas 2D is not available.');
    this.g = g;
    this.painter = new Painter(g);
    this.audio = new SnapAudio(ctx);
    this.view = makeView(ctx.canvas.width, ctx.canvas.height, ctx.pixelRatio);
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'snap-hint';
    this.hint.textContent = 'Pinch both ends and bend · turn your fingers to twist it first';
    ctx.overlay.appendChild(this.hint);
    const p = ctx.panel;
    p.choice(
      'Material',
      (Object.keys(MATS) as MatId[]).map((k) => ({ value: k, label: MATS[k].label })),
      this.s.mat,
      (v) => {
        this.s.mat = v;
        this.reset();
      },
    );
    p.slider(this.s, 'bundle', { label: 'Bundle', min: 1, max: 10, step: 1, onChange: () => this.reset() });
    p.slider(this.s, 'pretwist', { label: 'Twist on grab (°)', min: 0, max: 360, step: 10 });
    p.choice(
      'Slow motion',
      [
        { value: 'off', label: 'Off' },
        { value: 'slow', label: 'Slow' },
        { value: 'deep', label: 'Very slow' },
      ],
      this.s.slowmo,
      (v) => {
        this.s.slowmo = v;
        this.world.slowmo = v;
      },
    );
    p.action('New strands', () => this.reset());
    this.reset();
    if (import.meta.env.DEV) this.devHook();
  }

  private reset() {
    const w = new World();
    w.slowmo = this.s.slowmo;
    const hw = worldHalfWidth(this.view);
    w.left = -hw;
    w.right = hw;
    w.floor = 0;
    const mat = MATS[this.s.mat];
    const n = Math.round(this.s.bundle);
    for (let k = 0; k < n; k++) {
      const depth = 0.5 + (k - (n - 1) / 2) * 0.03;
      const x0 = -mat.L / 2 + (Math.random() - 0.5) * 0.006;
      const a = (Math.random() - 0.5) * 0.01;
      const r = Rod.strand(mat, x0, mat.r * 1.05 + Math.max(0, -Math.sin(a) * mat.L) + 0.0015, a, this.strands++, depth, Math.random);
      w.rods.push(r);
    }
    this.world = w;
    this.pair = this.pre = null;
  }

  // ---------------------------------------------------------------- input

  private input(dt: number) {
    const v = this.view, w = this.world;
    const seen = new Set<number>();
    for (const p of this.ctx.pointers.active.values()) {
      seen.add(p.id);
      const sx = p.x * v.width, sy = (1 - p.y) * v.height;
      const fx = (sx - v.width / 2) / v.ppm, fy = (v.floorY - sy) / v.ppm;
      let f = w.fingers.get(p.id);
      if (!f) {
        f = { x: fx, y: fy, tw: 0, lx: fx, ly: fy, ltw: 0 };
        w.fingers.set(p.id, f);
        this.grab(p.id, sx, sy);
      } else {
        f.x = fx;
        f.y = Math.max(fy, -0.01);
      }
    }
    for (const id of [...w.fingers.keys()]) if (!seen.has(id)) w.release(id);
    // Two fingers holding the same rod: turning the pair twists the ends against each other.
    let pair: { a: number; b: number } | null = null;
    for (const r of w.rods) {
      if (r.grips.length === 2 && r.grips[0].finger !== r.grips[1].finger) {
        const [a, b] = r.grips[0].node < r.grips[1].node ? [r.grips[0].finger, r.grips[1].finger] : [r.grips[1].finger, r.grips[0].finger];
        pair = { a, b };
        break;
      }
    }
    if (!pair) {
      this.pair = this.pre = null;
      return;
    }
    const fa = w.fingers.get(pair.a)!, fb = w.fingers.get(pair.b)!;
    const psi = Math.atan2(fb.y - fa.y, fb.x - fa.x);
    if (this.pair && this.pair.a === pair.a && this.pair.b === pair.b) {
      let d = psi - this.pair.psi;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      fa.tw -= (TWIST_GAIN * d) / 2;
      fb.tw += (TWIST_GAIN * d) / 2;
      w.turnGrips(pair.a, d);
      w.turnGrips(pair.b, d);
    } else if (this.s.pretwist > 0) {
      this.pre = { ...pair, left: (this.s.pretwist * Math.PI) / 180 };
    }
    this.pair = { ...pair, psi };
    // "Twist on grab": wring the ends over about half a second.
    if (this.pre) {
      const q = Math.min(this.pre.left, 12 * dt);
      fa.tw -= q / 2;
      fb.tw += q / 2;
      this.pre.left -= q;
      if (this.pre.left <= 0) this.pre = null;
    }
  }

  private grab(id: number, sx: number, sy: number) {
    const v = this.view, w = this.world;
    const rad = GRAB_CSS * v.dpr;
    const near: { r: Rod; i: number; d: number }[] = [];
    for (const r of w.rods) {
      if (r.grips.length >= 2) continue;
      let best = -1, bd = Infinity;
      for (let i = 0; i < r.n; i++) {
        const x = v.width / 2 + r.x[i] * v.ppm, y = v.floorY - r.y[i] * v.ppm - r.depth * v.band;
        const d = Math.hypot(x - sx, y - sy);
        if (d < bd) (bd = d), (best = i);
      }
      if (best < 0 || bd > rad) continue;
      // Pinching near an end takes the end itself (a clamp), not the node beside it.
      const e0 = Math.hypot(v.width / 2 + r.x[0] * v.ppm - sx, v.floorY - r.y[0] * v.ppm - r.depth * v.band - sy);
      const e1 = Math.hypot(v.width / 2 + r.x[r.n - 1] * v.ppm - sx, v.floorY - r.y[r.n - 1] * v.ppm - r.depth * v.band - sy);
      if (e0 < bd + 12 * v.dpr && e0 <= e1) best = 0;
      else if (e1 < bd + 12 * v.dpr) best = r.n - 1;
      if (r.grips.some((g) => Math.abs(g.node - best) < 3)) continue;
      near.push({ r, i: best, d: bd });
    }
    if (!near.length) return;
    // A bundle comes up together: everything close to the nearest strand.
    const dmin = Math.min(...near.map((c) => c.d));
    for (const c of near) if (c.d <= dmin + 16 * v.dpr) w.grab(c.r, c.i, id);
    this.hint.classList.add('gone');
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.input(dt);
    const w = this.world;
    const t0 = performance.now();
    w.step(dt);
    const ms = performance.now() - t0;
    this.simMs = this.simMs * 0.9 + ms * 0.1;
    // Keep the sim inside a few milliseconds: the quasi-static rods share what is left.
    if (this.simMs > 7) w.budget = Math.max(12000, w.budget * 0.93);
    else if (this.simMs < 4) w.budget = Math.min(120000, w.budget * 1.02);
    const hw = worldHalfWidth(this.view);
    for (const c of w.cracks) {
      // Pieces scatter across the table's depth as they fly.
      for (const p of [c.a, c.b]) if (!p.grips.length) p.depth = Math.max(0.05, Math.min(0.95, p.depth + (Math.random() - 0.5) * 0.25));
      this.cracksTotal++;
      if (import.meta.env.DEV) {
        this.log.push({ strand: c.rod.strand, first: c.first, lambda: +(c.a.lambda * 100).toFixed(2), kappa: +c.kappa.toFixed(1), twist: +((c.twist * c.rod.mat.L * 180) / Math.PI).toFixed(0), t: +(c.t * 1000).toFixed(3), vq: +c.rod.vq.toFixed(4), sigma: +c.rod.sigma.toFixed(3) });
        if (this.log.length > 200) this.log.shift();
      }
    }
    this.audio.frame(w, t, (x) => Math.max(-1, Math.min(1, x / hw)));
    const s = this.audio.tension(w);
    const fingers = [...this.ctx.pointers.active.values()].map((p) => ({ x: p.x * this.view.width, y: (1 - p.y) * this.view.height }));
    this.painter.draw(this.view, w, fingers, t);
    this.status(s);
  }

  private status(s: number) {
    const w = this.world;
    const held = w.rods.find((r) => r.grips.length === 2);
    const parts: string[] = [`${w.rods.length} piece${w.rods.length === 1 ? '' : 's'}`];
    if (held) {
      const tw = ((held.th[held.n - 1] - held.th[0]) * 180) / Math.PI;
      parts.push(`twist ${Math.round(Math.abs(tw))}°`, `strain ${Math.round(s * 100)}%`);
    }
    if (w.rate < 0.99) parts.push(`×${w.rate < 0.01 ? w.rate.toFixed(3) : w.rate.toFixed(2)}`);
    parts.push(`sim ${this.simMs.toFixed(1)}ms`);
    this.ctx.setStatus(parts.join(' · '));
  }

  resize(width: number, height: number) {
    if (width === this.view.width && height === this.view.height) return;
    const first = this.view.width <= 1;
    this.view = makeView(width, height, this.ctx.pixelRatio);
    const hw = worldHalfWidth(this.view);
    this.world.left = -hw;
    this.world.right = hw;
    if (first) this.reset();
  }

  destroy() {
    this.hint.remove();
    this.style.remove();
    delete (window as unknown as Record<string, unknown>).__snap;
  }

  private devHook() {
    const self = this;
    const toCss = (x: number, y: number, depth: number) => {
      const v = self.view;
      const r = self.ctx.canvas.getBoundingClientRect();
      const sx = v.width / 2 + x * v.ppm, sy = v.floorY - y * v.ppm - depth * v.band;
      return [r.left + (sx / v.width) * r.width, r.top + (sy / v.height) * r.height];
    };
    (window as unknown as Record<string, unknown>).__snap = {
      state: () => {
        const w = self.world;
        const per: Record<number, number> = {};
        for (const r of w.rods) per[r.strand] = (per[r.strand] ?? 0) + 1;
        return {
          mat: self.s.mat,
          rods: w.rods.length,
          pieces: per,
          cracks: self.cracksTotal,
          rate: w.rate,
          time: w.time,
          work: w.work,
          budget: Math.round(w.budget),
          simMs: +self.simMs.toFixed(2),
          maxS: Math.max(0, ...w.rods.map((r) => r.maxS)),
          grips: w.rods.reduce((a, r) => a + r.grips.length, 0),
          fingers: w.fingers.size,
          asleep: w.rods.filter((r) => r.asleep).length,
          twist: w.rods.filter((r) => r.grips.length === 2).map((r) => +(((r.th[r.n - 1] - r.th[0]) * 180) / Math.PI).toFixed(1)),
          lengths: w.rods.map((r) => +(r.length * 100).toFixed(1)),
        };
      },
      reset: (o: Partial<Settings> = {}) => {
        Object.assign(self.s, o);
        self.reset();
      },
      /** CSS-pixel positions of each strand's ends (for driving touches). */
      ends: () => self.world.rods.map((r) => ({ strand: r.strand, a: toCss(r.x[0], r.y[0], r.depth), b: toCss(r.x[r.n - 1], r.y[r.n - 1], r.depth) })),
      toCss,
      trial: (o: TrialOpts) => trial(o),
      trials: (o: TrialOpts & { n?: number }) => trials(o),
      world: () => self.world,
      log: () => self.log,
      audio: () => self.audio.counts,
    };
  }
}

const STYLE = `
.snap-hint {
  position: absolute; left: 50%; top: 16%; transform: translateX(-50%);
  max-width: 80%; text-align: center; padding: 8px 14px; border-radius: 14px;
  background: rgba(60, 38, 20, 0.55); color: #fff4e0; font: 500 14px/1.35 system-ui, sans-serif;
  pointer-events: none; transition: opacity 0.6s; backdrop-filter: blur(4px);
}
.snap-hint.gone { opacity: 0; }
`;
