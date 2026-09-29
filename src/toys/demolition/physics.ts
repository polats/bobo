// 2D rigid bodies for stacking and smashing, after Box2D v3's "soft step" solver (Catto 2024):
// contacts are collided once per frame, then solved over a few substeps with soft constraints,
// a relax pass without bias, warm starting from last frame, and per-body sleeping.
// Box-box contact manifolds follow Box2D Lite's SAT + clipping, with a speculative margin.
// Additions for rubble and tall stacks: Box2D 3.1 style rolling resistance (a torque at each contact
// capped by the normal load, so balls and chips stop rolling); a shock-propagation pass after each
// relax, run bottom-up through the contact graph with the lower body of each pair made heavier, so
// towers settle without jitter even at low substep counts; and island waking, so a hard hit on a
// sleeping building wakes all of it before the solve instead of bouncing off frozen bricks.

export const enum Shape {
  Box = 0,
  Circle = 1,
}

export const enum Kind {
  Block = 0,
  Wrecker = 1,
  Cannonball = 2,
  Static = 3,
}

export interface Body {
  id: number;
  shape: Shape;
  kind: Kind;
  hx: number;
  hy: number;
  r: number;
  x: number;
  y: number;
  a: number;
  c: number;
  s: number;
  vx: number;
  vy: number;
  w: number;
  invMass: number;
  invI: number;
  mass: number;
  friction: number;
  /** Rolling resistance coefficient (Box2D 3.1): the resisting torque is this × radius × normal force. */
  rolling: number;
  sleeping: boolean;
  sleepTime: number;
  // Pose at collide time, for per-substep separation updates.
  x0: number;
  y0: number;
  a0: number;
  // Velocity at frame start, for break detection.
  svx: number;
  svy: number;
  color: number;
  breakable: boolean;
  alive: boolean;
  /** Seconds since spawn; fresh fracture pieces can't re-break immediately. */
  age: number;
  /** Contact hops from something still (ground or a sleeper) this frame, for shock propagation. */
  depth: number;
}

interface Point {
  id: number;
  rAx: number;
  rAy: number;
  rBx: number;
  rBy: number;
  adj: number;
  nImp: number;
  tImp: number;
  nMass: number;
  tMass: number;
  /** Normal and tangent masses for the shock pass. */
  nMassS: number;
  tMassS: number;
  maxImp: number;
  px: number;
  py: number;
}

export interface Manifold {
  key: number;
  a: Body;
  b: Body;
  nx: number;
  ny: number;
  points: Point[];
  friction: number;
  mA: number;
  iA: number;
  mB: number;
  iB: number;
  static: boolean;
  /** Resisting torque per unit normal impulse (m), its angular mass and accumulated impulse. */
  rolling: number;
  rollMass: number;
  rollImp: number;
  /** Which body sits lower in the contact graph (1 = a, 2 = b, 0 = level), and that depth. */
  lower: number;
  depth: number;
  rollMassS: number;
}

export interface Rope {
  ax: number;
  ay: number;
  avx: number;
  avy: number;
  body: Body;
  length: number;
  imp: number;
}

export interface Grab {
  body: Body;
  lx: number;
  ly: number;
  tx: number;
  ty: number;
  ix: number;
  iy: number;
}

export interface Impact {
  x: number;
  y: number;
  impulse: number;
  speed: number;
}

const MARGIN = 0.03; // speculative contact distance (m)
const SLEEP_LIN = 0.06;
const SLEEP_ANG = 0.08;
const SLEEP_TIME = 0.5;
const MAX_SPEED = 80;
const CELL = 1.25;
/** Closing speed at which a touch wakes the whole sleeping pile, not just the body touched. */
const WAKE_HIT = 1;
/** Shock pass: inverse-mass scale of the lower body. 0 would be classic shock propagation (lower
 * body immovable), but with one pass that feeds rocking up the stack; half weight keeps it stable. */
const SHOCK_SCALE = 0.5;

interface Softness {
  biasRate: number;
  massScale: number;
  impulseScale: number;
}

function softness(hertz: number, zeta: number, h: number): Softness {
  if (hertz === 0) return { biasRate: 0, massScale: 1, impulseScale: 0 };
  const omega = 2 * Math.PI * hertz;
  const a1 = 2 * zeta + h * omega;
  const a2 = h * omega * a1;
  const a3 = 1 / (1 + a2);
  return { biasRate: omega / a1, massScale: a2 * a3, impulseScale: a3 };
}

export class World {
  bodies: Body[] = [];
  manifolds = new Map<number, Manifold>();
  ropes: Rope[] = [];
  grabs: Grab[] = [];
  gravity = -10;
  substeps = 8;
  contactHertz = 60;
  contactZeta = 10;
  pushMax = 3;
  /** Shock propagation: the lower body's share of each correction in the bottom-up pass (1 = off). */
  shockScale = SHOCK_SCALE;
  breakSpeed = 7;
  maxBodies = 650;
  private nextId = 1;
  /** Bodies whose velocity jumped past breakSpeed this frame (excluding gravity). */
  broken: Body[] = [];
  impacts: Impact[] = [];
  /** This frame's active contacts, ordered bottom-up through the contact graph. */
  private upward: Manifold[] = [];

