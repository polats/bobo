// Ferrofluid in a dish, 2.5D.
// - The puddle's footprint is a 2D particle liquid (Clavet et al. 2005 double-density relaxation:
//   pressure plus near-pressure gives cohesive, blobby liquid with surface tension for free).
// - Particles are splatted into a thickness grid that becomes the surface height.
// - Rosensweig spikes are a hex lattice of cones whose heights follow the local magnetic field
//   above a critical value, each on an underdamped spring so they snap up, overshoot and sway.

export const DISH_R = 1.0; // inner radius of the dish (world units, xz plane)
export const GRID = 160; // thickness grid resolution over [-EXT, EXT]²
export const EXT = 1.1;
export const CELL_TEX = 32; // spike data texture: axial (q, r) + 16

export interface Magnet {
  x: number;
  z: number;
  strength: number;
}

export interface Drop {
  x: number;
  z: number;
  y: number;
  vy: number;
  r: number;
  count: number;
}

export class Ferro {
  n = 0;
  px!: Float32Array;
  pz!: Float32Array;
  vx!: Float32Array;
  vz!: Float32Array;
  private ox!: Float32Array;
  private oz!: Float32Array;
  readonly cap = 1400;
  /** Surface thickness over the grid (world units), smoothed. */
  readonly thick = new Float32Array(GRID * GRID);
  private tmp = new Float32Array(GRID * GRID);
  /** Spike state per hex cell. */
  readonly cellQ: Int16Array;
  readonly cellR: Int16Array;
  readonly cellX: Float32Array;
  readonly cellZ: Float32Array;
  readonly amp: Float32Array;
  private ampV: Float32Array;
  readonly tiltX: Float32Array;
  readonly tiltZ: Float32Array;
  private tiltVX: Float32Array;
  private tiltVZ: Float32Array;
  readonly nCells: number;
  readonly spacing = 0.092;
  /** RGBA16F-ready spike texture data (amp, tiltX, tiltZ, presence). */
  readonly cellData = new Float32Array(CELL_TEX * CELL_TEX * 4);
  drops: Drop[] = [];
  snapsThisFrame = 0;
  landedThisFrame = 0;
  // Counting-sort neighbour grid over [-EXT, EXT]² with cell size = interaction radius.
  private readonly H = 0.075;
  private readonly GN = Math.ceil((2 * EXT) / 0.075);
  private cellStart = new Int32Array(this.GN * this.GN + 1);
  private cellItems = new Int32Array(1400);
  private cellOf = new Int32Array(1400);
  private nbr = new Int32Array(64);
  private nbq = new Float32Array(64);

  cfg = {
    strength: 1, // global magnet strength multiplier
    baseMagnet: 0.55, // the magnet that always sits under the middle of the dish
    viscosity: 0.35,
    tension: 1, // scales near-pressure (cohesion / beading)
    sharpness: 1, // spike cone exponent multiplier
    amount: 620, // particle count target
  };

  constructor() {
    this.px = new Float32Array(this.cap);
    this.pz = new Float32Array(this.cap);
    this.vx = new Float32Array(this.cap);
    this.vz = new Float32Array(this.cap);
    this.ox = new Float32Array(this.cap);
    this.oz = new Float32Array(this.cap);
    // Hex lattice (pointy-top axial coordinates) covering the dish.
    const size = this.spacing / Math.sqrt(3);
    const qs: number[] = [];
    const rs: number[] = [];
    for (let r = -15; r <= 15; r++)
      for (let q = -15; q <= 15; q++) {
        const x = size * Math.sqrt(3) * (q + r / 2);
        const z = size * 1.5 * r;
        if (Math.hypot(x, z) < DISH_R - 0.02) {
          qs.push(q);
          rs.push(r);
        }
      }
    this.nCells = qs.length;
    this.cellQ = Int16Array.from(qs);
    this.cellR = Int16Array.from(rs);
    this.cellX = new Float32Array(this.nCells);
    this.cellZ = new Float32Array(this.nCells);
    for (let i = 0; i < this.nCells; i++) {
      this.cellX[i] = size * Math.sqrt(3) * (qs[i] + rs[i] / 2);
      this.cellZ[i] = size * 1.5 * rs[i];
    }
    this.amp = new Float32Array(this.nCells);
    this.ampV = new Float32Array(this.nCells);
    this.tiltX = new Float32Array(this.nCells);
    this.tiltZ = new Float32Array(this.nCells);
    this.tiltVX = new Float32Array(this.nCells);
    this.tiltVZ = new Float32Array(this.nCells);
    this.reset();
  }

