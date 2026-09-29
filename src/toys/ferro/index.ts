import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { lookAt, multiply, normalize, perspective, type Mat4, type Vec3 } from '../cloth/math';
import { Ferro, type Magnet } from './sim';
import { FerroRenderer, type Theme } from './render';
import type { Loop } from '../../shell/sound';

export const ferroToy: Toy = {
  id: 'ferro',
  title: 'Ferro Blob',
  blurb: 'Glossy black magnetic liquid. Drag the magnet and it bristles into spikes; tap to drip more in.',
  tech: 'Particle liquid + Rosensweig spikes · WebGL2',
  swatch: 'linear-gradient(140deg,#0b0b12,#3b2a6b 45%,#18c6e0)',
  refs: [
    {
      short: '2MP ferrofluids',
      title: 'Two Minute Papers — Building A Liquid Labyrinth! (surface-only ferrofluids)',
      url: 'https://www.youtube.com/watch?v=nJ86LCA0Asw',
      use: 'The look we are chasing: spiky, mirror-black liquid that crawls toward a magnet.',
    },
    {
      short: '2MP large-scale',
      title: 'Two Minute Papers — How Can This Liquid Climb? (large-scale ferrofluids)',
      url: 'https://www.youtube.com/watch?v=goD36hVVl7M',
      use: 'Reference for the spike lattice and how it leans and climbs along the field.',
    },
    {
      short: 'Rosensweig',
      title: 'The Amplitude Equation for the Rosensweig Instability in Magnetic Fluids and Gels (arXiv 1101.3742)',
      url: 'https://arxiv.org/abs/1101.3742',
      use: 'Spikes appear in a hexagonal pattern once the field passes a critical strength; we use a hex lattice with a threshold.',
    },
    {
      short: 'Clavet 2005',
      title: 'Clavet, Beaudoin, Poulin — Particle-based Viscoelastic Fluid Simulation (SCA 2005)',
      url: 'https://dl.acm.org/doi/10.1145/1073368.1073400',
      use: 'Double-density relaxation for the puddle: cohesive, blobby 2D liquid with surface tension.',
    },
  ],
  async create(ctx) {
    return new FerroBlob(ctx);
  },
};

interface Finger {
  magnet: Magnet;
  moved: number;
  born: number;
}

