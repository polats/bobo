import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile, createDouble, createTarget, destroyTarget, gridSize, type DoubleTarget, type Target } from '../../shell/gl';
import * as S from './shaders';

type Mode = 'neon' | 'paint';

const PIGMENTS: { id: string; label: string; neon: [number, number, number] | null; paint: [number, number, number] | null }[] = [
  { id: 'rainbow', label: 'Rainbow', neon: null, paint: null },
  { id: 'pink', label: 'Pink', neon: [1, 0.18, 0.55], paint: [0.05, 0.85, 0.35] },
  { id: 'cyan', label: 'Cyan', neon: [0.1, 0.8, 1], paint: [0.85, 0.12, 0.05] },
  { id: 'yellow', label: 'Yellow', neon: [1, 0.8, 0.1], paint: [0.02, 0.1, 0.9] },
  { id: 'violet', label: 'Violet', neon: [0.55, 0.25, 1], paint: [0.45, 0.8, 0.12] },
];

export const inkToy: Toy = {
  id: 'ink',
  title: 'Ink Swirl',
  blurb: 'Finger-paint glowing fluid. Swirl, flick, tap to burst. Paint mode mixes like real pigment.',
  tech: 'Stable Fluids · WebGL2',
  swatch: 'linear-gradient(120deg,#ff2d8d,#6d3bff 50%,#18d0ff)',
  refs: [
    {
      short: 'Stam 1999',
      title: 'Stam — Stable Fluids (SIGGRAPH 1999)',
      url: 'https://dl.acm.org/doi/10.1145/311535.311548',
      use: 'The solver: semi-Lagrangian advection + pressure projection, stable at any time step.',
    },
    {
      short: 'Stam 2003',
      title: 'Stam — Real-Time Fluid Dynamics for Games (GDC 2003)',
      url: 'https://pdfs.semanticscholar.org/5127/ac7b58e36ffd13ca4437fc123c6a018dc436.pdf',
      use: 'Game-friendly formulation of the same solver.',
    },
    {
      short: 'GPU Gems 38',
      title: 'GPU Gems ch. 38 — Fast Fluid Dynamics Simulation on the GPU',
      url: 'https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu',
      use: 'Fragment-shader passes: Jacobi pressure, vorticity confinement, splats.',
    },
    {
      short: 'Dobryakov',
      title: 'Pavel Dobryakov — WebGL Fluid Simulation',
      url: 'https://github.com/PavelDoGreat/WebGL-Fluid-Simulation',
      use: 'Reference implementation for pass layout, splat forces and bloom.',
    },
    {
      short: 'TMP #17',
      title: 'Ten Minute Physics #17 — Eulerian fluid in 200 lines',
      url: 'https://matthias-research.github.io/pages/tenMinutePhysics/index.html',
      use: 'Clear walkthrough of the grid solver for anyone tuning it.',
    },
    {
      short: 'Mixbox',
      title: 'Two Minute Papers — Practical Pigment Mixing (Mixbox)',
      url: 'https://www.youtube.com/watch?v=b2D_5G_npVI',
      use: 'Inspiration for Paint mode; we use a simpler Beer–Lambert absorbance mix.',
    },
  ],
  async create(ctx) {
    return new Ink(ctx);
  },
};

