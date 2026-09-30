// Sound and touch from the sim's own events: micro-cracks tick as layers give (their energies are the
// released strain energy), a crack snaps, each new piece rings with its free-free bending modes
// (f ∝ 1/L², so short shards ring high), and pieces tick on the table with the modes their strike
// point excites.

import type { ToyContext } from '../../shell/types';
import type { Mode } from '../../shell/sound';
import { BAR_BL, barShape, type Mat } from './materials';
import type { Rod, World } from './sim';

export class SnapAudio {
  private lastHaptic = 0;
  private lastHit = new Map<number, number>();
  private now = 0;
  /** Event counts (dev hook). */
  readonly counts = { micro: 0, crack: 0, ring: 0, hit: 0, tick: 0 };

  constructor(private ctx: ToyContext) {}

  /** Energy of a full crack in this material: the strand's stored energy at its limit curvature. */
  private ref(m: Mat, r: Rod) {
    return 0.5 * r.EI * m.kc * m.kc * m.L;
  }

  frame(w: World, t: number, panOf: (x: number) => number) {
    this.now = t;
    const { sound } = this.ctx;
    // Micro-cracks: acoustic emission before the break (and the fibres of a hinge letting go).
    let bigMicro = 0;
    for (const m of w.micros) {
      const e = m.energy / this.ref(m.rod.mat, m.rod);
      const gain = Math.min(1, 1.6 * Math.pow(e * 40, 0.45));
      if (gain < 0.04) continue;
      sound.crumple(gain, { pan: panOf(m.x), stiffness: m.rod.mat.fibrous ? 0.35 : 0.85 });
      this.counts.micro++;
      bigMicro = Math.max(bigMicro, gain);
    }
    if (bigMicro > 0.35 && t - this.lastHaptic > 0.05) {
      this.ctx.haptic('light');
      this.lastHaptic = t;
    }
    // Cracks: the snap, then both pieces ringing.
    let cracked = false;
    for (const c of w.cracks) {
      const m = c.rod.mat;
      const e = Math.min(1, Math.sqrt(c.energy / this.ref(m, c.rod)) * 2.2);
      sound.play('snap', { pitch: m.crackPitch * (0.9 + Math.random() * 0.2) * (c.first ? 1 : 1.12), gain: 0.35 + 0.65 * e, pan: panOf(c.x) });
      this.counts.crack++;
      this.ring(c.a, 1, 0.55 * (0.4 + e), panOf(c.x), 1);
      this.ring(c.b, 0, 0.55 * (0.4 + e), panOf(c.x), 1);
      cracked = true;
    }
    if (cracked) {
      this.ctx.haptic('heavy');
      this.lastHaptic = t;
    }
    // Pieces landing and skittering on the table.
    for (const h of w.hits) {
      const last = this.lastHit.get(h.rod.id) ?? -1;
      if (t - last < 0.035) continue;
      const s = Math.min(1, h.speed / 1.2);
      if (s < 0.04) continue;
      this.lastHit.set(h.rod.id, t);
      this.counts.hit++;
      this.ring(h.rod, h.node / Math.max(1, h.rod.n - 1), 0.12 + 0.6 * s, panOf(h.rod.x[h.node]), s);
      if (s > 0.5 && t - this.lastHaptic > 0.06) {
        this.ctx.haptic('light');
        this.lastHaptic = t;
      }
    }
    if (this.lastHit.size > 200) this.lastHit.clear();
  }

  /** Free-free bar modes of a piece, excited at fraction u along it (0 or 1 = an end). */
  ring(r: Rod, u: number, gain: number, pan: number, strike: number) {
    const m = r.mat;
    const L = Math.max(r.ds, r.length);
    const partials: Mode[] = [];
    for (let k = 0; k < BAR_BL.length; k++) {
      const f = ((BAR_BL[k] * BAR_BL[k]) / (2 * Math.PI * L * L)) * r.cb;
      if (f > 15000) break;
      if (f < 30) continue;
      const shape = Math.abs(barShape(k, u)) / 2;
      // Constant Q: every mode loses the same fraction per cycle, so T60 = 2.2 Q / f.
      const decay = Math.min(2.5, (2.2 * m.Q) / f);
      partials.push({ freq: f * (0.99 + Math.random() * 0.02), amp: shape / Math.pow(k + 1, 0.7), decay });
    }
    if (!partials.length) {
      // Shards too short to ring in the audible band: a dry tick.
      this.ctx.sound.play('tick', { gain: gain * 0.6, pitch: 1.5, pan });
      this.counts.tick++;
      return;
    }
    this.ctx.sound.modes(partials, { gain, pan, strike });
    this.counts.ring++;
  }

  /** Tension you feel: continuous haptics rising with the highest stress on a held rod. */
  tension(w: World) {
    let s = 0;
    for (const r of w.rods) if (r.grips.length) s = Math.max(s, r.maxS);
    if (s < 0.25) return s;
    const u = Math.min(1, (s - 0.25) / 0.75);
    this.ctx.hapticLevel(0.06 + 0.8 * u * u, 0.25 + 0.6 * u);
    return s;
  }

  get time() {
    return this.now;
  }
}
