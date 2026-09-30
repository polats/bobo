// WebGL2 renderer: the table, plate, bread and honey film go into an offscreen scene texture with the
// dipper's wood and the shadows; then the honey that has depth (the falling thread, the coat on the
// dipper) is drawn over it, refracting and tinting that texture.
import { compile, Program } from '../../shell/gl';
import type { Liquid } from './liquids';
import { set4, type Pool } from './pool';
import * as S from './shaders';

export type Vec3 = [number, number, number];
type Mat4 = Float32Array;

export const LIGHT: Vec3 = norm([-0.35, 0.85, -0.45]);

/** Honey dipper geometry, local frame: x runs from the head's tip (0) to the handle's end. */
export const HEAD_LEN = 0.046;
export const HEAD_R = 0.0125;
const HANDLE_LEN = 0.13;
const HANDLE_R = 0.0042;
const RIDGE = 0.0046;
const DIP_S = 72;
const DIP_A = 28;
const COAT_S = 64;
const COAT_A = 32;
/** Surface mesh vertices per side (the film textures are finer; normals come from them per pixel). */
const MESH = 128;
/** Baked bread colour texture size. */
const ALBEDO = 1024;
/** Quality ladder for the frame-time governor: scene-pass resolution and MSAA samples. */
const QUALITY = [
  { scale: 1, samples: 4 },
  { scale: 0.85, samples: 4 },
  { scale: 0.8, samples: 0 },
  { scale: 0.66, samples: 0 },
];

export interface DrawOpts {
  offset: [number, number];
  pose: DipperPose;
  liquid: Liquid;
  pancake: boolean;
  half: number;
  thickness: number;
  coat: boolean;
}

/** Envelope of the head (the rings' outer tips) at axial position s. */
export function headEnv(s: number) {
  if (s < 0 || s > HEAD_LEN) return 0;
  const u = s / HEAD_LEN;
  // Egg-ish: fuller toward the handle end, rounded tip.
  return HEAD_R * Math.pow(Math.sin(Math.PI * Math.min(1, u * 0.92 + 0.04)), 0.45) * (0.85 + 0.15 * u);
}

/** Groove depth 0..1 at s (1 = bottom of a groove). */
function grooveAt(s: number) {
  if (s < 0.003 || s > HEAD_LEN - 0.003) return 0;
  const c = 0.5 + 0.5 * Math.cos((2 * Math.PI * (s - 0.003)) / RIDGE);
  return 1 - Math.pow(c, 0.35);
}

/** Wood radius at s: head rings, a neck, then the handle. */
export function woodR(s: number) {
  if (s <= HEAD_LEN) return Math.max(0.0012, headEnv(s) * (1 - 0.42 * grooveAt(s)));
  const t = s - HEAD_LEN;
  if (t < 0.008) return HANDLE_R + (headEnv(HEAD_LEN - 0.0005) * 0.5 - HANDLE_R) * (1 - smooth(0, 0.008, t));
  const end = HANDLE_LEN - t;
  if (end < 0.004) return HANDLE_R * Math.sqrt(Math.max(0.02, end / 0.004)) * 1.05;
  return HANDLE_R * (1 + 0.12 * smooth(HANDLE_LEN - 0.03, HANDLE_LEN - 0.006, t));
}

export interface DipperPose {
  /** World position of the head tip (local origin). */
  origin: Vec3;
  /** Axis (local x), up-ish (local y) and side (local z), world unit vectors. */
  ax: Vec3;
  ay: Vec3;
  az: Vec3;
}

export interface Ribbon {
  data: Float32Array;
  index: Uint32Array;
  /** Floats of `data` in use, and indices of `index` in use. */
  floats: number;
  count: number;
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  w = 1;
  h = 1;
  readonly view = new Float32Array(16);
  readonly proj = new Float32Array(16);
  readonly viewProj = new Float32Array(16);
  eye: Vec3 = [0, 0.2, 0.4];
  /** World size of one device pixel per metre of distance from the eye. */
  pxScale = 0.001;
  private progs: Record<string, Program> = {};
  private quad: WebGLBuffer;
  /**
   * Scene pass: drawn (multisampled, if the quality level allows) at a fraction of the screen, then
   * resolved into a texture the honey refracts. The table under it is static, so it is drawn once
   * per camera into its own texture and copied in.
   */
  private scene: { msaa: WebGLFramebuffer | null; color: WebGLRenderbuffer | null; depth: WebGLRenderbuffer; fbo: WebGLFramebuffer; tex: WebGLTexture; sw: number; sh: number } | null = null;
  private tableTarget: { fbo: WebGLFramebuffer; tex: WebGLTexture } | null = null;
  private tableDirty = true;
  /** Bread colour (crumb, pores, crust) baked once per slice: the per-pixel noise was the film pass's main cost. */
  private albedo: { fbo: WebGLFramebuffer; tex: WebGLTexture };
  /** 0 = full: scene at full resolution with 4× MSAA; each step down trades resolution and MSAA for speed. */
  quality = 0;
  private invViewProj = new Float32Array(16);
  private model = new Float32Array(16);
  private liquid: Liquid | null = null;
  private table: MeshBuf;
  private plate: MeshBuf;
  private wood: MeshBuf;
  private wall: MeshBuf | null = null;
  private pancake = false;
  private surf: { vao: WebGLVertexArrayObject; count: number };
  private baseTex: WebGLTexture;
  private honeyTex: WebGLTexture;
  private coat: { vao: WebGLVertexArrayObject; buf: WebGLBuffer; count: number; data: Float32Array };
  private thread: DynBuf;
  private shadow: DynBuf;
  private blob: DynBuf;
  private readonly N: number;
  private stage: Float32Array;
  private coatP = new Float32Array((COAT_S + 1) * (COAT_A + 1) * 3);
  private scatterLin = new Float32Array(3);

