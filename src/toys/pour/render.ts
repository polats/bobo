// WebGL2 renderer: a background pass (gradient, shelves), one quad per tube whose fragment shader
// draws the layer stack, slosh surface, meniscus, rising blobs, glass and cork analytically, and the
// pour stream as particles splatted into a half-res density target and thresholded (Ferro's
// thickness-grid idea on the GPU), tinted by the colour each particle carries.

export interface TubeDraw {
  /** Local origin (bottom of the round) in world CSS px, and CCW rotation. */
  tx: number;
  ty: number;
  ang: number;
  r: number;
  h: number;
  g: number;
  /** Surface offsets along the local up-vector for each layer top, bottom → top. */
  d: Float32Array;
  /** rgb + kind per layer. */
  c: Float32Array;
  nl: number;
  m1: number;
  m2: number;
  /** Rising blobs: x, y, radius, 0 (local px). */
  blobs: Float32Array;
  blobC: [number, number, number, number];
  nb: number;
  cork: number;
  corkY: number;
  sel: number;
  shimmer: number;
}

const BG = /* glsl */ `
uniform vec2 uView;
uniform vec2 uShelf;
uniform float uShelfW;
vec3 bg(vec2 w) {
  vec2 uv = w / uView;
  vec3 c = mix(vec3(0.17, 0.11, 0.24), vec3(0.05, 0.08, 0.16), uv.y);
  vec2 q = (uv - vec2(0.5, 0.56)) * vec2(1.25, 0.95);
  c += vec3(0.2, 0.15, 0.27) * exp(-dot(q, q) * 5.0);
  for (int i = 0; i < 2; i++) {
    float y = uShelf[i];
    if (y < 0.0) continue;
    float d = w.y - y;
    float span = 1.0 - smoothstep(uShelfW - 2.0, uShelfW + 2.0, abs(w.x - uView.x * 0.5));
    // Soft shadow the tubes and shelf cast onto the wall.
    c *= 1.0 - 0.35 * span * smoothstep(-36.0, -10.0, d) * (1.0 - smoothstep(-10.0, -9.0, d));
    if (d < 0.0 && d > -10.0) {
      vec3 wood = mix(vec3(0.42, 0.3, 0.36), vec3(0.62, 0.48, 0.52), smoothstep(-10.0, -1.0, d));
      wood += 0.25 * (1.0 - smoothstep(-2.0, 0.0, d)) * step(-2.0, d);
      c = mix(c, wood, span);
    }
  }
  return c;
}
`;

const FULL_VS = /* glsl */ `#version 300 es
out vec2 vUV;
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  vUV = p;
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const BG_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
out vec4 o;
${BG}
void main() {
  vec3 c = bg(vUV * uView);
  vec2 v = vUV - 0.5;
  c *= 1.0 - 0.35 * dot(v, v);
  o = vec4(c, 1.0);
}`;

