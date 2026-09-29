import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile, createDouble, createTarget, destroyTarget, gridSize, type DoubleTarget, type Target } from '../../shell/gl';
import type { Loop } from '../../shell/sound';
import * as S from './shaders';

export const poolToy: Toy = {
  id: 'pool',
  title: 'Ripple Pool',
  blurb: 'Poke a sunlit pool and watch caustics dance. Grab and fling rubber ducks. Make it rain.',
  tech: 'Height-field waves · WebGL2',
  swatch: 'linear-gradient(140deg,#5ee7ff,#2a7fff 55%,#ffe066)',
  refs: [
    {
      short: 'Wallace',
      title: 'Evan Wallace — WebGL Water',
      url: 'https://github.com/evanw/webgl-water',
      use: 'The recipe: wave-equation height field, drop shape, and caustics from projected triangle area.',
    },
    {
      short: 'TMP #20',
      title: 'Ten Minute Physics #20 — height-field water',
      url: 'https://matthias-research.github.io/pages/tenMinutePhysics/index.html',
      use: 'Walkthrough of the height-field update and its stability limit.',
    },
    {
      short: 'Jeschke & Wojtan 2023',
      title: 'Jeschke & Wojtan — Generalizing Shallow Water Simulations with Dispersive Surface Waves (SIGGRAPH 2023)',
      url: 'https://research.nvidia.com/publication/2023-08_generalizing-shallow-water-simulations-dispersive-surface-waves',
      use: 'Where this goes next: dispersive waves and wakes. Not implemented yet.',
    },
    {
      short: '2MP #110',
      title: 'Two Minute Papers — Water Wave Simulation with Dispersion Kernels',
      url: 'https://www.youtube.com/watch?v=FeMSEaHR8aw',
      use: 'Inspiration for more realistic ripple spreading.',
    },
  ],
  async create(ctx) {
    return new Pool(ctx);
  },
};

interface Duck {
  x: number;
  y: number;
  vx: number;
  vy: number;
  heading: number;
  spin: number;
  r: number;
  squash: number;
  squashV: number;
  grabbedBy: number | null;
  wake: number;
}

type Theme = 'day' | 'night';

