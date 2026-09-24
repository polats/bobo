import { compile, Program } from '../../shell/gl';
import type { Mat4, Vec3 } from '../cloth/math';
import { CELL_TEX, DISH_R, EXT, GRID, type Drop, type Ferro, type Magnet } from './sim';

export type Theme = 'chrome' | 'gold' | 'oil';
const MAX_MAGNETS = 5;
const MESH = 220;

// Shared surface-height function: thickness texture + hex-lattice Rosensweig spikes.
const heightLib = /* glsl */ `
uniform sampler2D uThick;
uniform sampler2D uCells;
uniform float spacing;
uniform float sharp;
const float EXT = ${EXT.toFixed(4)};
const float SQ3 = 1.7320508;

vec2 hexRound(vec2 qr) {
  vec3 c = vec3(qr.x, -qr.x - qr.y, qr.y);
  vec3 r = floor(c + 0.5);
  vec3 d = abs(r - c);
  if (d.x > d.y && d.x > d.z) r.x = -r.y - r.z;
  else if (d.y > d.z) r.y = -r.x - r.z;
  else r.z = -r.x - r.y;
  return r.xz;
}

float thicknessAt(vec2 p) {
  return texture(uThick, (p + EXT) / (2.0 * EXT)).r;
}

// Height of the liquid surface above the dish floor at xz = p.
float heightAt(vec2 p) {
  float base = thicknessAt(p);
  float size = spacing / SQ3;
  vec2 qr = vec2((SQ3 / 3.0 * p.x - p.y / 3.0) / size, (2.0 / 3.0 * p.y) / size);
  vec2 best = vec2(0.0);
  float spike = 0.0;
  // Nearest cell plus its neighbours so leaning spikes stay whole across cell borders.
  vec2 c0 = hexRound(qr);
  for (int k = 0; k < 7; k++) {
    vec2 off = k == 0 ? vec2(0.0) : k == 1 ? vec2(1.0, 0.0) : k == 2 ? vec2(-1.0, 0.0) : k == 3 ? vec2(0.0, 1.0)
             : k == 4 ? vec2(0.0, -1.0) : k == 5 ? vec2(1.0, -1.0) : vec2(-1.0, 1.0);
    vec2 cq = c0 + off;
    ivec2 ic = ivec2(cq) + ${CELL_TEX / 2};
    if (any(lessThan(ic, ivec2(0))) || any(greaterThan(ic, ivec2(${CELL_TEX - 1})))) continue;
    vec4 cell = texelFetch(uCells, ic, 0);
    float a = cell.x;
    if (a < 0.002) continue;
    vec2 centre = vec2(size * SQ3 * (cq.x + cq.y * 0.5), size * 1.5 * cq.y);
    // Leaning: sample the cone at a point shifted against the tilt, more so near the tip.
    vec2 d = p - centre;
    float rad = spacing * 0.56;
    float r0 = length(d) / rad;
    float lean = clamp(1.0 - r0, 0.0, 1.0);
    d -= cell.yz * a * lean * 1.6;
    float r = length(d) / rad;
    float cone = pow(clamp(1.0 - r, 0.0, 1.0), 1.25 * sharp);
    // Soft rounded tip.
    cone = cone * (1.0 - 0.18 * exp(-r * r * 60.0));
    spike = max(spike, a * cone);
  }
  return base + spike * smoothstep(0.004, 0.03, base);
}

// Height and its xz gradient in one pass (analytic cone derivative; lean treated as a constant shift).
vec3 heightGrad(vec2 p) {
  float e = 0.004;
  float base = thicknessAt(p);
  vec2 gb = vec2(thicknessAt(p + vec2(e, 0.0)) - base, thicknessAt(p + vec2(0.0, e)) - base) / e;
  float size = spacing / SQ3;
  vec2 qr = vec2((SQ3 / 3.0 * p.x - p.y / 3.0) / size, (2.0 / 3.0 * p.y) / size);
  vec2 c0 = hexRound(qr);
  float spike = 0.0;
  vec2 gs = vec2(0.0);
  float rad = spacing * 0.56;
  float k = 1.25 * sharp;
  for (int i = 0; i < 7; i++) {
    vec2 off = i == 0 ? vec2(0.0) : i == 1 ? vec2(1.0, 0.0) : i == 2 ? vec2(-1.0, 0.0) : i == 3 ? vec2(0.0, 1.0)
             : i == 4 ? vec2(0.0, -1.0) : i == 5 ? vec2(1.0, -1.0) : vec2(-1.0, 1.0);
    vec2 cq = c0 + off;
    ivec2 ic = ivec2(cq) + ${CELL_TEX / 2};
    if (any(lessThan(ic, ivec2(0))) || any(greaterThan(ic, ivec2(${CELL_TEX - 1})))) continue;
    vec4 cell = texelFetch(uCells, ic, 0);
    float a = cell.x;
    if (a < 0.002) continue;
    vec2 centre = vec2(size * SQ3 * (cq.x + cq.y * 0.5), size * 1.5 * cq.y);
    vec2 d = p - centre;
    float lean = clamp(1.0 - length(d) / rad, 0.0, 1.0);
    d -= cell.yz * a * lean * 1.6;
    float dl = length(d);
    float r = dl / rad;
    if (r >= 1.0) continue;
    float u = 1.0 - r;
    float ex = exp(-r * r * 60.0);
    float tip = 1.0 - 0.18 * ex;
    float f = a * pow(u, k) * tip;
    if (f > spike) {
      spike = f;
      float dfdr = a * (-k * pow(u, max(k - 1.0, 0.0)) * tip + pow(u, k) * 0.18 * 120.0 * r * ex);
      gs = dfdr * d / max(dl, 1e-5) / rad;
    }
  }
  float m = smoothstep(0.004, 0.03, base);
  return vec3(base + spike * m, gb + gs * m);
}
`;

