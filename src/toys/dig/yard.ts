// Glue between the grid and the rigid bodies. Each frame: the CA steps with bodies stamped in as
// solid cells; the structural pass cuts unsupported ground free as bodies; the solver moves them;
// moved bodies are re-stamped (pushing grains and water out of the way); hard landings break slabs
// into loose grains and smaller pieces; and a slab that comes to rest where it can hold bakes back
// into packed ground. Finds sit latent in the dirt until dug into, then become bodies too.

import { BODY, DigSim, EMPTY, FIND, LOOSE, MAT, PACKED, ROCK, WATER } from './sim';
import { MIN_ISLAND, Structure } from './islands';
import { Kind, type PBody, RigidWorld } from './rigid';

/** Speed change (cells/s) a slab of each material shrugs off; past it, it breaks up. */
const TOUGH = [0, 70, 60, 85, 35, 45, 200, 200, 0, 200];
/** Biggest body cut from the ground in one piece; bigger islands split along random seams. */
const MAX_PIECE = 1200;
/** Frames between structural passes while the ground keeps changing; longer while a finger is
 * digging, so an advancing tunnel drops its roof in chunky slabs rather than a slice per pass. */
const CHECK_EVERY = 4, CHECK_DIGGING = 18;
/** Rows of context the structural pass takes above and below what changed. */
const ABOVE = 96, BELOW = 64;

export const enum FindState {
  Buried = 0,
  Loose = 1,
  Flying = 2,
  Found = 3,
}

export interface Find {
  emoji: string;
  name: string;
  x: number;
  y: number;
  /** Body radius in cells, and the emoji's size. */
  r: number;
  size: number;
  state: FindState;
  body: PBody | null;
  /** Fraction of the ring around it that's open air or water. */
  exposure: number;
  /** Seconds it's been lying in the open. */
  open: number;
  fly: number;
  a: number;
}

export interface YardEvent {
  type: 'detach' | 'impact' | 'shatter' | 'bake' | 'reveal' | 'roll';
  x: number;
  y: number;
  mass: number;
  speed: number;
  kind: Kind;
  mat: number;
}

export class Yard {
  readonly sim: DigSim;
  readonly world: RigidWorld;
  readonly structure: Structure;
  events: YardEvent[] = [];
  stats = { detached: 0, shattered: 0, baked: 0, checks: 0, checkMs: 0, lost: 0, maxHit: 0 };
  private byId = new Map<number, PBody>();
  private frames = 0;
  private lastCheck = -99;
  private time = 0;
  /** Set by the toy while a finger is scraping. */
  digging = false;

  constructor(W: number, H: number, ground: number, readonly finds: Find[], seed?: number) {
    this.sim = new DigSim(W, H, ground, seed);
    this.world = new RigidWorld(this.sim);
    this.structure = new Structure(this.sim);
    // Boulders start asleep in their sockets; undercut one and it wakes.
    for (const list of this.sim.boulders)
      for (const b of this.fromCells(list, Kind.Boulder)) {
        b.sleeping = true;
        b.noBake = true;
      }
  }

  bodyAt(k: number) {
    return this.sim.cells[k] & BODY ? this.byId.get(this.sim.owner[k]) : undefined;
  }

  // ---------------------------------------------------------------- frame

