// WebGL2 view. Pass 1: the room, the wooden frame and the back of the glass (a lens that bends the room
// behind it), all from the same SDF texture the grains collide with. Pass 2: grains as shaded point
// sprites, or water as blurred splats into a half-res field that a composite pass thresholds into a
// refracting liquid with bubble rims. Pass 3: the front of the glass, blended on top: rim, Fresnel edge
// and the long window reflections that follow the bulb's curve.
import { Glass, HB, R, WALL } from './glass';

export type Look = 'sand' | 'salt' | 'steel' | 'water';

const QUAD_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

// Shared: pixel -> glass frame, SDF lookup, the room behind.
const COMMON = `
uniform vec2 uRes;
uniform vec2 uCenter; // px, y down
uniform float uScale;  // px per metre
uniform vec2 uRot;     // cos, sin of the glass angle
uniform sampler2D uSdf;
uniform vec4 uSdfBox;  // x0, y0, w, h (m)
vec2 toGlass(vec2 fc) {
  vec2 d = vec2(fc.x - uCenter.x, uCenter.y - fc.y) / uScale;
  return vec2(uRot.x * d.x + uRot.y * d.y, -uRot.y * d.x + uRot.x * d.y);
}
float sdf(vec2 p) {
  vec2 uv = (p - uSdfBox.xy) / uSdfBox.zw;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.006;
  return texture(uSdf, uv).r;
}
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(p) + 8192) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n >> 8) * (1.0 / 16777216.0);
}
vec3 room(vec2 fc) {
  vec2 uv = fc / uRes;
  // Warm dusk room: a lamp glow up left, a window's cool light on the right.
  vec3 c = mix(vec3(0.11, 0.075, 0.055), vec3(0.03, 0.025, 0.028), smoothstep(0.0, 1.2, length(uv - vec2(0.25, 0.2))));
  c += vec3(0.20, 0.12, 0.05) * exp(-12.0 * dot(uv - vec2(0.18, 0.12), uv - vec2(0.18, 0.12)));
  float win = smoothstep(0.62, 0.66, uv.x) * smoothstep(0.9, 0.86, uv.x) * smoothstep(0.08, 0.14, uv.y) * smoothstep(0.62, 0.56, uv.y);
  c += vec3(0.05, 0.07, 0.09) * win;
  return c * (0.96 + 0.04 * hash(fc));
}
`;

const BACK_FS = `#version 300 es
precision highp float;
${COMMON}
uniform float uHB, uR, uWall;
out vec4 frag;
float sdBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
vec3 wood(vec2 p, float ring) {
  float g = sin((p.x * 900.0 + sin(p.y * 2400.0 + p.x * 300.0) * 1.3) + ring) * 0.5 + 0.5;
  return mix(vec3(0.24, 0.12, 0.055), vec3(0.42, 0.24, 0.11), g * 0.6 + 0.2);
}
void main() {
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = toGlass(fc);
  vec3 col = room(fc);
  float px = 1.0 / uScale;
  float capY = uHB + uWall + 0.006;
  // Soft shadow of the frame on the wall behind.
  float sh = sdBox(p - vec2(0.004, -0.006), vec2(uR + 0.012, capY + 0.006), 0.006);
  col *= 1.0 - 0.5 * smoothstep(0.02, -0.004, sh);
  // Posts either side, then the caps.
  for (int s = -1; s <= 1; s += 2) {
    vec2 q = p - vec2(float(s) * (uR + 0.0075), 0.0);
    float d = sdBox(q, vec2(0.0028, capY), 0.0012);
    if (d < px) {
      float sh2 = 0.65 + 0.35 * cos(q.x / 0.0028 * 1.3);
      vec3 w = wood(q.yx * vec2(0.3, 1.0), 0.0) * sh2;
      col = mix(col, w, smoothstep(px, -px, d));
    }
  }
  for (int s = -1; s <= 1; s += 2) {
    vec2 q = p - vec2(0.0, float(s) * (capY + 0.004));
    float d = sdBox(q, vec2(uR + 0.013, 0.005), 0.002);
    if (d < px) {
      float lit = 0.7 + 0.3 * smoothstep(-0.005, 0.005, q.y * float(s) * -1.0 + 0.002);
      vec3 w = wood(q, float(s) * 3.0) * lit;
      w *= 1.0 - 0.35 * smoothstep(-0.0015, 0.0, d);
      col = mix(col, w, smoothstep(px, -px, d));
    }
  }
  float d = sdf(p);
  if (d < uWall + px) {
    // Inside: the glass is a lens. Look up the room displaced towards the axis near the walls.
    float e = 1.0 / 0.0008;
    vec2 gr = vec2(sdf(p + vec2(0.0008, 0.0)) - sdf(p - vec2(0.0008, 0.0)), sdf(p + vec2(0.0, 0.0008)) - sdf(p - vec2(0.0, 0.0008))) * 0.5 * e;
    float edge = exp(d / 0.004);
    vec2 n = vec2(uRot.x * gr.x - uRot.y * gr.y, -(uRot.y * gr.x + uRot.x * gr.y));
    vec3 behind = room(fc - n * edge * 22.0 * uScale * 0.001);
    vec3 inside = behind * vec3(0.92, 0.96, 0.97) + vec3(0.012, 0.016, 0.02);
    float wallT = smoothstep(-px, px, d);
    vec3 wallCol = mix(behind, vec3(0.5, 0.58, 0.6), 0.18);
    vec3 g = mix(inside, wallCol, wallT);
    col = mix(col, g, smoothstep(uWall + px, uWall - px, d));
  }
  frag = vec4(col, 1.0);
}`;

