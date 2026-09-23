// WebGL2 renderer: the grid is uploaded as an RGBA8 texture (material, colour variation, life)
// and shaded per cell, with a blurred emissive layer for fire, lava and embers.

const vert = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

// Shared material shading. Material ids match sim.ts.
const shade = /* glsl */ `
uniform sampler2D uGrid;
uniform vec2 uGridSize;
uniform float uTime;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec4 cellAt(vec2 cell) { return texture(uGrid, (cell + 0.5) / uGridSize); }
int matOf(vec4 c) { return int(c.r * 255.0 + 0.5); }

vec3 fireRamp(float t) {
  // Black-body-ish ramp: deep red -> orange -> yellow -> white-hot.
  return mix(mix(vec3(0.55, 0.05, 0.02), vec3(1.0, 0.42, 0.05), smoothstep(0.0, 0.45, t)),
             mix(vec3(1.0, 0.8, 0.25), vec3(1.0, 0.97, 0.85), smoothstep(0.8, 1.0, t)),
             smoothstep(0.4, 0.8, t));
}

// Returns rgb in .rgb and emissive strength in .a.
vec4 material(vec2 cell) {
  vec4 c = cellAt(cell);
  int m = matOf(c);
  float v = c.g;              // per-cell variation 0..1
  float life = c.b * 255.0;   // 0..255
  float flick = hash(cell + floor(uTime * 14.0));
  vec3 col = vec3(0.0);
  float emit = 0.0;
  if (m == 0) return vec4(-1.0);
  if (m == 1) col = mix(vec3(0.32, 0.33, 0.38), vec3(0.42, 0.43, 0.48), v);            // wall
  else if (m == 2) col = mix(vec3(0.86, 0.68, 0.36), vec3(0.98, 0.82, 0.5), v);        // sand
  else if (m == 3) {                                                                     // water
    float wave = 0.5 + 0.5 * sin(cell.x * 0.35 + cell.y * 0.2 + uTime * 2.2 + v * 3.0);
    col = mix(vec3(0.1, 0.36, 0.85), vec3(0.2, 0.55, 1.0), wave * 0.6 + v * 0.2);
  }
  else if (m == 4) {                                                                     // wood (burning if life > 0)
    col = mix(vec3(0.42, 0.25, 0.12), vec3(0.55, 0.34, 0.17), v) * (0.85 + 0.15 * step(0.5, fract(cell.y * 0.25)));
    if (life > 0.0) { float t = 0.4 + 0.5 * flick; col = mix(col * 0.4, fireRamp(t), 0.75); emit = 0.8 * t; }
  }
  else if (m == 5) { float t = clamp(life / 24.0, 0.0, 1.0) * (0.7 + 0.3 * flick); col = fireRamp(0.35 + 0.65 * t); emit = 0.7 + 0.5 * t; }
  else if (m == 6) { float a = clamp(life / 150.0, 0.0, 1.0); col = vec3(0.35 + 0.1 * v) * a; return vec4(col, -a); }
  else if (m == 7) { float a = clamp(life / 255.0, 0.0, 1.0) * 0.6 + 0.1; col = vec3(0.82, 0.86, 0.92) * a; return vec4(col, -a); }
  else if (m == 8) col = mix(vec3(0.32, 0.22, 0.06), vec3(0.45, 0.33, 0.1), v);          // oil
  else if (m == 9) {                                                                     // lava
    float t = 0.55 + 0.35 * hash(floor(cell / 2.0) + floor(uTime * 3.0)) + 0.1 * v;
    col = fireRamp(t * 0.85); emit = 0.9;
  }
  else if (m == 10) { col = mix(vec3(0.35, 0.95, 0.2), vec3(0.6, 1.0, 0.3), v); emit = 0.35; } // acid
  else if (m == 11) {                                                                    // plant
    col = mix(vec3(0.12, 0.55, 0.18), vec3(0.3, 0.8, 0.25), v);
    if (life > 0.0) { float t = 0.4 + 0.5 * flick; col = mix(col * 0.4, fireRamp(t), 0.75); emit = 0.8 * t; }
  }
  else if (m == 12) col = mix(vec3(0.7, 0.88, 1.0), vec3(0.88, 0.96, 1.0), v);           // ice
  else if (m == 13) col = mix(vec3(0.22, 0.2, 0.2), vec3(0.34, 0.3, 0.3), v);            // gunpowder
  else if (m == 14) { float t = clamp(life / 90.0, 0.0, 1.0); col = fireRamp(0.5 + 0.5 * t); emit = 1.0; } // ember
  else if (m == 15) col = mix(vec3(0.2, 0.17, 0.17), vec3(0.3, 0.25, 0.23), v);          // cooled rock
  return vec4(col, emit);
}
`;

const displayFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${shade}
uniform sampler2D uGlow;
uniform sampler2D uGas;
uniform float uGlowAmt;
uniform float uFlash;
uniform vec2 uShake;

void main() {
  vec2 uv = vUv + uShake;
  vec2 cell = floor(uv * uGridSize);
  vec3 bg = mix(vec3(0.025, 0.025, 0.045), vec3(0.06, 0.05, 0.09), vUv.y);
  bg *= 1.0 - 0.35 * length(vUv - 0.5);
  vec4 m = material(cell);
  vec3 col = bg;
  if (m.a > -0.5 || m.r >= 0.0) {
    if (m.a < 0.0) {
      // Gases are mostly drawn by the blurred cloud layer below; a faint per-cell speckle adds texture.
      col = bg * (1.0 + m.a * 0.15) + m.rgb * 0.15;
    } else {
      col = m.rgb;
      // Light from above: bevel the top edge of any surface facing open air.
      vec4 above = cellAt(cell + vec2(0.0, 1.0));
      if (matOf(above) == 0) col *= 1.18;
      vec4 below = cellAt(cell + vec2(0.0, -1.0));
      if (matOf(below) == 0) col *= 0.82;
    }
  }
  // Blurred isolated gas cells are faint, so boost coverage (keeping rgb premultiplied to match).
  vec4 gas = texture(uGas, vUv);
  float cover = 0.85 * (1.0 - exp(-gas.a * 9.0));
  gas *= cover / max(gas.a, 1e-4);
  col = col * (1.0 - gas.a) + gas.rgb;
  col += texture(uGlow, vUv).rgb * uGlowAmt;
  col += vec3(1.0, 0.55, 0.2) * uFlash;
  // Gentle filmic curve so glow saturates instead of clipping.
  col = col / (1.0 + col * 0.25);
  fragColor = vec4(pow(col, vec3(0.95)), 1.0);
}`;

const emissiveFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${shade}
void main() {
  vec4 m = material(floor(vUv * uGridSize));
  fragColor = m.a > 0.0 ? vec4(m.rgb * m.a, 1.0) : vec4(0.0);
}`;

// Smoke and steam as premultiplied colour + coverage, blurred into soft clouds.
const gasFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
${shade}
void main() {
  vec4 m = material(floor(vUv * uGridSize));
  fragColor = (m.a < 0.0 && m.r >= 0.0) ? vec4(m.rgb, -m.a) : vec4(0.0);
}`;

const blurFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uTex;
uniform vec2 uDir;
void main() {
  vec4 s = texture(uTex, vUv) * 0.227;
  s += (texture(uTex, vUv + uDir * 1.385) + texture(uTex, vUv - uDir * 1.385)) * 0.316;
  s += (texture(uTex, vUv + uDir * 3.231) + texture(uTex, vUv - uDir * 3.231)) * 0.070;
  fragColor = s;
}`;

interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export class SandRenderer {
  private gl: WebGL2RenderingContext;
  private tri: WebGLVertexArrayObject;
  private display: WebGLProgram;
  private emissive: WebGLProgram;
  private blur: WebGLProgram;
  private gasProg: WebGLProgram;
  private gasA: Target | null = null;
  private gasB: Target | null = null;
  private grid: WebGLTexture;
  private gridW = 0;
  private gridH = 0;
  private pixels = new Uint8Array(0);
  private glowA: Target | null = null;
  private glowB: Target | null = null;
  private loc = new Map<WebGLProgram, Map<string, WebGLUniformLocation | null>>();

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false });
    if (!gl) throw new Error('Alchemy Sandbox needs WebGL2, which this browser does not provide.');
    this.gl = gl;
    this.display = this.program(displayFrag);
    this.emissive = this.program(emissiveFrag);
    this.blur = this.program(blurFrag);
    this.gasProg = this.program(gasFrag);
    this.tri = gl.createVertexArray()!;
    gl.bindVertexArray(this.tri);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.grid = gl.createTexture()!;
  }

  private program(frag: string) {
    const gl = this.gl;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'shader error');
      return s;
    };
    const p = gl.createProgram()!;
    gl.attachShader(p, sh(gl.VERTEX_SHADER, vert));
    gl.attachShader(p, sh(gl.FRAGMENT_SHADER, frag));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link error');
    return p;
  }

  private u(p: WebGLProgram, name: string) {
    let m = this.loc.get(p);
    if (!m) this.loc.set(p, (m = new Map()));
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private target(w: number, h: number): Target {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { tex, fbo, w, h };
  }

  private freeTarget(t: Target | null) {
    if (!t) return;
    this.gl.deleteTexture(t.tex);
    this.gl.deleteFramebuffer(t.fbo);
  }

  /** (Re)allocate for a new grid size. */
  setGrid(w: number, h: number) {
    const gl = this.gl;
    this.gridW = w;
    this.gridH = h;
    this.pixels = new Uint8Array(w * h * 4);
    gl.bindTexture(gl.TEXTURE_2D, this.grid);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    this.freeTarget(this.glowA);
    this.freeTarget(this.glowB);
    // Glow at grid resolution is already soft; blurring it twice gives a wide halo for free.
    this.glowA = this.target(w, h);
    this.glowB = this.target(w, h);
    this.freeTarget(this.gasA);
    this.freeTarget(this.gasB);
    this.gasA = this.target(w, h);
    this.gasB = this.target(w, h);
  }

  draw(
    mat: Uint8Array,
    vari: Uint8Array,
    life: Uint16Array,
    opts: { width: number; height: number; time: number; glow: number; flash: number; shake: [number, number] },
  ) {
    const gl = this.gl;
    const px = this.pixels;
    for (let i = 0, o = 0; i < mat.length; i++, o += 4) {
      px[o] = mat[i];
      px[o + 1] = vari[i];
      const l = life[i];
      px[o + 2] = l > 255 ? 255 : l;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.grid);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, this.gridW, this.gridH, gl.RGBA, gl.UNSIGNED_BYTE, px);
    gl.bindVertexArray(this.tri);
    const a = this.glowA!;
    const b = this.glowB!;

    if (opts.glow > 0) {
      gl.useProgram(this.emissive);
      this.bindGrid(this.emissive, opts.time);
      gl.bindFramebuffer(gl.FRAMEBUFFER, a.fbo);
      gl.viewport(0, 0, a.w, a.h);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      gl.useProgram(this.blur);
      gl.uniform1i(this.u(this.blur, 'uTex'), 1);
      for (let pass = 0; pass < 2; pass++) {
        const spread = pass + 1;
        this.blurPass(a, b, spread / a.w, 0);
        this.blurPass(b, a, 0, spread / a.h);
      }
    }

    const ga = this.gasA!;
    const gb = this.gasB!;
    gl.useProgram(this.gasProg);
    this.bindGrid(this.gasProg, opts.time);
    gl.bindFramebuffer(gl.FRAMEBUFFER, ga.fbo);
    gl.viewport(0, 0, ga.w, ga.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    gl.useProgram(this.blur);
    gl.uniform1i(this.u(this.blur, 'uTex'), 1);
    for (let pass = 0; pass < 2; pass++) {
      this.blurPass(ga, gb, (pass + 1) / ga.w, 0);
      this.blurPass(gb, ga, 0, (pass + 1) / ga.h);
    }

    gl.useProgram(this.display);
    this.bindGrid(this.display, opts.time);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, ga.tex);
    gl.uniform1i(this.u(this.display, 'uGas'), 2);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, a.tex);
    gl.uniform1i(this.u(this.display, 'uGlow'), 1);
    gl.uniform1f(this.u(this.display, 'uGlowAmt'), opts.glow);
    gl.uniform1f(this.u(this.display, 'uFlash'), opts.flash);
    gl.uniform2f(this.u(this.display, 'uShake'), opts.shake[0], opts.shake[1]);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, opts.width, opts.height);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  private bindGrid(p: WebGLProgram, time: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.grid);
    gl.uniform1i(this.u(p, 'uGrid'), 0);
    gl.uniform2f(this.u(p, 'uGridSize'), this.gridW, this.gridH);
    gl.uniform1f(this.u(p, 'uTime'), time);
  }

  private blurPass(src: Target, dst: Target, dx: number, dy: number) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, src.tex);
    gl.uniform2f(this.u(this.blur, 'uDir'), dx, dy);
    gl.bindFramebuffer(gl.FRAMEBUFFER, dst.fbo);
    gl.viewport(0, 0, dst.w, dst.h);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy() {
    const gl = this.gl;
    this.freeTarget(this.glowA);
    this.freeTarget(this.glowB);
    this.freeTarget(this.gasA);
    this.freeTarget(this.gasB);
    gl.deleteTexture(this.grid);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
