// Water drops on the pane. A drop is pinned by contact-angle hysteresis until its weight beats it
// (each drop gets its own threshold), then runs down in stick-slip jerks, wandering sideways, losing
// water to a trail and merging with drops it meets. When it runs dry it stops; on a cold pane a
// stopped drop freezes into a bead of clear ice.

export interface Drop {
  x: number;
  y: number;
  /** Water, in lattice-cell units of film. */
  m: number;
  /** Mass the drop must pass before it slides. */
  pin: number;
  vx: number;
  vy: number;
  /** Seconds since it last moved. */
  still: number;
  seed: number;
}

export const MAX_DROPS = 48;

/** Drop radius in world units for a mass. */
export function dropRadius(m: number) {
  return 0.0045 * Math.sqrt(Math.max(0.2, m));
}

export class Drops {
  readonly list: Drop[] = [];
  /** Running drops this frame, for the trickle loop. */
  running = 0;
  /** Drops merged or frozen this frame (for ticks). */
  merges = 0;
  frozen: Drop[] = [];

  add(x: number, y: number, m: number) {
    if (this.list.length >= MAX_DROPS) {
      // Too many: feed the nearest one instead.
      let best: Drop | null = null;
      let bd = 1e9;
      for (const d of this.list) {
        const dd = (d.x - x) ** 2 + (d.y - y) ** 2;
        if (dd < bd) (bd = dd), (best = d);
      }
      if (best) best.m += m;
      return;
    }
    this.list.push({ x, y, m, pin: 2.2 + Math.random() * 2.2, vx: 0, vy: 0, still: 0, seed: Math.random() * 100 });
  }

  /**
   * Advance by dt. `drag(x, y)` is the extra friction at a spot (frost soaks drops up), `freezeAfter`
   * how long a stopped drop takes to freeze. `trail` receives each running drop's segment.
   */
  step(dt: number, t: number, freezeAfter: number, drag: (x: number, y: number) => number, trail: (x0: number, y0: number, x1: number, y1: number, r: number) => void) {
    const L = this.list;
    this.running = 0;
    this.merges = 0;
    this.frozen.length = 0;
    for (const d of L) {
      const x0 = d.x, y0 = d.y;
      const f = drag(d.x, d.y);
      if (d.m > d.pin * (1 + f)) {
        // Weight beyond the pinning force accelerates it; the contact line sticks and slips.
        const push = 1 - (d.pin * (1 + f)) / d.m;
        const jerk = 0.55 + 0.45 * Math.sin(t * (9 + d.seed * 0.05) + d.seed) ** 2;
        d.vy -= 0.9 * push * dt;
        d.vy = Math.max(d.vy, -(0.08 + 0.25 * push) * jerk);
        d.vx += (Math.sin(t * 1.7 + d.seed) * 0.08 - d.vx * 4) * dt;
      } else {
        d.vy *= Math.max(0, 1 - dt * 10);
        d.vx *= Math.max(0, 1 - dt * 10);
      }
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      const moved = Math.hypot(d.x - x0, d.y - y0);
      if (moved > 1e-5) {
        // The trail keeps some of the water.
        d.m -= moved * (3 + 12 * f);
        this.running++;
        d.still = 0;
        trail(x0, y0, d.x, d.y, dropRadius(d.m));
      } else d.still += dt;
    }
    // Merge touching drops.
    for (let i = 0; i < L.length; i++) {
      const a = L[i];
      if (a.m <= 0) continue;
      for (let j = i + 1; j < L.length; j++) {
        const b = L[j];
        if (b.m <= 0) continue;
        const r = dropRadius(a.m) + dropRadius(b.m);
        if ((a.x - b.x) ** 2 + (a.y - b.y) ** 2 < r * r * 0.7) {
          const m = a.m + b.m;
          a.x = (a.x * a.m + b.x * b.m) / m;
          a.y = (a.y * a.m + b.y * b.m) / m;
          a.vx = (a.vx * a.m + b.vx * b.m) / m;
          a.vy = Math.min(a.vy, b.vy);
          a.m = m;
          a.pin = Math.min(a.pin, b.pin);
          a.still = 0;
          b.m = 0;
          this.merges++;
        }
      }
    }
    let n = 0;
    for (const d of L) {
      if (d.m < 0.25 || d.y < 0.01) continue;
      if (d.still > freezeAfter) {
        this.frozen.push(d);
        continue;
      }
      L[n++] = d;
    }
    L.length = n;
  }

  clear() {
    this.list.length = 0;
  }
}
