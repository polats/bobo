// The rubbed rim, integrated at audio rate. A bowed-resonator model (McIntyre, Schumacher &
// Woodhouse 1983): a fingertip pad (mass on a spring, dragged by the finger bone at the circling
// speed) rubs the rim through a velocity-weakening friction law with static > kinetic friction;
// the rim's tangential velocity at the contact comes from the glass's bending modes. Each sample
// the stick/slip state is solved implicitly (the Friedlander-style intersection of the friction
// curve with the line the two admittances allow), so nothing about the tone is scripted:
//   - lock-in: while the friction curve's negative slope N·|μ'(v)| beats the mode's own damping
//     (the classic single-mode stability criterion Mertz et al. test on a real wineglass), the (2,0)
//     mode self-excites and grows until the rim's velocity swing reaches the finger's speed;
//   - too slow or a dry finger: the pad sticks and lets go in relaxation jerks at its own rate, and
//     each slip kicks the glass: an irregular squeak;
//   - too fast or too light: the curve is flat out there, the mode decays, only contact hiss is left.
// The modes are degenerate pairs (cos nθ, sin nθ). The finger drives whichever combination has its
// tangential antinode under it, so the vibration pattern turns with the finger (one radial node
// follows the contact, as Terwagne & Bush observe on singing bowls), and a slight split between
// the pair makes the note beat.

export const SR = 24000;

export interface Friction {
  /** Static and kinetic (fast-sliding) coefficients, and the speed over which μ falls, m/s. */
  us: number;
  ud: number;
  v0: number;
  /** Relative jitter of the normal force (skin ridges, grit). */
  rough: number;
  /** Viscous rise of μ with sliding speed, s/m (an oil film: the Stribeck curve's far branch). */
  visc: number;
}

// A clean wet fingertip slides with a gentle, wide fall in μ: the regime that sings. A dry,
// slightly oily one grips hard, lets go abruptly (a steep, narrow fall), and past a few cm/s its
// oil film makes friction rise with speed, which damps the glass instead of driving it: it
// judders and squeaks at a crawl and just drags when faster.
export const WET: Friction = { us: 0.7, ud: 0.25, v0: 0.3, rough: 0.04, visc: 0.05 };
export const DRY: Friction = { us: 1.05, ud: 0.7, v0: 0.012, rough: 0.22, visc: 1.4 };

// Fingertip pad: effective moving mass and tangential stiffness/damping of the skin.
const PAD_M = 3e-3;
const PAD_K = 3000;
const PAD_C = 3;

const N_MODES = 4; // (2,0) cos/sin, (3,0) cos/sin

export interface ModeSet {
  /** (2,0) frequency (with water), Hz. */
  f: number;
  /** (3,0) / (2,0) ratio. */
  r3: number;
  /** (2,0) modal mass (with water), kg. */
  M: number;
  Q: number;
  split: number;
}

export class RimSim {
  // Modal states: radial rim amplitude (m) and its velocity, per mode.
  readonly x = new Float64Array(N_MODES);
  readonly v = new Float64Array(N_MODES);
  private k = new Float64Array(N_MODES);
  private c = new Float64Array(N_MODES);
  private m = new Float64Array(N_MODES);
  private n = new Float64Array(N_MODES);
  private w = new Float64Array(N_MODES);
  // Pad: deflection from the finger bone (m) and velocity (m/s, rim frame).
  private e = 0;
  private vp = 0;
  private voicePh = 0;
  private hp = 0;
  private lp = 0;
  private fl = 0;
  private seed = 12345;

  // Inputs, set per frame.
  /** Normal force, N (0 = not touching). */
  N = 0;
  /** Finger bone speed along the rim, m/s (signed). */
  vb = 0;
  /** Contact angle on the rim, radians. */
  phi = 0;
  fr: Friction = { ...WET };
  /** Voice drive on the (2,0) cos mode, newtons (amplitude of a sinusoid at the mode's frequency). */
  voice = 0;