const TUBE_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aQ;
uniform vec4 uBox;
uniform vec3 uXf;
uniform vec2 uView;
out vec2 vL;
out vec2 vW;
void main() {
  vec2 l = mix(uBox.xy, uBox.zw, aQ);
  float c = cos(uXf.z), s = sin(uXf.z);
  vec2 w = uXf.xy + vec2(c * l.x - s * l.y, s * l.x + c * l.y);
  vL = l;
  vW = w;
  gl_Position = vec4(w / uView * 2.0 - 1.0, 0.0, 1.0);
}`;

const TUBE_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vL;
in vec2 vW;
out vec4 o;
${BG}
uniform vec3 uShape; // r, h, glass
uniform vec2 uN;
uniform float uD[8];
uniform vec4 uC[8];
uniform int uNL;
uniform vec3 uSlosh; // m1, m2, time
uniform vec4 uBlob[6];
uniform vec4 uBlobC;
uniform int uNB;
uniform vec4 uFx; // cork, cork offset, selected, shimmer phase
uniform float uAA;

float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }

vec4 over(vec4 top, vec4 under) { return top + under * (1.0 - top.a); }

vec3 shadeLiquid(vec3 base, float kind, float xs, vec2 p, float depth, float t) {
  float cyl = sqrt(max(0.0, 1.0 - xs * xs));
  vec3 c = base * (0.6 + 0.4 * cyl);
  c *= 1.0 - 0.2 * smoothstep(0.0, 160.0, depth);
  if (kind > 0.5 && kind < 1.5) {
    // Oil: clear and glossy, with slow sheen bands and a few trapped bubbles.
    c = mix(c, vec3(1.0, 0.95, 0.75), 0.18 * (0.5 + 0.5 * sin(p.y * 0.21 - t * 1.4 + xs * 2.5)));
    vec2 cell = floor(vec2(p.x, p.y - t * 9.0) / 7.0);
    float b = hash(cell);
    vec2 f = fract(vec2(p.x, p.y - t * 9.0) / 7.0) - 0.5;
    c += 0.35 * step(0.92, b) * (1.0 - smoothstep(0.12, 0.22, length(f)));
  } else if (kind > 1.5) {
    // Syrup: deep, dark and very glossy.
    c = base * (0.45 + 0.55 * cyl) + vec3(0.5, 0.25, 0.3) * pow(cyl, 14.0) * 0.5;
  }
  return c;
}

void main() {
  float r = uShape.x, h = uShape.y, g = uShape.z;
  vec2 p = vL;
  float aa = uAA * 1.25;
  float t = uSlosh.z;
  float si = p.y > r ? abs(p.x) - r : length(p - vec2(0.0, r)) - r;
  float wall = abs(si - g * 0.5) - g * 0.5;
  if (p.y > h) wall = length(vec2(abs(p.x) - (r + g * 0.5), p.y - h)) - g * 0.5;
  float inside = (1.0 - smoothstep(-aa, aa, si)) * (1.0 - smoothstep(h - aa, h + aa, p.y));
  float xs = clamp(p.x / r, -1.0, 1.0);
  vec4 col = vec4(0.0);

  // Selection glow under everything.
  float dOut = max(si - g, 0.0);
  if (p.y < h + 4.0) col = vec4(vec3(1.0, 0.92, 0.6), 1.0) * uFx.z * 0.55 * exp(-dOut / 5.0) * (1.0 - inside);

  if (inside > 0.0) {
    float s = dot(p, uN);
    float wave = uSlosh.x * xs + uSlosh.y * cos(3.14159 * xs);
    float men = 2.2 * exp(-(r - abs(p.x)) / 2.2);
    vec4 fill = vec4(0.0);
    int li = -1;
    float topD = -1e9;
    if (uNL > 0) {
      topD = uD[uNL - 1] + wave + men;
      if (s < topD) {
        for (int i = 0; i < 8; i++) {
          if (i >= uNL) break;
          float di = uD[i] + (i == uNL - 1 ? wave + men : wave * 0.3);
          if (s < di) { li = i; break; }
        }
        if (li < 0) li = uNL - 1;
      }
    }
    if (li >= 0) {
      vec4 lc = uC[li];
      float depth = topD - s;
      vec3 c = shadeLiquid(lc.rgb, lc.a, xs, p, depth, t);
      // Seam between layers.
      if (li < uNL - 1) c *= 1.0 - 0.18 * (1.0 - smoothstep(0.0, 1.6, uD[li] + wave * 0.3 - s));
      // Rising / sinking blobs of another liquid.
      float f = 0.0;
      for (int i = 0; i < 6; i++) {
        if (i >= uNB) break;
        vec2 d = p - uBlob[i].xy;
        f += uBlob[i].z * uBlob[i].z / (dot(d, d) + 0.5);
      }
      float bm = smoothstep(0.85, 1.15, f);
      if (bm > 0.0) c = mix(c, shadeLiquid(uBlobC.rgb, uBlobC.a, xs, p, depth, t) * 1.08 + 0.05, bm);
      // Bright surface band and the meniscus line.
      float band = 1.0 - smoothstep(0.0, 3.0, depth);
      c = mix(c, lc.rgb * 1.2 + 0.18, band * 0.75);
      // Solved shimmer: a diagonal sweep.
      if (uFx.w >= 0.0) {
        float u = (p.y + p.x * 0.7) / h;
        c += vec3(0.55) * exp(-pow((u - (uFx.w * 1.8 - 0.4)) * 7.0, 2.0));
      }
      fill = vec4(c, 1.0);
    } else {
      // Empty glass: the wall behind, bent a little by the tube (fake refraction).
      vec3 b = bg(vW + vec2(-xs * 7.0, 0.0)) * 0.92 + vec3(0.03, 0.035, 0.05);
      fill = vec4(b, 1.0) * 0.72;
    }
    col = over(fill * inside, col);
  }

  // Glass wall, lip and highlights.
  float ga = 1.0 - smoothstep(-aa, aa, wall);
  float lip = 1.0 - smoothstep(0.0, 3.0, abs(p.y - h));
  vec4 glass = vec4(vec3(0.82, 0.88, 1.0), 1.0) * ga * (0.42 + 0.4 * lip);
  col = over(glass, col);
  float body = max(inside, ga) * smoothstep(r * 0.4, r * 0.9, p.y) * (1.0 - smoothstep(h - 6.0, h, p.y));
  float hl = exp(-pow((p.x + 0.52 * r) / (0.13 * r), 2.0)) * 0.42 + exp(-pow((p.x - 0.74 * r) / (0.06 * r), 2.0)) * 0.16;
  col.rgb += vec3(hl * body);

  // Cork: a plug in the mouth and a cap over the lip.
  if (uFx.x > 0.0) {
    float oy = uFx.y;
    vec2 q = p - vec2(0.0, h + oy);
    vec2 bp = abs(q - vec2(0.0, -4.0)) - vec2(r - 0.5, 6.0);
    vec2 bc = abs(q - vec2(0.0, 7.5)) - vec2(r + g + 2.5, 6.0);
    float dp = length(max(bp, 0.0)) + min(max(bp.x, bp.y), 0.0) - 1.0;
    float dc = length(max(bc, 0.0)) + min(max(bc.x, bc.y), 0.0) - 3.0;
    float dk = min(dp, dc);
    float ca = 1.0 - smoothstep(-aa, aa, dk);
    if (ca > 0.0) {
      vec3 cork = vec3(0.78, 0.57, 0.36) * (0.82 + 0.3 * hash(floor(p * 1.6)));
      cork *= 0.8 + 0.25 * smoothstep(-6.0, 6.0, q.y) - 0.18 * smoothstep(0.4, 1.0, abs(p.x) / (r + g + 2.5));
      col = over(vec4(cork, 1.0) * ca * uFx.x, col);
    }
  }
  if (col.a <= 0.002) discard;
  o = col;
}`;