const FRONT_FS = `#version 300 es
precision highp float;
${COMMON}
uniform float uHB, uR, uWall, uNeck;
out vec4 frag;
// The bulb's inner half-width at height y (same profile as glass.ts).
float widthAt(float y) {
  float s = abs(y);
  if (s >= uHB) return 0.0;
  float c = uNeck * 0.5 + max(0.0, s - 0.0015) * 0.8;
  float k = 0.014;
  float h = clamp(0.5 + 0.5 * (uR - c) / k, 0.0, 1.0);
  float w = uR * (1.0 - h) + c * h - k * h * (1.0 - h);
  float d0 = uHB - 0.02;
  if (s > d0) w *= sqrt(max(0.0, 1.0 - pow((s - d0) / 0.02, 2.0)));
  return w;
}
void main() {
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = toGlass(fc);
  float px = 1.0 / uScale;
  float d = sdf(p);
  if (d > uWall + px) discard;
  // Reflection bands and highlights, placed by the bulb profile.
  float a = 0.0;
  vec3 c = vec3(0.0);
  // Outer and inner rims.
  float rimO = exp(-abs(d - uWall) / (1.2 * px)) * 0.55;
  float rimI = exp(-abs(d) / (1.4 * px)) * 0.35;
  // Fresnel: the curved glass reflects more near its silhouette.
  float fres = pow(smoothstep(-0.006, uWall, d), 3.0) * 0.28;
  // Long window reflections riding the curve: two bands at fixed fractions of the local width.
  float w = max(0.0005, widthAt(p.y));
  float wl = abs(p.x) / (w + uWall);
  float band1 = smoothstep(0.1, 0.0, abs(-p.x / (w + uWall) - 0.62)) * 0.5;
  float band2 = smoothstep(0.05, 0.0, abs(p.x / (w + uWall) - 0.78)) * 0.22;
  float bands = (band1 + band2) * smoothstep(uHB, uHB - 0.012, abs(p.y)) * smoothstep(0.0015, 0.008, abs(p.y));
  float hl = 0.0;
  // Small hot spots on each bulb's shoulder.
  for (int s = -1; s <= 1; s += 2) {
    vec2 q = p - vec2(-uR * 0.5, float(s) * uHB * 0.55);
    hl += exp(-dot(q, q) / (0.0035 * 0.0035)) * 0.45;
  }
  a = clamp(rimO + rimI + fres + bands + hl, 0.0, 0.9) * (wl < 1.2 ? 1.0 : 0.0);
  c = mix(vec3(0.85, 0.92, 1.0), vec3(1.0, 0.95, 0.85), band1 * 1.5);
  frag = vec4(c * a, a);
}`;

