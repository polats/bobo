// WebGL2 drawing for Scratch Off: the counter under a lamp, the card (printed ticket, then the
// coat lit as a height field: a bright lip and a cast shadow at every scratch, brushed-metal
// streaks, glinting flakes that tilt up as they take damage), and the crumbs as point sprites.

import { compile, Program } from '../../shell/gl';
import { MAX_CRUMBS, type Crumbs } from './crumbs';
import type { Coat } from './coat';

const fullVert = `#version 300 es
layout(location = 0) in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

const bgFrag = `#version 300 es
precision highp float;
uniform vec2 uRes;
uniform vec4 uCard;   // x, y, w, h in px, y down
uniform float uRadius;
uniform vec2 uLamp;   // px
uniform float uLift;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 p = vec2(gl_FragCoord.x, uRes.y - gl_FragCoord.y);
  float s = uRes.x / 400.0;
  // A worn wooden counter.
  vec2 q = p / s;
  float g = vnoise(vec2(q.x * 0.012, q.y * 0.25)) * 0.6 + vnoise(vec2(q.x * 0.05, q.y * 1.1)) * 0.4;
  float rings = sin((q.y * 0.08 + g * 6.0)) * 0.5 + 0.5;
  vec3 wood = mix(vec3(0.20, 0.11, 0.06), vec3(0.36, 0.20, 0.10), g * 0.7 + rings * 0.3);
  wood *= 0.85 + 0.15 * vnoise(q * 0.6);
  // The lamp pool.
  float d = length((p - uLamp) / uRes.y);
  vec3 col = wood * (0.25 + 1.25 * exp(-d * d * 3.2)) + vec3(0.06, 0.035, 0.01) * exp(-d * d * 8.0);
  // Card shadow, softer and further when the card is lifted.
  vec2 c = uCard.xy + uCard.zw * 0.5 + vec2(0.0, uCard.w * (0.018 + uLift * 0.03));
  float sd = sdBox(p - c, uCard.zw * 0.5, uRadius);
  float blur = uCard.z * (0.035 + uLift * 0.05);
  col *= 1.0 - 0.6 * (1.0 - smoothstep(-blur, blur, sd));
  o = vec4(col, 1.0);
}`;

const cardVert = `#version 300 es
layout(location = 0) in vec2 aPosition;
uniform vec2 uRes;
uniform vec4 uCard;
uniform float uAngle;
out vec2 vUv;
void main() {
  vUv = aPosition;
  vec2 c = uCard.xy + uCard.zw * 0.5;
  vec2 d = (aPosition - 0.5) * uCard.zw;
  float s = sin(uAngle), k = cos(uAngle);
  vec2 p = c + vec2(d.x * k - d.y * s, d.x * s + d.y * k);
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const cardFrag = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uArt, uPrint, uCoat, uStill;
uniform vec2 uGrid;
uniform vec2 uPx;
uniform vec3 uLight;   // card uv x, y and height in card widths
uniform vec3 uFoil;
uniform float uSheen, uStreak, uGlitter, uLip, uTime, uFlash, uRadius;
uniform vec4 uWin[3];
uniform float uWinOn;
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
void main() {
  vec2 px = vUv * uPx;
  float corner = sdBox(px - uPx * 0.5, uPx * 0.5, uRadius);
  float cardA = 1.0 - smoothstep(-1.0, 0.5, corner);
  if (cardA <= 0.0) discard;
  vec3 paper = texture(uArt, vUv).rgb;
  vec2 tx = 1.0 / uGrid;
  vec2 cs = texture(uCoat, vUv).rg;
  float h = cs.r, dmg = cs.g;
  vec4 st = texture(uStill, vUv);
  float hx = texture(uCoat, vUv + vec2(tx.x, 0.0)).r - texture(uCoat, vUv - vec2(tx.x, 0.0)).r;
  float hy = texture(uCoat, vUv + vec2(0.0, tx.y)).r - texture(uCoat, vUv - vec2(0.0, tx.y)).r;
  vec3 lp = vec3(uLight.xy * uPx, uLight.z * uPx.x);
  vec3 L = normalize(lp - vec3(px, 0.0));
  vec3 V = vec3(0.0, 0.0, 1.0);
  vec3 H = normalize(L + V);

  // Paper: a cast shadow where coat stands between it and the lamp, and grey residue speckle.
  float e = 0.42;
  float fw = fwidth(h) + 0.03;
  float a = smoothstep(e - fw, e + fw, h);
  vec2 toL = normalize(L.xy + 1e-4) * tx * 1.8;
  float hs = texture(uCoat, vUv + toL).r;
  paper *= 1.0 - 0.38 * smoothstep(0.3, 0.7, hs) * (1.0 - a);
  float res = smoothstep(0.04, e, h) * (1.0 - a);
  float speck = step(hash(floor(px / 1.6)), res * 1.1);
  paper = mix(paper, uFoil * 0.55, speck * 0.75);

  // Coat: height-field normal (the lip), per-flake tilt that grows as a flake works loose. Intact
  // coat is nearly flat (you can't see the flakes until they start to give).
  vec2 tilt = (st.rg - 0.5) * (0.025 + dmg * dmg * 1.3) * uGlitter;
  vec3 n = normalize(vec3(-hx * uLip - tilt.x, -hy * uLip - tilt.y, 1.0));
  float streak = hash(vec2(floor(px.y * 0.7), 3.0)) * 0.6 + hash(vec2(floor(px.y * 0.23), 9.0)) * 0.4;
  float diff = 0.62 + 0.38 * max(dot(n, L), 0.0);
  float nh = max(dot(n, H), 0.0);
  float worn = 1.0 - smoothstep(0.55, 1.0, h);
  float spec = pow(nh, 24.0) * 0.32 * uSheen * (0.5 + streak * uStreak * 0.7) * (1.0 - worn * 0.85);
  // Glitter: the odd pigment speck catching the lamp, and loosened flakes flashing as they tilt.
  float speckG = step(0.985, hash(floor(px / 2.0))) * pow(nh, 60.0);
  float lifted = pow(max(dot(normalize(vec3((st.rg - 0.5) * 0.7, 1.0)), H), 0.0), 300.0) * dmg * dmg;
  float glint = (speckG * 0.9 + lifted * 0.8) * uGlitter * (1.0 - worn);
  vec3 foil = uFoil * diff * (0.9 + 0.1 * streak) * (1.0 - worn * 0.3);
  foil += vec3(spec + glint);
  foil = foil / (1.0 + max(foil - 0.85, 0.0));
  float ink = texture(uPrint, vUv).r;
  foil = mix(foil, vec3(0.13, 0.14, 0.2) * diff + spec * 0.15, ink * 0.8);
  float crack = st.b * smoothstep(0.2, 0.95, dmg);
  foil *= 1.0 - crack * 0.55;
  vec3 col = mix(paper, foil, a);

  // Winning cells glow.
  float glow = 0.0;
  for (int i = 0; i < 3; i++) {
    vec4 b = uWin[i];
    vec2 c = (b.xy + b.zw) * 0.5 * uPx;
    float d = sdBox(px - c, (b.zw - b.xy) * 0.5 * uPx, uPx.x * 0.02);
    glow += exp(-abs(d) / (uPx.x * 0.006)) * 0.8 + (d < 0.0 ? 0.06 : 0.0);
  }
  col += vec3(1.0, 0.7, 0.2) * glow * uWinOn * (0.6 + 0.4 * sin(uTime * 6.0));
  col += uFlash;
  o = vec4(col * cardA, cardA);
}`;

const crumbVert = `#version 300 es
layout(location = 0) in vec4 aA;   // x, y (px, y down), size px, rotation
layout(location = 1) in vec4 aB;   // shade, alpha, height px, seed
uniform vec2 uRes;
uniform float uShadow;
uniform vec2 uShadowDir;
out float vRot, vShade, vAlpha, vSeed;
void main() {
  vec2 p = aA.xy;
  float s = aA.z * (1.0 + aB.z * 0.015);
  if (uShadow > 0.5) p += uShadowDir * (aA.z * 0.18 + aB.z * 0.7);
  else p.y -= aB.z * 0.6;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
  gl_PointSize = s;
  vRot = aA.w; vShade = aB.x; vAlpha = aB.y; vSeed = aB.w;
}`;

const crumbFrag = `#version 300 es
precision highp float;
in float vRot, vShade, vAlpha, vSeed;
uniform float uShadow;
uniform vec3 uFoil;
uniform vec3 uLightDir;
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float s = sin(vRot), c = cos(vRot);
  q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  q.y /= 0.62;
  float th = atan(q.y, q.x);
  float r = 0.78 + 0.13 * sin(3.0 * th + vSeed * 6.28) + 0.08 * sin(5.0 * th + vSeed * 17.0);
  float l = length(q) / r;
  if (l > 1.0) discard;
  float aa = 1.0 - smoothstep(0.85, 1.0, l);
  if (uShadow > 0.5) { o = vec4(0.0, 0.0, 0.0, 0.32 * aa * vAlpha); return; }
  // A curled crumb: dome normal plus a facet tilt, the underside's grey latex showing on the rim.
  vec3 n = normalize(vec3(q * 0.9 + (vec2(fract(vSeed * 7.3), fract(vSeed * 3.1)) - 0.5) * 0.8, 1.0 - l * 0.6));
  float d = 0.45 + 0.55 * max(dot(n, uLightDir), 0.0);
  float sp = pow(max(dot(n, normalize(uLightDir + vec3(0, 0, 1))), 0.0), 40.0);
  vec3 col = mix(uFoil * d * vShade, vec3(0.42, 0.42, 0.44) * d, smoothstep(0.55, 1.0, l) * 0.7) + sp * 0.8;
  o = vec4(col * aa * vAlpha, aa * vAlpha);
}`;

export interface Look {
  sheen: number;
  streak: number;
  glitter: number;
  lip: number;
}

export interface CardPose {
  /** Card rect in device px (y down). */
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  lift: number;
}

export class ScratchRenderer {
  private bg: Program;
  private card: Program;
  private crumb: Program;
  private quad: WebGLVertexArrayObject;
  private tri: WebGLVertexArrayObject;
  private crumbVao: WebGLVertexArrayObject;
  private crumbBuf: WebGLBuffer;
  private crumbData = new Float32Array(MAX_CRUMBS * 8);
  private art: WebGLTexture;
  private print: WebGLTexture;
  private coatTex: WebGLTexture;
  private still: WebGLTexture;
  private grid: [number, number] = [1, 1];

  constructor(private gl: WebGL2RenderingContext) {
    const v = compile(gl, gl.VERTEX_SHADER, fullVert);
    this.bg = new Program(gl, v, bgFrag);
    this.card = new Program(gl, compile(gl, gl.VERTEX_SHADER, cardVert), cardFrag);
    this.crumb = new Program(gl, compile(gl, gl.VERTEX_SHADER, crumbVert), crumbFrag);
    this.tri = gl.createVertexArray()!;
    gl.bindVertexArray(this.tri);
    let b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.crumbVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.crumbVao);
    this.crumbBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.crumbBuf);
    gl.bufferData(gl.ARRAY_BUFFER, this.crumbData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 32, 0);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 16);
    gl.bindVertexArray(null);
    const tex = () => gl.createTexture()!;
    this.art = tex();
    this.print = tex();
    this.coatTex = tex();
    this.still = tex();
  }

  /** Upload a new card: printed ticket, coat print and the coat itself. */
  setCard(art: HTMLCanvasElement, print: HTMLCanvasElement, coat: Coat) {
    const gl = this.gl;
    for (const [t, cv] of [[this.art, art], [this.print, print]] as const) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, cv);
      gl.generateMipmap(gl.TEXTURE_2D);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }
    this.grid = [coat.W, coat.H];
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.bindTexture(gl.TEXTURE_2D, this.coatTex);
    coat.pack();
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, coat.W, coat.H, 0, gl.RG, gl.UNSIGNED_BYTE, coat.tex);
    this.params(gl.LINEAR);
    gl.bindTexture(gl.TEXTURE_2D, this.still);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, coat.W, coat.H, 0, gl.RGBA, gl.UNSIGNED_BYTE, coat.still);
    this.params(gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  private params(filter: number) {
    const gl = this.gl;
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  /** Upload the coat rows that changed. */
  update(coat: Coat) {
    const rows = coat.pack();
    if (!rows) return;
    const gl = this.gl;
    const [y0, y1] = rows;
    gl.bindTexture(gl.TEXTURE_2D, this.coatTex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, coat.W, y1 - y0, gl.RG, gl.UNSIGNED_BYTE, coat.tex.subarray(y0 * coat.W * 2, y1 * coat.W * 2));
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
  }

  draw(o: {
    width: number;
    height: number;
    pose: CardPose;
    lamp: [number, number];
    light: [number, number, number];
    foil: [number, number, number];
    look: Look;
    time: number;
    flash: number;
    win: number[][];
    winOn: number;
    crumbs: Crumbs | null;
  }) {
    const gl = this.gl;
    const { pose: c } = o;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, o.width, o.height);
    const radius = c.w * 0.045;

    let u = this.bg.use();
    gl.uniform2f(u.uRes, o.width, o.height);
    gl.uniform4f(u.uCard, c.x, c.y, c.w, c.h);
    gl.uniform1f(u.uRadius, radius);
    gl.uniform2f(u.uLamp, ...o.lamp);
    gl.uniform1f(u.uLift, c.lift);
    gl.bindVertexArray(this.tri);
    gl.drawArrays(gl.TRIANGLES, 0, 3);

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    u = this.card.use();
    gl.uniform2f(u.uRes, o.width, o.height);
    gl.uniform4f(u.uCard, c.x, c.y, c.w, c.h);
    gl.uniform1f(u.uAngle, c.angle);
    gl.uniform2f(u.uGrid, ...this.grid);
    gl.uniform2f(u.uPx, c.w, c.h);
    gl.uniform3f(u.uLight, ...o.light);
    gl.uniform3f(u.uFoil, ...o.foil);
    gl.uniform1f(u.uSheen, o.look.sheen);
    gl.uniform1f(u.uStreak, o.look.streak);
    gl.uniform1f(u.uGlitter, o.look.glitter);
    gl.uniform1f(u.uLip, o.look.lip);
    gl.uniform1f(u.uTime, o.time % 1000);
    gl.uniform1f(u.uFlash, o.flash);
    gl.uniform1f(u.uRadius, radius);
    const win = new Float32Array(12);
    o.win.slice(0, 3).forEach((b, i) => win.set(b, i * 4));
    gl.uniform4fv(u['uWin[0]'], win);
    gl.uniform1f(u.uWinOn, o.winOn);
    const units: [string, WebGLTexture][] = [['uArt', this.art], ['uPrint', this.print], ['uCoat', this.coatTex], ['uStill', this.still]];
    units.forEach(([name, t], i) => {
      gl.activeTexture(gl.TEXTURE0 + i);
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.uniform1i(u[name], i);
    });
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    const cr = o.crumbs;
    if (cr && cr.count) {
      const d = this.crumbData;
      const sx = c.w / this.grid[0], sy = c.h / this.grid[1];
      const sn = Math.sin(c.angle), cs = Math.cos(c.angle);
      const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
      for (let i = 0; i < cr.count; i++) {
        const lx = cr.x[i] * sx - c.w / 2, ly = cr.y[i] * sy - c.h / 2;
        const k = i * 8;
        d[k] = cx + lx * cs - ly * sn;
        d[k + 1] = cy + lx * sn + ly * cs;
        d[k + 2] = Math.max(1.5, cr.size[i] * sx * 1.25);
        d[k + 3] = cr.rot[i];
        d[k + 4] = cr.shade[i];
        d[k + 5] = Math.max(0, Math.min(1, cr.life[i]));
        d[k + 6] = cr.z[i] * sx;
        d[k + 7] = (i * 0.618) % 1;
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, this.crumbBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d.subarray(0, cr.count * 8));
      u = this.crumb.use();
      gl.uniform2f(u.uRes, o.width, o.height);
      gl.uniform3f(u.uFoil, ...o.foil);
      const lx = o.light[0] - 0.5, ly = o.light[1] - 0.5;
      const ll = Math.hypot(lx, ly) + 1e-3;
      const L = [lx, ly, o.light[2]];
      const LL = Math.hypot(L[0], L[1], L[2]);
      gl.uniform3f(u.uLightDir, L[0] / LL, L[1] / LL, L[2] / LL);
      gl.uniform2f(u.uShadowDir, -lx / ll, -ly / ll);
      gl.bindVertexArray(this.crumbVao);
      gl.uniform1f(u.uShadow, 1);
      gl.drawArrays(gl.POINTS, 0, cr.count);
      gl.uniform1f(u.uShadow, 0);
      gl.drawArrays(gl.POINTS, 0, cr.count);
    }
    gl.disable(gl.BLEND);
    gl.bindVertexArray(null);
  }

  destroy() {
    const gl = this.gl;
    for (const t of [this.art, this.print, this.coatTex, this.still]) gl.deleteTexture(t);
    gl.deleteBuffer(this.crumbBuf);
  }
}
