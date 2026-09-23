// Laundry on a line: several XPBD cloth garments pegged to a sagging XPBD rope.
// Clothespins are soft zero-length constraints that pop when stretched too far; wind is per-triangle drag.

export const enum Kind {
  Stretch = 0,
  Shear = 1,
  Bend = 2,
  Rope = 3,
  Pin = 4,
}

export type GarmentType = 'sheet' | 'towel' | 'shirt' | 'sock' | 'pants' | 'bunting';

export interface GarmentStyle {
  pattern: number; // 0 solid, 1 stripes, 2 gingham, 3 dots, 4 towel bands
  a: [number, number, number];
  b: [number, number, number];
}

export interface Garment {
  type: GarmentType;
  first: number; // particle range
  count: number;
  triFirst: number;
  triCount: number;
  pins: number[]; // constraint ids
  gone: boolean;
}

export interface FlyingPin {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  spin: number;
  age: number;
}

const SPACING = 0.033;

export class Laundry {
  n = 0;
  pos!: Float32Array;
  prev!: Float32Array;
  vel!: Float32Array;
  invMass!: Float32Array;
  uv!: Float32Array;
  pattern!: Float32Array;
  colorA!: Float32Array;
  colorB!: Float32Array;
  nc = 0;
  ca!: Int32Array;
  cb!: Int32Array;
  rest!: Float32Array;
  kind!: Uint8Array;
  alive!: Uint8Array;
  bendVia!: Int32Array;
  nt = 0;
  tris!: Uint32Array;
  triEdges!: Int32Array;
  triAlive!: Uint8Array;
  topology = 0;
  garments: Garment[] = [];
  ropeFirst = 0;
  ropeCount = 0;
  readonly floorY = -1.3;
  readonly lineY = 1.1;
  readonly postX = 1.05;
  flyingPins: FlyingPin[] = [];
  poppedThisFrame = 0;
  tornThisFrame = 0;
  grabbed = -1;
  grabTarget: [number, number, number] = [0, 0, 0];
  gust: [number, number, number] = [0, 0, 0];
  age = 0;

  cfg = {
    substeps: 10,
    gravity: 9.8,
    breeze: 2.5,
    pinStrength: 1, // multiplier on how far a pin may stretch before it pops
    tear: 2.2, // <= 0 disables tearing
    bendCompliance: 1.5,
  };

  constructor(styles: GarmentStyle[]) {
    this.build(styles);
  }

  // ------------------------------------------------------------------ build

