// Crumbs of popped coat lying on the card. The tool ploughs them: any crumb inside the contact is
// moved to its rim and carried with the tool, so crumbs pile up along a coin's edge and are left in
// a ridge where the stroke ends. Breath and two-finger puffs blow them radially; past the card
// edge they tumble off and fade. Positions are in coat cells.

export const MAX_CRUMBS = 2600;

export interface CrumbParams {
  /** Crumbs from one popped flake (fractional = chance of one more). */
  perFlake: number;
  /** How much of the tool's speed a ploughed crumb picks up. */
  push: number;
  /** Sliding friction on the card (per second). */
  friction: number;
  /** Strength of breath and two-finger puffs. */
  blow: number;
  /** 0 = crumbs drop like grit; 1 = leaf: floats down slowly, swaying, and lifts at the slightest air. */
  flutter: number;
}

export class Crumbs {
  readonly x = new Float32Array(MAX_CRUMBS);
  readonly y = new Float32Array(MAX_CRUMBS);
  readonly z = new Float32Array(MAX_CRUMBS);
  private readonly vx = new Float32Array(MAX_CRUMBS);
  private readonly vy = new Float32Array(MAX_CRUMBS);
  private readonly vz = new Float32Array(MAX_CRUMBS);
  readonly size = new Float32Array(MAX_CRUMBS);
  readonly rot = new Float32Array(MAX_CRUMBS);
  private readonly spin = new Float32Array(MAX_CRUMBS);
  readonly shade = new Float32Array(MAX_CRUMBS);
  /** 1 while on the card, falls to 0 once it has gone over the edge. */
  readonly life = new Float32Array(MAX_CRUMBS);
  private readonly off = new Uint8Array(MAX_CRUMBS);
  /** Seconds a crumb has lain still on the card (sticky crumbs glue back down). */
  readonly rest = new Float32Array(MAX_CRUMBS);
  count = 0;
  /** Crumbs that came to rest or hit the card this frame (ticks). */
  landed = 0;
  /** Crumbs swept or blown off the card this frame. */
  lost = 0;
  /** Crumbs under the tool this frame. */
  ploughed = 0;

  clear() {
    this.count = 0;
  }

  /** `gone`: already flying off the card (the coat bursting away when a card finishes). */
  add(x: number, y: number, size: number, vx: number, vy: number, hop: number, shade: number, gone = false) {
    let i = this.count;
    if (i >= MAX_CRUMBS) {
      // Recycle a random small crumb rather than refuse a new one.
      i = (Math.random() * MAX_CRUMBS) | 0;
      for (let k = 0; k < 4 && this.size[i] > 1.6; k++) i = (Math.random() * MAX_CRUMBS) | 0;
    } else this.count++;
    this.x[i] = x;
    this.y[i] = y;
    this.z[i] = 0.01;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = hop;
    this.size[i] = size;
    this.rot[i] = Math.random() * Math.PI * 2;
    this.spin[i] = (Math.random() - 0.5) * 18;
    this.shade[i] = shade;
    this.life[i] = gone ? 1 + Math.random() * 0.5 : 1;
    this.off[i] = gone ? 1 : 0;
    this.rest[i] = 0;
  }

  /** Is this crumb lying on the card (not flying off)? */
  onCard(i: number) {
    return !this.off[i] && this.z[i] <= 0 && this.life[i] > 0;
  }

  /** Remove a crumb (it has glued itself back down). */
  absorb(i: number) {
    this.life[i] = 0;
    this.off[i] = 1;
  }

  /** Plough the crumbs under a tool at (x, y) moving with (tvx, tvy) cells/s along (ux, uy). */
  plough(x: number, y: number, ux: number, uy: number, tvx: number, tvy: number, r: number, flat: number, p: CrumbParams) {
    const rb = Math.max(1.2, r * (1 - flat * 0.82));
    const reach = Math.max(r, rb) + 2;
    const { x: X, y: Y, z: Z } = this;
    for (let i = 0; i < this.count; i++) {
      if (this.off[i] || Z[i] > 0.6) continue;
      const ox = X[i] - x, oy = Y[i] - y;
      if (Math.abs(ox) > reach || Math.abs(oy) > reach) continue;
      const along = ox * ux + oy * uy;
      const across = ox * -uy + oy * ux;
      const s = this.size[i] * 0.4;
      const ea = rb + s, ec = r + s;
      if (Math.abs(along) >= ea || Math.abs(across) >= ec) continue;
      // Push it out of the contact through the nearest side, favouring the front of the stroke.
      const fa = (ea - Math.abs(along)) / ea, fc = (ec - Math.abs(across)) / ec;
      let na = along, nc = across;
      if (fa < fc * 1.6 || along > 0) na = along >= 0 ? ea : -ea;
      else nc = across >= 0 ? ec : -ec;
      X[i] = x + ux * na - uy * nc;
      Y[i] = y + uy * na + ux * nc;
      const k = p.push * (na > 0 ? 1 : 0.25);
      this.vx[i] = tvx * k + (Math.random() - 0.5) * 30;
      this.vy[i] = tvy * k + (Math.random() - 0.5) * 30;
      if (Math.random() < 0.04 + p.flutter * 0.25) this.vz[i] = (8 + Math.random() * 12) * (1 + p.flutter * 0.5);
      this.spin[i] += (Math.random() - 0.5) * 20;
      this.ploughed++;
    }
  }

