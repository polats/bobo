// WebGL2 view: a dark brushed-steel plate (straight brushing on the square, lathe rings on the disc)
// with a soft drop shadow, a faint shimmer where the acceleration field says it is moving, then the
// sand as points: a soft shadow pass offset by each grain's hop height, then the grains.
import { GRID } from './plate';

const QUAD_VS = `#version 300 es
void main() {
  vec2 p = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(p * 2.0 - 1.0, 0.0, 1.0);
}`;

const PLATE_FS = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec3 uPlate; // centre (px, y down), half-size px
uniform float uCircle;
uniform float uTime;
uniform float uShimmer;
uniform sampler2D uField;
out vec4 frag;
float hash(vec2 p) {
  uvec2 q = uvec2(ivec2(p) + 8192) * uvec2(1597334673u, 3812015801u);
  uint n = (q.x ^ q.y) * 1597334673u;
  return float(n >> 8) * (1.0 / 16777216.0);
}
float vnoise(float x, float row) {
  float i = floor(x), f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(hash(vec2(i, row)), hash(vec2(i + 1.0, row)), f);
}
float sdPlate(vec2 p) {
  if (uCircle > 0.5) return length(p) - 1.0;
  vec2 q = abs(p) - vec2(0.97);
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - 0.03;
}
void main() {
  vec2 fc = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  vec2 p = (fc - uPlate.xy) / uPlate.z;
  float px = 1.0 / uPlate.z;
  float sd = sdPlate(p);
  // Room: dark felt-grey table under a soft top light.
  vec2 uv = fc / uRes;
  vec3 room = mix(vec3(0.075, 0.07, 0.068), vec3(0.03, 0.03, 0.034), smoothstep(0.1, 1.1, length(uv - vec2(0.5, 0.35))));
  room *= 0.92 + 0.08 * hash(fc * 0.5);
  // Drop shadow: the plate floats a little above the table.
  float sh = sdPlate(p - vec2(0.035, 0.07));
  room *= 1.0 - 0.72 * exp(-max(sh, 0.0) * 9.0) * smoothstep(0.02, -0.25, sh - 0.12);
  vec3 col = room;
  if (sd < 2.0 * px) {
    float G = texture(uField, (p + 1.0) * 0.5).r;
    float e = 0.03;
    float gx = texture(uField, (p + vec2(e, 0.0) + 1.0) * 0.5).r - texture(uField, (p - vec2(e, 0.0) + 1.0) * 0.5).r;
    float gy = texture(uField, (p + vec2(0.0, e) + 1.0) * 0.5).r - texture(uField, (p - vec2(0.0, e) + 1.0) * 0.5).r;
    // Brushing direction: along x on the square, around the centre on the disc.
    float r = length(p), th = atan(p.y, p.x);
    float along, across;
    if (uCircle > 0.5) { along = th * 900.0; across = r * uPlate.z * 1.2; }
    else { along = p.x * uPlate.z * 0.08; across = p.y * uPlate.z * 1.2; }
    float blur = 1.0 - 0.5 * smoothstep(1.5, 8.0, G) * uShimmer;
    float streak = 0.5 + blur * (-0.5 + vnoise(along * 0.02 + hash(vec2(floor(across), 3.0)) * 40.0, floor(across)) * 0.6 + hash(vec2(floor(across), 7.0)) * 0.4);
    // Vibration shimmer: the surface tilts back and forth where it moves (far faster than the frame
    // rate), so the sheen flickers there and the fine brushing blurs.
    float flick = sin(uTime * 53.0) * 0.6 + sin(uTime * 37.0 + 1.3) * 0.4;
    vec2 tilt = vec2(gx, gy) * 0.18 * flick * uShimmer;
    // Anisotropic sheen: brushed steel spreads a highlight across the grain.
    float sheen;
    if (uCircle > 0.5) {
      float a = cos(2.0 * (th - 0.75)) ;
      sheen = pow(0.5 + 0.5 * a, 6.0) * (0.35 + 0.65 * smoothstep(1.0, 0.1, r));
    } else {
      float d = (p.x - p.y) * 0.5 + 0.15 + tilt.x * 2.0;
      sheen = exp(-d * d * 5.0) * 0.8 + 0.2 * exp(-(p.x + p.y + 0.9) * (p.x + p.y + 0.9) * 2.0);
    }
    sheen += (tilt.x + tilt.y) * 0.6;
    vec3 steel = vec3(0.105, 0.112, 0.125) * (0.8 + 0.35 * streak);
    steel += vec3(0.5, 0.54, 0.6) * max(sheen, 0.0) * (0.5 + 0.5 * streak) * 0.42;
    // Moving metal blurs its fine brushing a touch and catches a little extra light.
    steel += vec3(0.035, 0.038, 0.045) * smoothstep(1.0, 6.0, G) * uShimmer * (0.8 + 0.2 * flick);
    // Bevelled edge: lit from the top left.
    float rim = smoothstep(-0.035, 0.0, sd);
    vec2 nrm = uCircle > 0.5 ? p / max(r, 1e-3) : (abs(p.x) > abs(p.y) ? vec2(sign(p.x), 0.0) : vec2(0.0, sign(p.y)));
    float lit = dot(nrm, normalize(vec2(-0.6, -0.8)));
    steel += rim * (lit > 0.0 ? vec3(0.5, 0.52, 0.56) * lit : vec3(-0.09) * -lit);
    float a = smoothstep(px * 1.5, -px * 1.5, sd);
    col = mix(col, steel, a);
  }
  frag = vec4(col, 1.0);
}`;

const GRAIN_VS = `#version 300 es
layout(location = 0) in vec4 aGrain; // x, y (px, y down), height (plate half-sizes), tint
uniform vec2 uRes;
uniform float uSize;
uniform float uHalf;
uniform float uShadow;
out float vTint;
out float vZ;
void main() {
  vec2 p = aGrain.xy;
  float z = aGrain.z;
  vTint = aGrain.w;
  vZ = z;
  float s = uSize;
  if (uShadow > 0.5) {
    // Light from the top left: the shadow slides down-right and spreads as the grain rises.
    p += vec2(0.35, 0.6) * (max(z, 0.0) * uHalf + uSize * 0.35);
    s = uSize * (1.7 + max(z, 0.0) * 14.0);
    if (z < 0.0) s = 0.0;
  } else {
    // A rising grain comes toward the eye; one falling off the edge drops away and shrinks.
    s *= z >= 0.0 ? 1.0 + z * 2.5 : max(0.0, 1.0 + z * 1.4);
  }
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  gl_PointSize = s;
}`;

const GRAIN_FS = `#version 300 es
precision highp float;
uniform float uShadow;
in float vTint;
in float vZ;
out vec4 frag;
void main() {
  vec2 d = gl_PointCoord * 2.0 - 1.0;
  float r2 = dot(d, d);
  if (uShadow > 0.5) {
    float a = exp(-r2 * 2.6) * 0.34 / (1.0 + max(vZ, 0.0) * 40.0);
    frag = vec4(0.0, 0.0, 0.0, a);
    return;
  }
  if (r2 > 1.0) discard;
  // Pale quartz sand with a few darker and warmer grains, lit like tiny spheres.
  vec3 base = mix(vec3(0.95, 0.88, 0.72), vec3(0.78, 0.66, 0.5), vTint * vTint);
  if (vTint > 0.93) base = vec3(0.55, 0.48, 0.42);
  float n = sqrt(max(0.0, 1.0 - r2));
  float l = 0.55 + 0.6 * max(0.0, dot(vec3(d.x, d.y, n), normalize(vec3(-0.5, -0.7, 0.9))));
  float fade = vZ < 0.0 ? max(0.0, 1.0 + vZ * 1.6) : 1.0;
  frag = vec4(base * l * fade, smoothstep(1.0, 0.6, r2) * fade);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string) {
  const make = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
    return s;
  };
  const p = gl.createProgram()!;
  gl.attachShader(p, make(gl.VERTEX_SHADER, vs));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fs));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
  const u = new Map<string, WebGLUniformLocation | null>();
  return { p, u: (name: string) => (u.has(name) ? u.get(name)! : (u.set(name, gl.getUniformLocation(p, name)), u.get(name)!)) };
}

