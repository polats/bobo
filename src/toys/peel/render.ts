// WebGL2 view of the peel: a top-down, slightly perspective camera over the surface.
//  1. background: the sharp surface texture plus a gloss sweep on shiny parts (the reveal);
//  2. film: one draw of the sheet mesh; it looks through itself by sampling the surface texture at
//     its own screen position, blurred and hazed, so what's under the film is visibly duller than
//     what you've revealed. Height tint, an environment streak that runs along the curl, strain
//     whitening, a bright wet line along the peel front and an adhesive sheen on the underside;
//  3. shadow: the lifted film projected onto the surface, stencilled so folds don't double up.

import type { Film } from './sim';

/** Camera distance above the surface, in world units: lifted film grows a touch as it nears you. */
export const CAM_D = 4;

const FLOATS = 11; // pos 3, normal 3, uv 2, strain, alpha, stuck

const BG_VS = `#version 300 es
out vec2 vUv;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUv = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.99, 1.0);
}`;

const BG_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uBase;
uniform sampler2D uGloss;
uniform float uTime;
uniform float uFlash;
out vec4 frag;
void main() {
  vec3 col = texture(uBase, vUv).rgb;
  float g = texture(uGloss, vUv).r;
  // A slow sheen crossing the shiny parts, and a bright sweep when the film comes off.
  float d = vUv.x * 0.8 + vUv.y;
  float t = fract(uTime * 0.09) * 3.0 - 0.6;
  float band = exp(-pow((d - t) * 9.0, 2.0)) * 0.22 + exp(-pow((d - t + 0.12) * 30.0, 2.0)) * 0.18;
  float flash = uFlash > 0.0 ? exp(-pow((d - uFlash * 2.6 + 0.4) * 7.0, 2.0)) * 0.32 : 0.0;
  col += g * (band + flash) * vec3(1.0, 0.98, 0.95);
  frag = vec4(col, 1.0);
}`;

const FILM_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNrm;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec3 aMisc; // strain, alpha, stuck
uniform vec2 uScale;
uniform vec2 uOffset;
uniform float uD;
out vec3 vN;
out vec2 vUv;
out vec3 vMisc;
out float vZ;
void main() {
  vN = aNrm;
  vUv = aUv;
  vMisc = aMisc;
  vZ = aPos.z;
  vec2 c = aPos.xy * uScale + uOffset;
  gl_Position = vec4(c * (uD / (uD - aPos.z)), 0.5 - aPos.z * 0.3, 1.0);
}`;

