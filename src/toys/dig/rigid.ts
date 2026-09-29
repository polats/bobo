// Pixel rigid bodies, as in Noita (Purho, GDC 2019): a piece of ground cut free keeps its cells as a
// mask; its outline (marching squares + Douglas–Peucker, outline.ts) gives the points it collides
// with. The solver is Box2D v3's "soft step" (Catto 2024), adapted from ../demolition/physics.ts:
// contacts are collided once per frame and solved over substeps with soft constraints, warm starting,
// a relax pass without bias, and per-body sleeping.
// Contacts are points against cells: each outline point is looked up in the other shape's cells (the
// terrain grid, or another body's mask in that body's frame) for its signed distance to the nearest
// solid (or, when inside, free) cell square, which gives a per-point normal and separation. Points
// within a speed-scaled margin make speculative contacts, so fast slabs don't sink into the ground.

import { SOLID, WATER } from './sim';
import { resample, simplify, snapInside, traceOutline } from './outline';

export const enum Kind {
  Slab = 0,
  Boulder = 1,
  Find = 2,
}

export interface PBody {
  id: number;
  kind: Kind;
  x: number;
  y: number;
  a: number;
  c: number;
  s: number;
  vx: number;
  vy: number;
  w: number;
  mass: number;
  invMass: number;
  invI: number;
  friction: number;
  /** Cell mask (materials) with its centre of mass at (cx, cy) in mask coordinates. */
  mw: number;
  mh: number;
  mask: Uint8Array;
  shade: Uint8Array;
  cx: number;
  cy: number;
  cells: number;
  /** Outline sample points, local coordinates about the centre of mass. */
  pts: Float32Array;
  rad: number;
  sleeping: boolean;
  sleepTime: number;
  age: number;
  alive: boolean;
  /** Moved during this frame's step. */
  active: boolean;
  x0: number;
  y0: number;
  a0: number;
  svx: number;
  svy: number;
  /** Velocity change this frame beyond gravity (cells/s), and where the hardest contact was. */
  hit: number;
  hitImp: number;
  hitX: number;
  hitY: number;
  /** Fraction of outline points in water. */
  wet: number;
  touching: boolean;
  // Toy-side state.
  stamp: number[];
  canvas: HTMLCanvasElement | null;
  find: number;
  noBake: boolean;
  tough: number;
  mat: number;
  nextKnock: number;
}

interface CP {
  a: PBody | null;
  b: PBody;
  nx: number;
  ny: number;
  rAx: number;
  rAy: number;
  rBx: number;
  rBy: number;
  adj: number;
  nImp: number;
  tImp: number;
  nMass: number;
  tMass: number;
  mA: number;
  iA: number;
  mB: number;
  iB: number;
  friction: number;
  key: number;
  maxImp: number;
  px: number;
  py: number;
  close: number;
}

/** Mass per cell by material. */
export const DENSITY = [0, 0.9, 1, 1.2, 1.3, 1.4, 1.7, 2, 1, 1.5];
const TERRAIN_FRICTION = 0.6;
const MAX_SPEED = 220;
const SLEEP_LIN = 2.5;
const SLEEP_ANG = 0.12;
const SLEEP_TIME = 0.45;

interface Softness {
  biasRate: number;
  massScale: number;
  impulseScale: number;
}

function softness(hertz: number, zeta: number, h: number): Softness {
  const omega = 2 * Math.PI * hertz;
  const a1 = 2 * zeta + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  return { biasRate: omega / a1, massScale: a2 * a3, impulseScale: a3 };
}

// Probe results (module scratch, to keep the hot loop allocation-free).
let PS = 0, PNX = 0, PNY = 0;

function solidAt(g: Uint8Array, W: number, H: number, edge: number, i: number, j: number) {
  if (i < 0 || i >= W || j >= H) return edge;
  if (j < 0) return 0;
  return SOLID[g[j * W + i]];
}

/**
 * Signed distance from (px, py) to the solid cells of grid g, searched a couple of cells out, with
 * the normal pointing out of the solid. `edge` is what lies past the sides and bottom (the terrain's
 * walls are solid, a body mask is surrounded by air). False when nothing solid is within `margin`.
 */