  constructor(canvas: HTMLCanvasElement, pool: Pool) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.N = pool.N;
    const vs = (src: string) => compile(gl, gl.VERTEX_SHADER, src);
    const blitVs = vs(S.BLIT_VS), meshVs = vs(S.MESH_VS);
    this.progs.blit = new Program(gl, blitVs, S.BLIT_FS);
    this.progs.table = new Program(gl, meshVs, S.TABLE_FS);
    this.progs.plate = new Program(gl, meshVs, S.PLATE_FS);
    this.progs.wood = new Program(gl, meshVs, S.WOOD_FS);
    this.progs.surf = new Program(gl, vs(S.SURF_VS), S.SURF_FS);
    this.progs.thread = new Program(gl, vs(S.THREAD_VS), S.THREAD_FS);
    this.progs.coat = new Program(gl, vs(S.COAT_VS), S.COAT_FS);
    this.progs.shadow = new Program(gl, vs(S.SHADOW_VS), S.SHADOW_FS);
    this.progs.blob = new Program(gl, vs(S.BLOB_VS), S.BLOB_FS);
    this.progs.albedo = new Program(gl, blitVs, S.ALBEDO_FS);
    this.progs.wall = new Program(gl, meshVs, S.WALL_FS);
    this.albedo = colorTarget(gl, ALBEDO, ALBEDO);