const FILM_FS = `#version 300 es
precision highp float;
in vec3 vN;
in vec2 vUv;
in vec3 vMisc;
in float vZ;
uniform sampler2D uBase;
uniform sampler2D uPrint;
uniform vec2 uRes;
uniform vec3 uTint;
uniform vec3 uBack;
uniform float uHaze;
uniform float uOpaque;
uniform float uCutout;
uniform float uBlur;
out vec4 frag;

vec3 through(vec2 suv) {
  // A soft 7-tap blur: the film diffuses what's under it a little.
  vec2 px = uBlur / uRes;
  vec3 c = texture(uBase, suv).rgb * 0.28;
  c += texture(uBase, suv + vec2(1.0, 0.0) * px).rgb * 0.12;
  c += texture(uBase, suv + vec2(-0.5, 0.87) * px).rgb * 0.12;
  c += texture(uBase, suv + vec2(-0.5, -0.87) * px).rgb * 0.12;
  c += texture(uBase, suv + vec2(-1.0, 0.0) * px * 1.6).rgb * 0.12;
  c += texture(uBase, suv + vec2(0.5, -0.87) * px * 1.6).rgb * 0.12;
  c += texture(uBase, suv + vec2(0.5, 0.87) * px * 1.6).rgb * 0.12;
  return c;
}

void main() {
  vec4 pr = texture(uPrint, vUv);
  if (uCutout > 0.5 && pr.a < 0.5) discard;
  vec2 suv = gl_FragCoord.xy / uRes;
  bool top = gl_FrontFacing;
  vec3 n = normalize(vN) * (top ? 1.0 : -1.0);
  if (n.z < 0.0) n = -n;
  vec3 L = normalize(vec3(-0.45, 0.55, 1.0));
  float dif = clamp(dot(n, L), 0.0, 1.0);
  float lift = clamp(vZ * 5.0, 0.0, 1.0);
  vec3 thr = through(suv);
  float lum = dot(thr, vec3(0.299, 0.587, 0.114));
  vec3 col;
  if (top) {
    if (uOpaque > 0.5) {
      col = pr.rgb * (0.62 + 0.45 * dif);
    } else {
      col = mix(thr, vec3(lum), 0.18) * mix(vec3(1.0), uTint, 0.55 + 0.3 * lift);
      col = mix(col, vec3(0.96, 0.98, 1.0), uHaze * (1.0 + lift));
      col = mix(col, pr.rgb, pr.a);
      col *= 0.9 + 0.15 * dif;
    }
  } else {
    // The glued side: adhesive sheen (tiny glitter), and the print seen faintly from behind.
    float sp = fract(sin(dot(floor(vUv * 420.0), vec2(12.9898, 78.233))) * 43758.5453);
    if (uOpaque > 0.5) col = uBack * (0.66 + 0.4 * dif);
    else col = mix(thr * uBack, vec3(1.0), 0.14 + 0.1 * lift) * (0.88 + 0.15 * dif);
    col = mix(col, pr.rgb, pr.a * (uOpaque > 0.5 ? 0.08 : 0.35));
    col += step(0.985, sp) * 0.18;
  }
  // Environment streak: a window reflection that slides along the curl as the normal turns.
  vec3 r = vec3(2.0 * n.z * n.xy, 2.0 * n.z * n.z - 1.0);
  float s = dot(r.xy, vec2(0.62, 0.78)) * 2.2 + (suv.x - suv.y) * 0.5;
  float streak = exp(-pow((s - 0.28) * 5.0, 2.0)) * 0.3 + exp(-pow((s + 0.55) * 9.0, 2.0)) * 0.14;
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float spec = pow(max(dot(n, H), 0.0), 90.0) * 0.45;
  float fres = pow(1.0 - n.z, 2.5) * 0.45;
  col += (streak * (0.4 + 0.6 * lift) + spec + fres) * (uOpaque > 0.5 ? 0.55 : 1.0);
  // Stretch turns the film milky; the peel front shows as a bright wet line where air gets in.
  col = mix(col, vec3(1.0), clamp(vMisc.x * 2.2, 0.0, 0.55));
  float front = 1.0 - abs(vMisc.z * 2.0 - 1.0);
  col += smoothstep(0.35, 0.95, front) * 0.28 * (uOpaque > 0.5 ? 0.5 : 1.0);
  frag = vec4(col, vMisc.y);
}`;

const SHADOW_VS = `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 2) in vec2 aUv;
layout(location = 3) in vec3 aMisc;
uniform vec2 uScale;
uniform vec2 uOffset;
out float vA;
out vec2 vUv;
void main() {
  // Light from the upper left: the shadow falls down and right, further the higher the film.
  vec2 p = aPos.xy + vec2(0.45, -0.6) * aPos.z;
  vA = 0.38 * smoothstep(0.0, 0.06, aPos.z) / (1.0 + aPos.z * 2.5) * aMisc.y;
  vUv = aUv;
  gl_Position = vec4(p * uScale + uOffset, 0.5 - 0.004 * 0.3, 1.0);
}`;

