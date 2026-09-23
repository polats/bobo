// Tearable cloth with XPBD "small steps" (Macklin et al. 2019; Müller's Ten Minute Physics #14/#15):
// many substeps, one Gauss-Seidel pass of distance constraints each, constraints break when overstretched.

export const enum Kind {
  Stretch = 0, // grid edges and the triangle diagonal: tearable, define the rendered triangles
  Shear = 1, // the other diagonal: tearable, keeps the weave from shearing flat
  Bend = 2, // skip-one springs: soft, removed when the fabric between them tears
}

export type Scene = 'curtain' | 'flag' | 'hammock';

export interface Ball {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  hue: number;
  age: number;
  px: number;
  py: number;
  pz: number;
  /** Inverse mass relative to one cloth particle. */
  w: number;
  hitWall?: boolean;
}

export class Cloth {
  readonly cols: number;
  readonly rows: number;
  n: number;
  pos: Float32Array;
  prev: Float32Array;
  vel: Float32Array;
  invMass: Float32Array;
  uv: Float32Array;
  pinned: Uint8Array;
  // Constraints
  ca: Int32Array;
  cb: Int32Array;
  rest: Float32Array;
  kind: Uint8Array;
  alive: Uint8Array;
  /** For bend constraints: the two stretch constraints they span; the bend dies with either. */
  bendVia: Int32Array;
  nc: number;
  // Triangles
  tris: Uint32Array;
  triEdges: Int32Array;
  readonly triAlive: Uint8Array;
  readonly nt: number;
  /** Bumps whenever triangles die so the renderer can rebuild its index buffer. */
  topology = 0;
  tornThisFrame = 0;
  /** Per-constraint tear threshold multiplier: random wobble plus crack-tip weakening. */
  weak!: Float32Array;
  /** Per-particle stretch (len / rest - 1) from the last substep, for stress whitening. */
  strain!: Float32Array;
  maxStrain = 0;
  /** Finger holds: soft attachments of a patch of particles to a moving target. */
  handles: { verts: Int32Array; offsets: Float32Array; weights: Float32Array; target: [number, number, number] }[] = [];
  private pending: number[] = [];
  private queued!: Uint8Array;
  private capP = 0;
  private capC = 0;
  /** Seconds since creation; tearing waits for the cloth to settle after a reset. */
  age = 0;
  readonly width: number;
  readonly height: number;
  readonly floorY: number;
  readonly wallZ: number;
  readonly balls: Ball[] = [];
  grabbed = -1;
  grabTarget: [number, number, number] = [0, 0, 0];

  cfg = {
    substeps: 12,
    gravity: 9.8,
    stretchCompliance: 1.5e-7, // a little give, so you see the fabric strain before it rips
    bendCompliance: 0.8,
    tear: 1.8, // break when stretched past this multiple of rest length; <= 0 means indestructible
    wind: 0,
    damping: 0.4,
  };

  constructor(readonly scene: Scene, resolution: number) {
    const W = scene === 'flag' ? 1.5 : 1.4;
    const H = scene === 'flag' ? 1.0 : scene === 'hammock' ? 1.3 : 2.0;
    const spacing = W / (resolution - 1);
    const cols = resolution;
    const rows = Math.max(3, Math.round(H / spacing) + 1);
    this.cols = cols;
    this.rows = rows;
    this.width = W;
    this.height = H;
    this.floorY = -1.35;
    this.wallZ = scene === 'hammock' ? -2.2 : -0.7;
    const n = (this.n = cols * rows);
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.invMass = new Float32Array(n);
    this.uv = new Float32Array(n * 2);
    this.pinned = new Uint8Array(n);

    const top = scene === 'flag' ? 0.75 : 1.0;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        let x = -W / 2 + c * spacing;
        let y = top - r * spacing;
        let z = 0.004 * Math.sin(c * 1.7 + r * 0.9);
        if (scene === 'hammock') y += 0.004 * Math.sin(c * 1.7 + r * 0.9);
        if (scene === 'flag') x += 0.05;
        // Curtain hangs from rings gathered on a rod, which throws natural pleats.
        if (scene === 'curtain' && r === 0) x *= 0.82;
        if (scene === 'hammock') {
          // Lies flat, spanning x and z, pinned by its corners like a trampoline.
          y = 0;
          z = -H / 2 + r * spacing;
        }
        this.pos.set([x, y, z], i * 3);
        this.uv.set([c / (cols - 1), r / (rows - 1)], i * 2);
        this.invMass[i] = 1;
      }
    const pin = (i: number) => {
      this.invMass[i] = 0;
      this.pinned[i] = 1;
    };
    // Every top particle hangs from the gathered rod, so the heavy curtain can't rip itself on load.
    if (scene === 'curtain') for (let c = 0; c < cols; c++) pin(c);
    if (scene === 'flag') for (let r = 0; r < rows; r++) pin(r * cols);
    if (scene === 'hammock') {
      pin(0);
      pin(cols - 1);
      pin((rows - 1) * cols);
      pin(rows * cols - 1);
    }
    if (scene === 'flag') this.cfg.wind = 5;