  reset() {
    this.n = 0;
    this.drops = [];
    this.amp.fill(0);
    this.ampV.fill(0);
    this.tiltX.fill(0);
    this.tiltZ.fill(0);
    this.addBlob(0, 0.05, 0.4, this.cfg.amount);
    this.settle();
  }

  /** Let the puddle relax for a moment off-screen so it starts as one calm blob. */
  settle() {
    const mags = [{ x: 0, z: 0, strength: this.cfg.baseMagnet }];
    for (let i = 0; i < 90; i++) this.liquid(1 / 120, mags);
    for (let i = 0; i < this.n; i++) {
      this.vx[i] = 0;
      this.vz[i] = 0;
    }
  }

  /** Spawn particles in a disc (sunflower spiral so they start evenly spaced). */
  addBlob(cx: number, cz: number, radius: number, count: number) {
    const golden = Math.PI * (3 - Math.sqrt(5));
    for (let i = 0; i < count && this.n < this.cap; i++) {
      const rr = radius * Math.sqrt((i + 0.5) / count);
      const a = i * golden;
      const k = this.n++;
      this.px[k] = cx + Math.cos(a) * rr;
      this.pz[k] = cz + Math.sin(a) * rr;
      this.vx[k] = 0;
      this.vz[k] = 0;
    }
  }

  setAmount(target: number) {
    this.cfg.amount = target;
    if (this.n > target) this.n = target;
    else if (this.n < target) this.addBlob(0, 0, 0.25, target - this.n);
  }

  dropAt(x: number, z: number) {
    this.drops.push({ x, z, y: 1.1, vy: 0, r: 0.09, count: 70 });
  }

  // ------------------------------------------------------------------ step

  step(dt: number, magnets: Magnet[]) {
    this.snapsThisFrame = 0;
    this.landedThisFrame = 0;
    const all: Magnet[] = [{ x: 0, z: 0, strength: this.cfg.baseMagnet }, ...magnets];
    const sub = dt > 1 / 50 ? 3 : 2;
    const h = dt / sub;
    for (let s = 0; s < sub; s++) this.liquid(h, all);
    this.stepDrops(dt);
    this.splat();
    this.spikes(dt, all);
  }

  private field(x: number, z: number, mags: Magnet[]) {
    // Dipole-ish falloff: strong over the magnet, fading over ~0.35 units.
    let b = 0;
    for (const m of mags) {
      const d2 = (x - m.x) ** 2 + (z - m.z) ** 2;
      b += (m.strength * this.cfg.strength) / (1 + d2 / 0.09) ** 1.5;
    }
    return b;
  }

