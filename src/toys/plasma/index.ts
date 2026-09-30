import type { Loop } from '../../shell/sound';
import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile } from '../../shell/gl';
import { FIXED, type Field } from './field';
import type { Discharge, Params } from './dbm';
import { ACRYLIC, BOARD_W, ELECTRODE_R, GLASS, GLOBE, GLOBE_N, GLOBE_R, WOOD, buildBoard, buildGlobe, disc, step } from './scene';
import { Hum } from './hum';
import { dbmCluster } from './fractal';
import * as S from './shaders';

export const plasmaToy: Toy = {
  id: 'plasma',
  title: 'Plasma Globe',
  blurb: 'A plasma globe in a dark room. Touch the glass and the filaments reach for your fingertip; hold on and the channel runs hot and thick, slide and it follows. In Tune, swap the globe for a wet wooden board to burn a branching Lichtenberg figure, or charge an acrylic block and discharge it with a tap.',
  tech: 'Dielectric breakdown model on a CPU grid: multigrid Laplace/Poisson solve, growth ∝ |E|^η, channel currents, heating and decay, charging glass · WebGL2 glow and bloom',
  swatch: 'radial-gradient(circle at 50% 46%,#ffd6fb 0 3%,#d04ce0 7%,rgba(120,50,220,.55) 18%,rgba(40,10,80,.8) 36%,#07030f 38%),linear-gradient(180deg,#0a0614,#030208)',
  refs: [
    {
      short: 'Niemeyer 1984',
      title: 'Fractal Dimension of Dielectric Breakdown (L. Niemeyer, L. Pietronero & H. J. Wiesmann, Phys. Rev. Lett. 52, 1033, 1984)',
      url: 'https://doi.org/10.1103/PhysRevLett.52.1033',
      use: 'The growth rule: solve Laplace’s equation with the discharge held at the electrode’s potential, and let each neighbouring cell break down with probability ∝ |E|^η. The η slider is their exponent: low η gives dense, bushy figures, high η sparse, straight ones.',
    },
    {
      short: 'Kim & Lin 2004',
      title: 'Physically Based Animation and Rendering of Lightning (T. Kim & M. C. Lin, Pacific Graphics 2004)',
      url: 'https://gamma.cs.unc.edu/LIGHTNING/',
      use: 'DBM for animated electric arcs and rendering them as glow around the channel. Here the glow is a Gaussian core and soft halo per segment plus a two-level bloom, a cheap stand-in for their convolution kernel; brightness follows the simulated current.',
    },
    {
      short: 'Lichtenberg figure',
      title: 'Lichtenberg figure (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Lichtenberg_figure',
      use: 'The two board modes: fractal burning, where current through wet wood chars paths between two electrodes (they grow from both ends and follow the grain), and charged acrylic that discharges in a branching tree when tapped with a grounded point.',
    },
    {
      short: 'Plasma globe',
      title: 'Plasma globe (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Plasma_globe',
      use: 'Why a fingertip draws a filament: the body is a much bigger capacitance to ground than the bare glass, so current keeps flowing where you touch while glass elsewhere charges up and turns filaments away.',
    },
  ],
  async create(ctx) {
    return new Plasma(ctx);
  },
};

type Mode = 'globe' | 'wood' | 'acrylic';

const MAX_SEG = 16000;

interface Finger {
  eid: number;
  cx: number;
  cy: number;
  r: number;
  held: number;
}