  private build(styles: GarmentStyle[]) {
    const P: number[] = [];
    const UV: number[] = [];
    const PAT: number[] = [];
    const CA: number[] = [];
    const CB: number[] = [];
    const W: number[] = [];
    const A: number[] = [];
    const B: number[] = [];
    const K: number[] = [];
    const VIA: number[] = [];
    const T: number[] = [];
    const TE: number[] = [];
    const edgeIds = new Map<string, number>();
    const addC = (i: number, j: number, k: Kind, v0 = -1, v1 = -1) => {
      edgeIds.set(i < j ? `${i},${j}` : `${j},${i}`, A.length);
      A.push(i);
      B.push(j);
      K.push(k);
      VIA.push(v0, v1);
      return A.length - 1;
    };
    const edge = (i: number, j: number) => edgeIds.get(i < j ? `${i},${j}` : `${j},${i}`) ?? -1;
    const addP = (x: number, y: number, z: number, w: number, u = 0, v = 0, style?: GarmentStyle) => {
      P.push(x, y, z);
      W.push(w);
      UV.push(u, v);
      PAT.push(style ? style.pattern : -1);
      CA.push(...(style ? style.a : [0, 0, 0]));
      CB.push(...(style ? style.b : [0, 0, 0]));
      return W.length - 1;
    };

    // Rope between two posts, a touch longer than the span so it sags.
    const ropeN = 56;
    this.ropeFirst = 0;
    this.ropeCount = ropeN;
    const x0 = -this.postX;
    const x1 = this.postX;
    for (let i = 0; i < ropeN; i++) {
      const f = i / (ropeN - 1);
      addP(x0 + (x1 - x0) * f, this.lineY, 0, i === 0 || i === ropeN - 1 ? 0 : 0.35);
    }
    const ropeSeg = ((x1 - x0) / (ropeN - 1)) * 1.035;
    for (let i = 0; i + 1 < ropeN; i++) addC(i, i + 1, Kind.Rope);
    const ropeAt = (x: number) => Math.max(1, Math.min(ropeN - 2, Math.round(((x - x0) / (x1 - x0)) * (ropeN - 1))));

    // Garments laid out left to right along the line.
    const layout: { type: GarmentType; w: number; h: number; x: number }[] = [
      { type: 'shirt', w: 0.46, h: 0.46, x: -0.72 },
      { type: 'sock', w: 0.14, h: 0.3, x: -0.38 },
      { type: 'sock', w: 0.14, h: 0.3, x: -0.22 },
      { type: 'sheet', w: 0.58, h: 0.8, x: 0.18 },
      { type: 'towel', w: 0.34, h: 0.5, x: 0.7 },
    ];
    const garments: Garment[] = [];
    layout.forEach((g, gi) => {
      const style = styles[gi % styles.length];
      const cols = Math.max(3, Math.round(g.w / SPACING) + 1);
      const rows = Math.max(3, Math.round(g.h / SPACING) + 1);
      const mask = shapeMask(g.type);
      const cellOn = (r: number, c: number) => mask((c + 0.5) / (cols - 1), (r + 0.5) / (rows - 1));
      const ids = new Int32Array(cols * rows).fill(-1);
      const first = W.length;
      const left = g.x - g.w / 2;
      // Clip-on garments hang flat; a tiny z wobble breaks the symmetry so wind can grab them.
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const touches =
            (r < rows - 1 && c < cols - 1 && cellOn(r, c)) ||
            (r < rows - 1 && c > 0 && cellOn(r, c - 1)) ||
            (r > 0 && c < cols - 1 && cellOn(r - 1, c)) ||
            (r > 0 && c > 0 && cellOn(r - 1, c - 1));
          if (!touches) continue;
          ids[r * cols + c] = addP(
            left + c * SPACING,
            this.lineY - 0.012 - r * SPACING,
            0.003 * Math.sin(c * 2.1 + r * 1.3 + gi),
            1,
            c / (cols - 1),
            r / (rows - 1),
            style,
          );
        }
      const id = (r: number, c: number) => (r >= 0 && c >= 0 && r < rows && c < cols ? ids[r * cols + c] : -1);
      for (let r = 0; r < rows; r++)
        for (let c = 0; c < cols; c++) {
          const i = id(r, c);
          if (i < 0) continue;
          const right = id(r, c + 1);
          const down = id(r + 1, c);
          if (right >= 0) addC(i, right, Kind.Stretch);
          if (down >= 0) addC(i, down, Kind.Stretch);
        }
      const triFirst = T.length / 3;
      for (let r = 0; r + 1 < rows; r++)
        for (let c = 0; c + 1 < cols; c++) {
          if (!cellOn(r, c)) continue;
          const p00 = id(r, c), p10 = id(r, c + 1), p01 = id(r + 1, c), p11 = id(r + 1, c + 1);
          if (p00 < 0 || p10 < 0 || p01 < 0 || p11 < 0) continue;
          if ((r + c) % 2 === 0) {
            const d = addC(p00, p11, Kind.Stretch);
            addC(p10, p01, Kind.Shear);
            T.push(p00, p01, p11, p00, p11, p10);
            TE.push(edge(p00, p01), edge(p01, p11), d, d, edge(p11, p10), edge(p10, p00));
          } else {
            const d = addC(p10, p01, Kind.Stretch);
            addC(p00, p11, Kind.Shear);
            T.push(p00, p01, p10, p10, p01, p11);
            TE.push(edge(p00, p01), d, edge(p10, p00), d, edge(p01, p11), edge(p11, p10));
          }
        }
      for (let r = 0; r < rows; r++)
        for (let c = 0; c + 2 < cols; c++) {
          const a = id(r, c), m = id(r, c + 1), b = id(r, c + 2);
          if (a >= 0 && m >= 0 && b >= 0) addC(a, b, Kind.Bend, edge(a, m), edge(m, b));
        }
      for (let r = 0; r + 2 < rows; r++)
        for (let c = 0; c < cols; c++) {
          const a = id(r, c), m = id(r + 1, c), b = id(r + 2, c);
          if (a >= 0 && m >= 0 && b >= 0) addC(a, b, Kind.Bend, edge(a, m), edge(m, b));
        }
      // Clothespins on the top row: the outer corners, plus the middle for wide pieces.
      const topCols: number[] = [];
      for (let c = 0; c < cols; c++) if (id(0, c) >= 0) topCols.push(c);
      const pinCols = new Set<number>([topCols[0], topCols[topCols.length - 1]]);
      if (g.w > 0.5) pinCols.add(topCols[Math.floor(topCols.length / 2)]);
      const pins = [...pinCols].map((c) => addC(id(0, c), ropeAt(left + c * SPACING), Kind.Pin));
      garments.push({ type: g.type, first, count: W.length - first, triFirst, triCount: T.length / 3 - triFirst, pins, gone: false });
    });

