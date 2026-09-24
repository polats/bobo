import { compile, Program } from '../../shell/gl';

/** Instance layout: x, y, hx, hy | angle, kind, variation, alpha | r, g, b, extra */
export const FLOATS = 12;
export const enum Sprite {
  Block = 0,
  Metal = 1,
  Shadow = 2,
  Streak = 3,
  Dust = 4,
  Link = 5,
}

const skyVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() { vUv = aPosition * 0.5 + 0.5; gl_Position = vec4(aPosition, 0.0, 1.0); }`;

const skyFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec4 view;   // centre x, y, width, height (world metres)
uniform float time;
out vec4 fragColor;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec2 w = view.xy + (vUv - 0.5) * view.zw;
  vec3 col;
  if (w.y >= 0.0) {
    float t = clamp(w.y / 28.0, 0.0, 1.0);
    col = mix(vec3(0.62, 0.84, 1.0), vec3(0.2, 0.48, 0.92), t);
    // Sun.
    vec2 sp = vec2(-4.0, 21.0);
    float sd = length(w - sp);
    col += vec3(1.0, 0.9, 0.6) * (smoothstep(1.4, 1.2, sd) * 0.7 + exp(-sd * 0.35) * 0.25);
    // Puffy clouds drifting.
    for (int i = 0; i < 4; i++) {
      float fi = float(i);
      vec2 c = vec2(mod(fi * 7.3 + time * 0.25 * (0.5 + hash(fi)), 36.0) - 18.0, 14.0 + fi * 3.1);
      float d = length((w - c) * vec2(0.55, 1.0)) - 1.2;
      d = min(d, length((w - c - vec2(1.3, 0.3)) * vec2(0.6, 1.0)) - 1.0);
      d = min(d, length((w - c + vec2(1.4, -0.2)) * vec2(0.6, 1.0)) - 0.8);
      col = mix(col, vec3(1.0), smoothstep(0.15, -0.15, d) * 0.85);
    }
    // Two layers of distant hills.
    float h1 = 3.0 + 1.2 * sin(w.x * 0.21 + 1.0) + 0.7 * sin(w.x * 0.47 + 2.0);
    float h2 = 1.6 + 0.9 * sin(w.x * 0.33 + 4.0) + 0.4 * sin(w.x * 0.9);
    if (w.y < h1) col = mix(col, vec3(0.55, 0.75, 0.62), 0.85);
    if (w.y < h2) col = mix(col, vec3(0.42, 0.66, 0.45), 0.9);
  } else {
    // Grass lip over layered soil.
    float grass = smoothstep(-0.32, -0.26, w.y);
    vec3 soil = mix(vec3(0.45, 0.3, 0.18), vec3(0.36, 0.23, 0.14), smoothstep(-0.4, -4.0, w.y));
    soil *= 0.92 + 0.08 * step(0.5, fract(w.y * 1.4 + 0.3 * sin(w.x * 1.7)));
    vec3 g = vec3(0.36, 0.64, 0.25) * (0.92 + 0.1 * sin(w.x * 23.0));
    col = mix(soil, g, grass);
  }
  fragColor = vec4(col, 1.0);
}`;

const spriteVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aA;  // x, y, hx, hy
layout(location = 2) in vec4 aB;  // angle, kind, variation, alpha
layout(location = 3) in vec4 aC;  // r, g, b, extra
uniform vec4 view;
out vec2 vLocal;
out vec2 vHalf;
out vec4 vB;
out vec4 vC;
out float vAngle;
void main() {
  float pad = aB.y == 2.0 ? 0.18 : 0.03; // shadows are blurred past their edge
  vec2 half_ = aA.zw + pad;
  vec2 lp = aCorner * half_;
  float c = cos(aB.x), s = sin(aB.x);
  vec2 wp = aA.xy + vec2(c * lp.x - s * lp.y, s * lp.x + c * lp.y);
  vLocal = lp;
  vHalf = aA.zw;
  vB = aB;
  vC = aC;
  vAngle = aB.x;
  gl_Position = vec4((wp - view.xy) / view.zw * 2.0, 0.0, 1.0);
}`;

const spriteFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vHalf;
in vec4 vB;
in vec4 vC;
in float vAngle;
out vec4 fragColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}

void main() {
  float kind = vB.y;
  vec3 col = vC.rgb;
  float alpha = vB.w;
  if (kind < 0.5) {
    // Toy block: rounded, bevelled, lit from the top left.
    float rad = min(0.07, 0.3 * min(vHalf.x, vHalf.y));
    float d = sdRoundBox(vLocal, vHalf, rad);
    float aa = fwidth(d) * 1.2;
    float cover = 1.0 - smoothstep(-aa, aa, d);
    if (cover <= 0.001) discard;
    float bw = min(0.08, 0.4 * min(vHalf.x, vHalf.y));
    float t = clamp(-d / bw, 0.0, 1.0);
    vec2 q = abs(vLocal) - vHalf + rad;
    vec2 n = q.x > q.y ? vec2(sign(vLocal.x), 0.0) : vec2(0.0, sign(vLocal.y));
    if (q.x > 0.0 && q.y > 0.0) n = normalize(sign(vLocal) * q);
    float c = cos(vAngle), s = sin(vAngle);
    vec2 nw = vec2(c * n.x - s * n.y, s * n.x + c * n.y);
    float lit = dot(nw, normalize(vec2(-0.55, 0.85)));
    col *= 0.9 + vB.z * 0.2;
    col *= 1.0 + (1.0 - t) * lit * 0.45;
    // Soft face gradient and a glossy streak across the top of the face.
    float fy = (s * vLocal.x + c * vLocal.y) / max(vHalf.x, vHalf.y);
    col *= 0.94 + 0.08 * fy;
    col = mix(col * 0.55, col, smoothstep(0.0, 0.03, -d));
    fragColor = vec4(col * cover * alpha, cover * alpha);
    return;
  }
  if (kind < 1.5) {
    // Metal sphere (wrecking ball, cannonball, hook).
    float r = vHalf.x;
    float l = length(vLocal) / r;
    float aa = fwidth(l) * 1.2;
    float cover = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, l);
    if (cover <= 0.001) discard;
    vec3 n = vec3(vLocal / r, sqrt(max(0.0, 1.0 - l * l)));
    vec3 L = normalize(vec3(-0.5, 0.7, 0.6));
    float diff = max(dot(n, L), 0.0);
    float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);
    vec3 c2 = col * (0.25 + 0.8 * diff) + spec * 0.8 + vec3(0.25, 0.3, 0.4) * pow(1.0 - n.z, 3.0) * 0.4;
    fragColor = vec4(c2 * cover, cover);
    return;
  }
  if (kind < 2.5) {
    // Soft contact shadow.
    float rad = min(0.07, 0.3 * min(vHalf.x, vHalf.y));
    float d = sdRoundBox(vLocal, vHalf, rad);
    float a = (1.0 - smoothstep(-0.12, 0.16, d)) * alpha;
    fragColor = vec4(0.0, 0.03, 0.06, 1.0) * a;
    return;
  }
  if (kind < 3.5) {
    // Motion streak: fades toward the tail (-x).
    float u = vLocal.x / vHalf.x;
    float v = abs(vLocal.y) / vHalf.y;
    float a = smoothstep(-1.0, 0.8, u) * (1.0 - smoothstep(0.4, 1.0, v)) * (1.0 - smoothstep(0.85, 1.0, u)) * alpha;
    fragColor = vec4(col, 1.0) * a;
    return;
  }
  if (kind < 4.5) {
    // Dust puff.
    float l = length(vLocal) / vHalf.x;
    float a = pow(max(0.0, 1.0 - l), 1.6) * alpha;
    fragColor = vec4(col, 1.0) * a;
    return;
  }
  // Chain link: an oval ring.
  float d = abs(sdRoundBox(vLocal, vHalf, min(vHalf.x, vHalf.y)) + 0.035) - 0.03;
  float aa = fwidth(d);
  float cover = 1.0 - smoothstep(-aa, aa, d);
  if (cover <= 0.001) discard;
  float sh = 0.6 + 0.4 * clamp(-vLocal.y / vHalf.y * 0.5 + 0.5, 0.0, 1.0);
  fragColor = vec4(col * sh * cover, cover);
}`;

export class DemolitionRenderer {
  private sky: Program;
  private sprite: Program;
  private quad: WebGLVertexArrayObject;
  private vao: WebGLVertexArrayObject;
  private inst: WebGLBuffer;
  private capacity = 0;

  constructor(private gl: WebGL2RenderingContext) {
    this.sky = new Program(gl, compile(gl, gl.VERTEX_SHADER, skyVert), skyFrag);
    this.sprite = new Program(gl, compile(gl, gl.VERTEX_SHADER, spriteVert), spriteFrag);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    for (let k = 0; k < 3; k++) {
      gl.enableVertexAttribArray(1 + k);
      gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, FLOATS * 4, k * 16);
      gl.vertexAttribDivisor(1 + k, 1);
    }
    gl.bindVertexArray(null);
  }

  draw(width: number, height: number, view: [number, number, number, number], time: number, data: Float32Array, count: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    let u = this.sky.use();
    gl.uniform4f(u.view, ...view);
    gl.uniform1f(u.time, time);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    if (count > this.capacity) {
      this.capacity = Math.max(count, this.capacity * 2, 1024);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * FLOATS * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, count * FLOATS));
    u = this.sprite.use();
    gl.uniform4f(u.view, ...view);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.BLEND);
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
