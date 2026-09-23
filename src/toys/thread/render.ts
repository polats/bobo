import { compile, Program } from '../../shell/gl';
import type { Knit } from './sim';
import type { Mat4, Vec3 } from '../cloth/math';

export type Palette = [number, number, number][];

export const PALETTES: Record<string, Palette> = {
  berry: [[0.62, 0.08, 0.22], [0.93, 0.86, 0.74], [0.36, 0.1, 0.36], [0.95, 0.55, 0.45]],
  forest: [[0.22, 0.42, 0.22], [0.9, 0.84, 0.7], [0.66, 0.3, 0.12], [0.14, 0.26, 0.2]],
  ocean: [[0.1, 0.22, 0.48], [0.9, 0.9, 0.86], [0.1, 0.5, 0.55], [0.95, 0.7, 0.2]],
  candy: [[0.98, 0.55, 0.7], [0.62, 0.86, 0.95], [0.99, 0.94, 0.66], [0.72, 0.6, 0.95]],
};

/** Rows per stripe; shared by the knit shader and the yarn colouring so unravelled yarn matches. */
export const STRIPE_ROWS = 3;

/** Rendered points per simulated yarn segment (Catmull-Rom), so crimps read as soft curls. */
const SUBDIV = 3;

export function rowColor(p: Palette, row: number): [number, number, number] {
  return p[Math.floor(row / STRIPE_ROWS) % p.length];
}

const knitVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 viewProj;
out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vPos = aPos;
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = viewProj * vec4(aPos, 1.0);
}`;

const knitFrag = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
in vec2 vUv;   // stitch units: x = column, y = row (downward)
uniform vec3 eye;
uniform vec3 lightDir;
uniform vec3 palette[4];
uniform float stripeRows;
out vec4 fragColor;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

float sdSeg(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

// Height of one knit "V": two plump legs leaning in to meet at the bottom, overlapping the rows around it.
float legs(vec2 p) {
  float r = 0.23;
  float d1 = sdSeg(p, vec2(0.1, -0.12), vec2(0.47, 0.92));
  float d2 = sdSeg(p, vec2(0.9, -0.12), vec2(0.53, 0.92));
  float h1 = sqrt(max(0.0, 1.0 - (d1 / r) * (d1 / r)));
  float h2 = sqrt(max(0.0, 1.0 - (d2 / r) * (d2 / r)));
  // Right leg sits slightly over the left, as in real stockinette.
  return max(h1 * 0.92, h2);
}

float knitHeight(vec2 uv) {
  vec2 p = fract(uv);
  return max(legs(p), max(legs(p + vec2(0.0, 1.0)), legs(p - vec2(0.0, 1.0))) * 0.9);
}

void main() {
  vec3 N = normalize(vNormal);
  bool front = gl_FrontFacing;
  if (!front) N = -N;

  // Tangent frame from screen-space derivatives, so no tangent attribute is needed.
  vec3 dp1 = dFdx(vPos), dp2 = dFdy(vPos);
  vec2 duv1 = dFdx(vUv), duv2 = dFdy(vUv);
  vec3 dp2perp = cross(dp2, N), dp1perp = cross(N, dp1);
  vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
  vec3 B = dp2perp * duv1.y + dp1perp * duv2.y;
  float invmax = inversesqrt(max(max(dot(T, T), dot(B, B)), 1e-12));
  mat3 TBN = mat3(T * invmax, B * invmax, N);

  float e = 0.03;
  float h = knitHeight(vUv);
  float hx = knitHeight(vUv + vec2(e, 0.0)) - knitHeight(vUv - vec2(e, 0.0));
  float hy = knitHeight(vUv + vec2(0.0, e)) - knitHeight(vUv - vec2(0.0, e));
  vec3 nT = normalize(vec3(-hx * 1.6, -hy * 1.6, 2.0 * e * 4.0));
  vec3 n = normalize(TBN * nT);

  float row = floor(vUv.y);
  vec3 base = palette[int(mod(floor(row / stripeRows), 4.0))];
  base *= 0.92 + 0.16 * hash(floor(vUv) + 3.7);            // stitch-to-stitch variation
  base *= 0.9 + 0.1 * hash(floor(vUv * 9.0));               // fibre fuzz
  if (!front) base *= 0.75;

  vec3 L = -lightDir;
  vec3 V = normalize(eye - vPos);
  float wrap = 0.4;
  float diff = clamp((dot(n, L) + wrap) / (1.0 + wrap), 0.0, 1.0);
  float ao = mix(0.35, 1.0, smoothstep(0.0, 0.7, h));       // dark valleys between loops
  float sheen = pow(1.0 - abs(dot(n, V)), 3.0) * 0.45;
  vec3 col = base * (0.28 + 0.9 * diff) * ao + base * sheen * ao;
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

const tubeVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aSide;
layout(location = 2) in vec3 aTangent;
layout(location = 3) in vec2 aAcrossAlong;
layout(location = 4) in vec4 aColor;   // rgb, a = ply twist strength
uniform mat4 viewProj;
out vec3 vPos;
out vec3 vSide;
out vec3 vTangent;
out vec2 vAA;
out vec4 vColor;
void main() {
  vPos = aPos;
  vSide = aSide;
  vTangent = aTangent;
  vAA = aAcrossAlong;
  vColor = aColor;
  gl_Position = viewProj * vec4(aPos, 1.0);
}`;

