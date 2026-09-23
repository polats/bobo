// A knitted swatch as a stitch grid over XPBD cloth, plus one free yarn strand (an XPBD chain).
// Pulling the strand taut pops the "front" stitch: its cloth cell is removed and its yarn length is
// appended to the strand. Stitches unravel in knit-row order, back and forth, from the bind-off edge up.

export type Size = 'small' | 'medium';

export class Knit {
  readonly cols: number;
  readonly rows: number;
  readonly np: number;
  /** Stitch width and height in world units. */
  readonly sw: number;
  readonly sh: number;
  readonly topY = 0.85;
  readonly floorY = -1.15;
  readonly width: number;

  // Cloth particles: (rows + 1) x (cols + 1) stitch corners.
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  readonly vel: Float32Array;
  readonly pinned: Uint8Array;
  readonly partAlive: Uint8Array;
  readonly uv: Float32Array;

  // Cloth constraints.
  readonly ca: Int32Array;
  readonly cb: Int32Array;
  readonly rest: Float32Array;
  readonly comp: Float32Array;
  readonly s0: Int32Array;
  readonly s1: Int32Array;
  readonly via0: Int32Array;
  readonly via1: Int32Array;
  readonly cAlive: Uint8Array;
  readonly nc: number;

  readonly stitchAlive: Uint8Array;
  stitchesLeft: number;
  topology = 0;

  // Unravel cursor: next stitch to pop and travel direction along its row.
  cr: number;
  cc: number;
  cdir: number;
  done = false;
  anchor: number;

  // Free yarn strand. Index 0 is the loose end; the last particle is tied to the anchor.
  readonly cap: number;
  rn = 0;
  readonly rpos: Float32Array;
  readonly rprev: Float32Array;
  readonly rvel: Float32Array;
  readonly rfrozen: Uint8Array;
  readonly rcalm: Float32Array;
  /** Knit row each yarn particle came from, so unravelled yarn keeps its stripe colour. */
  readonly rrow: Uint16Array;
  /** Per-particle crimp variation so the kinks don't repeat regularly. */
  readonly rkink: Float32Array;
  readonly seg: number;
  readonly segsPerStitch = 3;
  readonly yarnR: number;

  grabbedCloth = -1;
  grabbedRod = -1;
  /** Finger target for the grabbed yarn particle. */
  grabTarget: [number, number, number] = [0, 0, 0];
  /** Finger target for the grabbed knit corner (a second hand can hold the knit while the first pulls). */
  clothTarget: [number, number, number] = [0, 0, 0];
  /** Set when a yarn particle rests on something (floor, pile, knit) this frame; only supported yarn may sleep. */
  readonly rsupported: Uint8Array;
  /** Where each yarn particle was when it last started keeping still; jitter around it still counts as rest. */
  private readonly rref: Float32Array;
  // Spatial hash for yarn self-collision and yarn-knit contact (counting sort, as in Ten Minute Physics #11).
  private readonly hashSize = 4096;
  private readonly cellStart: Int32Array;
  private readonly cellEntries: Int32Array;
  private readonly yarnMin: number;
  private readonly clothMin: number;
  private readonly cell: number;

  // Per-frame events for the renderer / juice.
  popsThisFrame = 0;
  rowsThisFrame = 0;
  popEvents: [number, number, number, number][] = []; // x, y, z, row
  tension = 0;

  cfg = {
    substeps: 10,
    gravity: 12,
    threshold: 0.015,
    crimp: 0.6,
    damping: 1.4,
  };

  constructor(size: Size) {
    const cols = (this.cols = size === 'small' ? 14 : 20);
    const rows = (this.rows = size === 'small' ? 18 : 26);
    const W = (this.width = size === 'small' ? 1.0 : 1.15);
    const sw = (this.sw = W / cols);
    const sh = (this.sh = sw * 0.8);
    const pc = cols + 1;
    const np = (this.np = (rows + 1) * pc);
    this.pos = new Float32Array(np * 3);
    this.prev = new Float32Array(np * 3);
    this.vel = new Float32Array(np * 3);
    this.pinned = new Uint8Array(np);
    this.partAlive = new Uint8Array(np).fill(1);
    this.uv = new Float32Array(np * 2);
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c <= cols; c++) {
        const i = r * pc + c;
        this.pos.set([-W / 2 + c * sw, this.topY - r * sh, 0.002 * Math.sin(c * 1.3 + r * 0.7)], i * 3);
        this.uv.set([c, r], i * 2);
        if (r === 0) this.pinned[i] = 1;
      }
    this.prev.set(this.pos);