  private liquid(h: number, mags: Magnet[]) {
    const { px, pz, vx, vz, ox, oz } = this;
    const n = this.n;
    const H = 0.075; // interaction radius
    const rho0 = 3.7;
    const k = 0.9;
    const kNear = 3.2 * this.cfg.tension;
    // Magnetic attraction and gentle drag.
    for (let i = 0; i < n; i++) {
      let ax = 0;
      let az = 0;
      for (const m of mags) {
        const dx = m.x - px[i];
        const dz = m.z - pz[i];
        const d2 = dx * dx + dz * dz;
        const s = (m.strength * this.cfg.strength * 2.6) / (d2 + 0.05) ** 1.5 * 0.12;
        ax += dx * s;
        az += dz * s;
      }
      vx[i] = (vx[i] + ax * h) * (1 - 1.2 * h);
      vz[i] = (vz[i] + az * h) * (1 - 1.2 * h);
    }
    this.buildGrid();
    this.viscosity(H, h);
    for (let i = 0; i < n; i++) {
      ox[i] = px[i];
      oz[i] = pz[i];
      px[i] += vx[i] * h;
      pz[i] += vz[i] * h;
    }
    this.buildGrid();
    // Double density relaxation (Clavet 2005).
    const { GN, cellStart, cellItems, cellOf } = this;
    const inv = 1 / H;
    const nbr = this.nbr;
    const nbq = this.nbq;
    for (let i = 0; i < n; i++) {
      const c = cellOf[i];
      const cx = c % GN;
      const cz = (c / GN) | 0;
      let rho = 0;
      let rhoN = 0;
      let m = 0;
      for (let b = Math.max(0, cz - 1); b <= Math.min(GN - 1, cz + 1); b++)
        for (let a = Math.max(0, cx - 1); a <= Math.min(GN - 1, cx + 1); a++) {
          const cc = b * GN + a;
          for (let s = cellStart[cc]; s < cellStart[cc + 1]; s++) {
            const j = cellItems[s];
            if (j === i) continue;
            const q = Math.hypot(px[j] - px[i], pz[j] - pz[i]) * inv;
            if (q < 1) {
              const w = 1 - q;
              rho += w * w;
              rhoN += w * w * w;
              if (m < 64) {
                nbr[m] = j;
                nbq[m++] = q;
              }
            }
          }
        }
      const P = k * (rho - rho0);
      const PN = kNear * rhoN;
      let dxi = 0;
      let dzi = 0;
      for (let t = 0; t < m; t++) {
        const j = nbr[t];
        const q = nbq[t];
        const rx = px[j] - px[i];
        const rz = pz[j] - pz[i];
        const r = q * H;
        if (r < 1e-6) continue;
        const w = 1 - q;
        // Clamp so a jolt can never blow the puddle apart.
        const D = Math.max(-0.012, Math.min(0.012, h * h * (P * w + PN * w * w) * 30));
        const ux = (rx / r) * D;
        const uz = (rz / r) * D;
        px[j] += ux;
        pz[j] += uz;
        dxi -= ux;
        dzi -= uz;
      }
      px[i] += dxi;
      pz[i] += dzi;
    }
    // Dish wall.
    const R = DISH_R - 0.03;
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(px[i], pz[i]);
      if (d > R) {
        px[i] *= R / d;
        pz[i] *= R / d;
      }
      vx[i] = (px[i] - ox[i]) / h;
      vz[i] = (pz[i] - oz[i]) / h;
    }
  }

  private viscosity(H: number, h: number) {
    const { px, pz, vx, vz, GN, cellStart, cellItems, cellOf } = this;
    const sigma = this.cfg.viscosity * 6;
    const inv = 1 / H;
    for (let i = 0; i < this.n; i++) {
      const c = cellOf[i];
      const cx = c % GN;
      const cz = (c / GN) | 0;
      for (let b = Math.max(0, cz - 1); b <= Math.min(GN - 1, cz + 1); b++)
        for (let a = Math.max(0, cx - 1); a <= Math.min(GN - 1, cx + 1); a++) {
          const cc = b * GN + a;
          for (let s = cellStart[cc]; s < cellStart[cc + 1]; s++) {
            const j = cellItems[s];
            if (j <= i) continue;
            const rx = px[j] - px[i];
            const rz = pz[j] - pz[i];
            const r = Math.hypot(rx, rz);
            const q = r * inv;
            if (q >= 1 || r < 1e-6) continue;
            const ux = rx / r;
            const uz = rz / r;
            const u = (vx[i] - vx[j]) * ux + (vz[i] - vz[j]) * uz;
            if (u <= 0) continue;
            const I = h * (1 - q) * sigma * u * 0.5;
            vx[i] -= I * ux;
            vz[i] -= I * uz;
            vx[j] += I * ux;
            vz[j] += I * uz;
          }
        }
    }
  }

  private buildGrid() {
    const { GN, cellStart, cellItems, cellOf } = this;
    const inv = 1 / this.H;
    cellStart.fill(0);
    for (let i = 0; i < this.n; i++) {
      const cx = Math.min(GN - 1, Math.max(0, Math.floor((this.px[i] + EXT) * inv)));
      const cz = Math.min(GN - 1, Math.max(0, Math.floor((this.pz[i] + EXT) * inv)));
      const c = cz * GN + cx;
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 0; c < GN * GN; c++) cellStart[c + 1] += cellStart[c];
    const fill = cellStart.slice(0, GN * GN);
    for (let i = 0; i < this.n; i++) cellItems[fill[cellOf[i]]++] = i;
  }

  private stepDrops(dt: number) {
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.vy -= 7 * dt;
      d.y += d.vy * dt;
      const surface = this.thicknessAt(d.x, d.z) + d.r * 0.6;
      if (d.y <= surface) {
        // Splash down: the drop becomes liquid with an outward kick.
        const start = this.n;
        this.addBlob(d.x, d.z, 0.1, d.count);
        for (let k = start; k < this.n; k++) {
          const dx = this.px[k] - d.x;
          const dz = this.pz[k] - d.z;
          this.vx[k] = dx * 4;
          this.vz[k] = dz * 4;
        }
        this.drops.splice(i, 1);
        this.landedThisFrame++;
      }
    }
  }

  // ------------------------------------------------------------------ surface

  private splat() {
    const t = this.thick;
    const tmp = this.tmp;
    tmp.fill(0);
    const cell = (2 * EXT) / GRID;
    const R = 0.085;
    const rc = Math.ceil(R / cell);
    const vol = 0.0135; // thickness contributed per particle at its centre
    for (let i = 0; i < this.n; i++) {
      const gx = (this.px[i] + EXT) / cell;
      const gz = (this.pz[i] + EXT) / cell;
      const cx = Math.floor(gx);
      const cz = Math.floor(gz);
      for (let z = cz - rc; z <= cz + rc; z++) {
        if (z < 0 || z >= GRID) continue;
        for (let x = cx - rc; x <= cx + rc; x++) {
          if (x < 0 || x >= GRID) continue;
          const d2 = ((x + 0.5 - gx) ** 2 + (z + 0.5 - gz) ** 2) * cell * cell;
          if (d2 >= R * R) continue;
          const w = 1 - d2 / (R * R);
          tmp[z * GRID + x] += vol * w * w;
        }
      }
    }
    // Separable 1-2-1 blur, then a soft saturation so crowded regions heap without exploding.
    for (let z = 0; z < GRID; z++)
      for (let x = 0; x < GRID; x++) {
        const i = z * GRID + x;
        const l = x > 0 ? tmp[i - 1] : tmp[i];
        const r = x < GRID - 1 ? tmp[i + 1] : tmp[i];
        t[i] = (l + 2 * tmp[i] + r) * 0.25;
      }
    for (let z = 0; z < GRID; z++)
      for (let x = 0; x < GRID; x++) {
        const i = z * GRID + x;
        const u = z > 0 ? t[i - GRID] : t[i];
        const d = z < GRID - 1 ? t[i + GRID] : t[i];
        const v = (u + 2 * t[i] + d) * 0.25;
        tmp[i] = v;
      }
    for (let i = 0; i < t.length; i++) {
      const v = tmp[i];
      t[i] = 0.32 * (1 - Math.exp(-v / 0.32));
    }
  }

  thicknessAt(x: number, z: number) {
    const cell = (2 * EXT) / GRID;
    const gx = (x + EXT) / cell - 0.5;
    const gz = (z + EXT) / cell - 0.5;
    const x0 = Math.max(0, Math.min(GRID - 2, Math.floor(gx)));
    const z0 = Math.max(0, Math.min(GRID - 2, Math.floor(gz)));
    const fx = Math.min(1, Math.max(0, gx - x0));
    const fz = Math.min(1, Math.max(0, gz - z0));
    const t = this.thick;
    const a = t[z0 * GRID + x0] * (1 - fx) + t[z0 * GRID + x0 + 1] * fx;
    const b = t[(z0 + 1) * GRID + x0] * (1 - fx) + t[(z0 + 1) * GRID + x0 + 1] * fx;
    return a * (1 - fz) + b * fz;
  }

  private spikes(dt: number, mags: Magnet[]) {
    const Bc = 0.34; // critical field for the normal-field instability
    const kS = 190;
    const damp = 8.5;
    const d = this.cellData;
    d.fill(0);
    for (let i = 0; i < this.nCells; i++) {
      const x = this.cellX[i];
      const z = this.cellZ[i];
      const th = this.thicknessAt(x, z);
      const presence = smooth(0.012, 0.045, th);
      const B = this.field(x, z, mags);
      const target = presence * Math.min(0.26, Math.max(0, B - Bc) * 0.75) * (0.6 + 3 * Math.min(th, 0.15));
      const before = this.amp[i];
      this.ampV[i] += ((target - this.amp[i]) * kS - this.ampV[i] * damp) * dt;
      this.amp[i] = Math.max(0, this.amp[i] + this.ampV[i] * dt);
      if (before < 0.05 && this.amp[i] >= 0.05) this.snapsThisFrame++;
      // Spikes lean along the field toward the strongest nearby magnet, with inertia.
      let gx = 0;
      let gz = 0;
      for (const m of mags) {
        const dx = m.x - x;
        const dz = m.z - z;
        const dd = Math.hypot(dx, dz) + 1e-4;
        const w = (m.strength * this.cfg.strength) / (1 + (dd * dd) / 0.09) ** 1.5;
        gx += (dx / dd) * w * Math.min(1, dd / 0.2);
        gz += (dz / dd) * w * Math.min(1, dd / 0.2);
      }
      const tx = gx * 0.35;
      const tz = gz * 0.35;
      this.tiltVX[i] += ((tx - this.tiltX[i]) * 90 - this.tiltVX[i] * 7) * dt;
      this.tiltVZ[i] += ((tz - this.tiltZ[i]) * 90 - this.tiltVZ[i] * 7) * dt;
      this.tiltX[i] += this.tiltVX[i] * dt;
      this.tiltZ[i] += this.tiltVZ[i] * dt;
      const o = ((this.cellR[i] + 16) * CELL_TEX + (this.cellQ[i] + 16)) * 4;
      d[o] = this.amp[i];
      d[o + 1] = clamp(this.tiltX[i], -0.6, 0.6);
      d[o + 2] = clamp(this.tiltZ[i], -0.6, 0.6);
      d[o + 3] = presence;
    }
  }
}

function smooth(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