    this.quad = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);

    this.table = meshBuf(gl, tableMesh());
    this.plate = meshBuf(gl, plateMesh());
    this.wood = meshBuf(gl, woodMesh());
    this.surf = this.surfMesh(MESH);
    this.baseTex = tex(gl, pool.N);
    this.honeyTex = tex(gl, pool.N);
    this.stage = new Float32Array(pool.N * pool.N * 2);
    this.setBase(pool);

    // Coat: dynamic lathe, pos3 normal3 thick1.
    const coatData = new Float32Array((COAT_S + 1) * (COAT_A + 1) * 7);
    const cvao = gl.createVertexArray()!;
    gl.bindVertexArray(cvao);
    const cbuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, cbuf);
    gl.bufferData(gl.ARRAY_BUFFER, coatData.byteLength, gl.DYNAMIC_DRAW);
    attrib(gl, 0, 3, 7, 0);
    attrib(gl, 1, 3, 7, 3);
    attrib(gl, 2, 1, 7, 6);
    const cidx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, cidx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, gridIndex(COAT_S + 1, COAT_A + 1), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.coat = { vao: cvao, buf: cbuf, count: COAT_S * COAT_A * 6, data: coatData };

    this.thread = dynBuf(gl, [3, 3, 2, 1]);
    this.shadow = dynBuf(gl, [3, 4]);
    this.blob = dynBuf(gl, [3, 4]);
  }

  private surfMesh(N: number) {
    const gl = this.gl;
    const uv = new Float32Array(N * N * 2);
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        uv[(j * N + i) * 2] = (i + 0.5) / N;
        uv[(j * N + i) * 2 + 1] = (j + 0.5) / N;
      }
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    const idx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, idx);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, gridIndex(N, N), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    return { vao, count: (N - 1) * (N - 1) * 6 };
  }

  /** Upload the bare bread/plate heights and the bread outline. */
  setBase(pool: Pool) {
    const { N, dx, half } = pool;
    const d = this.stage;
    for (let j = 0; j < N; j++)
      for (let i = 0; i < N; i++) {
        const k = j * N + i;
        d[k * 2] = pool.b[k] * 1000;
        d[k * 2 + 1] = Math.max(-60, Math.min(60, pool.sdf(-half + (i + 0.5) * dx, -half + (j + 0.5) * dx) * 1000));
      }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, N, N, gl.RG, gl.FLOAT, d);
    pool.dirty = [0, 0, N - 1, N - 1];
    // The side wall from the exact outline.
    if (this.wall) {
      gl.deleteVertexArray(this.wall.vao);
    }
    this.wall = meshBuf(gl, wallMesh(pool));
    this.pancake = pool.base === 'pancake';
    // Bake the bread's colour for this slice.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.albedo.fbo);
    gl.viewport(0, 0, ALBEDO, ALBEDO);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    const u = this.progs.albedo.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.uniform1i(u.uBase, 0);
    gl.uniform1f(u.uHalf, half);
    gl.uniform1f(u.uPancake, pool.base === 'pancake' ? 1 : 0);
    this.quadDraw();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  private quadDraw() {
    const gl = this.gl;
    gl.bindVertexArray(null);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /** Upload the honey cells that changed. */
  uploadHoney(pool: Pool) {
    const [i0, j0, i1, j1] = pool.dirty;
    if (i1 < i0 || j1 < j0) return;
    const N = pool.N, w = i1 - i0 + 1, hh = j1 - j0 + 1, d = this.stage;
    let q = 0;
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        const k = j * N + i;
        d[q++] = pool.h[k] * 1000;
        d[q++] = pool.soak[k];
      }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.honeyTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, i0, j0, w, hh, gl.RG, gl.FLOAT, d.subarray(0, w * hh * 2));
    set4(pool.dirty, 0, 0, -1, -1);
  }

  resize(w: number, h: number) {
    this.w = w;
    this.h = h;
    this.allocScene();
    this.camera();
  }

  /** Step the quality down one level (the toy's frame-time governor calls this). */
  degrade() {
    if (this.quality >= QUALITY.length - 1) return false;
    this.quality++;
    this.allocScene();
    return true;
  }

  private allocScene() {
    const gl = this.gl;
    const q = QUALITY[this.quality];
    const sw = Math.max(1, Math.round(this.w * q.scale)), sh = Math.max(1, Math.round(this.h * q.scale));
    if (this.scene) {
      const s = this.scene;
      if (s.msaa) gl.deleteFramebuffer(s.msaa);
      if (s.color) gl.deleteRenderbuffer(s.color);
      gl.deleteFramebuffer(s.fbo);
      gl.deleteRenderbuffer(s.depth);
      gl.deleteTexture(s.tex);
    }
    if (this.tableTarget) {
      gl.deleteFramebuffer(this.tableTarget.fbo);
      gl.deleteTexture(this.tableTarget.tex);
    }
    const samples = Math.min(q.samples, gl.getParameter(gl.MAX_SAMPLES) as number);
    const { fbo, tex } = colorTarget(gl, sw, sh);
    let msaa: WebGLFramebuffer | null = null, color: WebGLRenderbuffer | null = null;
    const depth = gl.createRenderbuffer()!;
    gl.bindRenderbuffer(gl.RENDERBUFFER, depth);
    if (samples > 1) {
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.DEPTH_COMPONENT24, sw, sh);
      color = gl.createRenderbuffer()!;
      gl.bindRenderbuffer(gl.RENDERBUFFER, color);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, sw, sh);
      msaa = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, msaa);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    } else {
      // No MSAA: draw straight into the texture's framebuffer, with its own depth.
      gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT24, sw, sh);
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, depth);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.scene = { msaa, color, depth, fbo, tex, sw, sh };
    this.tableTarget = colorTarget(gl, sw, sh);
    this.tableDirty = true;
  }

  /** Camera elevation in degrees (dev hook can look straight down). */
  elevation = 36;

  camera() {
    const aspect = this.w / this.h;
    const el = (this.elevation * Math.PI) / 180;
    const vfov = (40 * Math.PI) / 180;
    const t = Math.tan(vfov / 2);
    // Fit the bread's width (with a little plate either side) and ~12 cm of headroom above it.
    const dist = Math.max(0.105 / t, 0.06 / (aspect * t));
    const target: Vec3 = [0, 0.036, -0.006];
    this.eye = [target[0], target[1] + dist * Math.sin(el), target[2] + dist * Math.cos(el)];
    // Shift the frame down on tall screens so the bread sits in the lower part.
    lookAt(this.view, this.eye, target, this.elevation > 80 ? [0, 0, -1] : [0, 1, 0]);
    perspective(this.proj, vfov, aspect, 0.02, 2);
    mul(this.viewProj, this.proj, this.view);
    invertInto(this.invViewProj, this.viewProj);
    this.pxScale = (2 * t) / this.h;
    this.tableDirty = true;
  }

  /** World point to canvas pixels (y down). */
  project(p: Vec3): [number, number, number] {
    const m = this.viewProj;
    const x = m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12];
    const y = m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13];
    const w = m[3] * p[0] + m[7] * p[1] + m[11] * p[2] + m[15];
    return [((x / w) * 0.5 + 0.5) * this.w, (1 - ((y / w) * 0.5 + 0.5)) * this.h, w];
  }

  /** Ray through canvas pixel (px, py) (a reused object: read it before the next call). */
  ray(px: number, py: number): { o: Vec3; d: Vec3 } {
    const m = this.invViewProj, r = this.rayOut;
    const nx = (px / this.w) * 2 - 1, ny = 1 - (py / this.h) * 2;
    xformInto(r.o, m, nx, ny, -1);
    xformInto(r.d, m, nx, ny, 1);
    r.d[0] -= r.o[0];
    r.d[1] -= r.o[1];
    r.d[2] -= r.o[2];
    const l = Math.sqrt(r.d[0] * r.d[0] + r.d[1] * r.d[1] + r.d[2] * r.d[2]) || 1;
    r.d[0] /= l;
    r.d[1] /= l;
    r.d[2] /= l;
    return r;
  }

  private rayOut: { o: Vec3; d: Vec3 } = { o: [0, 0, 0], d: [0, 0, 1] };

  // Coat tables over its axial samples (fixed), so the per-frame loop is plain arithmetic.
  private coatSs = new Float64Array(COAT_S + 1);
  private coatWood = new Float64Array(COAT_S + 1);
  private coatEnv = new Float64Array(COAT_S + 1);
  private coatFillR = new Float64Array(COAT_S + 1);
  private coatDrop = new Float64Array(COAT_S + 1);
  private coatNeckS = new Float64Array(COAT_S + 1);
  // The same at 0.5 mm steps along the head, for finding its lowest point.
  private lowSs = new Float64Array(0);
  private lowWood = new Float64Array(0);
  private lowEnv = new Float64Array(0);
  private coatReady = false;
  /** cos/sin around the coat. */
  private coatRing = new Float64Array((COAT_A + 1) * 2);

  private coatTables() {
    const s0 = -0.0015, s1 = HEAD_LEN + 0.004;
    for (let i = 0; i <= COAT_S; i++) {
      const s = s0 + ((s1 - s0) * i) / COAT_S;
      this.coatSs[i] = s;
      this.coatWood[i] = woodR(Math.max(0, s));
      this.coatEnv[i] = headEnv(s);
    }
    for (let j = 0; j <= COAT_A; j++) {
      this.coatRing[j * 2] = Math.cos((2 * Math.PI * j) / COAT_A);
      this.coatRing[j * 2 + 1] = Math.sin((2 * Math.PI * j) / COAT_A);
    }
    const m = Math.floor((HEAD_LEN - 0.008) / 0.0005) + 1;
    this.lowSs = new Float64Array(m);
    this.lowWood = new Float64Array(m);
    this.lowEnv = new Float64Array(m);
    for (let k = 0; k < m; k++) {
      const s = 0.004 + k * 0.0005;
      this.lowSs[k] = s;
      this.lowWood[k] = woodR(s);
      this.lowEnv[k] = headEnv(s);
    }
    this.coatReady = true;
  }

  /**
   * Place the dipper so the lowest point of its honey coat (the neck the thread leaves from) sits at
   * the nozzle, and rebuild the coat. `load` 0..1 sets the coat's thickness, `flow` 0..1 the neck.
   * Writes pose.origin (pose.ax/ay/az must be set).
   */
  setCoat(pose: DipperPose, nx0: number, ny0: number, nz0: number, load: number, flow: number, t: number) {
    if (!this.coatReady) this.coatTables();
    const d = this.coat.data;
    const { origin: o, ax, ay, az } = pose;
    const tl = 0.00025 + 0.0022 * load, sag = tl * 1.1;
    // Lowest point of the coat across the axis (straight down across it is -ay).
    const nd = Math.sqrt(Math.max(0, 1 - ax[1] * ax[1]));
    let sBest = 0.01, yBest = Infinity, fBest = 0;
    for (let k = 0; k < this.lowSs.length; k++) {
      const s = this.lowSs[k];
      const f = Math.max(this.lowWood[k] + tl * 0.35, this.lowEnv[k] * 0.9 + tl * 0.8);
      const y = s * ax[1] - (f + sag) * nd;
      if (y < yBest) {
        yBest = y;
        sBest = s;
        fBest = f;
      }
    }
    const neck = 0.0012 + 0.004 * load * Math.min(1, flow + 0.2);
    const reach = fBest + sag + neck;
    o[0] = nx0 - ax[0] * sBest + ay[0] * reach;
    o[1] = ny0 - ax[1] * sBest + ay[1] * reach;
    o[2] = nz0 - ax[2] * sBest + ay[2] * reach;
    // Per axial sample: the coat filling the grooves, the ring drops (visual) and the neck.
    for (let i = 0; i <= COAT_S; i++) {
      const s = this.coatSs[i], w = this.coatWood[i];
      let f: number;
      if (s < 0) f = (tl + 0.0012) * Math.sqrt(Math.max(0, 1 - (s / 0.0015) * (s / 0.0015)));
      else if (s > HEAD_LEN) f = Math.max(w + tl * 0.3 * Math.max(0, 1 - (s - HEAD_LEN) / 0.004), 0);
      else f = Math.max(w + tl * 0.35, this.coatEnv[i] * 0.9 + tl * 0.8);
      this.coatFillR[i] = f;
      let drop = 0;
      if (s >= 0 && s <= HEAD_LEN) {
        const ring = Math.round((s - 0.003) / 0.0046), sc = 0.003 + ring * 0.0046, u = (s - sc) / 0.0011;
        drop = load * 0.0022 * (0.55 + 0.45 * Math.sin(t * (0.7 + 0.13 * ring) + ring * 2.1)) * Math.exp(-u * u);
      }
      this.coatDrop[i] = drop;
      const v = (s - sBest) / 0.0024;
      this.coatNeckS[i] = neck * Math.exp(-v * v);
    }
    const P = this.coatP;
    // (Plain locals: reading doubles out of JS arrays inside the loop would box them.)
    const ax0 = ax[0], ax1 = ax[1], ax2 = ax[2], ay0 = ay[0], ay1 = ay[1], ay2 = ay[2], az0 = az[0], az1 = az[1], az2 = az[2];
    const o0 = o[0], o1 = o[1], o2 = o[2];
    const ring = this.coatRing;
    for (let i = 0; i <= COAT_S; i++) {
      const s = this.coatSs[i], f = this.coatFillR[i], dr = this.coatDrop[i], nk = this.coatNeckS[i], w = this.coatWood[i];
      const bx = o0 + ax0 * s, by = o1 + ax1 * s, bz = o2 + ax2 * s;
      for (let j = 0; j <= COAT_A; j++) {
        const cy = ring[j * 2], cz = ring[j * 2 + 1];
        const nx = ay0 * cy + az0 * cz, ny = ay1 * cy + az1 * cz, nz = ay2 * cy + az2 * cz;
        const dn = ny < 0 ? -ny : 0, d2 = dn * dn, d4 = d2 * d2, d8 = d4 * d4;
        const r = f + sag * d2 + dr * d8 * d2 + nk * d8;
        const k = (i * (COAT_A + 1) + j) * 3;
        P[k] = bx + nx * r;
        P[k + 1] = by + ny * r;
        P[k + 2] = bz + nz * r;
        d[(i * (COAT_A + 1) + j) * 7 + 6] = r > w ? r - w : 0;
      }
    }
    // Normals from the grid.
    for (let i = 0; i <= COAT_S; i++)
      for (let j = 0; j <= COAT_A; j++) {
        const k = i * (COAT_A + 1) + j;
        const ia = Math.max(0, i - 1), ib = Math.min(COAT_S, i + 1);
        const ja = (j + COAT_A - 1) % COAT_A, jb = (j + 1) % COAT_A;
        const a = ia * (COAT_A + 1) + j, b = ib * (COAT_A + 1) + j, c = i * (COAT_A + 1) + ja, e = i * (COAT_A + 1) + jb;
        const ux = P[b * 3] - P[a * 3], uy = P[b * 3 + 1] - P[a * 3 + 1], uz = P[b * 3 + 2] - P[a * 3 + 2];
        const vx = P[e * 3] - P[c * 3], vy = P[e * 3 + 1] - P[c * 3 + 1], vz = P[e * 3 + 2] - P[c * 3 + 2];
        // v × u points outward (the lathe runs +s along the axis and +φ around it).
        let nx = vy * uz - vz * uy, ny = vz * ux - vx * uz, nz = vx * uy - vy * ux;
        const l = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        nx /= l; ny /= l; nz /= l;
        // Tip and tail caps collapse to the axis: point their normals along it.
        if (i === 0 || i === COAT_S) {
          const sg = i === 0 ? -1 : 1;
          nx = ax0 * sg; ny = ax1 * sg; nz = ax2 * sg;
        }
        const o7 = k * 7;
        d[o7] = P[k * 3]; d[o7 + 1] = P[k * 3 + 1]; d[o7 + 2] = P[k * 3 + 2];
        d[o7 + 3] = nx; d[o7 + 4] = ny; d[o7 + 5] = nz;
      }
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.coat.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
  }

  setThread(r: Ribbon) {
    upload(this.gl, this.thread, r);
  }

  setShadow(r: Ribbon) {
    upload(this.gl, this.shadow, r);
  }

  setBlob(r: Ribbon) {
    upload(this.gl, this.blob, r);
  }

  private setCommon(u: Record<string, WebGLUniformLocation>) {
    const gl = this.gl, liquid = this.liquid!;
    if (u.uViewProj) gl.uniformMatrix4fv(u.uViewProj, false, this.viewProj);
    if (u.uEye) gl.uniform3fv(u.uEye, this.eye);
    if (u.uLight) gl.uniform3fv(u.uLight, LIGHT);
    if (u.uAbsorb) gl.uniform3fv(u.uAbsorb, liquid.absorb);
    if (u.uScatter) gl.uniform3fv(u.uScatter, this.scatterLin);
    if (u.uCloud) gl.uniform1f(u.uCloud, liquid.cloud);
    if (u.uRes) gl.uniform2f(u.uRes, this.w, this.h);
  }

  draw(o: DrawOpts) {
    const gl = this.gl;
    const sc = this.scene!;
    this.liquid = o.liquid;
    for (let i = 0; i < 3; i++) this.scatterLin[i] = o.liquid.scatter[i] ** 2.2;
    const model = this.model;

    // The table only changes with the camera: draw it once into its own texture.
    if (this.tableDirty) {
      this.tableDirty = false;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.tableTarget!.fbo);
      gl.viewport(0, 0, sc.sw, sc.sh);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      identity(model);
      model[13] = -o.thickness - 0.006;
      this.drawMesh('table', this.table, model);
    }

    // Pass 1: the scene.
    gl.bindFramebuffer(gl.FRAMEBUFFER, sc.msaa ?? sc.fbo);
    gl.viewport(0, 0, sc.sw, sc.sh);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    let u = this.progs.blit.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tableTarget!.tex);
    gl.uniform1i(u.uTex, 0);
    this.quadDraw();
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    identity(model);
    model[12] = o.offset[0];
    model[13] = -o.thickness - 0.0002;
    model[14] = o.offset[1];
    this.drawMesh('plate', this.plate, model);

    // Bread + honey film.
    u = this.progs.surf.use();
    this.setCommon(u);
    gl.uniform1f(u.uHalf, o.half);
    gl.uniform2f(u.uOffset, o.offset[0], o.offset[1]);
    gl.uniform1f(u.uTexel, 1 / this.N);
    gl.uniform1f(u.uMesh, 1 / MESH);
    gl.uniform1f(u.uThick, o.thickness * 1000);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseTex);
    gl.uniform1i(u.uBase, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.honeyTex);
    gl.uniform1i(u.uHoney, 1);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.albedo.tex);
    gl.uniform1i(u.uAlbedo, 2);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindVertexArray(this.surf.vao);
    gl.drawElements(gl.TRIANGLES, this.surf.count, gl.UNSIGNED_INT, 0);

    identity(model);
    model[12] = o.offset[0];
    model[14] = o.offset[1];
    u = this.progs.wall.use();
    gl.uniform1f(u.uPancake, this.pancake ? 1 : 0);
    this.drawMesh('wall', this.wall!, model);

    // Shadows lie on what's there: blended, no depth writes.
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.DST_COLOR, gl.SRC_ALPHA);
    gl.depthMask(false);
    gl.enable(gl.POLYGON_OFFSET_FILL);
    gl.polygonOffset(-2, -2);
    if (this.blob.count) {
      // A flat soft blob: no depth test, or the crumb's relief would cut it into a ragged edge.
      gl.disable(gl.DEPTH_TEST);
      u = this.progs.blob.use();
      this.setCommon(u);
      gl.bindVertexArray(this.blob.vao);
      gl.drawElements(gl.TRIANGLES, this.blob.count, gl.UNSIGNED_INT, 0);
      gl.enable(gl.DEPTH_TEST);
    }
    if (this.shadow.count) {
      u = this.progs.shadow.use();
      this.setCommon(u);
      gl.bindVertexArray(this.shadow.vao);
      gl.drawElements(gl.TRIANGLES, this.shadow.count, gl.UNSIGNED_INT, 0);
    }
    gl.disable(gl.POLYGON_OFFSET_FILL);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    // Dipper wood.
    const p = o.pose;
    model[0] = p.ax[0]; model[1] = p.ax[1]; model[2] = p.ax[2]; model[3] = 0;
    model[4] = p.ay[0]; model[5] = p.ay[1]; model[6] = p.ay[2]; model[7] = 0;
    model[8] = p.az[0]; model[9] = p.az[1]; model[10] = p.az[2]; model[11] = 0;
    model[12] = p.origin[0]; model[13] = p.origin[1]; model[14] = p.origin[2]; model[15] = 1;
    this.drawMesh('wood', this.wood, model);

    // Resolve, then pass 2: to the screen, then the honey with depth.
    if (sc.msaa) {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, sc.msaa);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, sc.fbo);
      gl.blitFramebuffer(0, 0, sc.sw, sc.sh, 0, 0, sc.sw, sc.sh, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.DEPTH_TEST);
    u = this.progs.blit.use();
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sc.tex);
    gl.uniform1i(u.uTex, 0);
    this.quadDraw();
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);

    if (o.coat) {
      u = this.progs.coat.use();
      this.setCommon(u);
      gl.uniform1i(u.uScene, 0);
      gl.enable(gl.CULL_FACE);
      gl.cullFace(gl.BACK);
      gl.frontFace(gl.CW);
      gl.bindVertexArray(this.coat.vao);
      gl.drawElements(gl.TRIANGLES, this.coat.count, gl.UNSIGNED_INT, 0);
      gl.disable(gl.CULL_FACE);
      gl.frontFace(gl.CCW);
    }
    if (this.thread.count) {
      u = this.progs.thread.use();
      this.setCommon(u);
      gl.uniform1i(u.uScene, 0);
      gl.bindVertexArray(this.thread.vao);
      gl.drawElements(gl.TRIANGLES, this.thread.count, gl.UNSIGNED_INT, 0);
    }
    gl.bindVertexArray(null);
  }

  private drawMesh(name: string, m: MeshBuf, model: Mat4) {
    const gl = this.gl;
    const u = this.progs[name].use();
    this.setCommon(u);
    gl.uniformMatrix4fv(u.uModel, false, model);
    gl.bindVertexArray(m.vao);
    gl.drawElements(gl.TRIANGLES, m.count, gl.UNSIGNED_INT, 0);
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}

