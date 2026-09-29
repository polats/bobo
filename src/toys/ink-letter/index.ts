import type { Loop } from '../../shell/sound';
import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile } from '../../shell/gl';
import { LETTERS, paintLetter, type Letter, type Word } from './letters';
import { IGNITE, Paper } from './sim';
import * as S from './shaders';

export const inkLetterToy: Toy = {
  id: 'ink-letter',
  title: 'Invisible Ink',
  blurb: 'Hold a secret letter over a candle to bring out the hidden message. Keep it moving: linger and the paper browns, chars and catches.',
  tech: 'CPU heat + scorch grid · WebGL2 composite',
  swatch: 'radial-gradient(circle at 50% 78%,#ffd27a 0 6%,#e0762a 12%,transparent 30%),linear-gradient(180deg,#e9d9b4 0 58%,#a0622c 70%,#2a1a12 72%)',
  refs: [
    {
      short: 'Invisible ink',
      title: 'Invisible ink (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Invisible_ink',
      use: 'Lemon-juice ink that browns before the paper does, and cobalt ink that needs more heat: the two inks here.',
    },
    {
      short: 'Heat equation',
      title: 'Heat equation (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Heat_equation',
      use: 'Explicit five-point diffusion of the flame’s heat through the sheet.',
    },
    {
      short: 'Noita',
      title: 'Exploring the Tech and Design of Noita (Petri Purho, GDC 2019)',
      url: 'https://www.youtube.com/watch?v=prXuyMCgbTc',
      use: 'Per-cell fire that spreads to neighbours and burns material away, as in Campfire’s Burn grid.',
    },
  ],
  async create(ctx) {
    return new InkLetter(ctx);
  },
};

/** Grid cells and mask pixels per world unit (the screen's short side). */
const CPU = 110;
const MPX = 600;
/** Share of the hidden ink that must read to decode, and the share of sheet that may char. */
const GOAL = 0.82;
const LIMIT = 0.05;
const MAX_PARTS = 256;
/** Seconds the letter sways over the flame on its own before the first touch (the ad hook). */
const IDLE_DEMO = 6.5;