const tubeFrag = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vSide;
in vec3 vTangent;
in vec2 vAA;
in vec4 vColor;
uniform vec3 eye;
uniform vec3 lightDir;
out vec4 fragColor;
void main() {
  float a = clamp(vAA.x, -1.0, 1.0);
  vec3 V = normalize(eye - vPos);
  vec3 S = normalize(vSide);
  vec3 n = normalize(S * a + V * sqrt(max(0.0, 1.0 - a * a)));
  vec3 T = normalize(vTangent);
  vec3 L = -lightDir;
  float diff = clamp((dot(n, L) + 0.35) / 1.35, 0.0, 1.0);
  // Plies twisting around the strand: helical dark grooves.
  float twist = sin((vAA.y * 2.2 + a * 0.9) * 6.2831);
  float ply = mix(1.0, 0.72 + 0.28 * smoothstep(-0.6, 0.6, twist), vColor.a);
  // Kajiya-Kay highlight along the fibre direction.
  vec3 H = normalize(L + V);
  float th = dot(T, H);
  float spec = pow(sqrt(max(0.0, 1.0 - th * th)), 60.0) * 0.25 * vColor.a;
  float rim = 1.0 - a * a;
  vec3 col = vColor.rgb * (0.3 + 0.85 * diff) * ply * mix(0.6, 1.0, rim) + spec;
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

const roomVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 viewProj;
out vec3 vPos;
void main() {
  vPos = aPos;
  gl_Position = viewProj * vec4(aPos, 1.0);
}`;

const roomFrag = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
uniform float floorY;
uniform vec3 shadowAt;  // xz centre + radius of the soft contact shadow under the garment
out vec4 fragColor;
void main() {
  vec3 col;
  if (abs(vPos.y - floorY) < 0.001) {
    float board = floor(vPos.x * 5.0);
    float grain = sin(vPos.z * 30.0 + sin(vPos.x * 4.0 + board) * 3.0) * 0.5 + 0.5;
    col = vec3(0.5, 0.33, 0.2) * (0.86 + 0.14 * grain) * (0.9 + 0.1 * fract(sin(board * 91.7) * 43758.5));
    col *= 0.93 + 0.07 * smoothstep(0.0, 0.04, fract(vPos.x * 5.0));
    float d = length(vPos.xz - shadowAt.xy) / shadowAt.z;
    col *= 1.0 - 0.35 * exp(-d * d * 2.0);
  } else {
    // Warm cabin wall with a soft window glow.
    col = mix(vec3(0.16, 0.1, 0.08), vec3(0.42, 0.3, 0.22), smoothstep(-1.2, 1.8, vPos.y));
    col += vec3(0.35, 0.25, 0.12) * exp(-length(vPos.xy - vec2(0.2, 1.2)) * 1.4) * 0.6;
  }
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

const puffVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPuff;   // xyz, life 0..1
layout(location = 1) in vec3 aColor;
uniform mat4 viewProj;
uniform float pxScale;
out float vLife;
out vec3 vColor;
void main() {
  vec4 clip = viewProj * vec4(aPuff.xyz, 1.0);
  gl_Position = clip;
  gl_PointSize = pxScale * (0.4 + (1.0 - aPuff.w) * 0.9) / clip.w;
  vLife = aPuff.w;
  vColor = aColor;
}`;

const puffFrag = /* glsl */ `#version 300 es
precision highp float;
in float vLife;
in vec3 vColor;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.0, length(d)) * vLife * 0.85;
  fragColor = vec4(pow(vColor * 1.2, vec3(1.0 / 2.2)) * a, a);
}`;

interface Puff {
  x: number; y: number; z: number; vx: number; vy: number; vz: number; life: number; color: [number, number, number];
}

export class KnitRenderer {
  private knit: Program;
  private tube: Program;
  private room: Program;
  private puffP: Program;
  private knitVao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private nrmBuf: WebGLBuffer;
  private idxBuf: WebGLBuffer;
  private idxCount = 0;
  private topology = -1;
  private normals: Float32Array;
  private tubeVao: WebGLVertexArrayObject;
  private tubeBuf: WebGLBuffer;
  private tubeData: Float32Array;
  private roomVao: WebGLVertexArrayObject;
  private puffVao: WebGLVertexArrayObject;
  private puffBuf: WebGLBuffer;
  private puffs: Puff[] = [];
  private joined = new Float32Array(0);
  private smooth = new Float32Array(0);
  palette: Palette = PALETTES.berry;
  private readonly bufs: WebGLBuffer[] = [];

  constructor(private gl: WebGL2RenderingContext, private sim: Knit) {
    this.knit = new Program(gl, compile(gl, gl.VERTEX_SHADER, knitVert), knitFrag);
    this.tube = new Program(gl, compile(gl, gl.VERTEX_SHADER, tubeVert), tubeFrag);
    this.room = new Program(gl, compile(gl, gl.VERTEX_SHADER, roomVert), roomFrag);
    this.puffP = new Program(gl, compile(gl, gl.VERTEX_SHADER, puffVert), puffFrag);

    this.normals = new Float32Array(sim.np * 3);
    this.knitVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.knitVao);
    this.posBuf = this.attrib(0, 3, sim.pos, gl.DYNAMIC_DRAW);
    this.nrmBuf = this.attrib(1, 3, this.normals, gl.DYNAMIC_DRAW);
    this.attrib(2, 2, sim.uv, gl.STATIC_DRAW);
    this.idxBuf = gl.createBuffer()!;
    this.bufs.push(this.idxBuf);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);

    // Tube strip: per vertex pos3 side3 tangent3 across/along2 color4 = 15 floats; 2 verts per point.
    // Room for the yarn strand, a break, and the needle.
    this.tubeData = new Float32Array(((sim.cap + 1) * SUBDIV + 40 + sim.cols * 7) * 2 * 15);
    this.tubeVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.tubeVao);
    this.tubeBuf = gl.createBuffer()!;
    this.bufs.push(this.tubeBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tubeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.tubeData.byteLength, gl.DYNAMIC_DRAW);
    const stride = 15 * 4;
    const layout: [number, number, number][] = [[0, 3, 0], [1, 3, 3], [2, 3, 6], [3, 2, 9], [4, 4, 11]];
    for (const [loc, size, off] of layout) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
    }

    const f = sim.floorY;
    const zw = -1.0;
    const room = new Float32Array([
      -6, f, zw, 6, f, zw, -6, f, 6, 6, f, zw, 6, f, 6, -6, f, 6,
      -6, f, zw, 6, f, zw, -6, 6, zw, 6, f, zw, 6, 6, zw, -6, 6, zw,
    ]);
    this.roomVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.roomVao);
    this.attrib(0, 3, room, gl.STATIC_DRAW);

    this.puffVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.puffVao);
    this.puffBuf = gl.createBuffer()!;
    this.bufs.push(this.puffBuf);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.puffBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 256 * 7 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 28, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 28, 16);
    gl.bindVertexArray(null);
  }

  private attrib(loc: number, size: number, data: Float32Array, usage: number) {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    this.bufs.push(buf);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return buf;
  }

  /** Fibre puff burst where a stitch popped. */
  burst(x: number, y: number, z: number, color: [number, number, number]) {
    for (let i = 0; i < 7; i++) {
      if (this.puffs.length >= 256) this.puffs.shift();
      const a = Math.random() * Math.PI * 2;
      const s = 0.25 + Math.random() * 0.45;
      this.puffs.push({ x, y, z: z + 0.02, vx: Math.cos(a) * s, vy: Math.sin(a) * s + 0.25, vz: (Math.random() - 0.3) * s, life: 1, color });
    }
  }

  private updateKnit() {
    const gl = this.gl;
    const s = this.sim;
    const pc = s.cols + 1;
    if (s.topology !== this.topology) {
      this.topology = s.topology;
      const idx = new Uint32Array(s.rows * s.cols * 6);
      let k = 0;
      for (let r = 0; r < s.rows; r++)
        for (let c = 0; c < s.cols; c++) {
          if (!s.stitchAlive[r * s.cols + c]) continue;
          const a = r * pc + c, b = a + 1, d = a + pc, e = d + 1;
          idx[k++] = a; idx[k++] = d; idx[k++] = e;
          idx[k++] = a; idx[k++] = e; idx[k++] = b;
        }
      this.idxCount = k;
      gl.bindVertexArray(this.knitVao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.subarray(0, k), gl.DYNAMIC_DRAW);
    }
    // Vertex normals from the grid (central differences), cheap and smooth.
    const p = s.pos;
    const nrm = this.normals;
    for (let r = 0; r <= s.rows; r++)
      for (let c = 0; c <= s.cols; c++) {
        const i = r * pc + c;
        const l = r * pc + Math.max(0, c - 1), rr = r * pc + Math.min(s.cols, c + 1);
        const u = Math.max(0, r - 1) * pc + c, d = Math.min(s.rows, r + 1) * pc + c;
        const tx = p[rr * 3] - p[l * 3], ty = p[rr * 3 + 1] - p[l * 3 + 1], tz = p[rr * 3 + 2] - p[l * 3 + 2];
        const bx = p[u * 3] - p[d * 3], by = p[u * 3 + 1] - p[d * 3 + 1], bz = p[u * 3 + 2] - p[d * 3 + 2];
        nrm[i * 3] = ty * bz - tz * by;
        nrm[i * 3 + 1] = tz * bx - tx * bz;
        nrm[i * 3 + 2] = tx * by - ty * bx;
      }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, p);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, nrm);
  }

  /** Writes a camera-facing strip for a polyline; returns the new vertex count. */
  private strip(v: number, pts: Float32Array, n: number, radius: number, eye: Vec3, color: (i: number) => [number, number, number], ply: number, alongScale: number) {
    const d = this.tubeData;
    let along = 0;
    for (let i = 0; i < n; i++) {
      const o = i * 3;
      const ip = Math.max(0, i - 1) * 3, inx = Math.min(n - 1, i + 1) * 3;
      let tx = pts[inx] - pts[ip], ty = pts[inx + 1] - pts[ip + 1], tz = pts[inx + 2] - pts[ip + 2];
      const tl = Math.hypot(tx, ty, tz) || 1;
      tx /= tl; ty /= tl; tz /= tl;
      if (i > 0) along += Math.hypot(pts[o] - pts[o - 3], pts[o + 1] - pts[o - 2], pts[o + 2] - pts[o - 1]);
      const vx = eye[0] - pts[o], vy = eye[1] - pts[o + 1], vz = eye[2] - pts[o + 2];
      let sx = ty * vz - tz * vy, sy = tz * vx - tx * vz, sz = tx * vy - ty * vx;
      const sl = Math.hypot(sx, sy, sz) || 1;
      sx /= sl; sy /= sl; sz /= sl;
      const [cr, cg, cb] = color(i);
      for (const side of [-1, 1]) {
        const k = v * 15;
        d[k] = pts[o] + sx * radius * side;
        d[k + 1] = pts[o + 1] + sy * radius * side;
        d[k + 2] = pts[o + 2] + sz * radius * side;
        d[k + 3] = sx; d[k + 4] = sy; d[k + 5] = sz;
        d[k + 6] = tx; d[k + 7] = ty; d[k + 8] = tz;
        d[k + 9] = side;
        d[k + 10] = along / alongScale;
        d[k + 11] = cr; d[k + 12] = cg; d[k + 13] = cb; d[k + 14] = ply;
        v++;
      }
    }
    return v;
  }

  draw(width: number, height: number, viewProj: Mat4, eye: Vec3, dt: number) {
    const gl = this.gl;
    const s = this.sim;
    this.updateKnit();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.08, 0.06, 0.05, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const L: Vec3 = normalize3([-0.35, -0.55, -0.8]);

    let u = this.room.use();
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform1f(u.floorY, s.floorY);
    gl.uniform3f(u.shadowAt, 0.05, -0.05, 0.9);
    gl.bindVertexArray(this.roomVao);
    gl.drawArrays(gl.TRIANGLES, 0, 12);

    if (this.idxCount) {
      u = this.knit.use();
      gl.uniformMatrix4fv(u.viewProj, false, viewProj);
      gl.uniform3f(u.eye, eye[0], eye[1], eye[2]);
      gl.uniform3f(u.lightDir, L[0], L[1], L[2]);
      gl.uniform3fv(u['palette[0]'], new Float32Array(this.palette.flat()));
      gl.uniform1f(u.stripeRows, 3);
      gl.bindVertexArray(this.knitVao);
      gl.drawElements(gl.TRIANGLES, this.idxCount, gl.UNSIGNED_INT, 0);
    }

    // Yarn strand, then (after a degenerate break) the wooden needle.
    let v = 0;
    const pal = this.palette;
    if (s.rn >= 1) {
      // The strand runs on into the knit at its anchor, so it never looks detached.
      const n = s.rn + 1;
      if (this.joined.length < n * 3) this.joined = new Float32Array((s.cap + 1) * 3);
      const j = this.joined;
      j.set(s.rpos.subarray(0, s.rn * 3));
      j.set(s.pos.subarray(s.anchor * 3, s.anchor * 3 + 3), s.rn * 3);
      const m = (n - 1) * SUBDIV + 1;
      if (this.smooth.length < m * 3) this.smooth = new Float32Array(((s.cap + 1) * SUBDIV + 1) * 3);
      catmullRom(j, n, SUBDIV, this.smooth);
      // The strand between the finger and the knit brightens as it pulls taut: the knot is about to give.
      const glow = s.grabbedRod >= 0 ? smoothstep(0.82, 1.0, s.tension) * 0.45 : 0;
      const g0 = s.grabbedRod;
      v = this.strip(0, this.smooth, m, s.yarnR, eye, (i) => {
        const pi = Math.min(Math.floor(i / SUBDIV), s.rn - 1);
        const c = rowColor(pal, s.rrow[pi]);
        if (glow <= 0 || pi < g0) return c;
        return [c[0] + (1 - c[0]) * glow, c[1] + (1 - c[1]) * glow, c[2] + (1 - c[2]) * glow];
      }, 1, s.yarnR * 5);
    }
    const strand = v;
    // The needle is dead straight, so two points make a seamless strip (more points made the camera-facing
    // strip jog at each joint, which read as notches along the top edge).
    const needleR = s.sw * 0.28;
    const half = s.width / 2 + 0.2;
    const needle = new Float32Array([-half, s.topY + 0.004, 0, half, s.topY + 0.004, 0]);
    const needleStart = v;
    v = this.strip(v, needle, 2, needleR, eye, () => [0.62, 0.42, 0.22], 0, 1);
    // Live loops of the top row wrap over the needle.
    const loops: number[] = [];
    const loop = new Float32Array(7 * 3);
    const lr = needleR + s.yarnR * 0.9;
    for (let c = 0; c < s.cols; c++) {
      if (!s.stitchAlive[c]) continue;
      const a = s.pid(0, c) * 3, b = s.pid(0, c + 1) * 3;
      const x = (s.pos[a] + s.pos[b]) / 2;
      const z = (s.pos[a + 2] + s.pos[b + 2]) / 2;
      for (let k = 0; k < 7; k++) {
        // From the front of the knit, up over the needle, and down behind it.
        const ang = -Math.PI / 2 + (k / 6) * Math.PI * 1.25;
        loop.set([x + (k - 3) * s.sw * 0.03, s.topY + 0.004 + Math.sin(ang) * lr, z + Math.cos(ang) * lr], k * 3);
      }
      loops.push(v);
      const col = rowColor(pal, 0);
      v = this.strip(v, loop, 7, s.yarnR * 1.15, eye, () => col, 1, s.yarnR * 5);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.tubeBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.tubeData.subarray(0, v * 15));
    u = this.tube.use();
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform3f(u.eye, eye[0], eye[1], eye[2]);
    gl.uniform3f(u.lightDir, L[0], L[1], L[2]);
    gl.bindVertexArray(this.tubeVao);
    if (strand) gl.drawArrays(gl.TRIANGLE_STRIP, 0, strand);
    gl.drawArrays(gl.TRIANGLE_STRIP, needleStart, 4);
    for (const start of loops) gl.drawArrays(gl.TRIANGLE_STRIP, start, 14);

    // Fibre puffs.
    const alive = this.puffs;
    for (const p of alive) {
      p.vy -= 0.8 * dt;
      p.vx *= 0.96; p.vy *= 0.96; p.vz *= 0.96;
      p.x += p.vx * dt; p.y += p.vy * dt; p.z += p.vz * dt;
      p.life -= dt * 1.4;
    }
    this.puffs = alive.filter((p) => p.life > 0);
    if (this.puffs.length) {
      const data = new Float32Array(this.puffs.length * 7);
      this.puffs.forEach((p, i) => data.set([p.x, p.y, p.z, p.life, ...p.color], i * 7));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.puffBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      u = this.puffP.use();
      gl.uniformMatrix4fv(u.viewProj, false, viewProj);
      gl.uniform1f(u.pxScale, height * 0.05);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.depthMask(false);
      gl.bindVertexArray(this.puffVao);
      gl.drawArrays(gl.POINTS, 0, this.puffs.length);
      gl.depthMask(true);
      gl.disable(gl.BLEND);
    }
  }

  destroy() {
    const gl = this.gl;
    this.bufs.forEach((b) => gl.deleteBuffer(b));
    for (const vao of [this.knitVao, this.tubeVao, this.roomVao, this.puffVao]) gl.deleteVertexArray(vao);
    for (const p of [this.knit, this.tube, this.room, this.puffP]) gl.deleteProgram(p.program);
  }
}

function catmullRom(src: Float32Array, n: number, sub: number, out: Float32Array) {
  let k = 0;
  for (let i = 0; i < n - 1; i++) {
    const i0 = Math.max(0, i - 1) * 3, i1 = i * 3, i2 = (i + 1) * 3, i3 = Math.min(n - 1, i + 2) * 3;
    for (let s = 0; s < sub; s++) {
      const t = s / sub, t2 = t * t, t3 = t2 * t;
      for (let c = 0; c < 3; c++) {
        const p0 = src[i0 + c], p1 = src[i1 + c], p2 = src[i2 + c], p3 = src[i3 + c];
        out[k++] = 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
      }
    }
  }
  out[k++] = src[(n - 1) * 3];
  out[k++] = src[(n - 1) * 3 + 1];
  out[k++] = src[(n - 1) * 3 + 2];
}

function smoothstep(a: number, b: number, x: number) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

function normalize3(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}
