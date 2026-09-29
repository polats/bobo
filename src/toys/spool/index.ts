import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { PICTURES } from './pictures';
import { Colourwork, T_HI } from './sim';

export const spoolToy: Toy = {
  id: 'spool',
  title: 'Spool Sort',
  blurb:
    'A fair-isle picture where every colour is one long yarn. Hold a spool to reel its strand in: it tightens, drags on the floats caught behind other colours, and pops the stitches out loop by loop.',
  tech: 'XPBD knit + stranded-yarn cables with capstan-friction catches · Canvas 2D',
  swatch: 'linear-gradient(135deg,#e8364f,#fff4e6 45%,#5cc05a)',
  refs: [
    {
      short: 'Macklin 2016',
      title: 'Macklin, Müller, Chentanez — XPBD: Position-Based Simulation of Compliant Constrained Dynamics (MIG 2016)',
      url: 'https://doi.org/10.1145/2994258.2994272',
      use: 'One solver for the stitch grid (soft-then-stiff compliant links) and the yarn cables, whose stretch gives the tension that pops stitches.',
    },
    {
      short: 'Cirio 2017',
      title: 'Cirio, Lopez-Moreno, Otaduy — Yarn-Level Cloth Simulation with Sliding Persistent Contacts (IEEE TVCG 2017)',
      url: 'https://doi.org/10.1109/TVCG.2016.2592908',
      use: 'The idea of yarn sliding through persistent contacts: each caught float is a contact node the strand slides through, moving rest length between segments.',
    },
    {
      short: 'Capstan eq.',
      title: 'Capstan equation (belt friction, Euler–Eytelwein)',
      url: 'https://en.wikipedia.org/wiki/Capstan_equation',
      use: 'Yarn slips through a catch only when one side pulls e^(μθ) times harder than the other, so catches hold back tension and drag the patch they are wrapped around.',
    },
    {
      short: 'Fair Isle',
      title: 'Fair Isle (technique) — stranded colourwork',
      url: 'https://en.wikipedia.org/wiki/Fair_Isle_(technique)',
      use: 'The knit structure: each colour carried behind the others as floats, with floats longer than a few stitches caught by the working yarn.',
    },
  ],
  async create(ctx) {
    return new SpoolSort(ctx);
  },
};

interface Puff {
  x: number; y: number; vx: number; vy: number; life: number; color: string;
}

const TAU = Math.PI * 2;

class SpoolSort implements ToyInstance {
  private g: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private u = 1;
  private pitch = 20;
  private originX = 0;
  private originY = 0;
  private picIndex = 0;
  private sim!: Colourwork;
  private holds = new Map<number, number>();
  private spin: number[] = [];
  private nope: number[] = [];
  private flash: number[] = [];
  private puffs: Puff[] = [];
  private done = 0;
  private fade = 0;
  private time = 0;
  private trickle;
  private hiss;
  private popRate = 0;
  private everHeld = false;

  constructor(private ctx: ToyContext) {
    const g = ctx.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('Canvas 2D is not available.');
    this.g = g;
    this.trickle = ctx.sound.loop('trickle');
    this.hiss = ctx.sound.loop('hiss');
    ctx.panel.action('Next picture', () => this.load(this.picIndex + 1));
    ctx.panel.action('Start over', () => this.load(this.picIndex));
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.load(0);
    if (import.meta.env.DEV) {
      // Dev probe for headless tests: strand state and spool centres in CSS pixels.
      const w = window as unknown as Record<string, unknown>;
      w.__spool = () => {
        const s = this.sim;
        const css = this.ctx.canvas.clientWidth / this.width;
        return {
          pic: PICTURES[this.picIndex].name,
          left: s.left,
          progress: s.progress,
          complete: s.complete,
          strands: s.strands.map((st, i) => {
            const [x, y, w, h] = this.spoolRect(i);
            const front = st.chain[st.chain.length - 1] ?? -1;
            return {
              color: st.color, next: st.next, of: st.stitches.length, catches: Math.max(0, st.chain.length - 1),
              t0: Math.round(st.tension[0] ?? 0), tf: Math.round(st.tension[st.tension.length - 1] ?? 0),
              grip: front >= 0 ? Math.round(s.grip(front, st.give)) : 0, tmax: Math.round(st.tmax), give: +st.give.toFixed(2),
              jam: st.jam, blocker: st.blocker, wound: +st.wound.toFixed(1), total: +st.total.toFixed(1), done: st.done,
              holding: st.holding, sx: (x + w / 2) * css, sy: (y + h / 2) * css,
              belowAlive: front >= 0 && front + s.W < s.n ? !!s.alive[front + s.W] : false,
            };
          }),
        };
      };
      w.__spoolFront = (i: number) => {
        const st = this.sim.strands[i];
        const k = st.chain[st.chain.length - 1];
        if (k === undefined) return null;
        const css = this.ctx.canvas.clientWidth / this.width;
        return { x: (this.originX + this.sim.pos[k * 2] * this.pitch) * css, y: (this.originY + this.sim.pos[k * 2 + 1] * this.pitch) * css, rest: [(k % this.sim.W), Math.floor(k / this.sim.W)] };
      };
    }
  }

