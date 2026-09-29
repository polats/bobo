import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile, createDouble, createTarget, destroyTarget, gridSize, type DoubleTarget, type Target } from '../../shell/gl';
import * as F from '../ink/shaders';
import * as S from './shaders';
import type { Loop } from '../../shell/sound';
import { Burn, jarDist, type Jar } from './burn';

export const fireToy: Toy = {
  id: 'fire',
  title: 'Campfire',
  blurb: 'Stack logs, strike a match, blow on the embers. Fire climbs the wood; douse it and it hisses, or trap it under a jar and watch it gasp.',
  tech: 'Fire fluid + burning cells + oxygen field · WebGL2',
  swatch: 'linear-gradient(145deg,#ff9a1f,#e8410f 50%,#3a0d2e)',
  refs: [
    {
      short: 'TMP #21',
      title: 'Ten Minute Physics #21 — fire simulation',
      url: 'https://matthias-research.github.io/pages/tenMinutePhysics/index.html',
      use: 'Fire as a grid fluid with temperature: buoyancy lifts hot gas, cooling fades it. Plus an oxygen scalar on the burn grid (idea from Fire-X / FlameForge): burning uses it up, so a covered fire starves and a blown one roars.',
    },
    {
      short: 'Stam 1999',
      title: 'Stam — Stable Fluids (SIGGRAPH 1999)',
      url: 'https://dl.acm.org/doi/10.1145/311535.311548',
      use: 'The solver underneath (shared with Ink Swirl): advection, pressure projection, vorticity.',
    },
    {
      short: 'Wood combustion',
      title: 'Two Minute Papers — Burning Down Virtual Trees… In Real Time! (Interactive Wood Combustion)',
      url: 'https://www.youtube.com/watch?v=2jwVDRKKDME',
      use: 'Inspiration for fuel that burns away, chars and spreads fire along the wood.',
    },
    {
      short: 'GPU Gems 38',
      title: 'GPU Gems ch. 38 — Fast Fluid Dynamics Simulation on the GPU',
      url: 'https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu',
      use: 'Buoyancy and temperature fields as extra fragment-shader passes.',
    },
  ],
  async create(ctx) {
    return new Campfire(ctx);
  },
};

type Tool = 'match' | 'wood' | 'blow' | 'water' | 'jar';
const TOOLS: { id: Tool; label: string; glyph: string; swatch: string }[] = [
  { id: 'match', label: 'Match', glyph: '🔥', swatch: '#ff8a1f' },
  { id: 'wood', label: 'Logs', glyph: '🪵', swatch: '#9a6232' },
  { id: 'blow', label: 'Blow', glyph: '💨', swatch: '#cfe3ff' },
  { id: 'water', label: 'Water', glyph: '💧', swatch: '#3d8bff' },
  { id: 'jar', label: 'Glass jar', glyph: '🫙', swatch: '#9fc4d8' },
];

const GROUND = 0.14;
/** Bell jar size in screen-height units: tall enough to clear the teepee. */
const JAR_RX = 0.16;
const JAR_RY = 0.3;
/** Resting rim height: pressed just into the dirt, sealed. */
const JAR_REST = GROUND - 0.004;

/** The jar as the burn grid sees it, plus who's holding it and how it got there. */
interface JarState extends Jar {
  vy: number;
  holder: number | null;
  gx: number;
  gy: number;
  held: number;
  moved: number;
  grabbed: boolean;
}

