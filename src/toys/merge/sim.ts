// Copy of Jelly Stack's sim (src/toys/jelly/sim.ts) with jar walls and a larger particle budget.
// Jellies as particle clusters held together by shape matching (Müller et al. 2005, "Meshless
// Deformations Based on Shape Matching"): each substep every body is pulled toward the best-fit
// rotation+linear transform of its rest shape, so it wobbles, squashes and always springs back.
// Bodies collide with each other particle-to-particle through a spatial hash, PBD-style.

import { edgeDistance, inside, outline, type ShapeId } from '../jelly/shapes';

export const RING_SCALES = [1, 0.84, 0.64, 0.42, 0.2];
const OUTLINE_POINTS = 48;
const MAX_PARTICLES = 4000;
const REST_SPEED = 0.35;
const REST_DAMPING = 14;
const SLEEP_SPEED = 0.07;
const SLEEP_AFTER = 0.5;
const WAKE_SPEED = 0.25;
const GRIP_FLOOR = 0.3;

export interface Body {
  shape: ShapeId;
  color: [number, number, number];
  start: number;
  count: number;
  /** Rest offsets from the rest centre of mass. */
  q: Float32Array;
  aqqInv: [number, number, number, number];
  /** 0 = loose jello … 1 = firm gummy. */
  firm: number;
  /** Largest rest distance from the centre, for shading. */
  ext: number;
  halfHeight: number;
  halfWidth: number;
  seed: number;
  face: boolean;
  // Render mesh in rest space (relative to the rest centre of mass).
  verts: Float32Array;
  rim: Float32Array;
  nbr: Int32Array;
  nbw: Float32Array;
  tris: Uint16Array;
  // Per-frame state.
  cx: number;
  cy: number;
  T: [number, number, number, number];
  vx: number;
  vy: number;
  onGround: boolean;
  age: number;
  /** Mean particle speed last frame; slow bodies get settling damping. */
  speed: number;
  /** Seconds spent nearly still; past SLEEP_AFTER the body freezes until something disturbs it. */
  still: number;
  asleep: boolean;
  /** Visual squash-and-stretch springs (log vertical stretch, horizontal shear) and velocities. */
  js: number;
  jsv: number;
  jk: number;
  jkv: number;
  minY: number;
}

export interface Impact {
  x: number;
  y: number;
  strength: number;
  ground: boolean;
}

export interface Handle {
  idx: Int32Array;
  offs: Float32Array;
  w: Float32Array;
  tx: number;
  ty: number;
}

export class JellyWorld {
  readonly pos = new Float32Array(MAX_PARTICLES * 2);
  readonly prev = new Float32Array(MAX_PARTICLES * 2);
  readonly vel = new Float32Array(MAX_PARTICLES * 2);
  readonly owner = new Int16Array(MAX_PARTICLES);
  private readonly vyPre = new Float32Array(MAX_PARTICLES);
  private readonly grounded = new Uint8Array(MAX_PARTICLES);
  /** 1 for particles of sleeping bodies: they don't move and act as solid ground. */
  private readonly frozen = new Uint8Array(MAX_PARTICLES);
  n = 0;
  bodies: Body[] = [];
  handles: Handle[] = [];
  impacts: Impact[] = [];

  /** Particle spacing and collision radius (world units; the short screen side is 1). */
  readonly d = 0.026;
  readonly r = 0.013;
  wW = 1;
  wH = 2;
  groundY = 0.25;
  /** Jar walls (world x); particles are kept between them. */
  left = 0;
  right = 1;

  cfg = {
    substeps: 6,
    iterations: 4,
    gravity: 7,
    wobble: 0.55,
    bounce: 0.35,
    friction: 0.7,
  };

  private cellStart = new Int32Array(1);
  private cellItems = new Int32Array(MAX_PARTICLES);
  private cellOf = new Int32Array(MAX_PARTICLES);
  private cn = new Float32Array(MAX_PARTICLES * 2);
  private cdisp = new Float32Array(MAX_PARTICLES * 2);
  private cpen = new Float32Array(MAX_PARTICLES);
  private cw = new Float32Array(MAX_PARTICLES);
  private cfz = new Float32Array(MAX_PARTICLES);
  private gx = 1;
  private gy = 1;

  resize(wW: number, wH: number, groundY: number) {
    this.wW = wW;
    this.wH = wH;
    this.groundY = groundY;
    this.gx = Math.ceil(wW / this.d) + 2;
    this.gy = Math.ceil((wH + 2) / this.d) + 2;
    this.cellStart = new Int32Array(this.gx * this.gy + 1);
  }

