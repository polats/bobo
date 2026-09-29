// Molten gold as 1D flow on the seam graph. Every seam polyline is a chain of short segments;
// each segment fills from either end (fa, fb) at a speed set by its slope (downhill races,
// uphill creeps by capillary pull) over the viscosity. A full segment wets its end node, which
// feeds every open segment meeting there, so gold branches at junctions. A seam is open only
// once both shards on either side are seated; gold waiting at a closed seam moves on when it opens.

import type { Seam } from './fracture';

export class GoldNet {
  readonly nx: Float32Array;
  readonly ny: Float32Array;
  readonly wet: Uint8Array;
  private adjStart: Int32Array;
  private adj: Int32Array;
  readonly sa: Int32Array;
  readonly sb: Int32Array;
  readonly len: Float32Array;
  private dirY: Float32Array;
  readonly fa: Float32Array;
  readonly fb: Float32Array;
  /** Bit 1: filling from a; bit 2: filling from b. */
  private enter: Uint8Array;
  readonly full: Uint8Array;
  readonly open: Uint8Array;
  private segSeam: Int32Array;
  /** Segment ranges per seam, in polyline order. */
  readonly seamStart: Int32Array;
  readonly seams: Seam[];
  readonly seamFull: Uint8Array;
  readonly totalLen: number;
  filledLen = 0;
  /** Segments filling right now (for the trickle loop). */
  fronts = 0;
  /** Seams completed on the last step (count), and whether anything moved. */
  justCompleted = 0;
  changed = true;

  constructor(seams: Seam[], vertexCount: number) {
    this.seams = seams;
    let nodes = vertexCount, segs = 0;
    for (const s of seams) {
      const n = s.pts.length / 2;
      nodes += Math.max(0, n - 2);
      segs += n - 1;
    }
    this.nx = new Float32Array(nodes);
    this.ny = new Float32Array(nodes);
    this.wet = new Uint8Array(nodes);
    this.sa = new Int32Array(segs);
    this.sb = new Int32Array(segs);
    this.len = new Float32Array(segs);
    this.dirY = new Float32Array(segs);
    this.fa = new Float32Array(segs);
    this.fb = new Float32Array(segs);
    this.enter = new Uint8Array(segs);
    this.full = new Uint8Array(segs);
    this.open = new Uint8Array(segs);
    this.segSeam = new Int32Array(segs);
    this.seamStart = new Int32Array(seams.length + 1);
    this.seamFull = new Uint8Array(seams.length);
    let nextNode = vertexCount, si = 0, total = 0;
    const deg = new Int32Array(nodes);
    seams.forEach((s, k) => {
      this.seamStart[k] = si;
      const n = s.pts.length / 2;
      let prev = s.va;
      this.nx[prev] = s.pts[0];
      this.ny[prev] = s.pts[1];
      for (let q = 1; q < n; q++) {
        const id = q === n - 1 ? s.vb : nextNode++;
        this.nx[id] = s.pts[2 * q];
        this.ny[id] = s.pts[2 * q + 1];
        this.sa[si] = prev;
        this.sb[si] = id;
        const dx = this.nx[id] - this.nx[prev], dy = this.ny[id] - this.ny[prev];
        const l = Math.max(0.5, Math.hypot(dx, dy));
        this.len[si] = l;
        this.dirY[si] = dy / l;
        this.segSeam[si] = k;
        total += l;
        deg[prev]++;
        deg[id]++;
        prev = id;
        si++;
      }
    });
    this.seamStart[seams.length] = si;
    this.totalLen = total;
    this.adjStart = new Int32Array(nodes + 1);
    for (let k = 0; k < nodes; k++) this.adjStart[k + 1] = this.adjStart[k] + deg[k];
    this.adj = new Int32Array(this.adjStart[nodes]);
    const fill = this.adjStart.slice(0, nodes);
    for (let s = 0; s < segs; s++) {
      this.adj[fill[this.sa[s]]++] = s;
      this.adj[fill[this.sb[s]]++] = s;
    }
  }

  get nodeCount() {
    return this.nx.length;
  }

  get segCount() {
    return this.sa.length;
  }

  get fraction() {
    return this.totalLen > 0 ? Math.min(1, this.filledLen / this.totalLen) : 1;
  }

  get done() {
    return this.filledLen >= this.totalLen - 1e-3;
  }

  /** Open every seam whose two shards are both seated; gold already at an end flows on in. */
  updateOpen(seated: ArrayLike<boolean>) {
    for (let s = 0; s < this.sa.length; s++) {
      if (this.open[s]) continue;
      const seam = this.seams[this.segSeam[s]];
      if (!seated[seam.i] || !seated[seam.j]) continue;
      this.open[s] = 1;
      if (this.wet[this.sa[s]]) this.enter[s] |= 1;
      if (this.wet[this.sb[s]]) this.enter[s] |= 2;
    }
    this.changed = true;
  }

