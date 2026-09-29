// WebGL2 renderer for Sand Jar: the grid (colour, variation, lock flag, target) and a static mask
// (open / glass-or-frame) are uploaded as textures and shaded per pixel: crisp grains with speckle
// and glitter, a glass jar with reflections or a wooden frame with a ghost of the target picture.

import { PALETTE, type JarSim } from './sim';

const vert = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const frag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uGrid;   // r colour, g variation, b locked, a target colour
uniform sampler2D uMask;   // r: 0 outside, 1 open, 2 glass/frame
uniform vec2 uGridSize;
uniform vec3 uPal[13];
uniform vec4 uJar;         // cx, half-width, floor y, rim y (cells)
uniform float uNeck;
uniform int uMode;         // 0 jar, 1 reveal
uniform float uTime;
uniform float uGlitter;
uniform float uShimmer;    // 0..1 sweep after a reveal completes; <0 = off
uniform vec4 uTool;        // x, y (cells), kind (0 none, 1 funnel, 2 stick, 3 scoop), radius
uniform vec3 uToolColor;
uniform float uView;       // rotation of the whole scene (drag-to-tilt), radians
uniform vec2 uViewCenter;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec4 grid(vec2 cell) { return texture(uGrid, (cell + 0.5) / uGridSize); }
float maskAt(vec2 cell) { return floor(texture(uMask, (cell + 0.5) / uGridSize).r * 255.0 + 0.5); }
int ci(vec4 c) { return int(c.r * 255.0 + 0.5); }

vec3 background(vec2 g) {
  // Warm studio wall, a soft window glow, and a wooden table below the jar.
  float y = g.y / uGridSize.y;
  vec3 wall = mix(vec3(0.93, 0.86, 0.78), vec3(0.98, 0.94, 0.88), y);
  vec2 d = (g - vec2(uGridSize.x * 0.2, uGridSize.y * 0.8)) / uGridSize.y;
  wall += vec3(1.0, 0.95, 0.85) * 0.12 * exp(-dot(d, d) * 6.0);
  if (g.y < uJar.z) {
    float grain = hash(vec2(floor(g.y * 0.7), floor(g.x * 0.08)));
    vec3 wood = mix(vec3(0.62, 0.42, 0.27), vec3(0.7, 0.5, 0.33), grain);
    wood *= 0.9 + 0.1 * sin(g.x * 0.35 + sin(g.y * 0.6) * 3.0);
    wood *= mix(0.78, 1.0, smoothstep(uJar.z - 6.0, uJar.z, g.y)); // shadow line under the jar
    return wood;
  }
  return wall;
}

