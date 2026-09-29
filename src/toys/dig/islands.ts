// Structural pass: which packed ground still stands, and which is cut free. As in Noita (Purho, GDC
// 2019) the ground is static pixels until a piece loses its hold; then it becomes a rigid body.
//
// Anchors are bedrock, the side walls, and ground resting on something that isn't ground (a grain
// pile, a pond, a body). From them a 0-1 breadth-first flood labels every packed cell with its support
// distance: resting on the cell below costs nothing, while reaching sideways or hanging from above costs
// one cell. A cell further than its material's span from support can't carry itself (so a tunnel roof
// wider than twice the span drops a plug, and a ledge that sticks out too far snaps off), and passes no
// support on. Unsupported cells are then labelled into 4-connected components, each also taking the
// barely-held ground next to it (past half its span), as a crack would. Cohesionless or tiny pieces
// run loose; the rest are returned as islands for the toy to turn into rigid bodies. With infinite
// spans this is plain connected-component labelling against the anchors.
//
// The pass runs over a band of rows around what changed. Rows just past the band's edges count as
// anchored, which only ever errs towards holding, and a band sized well beyond the spans keeps that rare.

import { BEDROCK, DigSim, GRAVEL, LOOSE, MAT, PACKED, PROP, SAND } from './sim';

/** Cells each material can reach past its nearest support: sand and gravel barely, clay a real tunnel roof. */
export const SPAN = [0, 8, 6, 10, 1, 1, 12, 99, 0, 0];
const MAXS = 13;
/** Smaller cut-free bits just crumble. */
export const MIN_ISLAND = 10;

export class Structure {
  private s = new Uint8Array(0);
  private qa = new Int32Array(0);
  private qb = new Int32Array(0);
  private y0 = 0;
  private y1 = 0;
  /** Cells labelled in the last pass. */
  visited = 0;

  constructor(private sim: DigSim) {}

  /** Support distances for rows [y0, y1): SPAN-limited, 255 where no support reaches. */
  solve(y0: number, y1: number) {
    const { W, H, cells } = this.sim;
    y0 = Math.max(0, y0);
    y1 = Math.min(H, y1);
    this.y0 = y0;
    this.y1 = y1;
    const n = W * (y1 - y0), base = y0 * W;
    if (this.s.length < n) {
      this.s = new Uint8Array(n);
      this.qa = new Int32Array(n);
      this.qb = new Int32Array(n);
    }
    const s = this.s;
    s.fill(255, 0, n);
    let cur = this.qa, nxt = this.qb, cn = 0;
    const topOpen = y0 > 0, botOpen = y1 < H;
    for (let i = 0; i < n; i++) {
      const k = base + i;
      const c = cells[k];
      if (!PACKED[c]) continue;
      const x = i % W, y = y0 + ((i / W) | 0);
      if (c === BEDROCK || x === 0 || x === W - 1 || (topOpen && y === y0) || (botOpen && y === y1 - 1) || (y + 1 < H && PROP[cells[k + W]])) {
        s[i] = 0;
        cur[cn++] = i;
      }
    }
    let visited = 0;
    for (let L = 0; cn > 0; L++) {
      let nn = 0;
      for (let q = 0; q < cn; q++) {
        const i = cur[q];
        if (s[i] !== L) continue;
        visited++;
        const k = base + i;
        if (L > SPAN[cells[k]]) continue; // too far out to hold anything else up
        // Up: the cell above rests on this one, free.
        if (i >= W && PACKED[cells[k - W]] && s[i - W] > L) {
          s[i - W] = L;
          cur[cn++] = i - W;
        }
        if (L >= MAXS) continue;
        const L1 = L + 1, x = i % W;
        if (i + W < n && PACKED[cells[k + W]] && s[i + W] > L1) {
          s[i + W] = L1;
          nxt[nn++] = i + W;
        }
        if (x > 0 && PACKED[cells[k - 1]] && s[i - 1] > L1) {
          s[i - 1] = L1;
          nxt[nn++] = i - 1;
        }
        if (x < W - 1 && PACKED[cells[k + 1]] && s[i + 1] > L1) {
          s[i + 1] = L1;
          nxt[nn++] = i + 1;
        }
      }
      const tmp = cur;
      cur = nxt;
      nxt = tmp;
      cn = nn;
    }
    this.visited = visited;
  }

  /** After solve(): does packed cell k (inside the solved rows) stand? */
  held(k: number) {
    const i = k - this.y0 * this.sim.W;
    if (i < 0 || i >= this.sim.W * (this.y1 - this.y0)) return true;
    return this.s[i] <= SPAN[this.sim.cells[k] & MAT];
  }

  /** Packed cells in rows [y0, y1) that no longer stand. */
  unheld(y0: number, y1: number) {
    this.solve(y0, y1);
    const { W, cells } = this.sim;
    const n = W * (this.y1 - this.y0), base = this.y0 * W;
    let count = 0;
    for (let i = 0; i < n; i++) if (PACKED[cells[base + i]] && this.s[i] > SPAN[cells[base + i]]) count++;
    return count;
  }

  /**
   * Cut free whatever in rows [y0, y1) lost its hold. Cohesionless and tiny pieces run loose here;
   * the rest come back as islands (lists of cell indices).
   */
  islands(y0: number, y1: number): number[][] {
    this.solve(y0, y1);
    const { W, cells } = this.sim;
    const s = this.s, n = W * (this.y1 - this.y0), base = this.y0 * W;
    const out: number[][] = [];
    const stack: number[] = [];
    for (let i0 = 0; i0 < n; i0++) {
      const c0 = cells[base + i0];
      if (!PACKED[c0] || s[i0] <= SPAN[c0]) continue;
      // Flood this unsupported component, marking cells as done by zeroing their distance.
      const comp: number[] = [];
      let cohesive = 0;
      s[i0] = 0;
      stack.push(i0);
      while (stack.length) {
        const i = stack.pop()!;
        const k = base + i;
        comp.push(k);
        const m = cells[k];
        if (m !== SAND && m !== GRAVEL) cohesive++;
        const x = i % W;
        if (i >= W) this.take(i - W, k - W, stack);
        if (i + W < n) this.take(i + W, k + W, stack);
        if (x > 0) this.take(i - 1, k - 1, stack);
        if (x < W - 1) this.take(i + 1, k + 1, stack);
      }
      if (comp.length < MIN_ISLAND || cohesive * 2 < comp.length) {
        for (const k of comp) cells[k] |= LOOSE;
        this.sim.crumbled += comp.length;
      } else out.push(comp);
    }
    return out;
  }

  private take(i: number, k: number, stack: number[]) {
    const c = this.sim.cells[k];
    // The crack runs back through ground that was only just holding (past half its span), so a
    // failing roof comes down in one chunky slab instead of a thin slice per pass.
    if (!PACKED[c] || this.s[i] * 2 <= SPAN[c]) return;
    this.s[i] = 0;
    stack.push(i);
  }
}
