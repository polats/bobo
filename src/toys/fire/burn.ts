// Where the wood is and what's burning: a small CPU cellular automaton on the same grid as the fluid.
// Fire spreads to neighbouring fuel (mostly upward), eats fuel, leaves glowing char, and water puts it out.
// An oxygen field on the same grid (1 = fresh air) feeds it: burning uses air up, fresh air mixes back in
// from the open sky and sides, blowing adds extra, and a glass jar or a steam cloud keeps it out. Starved
// cells sink to a smoulder and slowly go out; give them air again and they flare back up (Fire-X's idea).

export interface Ember {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

/** A glass bell jar resting over (or hovering above) the fire: upper half of an ellipse. */
export interface Jar {
  x: number; // uv
  y: number; // rim height, uv
  rx: number; // half-width, in screen-height units
  ry: number; // height, in screen-height units
  /** 0 = air gets under the rim freely, 1 = rim on the ground and sealed. */
  seal: number;
}

/** Signed distance (screen-height units) from the jar's glass, negative inside; null below the rim. */
export function jarDist(j: Jar, x: number, y: number, aspect: number) {
  const qx = ((x - j.x) * aspect) / j.rx, qy = (y - j.y) / j.ry;
  if (qy < 0) return null;
  const d = Math.sqrt(qx * qx + qy * qy) || 1e-6;
  const gx = qx / j.rx, gy = qy / j.ry;
  const g = Math.sqrt(gx * gx + gy * gy) / d;
  return (d - 1) / g;
}

export class Burn {
  readonly fuel: Float32Array; // 0..1 wood remaining
  readonly heat: Float32Array; // 0..1 how hard this cell is burning
  readonly char: Float32Array; // 0..1 burnt-ness (for the glowing-ember look)
  readonly wet: Float32Array; // 0..1 dampness, slows ignition
  readonly tex: Uint8Array; // RGBA8 upload: fuel, heat, char, wet
  oxy: Float32Array; // 0..2 oxygen, 1 = fresh air, above 1 = blown-in draught
  private oxyNext: Float32Array;
  readonly oxyTex: Uint8Array; // R8 upload: oxygen / 2
  /** Per cell: 0 open air, 1 under the jar, 2 the glass itself. */
  private jarMask: Uint8Array;
  private jarKey = '';
  jar: Jar | null = null;
  /** Heat-weighted oxygen over burning cells: how well-fed the fire is, for sound and glow. */
  fed = 1;
  embers: Ember[] = [];
  /** Sum of burning heat, normalised; drives the ground light and haptics. */
  intensity = 0;
  cx = 0.5;
  cy = 0.2;
  newlyLit = 0;

  cfg = {
    spread: 2.2,
    burnRate: 0.06,
    emberRate: 1,
    /** Air a fully burning cell uses per second (fraction of what's there). */
    consume: 2.6,
    /** How fast open air mixes back in (per second); the unresolved draught around a real fire. */
    mixing: 3,
    /** Ground height (uv): the earth below neither holds nor passes air. */
    ground: 0.14,
  };

  constructor(readonly w: number, readonly h: number) {
    const n = w * h;
    this.fuel = new Float32Array(n);
    this.heat = new Float32Array(n);
    this.char = new Float32Array(n);
    this.wet = new Float32Array(n);
    this.tex = new Uint8Array(n * 4);
    this.oxy = new Float32Array(n).fill(1);
    this.oxyNext = new Float32Array(n).fill(1);
    this.oxyTex = new Uint8Array(n).fill(128);
    this.jarMask = new Uint8Array(n);
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
    // The steam cloud shoves the air out of a wider patch, so the fire nearby chokes too.
    const steam = Math.min(1, 0.25 + hissed / 30);
    this.forDisc(x, y + radius * 0.8, radius * 2.2, (i) => (this.oxy[i] *= 1 - 0.35 * steam));
    return hissed;
  }

  /** Blowing: push fresh air (above ambient) into a patch. */
  breathe(x: number, y: number, radius: number, amount: number) {
    this.forDisc(x, y, radius, (i) => (this.oxy[i] = Math.min(2, Math.max(this.oxy[i], 1) + amount)));
  }

  clearAll() {
    this.fuel.fill(0);
    this.heat.fill(0);
    this.char.fill(0);
    this.wet.fill(0);
    this.oxy.fill(1);
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
    this.stepOxygen(dt, wind); // swaps this.oxy, so read it after
    const { w, h, fuel, heat, char, wet, oxy, cfg } = this;
    let sum = 0, sx = 0, sy = 0, so = 0;
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
        const o = oxy[i];
        const air = Math.max(0, Math.min(1, (o - 0.12) / 0.5)); // 0 starved .. 1 fed
        const boost = air * (1 + Math.max(0, o - 1) * 2.5); // a blown-on fire burns far harder
        if (prev[i] > 0.05) {
          // Burning: eat fuel and air, char the wood. Without air it sinks to a smoulder, then out.
          const target = 0.12 + 0.88 * air;
          if (heat[i] < target) heat[i] = Math.min(1, heat[i] + dt * 0.8 * (0.3 + boost));
          else heat[i] -= dt * (1.6 * (heat[i] - target) + (air < 0.05 ? 0.008 : 0));
          fuel[i] = Math.max(0, fuel[i] - cfg.burnRate * dt * heat[i] * (0.25 + boost) * (0.6 + 0.8 * Math.random()));
          oxy[i] = o * Math.max(0, 1 - cfg.consume * heat[i] * dt);
          char[i] = Math.min(1, char[i] + dt * 0.5);
          if (fuel[i] <= 0.02) heat[i] *= 0.5;
          sum += heat[i];
          sx += heat[i] * x;
          sy += heat[i] * y;
          so += heat[i] * o;
          continue;
        }
        wet[i] = Math.max(0, wet[i] - dt * 0.15);
        if (air <= 0) continue; // no air, nothing catches
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
    this.fed = sum > 1e-3 ? so / sum : 1;
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
      this.oxyTex[i] = Math.round(Math.min(2, oxy[i]) * 127.5);
    }
  }