  // ---------------------------------------------------------------- bodies

  spawn(shape: ShapeId, x: number, y: number, size: number, color: [number, number, number], firm: number, angle = 0): Body | null {
    const { d, r } = this;
    const out = outline(shape, size, OUTLINE_POINTS);
    // Particles: a ring just inside the outline plus an interior grid.
    const pts: [number, number][] = [];
    let perim = 0;
    for (let i = 0; i < out.length; i++) {
      const [ax, ay] = out[i];
      const [bx, by] = out[(i + 1) % out.length];
      perim += Math.hypot(bx - ax, by - ay);
    }
    // Even count, starting at the top centre: the ring is mirror-symmetric, so stacks don't lean.
    const ringN = Math.max(8, 2 * Math.round(perim / (d * 0.95) / 2));
    let topArc = 0;
    for (let i = 0; i < out.length / 4; i++) {
      const [ax, ay] = out[i];
      const [bx, by] = out[i + 1];
      topArc += Math.hypot(bx - ax, by - ay);
    }
    for (let k = 0; k < ringN; k++) {
      const [px, py] = pointAlong(out, (topArc + (k / ringN) * perim) % perim);
      const l = Math.hypot(px, py) || 1;
      const inset = Math.max(0.2, 1 - (r * 1.05) / l);
      pts.push([px * inset, py * inset]);
    }
    const ext = Math.max(...out.map(([px, py]) => Math.hypot(px, py)));
    // Interior lattice centred on the origin (odd rows offset by half a step), also symmetric.
    const M = Math.ceil(ext / d) + 1;
    for (let j = -M; j <= M; j++)
      for (let i = -M; i <= M; i++) {
        const jx = (i + (j & 1 ? 0.5 : 0)) * d;
        const gy = j * d * 0.9;
        if (Math.abs(jx) > ext + d) continue;
        if (inside(out, jx, gy) && edgeDistance(out, jx, gy) > d * 1.05) pts.push([jx, gy]);
      }
    if (this.n + pts.length > MAX_PARTICLES) return null;

    let mx = 0;
    let my = 0;
    for (const [px, py] of pts) {
      mx += px;
      my += py;
    }
    mx /= pts.length;
    my /= pts.length;
    const q = new Float32Array(pts.length * 2);
    let a00 = 0, a01 = 0, a11 = 0;
    let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
    pts.forEach(([px, py], i) => {
      const qx = px - mx;
      const qy = py - my;
      q[i * 2] = qx;
      q[i * 2 + 1] = qy;
      a00 += qx * qx;
      a01 += qx * qy;
      a11 += qy * qy;
      minY = Math.min(minY, qy);
      maxY = Math.max(maxY, qy);
      minX = Math.min(minX, qx);
      maxX = Math.max(maxX, qx);
    });
    const det = a00 * a11 - a01 * a01;

    // Render mesh: concentric rings of the outline plus a centre vertex.
    const m = out.length;
    const rings = RING_SCALES.length;
    const vcount = m * rings + 1;
    const verts = new Float32Array(vcount * 2);
    const rim = new Float32Array(vcount);
    RING_SCALES.forEach((s, ri) => {
      for (let k = 0; k < m; k++) {
        verts[(ri * m + k) * 2] = out[k][0] * s - mx;
        verts[(ri * m + k) * 2 + 1] = out[k][1] * s - my;
        rim[ri * m + k] = s;
      }
    });
    verts[(vcount - 1) * 2] = -mx;
    verts[(vcount - 1) * 2 + 1] = -my;
    rim[vcount - 1] = 0;
    const tris: number[] = [];
    for (let ri = 0; ri + 1 < rings; ri++)
      for (let k = 0; k < m; k++) {
        const a = ri * m + k, b = ri * m + ((k + 1) % m), c = (ri + 1) * m + k, e = (ri + 1) * m + ((k + 1) % m);
        tris.push(a, c, b, b, c, e);
      }
    for (let k = 0; k < m; k++) tris.push((rings - 1) * m + k, vcount - 1, (rings - 1) * m + ((k + 1) % m));
    // Skinning: each render vertex follows its four nearest particles.
    const nbr = new Int32Array(vcount * 4);
    const nbw = new Float32Array(vcount * 4);
    for (let v = 0; v < vcount; v++) {
      const vx = verts[v * 2], vy = verts[v * 2 + 1];
      const best: [number, number][] = [];
      for (let i = 0; i < pts.length; i++) {
        const dd = (q[i * 2] - vx) ** 2 + (q[i * 2 + 1] - vy) ** 2;
        if (best.length < 4) best.push([dd, i]);
        else if (dd < best[3][0]) best[3] = [dd, i];
        else continue;
        best.sort((a, b) => a[0] - b[0]);
      }
      let sum = 0;
      best.forEach(([dd], k) => (sum += (nbw[v * 4 + k] = 1 / (dd + 1e-5))));
      best.forEach(([, i], k) => {
        nbr[v * 4 + k] = i;
        nbw[v * 4 + k] /= sum;
      });
    }

    const start = this.n;
    const ca = Math.cos(angle), sa = Math.sin(angle);
    const bi = this.bodies.length;
    for (let i = 0; i < pts.length; i++) {
      const p = start + i;
      const qx = q[i * 2], qy = q[i * 2 + 1];
      this.pos[p * 2] = x + ca * qx - sa * qy;
      this.pos[p * 2 + 1] = y + sa * qx + ca * qy;
      this.prev[p * 2] = this.pos[p * 2];
      this.prev[p * 2 + 1] = this.pos[p * 2 + 1];
      this.vel[p * 2] = 0;
      this.vel[p * 2 + 1] = 0;
      this.owner[p] = bi;
    }
    this.n += pts.length;
    const body: Body = {
      shape,
      color,
      start,
      count: pts.length,
      q,
      aqqInv: [a11 / det, -a01 / det, -a01 / det, a00 / det],
      firm,
      ext,
      halfHeight: (maxY - minY) / 2 + this.r,
      halfWidth: (maxX - minX) / 2 + this.r,
      seed: Math.random() * 100,
      face: shape === 'bobo',
      verts,
      rim,
      nbr,
      nbw,
      tris: Uint16Array.from(tris),
      cx: x,
      cy: y,
      T: [ca, -sa, sa, ca],
      vx: 0,
      vy: 0,
      onGround: false,
      age: 0,
      speed: 0,
      still: 0,
      asleep: false,
      js: 0,
      jsv: 0,
      jk: 0,
      jkv: 0,
      minY: y,
    };
    this.bodies.push(body);
    return body;
  }

