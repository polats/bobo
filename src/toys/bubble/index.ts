import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop, Slip } from '../../shell/sound';
import { FilmSim, filmPrograms, type FilmParams, type FilmPrograms } from './film';
import { Inflation, RHO_WATER, SIGMA } from './blow';
import { SceneRenderer, type BubbleDraw } from './render';
import { MAX_SLOTS } from './shaders';

export const bubbleToy: Toy = {
  id: 'bubble',
  title: 'Bubble Wand',
  blurb: 'A soap film on a wand: it drains into rainbow bands, swirls under your finger and thins to black before it pops. Blow gently for one big bubble, hard for a stream of small ones.',
  tech: 'Soap-film thickness + surface flow (stable fluids) · thin-film interference · WebGL2',
  swatch: 'radial-gradient(circle at 42% 38%,#fff6 0 7%,#f6c3ff 12%,#9fe8ff 26%,#fff0a6 38%,#ff9fd0 50%,#7a5cff 62%,#141726 66%,#090b14)',
  refs: [
    {
      short: 'Ishida 2020',
      title: 'Ishida, Synak, Narita, Hachisuka, Wojtan — A Model for Soap Film Dynamics with Evolving Thickness (SIGGRAPH 2020)',
      url: 'https://doi.org/10.1145/3386569.3392405',
      use: 'Thickness as a simulated field carried by the film’s tangential flow; gravity drainage, evaporation, the surface-tension term that makes thickness ripple (∂²h/∂t² ∝ ∇²h), and rupture where it runs too thin. Ours is a flat 2D grid per film, not their 2.5D mesh solver.',
    },
    {
      short: 'Culick 1960',
      title: 'Culick — Comments on a Ruptured Soap Film (J. Appl. Phys. 1960)',
      url: 'https://doi.org/10.1063/1.1735765',
      use: 'A hole’s rim runs out at √(2σ/ρh): fast through black film, slower through thick. Slowed down by the pop slow-motion setting.',
    },
    {
      short: 'Stam 1999',
      title: 'Stam — Stable Fluids (SIGGRAPH 1999)',
      url: 'https://doi.org/10.1145/311535.311548',
      use: 'The surface flow: semi-Lagrangian advection and a pressure projection on each film disc (Ink Swirl’s pass layout).',
    },
    {
      short: 'Wyman 2013',
      title: 'Wyman, Sloan, Shirley — Simple Analytic Approximations to the CIE XYZ Color Matching Functions (JCGT 2013)',
      url: 'https://jcgt.org/published/0002/02/01/',
      use: 'The observer for the interference colours: film reflectance integrated over 380–780 nm into a thickness → colour table.',
    },
  ],
  async create(ctx) {
    return new BubbleWand(ctx);
  },
};

/** Ring radius (m), camera distance (m) and the world width the short side of the screen shows. */
const A = 0.02;
const CAM_F = 0.15;
const VIEW_W = 0.085;
const WAND_N = 128;
const SLOT_N = 64;
const SLOT_COLS = 4;
const SLOT_ROWS = 3;
const DISC = 0.92;
const BATH_H = 3;
/** Liquid the wand's rim holds after a dip, in µm of film over the ring's area. */
const RESERVOIR = 80;
const G = 9.81;

type DipPhase = 'none' | 'down' | 'held' | 'lift' | 'home';

interface Bubble {
  slot: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  r: number;
  /** Breath warmth above the room, K: it rises until it cools. */
  warm: number;
  wobble: number;
  axis: number;
  phase: number;
  /** Seconds since its film tore, or -1. */
  popping: number;
  bornIssue: number;
  age: number;
  mean: number;
}

interface Drop {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
}

type Grip = 'stir' | 'dip' | 'waft' | 'none';