  // Per-block diagnostics.
  stickFrac = 0;
  slips = 0;
  rubPower = 0;
  hiss = 0;

  setModes(ms: ModeSet) {
    const dt = 1 / SR;
    for (let i = 0; i < N_MODES; i++) {
      const hi = i >= 2;
      const order = hi ? 3 : 2;
      const f = ms.f * (hi ? ms.r3 : 1) * (i % 2 ? 1 + ms.split : 1);
      const w = 2 * Math.PI * f;
      // Symplectic Euler runs sharp by ~(ω dt)²/24; pick k so the discrete frequency is exact.
      const wn = (2 / dt) * Math.sin((w * dt) / 2);
      this.k[i] = wn * wn;
      this.w[i] = w;
      this.c[i] = w / (ms.Q * (hi ? 0.6 : 1));
      // Modal mass scales with the wall's kinetic energy per unit radial amplitude, (1 + 1/n²).
      this.m[i] = ms.M * (1 + 1 / (order * order)) / 1.25;
      this.n[i] = order;
    }
  }

  reset() {
    this.x.fill(0);
    this.v.fill(0);
    this.e = this.vp = 0;
  }

  /** Fingertip lands: the pad starts at rest on the rim, undeflected. */
  touch() {
    this.e = 0;
    this.vp = 0;
  }

  /** A tap on the wall at angle θ: a radial impulse J (N·s) shared by the modes by their shapes there. */
  strike(theta: number, J: number) {
    for (let i = 0; i < N_MODES; i++) {
      const s = i % 2 ? Math.sin(this.n[i] * theta) : Math.cos(this.n[i] * theta);
      this.v[i] += (J * s) / this.m[i];
    }
  }

  private rand() {
    // xorshift: cheap audio-rate noise.
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 4294967296 - 0.5;
  }