class InkLetter implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private scene: Program;
  private parts: Program;
  private quad: WebGLVertexArrayObject;
  private partVao: WebGLVertexArrayObject;
  private partBuf: WebGLBuffer;
  private partData = new Float32Array(MAX_PARTS * 5);
  private tex1: WebGLTexture;
  private tex2: WebGLTexture;
  private maskTex: WebGLTexture;

  private width = 1;
  private height = 1;
  private px = 1;
  private X = 1;
  private Y = 1;
  private candle = { x: 0.5, y: 0.5, r: 0.06, desk: 0.2 };

  private index = 0;
  private letter!: Letter;
  private paper!: Paper;
  private words: Word[] = [];
  private sx = 0;
  private sy = 0;
  private angle = 0;
  private vx = 0;
  private vy = 0;
  private lift = 0;
  private touched = false;
  private dragging = false;
  private t0 = 0;
  private time = 0;
  private state: 'play' | 'decoded' | 'lost' = 'play';
  private glow = 0;
  private bend = 0;
  private hx = 0;
  private hy = 0;
  private flick = 1;
  private celebrations = 0;
  private burnt = 0;
  private lastCatch = -9;
  private lastSizzle = 0;
  private wordFrame = 0;
  private shownWords = 0;
  private lostWords = 0;
  private cpuMs = 0;

  private pX = new Float32Array(MAX_PARTS);
  private pY = new Float32Array(MAX_PARTS);
  private pVX = new Float32Array(MAX_PARTS);
  private pVY = new Float32Array(MAX_PARTS);
  private pLife = new Float32Array(MAX_PARTS);
  private pDur = new Float32Array(MAX_PARTS);
  private pSize = new Float32Array(MAX_PARTS);
  private pKind = new Uint8Array(MAX_PARTS);
  private pN = 0;

  private crackle: Loop;
  private hiss: Loop;
  private style: HTMLStyleElement;
  private tag: HTMLElement;
  private bar: HTMLElement;
  private hint: HTMLElement;
  private card: HTMLElement;

  readonly cfg = { flame: 1, draught: 1 };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    const vert = compile(gl, gl.VERTEX_SHADER, S.quadVert);
    this.scene = new Program(gl, vert, S.sceneFrag);
    this.parts = new Program(gl, compile(gl, gl.VERTEX_SHADER, S.partVert), S.partFrag);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.partVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.partVao);
    this.partBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.partData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 20, 16);
    gl.bindVertexArray(null);
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.tex1 = tex();
    this.tex2 = tex();
    this.maskTex = tex();

    this.crackle = ctx.sound.loop('crackle');
    this.hiss = ctx.sound.loop('hiss');
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.tag = document.createElement('div');
    this.tag.className = 'inkl-tag';
    this.tag.innerHTML = '<b></b><span class="inkl-row">scorch<span class="inkl-bar"><i></i></span></span>';
    this.bar = this.tag.querySelector('i')!;
    this.hint = document.createElement('div');
    this.hint.className = 'inkl-hint';
    this.card = document.createElement('div');
    this.card.className = 'inkl-card';
    this.card.hidden = true;
    ctx.overlay.append(this.tag, this.hint, this.card);

    ctx.panel.slider(this.cfg, 'flame', { label: 'Flame size', min: 0.6, max: 1.5, step: 0.05 });
    ctx.panel.slider(this.cfg, 'draught', { label: 'Draught', min: 0, max: 2, step: 0.1 });
    ctx.panel.action('Next letter', () => this.load(this.index + 1));
    ctx.panel.action('Start this letter again', () => this.load(this.index));

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.layout();
    this.load(0);
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__inkLetter = () => ({
        letter: this.index,
        state: this.state,
        revealed: +this.paper.revealed.toFixed(3),
        lost: +this.paper.lost.toFixed(3),
        damage: +this.paper.damage.toFixed(4),
        browned: +this.paper.browned.toFixed(3),
        burning: this.paper.burning,
        hottest: +this.paper.hottest.toFixed(2),
        celebrations: this.celebrations,
        words: `${this.shownWords}/${this.words.length}` + (this.lostWords ? ` (${this.lostWords} lost)` : ''),
        sheet: [+this.sx.toFixed(3), +this.sy.toFixed(3)],
        world: [+this.X.toFixed(3), +this.Y.toFixed(3)],
        heat: [+this.hx.toFixed(3), +this.hy.toFixed(3)],
        size: [this.letter.w, this.letter.h],
        cpuMs: +this.cpuMs.toFixed(2),
      });
      w.__inkLetterLoad = (i: number) => this.load(i);
      w.__inkLetterWords = () =>
        this.words.map((x) => {
          const P = this.paper;
          P.word(Math.floor(x.x0 * P.w), Math.floor((1 - x.y1) * P.h), Math.min(P.w - 1, Math.ceil(x.x1 * P.w)), Math.min(P.h - 1, Math.ceil((1 - x.y0) * P.h)), x.inkB);
          return [+x.x0.toFixed(2), +x.x1.toFixed(2), +x.y0.toFixed(2), +x.y1.toFixed(2), x.shown, x.lost, +P.wordShown.toFixed(2), +P.wordLost.toFixed(2)];
        });
    }
  }

  // ---------------------------------------------------------------- setup

  private layout() {
    this.px = Math.min(this.width, this.height);
    this.X = this.width / this.px;
    this.Y = this.height / this.px;
    const portrait = this.Y > this.X;
    this.candle.desk = this.Y * (portrait ? 0.22 : 0.1);
    this.candle.y = this.Y * (portrait ? 0.4 : 0.32);
    this.candle.x = this.X / 2;
    this.candle.r = 0.055;
  }

  private load(i: number) {
    const gl = this.gl;
    this.index = ((i % LETTERS.length) + LETTERS.length) % LETTERS.length;
    const L = (this.letter = LETTERS[this.index]);
    const gw = Math.round(L.w * CPU), gh = Math.round(L.h * CPU);
    this.paper = new Paper(gw, gh);
    const { canvas, words, W, H } = paintLetter(L, MPX);
    this.words = words;
    // Average the mask into the grid (grid rows run bottom-up, the canvas top-down).
    const img = canvas.getContext('2d')!.getImageData(0, 0, W, H).data;
    const { mA, mB } = this.paper;
    const cnt = new Float32Array(gw * gh);
    for (let y = 0; y < H; y++) {
      const gy = gh - 1 - Math.min(gh - 1, Math.floor((y / H) * gh));
      for (let x = 0; x < W; x++) {
        const c = gy * gw + Math.min(gw - 1, Math.floor((x / W) * gw));
        const o = (y * W + x) * 4;
        mA[c] += img[o] / 255;
        mB[c] += img[o + 1] / 255;
        cnt[c]++;
      }
    }
    for (let c = 0; c < gw * gh; c++) {
      // Coverage, boosted a little so thin strokes count as ink cells.
      mA[c] = Math.min(1, (mA[c] / Math.max(1, cnt[c])) * 1.6);
      mB[c] = Math.min(1, (mB[c] / Math.max(1, cnt[c])) * 1.6);
    }
    this.paper.inkReady();
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    for (const t of [this.tex1, this.tex2]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gw, gh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    this.state = 'play';
    this.touched = this.index > 0;
    this.t0 = this.time;
    this.glow = 0;
    this.burnt = 0;
    this.shownWords = this.lostWords = 0;
    this.pN = 0;
    this.vx = this.vy = 0;
    this.card.hidden = true;
    this.tag.classList.remove('away');
    // Arrive with the flame just under the first hidden line (letter one sways there by itself).
    this.heatPoint();
    const { hx, hy } = this;
    const first = L.hidden[0];
    this.sx = hx - (first.x - 0.5) * L.w;
    this.sy = hy - (0.5 - first.y) * L.h + 0.03;
    if (this.index > 0) this.sy = hy - L.h / 2 - 0.12;
    this.clampSheet();
    this.tag.querySelector('b')!.textContent = `Letter ${this.index + 1} · ${L.name}`;
    this.showHint(L.hint);
    this.ctx.progress(0, 'revealed');
  }

  private showHint(text: string) {
    this.hint.textContent = text;
    this.hint.classList.remove('show');
    void this.hint.offsetWidth;
    this.hint.classList.add('show');
  }

  /** Where the flame's heat is centred (world), leaning with the draught: sets hx, hy. */
  private heatPoint() {
    const len = 0.19 * this.cfg.flame;
    this.hx = this.candle.x + this.bend * 0.5 * len;
    this.hy = this.candle.y + len * (1.1 - 0.15 * Math.abs(this.bend));
  }

  private clampSheet() {
    const { w, h } = this.letter;
    this.heatPoint();
    const { hx, hy } = this;
    this.sx = Math.max(hx - w / 2 - 0.1, Math.min(hx + w / 2 + 0.1, this.sx));
    this.sy = Math.max(hy - h / 2 - 0.02, Math.min(Math.min(hy + h / 2 + 0.35, this.Y - h / 2 + 0.05), this.sy));
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    const t0 = import.meta.env.DEV ? performance.now() : 0;
    this.time = t;
    this.input(dt);
    this.flameStep(dt);
    const P = this.paper;
    // The flame's heat, carried into sheet cells.
    this.heatPoint();
    const { hx, hy } = this;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    const rx = hx - this.sx, ry = hy - this.sy;
    const lx = c * rx + s * ry, ly = -s * rx + c * ry;
    const gx = (lx / this.letter.w + 0.5) * P.w, gy = (ly / this.letter.h + 0.5) * P.h;
    const f = this.cfg.flame;
    // Once decoded, the hand is pulling the letter away: no more heat.
    if (this.state !== 'decoded') P.addHeat(gx, gy, 0.045 * f * CPU, 0.1 * f * CPU, 0.05 * f * CPU, 0.94 + 0.06 * this.flick, this.bend * 0.5);
    P.step(dt);
    this.glow = Math.max(0, this.glow - dt * 0.6);
    this.events(t);
    this.stepParts(dt);
    this.draw(t);
    this.ctx.setStatus(`${Math.round(P.revealed * 100)}% read · ${(P.damage * 100).toFixed(1)}% burnt`);
    if (import.meta.env.DEV) this.cpuMs += (performance.now() - t0 - this.cpuMs) * 0.05;
  }

  private input(dt: number) {
    let p = null;
    for (const q of this.ctx.pointers.active.values()) {
      p = q;
      break;
    }
    const was = this.dragging;
    this.dragging = !!p && this.state === 'play';
    if (p && this.state === 'play') {
      if (!was) {
        this.ctx.haptic('light');
        this.ctx.sound.play('whoosh', { pitch: 2.2, gain: 0.12 });
        if (!this.touched) this.hint.classList.remove('show');
        this.touched = true;
      }
      const mx = p.dx * this.X, my = p.dy * this.Y;
      this.sx += mx;
      this.sy += my;
      this.vx += (mx / Math.max(dt, 1e-3) - this.vx) * Math.min(1, dt * 12);
      this.vy += (my / Math.max(dt, 1e-3) - this.vy) * Math.min(1, dt * 12);
    } else {
      this.vx *= Math.exp(-dt * 8);
      this.vy *= Math.exp(-dt * 8);
      const L = this.letter;
      this.heatPoint();
    const { hx, hy } = this;
      const age = this.time - this.t0;
      if (!this.touched && this.state === 'play') {
        // The ad hook: the letter sways along its first hidden line, then lifts clear of the flame.
        const first = L.hidden[0];
        const u = age < IDLE_DEMO ? first.x + 0.3 * Math.sin(age * 1.15 - 0.4) : first.x;
        const tx = hx - (u - 0.5) * L.w;
        const ty = age < IDLE_DEMO ? hy - (0.5 - first.y) * L.h + 0.03 : hy - L.h / 2 - 0.14;
        const k = Math.min(1, dt * (age < IDLE_DEMO ? 6 : 2));
        this.vx = (tx - this.sx) / Math.max(dt, 1e-3) * k;
        this.sx += (tx - this.sx) * k;
        this.sy += (ty - this.sy) * k;
        if (age > IDLE_DEMO && !this.hint.classList.contains('show')) this.showHint('Drag the letter over the candle. Gently!');
      } else if (this.state === 'decoded') {
        // Lift the decoded letter clear of the flame, above the card.
        this.sx += (hx - this.sx) * Math.min(1, dt * 3);
        this.sy += (Math.min(hy + L.h / 2 + 0.14, this.Y - 0.3 - L.h / 2) - this.sy) * Math.min(1, dt * 3);
      }
    }
    this.clampSheet();
    // Tilt with the drag like a sheet held by one corner; a little flutter in a draught.
    const target = Math.max(-0.07, Math.min(0.07, -this.vx * 0.06)) - 0.02 + this.bend * 0.015 * Math.sin(this.time * 3);
    this.angle += (target - this.angle) * Math.min(1, dt * 6);
    this.lift += ((this.dragging ? 1 : 0) - this.lift) * Math.min(1, dt * 8);
  }

  private flameStep(dt: number) {
    const t = this.time;
    const w = this.letter.wind * this.cfg.draught;
    // Draught: slow swells plus the odd gust; a still room just breathes the flame a little.
    const gust = Math.max(0, Math.sin(t * 0.37 + 1.1)) ** 6;
    const target = w * (0.55 * Math.sin(t * 0.8) + 0.3 * Math.sin(t * 2.3 + 1.3) + 0.6 * gust) + 0.04 * Math.sin(t * 1.7);
    this.bend += (Math.max(-1, Math.min(1, target)) - this.bend) * Math.min(1, dt * 4);
    this.flick = 0.75 + 0.25 * Math.sin(t * 17) * Math.sin(t * 5.3 + 1);
  }

  private events(t: number) {
    const P = this.paper;
    const snd = this.ctx.sound;
    // Crackle rises as the paper chars; a soft hiss as it heats.
    this.crackle.set(Math.min(1, P.charring * 0.6 + P.burning / 50), Math.min(1, 0.3 + P.burning / 120));
    this.hiss.set(Math.max(0, Math.min(1, (P.hottest - 0.35) * 0.8)) * 0.6, 0.3 + Math.min(0.6, P.hottest * 0.4));
    if (P.burning > 0 && t - this.lastSizzle > 0.28 + Math.random() * 0.3) {
      this.lastSizzle = t;
      snd.play('sizzle', { gain: Math.min(1, 0.25 + P.burning / 60), pitch: 0.8 + Math.random() * 0.5 });
    }
    if (P.caught > 0) {
      if (t - this.lastCatch > 1.2) {
        snd.play('whoosh', { pitch: 0.8, gain: 0.9 });
        this.ctx.haptic('medium');
        if (this.state === 'play') this.showHint('It caught! Pull it away!');
      }
      this.lastCatch = t;
    }
    // Light ticks as each hidden word comes through; a word that chars away is lost for good.
    if (++this.wordFrame % 3 === 0) {
      for (const w of this.words) {
        if (w.lost) continue;
        const x0 = Math.floor(w.x0 * P.w), x1 = Math.min(P.w - 1, Math.ceil(w.x1 * P.w));
        const y0 = Math.floor((1 - w.y1) * P.h), y1 = Math.min(P.h - 1, Math.ceil((1 - w.y0) * P.h));
        P.word(x0, y0, x1, y1, w.inkB);
        if (P.wordLost > 0.5) {
          w.lost = true;
          this.lostWords++;
          if (w.shown) this.shownWords--;
          w.shown = false;
        } else if (!w.shown && P.wordShown > 0.6) {
          w.shown = true;
          this.shownWords++;
          this.ctx.haptic('light');
          snd.play('tick', { pitch: w.inkB ? 0.8 : 1.1 + Math.random() * 0.2, gain: 0.8 });
          break;
        }
      }
    }
    this.burnt = Math.max(this.burnt, P.damage);
    this.bar.style.width = `${Math.min(100, (this.burnt / LIMIT) * 100).toFixed(1)}%`;
    this.bar.classList.toggle('hot', this.burnt > LIMIT * 0.6);
    if (this.state !== 'play') return;
    const settled = this.shownWords + this.lostWords === this.words.length;
    // The ring fills with both the ink read and the words come through, so it completes at the decode.
    this.ctx.progress(0.5 * Math.min(1, P.revealed / GOAL) + (0.5 * this.shownWords) / this.words.length, 'revealed');
    if (P.revealed >= GOAL && settled && this.lostWords <= 1 && P.damage <= LIMIT) {
      this.state = 'decoded';
      this.celebrations++;
      this.glow = 1;
      this.ctx.celebrate(P.damage < 0.002 ? 'Decoded, not a scorch!' : 'Decoded!');
      this.showCard(true);
    } else if (P.damage > LIMIT || this.lostWords > 1 || P.lost > 1 - GOAL + 0.03) {
      this.state = 'lost';
      snd.play('crumble', { pitch: 0.7 });
      this.ctx.haptic('heavy');
      this.showCard(false);
    }
  }

  private showCard(ok: boolean) {
    const L = this.letter;
    const last = this.index === LETTERS.length - 1;
    this.card.innerHTML = ok
      ? `<em class="stamp">Decoded</em><p>“${L.decoded}”</p><button type="button">${last ? 'Back to letter 1' : 'Next letter'} ›</button>`
      : `<em class="stamp lost">Burnt</em><p>The message went up in smoke. Keep the letter moving, and pull it away when it browns.</p><button type="button">Try again</button>`;
    this.card.querySelector('button')!.onclick = () => this.load(ok ? this.index + 1 : this.index);
    this.card.hidden = false;
    this.tag.classList.add('away');
    this.hint.classList.remove('show');
  }

  // ---------------------------------------------------------------- particles

  private spawn(x: number, y: number, vx: number, vy: number, dur: number, size: number, kind: number) {
    if (this.pN >= MAX_PARTS) return;
    const i = this.pN++;
    this.pX[i] = x;
    this.pY[i] = y;
    this.pVX[i] = vx;
    this.pVY[i] = vy;
    this.pLife[i] = this.pDur[i] = dur;
    this.pSize[i] = size;
    this.pKind[i] = kind;
  }

  private stepParts(dt: number) {
    const P = this.paper;
    const L = this.letter;
    const c = Math.cos(this.angle), s = Math.sin(this.angle);
    // Sample a few random cells: burning ones throw embers and smoke, scorching ones smoke (the warning).
    for (let k = 0; k < 28; k++) {
      const i = (Math.random() * P.n) | 0;
      const fire = P.fire[i] > 0;
      const hot = P.dose[i] > 0.45 && P.dose[i] < IGNITE && P.T[i] > 0.75 && !P.hole[i];
      if (!fire && !hot) continue;
      if (!fire && Math.random() > 0.25) continue;
      const lx = (((i % P.w) + 0.5) / P.w - 0.5) * L.w, ly = ((((i / P.w) | 0) + 0.5) / P.h - 0.5) * L.h;
      const x = this.sx + c * lx - s * ly, y = this.sy + s * lx + c * ly;
      if (fire && Math.random() < 0.35) this.spawn(x, y, (Math.random() - 0.5) * 0.12 + this.bend * 0.1, 0.1 + Math.random() * 0.25, 0.6 + Math.random() * 0.9, 0.006 + Math.random() * 0.006, 0);
      if (Math.random() < 0.5) this.spawn(x, y + 0.01, (Math.random() - 0.5) * 0.03, 0.05 + Math.random() * 0.05, 1.6 + Math.random() * 1.4, 0.025 + Math.random() * 0.02, 1);
    }
    let n = 0;
    for (let i = 0; i < this.pN; i++) {
      this.pLife[i] -= dt;
      if (this.pLife[i] <= 0) continue;
      const kind = this.pKind[i];
      // Embers rise and wander; smoke drifts with the draught and slows.
      this.pVX[i] += ((Math.random() - 0.5) * 0.6 + this.bend * 0.15) * dt;
      if (kind === 1) this.pVY[i] *= 1 - dt * 0.3;
      this.pX[n] = this.pX[i] + this.pVX[i] * dt;
      this.pY[n] = this.pY[i] + this.pVY[i] * dt;
      this.pVX[n] = this.pVX[i];
      this.pVY[n] = this.pVY[i];
      this.pLife[n] = this.pLife[i];
      this.pDur[n] = this.pDur[i];
      this.pSize[n] = this.pSize[i];
      this.pKind[n] = kind;
      n++;
    }
    this.pN = n;
  }

  // ---------------------------------------------------------------- draw

  private draw(t: number) {
    const { gl, paper: P, letter: L } = this;
    P.pack();
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, P.w, P.h, gl.RGBA, gl.UNSIGNED_BYTE, P.tex1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex2);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, P.w, P.h, gl.RGBA, gl.UNSIGNED_BYTE, P.tex2);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    const u = this.scene.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex1);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.tex2);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(u.uS1, 0);
    gl.uniform1i(u.uS2, 1);
    gl.uniform1i(u.uMask, 2);
    gl.uniform1f(u.uPx, this.px);
    gl.uniform2f(u.uWorld, this.X, this.Y);
    gl.uniform4f(u.uSheet, this.sx, this.sy, L.w / 2, L.h / 2);
    gl.uniform2f(u.uRot, Math.cos(this.angle), Math.sin(this.angle));
    gl.uniform2f(u.uCell, P.w, P.h);
    gl.uniform3f(u.uCandle, this.candle.x, this.candle.y, this.candle.r);
    gl.uniform1f(u.uDesk, this.candle.desk);
    gl.uniform3f(u.uFlame, this.cfg.flame, this.bend, this.flick);
    gl.uniform1f(u.uTime, t % 1000);
    gl.uniform1f(u.uLift, this.lift);
    gl.uniform1f(u.uFireOn, P.burning > 0 ? 1 : 0);
    gl.uniform1f(u.uGlow, this.glow);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    if (this.pN) {
      const d = this.partData;
      for (let i = 0; i < this.pN; i++) {
        const o = i * 5;
        d[o] = this.pX[i];
        d[o + 1] = this.pY[i];
        d[o + 2] = this.pLife[i] / this.pDur[i];
        d[o + 3] = this.pSize[i];
        d[o + 4] = this.pKind[i];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, this.pN * 5);
      const pu = this.parts.use();
      gl.uniform2f(pu.uWorld, this.X, this.Y);
      gl.uniform1f(pu.uPx, this.px);
      gl.bindVertexArray(this.partVao);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.uniform1f(pu.uPass, 1);
      gl.drawArrays(gl.POINTS, 0, this.pN);
      gl.blendFunc(gl.ONE, gl.ONE);
      gl.uniform1f(pu.uPass, 0);
      gl.drawArrays(gl.POINTS, 0, this.pN);
      gl.disable(gl.BLEND);
    }
    gl.bindVertexArray(null);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.layout();
    this.clampSheet();
  }

  destroy() {
    this.crackle.stop();
    this.hiss.stop();
    this.tag.remove();
    this.hint.remove();
    this.card.remove();
    this.style.remove();
    const gl = this.gl;
    gl.deleteTexture(this.tex1);
    gl.deleteTexture(this.tex2);
    gl.deleteTexture(this.maskTex);
    gl.deleteBuffer(this.partBuf);
    gl.deleteVertexArray(this.quad);
    gl.deleteVertexArray(this.partVao);
  }
}

