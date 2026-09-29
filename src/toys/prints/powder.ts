// Dusting powder on a top-down surface: a grid of loose and stuck powder over a hidden adhesion
// mask (the latent print's sweat and oil). Brush bristles and falling grains lay powder down; where
// the mask is high it sticks at once, elsewhere it stays loose. The brush sweeps loose powder
// along its stroke and presses it onto ridges; blowing pushes it radially away and lifts some into
// the air. Airborne grains are a small particle system that lands back on the grid (or blows off).

import type { Ridges } from './fingerprint';

const MAX_PARTS = 3200;

export class Powder {
  readonly W: number;
  readonly H: number;
  readonly loose: Float32Array;
  readonly stuck: Float32Array;
  readonly mask: Float32Array;
  private readonly tmp: Float32Array;
  /** RGBA8 upload buffer: loose, stuck, mask, 255. */
  readonly tex: Uint8Array;
  dirty0 = 0;
  dirty1 = 0;
  /** Cells under laid tape: nothing moves there. */
  cover: [number, number, number, number] | null = null;
  // Airborne grains: position in cells, height (0 = landed), velocity, life; kind 0 falls and lands, 1 blows away.
  readonly px = new Float32Array(MAX_PARTS);
  readonly py = new Float32Array(MAX_PARTS);
  readonly pz = new Float32Array(MAX_PARTS);
  private readonly vx = new Float32Array(MAX_PARTS);
  private readonly vy = new Float32Array(MAX_PARTS);
  private readonly vz = new Float32Array(MAX_PARTS);
  readonly life = new Float32Array(MAX_PARTS);
  private readonly kind = new Uint8Array(MAX_PARTS);
  count = 0;
  /** Grains landed / cells captured this frame, for ticks and haptics. */
  landed = 0;
  captured = 0;
  /** Loose powder blown off this frame. */
  blown = 0;
  private seed = 1;

  constructor(W: number, H: number) {
    this.W = W;
    this.H = H;
    const n = W * H;
    this.loose = new Float32Array(n);
    this.stuck = new Float32Array(n);
    this.mask = new Float32Array(n);
    this.tmp = new Float32Array(n);
    this.tex = new Uint8Array(n * 4).fill(255);
    this.markDirty(0, H);
  }

  private rand() {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return (s >>> 0) / 4294967296;
  }

  markDirty(y0: number, y1: number) {
    y0 = Math.max(0, Math.floor(y0));
    y1 = Math.min(this.H, Math.ceil(y1));
    if (y1 <= y0) return;
    if (this.dirty1 <= this.dirty0) {
      this.dirty0 = y0;
      this.dirty1 = y1;
    } else {
      this.dirty0 = Math.min(this.dirty0, y0);
      this.dirty1 = Math.max(this.dirty1, y1);
    }
  }

  /** Pack the dirty rows into the upload buffer; returns the row range, or null. */
  pack(): [number, number] | null {
    const { dirty0: y0, dirty1: y1, W, loose, stuck, mask, tex } = this;
    if (y1 <= y0) return null;
    for (let i = y0 * W; i < y1 * W; i++) {
      const o = i * 4;
      tex[o] = Math.min(255, loose[i] * 255);
      tex[o + 1] = Math.min(255, stuck[i] * 255);
      tex[o + 2] = mask[i] * 255;
    }
    this.dirty0 = this.dirty1 = 0;
    return [y0, y1];
  }

  private covered(x: number, y: number) {
    const c = this.cover;
    return c !== null && x >= c[0] && x < c[2] && y >= c[1] && y < c[3];
  }

  // ---------------------------------------------------------------- latent marks

