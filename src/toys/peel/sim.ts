// Peelable film: an XPBD sheet (Tear Sheet's small-steps cloth, flattened onto a surface) where every
// vertex is also glued to its rest spot by a zero-length adhesion constraint (like Laundry's
// break-at-stretch pins). A glued vertex lets go when the film pulls it further than a threshold that
// follows Kendall's peel relation, F = G·w / (1 − cos θ): peeling back at a high angle is easy,
// peeling flat or sideways needs so much force that the film tears at the peel front instead.

export interface FilmSpec {
  /** Rest rectangle in world units (y up, the surface is z = 0). */
  x0: number;
  y0: number;
  w: number;
  h: number;
  spacing: number;
  /** Adhesive coverage at film uv (0..1, v up), 0..1; default everywhere. */
  shape?: (u: number, v: number) => number;
  /** Film uv of the non-sticky pull tab, and its radius in world units. */
  tab: [number, number];
  tabR: number;
}

export interface Handle {
  verts: Int32Array;
  offsets: Float32Array;
  weights: Float32Array;
  target: [number, number, number];
}

/** Film thickness: loose film rests this far above the glued film, so folds never z-fight. */
export const THICK = 0.008;

export class Film {
  readonly cols: number;
  readonly rows: number;
  readonly spacing: number;
  readonly n: number;
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  readonly vel: Float32Array;
  /** Rest spot on the surface (x, y). */
  readonly rest: Float32Array;
  /** Film texture uv (u, v up). */
  readonly uv: Float32Array;
  readonly normal: Float32Array;
  /** Per-vertex stretch, for strain whitening. */
  readonly strain: Float32Array;
  /** Render alpha: fades as a freed piece flies off. */
  readonly alpha: Float32Array;
  /** Has an adhesion constraint at all (inside the sticker shape, off the tab). */
  readonly sticky: Uint8Array;
  /** Adhesion still holding. */
  readonly stuck: Uint8Array;
  readonly isTab: Uint8Array;
  /** Glued and sitting exactly on its rest spot (lets the solver skip the untouched film). */
  private readonly rested: Uint8Array;
  /** 1 while flying away, 2 once gone. */
  readonly fly: Uint8Array;
  /** On a free edge of the sheet (film border or a torn edge); refreshed with the topology. */
  readonly boundary: Uint8Array;
  // Edges: triangle edges (tearable) and each cell's other diagonal (shear).
  readonly ne: number;
  readonly ea: Int32Array;
  readonly eb: Int32Array;
  readonly erest: Float32Array;
  readonly ealive: Uint8Array;
  readonly eshear: Uint8Array;
  readonly eweak: Float32Array;
  /** The (up to) two triangles each edge borders; -1 for none. */
  private readonly et: Int32Array;
  // Triangles
  readonly nt: number;
  readonly tris: Uint32Array;
  private readonly triEdges: Int32Array;
  private readonly triShear: Int32Array;
  readonly triAlive: Uint8Array;
  // Curl hinges: vertex triples along rows and columns, alive while both edges are.
  private readonly nq: number;
  private readonly qa: Int32Array;
  private readonly qb: Int32Array;
  private readonly qc: Int32Array;
  private readonly qe: Int32Array;
  // Vertex → edges (CSR), for the local peel angle.
  private readonly adjStart: Int32Array;
  private readonly adjEdge: Int32Array;
  /** Grid row / column of each vertex and the grid → vertex map, to look up the peeled arm. */
  private readonly gr: Int16Array;
  private readonly gc: Int16Array;
  private readonly grid: Int32Array;

  /** Connected pieces: id per vertex, stuck-vertex count per piece. */
  readonly comp: Int32Array;
  readonly compStuck: Int32Array;
  compCount = 0;
  private readonly parent: Int32Array;
  // Per-piece peel front (summed position, outward direction, count) and its Kendall factor.
  private readonly fx: Float32Array;
  private readonly fy: Float32Array;
  private readonly fux: Float32Array;
  private readonly fuy: Float32Array;
  private readonly fn: Int32Array;
  readonly pieceK: Float32Array;

  readonly total: number;
  released = 0;
  releasedThisFrame = 0;
  tornThisFrame = 0;
  tears = 0;
  everTorn = false;
  /** Bumps whenever triangles die, so the renderer rebuilds its index buffer. */
  topology = 0;
  maxStrain = 0;
  /** World-space centre of this frame's releases / tears (for stereo panning). */
  releaseX = 0;
  tearX = 0;
  age = 0;
  handles: Handle[] = [];
  /** Finger speed in world units / s, set by the toy: fast pulls glue harder (a viscoelastic adhesive). */
  speed = 0;
  private pending: number[] = [];