    this.n = W.length;
    this.pos = Float32Array.from(P);
    this.prev = Float32Array.from(P);
    this.vel = new Float32Array(P.length);
    this.invMass = Float32Array.from(W);
    this.uv = Float32Array.from(UV);
    this.pattern = Float32Array.from(PAT);
    this.colorA = Float32Array.from(CA);
    this.colorB = Float32Array.from(CB);
    this.nc = A.length;
    this.ca = Int32Array.from(A);
    this.cb = Int32Array.from(B);
    this.kind = Uint8Array.from(K);
    this.bendVia = Int32Array.from(VIA);
    this.alive = new Uint8Array(this.nc).fill(1);
    this.rest = new Float32Array(this.nc);
    for (let c = 0; c < this.nc; c++) {
      const k = this.kind[c];
      this.rest[c] = k === Kind.Pin ? 0 : k === Kind.Rope ? ropeSeg : this.dist(this.ca[c], this.cb[c]);
    }
    this.tris = Uint32Array.from(T);
    this.triEdges = Int32Array.from(TE);
    this.nt = T.length / 3;
    this.triAlive = new Uint8Array(this.nt).fill(1);
    this.garments = garments;
  }

  private dist(i: number, j: number) {
    const p = this.pos;
    return Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
  }

  // ------------------------------------------------------------------ step

  step(dt: number, t: number) {
    const sub = this.cfg.substeps;
    const h = dt / sub;
    this.age += dt;
    this.poppedThisFrame = 0;
    this.tornThisFrame = 0;
    this.applyWind(dt, t);
    for (let s = 0; s < sub; s++) {
      this.integrate(h);
      this.solve(h);
      this.collide();
      this.updateVelocities(h);
    }
    // User gusts fade out over about a second.
    const fade = Math.exp(-dt * 1.4);
    this.gust[0] *= fade;
    this.gust[1] *= fade;
    this.gust[2] *= fade;
    this.stepFlyingPins(dt);
    if (this.tornThisFrame || this.poppedThisFrame) this.refresh();
  }

  private integrate(h: number) {
    const { pos, prev, vel, invMass } = this;
    const g = this.cfg.gravity;
    const damp = Math.exp(-0.3 * h);
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      if (invMass[i] === 0) continue;
      vel[o] *= damp;
      vel[o + 1] = (vel[o + 1] - g * h) * damp;
      vel[o + 2] *= damp;
      pos[o] += vel[o] * h;
      pos[o + 1] += vel[o + 1] * h;
      pos[o + 2] += vel[o + 2] * h;
    }
    if (this.grabbed >= 0) {
      const o = this.grabbed * 3;
      pos[o] += (this.grabTarget[0] - pos[o]) * 0.5;
      pos[o + 1] += (this.grabTarget[1] - pos[o + 1]) * 0.5;
      pos[o + 2] += (this.grabTarget[2] - pos[o + 2]) * 0.5;
    }
  }

  private solve(h: number) {
    const { pos, invMass, ca, cb, rest, kind, alive, bendVia } = this;
    const h2 = h * h;
    const alphaBend = (this.cfg.bendCompliance * 1e-3) / h2;
    const alphaPin = 2e-6 / h2;
    const alphaRope = 1e-7 / h2;
    const tear = this.age > 0.6 ? this.cfg.tear : 0;
    const pinBreak = 0.04 * this.cfg.pinStrength;
    const grabbed = this.grabbed;
    for (let c = 0; c < this.nc; c++) {
      if (!alive[c]) continue;
      const k = kind[c];
      if (k === Kind.Bend && (!alive[bendVia[c * 2]] || !alive[bendVia[c * 2 + 1]])) {
        alive[c] = 0;
        continue;
      }
      const i = ca[c];
      const j = cb[c];
      const wi = i === grabbed ? 0 : invMass[i];
      const wj = j === grabbed ? 0 : invMass[j];
      const w = wi + wj;
      if (w === 0) continue;
      const oi = i * 3;
      const oj = j * 3;
      const dx = pos[oi] - pos[oj];
      const dy = pos[oi + 1] - pos[oj + 1];
      const dz = pos[oi + 2] - pos[oj + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const r0 = rest[c];
      if (k === Kind.Pin) {
        if (this.age > 0.6 && len > pinBreak) {
          alive[c] = 0;
          this.poppedThisFrame++;
          this.launchPin(oi);
          continue;
        }
      } else if (tear > 0 && (k === Kind.Stretch || k === Kind.Shear) && len > r0 * tear) {
        alive[c] = 0;
        this.tornThisFrame++;
        continue;
      }
      if (len < 1e-9) continue;
      const alpha = k === Kind.Bend ? alphaBend : k === Kind.Pin ? alphaPin : k === Kind.Rope ? alphaRope : 0;
      const lambda = -(len - r0) / (w + alpha);
      const sx = (dx / len) * lambda;
      const sy = (dy / len) * lambda;
      const sz = (dz / len) * lambda;
      pos[oi] += sx * wi;
      pos[oi + 1] += sy * wi;
      pos[oi + 2] += sz * wi;
      pos[oj] -= sx * wj;
      pos[oj + 1] -= sy * wj;
      pos[oj + 2] -= sz * wj;
    }
  }

  private launchPin(o: number) {
    const p = this.pos;
    this.flyingPins.push({
      x: p[o],
      y: p[o + 1] + 0.02,
      z: p[o + 2] + 0.02,
      vx: (Math.random() - 0.5) * 1.5 + this.gust[0] * 0.1,
      vy: 1.5 + Math.random(),
      vz: 0.6 + Math.random() * 0.6,
      spin: (Math.random() - 0.5) * 20,
      age: 0,
    });
    if (this.flyingPins.length > 40) this.flyingPins.shift();
  }

  private collide() {
    const { pos, prev, invMass } = this;
    const floor = this.floorY;
    for (let i = 0; i < this.n; i++) {
      if (invMass[i] === 0) continue;
      const o = i * 3;
      if (pos[o + 1] < floor) {
        pos[o + 1] = floor;
        pos[o] = prev[o] + (pos[o] - prev[o]) * 0.15;
        pos[o + 2] = prev[o + 2] + (pos[o + 2] - prev[o + 2]) * 0.15;
      }
    }
  }

  private updateVelocities(h: number) {
    const { pos, prev, vel, invMass } = this;
    for (let i = 0; i < this.n; i++) {
      if (invMass[i] === 0) continue;
      const o = i * 3;
      vel[o] = (pos[o] - prev[o]) / h;
      vel[o + 1] = (pos[o + 1] - prev[o + 1]) / h;
      vel[o + 2] = (pos[o + 2] - prev[o + 2]) / h;
    }
  }

  /** Breeze plus user gusts, swirling in space and time; drag acts on the facing side of each triangle. */
  private applyWind(dt: number, t: number) {
    const { pos, vel, invMass, tris, triAlive } = this;
    const base = this.cfg.breeze;
    for (let ti = 0; ti < this.nt; ti++) {
      if (!triAlive[ti]) continue;
      const a = tris[ti * 3] * 3;
      const b = tris[ti * 3 + 1] * 3;
      const c = tris[ti * 3 + 2] * 3;
      const cx = (pos[a] + pos[b] + pos[c]) / 3;
      const cy = (pos[a + 1] + pos[b + 1] + pos[c + 1]) / 3;
      const swirl = Math.sin(cx * 2.3 - t * 1.9) * Math.sin(cy * 3.1 + t * 1.3);
      const gustPulse = 0.55 + 0.45 * Math.sin(t * 0.8 + cx * 0.7) * Math.sin(t * 0.33 + 2);
      const wx = base * gustPulse * (1 + 0.4 * swirl) + this.gust[0];
      const wy = base * 0.25 * swirl + this.gust[1];
      const wz = base * 0.9 * Math.sin(t * 1.1 + cx * 1.7) + this.gust[2];
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      let nx = e1y * e2z - e1z * e2y;
      let ny = e1z * e2x - e1x * e2z;
      let nz = e1x * e2y - e1y * e2x;
      const nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl;
      ny /= nl;
      nz /= nl;
      const rvx = wx - (vel[a] + vel[b] + vel[c]) / 3;
      const rvy = wy - (vel[a + 1] + vel[b + 1] + vel[c + 1]) / 3;
      const rvz = wz - (vel[a + 2] + vel[b + 2] + vel[c + 2]) / 3;
      const f = (nx * rvx + ny * rvy + nz * rvz) * 1.4 * dt;
      for (const v of [a, b, c]) {
        if (invMass[v / 3] === 0) continue;
        vel[v] += nx * f;
        vel[v + 1] += ny * f;
        vel[v + 2] += nz * f;
      }
    }
  }

  private stepFlyingPins(dt: number) {
    for (const p of this.flyingPins) {
      p.age += dt;
      p.vy -= this.cfg.gravity * dt;
      p.vx += this.gust[0] * 0.2 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.y < this.floorY + 0.015) {
        p.y = this.floorY + 0.015;
        p.vy = Math.abs(p.vy) * 0.3;
        p.vx *= 0.6;
        p.vz *= 0.6;
        p.spin *= 0.6;
      }
    }
    for (let i = this.flyingPins.length - 1; i >= 0; i--) if (this.flyingPins[i].age > 20) this.flyingPins.splice(i, 1);
  }

  private refresh() {
    const { triEdges, triAlive, alive } = this;
    let changed = false;
    for (let t = 0; t < this.nt; t++) {
      if (!triAlive[t]) continue;
      if (!alive[triEdges[t * 3]] || !alive[triEdges[t * 3 + 1]] || !alive[triEdges[t * 3 + 2]]) {
        triAlive[t] = 0;
        changed = true;
      }
    }
    if (changed) this.topology++;
  }

  /** Garments blown far off-screen are retired so they stop costing simulation time. */
  retireLost() {
    for (const g of this.garments) {
      if (g.gone) continue;
      let sx = 0;
      let sy = 0;
      for (let i = g.first; i < g.first + g.count; i++) {
        sx += this.pos[i * 3];
        sy += this.pos[i * 3 + 1];
      }
      sx /= g.count;
      sy /= g.count;
      if (Math.abs(sx) > 4 || sy > 5) {
        g.gone = true;
        for (let i = g.first; i < g.first + g.count; i++) {
          this.invMass[i] = 0;
          this.pos[i * 3 + 1] = -50;
        }
        for (let t = g.triFirst; t < g.triFirst + g.triCount; t++) this.triAlive[t] = 0;
        this.topology++;
      }
    }
  }

  get onLine() {
    return this.garments.filter((g) => !g.gone && g.pins.some((p) => this.alive[p])).length;
  }
}

/** Silhouettes in garment-local (u across, v down) coordinates. */
function shapeMask(type: GarmentType): (u: number, v: number) => boolean {
  switch (type) {
    case 'shirt':
      return (u, v) => {
        if (v < 0.07 && Math.abs(u - 0.5) < 0.13) return false; // neckline
        if (v < 0.36) return true; // shoulders and sleeves
        return u > 0.2 && u < 0.8; // body
      };
    case 'sock':
      return (u, v) => u < 0.6 || v > 0.72; // leg plus a foot sticking out
    case 'pants':
      return (u, v) => v < 0.32 || Math.abs(u - 0.5) > 0.07;
    case 'bunting':
      return (u, v) => Math.abs(u - 0.5) < 0.5 - v * 0.5;
    default:
      return () => true;
  }
}