void main() {
  vec2 g = vUv * uGridSize;
  vec2 d = g - uViewCenter;
  float cv = cos(uView), sv = sin(uView);
  g = uViewCenter + vec2(cv * d.x - sv * d.y, sv * d.x + cv * d.y);
  vec2 cell = floor(g);
  vec2 sub = fract(g);
  vec3 col = background(g);
  bool inGrid = all(greaterThanEqual(cell, vec2(0.0))) && all(lessThan(cell, uGridSize));
  float m = inGrid ? maskAt(cell) : 0.0;
  vec4 c = inGrid ? grid(cell) : vec4(0.0);
  int k = ci(c);
  bool locked = c.b > 0.5;
  int tgt = int(c.a * 255.0 + 0.5);

  if (m > 0.5 && m < 1.5) {
    if (uMode == 1 && g.y < uJar.w) {
      // Frame backing: cream paper with a faint ghost of the picture to aim for.
      col = vec3(0.97, 0.94, 0.88) * (0.96 + 0.04 * hash(cell));
      if (tgt > 0) col = mix(col, uPal[tgt], 0.24 + 0.04 * sin(uTime * 2.0 + cell.x * 0.1));
    } else if (uMode == 0 && g.y < uJar.w) {
      // Behind the glass: the wall, slightly cooler and dimmer.
      col = col * vec3(0.93, 0.96, 0.98);
    }
    if (k > 0) {
      vec3 base = uPal[k];
      base *= 0.86 + 0.26 * c.g;
      base *= 0.93 + 0.14 * hash(floor(g * 2.0) + c.g * 17.0);            // sub-grain speckle
      float e = max(abs(sub.x - 0.5), abs(sub.y - 0.5));
      base *= 1.0 - 0.1 * smoothstep(0.32, 0.5, e);                        // rounded grains
      if (ci(grid(cell + vec2(0.0, 1.0))) == 0) base *= 1.07;              // lit top surface
      if (ci(grid(cell + vec2(0.0, -1.0))) == 0 && cell.y > uJar.z) base *= 0.92;
      // Glitter: a few grains flash as they catch the light.
      float gl = step(1.0 - 0.02 * uGlitter, hash(cell + floor(uTime * 2.5 + c.g * 9.0)));
      base += vec3(1.0, 0.98, 0.9) * gl * smoothstep(0.5, 0.0, length(sub - 0.5)) * 0.9;
      if (uMode == 1 && locked) {
        base = mix(base, base * 1.12 + 0.03, 0.6);
        if (uShimmer >= 0.0) {
          float t = (g.x / uGridSize.x + g.y / uGridSize.y * 0.6) - (uShimmer * 2.2 - 0.6);
          base += vec3(1.0, 0.97, 0.85) * exp(-t * t * 90.0) * 0.6;
        }
      }
      col = base;
    }
  } else if (m > 1.5) {
    if (uMode == 0) {
      // Glass wall: pale cyan tint with a bright inner edge.
      col = mix(col, vec3(0.8, 0.88, 0.94), 0.45);
      col += 0.05 * smoothstep(0.3, 0.7, sub.x);
    } else {
      // Wooden picture frame with a bevel.
      vec3 wood = mix(vec3(0.5, 0.31, 0.18), vec3(0.6, 0.39, 0.23), hash(vec2(floor(g.x * 0.3), floor(g.y * 0.3))));
      col = wood * (0.9 + 0.2 * smoothstep(0.0, 1.0, sub.y));
    }
  }

  // Front of the glass: soft vertical reflections over everything inside the jar.
  if (uMode == 0 && m > 0.5 && g.y < uJar.w) {
    float xn = (g.x - uJar.x) / uJar.y;
    float hl = smoothstep(-0.8, -0.74, xn) * smoothstep(-0.6, -0.66, xn) * 0.13
             + smoothstep(0.58, 0.62, xn) * smoothstep(0.7, 0.66, xn) * 0.06;
    col += vec3(1.0) * hl;
  }

  // Tools drawn at the finger.
  int kind = int(uTool.z + 0.5);
  vec2 p = g - uTool.xy;
  if (kind == 1) {
    if (p.y > 0.0 && p.y < 16.0) {
      float hw = 1.1 + p.y * 0.42;
      float ax = abs(p.x);
      if (ax < hw) {
        vec3 metal = mix(vec3(0.72, 0.75, 0.8), vec3(0.95, 0.96, 0.98), smoothstep(-hw, hw, p.x));
        vec3 inside = uToolColor * (0.9 + 0.2 * hash(floor(g * 2.0)));
        col = (ax > hw - 1.2 || p.y < 2.0) ? metal : (p.y > 6.0 ? inside : mix(metal, inside, 0.5));
      }
    }
  } else if (kind == 2) {
    if (p.y > -1.0 && p.y < 60.0 && abs(p.x) < 1.0 + step(p.y, 0.0) * 0.0) {
      col = mix(vec3(0.62, 0.45, 0.28), vec3(0.78, 0.6, 0.4), smoothstep(-1.0, 1.0, p.x));
    }
  } else if (kind == 3) {
    float ring = abs(length(p) - uTool.w);
    col = mix(col, vec3(1.0), smoothstep(0.9, 0.2, ring) * 0.8);
  }
  fragColor = vec4(col, 1.0);
}`;

export class JarRenderer {
  private program: WebGLProgram;
  private u: Record<string, WebGLUniformLocation | null> = {};
  private vao: WebGLVertexArrayObject;
  private gridTex: WebGLTexture;
  private maskTex: WebGLTexture;
  private data = new Uint8Array(0);
  private w = 0;
  private h = 0;

  constructor(private gl: WebGL2RenderingContext) {
    const mk = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, mk(gl.VERTEX_SHADER, vert));
    gl.attachShader(p, mk(gl.FRAGMENT_SHADER, frag));
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link');
    this.program = p;
    for (const name of ['uGrid', 'uMask', 'uGridSize', 'uPal', 'uJar', 'uNeck', 'uMode', 'uTime', 'uGlitter', 'uShimmer', 'uTool', 'uToolColor', 'uView', 'uViewCenter'])
      this.u[name] = gl.getUniformLocation(p, name);
    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    const tex = () => {
      const t = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    };
    this.gridTex = tex();
    this.maskTex = tex();
  }

  /** Call when the sim is (re)built: sizes textures and uploads the static mask. */
  setSim(sim: JarSim) {
    const gl = this.gl;
    this.w = sim.W;
    this.h = sim.H;
    this.data = new Uint8Array(sim.n * 4);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.gridTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, sim.W, sim.H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, sim.W, sim.H, 0, gl.RED, gl.UNSIGNED_BYTE, sim.mask);
  }

  draw(
    sim: JarSim,
    width: number,
    height: number,
    o: { time: number; glitter: number; shimmer: number; tool: [number, number, number, number]; toolColor: number; view: number },
  ) {
    const gl = this.gl;
    const d = this.data;
    for (let i = 0; i < sim.n; i++) {
      d[i * 4] = sim.col[i];
      d[i * 4 + 1] = sim.vari[i];
      d[i * 4 + 2] = sim.flags[i] ? 255 : 0;
      d[i * 4 + 3] = sim.target[i];
    }
    gl.bindTexture(gl.TEXTURE_2D, this.gridTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.w, this.h, gl.RGBA, gl.UNSIGNED_BYTE, d);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.gridTex);
    gl.uniform1i(this.u.uGrid, 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.uniform1i(this.u.uMask, 1);
    gl.uniform2f(this.u.uGridSize, sim.W, sim.H);
    gl.uniform3fv(this.u.uPal, new Float32Array(PALETTE.flat()));
    const j = sim.jar;
    gl.uniform4f(this.u.uJar, j.cx, j.half, sim.mode === 'jar' ? j.y0 : sim.frame.y0 - 3, sim.mode === 'jar' ? j.yTop : sim.frame.y1);
    gl.uniform1f(this.u.uNeck, j.neck);
    gl.uniform1i(this.u.uMode, sim.mode === 'jar' ? 0 : 1);
    gl.uniform1f(this.u.uTime, o.time % 1000);
    gl.uniform1f(this.u.uGlitter, o.glitter);
    gl.uniform1f(this.u.uShimmer, o.shimmer);
    gl.uniform4f(this.u.uTool, ...o.tool);
    const tc = PALETTE[o.toolColor] ?? PALETTE[1];
    gl.uniform3f(this.u.uToolColor, tc[0], tc[1], tc[2]);
    gl.uniform1f(this.u.uView, o.view);
    gl.uniform2f(this.u.uViewCenter, j.cx, (j.y0 + j.yTop) / 2);
    gl.bindVertexArray(this.vao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.gridTex);
    gl.deleteTexture(this.maskTex);
    gl.deleteProgram(this.program);
  }
}