  /** Remove a body and compact the particle arrays behind it. */
  remove(bi: number) {
    const b = this.bodies[bi];
    const end = b.start + b.count;
    const tail = this.n - end;
    this.pos.copyWithin(b.start * 2, end * 2, this.n * 2);
    this.prev.copyWithin(b.start * 2, end * 2, this.n * 2);
    this.vel.copyWithin(b.start * 2, end * 2, this.n * 2);
    this.n -= b.count;
    this.bodies.splice(bi, 1);
    for (let k = bi; k < this.bodies.length; k++) this.bodies[k].start -= b.count;
    for (let k = 0; k < this.bodies.length; k++) {
      const o = this.bodies[k];
      for (let i = o.start; i < o.start + o.count; i++) this.owner[i] = k;
    }
    this.handles = [];
    void tail;
  }

  clear() {
    this.bodies = [];
    this.handles = [];
    this.n = 0;
  }

  // ---------------------------------------------------------------- step

  step(dt: number) {
    const sub = this.cfg.substeps;
    const h = dt / sub;
    const g = this.cfg.gravity;
    const { pos, prev, vel, vyPre, grounded, frozen } = this;
    for (let k = 0; k < this.bodies.length; k++) {
      const b = this.bodies[k];
      frozen.fill(b.asleep ? 1 : 0, b.start, b.start + b.count);
    }
    for (let s = 0; s < sub; s++) {
      for (let i = 0; i < this.n; i++) {
        prev[i * 2] = pos[i * 2];
        prev[i * 2 + 1] = pos[i * 2 + 1];
        if (frozen[i]) continue;
        vel[i * 2 + 1] -= g * h;
        vyPre[i] = vel[i * 2 + 1];
        grounded[i] = 0;
        pos[i * 2] += vel[i * 2] * h;
        pos[i * 2 + 1] += vel[i * 2 + 1] * h;
      }
      for (const hd of this.handles)
        for (let k = 0; k < hd.idx.length; k++) {
          const i = hd.idx[k];
          pos[i * 2] += (hd.tx + hd.offs[k * 2] - pos[i * 2]) * hd.w[k];
          pos[i * 2 + 1] += (hd.ty + hd.offs[k * 2 + 1] - pos[i * 2 + 1]) * hd.w[k];
        }
      // Alternate contacts and shape matching until they agree. One pass leaves only the supported
      // particles pushed up, which slowly spins a resting block off its support.
      this.buildHash();
      const iters = this.cfg.iterations;
      for (let it = 0; it < iters; it++) {
        this.collide();
        this.bounds();
        for (const b of this.bodies) if (!b.asleep) this.matchShape(b, it === iters - 1);
      }
      this.bounds();
      const e = this.cfg.bounce;
      const damp = Math.exp(-0.6 * h);
      // Settling: jellies that are nearly still lose energy fast, like real gel's internal friction,
      // so a stack stops creeping instead of slowly buckling. Fast wobble and throws are untouched.
      const restDamp = this.bodies.map((b) => {
        const k = Math.max(0, 1 - b.speed / REST_SPEED);
        return Math.exp(-REST_DAMPING * k * k * h);
      });
      for (let i = 0; i < this.n; i++) {
        if (frozen[i]) {
          vel[i * 2] = vel[i * 2 + 1] = 0;
          continue;
        }
        let vx = (pos[i * 2] - prev[i * 2]) / h;
        let vy = (pos[i * 2 + 1] - prev[i * 2 + 1]) / h;
        // Bouncy floor: give back part of the landing speed.
        if (grounded[i] && vyPre[i] < -0.3) vy = Math.max(vy, -vyPre[i] * e);
        const sp = Math.hypot(vx, vy);
        if (sp > 12) {
          vx *= 12 / sp;
          vy *= 12 / sp;
        }
        const dd = damp * restDamp[this.owner[i]];
        vel[i * 2] = vx * dd;
        vel[i * 2 + 1] = vy * dd;
      }
    }
    this.unjam();
    this.track(dt);
  }

