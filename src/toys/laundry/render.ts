import { compile, Program } from '../../shell/gl';
import type { Mat4, Vec3 } from '../cloth/math';
import type { Laundry } from './sim';

const LIGHT: Vec3 = normalize([-0.35, -0.8, -0.5]);

const clothVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
layout(location = 3) in float aPattern;
layout(location = 4) in vec3 aColA;
layout(location = 5) in vec3 aColB;
uniform mat4 viewProj;
uniform float shadow;
uniform float floorY;
uniform vec3 lightDir;
out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
out float vPattern;
out vec3 vColA;
out vec3 vColB;
void main() {
  vec3 p = aPos;
  if (shadow > 0.5) {
    float t = (p.y - floorY) / -lightDir.y;
    p = p + lightDir * t + vec3(0.0, 0.003, 0.0);
  }
  vPos = p;
  vNormal = aNormal;
  vUv = aUv;
  vPattern = aPattern;
  vColA = aColA;
  vColB = aColB;
  gl_Position = viewProj * vec4(p, 1.0);
}`;

const clothFrag = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
in vec2 vUv;
in float vPattern;
in vec3 vColA;
in vec3 vColB;
uniform vec3 eye;
uniform vec3 lightDir;
uniform float shadow;
out vec4 fragColor;

vec3 fabric(vec2 uv) {
  float p = vPattern;
  if (p < 0.5) return vColA;
  if (p < 1.5) return mix(vColA, vColB, step(0.5, fract(uv.x * 5.0)));             // stripes
  if (p < 2.5) {                                                                     // gingham
    vec2 g = step(0.5, fract(uv * vec2(7.0, 9.0)));
    return mix(vColA, vColB, (g.x + g.y) * 0.5);
  }
  if (p < 3.5) {                                                                     // polka dots
    vec2 q = fract(uv * vec2(6.0, 8.0)) - 0.5;
    return mix(vColA, vColB, smoothstep(0.22, 0.18, length(q)));
  }
  // Towel: plain with bands near the ends.
  float band = step(abs(uv.y - 0.12), 0.03) + step(abs(uv.y - 0.88), 0.03);
  return mix(vColA, vColB, clamp(band, 0.0, 1.0));
}

void main() {
  if (shadow > 0.5) {
    fragColor = vec4(0.0, 0.05, 0.0, 0.28);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 v = normalize(eye - vPos);
  if (!gl_FrontFacing) n = -n;
  vec3 L = -lightDir;
  vec3 base = fabric(vUv);
  if (!gl_FrontFacing) base *= 0.85;
  vec2 w = sin(vUv * vec2(160.0, 200.0));
  base *= 0.93 + 0.07 * w.x * w.y;
  float diff = clamp((dot(n, L) + 0.3) / 1.3, 0.0, 1.0);
  // Thin cotton glows when the sun is behind it.
  float back = clamp(dot(-n, L), 0.0, 1.0) * 0.45;
  float sheen = pow(1.0 - abs(dot(n, v)), 4.0) * 0.25;
  vec3 col = base * (0.32 + 0.75 * diff + back * vec3(1.0, 0.95, 0.85)) + sheen * base;
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

const skyVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.999, 1.0); }`;

const skyFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform float time;
uniform float horizon; // screen-space y of the horizon
uniform float aspect;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
void main() {
  vec3 top = vec3(0.28, 0.55, 0.92);
  vec3 low = vec3(0.78, 0.9, 1.0);
  vec3 col = mix(low, top, smoothstep(horizon, 1.0, vUv.y));
  // Drifting clouds.
  vec2 q = vec2(vUv.x * aspect * 4.0 + time * 0.03, vUv.y * 3.0);
  float c = noise(q) * 0.6 + noise(q * 2.3 + 7.0) * 0.4;
  col = mix(col, vec3(1.0), smoothstep(0.62, 0.8, c) * smoothstep(horizon, horizon + 0.2, vUv.y) * 0.8);
  // Sun glow top-left.
  float sd = length((vUv - vec2(0.22, 0.9)) * vec2(aspect, 1.0)) / max(aspect, 0.4);
  col += vec3(1.0, 0.92, 0.7) * (smoothstep(0.05, 0.035, sd) * 0.6 + pow(max(0.0, 1.0 - sd * 3.0), 3.0) * 0.35);
  fragColor = vec4(col, 1.0);
}`;

const groundVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
uniform mat4 viewProj;
out vec3 vPos;
void main() { vPos = aPos; gl_Position = viewProj * vec4(aPos, 1.0); }`;

