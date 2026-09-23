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
  readonly n: number;
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  readonly vel: Float32Array;
  readonly invMass: Float32Array;
  readonly uv: Float32Array;
  readonly pinned: Uint8Array;
  // Constraints
  readonly ca: Int32Array;
  readonly cb: Int32Array;
  readonly rest: Float32Array;
  readonly kind: Uint8Array;
  readonly alive: Uint8Array;
  /** For bend constraints: the two stretch constraints they span; the bend dies with either. */
  readonly bendVia: Int32Array;
  readonly nc: number;
  // Triangles
  readonly tris: Uint32Array;
  readonly triEdges: Int32Array;
  readonly triAlive: Uint8Array;
  readonly nt: number;
  /** Bumps whenever triangles die so the renderer can rebuild its index buffer. */
  topology = 0;
  tornThisFrame = 0;
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
    stretchCompliance: 0,
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
    for (let s = 0; s < substeps; s++) {
      this.integrate(h);
      this.solve(h);
      this.collide();
      this.updateVelocities(h);
    }
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

  private solve(h: number) {
    const { pos, invMass, ca, cb, rest, kind, alive, bendVia } = this;
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
      if (tear > 0 && k !== Kind.Bend && len > r0 * tear) {
        alive[c] = 0;
        this.tornThisFrame++;
        continue;
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

  /** Cuts every tearable constraint whose screen-space projection crosses the segment. */
  cut(project: (x: number, y: number, z: number) => [number, number], ax: number, ay: number, bx: number, by: number) {
    const { pos, ca, cb, alive, kind } = this;
    let cutCount = 0;
    const cache = new Float32Array(this.n * 2);
    for (let i = 0; i < this.n; i++) {
      const [sx, sy] = project(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
      cache[i * 2] = sx;
      cache[i * 2 + 1] = sy;
    }
    for (let c = 0; c < this.nc; c++) {
      if (!alive[c] || kind[c] === Kind.Bend) continue;
      const i = ca[c];
      const j = cb[c];
      if (segmentsCross(ax, ay, bx, by, cache[i * 2], cache[i * 2 + 1], cache[j * 2], cache[j * 2 + 1])) {
        alive[c] = 0;
        cutCount++;
      }
    }
    if (cutCount) this.refreshTriangles();
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
