// The water's surface, seen from above as a disk texture. The vibrating wall is a wave maker: it
// sends capillary ripples inward from the rim, strongest at the (2,0) antinodes and zero at the
// nodes, so the surface shows the mode's 4-lobed pattern turning with the finger. Past a
// threshold the edge goes Faraday-unstable (Terwagne & Bush 2011): standing crests perpendicular
// to the wall that oscillate at half the forcing frequency; higher still, crests fracture into
// spray (the droplets are thrown by the toy). The real ripples are ~1 mm and 500 Hz, so we show
// them slowed and enlarged; their shape, placement and thresholds come from the modal amplitudes.

const TS = 112;

export interface Ring {
  u: number;
  v: number;
  age: number;
  amp: number;
}

export class WaterSurface {
  readonly canvas: HTMLCanvasElement;
  private g: CanvasRenderingContext2D;
  private img: ImageData;
  private px: Uint32Array;
  private h = new Float32Array(TS * TS);
  // Per-pixel precomputed polar terms.
  private inside = new Uint8Array(TS * TS);
  private c2 = new Float32Array(TS * TS);
  private s2 = new Float32Array(TS * TS);
  private env = new Float32Array(TS * TS);
  private cK = new Float32Array(TS * TS);
  private sK = new Float32Array(TS * TS);
  private far = new Float32Array(TS * TS);
  private fenv = new Float32Array(TS * TS);
  private uu = new Float32Array(TS * TS);
  private vv = new Float32Array(TS * TS);
  private still = false;
  readonly rings: Ring[] = [];

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = TS;
    this.g = this.canvas.getContext('2d')!;
    this.img = this.g.createImageData(TS, TS);
    this.px = new Uint32Array(this.img.data.buffer);
    for (let j = 0; j < TS; j++)
      for (let i = 0; i < TS; i++) {
        const k = j * TS + i;
        const u = ((i + 0.5) / TS) * 2 - 1, v = ((j + 0.5) / TS) * 2 - 1;
        const r = Math.hypot(u, v), th = Math.atan2(v, u);
        this.uu[k] = u;
        this.vv[k] = v;
        this.inside[k] = r < 1 ? 1 : 0;
        this.c2[k] = Math.cos(2 * th);
        this.s2[k] = Math.sin(2 * th);
        // Wall-generated ripples decay inward; ~5 visible crests across the edge band.
        this.env[k] = Math.exp(-(1 - r) / 0.28);
        this.cK[k] = Math.cos(34 * (1 - r));
        this.sK[k] = Math.sin(34 * (1 - r));
        // Faraday crests: radial ridges along the edge, ~30 around.
        this.far[k] = Math.cos(30 * th) * Math.cos(9 * (1 - r));
        this.fenv[k] = Math.exp(-(1 - r) / 0.16);
      }
  }

  /**
   * Redraw. z = (2,0) complex amplitudes [re0, im0, re1, im1] in units of the breaking amplitude,
   * phase = displayed (slowed) oscillation phase, faraday = 0..1 edge instability.
   */
  update(z: Float64Array, phase: number, faraday: number, tint: [number, number, number]) {
    const active = Math.hypot(z[0], z[1], z[2], z[3]) > 0.003 || this.rings.length > 0 || faraday > 0;
    if (!active && this.still) return;
    this.still = !active;
    const { h, inside, c2, s2, env, cK, sK, far, fenv, uu, vv } = this;
    const co = Math.cos(phase), so = Math.sin(phase);
    const half = Math.cos(phase / 2) * faraday * 0.9;
    // Displayed height scale: compress so faint rubbing still shows and near-breaking doesn't blow out.
    const mag = Math.hypot(z[0], z[1], z[2], z[3]);
    const vis = mag > 1e-6 ? Math.min(2, Math.pow(mag, 0.5) * 4) / mag : 0;
    // Strongest wall motion around the rim, to sharpen the lobes (the eye reads contrast, not dB).
    let pmax = 1e-9;
    for (let a = 0; a < 16; a++) {
      const c = Math.cos((a / 16) * 2 * Math.PI), s = Math.sin((a / 16) * 2 * Math.PI);
      pmax = Math.max(pmax, Math.hypot(z[0] * c + z[2] * s, z[1] * c + z[3] * s));
    }
    const inv2 = 1 / (pmax * pmax);
    for (let k = 0; k < TS * TS; k++) {
      if (!inside[k]) continue;
      // Wall displacement here (complex), sent inward as a travelling ripple.
      const pr = z[0] * c2[k] + z[2] * s2[k], pi = z[1] * c2[k] + z[3] * s2[k];
      const lobe = (pr * pr + pi * pi) * inv2;
      const zr = pr * vis * lobe, zi = pi * vis * lobe;
      const cw = co * cK[k] + so * sK[k], sw = so * cK[k] - co * sK[k];
      let y = env[k] * (zr * cw - zi * sw);
      if (half) y += half * fenv[k] * far[k] * Math.sqrt(zr * zr + zi * zi);
      h[k] = y;
    }
    for (let n = this.rings.length - 1; n >= 0; n--) {
      const r = this.rings[n];
      const rad = r.age * 1.1, a = r.amp * Math.exp(-r.age * 2.2);
      const lo2 = Math.max(0, rad - 0.3) ** 2, hi2 = (rad + 0.3) ** 2;
      for (let k = 0; k < TS * TS; k++) {
        if (!inside[k]) continue;
        const du = uu[k] - r.u, dv = vv[k] - r.v, d2 = du * du + dv * dv;
        if (d2 < lo2 || d2 > hi2) continue;
        const d = Math.sqrt(d2) - rad;
        h[k] += a * Math.exp(-d * d * 60) * Math.cos(d * 40);
      }
    }
    const [tr, tg, tb] = tint;
    const px = this.px;
    for (let j = 0; j < TS; j++) {
      // Grazing view: the back of the surface reflects the bright room, the front is see-through.
      const back = 1 - j / TS;
      for (let i = 0; i < TS; i++) {
        const k = j * TS + i;
        if (!inside[k]) {
          px[k] = 0;
          continue;
        }
        const gx = (i > 0 && i < TS - 1 ? h[k + 1] - h[k - 1] : 0);
        const gy = (j > 0 && j < TS - 1 ? h[k + TS] - h[k - TS] : 0);
        const lit = Math.max(-1, Math.min(1, (gx * 0.6 - gy) * 3));
        const spec = Math.max(0, lit) ** 3;
        const base = 0.28 + 0.5 * back * back;
        const L = base + lit * 0.35;
        const r = Math.min(255, tr * L + 255 * spec * 0.9);
        const g = Math.min(255, tg * L + 255 * spec * 0.9);
        const b = Math.min(255, tb * L + 255 * spec);
        const a = Math.min(255, 150 + 90 * back + 200 * spec);
        px[k] = (a << 24) | (Math.max(0, b) << 16) | (Math.max(0, g) << 8) | Math.max(0, r);
      }
    }
    this.g.putImageData(this.img, 0, 0);
  }

  step(dt: number) {
    for (let n = this.rings.length - 1; n >= 0; n--) if ((this.rings[n].age += dt) > 1.8) this.rings.splice(n, 1);
  }
}