function probe(g: Uint8Array, W: number, H: number, edge: number, px: number, py: number, margin: number): boolean {
  const ci = Math.floor(px), cj = Math.floor(py);
  const inside = solidAt(g, W, H, edge, ci, cj);
  const R = inside ? 2 : Math.ceil(margin);
  let best = Infinity, qx = 0, qy = 0, bi = 0, bj = 0;
  for (let j = cj - R; j <= cj + R; j++)
    for (let i = ci - R; i <= ci + R; i++) {
      if (solidAt(g, W, H, edge, i, j) === inside) continue;
      const cx = px < i ? i : px > i + 1 ? i + 1 : px;
      const cy = py < j ? j : py > j + 1 ? j + 1 : py;
      const d = (cx - px) * (cx - px) + (cy - py) * (cy - py);
      if (d < best) {
        best = d;
        qx = cx;
        qy = cy;
        bi = i;
        bj = j;
      }
    }
  if (best === Infinity) {
    // Buried past the search radius: out of the ground push up; deep inside another body there's no
    // good direction, so leave it to the outline points that can find one.
    if (!inside || !edge) return false;
    PS = -(R + 0.5);
    PNX = 0;
    PNY = -1;
    return true;
  }
  const d = Math.sqrt(best);
  if (!inside && d > margin) return false;
  let nx: number, ny: number;
  if (d > 1e-6) {
    nx = (qx - px) / d;
    ny = (qy - py) / d;
    if (!inside) {
      nx = -nx;
      ny = -ny;
    }
  } else {
    // Exactly on a cell edge: take the normal from the cell centres.
    nx = inside ? bi - ci : ci - bi;
    ny = inside ? bj - cj : cj - bj;
    const l = Math.hypot(nx, ny) || 1;
    nx /= l;
    ny /= l;
  }
  PS = inside ? -d : d;
  PNX = nx;
  PNY = ny;
  return true;
}

export class RigidWorld {
  bodies: PBody[] = [];
  /** Cells/s² (a cell is about 5 cm). */
  gravity = 170;
  substeps = 4;
  contactHertz = 30;
  contactZeta = 10;
  pushMax = 40;
  /** Bodies that came to rest this frame. */
  slept: PBody[] = [];
  /** Contact points last frame. */
  contacts = 0;
  private nextId = 1;
  private pool: CP[] = [];
  private n = 0;
  private prevN = new Map<number, number>();
  private prevT = new Map<number, number>();

  constructor(private grid: { cells: Uint8Array; W: number; H: number }) {}

  /** A body from a mask whose cell (0, 0) corner sits at (ox, oy), turned by a. Null if the mask is empty. */
  create(kind: Kind, mw: number, mh: number, mask: Uint8Array, shade: Uint8Array, ox: number, oy: number, a: number): PBody | null {
    let m = 0, sx = 0, sy = 0, n = 0;
    for (let j = 0; j < mh; j++)
      for (let i = 0; i < mw; i++) {
        const v = mask[j * mw + i];
        if (!v) continue;
        const d = DENSITY[v];
        m += d;
        sx += d * (i + 0.5);
        sy += d * (j + 0.5);
        n++;
      }
    if (!n) return null;
    const cx = sx / m, cy = sy / m;
    let I = 0;
    for (let j = 0; j < mh; j++)
      for (let i = 0; i < mw; i++) {
        const v = mask[j * mw + i];
        if (v) I += DENSITY[v] * ((i + 0.5 - cx) ** 2 + (j + 0.5 - cy) ** 2 + 1 / 6);
      }
    const outline = resample(simplify(traceOutline(mask, mw, mh), 0.45), 1.35);
    snapInside(outline, mask, mw, mh);
    const pts = new Float32Array(outline.length);
    for (let i = 0; i < outline.length; i += 2) {
      pts[i] = outline[i] - cx;
      pts[i + 1] = outline[i + 1] - cy;
    }
    let rad = 0;
    for (let i = 0; i < pts.length; i += 2) rad = Math.max(rad, Math.hypot(pts[i], pts[i + 1]));
    const c = Math.cos(a), s = Math.sin(a);
    const b: PBody = {
      id: this.nextId++,
      kind,
      x: ox + c * cx - s * cy,
      y: oy + s * cx + c * cy,
      a,
      c,
      s,
      vx: 0,
      vy: 0,
      w: 0,
      mass: m,
      invMass: 1 / m,
      invI: 1 / I,
      friction: kind === Kind.Find ? 0.5 : 0.6,
      mw,
      mh,
      mask,
      shade,
      cx,
      cy,
      cells: n,
      pts,
      rad: rad + 0.75,
      sleeping: false,
      sleepTime: 0,
      age: 0,
      alive: true,
      active: false,
      x0: 0,
      y0: 0,
      a0: 0,
      svx: 0,
      svy: 0,
      hit: 0,
      hitImp: 0,
      hitX: 0,
      hitY: 0,
      wet: 0,
      touching: false,
      stamp: [],
      canvas: null,
      find: -1,
      noBake: false,
      tough: Infinity,
      mat: 0,
      nextKnock: 0,
    };
    b.x0 = b.x;
    b.y0 = b.y;
    b.a0 = b.a;
    this.bodies.push(b);
    return b;
  }