  /** Is (x, y) inside body b's outline, grown outward by pad? */
  contains(b: Body, x: number, y: number, pad = 0) {
    const [t00, t01, t10, t11] = b.T;
    const det = t00 * t11 - t01 * t10;
    if (Math.abs(det) < 1e-9) return false;
    const dx = x - b.cx, dy = y - b.cy;
    const k = 1 / (1 + pad / b.ext);
    const qx = ((t11 * dx - t01 * dy) / det) * k;
    const qy = ((-t10 * dx + t00 * dy) / det) * k;
    // Ring 0 of the render mesh is the outline itself, in rest space.
    const v = b.verts;
    let inside = false;
    for (let a = 0, c = OUTLINE_POINTS - 1; a < OUTLINE_POINTS; c = a++) {
      const ax = v[a * 2], ay = v[a * 2 + 1], cx = v[c * 2], cy = v[c * 2 + 1];
      if (ay > qy !== cy > qy && qx < ((cx - ax) * (qy - ay)) / (cy - ay) + ax) inside = !inside;
    }
    return inside;
  }

  private overlapCount(b: Body, o: Body, pad: number) {
    let n = 0;
    for (let i = o.start; i < o.start + o.count; i++) if (this.contains(b, this.pos[i * 2], this.pos[i * 2 + 1], pad)) n++;
    return n;
  }

  /**
   * Separate b from every body it has swallowed or sunk into. Particle contacts can only resolve
   * shallow overlaps: a gummy that ends up inside another (a merge spawning on top of it, a hard
   * drop punching through) gets jammed there, and the lopsided contact pushes send the pair flying.
   * The smaller of each pair is shifted out whole (position and history together, so it isn't
   * launched), up-biased because the jar is open at the top.
   */
  evict(b: Body) {
    for (const o of this.bodies) {
      if (o === b || Math.hypot(o.cx - b.cx, o.cy - b.cy) > b.ext + o.ext + this.r * 2) continue;
      if (o.ext <= b.ext) this.pushOut(b, o);
      else this.pushOut(o, b);
    }
  }

  private pushOut(big: Body, o: Body) {
    const { pos, prev, r } = this;
    if (!this.overlapCount(big, o, 0)) return;
    let nx = o.cx - big.cx, ny = o.cy - big.cy;
    const l = Math.hypot(nx, ny);
    nx = l > 1e-6 ? nx / l : 0;
    ny = (l > 1e-6 ? ny / l : 1) + 0.6;
    const nl = Math.hypot(nx, ny);
    const stepX = (nx / nl) * r * 0.75, stepY = (ny / nl) * r * 0.75;
    for (let it = 0; it < 60 && this.overlapCount(big, o, r * 0.5); it++) {
      for (let i = o.start; i < o.start + o.count; i++) {
        pos[i * 2] += stepX;
        pos[i * 2 + 1] += stepY;
        prev[i * 2] += stepX;
        prev[i * 2 + 1] += stepY;
      }
      o.cx += stepX;
      o.cy += stepY;
    }
    this.wake(big);
    this.wake(o);
  }

