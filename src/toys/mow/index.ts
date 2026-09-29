import type { Loop } from '../../shell/sound';
import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { Program, compile } from '../../shell/gl';
import { LX, LZ, Lawn, TH, TW, makeLayout, rng, type Layout } from './lawn';
import { MeshBuilder, cross, lookAt, multiply, perspective, placeY, type Mesh, type V3 } from './mesh';
import * as S from './shaders';

export const mowToy: Toy = {
  id: 'mow',
  title: 'Mow Lines',
  blurb: 'Push a mower up and down a shaggy lawn and leave crisp light and dark stripes. Mind the flowers, the stone and the sleeping cat.',
  tech: 'Shell-textured grass + cut map · WebGL2',
  swatch: 'linear-gradient(140deg,#8be04e,#2f9e3a 50%,#1b5e20)',
  refs: [
    {
      short: 'Lengyel 2001',
      title: 'Lengyel, Praun, Finkelstein & Hoppe — Real-Time Fur over Arbitrary Surfaces (I3D 2001)',
      url: 'https://hhoppe.com/proj/fur/',
      use: 'Concentric shells: the lawn is the same quad drawn 16 times at rising heights.',
    },
    {
      short: 'Acerola',
      title: 'Acerola — How Do Games Render Fur? (2023)',
      url: 'https://www.youtube.com/watch?v=9dr-tRQzij4',
      use: 'The modern recipe: hashed blade cells, a taper test per shell, discard instead of blending, fake AO by height.',
    },
    {
      short: 'Ilett grass',
      title: 'Daniel Ilett — Six Grass Rendering Techniques in Unity',
      url: 'https://danielilett.com/2022-12-05-tut6-2-six-grass-techniques/',
      use: 'A grass map where the value is the blade length: mowing is just writing into it.',
    },
    {
      short: 'Grass Master',
      title: 'Grass Master – Cutting Game (SayGames, 2026) — design reference',
      url: 'https://apps.apple.com/us/app/grass-master-cutting-game/id6763011499',
      use: 'Mowing as a one-verb ASMR chore with a visible reveal.',
    },
  ],
  async create(ctx) {
    return new MowLines(ctx);
  },
};

/** Deck (cutting) radius and full grass height, world units (the lawn is 1 wide). */
const DECK = 0.075;
const GRASS_H = 0.034;
const MAX_SPEED = 1.5;
/** The deck rides a little above the finger so the finger never hides it. */
const FINGER_LIFT = 0.03;
/** Length removed per second that counts as full load (fresh grass at a brisk walk). */
const FULL_LOAD = 0.15 * 0.6 * TW * TW * 160;
const MAX_PARTS = 360;
const SUN: V3 = [-0.45, 0.8, 0.4];
const DONE_AT = 0.98;
const GRID_X = 24;
const GRID_Z = 38;

type CatState = 'sleep' | 'run';