const GRAIN_VS = `#version 300 es
layout(location = 0) in vec4 aGrain; // x, y (m), radius (m), tint
layout(location = 1) in vec2 aShade; // brightness, spin angle
uniform vec2 uRes;
uniform vec2 uCenter;
uniform float uScale;
uniform vec2 uRot;
out float vTint;
out float vShade;
out float vSize;
out float vSpin;
void main() {
  vec2 p = aGrain.xy;
  vec2 q = vec2(uRot.x * p.x - uRot.y * p.y, uRot.y * p.x + uRot.x * p.y) * uScale;
  vec2 fc = vec2(uCenter.x + q.x, uCenter.y - q.y);
  gl_Position = vec4(fc.x / uRes.x * 2.0 - 1.0, 1.0 - fc.y / uRes.y * 2.0, 0.0, 1.0);
  vSize = aGrain.z * 2.0 * uScale + 1.0;
  gl_PointSize = vSize;
  vTint = aGrain.w;
  vShade = aShade.x;
  vSpin = aShade.y + atan(uRot.y, uRot.x);
}`;

const GRAIN_FS = `#version 300 es
precision highp float;
uniform int uLook;
in float vTint;
in float vShade;
in float vSize;
in float vSpin;
out vec4 frag;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  c.y = -c.y;
  float r2 = dot(c, c);
  float aa = 2.0 / vSize;
  float cover;
  vec3 col;
  vec3 L = normalize(vec3(-0.5, 0.6, 0.62));
  if (uLook == 1) {
    // Salt: little rotated cubes, pale and glassy.
    float ang = vSpin;
    vec2 q = mat2(cos(ang), -sin(ang), sin(ang), cos(ang)) * c;
    float d = max(abs(q.x), abs(q.y)) - 0.72;
    cover = smoothstep(aa, -aa, d);
    float face = q.x > abs(q.y) ? 0.9 : q.y > abs(q.x) ? 1.08 : 0.82;
    col = mix(vec3(0.86, 0.88, 0.9), vec3(0.98, 0.97, 0.95), vTint) * face;
    col += vec3(0.25) * smoothstep(0.08, 0.0, abs(d + 0.12)) * 0.5;
  } else {
    cover = smoothstep(1.0, 1.0 - aa * 1.5, r2);
    vec3 n = vec3(c, sqrt(max(0.0, 1.0 - r2)));
    float dif = max(0.0, dot(n, L));
    if (uLook == 2) {
      // Steel shot: dark chrome with a sharp highlight and a warm room bounce.
      float spec = pow(max(0.0, dot(reflect(-L, n), vec3(0, 0, 1))), 28.0);
      col = vec3(0.16, 0.17, 0.19) + vec3(0.35, 0.36, 0.4) * dif + vec3(1.0) * spec * 0.9 + vec3(0.12, 0.07, 0.03) * (1.0 - n.z);
    } else {
      // Sand: warm quartz and feldspar, the odd dark grain.
      vec3 base = mix(vec3(0.86, 0.66, 0.40), vec3(0.95, 0.80, 0.55), vTint);
      if (vTint > 0.93) base = vec3(0.45, 0.33, 0.24);
      else if (vTint < 0.08) base = vec3(0.98, 0.93, 0.85);
      col = base * (0.45 + 0.65 * dif);
      // A darker fleck on each grain turns with it, so you can see grains roll.
      vec2 fl = vec2(cos(vSpin), sin(vSpin)) * 0.45;
      col *= 1.0 - 0.28 * smoothstep(0.32, 0.12, length(c - fl)) * step(0.3, fract(vTint * 7.0));
    }
  }
  col *= vShade;
  frag = vec4(col * cover, cover);
}`;

const SPLAT_FS = `#version 300 es
precision highp float;
out vec4 frag;
void main() {
  vec2 c = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(c, c);
  if (r2 > 1.0) discard;
  float k = exp(-r2 * 3.0);
  frag = vec4(k, 0.0, 0.0, 1.0);
}`;