  step(dt: number, y0: number, y1: number, time: number) {
    this.events.length = 0;
    this.frames++;
    this.time = time;
    const { sim, world } = this;
    sim.step(y0, y1);
    for (const id of sim.wake) {
      const b = this.byId.get(id);
      if (b?.sleeping) world.wake(b);
    }
    sim.wake.length = 0;
    // Sleepers re-check their footing now and then: a grain sliding out diagonally, say, doesn't wake them.
    for (const b of world.bodies) if (b.sleeping && (this.frames + b.id) % 10 === 0 && !this.footing(b)) world.wake(b);
    if (sim.dirtyHi >= sim.dirtyLo && this.frames - this.lastCheck >= (this.digging ? CHECK_DIGGING : CHECK_EVERY)) this.checkStructure();
    world.step(dt);
    const moved: PBody[] = [];
    for (const b of [...world.bodies]) {
      if (!b.alive || !b.active) continue;
      if (b.hit > this.stats.maxHit) this.stats.maxHit = b.hit;
      if (b.hit > 22 && b.age > 0.05) this.events.push(this.event('impact', b, b.hitX, b.hitY, b.hit));
      if (b.kind === Kind.Slab && b.age > 0.3 && b.hit > b.tough) {
        // Hard landing: a crater of loose grains around the hit, the rest in pieces.
        const over = b.hit / b.tough;
        this.events.push(this.event('shatter', b, b.hitX, b.hitY, b.hit));
        this.stats.shattered++;
        this.shatter(b, b.hitX, b.hitY, over > 1.8 ? 1e9 : 2 + (over - 1) * Math.sqrt(b.cells) * 0.35, false);
        continue;
      }
      if (b.kind === Kind.Boulder && b.touching && time > b.nextKnock) {
        const roll = Math.abs(b.w) * b.rad;
        if (roll > 10) {
          b.nextKnock = time + Math.max(0.09, 0.5 - roll / 200) * (0.7 + Math.random() * 0.6);
          this.events.push(this.event('roll', b, b.x, b.y + b.rad * 0.8, roll));
        }
      }
      moved.push(b);
    }
    for (const b of moved) this.unstamp(b);
    for (const b of moved) this.stamp(b);
    for (const b of world.slept) if (b.alive && b.kind === Kind.Slab && !b.noBake) this.bake(b);
    world.compact();
    this.stepFinds(dt);
  }

  private event(type: YardEvent['type'], b: PBody, x: number, y: number, speed: number): YardEvent {
    return { type, x, y, mass: b.mass, speed, kind: b.kind, mat: b.mat };
  }

  /** The structural pass over the rows that changed since the last one. */
  checkStructure() {
    const { sim } = this;
    const t0 = performance.now();
    const lo = sim.dirtyLo - ABOVE, hi = sim.dirtyHi + BELOW + 1;
    sim.dirtyLo = Infinity;
    sim.dirtyHi = -Infinity;
    this.lastCheck = this.frames;
    const islands = this.structure.islands(lo, hi);
    for (const cells of islands)
      for (const b of this.fromCells(cells, Kind.Slab)) {
        this.stats.detached++;
        this.events.push(this.event('detach', b, b.x, b.y, 0));
      }
    this.stats.checks++;
    this.stats.checkMs = performance.now() - t0;
  }

  // ---------------------------------------------------------------- bodies