  remove(b: PBody) {
    b.alive = false;
    this.wakeNear(b.x, b.y, b.rad + 1);
  }

  compact() {
    if (this.bodies.some((b) => !b.alive)) this.bodies = this.bodies.filter((b) => b.alive);
  }

  wake(b: PBody) {
    b.sleeping = false;
    b.sleepTime = 0;
  }

  wakeNear(x: number, y: number, r: number) {
    for (const b of this.bodies) if (b.alive && b.sleeping && (b.x - x) ** 2 + (b.y - y) ** 2 < (r + b.rad) ** 2) this.wake(b);
  }

  step(dt: number) {
    this.slept.length = 0;
    if (dt <= 0) return;
    const bodies = this.bodies;
    for (const b of bodies) {
      b.x0 = b.x;
      b.y0 = b.y;
      b.a0 = b.a;
      b.active = b.alive && !b.sleeping;
      if (!b.active) continue;
      b.svx = b.vx;
      b.svy = b.vy;
      b.age += dt;
      b.hit = b.hitImp = 0;
      b.touching = false;
    }
    this.collide(dt);
    const cps = this.pool, n = this.n;
    for (let i = 0; i < n; i++) {
      const p = cps[i];
      const a = p.a, b = p.b;
      p.mA = a && a.active ? a.invMass : 0;
      p.iA = a && a.active ? a.invI : 0;
      p.mB = b.active ? b.invMass : 0;
      p.iB = b.active ? b.invI : 0;
      const rnA = p.rAx * p.ny - p.rAy * p.nx, rnB = p.rBx * p.ny - p.rBy * p.nx;
      const kn = p.mA + p.mB + p.iA * rnA * rnA + p.iB * rnB * rnB;
      p.nMass = kn > 0 ? 1 / kn : 0;
      const tx = p.ny, ty = -p.nx;
      const rtA = p.rAx * ty - p.rAy * tx, rtB = p.rBx * ty - p.rBy * tx;
      const kt = p.mA + p.mB + p.iA * rtA * rtA + p.iB * rtB * rtB;
      p.tMass = kt > 0 ? 1 / kt : 0;
      p.maxImp = 0;
    }
    const sub = this.substeps, h = dt / sub, inv_h = 1 / h;
    const hz = Math.min(this.contactHertz, (0.25 * sub) / dt);
    const soft = softness(hz, this.contactZeta, h);
    const softStatic = softness(2 * hz, this.contactZeta, h);
    const g = this.gravity;
    for (let s = 0; s < sub; s++) {
      for (const b of bodies) {
        if (!b.active) continue;
        // Gravity, a little air drag, water drag and buoyancy, and rolling resistance on the ground.
        b.vy += g * h * (1 - 0.45 * b.wet);
        const damp = 1 / (1 + h * (0.05 + 4 * b.wet));
        b.vx *= damp;
        b.vy *= damp;
        b.w *= 1 / (1 + h * (0.2 + 4 * b.wet + (b.touching ? 1.2 : 0)));
      }
      this.warmStart();
      this.solve(inv_h, soft, softStatic, true);
      for (const b of bodies) {
        if (!b.active) continue;
        const sp = Math.hypot(b.vx, b.vy);
        if (sp > MAX_SPEED) {
          b.vx *= MAX_SPEED / sp;
          b.vy *= MAX_SPEED / sp;
        }
        b.x += h * b.vx;
        b.y += h * b.vy;
        b.a += h * b.w;
        b.c = Math.cos(b.a);
        b.s = Math.sin(b.a);
      }
      this.solve(inv_h, soft, softStatic, false);
    }
    // Keep impulses for next frame's warm start.
    this.prevN.clear();
    this.prevT.clear();
    for (let i = 0; i < n; i++) {
      const p = cps[i];
      this.prevN.set(p.key, p.nImp);
      this.prevT.set(p.key, p.tImp);
    }
    this.contacts = n;
    this.finish(dt);
  }