const groundFrag = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 g = vPos.xz * 60.0;
  float blade = hash(floor(g)) * 0.25 + hash(floor(g * 0.37)) * 0.15;
  vec3 col = mix(vec3(0.23, 0.48, 0.16), vec3(0.4, 0.66, 0.24), blade + 0.3 * smoothstep(-2.0, 1.0, -vPos.z));
  col = pow(col, vec3(1.0 / 1.6));
  fragColor = vec4(col, 1.0);
}`;

const sphereVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aSphere;
layout(location = 2) in vec3 aColor;
uniform mat4 view;
uniform mat4 proj;
out vec2 vCorner;
out vec3 vCenter;
out float vR;
out vec3 vColor;
void main() {
  vec4 c = view * vec4(aSphere.xyz, 1.0);
  vCorner = aCorner * 1.05;
  vCenter = c.xyz;
  vR = aSphere.w;
  vColor = aColor;
  gl_Position = proj * (c + vec4(aCorner * aSphere.w * 1.05, 0.0, 0.0));
}`;

const sphereFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vCorner;
in vec3 vCenter;
in float vR;
in vec3 vColor;
uniform mat4 proj;
uniform mat4 view;
uniform vec3 lightDir;
out vec4 fragColor;
void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  vec3 n = vec3(vCorner, sqrt(1.0 - r2));
  vec4 clip = proj * vec4(vCenter + n * vR, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
  vec3 L = normalize((view * vec4(-lightDir, 0.0)).xyz);
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0) * 0.3;
  vec3 col = vColor * (0.35 + 0.75 * diff) + spec;
  fragColor = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

const MAX_SPHERES = 1024;

export class LaundryRenderer {
  private cloth: Program;
  private sky: Program;
  private ground: Program;
  private sphere: Program;
  private vao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private nrmBuf: WebGLBuffer;
  private idxBuf: WebGLBuffer;
  private idxCount = 0;
  private topology = -1;
  private normals: Float32Array;
  private skyVao: WebGLVertexArrayObject;
  private groundVao: WebGLVertexArrayObject;
  private sphereVao: WebGLVertexArrayObject;
  private sphereBuf: WebGLBuffer;
  private sphereColBuf: WebGLBuffer;
  private sphereData = new Float32Array(MAX_SPHERES * 4);
  private sphereCol = new Float32Array(MAX_SPHERES * 3);

  constructor(private gl: WebGL2RenderingContext, private sim: Laundry) {
    this.cloth = new Program(gl, compile(gl, gl.VERTEX_SHADER, clothVert), clothFrag);
    this.sky = new Program(gl, compile(gl, gl.VERTEX_SHADER, skyVert), skyFrag);
    this.ground = new Program(gl, compile(gl, gl.VERTEX_SHADER, groundVert), groundFrag);
    this.sphere = new Program(gl, compile(gl, gl.VERTEX_SHADER, sphereVert), sphereFrag);

    this.normals = new Float32Array(sim.n * 3);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.posBuf = this.attrib(0, 3, sim.pos, gl.DYNAMIC_DRAW);
    this.nrmBuf = this.attrib(1, 3, this.normals, gl.DYNAMIC_DRAW);
    this.attrib(2, 2, sim.uv, gl.STATIC_DRAW);
    this.attrib(3, 1, sim.pattern, gl.STATIC_DRAW);
    this.attrib(4, 3, sim.colorA, gl.STATIC_DRAW);
    this.attrib(5, 3, sim.colorB, gl.STATIC_DRAW);
    this.idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);