  /** Integrate `count` samples, writing the radiated sound to L/R from `offset`. */
  run(count: number, L: Float32Array | null, R: Float32Array | null, offset = 0) {
    const dt = 1 / SR;
    const { x, v, k, c, m, n } = this;
    const fr = this.fr;
    const dmu = fr.us - fr.ud;
    const vb = this.vb;
    const touching = this.N > 1e-4;
    // Tangential mode shapes at the contact: u_t = -(u_r/n) sin nθ for the cos mode, +cos for sin.
    const g = [0, 0, 0, 0];
    for (let i = 0; i < N_MODES; i++) g[i] = i % 2 ? Math.cos(n[i] * this.phi) / n[i] : -Math.sin(n[i] * this.phi) / n[i];
    let Yr = 0;
    for (let i = 0; i < N_MODES; i++) Yr += (g[i] * g[i]) / m[i];
    Yr *= dt;
    const Yp = dt / PAD_M;
    const Y = Yp + Yr;
    let stuck = 0, slips = 0, power = 0, hiss = 0;
    let wasStuck = false;
    const vw = this.w[0] * dt;
    // Listening angles for the two channels, 45° apart so the quadrupole never nulls both.
    const cl2 = Math.cos(2 * 0.3), sl2 = Math.sin(2 * 0.3), cr2 = Math.cos(2 * 1.085), sr2 = Math.sin(2 * 1.085);
    for (let s = 0; s < count; s++) {
      // Free step (no friction) for the modes and the pad.
      let vr = 0;
      for (let i = 0; i < N_MODES; i++) {
        let f = -k[i] * x[i] - c[i] * v[i];
        if (i === 0 && this.voice) f += this.voice * Math.sin(this.voicePh) / m[i];
        v[i] += dt * f;
        vr += g[i] * v[i];
      }
      this.voicePh += vw;
      if (this.voicePh > 6.283185307179586) this.voicePh -= 6.283185307179586;
      let F = 0;
      if (touching) {
        const vp = this.vp + (dt * (-PAD_K * this.e - PAD_C * (this.vp - vb))) / PAD_M;
        const wStar = vp - vr;
        const Nn = this.N * (1 + fr.rough * 2 * this.rand());
        const Fstick = wStar / Y;
        let u = 0;
        if (Math.abs(Fstick) <= fr.us * Nn) {
          F = Fstick;
          stuck++;
          wasStuck = true;
        } else {
          // Slip: u + Y·N·μ(u) = |w*| with μ(u) = μd + (μs − μd)·v0/(v0 + u) + visc·u; the
          // quadratic a·u² + b·u + c = 0 has exactly one positive root.
          const A = Math.abs(wStar);
          const B = Y * Nn * fr.ud - A;
          const a = 1 + Y * Nn * fr.visc;
          const b = a * fr.v0 + B;
          const c0 = fr.v0 * B + Y * Nn * dmu * fr.v0;
          u = (-b + Math.sqrt(Math.max(0, b * b - 4 * a * c0))) / (2 * a);
          F = Math.sign(wStar) * Nn * (fr.ud + (dmu * fr.v0) / (fr.v0 + u) + fr.visc * u);
          if (wasStuck) slips++;
          wasStuck = false;
        }
        // The pad pulls the rim along (+F) and is held back (-F).
        this.vp = vp - (dt * F) / PAD_M;
        this.e += dt * (this.vp - vb);
        for (let i = 0; i < N_MODES; i++) v[i] += (dt * g[i] * F) / m[i];
        power += F * (g[0] * v[0] + g[1] * v[1]);
        hiss += u * Nn;
        // Rough skin sliding on glass: broadband noise that scales with slip speed and load.
        const nz = this.rand() * u * Nn;
        this.hp += (nz - this.hp) * 0.35;
      } else {
        this.e *= 0.99;
        this.vp = vb;
        this.hp *= 0.9;
      }
      for (let i = 0; i < N_MODES; i++) x[i] += dt * v[i];
      if (L && R) {
        // Radiated pressure ~ wall velocity, seen from two angles, plus the contact noise.
        const a2l = v[0] * cl2 + v[1] * sl2, a2r = v[0] * cr2 + v[1] * sr2;
        const a3 = (v[2] + v[3]) * 0.7;
        this.lp += (this.hp - this.lp) * 0.5;
        // The contact force also rings the wall's many higher modes, which we don't track; its
        // high-passed jerk stands in for them: periodic when locked (a brighter tone), a train of
        // irregular clicks when the stick-slip is raucous (the squeak).
        this.fl += (F - this.fl) * 0.3;
        const nz = (this.hp - this.lp) * 0.4 + (F - this.fl) * 0.12;
        L[offset + s] = a2l + a3 + nz;
        R[offset + s] = a2r + a3 - nz;
      }
    }
    this.stickFrac = count ? stuck / count : 0;
    this.slips = slips;
    this.rubPower = count ? power / count : 0;
    this.hiss = count ? hiss / count : 0;
  }

  /** Radial amplitude envelope of the (2,0) pair (m) and the pattern's orientation (rad). */
  amp2() {
    const w = this.w[0];
    const a = Math.hypot(this.x[0], this.v[0] / w), b = Math.hypot(this.x[1], this.v[1] / w);
    return Math.hypot(a, b);
  }

  /**
   * Complex (2,0) amplitudes z = x − i·v/ω for both members: the displayed pattern is
   * Re[(z0 cos 2θ + z1 sin 2θ) e^{iωt}].
   */
  pattern(out: Float64Array) {
    const w = this.w[0];
    out[0] = this.x[0];
    out[1] = -this.v[0] / w;
    out[2] = this.x[1];
    out[3] = -this.v[1] / w;
    return out;
  }

  amp3() {
    const w = this.w[2];
    return Math.hypot(this.x[2], this.v[2] / w, this.x[3], this.v[3] / w);
  }
}