class Pool implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private p: Record<string, Program>;
  private water!: DoubleTarget;
  private caustics!: Target;
  private causticsTmp!: Target;
  private grid!: { vao: WebGLVertexArrayObject; buf: WebGLBuffer; idx: WebGLBuffer; count: number };
  private duckVao: WebGLVertexArrayObject;
  private duckBuf: WebGLBuffer;
  private duckSquashBuf: WebGLBuffer;
  private ducks: Duck[] = [];
  private width = 1;
  private height = 1;
  private world: [number, number] = [1, 1];
  private rainClock = 0;
  private lastDrop = new Map<number, { x: number; y: number }>();
  // Sound: a bubbly wake bed while a finger drags through the water, a trickle bed for rain.
  private wakeLoop: Loop;
  private rainLoop: Loop;
  private wakeLevel = 0;
  private dragDist = 0;
  private bumpCool = 0;

  readonly cfg = {
    theme: 'day' as Theme,
    simRes: 192,
    steps: 2,
    waveSpeed: 0.9,
    damping: 0.994,
    depth: 0.3,
    dropSize: 0.035,
    dropStrength: 0.012,
    caustics: 1.3,
    sunAngle: 14,
    breeze: 0.8,
    rain: false,
    rainRate: 14,
    duckCount: 5,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This device cannot render to float textures.');
    }
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.wakeLoop = ctx.sound.loop('bubble');
    this.rainLoop = ctx.sound.loop('trickle');

    const quadVert = compile(gl, gl.VERTEX_SHADER, S.quadVert);
    this.p = {
      update: new Program(gl, quadVert, S.updateFrag),
      normal: new Program(gl, quadVert, S.normalFrag),
      drop: new Program(gl, quadVert, S.dropFrag),
      blur: new Program(gl, quadVert, S.blurFrag),
      composite: new Program(gl, quadVert, S.compositeFrag),
      caustics: new Program(gl, compile(gl, gl.VERTEX_SHADER, S.causticsVert), S.causticsFrag),
      duck: new Program(gl, compile(gl, gl.VERTEX_SHADER, S.duckVert), S.duckFrag),
    };

    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    // Ducks: a unit quad per instance plus per-duck position/heading/size and squash.
    this.duckVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.duckVao);
    const corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.duckBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.duckBuf);
    gl.bufferData(gl.ARRAY_BUFFER, S.MAX_DUCKS * 16, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(1, 1);
    this.duckSquashBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.duckSquashBuf);
    gl.bufferData(gl.ARRAY_BUFFER, S.MAX_DUCKS * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.allocate();
    this.setDuckCount(this.cfg.duckCount);
    this.buildPanel();
    // A few opening drops so the first frame already shimmers.
    for (let i = 0; i < 5; i++) this.drop(0.2 + Math.random() * 0.6, 0.2 + Math.random() * 0.6, 0.05, 0.015);
  }

  // ---------- resources ----------

  private allocate() {
    const gl = this.gl;
    this.release();
    const [w, h] = gridSize(this.cfg.simRes, this.width, this.height);
    const aspect = this.width / this.height;
    this.world = aspect >= 1 ? [aspect, 1] : [1, 1 / aspect];
    this.water = createDouble(gl, w, h, gl.LINEAR);
    const [cw, ch] = gridSize(Math.round(this.cfg.simRes * 1.5), this.width, this.height);
    this.caustics = createTarget(gl, cw, ch, gl.LINEAR);
    this.causticsTmp = createTarget(gl, cw, ch, gl.LINEAR);
    this.grid = this.buildGrid(w, h);
    this.ctx.setStatus(`waves ${w}×${h} · caustics ${cw}×${ch}`);
  }

  private buildGrid(w: number, h: number) {
    const gl = this.gl;
    const verts = new Float32Array(w * h * 2);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        verts[(y * w + x) * 2] = (x + 0.5) / w;
        verts[(y * w + x) * 2 + 1] = (y + 0.5) / h;
      }
    const idx = new Uint32Array((w - 1) * (h - 1) * 6);
    let k = 0;
    for (let y = 0; y < h - 1; y++)
      for (let x = 0; x < w - 1; x++) {
        const i = y * w + x;
        idx.set([i, i + 1, i + w, i + 1, i + w + 1, i + w], k);
        k += 6;
      }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, buf, idx: ib, count: idx.length };
  }

  private release() {
    const gl = this.gl;
    if (!this.water) return;
    destroyTarget(gl, this.water.read);
    destroyTarget(gl, this.water.write);
    destroyTarget(gl, this.caustics);
    destroyTarget(gl, this.causticsTmp);
    gl.deleteVertexArray(this.grid.vao);
    gl.deleteBuffer(this.grid.buf);
    gl.deleteBuffer(this.grid.idx);
  }

  // ---------- UI ----------

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice<Theme>('Scene', [{ value: 'day', label: 'Sunny' }, { value: 'night', label: 'Night' }], c.theme, (t) => (c.theme = t));
    panel.slider(c, 'breeze', { label: 'Breeze', min: 0, max: 4, step: 0.1 });
    panel.toggleSwitch(c, 'rain', 'Rain');
    panel.slider(c, 'rainRate', { label: 'Rain drops / s', min: 2, max: 60, step: 1 });
    panel.slider(c, 'duckCount', { label: 'Ducks', min: 0, max: S.MAX_DUCKS, step: 1, onChange: (v) => this.setDuckCount(v) });
    panel.heading('Water');
    panel.slider(c, 'waveSpeed', { label: 'Wave speed', min: 0.2, max: 1, step: 0.01 });
    panel.slider(c, 'damping', { label: 'Calm ↔ lively', min: 0.97, max: 0.999, step: 0.001 });
    panel.slider(c, 'steps', { label: 'Steps per frame', min: 1, max: 4, step: 1 });
    panel.slider(c, 'dropSize', { label: 'Poke size', min: 0.01, max: 0.12, step: 0.005 });
    panel.slider(c, 'dropStrength', { label: 'Poke strength', min: 0.002, max: 0.04, step: 0.001 });
    panel.heading('Light');
    panel.slider(c, 'caustics', { label: 'Caustics', min: 0, max: 2.5, step: 0.05 });
    panel.slider(c, 'sunAngle', { label: 'Sun angle °', min: 0, max: 40, step: 1 });
    panel.slider(c, 'depth', { label: 'Pool depth', min: 0.08, max: 0.8, step: 0.01 });
    panel.choice(
      'Wave resolution',
      [128, 192, 256].map((v) => ({ value: String(v), label: String(v) })),
      String(c.simRes),
      (v) => {
        c.simRes = Number(v);
        this.allocate();
      },
    );
    panel.action('Calm the water', () => this.calm());
  }

  private setDuckCount(n: number) {
    while (this.ducks.length < n) {
      this.ducks.push({
        x: 0.2 + Math.random() * 0.6,
        y: 0.2 + Math.random() * 0.6,
        vx: (Math.random() - 0.5) * 0.05,
        vy: (Math.random() - 0.5) * 0.05,
        heading: Math.random() * Math.PI * 2,
        spin: 0,
        r: 0.045 + Math.random() * 0.012,
        squash: 0,
        squashV: 0,
        grabbedBy: null,
        wake: 0,
      });
    }
    this.ducks.length = n;
  }

  // ---------- frame ----------

  frame(dt: number, t: number) {
    this.handleInput(dt);
    if (this.cfg.rain) {
      this.rainClock += dt * this.cfg.rainRate;
      while (this.rainClock >= 1) {
        this.rainClock -= 1;
        const x = Math.random();
        this.drop(x, Math.random(), 0.012 + Math.random() * 0.01, -0.004 - Math.random() * 0.004, false);
        // Only a few audible plips a second on top of the bed, however heavy the rain.
        // Raindrops each trap a tiny bubble (the high 'plink' of rain on water); a few dozen a second at most.
        if (Math.random() < 30 / this.cfg.rainRate) this.ctx.sound.bubble(0.0004 + Math.random() * 0.0008, { gain: 0.35, pan: this.pan(x) });
      }
    }
    this.rainLoop.set(this.cfg.rain ? 0.12 + Math.min(1, this.cfg.rainRate / 60) * 0.3 : 0, 0.4 + Math.min(1, this.cfg.rainRate / 60) * 0.4);
    this.updateDucks(dt);
    this.updateSound(dt);
    this.simulate(t);
    this.renderCaustics();
    this.render(t);
  }

  private handleInput(dt: number) {
    const [wx, wy] = this.world;
    const c = this.cfg;
    for (const p of this.ctx.pointers.active.values()) {
      if (p.justDown) {
        const duck = this.duckAt(p.x, p.y);
        if (duck) {
          duck.grabbedBy = p.id;
          duck.squashV += 6;
          this.ctx.haptic('medium');
          // Rubber squeak: a high, short squish, smaller ducks squeak higher.
          this.ctx.sound.play('squish', { pitch: 1.8 * (0.05 / duck.r), gain: 0.5, pan: this.pan(duck.x) });
          continue;
        }
        this.drop(p.x, p.y, c.dropSize, -c.dropStrength);
        this.lastDrop.set(p.id, { x: p.x, y: p.y });
        this.ctx.haptic('light');
        // Bigger pokes plop lower; stronger pokes plop louder and turn into a splash.
        const size = c.dropSize / 0.035;
        const force = c.dropStrength / 0.012;
        this.ctx.sound.play('plop', { pitch: 1.1 / Math.sqrt(size), gain: Math.min(0.6, 0.2 + force * 0.15), pan: this.pan(p.x) });
        // A bigger, harder poke traps more air, in bigger bubbles.
        this.ctx.sound.bubbles(1 + force * size * 2, 0.0008, 0.002 + 0.003 * Math.min(2, size), { gain: Math.min(1, 0.4 + force * 0.2), pan: this.pan(p.x) });
        if (force * size > 2) this.ctx.sound.play('splash', { pitch: 1 / Math.sqrt(size), gain: Math.min(0.8, force * size * 0.15), pan: this.pan(p.x) });
        continue;
      }
      // Dragging a duck churns the water too, so both count toward the wake bed.
      this.dragDist += Math.hypot(p.dx * wx, p.dy * wy);
      const grabbed = this.ducks.find((d) => d.grabbedBy === p.id);
      if (grabbed) {
        grabbed.x = clamp(p.x, 0.02, 0.98);
        grabbed.y = clamp(p.y, 0.02, 0.98);
        grabbed.vx = p.dx / Math.max(dt, 1e-3);
        grabbed.vy = p.dy / Math.max(dt, 1e-3);
        continue;
      }
      // Dragging leaves a trail of small pokes spaced along the path: a finger wake.
      const last = this.lastDrop.get(p.id) ?? { x: p.x, y: p.y };
      const dist = Math.hypot((p.x - last.x) * wx, (p.y - last.y) * wy);
      const spacing = c.dropSize * 0.5;
      if (dist >= spacing) {
        const n = Math.min(8, Math.floor(dist / spacing));
        for (let i = 1; i <= n; i++) {
          const f = i / n;
          this.drop(last.x + (p.x - last.x) * f, last.y + (p.y - last.y) * f, c.dropSize * 0.7, -c.dropStrength * 0.35);
        }
        this.lastDrop.set(p.id, { x: p.x, y: p.y });
      }
    }
    for (const d of this.ducks) if (d.grabbedBy !== null && !this.ctx.pointers.active.has(d.grabbedBy)) {
      d.grabbedBy = null;
      const speed = Math.hypot(d.vx, d.vy);
      d.vx = clamp(d.vx, -1.5, 1.5);
      d.vy = clamp(d.vy, -1.5, 1.5);
      // Released: a splash where it lands.
      this.drop(d.x, d.y, d.r * 1.4, -this.cfg.dropStrength * (0.6 + Math.min(speed, 2)), false);
      d.squashV -= 8;
      // Thrown ducks land with a splash; a gentle drop is just a plop.
      if (speed > 0.6) this.ctx.sound.play('splash', { pitch: 1.2 - Math.min(speed, 3) * 0.1, gain: Math.min(1, 0.3 + speed * 0.2), pan: this.pan(d.x) });
      else this.ctx.sound.play('plop', { pitch: 0.8, gain: 0.5, pan: this.pan(d.x) });
      this.ctx.sound.bubbles(2 + speed * 6, 0.001, 0.006, { gain: Math.min(1, 0.4 + speed * 0.3), pan: this.pan(d.x) });
    }
    for (const id of this.lastDrop.keys()) if (!this.ctx.pointers.active.has(id)) this.lastDrop.delete(id);
  }

  private updateSound(dt: number) {
    this.bumpCool -= dt;
    // Finger distance through the water per second drives the wake bed; fast release so it
    // stops when the finger stops.
    const target = Math.min(1, this.dragDist / Math.max(dt, 1e-3) / 2.5);
    this.dragDist = 0;
    this.wakeLevel += (target - this.wakeLevel) * (1 - Math.exp(-dt * (target > this.wakeLevel ? 10 : 4)));
    this.wakeLoop.set(this.wakeLevel * 0.5, 0.3 + this.wakeLevel * 0.6);
  }

  /** A soft rubbery bump, at most a few per second across all ducks. */
  private bump(x: number, strength: number) {
    if (this.bumpCool > 0 || strength < 0.15) return;
    this.bumpCool = 0.18;
    this.ctx.sound.play('boing', { pitch: 1.4, gain: Math.min(0.5, strength * 0.6), pan: this.pan(x) });
  }

  private pan(x: number) {
    return (x - 0.5) * 1.2;
  }

  private duckAt(x: number, y: number) {
    const [wx, wy] = this.world;
    let best: Duck | null = null;
    let bestD = Infinity;
    for (const d of this.ducks) {
      const dist = Math.hypot((d.x - x) * wx, (d.y - y) * wy);
      if (dist < d.r * 1.6 && dist < bestD) {
        best = d;
        bestD = dist;
      }
    }
    return best;
  }

  private updateDucks(dt: number) {
    const [wx, wy] = this.world;
    for (const d of this.ducks) {
      // Squash spring: grabs and landings wobble the duck.
      d.squashV += (-d.squash * 180 - d.squashV * 10) * dt;
      d.squash += d.squashV * dt;
      if (d.grabbedBy !== null) continue;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      const drag = Math.exp(-dt * 1.2);
      d.vx *= drag;
      d.vy *= drag;
      // Lazy drift so resting ducks still meander.
      d.vx += Math.sin(performance.now() * 0.0003 + d.r * 999) * 0.004 * dt;
      d.vy += Math.cos(performance.now() * 0.00023 + d.r * 555) * 0.004 * dt;
      const rx = d.r / wx;
      const ry = d.r / wy;
      if (d.x < rx) { d.x = rx; this.bump(d.x, Math.abs(d.vx)); d.vx = Math.abs(d.vx) * 0.6; d.squashV += 3; }
      if (d.x > 1 - rx) { d.x = 1 - rx; this.bump(d.x, Math.abs(d.vx)); d.vx = -Math.abs(d.vx) * 0.6; d.squashV += 3; }
      if (d.y < ry) { d.y = ry; this.bump(d.x, Math.abs(d.vy)); d.vy = Math.abs(d.vy) * 0.6; d.squashV += 3; }
      if (d.y > 1 - ry) { d.y = 1 - ry; this.bump(d.x, Math.abs(d.vy)); d.vy = -Math.abs(d.vy) * 0.6; d.squashV += 3; }
      // Turn to face the direction of travel.
      const speed = Math.hypot(d.vx * wx, d.vy * wy);
      if (speed > 0.01) {
        const target = Math.atan2(d.vy * wy, d.vx * wx);
        let diff = target - d.heading;
        diff = Math.atan2(Math.sin(diff), Math.cos(diff));
        d.heading += diff * Math.min(1, dt * 4 * Math.min(1, speed * 8));
      }
      // Moving ducks leave a wake.
      d.wake += speed * dt;
      if (d.wake > d.r * 0.5) {
        d.wake = 0;
        const bx = d.x - Math.cos(d.heading) * (d.r / wx);
        const by = d.y - Math.sin(d.heading) * (d.r / wy);
        this.drop(bx, by, d.r * 0.9, -0.003 * Math.min(1, speed * 3), false);
      }
    }
    // Ducks bump each other.
    for (let i = 0; i < this.ducks.length; i++)
      for (let j = i + 1; j < this.ducks.length; j++) {
        const a = this.ducks[i];
        const b = this.ducks[j];
        const dx = (b.x - a.x) * wx;
        const dy = (b.y - a.y) * wy;
        const dist = Math.hypot(dx, dy) || 1e-6;
        const min = (a.r + b.r) * 0.9;
        if (dist < min) {
          const push = (min - dist) / 2;
          const nx = dx / dist;
          const ny = dy / dist;
          if (a.grabbedBy === null) { a.x -= (nx * push) / wx; a.y -= (ny * push) / wy; a.vx -= nx * 0.3 * push * 30; a.vy -= ny * 0.3 * push * 30; }
          if (b.grabbedBy === null) { b.x += (nx * push) / wx; b.y += (ny * push) / wy; b.vx += nx * 0.3 * push * 30; b.vy += ny * 0.3 * push * 30; }
          if (push > 0.004) {
            a.squashV += 2;
            b.squashV += 2;
            this.bump((a.x + b.x) / 2, Math.hypot(a.vx - b.vx, a.vy - b.vy));
          }
        }
      }
  }

  /** Adds a cosine-bump drop; `push` also shoves nearby ducks away like the ripple would. */
  private drop(x: number, y: number, radiusWorld: number, strength: number, push = true) {
    const gl = this.gl;
    const [wx, wy] = this.world;
    const u = this.p.drop.use();
    gl.uniform1i(u.uWater, 0);
    gl.uniform2f(u.center, x, y);
    gl.uniform1f(u.radius, radiusWorld / wy);
    gl.uniform1f(u.strength, strength);
    gl.uniform1f(u.aspect, wx / wy);
    this.bindTex(0, this.water.read.tex);
    this.blit(this.water.write);
    this.water.swap();
    if (!push) return;
    for (const d of this.ducks) {
      if (d.grabbedBy !== null) continue;
      const dx = (d.x - x) * wx;
      const dy = (d.y - y) * wy;
      const dist = Math.hypot(dx, dy);
      const reach = radiusWorld * 5;
      if (dist < reach && dist > 1e-4) {
        const k = (1 - dist / reach) * Math.abs(strength) * 25;
        d.vx += (dx / dist) * k / wx;
        d.vy += (dy / dist) * k / wy;
        d.spin += k;
      }
    }
  }

  private calm() {
    const gl = this.gl;
    for (const t of [this.water.read, this.water.write]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
  }

  private simulate(t: number) {
    const gl = this.gl;
    const w = this.water;
    let u = this.p.update.use();
    gl.uniform1i(u.uWater, 0);
    gl.uniform2f(u.delta, w.texelX, w.texelY);
    gl.uniform1f(u.waveSpeed, this.cfg.waveSpeed);
    gl.uniform1f(u.damping, this.cfg.damping);
    gl.uniform1f(u.breeze, this.cfg.breeze);
    gl.uniform1f(u.time, t % 1000);
    gl.uniform2f(u.world, this.world[0], this.world[1]);
    for (let i = 0; i < this.cfg.steps; i++) {
      this.bindTex(0, w.read.tex);
      this.blit(w.write);
      w.swap();
    }
    u = this.p.normal.use();
    gl.uniform1i(u.uWater, 0);
    gl.uniform2f(u.delta, w.texelX, w.texelY);
    gl.uniform2f(u.world, this.world[0], this.world[1]);
    gl.uniform1f(u.heightScale, 1);
    this.bindTex(0, w.read.tex);
    this.blit(w.write);
    w.swap();
  }

  private lightDir(): [number, number, number] {
    const a = (this.cfg.sunAngle * Math.PI) / 180;
    return [Math.sin(a) * 0.8, -Math.cos(a), Math.sin(a) * 0.6];
  }

  private renderCaustics() {
    const gl = this.gl;
    const c = this.caustics;
    gl.bindFramebuffer(gl.FRAMEBUFFER, c.fbo);
    gl.viewport(0, 0, c.width, c.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const u = this.p.caustics.use();
    gl.uniform1i(u.uWater, 0);
    gl.uniform3f(u.light, ...this.lightDir());
    gl.uniform2f(u.world, this.world[0], this.world[1]);
    gl.uniform1f(u.depth, this.cfg.depth);
    gl.uniform1f(u.heightScale, 1);
    this.bindTex(0, this.water.read.tex);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.grid.vao);
    gl.drawElements(gl.TRIANGLES, this.grid.count, gl.UNSIGNED_INT, 0);
    gl.disable(gl.BLEND);

    // Soften aliasing from the rasterised mesh with a small separable blur.
    const b = this.p.blur.use();
    gl.uniform1i(b.uTexture, 0);
    gl.uniform2f(b.dir, c.texelX, 0);
    this.bindTex(0, c.tex);
    this.blit(this.causticsTmp);
    gl.uniform2f(b.dir, 0, c.texelY);
    this.bindTex(0, this.causticsTmp.tex);
    this.blit(c);
  }

  private render(t: number) {
    const gl = this.gl;
    const c = this.cfg;
    const u = this.p.composite.use();
    gl.uniform1i(u.uWater, 0);
    gl.uniform1i(u.uCaustics, 1);
    gl.uniform2f(u.world, this.world[0], this.world[1]);
    gl.uniform1f(u.depth, c.depth);
    gl.uniform1f(u.heightScale, 1);
    gl.uniform3f(u.light, ...this.lightDir());
    gl.uniform1f(u.causticStrength, c.caustics * (c.theme === 'night' ? 0.8 : 1));
    gl.uniform1f(u.theme, c.theme === 'night' ? 1 : 0);
    gl.uniform1f(u.time, t % 100);
    gl.uniform1i(u.duckCount, this.ducks.length);
    const duckData = new Float32Array(S.MAX_DUCKS * 4);
    this.ducks.forEach((d, i) => duckData.set([d.x, d.y, d.r, 0], i * 4));
    gl.uniform4fv(u['ducks[0]'], duckData);
    this.bindTex(0, this.water.read.tex);
    this.bindTex(1, this.caustics.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (!this.ducks.length) return;
    const inst = new Float32Array(S.MAX_DUCKS * 4);
    const squash = new Float32Array(S.MAX_DUCKS);
    this.ducks.forEach((d, i) => {
      inst.set([d.x, d.y, d.heading, d.r], i * 4);
      squash[i] = clamp(d.squash, -0.8, 0.8);
    });
    gl.bindBuffer(gl.ARRAY_BUFFER, this.duckBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, inst);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.duckSquashBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, squash);
    const du = this.p.duck.use();
    gl.uniform1i(du.uWater, 0);
    gl.uniform2f(du.world, this.world[0], this.world[1]);
    gl.uniform1f(du.heightScale, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.duckVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.ducks.length);
    gl.disable(gl.BLEND);
  }

  private bindTex(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  private blit(target: Target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.width, target.height);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.allocate();
  }

  destroy() {
    this.wakeLoop.stop();
    this.rainLoop.stop();
    this.release();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