  /** Stamp a print's ridges into the adhesion mask, rotated about (cx, cy), with uneven finger pressure. */
  stampPrint(rid: Ridges, cx: number, cy: number, rot: number, seed: number) {
    const { W, H, mask } = this;
    const c = Math.cos(rot), s = Math.sin(rot);
    const R = Math.hypot(rid.w, rid.h) / 2 + 2;
    const ph = seed * 1.7;
    for (let y = Math.max(0, Math.floor(cy - R)); y < Math.min(H, cy + R); y++)
      for (let x = Math.max(0, Math.floor(cx - R)); x < Math.min(W, cx + R); x++) {
        const dx = x - cx, dy = y - cy;
        const lx = c * dx + s * dy + rid.w / 2, ly = -s * dx + c * dy + rid.h / 2;
        if (lx < 0 || ly < 0 || lx >= rid.w - 1 || ly >= rid.h - 1) continue;
        const x0 = lx | 0, y0 = ly | 0, fx = lx - x0, fy = ly - y0;
        const d = rid.data, i = y0 * rid.w + x0;
        const v = (d[i] * (1 - fx) + d[i + 1] * fx) * (1 - fy) + (d[i + rid.w] * (1 - fx) + d[i + rid.w + 1] * fx) * fy;
        // Finger pressure: firm in the middle, lighter toward one rolled edge, a few faint patches.
        const u = lx / rid.w - 0.5, w = ly / rid.h - 0.5;
        const p = 0.82 + 0.18 * Math.sin(u * 5 + ph) * Math.cos(w * 4 - ph) - 0.3 * Math.max(0, u * Math.cos(ph) + w * Math.sin(ph) - 0.15);
        const m = Math.max(0, Math.min(1, v * p));
        const k = y * W + x;
        mask[k] = Math.max(mask[k], m);
      }
    this.markDirty(cy - R, cy + R);
  }

  /** A greasy smear: low adhesion with streaks, no ridges. */
  stampSmudge(cx: number, cy: number, rx: number, ry: number, seed: number) {
    const { W, H, mask } = this;
    const a = seed * 2.3;
    for (let y = Math.max(0, Math.floor(cy - ry * 1.3)); y < Math.min(H, cy + ry * 1.3); y++)
      for (let x = Math.max(0, Math.floor(cx - rx * 1.3)); x < Math.min(W, cx + rx * 1.3); x++) {
        const dx = (x - cx) / rx, dy = (y - cy) / ry;
        const d = Math.hypot(dx, dy) + 0.18 * Math.sin(dx * 3 + a) * Math.sin(dy * 4 - a);
        if (d >= 1) continue;
        const streak = 0.55 + 0.45 * Math.sin((x * Math.cos(a) + y * Math.sin(a)) * 0.9);
        const k = y * W + x;
        mask[k] = Math.max(mask[k], (1 - d) * 0.75 * streak);
      }
    this.markDirty(cy - ry * 1.3, cy + ry * 1.3);
  }

  /** Put a little powder on a cell: sticky cells grab it, the rest stays loose. */
  private lay(k: number, a: number) {
    const m = this.mask[k];
    const grip = Math.min(1, m * m * 5);
    const st = this.stuck[k];
    const add = Math.min(1 - st, a * grip * 4);
    this.stuck[k] = st + add;
    this.loose[k] = Math.min(1.5, this.loose[k] + a * (1 - grip));
    if (add > 0.02) this.captured++;
  }

  // ---------------------------------------------------------------- tools

