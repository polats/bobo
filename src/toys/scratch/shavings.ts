// Wax shavings. A ductile coat doesn't crumble: the edge cuts a groove and the wax it lifts comes off
// as one continuous chip that curls, as a chip does off a cutting tool (orthogonal cutting). The
// growing chip is a strip that turns about an axis across the cut, so it rolls up into a coil in
// front of the edge; tilting that axis by the chip-flow angle walks each turn sideways, so seen from
// above the coil is a spring. A thicker cut (pressing harder) curls looser; a fast one tighter.
// The coil rides with the tool and breaks off when the stroke lifts, turns sharply, stops, or the
// chip gets long; then it lies on the card and can be blown or pushed away. Units are coat cells.

export const MAX_RIBBONS = 36;
export const MAX_PTS = 160;
/** Chip length per point (cells). */
const DS = 0.7;

export interface ShaveParams {
  /** Curl radius scale (bigger = looser coils). */
  curl: number;
  /** How long a chip grows before it snaps off by itself (cells). */
  length: number;
  /** Chip width as a share of the tool's contact width. */
  width: number;
  /** Chip-flow angle (rad): how far each turn walks sideways. */
  flow: number;
}

export class Ribbon {
  n = 0;
  /** Points in the chip's own frame while attached (along, across, up), world cells once free. */
  readonly a = new Float32Array(MAX_PTS);
  readonly c = new Float32Array(MAX_PTS);
  readonly z = new Float32Array(MAX_PTS);
  /** How much each point's face turns towards the sky (0..1), for shading. */
  readonly up = new Float32Array(MAX_PTS);
  width = 2;
  attached = true;
  /** While attached: the live tool frame it rides on. Once free: its across direction in the world. */
  frame: { x: number; y: number; ux: number; uy: number } | null = null;
  nx = 0;
  ny = 1;
  vx = 0;
  vy = 0;
  life = 1;
  // Growth state (attached only): position and tangent of the tip, and the curl axis.
  private px = 0;
  private py = 0;
  private pz = 0;
  private tx = 0.25;
  private ty = 0;
  private tz = 0.97;
  private kx = 0;
  private ky = 1;
  private acc = 0;
  /** Extra radius from the turns already rolled up (each turn lies over the last). */
  private roll = 0;

  start(front: number, width: number, flow: number) {
    this.n = 0;
    this.width = width;
    this.attached = true;
    this.life = 1;
    this.vx = this.vy = 0;
    this.px = front;
    this.py = this.pz = 0;
    const l = Math.hypot(0.25, 0.97);
    this.tx = 0.25 / l;
    this.ty = 0;
    this.tz = 0.97 / l;
    this.kx = -Math.sin(flow);
    this.ky = Math.cos(flow);
    this.acc = 0;
    this.roll = 0;
    this.push();
  }

  private push() {
    if (this.n >= MAX_PTS) return;
    const i = this.n++;
    this.a[i] = this.px;
    this.c[i] = this.py;
    this.z[i] = Math.max(0, this.pz);
    // The chip's face normal is k × t; its upward part is what the lamp sees.
    this.up[i] = this.kx * this.ty - this.ky * this.tx;
  }

  /** Feed `len` cells of chip in at radius R. */
  grow(len: number, R: number, thick = 0.5) {
    this.acc += len;
    while (this.acc >= DS && this.n < MAX_PTS) {
      this.acc -= DS;
      // Rotate the tangent about the curl axis by DS / R (Rodrigues); the roll fattens a chip's
      // thickness per turn.
      const r = Math.max(0.6, R + this.roll);
      this.roll += (DS / (2 * Math.PI * r)) * thick;
      const phi = DS / r;
      const cs = Math.cos(phi), sn = Math.sin(phi);
      const { kx, ky } = this;
      let { tx, ty, tz } = this;
      const kt = kx * tx + ky * ty;
      const cx = ky * tz, cy = -kx * tz, cz = kx * ty - ky * tx;
      tx = tx * cs + cx * sn + kx * kt * (1 - cs);
      ty = ty * cs + cy * sn + ky * kt * (1 - cs);
      tz = tz * cs + cz * sn;
      const l = Math.hypot(tx, ty, tz) || 1;
      this.tx = tx / l;
      this.ty = ty / l;
      this.tz = tz / l;
      this.px += this.tx * DS;
      this.py += this.ty * DS;
      this.pz += this.tz * DS;
      this.push();
    }
  }

  get length() {
    return this.n * DS;
  }
}