// ---- meshes ----

interface MeshData {
  pos: Float32Array;
  normal: Float32Array;
  extra: Float32Array;
  index: Uint32Array;
}

interface MeshBuf {
  vao: WebGLVertexArrayObject;
  count: number;
}

function meshBuf(gl: WebGL2RenderingContext, m: MeshData): MeshBuf {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const put = (loc: number, data: Float32Array, size: number) => {
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
  };
  put(0, m.pos, 3);
  put(1, m.normal, 3);
  put(2, m.extra, 2);
  const ib = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, m.index, gl.STATIC_DRAW);
  gl.bindVertexArray(null);
  return { vao, count: m.index.length };
}

function tableMesh(): MeshData {
  const s = 0.6;
  return {
    pos: new Float32Array([-s, 0, -s, s, 0, -s, -s, 0, s, s, 0, s]),
    normal: new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0]),
    extra: new Float32Array(8),
    index: new Uint32Array([0, 2, 1, 1, 2, 3]),
  };
}

/** A lathe around the y axis from an (r, y) profile. */
function lathe(profile: [number, number][], seg: number): MeshData {
  const n = profile.length;
  const pos = new Float32Array(n * (seg + 1) * 3), normal = new Float32Array(n * (seg + 1) * 3);
  for (let i = 0; i < n; i++) {
    const [r, y] = profile[i];
    const a = profile[Math.max(0, i - 1)], b = profile[Math.min(n - 1, i + 1)];
    // Profile tangent (dr, dy) -> outward normal (dy, -dr).
    let nr = b[1] - a[1], ny = -(b[0] - a[0]);
    const l = Math.hypot(nr, ny) || 1;
    nr /= l; ny /= l;
    for (let j = 0; j <= seg; j++) {
      const t = (2 * Math.PI * j) / seg, c = Math.cos(t), s = Math.sin(t);
      const k = (i * (seg + 1) + j) * 3;
      pos[k] = r * c; pos[k + 1] = y; pos[k + 2] = r * s;
      normal[k] = -nr * c; normal[k + 1] = -ny; normal[k + 2] = -nr * s;
    }
  }
  return { pos, normal, extra: new Float32Array(n * (seg + 1) * 2), index: gridIndex(n, seg + 1) };
}