  /** A puff of air from (x, y): radial push that falls off with distance, and a little lift. */
  blow(x: number, y: number, radius: number, power: number, dt: number, flutter = 0) {
    for (let i = 0; i < this.count; i++) {
      if (this.off[i]) continue;
      const ox = this.x[i] - x, oy = this.y[i] - y;
      const d = Math.hypot(ox, oy) + 1;
      if (d > radius * 3) continue;
      const f = ((power * 900 * dt) / (1 + (d / radius) ** 2) / Math.max(0.6, this.size[i] * 0.4)) * (1 + flutter * 1.5);
      this.vx[i] += (ox / d) * f;
      this.vy[i] += (oy / d) * f;
      if (Math.random() < f * 0.02 * (1 + flutter * 6)) this.vz[i] += (4 + Math.random() * 8) * (1 + flutter);
    }
  }

  /** Blow everything off the card (finishing a card): every crumb flies off and fades. */
  scatter(cx: number, cy: number) {
    for (let i = 0; i < this.count; i++) {
      const ox = this.x[i] - cx, oy = this.y[i] - cy;
      const d = Math.hypot(ox, oy) + 1;
      const s = 180 + Math.random() * 260;
      this.vx[i] = (ox / d) * s;
      this.vy[i] = (oy / d) * s;
      this.vz[i] = 10 + Math.random() * 20;
      this.off[i] = 1;
      this.life[i] = 1 + Math.random() * 0.4;
    }
  }

  step(dt: number, p: CrumbParams, inside: (x: number, y: number) => boolean) {
    this.landed = 0;
    this.lost = 0;
    const drag = Math.exp(-p.friction * dt);
    for (let i = 0; i < this.count; i++) {
      if (this.off[i]) {
        this.life[i] -= dt * 2.4;
        this.vz[i] -= 60 * dt;
        this.z[i] += this.vz[i] * dt;
        this.x[i] += this.vx[i] * dt;
        this.y[i] += this.vy[i] * dt;
        this.rot[i] += this.spin[i] * dt;
        continue;
      }
      const airborne = this.z[i] > 0;
      if (airborne) {
        // Leaf falls slowly against the air and sways side to side as it goes.
        this.vz[i] -= 90 * dt * (1 - p.flutter * 0.8);
        if (p.flutter > 0) {
          const air = Math.exp(-p.flutter * 2.5 * dt);
          this.vx[i] = this.vx[i] * air + Math.sin(this.rot[i] * 1.3 + i) * 40 * p.flutter * dt;
          this.vy[i] = this.vy[i] * air + Math.cos(this.rot[i] * 0.9 + i) * 25 * p.flutter * dt;
          this.vz[i] = Math.max(this.vz[i], -18);
        }
        this.z[i] += this.vz[i] * dt;
        if (this.z[i] <= 0) {
          this.z[i] = 0;
          this.vz[i] = 0;
          this.landed++;
        }
      }
      const v2 = this.vx[i] * this.vx[i] + this.vy[i] * this.vy[i];
      if (!airborne) {
        this.vx[i] *= drag;
        this.vy[i] *= drag;
        if (v2 < 4) {
          this.vx[i] = this.vy[i] = 0;
          this.rest[i] += dt;
        } else {
          this.rest[i] = 0;
          this.rot[i] += this.spin[i] * dt * Math.min(1, Math.sqrt(v2) / 60);
        }
      } else this.rot[i] += this.spin[i] * dt;
      this.x[i] += this.vx[i] * dt;
      this.y[i] += this.vy[i] * dt;
      if (!inside(this.x[i], this.y[i])) {
        this.off[i] = 1;
        this.vz[i] = 2;
        this.lost++;
      }
    }
    // Drop dead crumbs, swapping in the last one.
    for (let i = 0; i < this.count; i++) {
      if (this.life[i] > 0) continue;
      const j = --this.count;
      this.x[i] = this.x[j];
      this.y[i] = this.y[j];
      this.z[i] = this.z[j];
      this.vx[i] = this.vx[j];
      this.vy[i] = this.vy[j];
      this.vz[i] = this.vz[j];
      this.size[i] = this.size[j];
      this.rot[i] = this.rot[j];
      this.spin[i] = this.spin[j];
      this.shade[i] = this.shade[j];
      this.life[i] = this.life[j];
      this.off[i] = this.off[j];
      this.rest[i] = this.rest[j];
      i--;
    }
  }

  /** Crumbs resting on the card, for the "blow them off" hint. */
  resting() {
    let n = 0;
    for (let i = 0; i < this.count; i++) if (!this.off[i]) n++;
    return n;
  }
}
