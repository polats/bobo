import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Cloth, type Scene } from './sim';
import { ClothRenderer, type Fabric, type TrailPoint } from './render';
import { lookAt, multiply, normalize, perspective, projectPoint, sub, dot, type Mat4, type Vec3 } from './math';

export const clothToy: Toy = {
  id: 'cloth',
  title: 'Tear Sheet',
  blurb: 'Pull a curtain until it rips, slash it with a swipe, throw balls through a flag or onto a hammock.',
  tech: 'XPBD cloth · WebGL2',
  swatch: 'linear-gradient(130deg,#b3122e,#ff6b6b 50%,#f5c16c)',
  refs: [
    {
      short: 'Müller 2007',
      title: 'Müller et al. — Position Based Dynamics (2007)',
      url: 'https://matthias-research.github.io/pages/publications/posBasedDyn.pdf',
      use: 'Position-level distance constraints that stay stable when you yank the cloth.',
    },
    {
      short: 'Macklin 2016',
      title: 'Macklin, Müller, Chentanez — XPBD (MIG 2016)',
      url: 'https://dl.acm.org/doi/10.1145/2994258.2994272',
      use: 'Compliance, so stiffness and bendiness don’t depend on the iteration count.',
    },
    {
      short: 'TMP #14/#15',
      title: 'Ten Minute Physics #14–15 — cloth and self-collision',
      url: 'https://matthias-research.github.io/pages/tenMinutePhysics/index.html',
      use: 'Small-steps substepping, stretch + bending constraints, grabbing.',
    },
    {
      short: 'Macklin 2019',
      title: 'Macklin et al. — Small Steps in Physics Simulation (SCA 2019)',
      url: 'https://dl.acm.org/doi/10.1145/3309486.3340247',
      use: 'Why many substeps with one iteration beat many iterations.',
    },
  ],
  async create(ctx) {
    return new TearSheet(ctx);
  },
};

type Tool = 'grab' | 'cut' | 'ball';

const TOOLS: { id: Tool; label: string; swatch: string }[] = [
  { id: 'grab', label: '✋', swatch: '#f1eee8' },
  { id: 'cut', label: '✂️', swatch: '#ffd166' },
  { id: 'ball', label: '🔴', swatch: '#ff5d73' },
];

const FABRIC: Record<Scene, Fabric> = { curtain: 'velvet', flag: 'flag', hammock: 'canvas' };

