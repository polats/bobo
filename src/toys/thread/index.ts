import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop } from '../../shell/sound';
import { Knit, type Size } from './sim';
import { KnitRenderer, PALETTES, rowColor } from './render';
import { lookAt, multiply, normalize, perspective, projectPoint, sub, dot, type Mat4, type Vec3 } from '../cloth/math';

export const threadToy: Toy = {
  id: 'thread',
  title: 'Pull the Thread',
  blurb: 'Grab the loose end of a chunky knit and unravel it stitch by stitch into a pile of crinkly yarn.',
  tech: 'Stitch grid + XPBD yarn · WebGL2',
  swatch: 'linear-gradient(135deg,#9e1437,#f0dcc0 50%,#5c1a5c)',
  refs: [
    {
      short: 'Yuksel 2012',
      title: 'Yuksel et al. — Stitch Meshes for Modeling Knitted Clothing (SIGGRAPH 2012)',
      url: 'https://www.cemyuksel.com/research/stitchmeshes/',
      use: 'The idea of a stitch-level mesh whose row order defines how the garment unravels.',
    },
    {
      short: 'Kaldor 2008',
      title: 'Kaldor, Marschner, James — Simulating Knitted Cloth at the Yarn Level (SIGGRAPH 2008)',
      url: 'https://www.cs.cornell.edu/~srm/publications/SG08-knit-lr.pdf',
      use: 'Their yarn end is glued to stop unravelling; here the glue is the tension threshold.',
    },
    {
      short: 'Macklin 2016',
      title: 'Macklin, Müller, Chentanez — XPBD (MIG 2016)',
      url: 'https://dl.acm.org/doi/10.1145/2994258.2994272',
      use: 'One solver for the knit (anisotropic compliance) and the yarn strand.',
    },
    {
      short: 'Sperl 2021',
      title: 'Sperl, Narain, Wojtan — Mechanics-Aware Deformation of Yarn Pattern Geometry (SIGGRAPH 2021)',
      url: 'https://visualcomputing.ist.ac.at/publications/2021/MADYPG/',
      use: 'Inspiration for faking yarn loops on a coarse cloth; we draw the stitch loops in the shader.',
    },
    {
      short: 'Unravel',
      title: 'Unravel (Coldwood / EA, 2016)',
      url: 'https://store.steampowered.com/app/1225560/Unravel/',
      use: 'Feel reference for a finite, tuggable yarn trail.',
    },
  ],
  async create(ctx) {
    return new PullTheThread(ctx);
  },
};

type PaletteName = keyof typeof PALETTES;