const bgVert = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPos;
out vec2 vUv;
void main() { vUv = aPos * 0.5 + 0.5; gl_Position = vec4(aPos, 0.9999, 1.0); }`;

const bgFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec3 tint;
out vec4 o;
void main() {
  vec2 q = vUv - vec2(0.5, 0.62);
  float v = exp(-dot(q, q) * 3.2);
  vec3 c = mix(vec3(0.05, 0.05, 0.07), tint, v * 0.55);
  o = vec4(pow(c, vec3(1.0 / 2.2)), 1.0);
}`;

const dishVert = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
uniform mat4 viewProj;
out vec3 vPos;
out vec3 vN;
void main() { vPos = aPos; vN = aNormal; gl_Position = viewProj * vec4(aPos, 1.0); }`;

const dishFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec3 vPos;
in vec3 vN;
uniform vec3 eye;
uniform int nMag;
uniform vec4 mags[${MAX_MAGNETS}];
uniform vec3 accent;
${heightLib}
out vec4 o;
void main() {
  vec3 n = normalize(vN);
  vec3 v = normalize(eye - vPos);
  vec3 L = normalize(vec3(-0.35, 1.0, 0.45));
  float diff = clamp(dot(n, L) * 0.6 + 0.4, 0.0, 1.0);
  vec3 col = vec3(0.86, 0.86, 0.88) * diff;
  if (n.y > 0.9 && length(vPos.xz) < ${DISH_R.toFixed(3)} + 0.001) {
    // Soft shadow and contact darkening under the liquid.
    float sh = thicknessAt(vPos.xz + vec2(0.05, -0.07));
    float c = thicknessAt(vPos.xz);
    col *= 1.0 - 0.55 * smoothstep(0.0, 0.08, sh) - 0.25 * smoothstep(0.003, 0.02, c);
    // Magnet glow under the glaze.
    for (int i = 0; i < ${MAX_MAGNETS}; i++) {
      if (i >= nMag) break;
      float d = length(vPos.xz - mags[i].xy);
      float s = mags[i].z;
      col += accent * s * (0.35 * exp(-d * d * 30.0) + 0.25 * exp(-pow((d - 0.16) * 30.0, 2.0)));
    }
    // Glaze reflection.
    vec3 r = reflect(-v, n);
    col += vec3(0.25) * pow(clamp(r.y, 0.0, 1.0), 12.0) * (0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0));
  }
  col = col / (1.0 + col * 0.25);
  o = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

const fluidVert = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec2 aXZ;
uniform mat4 viewProj;
${heightLib}
out vec3 vPos;
void main() {
  // Dry vertices sink below the dish floor so their pixels fail the depth test before shading.
  float th = thicknessAt(aXZ);
  float h = th < 0.002 ? -0.06 : heightAt(aXZ) - 0.0015;
  vPos = vec3(aXZ.x, h, aXZ.y);
  gl_Position = viewProj * vec4(vPos, 1.0);
}`;

