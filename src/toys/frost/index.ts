import type { Loop, Slip } from '../../shell/sound';
import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile } from '../../shell/gl';
import { Drops, dropRadius, MAX_DROPS } from './drops';
import * as S from './shaders';

export const frostToy: Toy = {
  id: 'frost',
  title: 'Frost Window',
  blurb: 'A cold window at night. Breathe on it to fog the glass, write in the fog, and watch frost ferns grow from your lines. Hold a warm finger on it to melt a peephole and send drops running down.',
  tech: 'Reiter hex-lattice crystal growth + fog, heat and melt water on WebGL2 · CPU drops',
  swatch: 'radial-gradient(circle at 70% 30%,#ffb25a 0 3%,rgba(255,160,70,.35) 9%,transparent 26%),radial-gradient(circle at 20% 85%,rgba(220,235,255,.8) 0 8%,transparent 30%),linear-gradient(180deg,#0b1224,#060913)',
  refs: [
    {
      short: 'Reiter 2005',
      title: 'A local cellular model for snow crystal growth (C. Reiter, Chaos, Solitons & Fractals 2005)',
      url: 'https://doi.org/10.1016/S0960-0779(04)00374-1',
      use: 'The growth rule: on a hexagonal lattice, receptive cells (ice or touching ice) keep their water and gain a constant supply γ, while the rest diffuse (weight α). Here γ follows the vapour in the air over each spot and the far-field level comes from room humidity and your breath.',
    },
    {
      short: 'Libbrecht 2005',
      title: 'The physics of snow crystals (K. Libbrecht, Rep. Prog. Phys. 2005)',
      url: 'https://doi.org/10.1088/0034-4885/68/4/R03',
      use: 'Why more vapour gives branchier, faster crystals and less gives compact plates: the Cold slider lowers the background supply, the Humidity slider and your breath raise it.',
    },
    {
      short: 'Bergeron process',
      title: 'Wegener–Bergeron–Findeisen process (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Wegener%E2%80%93Bergeron%E2%80%93Findeisen_process',
      use: 'Ice holds less vapour than water, so frost grows at the expense of the fog around it: fog droplets evaporate into the vapour field and supercooled droplets freeze onto the front.',
    },
    {
      short: 'Contact-angle hysteresis',
      title: 'Contact angle: hysteresis (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Contact_angle#Contact_angle_hysteresis',
      use: 'Why drops sit still until they gather enough water, then run down in jerks and leave a trail.',
    },
  ],
  async create(ctx) {
    return new Frost(ctx);
  },
};

/** Lattice cells across the screen's short side, and the most cells the pane may have. */
const BASE = 240;
const MAX_CELLS = 170_000;
/** Lattice steps per frame. */
const STEPS = 5;
/** Readback blocks. */
const BX = 8;
const BY = 16;
const READ_EVERY = 4;

interface Finger {
  x: number;
  y: number;
  moved: number;
  still: number;
  mode: 'pending' | 'draw' | 'warm';
  speed: number;
}

interface Sim {
  A: WebGLTexture[];
  B: WebGLTexture[];
  fbo: WebGLFramebuffer[];
  W: number;
  H: number;
}

