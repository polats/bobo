// Stranded (fair-isle) colourwork as physics. The knit is an XPBD stitch grid hanging from its
// cast-on bar (adapted from Pull the Thread's cloth, src/toys/thread/sim.ts, reduced to 2D). Each
// colour is one continuous yarn: in every row it runs through its own stitches and floats behind the
// others; floats longer than a few stitches are caught behind a stitch of another colour, as knitters
// do. A spool winds its yarn in with a torque-limited winch. The free yarn from the spool to the first
// still-knitted stitch is a cable of XPBD segments whose inner nodes are those catches: yarn slides
// through a catch only when the tension on one side beats the other by the capstan factor e^(mu*theta).
// A stitch lets go when the tension reaching it beats the grip of the live loops around it.
//
// Units: one stitch pitch; y points down. Knitted top-down, so the bottom row is the last one worked.

import type { Picture } from './pictures';

/** Yarn in one knitted loop, in stitch pitches. */
export const LOOP_YARN = 2.4;
/** Floats longer than this many stitches get caught behind a stitch of another colour. */
export const CATCH_AFTER = 4;

// Grip of the loops around a stitch (tension units: pitch * mass / s^2).
const T_BASE = 40; // its own loop sliding out
const W_SIDE = 45; // each live neighbour in the course pinches it
const W_ABOVE = 25; // the loop above it slides off (or the cast-on bar)
const W_BELOW = 600; // the loop below is pulled *through* it: far beyond the winch while fresh
/** Seconds of full-torque pull for a jammed loop (or caught float) to work loose. */
const GIVE_TIME = 1.8;
// Winch: torque (max tension) and speed both ramp while the spool is held.
export const T_LO = 70;
export const T_HI = 240;
const V_LO = 7;
const V_HI = 24;
/** Wool on wool (catches). */
const MU = 0.4;
/** A caught float wraps half a turn around the other colour's leg. */
const WRAP = Math.PI;
/** Yarn stretch compliance: tension = stretch / ALPHA_YARN. */
const ALPHA_YARN = 2e-3;
// Knit links: soft while the loops rearrange, stiff once the yarn in them is straight.
const ALPHA_SOFT = 3e-3;
const ALPHA_HARD = 1e-4;
const SOFT_LIM = 0.14;
const ALPHA_SHEAR = 6e-3;

export interface Strand {
  color: string;
  /** Stitch ids in unravel order (the reverse of the order they were knitted). */
  stitches: number[];
  /** For stitches[i], the catching stitches on the float that leads to it from stitches[i - 1]. */
  catches: number[][];
  /** Index into `stitches` of the first still-knitted one (the front). */
  next: number;
  /** Cable nodes after the spool: live catches then the front stitch. Segment j ends at chain[j]. */
  chain: number[];
  rest: number[];
  tension: number[];
  /** Yarn wound on the spool so far, and all of this colour's yarn (the spool's capacity). */
  wound: number;
  total: number;
  holding: boolean;
  held: number;
  tmax: number;
  reelSpeed: number;
  /** Seconds the winch has been stalled at full torque. */
  stall: number;
  /** 0..1: how far the current jam has worked loose under sustained pull (wool creeps and slips). */
  give: number;
  /** Free yarn still to wind once the last stitch has gone. */
  tail: number;
  tailFrom: [number, number];
  done: boolean;
  /** Why it's stuck, for hints: 'catch' | 'below' | ''. */
  jam: string;
  /** Colour holding it back, if another colour. */
  blocker: string;
}

export interface ReleaseEvent {
  strand: number;
  stitch: number;
  x: number;
  y: number;
  /** Tension it took. */
  t: number;
  /** A caught float came free as this stitch left (another strand's snag released). */
  freed: number;
  /** Not a stitch: a caught float of this strand slipped out from behind its leg. */
  slip?: boolean;
}

export class Colourwork {
  readonly W: number;
  readonly H: number;
  readonly n: number;
  readonly color: string[];
  readonly colorIdx: Int32Array;
  readonly pos: Float32Array;
  readonly prev: Float32Array;
  readonly vel: Float32Array;
  readonly alive: Uint8Array;
  /** Connected through the knit to the cast-on bar. Cut-off islands are held by their own yarn, so gravity skips them. */
  readonly hung: Uint8Array;
  /** Per-stitch local stretch (0 = at rest), for drawing. */
  readonly strain: Float32Array;
  readonly strands: Strand[] = [];
  private la: Int32Array;
  private lb: Int32Array;
  private lrest: Float32Array;
  private lshear: Uint8Array;
  private readonly nl: number;
  gravity = 1.5;
  substeps = 8;
  /** Spool mouths in sim units, set by the view each frame. */
  mouths: Float32Array;
  events: ReleaseEvent[] = [];
  left: number;