class TearSheet implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private sim!: Cloth;
  private renderer!: ClothRenderer;
  private width = 1;
  private height = 1;
  private view!: Mat4;
  private proj!: Mat4;
  private viewProj!: Mat4;
  private eye: Vec3 = [0, 0, 3];
  private tool: Tool = 'grab';
  private grabs = new Map<number, number>();
  private lastCut = new Map<number, [number, number]>();
  private trail: TrailPoint[] = [];
  private dock: HTMLElement;
  private dockButtons: HTMLButtonElement[] = [];
  private tornTotal = 0;
  private hue = 0;

  readonly cfg = {
    scene: 'curtain' as Scene,
    resolution: 34,
    substeps: 12,
    tear: 1.8,
    bend: 0.8,
    wind: 0,
    gravity: 9.8,
    ballSize: 0.12,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.dock = this.buildDock();
    this.buildPanel();
    this.rebuild();
  }

  private rebuild() {
    const c = this.cfg;
    this.sim = new Cloth(c.scene, c.resolution);
    if (c.scene === 'flag' && c.wind === 0) c.wind = 5;
    if (c.scene !== 'flag' && this.sim.cfg.wind) c.wind = 0;
    this.syncSim();
    this.renderer = new ClothRenderer(this.gl, this.sim);
    this.grabs.clear();
    this.tornTotal = 0;
    this.updateCamera();
    // Hammock is for dropping things on; default to the ball tool there.
    this.setTool(c.scene === 'hammock' ? 'ball' : c.scene === 'flag' ? 'ball' : 'grab');
  }

  private syncSim() {
    const c = this.cfg;
    const s = this.sim.cfg;
    s.substeps = c.substeps;
    s.tear = c.tear >= 4 ? 0 : c.tear;
    s.bendCompliance = c.bend;
    s.wind = c.wind;
    s.gravity = c.gravity;
  }

  private updateCamera() {
    const aspect = this.width / this.height;
    const fov = (50 * Math.PI) / 180;
    const s = this.sim;
    let target: Vec3;
    let eye: Vec3;
    if (s.scene === 'hammock') {
      target = [0, -0.35, 0];
      const need = (Math.max(1.55 / aspect, 1.9) / (2 * Math.tan(fov / 2))) * 1.2;
      eye = [0, target[1] + need * 0.72, need * 0.72];
    } else {
      const h = s.scene === 'flag' ? 1.7 : 2.6;
      const w = s.scene === 'flag' ? 1.9 : 1.6;
      target = [s.scene === 'flag' ? 0.1 : 0, s.scene === 'flag' ? 0.1 : -0.15, 0];
      const need = Math.max(h, w / aspect) / (2 * Math.tan(fov / 2));
      eye = [target[0], target[1] + 0.15, need];
    }
    this.eye = eye;
    this.view = lookAt(eye, target, [0, 1, 0]);
    this.proj = perspective(fov, aspect, 0.05, 30);
    this.viewProj = multiply(this.proj, this.view);
  }

  private buildDock() {
    const dock = document.createElement('div');
    dock.className = 'dock';
    this.dockButtons = TOOLS.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.label;
      b.setAttribute('aria-label', t.id === 'grab' ? 'Grab' : t.id === 'cut' ? 'Cut' : 'Throw ball');
      b.style.setProperty('--swatch', t.swatch);
      b.addEventListener('click', () => this.setTool(t.id));
      return b;
    });
    dock.append(...this.dockButtons);
    this.ctx.overlay.appendChild(dock);
    return dock;
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.dockButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(TOOLS[i].id === t)));
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice<Scene>(
      'Scene',
      [
        { value: 'curtain', label: 'Curtain' },
        { value: 'flag', label: 'Flag' },
        { value: 'hammock', label: 'Hammock' },
      ],
      c.scene,
      (v) => {
        c.scene = v;
        this.rebuild();
      },
    );
    panel.slider(c, 'tear', { label: 'Toughness (4 = unbreakable)', min: 1.15, max: 4, step: 0.05, onChange: () => this.syncSim() });
    panel.slider(c, 'bend', { label: 'Floppiness', min: 0, max: 5, step: 0.1, onChange: () => this.syncSim() });
    panel.slider(c, 'wind', { label: 'Wind', min: 0, max: 14, step: 0.5, onChange: () => this.syncSim() });
    panel.slider(c, 'gravity', { label: 'Gravity', min: 0, max: 20, step: 0.5, onChange: () => this.syncSim() });
    panel.slider(c, 'ballSize', { label: 'Ball size', min: 0.05, max: 0.3, step: 0.01 });
    panel.slider(c, 'substeps', { label: 'Substeps', min: 4, max: 30, step: 1, onChange: () => this.syncSim() });
    panel.choice(
      'Resolution',
      [24, 34, 46].map((v) => ({ value: String(v), label: String(v) })),
      String(c.resolution),
      (v) => {
        c.resolution = Number(v);
        this.rebuild();
      },
    );
    panel.action('Mend (reset)', () => this.rebuild());
  }

  frame(dt: number, t: number) {
    this.handleInput(dt);
    const t0 = performance.now();
    this.sim.step(dt, t);
    const simMs = performance.now() - t0;
    this.tornTotal += this.sim.tornThisFrame;
    if (this.sim.tornThisFrame > 0) this.ctx.haptic(this.sim.tornThisFrame > 6 ? 'medium' : 'light');
    for (const p of this.trail) p.age += dt;
    while (this.trail.length && this.trail[0].age > 0.35) this.trail.shift();
    this.renderer.draw(this.width, this.height, this.view, this.proj, this.viewProj, this.eye, FABRIC[this.sim.scene], this.trail);
    let alive = 0;
    for (let i = 0; i < this.sim.nt; i++) alive += this.sim.triAlive[i];
    this.ctx.setStatus(`${this.sim.n} particles · ${Math.round((100 * alive) / this.sim.nt)}% intact · sim ${simMs.toFixed(1)}ms`);
  }

  private handleInput(dt: number) {
    const s = this.sim;
    for (const p of this.ctx.pointers.active.values()) {
      if (this.tool === 'grab') {
        let idx = this.grabs.get(p.id);
        if (p.justDown || idx === undefined) {
          if (!p.justDown) continue;
          idx = this.pick(p.x, p.y);
          if (idx < 0) continue;
          this.grabs.set(p.id, idx);
          this.ctx.haptic('light');
        }
        // Only one grabbed vertex is driven by the solver; extra fingers pin theirs directly.
        const target = this.unproject(p.x, p.y, idx);
        if (idx === [...this.grabs.values()][0]) {
          s.grabbed = idx;
          s.grabTarget = target;
        } else if (s.invMass[idx] > 0) {
          s.pos.set(target, idx * 3);
          s.vel.fill(0, idx * 3, idx * 3 + 3);
        }
      } else if (this.tool === 'cut') {
        const last = this.lastCut.get(p.id);
        if (last) {
          const cut = s.cut((x, y, z) => projectPoint(this.viewProj, x, y, z), last[0], last[1], p.x, p.y);
          if (cut) {
            this.tornTotal += cut;
            this.ctx.haptic(cut > 4 ? 'medium' : 'light');
          }
        }
        this.lastCut.set(p.id, [p.x, p.y]);
        this.trail.push({ x: p.x, y: p.y, age: 0 });
      } else if (this.tool === 'ball' && p.justDown) {
        this.throwBall(p.x, p.y);
      }
    }
    for (const id of [...this.grabs.keys()]) if (!this.ctx.pointers.active.has(id)) this.grabs.delete(id);
    for (const id of [...this.lastCut.keys()]) if (!this.ctx.pointers.active.has(id)) this.lastCut.delete(id);
    if (!this.grabs.size) s.grabbed = -1;
    else s.grabbed = [...this.grabs.values()][0];
    void dt;
  }

  /** Nearest particle to the pointer in screen space, within a finger-sized radius. */
  private pick(x: number, y: number) {
    const s = this.sim;
    const aspect = this.width / this.height;
    let best = -1;
    let bestD = 0.06 * 0.06;
    for (let i = 0; i < s.n; i++) {
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

  /** World point under the pointer on the camera-facing plane through particle `idx`'s current depth. */
  private unproject(x: number, y: number, idx: number): Vec3 {
    const s = this.sim;
    const p: Vec3 = [s.pos[idx * 3], s.pos[idx * 3 + 1], s.pos[idx * 3 + 2]];
    const dir = this.rayDir(x, y);
    const camFwd: Vec3 = [-this.view[2], -this.view[6], -this.view[10]];
    const depth = dot(sub(p, this.eye), camFwd);
    const t = depth / dot(dir, camFwd);
    return [this.eye[0] + dir[0] * t, this.eye[1] + dir[1] * t, this.eye[2] + dir[2] * t];
  }

  private rayDir(x: number, y: number): Vec3 {
    // Invert projection for a direction: build from the camera basis and fov.
    const v = this.view;
    const right: Vec3 = [v[0], v[4], v[8]];
    const up: Vec3 = [v[1], v[5], v[9]];
    const back: Vec3 = [v[2], v[6], v[10]];
    const tanY = 1 / this.proj[5];
    const tanX = 1 / this.proj[0];
    const nx = (x * 2 - 1) * tanX;
    const ny = (y * 2 - 1) * tanY;
    return normalize([
      right[0] * nx + up[0] * ny - back[0],
      right[1] * nx + up[1] * ny - back[1],
      right[2] * nx + up[2] * ny - back[2],
    ]);
  }

  private throwBall(x: number, y: number) {
    const dir = this.rayDir(x, y);
    const speed = this.sim.scene === 'hammock' ? 5 : 8;
    const start: Vec3 = [this.eye[0] + dir[0] * 0.6, this.eye[1] + dir[1] * 0.6, this.eye[2] + dir[2] * 0.6];
    this.hue = (this.hue + 0.17) % 1;
    this.sim.balls.push({
      x: start[0],
      y: start[1],
      z: start[2],
      vx: dir[0] * speed,
      vy: dir[1] * speed + 1.2,
      vz: dir[2] * speed,
      r: this.cfg.ballSize,
      hue: this.hue,
      age: 0,
      px: start[0],
      py: start[1],
      pz: start[2],
      // Heavier with volume; ~40 cloth particles' worth at the default size.
      w: 1 / (40 * Math.pow(this.cfg.ballSize / 0.12, 3)),
    });
    if (this.sim.balls.length > 40) this.sim.balls.shift();
    this.ctx.haptic('light');
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.updateCamera();
  }

  destroy() {
    this.dock.remove();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