  // ---------------------------------------------------------------- setup

  private load(index: number) {
    this.picIndex = ((index % PICTURES.length) + PICTURES.length) % PICTURES.length;
    this.sim = new Colourwork(PICTURES[this.picIndex]);
    const n = this.sim.strands.length;
    this.spin = new Array(n).fill(0);
    this.nope = new Array(n).fill(0);
    this.flash = new Array(n).fill(0);
    this.holds.clear();
    this.puffs = [];
    this.done = 0;
    this.fade = 0;
    this.layout();
    this.setMouths();
    this.sim.initTails();
    this.ctx.progress(0, 'reeled');
  }

  private layout() {
    const { width } = this;
    this.u = this.ctx.pixelRatio;
    const W = this.sim.W, H = this.sim.H;
    const top = 138 * this.u;
    const [, shelfY] = this.spoolRect(0);
    // Leave room under the knit for the strands to run down to the rack.
    const room = shelfY - top - 70 * this.u;
    this.pitch = Math.min((width * 0.84) / W, room / (H + 0.6));
    this.originX = (width - this.pitch * (W - 1)) / 2;
    this.originY = top + this.pitch * 0.8;
  }

  private setMouths() {
    const s = this.sim;
    for (let i = 0; i < s.strands.length; i++) {
      const [mx, my] = this.spoolMouth(i);
      s.mouths[i * 2] = (mx - this.originX) / this.pitch;
      s.mouths[i * 2 + 1] = (my - this.originY) / this.pitch;
    }
  }

  private spoolRect(slot: number): [number, number, number, number] {
    const n = this.sim ? this.sim.strands.length : 5;
    const w = Math.min(this.width / (n + 1.2), 74 * this.u);
    const h = w * 1.3;
    const gap = (this.width - w * n) / (n + 1);
    const x = gap + slot * (w + gap);
    const y = this.height - h - Math.max(34 * this.u, this.height * 0.055);
    return [x, y, w, h];
  }

  private spoolMouth(slot: number): [number, number] {
    const [x, y, w] = this.spoolRect(slot);
    return [x + w / 2, y + w * 0.12];
  }

  private sx(x: number) {
    return this.originX + x * this.pitch;
  }

  private sy(y: number) {
    return this.originY + y * this.pitch;
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    const s = this.sim;
    this.input();
    this.setMouths();
    s.step(dt);
    this.juice(dt);
    this.draw();
    const frac = s.progress;
    this.ctx.progress(frac, 'reeled');
    if (s.complete && !this.done) {
      this.done = t;
      this.ctx.celebrate(`${PICTURES[this.picIndex].name} unravelled!`);
    }
    if (this.done && t - this.done > 2.6) this.load(this.picIndex + 1);
    this.ctx.setStatus(`${s.left} stitches left`);
  }

  private input() {
    const s = this.sim;
    const { width, height } = this;
    for (const p of this.ctx.pointers.active.values()) {
      if (!p.justDown) continue;
      const x = p.x * width, y = (1 - p.y) * height;
      for (let i = 0; i < s.strands.length; i++) {
        const [rx, ry, rw, rh] = this.spoolRect(i);
        const pad = 8 * this.u;
        if (x < rx - pad || x > rx + rw + pad || y < ry - 3 * pad || y > ry + rh + 3 * pad) continue;
        if (s.strands[i].done) {
          this.nope[i] = 1;
          this.ctx.sound.play('knock', { pitch: 0.7, gain: 0.4, pan: this.pan(i) });
        } else {
          this.holds.set(p.id, i);
          this.everHeld = true;
          this.ctx.haptic('light');
          this.ctx.sound.play('tick', { pitch: 1.4, gain: 0.3, pan: this.pan(i) });
        }
        break;
      }
    }
    for (const id of [...this.holds.keys()]) if (!this.ctx.pointers.active.has(id)) this.holds.delete(id);
    const held = new Set(this.holds.values());
    s.strands.forEach((st, i) => (st.holding = held.has(i) && !st.done));
  }