class Plasma implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private pSeg: Program;
  private pBurn: Program;
  private pBlur: Program;
  private pComp: Program;
  private quad: WebGLVertexArrayObject;
  private segVao: WebGLVertexArrayObject;
  private segBuf: WebGLBuffer;
  private segData = new Float32Array(MAX_SEG * 8);
  private segN = 0;
  private burnN = 0;
  private burnData = new Float32Array(MAX_SEG * 8);
  private glow!: RT;
  private b1!: [RT, RT];
  private b2!: [RT, RT];
  private burn!: RT;
  private chargeTex: WebGLTexture;
  private chargeBytes = new Uint8Array(0);

  private width = 1;
  private height = 1;
  private mode: Mode = 'globe';
  readonly cfg = { eta: 2, volts: 1.2 };
  private tune: Params = { ...GLOBE };

  private f!: Field;
  private d!: Discharge;
  /** Grid to device pixels: px = ox + (i + 0.5) cs. */
  private ox = 0;
  private oy = 0;
  private cs = 1;
  private globe = [0, 0, 1];
  private boardRect = [0, 0, 1, 1];
  private nail = 0;
  private fingers = new Map<number, Finger>();
  private strike: { eid: number; quiet: number; age: number } | null = null;
  private charge = 0;
  private chargeHeld = 0;

  private time = 0;
  private growSm = 0;
  private tickDebt = 0;
  private currentSm = 0;
  private fingerI = 0;
  private burnPower = 0;
  private cpuMs = 0;
  private solveMs = 0;

  private hum: Hum;
  private crackle: Loop;
  private hiss: Loop;
  private style: HTMLStyleElement;
  private hint: HTMLElement;

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('This device cannot render to float textures.');
    this.gl = gl;
    const vq = compile(gl, gl.VERTEX_SHADER, S.quadVert);
    const vs = compile(gl, gl.VERTEX_SHADER, S.segVert);
    this.pSeg = new Program(gl, vs, S.segFrag);
    this.pBurn = new Program(gl, vs, S.burnFrag);
    this.pBlur = new Program(gl, vq, S.blurFrag);
    this.pComp = new Program(gl, vq, S.compFrag);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.segVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.segVao);
    this.segBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.segData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
    this.chargeTex = gl.createTexture()!;

    this.hum = new Hum(60);
    this.crackle = ctx.sound.loop('crackle');
    this.hiss = ctx.sound.loop('hiss');

    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'plasma-hint';
    ctx.overlay.append(this.hint);

    ctx.panel.slider(this.cfg, 'eta', { label: 'Branchiness η (low = bushy)', min: 0.5, max: 6, step: 0.1 });
    ctx.panel.slider(this.cfg, 'volts', { label: 'Voltage', min: 0.3, max: 1.6, step: 0.05 });
    ctx.panel.choice<Mode>('Mode', [{ value: 'globe', label: 'Globe' }, { value: 'wood', label: 'Wood' }, { value: 'acrylic', label: 'Acrylic' }], this.mode, (m) => this.setMode(m));
    ctx.panel.action('Clear burns', () => this.build());

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.targets();
    this.build();

    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__plasma = () => this.stats();
      w.__plasmaCfg = (o: Partial<typeof this.cfg>) => Object.assign(this.cfg, o);
      w.__plasmaTune = (o: Partial<Params>) => Object.assign(this.tune, o);
      w.__plasmaMode = (m: Mode) => this.setMode(m);
      w.__plasmaFractal = (eta: number, n = 128, seed = 1) => {
        const r = dbmCluster(eta, n, seed);
        return { eta, cells: r.cells.length, dMass: r.dMass, dBox: r.dBox };
      };
      /** Channel cells right now, and which tree they belong to. */
      w.__plasmaCells = () => {
        const out: [number, number, number][] = [];
        for (let s = 0; s < this.d.n; s++) if (this.d.parent[s] >= 0) out.push([this.d.cell[s] % this.f.W, (this.d.cell[s] / this.f.W) | 0, this.d.tree[s]]);
        return { W: this.f.W, H: this.f.H, cells: out };
      };
      /** Grid cell to CSS pixels (top-left origin), for driving the page from tests. */
      w.__plasmaCellToCss = (x: number, y: number) => {
        const r = this.ctx.canvas.getBoundingClientRect();
        const px = this.ox + (x + 0.5) * this.cs, py = this.oy + (y + 0.5) * this.cs;
        return [r.left + (px / this.width) * r.width, r.top + (1 - py / this.height) * r.height];
      };
      w.__plasmaGeom = () => ({ globe: this.globe, board: this.boardRect, cs: this.cs, ox: this.ox, oy: this.oy, W: this.width, H: this.height });
    }
  }

  private stats() {
    const d = this.d;
    const fingers = [...this.fingers.values()].filter((f) => f.eid >= 0).map((f) => {
      const el = d.electrodes[f.eid];
      // Length of the hottest channel feeding this finger (cells from the contact back to the electrode).
      let best = -1, bi = 0;
      for (const c of el.cells)
        for (const nb of [c + 1, c - 1, c + d.W, c - d.W]) {
          const s = d.slotOf[nb];
          if (s >= 0 && d.tree[s] !== f.eid && d.I[s] > bi) (bi = d.I[s]), (best = s);
        }
      let len = 0, tSum = 0;
      for (let s = best; s >= 0 && d.parent[s] >= 0; s = d.parent[s]) (len++), (tSum += d.T[s]);
      return { cell: [+f.cx.toFixed(1), +f.cy.toFixed(1)], I: +el.I.toFixed(3), V: +el.V.toFixed(3), contacts: el.contacts, pathLen: len, pathT: +(tSum / Math.max(1, len)).toFixed(2), straight: +Math.hypot(f.cx - GLOBE_N / 2, f.cy - GLOBE_N / 2).toFixed(1) };
    });
    let ring = 0;
    for (const v of d.ringV) ring += v;
    let maxT = 0;
    for (let s = 0; s < d.n; s++) maxT = Math.max(maxT, d.T[s]);
    return {
      mode: this.mode,
      grid: [this.f.W, this.f.H],
      cells: d.n,
      grownPerS: Math.round(this.growSm),
      current: +this.currentSm.toFixed(3),
      fingerI: +this.fingerI.toFixed(3),
      fingers,
      glassMean: d.ringV.length ? +(ring / d.ringV.length).toFixed(3) : 0,
      maxT: +maxT.toFixed(3),
      charge: +this.charge.toFixed(3),
      strike: !!this.strike,
      cpuMs: +this.cpuMs.toFixed(2),
      solveMs: +this.solveMs.toFixed(2),
      residual: +this.f.maxResidual().toExponential(2),
    };
  }

  private setMode(m: Mode) {
    this.mode = m;
    this.tune = { ...(m === 'globe' ? GLOBE : m === 'wood' ? WOOD : ACRYLIC) };
    this.build();
  }

  // ---------------------------------------------------------------- setup

  private targets() {
    const gl = this.gl;
    if (this.glow) for (const t of [this.glow, ...this.b1, ...this.b2, this.burn]) freeRT(gl, t);
    const w2 = Math.max(1, this.width >> 1), h2 = Math.max(1, this.height >> 1);
    this.glow = makeRT(gl, w2, h2);
    this.b1 = [makeRT(gl, w2 >> 1, h2 >> 1), makeRT(gl, w2 >> 1, h2 >> 1)];
    this.b2 = [makeRT(gl, w2 >> 2, h2 >> 2), makeRT(gl, w2 >> 2, h2 >> 2)];
    this.burn = makeRT(gl, w2, h2);
  }

  /** Fresh simulation for the current mode and screen size (also 'Clear burns'). */
  private build() {
    this.fingers.clear();
    this.strike = null;
    this.charge = 0;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.burn.fbo);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const W = this.width, H = this.height;
    if (this.mode === 'globe') {
      const R = Math.min(W * 0.45, H * 0.33);
      const cx = W * 0.5, cy = H * 0.53;
      this.globe = [cx, cy, R];
      this.cs = R / (GLOBE_R + 0.5);
      this.ox = cx - (GLOBE_N / 2) * this.cs;
      this.oy = cy - (GLOBE_N / 2) * this.cs;
      const g = buildGlobe(this.tune);
      this.f = g.f;
      this.d = g.d;
      this.nail = g.nail;
    } else {
      const wood = this.mode === 'wood';
      const top = H * (wood ? 0.13 : 0.2), bot = H * (wood ? 0.05 : 0.14), side = W * (wood ? 0.06 : 0.1);
      const bw = W - 2 * side;
      this.cs = bw / (BOARD_W - 2);
      let GH = Math.round(((H - top - bot) / this.cs + 2) / 16) * 16;
      while ((GH - 2) * this.cs > H - top - bot) GH -= 16;
      const bh = (GH - 2) * this.cs;
      const y0 = bot + (H - top - bot - bh) / 2;
      this.boardRect = [side, y0, side + bw, y0 + bh];
      this.ox = side - this.cs;
      this.oy = y0 - this.cs;
      const b = buildBoard(this.tune, GH, wood);
      this.f = b.f;
      this.d = b.d;
      this.nail = b.nail;
      if (!wood) {
        this.chargeBytes = new Uint8Array(BOARD_W * GH);
        gl.bindTexture(gl.TEXTURE_2D, this.chargeTex);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      }
    }
    this.hint.textContent = this.mode === 'globe' ? 'Touch the glass' : this.mode === 'wood' ? 'Hold the probe on the wet wood' : 'Hold to charge the block, let go to discharge';
    this.hint.classList.remove('gone');
  }

  private disc(x: number, y: number, r: number) {
    return disc(this.d, x, y, r);
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    const t0 = performance.now();
    this.time = t;
    const d = this.d, p = this.tune;
    p.eta = this.cfg.eta;
    p.volts = this.cfg.volts;
    this.input(dt);
    const ts = performance.now();
    step(d, dt, t, this.mode === 'acrylic' ? () => this.drain(dt) : undefined);
    this.solveMs += (performance.now() - ts - this.solveMs) * 0.05;
    this.after(dt);
    this.buildSegments(t);
    this.draw();
    this.juice(dt);
    this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
    this.ctx.setStatus(this.status());
  }

  private status() {
    if (this.mode === 'globe') return `${this.d.n} cells · current ${this.currentSm.toFixed(1)}${this.fingers.size ? ` · you ${this.fingerI.toFixed(1)}` : ''}`;
    if (this.mode === 'wood') return `${this.d.n} charred cells`;
    return `charge ${Math.round(this.charge * 100)}%`;
  }

  /** Pointer (uv, y up) to grid cell coordinates. */
  private toGrid(u: number, v: number): [number, number] {
    return [(u * this.width - this.ox) / this.cs - 0.5, (v * this.height - this.oy) / this.cs - 0.5];
  }

  private input(dt: number) {
    const d = this.d;
    const seen = new Set<number>();
    for (const ptr of this.ctx.pointers.active.values()) {
      seen.add(ptr.id);
      let [gx, gy] = this.toGrid(ptr.x, ptr.y);
      let f = this.fingers.get(ptr.id);
      if (this.mode === 'globe') {
        const c0 = GLOBE_N / 2 - 0.5;
        let dx = gx - c0, dy = gy - c0;
        const r = Math.hypot(dx, dy);
        if (!f && r > GLOBE_R * 1.12) continue;
        // Keep the contact on the glass and off the electrode.
        const rMax = GLOBE_R - 3.5, rMin = ELECTRODE_R + 9;
        const rc = Math.max(rMin, Math.min(rMax, r));
        if (r < 1e-3) (dx = 1), (dy = 0);
        gx = c0 + (dx / Math.max(r, 1e-3)) * rc;
        gy = c0 + (dy / Math.max(r, 1e-3)) * rc;
        // Pressing longer flattens the fingertip: a bigger contact.
        const rad = 1.8 + Math.min(1.2, (f?.held ?? 0) * 0.8);
        if (!f) {
          const eid = d.addElectrode({ V: 0, V0: 0, C: GLASS.bodyC, leak: GLASS.bodyLeak, cells: this.disc(gx, gy, rad) });
          f = { eid, cx: gx, cy: gy, r: rad, held: 0 };
          this.fingers.set(ptr.id, f);
          this.ctx.haptic('light');
          this.hint.classList.add('gone');
        } else if (Math.hypot(gx - f.cx, gy - f.cy) > 0.6 || rad - f.r > 0.3) {
          f.cx = gx;
          f.cy = gy;
          f.r = rad;
          d.moveElectrode(f.eid, this.disc(gx, gy, rad));
        }
        f.held += dt;
      } else if (this.mode === 'wood') {
        const [x0, y0, x1, y1] = this.boardRect;
        const px = ptr.x * this.width, py = ptr.y * this.height;
        if (!f && (px < x0 || px > x1 || py < y0 || py > y1)) continue;
        gx = Math.max(2, Math.min(this.f.W - 3, gx));
        gy = Math.max(2, Math.min(this.f.H - 3, gy));
        // A probe dragged to a new spot starts a new burn there; the old one stays charred.
        if (f && Math.hypot(gx - f.cx, gy - f.cy) > 2.5) {
          d.removeElectrode(f.eid);
          this.fingers.delete(ptr.id);
          f = undefined;
        }
        if (!f) {
          const eid = d.addElectrode({ V: 0, grows: true, permanent: true, cells: this.disc(gx, gy, 1.3) });
          f = { eid, cx: gx, cy: gy, r: 1.3, held: 0 };
          this.fingers.set(ptr.id, f);
          if (ptr.justDown) this.ctx.haptic('light');
          this.hint.classList.add('gone');
        }
        f.held += dt;
      } else {
        const [x0, y0, x1, y1] = this.boardRect;
        const px = ptr.x * this.width, py = ptr.y * this.height;
        if (!f && (px < x0 || px > x1 || py < y0 || py > y1)) continue;
        if (!f) {
          f = { eid: -1, cx: gx, cy: gy, r: 1, held: 0 };
          this.fingers.set(ptr.id, f);
          this.hint.classList.add('gone');
        }
        f.cx = Math.max(2, Math.min(this.f.W - 3, gx));
        f.cy = Math.max(2, Math.min(this.f.H - 3, gy));
        f.held += dt;
        if (!this.strike) this.chargeUp(dt);
      }
    }
    for (const [id, f] of this.fingers) {
      if (seen.has(id)) continue;
      this.fingers.delete(id);
      if (this.mode === 'acrylic') {
        // Let go: a grounded point touches the charged block where your finger was.
        if (!this.strike && this.charge > 0.04) this.startStrike(f.cx, f.cy);
        continue;
      }
      d.removeElectrode(f.eid);
    }
    if (this.mode === 'wood' && this.nail >= 0) {
      // Once the burns touch, the char bridges the probes: the field across the wet wood collapses,
      // growth stops and the current runs through the path instead (the arc).
      let bridged = false;
      for (const f of this.fingers.values()) {
        const el = d.electrodes[f.eid];
        const b = el.contacts > 0;
        el.grows = !b;
        bridged ||= b;
      }
      d.electrodes[this.nail].grows = this.fingers.size > 0 && !bridged;
    }
  }

  // ---------------------------------------------------------------- acrylic

  /** The beam deposits charge through the block (uniform, softer at the edges). */
  private chargeUp(dt: number) {
    const f = this.f, W = f.W, H = f.H;
    const add = dt * 0.35 * (1 - this.charge);
    this.charge = Math.min(1, this.charge + add);
    this.chargeHeld = 1;
    const q = 0.0016 * this.charge;
    for (let y = 1; y < H - 1; y++)
      for (let x = 1; x < W - 1; x++) {
        const e = Math.min(x, y, W - 1 - x, H - 1 - y);
        const i = y * W + x;
        if (f.kind[i] !== FIXED) f.rho[i] = Math.max(f.rho[i], q * Math.min(1, e / 5));
      }
    for (let k = 0; k < 2; k++) f.vcycle();
  }

  private startStrike(x: number, y: number) {
    const eid = this.d.addElectrode({ V: 0, grows: true, permanent: true, cells: this.disc(x, y, 1.2) });
    this.strike = { eid, quiet: 0, age: 0 };
    this.ctx.haptic('heavy');
    const pan = (x / this.f.W) * 2 - 1;
    this.ctx.sound.play('snap', { gain: 0.9, pitch: 0.7, pan });
    this.ctx.sound.play('thud', { gain: 0.5, pitch: 1.4, pan });
  }

  /** Channels in the block soak up the space charge around them; that charge is the discharge current. */
  private drain(dt: number) {
    const s0 = this.strike;
    if (!s0) return;
    const d = this.d, f = this.f, W = f.W, rho = f.rho;
    const k = 1 - Math.exp(-dt * 25);
    for (let s = 0; s < d.n; s++) {
      if (d.tree[s] !== s0.eid) continue;
      const c = d.cell[s];
      let q = rho[c];
      rho[c] = 0;
      for (const nb of [c + 1, c - 1, c + W, c - W, c + W + 1, c + W - 1, c - W + 1, c - W - 1]) {
        if (f.kind[nb] === FIXED) continue;
        const dq = rho[nb] * k;
        rho[nb] -= dq;
        q += dq;
      }
      d.Iown[s] += (q / dt) * 400;
    }
  }

  // ---------------------------------------------------------------- after the sim step

  private after(dt: number) {
    const d = this.d;
    if (this.mode === 'acrylic') {
      let tot = 0;
      const rho = this.f.rho;
      for (let i = 0; i < rho.length; i++) tot += rho[i];
      const cap = 0.0016 * (this.f.W - 12) * (this.f.H - 12);
      this.charge = Math.min(this.charge, tot / cap);
      if (this.strike) {
        const s = this.strike;
        s.age += dt;
        s.quiet = d.grown ? 0 : s.quiet + dt;
        if (s.quiet > 0.35 || s.age > 3) {
          d.removeElectrode(s.eid);
          this.strike = null;
          // What's left of the charge stays trapped until the next strike.
        }
      }
      this.chargeHeld *= Math.exp(-dt * 8);
      // Upload the charge for the haze.
      const b = this.chargeBytes;
      for (let i = 0; i < b.length; i++) b[i] = Math.min(255, rho[i] * (255 / 0.0016));
      const gl = this.gl;
      gl.bindTexture(gl.TEXTURE_2D, this.chargeTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, this.f.W, this.f.H, 0, gl.RED, gl.UNSIGNED_BYTE, b);
    }
    for (let k = 0; k < d.zaps.length; k += 4) {
      const pan = (d.zaps[k + 1] / d.W) * 2 - 1;
      if (this.mode === 'globe') {
        this.ctx.sound.play('snap', { gain: 0.35, pitch: 1.6 + Math.random() * 0.4, pan });
        for (let j = 0; j < 3; j++) this.ctx.sound.crumple(0.5 + Math.random() * 0.4, { stiffness: 1, pan });
        this.ctx.haptic('medium');
      } else if (this.mode === 'wood' && d.electrodes[d.zaps[k]] && d.zaps[k] === this.nail) {
        // The two burns met: the arc jumps across and the whole path flares.
        this.ctx.sound.play('snap', { gain: 0.8, pitch: 0.9, pan });
        this.ctx.sound.play('sizzle', { gain: 0.8, pan });
        this.ctx.haptic('heavy');
      }
    }
  }

  // ---------------------------------------------------------------- render

  /** Channel cell centre in px, with a stable sub-cell jitter so the grid never shows. */
  private cellPos(c: number, t: number): [number, number] {
    const W = this.f.W;
    const x = c % W, y = (c / W) | 0;
    const h1 = hash(c), h2 = hash(c + 7919);
    let jx = (h1 - 0.5) * 0.9, jy = (h2 - 0.5) * 0.9;
    if (this.mode === 'globe') {
      jx += 0.22 * Math.sin(t * (7 + 5 * h1) + h2 * 30);
      jy += 0.22 * Math.sin(t * (6 + 5 * h2) + h1 * 30);
    }
    return [this.ox + (x + 0.5 + jx) * this.cs, this.oy + (y + 0.5 + jy) * this.cs];
  }

  private buildSegments(t: number) {
    const d = this.d, cs = this.cs;
    const seg = this.segData, burn = this.burnData;
    let n = 0, b = 0;
    const mid = new Float32Array(d.n * 2);
    for (let s = 0; s < d.n; s++) {
      const [x, y] = this.cellPos(d.cell[s], t);
      const pa = d.parent[s];
      if (pa < 0) {
        mid[s * 2] = x;
        mid[s * 2 + 1] = y;
        continue;
      }
      const [px, py] = this.cellPos(d.cell[pa], t);
      mid[s * 2] = (x + px) * 0.5;
      mid[s * 2 + 1] = (y + py) * 0.5;
    }
    const [gcx, gcy, gR] = this.globe;
    const dt = 1 / 60;
    for (let s = 0; s < d.n && n < MAX_SEG; s++) {
      const pa = d.parent[s];
      if (pa < 0) continue;
      const x0 = mid[pa * 2], y0 = mid[pa * 2 + 1], x1 = mid[s * 2], y1 = mid[s * 2 + 1];
      const I = d.I[s], h = d.h[s], T = d.T[s];
      const o = n * 8;
      seg[o] = x0;
      seg[o + 1] = y0;
      seg[o + 2] = x1;
      seg[o + 3] = y1;
      if (this.mode === 'globe') {
        const r = Math.hypot(x1 - gcx, y1 - gcy) / gR;
        const Ic = I / (1 + I);
        seg[o + 4] = cs * (0.2 + 0.4 * T + 0.2 * Ic);
        seg[o + 5] = 0.12 + 0.3 * Math.min(1, h) + 0.5 * Ic;
        seg[o + 6] = Math.min(1, (1 - r) * 0.7 + T * 0.5 + Ic * 0.3);
        seg[o + 7] = T;
      } else if (this.mode === 'wood') {
        const loc = d.Iloc[s];
        const heat = loc * 1.5 + I * I * 0.25;
        seg[o + 4] = cs * (0.35 + 0.4 * Math.min(2, I));
        seg[o + 5] = Math.min(2.5, heat * 1.4 + h * 0.3) * 0.6;
        seg[o + 6] = Math.min(1, heat);
        seg[o + 7] = 0;
        const bo = b * 8;
        burn[bo] = x0;
        burn[bo + 1] = y0;
        burn[bo + 2] = x1;
        burn[bo + 3] = y1;
        burn[bo + 4] = cs * (0.4 + 0.45 * Math.sqrt(Math.min(4, I)) + 0.3 * T);
        burn[bo + 5] = (0.35 * heat + 0.05) * dt * 6;
        burn[bo + 6] = 0;
        burn[bo + 7] = 0;
        b++;
      } else {
        const age = this.time - d.born[s];
        const Ic = I / (1 + I);
        seg[o + 4] = cs * (0.2 + 0.3 * Ic);
        seg[o + 5] = 0.15 * Math.min(1, h) + 0.45 * Ic + 1.2 * Math.exp(-age * 14);
        seg[o + 6] = Math.min(1, 0.3 + Ic * 0.6);
        seg[o + 7] = Math.exp(-age * 8);
        // The etch is cut once, as the channel passes: a fine line, a little wider where the current ran.
        const bo = b * 8;
        burn[bo] = x0;
        burn[bo + 1] = y0;
        burn[bo + 2] = x1;
        burn[bo + 3] = y1;
        burn[bo + 4] = cs * (0.18 + 0.2 * Ic);
        burn[bo + 5] = age < 0.035 ? 0.8 : 0.004 * Ic;
        burn[bo + 6] = 0;
        burn[bo + 7] = 0;
        b++;
      }
      n++;
    }
    this.segN = n;
    this.burnN = b;
  }

  private drawSegs(prog: Program, data: Float32Array, count: number, target: RT, palette: number, reach: number) {
    if (!count) return;
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
    gl.viewport(0, 0, target.w, target.h);
    const u = prog.use();
    gl.uniform2f(u.uRes, this.width, this.height);
    gl.uniform1f(u.uReach, reach);
    if (u.uPalette) gl.uniform1i(u.uPalette, palette);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.segBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 8);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindVertexArray(this.segVao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.BLEND);
  }

  private blur(src: RT, dst: [RT, RT]) {
    const gl = this.gl;
    const u = this.pBlur.use();
    gl.bindVertexArray(this.quad);
    gl.uniform1i(u.uTex, 0);
    gl.activeTexture(gl.TEXTURE0);
    // Downsample + horizontal, then vertical.
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst[0].fbo);
    gl.viewport(0, 0, dst[0].w, dst[0].h);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(u.uDir, 1 / src.w, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst[1].fbo);
    gl.bindTexture(gl.TEXTURE_2D, dst[0].tex);
    gl.uniform2f(u.uDir, 0, 1 / dst[0].h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private draw() {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.glow.fbo);
    gl.viewport(0, 0, this.glow.w, this.glow.h);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const palette = this.mode === 'globe' ? 0 : this.mode === 'wood' ? 1 : 2;
    if (this.mode !== 'globe') this.drawSegs(this.pBurn, this.burnData, this.burnN, this.burn, 0, 3);
    this.drawSegs(this.pSeg, this.segData, this.segN, this.glow, palette, 4);
    this.blur(this.glow, this.b1);
    this.blur(this.b1[1], this.b2);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const u = this.pComp.use();
    const tex = [this.glow.tex, this.b1[1].tex, this.b2[1].tex, this.burn.tex, this.chargeTex];
    const names = ['uGlow', 'uBloom1', 'uBloom2', 'uBurn', 'uCharge'];
    tex.forEach((t, i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(u[names[i]], i);
    });
    gl.uniform2f(u.uRes, this.width, this.height);
    gl.uniform1i(u.uMode, palette);
    gl.uniform3f(u.uGlobe, this.globe[0], this.globe[1], this.globe[2]);
    gl.uniform1f(u.uElectrode, ELECTRODE_R * this.cs);
    gl.uniform1f(u.uCore, 0.45 + Math.min(1, this.currentSm * 0.03));
    gl.uniform1f(u.uHaze, Math.min(0.7, 0.08 + this.currentSm * 0.012));
    gl.uniform4f(u.uBoard, this.boardRect[0], this.boardRect[1], this.boardRect[2], this.boardRect[3]);
    if (this.mode === 'wood' && this.nail >= 0) {
      const nc = this.d.electrodes[this.nail].cells;
      let sx = 0, sy = 0;
      for (const c of nc) {
        sx += c % this.f.W;
        sy += (c / this.f.W) | 0;
      }
      gl.uniform3f(u.uNail, this.ox + (sx / nc.length + 0.5) * this.cs, this.oy + (sy / nc.length + 0.5) * this.cs, this.cs * 2.2);
    }
    const probes = new Float32Array(S.MAX_PROBES * 4);
    let k = 0;
    for (const f of this.fingers.values()) {
      if (k >= S.MAX_PROBES) break;
      const I = f.eid >= 0 ? this.d.electrodes[f.eid].I : this.chargeHeld;
      probes.set([this.ox + (f.cx + 0.5) * this.cs, this.oy + (f.cy + 0.5) * this.cs, this.cs * (this.mode === 'globe' ? 4 : this.mode === 'wood' ? 1.8 : 6), Math.min(1.5, I * 0.6)], k * 4);
      k++;
    }
    gl.uniform4fv(u['uProbe[0]'], probes);
    gl.uniform1i(u.uProbes, k);
    gl.uniform1f(u.uTime, this.time % 1000);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.bindVertexArray(null);
  }

  // ---------------------------------------------------------------- sound and feel

  private juice(dt: number) {
    const d = this.d, snd = this.ctx.sound;
    const k = Math.min(1, dt * 6);
    this.growSm += (d.grown / Math.max(dt, 1e-3) - this.growSm) * k;
    // Total current: into the globe's electrode, or through the probes.
    let I = 0, fI = 0;
    for (const f of this.fingers.values()) if (f.eid >= 0) fI += d.electrodes[f.eid].I;
    if (this.mode === 'globe') I = d.electrodes[this.nail].I;
    else if (this.mode === 'wood') I = fI;
    else I = this.strike ? d.electrodes[this.strike.eid].I : 0;
    this.currentSm += (I - this.currentSm) * k;
    this.fingerI += (fI - this.fingerI) * Math.min(1, dt * 20);
    const pan = d.grown ? (d.grownX / d.grown / d.W) * 2 - 1 : 0;

    // Crackle: one click per breakdown event, energies from the field that broke it down, with a
    // power-law spread (most faint, a few sharp), and a cap on clicks per frame.
    const ev = d.events;
    let clicks = 0;
    const maxClicks = this.mode === 'acrylic' ? 8 : 5;
    const rateScale = this.mode === 'globe' ? 0.08 : this.mode === 'wood' ? 1 : 0.25;
    this.tickDebt = Math.min(6, this.tickDebt + d.grown * rateScale);
    for (let j = 0; this.tickDebt >= 1 && clicks < maxClicks && j < ev.length; j += 3) {
      this.tickDebt -= 1;
      clicks++;
      const E = ev[j + 2] / this.tune.Eref;
      const e = Math.min(1, 0.06 * Math.pow(Math.random(), -1 / 1.5) * Math.min(3, E));
      const ep = (ev[j] / d.W) * 2 - 1;
      snd.crumple(e * (this.mode === 'wood' ? 0.5 : 0.8), { pan: ep, stiffness: this.mode === 'wood' ? 0.3 + Math.random() * 0.3 : 0.8 + Math.random() * 0.2 });
    }
    if (this.tickDebt > 3) this.tickDebt = 3;

    if (this.mode === 'globe') {
      const load = Math.min(1, this.currentSm / 6);
      this.hum.set(0.25 + 0.75 * load, Math.min(1, this.growSm / 1500));
      this.crackle.set(Math.min(0.6, this.growSm / 2500 + this.fingerI * 0.05), 0.7 + 0.3 * load);
      this.hiss.set(0, 0.5);
      if (this.fingers.size) this.ctx.hapticLevel(Math.min(1, 0.15 + this.fingerI * 0.18), 0.95);
    } else if (this.mode === 'wood') {
      let p = 0;
      for (let s = 0; s < d.n; s++) p += d.Iloc[s] + d.I[s] * d.I[s] * 0.02;
      this.burnPower += (p - this.burnPower) * k;
      const bp = Math.min(1, this.burnPower / 12);
      this.hiss.set(bp * 0.8, 0.3 + bp * 0.5);
      this.crackle.set(bp * 0.5, 0.4);
      this.hum.set(this.fingers.size ? 0.3 + 0.7 * Math.min(1, this.currentSm / 8) : 0, 0);
      if (Math.random() < bp * dt * 3) snd.play('sizzle', { gain: 0.2 + 0.3 * bp, pan });
      if (this.fingers.size) this.ctx.hapticLevel(Math.min(1, 0.1 + bp * 0.8), 0.6);
    } else {
      const g = Math.min(1, this.growSm / 800);
      this.crackle.set(g, 0.9);
      this.hiss.set(this.chargeHeld * 0.35, 0.2 + this.charge * 0.6);
      this.hum.set(this.chargeHeld * (0.2 + 0.8 * this.charge), this.chargeHeld * 0.3);
      if (this.strike) this.ctx.hapticLevel(Math.min(1, 0.3 + g), 1);
      else if (this.fingers.size) this.ctx.hapticLevel(0.08 + this.charge * 0.25, 0.3);
    }
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.targets();
    this.build();
  }

  destroy() {
    this.hum.stop();
    this.crackle.stop();
    this.hiss.stop();
    this.hint.remove();
    this.style.remove();
    const gl = this.gl;
    for (const t of [this.glow, ...this.b1, ...this.b2, this.burn]) freeRT(gl, t);
    gl.deleteTexture(this.chargeTex);
    gl.deleteBuffer(this.segBuf);
    gl.deleteVertexArray(this.quad);
    gl.deleteVertexArray(this.segVao);
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      for (const k of ['__plasma', '__plasmaCfg', '__plasmaTune', '__plasmaMode', '__plasmaFractal', '__plasmaCells', '__plasmaCellToCss', '__plasmaGeom']) delete w[k];
    }
  }
}

interface RT {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

function makeRT(gl: WebGL2RenderingContext, w: number, h: number): RT {
  w = Math.max(1, w);
  h = Math.max(1, h);
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('This device cannot render to half-float textures.');
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fbo, w, h };
}

function freeRT(gl: WebGL2RenderingContext, t: RT) {
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

function hash(n: number) {
  let x = Math.imul(n ^ 0x9e3779b9, 0x85ebca6b);
  x ^= x >>> 13;
  x = Math.imul(x, 0xc2b2ae35);
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

const STYLE = `
.plasma-hint { position: absolute; z-index: 3; left: 50%; bottom: calc(40px + var(--safe-bottom, 0px)); transform: translateX(-50%); padding: 9px 16px; border-radius: 99px; background: rgba(20, 10, 34, 0.55); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: #f0e2ff; font: italic 500 15px/1.2 Georgia, serif; white-space: nowrap; pointer-events: none; transition: opacity .8s; }
.plasma-hint.gone { opacity: 0; }
`;
