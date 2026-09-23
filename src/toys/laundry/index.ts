import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { lookAt, multiply, normalize, perspective, projectPoint, dot, sub, type Mat4, type Vec3 } from '../cloth/math';
import { Laundry, type GarmentStyle } from './sim';
import { LaundryRenderer } from './render';

export const laundryToy: Toy = {
  id: 'laundry',
  title: 'Laundry Line',
  blurb: 'Swipe to blow a gust, hold for a storm. Clothespins pop and the washing flies away.',
  tech: 'XPBD cloth + rope · WebGL2',
  swatch: 'linear-gradient(150deg,#46a8ff,#5bc8e8 45%,#6cc44a)',
  refs: [
    {
      short: 'TMP #14',
      title: 'Ten Minute Physics #14 — cloth simulation',
      url: 'https://matthias-research.github.io/pages/tenMinutePhysics/index.html',
      use: 'Small-steps XPBD cloth: stretch, shear and bending distance constraints.',
    },
    {
      short: 'Macklin 2016',
      title: 'Macklin, Müller, Chentanez — XPBD (MIG 2016)',
      url: 'https://dl.acm.org/doi/10.1145/2994258.2994272',
      use: 'Compliant clothespins and rope: they stretch under load, then pop past a limit.',
    },
    {
      short: 'cloth-sim',
      title: 'FurkanZhlp — cloth-sim (browser XPBD cloth)',
      url: 'https://github.com/FurkanZhlp/cloth-sim',
      use: 'Per-triangle aerodynamic drag on the side facing the wind.',
    },
    {
      short: 'Knit research',
      title: 'bobo research — Laundry Line toy idea',
      url: 'https://github.com/polats/bobo/blob/main/docs/research/cloth-knitting.md',
      use: 'The design brief: pegs that break, gusts, tearable washing.',
    },
  ],
  async create(ctx) {
    return new LaundryLine(ctx);
  },
};

type Palette = 'sunny' | 'pastel' | 'bold';

const PALETTES: Record<Palette, GarmentStyle[]> = {
  sunny: [
    { pattern: 1, a: [0.9, 0.18, 0.2], b: [0.95, 0.93, 0.88] },
    { pattern: 3, a: [0.98, 0.78, 0.1], b: [0.95, 0.4, 0.1] },
    { pattern: 3, a: [0.98, 0.78, 0.1], b: [0.95, 0.4, 0.1] },
    { pattern: 2, a: [0.95, 0.95, 0.92], b: [0.2, 0.45, 0.85] },
    { pattern: 4, a: [0.1, 0.62, 0.62], b: [0.97, 0.95, 0.9] },
  ],
  pastel: [
    { pattern: 0, a: [0.95, 0.72, 0.8], b: [1, 1, 1] },
    { pattern: 1, a: [0.72, 0.85, 0.98], b: [1, 1, 1] },
    { pattern: 1, a: [0.72, 0.85, 0.98], b: [1, 1, 1] },
    { pattern: 3, a: [0.98, 0.96, 0.85], b: [0.75, 0.9, 0.72] },
    { pattern: 4, a: [0.85, 0.78, 0.98], b: [1, 1, 1] },
  ],
  bold: [
    { pattern: 0, a: [0.1, 0.12, 0.2], b: [1, 1, 1] },
    { pattern: 2, a: [0.9, 0.1, 0.35], b: [0.1, 0.1, 0.1] },
    { pattern: 2, a: [0.9, 0.1, 0.35], b: [0.1, 0.1, 0.1] },
    { pattern: 1, a: [1.0, 0.55, 0.0], b: [0.05, 0.3, 0.6] },
    { pattern: 3, a: [0.05, 0.55, 0.3], b: [1.0, 0.95, 0.4] },
  ],
};