  /** Safety net: any body whose centre has sunk inside another one gets evicted. */
  private unjam() {
    const bs = this.bodies;
    for (let i = 0; i < bs.length; i++)
      for (let j = 0; j < bs.length; j++) {
        if (i === j) continue;
        const big = bs[i], small = bs[j];
        if (big.ext < small.ext || Math.hypot(big.cx - small.cx, big.cy - small.cy) > big.ext) continue;
        // Centres are refreshed by shape matching; sleeping bodies keep theirs, which is still right.
        if (this.contains(big, small.cx, small.cy, -this.r)) this.pushOut(big, small);
      }
  }

  /** Centre, and the rotation/linear blend that best maps the rest shape onto the current particles. */
  transform(b: Body): [number, number, number, number, number, number] {
    const { pos } = this;
    let cx = 0, cy = 0;
    for (let i = b.start; i < b.start + b.count; i++) {
      cx += pos[i * 2];
      cy += pos[i * 2 + 1];
    }
    cx /= b.count;
    cy /= b.count;
    let a00 = 0, a01 = 0, a10 = 0, a11 = 0;
    for (let k = 0; k < b.count; k++) {
      const i = b.start + k;
      const px = pos[i * 2] - cx, py = pos[i * 2 + 1] - cy;
      const qx = b.q[k * 2], qy = b.q[k * 2 + 1];
      a00 += px * qx;
      a01 += px * qy;
      a10 += py * qx;
      a11 += py * qy;
    }
    // 2D polar decomposition: the rotation part is closed form.
    const th = Math.atan2(a10 - a01, a00 + a11);
    const c = Math.cos(th), s = Math.sin(th);
    // Linear part A = Apq · Aqq⁻¹, normalised to keep area, blended in for squash-and-stretch.
    const [i00, i01, i10, i11] = b.aqqInv;
    let l00 = a00 * i00 + a01 * i10, l01 = a00 * i01 + a01 * i11;
    let l10 = a10 * i00 + a11 * i10, l11 = a10 * i01 + a11 * i11;
    const det = l00 * l11 - l01 * l10;
    if (det > 1e-6) {
      const k = 1 / Math.sqrt(det);
      l00 *= k;
      l01 *= k;
      l10 *= k;
      l11 *= k;
    } else {
      l00 = c;
      l01 = -s;
      l10 = s;
      l11 = c;
    }
    const beta = 0.35;
    return [cx, cy, beta * l00 + (1 - beta) * c, beta * l01 - (1 - beta) * s, beta * l10 + (1 - beta) * s, beta * l11 + (1 - beta) * c];
  }

  private matchShape(b: Body, last = true) {
    const [cx, cy, t00, t01, t10, t11] = this.transform(b);
    // Softer bodies take a smaller step toward their goal each substep: that's the wobble.
    // Physically fairly firm so stacks carry their load; the visible jiggle is layered on in the
    // renderer. Wobbliness still loosens the body for grabs and squishes.
    const loose = this.cfg.wobble;
    const alpha = (0.9 - 0.55 * loose) * (0.7 + 0.45 * b.firm);
    const a = Math.min(0.95, Math.max(0.05, alpha));
    const { pos } = this;
    for (let k = 0; k < b.count; k++) {
      const i = b.start + k;
      const qx = b.q[k * 2], qy = b.q[k * 2 + 1];
      const gx = cx + t00 * qx + t01 * qy;
      const gy = cy + t10 * qx + t11 * qy;
      pos[i * 2] += (gx - pos[i * 2]) * a;
      pos[i * 2 + 1] += (gy - pos[i * 2 + 1]) * a;
    }
    b.cx = cx;
    b.cy = cy;
    b.T = [t00, t01, t10, t11];
  }

  private cellIndex(x: number, y: number) {
    const cx = Math.min(this.gx - 1, Math.max(0, Math.floor(x / this.d) + 1));
    const cy = Math.min(this.gy - 1, Math.max(0, Math.floor(y / this.d) + 1));
    return cy * this.gx + cx;
  }

  private buildHash() {
    const { cellStart, cellItems, cellOf, pos } = this;
    cellStart.fill(0);
    for (let i = 0; i < this.n; i++) {
      const c = this.cellIndex(pos[i * 2], pos[i * 2 + 1]);
      cellOf[i] = c;
      cellStart[c + 1]++;
    }
    for (let c = 1; c < cellStart.length; c++) cellStart[c] += cellStart[c - 1];
    const fill = cellStart.slice(0, cellStart.length - 1);
    for (let i = 0; i < this.n; i++) cellItems[fill[cellOf[i]]++] = i;
  }