  add(b: Partial<Body> & { shape: Shape; density?: number }): Body {
    const body: Body = {
      id: this.nextId++,
      shape: b.shape,
      kind: b.kind ?? Kind.Block,
      hx: b.hx ?? 0.5,
      hy: b.hy ?? 0.5,
      r: b.r ?? 0.5,
      x: b.x ?? 0,
      y: b.y ?? 0,
      a: b.a ?? 0,
      c: 1,
      s: 0,
      vx: b.vx ?? 0,
      vy: b.vy ?? 0,
      w: b.w ?? 0,
      invMass: 0,
      invI: 0,
      mass: 0,
      friction: b.friction ?? 0.6,
      rolling: b.rolling ?? (b.shape === Shape.Circle ? 0.15 : 0.05),
      sleeping: b.sleeping ?? false,
      sleepTime: 0,
      x0: 0,
      y0: 0,
      a0: 0,
      svx: 0,
      svy: 0,
      color: b.color ?? 0,
      breakable: b.breakable ?? false,
      alive: true,
      age: 0,
      depth: 0,
    };
    body.c = Math.cos(body.a);
    body.s = Math.sin(body.a);
    const density = b.density ?? 1;
    if (body.kind !== Kind.Static) {
      if (body.shape === Shape.Box) {
        const m = density * 4 * body.hx * body.hy;
        body.mass = m;
        body.invMass = 1 / m;
        body.invI = 1 / ((m * (4 * body.hx * body.hx + 4 * body.hy * body.hy)) / 12);
      } else {
        const m = density * Math.PI * body.r * body.r;
        body.mass = m;
        body.invMass = 1 / m;
        body.invI = 1 / (0.5 * m * body.r * body.r);
      }
    }
    this.bodies.push(body);
    return body;
  }

  remove(b: Body) {
    b.alive = false;
    // Sleepers resting on it have no manifold with it (sleeper pairs are never collided): wake the neighbourhood.
    this.wakeRadius(b.x, b.y, Math.max(b.hx, b.hy, b.r) + 0.8);
    for (const [k, m] of this.manifolds) if (m.a === b || m.b === b) this.manifolds.delete(k);
    this.ropes = this.ropes.filter((r) => r.body !== b);
    this.grabs = this.grabs.filter((g) => g.body !== b);
  }

  compact() {
    this.bodies = this.bodies.filter((b) => b.alive);
  }

  wake(b: Body) {
    if (b.kind === Kind.Static) return;
    b.sleeping = false;
    b.sleepTime = 0;
  }

  wakeRadius(x: number, y: number, r: number) {
    for (const b of this.bodies) if (Math.hypot(b.x - x, b.y - y) < r + Math.max(b.hx, b.hy, b.r)) this.wake(b);
  }

  get sleepingCount() {
    let n = 0;
    for (const b of this.bodies) if (b.sleeping) n++;
    return n;
  }

  // ------------------------------------------------------------------ step