    // --- constraints ---
    const a: number[] = [];
    const b: number[] = [];
    const k: number[] = [];
    const via: number[] = [];
    const edgeId = new Map<number, number>();
    const add = (i: number, j: number, kind: Kind, v0 = -1, v1 = -1) => {
      edgeId.set(i < j ? i * n + j : j * n + i, a.length);
      a.push(i);
      b.push(j);
      k.push(kind);
      via.push(v0, v1);
      return a.length - 1;
    };
    const id = (r: number, c: number) => r * cols + c;
    const edge = (i: number, j: number) => edgeId.get(i < j ? i * n + j : j * n + i)!;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (c + 1 < cols) add(id(r, c), id(r, c + 1), Kind.Stretch);
        if (r + 1 < rows) add(id(r, c), id(r + 1, c), Kind.Stretch);
      }
    const tris: number[] = [];
    const triEdges: number[] = [];
    for (let r = 0; r + 1 < rows; r++)
      for (let c = 0; c + 1 < cols; c++) {
        const p00 = id(r, c);
        const p10 = id(r, c + 1);
        const p01 = id(r + 1, c);
        const p11 = id(r + 1, c + 1);
        // Alternate the diagonal so tears don't all run the same way.
        if ((r + c) % 2 === 0) {
          const d = add(p00, p11, Kind.Stretch);
          add(p10, p01, Kind.Shear);
          tris.push(p00, p01, p11, p00, p11, p10);
          triEdges.push(edge(p00, p01), edge(p01, p11), d, d, edge(p11, p10), edge(p10, p00));
        } else {
          const d = add(p10, p01, Kind.Stretch);
          add(p00, p11, Kind.Shear);
          tris.push(p00, p01, p10, p10, p01, p11);
          triEdges.push(edge(p00, p01), d, edge(p10, p00), d, edge(p01, p11), edge(p11, p10));
        }
      }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c + 2 < cols; c++) add(id(r, c), id(r, c + 2), Kind.Bend, edge(id(r, c), id(r, c + 1)), edge(id(r, c + 1), id(r, c + 2)));
    for (let r = 0; r + 2 < rows; r++)
      for (let c = 0; c < cols; c++) add(id(r, c), id(r + 2, c), Kind.Bend, edge(id(r, c), id(r + 1, c)), edge(id(r + 1, c), id(r + 2, c)));

    this.nc = a.length;
    this.ca = Int32Array.from(a);
    this.cb = Int32Array.from(b);
    this.kind = Uint8Array.from(k);
    this.bendVia = Int32Array.from(via);
    this.alive = new Uint8Array(this.nc).fill(1);
    this.rest = new Float32Array(this.nc);
    for (let c = 0; c < this.nc; c++) this.rest[c] = this.dist(this.ca[c], this.cb[c]);
    // Gathered curtain top: rest lengths come from the flat layout, not the pleated start.
    if (scene === 'curtain') for (let c = 0; c < this.nc; c++) {
      if (this.kind[c] === Kind.Stretch && this.ca[c] < cols && this.cb[c] < cols) this.rest[c] = spacing;
      if (this.kind[c] === Kind.Bend && this.ca[c] < cols && this.cb[c] < cols) this.rest[c] = spacing * 2;
    }
    this.tris = Uint32Array.from(tris);
    this.triEdges = Int32Array.from(triEdges);
    this.nt = tris.length / 3;
    this.triAlive = new Uint8Array(this.nt).fill(1);
    this.prev.set(this.pos);
    this.reserve();
  }

  /** Grow every array to leave room for vertices and constraints created by tearing. */
  private reserve() {
    this.capP = this.n * 3;
    this.capC = this.nc * 3;
    const grow = <T extends Float32Array | Int32Array | Uint8Array | Uint32Array>(a: T, size: number): T => {
      const b = new (a.constructor as new (n: number) => T)(size);
      b.set(a);
      return b;
    };
    this.pos = grow(this.pos, this.capP * 3);
    this.prev = grow(this.prev, this.capP * 3);
    this.vel = grow(this.vel, this.capP * 3);
    this.invMass = grow(this.invMass, this.capP);
    this.uv = grow(this.uv, this.capP * 2);
    this.pinned = grow(this.pinned, this.capP);
    this.strain = new Float32Array(this.capP);
    this.ca = grow(this.ca, this.capC);
    this.cb = grow(this.cb, this.capC);
    this.rest = grow(this.rest, this.capC);
    this.kind = grow(this.kind, this.capC);
    this.alive = grow(this.alive, this.capC);
    this.bendVia = grow(this.bendVia, this.capC * 2);
    this.queued = new Uint8Array(this.capC);
    this.weak = new Float32Array(this.capC);
    // A little random variation per thread so rips wander instead of running on rails.
    for (let c = 0; c < this.nc; c++) this.weak[c] = 0.9 + Math.random() * 0.2;
  }

  private dist(i: number, j: number) {
    const p = this.pos;
    return Math.hypot(p[i * 3] - p[j * 3], p[i * 3 + 1] - p[j * 3 + 1], p[i * 3 + 2] - p[j * 3 + 2]);
  }

  step(dt: number, t: number) {
    const { substeps } = this.cfg;
    const h = dt / substeps;
    this.tornThisFrame = 0;
    this.age += dt;
    this.applyWind(dt, t);
    let budget = 24;
    for (let s = 0; s < substeps; s++) {
      this.integrate(h);
      this.solve(h, s === substeps - 1);
      this.attach();
      while (this.pending.length && budget > 0) {
        const c = this.pending.pop()!;
        this.queued[c] = 0;
        if (this.alive[c] && this.tear(c)) budget--;
      }
      this.pending.length = 0;
      this.collide();
      this.updateVelocities(h);
    }
    // Crack tips heal back toward normal strength so old rips don't stay hair-trigger forever.
    const heal = 1 - Math.exp(-dt * 0.8);
    for (let c = 0; c < this.nc; c++) if (this.weak[c] < 0.9) this.weak[c] += (0.9 - this.weak[c]) * heal;
    this.stepBalls(dt);
    if (this.tornThisFrame) this.refreshTriangles();
  }

  private integrate(h: number) {
    const { pos, prev, vel, invMass } = this;
    const g = this.cfg.gravity;
    const damp = Math.exp(-this.cfg.damping * h);
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
    for (const b of this.balls) {
      b.px = b.x;
      b.py = b.y;
      b.pz = b.z;
      b.vy -= g * h;
      b.x += b.vx * h;
      b.y += b.vy * h;
      b.z += b.vz * h;
    }
    if (this.grabbed >= 0) {
      const o = this.grabbed * 3;
      // Ease toward the finger so fast flicks don't teleport a single vertex.
      pos[o] += (this.grabTarget[0] - pos[o]) * 0.5;
      pos[o + 1] += (this.grabTarget[1] - pos[o + 1]) * 0.5;
      pos[o + 2] += (this.grabTarget[2] - pos[o + 2]) * 0.5;
    }
  }

  private solve(h: number, last: boolean) {
    const { pos, invMass, ca, cb, rest, kind, alive, bendVia, weak, strain } = this;
    if (last) {
      strain.fill(0, 0, this.n);
      this.maxStrain = 0;
    }
    const alphaStretch = this.cfg.stretchCompliance / (h * h);
    const alphaBend = (this.cfg.bendCompliance * 1e-3) / (h * h);
    const tear = this.age > 0.6 ? this.cfg.tear : 0;
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
      if (len < 1e-9) continue;
      const r0 = rest[c];
      if (k !== Kind.Bend) {
        const st = len / r0 - 1;
        if (last && st > 0) {
          if (st > strain[i]) strain[i] = st;
          if (st > strain[j]) strain[j] = st;
          if (st > this.maxStrain) this.maxStrain = st;
        }
        if (tear > 0 && len > r0 * (1 + (tear - 1) * weak[c])) {
          if (k === Kind.Shear) {
            alive[c] = 0;
            continue;
          }
          if (!this.queued[c]) {
            this.queued[c] = 1;
            this.pending.push(c);
          }
        }
      }
      const alpha = k === Kind.Bend ? alphaBend : alphaStretch;
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

  private collide() {
    const { pos, prev, invMass } = this;
    const floor = this.floorY;
    for (let i = 0; i < this.n; i++) {
      if (invMass[i] === 0) continue;
      const o = i * 3;
      if (pos[o + 1] < floor) {
        pos[o + 1] = floor;
        // Floor friction: cancel most tangential travel this substep.
        pos[o] = prev[o] + (pos[o] - prev[o]) * 0.2;
        pos[o + 2] = prev[o + 2] + (pos[o + 2] - prev[o + 2]) * 0.2;
      }
    }
    // Balls and cloth push each other apart, split by inverse mass, so a heavy ball sags the sheet.
    for (const ball of this.balls) {
      const rr = ball.r + 0.012;
      for (let i = 0; i < this.n; i++) {
        const o = i * 3;
        const dx = pos[o] - ball.x;
        const dy = pos[o + 1] - ball.y;
        const dz = pos[o + 2] - ball.z;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= rr * rr || d2 < 1e-12) continue;
        const d = Math.sqrt(d2);
        const push = rr - d;
        const wp = invMass[i];
        const wsum = wp + ball.w;
        const kp = wp / wsum;
        const kb = ball.w / wsum;
        pos[o] += (dx / d) * push * kp;
        pos[o + 1] += (dy / d) * push * kp;
        pos[o + 2] += (dz / d) * push * kp;
        ball.x -= (dx / d) * push * kb;
        ball.y -= (dy / d) * push * kb;
        ball.z -= (dz / d) * push * kb;
      }
      if (ball.y - ball.r < floor) ball.y = floor + ball.r;
      if (ball.z - ball.r < this.wallZ) {
        ball.z = this.wallZ + ball.r;
        ball.hitWall = true;
      }
    }
  }

  private updateVelocities(h: number) {
    const { pos, prev, vel, invMass } = this;
    for (const b of this.balls) {
      b.vx = (b.x - b.px) / h;
      b.vy = (b.y - b.py) / h;
      b.vz = (b.z - b.pz) / h;
      if (b.hitWall) {
        b.vz = Math.abs(b.pz - b.z) / h * 0.5;
        b.hitWall = false;
      }
      // Rolling friction and a bouncy floor.
      if (b.y - b.r <= this.floorY + 1e-4) {
        b.vx *= 0.995;
        b.vz *= 0.995;
      }
    }
    for (let i = 0; i < this.n; i++) {
      if (invMass[i] === 0) continue;
      const o = i * 3;
      vel[o] = (pos[o] - prev[o]) / h;
      vel[o + 1] = (pos[o + 1] - prev[o + 1]) / h;
      vel[o + 2] = (pos[o + 2] - prev[o + 2]) / h;
    }
  }

  /** Per-triangle aerodynamic push: wind acts on the part of the surface facing it. */
  private applyWind(dt: number, t: number) {
    const strength = this.cfg.wind;
    if (strength <= 0) return;
    const gust = 0.6 + 0.4 * Math.sin(t * 1.3) * Math.sin(t * 0.37 + 1);
    const wx = strength * gust;
    const wz = strength * 0.35 * Math.sin(t * 0.9);
    const { pos, vel, invMass, tris, triAlive } = this;
    for (let tIdx = 0; tIdx < this.nt; tIdx++) {
      if (!triAlive[tIdx]) continue;
      const a = tris[tIdx * 3] * 3;
      const b = tris[tIdx * 3 + 1] * 3;
      const c = tris[tIdx * 3 + 2] * 3;
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
      const rvy = -(vel[a + 1] + vel[b + 1] + vel[c + 1]) / 3;
      const rvz = wz - (vel[a + 2] + vel[b + 2] + vel[c + 2]) / 3;
      // Pressure drag on the facing component; per unit mass, so it doesn't depend on resolution.
      const f = (nx * rvx + ny * rvy + nz * rvz) * 1.2 * dt;
      for (const v of [a, b, c]) {
        if (invMass[v / 3] === 0) continue;
        vel[v] += nx * f;
        vel[v + 1] += ny * f;
        vel[v + 2] += nz * f;
      }
    }
  }

  /** Pull held patches toward their fingers; soft, so the load spreads into the fabric. */
  private attach() {
    const { pos } = this;
    for (const hd of this.handles) {
      for (let k = 0; k < hd.verts.length; k++) {
        const o = hd.verts[k] * 3;
        const f = hd.weights[k];
        pos[o] += (hd.target[0] + hd.offsets[k * 3] - pos[o]) * f;
        pos[o + 1] += (hd.target[1] + hd.offsets[k * 3 + 1] - pos[o + 1]) * f;
        pos[o + 2] += (hd.target[2] + hd.offsets[k * 3 + 2] - pos[o + 2]) * f;
      }
    }
  }

  /**
   * Tear thread c by splitting one endpoint across the plane perpendicular to the thread
   * (cutting by vertex splitting): the crack opens across the pull, which relieves the tension
   * and leaves clean edges instead of holes.
   */
  tear(c: number): boolean {
    const a = this.ca[c];
    const b = this.cb[c];
    const p = this.pos;
    let dx = p[b * 3] - p[a * 3], dy = p[b * 3 + 1] - p[a * 3 + 1], dz = p[b * 3 + 2] - p[a * 3 + 2];
    const dl = Math.hypot(dx, dy, dz) || 1;
    dx /= dl;
    dy /= dl;
    dz /= dl;
    // Split the more strained free endpoint; the plane normal points from it toward the other end.
    const aFree = !this.pinned[a] && this.invMass[a] > 0;
    const bFree = !this.pinned[b] && this.invMass[b] > 0;
    let v = a;
    let sx = dx, sy = dy, sz = dz;
    if (!aFree || (bFree && this.strain[b] > this.strain[a])) {
      v = b;
      sx = -dx;
      sy = -dy;
      sz = -dz;
    }
    const w = this.split(v, sx, sy, sz);
    if (!w) {
      this.alive[c] = 0;
      this.tornThisFrame++;
      this.refreshTriangles();
      return true;
    }
    // The threads at the crack tip that carry the same pull are the next to go: the rip runs.
    for (let k = 0; k < this.nc; k++) {
      if (!this.alive[k] || this.kind[k] === Kind.Bend) continue;
      const i = this.ca[k], j = this.cb[k];
      if (i !== v && j !== v && i !== w && j !== w) continue;
      const ex = p[j * 3] - p[i * 3], ey = p[j * 3 + 1] - p[i * 3 + 1], ez = p[j * 3 + 2] - p[i * 3 + 2];
      const el = Math.hypot(ex, ey, ez) || 1;
      if (Math.abs((ex * dx + ey * dy + ez * dz) / el) > 0.6) this.weak[k] = Math.min(this.weak[k], 0.7);
    }
    this.tornThisFrame++;
    this.topology++;
    return true;
  }

  /** Scissor cut: each end of the thread keeps the triangles on its own side of the blade plane. */
  private slice(c: number, plane: [number, number, number, number]) {
    const p = this.pos;
    const [nx, ny, nz, d] = plane;
    let did = false;
    for (const v of [this.ca[c], this.cb[c]]) {
      if (this.pinned[v] || this.invMass[v] === 0) continue;
      const sv = p[v * 3] * nx + p[v * 3 + 1] * ny + p[v * 3 + 2] * nz + d > 0 ? 1 : -1;
      if (this.split(v, -sv * nx, -sv * ny, -sv * nz, -sv * d)) did = true;
    }
    if (did) {
      this.tornThisFrame++;
      this.topology++;
    } else {
      this.alive[c] = 0;
      this.refreshTriangles();
    }
  }

  private triNormal(t: number): [number, number, number] {
    const p = this.pos;
    const a = this.tris[t * 3] * 3, b = this.tris[t * 3 + 1] * 3, c = this.tris[t * 3 + 2] * 3;
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
    const l = Math.hypot(nx, ny, nz) || 1;
    return [nx / l, ny / l, nz / l];
  }

  /** Duplicate vertex v and move the triangles on t2's side of the cut plane to the copy. Returns the new index or 0. */
  /** `off` given: the plane is dot(x, n) + off = 0 in world space; otherwise it passes through v. */
  private split(v: number, cx: number, cy: number, cz: number, off?: number): number {
    if (this.pinned[v] || this.invMass[v] === 0 || this.n >= this.capP) return 0;
    const p = this.pos;
    const vx = p[v * 3], vy = p[v * 3 + 1], vz = p[v * 3 + 2];
    const sideOf = (x: number, y: number, z: number) =>
      (off === undefined ? (x - vx) * cx + (y - vy) * cy + (z - vz) * cz : x * cx + y * cy + z * cz + off) > 0 ? 1 : -1;
    const side = (t: number) => {
      const a = this.tris[t * 3] * 3, b = this.tris[t * 3 + 1] * 3, c = this.tris[t * 3 + 2] * 3;
      return sideOf((p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3);
    };
    const fan: number[] = [];
    for (let t = 0; t < this.nt; t++) {
      if (!this.triAlive[t]) continue;
      const o = t * 3;
      if (this.tris[o] === v || this.tris[o + 1] === v || this.tris[o + 2] === v) fan.push(t);
    }
    const s2 = 1;
    const moving = new Set(fan.filter((t) => side(t) === s2));
    if (moving.size === fan.length || moving.size === 0) return 0;

    // New vertex, identical to v.
    const w = this.n++;
    for (let k = 0; k < 3; k++) {
      p[w * 3 + k] = p[v * 3 + k];
      this.prev[w * 3 + k] = this.prev[v * 3 + k];
      this.vel[w * 3 + k] = this.vel[v * 3 + k];
    }
    this.invMass[w] = this.invMass[v];
    this.uv[w * 2] = this.uv[v * 2];
    this.uv[w * 2 + 1] = this.uv[v * 2 + 1];
    for (const t of moving) for (let k = 0; k < 3; k++) if (this.tris[t * 3 + k] === v) this.tris[t * 3 + k] = w;

    // Which side uses each triangle edge at v.
    const use = new Map<number, number>(); // 1 = moving side, 2 = staying side, 3 = both
    for (const t of fan) {
      const bit = moving.has(t) ? 1 : 2;
      for (let k = 0; k < 3; k++) {
        const e = this.triEdges[t * 3 + k];
        if (this.ca[e] === v || this.cb[e] === v) use.set(e, (use.get(e) ?? 0) | bit);
      }
    }
    const touched = new Set<number>();
    const reassign = (e: number) => {
      if (this.ca[e] === v) this.ca[e] = w;
      else this.cb[e] = w;
      touched.add(e);
    };
    for (const [e, u] of use) {
      if (u === 1) reassign(e);
      else if (u === 3 && this.nc < this.capC) {
        // Edge shared across the cut: each side keeps its own copy.
        const e2 = this.nc++;
        this.ca[e2] = this.ca[e] === v ? w : this.ca[e];
        this.cb[e2] = this.cb[e] === v ? w : this.cb[e];
        this.rest[e2] = this.rest[e];
        this.kind[e2] = this.kind[e];
        this.alive[e2] = 1;
        this.weak[e2] = this.weak[e];
        this.bendVia[e2 * 2] = this.bendVia[e2 * 2 + 1] = -1;
        for (const t of moving) for (let k = 0; k < 3; k++) if (this.triEdges[t * 3 + k] === e) this.triEdges[t * 3 + k] = e2;
        touched.add(e);
      }
    }
    // Loose shear diagonals follow whichever side their far end is on; bends through v give up.
    for (let e = 0; e < this.nc; e++) {
      if (!this.alive[e] || use.has(e)) continue;
      if (this.ca[e] !== v && this.cb[e] !== v) continue;
      if (this.kind[e] === Kind.Bend) {
        this.alive[e] = 0;
        continue;
      }
      if (this.kind[e] === Kind.Shear) {
        const x = this.ca[e] === v ? this.cb[e] : this.ca[e];
        if (sideOf(p[x * 3], p[x * 3 + 1], p[x * 3 + 2]) === s2) reassign(e);
      }
    }
    // Bends that bridged the new crack would hold it shut.
    for (let e = 0; e < this.nc; e++) {
      if (this.kind[e] !== Kind.Bend || !this.alive[e]) continue;
      if (touched.has(this.bendVia[e * 2]) || touched.has(this.bendVia[e * 2 + 1])) this.alive[e] = 0;
    }
    return w;
  }

  private stepBalls(dt: number) {
    for (const b of this.balls) b.age += dt;
    // Keep the scene light: old balls leave.
    for (let i = this.balls.length - 1; i >= 0; i--) if (this.balls[i].age > 15 || this.balls[i].z < -3) this.balls.splice(i, 1);
  }

  refreshTriangles() {
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

  /** Cuts every tearable thread whose screen-space projection crosses the segment. */
  cut(
    project: (x: number, y: number, z: number) => [number, number],
    ax: number,
    ay: number,
    bx: number,
    by: number,
    plane?: [number, number, number, number],
  ) {
    const { pos, ca, cb, alive, kind } = this;
    let cutCount = 0;
    const n0 = this.n;
    const cache = new Float32Array(n0 * 2);
    for (let i = 0; i < n0; i++) {
      const [sx, sy] = project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      cache[i * 2] = sx;
      cache[i * 2 + 1] = sy;
    }
    const hits: number[] = [];
    const nc0 = this.nc;
    for (let c = 0; c < nc0; c++) {
      if (!alive[c] || kind[c] === Kind.Bend) continue;
      const i = ca[c];
      const j = cb[c];
      if (i >= n0 || j >= n0) continue;
      if (segmentsCross(ax, ay, bx, by, cache[i * 2], cache[i * 2 + 1], cache[j * 2], cache[j * 2 + 1])) hits.push(c);
    }
    for (const c of hits.slice(0, 60)) {
      if (!alive[c]) continue;
      if (kind[c] === Kind.Shear) alive[c] = 0;
      else if (plane) this.slice(c, plane);
      else this.tear(c);
      cutCount++;
    }
    return cutCount;
  }
}

function segmentsCross(ax: number, ay: number, bx: number, by: number, cx: number, cy: number, dx: number, dy: number) {
  const d1 = orient(ax, ay, bx, by, cx, cy);
  const d2 = orient(ax, ay, bx, by, dx, dy);
  const d3 = orient(cx, cy, dx, dy, ax, ay);
  const d4 = orient(cx, cy, dx, dy, bx, by);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

function orient(ax: number, ay: number, bx: number, by: number, cx: number, cy: number) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}