const WATER_FS = `#version 300 es
precision highp float;
${COMMON}
uniform sampler2D uField;
uniform vec2 uFieldRes;
uniform vec4 uBubbles[20]; // x, y (glass m), r (m), on
out vec4 frag;
void main() {
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 uv = gl_FragCoord.xy / uRes;
  float f = texture(uField, uv).r;
  vec2 t = 1.0 / uFieldRes;
  float fx = texture(uField, uv + vec2(t.x, 0.0)).r - texture(uField, uv - vec2(t.x, 0.0)).r;
  float fy = texture(uField, uv + vec2(0.0, t.y)).r - texture(uField, uv - vec2(0.0, t.y)).r;
  float a = smoothstep(0.42, 0.62, f);
  vec2 p = toGlass(fc);
  float ring = 0.0;
  for (int i = 0; i < 20; i++) {
    vec4 b = uBubbles[i];
    if (b.w < 0.5) continue;
    float d = length(p - b.xy) - b.z;
    ring += exp(-abs(d) * uScale / 1.6) * 0.8;
    // Inside a bubble there is no water.
    a *= smoothstep(-2.0 / uScale, 1.0 / uScale, d);
    vec2 q = p - b.xy - vec2(-0.35, 0.4) * b.z;
    ring += exp(-dot(q, q) / (b.z * b.z * 0.04)) * 0.9;
  }
  if (a < 0.01 && ring < 0.01) discard;
  vec2 n = vec2(fx, -fy);
  vec3 behind = room(fc + n * 60.0);
  float edge = smoothstep(0.9, 0.45, f);
  // Clear water: the room seen through it, tinted, a touch brighter where it is thin at the edges.
  vec3 col = behind * vec3(0.75, 0.9, 0.95) + vec3(0.06, 0.13, 0.17);
  col += vec3(0.45, 0.65, 0.75) * edge * 0.45;
  float spec = pow(clamp(0.5 + dot(normalize(n + 1e-5), normalize(vec2(-0.6, -0.8))) * 0.5, 0.0, 1.0), 12.0) * edge;
  col += vec3(1.0) * spec * 0.6;
  float alpha = max(a * 0.82, ring * 0.7);
  col = mix(col, vec3(0.85, 0.95, 1.0), clamp(ring, 0.0, 1.0) * 0.8);
  frag = vec4(col * alpha, alpha);
}`;

export interface View2D {
  cx: number;
  cy: number;
  scale: number;
  angle: number;
}

export class HourglassView {
  private gl: WebGL2RenderingContext;
  private back: WebGLProgram;
  private front: WebGLProgram;
  private grainProg: WebGLProgram;
  private splatProg: WebGLProgram;
  private waterProg: WebGLProgram;
  private u = new Map<WebGLProgram, Record<string, WebGLUniformLocation | null>>();
  private sdfTex: WebGLTexture;
  private sdfVersion = -1;
  private vao: WebGLVertexArrayObject;
  private buf: WebGLBuffer;
  private shadeBuf: WebGLBuffer;
  readonly data: Float32Array;
  readonly shade: Float32Array;
  private fieldTex: WebGLTexture | null = null;
  private fieldFbo: WebGLFramebuffer | null = null;
  private fw = 0;
  private fh = 0;
  private empty: WebGLVertexArrayObject;
  private bubbleData = new Float32Array(80);