  step(dt: number) {
    if (dt <= 0) return;
    this.broken.length = 0;
    this.impacts.length = 0;
    const bodies = this.bodies;
    for (const b of bodies) {
      b.x0 = b.x;
      b.y0 = b.y;
      b.a0 = b.a;
      b.svx = b.vx;
      b.svy = b.vy;
      b.age += dt;
    }
    for (const g of this.grabs) this.wake(g.body);
    for (const r of this.ropes) this.wake(r.body);
    this.collide();
    const active = this.prepare();
    const shock = this.shockScale < 1;

    const n = this.substeps;
    const h = dt / n;
    const inv_h = 1 / h;
    const soft = softness(Math.min(this.contactHertz, 0.25 * n / dt), this.contactZeta, h);
    const softStatic = softness(2 * Math.min(this.contactHertz, 0.25 * n / dt), this.contactZeta, h);
    const jointSoft = softness(2 * this.contactHertz, 2, h);
    const mouseSoft = softness(5, 0.7, h);
    const g = this.gravity;
    for (let s = 0; s < n; s++) {
      for (const b of bodies) {
        if (b.invMass === 0 || b.sleeping) continue;
        b.vy += g * h;
        const damp = 1 / (1 + h * 0.05);
        b.vx *= damp;
        b.vy *= damp;
        b.w *= 1 / (1 + h * 0.2);
      }
      this.warmStart(active);
      this.solveContacts(active, inv_h, soft, softStatic, true);
      this.solveJoints(h, jointSoft, mouseSoft, true);
      for (const b of bodies) {
        if (b.invMass === 0 || b.sleeping) continue;
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
      this.solveContacts(active, inv_h, soft, softStatic, false);
      if (shock) this.solveContacts(this.upward, inv_h, soft, softStatic, false, true);
      this.solveJoints(h, jointSoft, mouseSoft, false);
    }
    this.finish(dt, active);
  }

  private collide() {
    const bodies = this.bodies;
    // Uniform grid broadphase.
    const grid = new Map<number, Body[]>();
    const key = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);
    const statics: Body[] = [];
    for (const b of bodies) {
      if (!b.alive) continue;
      if (b.kind === Kind.Static) {
        statics.push(b);
        continue;
      }
      const e = extentX(b), f = extentY(b);
      const i0 = Math.floor((b.x - e - MARGIN) / CELL), i1 = Math.floor((b.x + e + MARGIN) / CELL);
      const j0 = Math.floor((b.y - f - MARGIN) / CELL), j1 = Math.floor((b.y + f + MARGIN) / CELL);
      for (let i = i0; i <= i1; i++)
        for (let j = j0; j <= j1; j++) {
          const k = key(i, j);
          let cell = grid.get(k);
          if (!cell) grid.set(k, (cell = []));
          cell.push(b);
        }
    }
    // Wake a sleeper and every sleeper touching it, transitively (Box2D wakes whole islands).
    // Sleeper pairs may have no manifold yet, so touching is judged from the boxes' bounds.
    let woke = false;
    const wakePile = (start: Body) => {
      const stack = [start];
      this.wake(start);
      woke = true;
      while (stack.length) {
        const x = stack.pop()!;
        const e = extentX(x) + MARGIN, f = extentY(x) + MARGIN;
        const i0 = Math.floor((x.x - e) / CELL), i1 = Math.floor((x.x + e) / CELL);
        const j0 = Math.floor((x.y - f) / CELL), j1 = Math.floor((x.y + f) / CELL);
        for (let i = i0; i <= i1; i++)
          for (let j = j0; j <= j1; j++)
            for (const y of grid.get(key(i, j)) ?? []) {
              if (!y.sleeping || Math.abs(y.x - x.x) > e + extentX(y) || Math.abs(y.y - x.y) > f + extentY(y)) continue;
              this.wake(y);
              stack.push(y);
            }
      }
    };
    const old = this.manifolds;
    const next = new Map<number, Manifold>();
    const consider = (a: Body, b: Body) => {
      if (a.id > b.id) [a, b] = [b, a];
      const k = a.id * 1048576 + b.id;
      if (next.has(k)) return;
      const aStill = a.sleeping || a.kind === Kind.Static;
      const bStill = b.sleeping || b.kind === Kind.Static;
      const prev = old.get(k);
      if (aStill && bStill) {
        // Neither can move: keep the old manifold (warm start data) untouched.
        if (prev) next.set(k, prev);
        return;
      }
      const m = collidePair(a, b);
      if (!m) return;
      m.key = k;
      // A hard hit on a sleeper wakes its whole pile now, before the solve, so the blow meets
      // live bodies instead of bouncing off a frozen building.
      const sleeper = a.sleeping ? a : b.sleeping ? b : null;
      if (sleeper && closingSpeed(m) > WAKE_HIT) wakePile(sleeper);
      if (prev) {
        m.rollImp = prev.rollImp;
        for (const p of m.points)
          for (const q of prev.points)
            if (q.id === p.id) {
              p.nImp = q.nImp;
              p.tImp = q.tImp;
              break;
            }
      }
      next.set(k, m);
    };
    const pairs = () => {
      for (const cell of grid.values()) {
        for (let i = 0; i < cell.length; i++) for (let j = i + 1; j < cell.length; j++) consider(cell[i], cell[j]);
      }
      // Statics (the ground) against every movable body near them.
      for (const st of statics)
        for (const b of bodies) {
          if (!b.alive || b.kind === Kind.Static) continue;
          const ext = Math.max(b.hx, b.hy, b.r) * 1.5;
          if (b.y - ext > st.y + st.hy + MARGIN) continue;
          consider(st, b);
        }
    };
    pairs();
    // Pairs skipped earlier as asleep may just have woken: sweep again for their manifolds.
    for (let i = 0; woke && i < 3; i++) {
      woke = false;
      pairs();
    }
    // A sleeper whose contact vanished has lost its support: wake it.
    for (const [k, m] of old) {
      if (next.has(k)) continue;
      if (m.a.sleeping) this.wake(m.a);
      if (m.b.sleeping) this.wake(m.b);
    }
    this.manifolds = next;
  }