class MowLines implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private p: Record<string, Program>;
  private lawnVao: WebGLVertexArrayObject;
  private groundVao: WebGLVertexArrayObject;
  private triVao: WebGLVertexArrayObject;
  private partVao: WebGLVertexArrayObject;
  private partBuf: WebGLBuffer;
  private lenTex: WebGLTexture;
  private leanTex: WebGLTexture;
  private kindTex: WebGLTexture;
  private scene: { fbo: WebGLFramebuffer; tex: WebGLTexture; depth: WebGLRenderbuffer; w: number; h: number } | null = null;
  private meshes: Record<'mower' | 'stone' | 'catSleep' | 'catRun' | 'leaves' | 'flowers', Mesh>;
  private width = 1;
  private height = 1;

  private lawn = new Lawn();
  private layout!: Layout;
  private seed = 1;

  // Camera
  private fov = (36 * Math.PI) / 180;
  private eye: V3 = [0, 2, 2];
  private target: V3 = [0, 0, 0];
  private view = new Float32Array(16);
  private proj = new Float32Array(16);
  private viewProj = new Float32Array(16);
  private model = new Float32Array(16);
  private yaw = 0;
  private basis = { f: [0, 0, -1] as V3, r: [1, 0, 0] as V3, u: [0, 1, 0] as V3 };

  // Mower
  private mx = 0;
  private mz = 0.5;
  private vx = 0;
  private vz = 0;
  private heading = -Math.PI / 2;
  private running = false;
  private idle = 0;
  private stall = 0;
  /** No re-stall while the finger keeps pushing into the stone. */
  private stallCool = 0;
  private load = 0;
  private cutRate = 0;
  private pointerId: number | null = null;

  // Cat
  private cat = { x: 0, z: 0, heading: 0, state: 'sleep' as CatState, tx: 0, tz: 0, t: 0, moves: 0 };

  // Clippings: xyz + size, rgb + shape, and CPU-only velocity / life.
  private parts = new Float32Array(MAX_PARTS * 8);
  private partVel = new Float32Array(MAX_PARTS * 3);
  private partLife = new Float32Array(MAX_PARTS);
  private partNext = 0;
  private partCount = 0;
  private spawnAcc = 0;
  private tickAcc = 0;
  private hapticClock = 0;
  private regrowClock = 0;

  private flowersHit = 0;
  private stalls = 0;
  private celebrated = false;
  private celebrateMsg = '';
  private time = 0;
  private shells = 16;
  private autoShells = true;
  private slowFrames = 0;
  private frames = 0;

  private motor: Loop;
  private spray: Loop;
  private style: HTMLStyleElement;
  private chip: HTMLElement;
  private newBtn: HTMLButtonElement;
  private zzz: HTMLElement;

  readonly cfg = { cutHeight: 0.25, wind: 1, regrow: false };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.motor = ctx.sound.loop('rumble');
    this.spray = ctx.sound.loop('hiss');

    const v = (src: string) => compile(gl, gl.VERTEX_SHADER, src);
    this.p = {
      shell: new Program(gl, v(S.shellVert), S.shellFrag),
      ground: new Program(gl, v(S.groundVert), S.groundFrag),
      mesh: new Program(gl, v(S.meshVert), S.meshFrag),
      part: new Program(gl, v(S.partVert), S.partFrag),
      composite: new Program(gl, v(S.compositeVert), S.compositeFrag),
    };

    const quad = (data: number[]) => {
      const vao = gl.createVertexArray()!;
      gl.bindVertexArray(vao);
      const b = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, b);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(data), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      return vao;
    };
    // Lawn grid (triangles) so wind can be evaluated per vertex.
    const grid: number[] = [];
    for (let j = 0; j < GRID_Z; j++) {
      for (let i = 0; i < GRID_X; i++) {
        const u0 = i / GRID_X, u1 = (i + 1) / GRID_X, v0 = j / GRID_Z, v1 = (j + 1) / GRID_Z;
        grid.push(u0, v0, u1, v0, u1, v1, u0, v0, u1, v1, u0, v1);
      }
    }
    this.lawnVao = quad(grid);
    this.groundVao = quad([-1, -1, 1, -1, -1, 1, 1, 1]);
    this.triVao = quad([-1, -1, 3, -1, -1, 3]);
    this.partVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.partVao);
    this.partBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.parts.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    gl.bindVertexArray(null);

    const tex = (fmt: number, base: number, filter: number) => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, fmt, TW, TH, 0, base, gl.UNSIGNED_BYTE, null);
      return t;
    };
    this.lenTex = tex(gl.R8, gl.RED, gl.LINEAR);
    this.leanTex = tex(gl.RG8, gl.RG, gl.LINEAR);
    this.kindTex = tex(gl.R8, gl.RED, gl.LINEAR);

    const empty = new MeshBuilder();
    this.meshes = {
      mower: buildMower().upload(gl),
      stone: empty.upload(gl),
      catSleep: buildCat(false).upload(gl),
      catRun: buildCat(true).upload(gl),
      leaves: empty.upload(gl),
      flowers: empty.upload(gl),
    };

    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.chip = document.createElement('div');
    this.chip.className = 'mow-chip';
    this.newBtn = document.createElement('button');
    this.newBtn.type = 'button';
    this.newBtn.className = 'mow-new';
    this.newBtn.textContent = 'New lawn ›';
    this.newBtn.hidden = true;
    this.newBtn.addEventListener('click', () => this.newLawn());
    this.zzz = document.createElement('div');
    this.zzz.className = 'mow-zzz';
    this.zzz.innerHTML = '<i>z</i><i>z</i><i>z</i>';
    ctx.overlay.append(this.chip, this.newBtn, this.zzz);
    this.buildPanel();

    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.allocate();
    this.newLawn();

    if (import.meta.env.DEV) {
      // Dev-only probes for headless tests.
      const w = window as unknown as Record<string, unknown>;
      w.__mow = () => ({
        mown: this.lawn.cutTexels / this.lawn.lawnTexels,
        cut: this.lawn.cutTexels,
        lawn: this.lawn.lawnTexels,
        flowersHit: this.flowersHit,
        stalls: this.stalls,
        catMoves: this.cat.moves,
        catState: this.cat.state,
        shells: this.shells,
        celebrated: this.celebrated && this.celebrateMsg,
        load: this.load,
        parts: this.partCount,
        mower: [this.mx, this.mz],
        running: this.running,
      });
      w.__mowLayout = () => ({ ...this.layout, cat: { x: this.cat.x, z: this.cat.z }, lawn: [LX, LZ], deck: DECK });
      // World (x, z) on the ground to CSS pixels, where the finger should go for the deck to land there.
      w.__mowScreen = (x: number, z: number) => {
        const [nx, ny] = this.project(x, 0, z);
        const r = ctx.canvas.getBoundingClientRect();
        return [r.left + (nx * 0.5 + 0.5) * r.width, r.top + (1 - (ny * 0.5 + 0.5 - FINGER_LIFT)) * r.height];
      };
      w.__mowSeed = (s: number) => this.newLawn(s);
      // Mow the whole lawn in alternating stripes (flower beds untouched).
      w.__mowStripes = () => {
        for (let k = 0, x = -LX / 2; x <= LX / 2 + DECK; x += DECK * 2, k++) {
          const d = k % 2 ? 1 : -1;
          this.lawn.stamp(x, -LZ / 2 * d, x, (LZ / 2) * d, DECK, 0, d, true);
        }
      };
      // GPU cost of one full scene render (ms), averaged over n back-to-back renders.
      w.__mowBench = (n = 60) => {
        // A 1-pixel readback is the only reliable sync point (finish() is async in Chrome).
        const px = new Uint8Array(4);
        const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        this.render();
        sync();
        const t0 = performance.now();
        for (let i = 0; i < n; i++) this.render();
        sync();
        return (performance.now() - t0) / n;
      };
      // Centres of the remaining uncut lawn, bucketed on a coarse grid, for tests to mop up.
      w.__mowUncut = (cell = 16) => {
        const out: [number, number, number][] = [];
        const l = this.lawn;
        for (let j0 = 0; j0 < TH; j0 += cell) {
          for (let i0 = 0; i0 < TW; i0 += cell) {
            let n = 0, sx = 0, sz = 0;
            for (let j = j0; j < Math.min(TH, j0 + cell); j++) {
              for (let i = i0; i < Math.min(TW, i0 + cell); i++) {
                const k = j * TW + i;
                if (l.kind[k] !== 0 || l.len[k] <= l.threshold) continue;
                n++;
                sx += i;
                sz += j;
              }
            }
            if (n) out.push([((sx / n + 0.5) / TW - 0.5) * LX, ((sz / n + 0.5) / TH - 0.5) * LZ, n]);
          }
        }
        return out;
      };
    }
  }

  // ---------------------------------------------------------------- setup

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.slider(c, 'cutHeight', {
      label: 'Cut height',
      min: 0.12,
      max: 0.5,
      step: 0.01,
      onChange: () => {
        this.lawn.cutLevel = Math.round(c.cutHeight * 255);
        this.lawn.recount();
      },
    });
    panel.slider(c, 'wind', { label: 'Wind', min: 0, max: 2.5, step: 0.05 });
    panel.toggleSwitch(c, 'regrow', 'Regrowth');
    panel.choice(
      'Grass shells',
      [
        { value: 'auto', label: 'Auto' },
        { value: '8', label: '8' },
        { value: '12', label: '12' },
        { value: '16', label: '16' },
      ],
      'auto',
      (v) => {
        this.autoShells = v === 'auto';
        this.shells = v === 'auto' ? 16 : Number(v);
      },
    );
    panel.action('New lawn', () => this.newLawn());
  }

  private newLawn(seed = Math.floor(Math.random() * 1e9)) {
    this.seed = seed;
    this.layout = makeLayout(seed);
    this.lawn.cutLevel = Math.round(this.cfg.cutHeight * 255);
    this.lawn.reset(this.layout, seed);
    const k = this.lawn.kind;
    const gl = this.gl;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.kindTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TW, TH, gl.RED, gl.UNSIGNED_BYTE, k);
    this.upload();
    const lc = this.layout.cat;
    Object.assign(this.cat, { x: lc.x, z: lc.z, heading: lc.heading, state: 'sleep', tx: lc.x, tz: lc.z, moves: 0 });
    this.park();
    this.vx = this.vz = 0;
    this.flowersHit = 0;
    this.stalls = 0;
    this.celebrated = false;
    this.partCount = 0;
    this.partLife.fill(0);
    this.newBtn.hidden = true;
    this.buildStatics();
    this.updateChip();
    this.ctx.progress(0, 'mown');
  }

  /** Park the mower on the lawn edge nearest the camera, facing up the lawn. */
  private park() {
    if (this.yaw) {
      this.mx = LX / 2 - DECK * 0.6;
      this.mz = 0;
      this.heading = Math.PI;
    } else {
      this.mx = 0;
      this.mz = LZ / 2 - DECK * 0.6;
      this.heading = -Math.PI / 2;
    }
  }

  private buildStatics() {
    const gl = this.gl;
    const rand = rng(this.seed ^ 0x5bd1e995);
    const st = this.layout.stone;
    const stone = new MeshBuilder();
    stone.ellipsoid([st.x, 0.006, st.z], [st.r * 1.15, st.r * 0.75, st.r], [0.55, 0.54, 0.52], 11, 6, 0.35, rand);
    stone.ellipsoid([st.x + st.r * 0.5, 0.004, st.z + st.r * 0.6], [st.r * 0.4, st.r * 0.3, st.r * 0.35], [0.5, 0.49, 0.47], 7, 4, 0.4, rand);
    this.meshes.stone = stone.upload(gl, this.meshes.stone);
    const leaves = new MeshBuilder();
    for (const b of this.layout.beds) {
      const n = Math.round(b.r * 120);
      for (let i = 0; i < n; i++) {
        const a = rand() * Math.PI * 2, d = Math.sqrt(rand()) * (b.r - 0.015);
        const g = 0.7 + rand() * 0.4;
        leaves.ellipsoid([b.x + Math.cos(a) * d, 0.004, b.z + Math.sin(a) * d], [0.014, 0.008, 0.012], [0.16 * g, 0.42 * g, 0.12 * g], 6, 3, 0.3, rand);
      }
      // Low border stones around the bed.
      const m = Math.round(b.r * 90);
      for (let i = 0; i < m; i++) {
        const a = (i / m) * Math.PI * 2;
        const s = 0.6 + rand() * 0.2;
        leaves.ellipsoid([b.x + Math.cos(a) * b.r, 0.002, b.z + Math.sin(a) * b.r], [0.011, 0.008, 0.011], [s, s * 0.97, s * 0.92], 6, 3, 0.3, rand);
      }
    }
    this.meshes.leaves = leaves.upload(gl, this.meshes.leaves);
    this.buildFlowers();
  }

  private buildFlowers() {
    const m = new MeshBuilder();
    for (const f of this.layout.flowers) {
      const stem: V3 = [0.2, 0.5, 0.16];
      if (!f.alive) {
        m.cyl([f.x, 0, f.z], [f.x, 0.012, f.z], 0.002, 0.002, 4, stem, false);
        continue;
      }
      m.cyl([f.x, 0, f.z], [f.x, f.h, f.z], 0.0018, 0.0018, 4, stem, false);
      m.ellipsoid([f.x, f.h, f.z], [0.011, 0.005, 0.011], f.color, 7, 3);
      m.ellipsoid([f.x, f.h + 0.003, f.z], [0.004, 0.003, 0.004], [1, 0.8, 0.2], 5, 2);
    }
    this.meshes.flowers = m.upload(this.gl, this.meshes.flowers);
  }

  private allocate() {
    const gl = this.gl;
    if (this.scene) {
      gl.deleteFramebuffer(this.scene.fbo);
      gl.deleteTexture(this.scene.tex);
      gl.deleteRenderbuffer(this.scene.depth);
    }
    // Render the lawn at about DPR 1.5 at most: blades are sub-pixel detail anyway.
    const scale = Math.min(1, 1.5 / Math.max(1, this.ctx.pixelRatio));
    const w = Math.max(1, Math.round(this.width * scale));
    const h = Math.max(1, Math.round(this.height * scale));
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, w, h);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    this.scene = { fbo, tex, depth, w, h };
    this.fitCamera();
  }

  /**
   * Pick a 3/4 camera that fits the whole lawn between the top HUD and the bottom chip. On a
   * landscape screen the camera swings round 90° so the lawn's long side runs across it.
   */
  private fitCamera() {
    const aspect = this.width / this.height;
    const wide = aspect >= 1;
    this.yaw = wide ? Math.PI / 2 : 0;
    const pitch = wide ? 0.95 : 1.08;
    const yTop = wide ? 0.48 : 0.74;
    const yBot = wide ? -0.66 : -0.8;
    const xMax = wide ? 0.9 : 0.96;
    let s = 0;
    for (let dist = 0.6; dist < 12; dist *= 1.02) {
      let lo = 0, hi = 0, wx = 0;
      for (let it = 0; it < 8; it++) {
        this.setCamera(dist, pitch, s, aspect);
        lo = Infinity;
        hi = -Infinity;
        wx = 0;
        for (const [cx, cz] of CORNERS) {
          const [px, py] = this.project(cx * LX, 0, cz * LZ);
          lo = Math.min(lo, py);
          hi = Math.max(hi, py);
          wx = Math.max(wx, Math.abs(px));
        }
        s += ((lo + hi) / 2 - (yTop + yBot) / 2) * dist * 0.25;
      }
      if (wx <= xMax && lo >= yBot && hi <= yTop) break;
    }
  }

  /** Orbit camera: `s` slides the look-at point along the ground-forward direction. */
  private setCamera(dist: number, pitch: number, s: number, aspect: number) {
    const sy = Math.sin(this.yaw), cy = Math.cos(this.yaw);
    const cp = Math.cos(pitch), sp = Math.sin(pitch);
    this.target = [-sy * s, 0, -cy * s];
    this.eye = [this.target[0] + sy * cp * dist, sp * dist, this.target[2] + cy * cp * dist];
    lookAt(this.view, this.eye, this.target, [0, 1, 0]);
    perspective(this.proj, this.fov, aspect, 0.05, 20);
    multiply(this.viewProj, this.proj, this.view);
    const f: V3 = [-sy * cp, -sp, -cy * cp];
    const r: V3 = [cy, 0, -sy];
    this.basis = { f, r, u: cross(r, f) };
  }

  private project(x: number, y: number, z: number): [number, number] {
    const m = this.viewProj;
    const w = m[3] * x + m[7] * y + m[11] * z + m[15];
    return [(m[0] * x + m[4] * y + m[8] * z + m[12]) / w, (m[1] * x + m[5] * y + m[9] * z + m[13]) / w];
  }

  /** Canvas UV (y up) to the ground plane. */
  private ground(u: number, v: number): [number, number] {
    const t = Math.tan(this.fov / 2);
    const nx = (u * 2 - 1) * t * (this.width / this.height), ny = (v * 2 - 1) * t;
    const { f, r, u: up } = this.basis;
    const dx = f[0] + r[0] * nx + up[0] * ny, dy = f[1] + r[1] * nx + up[1] * ny, dz = f[2] + r[2] * nx + up[2] * ny;
    const k = dy < -1e-4 ? -this.eye[1] / dy : 50;
    return [this.eye[0] + dx * k, this.eye[2] + dz * k];
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.frames++;
    const ox = this.mx, oz = this.mz;
    this.drive(dt);
    let removed = 0;
    const speed = Math.hypot(this.vx, this.vz);
    if (this.running && this.stall <= 0) {
      const moving = speed > 0.08;
      removed = this.lawn.stamp(ox, oz, this.mx, this.mz, DECK, moving ? this.vx / speed : 0, moving ? this.vz / speed : 0, moving);
      this.cutFlowers();
    }
    this.cutRate += (removed / Math.max(dt, 1e-3) - this.cutRate) * Math.min(1, dt * 12);
    this.load = Math.min(1.5, this.cutRate / FULL_LOAD);
    this.updateCat(dt);
    if (this.cfg.regrow) {
      this.regrowClock += dt;
      if (this.regrowClock > 1.5) {
        this.regrowClock = 0;
        this.lawn.regrow(1);
      }
    }
    this.upload();
    this.emit(dt);
    this.stepParts(dt);
    this.feel(dt);
    this.adapt(dt);

    const mown = this.lawn.cutTexels / this.lawn.lawnTexels;
    this.ctx.progress(Math.min(1, mown / DONE_AT), 'mown');
    if (!this.celebrated && mown >= DONE_AT) {
      this.celebrated = true;
      this.celebrateMsg = this.flowersHit ? 'Mown!' : 'Perfect stripes!';
      this.ctx.celebrate(this.celebrateMsg);
      this.updateChip();
      setTimeout(() => (this.newBtn.hidden = !this.celebrated), 900);
    }
    this.render();
    this.placeZzz();
    this.ctx.setStatus(`${Math.round(mown * 100)}% mown · ${this.shells} shells`);
  }

  /** The deck chases the finger (speed-capped), bumps off the stone and cat, stays on the lawn. */
  private drive(dt: number) {
    let ptr = this.pointerId !== null ? this.ctx.pointers.active.get(this.pointerId) : undefined;
    if (!ptr) {
      this.pointerId = null;
      for (const q of this.ctx.pointers.active.values()) {
        if (q.justDown) {
          ptr = q;
          this.pointerId = q.id;
          break;
        }
      }
    }
    if (ptr?.justDown && !this.running) {
      // Pull-start.
      this.running = true;
      this.ctx.sound.play('whoosh', { pitch: 0.55, gain: 0.5 });
      this.ctx.sound.play('thud', { pitch: 0.7, gain: 0.4 });
      this.ctx.haptic('light');
    }
    if (ptr) this.idle = 0;
    else this.idle += dt;
    if (this.idle > 4 && this.running) this.running = false;

    this.stallCool -= dt;
    if (this.stall > 0) {
      this.stall -= dt;
      this.vx *= Math.exp(-dt * 20);
      this.vz *= Math.exp(-dt * 20);
    } else if (ptr) {
      let [tx, tz] = this.ground(ptr.x, ptr.y + FINGER_LIFT);
      tx = clamp(tx, -LX / 2, LX / 2);
      tz = clamp(tz, -LZ / 2, LZ / 2);
      let wx = (tx - this.mx) * 18, wz = (tz - this.mz) * 18;
      const w = Math.hypot(wx, wz);
      if (w > MAX_SPEED) {
        wx *= MAX_SPEED / w;
        wz *= MAX_SPEED / w;
      }
      const k = Math.min(1, dt * 22);
      this.vx += (wx - this.vx) * k;
      this.vz += (wz - this.vz) * k;
    } else {
      this.vx *= Math.exp(-dt * 12);
      this.vz *= Math.exp(-dt * 12);
    }
    this.mx += this.vx * dt;
    this.mz += this.vz * dt;

    // Stone: a hard stop, a clank and a stalled motor.
    const st = this.layout.stone;
    let dx = this.mx - st.x, dz = this.mz - st.z;
    let d = Math.hypot(dx, dz);
    const minD = st.r * 1.1 + DECK * 0.98;
    if (d < minD) {
      const nx = dx / (d || 1), nz = dz / (d || 1);
      const into = -(this.vx * nx + this.vz * nz);
      this.mx = st.x + nx * minD;
      this.mz = st.z + nz * minD;
      if (into > 0) {
        this.vx += into * nx * 1.3;
        this.vz += into * nz * 1.3;
      }
      if (into > 0.3 && this.stall <= 0 && this.stallCool <= 0 && this.running) {
        this.stall = 0.45;
        this.stallCool = 1.2;
        this.stalls++;
        const pan = this.pan();
        this.ctx.sound.play('knock', { pitch: 1.5 + Math.random() * 0.3, gain: Math.min(1, 0.5 + into * 0.4), pan });
        this.ctx.sound.play('knock', { pitch: 0.7, gain: 0.5, pan });
        this.ctx.haptic('medium');
        for (let i = 0; i < 10; i++) this.spawn(st.x - nx * st.r, 0.02, st.z - nz * st.r, (Math.random() - 0.5) * 0.8, 0.5 + Math.random() * 0.5, (Math.random() - 0.5) * 0.8, 0.85, 0.85, 0.8, 0.005);
      }
    }
    // Cat: it should have fled already, but never drive through it.
    dx = this.mx - this.cat.x;
    dz = this.mz - this.cat.z;
    d = Math.hypot(dx, dz);
    if (d < 0.05 + DECK * 0.8) {
      const s = (0.05 + DECK * 0.8) / (d || 1);
      this.mx = this.cat.x + dx * s;
      this.mz = this.cat.z + dz * s;
    }
    this.mx = clamp(this.mx, -LX / 2, LX / 2);
    this.mz = clamp(this.mz, -LZ / 2, LZ / 2);

    const speed = Math.hypot(this.vx, this.vz);
    if (speed > 0.08) {
      // Turn toward the direction of travel at a limited rate: a quick whip-turn at the lawn's end.
      const want = Math.atan2(this.vz, this.vx);
      let da = want - this.heading;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      const maxTurn = 11 * dt;
      this.heading += clamp(da, -maxTurn, maxTurn);
    }
  }

  private cutFlowers() {
    let changed = false;
    for (const f of this.layout.flowers) {
      // The blade is a little smaller than the housing, so skirting a bed closely is fair.
      if (!f.alive || Math.hypot(f.x - this.mx, f.z - this.mz) > DECK * 0.8) continue;
      f.alive = false;
      changed = true;
      this.flowersHit++;
      for (let i = 0; i < 9; i++) {
        const a = Math.random() * Math.PI * 2;
        this.spawn(f.x, f.h, f.z, Math.cos(a) * 0.4, 0.4 + Math.random() * 0.5, Math.sin(a) * 0.4, f.color[0], f.color[1], f.color[2], 0.008);
      }
    }
    if (changed) {
      this.buildFlowers();
      this.updateChip();
      const pan = this.pan();
      this.ctx.sound.play('snap', { pitch: 1.6, gain: 0.5, pan });
      this.ctx.sound.play('pop', { pitch: 1.3, gain: 0.4, pan });
      this.ctx.haptic('medium');
    }
  }

  private updateCat(dt: number) {
    const c = this.cat;
    c.t += dt;
    const d = Math.hypot(c.x - this.mx, c.z - this.mz);
    if (c.state === 'sleep') {
      if (this.running && d < 0.24) {
        // Startled awake: find a quiet spot, preferably already mown, far from the mower.
        const rand = Math.random;
        let best = -1;
        for (let k = 0; k < 30; k++) {
          const x = (rand() - 0.5) * (LX - 0.16), z = (rand() - 0.5) * (LZ - 0.16);
          const clear = this.layout.beds.every((b) => Math.hypot(x - b.x, z - b.z) > b.r + 0.07) && Math.hypot(x - this.layout.stone.x, z - this.layout.stone.z) > 0.13;
          if (!clear) continue;
          const score = Math.hypot(x - this.mx, z - this.mz) + (this.lawn.lengthAt(x, z) <= this.lawn.threshold ? 0.5 : 0);
          if (score > best) {
            best = score;
            c.tx = x;
            c.tz = z;
          }
        }
        if (best < 0) return;
        c.state = 'run';
        c.t = 0;
        c.moves++;
        const pan = this.pan(c.x, c.z);
        this.ctx.sound.play('boing', { pitch: 1.9, gain: 0.35, pan });
        this.ctx.sound.play('whoosh', { pitch: 1.4, gain: 0.3, pan });
        this.ctx.haptic('light');
      }
      return;
    }
    const dx = c.tx - c.x, dz = c.tz - c.z;
    const dd = Math.hypot(dx, dz);
    if (dd < 0.01) {
      c.state = 'sleep';
      this.ctx.sound.play('thud', { pitch: 1.6, gain: 0.25, pan: this.pan(c.x, c.z) });
      return;
    }
    const sp = Math.min(dd * 6, 0.75) * dt;
    c.x += (dx / dd) * sp;
    c.z += (dz / dd) * sp;
    let da = Math.atan2(dz, dx) - c.heading;
    da = Math.atan2(Math.sin(da), Math.cos(da));
    c.heading += clamp(da, -12 * dt, 12 * dt);
  }

  private upload() {
    const l = this.lawn;
    if (l.dx0 >= l.dx1 || l.dy0 >= l.dy1) return;
    const gl = this.gl;
    const w = l.dx1 - l.dx0, h = l.dy1 - l.dy0;
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, TW);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, l.dx0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, l.dy0);
    gl.bindTexture(gl.TEXTURE_2D, this.lenTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, l.dx0, l.dy0, w, h, gl.RED, gl.UNSIGNED_BYTE, l.len);
    gl.bindTexture(gl.TEXTURE_2D, this.leanTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, l.dx0, l.dy0, w, h, gl.RG, gl.UNSIGNED_BYTE, l.lean);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
    l.clearDirty();
  }

  // ---------------------------------------------------------------- clippings

  private spawn(x: number, y: number, z: number, vx: number, vy: number, vz: number, r: number, g: number, b: number, size: number) {
    const i = this.partNext;
    this.partNext = (i + 1) % MAX_PARTS;
    const o = i * 8;
    this.parts[o] = x;
    this.parts[o + 1] = y;
    this.parts[o + 2] = z;
    this.parts[o + 3] = size * (0.7 + Math.random() * 0.6);
    this.parts[i * 8 + 4] = r;
    this.parts[i * 8 + 5] = g;
    this.parts[i * 8 + 6] = b;
    this.parts[i * 8 + 7] = Math.random();
    this.partVel[i * 3] = vx;
    this.partVel[i * 3 + 1] = vy;
    this.partVel[i * 3 + 2] = vz;
    this.partLife[i] = 2 + Math.random();
  }

  /** Clippings fly out of the side chute at a rate that follows the cut rate. */
  private emit(dt: number) {
    if (this.stall > 0) return;
    this.spawnAcc += Math.min(1.2, this.load) * 330 * dt;
    const c = Math.cos(this.heading), s = Math.sin(this.heading);
    // Right-hand side of the deck, where the chute is.
    const rx = -s, rz = c;
    while (this.spawnAcc >= 1) {
      this.spawnAcc -= 1;
      const out = 0.6 + Math.random() * 0.7;
      const fw = (Math.random() - 0.6) * 0.5;
      const shade = 0.75 + Math.random() * 0.45;
      this.spawn(
        this.mx + rx * (DECK + 0.02) - c * 0.01,
        0.025,
        this.mz + rz * (DECK + 0.02) - s * 0.01,
        rx * out + c * fw + this.vx * 0.4 + (Math.random() - 0.5) * 0.2,
        0.2 + Math.random() * 0.45,
        rz * out + s * fw + this.vz * 0.4 + (Math.random() - 0.5) * 0.2,
        0.55 * shade,
        0.78 * shade,
        0.26 * shade,
        0.011,
      );
    }
  }

  private stepParts(dt: number) {
    const drag = Math.exp(-dt * 3);
    let n = 0;
    for (let i = 0; i < MAX_PARTS; i++) {
      if (this.partLife[i] <= 0) continue;
      const o = i * 8, v = i * 3;
      this.partLife[i] -= dt;
      if (this.parts[o + 1] > 0.004) {
        this.partVel[v] *= drag;
        this.partVel[v + 2] *= drag;
        this.partVel[v + 1] = this.partVel[v + 1] * drag - 2.4 * dt;
        this.parts[o] += this.partVel[v] * dt;
        this.parts[o + 1] += this.partVel[v + 1] * dt;
        this.parts[o + 2] += this.partVel[v + 2] * dt;
      } else this.parts[o + 1] = 0.004;
      // Landed clippings shrink away instead of popping out.
      if (this.partLife[i] < 0.6) this.parts[o + 3] *= Math.exp(-dt * 5);
      if (this.partLife[i] <= 0) this.parts[o + 3] = 0;
      n++;
    }
    this.partCount = n;
  }

  // ---------------------------------------------------------------- feel

  private pan(x = this.mx, z = this.mz) {
    return clamp(this.project(x, 0, z)[0], -1, 1) * 0.8;
  }

  /**
   * Load (length cut per second) drives it all: the motor gets louder and darker as it bogs
   * down, the spray hiss and chute ticks follow the cut rate, and haptics tick only in grass.
   */
  private feel(dt: number) {
    const l = Math.min(1, this.load);
    const stalled = this.stall > 0;
    const speed = Math.hypot(this.vx, this.vz);
    const level = !this.running ? 0 : stalled ? 0.12 : 0.34 + 0.5 * l + 0.1 * Math.min(1, speed);
    const bright = stalled ? 0.1 : 0.5 - 0.38 * l + 0.1 * Math.sin(this.time * 47);
    this.motor.set(level, bright);
    // The handle hums while it runs and thickens into a deep rumble as the motor bogs down.
    if (this.running && !stalled) this.ctx.hapticLevel(0.1 + 0.65 * l, 0.35 - 0.25 * l);
    this.spray.set(stalled ? 0 : l * 0.8, 0.4 + 0.3 * l);
    if (stalled || !this.running) return;
    this.tickAcc += l * 22 * dt;
    if (this.tickAcc >= 1) {
      this.tickAcc = 0;
      this.ctx.sound.play('tick', { pitch: 1.5 + Math.random(), gain: 0.2 + 0.25 * Math.random(), pan: this.pan() });
    }
    if (l > 0.12) {
      this.hapticClock += dt;
      if (this.hapticClock > 0.08 / l) {
        this.hapticClock = 0;
        this.ctx.haptic('light');
      }
    } else this.hapticClock = 0;
  }

  /** Drop to fewer shells when frames run long (auto mode only). */
  private adapt(dt: number) {
    if (!this.autoShells || this.frames < 60) return;
    this.slowFrames = dt > 1 / 45 ? this.slowFrames + 1 : Math.max(0, this.slowFrames - 0.5);
    if (this.slowFrames > 45 && this.shells > 8) {
      this.shells -= 4;
      this.slowFrames = 0;
    }
  }

  private updateChip() {
    const n = this.flowersHit;
    this.chip.classList.toggle('lost', n > 0);
    this.chip.textContent = n ? `✿ ${n} flower${n === 1 ? '' : 's'} mown` : this.celebrated ? '✿ Perfect — no flowers harmed' : '✿ Perfect so far';
  }

  private placeZzz() {
    const c = this.cat;
    const show = c.state === 'sleep';
    this.zzz.hidden = !show;
    if (!show) return;
    const [nx, ny] = this.project(c.x, 0.06, c.z);
    const r = this.ctx.canvas.getBoundingClientRect();
    this.zzz.style.transform = `translate(${(nx * 0.5 + 0.5) * r.width}px, ${(0.5 - ny * 0.5) * r.height}px)`;
  }

  // ---------------------------------------------------------------- render

  private render() {
    const gl = this.gl;
    const sc = this.scene!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, sc.fbo);
    gl.viewport(0, 0, sc.w, sc.h);
    gl.clearColor(0.05, 0.12, 0.04, 1);
    gl.clearDepth(1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.disable(gl.CULL_FACE);

    // Lawn shells.
    let u = this.p.shell.use();
    gl.uniformMatrix4fv(u.viewProj, false, this.viewProj);
    gl.uniform2f(u.lawnSize, LX, LZ);
    gl.uniform1f(u.grassH, GRASS_H);
    gl.uniform1i(u.shells, this.shells);
    gl.uniform1f(u.density, 190);
    gl.uniform1f(u.time, this.time % 1000);
    gl.uniform1f(u.windAmp, 0.009 * this.cfg.wind);
    gl.uniform2f(u.windDir, 0.8, 0.6);
    gl.uniform1f(u.cutLevel, this.lawn.cutLevel / 255);
    gl.uniform3f(u.camPos, ...this.eye);
    const sh = SHADOWS;
    const sx = 0.02, sz = -0.015; // shadows fall away from the sun
    sh.set([this.mx + sx, this.mz + sz, DECK * 1.35, 0.55], 0);
    sh.set([this.layout.stone.x + sx * 0.6, this.layout.stone.z + sz * 0.6, this.layout.stone.r * 1.6, 0.5], 4);
    sh.set([this.cat.x + sx * 0.6, this.cat.z + sz * 0.6, 0.075, this.cat.state === 'run' ? 0.35 : 0.5], 8);
    sh.set([0, 0, 1, 0], 12);
    gl.uniform4fv(u['shadows[0]'], sh);
    gl.uniform1i(u.uLen, 0);
    gl.uniform1i(u.uLean, 1);
    gl.uniform1i(u.uKind, 2);
    this.bindTex(0, this.lenTex);
    this.bindTex(1, this.leanTex);
    this.bindTex(2, this.kindTex);
    gl.bindVertexArray(this.lawnVao);
    gl.drawArraysInstanced(gl.TRIANGLES, 0, GRID_X * GRID_Z * 6, this.shells);

    u = this.p.ground.use();
    gl.uniformMatrix4fv(u.viewProj, false, this.viewProj);
    gl.uniform2f(u.lawnSize, LX, LZ);
    gl.bindVertexArray(this.groundVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Meshes.
    u = this.p.mesh.use();
    gl.uniformMatrix4fv(u.viewProj, false, this.viewProj);
    const sl = Math.hypot(...SUN);
    gl.uniform3f(u.sun, SUN[0] / sl, SUN[1] / sl, SUN[2] / sl);
    const draw = (m: Mesh, model: Float32Array, tint: V3 = [1, 1, 1]) => {
      if (!m.count) return;
      gl.uniformMatrix4fv(u.model, false, model);
      gl.uniform3f(u.tint, ...tint);
      gl.bindVertexArray(m.vao);
      gl.drawArrays(gl.TRIANGLES, 0, m.count);
    };
    const id = placeY(this.model, 0, 0, 0, 0);
    draw(this.meshes.stone, id);
    draw(this.meshes.leaves, id);
    draw(this.meshes.flowers, id);
    const c = this.cat;
    const running = c.state === 'run';
    const bob = running ? Math.abs(Math.sin(c.t * 16)) * 0.012 : Math.sin(this.time * 2.2) * 0.0008;
    draw(running ? this.meshes.catRun : this.meshes.catSleep, placeY(this.model, c.x, bob, c.z, c.heading, 1, running ? 1 : 1 + Math.sin(this.time * 2.2) * 0.04));
    const shake = this.running && this.stall <= 0 ? 0.0012 + 0.0015 * Math.min(1, this.load) : 0;
    draw(this.meshes.mower, placeY(this.model, this.mx + (Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake, this.mz + (Math.random() - 0.5) * shake, this.heading));

    // Clippings.
    if (this.partCount) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.partBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.parts);
      u = this.p.part.use();
      gl.uniformMatrix4fv(u.viewProj, false, this.viewProj);
      gl.uniform1f(u.pxPerUnit, sc.h / (2 * Math.tan(this.fov / 2)));
      gl.bindVertexArray(this.partVao);
      gl.drawArrays(gl.POINTS, 0, MAX_PARTS);
    }
    gl.disable(gl.DEPTH_TEST);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    u = this.p.composite.use();
    gl.uniform1i(u.uScene, 0);
    this.bindTex(0, sc.tex);
    gl.bindVertexArray(this.triVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindTex(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.allocate();
  }

  destroy() {
    this.motor.stop();
    this.spray.stop();
    this.chip.remove();
    this.newBtn.remove();
    this.zzz.remove();
    this.style.remove();
    this.ctx.progress(null);
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      delete w.__mow;
      delete w.__mowLayout;
      delete w.__mowScreen;
      delete w.__mowSeed;
      delete w.__mowBench;
      delete w.__mowStripes;
      delete w.__mowUncut;
    }
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

const SHADOWS = new Float32Array(S.MAX_SHADOWS * 4);
const CORNERS = [[-0.5, -0.5], [0.5, -0.5], [-0.5, 0.5], [0.5, 0.5]];

// ---------------------------------------------------------------- models (local x = forward, z = right)

function buildMower() {
  const m = new MeshBuilder();
  const red: V3 = [0.86, 0.14, 0.1];
  const dark: V3 = [0.16, 0.16, 0.18];
  const black: V3 = [0.06, 0.06, 0.07];
  const steel: V3 = [0.7, 0.72, 0.75];
  // Deck: a low dome.
  m.cyl([0, 0.008, 0], [0, 0.03, 0], 0.074, 0.07, 22, red);
  m.cyl([0, 0.03, 0], [0, 0.042, 0], 0.07, 0.05, 22, red);
  // Engine block, cover and fuel cap.
  m.cyl([0, 0.042, 0], [0, 0.072, 0], 0.034, 0.032, 14, dark);
  m.cyl([0, 0.072, 0], [0, 0.08, 0], 0.032, 0.022, 14, black);
  m.cyl([0.012, 0.08, 0.008], [0.012, 0.086, 0.008], 0.007, 0.007, 8, [0.95, 0.75, 0.15]);
  // Pull-cord handle.
  m.box([-0.02, 0.076, -0.03], [0.006, 0.004, 0.012], black);
  // Wheels: axle along z.
  for (const x of [-0.05, 0.052]) {
    for (const z of [-0.072, 0.072]) {
      const s = Math.sign(z);
      m.cyl([x, 0.02, z - s * 0.007], [x, 0.02, z + s * 0.007], 0.021, 0.021, 12, black);
      m.cyl([x, 0.02, z + s * 0.0075], [x, 0.02, z + s * 0.009], 0.011, 0.009, 8, steel);
    }
  }
  // Side chute on the right.
  m.box([0.0, 0.022, 0.085], [0.024, 0.011, 0.017], dark);
  m.box([0.0, 0.03, 0.1], [0.022, 0.004, 0.004], dark);
  // Handle: two bars up and back, grip across.
  for (const z of [-0.044, 0.044]) m.cyl([-0.05, 0.04, z * 0.9], [-0.18, 0.15, z * 1.05], 0.0045, 0.0045, 6, steel);
  m.cyl([-0.18, 0.15, -0.05], [-0.18, 0.15, 0.05], 0.0065, 0.0065, 8, black);
  m.box([-0.165, 0.14, 0], [0.006, 0.004, 0.03], red);
  return m;
}

function buildCat(running: boolean) {
  const m = new MeshBuilder();
  const fur: V3 = [0.95, 0.55, 0.2];
  const pale: V3 = [1, 0.85, 0.65];
  const pink: V3 = [0.95, 0.55, 0.6];
  const rand = rng(7);
  if (!running) {
    // Curled up asleep: a loaf with the head tucked on the front and the tail wrapped round.
    m.ellipsoid([0, 0.02, 0], [0.047, 0.022, 0.038], fur, 12, 6, 0.08, rand);
    m.ellipsoid([0.036, 0.024, 0.016], [0.021, 0.017, 0.022], fur, 10, 5, 0.05, rand);
    m.ellipsoid([0.05, 0.02, 0.018], [0.009, 0.007, 0.01], pale, 6, 3);
    for (const z of [0.004, 0.029]) m.cyl([0.036, 0.036, z], [0.034, 0.05, z], 0.007, 0.0005, 5, fur);
    for (let i = 0; i < 6; i++) {
      const a0 = -1.2 + i * 0.45, a1 = a0 + 0.45;
      m.cyl([Math.cos(a0) * 0.046, 0.01, Math.sin(a0) * 0.04 + 0.004], [Math.cos(a1) * 0.046, 0.01, Math.sin(a1) * 0.04 + 0.004], 0.008 - i * 0.0006, 0.008 - (i + 1) * 0.0006, 6, i > 3 ? pale : fur);
    }
    // Darker tabby saddle along the back.
    m.ellipsoid([-0.006, 0.026, -0.004], [0.036, 0.018, 0.026], [0.78, 0.38, 0.12], 10, 5, 0.05, rand);
  } else {
    m.ellipsoid([0, 0.042, 0], [0.05, 0.019, 0.021], fur, 12, 6, 0.06, rand);
    m.ellipsoid([0.056, 0.058, 0], [0.019, 0.017, 0.018], fur, 10, 5, 0.05, rand);
    m.ellipsoid([0.072, 0.054, 0], [0.008, 0.006, 0.009], pale, 6, 3);
    for (const z of [-0.009, 0.009]) m.cyl([0.056, 0.07, z], [0.053, 0.086, z * 1.3], 0.007, 0.0005, 5, fur);
    m.ellipsoid([0.075, 0.058, 0], [0.002, 0.002, 0.003], pink, 4, 2);
    for (const x of [-0.034, 0.034]) {
      for (const z of [-0.011, 0.011]) {
        const swing = x * z > 0 ? 0.012 : -0.012;
        m.cyl([x, 0.035, z], [x + swing, 0.002, z], 0.006, 0.005, 6, fur);
      }
    }
    m.cyl([-0.045, 0.048, 0], [-0.075, 0.08, 0], 0.007, 0.004, 6, fur);
    m.cyl([-0.075, 0.08, 0], [-0.085, 0.095, 0], 0.004, 0.003, 6, pale);
    m.ellipsoid([-0.004, 0.047, 0], [0.038, 0.016, 0.016], [0.78, 0.38, 0.12], 10, 5, 0.05, rand);
  }
  return m;
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

const STYLE = `
  .mow-chip { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
    bottom: calc(16px + var(--safe-bottom)); padding: 8px 14px; border-radius: 99px;
    background: rgba(12, 40, 14, 0.62); color: #eaffd8; font: 600 13px/1 inherit; letter-spacing: 0.01em;
    backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px); pointer-events: none; white-space: nowrap; }
  .mow-chip.lost { background: rgba(70, 24, 30, 0.62); color: #ffd6de; }
  .mow-new { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
    bottom: calc(60px + var(--safe-bottom)); height: 44px; padding: 0 22px; border: 0; border-radius: 99px;
    background: linear-gradient(135deg, #8be04e, #2f9e3a); color: #fff; font: 700 16px/1 inherit;
    box-shadow: 0 8px 24px -8px rgba(10, 60, 10, 0.8); cursor: pointer; }
  .mow-new[hidden] { display: none; }
  .mow-zzz { position: absolute; z-index: 2; left: 0; top: 0; pointer-events: none; }
  .mow-zzz[hidden] { display: none; }
  .mow-zzz i { position: absolute; left: 0; top: 0; color: #fff; font: italic 700 13px/1 inherit;
    text-shadow: 0 1px 3px rgba(0, 0, 0, 0.5); opacity: 0; animation: mow-z 2.4s linear infinite; }
  .mow-zzz i:nth-child(2) { animation-delay: 0.8s; font-size: 11px; }
  .mow-zzz i:nth-child(3) { animation-delay: 1.6s; font-size: 9px; }
  @keyframes mow-z { 0% { opacity: 0; transform: translate(0, 0); } 20% { opacity: 0.9; }
    100% { opacity: 0; transform: translate(14px, -30px); } }`;