  // ------------------------------------------------------------------ contacts

  private collide(dt: number) {
    this.n = 0;
    const { cells, W, H } = this.grid;
    const bodies = this.bodies;
    for (const b of bodies) {
      if (!b.active) continue;
      const margin = Math.min(2, 0.4 + (Math.hypot(b.vx, b.vy) + Math.abs(b.w) * b.rad) * dt * 1.2);
      const pts = b.pts;
      let wet = 0;
      for (let i = 0, pi = 0; i < pts.length; i += 2, pi++) {
        const wx = b.x + b.c * pts[i] - b.s * pts[i + 1];
        const wy = b.y + b.s * pts[i] + b.c * pts[i + 1];
        if (probe(cells, W, H, 1, wx, wy, margin)) this.add(null, b, wx, wy, pi, 0, TERRAIN_FRICTION);
        const ix = Math.floor(wx), iy = Math.floor(wy);
        if (ix >= 0 && ix < W && iy >= 0 && iy < H && cells[iy * W + ix] === WATER) wet++;
      }
      b.wet = wet / (pts.length / 2);
    }
    for (let i = 0; i < bodies.length; i++) {
      const A = bodies[i];
      if (!A.alive) continue;
      for (let j = i + 1; j < bodies.length; j++) {
        const B = bodies[j];
        if (!B.alive || (!A.active && !B.active)) continue;
        const r = A.rad + B.rad + 2;
        if ((A.x - B.x) ** 2 + (A.y - B.y) ** 2 > r * r) continue;
        this.pointsVsMask(A, B, dt);
        this.pointsVsMask(B, A, dt);
      }
    }
  }

  /** P's outline points against M's cells, in M's frame. */
  private pointsVsMask(P: PBody, M: PBody, dt: number) {
    const rel = Math.hypot(P.vx - M.vx, P.vy - M.vy) + Math.abs(P.w) * P.rad + Math.abs(M.w) * M.rad;
    const margin = Math.min(2, 0.4 + rel * dt * 1.2);
    const pts = P.pts;
    const reach = (M.rad + margin) ** 2;
    for (let i = 0, pi = 0; i < pts.length; i += 2, pi++) {
      const wx = P.x + P.c * pts[i] - P.s * pts[i + 1];
      const wy = P.y + P.s * pts[i] + P.c * pts[i + 1];
      const dx = wx - M.x, dy = wy - M.y;
      if (dx * dx + dy * dy > reach) continue;
      const lx = M.c * dx + M.s * dy + M.cx, ly = -M.s * dx + M.c * dy + M.cy;
      if (!probe(M.mask, M.mw, M.mh, 0, lx, ly, margin)) continue;
      const nx = M.c * PNX - M.s * PNY, ny = M.s * PNX + M.c * PNY;
      PNX = nx;
      PNY = ny;
      this.add(M, P, wx, wy, pi, M.id, Math.sqrt(P.friction * M.friction));
    }
  }