  private pan(slot: number) {
    return ((slot + 0.5) / this.sim.strands.length - 0.5) * 1.2;
  }

  private juice(dt: number) {
    const s = this.sim;
    let pops = 0;
    for (const e of s.events) {
      const st = s.strands[e.strand];
      if (e.slip) {
        // A caught float worked its way out from behind its leg.
        this.ctx.sound.play('snap', { gain: 0.45, pitch: 1.4, pan: this.pan(e.strand) });
        this.ctx.haptic('medium');
        this.burst(e.x, e.y, st.color, 5);
        continue;
      }
      pops++;
      this.spin[e.strand] += 1;
      this.burst(e.x, e.y, st.color, 4);
      if (e.freed >= 0) {
        // Another colour's caught float springs loose as this stitch leaves.
        this.ctx.sound.play('snap', { gain: 0.5, pitch: 1.1, pan: this.pan(e.freed) });
        this.ctx.haptic('medium');
        this.flash[e.freed] = 1;
      }
      if (s.strands[e.strand].done || s.strands[e.strand].tail > 0) this.ctx.sound.play('chime', { gain: 0.35, pitch: 1 + e.strand * 0.1 });
    }
    if (pops) {
      const k = Math.min(1, this.popRate / 12);
      const e = s.events[s.events.length - 1];
      this.ctx.sound.play('tick', { gain: Math.min(0.7, 0.35 + pops * 0.1), pitch: 0.85 + k * 0.8, pan: this.pan(e.strand) });
      this.ctx.haptic(pops > 1 ? 'medium' : 'light');
    }
    if (dt > 0) this.popRate += (pops / dt - this.popRate) * Math.min(1, dt * 4);
    // Sound and a continuous buzz from the strands being reeled: speed rasps, tension hums.
    let speed = 0, tension = 0, sharp = 0;
    for (const st of s.strands) {
      if (st.tail > 0) speed = Math.max(speed, 1);
      if (!st.holding) continue;
      speed = Math.max(speed, st.reelSpeed / 24);
      const t = Math.min(1, (st.tension[0] ?? 0) / T_HI);
      if (t > tension) {
        tension = t;
        sharp = 0.25 + 0.6 * Math.min(1, st.reelSpeed / 24);
      }
    }
    this.trickle.set(Math.min(0.8, speed * 0.8), 0.3 + speed * 0.5);
    this.hiss.set(tension * tension * 0.35, 0.2 + tension * 0.6);
    if (tension > 0.02 || speed > 0.05) this.ctx.hapticLevel(0.12 + tension * 0.7 + speed * 0.15, sharp || 0.5);
    for (let i = 0; i < this.spin.length; i++) {
      this.spin[i] += s.strands[i].reelSpeed * dt * 0.25 + (s.strands[i].tail > 0 ? dt * 6 : 0);
      this.nope[i] = Math.max(0, this.nope[i] - dt * 3);
      this.flash[i] = Math.max(0, this.flash[i] - dt * 2);
    }
    for (const p of this.puffs) {
      p.vy += 3 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.life -= dt * 1.6;
    }
    this.puffs = this.puffs.filter((p) => p.life > 0);
    this.fade = Math.min(1, this.fade + dt * 3);
  }

