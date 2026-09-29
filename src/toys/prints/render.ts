// WebGL2 view: the painted surface under a forensic torch, powder shaded grain by grain from the
// powder grid, airborne grains as points, and the lifting tape (Peel It's film mesh) carrying its
// own snapshot of the powder it picked up.
//  1. surface + powder + brush head, one full-screen pass;
//  2. airborne grains (points);
//  3. tape: the film mesh, see-through, with the lifted powder on its adhesive;
//  4. tape shadow, stencilled so folds don't double up.

import type { Film } from '../peel/sim';
import { CAM_D } from '../peel/render';

const FLOATS = 11; // pos 3, normal 3, uv 2, strain, alpha, stuck

const COMMON = `
uniform vec2 uRes;
uniform vec3 uLight; // torch centre (device px, y up) and radius
uniform vec3 uPowderCol;
uniform float uSparkle;
uniform float uTime;
// Integer hash (a sin() hash quantises to 1/256 steps at these magnitudes, which shows as stray dots).
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(p) + 4096) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n >> 8) * (1.0 / 16777216.0);
}
// Soft shoulder so the torch pool on a white mug glows instead of clipping.
vec3 tone(vec3 c) {
  vec3 over = max(c - 0.78, 0.0);
  return min(c, 0.78) + 0.22 * (1.0 - exp(-over * 4.5));
}
// Cool room light plus a warm torch pool.
vec3 lighting(vec2 fc, out float spot) {
  float d = length(fc - uLight.xy) / uLight.z;
  spot = exp(-d * d * 1.4);
  float vig = 1.0 - 0.45 * pow(length(fc / uRes - 0.5) * 1.3, 2.0);
  return (vec3(0.42, 0.47, 0.6) * 0.78 + vec3(1.0, 0.9, 0.76) * spot * 0.95) * vig;
}
// Powder at grid coords g, from the field (loose, stuck, mask): grainy while it builds, solid on ridges.
vec4 powder(vec3 f, vec2 g, vec3 lit, float spot) {
  vec2 gp = floor(g * 2.0);
  float h1 = hash(gp), h2 = hash(gp + 31.7), h3 = hash(gp + 77.1);
  float st = smoothstep(0.1 + h1 * 0.3, 0.26 + h1 * 0.3, f.g);
  float lo = step(h2 + 0.002, f.r * 1.15) * (0.55 + 0.35 * h3);
  float a = max(st * (0.9 + 0.1 * h3), lo);
  vec3 c = uPowderCol * lit * (0.8 + 0.4 * h3);
  // Flake glints: a few grains catch the torch, and twinkle as it moves.
  float gl = step(0.93, hash(gp + floor(uLight.xy / 24.0)));
  c += uSparkle * gl * (0.25 + spot * 1.4) * vec3(1.0, 0.97, 0.9) * a;
  return vec4(c, a);
}
`;