  /** Contact at point (px, py) of body b, pushed along the probe normal out of a (null = terrain). */
  private add(a: PBody | null, b: PBody, px: number, py: number, pi: number, other: number, friction: number) {
    let p = this.pool[this.n];
    if (!p) {
      p = { a: null, b, nx: 0, ny: 0, rAx: 0, rAy: 0, rBx: 0, rBy: 0, adj: 0, nImp: 0, tImp: 0, nMass: 0, tMass: 0, mA: 0, iA: 0, mB: 0, iB: 0, friction: 0, key: 0, maxImp: 0, px: 0, py: 0, close: 0 };
      this.pool.push(p);
    }
    this.n++;
    const nx = PNX, ny = PNY, sep = PS;
    p.a = a;
    p.b = b;
    p.nx = nx;
    p.ny = ny;
    p.px = px;
    p.py = py;
    // A static anchor keeps the world point itself as its "arm", so the separation update is uniform.
    p.rAx = a ? px - a.x : px;
    p.rAy = a ? py - a.y : py;
    p.rBx = px - b.x;
    p.rBy = py - b.y;
    p.adj = sep - ((p.rBx - p.rAx) * nx + (p.rBy - p.rAy) * ny);
    p.friction = friction;
    p.key = ((b.id & 0xfffff) * 65536 + (other & 0xffff)) * 2048 + (pi & 2047);
    p.nImp = this.prevN.get(p.key) ?? 0;
    p.tImp = this.prevT.get(p.key) ?? 0;
    // Closing speed, for waking sleepers that get hit.
    const vbx = b.vx - b.w * p.rBy, vby = b.vy + b.w * p.rBx;
    const vax = a ? a.vx - a.w * p.rAy : 0, vay = a ? a.vy + a.w * p.rAx : 0;
    p.close = -((vbx - vax) * nx + (vby - vay) * ny);
    b.touching = true;
    if (a) a.touching = true;
  }

  private warmStart() {
    const cps = this.pool;
    for (let i = 0; i < this.n; i++) {
      const p = cps[i];
      const a = p.a, b = p.b;
      const Px = p.nImp * p.nx + p.tImp * p.ny;
      const Py = p.nImp * p.ny - p.tImp * p.nx;
      if (a && p.mA) {
        a.vx -= p.mA * Px;
        a.vy -= p.mA * Py;
        a.w -= p.iA * (p.rAx * Py - p.rAy * Px);
      }
      if (p.mB) {
        b.vx += p.mB * Px;
        b.vy += p.mB * Py;
        b.w += p.iB * (p.rBx * Py - p.rBy * Px);
      }
    }
  }