class Ink implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private p: Record<string, Program>;
  private velocity!: DoubleTarget;
  private dye!: DoubleTarget;
  private pressure!: DoubleTarget;
  private divergence!: Target;
  private curl!: Target;
  private bloom: Target[] = [];
  private width = 1;
  private height = 1;
  private dock: HTMLElement;
  private pigment = 'rainbow';
  private pointerColor = new Map<number, [number, number, number]>();
  private idle = 0;
  private hue = Math.random();

  readonly cfg = {
    mode: 'neon' as Mode,
    simRes: 128,
    dyeRes: 768,
    dyeFade: 1,
    velFade: 0.25,
    pressureFade: 0.8,
    iterations: 20,
    curl: 28,
    radius: 0.25,
    force: 6000,
    bloom: true,
    bloomIntensity: 0.8,
    bloomThreshold: 0.55,
    shading: 1,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This device cannot render to float textures.');
    }
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;

    // Phones get a smaller dye buffer; the difference is invisible at arm's length.
    if (Math.min(screen.width, screen.height) < 500) this.cfg.dyeRes = 512;

    const vert = compile(gl, gl.VERTEX_SHADER, S.baseVert);
    const mk = (src: string) => new Program(gl, vert, src);
    this.p = {
      clear: mk(S.clearFrag),
      splat: mk(S.splatFrag),
      advect: mk(S.advectionFrag),
      divergence: mk(S.divergenceFrag),
      curl: mk(S.curlFrag),
      vorticity: mk(S.vorticityFrag),
      pressure: mk(S.pressureFrag),
      gradient: mk(S.gradientSubtractFrag),
      prefilter: mk(S.bloomPrefilterFrag),
      blur: mk(S.blurFrag),
      display: mk(S.displayFrag),
    };

    // One oversized triangle covers the viewport with no diagonal seam.
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.allocate();

    this.dock = this.buildDock();
    this.buildPanel();
    this.randomSplats(6);
  }

  // ---------- resources ----------

  private allocate() {
    const gl = this.gl;
    this.release();
    const [sw, sh] = gridSize(this.cfg.simRes, this.width, this.height);
    const [dw, dh] = gridSize(Math.min(this.cfg.dyeRes, Math.min(this.width, this.height)), this.width, this.height);
    this.velocity = createDouble(gl, sw, sh, gl.LINEAR);
    this.dye = createDouble(gl, dw, dh, gl.LINEAR);
    this.pressure = createDouble(gl, sw, sh, gl.NEAREST);
    this.divergence = createTarget(gl, sw, sh, gl.NEAREST);
    this.curl = createTarget(gl, sw, sh, gl.NEAREST);
    let [bw, bh] = gridSize(256, this.width, this.height);
    for (let i = 0; i < 6 && bw >= 4 && bh >= 4; i++) {
      this.bloom.push(createTarget(gl, bw, bh, gl.LINEAR));
      bw >>= 1;
      bh >>= 1;
    }
    this.ctx.setStatus(`grid ${sw}×${sh} · dye ${dw}×${dh}`);
  }

  private release() {
    const gl = this.gl;
    if (!this.velocity) return;
    for (const d of [this.velocity, this.dye, this.pressure]) {
      destroyTarget(gl, d.read);
      destroyTarget(gl, d.write);
    }
    destroyTarget(gl, this.divergence);
    destroyTarget(gl, this.curl);
    this.bloom.forEach((b) => destroyTarget(gl, b));
    this.bloom = [];
  }

  // ---------- UI ----------

  private buildDock() {
    const dock = document.createElement('div');
    dock.className = 'dock';
    const buttons = PIGMENTS.map((pg) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.setAttribute('aria-label', pg.label);
      if (pg.neon) b.style.setProperty('--swatch', `rgb(${pg.neon.map((c) => Math.round(c * 255)).join(',')})`);
      else b.style.setProperty('--swatch', 'linear-gradient(90deg,#ff5b8a,#ffd35b,#5bffb0,#5bb8ff)');
      b.setAttribute('aria-pressed', String(pg.id === this.pigment));
      b.addEventListener('click', () => {
        this.pigment = pg.id;
        buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      });
      return b;
    });
    dock.append(...buttons);
    this.ctx.overlay.appendChild(dock);
    return dock;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice<Mode>('Mode', [{ value: 'neon', label: 'Neon light' }, { value: 'paint', label: 'Paint' }], c.mode, (m) => {
      c.mode = m;
      this.clear();
      this.randomSplats(5);
    });
    panel.heading('Fluid');
    panel.slider(c, 'curl', { label: 'Swirl (vorticity)', min: 0, max: 60, step: 1 });
    panel.slider(c, 'dyeFade', { label: 'Ink fade', min: 0, max: 4, step: 0.05 });
    panel.slider(c, 'velFade', { label: 'Motion fade', min: 0, max: 4, step: 0.05 });
    panel.slider(c, 'radius', { label: 'Brush size', min: 0.05, max: 1, step: 0.01 });
    panel.slider(c, 'force', { label: 'Push force', min: 1000, max: 15000, step: 100 });
    panel.slider(c, 'iterations', { label: 'Pressure iterations', min: 4, max: 50, step: 1 });
    panel.choice(
      'Sim resolution',
      [64, 128, 192, 256].map((v) => ({ value: String(v), label: String(v) })),
      String(c.simRes),
      (v) => {
        c.simRes = Number(v);
        this.allocate();
      },
    );
    panel.heading('Look');
    panel.toggleSwitch(c, 'bloom', 'Bloom');
    panel.slider(c, 'bloomIntensity', { label: 'Bloom intensity', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'bloomThreshold', { label: 'Bloom threshold', min: 0, max: 1.5, step: 0.05 });
    panel.slider(c, 'shading', { label: 'Gloss', min: 0, max: 1, step: 0.05 });
    panel.action('Random splats', () => this.randomSplats(8));
    panel.action('Clear', () => this.clear());
  }

  // ---------- frame ----------

  frame(dt: number, t: number) {
    const touching = this.ctx.pointers.active.size > 0;
    this.idle = touching ? 0 : this.idle + dt;
    this.handleInput();
    // Attract mode: keep the screen alive when nobody is touching it.
    if (this.idle > 5 && Math.random() < dt * 0.6) this.randomSplats(1);
    this.step(dt);
    this.render(t);
  }

  private handleInput() {
    const aspect = this.width / this.height;
    for (const p of this.ctx.pointers.active.values()) {
      if (p.justDown) {
        this.pointerColor.set(p.id, this.pickColor());
        // Tap = radial burst, like a drop of ink hitting water.
        const col = this.pointerColor.get(p.id)!;
        for (let i = 0; i < 6; i++) {
          const a = (i / 6) * Math.PI * 2;
          this.splat(p.x, p.y, Math.cos(a) * 400, Math.sin(a) * 400, col.map((v) => v * 0.25) as [number, number, number]);
        }
        this.ctx.haptic('light');
      }
      let col = this.pointerColor.get(p.id);
      if (!col) this.pointerColor.set(p.id, (col = this.pickColor()));
      if (this.pigment === 'rainbow' && Math.random() < 0.04) this.pointerColor.set(p.id, (col = this.pickColor()));
      const dx = p.dx * (aspect < 1 ? aspect : 1);
      const dy = p.dy / (aspect > 1 ? aspect : 1);
      const speed = Math.hypot(dx, dy);
      if (speed > 0) {
        this.splat(p.x, p.y, dx * this.cfg.force, dy * this.cfg.force, col);
        if (speed > 0.04) this.ctx.haptic('light');
      } else if (p.held > 0.15) {
        // Holding still keeps pumping a little ink.
        this.splat(p.x, p.y, 0, 0, col.map((v) => v * 0.05) as [number, number, number]);
      }
    }
    for (const id of this.pointerColor.keys()) if (!this.ctx.pointers.active.has(id)) this.pointerColor.delete(id);
  }

  private pickColor(): [number, number, number] {
    const pg = PIGMENTS.find((x) => x.id === this.pigment)!;
    const paint = this.cfg.mode === 'paint';
    if (pg.neon && pg.paint) return (paint ? pg.paint : pg.neon).map((v) => v * (paint ? 0.22 : 0.12)) as [number, number, number];
    this.hue = (this.hue + 0.13 + Math.random() * 0.1) % 1;
    const [r, g, b] = hsv(this.hue, 1, 1);
    return paint ? [(1 - r) * 0.2, (1 - g) * 0.2, (1 - b) * 0.2] : [r * 0.12, g * 0.12, b * 0.12];
  }

  private randomSplats(n: number) {
    for (let i = 0; i < n; i++) {
      const c = this.pickColor().map((v) => v * 10) as [number, number, number];
      const x = 0.15 + Math.random() * 0.7;
      const y = 0.15 + Math.random() * 0.7;
      this.splat(x, y, (Math.random() - 0.5) * 1800, (Math.random() - 0.5) * 1800, c);
    }
  }

  private clear() {
    const gl = this.gl;
    for (const d of [this.dye, this.velocity, this.pressure]) {
      for (const t of [d.read, d.write]) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      }
    }
  }

  private splat(x: number, y: number, dx: number, dy: number, color: [number, number, number]) {
    const gl = this.gl;
    const aspect = this.width / this.height;
    // Keep the brush a constant physical size regardless of orientation.
    const r = (this.cfg.radius / 100) * (aspect > 1 ? aspect : 1);
    const u = this.p.splat.use();
    gl.uniform1i(u.uTarget, 0);
    gl.uniform1f(u.aspectRatio, aspect);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, r);
    gl.uniform3f(u.color, dx, dy, 0);
    this.bindTex(0, this.velocity.read.tex);
    this.blit(this.velocity.write);
    this.velocity.swap();
    gl.uniform3f(u.color, color[0], color[1], color[2]);
    this.bindTex(0, this.dye.read.tex);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  private step(dt: number) {
    const gl = this.gl;
    const c = this.cfg;
    const vel = this.velocity;
    gl.disable(gl.BLEND);

    let u = this.p.curl.use();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uVelocity, 0);
    this.bindTex(0, vel.read.tex);
    this.blit(this.curl);

    u = this.p.vorticity.use();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uVelocity, 0);
    gl.uniform1i(u.uCurl, 1);
    gl.uniform1f(u.curl, c.curl);
    gl.uniform1f(u.dt, dt);
    this.bindTex(0, vel.read.tex);
    this.bindTex(1, this.curl.tex);
    this.blit(vel.write);
    vel.swap();

    u = this.p.divergence.use();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uVelocity, 0);
    this.bindTex(0, vel.read.tex);
    this.blit(this.divergence);

    u = this.p.clear.use();
    gl.uniform1i(u.uTexture, 0);
    gl.uniform1f(u.value, c.pressureFade);
    this.bindTex(0, this.pressure.read.tex);
    this.blit(this.pressure.write);
    this.pressure.swap();

    u = this.p.pressure.use();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uDivergence, 1);
    this.bindTex(1, this.divergence.tex);
    gl.uniform1i(u.uPressure, 0);
    for (let i = 0; i < c.iterations; i++) {
      this.bindTex(0, this.pressure.read.tex);
      this.blit(this.pressure.write);
      this.pressure.swap();
    }

    u = this.p.gradient.use();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uPressure, 0);
    gl.uniform1i(u.uVelocity, 1);
    this.bindTex(0, this.pressure.read.tex);
    this.bindTex(1, vel.read.tex);
    this.blit(vel.write);
    vel.swap();

    u = this.p.advect.use();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform2f(u.velTexelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uVelocity, 0);
    gl.uniform1i(u.uSource, 1);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.dissipation, c.velFade);
    this.bindTex(0, vel.read.tex);
    this.bindTex(1, vel.read.tex);
    this.blit(vel.write);
    vel.swap();

    gl.uniform2f(u.texelSize, this.dye.texelX, this.dye.texelY);
    gl.uniform1f(u.dissipation, c.dyeFade);
    this.bindTex(0, vel.read.tex);
    this.bindTex(1, this.dye.read.tex);
    this.blit(this.dye.write);
    this.dye.swap();
  }

  private render(t: number) {
    const gl = this.gl;
    const c = this.cfg;
    const neonBloom = c.bloom && c.mode === 'neon' && this.bloom.length > 1;
    if (neonBloom) this.renderBloom();

    const u = this.p.display.use();
    gl.uniform1i(u.uTexture, 0);
    gl.uniform1i(u.uBloom, 1);
    gl.uniform2f(u.dyeTexel, this.dye.texelX, this.dye.texelY);
    gl.uniform1f(u.bloomOn, neonBloom ? c.bloomIntensity : 0);
    gl.uniform1f(u.paint, c.mode === 'paint' ? 1 : 0);
    gl.uniform1f(u.shading, c.shading);
    gl.uniform1f(u.time, t % 100);
    this.bindTex(0, this.dye.read.tex);
    this.bindTex(1, this.bloom[0]?.tex ?? this.dye.read.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private renderBloom() {
    const gl = this.gl;
    const c = this.cfg;
    const levels = this.bloom;
    const knee = c.bloomThreshold * 0.7 + 0.0001;
    let u = this.p.prefilter.use();
    gl.uniform1i(u.uTexture, 0);
    gl.uniform3f(u.curve, c.bloomThreshold - knee, knee * 2, 0.25 / knee);
    gl.uniform1f(u.threshold, c.bloomThreshold);
    gl.uniform2f(u.texelSize, this.dye.texelX, this.dye.texelY);
    this.bindTex(0, this.dye.read.tex);
    this.blit(levels[0]);

    // Downsample chain then additive upsample: a cheap wide, soft glow.
    u = this.p.blur.use();
    gl.uniform1i(u.uTexture, 0);
    for (let i = 1; i < levels.length; i++) {
      const src = levels[i - 1];
      gl.uniform2f(u.texelSize, src.texelX, src.texelY);
      this.bindTex(0, src.tex);
      this.blit(levels[i]);
    }
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.enable(gl.BLEND);
    for (let i = levels.length - 1; i > 0; i--) {
      const src = levels[i];
      gl.uniform2f(u.texelSize, src.texelX, src.texelY);
      this.bindTex(0, src.tex);
      this.blit(levels[i - 1]);
    }
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
    this.randomSplats(4);
  }

  destroy() {
    this.release();
    this.dock.remove();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

function hsv(h: number, s: number, v: number): [number, number, number] {
  const i = Math.floor(h * 6);
  const f = h * 6 - i;
  const p = v * (1 - s);
  const q = v * (1 - f * s);
  const t = v * (1 - (1 - f) * s);
  switch (i % 6) {
    case 0: return [v, t, p];
    case 1: return [q, v, p];
    case 2: return [p, v, t];
    case 3: return [p, q, v];
    case 4: return [t, p, v];
    default: return [v, p, q];
  }
}
