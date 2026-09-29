import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile, createDouble, createTarget, destroyTarget, gridSize, type DoubleTarget, type Target } from '../../shell/gl';
import { OBJECTS } from './objects';
import * as S from './shaders';

export const rinseToy: Toy = {
  id: 'rinse',
  title: 'Power Rinse',
  blurb: 'Blast a mud-caked statue, duck or gnome back to sparkling. Watch the % clean fill and find what was hiding under the grime.',
  tech: 'Erodible dirt + runoff · WebGL2',
  swatch: 'linear-gradient(140deg,#1fb6ff,#0a6cff 50%,#7a4b25)',
  refs: [
    {
      short: 'PowerWash Simulator',
      title: 'PowerWash Simulator 2 (FuturLab, 2025) — design reference',
      url: 'https://en.wikipedia.org/wiki/PowerWash_Simulator_2',
      use: 'The loop: every pass visibly improves the object, per-part completion pings, zero failure.',
    },
    {
      short: 'bobo 2026 scene',
      title: 'bobo research — Power Rinse concept (2026-scene.md §6)',
      url: 'https://github.com/ai-asylum/bobo/blob/main/docs/research/2026-scene.md',
      use: 'Why cleaning + reveal + "% done" is the gap this toy fills.',
    },
    {
      short: 'iq SDFs',
      title: 'Inigo Quilez — 2D distance functions',
      url: 'https://iquilezles.org/articles/distfunctions2d/',
      use: 'The procedural objects (hearts, stars, rounded boxes) are drawn as signed-distance shapes.',
    },
  ],
  async create(ctx) {
    return new PowerRinse(ctx);
  },
};

type Nozzle = 'jet' | 'fan' | 'turbo';
const NOZZLES: { id: Nozzle; label: string; glyph: string; swatch: string }[] = [
  { id: 'jet', label: 'Jet nozzle', glyph: '●', swatch: '#7fd3ff' },
  { id: 'fan', label: 'Fan nozzle', glyph: '▼', swatch: '#b9e8ff' },
  { id: 'turbo', label: 'Turbo nozzle', glyph: '✺', swatch: '#ffd166' },
];

const GROUND = 0.2;
const NOZZLE: [number, number] = [0.8, 0.13];
const STAT_W = 48;

interface Mist {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  size: number;
}