class Frost implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private pStep: Program;
  private pInit: Program;
  private pSum: Program;
  private pComp: Program;
  private pDrop: Program;
  private quad: WebGLVertexArrayObject;
  private dropVao: WebGLVertexArrayObject;
  private dropBuf: WebGLBuffer;
  private dropData = new Float32Array(MAX_DROPS * 4);
  private sim!: Sim;
  private cur = 0;
  private sumTex: WebGLTexture;
  private sumFbo: WebGLFramebuffer;
  private pbo: WebGLBuffer[];
  private pboIdx = 0;
  private fence: WebGLSync | null = null;
  private sums = new Float32Array(BX * BY * 4);
  private block = [1, 1];

  private width = 1;
  private height = 1;
  private px = 1;
  private X = 1;
  private Y = 1;
  private cellPx = 1;
  private lamp = [0.7, 1.2];

  private step = 1;
  private frameNo = 0;
  private time = 0;
  private readStep = 0;
  private readTime = 0;
  private pendingSince = 0;
  private pendingTime = 0;

  private saData = new Float32Array(S.MAX_STAMPS * 4);
  private sbData = new Float32Array(S.MAX_STAMPS * 4);
  private stamps: number[][] = [];

  private fingers = new Map<number, Finger>();
  private drops = new Drops();
  private breath = 0;
  private breathHeld = false;
  private breathX = 0.5;

  // Stats from the last readback.
  private ice = 0;
  private fog = 0;
  private growth = 0;
  private growthSm = 0;
  private tickDebt = 0;
  private blockFresh = new Float32Array(BX * BY);

  private hissLoop: Loop;
  private scrapeLoop: Loop;
  private trickleLoop: Loop;
  private squeak: Slip;
  private style: HTMLStyleElement;
  private btn: HTMLButtonElement;
  private hint: HTMLElement;
  private hintStage = 0;
  private hintUntil = 0;
  private cpuMs = 0;

  readonly cfg = { humidity: 0.6, cold: 0.6 };
  /**
   * Model constants (dev hook can override): sw = vapour the cold pane holds before fog condenses;
   * alpha = Reiter's diffusion weight; room vapour H = sw * (h0 + h1 * humidity); kappa = exchange with
   * the room air per step; g0 = Reiter's gamma at mild cold; seam = how strongly a finger line seeds ice.
   */
  private tune = { sw: 0.32, alpha: 0.5, h0: 0.45, h1: 0.4, kappa: 0.00005, g0: 0.003, seam: 0.9, steps: STEPS };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    // The growth rule adds tiny amounts each step, so the lattice needs full 32-bit floats.
    if (!gl.getExtension('EXT_color_buffer_float')) throw new Error('This device cannot render to float textures.');
    this.gl = gl;
    const vert = compile(gl, gl.VERTEX_SHADER, S.quadVert);
    this.pStep = new Program(gl, vert, S.stepFrag);
    this.pInit = new Program(gl, vert, S.initFrag);
    this.pSum = new Program(gl, vert, S.sumFrag);
    this.pComp = new Program(gl, vert, S.compFrag);
    this.pDrop = new Program(gl, compile(gl, gl.VERTEX_SHADER, S.dropVert), S.dropFrag);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.dropVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dropVao);
    this.dropBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dropBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.dropData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindVertexArray(null);

    this.sumTex = this.floatTex(BX, BY);
    this.sumFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sumFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.sumTex, 0);
    // Two pack buffers, alternated, so a read never lands in a buffer that is still being fetched.
    this.pbo = [0, 1].map(() => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.sums.byteLength, gl.STREAM_READ);
      return b;
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);

    this.hissLoop = ctx.sound.loop('hiss');
    this.scrapeLoop = ctx.sound.loop('crackle');
    this.trickleLoop = ctx.sound.loop('trickle');
    this.squeak = ctx.sound.slip();

    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.btn = document.createElement('button');
    this.btn.type = 'button';
    this.btn.className = 'frost-breath';
    this.btn.innerHTML = '<span>Hold to breathe</span>';
    const hold = (on: boolean) => (e: Event) => {
      e.preventDefault();
      this.breathHeld = on;
      this.btn.classList.toggle('on', on);
    };
    this.btn.addEventListener('pointerdown', hold(true));
    this.btn.addEventListener('pointerup', hold(false));
    this.btn.addEventListener('pointercancel', hold(false));
    this.btn.addEventListener('pointerleave', hold(false));
    this.btn.addEventListener('contextmenu', (e) => e.preventDefault());
    this.hint = document.createElement('div');
    this.hint.className = 'frost-hint';
    this.hint.textContent = 'Breathe on the glass, then draw in the fog';
    ctx.overlay.append(this.btn, this.hint);
    ctx.mic.offer('Breathe on the glass');

    ctx.panel.slider(this.cfg, 'humidity', { label: 'Humidity', min: 0, max: 1, step: 0.05 });
    ctx.panel.slider(this.cfg, 'cold', { label: 'Cold', min: 0, max: 1, step: 0.05 });
    ctx.panel.action('Clear pane', () => this.reset());

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.build();

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__frost = () => ({
        grid: [this.sim.W, this.sim.H],
        cellPx: +this.cellPx.toFixed(2),
        step: this.step,
        ice: this.ice,
        fog: +this.fog.toFixed(4),
        growth: Math.round(this.growth),
        breath: +this.breath.toFixed(2),
        drops: this.drops.list.length,
        running: this.drops.running,
        heat: [...this.fingers.values()].map((f) => [f.mode, +f.still.toFixed(2)]),
        cpuMs: +this.cpuMs.toFixed(2),
      });
      w.__frostBreath = (v: boolean) => (this.breathHeld = v);
      w.__frostBlocks = () => Array.from(this.sums);
      w.__frostReset = () => this.reset();
      w.__frostCfg = (o: Partial<typeof this.cfg>) => Object.assign(this.cfg, o);
      w.__frostTune = (o: Partial<typeof this.tune>) => Object.assign(this.tune, o);
    }
  }

  // ---------------------------------------------------------------- setup

  private floatTex(w: number, h: number) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA32F, w, h);
    return t;
  }

  /** (Re)create the lattice for the current canvas size. */
  private build() {
    const gl = this.gl;
    if (this.sim) this.freeSim();
    this.px = Math.min(this.width, this.height);
    this.X = this.width / this.px;
    this.Y = this.height / this.px;
    this.lamp = [this.X * 0.7, this.Y * 0.66];
    let cell = this.px / BASE;
    let W = Math.ceil(this.width / cell) + 1;
    let H = Math.ceil(this.height / (cell * 0.8660254)) + 1;
    if (W * H > MAX_CELLS) {
      cell *= Math.sqrt((W * H) / MAX_CELLS);
      W = Math.ceil(this.width / cell) + 1;
      H = Math.ceil(this.height / (cell * 0.8660254)) + 1;
    }
    this.cellPx = cell;
    const A = [this.floatTex(W, H), this.floatTex(W, H)];
    const B = [this.floatTex(W, H), this.floatTex(W, H)];
    const fbo = [0, 1].map((i) => {
      const f = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, f);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, A[i], 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, B[i], 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('This device cannot render to float textures.');
      return f;
    });
    this.sim = { A, B, fbo, W, H };
    this.block = [Math.ceil(W / BX), Math.ceil(H / BY)];
    this.reset();
  }

  private freeSim() {
    const gl = this.gl;
    for (const t of [...this.sim.A, ...this.sim.B]) gl.deleteTexture(t);
    for (const f of this.sim.fbo) gl.deleteFramebuffer(f);
  }

  /** A fresh cold pane: light fog low down, old scratches, and a short opening breath already on it. */
  private reset() {
    const gl = this.gl;
    const { W, H } = this.sim;
    this.drops.clear();
    this.stamps.length = 0;
    const u = this.pInit.use();
    gl.uniform2i(u.uSize, W, H);
    gl.uniform1f(u.uH, this.params().H);
    gl.uniform1f(u.uSeed, Math.random() * 100);
    for (const i of [0, 1]) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sim.fbo[i]);
      gl.viewport(0, 0, W, H);
      gl.bindVertexArray(this.quad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    // Old scratches on the glass: faint seams where frost will find a foothold.
    const cw = this.width / this.cellPx, ch = this.height / this.cellPx;
    for (let i = 0; i < 7; i++) {
      const x = Math.random() * cw, y = Math.random() * ch;
      const a = Math.random() * Math.PI, len = (0.08 + Math.random() * 0.25) * cw;
      this.stamps.push([x, y, 1.3, 0, 0, Math.cos(a) * len, Math.sin(a) * len, 0.35]);
    }
    // A night's start: a few crystals already rooted along the bottom of the frame and in its corners.
    const ww = this.X, hh = this.Y;
    const seeds: [number, number][] = [[0.02, 0.02], [ww - 0.02, 0.02], [0.02, hh - 0.02], [ww - 0.02, hh - 0.02]];
    for (let i = 0; i < 4; i++) seeds.push([0.1 + Math.random() * (ww - 0.2), 0.02]);
    for (let i = 0; i < 2; i++) seeds.push([Math.random() < 0.5 ? 0.02 : ww - 0.02, 0.2 + Math.random() * (hh - 0.4)]);
    for (const [x, y] of seeds) this.stamp(3, x, y, 0.004, 1, 0, 0, Math.random());
    // Warm the pane up so those have a head start.
    for (let k = 0; k < 70; k++) this.simulate(1 / 60, k / 60, 0);
  }

  private params() {
    const { humidity, cold } = this.cfg;
    const Sw = this.tune.sw;
    return {
      alpha: this.tune.alpha,
      // Mild cold: plenty of background supply, compact plates; deep cold: sparse supply, dendrites.
      gamma: this.tune.g0 * Math.pow(0.03, cold),
      Sw,
      kappa: this.tune.kappa,
      H: Sw * (this.tune.h0 + this.tune.h1 * humidity),
      nucT: Sw * (0.5 - 0.2 * cold),
      nucRate: 0.00002 * (0.3 + cold),
      refreeze: 0.002 + 0.012 * cold,
    };
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    const t0 = import.meta.env.DEV ? performance.now() : 0;
    this.time = t;
    this.frameNo++;
    this.readback();
    this.input(dt);
    const blow = this.ctx.mic.active ? this.ctx.mic.blow : 0;
    const target = Math.max(blow * 1.1, this.breathHeld ? 0.6 + 0.12 * Math.sin(t * 2.3) : 0);
    this.breath += (Math.min(1, target) - this.breath) * Math.min(1, dt * (target > this.breath ? 6 : 2.5));
    if (this.breath > 0.05 && this.hintStage === 0) this.hint.classList.add('gone');
    this.stepDrops(dt, t);
    this.simulate(dt, t, this.breath);
    this.requestSums();
    this.draw();
    this.juice(dt);
    this.ctx.setStatus(`frost ${((this.ice / (this.sim.W * this.sim.H)) * 100).toFixed(1)}% · ${this.drops.list.length} drops`);
    if (import.meta.env.DEV) this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
  }

  /** World (short side = 1) to lattice space. */
  private toCell(x: number, y: number): [number, number] {
    const k = this.px / this.cellPx;
    return [x * k, y * k];
  }

  private stamp(kind: number, x: number, y: number, r: number, str: number, dx = 0, dy = 0, extra = 0) {
    const [cx, cy] = this.toCell(x, y);
    const k = this.px / this.cellPx;
    this.stamps.push([cx, cy, r * k, kind, str, dx * k, dy * k, extra]);
  }

  private input(dt: number) {
    const seen = new Set<number>();
    for (const p of this.ctx.pointers.active.values()) {
      seen.add(p.id);
      const x = p.x * this.X, y = p.y * this.Y;
      let f = this.fingers.get(p.id);
      if (!f || p.justDown) {
        f = { x, y, moved: 0, still: 0, mode: 'pending', speed: 0 };
        this.fingers.set(p.id, f);
        this.ctx.haptic('light');
        if (this.hintStage !== 1) this.hint.classList.add('gone');
      }
      const dx = x - f.x, dy = y - f.y;
      const d = Math.hypot(dx, dy);
      f.moved += d;
      f.speed += (d / Math.max(dt, 1e-3) - f.speed) * Math.min(1, dt * 14);
      f.still = f.speed < 0.04 ? f.still + dt : 0;
      if (f.mode === 'pending' && f.moved > 0.012) f.mode = 'draw';
      if (f.still > 0.4) f.mode = 'warm';
      else if (f.mode === 'warm' && f.speed > 0.15) f.mode = 'draw';
      const r = 0.017;
      // A finger drawn across the glass wipes a line; one that rests warms the glass until it melts.
      if (f.mode === 'draw' || (f.mode === 'pending' && d > 0)) this.stamp(0, f.x, f.y, r, 1, dx, dy, this.tune.seam);
      if (f.mode === 'warm' || f.still > 0.15) {
        const ramp = Math.min(1, (f.still - 0.15) / 1.2);
        this.stamp(1, x, y, 0.036, 0.03 + 0.1 * ramp);
      }
      f.x = x;
      f.y = y;
    }
    for (const [id, f] of this.fingers) {
      if (seen.has(id)) continue;
      // After the first line, point at the other verb once.
      if (f.mode === 'draw' && this.hintStage === 0) {
        this.hintStage = 1;
        this.hint.textContent = 'Rest a finger on the frost to melt it';
        this.hint.classList.remove('gone');
        this.hintUntil = this.time + 4;
      }
      if (f.mode === 'warm') this.hintStage = 2;
      this.fingers.delete(id);
    }
    if (this.hintStage === 1 && this.time > this.hintUntil) this.hint.classList.add('gone');
  }

  private stepDrops(dt: number, t: number) {
    const D = this.drops;
    // Film under the pane turns into drops: in a warm spot they bead at its lower rim, elsewhere
    // (heavy fog running together) anywhere in the block.
    if (this.frameNo % READ_EVERY === 0) {
      const [bw, bh] = this.block;
      const cells = bw * bh;
      const k = this.cellPx / this.px;
      let made = 0;
      for (let j = 0; j < BY && made < 3; j++)
        for (let i = 0; i < BX && made < 3; i++) {
          const o = (j * BX + i) * 4;
          const wet = this.sums[o + 3] / cells;
          if (wet < 0.12 || Math.random() > wet * 2) continue;
          const bx0 = i * bw * k, by0 = j * bh * k * 0.8660254;
          let x = bx0 + Math.random() * bw * k, y = by0 + Math.random() * bh * k * 0.866;
          for (const f of this.fingers.values()) {
            if (f.mode !== 'warm') continue;
            if (Math.abs(f.x - (bx0 + bw * k * 0.5)) < bw * k && Math.abs(f.y - (by0 + bh * k * 0.43)) < bh * k) {
              const a = -Math.PI / 2 + (Math.random() - 0.5) * 2.2;
              x = f.x + Math.cos(a) * 0.035;
              y = f.y + Math.sin(a) * 0.035;
            }
          }
          const ra = 0.012;
          const area = Math.PI * (ra / k) ** 2;
          D.add(x, y, Math.min(6, wet * area * 0.35));
          this.stamp(4, x, y, ra, 1);
          made++;
        }
      // Pinned drops soak up the film around them and swell.
      for (const d of D.list) {
        const b = this.blockAt(d.x, d.y);
        const wet = this.sums[b * 4 + 3] / cells;
        if (wet > 0.02 && d.vy > -0.01) {
          d.m += wet * 2.5;
          this.stamp(4, d.x, d.y, dropRadius(d.m) * 2, 1);
        }
      }
    }
    const [bw, bh] = this.block;
    const freezeAfter = 1.2 + 6 * (1 - this.cfg.cold);
    D.step(
      dt,
      t,
      freezeAfter,
      (x, y) => (this.sums[this.blockAt(x, y) * 4] / (bw * bh)) * 1.5,
      (x0, y0, x1, y1, r) => this.stamp(2, x0, y0, r * 0.8, 0.12, x1 - x0, y1 - y0),
    );
    for (const d of D.frozen) {
      this.stamp(3, d.x, d.y, dropRadius(d.m) * 0.9, 1, 0, 0, Math.random());
      this.ctx.sound.crumple(0.3, { stiffness: 0.9, pan: (d.x / this.X) * 2 - 1 });
    }
    if (D.merges) this.ctx.sound.play('plop', { gain: 0.12, pitch: 1.6 + Math.random() * 0.5 });
  }

  private blockAt(x: number, y: number) {
    const [cx, cy] = this.toCell(x, y);
    const i = Math.max(0, Math.min(BX - 1, Math.floor(cx / this.block[0])));
    const j = Math.max(0, Math.min(BY - 1, Math.floor(cy / 0.8660254 / this.block[1])));
    return j * BX + i;
  }

  private simulate(dt: number, t: number, breath: number) {
    const gl = this.gl;
    const { W, H } = this.sim;
    const P = this.params();
    const u = this.pStep.use();
    gl.uniform2i(u.uSize, W, H);
    gl.uniform4f(u.uP, P.alpha, P.gamma, P.Sw, P.kappa);
    gl.uniform4f(u.uQ, P.H, P.nucT, P.nucRate, P.refreeze);
    // The plume sits low and central, drifting a little as a head would.
    this.breathX = 0.5 + 0.06 * Math.sin(t * 0.37);
    const [bx, by] = this.toCell(this.X * this.breathX, this.Y * 0.3);
    gl.uniform4f(u.uBreath, bx, by, (this.X * 0.3 * this.px) / this.cellPx, breath * 0.5);
    gl.uniform1f(u.uTime, t % 1000);
    gl.bindVertexArray(this.quad);
    gl.viewport(0, 0, W, H);
    gl.uniform1i(u.uA, 0);
    gl.uniform1i(u.uB, 1);
    for (let k = 0; k < this.tune.steps; k++) {
      let n = 0;
      if (k === 0) {
        n = Math.min(S.MAX_STAMPS, this.stamps.length);
        for (let i = 0; i < n; i++) {
          const s = this.stamps[i];
          this.saData.set([s[0], s[1], s[2], s[3]], i * 4);
          this.sbData.set([s[4], s[5], s[6], s[7]], i * 4);
        }
        this.stamps.splice(0, n);
        if (n) {
          gl.uniform4fv(u['uSA[0]'], this.saData);
          gl.uniform4fv(u['uSB[0]'], this.sbData);
        }
      }
      gl.uniform1i(u.uN, n);
      gl.uniform1f(u.uStep, this.step);
      const src = this.cur, dst = 1 - this.cur;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.sim.fbo[dst]);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sim.A[src]);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.sim.B[src]);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.cur = dst;
      this.step++;
    }
    // Stamps that didn't fit wait for the next frame; a long backlog (a fast scribble) is thinned.
    if (this.stamps.length > S.MAX_STAMPS * 4) this.stamps.splice(0, this.stamps.length - S.MAX_STAMPS * 4);
    void dt;
  }

  /** Sum the lattice into blocks and start an async read; results arrive a frame or two later. */
  private requestSums() {
    if (this.fence || this.frameNo % READ_EVERY !== 0) return;
    const gl = this.gl;
    const u = this.pSum.use();
    gl.uniform2i(u.uSize, this.sim.W, this.sim.H);
    gl.uniform2i(u.uBlock, this.block[0], this.block[1]);
    gl.uniform1f(u.uSince, this.readStep);
    gl.uniform1i(u.uA, 0);
    gl.uniform1i(u.uB, 1);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sim.A[this.cur]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sim.B[this.cur]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.sumFbo);
    gl.viewport(0, 0, BX, BY);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.pboIdx = 1 - this.pboIdx;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[this.pboIdx]);
    gl.readPixels(0, 0, BX, BY, gl.RGBA, gl.FLOAT, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    gl.flush();
    this.pendingSince = this.readStep;
    this.pendingTime = this.readTime;
    this.readStep = this.step;
    this.readTime = this.time;
  }

  private readback() {
    const gl = this.gl;
    if (!this.fence) return;
    if (gl.getSyncParameter(this.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
    gl.deleteSync(this.fence);
    this.fence = null;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[this.pboIdx]);
    gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.sums);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    let ice = 0, fresh = 0, fog = 0;
    for (let i = 0; i < BX * BY; i++) {
      ice += this.sums[i * 4];
      this.blockFresh[i] = this.sums[i * 4 + 1];
      fresh += this.sums[i * 4 + 1];
      fog += this.sums[i * 4 + 2];
    }
    this.ice = ice;
    this.fog = fog / (this.sim.W * this.sim.H);
    // Cells frozen between the previous read and this one, per second.
    const span = Math.max(1 / 60, this.readTime - this.pendingTime);
    this.growth = this.pendingSince > 0 ? fresh / span : 0;
  }

  private draw() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    const u = this.pComp.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.sim.A[this.cur]);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.sim.B[this.cur]);
    gl.uniform1i(u.uA, 0);
    gl.uniform1i(u.uB, 1);
    gl.uniform2i(u.uSize, this.sim.W, this.sim.H);
    gl.uniform1f(u.uCellPx, this.cellPx);
    gl.uniform1f(u.uPx, this.px);
    gl.uniform1f(u.uStep, this.step);
    gl.uniform1f(u.uFrame, this.frameNo);
    gl.uniform2f(u.uWorld, this.X, this.Y);
    gl.uniform2f(u.uLamp, this.lamp[0], this.lamp[1]);
    gl.uniform1f(u.uTime, this.time % 1000);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    const L = this.drops.list;
    if (L.length) {
      const d = this.dropData;
      for (let i = 0; i < L.length; i++) {
        const p = L[i];
        d[i * 4] = p.x;
        d[i * 4 + 1] = p.y;
        d[i * 4 + 2] = dropRadius(p.m);
        d[i * 4 + 3] = Math.min(0.8, -p.vy * 4);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dropBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, L.length * 4);
      const pu = this.pDrop.use();
      gl.uniform2f(pu.uWorld, this.X, this.Y);
      gl.uniform1f(pu.uPx, this.px);
      gl.uniform2f(pu.uLamp, this.lamp[0], this.lamp[1]);
      gl.uniform1f(pu.uTime, this.time % 1000);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.dropVao);
      gl.drawArrays(gl.POINTS, 0, L.length);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  /** Sound and haptics, all driven by what the lattice and drops just did. */
  private juice(dt: number) {
    const snd = this.ctx.sound;
    this.growthSm += (this.growth - this.growthSm) * Math.min(1, dt * 4);
    // Growth crackle: tiny clicks at a rate that follows how many cells froze, with power-law
    // (Pareto) energies so most are faint ticks and a few are sharp cracks.
    this.tickDebt += Math.min(40, this.growthSm * 0.02) * dt;
    let clicks = 0;
    while (this.tickDebt >= 1 && clicks < 4) {
      this.tickDebt -= 1;
      clicks++;
      const e = Math.min(1, 0.05 * Math.pow(Math.random(), -1 / 1.6));
      snd.crumple(e * 0.7, { stiffness: 0.85 + Math.random() * 0.15, pan: this.freshPan() });
    }
    this.hissLoop.set(Math.min(1, this.breath * 0.9), 0.25 + this.breath * 0.35);
    // Finger on glass: a squeak through fog and film, a crunch through frost.
    let squeak = 0, scrape = 0, pan = 0, speed = 0;
    for (const f of this.fingers.values()) {
      if (f.mode !== 'draw') continue;
      const b = this.blockAt(f.x, f.y) * 4;
      const cells = this.block[0] * this.block[1];
      const wetness = Math.min(1, (this.sums[b + 2] / cells) * 3 + (this.sums[b + 3] / cells) * 4);
      const ice = this.sums[b] / cells;
      const v = Math.min(1, f.speed / 1.2);
      squeak = Math.max(squeak, wetness * v * (1 - ice));
      scrape = Math.max(scrape, ice * v * 1.5);
      speed = Math.max(speed, f.speed);
      pan = (f.x / this.X) * 2 - 1;
    }
    this.squeak.set(squeak * 0.9, 18 + speed * 160, 750 + speed * 500, pan);
    this.scrapeLoop.set(Math.min(1, scrape), 0.6 + 0.4 * Math.min(1, speed));
    this.trickleLoop.set(Math.min(0.5, this.drops.running * 0.08), 0.5);
    const g = Math.min(1, this.growthSm / 2500);
    if (squeak > 0.02 || scrape > 0.02 || this.breath > 0.1) {
      this.ctx.hapticLevel(Math.min(1, squeak * 0.35 + scrape * 0.7 + g * 0.5 + this.breath * 0.1), scrape > squeak ? 0.9 : 0.6);
    }
  }

  private freshPan() {
    let tot = 0;
    for (let i = 0; i < BX * BY; i++) tot += this.blockFresh[i];
    if (tot <= 0) return 0;
    let r = Math.random() * tot;
    for (let i = 0; i < BX * BY; i++) {
      r -= this.blockFresh[i];
      if (r <= 0) return ((i % BX) + 0.5) / BX * 1.6 - 0.8;
    }
    return 0;
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.build();
  }

  destroy() {
    this.hissLoop.stop();
    this.scrapeLoop.stop();
    this.trickleLoop.stop();
    this.squeak.stop();
    this.btn.remove();
    this.hint.remove();
    this.style.remove();
    const gl = this.gl;
    if (this.fence) gl.deleteSync(this.fence);
    this.freeSim();
    gl.deleteTexture(this.sumTex);
    gl.deleteFramebuffer(this.sumFbo);
    for (const b of this.pbo) gl.deleteBuffer(b);
    gl.deleteBuffer(this.dropBuf);
    gl.deleteVertexArray(this.quad);
    gl.deleteVertexArray(this.dropVao);
  }
}

const STYLE = `
.frost-breath { position: absolute; z-index: 3; left: 50%; bottom: calc(22px + var(--safe-bottom, 0px)); transform: translateX(-50%); height: 48px; padding: 0 22px; border: 1px solid rgba(220, 235, 255, 0.28); border-radius: 99px; background: rgba(20, 30, 50, 0.5); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); color: #dfeaff; font: 600 15px/1 system-ui, sans-serif; letter-spacing: 0.02em; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; cursor: pointer; transition: background .2s, transform .2s; }
.frost-breath.on { background: rgba(200, 220, 255, 0.35); transform: translateX(-50%) scale(1.06); }
.frost-hint { position: absolute; z-index: 3; left: 50%; top: 42%; transform: translateX(-50%); padding: 9px 16px; border-radius: 99px; background: rgba(10, 16, 30, 0.5); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: #e6efff; font: italic 500 15px/1.2 Georgia, serif; white-space: nowrap; pointer-events: none; transition: opacity .8s; }
.frost-hint.gone { opacity: 0; }
`;
