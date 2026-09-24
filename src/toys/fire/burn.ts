// Where the wood is and what's burning: a small CPU cellular automaton on the same grid as the fluid.
// Fire spreads to neighbouring fuel (mostly upward), eats fuel, leaves glowing char, and water puts it out.

export interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

export class Burn {
  readonly fuel: Float32Array; // 0..1 wood remaining
  readonly heat: Float32Array; // 0..1 how hard this cell is burning
  readonly char: Float32Array; // 0..1 burnt-ness (for the glowing-ember look)
  readonly wet: Float32Array; // 0..1 dampness, slows ignition
  readonly tex: Uint8Array; // RGBA8 upload: fuel, heat, char, wet
  embers: Ember[] = [];
  /** Sum of burning heat, normalised; drives the ground light and haptics. */
  intensity = 0;
  cx = 0.5;
  cy = 0.2;
  newlyLit = 0;

  cfg = { spread: 2.2, burnRate: 0.06, oxygen: 0, emberRate: 1 };

  constructor(readonly w: number, readonly h: number) {
    const n = w * h;
    this.fuel = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.char = new Float32Array(n);
    this.wet = new Float32Array(n);
    this.tex = new Uint8Array(n * 4);
  }

  /** Lay a log (capsule) between two uv points. */
  log(x0: number, y0: number, x1: number, y1: number, radius: number) {
    const { w, h } = this;
    const ax = x0 * w, ay = y0 * h, bx = x1 * w, by = y1 * h;
    const r = radius * h;
    const minX = Math.max(0, Math.floor(Math.min(ax, bx) - r)), maxX = Math.min(w - 1, Math.ceil(Math.max(ax, bx) + r));
    const minY = Math.max(0, Math.floor(Math.min(ay, by) - r)), maxY = Math.min(h - 1, Math.ceil(Math.max(ay, by) + r));
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    for (let y = minY; y <= maxY; y++)
      for (let x = minX; x <= maxX; x++) {
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2));
        const px = ax + dx * t - x, py = ay + dy * t - y;
        const d = Math.sqrt(px * px + py * py);
        if (d > r) continue;
        const i = y * w + x;
        // Rounded cross-section: thicker wood in the middle of the log.
        const amount = 0.55 + 0.45 * Math.sqrt(1 - (d / r) ** 2);
        this.fuel[i] = Math.max(this.fuel[i], amount);
        this.char[i] = Math.min(this.char[i], 0.2);
      }
  }

  /** Match or blowtorch: light any wood under the brush. Returns how many cells caught. */
  ignite(x: number, y: number, radius: number) {
    let lit = 0;
    this.forDisc(x, y, radius, (i) => {
      if (this.fuel[i] > 0.05 && this.heat[i] < 0.3) {
        this.heat[i] = Math.max(this.heat[i], 0.6);
        this.wet[i] = 0;
        lit++;
      }
    });
    return lit;
  }

  douse(x: number, y: number, radius: number) {
    let hissed = 0;
    this.forDisc(x, y, radius, (i) => {
      if (this.heat[i] > 0.05) hissed++;
      this.heat[i] *= 0.2;
      this.wet[i] = 1;
    });
    return hissed;
  }

  clearAll() {
    this.fuel.fill(0);
    this.heat.fill(0);
    this.char.fill(0);
    this.wet.fill(0);
    this.embers.length = 0;
  }

  private forDisc(x: number, y: number, radius: number, fn: (i: number) => void) {
    const { w, h } = this;
    const cx = x * w, cy = y * h, r = radius * h;
    for (let yy = Math.max(0, Math.floor(cy - r)); yy <= Math.min(h - 1, Math.ceil(cy + r)); yy++)
      for (let xx = Math.max(0, Math.floor(cx - r)); xx <= Math.min(w - 1, Math.ceil(cx + r)); xx++)
        if ((xx - cx) ** 2 + (yy - cy) ** 2 <= r * r) fn(yy * w + xx);
  }

  step(dt: number, wind: number) {
    const { w, h, fuel, heat, char, wet, cfg } = this;
    const boost = 1 + cfg.oxygen * 2.5;
    let sum = 0, sx = 0, sy = 0;
    this.newlyLit = 0;
    // Ignition pass reads last frame's heat so spread doesn't race across the grid in one sweep.
    const prev = heat.slice();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        if (fuel[i] <= 0.02) {
          heat[i] *= Math.exp(-dt * 3);
          continue;
        }
        if (prev[i] > 0.05) {
          // Burning: eat fuel, flare with oxygen, char the wood.
          heat[i] = Math.min(1, heat[i] + dt * 0.8 * boost);
          fuel[i] = Math.max(0, fuel[i] - cfg.burnRate * dt * heat[i] * boost * (0.6 + 0.8 * Math.random()));
          char[i] = Math.min(1, char[i] + dt * 0.5);
          if (fuel[i] <= 0.02) heat[i] *= 0.5;
          sum += heat[i];
          sx += heat[i] * x;
          sy += heat[i] * y;
          continue;
        }
        wet[i] = Math.max(0, wet[i] - dt * 0.15);
        // Neighbours on fire; flames climb, so heat from below counts far more than from above.
        let n = 0;
        if (y > 0) n += prev[i - w] * 2.2;
        if (y > 1) n += prev[i - 2 * w] * 0.9;
        if (y + 1 < h) n += prev[i + w] * 0.35;
        if (x > 0) n += prev[i - 1] * (0.8 + Math.max(0, wind) * 0.8);
        if (x + 1 < w) n += prev[i + 1] * (0.8 + Math.max(0, -wind) * 0.8);
        if (n > 0 && Math.random() < n * cfg.spread * boost * dt * (1 - wet[i] * 0.95)) {
          heat[i] = 0.35;
          this.newlyLit++;
        }
      }
    const total = w * h * 0.05;
    this.intensity = Math.min(1.5, sum / total);
    if (sum > 0) {
      this.cx = sx / sum / w;
      this.cy = sy / sum / h;
    }
    this.stepEmbers(dt, wind, sum);
    for (let i = 0; i < w * h; i++) {
      this.tex[i * 4] = Math.round(Math.min(1, fuel[i]) * 255);
      this.tex[i * 4 + 1] = Math.round(Math.min(1, heat[i]) * 255);
      this.tex[i * 4 + 2] = Math.round(char[i] * 255);
      this.tex[i * 4 + 3] = Math.round(wet[i] * 255);
    }
  }

  private stepEmbers(dt: number, wind: number, sum: number) {
    const { w, h, heat, cfg } = this;
    // Spawn from random burning cells; more fire, more sparks.
    const want = Math.min(12, sum * 0.015 * cfg.emberRate * (1 + cfg.oxygen * 3));
    let spawns = Math.floor(want) + (Math.random() < want % 1 ? 1 : 0);
    for (let tries = 0; spawns > 0 && tries < 60; tries++) {
      const i = Math.floor(Math.random() * w * h);
      if (heat[i] < 0.4) continue;
      spawns--;
      this.embers.push({
        x: ((i % w) + Math.random()) / w,
        y: (Math.floor(i / w) + Math.random()) / h,
        vx: (Math.random() - 0.5) * 0.08 + wind * 0.05,
        vy: 0.12 + Math.random() * 0.25,
        life: 1 + Math.random() * 1.6,
        size: 0.6 + Math.random() * 1.2,
      });
    }
    for (const e of this.embers) {
      e.life -= dt;
      e.vx += ((Math.random() - 0.5) * 0.6 + wind * 0.25) * dt;
      e.vy += (Math.random() - 0.35) * 0.3 * dt;
      e.x += e.vx * dt;
      e.y += e.vy * dt;
    }
    this.embers = this.embers.filter((e) => e.life > 0 && e.y < 1.1 && e.x > -0.1 && e.x < 1.1);
    if (this.embers.length > 900) this.embers.splice(0, this.embers.length - 900);
  }
}