    // Constraints with the stitches they belong to; a constraint lives while any owner stitch lives.
    const A: number[] = [], B: number[] = [], C: number[] = [], S0: number[] = [], S1: number[] = [], V0: number[] = [], V1: number[] = [];
    const sid = (r: number, c: number) => (r >= 0 && r < rows && c >= 0 && c < cols ? r * cols + c : -1);
    const pid = (r: number, c: number) => r * pc + c;
    const add = (a: number, b: number, comp: number, s0: number, s1: number, v0 = -1, v1 = -1) => {
      A.push(a); B.push(b); C.push(comp); S0.push(s0); S1.push(s1); V0.push(v0); V1.push(v1);
      return A.length - 1;
    };
    // Knit is stretchy along the course (rows), firmer along the wale (columns), barely resists shear.
    const COURSE = 2e-6, WALE = 4e-7, SHEAR = 1.5e-5, BEND = 1e-3;
    const hEdge: number[][] = [];
    const vEdge: number[][] = [];
    for (let r = 0; r <= rows; r++) {
      hEdge[r] = [];
      for (let c = 0; c < cols; c++) hEdge[r][c] = add(pid(r, c), pid(r, c + 1), COURSE, sid(r, c), sid(r - 1, c));
    }
    for (let r = 0; r < rows; r++) {
      vEdge[r] = [];
      for (let c = 0; c <= cols; c++) vEdge[r][c] = add(pid(r, c), pid(r + 1, c), WALE, sid(r, c - 1), sid(r, c));
    }
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        add(pid(r, c), pid(r + 1, c + 1), SHEAR, sid(r, c), -1);
        add(pid(r, c + 1), pid(r + 1, c), SHEAR, sid(r, c), -1);
      }
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c + 2 <= cols; c++) add(pid(r, c), pid(r, c + 2), BEND, -1, -1, hEdge[r][c], hEdge[r][c + 1]);
    for (let r = 0; r + 2 <= rows; r++)
      for (let c = 0; c <= cols; c++) add(pid(r, c), pid(r + 2, c), BEND, -1, -1, vEdge[r][c], vEdge[r + 1][c]);
    this.nc = A.length;
    this.ca = Int32Array.from(A);
    this.cb = Int32Array.from(B);
    this.comp = Float32Array.from(C);
    this.s0 = Int32Array.from(S0);
    this.s1 = Int32Array.from(S1);
    this.via0 = Int32Array.from(V0);
    this.via1 = Int32Array.from(V1);
    this.cAlive = new Uint8Array(this.nc).fill(1);
    this.rest = new Float32Array(this.nc);
    for (let k = 0; k < this.nc; k++) {
      const a = this.ca[k] * 3, b = this.cb[k] * 3;
      this.rest[k] = Math.hypot(this.pos[a] - this.pos[b], this.pos[a + 1] - this.pos[b + 1], this.pos[a + 2] - this.pos[b + 2]);
    }
    this.stitchAlive = new Uint8Array(rows * cols).fill(1);
    this.stitchesLeft = rows * cols;

    // Unravel from the bottom-right corner, where the bind-off tail hangs.
    this.cr = rows - 1;
    this.cc = cols - 1;
    this.cdir = -1;
    this.anchor = this.anchorFor(this.cr, this.cc, this.cdir);

    // Yarn per stitch in stitch-widths. Real loops hold ~3; less makes each pop cost less finger travel.
    this.seg = (sw * 2.2) / this.segsPerStitch;
    this.yarnR = sw * 0.17;
    this.cap = rows * cols * this.segsPerStitch + 64;
    this.rpos = new Float32Array(this.cap * 3);
    this.rprev = new Float32Array(this.cap * 3);
    this.rvel = new Float32Array(this.cap * 3);
    this.rfrozen = new Uint8Array(this.cap);
    this.rcalm = new Float32Array(this.cap);
    this.rrow = new Uint16Array(this.cap);
    this.rkink = new Float32Array(this.cap);
    this.rsupported = new Uint8Array(this.cap);
    this.rref = new Float32Array(this.cap * 3);
    // Collision sizes: yarn keeps a loose, fluffy spacing in the pile; knit corners act as small spheres.
    this.yarnMin = this.seg * 0.72;
    this.clothMin = sw * 0.5 + this.yarnR;
    this.cell = Math.max(this.yarnMin, this.clothMin);
    this.cellStart = new Int32Array(this.hashSize + 1);
    this.cellEntries = new Int32Array(this.cap + np);
    // Tail: dangles from the anchor with a lazy curl, loose end at index 0.
    const a = this.anchor * 3;
    // A short tail: the first tug has little slack to take up before the first stitch pops.
    const tail = 9;
    for (let j = tail; j >= 1; j--) {
      const t = j / tail;
      this.pushRod(this.pos[a] + 0.04 * Math.sin(t * 5), this.pos[a + 1] - j * this.seg * 0.92, this.pos[a + 2] + 0.05 * Math.sin(t * 7) + 0.03, rows - 1);
    }
  }

  pid(r: number, c: number) {
    return r * (this.cols + 1) + c;
  }

  private anchorFor(r: number, c: number, dir: number) {
    return dir < 0 ? this.pid(r + 1, c + 1) : this.pid(r + 1, c);
  }

  private pushRod(x: number, y: number, z: number, row: number) {
    if (this.rn >= this.cap) return;
    const i = this.rn++;
    this.rpos.set([x, y, z], i * 3);
    this.rprev.set([x, y, z], i * 3);
    this.rvel.fill(0, i * 3, i * 3 + 3);
    this.rfrozen[i] = 0;
    this.rcalm[i] = 0;
    this.rrow[i] = row;
    this.rkink[i] = 0.55 + Math.random() * 0.45;
  }

  unfreezeAll() {
    this.rfrozen.fill(0);
    this.rcalm.fill(0);
  }

  step(dt: number) {
    const sub = this.cfg.substeps;
    const h = dt / sub;
    this.popsThisFrame = 0;
    this.rowsThisFrame = 0;
    this.popEvents.length = 0;
    this.rsupported.fill(0, 0, this.rn);
    for (let s = 0; s < sub; s++) {
      this.integrate(h);
      this.solveCloth(h);
      this.solveRod(h);
      if (s % 3 === 2) this.collideYarn();
      this.collide();
      this.updateVelocities(h);
    }
    this.sleep(dt);
    this.checkTension();
  }

  private integrate(h: number) {
    const { pos, prev, vel, pinned, partAlive, rpos, rprev, rvel, rfrozen } = this;
    const g = this.cfg.gravity;
    const damp = Math.exp(-this.cfg.damping * h);
    for (let i = 0; i < this.np; i++) {
      const o = i * 3;
      prev[o] = pos[o]; prev[o + 1] = pos[o + 1]; prev[o + 2] = pos[o + 2];
      if (pinned[i] || !partAlive[i]) continue;
      vel[o] *= damp;
      vel[o + 1] = (vel[o + 1] - g * h) * damp;
      vel[o + 2] *= damp;
      pos[o] += vel[o] * h; pos[o + 1] += vel[o + 1] * h; pos[o + 2] += vel[o + 2] * h;
    }
    for (let i = 0; i < this.rn; i++) {
      const o = i * 3;
      rprev[o] = rpos[o]; rprev[o + 1] = rpos[o + 1]; rprev[o + 2] = rpos[o + 2];
      if (rfrozen[i]) continue;
      rvel[o] *= damp;
      rvel[o + 1] = (rvel[o + 1] - g * h) * damp;
      rvel[o + 2] *= damp;
      rpos[o] += rvel[o] * h; rpos[o + 1] += rvel[o + 1] * h; rpos[o + 2] += rvel[o + 2] * h;
    }
    // Grabs are kinematic: ease toward the finger.
    if (this.grabbedRod >= 0) {
      const t = this.grabTarget;
      const o = this.grabbedRod * 3;
      rpos[o] += (t[0] - rpos[o]) * 0.5; rpos[o + 1] += (t[1] - rpos[o + 1]) * 0.5; rpos[o + 2] += (t[2] - rpos[o + 2]) * 0.5;
    }
    if (this.grabbedCloth >= 0) {
      const t = this.clothTarget;
      const o = this.grabbedCloth * 3;
      pos[o] += (t[0] - pos[o]) * 0.5; pos[o + 1] += (t[1] - pos[o + 1]) * 0.5; pos[o + 2] += (t[2] - pos[o + 2]) * 0.5;
    }
  }

  private wCloth(i: number) {
    return this.pinned[i] || i === this.grabbedCloth || !this.partAlive[i] ? 0 : 1;
  }

  private solveCloth(h: number) {
    const { pos, ca, cb, rest, comp, cAlive } = this;
    const ih2 = 1 / (h * h);
    for (let k = 0; k < this.nc; k++) {
      if (!cAlive[k]) continue;
      const i = ca[k], j = cb[k];
      const wi = this.wCloth(i), wj = this.wCloth(j);
      const w = wi + wj;
      if (w === 0) continue;
      const oi = i * 3, oj = j * 3;
      const dx = pos[oi] - pos[oj], dy = pos[oi + 1] - pos[oj + 1], dz = pos[oi + 2] - pos[oj + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      if (len < 1e-9) continue;
      const lambda = -(len - rest[k]) / (w + comp[k] * ih2);
      const sx = (dx / len) * lambda, sy = (dy / len) * lambda, sz = (dz / len) * lambda;
      pos[oi] += sx * wi; pos[oi + 1] += sy * wi; pos[oi + 2] += sz * wi;
      pos[oj] -= sx * wj; pos[oj + 1] -= sy * wj; pos[oj + 2] -= sz * wj;
    }
  }

  private wRod(i: number) {
    // Yarn particles are lighter than a cloth corner (which carries a whole stitch of yarn).
    return this.rfrozen[i] || i === this.grabbedRod ? 0 : 2;
  }

  private distance(p: Float32Array, i: number, q: Float32Array, j: number, rest: number, wi: number, wj: number, alpha: number) {
    const w = wi + wj;
    if (w === 0) return 0;
    const oi = i * 3, oj = j * 3;
    const dx = p[oi] - q[oj], dy = p[oi + 1] - q[oj + 1], dz = p[oi + 2] - q[oj + 2];
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < 1e-9) return 0;
    const lambda = -(len - rest) / (w + alpha);
    const sx = (dx / len) * lambda, sy = (dy / len) * lambda, sz = (dz / len) * lambda;
    p[oi] += sx * wi; p[oi + 1] += sy * wi; p[oi + 2] += sz * wi;
    q[oj] -= sx * wj; q[oj + 1] -= sy * wj; q[oj + 2] -= sz * wj;
    return len - rest;
  }

  private solveRod(h: number) {
    const { rpos, seg, rkink, rn } = this;
    const crimpAlpha = 4e-6 / (h * h);
    const crimp = this.cfg.crimp;
    for (let i = 0; i + 1 < rn; i++) this.distance(rpos, i, rpos, i + 1, seg, this.wRod(i), this.wRod(i + 1), 0);
    // Skip-one springs shorter than two segments want the yarn to zig-zag: its remembered crimp.
    if (crimp > 0)
      for (let i = 0; i + 2 < rn; i++) {
        const wi = this.wRod(i), wk = this.wRod(i + 2);
        if (wi + wk === 0) continue;
        this.distance(rpos, i, rpos, i + 2, seg * (2 - crimp * 0.85 * rkink[i]), wi, wk, crimpAlpha);
      }
    // Tie the strand into the knit at the anchor; pulling it tugs the fabric.
    if (rn > 0) this.distance(rpos, rn - 1, this.pos, this.anchor, seg * 0.4, this.wRod(rn - 1), this.wCloth(this.anchor) * 0.5, 0);
  }

  private collide() {
    const floor = this.floorY;
    const r = this.yarnR;
    const { rpos, rprev, rn, pos, prev, np } = this;
    for (let i = 0; i < rn; i++) {
      const o = i * 3;
      if (rpos[o + 1] < floor + r + 1e-4) this.rsupported[i] = 1;
      if (rpos[o + 1] < floor + r) {
        rpos[o + 1] = floor + r;
        // Wool on wood: lots of friction.
        rpos[o] = rprev[o] + (rpos[o] - rprev[o]) * 0.15;
        rpos[o + 2] = rprev[o + 2] + (rpos[o + 2] - rprev[o + 2]) * 0.15;
      }
      // Keep yarn from sinking behind the table's back edge.
      if (rpos[o + 2] < -0.9) rpos[o + 2] = -0.9;
    }
    for (let i = 0; i < np; i++) {
      const o = i * 3;
      if (pos[o + 1] < floor + 0.01) {
        pos[o + 1] = floor + 0.01;
        pos[o] = prev[o] + (pos[o] - prev[o]) * 0.2;
        pos[o + 2] = prev[o + 2] + (pos[o + 2] - prev[o + 2]) * 0.2;
      }
    }
  }

  private hashCell(x: number, y: number, z: number) {
    const inv = 1 / this.cell;
    const xi = Math.floor(x * inv), yi = Math.floor(y * inv), zi = Math.floor(z * inv);
    return Math.abs((xi * 92837111) ^ (yi * 689287499) ^ (zi * 283923481)) % this.hashSize;
  }

  /**
   * Yarn against yarn (so the pile heaps up) and against the knit's corners (so hanging yarn stays in front).
   * Everything goes into one hash; only awake yarn particles query it.
   */
  private collideYarn() {
    const { rpos, rprev, rn, pos, np, partAlive, rfrozen, cellStart, cellEntries, hashSize, cap } = this;
    cellStart.fill(0);
    for (let i = 0; i < rn; i++) cellStart[this.hashCell(rpos[i * 3], rpos[i * 3 + 1], rpos[i * 3 + 2])]++;
    for (let i = 0; i < np; i++) if (partAlive[i]) cellStart[this.hashCell(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])]++;
    let acc = 0;
    for (let c = 0; c < hashSize; c++) {
      acc += cellStart[c];
      cellStart[c] = acc;
    }
    cellStart[hashSize] = acc;
    for (let i = 0; i < rn; i++) cellEntries[--cellStart[this.hashCell(rpos[i * 3], rpos[i * 3 + 1], rpos[i * 3 + 2])]] = i;
    for (let i = 0; i < np; i++) if (partAlive[i]) cellEntries[--cellStart[this.hashCell(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2])]] = cap + i;

    const yMin2 = this.yarnMin * this.yarnMin;
    const cMin = this.clothMin;
    const cMin2 = cMin * cMin;
    const inv = 1 / this.cell;
    const nearAnchor = rn - 8;
    const g = this.grabbedRod;
    for (let i = 0; i < rn; i++) {
      if (rfrozen[i] || i === g) continue;
      const o = i * 3;
      const xi = Math.floor(rpos[o] * inv), yi = Math.floor(rpos[o + 1] * inv), zi = Math.floor(rpos[o + 2] * inv);
      for (let dx = -1; dx <= 1; dx++)
        for (let dy = -1; dy <= 1; dy++)
          for (let dz = -1; dz <= 1; dz++) {
            const h = Math.abs(((xi + dx) * 92837111) ^ ((yi + dy) * 689287499) ^ ((zi + dz) * 283923481)) % hashSize;
            for (let e = cellStart[h]; e < cellStart[h + 1]; e++) {
              const id = cellEntries[e];
              if (id >= cap) {
                // Yarn vs a knit corner: push the yarn out; the strand's last few particles thread into the knit.
                const ci = id - cap;
                if (i >= nearAnchor || ci === this.anchor) continue;
                const q = ci * 3;
                const ex = rpos[o] - pos[q], ey = rpos[o + 1] - pos[q + 1], ez = rpos[o + 2] - pos[q + 2];
                const d2 = ex * ex + ey * ey + ez * ez;
                if (d2 >= cMin2 || d2 < 1e-12) continue;
                const d = Math.sqrt(d2);
                const push = (cMin - d) / d;
                rpos[o] += ex * push; rpos[o + 1] += ey * push; rpos[o + 2] += ez * push;
                rprev[o] += ex * push * 0.5; rprev[o + 1] += ey * push * 0.5; rprev[o + 2] += ez * push * 0.5;
                if (ey > d * 0.35) this.rsupported[i] = 1;
                continue;
              }
              if (id <= i + 6 && id >= i - 6) continue; // neighbours along the strand (crimp brings them close)
              if (!rfrozen[id] && id < i) continue; // awake pairs are handled once
              const q = id * 3;
              const ex = rpos[o] - rpos[q], ey = rpos[o + 1] - rpos[q + 1], ez = rpos[o + 2] - rpos[q + 2];
              const d2 = ex * ex + ey * ey + ez * ez;
              if (d2 >= yMin2 || d2 < 1e-12) continue;
              const d = Math.sqrt(d2);
              const corr = (this.yarnMin - d) / d;
              const other = rfrozen[id] || id === g ? 0 : 0.5;
              const mine = other ? 0.5 : 1;
              rpos[o] += ex * corr * mine; rpos[o + 1] += ey * corr * mine; rpos[o + 2] += ez * corr * mine;
              if (other) {
                rpos[q] -= ex * corr * other; rpos[q + 1] -= ey * corr * other; rpos[q + 2] -= ez * corr * other;
              }
              // Resting on yarn below counts as support, and wool on wool is grippy.
              if (ey > d * 0.35) this.rsupported[i] = 1;
              else if (ey < -d * 0.35) this.rsupported[id] = 1;
              rpos[o] = rprev[o] + (rpos[o] - rprev[o]) * 0.7;
              rpos[o + 2] = rprev[o + 2] + (rpos[o + 2] - rprev[o + 2]) * 0.7;
            }
          }
    }
  }

  private updateVelocities(h: number) {
    const { pos, prev, vel, rpos, rprev, rvel } = this;
    for (let i = 0; i < this.np * 3; i++) vel[i] = (pos[i] - prev[i]) / h;
    for (let i = 0; i < this.rn * 3; i++) rvel[i] = (rpos[i] - rprev[i]) / h;
  }

  /** Yarn that has come to rest on the table sleeps, so a big pile costs almost nothing. */
  private sleep(dt: number) {
    const { rpos, rvel, rfrozen, rcalm, rn, rsupported, rref } = this;
    const g = this.grabbedRod;
    const still = this.yarnR * 1.2;
    for (let i = 0; i < rn - 24; i++) {
      if (rfrozen[i]) continue;
      const o = i * 3;
      if (g >= 0 && Math.abs(i - g) < 30) {
        rcalm[i] = 0;
        rref[o] = rpos[o]; rref[o + 1] = rpos[o + 1]; rref[o + 2] = rpos[o + 2];
        continue;
      }
      // Rest = staying within a small ball for a moment, so contact jitter in a pile doesn't keep it awake.
      const dx = rpos[o] - rref[o], dy = rpos[o + 1] - rref[o + 1], dz = rpos[o + 2] - rref[o + 2];
      if (rsupported[i] && dx * dx + dy * dy + dz * dz < still * still) rcalm[i] += dt;
      else {
        rcalm[i] = 0;
        rref[o] = rpos[o]; rref[o + 1] = rpos[o + 1]; rref[o + 2] = rpos[o + 2];
      }
      if (rcalm[i] > 0.35) {
        rfrozen[i] = 1;
        rvel.fill(0, o, o + 3);
      }
    }
  }

  /**
   * How taut the strand is between the finger and the knit: straight-line distance over the yarn length
   * in between. Once it's pulled straight (and the swatch can't swing any closer), stitches pop.
   */
  private checkTension() {
    const g = this.grabbedRod;
    if (g < 0 || this.done || this.rn < 2) {
      this.tension = 0;
      return;
    }
    const p = this.rpos;
    const q = this.anchor * 3;
    const o = g * 3;
    // Use the finger itself as well as the grabbed particle: the yarn lags the finger, and a firm tug
    // should read as tension straight away rather than after the strand has caught up.
    const t = this.grabTarget;
    const straight = Math.max(
      Math.hypot(p[o] - this.pos[q], p[o + 1] - this.pos[q + 1], p[o + 2] - this.pos[q + 2]),
      Math.hypot(t[0] - this.pos[q], t[1] - this.pos[q + 1], t[2] - this.pos[q + 2]) * 0.985,
    );
    const restLen = (this.rn - 1 - g) * this.seg + this.seg * 0.4;
    const taut = straight / restLen;
    this.tension = taut;
    const excess = taut - (0.97 + this.cfg.threshold);
    if (excess <= 0) return;
    // Pull harder, pop faster: a yank zips through several stitches in one frame.
    const pops = Math.min(5, 1 + Math.floor(excess / 0.02));
    for (let k = 0; k < pops && !this.done; k++) this.pop();
  }

  pop() {
    if (this.done) return;
    const { cols } = this;
    const r = this.cr, c = this.cc, dir = this.cdir;
    this.stitchAlive[r * cols + c] = 0;
    this.stitchesLeft--;
    this.refreshAlive();
    // Advance along the row, turning back up at the end: knit-row order.
    let next = this.pid(r, dir > 0 ? c + 1 : c);
    this.cc += dir;
    if (this.cc < 0 || this.cc >= cols) {
      this.rowsThisFrame++;
      this.cr--;
      this.cdir = -dir;
      this.cc = this.cdir < 0 ? cols - 1 : 0;
      if (this.cr < 0) this.done = true;
    }
    if (!this.done) next = this.anchorFor(this.cr, this.cc, this.cdir);
    const oldA = this.anchor * 3;
    this.anchor = next;
    const a = next * 3;
    // The stitch's yarn springs out between where the strand was tied and the new tie point.
    const k = this.segsPerStitch;
    const last = (this.rn - 1) * 3;
    const sx = this.rn ? this.rpos[last] : this.pos[oldA];
    const sy = this.rn ? this.rpos[last + 1] : this.pos[oldA + 1];
    const sz = this.rn ? this.rpos[last + 2] : this.pos[oldA + 2];
    // The pull direction: from the tie point back along the strand.
    let fx = 0, fy = 0, fz = 0;
    if (this.rn >= 2) {
      const b = (this.rn - 2) * 3;
      fx = this.rpos[b] - sx; fy = this.rpos[b + 1] - sy; fz = this.rpos[b + 2] - sz;
      const fl = Math.hypot(fx, fy, fz) || 1;
      fx /= fl; fy /= fl; fz /= fl;
    }
    for (let j = 1; j <= k; j++) {
      const t = j / (k + 1);
      const first = this.rn;
      this.pushRod(
        sx + (this.pos[a] - sx) * t + (Math.random() - 0.5) * this.sw * 0.4,
        sy + (this.pos[a + 1] - sy) * t + (Math.random() - 0.5) * this.sw * 0.4,
        sz + (this.pos[a + 2] - sz) * t + this.sw * (0.2 + Math.random() * 0.3),
        r,
      );
      // Freed yarn springs out toward the finger.
      if (this.rn > first) this.rvel.set([fx * 1.5, fy * 1.5 + 0.4, fz * 1.5 + 0.3], first * 3);
    }
    // Juice: the knit jumps toward the pull and the strand near the knot whips outward.
    for (const ci of [this.anchor, oldA / 3]) {
      if (this.pinned[ci] || !this.partAlive[ci]) continue;
      this.vel[ci * 3] += fx * 0.8;
      this.vel[ci * 3 + 1] += fy * 0.8;
      this.vel[ci * 3 + 2] += fz * 0.8 + 0.35;
    }
    for (let j = Math.max(0, this.rn - k - 6); j < this.rn - k; j++) {
      if (this.rfrozen[j] || j === this.grabbedRod) continue;
      this.rvel[j * 3 + 2] += 0.6;
      this.rvel[j * 3 + 1] += 0.3;
    }
    this.popsThisFrame++;
    this.popEvents.push([this.pos[oldA], this.pos[oldA + 1], this.pos[oldA + 2], r]);
    this.topology++;
  }

  private refreshAlive() {
    const { stitchAlive, cAlive, s0, s1, via0, via1, nc } = this;
    for (let k = 0; k < nc; k++) {
      if (via0[k] >= 0) continue;
      cAlive[k] = (s0[k] >= 0 && stitchAlive[s0[k]]) || (s1[k] >= 0 && stitchAlive[s1[k]]) ? 1 : 0;
    }
    for (let k = 0; k < nc; k++) if (via0[k] >= 0) cAlive[k] = cAlive[via0[k]] && cAlive[via1[k]] ? 1 : 0;
    const { rows, cols } = this;
    for (let r = 0; r <= rows; r++)
      for (let c = 0; c <= cols; c++) {
        let alive = 0;
        for (const [sr, sc] of [[r - 1, c - 1], [r - 1, c], [r, c - 1], [r, c]]) {
          if (sr >= 0 && sr < rows && sc >= 0 && sc < cols && stitchAlive[sr * cols + sc]) alive = 1;
        }
        this.partAlive[this.pid(r, c)] = alive;
      }
  }

  /** Total free yarn length in world units. */
  get yarnLength() {
    return Math.max(0, this.rn - 1) * this.seg;
  }
}