function plateMesh(): MeshData {
  const prof: [number, number][] = [];
  prof.push([0, 0]);
  for (let i = 1; i <= 12; i++) prof.push([(0.084 * i) / 12, 0]);
  for (let i = 1; i <= 10; i++) {
    const t = i / 10;
    prof.push([0.084 + 0.012 * t, 0.0075 * (1 - Math.cos((t * Math.PI) / 2)) ** 0.8]);
  }
  prof.push([0.1, 0.0078], [0.104, 0.0074], [0.106, 0.004], [0.103, -0.002]);
  return lathe(prof, 72);
}

function woodMesh(): MeshData {
  const S = DIP_S * 3, A = DIP_A;
  const total = HEAD_LEN + HANDLE_LEN;
  const sAt = (i: number) => {
    // Dense along the head, coarser along the handle.
    const u = i / S;
    return u < 0.6 ? (u / 0.6) * HEAD_LEN : HEAD_LEN + ((u - 0.6) / 0.4) * HANDLE_LEN;
  };
  const pos = new Float32Array((S + 1) * (A + 1) * 3), normal = new Float32Array((S + 1) * (A + 1) * 3), extra = new Float32Array((S + 1) * (A + 1) * 2);
  for (let i = 0; i <= S; i++) {
    const s = Math.min(total, sAt(i));
    const r = i === 0 || i === S ? 0.0003 : woodR(s);
    const ds = 0.0004;
    const dr = (woodR(Math.min(total, s + ds)) - woodR(Math.max(0, s - ds))) / (2 * ds);
    const nl = Math.hypot(1, dr);
    for (let j = 0; j <= A; j++) {
      const t = (2 * Math.PI * j) / A, c = Math.cos(t), sn = Math.sin(t);
      const k = (i * (A + 1) + j) * 3;
      pos[k] = s; pos[k + 1] = r * c; pos[k + 2] = r * sn;
      normal[k] = -dr / nl; normal[k + 1] = c / nl; normal[k + 2] = sn / nl;
      if (i === 0) { normal[k] = -1; normal[k + 1] = 0; normal[k + 2] = 0; }
      extra[(i * (A + 1) + j) * 2] = s <= HEAD_LEN ? grooveAt(s) : 0;
      extra[(i * (A + 1) + j) * 2 + 1] = s <= HEAD_LEN + 0.004 ? 1 : 0;
    }
  }
  return { pos, normal, extra, index: gridIndex(S + 1, A + 1) };
}