  /**
   * Brush contact at (x, y) cells, radius r, moving (mx, my) cells this frame. Lays powder, presses
   * loose powder onto ridges, sweeps the rest along the stroke and spits grains into the air.
   */
  brush(x: number, y: number, r: number, mx: number, my: number, dt: number, load: number) {
    const { W, H, loose, stuck, mask, tmp } = this;
    const x0 = Math.max(0, Math.floor(x - r - 3)), x1 = Math.min(W, Math.ceil(x + r + 3));
    const y0 = Math.max(0, Math.floor(y - r - 3)), y1 = Math.min(H, Math.ceil(y + r + 3));
    const sp = Math.hypot(mx, my);
    const ux = sp > 0 ? mx / sp : 0, uy = sp > 0 ? my / sp : 0;
    const sweep = Math.min(0.55, sp * 0.09);
    const ox = Math.round(ux * 2), oy = Math.round(uy * 2);
    for (let yy = y0; yy < y1; yy++) tmp.set(loose.subarray(yy * W + x0, yy * W + x1), yy * W + x0);
    const r2 = r * r;
    const lay = load * dt * (0.5 + Math.min(1.5, sp * 0.25));
    for (let yy = y0; yy < y1; yy++)
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx - x, dy = yy - y, d2 = dx * dx + dy * dy;
        if (d2 >= r2 || this.covered(xx, yy)) continue;
        const k = yy * W + xx;
        // Bristle tips are uneven: a hashed pattern that shifts every frame.
        const w = (1 - d2 / r2) * (0.6 + 0.8 * this.rand());
        const m = mask[k];
        const grip = Math.min(1, m * m * 5);
        // Loose grains rolled over a ridge get pressed on; loose grains on bare surface get pushed.
        const l = tmp[k];
        const press = l * grip * w * Math.min(1, dt * 10);
        stuck[k] = Math.min(1, stuck[k] + press);
        loose[k] -= press;
        if (sweep > 0) {
          const tx = xx + ox, ty = yy + oy;
          if (tx >= 0 && tx < W && ty >= 0 && ty < H && !this.covered(tx, ty)) {
            const mv = (l - press) * sweep * w;
            loose[k] -= mv;
            loose[ty * W + tx] += mv;
          }
        }
        // Stray powder caught in valleys brushes off again.
        if (grip < 0.5) {
          const off = stuck[k] * (1 - grip * 2) * w * dt * 3;
          stuck[k] -= off;
          loose[k] += off * 0.8;
        }
        if (w > 0.15) this.lay(k, lay * w);
      }
    this.markDirty(y0 - 3, y1 + 3);
    // Grains shaken off the bristles: a small cloud that settles around the brush.
    const n = Math.min(40, Math.round((2 + sp * 1.2) * load * dt * 60));
    for (let i = 0; i < n; i++) {
      const a = this.rand() * Math.PI * 2, rr = Math.sqrt(this.rand()) * r * 1.3;
      this.spawn(x + Math.cos(a) * rr, y + Math.sin(a) * rr, 0.35 + this.rand() * 0.7, mx * 12 + (this.rand() - 0.5) * 30, my * 12 + (this.rand() - 0.5) * 30, -2 - this.rand() * 2.5, 0);
    }
  }

  /** Blow from (x, y): loose powder slides away radially, some goes airborne; weakly held grains come off. */
  blow(x: number, y: number, r: number, dt: number, power: number) {
    const { W, H, loose, stuck, mask, tmp } = this;
    const x0 = Math.max(0, Math.floor(x - r - 3)), x1 = Math.min(W, Math.ceil(x + r + 3));
    const y0 = Math.max(0, Math.floor(y - r - 3)), y1 = Math.min(H, Math.ceil(y + r + 3));
    for (let yy = y0; yy < y1; yy++) tmp.set(loose.subarray(yy * W + x0, yy * W + x1), yy * W + x0);
    let spawned = 0;
    const r2 = r * r;
    for (let yy = y0; yy < y1; yy++)
      for (let xx = x0; xx < x1; xx++) {
        const dx = xx - x, dy = yy - y, d2 = dx * dx + dy * dy;
        if (d2 >= r2 || this.covered(xx, yy)) continue;
        const k = yy * W + xx;
        const d = Math.sqrt(d2) || 1;
        const w = (1 - d / r) * power;
        const m = mask[k];
        const grip = Math.min(1, m * m * 5);
        // Grains on the ridges hold; stray ones on the fringe let go.
        const off = stuck[k] * (1 - grip) * (1 - grip) * Math.min(1, w * dt * 5);
        stuck[k] -= off;
        const l = tmp[k] + off;
        if (l < 0.002) continue;
        const f = Math.min(0.85, w * dt * 14 * (0.7 + 0.6 * this.rand()));
        const mv = l * f;
        const tx = xx + Math.round((dx / d) * 2.4), ty = yy + Math.round((dy / d) * 2.4);
        loose[k] += off - mv;
        // A third leaves the surface for good; the rest slides outward.
        if (tx >= 0 && tx < W && ty >= 0 && ty < H && !this.covered(tx, ty)) loose[ty * W + tx] += mv * 0.62;
        this.blown += mv * 0.38;
        if (mv > 0.03 && spawned < 70 && this.rand() < mv * 2) {
          spawned++;
          const s = 60 + this.rand() * 140;
          this.spawn(xx, yy, 0.05, (dx / d) * s + (this.rand() - 0.5) * 40, (dy / d) * s + (this.rand() - 0.5) * 40, 0.8 + this.rand() * 1.6, 1);
        }
      }
    this.markDirty(y0 - 3, y1 + 3);
  }

  /** Lift everything in a cell rectangle (the tape takes it). */
  clear(x0: number, y0: number, x1: number, y1: number) {
    const { W, H, loose, stuck } = this;
    x0 = Math.max(0, Math.floor(x0));
    y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(W, Math.ceil(x1));
    y1 = Math.min(H, Math.ceil(y1));
    for (let y = y0; y < y1; y++) {
      loose.fill(0, y * W + x0, y * W + x1);
      stuck.fill(0, y * W + x0, y * W + x1);
    }
    this.markDirty(y0, y1);
  }

  // ---------------------------------------------------------------- airborne grains

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, kind: number) {
    let i = this.count;
    if (i >= MAX_PARTS) i = (this.rand() * MAX_PARTS) | 0;
    else this.count++;
    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = kind ? 0.5 + this.rand() * 0.7 : 3;
    this.kind[i] = kind;
  }

  step(dt: number) {
    this.landed = 0;
    const { px, py, pz, vx, vy, vz, life, kind, W, H } = this;
    let n = this.count;
    for (let i = 0; i < n; i++) {
      const air = kind[i] ? 3 : 7;
      vx[i] -= vx[i] * Math.min(1, air * dt);
      vy[i] -= vy[i] * Math.min(1, air * dt);
      px[i] += vx[i] * dt;
      py[i] += vy[i] * dt;
      pz[i] += vz[i] * dt;
      if (kind[i]) vz[i] -= 2.5 * dt;
      life[i] -= dt;
      let dead = life[i] <= 0 || px[i] < 0 || py[i] < 0 || px[i] >= W || py[i] >= H;
      if (!dead && !kind[i] && pz[i] <= 0) {
        // Landed: it joins the powder on the surface.
        const x = px[i] | 0, y = py[i] | 0;
        if (!this.covered(x, y)) {
          this.lay(y * W + x, 0.05);
          this.markDirty(y, y + 1);
        }
        this.landed++;
        dead = true;
      }
      if (dead) {
        n--;
        px[i] = px[n];
        py[i] = py[n];
        pz[i] = pz[n];
        vx[i] = vx[n];
        vy[i] = vy[n];
        vz[i] = vz[n];
        life[i] = life[n];
        kind[i] = kind[n];
        i--;
      }
    }
    this.count = n;
  }

  /** Fraction of a print's ridge cells that hold powder, and the loose haze left over its valleys. */
  revealed = 0;
  haze = 0;
  reveal(ridge: Int32Array, valley: Int32Array) {
    const { stuck, loose } = this;
    let s = 0;
    for (let i = 0; i < ridge.length; i++) s += Math.min(1, stuck[ridge[i]] * 2.2);
    let h = 0;
    for (let i = 0; i < valley.length; i++) h += Math.min(1, loose[valley[i]] * 2.5);
    this.revealed = ridge.length ? s / ridge.length : 0;
    this.haze = valley.length ? h / valley.length : 0;
  }
}