  private solve(inv_h: number, soft: Softness, softStatic: Softness, useBias: boolean) {
    const cps = this.pool;
    const pushMax = this.pushMax;
    for (let i = 0; i < this.n; i++) {
      const p = cps[i];
      const a = p.a, b = p.b;
      const nx = p.nx, ny = p.ny, tx = ny, ty = -nx;
      const sf = !a || !p.mA ? softStatic : soft;
      // Current separation from the pose change since collide.
      let dpx = b.x - b.x0, dpy = b.y - b.y0;
      const daB = b.a - b.a0;
      const cB = Math.cos(daB), sB = Math.sin(daB);
      const prBx = cB * p.rBx - sB * p.rBy, prBy = sB * p.rBx + cB * p.rBy;
      let prAx = p.rAx, prAy = p.rAy;
      let vAx = 0, vAy = 0, wA = 0;
      if (a) {
        dpx -= a.x - a.x0;
        dpy -= a.y - a.y0;
        const daA = a.a - a.a0;
        const cA = Math.cos(daA), sA = Math.sin(daA);
        prAx = cA * p.rAx - sA * p.rAy;
        prAy = sA * p.rAx + cA * p.rAy;
        vAx = a.vx;
        vAy = a.vy;
        wA = a.w;
      }
      const sep = (dpx + prBx - prAx) * nx + (dpy + prBy - prAy) * ny + p.adj;
      let vBx = b.vx, vBy = b.vy, wB = b.w;
      let bias = 0, massScale = 1, impulseScale = 0;
      if (sep > 0) bias = sep * inv_h;
      else if (useBias) {
        bias = Math.max(sf.biasRate * sep, -pushMax);
        massScale = sf.massScale;
        impulseScale = sf.impulseScale;
      }
      let dvx = vBx - wB * p.rBy - (vAx - wA * p.rAy);
      let dvy = vBy + wB * p.rBx - (vAy + wA * p.rAx);
      const vn = dvx * nx + dvy * ny;
      let imp = -p.nMass * massScale * (vn + bias) - impulseScale * p.nImp;
      const newImp = Math.max(p.nImp + imp, 0);
      imp = newImp - p.nImp;
      p.nImp = newImp;
      if (newImp > p.maxImp) p.maxImp = newImp;
      let Px = imp * nx, Py = imp * ny;
      vAx -= p.mA * Px;
      vAy -= p.mA * Py;
      wA -= p.iA * (p.rAx * Py - p.rAy * Px);
      vBx += p.mB * Px;
      vBy += p.mB * Py;
      wB += p.iB * (p.rBx * Py - p.rBy * Px);
      // Friction, capped by this point's normal impulse.
      dvx = vBx - wB * p.rBy - (vAx - wA * p.rAy);
      dvy = vBy + wB * p.rBx - (vAy + wA * p.rAx);
      const vt = dvx * tx + dvy * ty;
      const maxF = p.friction * p.nImp;
      const newT = Math.max(-maxF, Math.min(p.tImp - p.tMass * vt, maxF));
      const ti = newT - p.tImp;
      p.tImp = newT;
      Px = ti * tx;
      Py = ti * ty;
      vAx -= p.mA * Px;
      vAy -= p.mA * Py;
      wA -= p.iA * (p.rAx * Py - p.rAy * Px);
      vBx += p.mB * Px;
      vBy += p.mB * Py;
      wB += p.iB * (p.rBx * Py - p.rBy * Px);
      if (a && p.mA) {
        a.vx = vAx;
        a.vy = vAy;
        a.w = wA;
      }
      if (p.mB) {
        b.vx = vBx;
        b.vy = vBy;
        b.w = wB;
      }
    }
  }

  private finish(dt: number) {
    const cps = this.pool;
    const g = this.gravity;
    for (let i = 0; i < this.n; i++) {
      const p = cps[i];
      const b = p.b, a = p.a;
      if (p.maxImp > b.hitImp) {
        b.hitImp = p.maxImp;
        b.hitX = p.px;
        b.hitY = p.py;
      }
      if (a && p.maxImp > a.hitImp) {
        a.hitImp = p.maxImp;
        a.hitX = p.px;
        a.hitY = p.py;
      }
      // A sleeper struck by something moving wakes up for next frame.
      if (a && a.sleeping && b.active && (p.close > 6 || Math.hypot(b.vx, b.vy) > 4)) this.wake(a);
      if (b.sleeping && a && a.active && (p.close > 6 || Math.hypot(a.vx, a.vy) > 4)) this.wake(b);
    }
    const { W, H } = this.grid;
    for (const b of this.bodies) {
      if (!b.active) continue;
      b.hit = Math.hypot(b.vx - b.svx, b.vy - (b.svy + g * dt * (1 - 0.45 * b.wet)));
      if (Math.hypot(b.vx, b.vy) < SLEEP_LIN && Math.abs(b.w) < SLEEP_ANG) {
        b.sleepTime += dt;
        if (b.sleepTime > SLEEP_TIME) {
          b.sleeping = true;
          b.vx = b.vy = b.w = 0;
          this.slept.push(b);
        }
      } else b.sleepTime = 0;
      // Anything that somehow escapes the yard is gone.
      if (b.y > H + 20 || b.x < -20 || b.x > W + 20) b.alive = false;
    }
  }
}