const PT_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aP;
layout(location = 1) in vec3 aC;
uniform vec2 uView;
uniform float uSize;
out vec3 vC;
void main() {
  gl_Position = vec4(aP / uView * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = uSize;
  vC = aC;
}`;

const PT_FS = /* glsl */ `#version 300 es
precision mediump float;
in vec3 vC;
uniform float uW;
out vec4 o;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float w = (1.0 - r2) * (1.0 - r2) * uW;
  o = vec4(vC * w, w);
}`;

const COMP_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUV;
uniform sampler2D uT;
uniform vec2 uTexel;
uniform float uTh;
out vec4 o;
void main() {
  vec4 a = texture(uT, vUV);
  float m = smoothstep(uTh * 0.75, uTh * 1.25, a.a);
  if (m <= 0.0) discard;
  vec3 c = a.rgb / max(a.a, 1e-4);
  float wx = texture(uT, vUV + vec2(uTexel.x, 0.0)).a - texture(uT, vUV - vec2(uTexel.x, 0.0)).a;
  float wy = texture(uT, vUV + vec2(0.0, uTexel.y)).a - texture(uT, vUV - vec2(0.0, uTexel.y)).a;
  vec3 n = normalize(vec3(-vec2(wx, wy) * 2.5 / uTh, 1.0));
  float l = clamp(dot(n, normalize(vec3(-0.5, 0.6, 0.65))), 0.0, 1.0);
  c = c * (0.7 + 0.4 * l) + pow(l, 18.0) * 0.55;
  o = vec4(c * m, m);
}`;

