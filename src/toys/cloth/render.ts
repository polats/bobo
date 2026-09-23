import { compile, Program } from '../../shell/gl';
import type { Cloth } from './sim';
import type { Mat4, Vec3 } from './math';

export type Fabric = 'velvet' | 'flag' | 'canvas';

const clothVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aUv;
uniform mat4 viewProj;
uniform float shadow;      // 1 = project onto the shadow plane
uniform vec4 plane;        // shadow receiver: dot(n, p) + d = 0
uniform vec3 lightDir;     // direction light travels
out vec3 vPos;
out vec3 vNormal;
out vec2 vUv;
void main() {
  vec3 p = aPos;
  if (shadow > 0.5) {
    float t = (dot(plane.xyz, p) + plane.w) / dot(plane.xyz, lightDir);
    p = p - lightDir * t + plane.xyz * 0.002;
  }
  vPos = p;
  vNormal = aNormal;
  vUv = aUv;
  gl_Position = viewProj * vec4(p, 1.0);
}`;

const clothFrag = /* glsl */ `#version 300 es
precision highp float;
in vec3 vPos;
in vec3 vNormal;
in vec2 vUv;
uniform vec3 eye;
uniform vec3 lightDir;
uniform float shadow;
uniform vec3 shadowColor;
uniform float fabric;      // 0 velvet curtain, 1 flag, 2 striped canvas
uniform vec2 threads;      // weave frequency
out vec4 fragColor;

vec3 pattern(vec2 uv) {
  if (fabric < 0.5) {
    // Deep red velvet with a gold band near the hem.
    vec3 c = vec3(0.3, 0.012, 0.035);
    float band = smoothstep(0.012, 0.0, abs(uv.y - 0.9) - 0.018);
    return mix(c, vec3(0.8, 0.5, 0.12), band);
  }
  if (fabric < 1.5) {
    // Bold horizontal stripes with a canton.
    float s = floor(uv.y * 5.0);
    vec3 c = mod(s, 2.0) < 1.0 ? vec3(1.0, 0.28, 0.45) : vec3(1.0, 0.95, 0.86);
    if (uv.x < 0.38 && uv.y < 0.6) {
      c = vec3(0.12, 0.3, 0.75);
      vec2 g = fract(uv * vec2(9.0, 8.0)) - 0.5;
      c = mix(c, vec3(1.0, 0.9, 0.5), smoothstep(0.2, 0.12, length(g)));
    }
    return c;
  }
  // Sun-bleached striped canvas.
  float s = step(0.5, fract(uv.x * 6.0));
  return mix(vec3(0.95, 0.9, 0.8), vec3(0.1, 0.55, 0.62), s);
}