const BG_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.99, 1.0);
}`;

const BG_FS = `#version 300 es
precision highp float;
uniform sampler2D uSurface;
uniform sampler2D uPowder;
uniform vec2 uGrid;
uniform float uCell;
uniform float uSheen;
uniform vec4 uBrush; // x, y (device px, y up), radius px, alpha
uniform float uBrushAng;
uniform vec4 uBlow; // x, y (device px, y up), radius px, strength
${COMMON}
out vec4 frag;
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec3 surf = texture(uSurface, fc / uRes).rgb;
  float spot;
  vec3 lit = lighting(fc, spot);
  vec3 col = surf * lit;
  vec2 g = vec2(fc.x, uRes.y - fc.y) / uCell;
  vec3 f = texture(uPowder, g / uGrid).rgb;
  // Latent sweat catches the raking light as a faint oily sheen.
  col += uSheen * f.b * spot * spot * 0.018 * vec3(0.9, 1.0, 1.1);
  vec4 p = powder(f, g, lit, spot);
  col = mix(col, p.rgb, p.a);
  // A puff of air: faint streaky rings racing outward from the nozzle.
  if (uBlow.w > 0.01) {
    vec2 d = fc - uBlow.xy;
    float rr = length(d) / uBlow.z;
    float streaks = 0.5 + 0.5 * hash(vec2(floor(atan(d.y, d.x) * 22.0), 3.0));
    float ring = 0.0;
    for (int i = 0; i < 2; i++) {
      float ph = fract(uTime * 2.2 + float(i) * 0.5);
      ring += exp(-pow((rr - ph * 1.1) * 7.0, 2.0)) * (1.0 - ph);
    }
    col += ring * streaks * uBlow.w * 0.07 * lit * smoothstep(1.2, 0.2, rr);
  }
  // Brush head from above: a soft shadow, then a swirl of splayed bristle tips, dusted with powder.
  if (uBrush.w > 0.0) {
    vec2 d = fc - uBrush.xy;
    float r = uBrush.z;
    float sh = length(d - vec2(0.35, -0.45) * r) / r;
    col *= 1.0 - 0.3 * uBrush.w * smoothstep(1.2, 0.5, sh);
    float rr = length(d) / r;
    float ang = atan(d.y, d.x) + uBrushAng + rr * 1.3;
    float fib = hash(vec2(floor(ang * 38.0), 1.0));
    float fib2 = hash(vec2(floor(ang * 110.0), floor(rr * 6.0)));
    float edge = 0.86 + 0.14 * fib;
    float body = smoothstep(edge, edge - 0.1, rr) * (0.3 + 0.7 * smoothstep(0.1, 0.95, rr));
    vec3 hair = mix(vec3(0.34, 0.24, 0.16), vec3(0.78, 0.64, 0.46), fib2);
    hair = mix(hair, uPowderCol, 0.35 * smoothstep(0.4, 0.95, rr));
    col = mix(col, hair * lit * (0.75 + 0.5 * fib), body * uBrush.w * 0.8);
  }
  frag = vec4(tone(col), 1.0);
}`;

const PT_VS = `#version 300 es
layout(location = 0) in vec4 aP; // x, y (cells), z, alpha
uniform float uCell;
${COMMON}
out vec3 vCol;
out float vA;
void main() {
  vec2 px = vec2(aP.x * uCell, uRes.y - aP.y * uCell);
  float spot;
  vec3 lit = lighting(px, spot);
  vCol = uPowderCol * lit * 1.1 + uSparkle * spot * 0.4;
  vA = aP.w;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uCell * (0.7 + aP.z * 1.8);
}`;

const PT_FS = `#version 300 es
precision mediump float;
in vec3 vCol;
in float vA;
out vec4 frag;
void main() {
  float d = length(gl_PointCoord - 0.5) * 2.0;
  frag = vec4(vCol, vA * smoothstep(1.0, 0.5, d));
}`;

const FILM_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec3 aMisc; // strain, alpha, stuck
uniform vec2 uScale;
uniform float uD;
uniform float uLay;
out vec3 vN;
out vec2 vUv;
out vec3 vMisc;
out float vZ;
void main() {
  vN = aNrm;
  vUv = aUv;
  vMisc = aMisc;
  // Laying down: the strip rolls on from the top, still raised where it hasn't touched yet.
  float z = aPos.z + 0.28 * clamp(((1.0 - aUv.y) - uLay * 1.25 + 0.25) * 4.0, 0.0, 1.0);
  vZ = z;
  vec2 c = aPos.xy * uScale;
  gl_Position = vec4(c * (uD / (uD - z)), 0.5 - z * 0.3, 1.0);
}`;