export class Shavings {
  readonly ribbons: Ribbon[] = [];
  /** The chip growing on each pointer's edge. */
  readonly growing = new Map<number, Ribbon>();
  /** Chips snapped off since the reader last zeroed it (for a tick). */
  snapped = 0;
  private pool: Ribbon[] = [];

  clear() {
    for (const r of this.ribbons) this.pool.push(r);
    this.ribbons.length = 0;
    this.growing.clear();
  }

  /** Feed the chip on pointer `id` with `len` cells cut this frame. */
  feed(id: number, frame: { x: number; y: number; ux: number; uy: number }, len: number, R: number, front: number, width: number, p: ShaveParams) {
    let r = this.growing.get(id);
    if (!r) {
      if (len < 0.2) return;
      r = this.pool.pop() ?? new Ribbon();
      if (this.ribbons.length >= MAX_RIBBONS) {
        // The oldest loose shaving makes room.
        const old = this.ribbons.findIndex((x) => !x.attached);
        if (old < 0) return;
        this.pool.push(...this.ribbons.splice(old, 1));
      }
      r.start(front, width, p.flow * (Math.random() < 0.5 ? -1 : 1));
      this.ribbons.push(r);
      this.growing.set(id, r);
    }
    r.frame = frame;
    r.grow(len, R);
    if (r.length > p.length * (0.8 + Math.random() * 0.4) || r.n >= MAX_PTS) this.snap(id);
  }

  /** Break the chip off pointer `id`: it's put down in the world where the tool last was. */
  snap(id: number) {
    const r = this.growing.get(id);
    if (!r) return;
    this.growing.delete(id);
    if (r.frame) this.place(r, r.frame);
    r.frame = null;
    if (r.n < 3) {
      this.ribbons.splice(this.ribbons.indexOf(r), 1);
      this.pool.push(r);
      return;
    }
    r.attached = false;
    this.snapped++;
  }

  /** Convert an attached chip from its tool frame to world cells. */
  private place(r: Ribbon, f: { x: number; y: number; ux: number; uy: number }) {
    r.nx = -f.uy;
    r.ny = f.ux;
    for (let i = 0; i < r.n; i++) {
      const a = r.a[i], c = r.c[i];
      r.a[i] = f.x + f.ux * a - f.uy * c;
      r.c[i] = f.y + f.uy * a + f.ux * c;
    }
  }

  /** Snap every chip whose pointer is no longer down. */
  release(active: Set<number>) {
    for (const id of [...this.growing.keys()]) if (!active.has(id)) this.snap(id);
  }

  blow(x: number, y: number, radius: number, power: number, dt: number) {
    for (const r of this.ribbons) {
      if (r.attached || !r.n) continue;
      const m = r.n >> 1;
      const ox = r.a[m] - x, oy = r.c[m] - y;
      const d = Math.hypot(ox, oy) + 1;
      if (d > radius * 3) continue;
      const f = (power * 500 * dt) / (1 + (d / radius) ** 2) / (1 + r.length * 0.02);
      r.vx += (ox / d) * f;
      r.vy += (oy / d) * f;
    }
  }

  /** A tool running into a loose shaving shoves it along. */
  plough(x: number, y: number, tvx: number, tvy: number, reach: number) {
    for (const r of this.ribbons) {
      if (r.attached || !r.n) continue;
      const m = r.n >> 1;
      if (Math.hypot(r.a[m] - x, r.c[m] - y) > reach + Math.sqrt(r.length) * 1.5) continue;
      r.vx = tvx * 0.7;
      r.vy = tvy * 0.7;
    }
  }

  step(dt: number, inside: (x: number, y: number) => boolean) {
    const drag = Math.exp(-6 * dt);
    for (let k = this.ribbons.length - 1; k >= 0; k--) {
      const r = this.ribbons[k];
      if (r.attached) continue;
      if (r.vx || r.vy) {
        const dx = r.vx * dt, dy = r.vy * dt;
        for (let i = 0; i < r.n; i++) {
          r.a[i] += dx;
          r.c[i] += dy;
        }
        r.vx *= drag;
        r.vy *= drag;
        if (Math.abs(r.vx) + Math.abs(r.vy) < 2) r.vx = r.vy = 0;
      }
      const m = r.n >> 1;
      if (!inside(r.a[m], r.c[m])) r.life -= dt * 3;
      if (r.life <= 0) {
        this.ribbons.splice(k, 1);
        this.pool.push(r);
      }
    }
  }
}