const STYLE = `
.inkl-tag { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%); top: calc(116px + var(--safe-top, 0px)); display: grid; gap: 5px; justify-items: center; padding: 7px 14px 8px; border-radius: 14px; background: rgba(20, 12, 8, 0.55); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: #f3e3c3; font: 600 12px/1 Georgia, serif; letter-spacing: 0.04em; pointer-events: none; white-space: nowrap; }
.inkl-bar { position: relative; width: 132px; height: 5px; border-radius: 3px; background: rgba(255, 235, 200, 0.16); overflow: hidden; }
.inkl-tag.away { opacity: 0; transition: opacity .4s; }
.inkl-row { display: flex; align-items: center; gap: 7px; font: italic 11px/1 Georgia, serif; color: rgba(243, 227, 195, 0.75); }
.inkl-bar i { position: absolute; inset: 0 auto 0 0; width: 0; border-radius: 3px; background: linear-gradient(90deg, #d8a55a, #b8561c); transition: width .2s; }
.inkl-bar i.hot { background: linear-gradient(90deg, #e0762a, #ff3b1c); box-shadow: 0 0 8px #ff5a1c; }
.inkl-hint { position: absolute; z-index: 3; left: 50%; bottom: calc(26px + var(--safe-bottom, 0px)); transform: translateX(-50%); padding: 9px 16px; border-radius: 99px; background: rgba(20, 12, 8, 0.62); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: #f6e7c8; font: italic 600 15px/1.2 Georgia, serif; opacity: 0; pointer-events: none; white-space: nowrap; transition: opacity .5s; }
.inkl-hint.show { opacity: 1; animation: inkl-hint 4.5s ease forwards; }
@keyframes inkl-hint { 0% { opacity: 0; transform: translate(-50%, 8px); } 8%, 85% { opacity: 1; transform: translate(-50%, 0); } 100% { opacity: 0; } }
.inkl-card { position: absolute; z-index: 4; left: 50%; bottom: calc(18px + var(--safe-bottom, 0px)); transform: translateX(-50%); width: min(calc(100vw - 32px), 360px); box-sizing: border-box; padding: 18px 20px 16px; border-radius: 6px; background: linear-gradient(180deg, #efe2c4, #e2cfa6); box-shadow: 0 18px 40px -12px rgba(0, 0, 0, 0.8), inset 0 0 30px rgba(120, 80, 30, 0.25); color: #3a2414; text-align: center; animation: inkl-card .45s cubic-bezier(.2, 1.3, .4, 1); }
.inkl-card[hidden] { display: none; }
.inkl-card .stamp { display: inline-block; padding: 4px 12px; border: 3px solid #a3261c; border-radius: 4px; color: #a3261c; font: 800 18px/1 'Courier New', monospace; letter-spacing: 0.2em; text-transform: uppercase; transform: rotate(-4deg); opacity: 0.9; }
.inkl-card .stamp.lost { border-color: #3a2414; color: #3a2414; }
.inkl-card p { margin: 12px 0 14px; font: 700 16px/1.35 'Courier New', monospace; }
.inkl-card button { height: 42px; padding: 0 22px; border: 0; border-radius: 99px; background: #3a2414; color: #f3e3c3; font: 700 15px/1 Georgia, serif; cursor: pointer; }
@keyframes inkl-card { 0% { opacity: 0; transform: translate(-50%, 30px) rotate(2deg); } 100% { opacity: 1; transform: translate(-50%, 0); } }
`;
