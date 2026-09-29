import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile, createDouble, destroyTarget, type DoubleTarget, type Target } from '../../shell/gl';
import * as S from './shaders';
import { PrintShelf } from './print';

export const marbleToy: Toy = {
  id: 'marble',
  title: 'Marbling Tray',
  blurb: 'Drip inks onto the bath, drag combs and rakes into feathered patterns, then lay paper to keep a print.',
  tech: 'Mixwell marbling brushes · WebGL2',
  swatch: 'linear-gradient(135deg,#1d3a8a,#c2362b 52%,#e0a526)',
  refs: [
    {
      short: 'Mixwell 2026',
      title: 'James & James — Mixwell (SIGGRAPH 2026 Best Paper)',
      url: 'https://dougjam.github.io/mixwell-2026/',
      use: 'The combs and stylus: analytic reverse-drift of a tine moving through the bath, evaluated per pixel.',
    },
    {
      short: 'Mixwell code',
      title: 'dougjam/mixwell-2026 — MIT-licensed GLSL brush library',
      url: 'https://github.com/dougjam/mixwell-2026',
      use: 'rdLine1DS, the Mixwell brush matrix and adaptive-midpoint segment brush, vendored in mixwell.ts.',
    },
    {
      short: 'Two Minute Papers',
      title: 'Mixwell paper video',
      url: 'https://www.youtube.com/watch?v=2dAXpTJAdZ4',
      use: 'Reference for how combed chevrons, nonpareil and gel-git patterns should look.',
    },
  ],
  async create(ctx) {
    return new Marbling(ctx);
  },
};

type Tool = 'drop' | 'stylus' | 'comb' | 'wave' | 'swirl';
type PaletteId = 'ebru' | 'sumi' | 'candy';
type RGB = [number, number, number];

const TOOLS: { id: Tool; label: string; glyph: string }[] = [
  { id: 'drop', label: 'Drop', glyph: '💧' },
  { id: 'stylus', label: 'Stylus', glyph: '✒️' },
  { id: 'comb', label: 'Comb', glyph: '𝍢' },
  { id: 'wave', label: 'Wave comb', glyph: '〰️' },
  { id: 'swirl', label: 'Swirl', glyph: '🌀' },
];

const hex = (h: string): RGB => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const PALETTES: Record<PaletteId, { base: string; inks: string[] }> = {
  ebru: { base: '#e9e1cf', inks: ['#1c3170', '#d9a13f', '#7b1e22', '#2a9a8c', '#f3ead3', '#1a1a1c'] },
  sumi: { base: '#ece9e1', inks: ['#141518', '#2c3a5e', '#6d6f76', '#a3a5a8', '#f2f0ea', '#4a2a22'] },
  candy: { base: '#f6f1ea', inks: ['#ff5c8a', '#2ec4b6', '#ffbf1f', '#7b61ff', '#3aa0ff', '#ffffff'] },
};

const UI_STYLE_ID = 'marble-ui-style';
const uiCss = `
.marble-tray {
  position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
  bottom: calc(10px + var(--safe-bottom)); display: flex; flex-direction: column; gap: 6px; align-items: center;
  padding: 7px 8px; border-radius: 20px; background: rgba(20,14,8,.62);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); border: 1px solid rgba(255,255,255,.12);
  max-width: calc(100vw - 20px);
}
.marble-row { display: flex; gap: 6px; align-items: center; }
.marble-row button {
  flex: 0 0 auto; height: 36px; min-width: 36px; padding: 0 10px; border: 0; border-radius: 99px;
  background: transparent; color: #f6efe2; font: 600 14px/1 ui-rounded, -apple-system, sans-serif; cursor: pointer;
}
.marble-row button[aria-pressed="true"] { background: rgba(255,255,255,.22); }
.marble-row button.ink { width: 30px; min-width: 30px; height: 30px; padding: 0; background: var(--ink);
  box-shadow: inset 0 0 0 2px rgba(255,255,255,.2); }
.marble-row button.ink[aria-pressed="true"] { box-shadow: 0 0 0 3px #fff; }
.marble-row button.lay { background: #f4ecdc; color: #3a2a16; padding: 0 14px; margin-left: 4px; }
`;