  constructor(private canvas: HTMLCanvasElement, max: number) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, premultipliedAlpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available');
    this.gl = gl;
    this.back = this.program(QUAD_VS, BACK_FS);
    this.front = this.program(QUAD_VS, FRONT_FS);
    this.grainProg = this.program(GRAIN_VS, GRAIN_FS);
    this.splatProg = this.program(GRAIN_VS, SPLAT_FS);
    this.waterProg = this.program(QUAD_VS, WATER_FS);
    this.sdfTex = gl.createTexture()!;
    this.data = new Float32Array(max * 4);
    this.shade = new Float32Array(max * 2);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    this.shadeBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadeBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.shade.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    this.empty = gl.createVertexArray()!;
  }

  private program(vs: string, fs: string) {
    const gl = this.gl;
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    const u: Record<string, WebGLUniformLocation | null> = {};
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i)!.name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    this.u.set(p, u);
    return p;
  }

  private uploadSdf(glass: Glass) {
    if (glass.version === this.sdfVersion) return;
    this.sdfVersion = glass.version;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, glass.nx, glass.ny, 0, gl.RED, gl.FLOAT, glass.sdf);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private common(p: WebGLProgram, glass: Glass, v: View2D) {
    const gl = this.gl, u = this.u.get(p)!;
    gl.useProgram(p);
    gl.uniform2f(u.uRes, this.canvas.width, this.canvas.height);
    gl.uniform2f(u.uCenter, v.cx, v.cy);
    gl.uniform1f(u.uScale, v.scale);
    gl.uniform2f(u.uRot, Math.cos(v.angle), Math.sin(v.angle));
    if (u.uSdf) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.sdfTex);
      gl.uniform1i(u.uSdf, 0);
      gl.uniform4f(u.uSdfBox, glass.x0, glass.y0, (glass.nx - 1) * 0.0004, (glass.ny - 1) * 0.0004);
    }
    if (u.uNeck) gl.uniform1f(u.uNeck, glass.neck);
    if (u.uHB) {
      gl.uniform1f(u.uHB, HB);
      gl.uniform1f(u.uR, R);
      gl.uniform1f(u.uWall, WALL);
    }
    return u;
  }

  private ensureField() {
    const gl = this.gl;
    const w = Math.max(1, this.canvas.width >> 1), h = Math.max(1, this.canvas.height >> 1);
    if (this.fieldTex && w === this.fw && h === this.fh) return;
    if (this.fieldTex) gl.deleteTexture(this.fieldTex);
    if (this.fieldFbo) gl.deleteFramebuffer(this.fieldFbo);
    this.fw = w;
    this.fh = h;
    this.fieldTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.fieldFbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.fieldTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /** `count` particles already written to `data` (x, y, r, tint) and `shade`. */
  draw(glass: Glass, v: View2D, look: Look, count: number, bubbles: { x: number; y: number; r: number }[]) {
    const gl = this.gl;
    this.uploadSdf(glass);
    const W = this.canvas.width, H = this.canvas.height;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.BLEND);
    gl.bindVertexArray(this.empty);
    this.common(this.back, glass, v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, count * 4);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.shadeBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.shade, 0, count * 2);
    if (look === 'water') {
      this.ensureField();
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.fieldFbo);
      gl.viewport(0, 0, this.fw, this.fh);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      // Same transform at half resolution: halve the centre and scale.
      const half = { cx: v.cx / 2, cy: v.cy / 2, scale: v.scale / 2, angle: v.angle };
      const u = this.common(this.splatProg, glass, half);
      gl.uniform2f(u.uRes, this.fw, this.fh);
      gl.drawArrays(gl.POINTS, 0, count);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, W, H);
      gl.bindVertexArray(this.empty);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const w = this.common(this.waterProg, glass, v);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.fieldTex);
      gl.uniform1i(w.uField, 1);
      gl.uniform2f(w.uFieldRes, this.fw, this.fh);
      const bd = this.bubbleData;
      bd.fill(0);
      for (let i = 0; i < Math.min(20, bubbles.length); i++) {
        bd[i * 4] = bubbles[i].x;
        bd[i * 4 + 1] = bubbles[i].y;
        bd[i * 4 + 2] = bubbles[i].r;
        bd[i * 4 + 3] = 1;
      }
      gl.uniform4fv(w.uBubbles, bd);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    } else {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      const u = this.common(this.grainProg, glass, v);
      gl.uniform1i(u.uLook, look === 'salt' ? 1 : look === 'steel' ? 2 : 0);
      gl.drawArrays(gl.POINTS, 0, count);
    }

    gl.bindVertexArray(this.empty);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    this.common(this.front, glass, v);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.disable(gl.BLEND);
  }

  destroy() {
    const gl = this.gl;
    for (const p of [this.back, this.front, this.grainProg, this.splatProg, this.waterProg]) gl.deleteProgram(p);
    gl.deleteTexture(this.sdfTex);
    if (this.fieldTex) gl.deleteTexture(this.fieldTex);
    if (this.fieldFbo) gl.deleteFramebuffer(this.fieldFbo);
    gl.deleteBuffer(this.buf);
    gl.deleteBuffer(this.shadeBuf);
  }
}