  /** Lift grid cells out as bodies (angle 0, in place). Big ones split into several. */
  fromCells(list: number[], kind: Kind): PBody[] {
    const { W, cells, shade } = this.sim;
    let x0 = W, y0 = Infinity, x1 = -1, y1 = -1;
    for (const k of list) {
      const x = k % W, y = (k / W) | 0;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    const mw = x1 - x0 + 1, mh = y1 - y0 + 1;
    const mask = new Uint8Array(mw * mh), sh = new Uint8Array(mw * mh);
    const idx: number[] = [];
    for (const k of list) {
      const i = (k % W) - x0 + (((k / W) | 0) - y0) * mw;
      mask[i] = cells[k] & MAT;
      sh[i] = shade[k];
      cells[k] = EMPTY;
      idx.push(i);
    }
    let label: Int32Array | null = null;
    if (idx.length > MAX_PIECE) {
      // Break along the seams of a random Voronoi diagram, so a big block comes down as a few chunks.
      const seeds = Math.ceil(idx.length / (MAX_PIECE * 0.6));
      const sx: number[] = [], sy: number[] = [];
      for (let s = 0; s < seeds; s++) {
        const i = idx[Math.floor(Math.random() * idx.length)];
        sx.push(i % mw);
        sy.push((i / mw) | 0);
      }
      label = new Int32Array(mw * mh);
      for (const i of idx) {
        const x = i % mw, y = (i / mw) | 0;
        let best = 0, bd = Infinity;
        for (let s = 0; s < seeds; s++) {
          const d = (x - sx[s]) ** 2 + (y - sy[s]) ** 2;
          if (d < bd) {
            bd = d;
            best = s;
          }
        }
        label[i] = best;
      }
    }
    const out: PBody[] = [];
    for (const comp of components(mask, mw, mh, idx, label)) {
      if (comp.length < MIN_ISLAND) {
        for (const i of comp) cells[(y0 + ((i / mw) | 0)) * W + x0 + (i % mw)] = mask[i] | LOOSE;
        continue;
      }
      const b = this.piece(kind, mask, sh, mw, x0, y0, 0, 1, 0, comp, null);
      if (b) out.push(b);
    }
    return out;
  }

  /** A body from some cells of a source mask whose origin is at (ox, oy) turned by (c, s). */
  private piece(kind: Kind, mask: Uint8Array, shade: Uint8Array, mw: number, ox: number, oy: number, a: number, c: number, s: number, comp: number[], parent: PBody | null) {
    let i0 = Infinity, j0 = Infinity, i1 = -1, j1 = -1;
    for (const i of comp) {
      const x = i % mw, y = (i / mw) | 0;
      if (x < i0) i0 = x;
      if (x > i1) i1 = x;
      if (y < j0) j0 = y;
      if (y > j1) j1 = y;
    }
    const w = i1 - i0 + 1, h = j1 - j0 + 1;
    const m = new Uint8Array(w * h), sh = new Uint8Array(w * h);
    const counts = new Array(10).fill(0);
    for (const i of comp) {
      const j = (i % mw) - i0 + (((i / mw) | 0) - j0) * w;
      m[j] = mask[i];
      sh[j] = shade[i];
      counts[mask[i]]++;
    }
    // Mostly rock cut from the ground behaves like a boulder: it rolls and never bakes back.
    if (kind === Kind.Slab && counts[ROCK] > comp.length * 0.6) kind = Kind.Boulder;
    const b = this.world.create(kind, w, h, m, sh, ox + c * i0 - s * j0, oy + s * i0 + c * j0, a);
    if (!b) return null;
    let tough = 0, mat = 0;
    for (let v = 1; v < 10; v++) {
      tough += counts[v] * TOUGH[v];
      if (counts[v] > counts[mat]) mat = v;
    }
    b.mat = mat;
    b.tough = kind === Kind.Slab ? tough / comp.length : Infinity;
    b.noBake = kind !== Kind.Slab;
    if (parent) {
      const rx = b.x - parent.x, ry = b.y - parent.y;
      b.vx = parent.vx - parent.w * ry;
      b.vy = parent.vy + parent.w * rx;
      b.w = parent.w;
    }
    this.byId.set(b.id & 0xffff, b);
    this.stamp(b);
    // Whatever a fresh slab was hanging on or leaning against has to react to it.
    if (!parent) this.world.wakeNear(b.x, b.y, b.rad + 1);
    return b;
  }

  /** Write a body's cells into the grid as BODY stamps, pushing grains and water out of the way. */
  stamp(b: PBody) {
    const { cells, owner, W, H } = this.sim;
    const oid = b.id & 0xffff;
    const x0 = Math.max(0, Math.floor(b.x - b.rad)), x1 = Math.min(W - 1, Math.ceil(b.x + b.rad));
    const y0 = Math.max(0, Math.floor(b.y - b.rad)), y1 = Math.min(H - 1, Math.ceil(b.y + b.rad));
    const { c, s, cx, cy, mw, mh, mask } = b;
    b.stamp.length = 0;
    for (let j = y0; j <= y1; j++)
      for (let i = x0; i <= x1; i++) {
        const dx = i + 0.5 - b.x, dy = j + 0.5 - b.y;
        const mi = Math.floor(c * dx + s * dy + cx), mj = Math.floor(-s * dx + c * dy + cy);
        if (mi < 0 || mj < 0 || mi >= mw || mj >= mh) continue;
        const v = mask[mj * mw + mi];
        if (!v) continue;
        const k = j * W + i;
        const cur = cells[k];
        if (cur) {
          if (PACKED[cur] || cur & BODY) continue;
          this.displace(k);
        }
        cells[k] = BODY | v;
        owner[k] = oid;
        b.stamp.push(k);
      }
  }

  /** Is anything under (or diagonally under) a body's cells, other than itself and water? */
  private footing(b: PBody) {
    const { cells, owner, W, H } = this.sim;
    const oid = b.id & 0xffff;
    for (const k of b.stamp) {
      if (k + W >= W * H) return true;
      for (const n of [k + W, k + W - 1, k + W + 1]) {
        const c = cells[n];
        if (c && c !== WATER && !(c & BODY && owner[n] === oid)) return true;
      }
    }
    return false;
  }

  unstamp(b: PBody) {
    const { cells, owner } = this.sim;
    const oid = b.id & 0xffff;
    for (const k of b.stamp) {
      if (!(cells[k] & BODY) || owner[k] !== oid) continue;
      cells[k] = EMPTY;
      this.sim.vacated(k);
    }
    b.stamp.length = 0;
  }

  /** Move a grain or water cell up out of a body's way (or sideways); lose it if boxed in. */
  private displace(k: number) {
    const { cells, W } = this.sim;
    const v = cells[k];
    cells[k] = EMPTY;
    for (let up = k - W, n = 0; up >= 0 && n < 8; up -= W, n++) {
      const c = cells[up];
      if (!c) {
        cells[up] = v;
        return;
      }
      if (PACKED[c] || c & BODY) break;
    }
    const x = k % W;
    for (let d = 1; d <= 3; d++)
      for (const s of [-d, d]) {
        if (x + s < 0 || x + s >= W) continue;
        if (!cells[k + s]) {
          cells[k + s] = v;
          return;
        }
      }
    this.stats.lost++;
  }

  private removeBody(b: PBody) {
    this.unstamp(b);
    this.world.remove(b);
    this.byId.delete(b.id & 0xffff);
  }

  /** Drop a loose grain at a world point (or the nearest free cell above it). */
  private dropGrain(wx: number, wy: number, v: number) {
    const { cells, W, H } = this.sim;
    const x = Math.floor(wx);
    let y = Math.floor(wy);
    if (x < 0 || x >= W || y >= H) return;
    for (let n = 0; n < 8 && y >= 0; n++, y--) {
      const k = y * W + x;
      if (!cells[k]) {
        cells[k] = v | LOOSE;
        return;
      }
    }
  }

  /**
   * Break a body: cells within `radius` of (px, py) run loose (or vanish if `scoop`), and what's left
   * splits into its connected pieces, each keeping the parent's motion. Crumbs become grains.
   */
  shatter(b: PBody, px: number, py: number, radius: number, scoop: boolean) {
    this.removeBody(b);
    const { mw, mh, mask, c, s } = b;
    const ox = b.x - (c * b.cx - s * b.cy), oy = b.y - (s * b.cx + c * b.cy);
    const at = (i: number): [number, number] => {
      const u = (i % mw) + 0.5, v = ((i / mw) | 0) + 0.5;
      return [ox + c * u - s * v, oy + s * u + c * v];
    };
    const keep: number[] = [];
    const r2 = radius * radius;
    for (let i = 0; i < mw * mh; i++) {
      if (!mask[i]) continue;
      const [wx, wy] = at(i);
      if ((wx - px) ** 2 + (wy - py) ** 2 < r2) {
        if (!scoop) this.dropGrain(wx, wy, mask[i]);
      } else keep.push(i);
    }
    for (const comp of components(mask, mw, mh, keep, null)) {
      if (comp.length < MIN_ISLAND) {
        for (const i of comp) {
          const [wx, wy] = at(i);
          this.dropGrain(wx, wy, mask[i]);
        }
        continue;
      }
      const nb = this.piece(b.kind, mask, b.shade, mw, ox, oy, b.a, c, s, comp, b);
      if (nb) nb.age = scoop ? b.age : 0;
    }
  }

  /**
   * A slab at rest becomes ground again, if the ground can hold it there; otherwise it stays a
   * sleeping body (so it can't bounce between the two).
   */
  private bake(b: PBody) {
    const { cells, W } = this.sim;
    const list = b.stamp;
    if (!list.length) {
      this.removeBody(b);
      return;
    }
    let lo = Infinity, hi = -Infinity;
    for (const k of list) {
      cells[k] &= MAT;
      const y = (k / W) | 0;
      if (y < lo) lo = y;
      if (y > hi) hi = y;
    }
    this.structure.solve(lo - ABOVE, hi + BELOW + 1);
    if (!list.every((k) => this.structure.held(k))) {
      for (const k of list) cells[k] |= BODY;
      b.noBake = true;
      return;
    }
    // Seal the hairline gaps rasterising leaves along its edges.
    const { H } = this.sim;
    for (const k of list) {
      for (const n of [k - 1, k + 1, k - W, k + W]) {
        if (n < W || n >= (H - 1) * W || cells[n]) continue;
        let around = 0;
        if (PACKED[cells[n - 1]]) around++;
        if (PACKED[cells[n + 1]]) around++;
        if (PACKED[cells[n - W]]) around++;
        if (PACKED[cells[n + W]]) around++;
        if (around >= 3) {
          cells[n] = cells[k];
          this.sim.shade[n] = this.sim.shade[k];
        }
      }
    }
    b.stamp = [];
    this.world.remove(b);
    this.byId.delete(b.id & 0xffff);
    this.stats.baked++;
    this.events.push(this.event('bake', b, b.x, b.y, 0));
  }

  /** Finger scraping over bodies: slabs get scooped, boulders and finds get shoved. */
  dig(x: number, y: number, r: number, out: number[], dx: number, dy: number) {
    const hit = new Set<number>();
    const n = this.sim.dig(x, y, r, out, hit);
    for (const id of hit) {
      const b = this.byId.get(id);
      if (!b || !b.alive) continue;
      if (b.kind === Kind.Slab) {
        out[b.mat] += 4;
        this.shatter(b, x, y, r, true);
        continue;
      }
      this.world.wake(b);
      // Shove along the stroke, at the finger, up to a walking pace.
      const len = Math.hypot(dx, dy);
      if (len < 1e-3) continue;
      const push = Math.min(40, len * 25);
      const along = (b.vx * dx + b.vy * dy) / len;
      if (along > push) continue;
      const J = (push - Math.max(0, along)) * b.mass * 0.25;
      const jx = (dx / len) * J, jy = (dy / len) * J;
      b.vx += jx * b.invMass;
      b.vy += jy * b.invMass;
      b.w += b.invI * ((x - b.x) * jy - (y - b.y) * jx);
      if (b.kind === Kind.Boulder) out[ROCK] += 2;
    }
    if (n) this.world.wakeNear(x, y, r + 2);
    return n;
  }

  // ---------------------------------------------------------------- finds

  private stepFinds(dt: number) {
    const { sim } = this;
    for (let i = 0; i < this.finds.length; i++) {
      const f = this.finds[i];
      if (f.state === FindState.Buried) {
        if ((this.frames + i) % 6 === 0 && this.discOpen(f) > 0 && !this.discBusy(f)) this.reveal(f, i);
        continue;
      }
      if (f.state !== FindState.Loose || !f.body) continue;
      const b = f.body;
      if (!b.alive) {
        f.body = null;
        f.state = FindState.Buried;
        continue;
      }
      f.x = b.x;
      f.y = b.y;
      f.a = b.a;
      if ((this.frames + i) % 3 === 0) f.exposure = this.exposure(b.x, b.y, f.r + 1.4);
      // In the open and settled: ready to collect. Buried again by a cave-in: not yet.
      const still = b.sleeping || Math.hypot(b.vx, b.vy) < 3;
      f.open = f.exposure > 0.3 && still ? f.open + dt : f.exposure > 0.3 ? f.open : 0;
      if (b.y < sim.ground) f.open = Math.max(f.open, 10);
    }
  }

  /** Cells of a buried find's disc that are air, water or rubble. */
  private discOpen(f: Find) {
    const { cells, W, H } = this.sim;
    let open = 0;
    const r = f.r;
    for (let y = Math.max(0, Math.floor(f.y - r)); y <= Math.min(H - 1, f.y + r); y++)
      for (let x = Math.max(0, Math.floor(f.x - r)); x <= Math.min(W - 1, f.x + r); x++) {
        if ((x + 0.5 - f.x) ** 2 + (y + 0.5 - f.y) ** 2 > r * r) continue;
        const c = cells[y * W + x];
        if (!c || c === WATER || c & LOOSE) open++;
      }
    return open;
  }

  /** A body is passing through the find's spot: wait, rather than spawn it overlapping. */
  private discBusy(f: Find) {
    const { cells, W, H } = this.sim;
    const r = f.r + 0.5;
    for (let y = Math.max(0, Math.floor(f.y - r)); y <= Math.min(H - 1, f.y + r); y++)
      for (let x = Math.max(0, Math.floor(f.x - r)); x <= Math.min(W - 1, f.x + r); x++)
        if ((x + 0.5 - f.x) ** 2 + (y + 0.5 - f.y) ** 2 <= r * r && cells[y * W + x] & BODY) return true;
    return false;
  }

  /** Dug into: the find becomes a body in its own socket, and drops if there's room below. */
  private reveal(f: Find, index: number) {
    const { cells, W, H } = this.sim;
    const R = Math.ceil(f.r);
    const mw = 2 * R + 1;
    const mask = new Uint8Array(mw * mw), sh = new Uint8Array(mw * mw);
    const ox = Math.floor(f.x) - R, oy = Math.floor(f.y) - R;
    const idx: number[] = [];
    for (let j = 0; j < mw; j++)
      for (let i = 0; i < mw; i++) {
        if ((i + 0.5 - (f.x - ox)) ** 2 + (j + 0.5 - (f.y - oy)) ** 2 > f.r * f.r) continue;
        mask[j * mw + i] = FIND;
        idx.push(j * mw + i);
        const x = ox + i, y = oy + j;
        if (x < 0 || x >= W || y < 0 || y >= H) continue;
        const k = y * W + x;
        if (cells[k] && !(cells[k] & BODY)) cells[k] = EMPTY;
      }
    // The dirt hugging it crumbles, so it can come loose instead of sitting in a perfect socket.
    const rr = f.r + 1.6;
    for (let y = Math.max(0, Math.floor(f.y - rr)); y <= Math.min(H - 1, f.y + rr); y++)
      for (let x = Math.max(0, Math.floor(f.x - rr)); x <= Math.min(W - 1, f.x + rr); x++) {
        const k = y * W + x;
        if (!PACKED[cells[k]] || cells[k] === ROCK || (x + 0.5 - f.x) ** 2 + (y + 0.5 - f.y) ** 2 > rr * rr) continue;
        cells[k] |= LOOSE;
        this.sim.markDirty(y);
      }
    const b = this.piece(Kind.Find, mask, sh, mw, ox, oy, 0, 1, 0, idx, null);
    if (!b) return;
    b.find = index;
    f.body = b;
    f.state = FindState.Loose;
    f.exposure = this.exposure(b.x, b.y, f.r + 1.4);
    this.events.push(this.event('reveal', b, b.x, b.y, 0));
  }

  /** Fraction of a ring that's open air or water. */
  exposure(x: number, y: number, r: number) {
    const { cells, W, H } = this.sim;
    let open = 0;
    const N = 20;
    for (let i = 0; i < N; i++) {
      const t = (i / N) * Math.PI * 2;
      const px = Math.floor(x + Math.cos(t) * r), py = Math.floor(y + Math.sin(t) * r);
      if (py < 0) {
        open++;
        continue;
      }
      if (px < 0 || px >= W || py >= H) continue;
      const c = cells[py * W + px];
      if (!c || c === WATER) open++;
    }
    return open / N;
  }

  /** Take a find off the board (it flies to the shelf). */
  collect(f: Find) {
    if (!f.body) return;
    f.x = f.body.x;
    f.y = f.body.y;
    f.a = f.body.a;
    this.removeBody(f.body);
    f.body = null;
    f.state = FindState.Flying;
    f.fly = 0;
  }

  // ---------------------------------------------------------------- dev

  /** Carve a rectangle of ground away (tests). */
  carve(x0: number, y0: number, x1: number, y1: number) {
    const { W, H, cells } = this.sim;
    for (let y = Math.max(0, y0); y < Math.min(H, y1); y++)
      for (let x = Math.max(0, x0); x < Math.min(W, x1); x++) {
        const k = y * W + x;
        if (!cells[k] || cells[k] & BODY) continue;
        cells[k] = EMPTY;
        this.sim.markDirty(y);
        this.sim.vacated(k);
      }
    this.world.wakeNear((x0 + x1) / 2, (y0 + y1) / 2, Math.hypot(x1 - x0, y1 - y0) / 2 + 2);
  }
}

/** 4-connected components among the given mask cells (optionally only within the same label). */
function components(mask: Uint8Array, mw: number, mh: number, idx: number[], label: Int32Array | null): number[][] {
  const inSet = new Uint8Array(mw * mh);
  for (const i of idx) if (mask[i]) inSet[i] = 1;
  const out: number[][] = [];
  const stack: number[] = [];
  for (const i0 of idx) {
    if (!inSet[i0]) continue;
    inSet[i0] = 0;
    stack.push(i0);
    const comp: number[] = [];
    const lab = label ? label[i0] : 0;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % mw;
      const nb = [x > 0 ? i - 1 : -1, x < mw - 1 ? i + 1 : -1, i - mw, i + mw];
      for (const j of nb) {
        if (j < 0 || j >= mw * mh || !inSet[j] || (label && label[j] !== lab)) continue;
        inSet[j] = 0;
        stack.push(j);
      }
    }
    out.push(comp);
  }
  return out;
}