  private prepare(): Manifold[] {
    const active: Manifold[] = [];
    const FAR = 1e9;
    for (const b of this.bodies) b.depth = b.sleeping || b.invMass === 0 ? 0 : FAR;
    for (const m of this.manifolds.values()) {
      const a = m.a, b = m.b;
      const aStill = a.sleeping || a.invMass === 0;
      const bStill = b.sleeping || b.invMass === 0;
      if (aStill && bStill) continue;
      m.mA = aStill ? 0 : a.invMass;
      m.iA = aStill ? 0 : a.invI;
      m.mB = bStill ? 0 : b.invMass;
      m.iB = bStill ? 0 : b.invI;
      m.static = aStill || bStill;
      const ki = m.iA + m.iB;
      m.rollMass = ki > 0 ? 1 / ki : 0;
      const nx = m.nx, ny = m.ny, tx = ny, ty = -nx;
      for (const p of m.points) {
        const rnA = p.rAx * ny - p.rAy * nx;
        const rnB = p.rBx * ny - p.rBy * nx;
        const kn = m.mA + m.mB + m.iA * rnA * rnA + m.iB * rnB * rnB;
        p.nMass = kn > 0 ? 1 / kn : 0;
        const rtA = p.rAx * ty - p.rAy * tx;
        const rtB = p.rBx * ty - p.rBy * tx;
        const kt = m.mA + m.mB + m.iA * rtA * rtA + m.iB * rtB * rtB;
        p.tMass = kt > 0 ? 1 / kt : 0;
        p.maxImp = 0;
      }
      active.push(m);
    }
    // Contact-graph depth from whatever is still: relax over the pairs until nothing shortens.
    // Towers are a few dozen hops deep, so this is a handful of cheap sweeps.
    for (let sweep = 0, changed = true; changed && sweep < 96; sweep++) {
      changed = false;
      for (const m of active) {
        const a = m.a, b = m.b;
        if (a.depth + 1 < b.depth) {
          b.depth = a.depth + 1;
          changed = true;
        } else if (b.depth + 1 < a.depth) {
          a.depth = b.depth + 1;
          changed = true;
        }
      }
    }
    // Masses for the shock pass, where the lower body of each pair takes only part of the correction.
    const k = this.shockScale;
    for (const m of active) {
      const da = m.a.depth, db = m.b.depth;
      m.depth = Math.min(da, db);
      m.lower = da < db ? 1 : db < da ? 2 : 0;
      const ka = m.lower === 1 ? k : 1, kb = m.lower === 2 ? k : 1;
      const mA = m.mA * ka, iA = m.iA * ka, mB = m.mB * kb, iB = m.iB * kb;
      const ki = iA + iB;
      m.rollMassS = ki > 0 ? 1 / ki : 0;
      const nx = m.nx, ny = m.ny, tx = ny, ty = -nx;
      for (const p of m.points) {
        if (!m.lower) {
          p.nMassS = p.nMass;
          p.tMassS = p.tMass;
          continue;
        }
        const rnA = p.rAx * ny - p.rAy * nx;
        const rnB = p.rBx * ny - p.rBy * nx;
        const kn = mA + mB + iA * rnA * rnA + iB * rnB * rnB;
        p.nMassS = kn > 0 ? 1 / kn : 0;
        const rtA = p.rAx * ty - p.rAy * tx;
        const rtB = p.rBx * ty - p.rBy * tx;
        const kt = mA + mB + iA * rtA * rtA + iB * rtB * rtB;
        p.tMassS = kt > 0 ? 1 / kt : 0;
      }
    }
    const up = this.upward;
    up.length = 0;
    for (const m of active) up.push(m);
    up.sort((p, q) => p.depth - q.depth);
    return active;
  }

  private warmStart(active: Manifold[]) {
    for (const m of active) {
      const a = m.a, b = m.b;
      const nx = m.nx, ny = m.ny, tx = ny, ty = -nx;
      for (const p of m.points) {
        const Px = p.nImp * nx + p.tImp * tx;
        const Py = p.nImp * ny + p.tImp * ty;
        a.vx -= m.mA * Px;
        a.vy -= m.mA * Py;
        a.w -= m.iA * (p.rAx * Py - p.rAy * Px);
        b.vx += m.mB * Px;
        b.vy += m.mB * Py;
        b.w += m.iB * (p.rBx * Py - p.rBy * Px);
      }
      a.w -= m.iA * m.rollImp;
      b.w += m.iB * m.rollImp;
    }
  }