export class Renderer {
  private bg: WebGLProgram;
  private tube: WebGLProgram;
  private pts: WebGLProgram;
  private comp: WebGLProgram;
  private quad: WebGLVertexArrayObject;
  private ptVao: WebGLVertexArrayObject;
  private ptBuf: WebGLBuffer;
  private fbo: WebGLFramebuffer | null = null;
  private tex: WebGLTexture | null = null;
  private fw = 1;
  private fh = 1;
  private w = 1;
  private h = 1;
  private float: boolean;
  private u = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(private gl: WebGL2RenderingContext) {
    this.float = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    this.bg = program(gl, FULL_VS, BG_FS);
    this.tube = program(gl, TUBE_VS, TUBE_FS);
    this.pts = program(gl, PT_VS, PT_FS);
    this.comp = program(gl, FULL_VS, COMP_FS);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.ptVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ptVao);
    this.ptBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 2100 * 5 * 4, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 20, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 20, 8);
    gl.bindVertexArray(null);
  }

  resize(w: number, h: number) {
    const { gl } = this;
    this.w = w;
    this.h = h;
    this.fw = Math.max(1, Math.round(w / 2));
    this.fh = Math.max(1, Math.round(h / 2));
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    if (this.float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, this.fw, this.fh, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, this.fw, this.fh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.tex, 0);
    if (this.float && gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
      this.float = false;
      this.resize(w, h);
      return;
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  draw(o: {
    view: [number, number];
    shelves: [number, number];
    shelfW: number;
    tubes: TubeDraw[];
    parts: Float32Array;
    np: number;
    dropR: number;
    time: number;
  }) {
    const { gl } = this;
    const [vw, vh] = o.view;
    const setBg = (p: WebGLProgram) => {
      gl.uniform2f(this.loc(p, 'uView'), vw, vh);
      gl.uniform2f(this.loc(p, 'uShelf'), o.shelves[0], o.shelves[1]);
      gl.uniform1f(this.loc(p, 'uShelfW'), o.shelfW);
    };
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.disable(gl.BLEND);
    gl.useProgram(this.bg);
    setBg(this.bg);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    const tp = this.tube;
    gl.useProgram(tp);
    setBg(tp);
    gl.uniform1f(this.loc(tp, 'uAA'), vw / this.w);
    for (const t of o.tubes) {
      const m = t.r + t.g + 14;
      gl.uniform4f(this.loc(tp, 'uBox'), -m, -t.g - 14, m, t.h + 84);
      gl.uniform3f(this.loc(tp, 'uXf'), t.tx, t.ty, t.ang);
      gl.uniform3f(this.loc(tp, 'uShape'), t.r, t.h, t.g);
      gl.uniform2f(this.loc(tp, 'uN'), Math.sin(t.ang), Math.cos(t.ang));
      gl.uniform1fv(this.loc(tp, 'uD'), t.d);
      gl.uniform4fv(this.loc(tp, 'uC'), t.c);
      gl.uniform1i(this.loc(tp, 'uNL'), t.nl);
      gl.uniform3f(this.loc(tp, 'uSlosh'), t.m1, t.m2, o.time);
      gl.uniform4fv(this.loc(tp, 'uBlob'), t.blobs);
      gl.uniform4f(this.loc(tp, 'uBlobC'), ...t.blobC);
      gl.uniform1i(this.loc(tp, 'uNB'), t.nb);
      gl.uniform4f(this.loc(tp, 'uFx'), t.cork, t.corkY, t.sel, t.shimmer);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }

    if (!o.np) return;
    // Stream: splat into the density target, then threshold over the scene.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fbo);
    gl.viewport(0, 0, this.fw, this.fh);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.useProgram(this.pts);
    gl.uniform2f(this.loc(this.pts, 'uView'), vw, vh);
    gl.uniform1f(this.loc(this.pts, 'uSize'), o.dropR * 2 * (this.fw / vw));
    gl.uniform1f(this.loc(this.pts, 'uW'), this.float ? 1 : 0.3);
    gl.bindVertexArray(this.ptVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.ptBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, o.parts, 0, o.np * 5);
    gl.drawArrays(gl.POINTS, 0, o.np);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.w, this.h);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.comp);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.uniform1i(this.loc(this.comp, 'uT'), 0);
    gl.uniform2f(this.loc(this.comp, 'uTexel'), 1 / this.fw, 1 / this.fh);
    gl.uniform1f(this.loc(this.comp, 'uTh'), this.float ? 0.35 : 0.105);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private loc(p: WebGLProgram, name: string) {
    let m = this.u.get(p);
    if (!m) this.u.set(p, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  destroy() {
    const { gl } = this;
    for (const p of [this.bg, this.tube, this.pts, this.comp]) gl.deleteProgram(p);
    if (this.tex) gl.deleteTexture(this.tex);
    if (this.fbo) gl.deleteFramebuffer(this.fbo);
    gl.deleteBuffer(this.ptBuf);
  }
}

function program(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const p = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`Shader: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(p, s);
  }
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`Link: ${gl.getProgramInfoLog(p)}`);
  return p;
}