// Environment: dark studio, two big softboxes and the white dish below.
const envLib = /* glsl */ `
vec3 env(vec3 r) {
  vec3 c = mix(vec3(0.015, 0.015, 0.02), vec3(0.08, 0.08, 0.1), clamp(r.y * 0.5 + 0.5, 0.0, 1.0));
  // Key softbox above and slightly behind the camera.
  vec3 k = normalize(vec3(-0.3, 0.85, 0.42));
  float dk = dot(r, k);
  c += vec3(1.0, 0.98, 0.95) * 7.0 * smoothstep(0.93, 0.97, dk);
  // Rim strip light behind.
  vec3 s = normalize(vec3(0.55, 0.6, -0.6));
  c += vec3(0.75, 0.85, 1.0) * 3.0 * smoothstep(0.955, 0.985, dot(r, s));
  // Big window behind the dish: what the flat top of the puddle mirrors from this camera angle.
  {
    vec3 wc = normalize(vec3(0.12, 0.8, -0.6));
    vec3 wu = normalize(cross(wc, vec3(1.0, 0.0, 0.0)));
    vec3 wr = normalize(cross(wu, wc));
    vec2 q = vec2(dot(r, wr), dot(r, wu)) / max(dot(r, wc), 0.01);
    vec2 box = smoothstep(vec2(0.62, 0.42), vec2(0.55, 0.36), abs(q));
    float mull = 1.0 - 0.8 * (1.0 - smoothstep(0.0, 0.025, abs(q.x))) - 0.8 * (1.0 - smoothstep(0.0, 0.025, abs(q.y)));
    c += vec3(0.85, 0.9, 1.0) * 1.6 * box.x * box.y * max(mull, 0.0) * step(0.0, dot(r, wc));
  }
  // Window-like horizon band.
  c += vec3(0.35) * smoothstep(0.06, 0.0, abs(r.y - 0.18)) * smoothstep(-0.2, 0.6, r.z);
  // The white dish floor reflected at grazing angles.
  if (r.y < 0.0) c = mix(c, vec3(0.7, 0.7, 0.72), smoothstep(0.0, -0.25, r.y));
  return c;
}
`;

const fluidFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec3 vPos;
uniform vec3 eye;
uniform float theme; // 0 chrome, 1 gold, 2 oil slick
uniform float time;
${heightLib}
${envLib}
out vec4 o;

vec3 thinFilm(float c) {
  // Cheap iridescence: phase shift across RGB.
  return 0.5 + 0.5 * cos(6.2831 * (c * 1.6 + vec3(0.0, 0.33, 0.67)));
}