  /**
   * One Gauss-Seidel pass over the contacts. `shock` is the shock-propagation pass: run bottom-up
   * with the lower body of each pair (nearer the ground in the contact graph) made heavier, so
   * support travels up a tall stack in one sweep and upper bodies barely push their base around.
   */
  private solveContacts(active: Manifold[], inv_h: number, soft: Softness, softStatic: Softness, useBias: boolean, shock = false) {
    const k = this.shockScale;
    for (const m of active) {
      const a = m.a, b = m.b;
      const ka = shock && m.lower === 1 ? k : 1, kb = shock && m.lower === 2 ? k : 1;
      const mA = m.mA * ka, iA = m.iA * ka, mB = m.mB * kb, iB = m.iB * kb;
      const nx = m.nx, ny = m.ny, tx = ny, ty = -nx;
      const sf = m.static ? softStatic : soft;
      // Pose change since collide, for the current separation.
      const dpx = b.x - b.x0 - (a.x - a.x0);
      const dpy = b.y - b.y0 - (a.y - a.y0);
      const daA = a.a - a.a0, daB = b.a - b.a0;
      const cA = Math.cos(daA), sA = Math.sin(daA), cB = Math.cos(daB), sB = Math.sin(daB);
      let vAx = a.vx, vAy = a.vy, wA = a.w, vBx = b.vx, vBy = b.vy, wB = b.w;
      let totalN = 0;
      for (const p of m.points) {
        const prAx = cA * p.rAx - sA * p.rAy, prAy = sA * p.rAx + cA * p.rAy;
        const prBx = cB * p.rBx - sB * p.rBy, prBy = sB * p.rBx + cB * p.rBy;
        const sep = (dpx + prBx - prAx) * nx + (dpy + prBy - prAy) * ny + p.adj;
        let bias = 0, massScale = 1, impulseScale = 0;
        if (sep > 0) bias = sep * inv_h;
        else if (useBias) {
          bias = Math.max(sf.biasRate * sep, -this.pushMax);
          massScale = sf.massScale;
          impulseScale = sf.impulseScale;
        }
        const dvx = vBx - wB * p.rBy - (vAx - wA * p.rAy);
        const dvy = vBy + wB * p.rBx - (vAy + wA * p.rAx);
        const vn = dvx * nx + dvy * ny;
        let imp = -(shock ? p.nMassS : p.nMass) * massScale * (vn + bias) - impulseScale * p.nImp;
        const newImp = Math.max(p.nImp + imp, 0);
        imp = newImp - p.nImp;
        p.nImp = newImp;
        if (newImp > p.maxImp) p.maxImp = newImp;
        totalN += newImp;
        const Px = imp * nx, Py = imp * ny;
        vAx -= mA * Px;
        vAy -= mA * Py;
        wA -= iA * (p.rAx * Py - p.rAy * Px);
        vBx += mB * Px;
        vBy += mB * Py;
        wB += iB * (p.rBx * Py - p.rBy * Px);
      }
      // Rolling resistance: oppose relative spin with a torque capped by the normal load.
      if (m.rolling > 0) {
        const maxR = m.rolling * totalN;
        const old = m.rollImp;
        m.rollImp = Math.max(-maxR, Math.min(maxR, old - (shock ? m.rollMassS : m.rollMass) * (wB - wA)));
        const d = m.rollImp - old;
        wA -= iA * d;
        wB += iB * d;
      }
      const mu = m.friction;
      for (const p of m.points) {
        const dvx = vBx - wB * p.rBy - (vAx - wA * p.rAy);
        const dvy = vBy + wB * p.rBx - (vAy + wA * p.rAx);
        const vt = dvx * tx + dvy * ty;
        let imp = -(shock ? p.tMassS : p.tMass) * vt;
        const maxF = mu * p.nImp;
        const newImp = Math.max(-maxF, Math.min(p.tImp + imp, maxF));
        imp = newImp - p.tImp;
        p.tImp = newImp;
        const Px = imp * tx, Py = imp * ty;
        vAx -= mA * Px;
        vAy -= mA * Py;
        wA -= iA * (p.rAx * Py - p.rAy * Px);
        vBx += mB * Px;
        vBy += mB * Py;
        wB += iB * (p.rBx * Py - p.rBy * Px);
      }
      if (mA > 0 || iA > 0) {
        a.vx = vAx;
        a.vy = vAy;
        a.w = wA;
      }
      if (mB > 0 || iB > 0) {
        b.vx = vBx;
        b.vy = vBy;
        b.w = wB;
      }
    }
  }

  private solveJoints(h: number, jointSoft: Softness, mouseSoft: Softness, useBias: boolean) {
    // Wrecking-ball rope: max-distance constraint from a kinematic anchor.
    for (const r of this.ropes) {
      const b = r.body;
      const dx = b.x - r.ax, dy = b.y - r.ay;
      const d = Math.hypot(dx, dy) || 1e-6;
      const nx = dx / d, ny = dy / d;
      const C = d - r.length;
      if (C < 0) {
        r.imp = 0;
        continue;
      }
      const cdot = (b.vx - r.avx) * nx + (b.vy - r.avy) * ny;
      let bias = 0, massScale = 1, impulseScale = 0;
      if (useBias) {
        bias = Math.min(jointSoft.biasRate * C, 30);
        massScale = jointSoft.massScale;
        impulseScale = jointSoft.impulseScale;
      }
      const mass = 1 / b.invMass;
      let imp = -mass * massScale * (cdot + bias) - impulseScale * r.imp;
      const newImp = Math.min(r.imp + imp, 0);
      imp = newImp - r.imp;
      r.imp = newImp;
      b.vx += b.invMass * imp * nx;
      b.vy += b.invMass * imp * ny;
    }
    // Finger grabs: soft point constraint to the target.
    for (const gr of this.grabs) {
      const b = gr.body;
      const rx = b.c * gr.lx - b.s * gr.ly, ry = b.s * gr.lx + b.c * gr.ly;
      const Cx = b.x + rx - gr.tx, Cy = b.y + ry - gr.ty;
      const vx = b.vx - b.w * ry, vy = b.vy + b.w * rx;
      const m = b.invMass, i = b.invI;
      const k11 = m + i * ry * ry, k12 = -i * rx * ry, k22 = m + i * rx * rx;
      const det = k11 * k22 - k12 * k12 || 1e-9;
      let bx = vx, by = vy;
      if (useBias) {
        bx += mouseSoft.biasRate * Cx;
        by += mouseSoft.biasRate * Cy;
      }
      const ms = useBias ? mouseSoft.massScale : 1;
      const is = useBias ? mouseSoft.impulseScale : 0;
      let ix = (-(k22 * bx - k12 * by) / det) * ms - is * gr.ix;
      let iy = (-(-k12 * bx + k11 * by) / det) * ms - is * gr.iy;
      const maxImp = 400 * b.mass * h;
      let ax = gr.ix + ix, ay = gr.iy + iy;
      const len = Math.hypot(ax, ay);
      if (len > maxImp) {
        ax *= maxImp / len;
        ay *= maxImp / len;
      }
      ix = ax - gr.ix;
      iy = ay - gr.iy;
      gr.ix = ax;
      gr.iy = ay;
      b.vx += m * ix;
      b.vy += m * iy;
      b.w += i * (rx * iy - ry * ix);
      b.w *= 0.995;
    }
  }