  cfg = {
    substeps: 10,
    iterations: 2,
    /** Also solve each cell's second diagonal (stiffer in shear, a quarter more work). */
    shear: false,
    gravity: 3.2,
    damping: 1.2,
    /** Bending compliance of the curl hinges. */
    bendCompliance: 4e-4,
    /** Rest curvature of peeled film (1 / world units): it curls back, adhesive side out. */
    curl: 5,
    /** G: adhesion break stretch at θ = 90°, as a fraction of the edge length. */
    stick: 0.03,
    /** The pull (glue stretch, in edge lengths) the film itself can carry: need more and it tears. */
    tough: 0.3,
    /** Finger speed (world units / s) up to which a pull counts as slow, and how fast grip climbs past it. */
    slow: 1,
    rate: 1.7,
    /** How much a sideways (in-plane, shearing) pull counts as a low angle. */
    side: 0.8,
    /** Kendall factor clamp: 1 / (1 − cos θ) runs from 0.5 at 180° to this at low angles. */
    kMax: 12,
    /** Glue compliance: the share of its stretch a glued vertex keeps each substep. */
    give: 0.5,
    /** Cap on the local angle factor, which only shapes where the front advances. */
    kCap: 6,
    /** Cells up the peeled arm at which the peel angle is measured. */
    arm: 7,
  };

  constructor(spec: FilmSpec) {
    const cols = Math.max(3, Math.round(spec.w / spec.spacing) + 1);
    const rows = Math.max(3, Math.round(spec.h / spec.spacing) + 1);
    this.cols = cols;
    this.rows = rows;
    this.spacing = spec.w / (cols - 1);
    const sx = spec.w / (cols - 1);
    const sy = spec.h / (rows - 1);
    const shape = spec.shape ?? (() => 1);
    // Keep the cells the adhesive area touches (plus a rim the texture trims), drop the rest.
    const gridN = cols * rows;
    const inside = new Uint8Array(gridN);
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) inside[r * cols + c] = shape(c / (cols - 1), r / (rows - 1)) > 0.5 ? 1 : 0;
    const keepCell = (r: number, c: number) =>
      inside[r * cols + c] || inside[r * cols + c + 1] || inside[(r + 1) * cols + c] || inside[(r + 1) * cols + c + 1] || shape((c + 0.5) / (cols - 1), (r + 0.5) / (rows - 1)) > 0.5;
    const map = new Int32Array(gridN).fill(-1);
    let n = 0;
    for (let r = 0; r + 1 < rows; r++)
      for (let c = 0; c + 1 < cols; c++)
        if (keepCell(r, c)) for (const g of [r * cols + c, r * cols + c + 1, (r + 1) * cols + c, (r + 1) * cols + c + 1]) if (map[g] < 0) map[g] = n++;
    this.n = n;
    this.grid = map;
    this.gr = new Int16Array(n);
    this.gc = new Int16Array(n);
    this.pos = new Float32Array(n * 3);
    this.prev = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.rest = new Float32Array(n * 2);
    this.uv = new Float32Array(n * 2);
    this.normal = new Float32Array(n * 3);
    this.strain = new Float32Array(n);
    this.alpha = new Float32Array(n).fill(1);
    this.sticky = new Uint8Array(n);
    this.stuck = new Uint8Array(n);
    this.isTab = new Uint8Array(n);
    this.rested = new Uint8Array(n);
    this.fly = new Uint8Array(n);
    this.boundary = new Uint8Array(n);
    this.comp = new Int32Array(n);
    this.compStuck = new Int32Array(n);
    this.parent = new Int32Array(n);
    this.fx = new Float32Array(n);
    this.fy = new Float32Array(n);
    this.fux = new Float32Array(n);
    this.fuy = new Float32Array(n);
    this.fn = new Int32Array(n);
    this.pieceK = new Float32Array(n);
    const tx = spec.x0 + spec.tab[0] * spec.w;
    const ty = spec.y0 + spec.tab[1] * spec.h;
    let total = 0;
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        const i = map[r * cols + c];
        if (i < 0) continue;
        const x = spec.x0 + c * sx;
        const y = spec.y0 + r * sy;
        this.rest[i * 2] = x;
        this.rest[i * 2 + 1] = y;
        this.gr[i] = r;
        this.gc[i] = c;