void main() {
  vec3 hg = heightGrad(vPos.xz);
  float h0 = hg.x;
  if (h0 < 0.0015) discard;
  // Feathered rim; alpha-to-coverage turns this into an antialiased edge with MSAA.
  float edge = smoothstep(0.0015, 0.006, h0);
  vec3 n = normalize(vec3(-hg.y, 1.0, -hg.z));
  vec3 p = vec3(vPos.x, h0, vPos.z);
  vec3 v = normalize(eye - p);
  float nv = max(dot(n, v), 0.0);
  vec3 r = reflect(-v, n);
  vec3 F0 = theme < 0.5 ? vec3(0.045) : theme < 1.5 ? vec3(1.0, 0.72, 0.3) : vec3(0.06);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - nv, 5.0);
  vec3 refl = env(r);
  if (theme > 1.5) refl *= mix(vec3(1.0), thinFilm(nv + h0 * 3.0 + time * 0.03), 0.8);
  vec3 base = theme < 1.5 ? vec3(0.004) : vec3(0.01, 0.006, 0.012);
  vec3 col = base + refl * F;
  // Tiny sharp specular to make every spike tip glint.
  vec3 k = normalize(vec3(-0.3, 0.85, 0.42));
  col += vec3(1.0) * pow(max(dot(r, k), 0.0), 600.0) * 4.0 * (theme > 0.5 && theme < 1.5 ? F0 : vec3(1.0));
  col = col / (1.0 + col);
  o = vec4(pow(col, vec3(1.0 / 2.2)), edge);
}`;

const dropVert = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aDrop;
uniform mat4 view;
uniform mat4 proj;
out vec2 vC;
out vec3 vCenter;
out float vR;
void main() {
  vec4 c = view * vec4(aDrop.xyz, 1.0);
  vC = aCorner;
  vCenter = c.xyz;
  vR = aDrop.w;
  gl_Position = proj * (c + vec4(aCorner * aDrop.w, 0.0, 0.0));
}`;

const dropFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vC;
in vec3 vCenter;
in float vR;
uniform mat4 proj;
uniform mat4 invView;
uniform float theme;
${envLib}
out vec4 o;
void main() {
  float r2 = dot(vC, vC);
  if (r2 > 1.0) discard;
  vec3 nView = vec3(vC, sqrt(1.0 - r2));
  vec4 clip = proj * vec4(vCenter + nView * vR, 1.0);
  gl_FragDepth = clip.z / clip.w * 0.5 + 0.5;
  vec3 n = normalize((invView * vec4(nView, 0.0)).xyz);
  vec3 v = normalize((invView * vec4(0.0, 0.0, 1.0, 0.0)).xyz);
  vec3 r = reflect(-v, n);
  vec3 F0 = theme > 0.5 && theme < 1.5 ? vec3(1.0, 0.72, 0.3) : vec3(0.045);
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 col = vec3(0.004) + env(r) * F;
  col = col / (1.0 + col);
  o = vec4(pow(col, vec3(1.0 / 2.2)), 1.0);
}`;

export class FerroRenderer {
  private bg: Program;
  private dish: Program;
  private fluid: Program;
  private drop: Program;
  private quad: WebGLVertexArrayObject;
  private dishVao: WebGLVertexArrayObject;
  private dishCount: number;
  private meshVao: WebGLVertexArrayObject;
  private meshCount: number;
  private dropVao: WebGLVertexArrayObject;
  private dropBuf: WebGLBuffer;
  private thickTex: WebGLTexture;
  private cellTex: WebGLTexture;
  private half = new Uint16Array(GRID * GRID);
  private cellHalf = new Uint16Array(CELL_TEX * CELL_TEX * 4);

  constructor(private gl: WebGL2RenderingContext) {
    this.bg = new Program(gl, compile(gl, gl.VERTEX_SHADER, bgVert), bgFrag);
    this.dish = new Program(gl, compile(gl, gl.VERTEX_SHADER, dishVert), dishFrag);
    this.fluid = new Program(gl, compile(gl, gl.VERTEX_SHADER, fluidVert), fluidFrag);
    this.drop = new Program(gl, compile(gl, gl.VERTEX_SHADER, dropVert), dropFrag);

    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    this.buffer(0, 2, new Float32Array([-1, -1, 3, -1, -1, 3]));

    // Dish: floor disc, inner wall, rounded lip.
    const pos: number[] = [];
    const nrm: number[] = [];
    const seg = 96;
    const R = DISH_R;
    const wallH = 0.09;
    const push = (x: number, y: number, z: number, nx: number, ny: number, nz: number) => {
      pos.push(x, y, z);
      nrm.push(nx, ny, nz);
    };
    for (let i = 0; i < seg; i++) {
      const a0 = (i / seg) * Math.PI * 2;
      const a1 = ((i + 1) / seg) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      // floor
      push(0, 0, 0, 0, 1, 0);
      push(R * c0, 0, R * s0, 0, 1, 0);
      push(R * c1, 0, R * s1, 0, 1, 0);
      // inner wall (normal points inward)
      push(R * c0, 0, R * s0, -c0, 0, -s0);
      push(R * c0, wallH, R * s0, -c0, 0.3, -s0);
      push(R * c1, 0, R * s1, -c1, 0, -s1);
      push(R * c1, 0, R * s1, -c1, 0, -s1);
      push(R * c0, wallH, R * s0, -c0, 0.3, -s0);
      push(R * c1, wallH, R * s1, -c1, 0.3, -s1);
      // lip
      const R2 = R + 0.07;
      push(R * c0, wallH, R * s0, 0, 1, 0);
      push(R2 * c0, wallH - 0.015, R2 * s0, c0 * 0.4, 0.9, s0 * 0.4);
      push(R * c1, wallH, R * s1, 0, 1, 0);
      push(R * c1, wallH, R * s1, 0, 1, 0);
      push(R2 * c0, wallH - 0.015, R2 * s0, c0 * 0.4, 0.9, s0 * 0.4);
      push(R2 * c1, wallH - 0.015, R2 * s1, c1 * 0.4, 0.9, s1 * 0.4);
      // outer wall
      push(R2 * c0, wallH - 0.015, R2 * s0, c0, 0, s0);
      push(R2 * c0, -0.25, R2 * s0, c0, 0, s0);
      push(R2 * c1, wallH - 0.015, R2 * s1, c1, 0, s1);
      push(R2 * c1, wallH - 0.015, R2 * s1, c1, 0, s1);
      push(R2 * c0, -0.25, R2 * s0, c0, 0, s0);
      push(R2 * c1, -0.25, R2 * s1, c1, 0, s1);
    }
    this.dishVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dishVao);
    this.buffer(0, 3, new Float32Array(pos));
    this.buffer(1, 3, new Float32Array(nrm));
    this.dishCount = pos.length / 3;

    // Liquid mesh: a grid over the dish, displaced in the vertex shader.
    const verts = new Float32Array(MESH * MESH * 2);
    for (let z = 0; z < MESH; z++)
      for (let x = 0; x < MESH; x++) {
        verts[(z * MESH + x) * 2] = -R + (2 * R * x) / (MESH - 1);
        verts[(z * MESH + x) * 2 + 1] = -R + (2 * R * z) / (MESH - 1);
      }
    const idx = new Uint32Array((MESH - 1) * (MESH - 1) * 6);
    let k = 0;
    for (let z = 0; z < MESH - 1; z++)
      for (let x = 0; x < MESH - 1; x++) {
        const i = z * MESH + x;
        idx.set([i, i + MESH, i + 1, i + 1, i + MESH, i + MESH + 1], k);
        k += 6;
      }
    this.meshVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.meshVao);
    this.buffer(0, 2, verts);
    const ib = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, idx, gl.STATIC_DRAW);
    this.meshCount = idx.length;

    this.dropVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dropVao);
    this.buffer(0, 2, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]));
    this.dropBuf = this.buffer(1, 4, new Float32Array(16 * 4), gl.DYNAMIC_DRAW);
    gl.vertexAttribDivisor(1, 1);
    gl.bindVertexArray(null);

    this.thickTex = this.texture(gl.R16F, gl.RED, GRID, GRID, gl.LINEAR);
    this.cellTex = this.texture(gl.RGBA16F, gl.RGBA, CELL_TEX, CELL_TEX, gl.NEAREST);
  }

  private buffer(loc: number, size: number, data: Float32Array, usage: number = this.gl.STATIC_DRAW) {
    const gl = this.gl;
    const b = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, usage);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
    return b;
  }

  private texture(internal: number, format: number, w: number, h: number, filter: number) {
    const gl = this.gl;
    const t = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, t);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, gl.HALF_FLOAT, null);
    return t;
  }

  private upload(sim: Ferro) {
    const gl = this.gl;
    toHalf(sim.thick, this.half);
    gl.bindTexture(gl.TEXTURE_2D, this.thickTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, GRID, GRID, gl.RED, gl.HALF_FLOAT, this.half);
    toHalf(sim.cellData, this.cellHalf);
    gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, CELL_TEX, CELL_TEX, gl.RGBA, gl.HALF_FLOAT, this.cellHalf);
  }

  draw(
    sim: Ferro,
    w: number,
    h: number,
    view: Mat4,
    proj: Mat4,
    viewProj: Mat4,
    invView: Mat4,
    eye: Vec3,
    magnets: Magnet[],
    drops: Drop[],
    theme: Theme,
    t: number,
  ) {
    const gl = this.gl;
    this.upload(sim);
    const themeId = theme === 'chrome' ? 0 : theme === 'gold' ? 1 : 2;
    const accent: Vec3 = theme === 'gold' ? [1.0, 0.55, 0.15] : theme === 'oil' ? [0.55, 0.3, 1.0] : [0.2, 0.55, 1.0];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    let u = this.bg.use();
    gl.uniform3f(u.tint, accent[0] * 0.18 + 0.05, accent[1] * 0.18 + 0.05, accent[2] * 0.18 + 0.06);
    gl.bindVertexArray(this.quad);
    gl.depthMask(false);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.depthMask(true);

    const bindCommon = (uu: Record<string, WebGLUniformLocation>) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.thickTex);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.cellTex);
      gl.uniform1i(uu.uThick, 0);
      gl.uniform1i(uu.uCells, 1);
      gl.uniform1f(uu.spacing, sim.spacing);
      gl.uniform1f(uu.sharp, sim.cfg.sharpness);
    };

    u = this.dish.use();
    bindCommon(u);
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform3f(u.eye, ...eye);
    gl.uniform3f(u.accent, ...accent);
    const all = [{ x: 0, z: 0, strength: sim.cfg.baseMagnet }, ...magnets].slice(0, MAX_MAGNETS);
    const md = new Float32Array(MAX_MAGNETS * 4);
    all.forEach((m, i) => md.set([m.x, m.z, Math.min(1.5, m.strength * sim.cfg.strength), 0], i * 4));
    gl.uniform1i(u.nMag, all.length);
    gl.uniform4fv(u['mags[0]'], md);
    gl.bindVertexArray(this.dishVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.dishCount);

    u = this.fluid.use();
    bindCommon(u);
    gl.uniformMatrix4fv(u.viewProj, false, viewProj);
    gl.uniform3f(u.eye, ...eye);
    gl.uniform1f(u.theme, themeId);
    gl.uniform1f(u.time, t % 1000);
    gl.bindVertexArray(this.meshVao);
    gl.enable(gl.SAMPLE_ALPHA_TO_COVERAGE);
    gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_INT, 0);
    gl.disable(gl.SAMPLE_ALPHA_TO_COVERAGE);

    if (drops.length) {
      const data = new Float32Array(16 * 4);
      drops.slice(0, 16).forEach((d, i) => data.set([d.x, d.y, d.z, d.r], i * 4));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dropBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);
      u = this.drop.use();
      gl.uniformMatrix4fv(u.view, false, view);
      gl.uniformMatrix4fv(u.proj, false, proj);
      gl.uniformMatrix4fv(u.invView, false, invView);
      gl.uniform1f(u.theme, themeId);
      gl.bindVertexArray(this.dropVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, Math.min(16, drops.length));
    }
  }

  destroy() {
    this.gl.deleteTexture(this.thickTex);
    this.gl.deleteTexture(this.cellTex);
  }
}

// Float32 → IEEE half, no allocation.
const f32 = new Float32Array(1);
const u32 = new Uint32Array(f32.buffer);
function toHalf(src: Float32Array, dst: Uint16Array) {
  for (let i = 0; i < src.length; i++) {
    f32[0] = src[i];
    const x = u32[0];
    const sign = (x >>> 16) & 0x8000;
    let e = ((x >>> 23) & 0xff) - 127 + 15;
    const m = x & 0x7fffff;
    if (e <= 0) dst[i] = sign;
    else if (e >= 31) dst[i] = sign | 0x7c00;
    else dst[i] = sign | (e << 10) | (m >>> 13);
    e = 0;
  }
}