const FILM_FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec2 vUv;
in vec3 vMisc;
in float vZ;
uniform sampler2D uSurface;
uniform sampler2D uTape;
uniform sampler2D uArt;
uniform vec4 uRect; // tape's grid rect: x0, y0, w, h (cells)
${COMMON}
out vec4 frag;
void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 suv = fc / uRes;
  bool top = gl_FrontFacing;
  vec3 n = normalize(vN) * (top ? 1.0 : -1.0);
  if (n.z < 0.0) n = -n;
  vec3 L = normalize(vec3(-0.45, 0.55, 1.0));
  float dif = clamp(dot(n, L), 0.0, 1.0);
  float lift = clamp(vZ * 5.0, 0.0, 1.0);
  float spot;
  vec3 lit = lighting(fc, spot);
  // Clear tape: the surface through it, a touch hazed and softer.
  vec2 px = 1.5 / uRes;
  vec3 thr = (texture(uSurface, suv).rgb * 0.4 + texture(uSurface, suv + px).rgb * 0.3 + texture(uSurface, suv - px).rgb * 0.3) * lit;
  vec3 col = mix(thr, vec3(0.8, 0.84, 0.9) * lit, 0.07 + 0.1 * lift);
  if (!top) col = mix(col, vec3(1.0) * lit, 0.08);
  vec4 art = texture(uArt, vUv);
  col = mix(col, art.rgb * lit * (0.7 + 0.4 * dif), art.a);
  // The powder it picked up rides on the adhesive.
  vec2 tuv = vec2(vUv.x, 1.0 - vUv.y);
  vec3 f = texture(uTape, tuv).rgb;
  vec4 p = powder(f, uRect.xy + tuv * uRect.zw, lit * (0.85 + 0.3 * dif), spot);
  col = mix(col, p.rgb, p.a * (1.0 - art.a * 0.8));
  col *= 0.94 + 0.12 * dif;
  // A window-streak reflection sliding along the curl, specular, fresnel, and the wet peel front.
  vec3 r = vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0);
  float s = dot(r.xy, vec2(0.62, 0.78)) * 2.2 + (suv.x - suv.y) * 0.5;
  float streak = exp(-pow((s - 0.28) * 5.0, 2.0)) * 0.22 + exp(-pow((s + 0.55) * 9.0, 2.0)) * 0.1;
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, H), 0.0), 90.0) * 0.35;
  float fres = pow(1.0 - n.z, 2.5) * 0.35;
  col += (streak * (0.3 + 0.7 * lift) + spec + fres) * (0.5 + 0.5 * spot);
  col = mix(col, vec3(1.0), clamp(vMisc.x * 2.2, 0.0, 0.5));
  float front = 1.0 - abs(vMisc.z * 2.0 - 1.0);
  col += smoothstep(0.35, 0.95, front) * 0.2;
  // Cut edges catch the light.
  float e = min(min(vUv.x, 1.0 - vUv.x), min(vUv.y, 1.0 - vUv.y));
  col += smoothstep(0.012, 0.0, e) * 0.25;
  frag = vec4(tone(col), vMisc.y);
}`;

const SHADOW_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec3 aMisc;
uniform vec2 uScale;
uniform float uLay;
out float vA;
void main() {
  float z = aPos.z + 0.28 * clamp(((1.0 - aUv.y) - uLay * 1.25 + 0.25) * 4.0, 0.0, 1.0);
  vec2 p = aPos.xy + vec2(0.45, -0.6) * z;
  vA = 0.42 * smoothstep(0.0, 0.06, z) / (1.0 + z * 2.5) * aMisc.y;
  gl_Position = vec4(p * uScale, 0.5 - 0.004 * 0.3, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision mediump float;
in float vA;
out vec4 frag;
void main() {
  if (vA < 0.004) discard;
  frag = vec4(0.0, 0.0, 0.02, vA);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const prog = gl.createProgram()!;
  for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader error');
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link error');
  const u = new Map<string, WebGLUniformLocation | null>();
  return { prog, u: (name: string) => (u.has(name) ? u.get(name)! : (u.set(name, gl.getUniformLocation(prog, name)), u.get(name)!)) };
}

export interface View {
  w: number;
  h: number;
  cell: number;
  /** World → clip scale (the world origin is the canvas centre). */
  scale: [number, number];
  light: [number, number, number];
  powder: [number, number, number];
  sparkle: number;
  sheen: number;
  brush: [number, number, number, number];
  brushAng: number;
  blow: [number, number, number, number];
  time: number;
}

export interface Parts {
  x: Float32Array;
  y: Float32Array;
  z: Float32Array;
  life: Float32Array;
  n: number;
}

export class PrintsRenderer {
  private bg;
  private pt;
  private film;
  private shadow;
  private empty: WebGLVertexArrayObject;
  private ptVao: WebGLVertexArrayObject;
  private ptBuf: WebGLBuffer;
  private ptData = new Float32Array(3200 * 4);
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private data = new Float32Array(0);
  private idx = new Uint16Array(0);
  private count = 0;
  private topology = -1;
  private flying = -1;
  private surface: WebGLTexture;
  private powder: WebGLTexture;
  private tape: WebGLTexture;
  private art: WebGLTexture;
  private gw = 1;
  private gh = 1;
  /** Tape grid rect (cells) and lay-down progress. */
  rect: [number, number, number, number] = [0, 0, 1, 1];
  lay = 1;

  constructor(private gl: WebGL2RenderingContext) {
    this.bg = compile(gl, BG_VS, BG_FS);
    this.pt = compile(gl, PT_VS, PT_FS);
    this.film = compile(gl, FILM_VS, FILM_FS);
    this.shadow = compile(gl, SHADOW_VS, SHADOW_FS);
    this.empty = gl.createVertexArray()!;
    this.ptVao = gl.createVertexArray()!;
    this.ptBuf = gl.createBuffer()!;
    gl.bindVertexArray(this.ptVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.ptData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    this.vao = gl.createVertexArray()!;
    this.vbo = gl.createBuffer()!;
    this.ibo = gl.createBuffer()!;
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    const stride = FLOATS * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, stride, 12);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 2, gl.FLOAT, false, stride, 24);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 3, gl.FLOAT, false, stride, 32);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
    gl.bindVertexArray(null);
    this.surface = this.texture();
    this.powder = this.texture();
    this.tape = this.texture();
    this.art = this.texture();
  }

  private texture() {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return t;
  }

  /** Canvases upload flipped so texture v runs up like gl_FragCoord. */
  uploadCanvas(which: 'surface' | 'art', src: HTMLCanvasElement) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, which === 'surface' ? this.surface : this.art);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
  }

  /** Powder grid: RGBA8, row 0 = top of the screen. */
  setGrid(w: number, h: number, data: Uint8Array) {
    const gl = this.gl;
    this.gw = w;
    this.gh = h;
    gl.bindTexture(gl.TEXTURE_2D, this.powder);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  uploadRows(data: Uint8Array, y0: number, y1: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.powder);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, this.gw, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, data.subarray(y0 * this.gw * 4, y1 * this.gw * 4));
  }

  /** The tape's snapshot of the powder under it (RGBA8, row 0 = top). */
  setTape(w: number, h: number, data: Uint8Array) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tape);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  setFilm(f: Film) {
    this.data = new Float32Array(f.n * FLOATS);
    this.idx = new Uint16Array(f.nt * 3);
    this.topology = -1;
    this.flying = -1;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
  }

  private common(u: (n: string) => WebGLUniformLocation | null, v: View) {
    const gl = this.gl;
    gl.uniform2f(u('uRes'), v.w, v.h);
    gl.uniform3fv(u('uLight'), v.light);
    gl.uniform3fv(u('uPowderCol'), v.powder);
    gl.uniform1f(u('uSparkle'), v.sparkle);
    gl.uniform1f(u('uTime'), v.time);
  }

  draw(v: View, parts: Parts, film: Film | null, flyingCount: number) {
    const gl = this.gl;
    gl.viewport(0, 0, v.w, v.h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);

    // 1. surface and powder
    let u = this.bg.u;
    gl.useProgram(this.bg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surface);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.powder);
    gl.uniform1i(u('uSurface'), 0);
    gl.uniform1i(u('uPowder'), 1);
    gl.uniform2f(u('uGrid'), this.gw, this.gh);
    gl.uniform1f(u('uCell'), v.cell);
    gl.uniform1f(u('uSheen'), v.sheen);
    gl.uniform4fv(u('uBrush'), v.brush);
    gl.uniform1f(u('uBrushAng'), v.brushAng);
    gl.uniform4fv(u('uBlow'), v.blow);
    this.common(u, v);
    gl.bindVertexArray(this.empty);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    // 2. airborne grains
    if (parts.n) {
      const d = this.ptData;
      for (let i = 0; i < parts.n; i++) {
        d[i * 4] = parts.x[i];
        d[i * 4 + 1] = parts.y[i];
        d[i * 4 + 2] = parts.z[i];
        d[i * 4 + 3] = Math.min(0.85, parts.life[i] * 2);
      }
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.pt.prog);
      u = this.pt.u;
      gl.uniform1f(u('uCell'), v.cell);
      this.common(u, v);
      gl.bindVertexArray(this.ptVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, parts.n * 4);
      gl.drawArrays(gl.POINTS, 0, parts.n);
      gl.disable(gl.BLEND);
    }
    if (film) this.drawFilm(film, v, flyingCount);
    gl.bindVertexArray(null);
  }

  private drawFilm(f: Film, v: View, flyingCount: number) {
    const gl = this.gl;
    const d = this.data;
    for (let i = 0; i < f.n; i++) {
      const o = i * FLOATS;
      d[o] = f.pos[i * 3];
      d[o + 1] = f.pos[i * 3 + 1];
      d[o + 2] = f.pos[i * 3 + 2];
      d[o + 3] = f.normal[i * 3];
      d[o + 4] = f.normal[i * 3 + 1];
      d[o + 5] = f.normal[i * 3 + 2];
      d[o + 6] = f.uv[i * 2];
      d[o + 7] = f.uv[i * 2 + 1];
      d[o + 8] = f.strain[i];
      d[o + 9] = f.alpha[i];
      d[o + 10] = f.stuck[i] || !f.sticky[i] ? 1 : 0;
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, d);
    if (f.topology !== this.topology || flyingCount !== this.flying) {
      this.topology = f.topology;
      this.flying = flyingCount;
      let k = 0;
      for (let t = 0; t < f.nt; t++) {
        if (!f.triAlive[t]) continue;
        const a = f.tris[t * 3], b = f.tris[t * 3 + 1], c = f.tris[t * 3 + 2];
        if (f.fly[a] === 2 || f.fly[b] === 2 || f.fly[c] === 2) continue;
        this.idx[k++] = a;
        this.idx[k++] = b;
        this.idx[k++] = c;
      }
      this.count = k;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx.subarray(0, k), gl.DYNAMIC_DRAW);
    }
    if (!this.count) return;
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.film.prog);
    const u = this.film.u;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.surface);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.tape);
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_2D, this.art);
    gl.uniform1i(u('uSurface'), 0);
    gl.uniform1i(u('uTape'), 2);
    gl.uniform1i(u('uArt'), 3);
    gl.uniform4fv(u('uRect'), this.rect);
    gl.uniform2f(u('uScale'), v.scale[0], v.scale[1]);
    gl.uniform1f(u('uD'), CAM_D);
    gl.uniform1f(u('uLay'), this.lay);
    this.common(u, v);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);

    gl.useProgram(this.shadow.prog);
    gl.uniform2f(this.shadow.u('uScale'), v.scale[0], v.scale[1]);
    gl.uniform1f(this.shadow.u('uLay'), this.lay);
    gl.depthMask(false);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.EQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.depthMask(true);
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