  private finish(dt: number, active: Manifold[]) {
    for (const r of this.ropes) r.imp = 0;
    for (const g of this.grabs) {
      g.ix = 0;
      g.iy = 0;
    }
    // Hard hits for dust, shake and haptics.
    for (const m of active)
      for (const p of m.points) {
        if (p.maxImp <= 0) continue;
        const lighter = Math.min(m.a.invMass > 0 ? m.a.mass : Infinity, m.b.invMass > 0 ? m.b.mass : Infinity);
        const speed = p.maxImp / (lighter === Infinity ? 1 : lighter);
        if (speed > 2.5) this.impacts.push({ x: p.px, y: p.py, impulse: p.maxImp, speed });
      }
    // Wake sleepers touched by something moving.
    for (const m of active) {
      const a = m.a, b = m.b;
      if (a.sleeping && !b.sleeping && b.invMass > 0 && Math.hypot(b.vx, b.vy) + Math.abs(b.w) * 0.3 > 0.25) this.wake(a);
      if (b.sleeping && !a.sleeping && a.invMass > 0 && Math.hypot(a.vx, a.vy) + Math.abs(a.w) * 0.3 > 0.25) this.wake(b);
    }
    const g = this.gravity;
    const grabbed = new Set(this.grabs.map((x) => x.body));
    for (const b of this.bodies) {
      if (b.invMass === 0 || b.sleeping || !b.alive) continue;
      if (b.breakable && b.age > 0.4) {
        const dvx = b.vx - b.svx, dvy = b.vy - (b.svy + g * dt);
        if (Math.hypot(dvx, dvy) > this.breakSpeed) this.broken.push(b);
      }
      const still = Math.hypot(b.vx, b.vy) < SLEEP_LIN && Math.abs(b.w) < SLEEP_ANG;
      if (still && !grabbed.has(b) && b.kind !== Kind.Wrecker) {
        b.sleepTime += dt;
        if (b.sleepTime > SLEEP_TIME) {
          b.sleeping = true;
          b.vx = b.vy = b.w = 0;
        }
      } else b.sleepTime = 0;
      // Anything that falls off the world is gone.
      if (b.y < -40) b.alive = false;
    }
  }
}

// ------------------------------------------------------------------ narrowphase

function collidePair(a: Body, b: Body): Manifold | null {
  if (a.shape === Shape.Box && b.shape === Shape.Box) return boxBox(a, b);
  if (a.shape === Shape.Circle && b.shape === Shape.Circle) return circleCircle(a, b);
  if (a.shape === Shape.Box) return boxCircle(a, b, false);
  return boxCircle(b, a, true);
}

const extentX = (b: Body) => (b.shape === Shape.Circle ? b.r : Math.abs(b.hx * b.c) + Math.abs(b.hy * b.s));
const extentY = (b: Body) => (b.shape === Shape.Circle ? b.r : Math.abs(b.hx * b.s) + Math.abs(b.hy * b.c));

/** Lever arm for rolling resistance: a ball's radius, a box's half thickness; the ground has none. */
const rollRadius = (b: Body) => (b.kind === Kind.Static ? 0 : b.shape === Shape.Circle ? b.r : Math.min(b.hx, b.hy));

function makeManifold(a: Body, b: Body, nx: number, ny: number): Manifold {
  // Box2D 3.1 mixing: the larger coefficient times the larger radius.
  const rolling = Math.max(a.rolling, b.rolling) * Math.max(rollRadius(a), rollRadius(b));
  return {
    key: 0,
    a,
    b,
    nx,
    ny,
    points: [],
    friction: Math.sqrt(a.friction * b.friction),
    mA: 0,
    iA: 0,
    mB: 0,
    iB: 0,
    static: false,
    rolling,
    rollMass: 0,
    rollImp: 0,
    lower: 0,
    depth: 0,
    rollMassS: 0,
  };
}

/** Approach speed along the normal at the manifold's first point (positive when closing). */
function closingSpeed(m: Manifold): number {
  const a = m.a, b = m.b, p = m.points[0];
  const dvx = b.vx - b.w * p.rBy - (a.vx - a.w * p.rAy);
  const dvy = b.vy + b.w * p.rBx - (a.vy + a.w * p.rAx);
  return -(dvx * m.nx + dvy * m.ny);
}

function addPoint(m: Manifold, px: number, py: number, sep: number, id: number) {
  const a = m.a, b = m.b;
  const rAx = px - a.x, rAy = py - a.y, rBx = px - b.x, rBy = py - b.y;
  const adj = sep - ((rBx - rAx) * m.nx + (rBy - rAy) * m.ny);
  m.points.push({ id, rAx, rAy, rBx, rBy, adj, nImp: 0, tImp: 0, nMass: 0, tMass: 0, nMassS: 0, tMassS: 0, maxImp: 0, px, py });
}

function circleCircle(a: Body, b: Body): Manifold | null {
  const dx = b.x - a.x, dy = b.y - a.y;
  const d = Math.hypot(dx, dy);
  const sep = d - a.r - b.r;
  if (sep > MARGIN) return null;
  const nx = d > 1e-9 ? dx / d : 0, ny = d > 1e-9 ? dy / d : 1;
  const m = makeManifold(a, b, nx, ny);
  addPoint(m, a.x + nx * (a.r + sep * 0.5), a.y + ny * (a.r + sep * 0.5), sep, 0);
  return m;
}