class BubbleWand implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private progs: FilmPrograms;
  private wand: FilmSim;
  private atlas: FilmSim;
  private scene: SceneRenderer;
  private model = new Inflation();
  private width = 1;
  private height = 1;
  private pxPerM = 1;
  private worldH = 0.18;
  private wandY = 0.012;
  private bathY = -0.05;
  private time = 0;
  private frameNo = 0;

  // Wand film lifecycle.
  private present = true;
  private popping = -1;
  private filmIssue = 0;
  private reform = 0;
  private reservoir = RESERVOIR;
  private prevArea = Math.PI * A * A;
  private pinchSpeed = 0;

  // Dipping.
  private dip: DipPhase = 'none';
  private yOff = 0;
  private yVel = 0;
  private dipPointer = -1;
  private grabY = 0;
  private liftS = 0;
  private lastExit = DISC;
  private wetted = false;
  private ripple = 9;

  private bubbles: Bubble[] = [];
  private drops: Drop[] = [];
  private dropData = new Float32Array(512 * 4);
  private grips = new Map<number, Grip>();

  private btnBlow = 0;
  private devBlow: number | null = null;
  private blow = 0;
  private stirSpeed = 0;
  private pinches: number[] = [];
  private pops = 0;
  private hint: HTMLElement;
  private blowBtn: HTMLButtonElement;
  private style: HTMLStyleElement;
  private hiss: Loop;
  private creak: Slip;

  readonly cfg = { soap: 0.5, slowmo: 100, drain: 1, swirl: 10 };

  constructor(private ctx: ToyContext) {
    ctx.mic.offer('Blow gently to make a bubble');
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) throw new Error('This device cannot render to float textures.');
    gl.getExtension('OES_texture_float_linear');
    this.gl = gl;
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.progs = filmPrograms(gl);
    this.wand = new FilmSim(gl, this.progs, this.quad, WAND_N, 1, 1);
    this.wand.setSlot(0, A / (WAND_N * 0.5 * DISC), true, 1);
    this.atlas = new FilmSim(gl, this.progs, this.quad, SLOT_N, SLOT_COLS, SLOT_ROWS);
    for (let i = 0; i < MAX_SLOTS; i++) this.atlas.setSlot(i, 1e-3, false);
    this.scene = new SceneRenderer(gl, this.quad);
    this.hiss = ctx.sound.loop('hiss');
    this.creak = ctx.sound.slip();

    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'bw-hint';
    this.hint.textContent = 'Blow gently · stir the film · tap the bowl to dip';
    this.blowBtn = this.buildBlowButton();
    ctx.overlay.append(this.hint, this.blowBtn);
    this.buildPanel();

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.layout();
    // Start with a film just lifted out of the bowl at an ordinary speed.
    this.freshFilm(frankelDip(0.12));

    if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__bubble = this.devHook();
  }

  // ------------------------------------------------------------------ UI

  private buildBlowButton() {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'bw-blow';
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg><span>Blow</span><i></i>';
    const bar = b.querySelector('i')!;
    let y0 = 0;
    const set = (v: number) => {
      this.btnBlow = v;
      bar.style.transform = `scaleX(${v})`;
      b.classList.toggle('on', v > 0);
    };
    b.addEventListener('pointerdown', (e) => {
      b.setPointerCapture(e.pointerId);
      y0 = e.clientY;
      set(0.36);
    });
    // Slide up while holding to blow harder.
    b.addEventListener('pointermove', (e) => {
      if (this.btnBlow > 0) set(Math.max(0.26, Math.min(1, 0.36 + (y0 - e.clientY) / 160)));
    });
    const end = () => set(0);
    b.addEventListener('pointerup', end);
    b.addEventListener('pointercancel', end);
    return b;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.slider(c, 'soap', { label: 'Soap strength', min: 0, max: 1, step: 0.01 });
    panel.slider(c, 'slowmo', { label: 'Pop slow-motion ×', min: 1, max: 300, step: 1 });
    panel.slider(c, 'drain', { label: 'Drainage', min: 0, max: 3, step: 0.05 });
    panel.slider(c, 'swirl', { label: 'Swirl', min: 0, max: 40, step: 1 });
    panel.action('Dip wand', () => this.startDip(-1));
  }

  // ------------------------------------------------------------------ layout & params

  private layout() {
    this.pxPerM = Math.min(this.width, this.height * 0.52) / VIEW_W;
    this.worldH = this.height / this.pxPerM;
    const bottom = -this.worldH / 2;
    this.bathY = bottom + 0.042;
    this.wandY = Math.min(0.012, this.worldH / 2 - A - 0.02);
  }

  private get halfW() {
    return this.width / this.pxPerM / 2;
  }

  /** Soap strength sets how thin a film survives and how fast it dries. */
  private params(atlas: boolean): FilmParams {
    const s = this.cfg.soap;
    return {
      buoy: 0.012,
      drag: 0.6,
      curl: this.cfg.swirl,
      drain: 3e-4 * this.cfg.drain,
      waves: 4e-6,
      waveDamp: 1.2,
      evap: (0.012 - 0.008 * s) * (atlas ? 1.5 : 1),
      suction: atlas ? 0 : 0.35,
      rimThin: 0.25,
      // Weak soap tears as soon as black film forms; strong soap holds black film for a while.
      rupture: 0.016 - 0.014 * s,
      culick: Math.sqrt((2 * SIGMA) / (RHO_WATER * 1e-6)) / Math.max(1, this.cfg.slowmo),
      blackH: 0.01,
      blackRate: 4e-5 * (1.2 - s),
      iterations: atlas ? 8 : 16,
      ...this.override,
    };
  }

  /** Dev-only parameter overrides. */
  private override: Partial<FilmParams> = {};
  /** Dev-only: skip parts of the frame to profile them. */
  private skip = { sim: false, atlas: false, render: false, bubbles: false };

  private get wandC(): [number, number] {
    return [0, this.wandY + this.yOff];
  }

  // ------------------------------------------------------------------ film lifecycle

  private freshFilm(h: number) {
    this.wand.paint(-2, 2, h);
    this.swirl(4, 0.03);
    this.present = true;
    this.popping = -1;
    this.filmIssue = this.wand.issued;
    this.model.reset();
    this.prevArea = Math.PI * A * A;
  }

  /** A few gentle eddies, as a film lifted out of the bath always carries. */
  private swirl(n: number, speed: number) {
    const cell = A / (WAND_N * 0.5 * DISC);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.wand.splat(0.25 + Math.random() * 0.5, 0.25 + Math.random() * 0.5, (Math.cos(a) * speed) / cell, (Math.sin(a) * speed) / cell, 0.006);
    }
  }

  /** The film tore: a pop sized by what tore (the ring, or the bubble it was blowing). */
  private onWandPop() {
    this.popping = 0;
    const r = this.model.bubble ? this.model.sphereRadius() : A;
    this.popSound(r, 0, 1);
    this.ctx.haptic('medium');
    const [cx, cy] = this.wandC;
    this.spray(cx, cy, this.model.bubble ? Math.sqrt(r * r - A * A) : 0, r, 40);
    this.pops++;
  }

  private startDip(pointer: number) {
    if (this.dip === 'down' || this.dip === 'held' || this.dip === 'lift') return;
    this.dip = 'down';
    this.dipPointer = pointer;
    this.wetted = false;
    this.model.reset();
    this.reform = 0;
  }

  private stepDip(dt: number) {
    const sub = this.bathY - A - 0.004 - this.wandY;
    const prev = this.yOff;
    const ptr = this.dipPointer >= 0 ? this.ctx.pointers.active.get(this.dipPointer) : undefined;
    if (this.dip === 'down') {
      this.yOff = Math.max(sub, this.yOff - 0.55 * dt);
      if (this.yOff <= sub + 1e-4) {
        this.dip = ptr ? 'held' : 'lift';
        if (ptr) this.grabY = this.toWorldY(ptr.y);
        this.liftS = 0;
      }
    } else if (this.dip === 'held') {
      if (!ptr) this.dip = 'lift';
      else {
        const target = Math.min(0, sub + Math.max(0, this.toWorldY(ptr.y) - this.grabY));
        this.yOff += (target - this.yOff) * (1 - Math.exp(-dt * 25));
      }
    } else if (this.dip === 'lift') {
      // An ordinary lift: it speeds up and slows down again, so the middle of the film comes out thickest.
      this.liftS = Math.min(1, Math.max(this.liftS, (this.yOff - sub) / -sub));
      const v = 0.05 + 0.14 * Math.sin(Math.PI * Math.min(1, this.liftS + 0.02));
      this.yOff = Math.min(0, this.yOff + v * dt);
    } else if (this.dip === 'home') {
      this.yVel += (-this.yOff * 300 - this.yVel * 30) * dt;
      this.yOff += this.yVel * dt;
      if (Math.abs(this.yOff) < 1e-4 && Math.abs(this.yVel) < 1e-3) {
        this.yOff = 0;
        this.dip = 'none';
      }
      return;
    }
    const speed = (this.yOff - prev) / dt;
    this.yVel = speed;
    // Where the bath's surface cuts the disc, in its local -1..1 rows.
    const yLoc = ((this.bathY - (this.wandY + this.yOff)) / A) * DISC;
    if (!this.wetted && yLoc > -DISC) {
      // The ring breaks the surface: whatever film it had merges into the bath.
      if (this.dip === 'down' && yLoc > DISC * 0.9) {
        this.wetted = true;
        this.reservoir = RESERVOIR;
        this.wand.paint(-2, 2, BATH_H);
        this.present = true;
        this.popping = -1;
        this.lastExit = DISC;
        this.ripple = 0;
        this.ctx.sound.play('plop', { pitch: 0.7, gain: 0.6 });
        this.ctx.sound.play('splash', { pitch: 1.4, gain: 0.25 });
        this.ctx.haptic('light');
      } else if (this.dip === 'down' && yLoc > -DISC && this.present && this.popping < 0 && yLoc < -DISC + 0.1) {
        // Touching the bath edge-first tears a dry film.
        this.present = false;
        this.popSound(A, 0, 0.5);
      }
    }
    if (this.wetted) {
      // Film forms row by row as the ring leaves the bath, as thick as the pull was fast (Frankel).
      if (yLoc < this.lastExit) this.wand.paint(Math.max(-DISC, yLoc), this.lastExit, frankelDip(Math.max(0.005, speed)));
      this.wand.paint(-2, Math.min(yLoc, DISC), BATH_H);
      this.lastExit = Math.min(DISC, Math.max(yLoc, -DISC));
      if (yLoc <= -DISC) {
        this.wetted = false;
        this.swirl(3, 0.02);
        this.filmIssue = this.wand.issued;
        this.prevArea = Math.PI * A * A;
        this.ctx.sound.bubbles(4, 0.001, 0.003, { gain: 0.25 });
        this.dip = 'home';
        this.yVel = speed;
      }
    }
  }

  private toWorldY(uvY: number) {
    return (uvY - 0.5) * this.worldH;
  }

  // ------------------------------------------------------------------ frame

  private jsMs = 0;
  private jsWorst = 0;

  frame(dt: number, t: number) {
    const t0 = performance.now();
    this.frameInner(dt, t);
    const ms = performance.now() - t0;
    this.jsMs += (ms - this.jsMs) * 0.05;
    this.jsWorst = Math.max(this.jsWorst * 0.995, ms);
  }

  private frameInner(dt: number, t: number) {
    this.time = t;
    this.frameNo++;
    this.ripple += dt;
    this.input(dt);
    if (this.dip !== 'none') this.stepDip(dt);

    // Breath: the mic, the hold button, or the dev hook.
    const mic = this.ctx.mic.active ? this.ctx.mic.blow : 0;
    this.blow = this.devBlow ?? Math.max(mic, this.btnBlow);
    this.hiss.set(this.btnBlow * 0.5, 0.3 + this.btnBlow * 0.4);

    const home = this.dip === 'none' || this.dip === 'home';
    if (this.present && this.popping < 0 && home) this.stepInflation(dt);
    else if (this.reform > 0) {
      this.reform -= dt;
      if (this.reform <= 0) this.reformFilm();
    }

    // While the ring is still in the bath the film is only being drawn out; it starts moving once free.
    if (this.present && !this.wetted && !this.skip.sim) this.wand.step(dt, this.params(false), this.popping >= 0 ? 5 : 1);
    const anyBubble = this.bubbles.length > 0;
    // Free bubbles change slowly: step them every other frame at twice the step, unless one is tearing.
    const tearing = this.bubbles.some((b) => b.popping >= 0);
    if (anyBubble && !this.skip.atlas) {
      if (tearing) this.atlas.step(dt, this.params(true), 3);
      else if (this.frameNo % 2) this.atlas.step(Math.min(1 / 20, dt * 2), this.params(true), 1);
    }

    if (this.frameNo % 2 === 0) {
      if (this.present) this.wand.readback();
    } else if (anyBubble) this.atlas.readback();
    this.checkPops(dt);
    this.stepBubbles(dt);
    this.stepDrops(dt);
    this.feel();
    if (!this.skip.render) this.draw();
    this.status();
  }

  private input(dt: number) {
    const [cx, cy] = this.wandC;
    this.stirSpeed = 0;
    for (const p of this.ctx.pointers.active.values()) {
      const wx = (p.x - 0.5) * (this.width / this.pxPerM);
      const wy = this.toWorldY(p.y);
      if (p.justDown) {
        let grip: Grip = 'waft';
        const hit = this.bubbleAt(wx, wy);
        if (hit) {
          this.pokeBubble(hit, wx, wy);
          grip = 'none';
        } else if (Math.hypot(wx - cx, wy - cy) < A * 1.05 && this.present) grip = 'stir';
        else if (wy < this.bathY + 0.01 && Math.abs(wx) < 0.04) {
          grip = 'dip';
          this.startDip(p.id);
        }
        this.grips.set(p.id, grip);
      }
      const grip = this.grips.get(p.id) ?? 'none';
      const vx = (p.dx * this.width) / this.pxPerM / dt;
      const vy = (p.dy * this.worldH) / dt;
      if (grip === 'stir' && this.present && (p.dx || p.dy)) {
        const cell = A / (WAND_N * 0.5 * DISC);
        const u = 0.5 + (0.5 * DISC * (wx - cx)) / A;
        const v = 0.5 + (0.5 * DISC * (wy - cy)) / A;
        // Drag drags the surface with it: a velocity splat in cells per second.
        const k = 0.35;
        this.wand.splat(u, v, (vx / cell) * k, (vy / cell) * k, 0.0025);
        this.stirSpeed = Math.max(this.stirSpeed, Math.hypot(vx, vy));
      } else if (grip === 'waft' && (p.dx || p.dy)) {
        // Moving air: a swipe wafts the bubbles near it.
        for (const b of this.bubbles) {
          const s = CAM_F / (CAM_F + b.z);
          const d = Math.hypot(b.x * s - wx, b.y * s - wy);
          const reach = 0.02 + b.r * s;
          if (d < reach * 2) {
            const f = (1 - d / (reach * 2)) * 0.5;
            b.vx += (vx / s - b.vx) * f * Math.min(1, dt * 12);
            b.vy += (vy / s - b.vy) * f * Math.min(1, dt * 12);
          }
        }
      }
    }
    for (const id of this.grips.keys()) if (!this.ctx.pointers.active.has(id)) this.grips.delete(id);
  }

  private stepInflation(dt: number) {
    const m = this.model;
    // Breath is turbulent air dragging on the film: it churns the colours while you blow.
    if (this.blow > 0.08) {
      const cell = A / (WAND_N * 0.5 * DISC);
      for (let i = 0; i < 2; i++) {
        const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * 0.35;
        const f = ((this.blow * 0.12) / cell) * (0.5 + Math.random());
        this.wand.splat(0.5 + r * Math.cos(a), 0.5 + r * Math.sin(a), f * Math.cos(a + 1.9), f * Math.sin(a + 1.9), 0.004);
      }
    }
    const n = 4;
    let pinch = null;
    for (let i = 0; i < n && !pinch; i++) pinch = m.step(dt / n, this.blow);
    const area = pinch ? pinch.area : m.area();
    const k = area / this.prevArea;
    if (Math.abs(k - 1) > 1e-4) {
      // Where the extra area comes from depends on how fast it's made: pulled slowly, the film that's
      // there just stretches thinner; pulled fast, fresh film is drawn out of the rim's meniscus, as
      // thick as the pull is fast (Frankel's h ∝ U^(2/3)).
      const U = Math.abs(area - this.prevArea) / dt / (2 * Math.PI * A);
      const drawn = U / (U + 0.05);
      const avail = Math.sqrt(Math.max(0, Math.min(1, this.reservoir / 12)));
      const mean = this.wand.stats[0].mean || 1;
      const frankel = Math.min(1.2, 0.45 * Math.pow(U / 0.1, 2 / 3)) * avail;
      const grow = k > 1;
      const thin = grow ? Math.pow(1 / k, 1 - drawn) : 1 / k;
      const hNew = Math.max(0.05, grow ? drawn * frankel + (1 - drawn) * mean * thin : mean);
      if (grow) this.reservoir -= ((area - this.prevArea) / (Math.PI * A * A)) * drawn * frankel;
      else this.reservoir = Math.min(RESERVOIR, this.reservoir + ((this.prevArea - area) / (Math.PI * A * A)) * mean);
      this.wand.feed(k, hNew, grow ? thin : 1);
      this.prevArea = area;
    }
    if (pinch) this.onPinch(pinch.radius, pinch.speed);
  }

  private onPinch(radius: number, speed: number) {
    const slot = this.freeSlot();
    const [cx, cy] = this.wandC;
    const cellW = A / (WAND_N * 0.5 * DISC);
    const cellB = radius / (SLOT_N * 0.5 * DISC);
    this.atlas.setSlot(slot, cellB, true, 0.7);
    this.atlas.copyFrom(this.wand, slot, cellW / cellB);
    this.bubbles.push({
      slot,
      x: cx + (Math.random() - 0.5) * 0.003,
      y: cy,
      z: radius * 1.05,
      // The breath jet is turbulent: each bubble leaves at a slightly different angle.
      vx: (Math.random() - 0.5) * (0.06 + 0.2 * this.blow),
      vy: 0.02 + (Math.random() - 0.3) * 0.1 * this.blow,
      vz: 0.6 + 1.2 * speed,
      r: radius,
      warm: 15,
      wobble: 0.14,
      axis: Math.PI / 2 + (Math.random() - 0.5) * 0.6,
      phase: 0,
      popping: -1,
      bornIssue: this.atlas.issued,
      age: 0,
      mean: 0.8,
    });
    this.pinches.push(radius);
    if (this.pinches.length > 200) this.pinches.shift();
    this.ctx.sound.bubble(Math.min(0.012, radius * 0.12), { gain: 0.35, pan: 0 });
    this.ctx.haptic('light');
    this.hint.classList.add('gone');
    // A new film has to span the ring before the next one can start.
    this.present = false;
    this.pinchSpeed = speed;
    this.reform = 0.06;
  }

  private reformFilm() {
    // The neck's leftover film snaps back across the ring, if the rim still holds enough liquid.
    const avail = Math.sqrt(Math.max(0, Math.min(1, this.reservoir / 12)));
    const h = Math.min(1.0, 0.3 * Math.pow(Math.max(0.05, this.pinchSpeed) / 0.1, 2 / 3)) * avail;
    if (this.reservoir < 1.5 || h < 0.05) {
      this.wand.paint(-2, 2, 0);
      this.present = false;
      return;
    }
    this.reservoir -= h;
    this.freshFilm(h);
    this.model.kick(-0.9);
  }

  private freeSlot() {
    const used = new Set(this.bubbles.map((b) => b.slot));
    for (let i = 0; i < MAX_SLOTS; i++) if (!used.has(i)) return i;
    // Every slot is taken: the oldest bubble bursts to make room.
    let old = this.bubbles[0];
    for (const b of this.bubbles) if (b.age > old.age) old = b;
    this.burst(old);
    this.removeBubble(old);
    return old.slot;
  }

  private checkPops(dt: number) {
    if (this.present) {
      const st = this.wand.stats[0];
      if (this.popping < 0 && this.wand.resultIssue > this.filmIssue && st.hole > 0 && this.dip === 'none') this.onWandPop();
      if (this.popping >= 0) {
        this.popping += dt;
        if ((this.wand.resultIssue > this.filmIssue && st.cover < 0.02 && this.popping > 0.1) || this.popping > 2) {
          this.present = false;
          this.popping = -1;
          this.model.reset();
          this.prevArea = Math.PI * A * A;
        }
      }
    }
    for (const b of this.bubbles.slice()) {
      const st = this.atlas.stats[b.slot];
      const fresh = this.atlas.resultIssue > b.bornIssue;
      if (fresh && st.mean > 0) b.mean = st.mean;
      if (b.popping < 0 && fresh && st.hole > 0) this.burst(b);
      if (b.popping >= 0) {
        b.popping += dt;
        if ((fresh && st.cover < 0.02 && b.popping > 0.08) || b.popping > 1.5) this.removeBubble(b);
      }
    }
  }

  /** Start a bubble's pop: sound, a tap, and a spray of droplets thrown off the rim. */
  private burst(b: Bubble) {
    if (b.popping >= 0) return;
    b.popping = 0;
    const s = CAM_F / (CAM_F + b.z);
    this.popSound(b.r, Math.max(-1, Math.min(1, (b.x * s) / this.halfW)), s);
    this.ctx.haptic('light');
    this.spray(b.x, b.y, b.z, b.r, 14 + Math.round(b.r * 900));
    this.pops++;
  }

  private removeBubble(b: Bubble) {
    const i = this.bubbles.indexOf(b);
    if (i >= 0) this.bubbles.splice(i, 1);
    this.atlas.setSlot(b.slot, 1e-3, false);
  }

  private bubbleAt(wx: number, wy: number) {
    let best: Bubble | null = null;
    for (const b of this.bubbles) {
      if (b.popping >= 0) continue;
      const s = CAM_F / (CAM_F + b.z);
      if (Math.hypot(b.x * s - wx, b.y * s - wy) < b.r * s && (!best || b.z < best.z)) best = b;
    }
    return best;
  }

  private pokeBubble(b: Bubble, wx: number, wy: number) {
    const s = CAM_F / (CAM_F + b.z);
    const qx = (wx / s - b.x) / b.r, qy = (wy / s - b.y) / b.r;
    const u = (b.slot % SLOT_COLS + 0.5 + 0.5 * DISC * qx) / SLOT_COLS;
    const v = (Math.floor(b.slot / SLOT_COLS) + 0.5 + 0.5 * DISC * qy) / SLOT_ROWS;
    this.atlas.poke(u, v, 2.5);
  }

  private stepBubbles(dt: number) {
    const t = this.time;
    const top = this.worldH / 2, bottom = -this.worldH / 2;
    for (const b of this.bubbles) {
      b.age += dt;
      const Vol = (4 / 3) * Math.PI * b.r ** 3;
      const mAir = 1.2 * Vol;
      const mFilm = RHO_WATER * b.mean * 1e-6 * 4 * Math.PI * b.r * b.r;
      // Warm breath inside lifts it; the film's weight pulls it down; air drag and slow drafts.
      const lift = mAir * G * (b.warm / 293) - mFilm * G;
      const wx = 0.012 * Math.sin(0.37 * t + b.y * 30) + 0.006 * Math.sin(0.9 * t + b.z * 20);
      const wy = 0.006 * Math.sin(0.5 * t + b.x * 25);
      // The breath is a jet out through the ring: it spreads and slows with distance, and carries
      // bubbles in it away into the room.
      const reach = 0.012 + 0.2 * b.z;
      const off = Math.hypot(b.x, b.y - this.wandY);
      const jet = this.blow > 0.03 && off < reach * 2 ? this.model.cfg.vMax * this.blow * (0.03 / (0.03 + b.z)) * Math.exp(-((off / reach) ** 2)) : 0;
      const rx = b.vx - wx, ry = b.vy - wy, rz = b.vz - jet;
      const sp = Math.hypot(rx, ry, rz);
      const dragK = (0.5 * 1.2 * 0.47 * Math.PI * b.r * b.r * sp) / (mAir * 1.5 + mFilm);
      const m = mAir * 1.5 + mFilm;
      b.vx += (-dragK * rx) * dt;
      b.vy += (lift / m - dragK * ry) * dt;
      b.vz += (-dragK * rz) * dt;
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      b.z = Math.max(b.r, Math.min(0.6, b.z + b.vz * dt));
      b.warm *= Math.exp(-dt / 5);
      // Shape wobble (an l = 2 mode), faster for smaller bubbles.
      b.phase += dt * 2 * Math.PI * 3.2 * Math.pow(0.02 / b.r, 1.5);
      b.wobble *= Math.exp(-dt * 1.6);
    }
    // Bubbles bump softly off one another.
    for (let i = 0; i < this.bubbles.length; i++)
      for (let j = i + 1; j < this.bubbles.length; j++) {
        const a = this.bubbles[i], c = this.bubbles[j];
        const dx = c.x - a.x, dy = c.y - a.y, dz = c.z - a.z;
        const d = Math.hypot(dx, dy, dz), rr = a.r + c.r;
        if (d < rr && d > 1e-6) {
          const push = ((rr - d) / d) * 0.5;
          a.x -= dx * push; a.y -= dy * push; a.z -= dz * push;
          c.x += dx * push; c.y += dy * push; c.z += dz * push;
          const rv = ((c.vx - a.vx) * dx + (c.vy - a.vy) * dy + (c.vz - a.vz) * dz) / d;
          if (rv < 0) {
            const imp = (-rv * 0.8) / 2;
            a.vx -= (imp * dx) / d; a.vy -= (imp * dy) / d; a.vz -= (imp * dz) / d;
            c.vx += (imp * dx) / d; c.vy += (imp * dy) / d; c.vz += (imp * dz) / d;
            a.wobble = Math.max(a.wobble, 0.06);
            c.wobble = Math.max(c.wobble, 0.06);
          }
        }
      }
    for (const b of this.bubbles.slice()) {
      if (b.popping >= 0) continue;
      const s = CAM_F / (CAM_F + b.z);
      const sx = b.x * s, sy = b.y * s, sr = b.r * s;
      // Drifting out of view: gone quietly. Touching the side walls: pop.
      if (sy - sr > top || sy + sr < bottom) this.removeBubble(b);
      else if (Math.abs(sx) + sr * 0.85 > this.halfW) this.pokeBubble(b, Math.sign(sx) * this.halfW, sy);
      else if (sy - sr * 0.8 < bottom) this.pokeBubble(b, sx, bottom);
    }
  }

  private spray(x: number, y: number, z: number, r: number, n: number) {
    for (let i = 0; i < n && this.drops.length < 500; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 0.15 + Math.random() * 0.5;
      const life = 0.35 + Math.random() * 0.45;
      this.drops.push({ x: x + Math.cos(a) * r, y: y + Math.sin(a) * r, z, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: (Math.random() - 0.5) * 0.2, life, max: life });
    }
  }

  private stepDrops(dt: number) {
    let n = 0;
    for (const d of this.drops) {
      d.life -= dt;
      if (d.life <= 0) continue;
      d.vy -= G * 0.25 * dt;
      d.vx *= 1 - dt * 3;
      d.vy *= 1 - dt * 1.5;
      d.x += d.vx * dt;
      d.y += d.vy * dt;
      d.z += d.vz * dt;
      this.drops[n++] = d;
    }
    this.drops.length = n;
  }

  /** A popping soap film: a short noise crack with a Helmholtz-like ring set by the size of what burst. */
  private popSound(r: number, pan: number, gain: number) {
    const f = (0.9 * 343) / (2 * Math.PI * r);
    this.ctx.sound.modes(
      [
        { freq: f, amp: 1, decay: 0.04 },
        { freq: f * 1.83, amp: 0.45, decay: 0.022 },
        { freq: f * 2.95, amp: 0.2, decay: 0.012 },
      ],
      { gain: Math.min(1, (0.3 + r * 14) * gain), pan, strike: 0.9 },
    );
  }

  private feel() {
    const m = this.model;
    if (this.present && this.blow > 0.05 && this.popping < 0) {
      // The bulge pushing back: its Laplace pressure (which peaks at the hemisphere) against the breath.
      const load = Math.min(1, m.laplace() / (4 * SIGMA / A)) * 0.6 + Math.min(0.4, this.blow * 0.4);
      this.ctx.hapticLevel(load, m.bubble ? 0.2 : 0.4);
    }
    // A faint wet creak while the finger drags the film.
    const s = this.present ? Math.min(1, this.stirSpeed / 0.4) : 0;
    this.creak.set(s * 0.25, 30 + s * 90, 1100 + s * 600);
  }

  private draw() {
    const m = this.model;
    const draws: BubbleDraw[] = (this.skip.bubbles ? [] : this.bubbles).map((b) => ({ x: b.x, y: b.y, z: b.z, r: b.r, slot: b.slot, wobble: b.wobble * Math.sin(b.phase), axis: b.axis, attached: false, popping: b.popping >= 0 }));
    const [cx, cy] = this.wandC;
    const inflating = this.present && m.bubble;
    if (inflating) {
      const R = m.sphereRadius();
      draws.push({ x: cx, y: cy, z: Math.sqrt(Math.max(0, R * R - A * A)) + m.neck, r: R, slot: -1, wobble: 0, axis: 0, attached: true, popping: this.popping >= 0 });
    }
    let n = 0;
    for (const d of this.drops) this.dropData.set([d.x, d.y, d.z, d.life / d.max], 4 * n++);
    this.scene.render(
      {
        pxPerM: this.pxPerM,
        camF: CAM_F,
        time: this.time,
        wandC: [cx, cy],
        wandR: A,
        bulge: m.shown,
        filmOn: this.present && !inflating,
        popping: this.popping >= 0,
        bowl: [0, this.bathY, 0.037, 0.0075],
        ripple: this.ripple,
        bubbles: draws,
        drops: this.dropData,
        dropCount: n,
        wandTex: this.wand.film.read.tex,
        atlasTex: this.atlas.film.read.tex,
        slots: [SLOT_COLS, SLOT_ROWS],
      },
      this.width,
      this.height,
    );
  }

  private status() {
    if (this.frameNo % 15) return;
    const st = this.wand.stats[0];
    const film = this.present ? `film ${st.mean.toFixed(2)} µm · thinnest ${(st.min * 1000).toFixed(0)} nm` : 'no film · tap the bowl';
    this.ctx.setStatus(`${film} · ${this.bubbles.length} bubbles`);
  }

  private devHook() {
    return {
      stats: () => ({
        present: this.present,
        popping: this.popping,
        dip: this.dip,
        reservoir: this.reservoir,
        film: { ...this.wand.stats[0] },
        blow: this.blow,
        model: { volume: this.model.volume, neck: this.model.neck, pressure: this.model.pressure, bubble: this.model.bubble, shown: this.model.shown, threshold: this.model.threshold },
        bubbles: this.bubbles.map((b) => ({ r: b.r, x: b.x, y: b.y, z: b.z, slot: b.slot, popping: b.popping, mean: b.mean, age: b.age })),
        pinches: this.pinches.slice(),
        pops: this.pops,
        jsMs: this.jsMs,
        jsWorst: this.jsWorst,
      }),
      setBlow: (v: number | null) => (this.devBlow = v),
      dip: () => this.startDip(-1),
      stir: (u: number, v: number, fx: number, fy: number) => this.wand.splat(u, v, fx, fy, 0.0025),
      popWand: () => this.wand.poke(0.5, 0.8, 1.5),
      cfg: this.cfg,
      override: (o: Partial<FilmParams>) => (this.override = o),
      skip: this.skip,
      fresh: (h: number) => this.freshFilm(h),
    };
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.layout();
  }

  destroy() {
    this.hiss.stop();
    this.creak.stop();
    this.wand.destroy();
    this.atlas.destroy();
    this.scene.destroy();
    this.hint.remove();
    this.blowBtn.remove();
    this.style.remove();
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__bubble;
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

/** Film thickness (µm) left on a ring pulled out of the bath at U m/s: Frankel's h ∝ U^(2/3). */
function frankelDip(U: number) {
  return Math.max(0.2, Math.min(BATH_H - 0.2, 1.4 * Math.pow(U / 0.1, 2 / 3)));
}

const STYLE = `
.bw-hint { position: absolute; left: 50%; bottom: calc(86px + env(safe-area-inset-bottom, 0px)); transform: translateX(-50%); padding: 8px 14px; border-radius: 12px; background: rgba(8,10,18,0.6); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.1); color: #e6e9f2; font: 700 13px/1.2 ui-rounded, -apple-system, system-ui, sans-serif; white-space: nowrap; pointer-events: none; transition: opacity .8s; }
.bw-hint.gone { opacity: 0; }
.bw-blow { position: absolute; z-index: 3; right: calc(14px + env(safe-area-inset-right, 0px)); bottom: calc(18px + env(safe-area-inset-bottom, 0px)); display: flex; align-items: center; gap: 6px; height: 46px; padding: 0 18px; border-radius: 99px; border: 1px solid rgba(255,255,255,0.16); background: rgba(22,26,40,0.78); -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); color: #e6e9f2; font: 700 15px/1 ui-rounded, -apple-system, system-ui, sans-serif; touch-action: none; user-select: none; -webkit-user-select: none; overflow: hidden; cursor: pointer; }
.bw-blow svg { width: 20px; height: 20px; }
.bw-blow i { position: absolute; left: 0; bottom: 0; height: 3px; width: 100%; background: linear-gradient(90deg,#9fe8ff,#ff9fd0); transform-origin: left; transform: scaleX(0); }
.bw-blow.on { background: rgba(60,70,110,0.9); }
`;