export class PlateView {
  private gl: WebGL2RenderingContext;
  private plate: ReturnType<typeof compile>;
  private grain: ReturnType<typeof compile>;
  private field: WebGLTexture;
  private vao: WebGLVertexArrayObject;
  private buf: WebGLBuffer;
  private data: Float32Array;

  constructor(canvas: HTMLCanvasElement, maxGrains: number) {
    const gl = canvas.getContext('webgl2', { antialias: false, alpha: false, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available.');
    this.gl = gl;
    this.plate = compile(gl, QUAD_VS, PLATE_FS);
    this.grain = compile(gl, GRAIN_VS, GRAIN_FS);
    this.field = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.field);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, GRID, GRID, 0, gl.RED, gl.FLOAT, new Float32Array(GRID * GRID));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.data = new Float32Array(maxGrains * 4);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.data.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 16, 0);
    gl.bindVertexArray(null);
  }

  /** Grain buffer to fill: x, y (device px), height, tint per grain. */
  get grains() {
    return this.data;
  }

  draw(o: { w: number; h: number; cx: number; cy: number; half: number; circle: boolean; t: number; shimmer: number; field: Float32Array; count: number; size: number }) {
    const gl = this.gl;
    gl.viewport(0, 0, o.w, o.h);
    gl.disable(gl.BLEND);
    gl.bindTexture(gl.TEXTURE_2D, this.field);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GRID, GRID, gl.RED, gl.FLOAT, o.field);
    const P = this.plate;
    gl.useProgram(P.p);
    gl.uniform2f(P.u('uRes'), o.w, o.h);
    gl.uniform3f(P.u('uPlate'), o.cx, o.cy, o.half);
    gl.uniform1f(P.u('uCircle'), o.circle ? 1 : 0);
    gl.uniform1f(P.u('uTime'), o.t);
    gl.uniform1f(P.u('uShimmer'), o.shimmer);
    gl.uniform1i(P.u('uField'), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!o.count) return;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.data, 0, o.count * 4);
    const G = this.grain;
    gl.useProgram(G.p);
    gl.uniform2f(G.u('uRes'), o.w, o.h);
    gl.uniform1f(G.u('uSize'), o.size);
    gl.uniform1f(G.u('uHalf'), o.half);
    gl.uniform1f(G.u('uShadow'), 1);
    gl.drawArrays(gl.POINTS, 0, o.count);
    gl.uniform1f(G.u('uShadow'), 0);
    gl.drawArrays(gl.POINTS, 0, o.count);
    gl.bindVertexArray(null);
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.field);
    gl.deleteBuffer(this.buf);
    gl.deleteVertexArray(this.vao);
    gl.deleteProgram(this.plate.p);
    gl.deleteProgram(this.grain.p);
  }
}