interface Stroke {
  la: [number, number]; // last applied point (bath units)
  travelled: number;
  n0: [number, number] | null; // rake axis, fixed at stroke start
  start: [number, number];
  angle: number;
  dropR: number;
  tickClock: number;
}

class Marbling implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private p: Record<string, Program>;
  private state!: DoubleTarget;
  private capture!: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };
  private width = 1;
  private height = 1;
  private world: [number, number] = [1, 1];
  private tool: Tool = 'comb';
  private ink = 0;
  private strokes = new Map<number, Stroke>();
  private tray: HTMLElement;
  private toolButtons: HTMLButtonElement[] = [];
  private inkButtons: HTMLButtonElement[] = [];
  private shelf: PrintShelf;
  private uiStyle: HTMLStyleElement | null = null;
  private strokeCount = 0;
  private printing = false;
  private segBuf = new Float32Array(S.MAX_TINES * 4);

  readonly cfg = {
    palette: 'ebru' as PaletteId,
    tines: 7,
    gap: 0.055,
    brush: 0.035,
    drift: 1,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) {
      throw new Error('This device cannot render to float textures.');
    }
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    const vert = compile(gl, gl.VERTEX_SHADER, S.quadVert);
    this.p = {
      stroke: new Program(gl, vert, S.strokeFrag),
      clear: new Program(gl, vert, S.clearFrag),
      copy: new Program(gl, vert, S.copyFrag),
      display: new Program(gl, vert, S.displayFrag),
    };
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    if (!document.getElementById(UI_STYLE_ID)) {
      this.uiStyle = document.createElement('style');
      this.uiStyle.id = UI_STYLE_ID;
      this.uiStyle.textContent = uiCss;
      document.head.appendChild(this.uiStyle);
    }
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.allocate(null);
    this.shelf = new PrintShelf(ctx.overlay);
    this.tray = this.buildTray();
    this.buildPanel();
    this.clearBath(0);
    this.seed();
  }

  // ------------------------------------------------------------------ resources

  private allocate(old: DoubleTarget | null) {
    const gl = this.gl;
    const S0 = Math.min(this.width, this.height);
    const short = Math.min(1024, S0);
    const w = Math.max(1, Math.round((this.width / S0) * short));
    const h = Math.max(1, Math.round((this.height / S0) * short));
    this.world = [this.width / S0, this.height / S0];
    const next = createDouble(gl, w, h, gl.LINEAR);
    if (old) {
      // Keep the pattern across rotations by resampling it into the new bath.
      const u = this.p.copy.use();
      gl.uniform1i(u.uState, 0);
      gl.uniform3f(u.base, 1, 1, 1);
      this.bindTex(0, old.read.tex);
      this.blit(next.read);
      destroyTarget(gl, old.read);
      destroyTarget(gl, old.write);
    }
    this.state = next;
    if (this.capture) {
      gl.deleteTexture(this.capture.tex);
      gl.deleteFramebuffer(this.capture.fbo);
    }
    const cs = 560;
    const capW = Math.round(this.world[0] >= 1 ? cs * this.world[0] : cs);
    const capH = Math.round(this.world[1] >= 1 ? cs * this.world[1] : cs);
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, capW, capH, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.capture = { tex, fbo, w: capW, h: capH };
  }

  // ------------------------------------------------------------------ UI

  private buildTray() {
    const tray = document.createElement('div');
    tray.className = 'marble-tray';
    const inks = document.createElement('div');
    inks.className = 'marble-row';
    const tools = document.createElement('div');
    tools.className = 'marble-row';
    this.toolButtons = TOOLS.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = t.glyph;
      b.setAttribute('aria-label', t.label);
      b.addEventListener('click', () => this.setTool(t.id));
      return b;
    });
    const lay = document.createElement('button');
    lay.type = 'button';
    lay.className = 'lay';
    lay.textContent = 'Lay paper';
    lay.addEventListener('click', () => this.layPaper());
    tools.append(...this.toolButtons, lay);
    tray.append(inks, tools);
    this.ctx.overlay.appendChild(tray);
    this.inkRow = inks;
    this.rebuildInks();
    this.setTool(this.tool);
    return tray;
  }

  private inkRow!: HTMLElement;

  private rebuildInks() {
    this.inkRow.replaceChildren();
    const pal = PALETTES[this.cfg.palette];
    this.inkButtons = pal.inks.map((c, i) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'ink';
      b.style.setProperty('--ink', c);
      b.setAttribute('aria-label', `Ink ${i + 1}`);
      b.addEventListener('click', () => {
        this.ink = i;
        this.inkButtons.forEach((x, j) => x.setAttribute('aria-pressed', String(j === i)));
        if (this.tool !== 'drop') this.setTool('drop');
      });
      return b;
    });
    this.ink = Math.min(this.ink, pal.inks.length - 1);
    this.inkButtons.forEach((x, j) => x.setAttribute('aria-pressed', String(j === this.ink)));
    this.inkRow.append(...this.inkButtons);
  }

  private setTool(t: Tool) {
    this.tool = t;
    this.toolButtons.forEach((b, i) => b.setAttribute('aria-pressed', String(TOOLS[i].id === t)));
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice<PaletteId>(
      'Palette',
      [
        { value: 'ebru', label: 'Ebru' },
        { value: 'sumi', label: 'Suminagashi' },
        { value: 'candy', label: 'Candy' },
      ],
      c.palette,
      (v) => {
        c.palette = v;
        this.rebuildInks();
        this.clearBath(0);
        this.seed();
      },
    );
    panel.slider(c, 'tines', { label: 'Comb tines', min: 2, max: S.MAX_TINES, step: 1 });
    panel.slider(c, 'gap', { label: 'Tine spacing', min: 0.02, max: 0.14, step: 0.005 });
    panel.slider(c, 'brush', { label: 'Brush / drop size', min: 0.012, max: 0.09, step: 0.002 });
    panel.slider(c, 'drift', { label: 'Surface wobble', min: 0, max: 2, step: 0.05 });
    panel.action('Lay paper', () => this.layPaper());
    panel.action('Clear bath', () => this.clearBath(0));
    panel.action('Scatter drops', () => this.seed());
  }

  // ------------------------------------------------------------------ strokes

  private inkColor(i = this.ink): RGB {
    return hex(PALETTES[this.cfg.palette].inks[i]);
  }

  private drop(x: number, y: number, r: number, color: RGB) {
    const gl = this.gl;
    const u = this.p.stroke.use();
    this.common(u);
    gl.uniform1i(u.mode, 0);
    gl.uniform2f(u.center, x, y);
    gl.uniform1f(u.radius, r);
    gl.uniform3f(u.color, color[0], color[1], color[2]);
    this.pass();
  }

  private tines(segs: number[][], tineR: number) {
    const gl = this.gl;
    const n = Math.min(S.MAX_TINES, segs.length);
    for (let i = 0; i < n; i++) this.segBuf.set(segs[i], i * 4);
    const u = this.p.stroke.use();
    this.common(u);
    gl.uniform1i(u.mode, 1);
    gl.uniform4fv(u['seg[0]'], this.segBuf);
    gl.uniform1i(u.nSeg, n);
    gl.uniform1f(u.tineR, tineR);
    this.pass();
  }

  private swirl(x: number, y: number, radius: number, angle: number) {
    const gl = this.gl;
    const u = this.p.stroke.use();
    this.common(u);
    gl.uniform1i(u.mode, 2);
    gl.uniform2f(u.center, x, y);
    gl.uniform1f(u.radius, radius);
    gl.uniform1f(u.angle, angle);
    this.pass();
  }

  private common(u: Record<string, WebGLUniformLocation>) {
    const gl = this.gl;
    gl.uniform1i(u.uState, 0);
    gl.uniform2f(u.texSize, this.state.width, this.state.height);
    gl.uniform2f(u.world, this.world[0], this.world[1]);
  }

  private pass() {
    this.bindTex(0, this.state.read.tex);
    this.blit(this.state.write);
    this.state.swap();
  }

  private clearBath(ghost: number) {
    const gl = this.gl;
    const u = this.p.clear.use();
    const b = hex(PALETTES[this.cfg.palette].base);
    gl.uniform1i(u.uState, 0);
    gl.uniform3f(u.base, b[0], b[1], b[2]);
    gl.uniform1f(u.ghost, ghost);
    this.pass();
    this.strokeCount = 0;
  }

  /** A traditional start: rings of dropped colour, then scattered speckle drops. */
  private seed() {
    const [W, H] = this.world;
    const inks = PALETTES[this.cfg.palette].inks.length;
    const cx = W / 2, cy = H * 0.55;
    for (let k = 0; k < 9; k++) this.drop(cx + (Math.random() - 0.5) * 0.02, cy + (Math.random() - 0.5) * 0.02, 0.07 + Math.random() * 0.03, this.inkColor(k % inks));
    for (let k = 0; k < 22; k++) {
      const x = 0.08 + Math.random() * (W - 0.16);
      const y = 0.12 + Math.random() * (H - 0.3);
      this.drop(x, y, 0.025 + Math.random() * 0.05, this.inkColor(Math.floor(Math.random() * inks)));
    }
  }

  // ------------------------------------------------------------------ frame

  frame(dt: number, t: number) {
    this.handleInput(dt);
    this.render(t);
    this.ctx.setStatus(`${this.strokeCount} strokes · ${this.shelf.prints.length} prints`);
  }

  private handleInput(dt: number) {
    if (this.printing) return;
    const [W, H] = this.world;
    const c = this.cfg;
    for (const p of this.ctx.pointers.active.values()) {
      const q: [number, number] = [p.x * W, p.y * H];
      let s = this.strokes.get(p.id);
      if (!s || p.justDown) {
        s = { la: q, travelled: 0, n0: null, start: q, angle: 0, dropR: 0, tickClock: 0 };
        this.strokes.set(p.id, s);
        if (this.tool === 'drop') {
          const r = c.brush * (0.8 + Math.random() * 0.3);
          this.drop(q[0], q[1], r, this.inkColor());
          s.dropR = r;
          this.strokeCount++;
          this.ctx.haptic('light');
        }
        continue;
      }
      const dx = q[0] - s.la[0];
      const dy = q[1] - s.la[1];
      const dist = Math.hypot(dx, dy);
      s.tickClock += dt;
      switch (this.tool) {
        case 'drop': {
          if (dist > c.brush * 1.2) {
            // Dragging dribbles a trail of drops.
            this.drop(q[0], q[1], c.brush * (0.5 + Math.random() * 0.3), this.inkColor());
            s.la = q;
            this.strokeCount++;
          } else if (p.held > 0.12) {
            // Holding still keeps pouring: the drop grows by constant area per second.
            const r2 = s.dropR * s.dropR + dt * 0.012 * (c.brush / 0.035) ** 2;
            const inc = Math.sqrt(Math.max(0, r2 - s.dropR * s.dropR));
            s.dropR = Math.sqrt(r2);
            if (s.dropR < 0.35) this.drop(s.la[0], s.la[1], inc, this.inkColor());
          }
          break;
        }
        case 'swirl': {
          const a0 = Math.atan2(s.la[1] - s.start[1], s.la[0] - s.start[0]);
          const a1 = Math.atan2(q[1] - s.start[1], q[0] - s.start[0]);
          const r = Math.hypot(q[0] - s.start[0], q[1] - s.start[1]);
          let da = a1 - a0;
          da = Math.atan2(Math.sin(da), Math.cos(da));
          if (r > 0.015 && Math.abs(da) > 0.01) {
            this.swirl(s.start[0], s.start[1], Math.max(0.08, r * 1.3), da * 1.6);
            s.la = q;
            this.tick(s);
          } else if (r <= 0.015) s.la = q;
          break;
        }
        default: {
          const tineR = this.tool === 'stylus' ? c.brush * 0.3 : Math.min(c.gap * 0.18, c.brush * 0.25);
          const step = Math.max(0.006, tineR * 2);
          if (dist < step) break;
          if (!s.n0) s.n0 = [-dy / dist, dx / dist];
          // Long moves are split so each pass's brush integration stays short.
          const maxL = tineR * 36;
          const chunks = Math.min(6, Math.ceil(dist / maxL));
          for (let k = 1; k <= chunks; k++) {
            const a: [number, number] = [s.la[0] + (dx * (k - 1)) / chunks, s.la[1] + (dy * (k - 1)) / chunks];
            const b: [number, number] = [s.la[0] + (dx * k) / chunks, s.la[1] + (dy * k) / chunks];
            const sa = s.travelled + (dist * (k - 1)) / chunks;
            const sb = s.travelled + (dist * k) / chunks;
            this.tines(this.rake(a, b, s.n0, sa, sb), tineR);
          }
          s.travelled += dist;
          s.la = q;
          this.strokeCount++;
          this.tick(s);
        }
      }
    }
    for (const id of [...this.strokes.keys()]) if (!this.ctx.pointers.active.has(id)) this.strokes.delete(id);
  }

  /** Tine segments for the current tool: one for the stylus, a rigid rake for combs (wavy for the wave comb). */
  private rake(a: [number, number], b: [number, number], n: [number, number], sa: number, sb: number) {
    const c = this.cfg;
    if (this.tool === 'stylus') return [[a[0], a[1], b[0], b[1]]];
    const N = Math.round(c.tines);
    const segs: number[][] = [];
    const lambda = c.gap * 3.2;
    const amp = this.tool === 'wave' ? c.gap * 0.9 : 0;
    const wa = amp * Math.sin((sa / lambda) * Math.PI * 2);
    const wb = amp * Math.sin((sb / lambda) * Math.PI * 2);
    for (let i = 0; i < N; i++) {
      const o = (i - (N - 1) / 2) * c.gap;
      segs.push([a[0] + n[0] * (o + wa), a[1] + n[1] * (o + wa), b[0] + n[0] * (o + wb), b[1] + n[1] * (o + wb)]);
    }
    return segs;
  }

  private tick(s: Stroke) {
    if (s.tickClock > 0.09) {
      s.tickClock = 0;
      this.ctx.haptic('light');
    }
  }

  // ------------------------------------------------------------------ printing

  private async layPaper() {
    if (this.printing) return;
    this.printing = true;
    this.ctx.haptic('light');
    const ok = await this.shelf.lay(
      () => this.capturePrint(),
      () => {
        // Real prints lift nearly all the ink; a faint ghost stays on the bath.
        this.clearBath(0.1);
        this.ctx.haptic('heavy');
        this.ctx.celebrate('Printed!');
      },
    );
    this.printing = false;
    if (!ok) return;
  }

  private capturePrint() {
    const gl = this.gl;
    const { fbo, w, h } = this.capture;
    const u = this.p.copy.use();
    const base = hex(PALETTES[this.cfg.palette].base);
    gl.uniform1i(u.uState, 0);
    gl.uniform3f(u.base, base[0], base[1], base[2]);
    this.bindTex(0, this.state.read.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.viewport(0, 0, w, h);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    const px = new Uint8Array(w * h * 4);
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d')!;
    const img = g.createImageData(w, h);
    // GL rows are bottom-up.
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    g.putImageData(img, 0, 0);
    return { url: cv.toDataURL('image/jpeg', 0.9), ratio: w / h };
  }

  // ------------------------------------------------------------------ render

  private render(t: number) {
    const gl = this.gl;
    const u = this.p.display.use();
    gl.uniform1i(u.uState, 0);
    gl.uniform2f(u.texSize, this.state.width, this.state.height);
    gl.uniform2f(u.world, this.world[0], this.world[1]);
    gl.uniform1f(u.time, t % 1000);
    gl.uniform1f(u.drift, this.cfg.drift);
    this.bindTex(0, this.state.read.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
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
    this.allocate(this.state);
  }

  destroy() {
    const gl = this.gl;
    destroyTarget(gl, this.state.read);
    destroyTarget(gl, this.state.write);
    gl.deleteTexture(this.capture.tex);
    gl.deleteFramebuffer(this.capture.fbo);
    this.tray.remove();
    this.shelf.destroy();
    this.uiStyle?.remove();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