  /**
   * One transport pass for the oxygen: diffusion between neighbours, open air at the sides and top,
   * the fire's own draught pulling air in along the ground and up through the flames, the wind, and
   * mixing back toward fresh air everywhere except under a sealed jar. The glass and the earth pass
   * nothing. (The GPU velocity field is never read back; this is the cheap CPU stand-in for it.)
   */
  private stepOxygen(dt: number, wind: number) {
    const { w, h, heat, cfg } = this;
    const o = this.oxy, out = this.oxyNext, mask = this.jarMask;
    this.markJar();
    const g0 = Math.max(1, Math.round(cfg.ground * h) - 1); // rows below this are earth
    const k = Math.min(0.24, 14 * dt); // explicit diffusion, clamped for stability
    const mixOpen = Math.min(1, cfg.mixing * dt);
    const mixJar = mixOpen * (1 - (this.jar?.seal ?? 0));
    const draw = Math.min(0.45, 7 * dt * Math.min(1, this.intensity * 2)); // draught toward the flames
    const fx = this.cx * w;
    const drift = Math.max(-0.45, Math.min(0.45, wind * 12 * dt));
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const m = mask[i];
        if (y < g0 || m === 2) {
          out[i] = o[i];
          continue;
        }
        const c = o[i];
        const l = x > 0 ? (mask[i - 1] === 2 ? c : o[i - 1]) : 1;
        const r = x + 1 < w ? (mask[i + 1] === 2 ? c : o[i + 1]) : 1;
        const u = y + 1 < h ? (mask[i + w] === 2 ? c : o[i + w]) : 1;
        const d = y > g0 && mask[i - w] !== 2 ? o[i - w] : c;
        let v = c + k * (l + r + u + d - 4 * c);
        // Hot gas rises out of the fire and air rushes in behind it: upwind from outside and below.
        const hot = heat[i] + (y > 0 ? heat[i - w] : 0);
        if (hot > 0.02) v += (d - v) * Math.min(0.5, hot * draw);
        v += ((x < fx ? l : r) - v) * draw * 0.35;
        if (drift > 0) v += (l - v) * drift;
        else if (drift < 0) v += (r - v) * -drift;
        v += (1 - v) * (m === 1 ? mixJar : mixOpen);
        out[i] = v;
      }
    this.oxyNext = o;
    this.oxy = out;
  }

  private markJar() {
    const { w, h, jar } = this;
    const mask = this.jarMask;
    // Only re-rasterise when the jar moves.
    const key = jar ? `${jar.x},${jar.y}` : '';
    if (key === this.jarKey) return;
    this.jarKey = key;
    mask.fill(0);
    if (!jar) return;
    const aspect = w / h;
    const t = Math.max(0.008, 1.6 / h); // glass thickness, at least a cell or so
    const x0 = Math.max(0, Math.floor((jar.x - (jar.rx + t) / aspect) * w));
    const x1 = Math.min(w - 1, Math.ceil((jar.x + (jar.rx + t) / aspect) * w));
    const y0 = Math.max(0, Math.floor(jar.y * h));
    const y1 = Math.min(h - 1, Math.ceil((jar.y + jar.ry + t) * h));
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        const d = jarDist(jar, (x + 0.5) / w, (y + 0.5) / h, aspect);
        if (d === null || d > t) continue;
        mask[y * w + x] = d < -t ? 1 : 2;
      }
  }

  private stepEmbers(dt: number, wind: number, sum: number) {
    const { w, h, heat, cfg } = this;
    // Spawn from random burning cells; more fire, more sparks.
    const want = Math.min(12, sum * 0.015 * cfg.emberRate * (0.2 + Math.max(0, this.fed - 0.3) * 2.5));
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
    // Sparks die on the glass rather than flying through it.
    const jar = this.jar, aspect = w / h;
    this.embers = this.embers.filter((e) => {
      if (e.life <= 0 || e.y > 1.1 || e.x < -0.1 || e.x > 1.1) return false;
      const d = jar ? jarDist(jar, e.x, e.y, aspect) : null;
      return d === null || Math.abs(d) > 0.006;
    });
    if (this.embers.length > 900) this.embers.splice(0, this.embers.length - 900);
  }
}