/** Box `bx` vs circle `ci`; `flip` means the pair order is (circle, box). */
function boxCircle(bx: Body, ci: Body, flip: boolean): Manifold | null {
  const dx = ci.x - bx.x, dy = ci.y - bx.y;
  const lx = bx.c * dx + bx.s * dy, ly = -bx.s * dx + bx.c * dy;
  let qx = Math.max(-bx.hx, Math.min(bx.hx, lx));
  let qy = Math.max(-bx.hy, Math.min(bx.hy, ly));
  let nlx: number, nly: number, sep: number;
  if (qx === lx && qy === ly) {
    // Centre inside the box: push out along the shallowest face.
    const ex = bx.hx - Math.abs(lx), ey = bx.hy - Math.abs(ly);
    if (ex < ey) {
      nlx = Math.sign(lx) || 1;
      nly = 0;
      qx = nlx * bx.hx;
      sep = -ex - ci.r;
    } else {
      nlx = 0;
      nly = Math.sign(ly) || 1;
      qy = nly * bx.hy;
      sep = -ey - ci.r;
    }
  } else {
    const ddx = lx - qx, ddy = ly - qy;
    const d = Math.hypot(ddx, ddy);
    nlx = ddx / d;
    nly = ddy / d;
    sep = d - ci.r;
  }
  if (sep > MARGIN) return null;
  let nx = bx.c * nlx - bx.s * nly, ny = bx.s * nlx + bx.c * nly;
  const px = bx.x + bx.c * qx - bx.s * qy, py = bx.y + bx.s * qx + bx.c * qy;
  const a = flip ? ci : bx, b = flip ? bx : ci;
  if (flip) {
    nx = -nx;
    ny = -ny;
  }
  const m = makeManifold(a, b, nx, ny);
  addPoint(m, px, py, sep, 0);
  return m;
}

// Box2D Lite style box-box: SAT for the reference face, then clip the incident edge.
const NO_EDGE = 0, EDGE1 = 1, EDGE2 = 2, EDGE3 = 3, EDGE4 = 4;
interface ClipV {
  x: number;
  y: number;
  in1: number;
  out1: number;
  in2: number;
  out2: number;
}
const cv = (): ClipV => ({ x: 0, y: 0, in1: 0, out1: 0, in2: 0, out2: 0 });
const inc = [cv(), cv()];
const clip1 = [cv(), cv()];
const clip2 = [cv(), cv()];
const copy = (d: ClipV, s: ClipV) => {
  d.x = s.x;
  d.y = s.y;
  d.in1 = s.in1;
  d.out1 = s.out1;
  d.in2 = s.in2;
  d.out2 = s.out2;
};

function clipSegment(out: ClipV[], vin: ClipV[], nx: number, ny: number, offset: number, clipEdge: number): number {
  let num = 0;
  const d0 = nx * vin[0].x + ny * vin[0].y - offset;
  const d1 = nx * vin[1].x + ny * vin[1].y - offset;
  if (d0 <= 0) copy(out[num++], vin[0]);
  if (d1 <= 0) copy(out[num++], vin[1]);
  if (d0 * d1 < 0 && num < 2) {
    const t = d0 / (d0 - d1);
    const o = out[num];
    const src = d0 > 0 ? vin[0] : vin[1];
    copy(o, src);
    o.x = vin[0].x + t * (vin[1].x - vin[0].x);
    o.y = vin[0].y + t * (vin[1].y - vin[0].y);
    if (d0 > 0) {
      o.in1 = clipEdge;
      o.in2 = NO_EDGE;
    } else {
      o.out1 = clipEdge;
      o.out2 = NO_EDGE;
    }
    num++;
  }
  return num;
}

function incidentEdge(hx: number, hy: number, px: number, py: number, c: number, s: number, nx: number, ny: number) {
  // Normal into the incident box's frame, reversed.
  const lx = -(c * nx + s * ny), ly = -(-s * nx + c * ny);
  const e0 = inc[0], e1 = inc[1];
  if (Math.abs(lx) > Math.abs(ly)) {
    if (lx > 0) {
      e0.x = hx; e0.y = -hy; e0.in2 = EDGE3; e0.out2 = EDGE4;
      e1.x = hx; e1.y = hy; e1.in2 = EDGE4; e1.out2 = EDGE1;
    } else {
      e0.x = -hx; e0.y = hy; e0.in2 = EDGE1; e0.out2 = EDGE2;
      e1.x = -hx; e1.y = -hy; e1.in2 = EDGE2; e1.out2 = EDGE3;
    }
  } else if (ly > 0) {
    e0.x = hx; e0.y = hy; e0.in2 = EDGE4; e0.out2 = EDGE1;
    e1.x = -hx; e1.y = hy; e1.in2 = EDGE1; e1.out2 = EDGE2;
  } else {
    e0.x = -hx; e0.y = -hy; e0.in2 = EDGE2; e0.out2 = EDGE3;
    e1.x = hx; e1.y = -hy; e1.in2 = EDGE3; e1.out2 = EDGE4;
  }
  for (const e of inc) {
    e.in1 = e.out1 = NO_EDGE;
    const x = e.x, y = e.y;
    e.x = px + c * x - s * y;
    e.y = py + s * x + c * y;
  }
}