/** Side wall: the outline found by bisection along rays from the centre, top to plate level. */
function wallMesh(pool: Pool): MeshData {
  const K = 256;
  const cellMm = (2000 * pool.half) / MESH;
  const e = Math.min(1, (0.9 * cellMm) / 2.5);
  const top = -0.3 * pool.thickness * (1 - Math.sqrt(Math.max(0, 1 - (1 - e) * (1 - e))));
  const bot = -pool.thickness;
  const pos = new Float32Array((K + 1) * 2 * 3), normal = new Float32Array((K + 1) * 2 * 3), extra = new Float32Array((K + 1) * 2 * 2);
  for (let i = 0; i <= K; i++) {
    const a = (2 * Math.PI * i) / K, cx = Math.cos(a), cz = Math.sin(a);
    let lo = 0, hi = 0.09;
    for (let it = 0; it < 32; it++) {
      const m = (lo + hi) / 2;
      if (pool.sdf(cx * m, cz * m) < 0) lo = m;
      else hi = m;
    }
    const x = cx * lo, z = cz * lo, h = 1e-5;
    let nx = pool.sdf(x + h, z) - pool.sdf(x - h, z), nz = pool.sdf(x, z + h) - pool.sdf(x, z - h);
    const nl = Math.hypot(nx, nz) || 1;
    nx /= nl;
    nz /= nl;
    for (let k = 0; k < 2; k++) {
      const q = i * 2 + k;
      pos[q * 3] = x; pos[q * 3 + 1] = k ? top : bot; pos[q * 3 + 2] = z;
      normal[q * 3] = nx; normal[q * 3 + 1] = 0; normal[q * 3 + 2] = nz;
      extra[q * 2] = i / K; extra[q * 2 + 1] = k;
    }
  }
  return { pos, normal, extra, index: gridIndex(K + 1, 2) };
}