class Campfire implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private p: Record<string, Program>;
  private velocity!: DoubleTarget;
  private pressure!: DoubleTarget;
  private divergence!: Target;
  private curl!: Target;
  private heat!: DoubleTarget;
  private emission!: Target;
  private bloom: Target[] = [];
  private burn!: Burn;
  private burnTex!: WebGLTexture;
  private oxyTex!: WebGLTexture;
  private jar: JarState | null = null;
  private emberVao: WebGLVertexArrayObject;
  private emberBuf: WebGLBuffer;
  private emberData = new Float32Array(900 * 4);
  private width = 1;
  private height = 1;
  private tool: Tool = 'match';
  private dock: HTMLElement;
  private buttons: HTMLButtonElement[] = [];
  private lastPos = new Map<number, [number, number]>();
  private wind = 0;
  /** Recent blowing, 0..1.5 (the oxygen itself lives per cell in the burn grid). */
  private gust = 0;
  /** The fire itself: crackle from how much is burning and how well it's fed, a roar when blown on, steam when doused. */
  private crackle: Loop;
  private roar: Loop;
  private steam: Loop;
  /** Cells hissing under the water this frame, smoothed for the steam loop. */
  private hissing = 0;
  private hissFrame = 0;
  private sizzleCool = 0;
  private whooshCool = 0;
  private catchCool = 0;

  readonly cfg = {
    simRes: 112,
    heatRes: 224,
    burnRes: 180,
    buoyancy: 1.0,
    heatRate: 1.5,
    cooling: 2.6,
    curl: 22,
    velFade: 0.6,
    spread: 2.2,
    burnRate: 0.05,
    embers: 1,
    bloom: 0.55,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This device cannot render to float textures.');
    }
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.crackle = ctx.sound.loop('crackle');
    this.roar = ctx.sound.loop('rumble');
    this.steam = ctx.sound.loop('hiss');
    const vert = compile(gl, gl.VERTEX_SHADER, F.baseVert);
    const mk = (src: string) => new Program(gl, vert, src);
    this.p = {
      splat: mk(F.splatFrag),
      advect: mk(F.advectionFrag),
      divergence: mk(F.divergenceFrag),
      curl: mk(F.curlFrag),
      vorticity: mk(F.vorticityFrag),
      pressure: mk(F.pressureFrag),
      gradient: mk(F.gradientSubtractFrag),
      clear: mk(F.clearFrag),
      prefilter: mk(F.bloomPrefilterFrag),
      blur: mk(F.blurFrag),
      source: mk(S.sourceFrag),
      buoyancy: mk(S.buoyancyFrag),
      emission: mk(S.emissionFrag),
      display: mk(S.displayFrag),
      jarVel: mk(S.jarVelFrag),
      ember: new Program(gl, compile(gl, gl.VERTEX_SHADER, S.emberVert), S.emberFrag),
    };
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.emberVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.emberVao);
    this.emberBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.emberBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.emberData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.allocate();
    this.dock = this.buildDock();
    this.buildPanel();
    this.buildCampfire();
  }

  // ---------------------------------------------------------------- resources

  private allocate() {
    const gl = this.gl;
    this.release();
    const [sw, sh] = gridSize(this.cfg.simRes, this.width, this.height);
    const [hw, hh] = gridSize(this.cfg.heatRes, this.width, this.height);
    this.velocity = createDouble(gl, sw, sh, gl.LINEAR);
    this.pressure = createDouble(gl, sw, sh, gl.NEAREST);
    this.divergence = createTarget(gl, sw, sh, gl.NEAREST);
    this.curl = createTarget(gl, sw, sh, gl.NEAREST);
    this.heat = createDouble(gl, hw, hh, gl.LINEAR);
    this.emission = createTarget(gl, hw, hh, gl.LINEAR);
    let [bw, bh] = gridSize(160, this.width, this.height);
    for (let i = 0; i < 5 && bw >= 4 && bh >= 4; i++) {
      this.bloom.push(createTarget(gl, bw, bh, gl.LINEAR));
      bw >>= 1;
      bh >>= 1;
    }
    const [cw, ch] = gridSize(this.cfg.burnRes, this.width, this.height);
    const old = this.burn;
    this.burn = new Burn(cw, ch);
    Object.assign(this.burn.cfg, { spread: this.cfg.spread, burnRate: this.cfg.burnRate, emberRate: this.cfg.embers, ground: GROUND });
    this.burn.jar = this.jar;
    if (old) this.buildCampfire();
    this.burnTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.burnTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, cw, ch, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    this.oxyTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.oxyTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1); // R8 rows needn't be 4-byte multiples
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cw, ch, 0, gl.RED, gl.UNSIGNED_BYTE, null);
    this.ctx.setStatus(`fluid ${sw}×${sh} · burn ${cw}×${ch}`);
  }

  private release() {
    const gl = this.gl;
    if (!this.velocity) return;
    for (const d of [this.velocity, this.pressure, this.heat]) {
      destroyTarget(gl, d.read);
      destroyTarget(gl, d.write);
    }
    for (const t of [this.divergence, this.curl, this.emission, ...this.bloom]) destroyTarget(gl, t);
    this.bloom = [];
    gl.deleteTexture(this.burnTex);
    gl.deleteTexture(this.oxyTex);
  }

  /** A little teepee of logs over a cross-piece, already smouldering at the base. */
  private buildCampfire() {
    const b = this.burn;
    b.clearAll();
    this.jar = b.jar = null;
    const aspect = this.width / this.height;
    const cx = 0.5;
    const s = Math.min(1, 0.55 / aspect) * 0.5; // keep the fire a sensible size in landscape
    const L = (x0: number, y0: number, x1: number, y1: number, r = 0.017) => b.log(cx + x0 * s, y0, cx + x1 * s, y1, r);
    L(-0.42, GROUND + 0.012, 0.42, GROUND + 0.02, 0.02);
    L(-0.3, GROUND + 0.03, 0.34, GROUND + 0.01, 0.018);
    L(-0.28, GROUND + 0.02, 0.04, GROUND + 0.24);
    L(0.3, GROUND + 0.02, -0.02, GROUND + 0.24);
    L(-0.06, GROUND + 0.015, 0.12, GROUND + 0.22, 0.015);
    // A spare log off to the side to light later.
    L(0.62, GROUND + 0.01, 0.98, GROUND + 0.03, 0.019);
    b.ignite(cx, GROUND + 0.035, 0.03);
  }

  // ---------------------------------------------------------------- UI

  private buildDock() {
    const dock = document.createElement('div');
    dock.className = 'dock';
    this.buttons = TOOLS.map((t) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = t.glyph;
      btn.setAttribute('aria-label', t.label);
      btn.style.setProperty('--swatch', t.swatch);
      btn.addEventListener('click', () => this.setTool(t.id));
      return btn;
    });
    dock.append(...this.buttons);
    this.ctx.overlay.appendChild(dock);
    this.setTool('match');
    return dock;
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.buttons.forEach((b, i) => b.setAttribute('aria-pressed', String(TOOLS[i].id === t)));
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    const sync = () => Object.assign(this.burn.cfg, { spread: c.spread, burnRate: c.burnRate, emberRate: c.embers });
    panel.heading('Flames');
    panel.slider(c, 'buoyancy', { label: 'Flame height', min: 0.5, max: 4, step: 0.05 });
    panel.slider(c, 'heatRate', { label: 'Heat', min: 0.5, max: 8, step: 0.1 });
    panel.slider(c, 'cooling', { label: 'Cooling', min: 0.3, max: 5, step: 0.05 });
    panel.slider(c, 'curl', { label: 'Flicker (vorticity)', min: 0, max: 50, step: 1 });
    panel.heading('Wood');
    panel.slider(c, 'spread', { label: 'Spread speed', min: 0.3, max: 6, step: 0.1, onChange: sync });
    panel.slider(c, 'burnRate', { label: 'Burn speed', min: 0.01, max: 0.3, step: 0.005, onChange: sync });
    panel.slider(c, 'embers', { label: 'Embers', min: 0, max: 4, step: 0.1, onChange: sync });
    panel.slider(c, 'bloom', { label: 'Glow', min: 0, max: 2, step: 0.05 });
    panel.action('New campfire', () => this.buildCampfire());
    panel.action('Clear everything', () => {
      this.burn.clearAll();
      this.jar = this.burn.jar = null;
    });
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.handleInput(dt);
    this.updateJar(dt);
    this.wind *= Math.exp(-dt * 1.5);
    this.gust *= Math.exp(-dt * 1.2);
    this.burn.step(dt, this.wind);
    if (this.burn.newlyLit > 6) this.ctx.haptic('light');
    this.listen(dt);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.burnTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.burn.w, this.burn.h, gl.RGBA, gl.UNSIGNED_BYTE, this.burn.tex);
    gl.bindTexture(gl.TEXTURE_2D, this.oxyTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.burn.w, this.burn.h, gl.RED, gl.UNSIGNED_BYTE, this.burn.oxyTex);
    this.step(dt, t);
    this.render(t);
    const air = this.burn.intensity > 0.005 ? ` · air ${Math.round(Math.min(2, this.burn.fed) * 100)}%` : '';
    this.ctx.setStatus(`fire ${Math.round(this.burn.intensity * 100)}%${air} · ${this.burn.embers.length} embers`);
  }

  /** Loops follow the burn state (all CPU-side); sparks pop now and then from wherever it's burning. */
  private listen(dt: number) {
    const b = this.burn;
    const fire = Math.min(1, b.intensity);
    // How well-fed the burning cells are: starved embers tick quietly, a blown-on fire roars.
    const air = Math.max(0, Math.min(1, (b.fed - 0.15) / 0.7));
    const rich = Math.min(1, Math.max(0, b.fed - 1) * 2 + this.gust * 0.6);
    const j = this.jar;
    const muffle = j && Math.abs(b.cx - j.x) * (this.width / this.height) < JAR_RX ? j.seal : 0; // heard through glass
    this.crackle.set(Math.min(1, fire * (0.3 + 0.6 * air + 0.2 * rich) * (1 - 0.35 * muffle)), 0.2 + fire * 0.2 + air * 0.3 + rich * 0.2 - muffle * 0.2);
    this.roar.set(Math.min(1, fire * (0.05 + air * 0.2 + rich * 0.8)), 0.2 + rich * 0.6);
    this.hissing += (this.hissFrame - this.hissing) * Math.min(1, dt * 8);
    this.hissFrame = 0;
    this.steam.set(Math.min(0.8, this.hissing / 60), 0.7);
    // Sap pockets bursting: more often in a bigger, better-fed fire.
    if (Math.random() < fire * dt * (0.3 + air * 1.2 + rich * 4)) {
      this.ctx.sound.play('pop', { gain: 0.08 + Math.random() * 0.2, pitch: 1.6 + Math.random() * 1.2, pan: (b.cx - 0.5) * 1.2 });
    }
    // New wood catching in a rush.
    this.catchCool -= dt;
    if (b.newlyLit > 12 && this.catchCool <= 0) {
      this.catchCool = 0.5;
      this.ctx.sound.play('whoosh', { gain: Math.min(0.5, 0.1 + b.newlyLit * 0.01), pitch: 0.5, pan: (b.cx - 0.5) * 1.2 });
    }
    this.sizzleCool -= dt;
    this.whooshCool -= dt;
  }

  private handleInput(dt: number) {
    const aspect = this.width / this.height;
    const pan = (x: number) => (x - 0.5) * 1.2;
    for (const p of this.ctx.pointers.active.values()) {
      const last = this.lastPos.get(p.id) ?? [p.x, p.y];
      this.lastPos.set(p.id, [p.x, p.y]);
      const y = Math.max(p.y, GROUND - 0.02);
      switch (this.tool) {
        case 'wood': {
          if (p.justDown) {
            this.lastPos.set(p.id, [p.x, y]);
            this.ctx.sound.play('knock', { gain: 0.5, pitch: 0.6, pan: pan(p.x) });
            break;
          }
          this.burn.log(last[0], Math.max(last[1], GROUND - 0.02), p.x, y, 0.017);
          break;
        }
        case 'match': {
          const lit = this.burn.ignite(p.x, y, 0.022);
          if (p.justDown || lit > 0) this.ctx.haptic('light');
          if (p.justDown) this.ctx.sound.play('sizzle', { gain: 0.35, pitch: 1.6, pan: pan(p.x) });
          if (lit > 4 && this.catchCool <= 0) {
            this.catchCool = 0.5;
            this.ctx.sound.play('whoosh', { gain: 0.35, pitch: 0.6, pan: pan(p.x) });
          }
          this.splat(this.heat, p.x, y, 0, 0, [0.9, 0.05, 0], 0.08);
          break;
        }
        case 'blow': {
          const dx = (p.x - last[0]) * (aspect < 1 ? aspect : 1);
          const dy = p.y - last[1];
          const speed = Math.hypot(dx, dy) / Math.max(dt, 1e-3);
          if (speed > 0.05) {
            this.splat(this.velocity, p.x, p.y, dx * 5000, dy * 5000, [0, 0, 0], 0.35);
            this.wind = Math.max(-1.5, Math.min(1.5, this.wind + dx * 18));
            this.gust = Math.min(1.5, this.gust + speed * dt * 1.5);
            // Fresh air along the whole stroke, richer the faster you blow.
            const puff = Math.min(0.25, speed * dt * 0.6);
            for (let k = 0; k <= 2; k++) this.burn.breathe(last[0] + (p.x - last[0]) * k * 0.5, last[1] + (p.y - last[1]) * k * 0.5, 0.08, puff);
            if (speed > 1) this.ctx.haptic('light');
            if (speed > 0.8 && this.whooshCool <= 0) {
              this.whooshCool = 0.3;
              this.ctx.sound.play('whoosh', { gain: Math.min(0.7, 0.15 + speed * 0.1), pitch: 0.9 + Math.min(0.5, speed * 0.08), pan: pan(p.x) });
            }
          }
          break;
        }
        case 'water': {
          const hissed = this.burn.douse(p.x, y, 0.045);
          this.splat(this.heat, p.x, y, 0, 0, [-0.8, 0, 0.35 + Math.min(1, hissed / 40)], 0.25);
          this.splat(this.velocity, p.x, y, 0, -250, [0, 0, 0], 0.3);
          if (hissed > 3) this.ctx.haptic('medium');
          if (p.justDown) this.ctx.sound.play('splash', { gain: 0.4, pitch: 1.2, pan: pan(p.x) });
          this.hissFrame += hissed;
          if (hissed > 3 && this.sizzleCool <= 0) {
            this.sizzleCool = 0.15;
            this.ctx.sound.play('sizzle', { gain: Math.min(0.9, 0.3 + hissed / 60), pitch: 0.9 + Math.random() * 0.3, pan: pan(p.x) });
          }
          break;
        }
        case 'jar': {
          this.holdJar(p.id, p.x, p.y, p.justDown, dt);
          break;
        }
      }
    }
    for (const id of [...this.lastPos.keys()]) if (!this.ctx.pointers.active.has(id)) this.lastPos.delete(id);
  }

  // ---------------------------------------------------------------- the jar

  /** Touch near the jar to pick it up; anywhere else brings it (one jar), held by its knob. */
  private holdJar(id: number, x: number, y: number, down: boolean, dt: number) {
    let j = this.jar;
    if (down && (!j || j.holder === null)) {
      const d = j ? jarDist(j, x, y - 0.04, this.width / this.height) : null;
      if (j && d !== null && d < 0.05) {
        Object.assign(j, { holder: id, gx: j.x - x, gy: j.y - y, grabbed: true });
      } else {
        const gy = -(JAR_RY + 0.025);
        j = this.jar = { x, y: Math.max(JAR_REST, y + gy), rx: JAR_RX, ry: JAR_RY, seal: 0, vy: 0, holder: id, gx: 0, gy, held: 0, moved: 0, grabbed: false };
        this.burn.jar = j;
        this.ctx.sound.play('whoosh', { gain: 0.12, pitch: 1.4, pan: (x - 0.5) * 1.2 });
      }
      j.held = j.moved = 0;
      j.vy = 0;
    }
    if (!j || j.holder !== id) return;
    const nx = x + j.gx, ny = Math.max(JAR_REST, y + j.gy);
    j.moved += Math.hypot(nx - j.x, ny - j.y);
    j.held += dt;
    if (ny <= JAR_REST && j.y > JAR_REST + 0.003) this.clink(Math.min(1, (j.y - ny) / Math.max(dt, 1e-3) / 2));
    j.x = nx;
    j.y = ny;
  }

  /** Let go (it drops onto the ground), and lift away on a tap or when let go up high. */
  private updateJar(dt: number) {
    const j = this.jar;
    if (!j) return;
    if (j.holder !== null && !this.ctx.pointers.active.has(j.holder)) {
      j.holder = null;
      if ((j.grabbed && j.moved < 0.015 && j.held < 0.3) || j.y > GROUND + 0.4) return this.liftJar();
    }
    if (j.holder === null && j.y > JAR_REST) {
      j.vy -= 3.5 * dt;
      j.y += j.vy * dt;
      if (j.y <= JAR_REST) {
        j.y = JAR_REST;
        this.clink(Math.min(1, -j.vy / 2));
        j.vy = 0;
      }
    }
    // Any gap under the rim lets air in; pressed onto the ground it's sealed.
    j.seal = 1 - Math.min(1, Math.max(0, (j.y - JAR_REST) / 0.05));
  }

  private clink(speed: number) {
    const pan = ((this.jar?.x ?? 0.5) - 0.5) * 1.2;
    this.ctx.sound.play('knock', { gain: 0.15 + speed * 0.4, pitch: 2.6, pan });
    this.ctx.sound.play('chime', { gain: 0.05 + speed * 0.1, pitch: 1.7, pan });
    this.ctx.haptic('medium');
  }

  /** Lifting a sealed jar off a smouldering fire: the rush of air brings it roaring back. */
  private liftJar() {
    const j = this.jar;
    if (!j) return;
    const b = this.burn;
    const under = Math.abs(b.cx - j.x) * (this.width / this.height) < JAR_RX && b.cy < j.y + JAR_RY;
    if (j.seal > 0.5 && under && b.intensity > 0.01) {
      b.breathe(j.x, j.y + JAR_RY * 0.3, JAR_RY * 0.5, 0.6);
      this.splat(this.heat, j.x, j.y + JAR_RY * 0.35, 0, 0, [0.6, 0.25, 0], 0.5);
      this.ctx.sound.play('whoosh', { gain: 0.6, pitch: 0.55, pan: (j.x - 0.5) * 1.2 });
      this.ctx.haptic('heavy');
    } else {
      this.ctx.sound.play('whoosh', { gain: 0.15, pitch: 1.3, pan: (j.x - 0.5) * 1.2 });
    }
    this.jar = b.jar = null;
  }

  private splat(target: DoubleTarget, x: number, y: number, vx: number, vy: number, color: [number, number, number], radius: number) {
    const gl = this.gl;
    const aspect = this.width / this.height;
    const u = this.p.splat.use();
    gl.uniform1i(u.uTarget, 0);
    gl.uniform1f(u.aspectRatio, aspect);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, (radius / 100) * (aspect > 1 ? aspect : 1));
    if (target === this.velocity) gl.uniform3f(u.color, vx, vy, 0);
    else gl.uniform3f(u.color, color[0], color[1], color[2]);
    this.bindTex(0, target.read.tex);
    this.blit(target.write);
    target.swap();
  }

  private step(dt: number, t: number) {
    const gl = this.gl;
    const c = this.cfg;
    const vel = this.velocity;
    gl.disable(gl.BLEND);

    let u = this.p.source.use();
    gl.uniform1i(u.uHeat, 0);
    gl.uniform1i(u.uBurn, 1);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.time, t % 1000);
    gl.uniform1f(u.heatRate, c.heatRate);
    gl.uniform1f(u.cooling, c.cooling);
    gl.uniform1f(u.aspect, this.width / this.height);
    gl.uniform1i(u.uOxy, 2);
    this.jarUniforms(u);
    this.bindTex(0, this.heat.read.tex);
    this.bindTex(1, this.burnTex);
    this.bindTex(2, this.oxyTex);
    this.blit(this.heat.write);
    this.heat.swap();

    u = this.p.buoyancy.use();
    gl.uniform1i(u.uVelocity, 0);
    gl.uniform1i(u.uHeat, 1);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.buoyancy, c.buoyancy * 600);
    gl.uniform1f(u.wind, this.wind);
    this.bindTex(0, vel.read.tex);
    this.bindTex(1, this.heat.read.tex);
    this.blit(vel.write);
    vel.swap();

    u = this.p.curl.use();
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
    gl.uniform1f(u.value, 0.8);
    this.bindTex(0, this.pressure.read.tex);
    this.blit(this.pressure.write);
    this.pressure.swap();

    u = this.p.pressure.use();
    gl.uniform2f(u.texelSize, vel.texelX, vel.texelY);
    gl.uniform1i(u.uDivergence, 1);
    this.bindTex(1, this.divergence.tex);
    gl.uniform1i(u.uPressure, 0);
    for (let i = 0; i < 18; i++) {
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

    if (this.jar) {
      u = this.p.jarVel.use();
      gl.uniform1i(u.uVelocity, 0);
      gl.uniform1f(u.aspect, this.width / this.height);
      this.jarUniforms(u);
      this.bindTex(0, vel.read.tex);
      this.blit(vel.write);
      vel.swap();
    }

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

    gl.uniform2f(u.texelSize, this.heat.texelX, this.heat.texelY);
    gl.uniform1f(u.dissipation, 0.05);
    this.bindTex(0, vel.read.tex);
    this.bindTex(1, this.heat.read.tex);
    this.blit(this.heat.write);
    this.heat.swap();
  }

  private jarUniforms(u: Record<string, WebGLUniformLocation>) {
    const j = this.jar;
    this.gl.uniform4f(u.jar, j?.x ?? 0, j?.y ?? 0, j ? 1 : 0, j?.seal ?? 0);
    this.gl.uniform2f(u.jarR, JAR_RX, JAR_RY);
  }

  private sceneUniforms(u: Record<string, WebGLUniformLocation>, t: number) {
    const gl = this.gl;
    gl.uniform1i(u.uHeat, 0);
    gl.uniform1i(u.uBurn, 1);
    gl.uniform1i(u.uOxy, 3);
    this.jarUniforms(u);
    gl.uniform2f(u.burnTexel, 1 / this.burn.w, 1 / this.burn.h);
    gl.uniform1f(u.time, t % 1000);
    gl.uniform1f(u.groundY, GROUND);
    gl.uniform1f(u.aspect, this.width / this.height);
    gl.uniform3f(u.light, this.burn.cx, Math.max(GROUND, this.burn.cy + 0.04), Math.min(1, this.burn.intensity));
    this.bindTex(0, this.heat.read.tex);
    this.bindTex(1, this.burnTex);
    this.bindTex(3, this.oxyTex);
  }

  private render(t: number) {
    const gl = this.gl;
    // Emission → bloom chain.
    let u = this.p.emission.use();
    this.sceneUniforms(u, t);
    this.blit(this.emission);
    const levels = this.bloom;
    u = this.p.prefilter.use();
    const thr = 0.55, knee = thr * 0.7;
    gl.uniform1i(u.uTexture, 0);
    gl.uniform3f(u.curve, thr - knee, knee * 2, 0.25 / knee);
    gl.uniform1f(u.threshold, thr);
    gl.uniform2f(u.texelSize, this.emission.texelX, this.emission.texelY);
    this.bindTex(0, this.emission.tex);
    this.blit(levels[0]);
    u = this.p.blur.use();
    gl.uniform1i(u.uTexture, 0);
    for (let i = 1; i < levels.length; i++) {
      gl.uniform2f(u.texelSize, levels[i - 1].texelX, levels[i - 1].texelY);
      this.bindTex(0, levels[i - 1].tex);
      this.blit(levels[i]);
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    for (let i = levels.length - 1; i > 0; i--) {
      gl.uniform2f(u.texelSize, levels[i].texelX, levels[i].texelY);
      this.bindTex(0, levels[i].tex);
      this.blit(levels[i - 1]);
    }
    gl.disable(gl.BLEND);

    u = this.p.display.use();
    this.sceneUniforms(u, t);
    gl.uniform1i(u.uBloom, 2);
    gl.uniform1f(u.bloomIntensity, this.cfg.bloom);
    this.bindTex(2, levels[0].tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // Embers on top, additive.
    const em = this.burn.embers;
    if (em.length) {
      const d = this.emberData;
      em.forEach((e, i) => d.set([e.x, e.y, e.life, e.size], i * 4));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.emberBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, em.length * 4));
      const eu = this.p.ember.use();
      gl.uniform1f(eu.pixelRatio, this.ctx.pixelRatio);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.bindVertexArray(this.emberVao);
      gl.drawArrays(gl.POINTS, 0, em.length);
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
    this.crackle.stop();
    this.roar.stop();
    this.steam.stop();
    this.release();
    this.dock.remove();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