const SHADOW_FS = `#version 300 es
precision mediump float;
in float vA;
in vec2 vUv;
uniform sampler2D uPrint;
uniform float uCutout;
out vec4 frag;
void main() {
  // Glued film casts nothing, and must not claim the stencil before the lifted part does.
  if (vA < 0.004 || (uCutout > 0.5 && texture(uPrint, vUv).a < 0.5)) discard;
  frag = vec4(0.05, 0.03, 0.02, vA);
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

export interface Look {
  opaque: boolean;
  cutout: boolean;
  tint: [number, number, number];
  back: [number, number, number];
  haze: number;
}

export class PeelRenderer {
  private bg;
  private film;
  private shadow;
  private vao: WebGLVertexArrayObject;
  private vbo: WebGLBuffer;
  private ibo: WebGLBuffer;
  private data = new Float32Array(0);
  private idx = new Uint16Array(0);
  private count = 0;
  private topology = -1;
  private flying = -1;
  private base: WebGLTexture;
  private gloss: WebGLTexture;
  private print: WebGLTexture;
  private emptyVao: WebGLVertexArrayObject;
  /** World → clip at z = 0. */
  scale: [number, number] = [1, 1];
  offset: [number, number] = [0, 0];

  constructor(private gl: WebGL2RenderingContext) {
    this.bg = compile(gl, BG_VS, BG_FS);
    this.film = compile(gl, FILM_VS, FILM_FS);
    this.shadow = compile(gl, SHADOW_VS, SHADOW_FS);
    this.emptyVao = gl.createVertexArray()!;
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
    this.base = this.texture();
    this.gloss = this.texture();
    this.print = this.texture();
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

  upload(which: 'base' | 'gloss' | 'print', src: HTMLCanvasElement) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, which === 'base' ? this.base : which === 'gloss' ? this.gloss : this.print);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (which === 'print') {
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    }
  }

  /** New film: size the buffers once. */
  setFilm(f: Film) {
    this.data = new Float32Array(f.n * FLOATS);
    this.idx = new Uint16Array(f.nt * 3);
    this.topology = -1;
    this.flying = -1;
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vbo);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
  }

  draw(f: Film, look: Look, w: number, h: number, t: number, flash: number, blur: number, flyingCount: number) {
    const gl = this.gl;
    // Vertex data: interleaved, rewritten every frame (about 45 KB).
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
      for (let tri = 0; tri < f.nt; tri++) {
        if (!f.triAlive[tri]) continue;
        const a = f.tris[tri * 3], b = f.tris[tri * 3 + 1], c = f.tris[tri * 3 + 2];
        if (f.fly[a] === 2 || f.fly[b] === 2 || f.fly[c] === 2) continue;
        this.idx[k++] = a;
        this.idx[k++] = b;
        this.idx[k++] = c;
      }
      this.count = k;
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.ibo);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, this.idx.subarray(0, k), gl.DYNAMIC_DRAW);
    }

    gl.viewport(0, 0, w, h);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.STENCIL_TEST);
    gl.depthMask(true);
    gl.clearDepth(1);
    gl.clearStencil(0);
    gl.clear(gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    // 1. surface
    gl.useProgram(this.bg.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.base);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.gloss);
    gl.uniform1i(this.bg.u('uBase'), 0);
    gl.uniform1i(this.bg.u('uGloss'), 1);
    gl.uniform1f(this.bg.u('uTime'), t);
    gl.uniform1f(this.bg.u('uFlash'), flash);
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!this.count) return;

    // 2. film
    gl.bindVertexArray(this.vao);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LESS);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.film.prog);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.base);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.print);
    const u = this.film.u;
    gl.uniform1i(u('uBase'), 0);
    gl.uniform1i(u('uPrint'), 2);
    gl.uniform2f(u('uScale'), this.scale[0], this.scale[1]);
    gl.uniform2f(u('uOffset'), this.offset[0], this.offset[1]);
    gl.uniform1f(u('uD'), CAM_D);
    gl.uniform2f(u('uRes'), w, h);
    gl.uniform3fv(u('uTint'), look.tint);
    gl.uniform3fv(u('uBack'), look.back);
    gl.uniform1f(u('uHaze'), look.haze);
    gl.uniform1f(u('uOpaque'), look.opaque ? 1 : 0);
    gl.uniform1f(u('uCutout'), look.cutout ? 1 : 0);
    gl.uniform1f(u('uBlur'), blur);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);

    // 3. shadow of the lifted film, under it (depth test) and once per pixel (stencil)
    gl.useProgram(this.shadow.prog);
    gl.uniform2f(this.shadow.u('uScale'), this.scale[0], this.scale[1]);
    gl.uniform2f(this.shadow.u('uOffset'), this.offset[0], this.offset[1]);
    gl.uniform1i(this.shadow.u('uPrint'), 2);
    gl.uniform1f(this.shadow.u('uCutout'), look.cutout ? 1 : 0);
    gl.depthMask(false);
    gl.enable(gl.STENCIL_TEST);
    gl.stencilFunc(gl.EQUAL, 0, 0xff);
    gl.stencilOp(gl.KEEP, gl.KEEP, gl.INCR);
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_SHORT, 0);
    gl.disable(gl.STENCIL_TEST);
    gl.depthMask(true);
    gl.bindVertexArray(null);
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