function gridIndex(rows: number, cols: number) {
  const idx = new Uint32Array((rows - 1) * (cols - 1) * 6);
  let q = 0;
  for (let i = 0; i < rows - 1; i++)
    for (let j = 0; j < cols - 1; j++) {
      const a = i * cols + j, b = a + 1, c = a + cols, d = c + 1;
      idx[q++] = a; idx[q++] = c; idx[q++] = b;
      idx[q++] = b; idx[q++] = c; idx[q++] = d;
    }
  return idx;
}

function colorTarget(gl: WebGL2RenderingContext, w: number, h: number) {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex };
}

function tex(gl: WebGL2RenderingContext, N: number) {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG16F, N, N, 0, gl.RG, gl.FLOAT, new Float32Array(N * N * 2));
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

interface DynBuf {
  vao: WebGLVertexArrayObject;
  buf: WebGLBuffer;
  ibuf: WebGLBuffer;
  cap: number;
  icap: number;
  count: number;
}

function attrib(gl: WebGL2RenderingContext, loc: number, size: number, stride: number, off: number) {
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride * 4, off * 4);
}

function dynBuf(gl: WebGL2RenderingContext, sizes: number[]): DynBuf {
  const vao = gl.createVertexArray()!;
  gl.bindVertexArray(vao);
  const buf = gl.createBuffer()!;
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  const stride = sizes.reduce((a, b) => a + b, 0);
  let off = 0;
  sizes.forEach((s, i) => {
    attrib(gl, i, s, stride, off);
    off += s;
  });
  const ibuf = gl.createBuffer()!;
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ibuf);
  gl.bindVertexArray(null);
  return { vao, buf, ibuf, cap: 0, icap: 0, count: 0 };
}

function upload(gl: WebGL2RenderingContext, b: DynBuf, r: Ribbon) {
  b.count = r.count;
  if (!r.count) return;
  gl.bindVertexArray(b.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, b.buf);
  if (r.data.byteLength > b.cap) {
    b.cap = r.data.byteLength * 2;
    gl.bufferData(gl.ARRAY_BUFFER, b.cap, gl.DYNAMIC_DRAW);
  }
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, r.data, 0, r.floats);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, b.ibuf);
  if (r.index.byteLength > b.icap) {
    b.icap = r.index.byteLength * 2;
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, b.icap, gl.DYNAMIC_DRAW);
  }
  gl.bufferSubData(gl.ELEMENT_ARRAY_BUFFER, 0, r.index, 0, r.count);
  gl.bindVertexArray(null);
}