  /**
   * Contacts between jellies. Pairwise circle normals on two bumpy rows of particles tilt and act
   * like rollers, so each particle instead gathers all its overlaps and resolves once along the
   * smoothed (overlap-weighted) normal, with static friction against the neighbours' mean motion.
   * Everything is accumulated first (Jacobi), so loop order can't bias stacks sideways.
   */
  private collide() {
    const { pos, prev, owner, cellStart, cellItems, cellOf, gx, frozen } = this;
    const { cn, cpen, cw, cdisp, cfz } = this;
    const rr = this.r * 2;
    const mu = this.cfg.friction;
    cn.fill(0, 0, this.n * 2);
    cdisp.fill(0, 0, this.n * 2);
    cpen.fill(0, 0, this.n);
    cw.fill(0, 0, this.n);
    cfz.fill(0, 0, this.n);
    for (let i = 0; i < this.n; i++) {
      const c = cellOf[i];
      const bi = owner[i];
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const cc = c + oy * gx + ox;
          if (cc < 0 || cc >= cellStart.length - 1) continue;
          for (let k = cellStart[cc]; k < cellStart[cc + 1]; k++) {
            const j = cellItems[k];
            if (j <= i || owner[j] === bi) continue;
            if (frozen[i] && frozen[j]) continue;
            let dx = pos[i * 2] - pos[j * 2];
            let dy = pos[i * 2 + 1] - pos[j * 2 + 1];
            const d2 = dx * dx + dy * dy;
            if (d2 >= rr * rr || d2 < 1e-12) continue;
            const dist = Math.sqrt(d2);
            const pen = rr - dist;
            dx /= dist;
            dy /= dist;
            const mix = pen * pen;
            const dix = pos[i * 2] - prev[i * 2], diy = pos[i * 2 + 1] - prev[i * 2 + 1];
            const djx = pos[j * 2] - prev[j * 2], djy = pos[j * 2 + 1] - prev[j * 2 + 1];
            cn[i * 2] += dx * mix;
            cn[i * 2 + 1] += dy * mix;
            cn[j * 2] -= dx * mix;
            cn[j * 2 + 1] -= dy * mix;
            if (pen > cpen[i]) cpen[i] = pen;
            if (pen > cpen[j]) cpen[j] = pen;
            cdisp[i * 2] += djx * mix;
            cdisp[i * 2 + 1] += djy * mix;
            cdisp[j * 2] += dix * mix;
            cdisp[j * 2 + 1] += diy * mix;
            cw[i] += mix;
            cw[j] += mix;
            if (frozen[j]) cfz[i] += mix;
            if (frozen[i]) cfz[j] += mix;
          }
        }
    }
    for (let i = 0; i < this.n; i++) {
      if (!cw[i] || frozen[i]) continue;
      let nx = cn[i * 2], ny = cn[i * 2 + 1];
      const nl = Math.hypot(nx, ny);
      if (nl < 1e-12) continue;
      nx /= nl;
      ny /= nl;
      // Against a sleeping (immovable) body this particle takes the whole correction.
      const share = 0.5 + 0.5 * (cfz[i] / cw[i]);
      const pen = cpen[i] * share;
      let px = nx * pen, py = ny * pen;
      const rx = pos[i * 2] - prev[i * 2] - cdisp[i * 2] / cw[i];
      const ry = pos[i * 2 + 1] - prev[i * 2 + 1] - cdisp[i * 2 + 1] / cw[i];
      const rn = rx * nx + ry * ny;
      const tx = rx - rn * nx, ty = ry - rn * ny;
      const tl = Math.hypot(tx, ty);
      if (tl > 1e-12) {
        // Resting contacts barely overlap, so give static friction a floor: stacks grip instead of skating.
        const grip = mu * Math.max(cpen[i] * 3, this.r * GRIP_FLOOR);
        // Static below the threshold; sliding friction is spread over the solver iterations.
        const f = tl < grip ? 1 : grip / this.cfg.iterations / tl;
        px -= tx * f * share;
        py -= ty * f * share;
      }
      pos[i * 2] += px;
      pos[i * 2 + 1] += py;
    }
  }

  private bounds() {
    const { pos, prev, grounded, r } = this;
    const floor = this.groundY + r;
    const mu = this.cfg.friction;
    for (let i = 0; i < this.n; i++) {
      if (this.frozen[i]) continue;
      const y = pos[i * 2 + 1];
      if (y < floor) {
        const pen = floor - y;
        pos[i * 2 + 1] = floor;
        grounded[i] = 1;
        const ux = pos[i * 2] - prev[i * 2];
        if (Math.abs(ux) < mu * pen * 1.5) pos[i * 2] = prev[i * 2];
        else pos[i * 2] -= Math.sign(ux) * mu * pen * 1.5;
      }
      if (pos[i * 2] < this.left + r) pos[i * 2] = this.left + r;
      else if (pos[i * 2] > this.right - r) pos[i * 2] = this.right - r;
    }
  }

  /** Per-body velocity, landing detection and impact events for haptics and dust. */
  private track(dt: number) {
    const { vel } = this;
    for (const b of this.bodies) {
      b.age += dt;
      let vx = 0, vy = 0, minY = Infinity, sp = 0;
      for (let i = b.start; i < b.start + b.count; i++) {
        vx += vel[i * 2];
        vy += vel[i * 2 + 1];
        sp += Math.hypot(vel[i * 2], vel[i * 2 + 1]);
        minY = Math.min(minY, this.pos[i * 2 + 1]);
      }
      b.speed = sp / b.count;
      vx /= b.count;
      vy /= b.count;
      const dv = Math.hypot(vx - b.vx, vy - b.vy);
      const ground = minY < this.groundY + this.r * 1.6;
      if (dv > 0.55 && b.age > 0.3) this.impacts.push({ x: b.cx, y: ground ? this.groundY : minY, strength: dv, ground: ground && !b.onGround });
      b.onGround = ground;
      b.minY = minY;
      this.jiggle(b, vx - b.vx, vy - b.vy, dt);
      b.vx = vx;
      b.vy = vy;
      if (!b.asleep) {
        b.still = b.speed < SLEEP_SPEED && !this.held(b) ? b.still + dt : 0;
        if (b.still > SLEEP_AFTER && b.age > 1) b.asleep = true;
      }
    }
    this.wakeTouched();
  }

  /**
   * Squash-and-stretch as a damped spring kicked by changes in velocity (the idea behind
   * Complementary Dynamics: secondary jiggle layered on top of the primary motion). Landing
   * squashes, being flung up stretches, sideways jolts shear. Purely visual.
   */
  private jiggle(b: Body, dvx: number, dvy: number, dt: number) {
    const amp = (0.25 + this.cfg.wobble) * (1.15 - 0.6 * b.firm);
    b.jsv -= dvy * 0.9 * amp;
    b.jkv -= dvx * 0.7 * amp;
    const w = 24 - 8 * this.cfg.wobble;
    const z = 0.12 + 0.18 * b.firm;
    b.jsv += (-w * w * b.js - 2 * z * w * b.jsv) * dt;
    b.jkv += (-w * w * b.jk - 2 * z * w * b.jkv) * dt;
    b.js = Math.max(-0.35, Math.min(0.35, b.js + b.jsv * dt));
    b.jk = Math.max(-0.4, Math.min(0.4, b.jk + b.jkv * dt));
  }

  private held(b: Body) {
    return this.handles.some((hd) => hd.idx.length && hd.idx[0] >= b.start && hd.idx[0] < b.start + b.count);
  }

  wake(b: Body) {
    b.asleep = false;
    b.still = 0;
  }

  /** Wake everything touching `b` (used for slaps and grabs, which shouldn't be pinned by sleepers). */
  wakeAround(b: Body) {
    const { pos, owner, cellStart, cellItems, gx } = this;
    const reach = this.r * 2.4;
    for (let i = b.start; i < b.start + b.count; i++) {
      const c = this.cellIndex(pos[i * 2], pos[i * 2 + 1]);
      for (let oy = -1; oy <= 1; oy++)
        for (let ox = -1; ox <= 1; ox++) {
          const cc = c + oy * gx + ox;
          if (cc < 0 || cc >= cellStart.length - 1) continue;
          for (let k = cellStart[cc]; k < cellStart[cc + 1]; k++) {
            const j = cellItems[k];
            if (j >= this.n) continue;
            const o = this.bodies[owner[j]];
            if (o && o.asleep && Math.hypot(pos[i * 2] - pos[j * 2], pos[i * 2 + 1] - pos[j * 2 + 1]) < reach) this.wake(o);
          }
        }
    }
  }

  /**
   * Sleepers wake when anything they touch is moving or held, and when they've lost all support
   * (the jelly underneath slid away), so nothing is ever left floating.
   */
  private wakeTouched() {
    const { pos, owner, cellStart, cellItems, gx } = this;
    const reach = this.r * 2.4;
    const floor = this.groundY + this.r * 2;
    for (let bi = 0; bi < this.bodies.length; bi++) {
      const b = this.bodies[bi];
      if (!b.asleep) continue;
      let supported = b.minY < floor;
      let disturbed = false;
      for (let i = b.start; i < b.start + b.count && !disturbed; i++) {
        const c = this.cellIndex(pos[i * 2], pos[i * 2 + 1]);
        for (let oy = -1; oy <= 1 && !disturbed; oy++)
          for (let ox = -1; ox <= 1 && !disturbed; ox++) {
            const cc = c + oy * gx + ox;
            if (cc < 0 || cc >= cellStart.length - 1) continue;
            for (let k = cellStart[cc]; k < cellStart[cc + 1]; k++) {
              const j = cellItems[k];
              if (j >= this.n || owner[j] === bi) continue;
              if (Math.hypot(pos[i * 2] - pos[j * 2], pos[i * 2 + 1] - pos[j * 2 + 1]) >= reach) continue;
              supported = true;
              const o = this.bodies[owner[j]];
              if (o && !o.asleep && (o.speed > WAKE_SPEED * 0.5 || this.held(o))) {
                disturbed = true;
                break;
              }
            }
          }
      }
      if (disturbed || !supported) this.wake(b);
    }
  }

  /** Nearest body under a point (within a finger's reach of any of its particles). */
  pick(x: number, y: number, reach: number): number {
    let best = -1;
    let bestD = reach * reach;
    for (let i = 0; i < this.n; i++) {
      const d2 = (this.pos[i * 2] - x) ** 2 + (this.pos[i * 2 + 1] - y) ** 2;
      if (d2 < bestD) {
        bestD = d2;
        best = this.owner[i];
      }
    }
    return best;
  }

  /** Soft hold on the part of a body under the finger. */
  grab(bi: number, x: number, y: number): Handle {
    const b = this.bodies[bi];
    this.wake(b);
    this.wakeAround(b);
    const R = Math.max(0.05, b.ext * 0.55);
    const idx: number[] = [];
    const offs: number[] = [];
    const w: number[] = [];
    for (let i = b.start; i < b.start + b.count; i++) {
      const dx = this.pos[i * 2] - x, dy = this.pos[i * 2 + 1] - y;
      const dd = Math.hypot(dx, dy);
      if (dd > R) continue;
      idx.push(i);
      offs.push(dx, dy);
      w.push(0.06 + 0.3 * (1 - (dd / R) ** 2));
    }
    const hd = { idx: Int32Array.from(idx), offs: Float32Array.from(offs), w: Float32Array.from(w), tx: x, ty: y };
    this.handles.push(hd);
    return hd;
  }

  release(hd: Handle) {
    const k = this.handles.indexOf(hd);
    if (k >= 0) this.handles.splice(k, 1);
  }

  /** A slap: shove the particles swept by a fast finger along its direction. */
  slap(x: number, y: number, dx: number, dy: number, radius: number): number {
    let hit = 0;
    const struck = new Set<Body>();
    for (let i = 0; i < this.n; i++) {
      const ddx = this.pos[i * 2] - x, ddy = this.pos[i * 2 + 1] - y;
      const dd = Math.hypot(ddx, ddy);
      if (dd > radius) continue;
      const f = 1 - dd / radius;
      const o = this.bodies[this.owner[i]];
      if (o.asleep) this.wake(o);
      struck.add(o);
      this.vel[i * 2] += dx * f;
      this.vel[i * 2 + 1] += dy * f;
      hit++;
    }
    for (const o of struck) this.wakeAround(o);
    return hit;
  }

  /** Highest resting top above the ground, for the tower meter. */
  towerHeight() {
    let top = 0;
    for (const b of this.bodies) {
      if (Math.hypot(b.vx, b.vy) > 0.25) continue;
      let maxY = -Infinity;
      for (let i = b.start; i < b.start + b.count; i++) maxY = Math.max(maxY, this.pos[i * 2 + 1]);
      top = Math.max(top, maxY + this.r - this.groundY);
    }
    return top;
  }
}

function pointAlong(pts: [number, number][], dist: number): [number, number] {
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    const l = Math.hypot(bx - ax, by - ay);
    if (dist <= l) {
      const t = l > 0 ? dist / l : 0;
      return [ax + (bx - ax) * t, ay + (by - ay) * t];
    }
    dist -= l;
  }
  return pts[0];
}