  constructor(pic: Picture) {
    const H = (this.H = pic.rows.length);
    const W = (this.W = Math.max(...pic.rows.map((r) => r.length)));
    const n = (this.n = W * H);
    this.color = [];
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) this.color.push(pic.palette[pic.rows[r][c] ?? pic.rows[r][0]] ?? '#ccc');
    this.pos = new Float32Array(n * 2);
    this.prev = new Float32Array(n * 2);
    this.vel = new Float32Array(n * 2);
    this.alive = new Uint8Array(n).fill(1);
    this.hung = new Uint8Array(n).fill(1);
    this.strain = new Float32Array(n);
    this.left = n;
    for (let k = 0; k < n; k++) {
      this.pos[k * 2] = k % W;
      this.pos[k * 2 + 1] = Math.floor(k / W);
    }
    this.prev.set(this.pos);

    // Course (row) and wale (column) links, plus soft shear so the fabric doesn't fold flat.
    const A: number[] = [], B: number[] = [], S: number[] = [];
    for (let r = 0; r < H; r++)
      for (let c = 0; c < W; c++) {
        const k = r * W + c;
        if (c + 1 < W) A.push(k), B.push(k + 1), S.push(0);
        if (r + 1 < H) A.push(k), B.push(k + W), S.push(0);
        if (c + 1 < W && r + 1 < H) A.push(k), B.push(k + W + 1), S.push(1);
        if (c > 0 && r + 1 < H) A.push(k), B.push(k + W - 1), S.push(1);
      }
    this.nl = A.length;
    this.la = Int32Array.from(A);
    this.lb = Int32Array.from(B);
    this.lshear = Uint8Array.from(S);
    this.lrest = new Float32Array(this.nl);
    for (let l = 0; l < this.nl; l++) this.lrest[l] = S[l] ? Math.SQRT2 : 1;