class PowerRinse implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private p: Record<string, Program>;
  private objTex!: Target;
  private dirt!: DoubleTarget;
  private run!: DoubleTarget;
  private stat!: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };
  private statPixels = new Uint8Array(0);
  private width = 1;
  private height = 1;
  private objIndex = 0;
  private nozzle: Nozzle = 'jet';
  private dock: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private nextBtn: HTMLButtonElement;
  private style: HTMLStyleElement;
  private frameNo = 0;
  private initialDirt = 0;
  private cleanFrac = 0;
  private regionInit: number[] = [];
  private regionDone: boolean[] = [];
  private done = false;
  private doneAt = 0;
  private finish = 0;
  private wiggle = 0;
  private shine = 0;
  private hissClock = 0;
  private aim: [number, number] = [0.5, 0.5];
  private jetData = new Float32Array(8);
  private jetStretch = new Float32Array([1, 1]);
  private jetCount = 0;
  private mist: Mist[] = [];
  private mistVao: WebGLVertexArrayObject;
  private mistBuf: WebGLBuffer;
  private mistData = new Float32Array(600 * 4);
  private time = 0;
  private seed = Math.random() * 100;

  readonly cfg = {
    strength: 1,
    width: 1,
    stubborn: 1,
    runoff: 1,
    dirtiness: 1,
    object: 'bobo' as string,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This device cannot render to float textures.');
    }
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    const vert = compile(gl, gl.VERTEX_SHADER, S.quadVert);
    const mk = (src: string) => new Program(gl, vert, src);
    this.p = {
      bake: mk(S.bakeFrag),
      gen: mk(S.genFrag),
      dirt: mk(S.dirtFrag),
      run: mk(S.runFrag),
      stat: mk(S.statFrag),
      display: mk(S.displayFrag),
      mist: new Program(gl, compile(gl, gl.VERTEX_SHADER, S.mistVert), S.mistFrag),
    };
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.mistVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.mistVao);
    this.mistBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.mistBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.mistData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.style = document.createElement('style');
    this.style.textContent = `
      .rinse-next { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
        bottom: calc(84px + var(--safe-bottom)); height: 44px; padding: 0 22px; border: 0; border-radius: 99px;
        background: linear-gradient(135deg, #3fd2ff, #1f7bff); color: #fff; font: 700 16px/1 inherit;
        box-shadow: 0 8px 24px -8px rgba(0, 60, 160, 0.8); cursor: pointer; }
      .rinse-next[hidden] { display: none; }
      .dock button.rinse-noz { font-size: 18px; }`;
    document.head.appendChild(this.style);
    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.className = 'rinse-next';
    this.nextBtn.textContent = 'Next object ›';
    this.nextBtn.hidden = true;
    this.nextBtn.addEventListener('click', () => this.nextObject());
    ctx.overlay.appendChild(this.nextBtn);

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.dock = this.buildDock();
    this.buildPanel();
    this.allocate();
  }

  // ---------------------------------------------------------------- resources

  private get aspect() {
    return this.width / this.height;
  }

  /** uv-height per object unit: fit the object's width on portrait, cap on landscape. */
  private get objScale() {
    return Math.min(this.aspect * 1.08, 0.72);
  }

  private get objCenter(): [number, number] {
    return [0.5, GROUND + 0.47 * this.objScale];
  }

  private allocate() {
    const gl = this.gl;
    this.release();
    const [sw, sh] = gridSize(280, this.width, this.height);
    this.objTex = createTarget(gl, sw, sh, gl.LINEAR);
    this.dirt = createDouble(gl, sw, sh, gl.LINEAR);
    this.run = createDouble(gl, sw, sh, gl.LINEAR);
    const stw = STAT_W;
    const sth = Math.max(8, Math.round(STAT_W / this.aspect));
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, stw, sth, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.stat = { tex, fbo, w: stw, h: sth };
    this.statPixels = new Uint8Array(stw * sth * 4);
    this.loadObject();
  }

  private release() {
    const gl = this.gl;
    if (!this.dirt) return;
    destroyTarget(gl, this.objTex);
    for (const d of [this.dirt, this.run]) {
      destroyTarget(gl, d.read);
      destroyTarget(gl, d.write);
    }
    gl.deleteTexture(this.stat.tex);
    gl.deleteFramebuffer(this.stat.fbo);
  }

  /** Bake the current object and cake it in fresh mud. */
  private loadObject() {
    const gl = this.gl;
    this.objIndex = Math.max(0, OBJECTS.findIndex((o) => o.id === this.cfg.object));
    let u = this.p.bake.use();
    this.common(u);
    gl.uniform1f(u.objPx, 1 / (this.objTex.height * this.objScale));
    this.blit(this.objTex);
    this.seed = Math.random() * 100;
    u = this.p.gen.use();
    this.common(u);
    gl.uniform1f(u.seed, this.seed);
    gl.uniform1f(u.amount, this.cfg.dirtiness);
    this.blit(this.dirt.read);
    this.blit(this.dirt.write);
    for (const t of [this.run.read, this.run.write]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    this.initialDirt = 0;
    this.regionInit = [];
    this.regionDone = [];
    this.done = false;
    this.finish = 0;
    this.shine = 0;
    this.cleanFrac = 0;
    this.nextBtn.hidden = true;
    this.ctx.progress(0, 'clean');
    this.readStats(); // baseline dirt, before any spraying
  }

  private nextObject() {
    const i = (this.objIndex + 1) % OBJECTS.length;
    this.cfg.object = OBJECTS[i].id;
    this.loadObject();
  }

  // ---------------------------------------------------------------- UI

  private buildDock() {
    const dock = document.createElement('div');
    dock.className = 'dock';
    this.buttons = NOZZLES.map((n) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'rinse-noz';
      b.textContent = n.glyph;
      b.setAttribute('aria-label', n.label);
      b.style.setProperty('--swatch', n.swatch);
      b.addEventListener('click', () => this.setNozzle(n.id));
      return b;
    });
    dock.append(...this.buttons);
    this.ctx.overlay.appendChild(dock);
    this.setNozzle('jet');
    return dock;
  }

  private setNozzle(n: Nozzle) {
    this.nozzle = n;
    this.buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(NOZZLES[i].id === n)));
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice(
      'Object',
      OBJECTS.map((o) => ({ value: o.id, label: o.label })),
      c.object,
      (v) => {
        c.object = v;
        this.loadObject();
      },
    );
    panel.slider(c, 'strength', { label: 'Jet strength', min: 0.3, max: 3, step: 0.05 });
    panel.slider(c, 'width', { label: 'Spray width', min: 0.5, max: 2.5, step: 0.05 });
    panel.slider(c, 'stubborn', { label: 'Moss stubbornness', min: 0.3, max: 4, step: 0.05 });
    panel.slider(c, 'runoff', { label: 'Muddy runoff', min: 0, max: 3, step: 0.05 });
    panel.slider(c, 'dirtiness', { label: 'Dirt amount', min: 0.4, max: 1.5, step: 0.05 });
    panel.action('Re-dirty', () => this.loadObject());
    panel.action('Next object', () => this.nextObject());
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.frameNo++;
    this.updateJets(dt, t);
    this.simulate(dt, t);
    // Readback stalls the GPU a little, so only sample progress while the jet is actually working.
    if (this.frameNo % 12 === 0 && (this.jetCount > 0 || this.finish > 0)) this.readStats();
    this.feel(dt);
    this.stepMist(dt);
    this.render(t);
    this.ctx.setStatus(`${OBJECTS[this.objIndex].label} · ${Math.round(this.cleanFrac * 100)}% clean`);
  }

  private updateJets(dt: number, t: number) {
    const ptrs = [...this.ctx.pointers.active.values()];
    const aspect = this.aspect;
    const c = this.cfg;
    const targets: { x: number; y: number; stretch: number; mult: number; rMult: number }[] = [];
    const fan = this.nozzle === 'fan';
    if (ptrs.length >= 2) {
      // Two fingers: one wide fan between them.
      const a = ptrs[0], b = ptrs[1];
      const spread = Math.hypot((a.x - b.x) * aspect, a.y - b.y);
      targets.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, stretch: Math.min(5, 1.6 + spread * 9), mult: 0.75, rMult: 1 });
    } else if (ptrs.length === 1) {
      const p0 = ptrs[0];
      if (fan) targets.push({ x: p0.x, y: p0.y, stretch: 3.2, mult: 0.7, rMult: 1 });
      else if (this.nozzle === 'turbo') {
        // Turbo: a narrow, very strong jet spinning in a tight circle.
        const r = 0.012;
        targets.push({ x: p0.x + (Math.cos(t * 38) * r) / aspect, y: p0.y + Math.sin(t * 38) * r, stretch: 1, mult: 2.1, rMult: 0.65 });
      } else targets.push({ x: p0.x, y: p0.y, stretch: 1, mult: 1, rMult: 1 });
    }
    this.jetCount = targets.length;
    targets.forEach((tg, i) => {
      const dist = Math.hypot((tg.x - NOZZLE[0]) * aspect, tg.y - NOZZLE[1]);
      // Further away: a wider, weaker footprint, like a real lance.
      const radius = 0.04 * (0.6 + dist * 0.8) * c.width * tg.rMult;
      const strength = c.strength * tg.mult * Math.max(0.35, 1.35 - dist * 0.7);
      this.jetData.set([tg.x, Math.max(tg.y, GROUND - 0.05), radius, strength], i * 4);
      this.jetStretch[i] = tg.stretch;
      this.aim = [tg.x, tg.y];
      this.spawnMist(tg.x, tg.y, radius * tg.stretch, dt);
    });
  }

  private common(u: Record<string, WebGLUniformLocation>) {
    const gl = this.gl;
    gl.uniform1f(u.aspect, this.aspect);
    gl.uniform2f(u.objCenter, ...this.objCenter);
    gl.uniform1f(u.objScale, this.objScale);
    gl.uniform1i(u.objId, this.objIndex);
  }

  private jetUniforms(u: Record<string, WebGLUniformLocation>) {
    const gl = this.gl;
    gl.uniform4fv(u['jets[0]'], this.jetData);
    gl.uniform2f(u.jetStretch, this.jetStretch[0], this.jetStretch[1]);
    gl.uniform1i(u.jetCount, this.jetCount);
  }

  private simulate(dt: number, t: number) {
    const gl = this.gl;
    let u = this.p.dirt.use();
    this.common(u);
    this.jetUniforms(u);
    gl.uniform1i(u.uDirt, 0);
    gl.uniform1i(u.uObj, 1);
    gl.uniform2f(u.texel, this.dirt.texelX, this.dirt.texelY);
    gl.uniform2f(u.nozzle, ...NOZZLE);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.stubborn, this.cfg.stubborn);
    gl.uniform1f(u.finish, this.finish);
    this.bindTex(0, this.dirt.read.tex);
    this.bindTex(1, this.objTex.tex);
    this.blit(this.dirt.write);
    this.dirt.swap();

    u = this.p.run.use();
    this.common(u);
    this.jetUniforms(u);
    gl.uniform1i(u.uRun, 0);
    gl.uniform1i(u.uDirt, 1);
    gl.uniform1i(u.uObj, 2);
    gl.uniform2f(u.texel, this.run.texelX, this.run.texelY);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.time, t % 1000);
    gl.uniform1f(u.groundY, GROUND);
    gl.uniform1f(u.runoff, this.cfg.runoff);
    this.bindTex(0, this.run.read.tex);
    this.bindTex(1, this.dirt.read.tex);
    this.bindTex(2, this.objTex.tex);
    this.blit(this.run.write);
    this.run.swap();
  }

  /** Reduce to a tiny texture and read it back for "% clean" and per-region pings. */
  private readStats() {
    const gl = this.gl;
    const u = this.p.stat.use();
    this.common(u);
    gl.uniform1i(u.uDirt, 0);
    gl.uniform1i(u.uObj, 1);
    this.bindTex(0, this.dirt.read.tex);
    this.bindTex(1, this.objTex.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.stat.fbo);
    gl.viewport(0, 0, this.stat.w, this.stat.h);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.readPixels(0, 0, this.stat.w, this.stat.h, gl.RGBA, gl.UNSIGNED_BYTE, this.statPixels);
    const px = this.statPixels;
    let dirt = 0;
    const regDirt = [0, 0, 0, 0, 0, 0];
    const regX = [0, 0, 0, 0, 0, 0];
    const regY = [0, 0, 0, 0, 0, 0];
    const regN = [0, 0, 0, 0, 0, 0];
    for (let i = 0; i < this.stat.w * this.stat.h; i++) {
      if (px[i * 4 + 1] < 128) continue;
      const d = px[i * 4] / 255;
      const reg = Math.min(5, Math.round((px[i * 4 + 2] / 255) * 8));
      dirt += d;
      regDirt[reg] += d;
      regN[reg]++;
      regX[reg] += (i % this.stat.w) + 0.5;
      regY[reg] += Math.floor(i / this.stat.w) + 0.5;
    }
    if (this.initialDirt === 0) {
      if (dirt <= 0) return;
      this.initialDirt = dirt;
      this.regionInit = regDirt.slice();
      this.regionDone = regDirt.map(() => false);
      return;
    }
    this.cleanFrac = Math.max(0, Math.min(1, 1 - dirt / this.initialDirt));
    if (!this.done) this.ctx.progress(this.cleanFrac, 'clean');
    // A part (head, beak, crate…) coming fully clean gets its own little ping.
    for (let r = 1; r <= 5; r++) {
      if (this.regionDone[r] || this.regionInit[r] < 3) continue;
      if (regDirt[r] / this.regionInit[r] < 0.015) {
        this.regionDone[r] = true;
        this.ctx.haptic('medium');
        const cx = regX[r] / regN[r] / this.stat.w;
        const cy = regY[r] / regN[r] / this.stat.h;
        for (let k = 0; k < 40; k++) this.sparkleAt(cx, cy);
      }
    }
    if (!this.done && this.cleanFrac >= 0.985) {
      this.done = true;
      this.doneAt = this.time;
      this.finish = 1;
      this.wiggle = 1;
      this.shine = 1;
      this.ctx.progress(1, 'clean');
      this.ctx.celebrate('Sparkling clean!');
      this.ctx.haptic('heavy');
      setTimeout(() => (this.nextBtn.hidden = !this.done), 900);
    }
  }

  private sampleDirtAt(x: number, y: number) {
    const sx = Math.floor(x * this.stat.w), sy = Math.floor(y * this.stat.h);
    if (sx < 0 || sy < 0 || sx >= this.stat.w || sy >= this.stat.h) return 0;
    return this.statPixels[(sy * this.stat.w + sx) * 4] / 255;
  }

  /** Jet hiss: ticks while the jet is chewing through dirt, faster when it's thick. */
  private feel(dt: number) {
    this.wiggle *= Math.exp(-dt * 2.5);
    this.shine *= Math.exp(-dt * 0.8);
    if (this.done && this.time - this.doneAt > 6) this.nextObject();
    if (!this.jetCount) return;
    const d = this.sampleDirtAt(this.jetData[0], this.jetData[1]);
    if (d < 0.08) return;
    this.hissClock += dt;
    if (this.hissClock > 0.11 - 0.05 * d) {
      this.hissClock = 0;
      this.ctx.haptic('light');
    }
  }

  private spawnMist(x: number, y: number, r: number, dt: number) {
    const n = Math.round(260 * dt);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 0.1 + Math.random() * 0.35;
      this.mist.push({
        x: x + (Math.cos(a) * r * 0.5) / this.aspect,
        y: y + Math.sin(a) * r * 0.5,
        vx: (Math.cos(a) * s) / this.aspect,
        vy: Math.abs(Math.sin(a)) * s * 0.9 + 0.05,
        life: 0.5 + Math.random() * 0.4,
        size: 3 + Math.random() * 6,
      });
    }
    if (this.mist.length > 600) this.mist.splice(0, this.mist.length - 600);
  }

  private sparkleAt(x: number, y: number) {
    const a = Math.random() * Math.PI * 2;
    const s = 0.08 + Math.random() * 0.3;
    this.mist.push({ x, y, vx: (Math.cos(a) * s) / this.aspect, vy: Math.sin(a) * s + 0.1, life: 1, size: 5 + Math.random() * 5 });
  }

  private stepMist(dt: number) {
    for (const m of this.mist) {
      m.life -= dt * 1.4;
      m.vy -= 0.9 * dt;
      m.vx *= Math.exp(-dt * 2);
      m.x += m.vx * dt;
      m.y += m.vy * dt;
    }
    this.mist = this.mist.filter((m) => m.life > 0);
  }

  private render(t: number) {
    const gl = this.gl;
    const u = this.p.display.use();
    this.common(u);
    this.jetUniforms(u);
    gl.uniform1i(u.uDirt, 0);
    gl.uniform1i(u.uRun, 1);
    gl.uniform1f(u.objPx, 1 / (this.height * this.objScale));
    gl.uniform1f(u.time, t % 1000);
    gl.uniform1f(u.groundY, GROUND);
    gl.uniform1f(u.wiggle, this.wiggle);
    gl.uniform1f(u.shine, this.shine);
    gl.uniform2f(u.nozzle, ...NOZZLE);
    gl.uniform2f(u.aim, ...this.aim);
    this.bindTex(0, this.dirt.read.tex);
    this.bindTex(1, this.run.read.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (this.mist.length) {
      const d = this.mistData;
      this.mist.forEach((m, i) => d.set([m.x, m.y, Math.min(1, m.life), m.size], i * 4));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.mistBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, this.mist.length * 4));
      const mu = this.p.mist.use();
      gl.uniform1f(mu.pixelRatio, this.ctx.pixelRatio);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.mistVao);
      gl.drawArrays(gl.POINTS, 0, this.mist.length);
      gl.disable(gl.BLEND);
    }
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
    this.release();
    this.dock.remove();
    this.nextBtn.remove();
    this.style.remove();
    this.ctx.progress(null);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