        this.uv[i * 2] = c / (cols - 1);
        this.uv[i * 2 + 1] = r / (rows - 1);
        const dt = Math.hypot(x - tx, y - ty);
        let z = 0;
        if (dt < spec.tabR) {
          // The tab is dry and already lifted: a little curled-up corner to grab.
          this.isTab[i] = 1;
          const k = 1 - dt / spec.tabR;
          z = THICK + 0.13 * k * k;
        } else if (inside[r * cols + c]) {
          this.sticky[i] = this.stuck[i] = this.rested[i] = 1;
          total++;
        } else z = THICK;
        this.pos.set([x, y, z], i * 3);
      }
    this.total = total;
    this.prev.set(this.pos);

    // --- edges and triangles ---
    const ea: number[] = [];
    const eb: number[] = [];
    const esh: number[] = [];
    const edgeId = new Map<number, number>();
    const edge = (i: number, j: number, shear = 0) => {
      const key = i < j ? i * n + j : j * n + i;
      let e = edgeId.get(key);
      if (e === undefined) {
        e = ea.length;
        edgeId.set(key, e);
        ea.push(i);
        eb.push(j);
        esh.push(shear);
      }
      return e;
    };
    const tris: number[] = [];
    const triEdges: number[] = [];
    const triShear: number[] = [];
    for (let r = 0; r + 1 < rows; r++)
      for (let c = 0; c + 1 < cols; c++) {
        if (!keepCell(r, c)) continue;
        const p00 = map[r * cols + c];
        const p10 = map[r * cols + c + 1];
        const p01 = map[(r + 1) * cols + c];
        const p11 = map[(r + 1) * cols + c + 1];
        // Counter-clockwise seen from +z (the film's top). Alternate the diagonal so rips wander.
        if ((r + c) % 2 === 0) {
          const s = edge(p10, p01, 1);
          tris.push(p00, p10, p11, p00, p11, p01);
          triEdges.push(edge(p00, p10), edge(p10, p11), edge(p11, p00), edge(p00, p11), edge(p11, p01), edge(p01, p00));
          triShear.push(s, s);
        } else {
          const s = edge(p00, p11, 1);
          tris.push(p00, p10, p01, p10, p11, p01);
          triEdges.push(edge(p00, p10), edge(p10, p01), edge(p01, p00), edge(p10, p11), edge(p11, p01), edge(p01, p10));
          triShear.push(s, s);
        }
      }
    this.ne = ea.length;
    this.ea = Int32Array.from(ea);
    this.eb = Int32Array.from(eb);
    this.eshear = Uint8Array.from(esh);
    this.ealive = new Uint8Array(this.ne).fill(1);
    this.erest = new Float32Array(this.ne);
    this.eweak = new Float32Array(this.ne);
    for (let e = 0; e < this.ne; e++) {
      const a = this.ea[e], b = this.eb[e];
      this.erest[e] = Math.hypot(this.rest[a * 2] - this.rest[b * 2], this.rest[a * 2 + 1] - this.rest[b * 2 + 1]);
      // A little random variation per link so tears wander instead of running on rails.
      this.eweak[e] = 0.9 + Math.random() * 0.2;
    }
    this.nt = tris.length / 3;
    this.tris = Uint32Array.from(tris);
    this.triEdges = Int32Array.from(triEdges);
    this.triShear = Int32Array.from(triShear);
    this.triAlive = new Uint8Array(this.nt).fill(1);
    this.et = new Int32Array(this.ne * 2).fill(-1);
    const put = (e: number, t: number) => (this.et[e * 2] < 0 ? (this.et[e * 2] = t) : (this.et[e * 2 + 1] = t));
    for (let t = 0; t < this.nt; t++) {
      for (let k = 0; k < 3; k++) put(this.triEdges[t * 3 + k], t);
      put(this.triShear[t], t);
    }

    // --- curl hinges along rows and columns ---
    const qa: number[] = [];
    const qb: number[] = [];
    const qc: number[] = [];
    const qe: number[] = [];
    const at = (r: number, c: number) => (r >= 0 && r < rows && c >= 0 && c < cols ? map[r * cols + c] : -1);
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        for (const [dr, dc] of [[0, 1], [1, 0]]) {
          const a = at(r - dr, c - dc), b = at(r, c), d = at(r + dr, c + dc);
          if (a < 0 || b < 0 || d < 0) continue;
          const e0 = edgeId.get(a < b ? a * n + b : b * n + a);
          const e1 = edgeId.get(b < d ? b * n + d : d * n + b);
          if (e0 === undefined || e1 === undefined) continue;
          qa.push(a);
          qb.push(b);
          qc.push(d);
          qe.push(e0, e1);
        }
      }
    this.nq = qa.length;
    this.qa = Int32Array.from(qa);
    this.qb = Int32Array.from(qb);
    this.qc = Int32Array.from(qc);
    this.qe = Int32Array.from(qe);

    // --- adjacency ---
    const deg = new Int32Array(n + 1);
    for (let e = 0; e < this.ne; e++) {
      deg[this.ea[e] + 1]++;
      deg[this.eb[e] + 1]++;
    }
    for (let i = 0; i < n; i++) deg[i + 1] += deg[i];
    this.adjStart = deg;
    this.adjEdge = new Int32Array(this.ne * 2);
    const fill = deg.slice(0, n);
    for (let e = 0; e < this.ne; e++) {
      this.adjEdge[fill[this.ea[e]]++] = e;
      this.adjEdge[fill[this.eb[e]]++] = e;
    }
    this.computeNormals();
    this.updateComponents();
  }

  /** Film that has come up: glue let go, or the dry tab (not the unglued rim around a sticker). */
  peeled(i: number) {
    return !this.stuck[i] && (this.sticky[i] === 1 || this.isTab[i] === 1);
  }

  /** Let go of vertex i's adhesion. */
  release(i: number) {
    if (!this.stuck[i]) return;
    this.stuck[i] = 0;
    this.rested[i] = 0;
    // Leave from rest: whatever the solver dragged it by this substep isn't velocity.
    const o = i * 3;
    this.prev[o] = this.pos[o];
    this.prev[o + 1] = this.pos[o + 1];
    this.prev[o + 2] = this.pos[o + 2];
    this.released++;
    this.releasedThisFrame++;
    this.releaseX += this.pos[i * 3];
  }

  step(dt: number) {
    const { substeps } = this.cfg;
    const h = dt / substeps;
    this.age += dt;
    this.releasedThisFrame = 0;
    this.tornThisFrame = 0;
    this.releaseX = 0;
    this.tearX = 0;
    this.maxStrain = 0;
    this.strain.fill(0);
    this.updatePeelAngles();
    for (let s = 0; s < substeps; s++) {
      this.integrate(h);
      this.attach();
      for (let it = 0; it < this.cfg.iterations; it++) this.solveEdges(h, s === substeps - 1 && it === 0);
      this.solveCurl(h);
      this.adhere();
      this.collide();
      this.updateVelocities(h);
    }
    if (this.releasedThisFrame) this.releaseX /= this.releasedThisFrame;
    if (this.tornThisFrame) this.tearX /= this.tornThisFrame;
    // Flying pieces fade out, then stop costing anything.
    for (let i = 0; i < this.n; i++) {
      if (this.fly[i] !== 1) continue;
      this.alpha[i] -= dt / 0.7;
      if (this.alpha[i] <= 0) {
        this.alpha[i] = 0;
        this.fly[i] = 2;
      }
    }
    this.computeNormals();
  }

  private integrate(h: number) {
    const { pos, prev, vel, fly } = this;
    const g = this.cfg.gravity;
    const damp = Math.exp(-this.cfg.damping * h);
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      prev[o] = pos[o];
      prev[o + 1] = pos[o + 1];
      prev[o + 2] = pos[o + 2];
      if (fly[i] === 2 || this.stuck[i]) continue;
      vel[o] *= damp;
      vel[o + 1] *= damp;
      vel[o + 2] = (vel[o + 2] - (fly[i] ? 0 : g * h)) * damp;
      pos[o] += vel[o] * h;
      pos[o + 1] += vel[o + 1] * h;
      pos[o + 2] += vel[o + 2] * h;
    }
  }

  /** Pull held patches toward their fingers; soft, so the load spreads into the film. */
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

  private solveEdges(h: number, last: boolean) {
    const { pos, ea, eb, erest, ealive, eweak, eshear, strain, fly, rested } = this;
    // Near-inextensible film (a tiny compliance keeps it from buzzing). Glued vertices move here
    // too (equal weights), and adhere() measures how far before snapping them back.
    const inv = 1 / (2 + 1e-9 / (h * h));
    const limit = this.age > 0.4 ? 1.4 : 0;
    const shear = this.cfg.shear;
    let maxStrain = this.maxStrain;
    for (let e = 0; e < this.ne; e++) {
      if (!ealive[e] || (!shear && eshear[e])) continue;
      const i = ea[e], j = eb[e];
      // Two glued vertices sitting exactly on their rest spots are exactly at rest length: skip.
      if (fly[i] === 2 || (rested[i] && rested[j])) continue;
      const oi = i * 3, oj = j * 3;
      const dx = pos[oi] - pos[oj];
      const dy = pos[oi + 1] - pos[oj + 1];
      const dz = pos[oi + 2] - pos[oj + 2];
      const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
      const r0 = erest[e];
      // Float32 round-off, not a real stretch: leave it (and keep the glued film marked at rest).
      if (len < 1e-9 || Math.abs(len - r0) < 1e-6) continue;
      const st = len / r0 - 1;
      if (last && st > 0) {
        if (st > strain[i]) strain[i] = st;
        if (st > strain[j]) strain[j] = st;
        if (st > maxStrain) maxStrain = st;
      }
      // Two fingers stretching the film apart can rip it anywhere, not just at the peel front.
      if (limit && st > limit * eweak[e]) {
        if (eshear[e]) ealive[e] = 0;
        else this.pending.push(e);
      }
      const k = (-(len - r0) * inv) / len;
      rested[i] = rested[j] = 0;
      const sx = dx * k, sy = dy * k, sz = dz * k;
      pos[oi] += sx;
      pos[oi + 1] += sy;
      pos[oi + 2] += sz;
      pos[oj] -= sx;
      pos[oj + 1] -= sy;
      pos[oj + 2] -= sz;
    }
    this.maxStrain = maxStrain;
    if (this.pending.length) {
      for (const e of this.pending) if (this.ealive[e]) this.cutEdge(e);
      this.pending.length = 0;
    }
  }

  /**
   * Discrete hinges with a curved rest shape: the middle vertex of each triple wants to sit a set
   * distance off the chord, against the film's top normal, so lifted film rolls up. Glued film
   * wants to be flat, which is what makes the curl start right at the peel front.
   */
  private solveCurl(h: number) {
    const { pos, normal, qa, qb, qc, qe, ealive, stuck, fly } = this;
    const alpha = this.cfg.bendCompliance / (h * h);
    const s = this.spacing;
    const target = -(this.cfg.curl * s * s) / 2;
    for (let q = 0; q < this.nq; q++) {
      if (!ealive[qe[q * 2]] || !ealive[qe[q * 2 + 1]]) continue;
      const a = qa[q], b = qb[q], c = qc[q];
      if (fly[b] === 2) continue;
      const wa = stuck[a] ? 0 : 1, wb = stuck[b] ? 0 : 1, wc = stuck[c] ? 0 : 1;
      const w = wb + (wa + wc) * 0.25;
      if (w === 0) continue;
      const oa = a * 3, ob = b * 3, oc = c * 3;
      const nx = normal[ob], ny = normal[ob + 1], nz = normal[ob + 2];
      const d =
        (pos[ob] - (pos[oa] + pos[oc]) * 0.5) * nx + (pos[ob + 1] - (pos[oa + 1] + pos[oc + 1]) * 0.5) * ny + (pos[ob + 2] - (pos[oa + 2] + pos[oc + 2]) * 0.5) * nz;
      const d0 = wa && wb && wc ? target : 0;
      const lambda = -(d - d0) / (w + alpha);
      const kb = lambda * wb, ke = -0.5 * lambda;
      pos[ob] += nx * kb;
      pos[ob + 1] += ny * kb;
      pos[ob + 2] += nz * kb;
      pos[oa] += nx * ke * wa;
      pos[oa + 1] += ny * ke * wa;
      pos[oa + 2] += nz * ke * wa;
      pos[oc] += nx * ke * wc;
      pos[oc + 1] += ny * ke * wc;
      pos[oc + 2] += nz * ke * wc;
    }
  }

  /**
   * Adhesion: each glued vertex snaps back to its rest spot. How far the film dragged it first is the
   * pull on the glue; past the Kendall threshold it lets go, or, if the film would give out first
   * (low angle, fast yank), the film tears along the peel front and this vertex stays stuck.
   */
  private adhere() {
    const { pos, rest, stuck, comp, pieceK } = this;
    const c = this.cfg;
    const s = this.spacing;
    // Viscoelastic glue: grip climbs steeply once the hand moves faster than a steady pull.
    const rateMul = 1 + c.rate * Math.max(0, this.speed - c.slow) ** 1.5;
    const minBreak = Math.min(c.stick * 0.5 * rateMul, c.tough) * s;
    const keep = c.give;
    for (let i = 0; i < this.n; i++) {
      if (!stuck[i]) continue;
      const o = i * 3;
      const dx = pos[o] - rest[i * 2];
      const dy = pos[o + 1] - rest[i * 2 + 1];
      const dz = Math.max(0, pos[o + 2]);
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > minBreak * minBreak) {
        const d = Math.sqrt(d2) / s;
        const p = comp[i];
        if (p >= 0 && pieceK[p] > 0 && c.stick * pieceK[p] * rateMul > c.tough) {
          // Peeling this piece would take more force than the film can carry: it tears at the front.
          if (d > c.tough * this.weakest(i) && this.age > 0.4) this.tearAt(i);
        } else if (d > c.stick * Math.min(c.kCap, this.kendall(i)) * rateMul) {
          this.release(i);
          continue;
        }
      }
      // A compliant glue layer: it gives a little (the stretch is the pull), then springs back.
      if (d2 < 1e-12) {
        pos[o] = rest[i * 2];
        pos[o + 1] = rest[i * 2 + 1];
        pos[o + 2] = 0;
        this.rested[i] = 1;
        continue;
      }
      pos[o] = rest[i * 2] + dx * keep;
      pos[o + 1] = rest[i * 2 + 1] + dy * keep;
      pos[o + 2] = dz * keep;
    }
  }

  /**
   * Kendall factor 1 / (1 − cos θ) for every held piece, once per frame, from the hand and the peel
   * front as a whole: θ is the angle between the front's outward direction (where the loose film
   * came from) and the pull, from the middle of the front up to the hand. The part of the pull
   * along the front shears the glue line (a sideways yank), which counts as a low angle.
   */
  private updatePeelAngles() {
    const { pos, rest, stuck, ea, eb, ealive, adjStart, adjEdge, comp, pieceK, fx, fy, fux, fuy, fn } = this;
    const c = this.cfg;
    // 0 = nobody is pulling this piece: it can only settle, never tear.
    pieceK.fill(0);
    if (!this.handles.length) return;
    fx.fill(0);
    fy.fill(0);
    fux.fill(0);
    fuy.fill(0);
    fn.fill(0);
    for (let i = 0; i < this.n; i++) {
      if (!stuck[i] || comp[i] < 0) continue;
      let ux = 0, uy = 0, loose = 0;
      for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
        const e = adjEdge[k];
        if (!ealive[e]) continue;
        const j = ea[e] === i ? eb[e] : ea[e];
        if (!this.peeled(j)) continue;
        ux += rest[j * 2] - rest[i * 2];
        uy += rest[j * 2 + 1] - rest[i * 2 + 1];
        loose++;
      }
      if (!loose) continue;
      const p = comp[i];
      fx[p] += pos[i * 3];
      fy[p] += pos[i * 3 + 1];
      const ul = Math.hypot(ux, uy) || 1;
      fux[p] += ux / ul;
      fuy[p] += uy / ul;
      fn[p]++;
    }
    for (const hd of this.handles) {
      const p = comp[hd.verts[0]];
      if (p < 0 || !fn[p]) continue;
      let ux = fux[p], uy = fuy[p];
      const ul = Math.hypot(ux, uy);
      if (ul < 1e-9) continue;
      ux /= ul;
      uy /= ul;
      const vx = hd.target[0] - fx[p] / fn[p], vy = hd.target[1] - fy[p] / fn[p], vz = hd.target[2];
      const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      const a = (vx * ux + vy * uy) / vl;
      const z = vz / vl;
      const sx = vx / vl - a * ux, sy = vy / vl - a * uy;
      const cos = a / (Math.sqrt(a * a + z * z) || 1);
      const denom = (1 - cos) * (1 - c.side * (sx * sx + sy * sy));
      const k = Math.min(c.kMax, Math.max(0.5, 1 / Math.max(1e-3, denom)));
      pieceK[p] = pieceK[p] ? Math.min(pieceK[p], k) : k;
    }
  }

  /** The peel angle factor of vertex i's piece (what decides peel vs tear). */
  peelFactor(i: number) {
    const p = this.comp[i];
    return p < 0 || !this.pieceK[p] ? this.cfg.kMax : this.pieceK[p];
  }

  /**
   * Kendall factor 1 / (1 − cos θ) at glued vertex i. θ is the angle of the peeled arm: measured to
   * a vertex a few cells up the loose film (past the bend right at the front, where film always
   * leaves the surface tangentially), against the direction that film originally lay in. The part
   * of the arm that runs sideways, along the front, shears the glue line and grips harder.
   */
  kendall(i: number) {
    const { pos, rest, stuck, ea, eb, ealive, adjStart, adjEdge, gr, gc, grid, fly, cols, rows } = this;
    const c = this.cfg;
    let best = c.kMax;
    const oi = i * 3;
    const r0 = gr[i], c0 = gc[i];
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const e = adjEdge[k];
      if (!ealive[e] || this.eshear[e]) continue;
      let j = ea[e] === i ? eb[e] : ea[e];
      if (!this.peeled(j) || fly[j]) continue;
      // Walk up the arm along the same grid direction while the film stays loose.
      const dr = gr[j] - r0, dc = gc[j] - c0;
      for (let m = 2; m <= c.arm; m++) {
        const rr = r0 + dr * m, cc = c0 + dc * m;
        if (rr < 0 || rr >= rows || cc < 0 || cc >= cols) break;
        const v = grid[rr * cols + cc];
        if (v < 0 || stuck[v] || fly[v] || this.comp[v] !== this.comp[j]) break;
        j = v;
      }
      const oj = j * 3;
      const vx = pos[oj] - pos[oi], vy = pos[oj + 1] - pos[oi + 1], vz = pos[oj + 2] - pos[oi + 2];
      const vl = Math.sqrt(vx * vx + vy * vy + vz * vz) || 1;
      let ux = rest[j * 2] - rest[i * 2], uy = rest[j * 2 + 1] - rest[i * 2 + 1];
      const ul = Math.hypot(ux, uy) || 1;
      ux /= ul;
      uy /= ul;
      const a = (vx * ux + vy * uy) / vl;
      const z = vz / vl;
      const sx = vx / vl - a * ux, sy = vy / vl - a * uy;
      const cos = a / (Math.sqrt(a * a + z * z) || 1);
      const denom = (1 - cos) * (1 - c.side * (sx * sx + sy * sy));
      // The easiest direction wins: that is where the film actually lifts from.
      best = Math.min(best, 1 / Math.max(1e-3, denom));
    }
    return Math.max(0.5, best);
  }

  private weakest(i: number) {
    let w = 1.1;
    for (let k = this.adjStart[i]; k < this.adjStart[i + 1]; k++) {
      const e = this.adjEdge[k];
      if (this.ealive[e] && !this.eshear[e]) w = Math.min(w, this.eweak[e]);
    }
    return w;
  }

  /** The film gives out at glued vertex i: cut every link from it to the loose film. */
  private tearAt(i: number) {
    const { ea, eb, ealive, stuck, adjStart, adjEdge } = this;
    for (let k = adjStart[i]; k < adjStart[i + 1]; k++) {
      const e = adjEdge[k];
      if (!ealive[e]) continue;
      const j = ea[e] === i ? eb[e] : ea[e];
      if (this.peeled(j)) this.cutEdge(e);
    }
  }

  /** Break one link, the triangles it borders and anything left dangling; weaken the crack tip. */
  private cutEdge(e: number) {
    const { ealive, et, triAlive, triEdges, triShear, ea, eb, eweak, adjStart, adjEdge, pos } = this;
    if (!ealive[e]) return;
    ealive[e] = 0;
    for (let s = 0; s < 2; s++) {
      const t = et[e * 2 + s];
      if (t < 0 || !triAlive[t]) continue;
      triAlive[t] = 0;
      ealive[triShear[t]] = 0;
      for (let k = 0; k < 3; k++) {
        const f = triEdges[t * 3 + k];
        const t0 = et[f * 2], t1 = et[f * 2 + 1];
        if ((t0 < 0 || !triAlive[t0]) && (t1 < 0 || !triAlive[t1])) ealive[f] = 0;
      }
    }
    // The links at the crack tip that carry the same pull are the next to go: the rip runs.
    const a = ea[e], b = eb[e];
    const dx = pos[b * 3] - pos[a * 3], dy = pos[b * 3 + 1] - pos[a * 3 + 1];
    const dl = Math.hypot(dx, dy) || 1;
    for (const v of [a, b])
      for (let k = adjStart[v]; k < adjStart[v + 1]; k++) {
        const f = adjEdge[k];
        if (!ealive[f]) continue;
        const i = ea[f], j = eb[f];
        const fx = pos[j * 3] - pos[i * 3], fy = pos[j * 3 + 1] - pos[i * 3 + 1];
        if (Math.abs(fx * dx + fy * dy) / ((Math.hypot(fx, fy) || 1) * dl) > 0.5) eweak[f] = Math.min(eweak[f], 0.6);
      }
    this.tornThisFrame++;
    this.tears++;
    this.everTorn = true;
    this.tearX += (pos[a * 3] + pos[b * 3]) * 0.5;
    this.topology++;
  }

  private collide() {
    const { pos, prev, stuck, fly } = this;
    for (let i = 0; i < this.n; i++) {
      if (stuck[i] || fly[i]) continue;
      const o = i * 3;
      if (pos[o + 2] < THICK) {
        pos[o + 2] = THICK;
        // Film lying on the surface drags instead of skating.
        pos[o] = prev[o] + (pos[o] - prev[o]) * 0.6;
        pos[o + 1] = prev[o + 1] + (pos[o + 1] - prev[o + 1]) * 0.6;
      }
    }
  }

  private updateVelocities(h: number) {
    const { pos, prev, vel, fly } = this;
    const inv = 1 / h;
    for (let i = 0; i < this.n; i++) {
      if (fly[i] === 2 || this.stuck[i]) continue;
      const o = i * 3;
      vel[o] = (pos[o] - prev[o]) * inv;
      vel[o + 1] = (pos[o + 1] - prev[o + 1]) * inv;
      vel[o + 2] = (pos[o + 2] - prev[o + 2]) * inv;
    }
  }

  /** Area-weighted vertex normals from the live triangles (top side = +z at rest). */
  computeNormals() {
    const { pos, normal, tris, triAlive } = this;
    normal.fill(0);
    for (let t = 0; t < this.nt; t++) {
      if (!triAlive[t]) continue;
      const a = tris[t * 3] * 3, b = tris[t * 3 + 1] * 3, c = tris[t * 3 + 2] * 3;
      const e1x = pos[b] - pos[a], e1y = pos[b + 1] - pos[a + 1], e1z = pos[b + 2] - pos[a + 2];
      const e2x = pos[c] - pos[a], e2y = pos[c + 1] - pos[a + 1], e2z = pos[c + 2] - pos[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      normal[a] += nx;
      normal[a + 1] += ny;
      normal[a + 2] += nz;
      normal[b] += nx;
      normal[b + 1] += ny;
      normal[b + 2] += nz;
      normal[c] += nx;
      normal[c + 1] += ny;
      normal[c + 2] += nz;
    }
    for (let i = 0; i < this.n; i++) {
      const o = i * 3;
      const l = Math.hypot(normal[o], normal[o + 1], normal[o + 2]);
      if (l > 1e-12) {
        normal[o] /= l;
        normal[o + 1] /= l;
        normal[o + 2] /= l;
      } else normal[o + 2] = 1;
    }
  }

  /** Union-find over live triangles: which pieces exist, which are still glued, which edges are free. */
  updateComponents() {
    const { parent, tris, triAlive, comp, compStuck, boundary, et, ealive, ne } = this;
    for (let i = 0; i < this.n; i++) parent[i] = i;
    const find = (x: number) => {
      while (parent[x] !== x) {
        parent[x] = parent[parent[x]];
        x = parent[x];
      }
      return x;
    };
    comp.fill(-1);
    for (let t = 0; t < this.nt; t++) {
      if (!triAlive[t]) continue;
      const a = find(tris[t * 3]), b = find(tris[t * 3 + 1]), c = find(tris[t * 3 + 2]);
      parent[b] = a;
      parent[find(c)] = a;
      comp[tris[t * 3]] = comp[tris[t * 3 + 1]] = comp[tris[t * 3 + 2]] = 0;
    }
    let count = 0;
    const idOf = new Map<number, number>();
    for (let i = 0; i < this.n; i++) {
      if (comp[i] < 0) {
        // In no live triangle any more: a lone vertex left by a rip.
        if (!this.fly[i]) {
          this.fly[i] = 2;
          this.alpha[i] = 0;
          this.release(i);
        }
        continue;
      }
      const r = find(i);
      let id = idOf.get(r);
      if (id === undefined) idOf.set(r, (id = count++));
      comp[i] = id;
    }
    this.compCount = count;
    compStuck.fill(0, 0, count);
    for (let i = 0; i < this.n; i++) if (comp[i] >= 0 && this.stuck[i]) compStuck[comp[i]]++;
    boundary.fill(0);
    for (let e = 0; e < ne; e++) {
      if (!ealive[e] || this.eshear[e]) continue;
      const t0 = et[e * 2], t1 = et[e * 2 + 1];
      const live = (t0 >= 0 && triAlive[t0] ? 1 : 0) + (t1 >= 0 && triAlive[t1] ? 1 : 0);
      if (live === 1) boundary[this.ea[e]] = boundary[this.eb[e]] = 1;
    }
  }

  /** Send piece `c` flying (toward the viewer and along vx, vy), releasing whatever glue it had left. */
  fling(c: number, vx: number, vy: number) {
    for (let i = 0; i < this.n; i++) {
      if (this.comp[i] !== c || this.fly[i]) continue;
      this.release(i);
      this.fly[i] = 1;
      this.vel[i * 3] += vx;
      this.vel[i * 3 + 1] += vy;
      this.vel[i * 3 + 2] += 1.6;
    }
    this.handles = this.handles.filter((hd) => this.comp[hd.verts[0]] !== c);
  }
}