    // One strand per colour, sorted by where its tail leaves the knit so the rack reads left to right.
    const colors = [...new Set(this.color)];
    this.colorIdx = Int32Array.from(this.color.map((c) => colors.indexOf(c)));
    const order: number[] = [];
    for (let r = H - 1; r >= 0; r--) {
      // Flat knitting turns at each edge: the last row worked ran left to right, so it unravels right to left.
      const rtl = (H - 1 - r) % 2 === 0;
      for (let i = 0; i < W; i++) order.push(r * W + (rtl ? W - 1 - i : i));
    }
    for (const color of colors) {
      const stitches = order.filter((k) => this.color[k] === color);
      const catches: number[][] = stitches.map(() => []);
      let total = 0;
      for (let i = 1; i < stitches.length; i++) {
        const a = stitches[i - 1], b = stitches[i];
        total += this.restDist(a, b);
        const ra = Math.floor(a / W), rb = Math.floor(b / W);
        if (ra !== rb) continue; // carried up the edge: not caught
        const ca = a % W, cb = b % W;
        const span = Math.abs(ca - cb) - 1;
        if (span < CATCH_AFTER) continue;
        // Catch evenly along the float, never more than CATCH_AFTER stitches loose.
        const count = Math.floor(span / CATCH_AFTER);
        const dir = Math.sign(cb - ca);
        for (let j = 1; j <= count; j++) catches[i].push(ra * W + ca + dir * Math.round((j * (span + 1)) / (count + 1)));
      }
      total += stitches.length * LOOP_YARN;
      this.strands.push({
        color, stitches, catches, next: 0, chain: [stitches[0]], rest: [0], tension: [0], wound: 0, total,
        holding: false, held: 0, tmax: T_LO, reelSpeed: 0, stall: 0, give: 0, tail: 0, tailFrom: [0, 0], done: false, jam: '', blocker: '',
      });
    }
    this.strands.sort((a, b) => (a.stitches[0] % W) - (b.stitches[0] % W));
    this.mouths = new Float32Array(this.strands.length * 2);
  }

  private restDist(a: number, b: number) {
    const W = this.W;
    return Math.hypot((a % W) - (b % W), Math.floor(a / W) - Math.floor(b / W)) + 0.2;
  }

  /** Tails from the spools up to each strand's first stitch, with a little slack. Call once mouths are set. */
  initTails() {
    for (let s = 0; s < this.strands.length; s++) {
      const st = this.strands[s];
      const k = st.stitches[0];
      const len = Math.hypot(this.mouths[s * 2] - this.pos[k * 2], this.mouths[s * 2 + 1] - this.pos[k * 2 + 1]) * 1.08 + 0.5;
      st.rest[0] = len;
      st.total += len;
    }
  }

  /** How hard the live loops around stitch k grip it; `give` loosens an interlock that's been hauled on. */
  grip(k: number, give = 0) {
    const { W, H, alive } = this;
    const r = Math.floor(k / W), c = k % W;
    let t = T_BASE;
    if (c > 0 && alive[k - 1]) t += W_SIDE;
    if (c + 1 < W && alive[k + 1]) t += W_SIDE;
    if (r === 0 || alive[k - W]) t += W_ABOVE;
    if (r + 1 < H && alive[k + W]) t += W_BELOW * (1 - give) * (1 - give);
    return t;
  }

  step(dt: number) {
    this.events.length = 0;
    const sub = this.substeps;
    const h = dt / sub;
    for (let s = 0; s < sub; s++) {
      this.integrate(h);
      this.solveKnit(h);
      this.solveYarn(h);
      const { pos, prev, vel } = this;
      for (let i = 0; i < this.n * 2; i++) vel[i] = (pos[i] - prev[i]) / h;
    }
    for (let s = 0; s < this.strands.length; s++) this.stepStrand(s, dt);
    this.measureStrain();
  }

  private integrate(h: number) {
    const { pos, prev, vel, alive, W } = this;
    const damp = Math.exp(-4 * h);
    const g = this.gravity * h;
    for (let k = 0; k < this.n; k++) {
      const o = k * 2;
      prev[o] = pos[o]; prev[o + 1] = pos[o + 1];
      if (!alive[k] || k < W) continue; // the cast-on row is on the bar
      vel[o] *= damp;
      vel[o + 1] = (vel[o + 1] + (this.hung[k] ? g : 0)) * damp;
      pos[o] += vel[o] * h;
      pos[o + 1] += vel[o + 1] * h;
    }
  }

  private w(k: number) {
    return k < this.W || !this.alive[k] ? 0 : 1;
  }

  private project(a: number, b: number, rest: number, alpha: number, pa: Float32Array, pb: Float32Array, wa: number, wb: number) {
    const dx = pa[a * 2] - pb[b * 2], dy = pa[a * 2 + 1] - pb[b * 2 + 1];
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len < 1e-9) return;
    const lambda = -(len - rest) / (wa + wb + alpha);
    const sx = (dx / len) * lambda, sy = (dy / len) * lambda;
    pa[a * 2] += sx * wa; pa[a * 2 + 1] += sy * wa;
    pb[b * 2] -= sx * wb; pb[b * 2 + 1] -= sy * wb;
  }

  private solveKnit(h: number) {
    const { la, lb, lrest, lshear, alive, pos } = this;
    const ih2 = 1 / (h * h);
    for (let l = 0; l < this.nl; l++) {
      const a = la[l], b = lb[l];
      if (!alive[a] || !alive[b]) continue;
      const wa = this.w(a), wb = this.w(b);
      if (wa + wb === 0) continue;
      if (lshear[l]) {
        this.project(a, b, lrest[l], ALPHA_SHEAR * ih2, pos, pos, wa, wb);
        continue;
      }
      this.project(a, b, lrest[l], ALPHA_SOFT * ih2, pos, pos, wa, wb);
      // Past the soft range the yarn in the loops is straight and the link goes stiff.
      const dx = pos[a * 2] - pos[b * 2], dy = pos[a * 2 + 1] - pos[b * 2 + 1];
      if (dx * dx + dy * dy > (lrest[l] + SOFT_LIM) ** 2) this.project(a, b, lrest[l] + SOFT_LIM, ALPHA_HARD * ih2, pos, pos, wa, wb);
    }
  }

  /** Each live cable segment is a one-sided XPBD distance constraint: taut yarn pulls, slack yarn doesn't push. */
  private solveYarn(h: number) {
    const alpha = ALPHA_YARN / (h * h);
    const { pos, mouths, W } = this;
    for (let s = 0; s < this.strands.length; s++) {
      const st = this.strands[s];
      if (st.done || st.tail > 0) continue;
      // The still-knitted part of the strand: floats and edge carries tie each stitch to the next one in its colour.
      for (let i = st.next + 1; i < st.stitches.length; i++) {
        const a = st.stitches[i - 1], b = st.stitches[i];
        const dx = pos[a * 2] - pos[b * 2], dy = pos[a * 2 + 1] - pos[b * 2 + 1];
        const rest = Math.abs((a % W) - (b % W)) < 2 && a !== b - W && a !== b + W ? 0 : this.restDist(a, b);
        if (!rest || dx * dx + dy * dy <= rest * rest) continue;
        const wa = this.w(a), wb = this.w(b);
        if (wa + wb) this.project(a, b, rest, alpha, pos, pos, wa, wb);
      }
      for (let j = 0; j < st.chain.length; j++) {
        const q = st.chain[j];
        const wq = this.w(q);
        if (j === 0) {
          const dx = mouths[s * 2] - pos[q * 2], dy = mouths[s * 2 + 1] - pos[q * 2 + 1];
          const len = Math.sqrt(dx * dx + dy * dy);
          const C = len - st.rest[0];
          if (C <= 0 || len < 1e-9 || !wq) continue;
          const lambda = C / (wq + alpha);
          pos[q * 2] += (dx / len) * lambda * wq;
          pos[q * 2 + 1] += (dy / len) * lambda * wq;
          continue;
        }
        const p = st.chain[j - 1];
        const dx = pos[p * 2] - pos[q * 2], dy = pos[p * 2 + 1] - pos[q * 2 + 1];
        if (Math.sqrt(dx * dx + dy * dy) <= st.rest[j]) continue;
        const wp = this.w(p);
        if (wp + wq) this.project(p, q, st.rest[j], alpha, pos, pos, wp, wq);
      }
    }
  }

  private segLen(s: number, j: number) {
    const st = this.strands[s];
    const q = st.chain[j];
    const { pos } = this;
    if (j === 0) return Math.hypot(this.mouths[s * 2] - pos[q * 2], this.mouths[s * 2 + 1] - pos[q * 2 + 1]);
    const p = st.chain[j - 1];
    return Math.hypot(pos[p * 2] - pos[q * 2], pos[p * 2 + 1] - pos[q * 2 + 1]);
  }

  private measure(s: number) {
    const st = this.strands[s];
    for (let j = 0; j < st.chain.length; j++) st.tension[j] = Math.max(0, this.segLen(s, j) - st.rest[j]) / ALPHA_YARN;
  }

  private stepStrand(s: number, dt: number) {
    const st = this.strands[s];
    if (st.done) return;
    if (st.tail > 0) {
      // Last stitch gone: the loose end whips in.
      const d = Math.min(st.tail, 30 * dt);
      st.tail -= d;
      st.wound += d;
      if (st.tail <= 1e-6) {
        st.tail = 0;
        st.done = true;
        st.wound = st.total;
      }
      return;
    }
    this.measure(s);
    // Winch: a motor whose torque and speed build while held; it reels until the yarn tension meets its torque.
    const ramp = (x: number) => (x >= 1 ? 1 : x * x * (3 - 2 * x));
    if (st.holding) {
      st.held += dt;
      st.tmax = T_LO + (T_HI - T_LO) * ramp(Math.min(1, st.held / 1.6));
      const vmax = V_LO + (V_HI - V_LO) * ramp(Math.min(1, st.held / 3));
      const t0 = st.tension[0];
      if (t0 < st.tmax) {
        st.reelSpeed = vmax * Math.min(1, 1.2 * (1 - t0 / st.tmax));
        const d = Math.min(st.reelSpeed * dt, st.rest[0] - 0.05);
        st.rest[0] -= d;
        st.wound += d;
      } else {
        // Overpowered (the torque limit dropped): the spool gives a little yarn back.
        const d = (t0 - st.tmax) * ALPHA_YARN * 0.5;
        st.rest[0] += d;
        st.wound -= d;
        st.reelSpeed = 0;
      }
    } else {
      st.held = 0;
      st.tmax = T_LO;
      st.reelSpeed = 0;
      // Eased off: the spool freewheels until the yarn is just slack.
      const stretch = st.tension[0] * ALPHA_YARN;
      if (stretch > 0) {
        const d = Math.min(stretch, 8 * dt);
        st.rest[0] += d;
        st.wound -= d;
      }
    }
    this.measure(s);
    this.slide(st);
    this.measure(s);

    const last = st.chain.length - 1;
    const front = st.chain[last];
    const tf = st.tension[last];
    // Stalled at full torque: the jam is taking the whole pull. Held there, it works loose: a caught
    // float creeps out from behind its leg (less wrap, less capstan grip) and an interlocked loop
    // slips over the one below. Easing off lets the wool settle back.
    const stalled = st.holding && st.tension[0] > st.tmax * 0.85 && st.held > 1.6 && tf < this.grip(front, st.give);
    st.stall = stalled ? st.stall + dt : 0;
    if (st.stall > 0.2) st.give = Math.min(1, st.give + dt / GIVE_TIME);
    else if (!st.holding) st.give = Math.max(0, st.give - dt * 0.5);
    this.diagnose(st, front);
    if (st.give >= 1 && st.chain.length > 1) {
      // The float nearest the front slips free of its catch with a snap.
      const i = st.chain.length - 2;
      this.events.push({ strand: s, stitch: st.chain[i], x: this.pos[st.chain[i] * 2], y: this.pos[st.chain[i] * 2 + 1], t: st.tension[i], freed: s, slip: true });
      this.unhook(st, i);
      st.give = 0.6;
      this.measure(s);
    }

    // A cut-free patch can be dragged right up to the spool: whatever reaches the mouth is wound straight on.
    if (st.chain.length > 1 && this.segLen(s, 0) < 0.6) {
      const k = st.chain[0];
      this.events.push({ strand: s, stitch: k, x: this.pos[k * 2], y: this.pos[k * 2 + 1], t: 0, freed: s, slip: true });
      this.unhook(st, 0);
      this.measure(s);
    }

    let pops = 0;
    while (pops < 3 && !st.done && st.tail === 0) {
      const l = st.chain.length - 1;
      const k = st.chain[l];
      const t = st.tension[l];
      if (t <= this.grip(k, st.give) && !(l === 0 && this.segLen(s, 0) < 0.6)) break;
      st.give = 0;
      this.release(s, t);
      this.measure(s);
      pops++;
    }
  }

  /** Yarn slides through each catch when one side out-pulls the other by the capstan factor. */
  private slide(st: Strand) {
    // A float working loose wraps less of the leg: the capstan factor falls toward 1.
    const K = Math.exp(MU * WRAP * (1 - st.give));
    for (let j = 1; j < st.chain.length; j++) {
      const sa = st.tension[j - 1] * ALPHA_YARN, sb = st.tension[j] * ALPHA_YARN;
      // Stretches (clamped at slack) on the spool side (a) and the far side (b).
      const la = this.segLenFor(st, j - 1), lb = this.segLenFor(st, j);
      const ra = la - st.rest[j - 1], rb = lb - st.rest[j];
      let d = 0;
      if (sa > K * sb) {
        // Toward the spool: move yarn from b to a until a = K * b (or b stays slack).
        d = rb + ra <= 0 ? ra : (ra - K * Math.max(0, rb)) / (1 + K);
        if (rb < 0 && rb + d < 0) d = ra;
        d = Math.min(d, st.rest[j] - 0.02);
      } else if (sb > K * sa) {
        d = -Math.min((rb - K * Math.max(0, ra)) / (1 + K), st.rest[j - 1] - 0.02);
      }
      if (d) {
        st.rest[j - 1] += d;
        st.rest[j] -= d;
        st.tension[j - 1] = Math.max(0, la - st.rest[j - 1]) / ALPHA_YARN;
        st.tension[j] = Math.max(0, lb - st.rest[j]) / ALPHA_YARN;
      }
    }
  }

  private segLenFor(st: Strand, j: number) {
    return this.segLen(this.strands.indexOf(st), j);
  }

  private diagnose(st: Strand, front: number) {
    st.jam = '';
    st.blocker = '';
    if (st.stall < 0.25) return;
    const below = front + this.W;
    if (below < this.n && this.alive[below]) {
      st.jam = 'below';
      st.blocker = this.color[below];
    } else if (st.chain.length > 1) {
      st.jam = 'catch';
      st.blocker = this.color[st.chain[st.chain.length - 2]];
    }
  }

  /** The front stitch unloops: its yarn joins the free strand and the float to the next stitch goes live. */
  private release(s: number, t: number) {
    const st = this.strands[s];
    const l = st.chain.length - 1;
    const k = st.chain[l];
    this.kill(k);
    const ev: ReleaseEvent = { strand: s, stitch: k, x: this.pos[k * 2], y: this.pos[k * 2 + 1], t, freed: -1 };
    this.events.push(ev);
    st.next++;
    if (st.next >= st.stitches.length) {
      let yarn = LOOP_YARN;
      for (const r of st.rest) yarn += r;
      st.tail = yarn;
      st.tailFrom = [ev.x, ev.y];
      st.chain = [];
      st.rest = [];
      st.tension = [];
    } else {
      const nk = st.stitches[st.next];
      const caught = st.catches[st.next].filter((c) => this.alive[c]);
      const nodes = [...caught, nk];
      let from = k;
      let carry = st.rest[l] + LOOP_YARN;
      st.chain.pop();
      st.rest.pop();
      st.tension.pop();
      for (const node of nodes) {
        st.chain.push(node);
        st.rest.push(carry + this.restDist(from, node));
        st.tension.push(0);
        from = node;
        carry = 0;
      }
    }
    // Other colours' floats caught behind this stitch come free.
    for (let o = 0; o < this.strands.length; o++) {
      const other = this.strands[o];
      const i = other.chain.indexOf(k);
      if (i < 0 || i === other.chain.length - 1) continue;
      if (other.tension[i] > 20 || other.tension[i + 1] > 20) ev.freed = o;
      this.unhook(other, i);
    }
  }

  /** Drop catch node i from a cable: the two segments either side become one. */
  private unhook(st: Strand, i: number) {
    st.rest[i + 1] += st.rest[i];
    st.chain.splice(i, 1);
    st.rest.splice(i, 1);
    st.tension.splice(i, 1);
  }

  private kill(k: number) {
    this.alive[k] = 0;
    this.left--;
    // Flood from the bar through live course/wale neighbours.
    const { W, H, alive, hung } = this;
    hung.fill(0);
    const stack: number[] = [];
    for (let c = 0; c < W; c++) if (alive[c]) (hung[c] = 1), stack.push(c);
    while (stack.length) {
      const q = stack.pop()!;
      const r = Math.floor(q / W), c = q % W;
      for (const nb of [c > 0 ? q - 1 : -1, c + 1 < W ? q + 1 : -1, r > 0 ? q - W : -1, r + 1 < H ? q + W : -1])
        if (nb >= 0 && alive[nb] && !hung[nb]) (hung[nb] = 1), stack.push(nb);
    }
  }

  private measureStrain() {
    const { W, H, pos, alive, strain } = this;
    for (let k = 0; k < this.n; k++) {
      if (!alive[k]) continue;
      const r = Math.floor(k / W), c = k % W;
      let m = 0;
      const x = pos[k * 2], y = pos[k * 2 + 1];
      if (c + 1 < W && alive[k + 1]) m = Math.max(m, Math.hypot(pos[k * 2 + 2] - x, pos[k * 2 + 3] - y) - 1);
      if (c > 0 && alive[k - 1]) m = Math.max(m, Math.hypot(pos[k * 2 - 2] - x, pos[k * 2 - 1] - y) - 1);
      if (r + 1 < H && alive[k + W]) m = Math.max(m, Math.hypot(pos[(k + W) * 2] - x, pos[(k + W) * 2 + 1] - y) - 1);
      if (r > 0 && alive[k - W]) m = Math.max(m, Math.hypot(pos[(k - W) * 2] - x, pos[(k - W) * 2 + 1] - y) - 1);
      strain[k] = Math.max(0, m);
    }
  }

  get progress() {
    let w = 0, t = 0;
    for (const s of this.strands) {
      w += Math.max(0, s.wound);
      t += s.total;
    }
    return t ? Math.min(1, w / t) : 0;
  }

  get complete() {
    return this.strands.every((s) => s.done);
  }
}