  /** Wet a node: gold enters every open segment that meets it. */
  wetNode(n: number) {
    if (this.wet[n]) return;
    this.wet[n] = 1;
    for (let k = this.adjStart[n]; k < this.adjStart[n + 1]; k++) {
      const s = this.adj[k];
      if (!this.open[s] || this.full[s]) continue;
      this.enter[s] |= this.sa[s] === n ? 1 : 2;
    }
  }

  /** Nearest node on an open seam within r (piece-local pixels), or -1. */
  nearestOpen(x: number, y: number, r: number) {
    let best = -1, bd = r * r;
    for (let s = 0; s < this.sa.length; s++) {
      if (!this.open[s]) continue;
      const n = this.sa[s];
      const d = (this.nx[n] - x) ** 2 + (this.ny[n] - y) ** 2;
      if (d < bd) [best, bd] = [n, d];
    }
    return best;
  }

  anyOpen() {
    for (let s = 0; s < this.open.length; s++) if (this.open[s]) return true;
    return false;
  }

  /** Advance the fronts. speed is pixels per second on a level seam. */
  step(dt: number, speed: number) {
    let fronts = 0;
    this.justCompleted = 0;
    for (let s = 0; s < this.sa.length; s++) {
      const e = this.enter[s];
      if (!e || this.full[s] || !this.open[s]) continue;
      fronts++;
      const l = this.len[s], g = this.dirY[s];
      // Downhill races, uphill creeps.
      if (e & 1) this.fa[s] += (Math.max(0.3, Math.min(1.5, 0.6 + 0.9 * g)) * speed * dt) / l;
      if (e & 2) this.fb[s] += (Math.max(0.3, Math.min(1.5, 0.6 - 0.9 * g)) * speed * dt) / l;
      this.changed = true;
      if (this.fa[s] + this.fb[s] >= 1) {
        this.full[s] = 1;
        this.filledLen += l;
        this.fa[s] = e & 1 ? 1 : 0;
        this.fb[s] = e & 1 ? 0 : 1;
        this.wetNode(this.sa[s]);
        this.wetNode(this.sb[s]);
        const k = this.segSeam[s];
        if (!this.seamFull[k]) {
          let all = true;
          for (let q = this.seamStart[k]; q < this.seamStart[k + 1] && all; q++) all = !!this.full[q];
          if (all) {
            this.seamFull[k] = 1;
            this.justCompleted++;
          }
        }
      }
    }
    this.fronts = fronts;
  }

  /**
   * Trace the gold into a path (piece-local). Front tips are written into tips as x, y pairs;
   * returns the tip count.
   */
  trace(path: Path2D, tips: Float32Array) {
    let nt = 0;
    const { nx, ny } = this;
    for (let k = 0; k < this.seams.length; k++) {
      let pen = false;
      for (let s = this.seamStart[k]; s < this.seamStart[k + 1]; s++) {
        const a = this.sa[s], b = this.sb[s];
        const ax = nx[a], ay = ny[a], bx = nx[b], by = ny[b];
        if (this.full[s]) {
          if (!pen) path.moveTo(ax, ay);
          path.lineTo(bx, by);
          pen = true;
          continue;
        }
        const fa = Math.min(1, this.fa[s]), fb = Math.min(1, this.fb[s]);
        if (fa > 0) {
          if (!pen) path.moveTo(ax, ay);
          const tx = ax + (bx - ax) * fa, ty = ay + (by - ay) * fa;
          path.lineTo(tx, ty);
          if (nt < tips.length / 2) {
            tips[2 * nt] = tx;
            tips[2 * nt + 1] = ty;
            nt++;
          }
        }
        pen = false;
        if (fb > 0) {
          const tx = bx - (bx - ax) * fb, ty = by - (by - ay) * fb;
          path.moveTo(tx, ty);
          path.lineTo(bx, by);
          pen = true;
          if (nt < tips.length / 2) {
            tips[2 * nt] = tx;
            tips[2 * nt + 1] = ty;
            nt++;
          }
        }
      }
    }
    return nt;
  }

  /** Every seam as one path (for the hairline cracks), open seams only. */
  traceOpen(path: Path2D) {
    const { nx, ny } = this;
    for (let k = 0; k < this.seams.length; k++) {
      let pen = false;
      for (let s = this.seamStart[k]; s < this.seamStart[k + 1]; s++) {
        if (!this.open[s]) {
          pen = false;
          continue;
        }
        if (!pen) path.moveTo(nx[this.sa[s]], ny[this.sa[s]]);
        path.lineTo(nx[this.sb[s]], ny[this.sb[s]]);
        pen = true;
      }
    }
  }

  /** Fill everything at once (dev and shelf baking). */
  fillAll() {
    this.full.fill(1);
    this.open.fill(1);
    this.filledLen = this.totalLen;
    this.seamFull.fill(1);
    this.changed = true;
  }
}
