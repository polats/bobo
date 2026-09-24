import { compile, Program } from '../../shell/gl';
import type { JellyWorld } from './sim';

const bgVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
uniform vec2 world;
out vec2 vWorld;
void main() {
  vWorld = (aPosition * 0.5 + 0.5) * world;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const bgFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vWorld;
uniform vec2 world;
uniform float groundY;
out vec4 fragColor;
void main() {
  vec2 p = vWorld;
  vec3 col;
  if (p.y > groundY) {
    // Playroom wall: warm gradient with soft polka dots.
    float t = (p.y - groundY) / (world.y - groundY);
    col = mix(vec3(1.0, 0.86, 0.8), vec3(0.78, 0.72, 0.98), smoothstep(0.0, 1.0, t));
    vec2 g = p * 9.0;
    g.x += step(1.0, mod(floor(g.y), 2.0)) * 0.5;
    float dots = smoothstep(0.2, 0.16, length(fract(g) - 0.5));
    col = mix(col, col * 1.06 + 0.03, dots * 0.5);
    // Contact shadow where the wall meets the table.
    col *= 1.0 - 0.25 * exp(-(p.y - groundY) * 18.0);
  } else {
    // Table top, lighter at the back edge.
    float t = (groundY - p.y) / groundY;
    col = mix(vec3(0.99, 0.93, 0.84), vec3(0.93, 0.78, 0.66), t);
    col += 0.1 * exp(-(groundY - p.y) * 90.0);
  }
  fragColor = vec4(col, 1.0);
}`;

const fxVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aUv;
layout(location = 2) in vec4 aColor;
layout(location = 3) in float aKind;
uniform vec2 world;
out vec2 vUv;
out vec4 vColor;
out float vKind;
void main() {
  vUv = aUv;
  vColor = aColor;
  vKind = aKind;
  gl_Position = vec4(aPos / world * 2.0 - 1.0, 0.0, 1.0);
}`;

const fxFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
in vec4 vColor;
in float vKind;
out vec4 fragColor;
void main() {
  float r = length(vUv);
  float a;
  if (vKind < 0.5) a = pow(1.0 - smoothstep(0.2, 1.0, r), 1.6);          // soft shadow
  else if (vKind < 1.5) a = 1.0 - smoothstep(0.5, 1.0, r);               // dust puff
  else {                                                                   // sparkle
    vec2 u = abs(vUv);
    a = max(smoothstep(0.18, 0.0, u.x) * (1.0 - u.y), smoothstep(0.18, 0.0, u.y) * (1.0 - u.x));
    a = max(a, smoothstep(0.35, 0.0, r));
  }
  fragColor = vec4(vColor.rgb * vColor.a * a, vColor.a * a);
}`;

const jellyVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPos;
layout(location = 1) in vec2 aDome;
layout(location = 2) in vec2 aRest;
layout(location = 3) in float aRim;
layout(location = 4) in vec3 aColor;
layout(location = 5) in vec2 aMisc; // x = face flag, y = seed
uniform vec2 world;
out vec2 vDome;
out vec2 vRest;
out float vRim;
out vec3 vColor;
out vec2 vMisc;
void main() {
  vDome = aDome;
  vRest = aRest;
  vRim = aRim;
  vColor = aColor;
  vMisc = aMisc;
  gl_Position = vec4(aPos / world * 2.0 - 1.0, 0.0, 1.0);
}`;

const jellyFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vDome;
in vec2 vRest;
in float vRim;
in vec3 vColor;
in vec2 vMisc;
out vec4 fragColor;

float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  float r = clamp(vRim, 0.0, 1.0);
  vec3 base = vColor;
  // Thickness falls toward the edge: thick middles glow, thin edges go deep and saturated.
  float thick = sqrt(max(0.0, 1.0 - r * r));
  vec3 deep = base * base * 0.85;
  vec3 glow = mix(base, vec3(1.0, 0.97, 0.92), 0.28);
  vec3 col = mix(deep, glow, 0.25 + 0.7 * thick);
  vec2 dir = vDome / max(length(vDome), 1e-4);
  float lit = dot(dir, normalize(vec2(-0.55, 0.83)));
  col *= 0.88 + 0.18 * lit * r;
  // Light caught in the rim on the lit side, and a darker, denser rim away from it.
  col += vec3(1.0) * smoothstep(0.8, 0.98, r) * max(0.0, lit) * 0.38;
  col *= 1.0 - smoothstep(0.85, 1.0, r) * max(0.0, -lit) * 0.3;
  // Big soft specular blob plus a small sharp one: reads as wet and glossy.
  vec2 s1 = (vDome - vec2(-0.3, 0.38)) * vec2(1.0, 1.55);
  col += smoothstep(0.2, 0.04, length(s1)) * 0.6;
  col += smoothstep(0.06, 0.02, length(vDome - vec2(-0.1, 0.55))) * 0.7;
  // A few tiny bubbles suspended inside.
  for (int i = 0; i < 4; i++) {
    float fi = float(i) + vMisc.y * 7.0;
    vec2 c = vec2(hash(fi) - 0.5, hash(fi + 3.1) - 0.5) * 1.0;
    float rad = 0.025 + hash(fi + 5.7) * 0.03;
    float d = length(vRest - c);
    col += smoothstep(rad, rad * 0.6, d) * smoothstep(rad * 0.3, rad * 0.7, d) * 0.22;
    col += smoothstep(rad * 0.45, 0.0, length(vRest - c - vec2(-rad * 0.35, rad * 0.35))) * 0.25;
  }
  if (vMisc.x > 0.5) {
    // Bobo's face, drawn in rest space so it squashes with the body.
    vec2 q = vRest;
    for (int e = -1; e <= 1; e += 2) {
      vec2 ep = q - vec2(0.24 * float(e), 0.06);
      float eye = length(ep * vec2(1.0, 0.72)) - 0.085;
      col = mix(col, vec3(0.12, 0.03, 0.14), 1.0 - smoothstep(-0.01, 0.01, eye));
      col = mix(col, vec3(1.0), 1.0 - smoothstep(-0.01, 0.01, length(ep - vec2(0.03, 0.04)) - 0.03));
      float blush = length((q - vec2(0.42 * float(e), -0.1)) * vec2(1.0, 1.8)) - 0.08;
      col = mix(col, vec3(1.0, 0.35, 0.55), (1.0 - smoothstep(-0.02, 0.04, blush)) * 0.45);
    }
    float mouth = abs(length(q - vec2(0.0, -0.02)) - 0.11);
    float lower = smoothstep(-0.05, -0.08, q.y);
    col = mix(col, vec3(0.12, 0.03, 0.14), (1.0 - smoothstep(0.012, 0.024, mouth)) * lower);
  }
  float aa = fwidth(r) * 1.5;
  float alpha = (1.0 - smoothstep(1.0 - aa, 1.0, r)) * 0.95;
  fragColor = vec4(col * alpha, alpha);
}`;

const FLOATS = 12;

export interface Fx {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  max: number;
  size: number;
  kind: 1 | 2;
  color: [number, number, number];
}

export class JellyRenderer {
  private bg: Program;
  private fx: Program;
  private jelly: Program;
  private quad: WebGLVertexArrayObject;
  private jVao: WebGLVertexArrayObject;
  private jBuf: WebGLBuffer;
  private jIdx: WebGLBuffer;
  private fVao: WebGLVertexArrayObject;
  private fBuf: WebGLBuffer;
  private jData = new Float32Array(0);
  private fData = new Float32Array(0);

  constructor(private gl: WebGL2RenderingContext) {
    this.bg = new Program(gl, compile(gl, gl.VERTEX_SHADER, bgVert), bgFrag);
    this.fx = new Program(gl, compile(gl, gl.VERTEX_SHADER, fxVert), fxFrag);
    this.jelly = new Program(gl, compile(gl, gl.VERTEX_SHADER, jellyVert), jellyFrag);

    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.jVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.jVao);
    this.jBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.jBuf);
    const st = FLOATS * 4;
    const attr = (loc: number, size: number, off: number) => {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, st, off * 4);
    };
    attr(0, 2, 0);
    attr(1, 2, 2);
    attr(2, 2, 4);
    attr(3, 1, 6);
    attr(4, 3, 7);
    attr(5, 2, 10);
    this.jIdx = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.jIdx);

    this.fVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.fVao);
    this.fBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf);
    const fst = 9 * 4;
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, fst, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 2, gl.FLOAT, false, fst, 8);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, fst, 16);
    gl.enableVertexAttribArray(3);
    gl.vertexAttribPointer(3, 1, gl.FLOAT, false, fst, 32);
    gl.bindVertexArray(null);
  }

  draw(w: JellyWorld, width: number, height: number, fx: Fx[]) {
    const gl = this.gl;
    this.worldW = w.wW;
    this.worldH = w.wH;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);

    const u = this.bg.use();
    gl.uniform2f(u.world, w.wW, w.wH);
    gl.uniform1f(u.groundY, w.groundY);
    gl.bindVertexArray(this.quad);
    gl.disable(gl.BLEND);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

    // Shadows under each jelly: tighter and darker the closer it is to the table.
    const quads: number[] = [];
    const pushQuad = (x: number, y: number, sx: number, sy: number, c: [number, number, number, number], kind: number) => {
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      for (const [cx, cy] of corners) quads.push(x + cx * sx, y + cy * sy, cx, cy, c[0], c[1], c[2], c[3], kind);
    };
    for (const b of w.bodies) {
      const lift = Math.max(0, b.cy - b.halfHeight - w.groundY);
      const k = Math.exp(-lift * 4);
      pushQuad(b.cx, w.groundY - 0.004, b.halfWidth * (1.1 + lift * 0.6), 0.03 + lift * 0.02, [0.35, 0.18, 0.22, 0.32 * k], 0);
    }
    this.drawFx(quads);

    // Jellies: skin every render vertex to its particles on top of the best-fit transform.
    let vcount = 0;
    let icount = 0;
    for (const b of w.bodies) {
      vcount += b.rim.length;
      icount += b.tris.length;
    }
    if (this.jData.length < vcount * FLOATS) this.jData = new Float32Array(vcount * FLOATS * 2);
    const idx = new Uint16Array(icount);
    const data = this.jData;
    const pos = w.pos;
    let vo = 0;
    let io = 0;
    for (const b of w.bodies) {
      const [cx, cy, t00, t01, t10, t11] = w.transform(b);
      const base = vo;
      // Squash-and-stretch about the base when resting (so it squashes into the table), else the centre.
      const ax = cx;
      const ay = b.onGround || b.asleep ? b.minY - w.r : cy;
      const sy = Math.exp(b.js);
      const sx = 1 / sy;
      const sh = b.jk;
      const nv = b.rim.length;
      for (let v = 0; v < nv; v++) {
        const rx = b.verts[v * 2], ry = b.verts[v * 2 + 1];
        let x = t00 * rx + t01 * ry;
        let y = t10 * rx + t11 * ry;
        for (let k = 0; k < 4; k++) {
          const i = b.nbr[v * 4 + k];
          const wk = b.nbw[v * 4 + k];
          const qx = b.q[i * 2], qy = b.q[i * 2 + 1];
          const p = (b.start + i) * 2;
          x += wk * (pos[p] - (t00 * qx + t01 * qy));
          y += wk * (pos[p + 1] - (t10 * qx + t11 * qy));
        }
        const ox = x - ax, oy = y - ay;
        x = ax + ox * sx + oy * sh;
        y = ay + oy * sy;
        const o = (base + v) * FLOATS;
        data[o] = x;
        data[o + 1] = y;
        data[o + 2] = (x - cx) / b.ext;
        data[o + 3] = (y - cy) / b.ext;
        data[o + 4] = rx / b.ext;
        data[o + 5] = ry / b.ext;
        data[o + 6] = b.rim[v];
        data[o + 7] = b.color[0];
        data[o + 8] = b.color[1];
        data[o + 9] = b.color[2];
        data[o + 10] = b.face ? 1 : 0;
        data[o + 11] = b.seed;
      }
      for (let t = 0; t < b.tris.length; t++) idx[io++] = b.tris[t] + base;
      vo += nv;
    }
    if (vcount) {
      const ju = this.jelly.use();
      gl.uniform2f(ju.world, w.wW, w.wH);
      gl.bindVertexArray(this.jVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.jBuf);
      gl.bufferData(gl.ARRAY_BUFFER, data.subarray(0, vcount * FLOATS), gl.STREAM_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.jIdx);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STREAM_DRAW);
      gl.drawElements(gl.TRIANGLES, icount, gl.UNSIGNED_SHORT, 0);
    }

    // Dust and sparkles on hard landings.
    const fq: number[] = [];
    for (const f of fx) {
      const t = f.life / f.max;
      const a = f.kind === 2 ? Math.sin(t * Math.PI) : (1 - t) * 0.55;
      const s = f.size * (f.kind === 1 ? 0.6 + t * 0.9 : 1 - t * 0.4);
      const corners = [[-1, -1], [1, -1], [1, 1], [-1, -1], [1, 1], [-1, 1]];
      for (const [cx, cy] of corners) fq.push(f.x + cx * s, f.y + cy * s, cx, cy, f.color[0], f.color[1], f.color[2], a, f.kind);
    }
    if (fq.length) {
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      this.drawFx(fq);
    }
    gl.disable(gl.BLEND);
  }

  private drawFx(v: number[]) {
    if (!v.length) return;
    const gl = this.gl;
    if (this.fData.length < v.length) this.fData = new Float32Array(v.length * 2);
    this.fData.set(v);
    const u = this.fx.use();
    gl.uniform2f(u.world, this.worldW, this.worldH);
    gl.bindVertexArray(this.fVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.fBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.fData.subarray(0, v.length), gl.STREAM_DRAW);
    gl.drawArrays(gl.TRIANGLES, 0, v.length / 9);
  }

  worldW = 1;
  worldH = 2;

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