    this.skyVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.skyVao);
    this.attrib(0, 2, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);

    const f = sim.floorY;
    this.groundVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.groundVao);
    this.attrib(0, 3, new Float32Array([-12, f, -12, 12, f, -12, -12, f, 6, 12, f, -12, 12, f, 6, -12, f, 6]), gl.STATIC_DRAW);

    this.sphereVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.sphereVao);
    this.attrib(0, 2, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.sphereBuf = this.attrib(1, 4, this.sphereData, gl.DYNAMIC_DRAW);
    gl.vertexAttribDivisor(1, 1);
    this.sphereColBuf = this.attrib(2, 3, this.sphereCol, gl.DYNAMIC_DRAW);
    gl.vertexAttribDivisor(2, 1);
    gl.bindVertexArray(null);
  }

  private attrib(loc: number, size: number, data: Float32Array, usage: number) {
    const gl = this.gl;
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return buf;
  }

  private updateMesh() {
    const gl = this.gl;
    const s = this.sim;
    if (s.topology !== this.topology) {
      this.topology = s.topology;
      const idx = new Uint32Array(s.nt * 3);
      let k = 0;
      for (let t = 0; t < s.nt; t++) {
        if (!s.triAlive[t]) continue;
        idx[k++] = s.tris[t * 3];
        idx[k++] = s.tris[t * 3 + 1];
        idx[k++] = s.tris[t * 3 + 2];
      }
      this.idxCount = k;
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx.subarray(0, k), gl.DYNAMIC_DRAW);
    }
    const nrm = this.normals;
    const p = s.pos;
    nrm.fill(0);
    for (let t = 0; t < s.nt; t++) {
      if (!s.triAlive[t]) continue;
      const a = s.tris[t * 3] * 3, b = s.tris[t * 3 + 1] * 3, c = s.tris[t * 3 + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
      for (const v of [a, b, c]) {
        nrm[v] += nx;
        nrm[v + 1] += ny;
        nrm[v + 2] += nz;
      }
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, this.posBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.pos);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.nrmBuf);
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, nrm);
  }

  draw(width: number, height: number, view: Mat4, proj: Mat4, viewProj: Mat4, eye: Vec3, horizon: number, t: number) {
    const gl = this.gl;
    const s = this.sim;
    this.updateMesh();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.6, 0.8, 1, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let u = this.sky.use();
    gl.uniform1f(u.time, t);
    gl.uniform1f(u.horizon, horizon);
    gl.uniform1f(u.aspect, width / height);
    gl.bindVertexArray(this.skyVao);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);

    u = this.ground.use();
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.bindVertexArray(this.groundVao);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // Soft translucent shadows on the grass, then the laundry itself.
    u = this.cloth.use();
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform3f(u.lightDir, LIGHT[0], LIGHT[1], LIGHT[2]);
    gl.uniform3f(u.eye, eye[0], eye[1], eye[2]);
    gl.uniform1f(u.floorY, s.floorY);
    gl.bindVertexArray(this.vao);
    gl.uniform1f(u.shadow, 1);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.drawElements(gl.TRIANGLES, this.idxCount, gl.UNSIGNED_INT, 0);
    gl.depthMask(true);
    gl.disable(gl.BLEND);
    gl.uniform1f(u.shadow, 0);
    gl.drawElements(gl.TRIANGLES, this.idxCount, gl.UNSIGNED_INT, 0);

    // Rope, posts and clothespins as sphere impostors.
    let k = 0;
    const put = (x: number, y: number, z: number, r: number, c: Vec3) => {
      if (k >= MAX_SPHERES) return;
      this.sphereData.set([x, y, z, r], k * 4);
      this.sphereCol.set(c, k * 3);
      k++;
    };
    const rope: Vec3 = [0.92, 0.9, 0.82];
    for (let i = 0; i + 1 < s.ropeCount; i++) {
      const a = (s.ropeFirst + i) * 3;
      const b = a + 3;
      for (let f = 0; f < 1; f += 0.34) put(s.pos[a] + (s.pos[b] - s.pos[a]) * f, s.pos[a + 1] + (s.pos[b + 1] - s.pos[a + 1]) * f, s.pos[a + 2] + (s.pos[b + 2] - s.pos[a + 2]) * f, 0.009, rope);
    }
    const wood: Vec3 = [0.45, 0.28, 0.14];
    for (const px of [-s.postX, s.postX]) for (let y = s.floorY; y <= s.lineY + 0.06; y += 0.015) put(px, y, 0, 0.032, wood);
    const peg: Vec3 = [0.85, 0.62, 0.36];
    for (const g of s.garments)
      for (const c of g.pins) {
        if (!s.alive[c]) continue;
        const o = s.ca[c] * 3;
        put(s.pos[o] - 0.008, s.pos[o + 1] + 0.012, s.pos[o + 2] + 0.012, 0.014, peg);
        put(s.pos[o] + 0.008, s.pos[o + 1] + 0.012, s.pos[o + 2] + 0.012, 0.014, peg);
      }
    for (const p of s.flyingPins) {
      const ax = Math.cos(p.age * p.spin) * 0.01;
      const ay = Math.sin(p.age * p.spin) * 0.01;
      put(p.x - ax, p.y - ay, p.z, 0.014, peg);
      put(p.x + ax, p.y + ay, p.z, 0.014, peg);
    }
    if (k) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sphereBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sphereData.subarray(0, k * 4));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.sphereColBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, this.sphereCol.subarray(0, k * 3));
      u = this.sphere.use();
      gl.uniformMatrix4fv(u.view, false, view);
      gl.uniformMatrix4fv(u.proj, false, proj);
      gl.uniform3f(u.lightDir, LIGHT[0], LIGHT[1], LIGHT[2]);
      gl.bindVertexArray(this.sphereVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, k);
    }
  }
}

function normalize(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
}