function boxBox(A: Body, B: Body): Manifold | null {
  const hAx = A.hx, hAy = A.hy, hBx = B.hx, hBy = B.hy;
  const cA = A.c, sA = A.s, cB = B.c, sB = B.s;
  const dpx = B.x - A.x, dpy = B.y - A.y;
  const dAx = cA * dpx + sA * dpy, dAy = -sA * dpx + cA * dpy;
  const dBx = cB * dpx + sB * dpy, dBy = -sB * dpx + cB * dpy;
  // C = RotA^T * RotB
  const c11 = cA * cB + sA * sB, c21 = -sA * cB + cA * sB;
  const c12 = -cA * sB + sA * cB, c22 = sA * sB + cA * cB;
  const a11 = Math.abs(c11), a21 = Math.abs(c21), a12 = Math.abs(c12), a22 = Math.abs(c22);
  const faceAx = Math.abs(dAx) - hAx - (a11 * hBx + a12 * hBy);
  const faceAy = Math.abs(dAy) - hAy - (a21 * hBx + a22 * hBy);
  if (faceAx > MARGIN || faceAy > MARGIN) return null;
  const faceBx = Math.abs(dBx) - (a11 * hAx + a21 * hAy) - hBx;
  const faceBy = Math.abs(dBy) - (a12 * hAx + a22 * hAy) - hBy;
  if (faceBx > MARGIN || faceBy > MARGIN) return null;

  const relTol = 0.95, absTol = 0.01;
  let axis = 0;
  let sep = faceAx;
  let nx = dAx > 0 ? cA : -cA, ny = dAx > 0 ? sA : -sA;
  if (faceAy > relTol * sep + absTol * hAy) {
    axis = 1;
    sep = faceAy;
    nx = dAy > 0 ? -sA : sA;
    ny = dAy > 0 ? cA : -cA;
  }
  if (faceBx > relTol * sep + absTol * hBx) {
    axis = 2;
    sep = faceBx;
    nx = dBx > 0 ? cB : -cB;
    ny = dBx > 0 ? sB : -sB;
  }
  if (faceBy > relTol * sep + absTol * hBy) {
    axis = 3;
    sep = faceBy;
    nx = dBy > 0 ? -sB : sB;
    ny = dBy > 0 ? cB : -cB;
  }

  let fnx: number, fny: number, front: number, snx: number, sny: number, negSide: number, posSide: number, negEdge: number, posEdge: number;
  if (axis === 0) {
    fnx = nx; fny = ny;
    front = A.x * fnx + A.y * fny + hAx;
    snx = -sA; sny = cA;
    const side = A.x * snx + A.y * sny;
    negSide = -side + hAy; posSide = side + hAy;
    negEdge = EDGE3; posEdge = EDGE1;
    incidentEdge(hBx, hBy, B.x, B.y, cB, sB, fnx, fny);
  } else if (axis === 1) {
    fnx = nx; fny = ny;
    front = A.x * fnx + A.y * fny + hAy;
    snx = cA; sny = sA;
    const side = A.x * snx + A.y * sny;
    negSide = -side + hAx; posSide = side + hAx;
    negEdge = EDGE2; posEdge = EDGE4;
    incidentEdge(hBx, hBy, B.x, B.y, cB, sB, fnx, fny);
  } else if (axis === 2) {
    fnx = -nx; fny = -ny;
    front = B.x * fnx + B.y * fny + hBx;
    snx = -sB; sny = cB;
    const side = B.x * snx + B.y * sny;
    negSide = -side + hBy; posSide = side + hBy;
    negEdge = EDGE3; posEdge = EDGE1;
    incidentEdge(hAx, hAy, A.x, A.y, cA, sA, fnx, fny);
  } else {
    fnx = -nx; fny = -ny;
    front = B.x * fnx + B.y * fny + hBy;
    snx = cB; sny = sB;
    const side = B.x * snx + B.y * sny;
    negSide = -side + hBx; posSide = side + hBx;
    negEdge = EDGE2; posEdge = EDGE4;
    incidentEdge(hAx, hAy, A.x, A.y, cA, sA, fnx, fny);
  }
  if (clipSegment(clip1, inc, -snx, -sny, negSide, negEdge) < 2) return null;
  if (clipSegment(clip2, clip1, snx, sny, posSide, posEdge) < 2) return null;
  const m = makeManifold(A, B, nx, ny);
  for (let i = 0; i < 2; i++) {
    const p = clip2[i];
    const s = fnx * p.x + fny * p.y - front;
    if (s > MARGIN) continue;
    // Slide onto the reference face, then take the midpoint between the surfaces.
    const px = p.x - s * fnx * 0.5, py = p.y - s * fny * 0.5;
    let in1 = p.in1, out1 = p.out1, in2 = p.in2, out2 = p.out2;
    if (axis >= 2) {
      [in1, in2] = [in2, in1];
      [out1, out2] = [out2, out1];
    }
    addPoint(m, px, py, s, in1 | (out1 << 8) | (in2 << 16) | (out2 << 24));
  }
  return m.points.length ? m : null;
}
