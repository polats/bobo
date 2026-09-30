// The wand's film under a breath, as a lumped model with real soap-film numbers.
//
// Breath at speed v presses on the film with its stagnation pressure ½ρv². The film pushes back
// with its Laplace pressure: a spherical cap of height H over the ring (radius a) holds 8σH/(a²+H²)
// (two surfaces), which peaks at the hemisphere, 4σ/a. Below that the film just bows to an
// equilibrium; above it there is no equilibrium, and past the hemisphere a bubble of radius R needs
// only 4σ/R, so it runs away and inflates. Stop blowing and the Laplace pressure pushes the air back
// out: a half-blown bubble shrinks back into the ring.
//
// Air flows in (or out) at a rate set by the pressure difference. The breath's push on the growing
// film (∝ ½ρv² times the area it catches) pulls it away from the ring against the rim's tension,
// 2·2πaσ; once the neck is stretched past about 0.8a it pinches off. Inflow grows with v but the push
// grows with v², so a gentle breath fills one big bubble before the push wins, and a hard one
// snaps off small bubbles one after another. Nothing counts bubbles: sizes and rates come out of that.

export const SIGMA = 0.025; // N/m, soapy water
const RHO_AIR = 1.2;
/** Film liquid density, for the Culick speed. */
export const RHO_WATER = 1000;

export interface BlowConfig {
  /** Ring radius, m. */
  a: number;
  /** Breath speed at blow = 1, m/s. */
  vMax: number;
  /** Largest inflow through the ring, m³/s, and the pressure over which it saturates, Pa. */
  qSat: number;
  pSat: number;
  /** Share of the breath's pressure that pushes the film away, and how that grows with bubble size. */
  push: number;
  pushGrow: number;
  /** Neck drag, N·s/m. */
  neckDrag: number;
  /** Neck stretch (in ring radii) at which it pinches off. */
  pinch: number;
}

export const DEFAULT_BLOW: BlowConfig = {
  a: 0.02,
  vMax: 13,
  qSat: 3.5e-4,
  pSat: 15,
  push: 0.2,
  pushGrow: 0.19,
  neckDrag: 0.03,
  pinch: 0.8,
};

export interface Pinch {
  /** Radius of the free bubble, m. */
  radius: number;
  /** Speed it leaves the ring at, m/s. */
  speed: number;
  /** Film area it takes with it, m². */
  area: number;
}

export class Inflation {
  /** Air volume pushed past the ring plane, m³. */
  volume = 0;
  /** Neck stretch beyond the attached shape, m. */
  neck = 0;
  neckSpeed = 0;
  /** Visual bulge height with a little membrane wobble on top of the quasi-static shape, m. */
  shown = 0;
  private shownV = 0;
  /** Breath pressure this step, Pa. */
  pressure = 0;
  /** Inflow this step, m³/s. */
  flow = 0;

  constructor(public cfg: BlowConfig = DEFAULT_BLOW) {}

  get a() {
    return this.cfg.a;
  }
  /** Hemisphere volume: the most a cap can hold. */
  get vHemi() {
    return (2 / 3) * Math.PI * this.a ** 3;
  }
  get bubble() {
    return this.volume > this.vHemi;
  }

  /** Cap height for a volume below the hemisphere (Newton on V = πH(3a²+H²)/6). */
  capHeight(V = this.volume) {
    const a = this.a;
    let H = Math.min(a, (2 * V) / (Math.PI * a * a));
    for (let i = 0; i < 8; i++) {
      const f = (Math.PI * H * (3 * a * a + H * H)) / 6 - V;
      const df = (Math.PI * (a * a + H * H)) / 2;
      H = Math.max(0, Math.min(a, H - f / df));
    }
    return H;
  }

  /** Sphere radius once past the hemisphere: V = πh²(3R−h)/3 with h = R + √(R²−a²). */
  sphereRadius(V = this.volume) {
    const a = this.a;
    let lo = a, hi = a * 20;
    for (let i = 0; i < 40; i++) {
      const R = 0.5 * (lo + hi);
      const h = R + Math.sqrt(R * R - a * a);
      const v = (Math.PI * h * h * (3 * R - h)) / 3;
      if (v < V) lo = R;
      else hi = R;
    }
    return 0.5 * (lo + hi);
  }

  /** Film area beyond the ring, m² (a spherical cap: 2πR_c·height). */
  area() {
    const a = this.a;
    if (!this.bubble) {
      const H = this.capHeight();
      return Math.PI * (a * a + H * H);
    }
    const R = this.sphereRadius();
    return 2 * Math.PI * R * (R + Math.sqrt(R * R - a * a));
  }

  /** Laplace pressure the film holds now, Pa. */
  laplace() {
    const a = this.a;
    if (!this.bubble) {
      const H = this.capHeight();
      return (8 * SIGMA * H) / (a * a + H * H);
    }
    return (4 * SIGMA) / this.sphereRadius();
  }

  /** Critical breath (0..1) that first pops the film past its hemisphere. */
  get threshold() {
    return Math.sqrt((2 * 4 * SIGMA) / this.a / RHO_AIR) / this.cfg.vMax;
  }

  reset() {
    this.volume = 0;
    this.neck = 0;
    this.neckSpeed = 0;
  }

  /** Advance by dt with breath 0..1. Returns a pinch-off if one happened. */
  step(dt: number, blow: number): Pinch | null {
    const c = this.cfg;
    const a = c.a;
    const v = c.vMax * Math.max(0, blow);
    const P = 0.5 * RHO_AIR * v * v;
    this.pressure = P;
    const dP = P - this.laplace();
    // Inflow saturates: a hard breath mostly splashes round the film rather than into it.
    const q = c.qSat * Math.tanh(dP / c.pSat) * (dP < 0 ? 0.6 : 1);
    this.flow = q;
    this.volume = Math.max(0, this.volume + q * dt);
    // Push on the film vs the neck's tension (two surfaces round the ring).
    const R = this.bubble ? this.sphereRadius() : a;
    const push = c.push * P * Math.PI * (a * a + c.pushGrow * Math.max(0, R * R - a * a));
    const tension = 4 * Math.PI * a * SIGMA;
    const enough = this.volume > 0.25 * this.vHemi;
    this.neckSpeed = enough ? (push - tension) / c.neckDrag : -this.neck * 8;
    this.neck = Math.max(0, this.neck + this.neckSpeed * dt);
    if (this.neckSpeed < 0 && this.neck <= 0) this.neckSpeed = 0;
    // The visible bulge follows the quasi-static shape through a light spring (the film has a little
    // inertia from the air it carries), so puffs and pinch-offs wobble.
    const target = this.bubble ? a : this.capHeight();
    const w = 38, z = 0.22;
    this.shownV += (w * w * (target - this.shown) - 2 * z * w * this.shownV) * dt;
    this.shown += this.shownV * dt;
    if (this.neck > c.pinch * a) {
      const V = this.volume;
      const area = this.area();
      const out: Pinch = { radius: Math.cbrt((3 * V) / (4 * Math.PI)), speed: Math.min(1.5, this.neckSpeed), area };
      this.reset();
      // The new film snaps back flat and overshoots.
      this.shownV = -1.2 * Math.max(0.2, Math.min(1, out.speed));
      return out;
    }
    return null;
  }

  /** Wobble kick from outside (a dip, a pop). */
  kick(v: number) {
    this.shownV += v;
  }
}