void main() {
  if (shadow > 0.5) {
    fragColor = vec4(pow(shadowColor, vec3(1.0 / 2.2)), 1.0);
    return;
  }
  vec3 n = normalize(vNormal);
  vec3 v = normalize(eye - vPos);
  bool front = gl_FrontFacing;
  if (!front) n = -n;
  vec3 L = -lightDir;
  vec3 base = pattern(vUv);
  if (!front) base = mix(base, vec3(0.85, 0.8, 0.72), 0.55) * 0.85; // lighter lining on the back
  // Woven threads: tiny brightness ripple that sells the fabric scale.
  vec2 w = sin(vUv * threads * 6.2831);
  base *= 0.9 + 0.1 * (w.x * w.y);
  float wrap = 0.35;
  float diff = clamp((dot(n, L) + wrap) / (1.0 + wrap), 0.0, 1.0);
  float nv = abs(dot(n, v));
  // Velvet and satin both brighten at grazing angles.
  float sheen = pow(1.0 - nv, fabric < 0.5 ? 2.5 : 4.0) * (fabric < 0.5 ? 0.9 : 0.35);
  vec3 h = normalize(L + v);
  float spec = pow(max(dot(n, h), 0.0), 32.0) * (fabric < 0.5 ? 0.08 : 0.25);
  vec3 col = base * (0.25 + 0.85 * diff) + base * sheen + spec;
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

const quadVert = /* glsl */ `#version 300 es
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
uniform float scene;
out vec4 fragColor;
void main() {
  vec3 col;
  if (abs(vPos.y - floorY) < 0.001) {
    // Warm wooden floor boards.
    float board = floor(vPos.x * 6.0);
    float grain = sin(vPos.z * 40.0 + sin(vPos.x * 3.0 + board) * 4.0) * 0.5 + 0.5;
    col = vec3(0.42, 0.27, 0.17) * (0.85 + 0.15 * grain) * (0.9 + 0.1 * fract(sin(board * 91.7) * 43758.5));
    col *= smoothstep(-0.5, 0.2, fract(vPos.x * 6.0)) * 0.1 + 0.9;
  } else {
    // Soft plaster wall with a vertical light falloff.
    col = mix(vec3(0.03, 0.025, 0.04), vec3(0.11, 0.09, 0.12), smoothstep(-1.4, 1.6, vPos.y));
    if (scene > 0.5 && scene < 1.5) col = mix(vec3(0.35, 0.6, 0.9), vec3(0.75, 0.88, 1.0), smoothstep(-1.4, 1.6, vPos.y)); // sky for the flag
  }
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

const ballVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aBall; // xyz center, w radius
layout(location = 2) in float aHue;
uniform mat4 view;
uniform mat4 proj;
out vec2 vCorner;
out vec3 vCenterView;
out float vRadius;
out float vHue;
void main() {
  vec4 c = view * vec4(aBall.xyz, 1.0);
  vec4 p = c + vec4(aCorner * aBall.w * 1.05, 0.0, 0.0);
  vCorner = aCorner * 1.05;
  vCenterView = c.xyz;
  vRadius = aBall.w;
  vHue = aHue;
  gl_Position = proj * p;
}`;

const ballFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vCorner;
in vec3 vCenterView;
in float vRadius;
in float vHue;
uniform mat4 proj;
uniform mat4 view;
uniform vec3 lightDir;
out vec4 fragColor;
vec3 hsv(float h) { return clamp(abs(mod(h * 6.0 + vec3(0.0, 4.0, 2.0), 6.0) - 3.0) - 1.0, 0.0, 1.0); }
void main() {
  float r2 = dot(vCorner, vCorner);
  if (r2 > 1.0) discard;
  vec3 n = vec3(vCorner, sqrt(1.0 - r2));
  vec3 posView = vCenterView + n * vRadius;
  vec4 clip = proj * vec4(posView, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
  vec3 L = normalize((view * vec4(-lightDir, 0.0)).xyz);
  float diff = max(dot(n, L), 0.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 60.0);
  vec3 base = mix(hsv(vHue), vec3(1.0), 0.08);
  // Negative hue marks hardware: gold rod, silver pole.
  if (vHue < -1.5) base = vec3(0.75, 0.77, 0.8);
  else if (vHue < 0.0) base = vec3(0.9, 0.62, 0.2);
  vec3 col = base * (0.22 + 0.85 * diff) + spec * (vHue < 0.0 ? 1.4 : 0.9);
  col = pow(col, vec3(1.0 / 2.2));
  fragColor = vec4(col, 1.0);
}`;

const trailVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;  // clip xy
layout(location = 1) in float aAlpha;
out float vAlpha;
void main() {
  vAlpha = aAlpha;
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const trailFrag = /* glsl */ `#version 300 es
precision highp float;
in float vAlpha;
out vec4 fragColor;
void main() { fragColor = vec4(vec3(1.0, 0.95, 0.8) * vAlpha, vAlpha); }`;

const MAX_SPHERES = 256;

export interface TrailPoint {
  x: number; // screen uv
  y: number;
  age: number;
}

export class ClothRenderer {
  private cloth: WebGLProgram;
  private clothU: Record<string, WebGLUniformLocation>;
  private room: Program;
  private ball: Program;
  private trail: Program;
  private vao: WebGLVertexArrayObject;
  private posBuf: WebGLBuffer;
  private nrmBuf: WebGLBuffer;
  private uvBuf: WebGLBuffer;
  private idxBuf: WebGLBuffer;
  private idxCount = 0;
  private topology = -1;
  private normals: Float32Array;
  private roomVao: WebGLVertexArrayObject;
  private ballVao: WebGLVertexArrayObject;
  private ballBuf: WebGLBuffer;
  private hueBuf: WebGLBuffer;
  private trailVao: WebGLVertexArrayObject;
  private trailBuf: WebGLBuffer;

  constructor(private gl: WebGL2RenderingContext, private sim: Cloth) {
    const cv = compile(gl, gl.VERTEX_SHADER, clothVert);
    const cp = new Program(gl, cv, clothFrag);
    this.cloth = cp.program;
    this.clothU = cp.uniforms;
    this.room = new Program(gl, compile(gl, gl.VERTEX_SHADER, quadVert), roomFrag);
    this.ball = new Program(gl, compile(gl, gl.VERTEX_SHADER, ballVert), ballFrag);
    this.trail = new Program(gl, compile(gl, gl.VERTEX_SHADER, trailVert), trailFrag);

    this.normals = new Float32Array(sim.n * 3);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    this.posBuf = this.attrib(0, 3, sim.pos, gl.DYNAMIC_DRAW);
    this.nrmBuf = this.attrib(1, 3, this.normals, gl.DYNAMIC_DRAW);
    this.uvBuf = this.attrib(2, 2, sim.uv, gl.STATIC_DRAW);
    this.idxBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.idxBuf);

    // Room: back wall and floor as two big quads.
    const f = sim.floorY;
    const zw = sim.scene === 'hammock' ? -2.2 : -0.7;
    const room = new Float32Array([
      -6, f, zw, 6, f, zw, -6, f, 6, 6, f, zw, 6, f, 6, -6, f, 6,
      -6, f, zw, 6, f, zw, -6, 6, zw, 6, f, zw, 6, 6, zw, -6, 6, zw,
    ]);
    this.roomVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.roomVao);
    this.attrib(0, 3, room, gl.STATIC_DRAW);

    this.ballVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.ballVao);
    this.attrib(0, 2, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    this.ballBuf = this.attrib(1, 4, new Float32Array(MAX_SPHERES * 4), gl.DYNAMIC_DRAW);
    gl.vertexAttribDivisor(1, 1);
    this.hueBuf = this.attrib(2, 1, new Float32Array(MAX_SPHERES), gl.DYNAMIC_DRAW);
    gl.vertexAttribDivisor(2, 1);

    this.trailVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.trailVao);
    this.trailBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuf);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 12, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 1, gl.FLOAT, false, 12, 8);
    gl.bindVertexArray(null);
  }

  get wallZ() {
    return this.sim.wallZ;
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
    // Smooth vertex normals from the living triangles.
    const nrm = this.normals;
    nrm.fill(0);
    const p = s.pos;
    for (let t = 0; t < s.nt; t++) {
      if (!s.triAlive[t]) continue;
      const a = s.tris[t * 3] * 3;
      const b = s.tris[t * 3 + 1] * 3;
      const c = s.tris[t * 3 + 2] * 3;
      const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
      const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
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

  draw(width: number, height: number, view: Mat4, proj: Mat4, viewProj: Mat4, eye: Vec3, fabric: Fabric, trail: TrailPoint[]) {
    const gl = this.gl;
    const s = this.sim;
    this.updateMesh();
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0.05, 0.05, 0.07, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const light: Vec3 = s.scene === 'hammock' ? [-0.15, -1, -0.35] : [-0.22, -0.35, -1];
    const ll = Math.hypot(...light);
    const L: Vec3 = [light[0] / ll, light[1] / ll, light[2] / ll];

    // Room.
    let u = this.room.use();
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform1f(u.floorY, s.floorY);
    gl.uniform1f(u.scene, s.scene === 'curtain' ? 0 : s.scene === 'flag' ? 1 : 2);
    gl.bindVertexArray(this.roomVao);
    gl.drawArrays(gl.TRIANGLES, 0, 12);

    // Shadow on the wall (or floor for the hammock), flat so overlaps never double-darken.
    gl.useProgram(this.cloth);
    const cu = this.clothU;
    gl.uniformMatrix4fv(cu.viewProj, false, viewProj);
    gl.uniform3f(cu.lightDir, L[0], L[1], L[2]);
    gl.uniform3f(cu.eye, eye[0], eye[1], eye[2]);
    gl.uniform1f(cu.fabric, fabric === 'velvet' ? 0 : fabric === 'flag' ? 1 : 2);
    gl.uniform2f(cu.threads, s.cols * 1.5, s.rows * 1.5);
    if (s.scene === 'hammock') gl.uniform4f(cu.plane, 0, 1, 0, -s.floorY);
    else gl.uniform4f(cu.plane, 0, 0, 1, -this.wallZ);
    gl.uniform3f(cu.shadowColor, ...((s.scene === 'flag' ? [0.2, 0.36, 0.58] : s.scene === 'hammock' ? [0.2, 0.13, 0.08] : [0.012, 0.01, 0.016]) as Vec3));
    gl.uniform1f(cu.shadow, 1);
    gl.bindVertexArray(this.vao);
    gl.disable(gl.CULL_FACE);
    gl.drawElements(gl.TRIANGLES, this.idxCount, gl.UNSIGNED_INT, 0);
    gl.uniform1f(cu.shadow, 0);
    gl.drawElements(gl.TRIANGLES, this.idxCount, gl.UNSIGNED_INT, 0);

    // Balls, plus the curtain rod / flagpole built from overlapping sphere impostors.
    const spheres: number[] = [];
    const hues: number[] = [];
    for (const b of s.balls) {
      spheres.push(b.x, b.y, b.z, b.r);
      hues.push(b.hue);
    }
    if (s.scene === 'curtain')
      for (let x = -0.8; x <= 0.8; x += 0.02) {
        spheres.push(x, 1.02, 0, 0.028);
        hues.push(-1);
      }
    if (s.scene === 'flag') {
      const px = s.pos[0];
      for (let y = s.floorY; y <= 0.82; y += 0.02) {
        spheres.push(px - 0.03, y, 0, 0.03);
        hues.push(-2);
      }
      spheres.push(px - 0.03, 0.84, 0, 0.05);
      hues.push(-1);
    }
    const count = Math.min(MAX_SPHERES, hues.length);
    if (count) {
      gl.bindBuffer(gl.ARRAY_BUFFER, this.ballBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(spheres.slice(0, count * 4)));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.hueBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Float32Array(hues.slice(0, count)));
      u = this.ball.use();
      gl.uniformMatrix4fv(u.view, false, view);
      gl.uniformMatrix4fv(u.proj, false, proj);
      gl.uniform3f(u.lightDir, L[0], L[1], L[2]);
      gl.bindVertexArray(this.ballVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    }

    // Glowing cut trail in screen space.
    gl.disable(gl.DEPTH_TEST);
    if (trail.length >= 2) {
      const aspect = width / height;
      const verts: number[] = [];
      for (let i = 0; i < trail.length; i++) {
        const a = trail[Math.max(0, i - 1)];
        const b = trail[Math.min(trail.length - 1, i + 1)];
        let dx = (b.x - a.x) * aspect;
        let dy = b.y - a.y;
        const l = Math.hypot(dx, dy) || 1;
        dx /= l;
        dy /= l;
        const alpha = Math.max(0, 1 - trail[i].age / 0.35);
        const w = 0.006 * (0.3 + alpha);
        const px = (-dy * w) / aspect;
        const py = dx * w;
        const x = trail[i].x * 2 - 1;
        const y = trail[i].y * 2 - 1;
        verts.push(x + px * 2, y + py * 2, alpha, x - px * 2, y - py * 2, alpha);
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.trailBuf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(verts), gl.STREAM_DRAW);
      this.trail.use();
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.bindVertexArray(this.trailVao);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, trail.length * 2);
      gl.disable(gl.BLEND);
    }
  }
}