class FerroBlob implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private sim = new Ferro();
  private renderer: FerroRenderer;
  private width = 1;
  private height = 1;
  private view!: Mat4;
  private proj!: Mat4;
  private viewProj!: Mat4;
  private invView!: Mat4;
  private eye: Vec3 = [0, 2, 2];
  private fingers = new Map<number, Finger>();
  private tickClock = 0;
  // Sound: a low magnetic hum that swells with field strength and spike count and brightens
  // as the magnet moves; squishes as spikes bristle up or slump back.
  private hum: Loop;
  private motion = 0;
  private lastSpikes = 0;
  private lastDropX = 0;

  readonly cfg = {
    theme: 'chrome' as Theme,
    strength: 1,
    baseMagnet: 0.55,
    amount: 620,
    viscosity: 0.35,
    tension: 1,
    sharpness: 1,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    if (!gl.getExtension('EXT_color_buffer_half_float')) gl.getExtension('EXT_color_buffer_float');
    this.gl = gl;
    this.hum = ctx.sound.loop('rumble');
    this.renderer = new FerroRenderer(gl);
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.buildPanel();
    this.sync();
    this.updateCamera();
  }

  private sync() {
    const s = this.sim.cfg;
    s.strength = this.cfg.strength;
    s.baseMagnet = this.cfg.baseMagnet;
    s.viscosity = this.cfg.viscosity;
    s.tension = this.cfg.tension;
    s.sharpness = this.cfg.sharpness;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice<Theme>(
      'Liquid',
      [
        { value: 'chrome', label: 'Black chrome' },
        { value: 'gold', label: 'Gold' },
        { value: 'oil', label: 'Oil slick' },
      ],
      c.theme,
      (v) => (c.theme = v),
    );
    panel.slider(c, 'strength', { label: 'Magnet strength', min: 0.3, max: 2.5, step: 0.05, onChange: () => this.sync() });
    panel.slider(c, 'baseMagnet', { label: 'Magnet under the dish', min: 0, max: 1.4, step: 0.05, onChange: () => this.sync() });
    panel.slider(c, 'amount', { label: 'Amount of fluid', min: 200, max: 1300, step: 10, onChange: (v) => this.sim.setAmount(v) });
    panel.slider(c, 'viscosity', { label: 'Viscosity', min: 0, max: 1.5, step: 0.05, onChange: () => this.sync() });
    panel.slider(c, 'tension', { label: 'Surface tension', min: 0.3, max: 2.5, step: 0.05, onChange: () => this.sync() });
    panel.slider(c, 'sharpness', { label: 'Spike sharpness', min: 0.5, max: 2.5, step: 0.05, onChange: () => this.sync() });
    panel.action('Reset', () => {
      this.sim.cfg.amount = c.amount;
      this.sim.reset();
    });
  }

  private updateCamera() {
    const aspect = this.width / this.height;
    const fov = (38 * Math.PI) / 180;
    // Fit the dish (plus lip) across the width in portrait; the view looks down at ~52°.
    const fitW = 2.28 / aspect;
    const fitH = 2.2;
    const dist = Math.max(fitW, fitH) / (2 * Math.tan(fov / 2));
    const elev = (60 * Math.PI) / 180;
    const target: Vec3 = [0, 0, 0.06];
    this.eye = [0, target[1] + Math.sin(elev) * dist, target[2] + Math.cos(elev) * dist];
    this.view = lookAt(this.eye, target, [0, 1, 0]);
    this.proj = perspective(fov, aspect, 0.05, 40);
    this.viewProj = multiply(this.proj, this.view);
    this.invView = invertRigid(this.view);
  }

  /** Pointer (uv, y up) → point on the dish plane y = 0. */
  private toDish(x: number, y: number): [number, number] {
    const v = this.view;
    const right: Vec3 = [v[0], v[4], v[8]];
    const up: Vec3 = [v[1], v[5], v[9]];
    const back: Vec3 = [v[2], v[6], v[10]];
    const nx = (x * 2 - 1) / this.proj[0];
    const ny = (y * 2 - 1) / this.proj[5];
    const d = normalize([right[0] * nx + up[0] * ny - back[0], right[1] * nx + up[1] * ny - back[1], right[2] * nx + up[2] * ny - back[2]]);
    const t = -this.eye[1] / d[1];
    let px = this.eye[0] + d[0] * t;
    let pz = this.eye[2] + d[2] * t;
    const r = Math.hypot(px, pz);
    if (r > 0.98) {
      px *= 0.98 / r;
      pz *= 0.98 / r;
    }
    return [px, pz];
  }

  frame(dt: number, t: number) {
    const ptrs = this.ctx.pointers.active;
    let travel = 0;
    for (const p of ptrs.values()) {
      const [x, z] = this.toDish(p.x, p.y);
      let f = this.fingers.get(p.id);
      if (!f) {
        f = { magnet: { x, z, strength: 0 }, moved: 0, born: t };
        this.fingers.set(p.id, f);
        this.ctx.haptic('light');
      }
      const step = Math.hypot(x - f.magnet.x, z - f.magnet.z);
      f.moved += step;
      travel += step;
      f.magnet.x = x;
      f.magnet.z = z;
      // Holding builds the field up; it eases in so spikes rise rather than pop instantly.
      const target = 0.9 + 0.8 * Math.min(1, p.held / 1.5);
      f.magnet.strength += (target - f.magnet.strength) * Math.min(1, dt * 6);
    }
    for (const [id, f] of [...this.fingers]) {
      if (ptrs.has(id)) continue;
      // A quick still tap drips more ferrofluid in.
      if (t - f.born < 0.25 && f.moved < 0.05) {
        this.sim.dropAt(f.magnet.x, f.magnet.z);
        this.lastDropX = f.magnet.x;
      }
      this.fingers.delete(id);
    }
    const magnets = [...this.fingers.values()].map((f) => f.magnet);
    const t0 = performance.now();
    this.sim.step(dt, magnets);
    const ms = performance.now() - t0;

    this.tickClock += dt;
    const snaps = this.sim.snapsThisFrame;
    if (this.sim.landedThisFrame) {
      this.ctx.haptic('medium');
      // A heavy, thick blob landing: low plop with a wet squelch under it.
      this.ctx.sound.play('plop', { pitch: 0.55, gain: 0.7, pan: this.lastDropX * 0.8 });
      this.ctx.sound.play('squish', { pitch: 0.7, gain: 0.5, pan: this.lastDropX * 0.8 });
    } else if (snaps >= 2 && this.tickClock > 0.06) {
      this.tickClock = 0;
      this.ctx.haptic(snaps > 8 ? 'medium' : 'light');
      // Spikes bristling up: a tight, high squish, fuller when many rise at once.
      this.ctx.sound.play('squish', { pitch: 1.6 - Math.min(snaps, 20) * 0.03, gain: Math.min(0.6, 0.15 + snaps * 0.03), pan: this.magnetPan() });
    }

    let spikes = 0;
    for (let i = 0; i < this.sim.nCells; i++) if (this.sim.amp[i] > 0.03) spikes++;
    // Many spikes vanishing at once (magnet lifted) slump back with a low squelch.
    const lost = this.lastSpikes - spikes;
    if (lost > 6 && this.tickClock > 0.06) {
      this.tickClock = 0;
      this.ctx.sound.play('squish', { pitch: 0.6, gain: Math.min(0.5, lost * 0.03) });
    }
    this.lastSpikes = spikes;
    let field = 0;
    for (const m of magnets) field += m.strength;
    this.motion += (Math.min(1, travel / Math.max(dt, 1e-3) / 2) - this.motion) * Math.min(1, dt * 6);
    // Only a held magnet hums; the resting dish (base magnet alone) stays silent.
    const level = magnets.length ? Math.min(1, field * 0.2 + Math.min(1, spikes / 40) * 0.25 + this.motion * 0.3) : 0;
    this.hum.set(level * 0.45, 0.15 + this.motion * 0.5);

    this.renderer.draw(
      this.sim,
      this.width,
      this.height,
      this.view,
      this.proj,
      this.viewProj,
      this.invView,
      this.eye,
      magnets,
      this.sim.drops,
      this.cfg.theme,
      t,
    );
    this.ctx.setStatus(`${this.sim.n} particles · ${spikes} spikes · sim ${ms.toFixed(1)}ms`);
  }

  private magnetPan() {
    let x = 0;
    for (const f of this.fingers.values()) x += f.magnet.x;
    return this.fingers.size ? (x / this.fingers.size) * 0.8 : 0;
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.updateCamera();
  }

  destroy() {
    this.hum.stop();
    this.renderer.destroy();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Inverse of a rotation + translation view matrix (column-major). */
function invertRigid(m: Mat4): Mat4 {
  const o = new Float32Array(16);
  // Transpose the 3×3 rotation.
  o[0] = m[0]; o[1] = m[4]; o[2] = m[8];
  o[4] = m[1]; o[5] = m[5]; o[6] = m[9];
  o[8] = m[2]; o[9] = m[6]; o[10] = m[10];
  const tx = m[12], ty = m[13], tz = m[14];
  o[12] = -(o[0] * tx + o[4] * ty + o[8] * tz);
  o[13] = -(o[1] * tx + o[5] * ty + o[9] * tz);
  o[14] = -(o[2] * tx + o[6] * ty + o[10] * tz);
  o[15] = 1;
  return o;
}