class PullTheThread implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private sim!: Knit;
  private renderer!: KnitRenderer;
  private width = 1;
  private height = 1;
  private view!: Mat4;
  private proj!: Mat4;
  private viewProj!: Mat4;
  private eye: Vec3 = [0, 0, 3];
  private baseEye: Vec3 = [0, 0, 3];
  private baseTarget: Vec3 = [0, 0, 0];
  private nudge = { x: 0, y: 0, vx: 0, vy: 0 };
  private grabs = new Map<number, { kind: 'rod' | 'cloth'; idx: number }>();
  private hint: HTMLElement;
  private popped = 0;
  /** Yarn rasping through the loops while it's pulled free. */
  private slideLoop: Loop;
  private lastYarn = 0;
  /** Smoothed stitches-per-second, so ticks climb in pitch as you zip faster. */
  private popRate = 0;
  private slide = 0;

  readonly cfg = {
    size: 'small' as Size,
    palette: 'berry' as PaletteName,
    threshold: 0.015,
    crimp: 0.6,
    gravity: 12,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.slideLoop = ctx.sound.loop('hiss');
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.hint = document.createElement('div');
    this.hint.textContent = 'pull me ↓';
    Object.assign(this.hint.style, {
      position: 'absolute', zIndex: '3', pointerEvents: 'none', padding: '6px 10px', borderRadius: '99px',
      background: 'rgba(20,12,10,0.6)', color: '#f7e7d4', font: '600 13px/1 ui-rounded, -apple-system, sans-serif',
      transform: 'translate(-50%, -50%)', whiteSpace: 'nowrap',
    });
    ctx.overlay.appendChild(this.hint);
    this.buildPanel();
    this.rebuild();
    if (import.meta.env.DEV) {
      // Dev-only probe for headless tests: loose end in CSS pixels, and stitch count.
      (window as unknown as Record<string, unknown>).__thread = () => {
        const s = this.sim;
        const css = (i: number) => {
          const [x, y] = projectPoint(this.viewProj, s.rpos[i * 3], s.rpos[i * 3 + 1], s.rpos[i * 3 + 2]);
          return { x: x * this.ctx.canvas.clientWidth, y: (1 - y) * this.ctx.canvas.clientHeight };
        };
        return { ...css(0), near: css(Math.max(0, s.rn - 4)), left: s.stitchesLeft, rn: s.rn, frozen: s.rfrozen.subarray(0, s.rn).reduce((a, b) => a + b, 0) };
      };
      (window as unknown as Record<string, unknown>).__threadPop = (n: number) => {
        for (let i = 0; i < n; i++) this.sim.pop();
      };
    }
  }

  private rebuild() {
    this.renderer?.destroy();
    this.sim = new Knit(this.cfg.size);
    this.sync();
    this.renderer = new KnitRenderer(this.gl, this.sim);
    this.renderer.palette = PALETTES[this.cfg.palette];
    this.grabs.clear();
    this.popped = 0;
    this.lastYarn = this.sim.yarnLength;
    this.popRate = 0;
    this.slide = 0;
    this.hint.style.display = '';
    this.updateCamera();
  }

  private sync() {
    const s = this.sim.cfg;
    s.threshold = this.cfg.threshold;
    s.crimp = this.cfg.crimp;
    s.gravity = this.cfg.gravity;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice<Size>('Garment', [{ value: 'small', label: 'Swatch' }, { value: 'medium', label: 'Big scarf' }], c.size, (v) => {
      c.size = v;
      this.rebuild();
    });
    panel.choice<PaletteName>(
      'Wool',
      (Object.keys(PALETTES) as PaletteName[]).map((k) => ({ value: k, label: k[0].toUpperCase() + k.slice(1) })),
      c.palette,
      (v) => {
        c.palette = v;
        this.renderer.palette = PALETTES[v];
      },
    );
    panel.slider(c, 'threshold', { label: 'Knot tightness', min: 0, max: 0.1, step: 0.005, onChange: () => this.sync() });
    panel.slider(c, 'crimp', { label: 'Yarn crinkle', min: 0, max: 1, step: 0.05, onChange: () => this.sync() });
    panel.slider(c, 'gravity', { label: 'Gravity', min: 2, max: 25, step: 0.5, onChange: () => this.sync() });
    panel.action('Re-knit', () => this.rebuild());
  }

  private updateCamera() {
    const aspect = this.width / this.height;
    const fov = (50 * Math.PI) / 180;
    const target: Vec3 = [0, -0.2, -0.05];
    const need = Math.max(2.55, 1.55 / aspect) / (2 * Math.tan(fov / 2));
    this.baseTarget = target;
    this.baseEye = [0, target[1] + need * 0.3, need];
    this.proj = perspective(fov, aspect, 0.05, 30);
    this.applyCamera();
  }

  private applyCamera() {
    const n = this.nudge;
    this.eye = [this.baseEye[0] + n.x, this.baseEye[1] + n.y, this.baseEye[2]];
    const target: Vec3 = [this.baseTarget[0] + n.x * 0.5, this.baseTarget[1] + n.y * 0.5, this.baseTarget[2]];
    this.view = lookAt(this.eye, target, [0, 1, 0]);
    this.viewProj = multiply(this.proj, this.view);
  }

  frame(dt: number) {
    const s = this.sim;
    this.handleInput();
    const t0 = performance.now();
    s.step(dt);
    const simMs = performance.now() - t0;

    // Juice: puffs + a tick per stitch, a bump when a row completes.
    for (const [x, y, z, row] of s.popEvents) this.renderer.burst(x, y, z, rowColor(this.renderer.palette, row));
    if (s.popsThisFrame) {
      this.popped += s.popsThisFrame;
      this.ctx.haptic(s.popsThisFrame > 2 ? 'medium' : 'light');
      this.hint.style.display = 'none';
      // One tick per frame for however many stitches let go, placed at the last one.
      const [x, y, z] = s.popEvents[s.popEvents.length - 1] ?? [0, 0, 0];
      const sx = projectPoint(this.viewProj, x, y, z)[0];
      const k = Math.min(1, this.popRate / 30);
      this.ctx.sound.play('tick', { gain: Math.min(0.7, 0.3 + s.popsThisFrame * 0.1), pitch: 0.9 + k * 0.9, pan: (sx - 0.5) * 1.2 });
      if (!s.stitchesLeft) {
        // The very last loop pulls free.
        this.ctx.sound.play('snap', { gain: 0.6, pitch: 1.2 });
        this.ctx.sound.play('chime', { gain: 0.5 });
      }
    }
    if (dt > 0) this.popRate += (s.popsThisFrame / dt - this.popRate) * Math.min(1, dt * 6);
    // Freed yarn sliding out of the knit: level from how fast the strand is growing.
    const yarn = s.yarnLength;
    if (dt > 0) this.slide += (Math.max(0, yarn - this.lastYarn) / dt - this.slide) * Math.min(1, dt * 5);
    this.lastYarn = yarn;
    const slide = this.slide;
    const pulling = s.grabbedRod >= 0 ? Math.min(1, Math.max(0, s.tension - 0.9) * 4) : 0;
    this.slideLoop.set(Math.min(0.6, slide * 0.6 + pulling * 0.08), 0.15 + Math.min(0.5, slide * 0.3));
    if (s.rowsThisFrame) {
      this.nudge.vy -= 0.9;
      this.nudge.vx += (Math.random() - 0.5) * 0.6;
      this.ctx.haptic('heavy');
      this.ctx.sound.play('thud', { gain: 0.45, pitch: 1.2 });
    }
    const n = this.nudge;
    n.vx += (-n.x * 90 - n.vx * 12) * dt;
    n.vy += (-n.y * 90 - n.vy * 12) * dt;
    n.x += n.vx * dt;
    n.y += n.vy * dt;
    this.applyCamera();

    this.renderer.draw(this.width, this.height, this.viewProj, this.eye, dt);
    this.placeHint();
    const left = s.stitchesLeft;
    this.ctx.setStatus(
      `${left ? `${left} stitches left` : 'all unravelled — Re-knit in Tune'} · ${(s.yarnLength * 0.3).toFixed(1)} m of yarn · sim ${simMs.toFixed(1)}ms`,
    );
  }

  private placeHint() {
    if (this.hint.style.display === 'none' || this.sim.rn === 0) return;
    const [x, y] = projectPoint(this.viewProj, this.sim.rpos[0], this.sim.rpos[1], this.sim.rpos[2]);
    const cssW = this.ctx.canvas.clientWidth;
    const cssH = this.ctx.canvas.clientHeight;
    this.hint.style.left = `${Math.min(cssW - 50, Math.max(50, x * cssW + 40))}px`;
    this.hint.style.top = `${(1 - y) * cssH + Math.sin(performance.now() / 250) * 4}px`;
  }

  private handleInput() {
    const s = this.sim;
    let rodDriver: { id: number; idx: number } | null = null;
    let clothDriver: { id: number; idx: number } | null = null;
    for (const p of this.ctx.pointers.active.values()) {
      let g = this.grabs.get(p.id);
      if (p.justDown) {
        const picked = this.pick(p.x, p.y);
        if (!picked) continue;
        g = picked;
        this.grabs.set(p.id, g);
        if (g.kind === 'rod') s.unfreezeAll();
        this.ctx.haptic('light');
        this.ctx.sound.play('tick', { gain: 0.25, pitch: g.kind === 'rod' ? 1.3 : 0.8, pan: (p.x - 0.5) * 1.2 });
      }
      if (!g) continue;
      // One finger can pull the yarn while another holds the knit: the natural two-handed unravel.
      if (g.kind === 'rod' && !rodDriver) {
        rodDriver = { id: p.id, idx: g.idx };
        s.grabTarget = this.unproject(p.x, p.y, s.rpos, g.idx);
      } else if (g.kind === 'cloth' && !clothDriver) {
        clothDriver = { id: p.id, idx: g.idx };
        s.clothTarget = this.unproject(p.x, p.y, s.pos, g.idx);
      }
    }
    for (const id of [...this.grabs.keys()]) if (!this.ctx.pointers.active.has(id)) this.grabs.delete(id);
    s.grabbedRod = rodDriver ? rodDriver.idx : -1;
    s.grabbedCloth = clothDriver ? clothDriver.idx : -1;
  }

  /** Yarn first (the loose end wins ties), then the knit; nothing nearby means nothing happens. */
  private pick(x: number, y: number): { kind: 'rod' | 'cloth'; idx: number } | null {
    const s = this.sim;
    const aspect = this.width / this.height;
    const dist = (px: number, py: number, pz: number) => {
      const [sx, sy] = projectPoint(this.viewProj, px, py, pz);
      const dx = (sx - x) * Math.min(1, aspect);
      const dy = (sy - y) / Math.max(1, aspect);
      return dx * dx + dy * dy;
    };
    let best: { kind: 'rod' | 'cloth'; idx: number } | null = null;
    let bestD = 0.055 * 0.055;
    const d0 = dist(s.rpos[0], s.rpos[1], s.rpos[2]);
    if (d0 < 0.08 * 0.08) return { kind: 'rod', idx: 0 };
    for (let i = 0; i < s.rn; i++) {
      const d = dist(s.rpos[i * 3], s.rpos[i * 3 + 1], s.rpos[i * 3 + 2]);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'rod', idx: i };
      }
    }
    if (best) return best;
    bestD = 0.06 * 0.06;
    for (let i = 0; i < s.np; i++) {
      if (!s.partAlive[i] || s.pinned[i]) continue;
      const d = dist(s.pos[i * 3], s.pos[i * 3 + 1], s.pos[i * 3 + 2]);
      if (d < bestD) {
        bestD = d;
        best = { kind: 'cloth', idx: i };
      }
    }
    return best;
  }

  private unproject(x: number, y: number, src: Float32Array, idx: number): Vec3 {
    const p: Vec3 = [src[idx * 3], src[idx * 3 + 1], src[idx * 3 + 2]];
    const dir = this.rayDir(x, y);
    const fwd: Vec3 = [-this.view[2], -this.view[6], -this.view[10]];
    const t = dot(sub(p, this.eye), fwd) / dot(dir, fwd);
    const q: Vec3 = [this.eye[0] + dir[0] * t, this.eye[1] + dir[1] * t, this.eye[2] + dir[2] * t];
    // Don't let the finger drag yarn through the table.
    q[1] = Math.max(q[1], this.sim.floorY + this.sim.yarnR);
    return q;
  }

  private rayDir(x: number, y: number): Vec3 {
    const v = this.view;
    const tanY = 1 / this.proj[5];
    const tanX = 1 / this.proj[0];
    const nx = (x * 2 - 1) * tanX;
    const ny = (y * 2 - 1) * tanY;
    return normalize([v[0] * nx + v[1] * ny - v[2], v[4] * nx + v[5] * ny - v[6], v[8] * nx + v[9] * ny - v[10]]);
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.updateCamera();
  }

  destroy() {
    this.slideLoop.stop();
    this.renderer.destroy();
    this.hint.remove();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