  private burst(x: number, y: number, color: string, n: number) {
    for (let i = 0; i < n; i++) {
      if (this.puffs.length > 120) this.puffs.shift();
      const a = Math.random() * TAU;
      const v = 0.8 + Math.random() * 1.4;
      this.puffs.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v - 0.6, life: 1, color });
    }
  }

  // ---------------------------------------------------------------- draw

  private draw() {
    const { g, width, height, u } = this;
    const bg = g.createLinearGradient(0, 0, 0, height);
    bg.addColorStop(0, '#fbe9dc');
    bg.addColorStop(1, '#f1cdb8');
    g.fillStyle = bg;
    g.fillRect(0, 0, width, height);
    const [, sy, , sh] = this.spoolRect(0);
    g.fillStyle = '#d9a37f';
    g.fillRect(0, sy + sh - 4 * u, width, height);
    g.fillStyle = 'rgba(120,60,30,0.18)';
    g.fillRect(0, sy + sh - 4 * u, width, 5 * u);

    g.save();
    g.globalAlpha = this.fade;
    this.drawBar();
    this.drawFloats();
    this.drawStitches();
    this.drawCatches();
    g.restore();
    for (let i = 0; i < this.sim.strands.length; i++) this.drawSpool(i);
    for (let i = 0; i < this.sim.strands.length; i++) this.drawStrand(i);
    this.drawPuffs();
    this.drawHint();
  }

  private drawBar() {
    const { g, u } = this;
    const y = this.sy(-0.62);
    const x0 = this.sx(-1.2), x1 = this.sx(this.sim.W + 0.2);
    g.lineCap = 'round';
    g.strokeStyle = 'rgba(90,50,30,0.25)';
    g.lineWidth = 9 * u;
    g.beginPath();
    g.moveTo(x0, y + 3 * u);
    g.lineTo(x1, y + 3 * u);
    g.stroke();
    g.strokeStyle = '#c98b5a';
    g.lineWidth = 8 * u;
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(x1, y);
    g.stroke();
    g.strokeStyle = 'rgba(255,255,255,0.4)';
    g.lineWidth = 2 * u;
    g.beginPath();
    g.moveTo(x0, y - 2 * u);
    g.lineTo(x1, y - 2 * u);
    g.stroke();
  }

  /** Floats behind the fabric: drawn first, so they show only through the gaps between loops. */
  private drawFloats() {
    const { g, sim: s, pitch: p } = this;
    const { pos, W } = s;
    g.lineCap = 'round';
    g.lineWidth = p * 0.2;
    for (const st of s.strands) {
      if (st.done) continue;
      g.strokeStyle = st.color;
      g.beginPath();
      for (let i = Math.max(1, st.next + 1); i < st.stitches.length; i++) {
        const a = st.stitches[i - 1], b = st.stitches[i];
        if (Math.floor(a / W) !== Math.floor(b / W) || Math.abs((a % W) - (b % W)) < 2) continue;
        g.moveTo(this.sx(pos[a * 2]), this.sy(pos[a * 2 + 1] + 0.18));
        g.lineTo(this.sx(pos[b * 2]), this.sy(pos[b * 2 + 1] + 0.18));
      }
      g.stroke();
    }
  }

  /** Every stitch is a knit "V": two slanted loops, stretched along the pull. Batched per colour. */
  private drawStitches() {
    const { g, sim: s, pitch: p } = this;
    const { pos, alive, strain, W, H } = s;
    const byColor = new Map<string, number[]>();
    const tense: number[] = [];
    for (let k = 0; k < s.n; k++) {
      if (!alive[k]) continue;
      let list = byColor.get(s.color[k]);
      if (!list) byColor.set(s.color[k], (list = []));
      list.push(k);
      if (strain[k] > 0.05) tense.push(k);
    }
    const lobes = (ks: number[], scale: number, ox: number, oy: number) => {
      g.beginPath();
      for (const k of ks) {
        const c = k % W, r = Math.floor(k / W);
        const x = this.sx(pos[k * 2]), y = this.sy(pos[k * 2 + 1]);
        // Local frame from live neighbours: across the course and down the wale.
        const L = c > 0 && alive[k - 1] ? k - 1 : k, R = c + 1 < W && alive[k + 1] ? k + 1 : k;
        const Up = r > 0 && alive[k - W] ? k - W : k, D = r + 1 < H && alive[k + W] ? k + W : k;
        let ax = pos[R * 2] - pos[L * 2], ay = pos[R * 2 + 1] - pos[L * 2 + 1];
        if (L === R) (ax = 1), (ay = 0);
        const span = Up === D ? 1 : Math.hypot(pos[D * 2] - pos[Up * 2], pos[D * 2 + 1] - pos[Up * 2 + 1]) / (D - Up === 2 * W ? 2 : 1);
        const rot = Math.atan2(ay, ax);
        const cs = Math.cos(rot), sn = Math.sin(rot);
        const tall = Math.min(1.6, Math.max(0.8, span)) * scale;
        const thin = 1 / Math.sqrt(Math.max(0.8, span));
        for (const side of [-1, 1]) {
          const cx = x + cs * side * p * 0.22 * thin + ox, cy = y + sn * side * p * 0.22 * thin + oy;
          const a = rot + Math.PI / 2 - side * 0.5 * thin;
          const rx = p * 0.52 * tall, ry = p * 0.27 * scale * thin;
          g.moveTo(cx + Math.cos(a) * rx, cy + Math.sin(a) * rx);
          g.ellipse(cx, cy, rx, ry, a, 0, TAU);
        }
      }
    };
    const all: number[] = [];
    for (const ks of byColor.values()) all.push(...ks);
    g.fillStyle = 'rgba(70,30,30,0.28)';
    lobes(all, 1.02, 0, p * 0.1);
    g.fill();
    for (const [c, ks] of byColor) {
      g.fillStyle = c;
      lobes(ks, 1, 0, 0);
      g.fill();
    }
    g.fillStyle = 'rgba(255,255,255,0.28)';
    lobes(all, 0.55, -p * 0.05, -p * 0.1);
    g.fill();
    // Stretched loops thin out and pale: the yarn in them is pulled straight.
    if (tense.length) {
      const hi = tense.filter((k) => strain[k] > 0.14);
      g.fillStyle = 'rgba(255,248,240,0.22)';
      lobes(tense, 0.8, 0, 0);
      g.fill();
      if (hi.length) {
        g.fillStyle = 'rgba(255,248,240,0.3)';
        lobes(hi, 0.7, 0, 0);
        g.fill();
      }
    }
  }

  /** Where a float is caught behind another colour's stitch, a fleck of it peeks through (as in real fair isle). */
  private drawCatches() {
    const { g, sim: s, pitch: p, u } = this;
    const { pos, alive } = s;
    for (const st of s.strands) {
      if (st.done) continue;
      g.fillStyle = st.color;
      g.beginPath();
      for (let i = st.next + 1; i < st.stitches.length; i++)
        for (const k of st.catches[i]) {
          if (!alive[k]) continue;
          const x = this.sx(pos[k * 2]), y = this.sy(pos[k * 2 + 1] + 0.42);
          g.moveTo(x + p * 0.16, y);
          g.ellipse(x, y, p * 0.16, p * 0.08, 0, 0, TAU);
        }
      g.fill();
    }
    g.lineWidth = 1.2 * u;
    g.strokeStyle = 'rgba(60,30,30,0.35)';
    g.stroke();
  }

  /** The free yarn: spool -> caught floats -> front stitch. Sags when slack, straightens and pales as it tightens. */
  private drawStrand(i: number) {
    const { g, sim: s, pitch: p, u } = this;
    const st = s.strands[i];
    if (st.done) return;
    const [mx, my] = this.spoolMouth(i);
    g.lineCap = 'round';
    g.lineJoin = 'round';
    if (st.tail > 0) {
      // Loose end whipping in.
      const f = Math.min(1, st.tail / 12);
      const ex = mx + (this.sx(st.tailFrom[0]) - mx) * f, ey = my + (this.sy(st.tailFrom[1]) - my) * f;
      g.strokeStyle = st.color;
      g.lineWidth = Math.max(3 * u, p * 0.24);
      g.beginPath();
      g.moveTo(mx, my);
      g.quadraticCurveTo((mx + ex) / 2 + Math.sin(this.time * 30) * p * f, (my + ey) / 2, ex, ey);
      g.stroke();
      return;
    }
    const pts: number[] = [mx, my];
    for (const k of st.chain) pts.push(this.sx(s.pos[k * 2]), this.sy(s.pos[k * 2 + 1]));
    const tmax = Math.max(...st.tension);
    const taut = Math.min(1, tmax / T_HI);
    const path = () => {
      g.beginPath();
      g.moveTo(pts[0], pts[1]);
      for (let j = 0; j < st.chain.length; j++) {
        const x0 = pts[j * 2], y0 = pts[j * 2 + 1], x1 = pts[j * 2 + 2], y1 = pts[j * 2 + 3];
        const len = Math.hypot(x1 - x0, y1 - y0) / p;
        const slack = st.rest[j] - len;
        if (slack <= 0.02 || len < 1e-3) {
          g.lineTo(x1, y1);
          continue;
        }
        // Parabola with the segment's arc length: sag d = sqrt(3 s (L - s) / 8), drooping downward.
        const d = Math.min(6, Math.sqrt((3 * len * slack) / 8)) * p;
        g.quadraticCurveTo((x0 + x1) / 2, (y0 + y1) / 2 + 2 * d, x1, y1);
      }
    };
    const w = Math.max(3 * u, p * 0.26) * (1 - 0.3 * taut);
    g.strokeStyle = 'rgba(60,30,30,0.25)';
    g.lineWidth = w + 2 * u;
    path();
    g.stroke();
    g.strokeStyle = st.color;
    g.lineWidth = w;
    path();
    g.stroke();
    // Ply twist marks scroll with the yarn as it slides toward the spool; they whiten as it goes taut.
    g.strokeStyle = `rgba(255,255,255,${0.25 + 0.45 * taut})`;
    g.lineWidth = w * 0.4;
    g.setLineDash([p * 0.18, p * 0.32]);
    g.lineDashOffset = st.wound * p;
    path();
    g.stroke();
    g.setLineDash([]);
    // Catches the strand is dragging on: a knot mark that reddens as it takes the load.
    for (let j = 0; j + 1 < st.chain.length; j++) {
      const x = pts[j * 2 + 2], y = pts[j * 2 + 3];
      const load = Math.min(1, st.tension[j] / T_HI);
      g.fillStyle = `rgba(${Math.round(120 + 135 * load)},${Math.round(60 - 20 * load)},50,${0.5 + 0.4 * load})`;
      g.beginPath();
      g.arc(x, y, p * (0.16 + 0.1 * load + (st.jam === 'catch' ? 0.05 * Math.sin(this.time * 20) : 0)), 0, TAU);
      g.fill();
    }
    // The front stitch: a ring that tightens with the pull against its grip.
    const k = st.chain[st.chain.length - 1];
    if (st.holding) {
      const x = this.sx(s.pos[k * 2]), y = this.sy(s.pos[k * 2 + 1]);
      const tf = st.tension[st.tension.length - 1];
      const grip = s.grip(k, st.give);
      const f = Math.min(1, tf / Math.max(1, Math.min(grip, T_HI * 1.2)));
      g.strokeStyle = st.jam ? `rgba(220,60,50,${0.5 + 0.3 * Math.sin(this.time * 18)})` : `rgba(255,255,255,${0.4 + 0.5 * f})`;
      g.lineWidth = 2 * u;
      g.beginPath();
      g.arc(x, y, p * (0.75 - 0.25 * f), 0, TAU);
      g.stroke();
    }
  }

  private drawSpool(slot: number) {
    const s = this.sim;
    const st = s.strands[slot];
    const { g, u } = this;
    let [x, y, w, h] = this.spoolRect(slot);
    x += Math.sin(this.nope[slot] * 30) * this.nope[slot] * 6 * u;
    const t0 = st.holding ? Math.min(1, (st.tension[0] ?? 0) / T_HI) : 0;
    // A held spool sinks a little into the shelf and trembles with the load.
    if (st.holding) y += 3 * u + Math.sin(this.time * 70) * t0 * 1.2 * u;
    g.save();
    g.translate(x + w / 2, y + h / 2);
    const fw = w, fh = h * 0.13;
    const core = w * 0.42;
    const fill = Math.min(1, Math.max(0, st.wound) / st.total);
    const yw = core + (fw * 0.9 - core) * Math.sqrt(fill);
    g.fillStyle = '#e9c9a0';
    g.fillRect(-core / 2, -h / 2 + fh, core, h - 2 * fh);
    g.globalAlpha = 0.5;
    g.fillStyle = st.color;
    g.fillRect(-core / 2, -h / 2 + fh, core, h - 2 * fh);
    g.globalAlpha = 1;
    if (fill > 0) {
      g.fillStyle = st.color;
      g.beginPath();
      g.roundRect(-yw / 2, -h / 2 + fh, yw, h - 2 * fh, yw * 0.12);
      g.fill();
      g.save();
      g.clip();
      g.strokeStyle = 'rgba(0,0,0,0.16)';
      g.lineWidth = 1.5 * u;
      const step = 5 * u;
      const off = (this.spin[slot] * 3 * u) % step;
      for (let yy = -h / 2 + fh - step + off; yy < h / 2 - fh; yy += step) {
        g.beginPath();
        g.moveTo(-yw / 2, yy);
        g.lineTo(yw / 2, yy + step * 0.6);
        g.stroke();
      }
      const shine = g.createLinearGradient(-yw / 2, 0, yw / 2, 0);
      shine.addColorStop(0, 'rgba(0,0,0,0.22)');
      shine.addColorStop(0.35, 'rgba(255,255,255,0.22)');
      shine.addColorStop(1, 'rgba(0,0,0,0.25)');
      g.fillStyle = shine;
      g.fillRect(-yw / 2, -h / 2, yw, h);
      g.restore();
    }
    for (const fy of [-h / 2, h / 2 - fh]) {
      g.fillStyle = '#b87a4b';
      g.beginPath();
      g.roundRect(-fw / 2, fy, fw, fh, fh * 0.45);
      g.fill();
      g.fillStyle = st.color;
      g.globalAlpha = 0.55;
      g.beginPath();
      g.roundRect(-fw / 2 + 3 * u, fy + fh * 0.3, fw - 6 * u, fh * 0.4, fh * 0.2);
      g.fill();
      g.globalAlpha = 1;
    }
    // Tension gauge under the spool: how hard the winch is pulling right now.
    const gy = h / 2 + 12 * u;
    g.fillStyle = 'rgba(80,40,30,0.18)';
    g.beginPath();
    g.roundRect(-fw / 2, gy - 3 * u, fw, 6 * u, 3 * u);
    g.fill();
    if (st.done) {
      g.fillStyle = 'rgba(80,40,30,0.6)';
      g.font = `700 ${12 * u}px ui-rounded, system-ui, sans-serif`;
      g.textAlign = 'center';
      g.fillText('✓', 0, gy + 5 * u);
    } else if (t0 > 0) {
      g.fillStyle = t0 > 0.85 ? '#e0443a' : t0 > 0.5 ? '#f29a3a' : '#6bbf59';
      g.beginPath();
      g.roundRect(-fw / 2, gy - 3 * u, fw * t0, 6 * u, 3 * u);
      g.fill();
    }
    // A colour whose stitch is holding back the strand being reeled glows, and so does one whose float just sprang free.
    const blocking = s.strands.some((o) => o.holding && o.blocker === st.color);
    const glow = Math.max(this.flash[slot], blocking ? 0.5 + 0.5 * Math.sin(this.time * 8) : 0);
    if (glow > 0) {
      g.strokeStyle = `rgba(255,255,255,${glow * 0.9})`;
      g.lineWidth = 3 * u;
      g.beginPath();
      g.roundRect(-fw / 2 - 4 * u, -h / 2 - 4 * u, fw + 8 * u, h + 8 * u, 8 * u);
      g.stroke();
    }
    g.restore();
  }

  private drawPuffs() {
    const { g, pitch: p } = this;
    for (const q of this.puffs) {
      g.globalAlpha = q.life * 0.8;
      g.fillStyle = q.color;
      g.beginPath();
      g.arc(this.sx(q.x), this.sy(q.y), p * (0.08 + (1 - q.life) * 0.12), 0, TAU);
      g.fill();
    }
    g.globalAlpha = 1;
  }

  private drawHint() {
    if (this.everHeld) return;
    const { g, u } = this;
    const [x, y, w] = this.spoolRect(0);
    const bob = Math.sin(this.time * 4) * 4 * u;
    const text = 'hold a spool to reel';
    g.font = `600 ${13 * u}px ui-rounded, -apple-system, sans-serif`;
    const tw = g.measureText(text).width + 20 * u;
    const cx = Math.max(tw / 2 + 8 * u, x + w / 2), cy = y - 22 * u + bob;
    g.fillStyle = 'rgba(20,12,10,0.6)';
    g.beginPath();
    g.roundRect(cx - tw / 2, cy - 14 * u, tw, 28 * u, 14 * u);
    g.fill();
    g.fillStyle = '#f7e7d4';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText(text, cx, cy);
    g.textBaseline = 'alphabetic';
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.layout();
  }

  destroy() {
    this.trickle.stop();
    this.hiss.stop();
    this.ctx.progress(null);
  }
}