class LaundryLine implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private sim!: Laundry;
  private renderer!: LaundryRenderer;
  private width = 1;
  private height = 1;
  private view!: Mat4;
  private proj!: Mat4;
  private viewProj!: Mat4;
  private eye: Vec3 = [0, 0, 3];
  private horizon = 0.3;
  private grabs = new Map<number, number>();
  private blowers = new Set<number>();

  readonly cfg = {
    palette: 'sunny' as Palette,
    breeze: 2.5,
    gust: 1,
    pinStrength: 1,
    tear: 2.2,
    substeps: 10,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.buildPanel();
    this.rebuild();
  }

  private rebuild() {
    this.sim = new Laundry(PALETTES[this.cfg.palette]);
    this.sync();
    this.renderer = new LaundryRenderer(this.gl, this.sim);
    this.grabs.clear();
    this.updateCamera();
  }

  private sync() {
    const s = this.sim.cfg;
    s.breeze = this.cfg.breeze;
    s.pinStrength = this.cfg.pinStrength;
    s.tear = this.cfg.tear >= 4 ? 0 : this.cfg.tear;
    s.substeps = this.cfg.substeps;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.slider(c, 'breeze', { label: 'Breeze', min: 0, max: 10, step: 0.1, onChange: () => this.sync() });
    panel.slider(c, 'gust', { label: 'Swipe gust strength', min: 0.2, max: 3, step: 0.1 });
    panel.slider(c, 'pinStrength', { label: 'Clothespin grip', min: 0.3, max: 4, step: 0.05, onChange: () => this.sync() });
    panel.slider(c, 'tear', { label: 'Fabric toughness (4 = unbreakable)', min: 1.3, max: 4, step: 0.05, onChange: () => this.sync() });
    panel.slider(c, 'substeps', { label: 'Substeps', min: 4, max: 24, step: 1, onChange: () => this.sync() });
    panel.choice<Palette>(
      'Washing',
      [
        { value: 'sunny', label: 'Sunny' },
        { value: 'pastel', label: 'Pastel' },
        { value: 'bold', label: 'Bold' },
      ],
      c.palette,
      (v) => {
        c.palette = v;
        this.rebuild();
      },
    );
    panel.action('Hang the washing again', () => this.rebuild());
  }

  private updateCamera() {
    const aspect = this.width / this.height;
    const fov = (48 * Math.PI) / 180;
    // Fit the line's full width, and the grass below, whatever the orientation.
    const w = 2.5;
    const h = 2.4;
    const need = Math.max(h, w / aspect) / (2 * Math.tan(fov / 2));
    const target: Vec3 = [0, 0.05, 0];
    this.eye = [0, 0.2, need];
    this.view = lookAt(this.eye, target, [0, 1, 0]);
    this.proj = perspective(fov, aspect, 0.05, 40);
    this.viewProj = multiply(this.proj, this.view);
    this.horizon = projectPoint(this.viewProj, 0, this.sim.floorY, -12)[1];
  }

  frame(dt: number, t: number) {
    this.handleInput(dt);
    const t0 = performance.now();
    this.sim.step(dt, t);
    this.sim.retireLost();
    const simMs = performance.now() - t0;
    if (this.sim.poppedThisFrame) this.ctx.haptic('medium');
    else if (this.sim.tornThisFrame) this.ctx.haptic('light');
    this.renderer.draw(this.width, this.height, this.view, this.proj, this.viewProj, this.eye, this.horizon, t);
    this.ctx.setStatus(`${this.sim.onLine}/${this.sim.garments.length} on the line · ${this.sim.n} particles · sim ${simMs.toFixed(1)}ms`);
  }

  private handleInput(dt: number) {
    const s = this.sim;
    const aspect = this.width / this.height;
    for (const p of this.ctx.pointers.active.values()) {
      if (p.justDown) {
        const idx = this.pick(p.x, p.y);
        if (idx >= 0) {
          this.grabs.set(p.id, idx);
          this.ctx.haptic('light');
        } else this.blowers.add(p.id);
      }
      const idx = this.grabs.get(p.id);
      if (idx !== undefined) {
        const target = this.unproject(p.x, p.y, idx);
        if (idx === [...this.grabs.values()][0]) {
          s.grabbed = idx;
          s.grabTarget = target;
        } else if (s.invMass[idx] > 0) {
          s.pos.set(target, idx * 3);
          s.vel.fill(0, idx * 3, idx * 3 + 3);
        }
        continue;
      }
      if (!this.blowers.has(p.id)) continue;
      // Swipe: a gust along the swipe. Holding still: a storm that keeps building.
      const k = this.cfg.gust / Math.max(dt, 1 / 120);
      const sx = p.dx * aspect * k * 1.2;
      const sy = p.dy * k * 1.2;
      s.gust[0] += clamp(sx, -3, 3);
      s.gust[1] += clamp(sy, -2, 2);
      const speed = Math.hypot(p.dx, p.dy) / dt;
      if (p.held > 0.35 && speed < 0.3) {
        const dir = p.x < 0.5 ? 1 : -1;
        s.gust[0] += dir * this.cfg.gust * Math.min(3, p.held) * 6 * dt;
        s.gust[2] += Math.sin(p.held * 5) * 2 * dt;
      }
      const g = Math.hypot(s.gust[0], s.gust[1], s.gust[2]);
      if (g > 12) {
        s.gust[0] *= 12 / g;
        s.gust[1] *= 12 / g;
        s.gust[2] *= 12 / g;
      }
    }
    for (const id of [...this.grabs.keys()]) if (!this.ctx.pointers.active.has(id)) this.grabs.delete(id);
    for (const id of [...this.blowers]) if (!this.ctx.pointers.active.has(id)) this.blowers.delete(id);
    s.grabbed = this.grabs.size ? [...this.grabs.values()][0] : -1;
  }

  private pick(x: number, y: number) {
    const s = this.sim;
    const aspect = this.width / this.height;
    let best = -1;
    let bestD = 0.05 * 0.05;
    for (let i = s.ropeCount; i < s.n; i++) {
      if (s.invMass[i] === 0) continue;
      const [sx, sy] = projectPoint(this.viewProj, s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]);
      const dx = (sx - x) * Math.min(1, aspect);
      const dy = (sy - y) / Math.max(1, aspect);
      const d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private unproject(x: number, y: number, idx: number): Vec3 {
    const s = this.sim;
    const p: Vec3 = [s.pos[idx * 3], s.pos[idx * 3 + 1], s.pos[idx * 3 + 2]];
    const v = this.view;
    const right: Vec3 = [v[0], v[4], v[8]];
    const up: Vec3 = [v[1], v[5], v[9]];
    const back: Vec3 = [v[2], v[6], v[10]];
    const nx = (x * 2 - 1) / this.proj[0];
    const ny = (y * 2 - 1) / this.proj[5];
    const dir = normalize([right[0] * nx + up[0] * ny - back[0], right[1] * nx + up[1] * ny - back[1], right[2] * nx + up[2] * ny - back[2]]);
    const fwd: Vec3 = [-back[0], -back[1], -back[2]];
    const t = dot(sub(p, this.eye), fwd) / dot(dir, fwd);
    return [this.eye[0] + dir[0] * t, this.eye[1] + dir[1] * t, this.eye[2] + dir[2] * t];
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.updateCamera();
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