// ---- small math ----

export function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}

function smooth(a: number, b: number, x: number) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function identity(m: Mat4) {
  m.fill(0);
  m[0] = m[5] = m[10] = m[15] = 1;
}

function perspective(m: Mat4, fovy: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovy / 2);
  m.fill(0);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
}

function lookAt(m: Mat4, eye: Vec3, at: Vec3, up: Vec3) {
  const z = norm([eye[0] - at[0], eye[1] - at[1], eye[2] - at[2]]);
  const x = norm([up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]]);
  const y: Vec3 = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
  m.set([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
}

function dot(a: Vec3, b: Vec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function mul(out: Mat4, a: Mat4, b: Mat4) {
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
}

function xformInto(out: Vec3, m: Mat4, px: number, py: number, pz: number) {
  const x = m[0] * px + m[4] * py + m[8] * pz + m[12];
  const y = m[1] * px + m[5] * py + m[9] * pz + m[13];
  const z = m[2] * px + m[6] * py + m[10] * pz + m[14];
  const w = m[3] * px + m[7] * py + m[11] * pz + m[15];
  out[0] = x / w;
  out[1] = y / w;
  out[2] = z / w;
}

function invertInto(inv: Mat4, m: Mat4) {
  const a = m;
  inv[0] = a[5] * a[10] * a[15] - a[5] * a[11] * a[14] - a[9] * a[6] * a[15] + a[9] * a[7] * a[14] + a[13] * a[6] * a[11] - a[13] * a[7] * a[10];
  inv[4] = -a[4] * a[10] * a[15] + a[4] * a[11] * a[14] + a[8] * a[6] * a[15] - a[8] * a[7] * a[14] - a[12] * a[6] * a[11] + a[12] * a[7] * a[10];
  inv[8] = a[4] * a[9] * a[15] - a[4] * a[11] * a[13] - a[8] * a[5] * a[15] + a[8] * a[7] * a[13] + a[12] * a[5] * a[11] - a[12] * a[7] * a[9];
  inv[12] = -a[4] * a[9] * a[14] + a[4] * a[10] * a[13] + a[8] * a[5] * a[14] - a[8] * a[6] * a[13] - a[12] * a[5] * a[10] + a[12] * a[6] * a[9];
  inv[1] = -a[1] * a[10] * a[15] + a[1] * a[11] * a[14] + a[9] * a[2] * a[15] - a[9] * a[3] * a[14] - a[13] * a[2] * a[11] + a[13] * a[3] * a[10];
  inv[5] = a[0] * a[10] * a[15] - a[0] * a[11] * a[14] - a[8] * a[2] * a[15] + a[8] * a[3] * a[14] + a[12] * a[2] * a[11] - a[12] * a[3] * a[10];
  inv[9] = -a[0] * a[9] * a[15] + a[0] * a[11] * a[13] + a[8] * a[1] * a[15] - a[8] * a[3] * a[13] - a[12] * a[1] * a[11] + a[12] * a[3] * a[9];
  inv[13] = a[0] * a[9] * a[14] - a[0] * a[10] * a[13] - a[8] * a[1] * a[14] + a[8] * a[2] * a[13] + a[12] * a[1] * a[10] - a[12] * a[2] * a[9];
  inv[2] = a[1] * a[6] * a[15] - a[1] * a[7] * a[14] - a[5] * a[2] * a[15] + a[5] * a[3] * a[14] + a[13] * a[2] * a[7] - a[13] * a[3] * a[6];
  inv[6] = -a[0] * a[6] * a[15] + a[0] * a[7] * a[14] + a[4] * a[2] * a[15] - a[4] * a[3] * a[14] - a[12] * a[2] * a[7] + a[12] * a[3] * a[6];
  inv[10] = a[0] * a[5] * a[15] - a[0] * a[7] * a[13] - a[4] * a[1] * a[15] + a[4] * a[3] * a[13] + a[12] * a[1] * a[7] - a[12] * a[3] * a[5];
  inv[14] = -a[0] * a[5] * a[14] + a[0] * a[6] * a[13] + a[4] * a[1] * a[14] - a[4] * a[2] * a[13] - a[12] * a[1] * a[6] + a[12] * a[2] * a[5];
  inv[3] = -a[1] * a[6] * a[11] + a[1] * a[7] * a[10] + a[5] * a[2] * a[11] - a[5] * a[3] * a[10] - a[9] * a[2] * a[7] + a[9] * a[3] * a[6];
  inv[7] = a[0] * a[6] * a[11] - a[0] * a[7] * a[10] - a[4] * a[2] * a[11] + a[4] * a[3] * a[10] + a[8] * a[2] * a[7] - a[8] * a[3] * a[6];
  inv[11] = -a[0] * a[5] * a[11] + a[0] * a[7] * a[9] + a[4] * a[1] * a[11] - a[4] * a[3] * a[9] - a[8] * a[1] * a[7] + a[8] * a[3] * a[5];
  inv[15] = a[0] * a[5] * a[10] - a[0] * a[6] * a[9] - a[4] * a[1] * a[10] + a[4] * a[2] * a[9] + a[8] * a[1] * a[6] - a[8] * a[2] * a[5];
  const det = a[0] * inv[0] + a[1] * inv[4] + a[2] * inv[8] + a[3] * inv[12];
  for (let i = 0; i < 16; i++) inv[i] /= det || 1;
}
