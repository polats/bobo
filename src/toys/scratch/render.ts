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
uniform float uPress;
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
  vec2 c = uCard.xy + uCard.zw * 0.5 + vec2(0.0, uCard.w * (0.018 + uLift * 0.03 - uPress * 0.008));
  float sd = sdBox(p - c, uCard.zw * 0.5, uRadius);
  float blur = uCard.z * (0.035 + uLift * 0.05 - uPress * 0.012);
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
uniform float uSheen, uStreak, uGlitter, uLip, uLift, uTime, uFlash, uRadius;
uniform vec4 uWin[3];
uniform float uWinOn;
uniform vec3 uDent;    // where the finger presses (card px) and how hard (0..1)
out vec4 o;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
// Coat height: a flake working loose rises off the card before it pops.
float lifted(float dmg) { return uLift * smoothstep(0.35, 1.0, dmg); }
float height(vec2 uv) { vec4 c = texture(uCoat, uv); return c.r * (1.0 + lifted(c.g)); }
void main() {
  vec2 px = vUv * uPx;
  float corner = sdBox(px - uPx * 0.5, uPx * 0.5, uRadius);
  float cardA = 1.0 - smoothstep(-1.0, 0.5, corner);
  if (cardA <= 0.0) discard;
  vec3 paper = texture(uArt, vUv).rgb;
  vec2 tx = 1.0 / uGrid;
  vec4 cs = texture(uCoat, vUv);
  float h = cs.r, dmg = cs.g;
  vec2 push = cs.ba * 2.0 - 1.0;
  vec4 st = texture(uStill, vUv);
  float hx = height(vUv + vec2(tx.x, 0.0)) - height(vUv - vec2(tx.x, 0.0));
  float hy = height(vUv + vec2(0.0, tx.y)) - height(vUv - vec2(0.0, tx.y));
  // The ticket gives a little under the finger: a shallow dent that shades the paper and the coat.
  vec2 dd = px - uDent.xy;
  float sig = uPx.x * 0.16;
  float dent = uDent.z * exp(-dot(dd, dd) / (sig * sig));
  vec2 dentG = -2.0 * dd / (sig * sig) * dent * uPx.x * 0.02;
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
  paper *= 1.0 + dot(-dentG, normalize(L.xy + 1e-4)) * 0.5 - dent * 0.06;
  float res = smoothstep(0.04, e, h) * (1.0 - a);
  float speck = step(hash(floor(px / 1.6)), res * 1.1);
  paper = mix(paper, uFoil * 0.55, speck * 0.75);

  // Coat: height-field normal (the lip), per-flake tilt that grows as a flake works loose. Intact
  // coat is nearly flat (you can't see the flakes until they start to give).
  // Loosened flakes tip over in the direction they're being pushed, and catch the lamp differently.
  vec2 tilt = (st.rg - 0.5) * (0.025 + dmg * dmg * 0.6) * uGlitter + push * lifted(dmg) * 0.9;
  vec3 n = normalize(vec3(-hx * uLip - tilt.x + dentG.x, -hy * uLip - tilt.y + dentG.y, 1.0));
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
uniform float uCurl;
uniform vec3 uFoil;
uniform vec3 uLightDir;
out vec4 o;
void main() {
  vec2 q = gl_PointCoord * 2.0 - 1.0;
  float s = sin(vRot), c = cos(vRot);
  q = vec2(q.x * c - q.y * s, q.x * s + q.y * c);
  if (fract(vSeed * 13.7) < uCurl) {
    // A rolled curl: a little cylinder of coat, foil outside, grey latex showing in the spiral at its ends.
    float d = length(vec2(max(abs(q.x) - 0.5, 0.0), q.y)) - 0.36;
    if (d > 0.0) discard;
    float aa = smoothstep(0.0, -0.08, d);
    if (uShadow > 0.5) { o = vec4(0.0, 0.0, 0.0, 0.32 * aa * vAlpha); return; }
    float across = clamp(q.y / 0.36, -1.0, 1.0);
    vec3 n = normalize(vec3(0.0, across, sqrt(1.0 - across * across) + 0.05));
    n.xy = vec2(n.x * c + n.y * s, -n.x * s + n.y * c);
    float diff = 0.4 + 0.6 * max(dot(n, uLightDir), 0.0);
    float sp = pow(max(dot(n, normalize(uLightDir + vec3(0, 0, 1))), 0.0), 24.0);
    float endR = length(vec2(abs(q.x) - 0.5, q.y));
    float spiral = (abs(q.x) > 0.5) ? 0.5 + 0.5 * sin(endR * 55.0 + atan(q.y, abs(q.x) - 0.5)) : 0.0;
    vec3 col = mix(uFoil * diff * vShade + sp * 0.7, vec3(0.38, 0.38, 0.4) * diff, spiral * 0.75);
    o = vec4(col * aa * vAlpha, aa * vAlpha);
    return;
  }
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

// The tool under the finger, drawn in its own frame: x across the stroke, y forward (the body
// trails behind the contact at y = 0). 1 coin held edge-on and tipped back, 2 key, 3 scraper.
const toolVert = `#version 300 es
layout(location = 0) in vec2 aPosition;
uniform vec2 uRes;
uniform vec2 uAt;
uniform float uSide;
out vec2 vP;
void main() {
  vP = (aPosition - 0.5) * uSide;
  vec2 p = uAt + vP;
  gl_Position = vec4(p.x / uRes.x * 2.0 - 1.0, 1.0 - p.y / uRes.y * 2.0, 0.0, 1.0);
}`;

const toolFrag = `#version 300 es
precision highp float;
in vec2 vP;
uniform int uKind;
uniform vec2 uDir;      // stroke direction (screen, y down)
uniform float uR;       // contact half-width, px
uniform float uSc;      // px per CSS px
uniform float uPress;
uniform float uAlpha;
uniform vec3 uLight;
out vec4 o;
// The lamp in the tool's own frame.
vec3 gL;
float sdBox(vec2 p, vec2 b) { vec2 q = abs(p) - b; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0); }
float sdEllipse(vec2 p, vec2 r) { float k = length(p / r); return (k - 1.0) * min(r.x, r.y); }
// Signed distance and colour of the tool at local point l.
vec4 shape(vec2 l, out float d) {
  float sc = uSc;
  if (uKind == 1) {
    // Only part of a tipped coin's rim touches, so the coin is wider than its contact.
    float R = max(uR * 1.9, 16.0 * sc), k = 0.6 - uPress * 0.1;
    vec2 c = vec2(0.0, -R * k);
    float face = sdEllipse(l - c, vec2(R, R * k));
    float rim = sdEllipse(l - c - vec2(0.0, R * 0.12), vec2(R, R * k));
    d = min(face, rim);
    vec3 metal = vec3(0.8, 0.82, 0.86);
    if (face > 0.0) {
      // The milled edge facing the stroke.
      float mill = 0.6 + 0.4 * step(0.5, fract(l.x / (2.2 * sc)));
      return vec4(metal * 0.55 * mill, 1.0);
    }
    vec2 f = (l - c) / vec2(R, R * k);
    float lf = length(f);
    float bevel = smoothstep(0.78, 1.0, lf);
    vec3 n = normalize(vec3(f * bevel * 1.4, 1.0));
    float diff = 0.5 + 0.5 * max(dot(n, gL), 0.0);
    float sp = pow(max(dot(n, normalize(gL + vec3(0, 0, 1))), 0.0), 40.0);
    float ring = smoothstep(0.02, 0.0, abs(lf - 0.72)) * 0.25;
    float emb = smoothstep(0.42, 0.38, length(f - vec2(0.05, 0.0))) * 0.12;
    return vec4(metal * (diff - ring + emb) + sp * 0.8, 1.0);
  }
  if (uKind == 2) {
    float L = 46.0 * sc, w = 3.2 * sc, Rb = 12.0 * sc;
    float shaft = sdBox(l - vec2(0.0, -L * 0.5), vec2(w, L * 0.5)) - 0.8 * sc;
    float teeth = 1e9;
    for (int i = 0; i < 4; i++) {
      float y = -L * (0.12 + float(i) * 0.1);
      teeth = min(teeth, sdBox(l - vec2(w + 2.0 * sc, y), vec2(2.0 * sc, (1.4 + mod(float(i), 2.0)) * sc)));
    }
    float bow = length(l - vec2(0.0, -L - Rb * 0.8)) - Rb;
    float hole = Rb * 0.32 - length(l - vec2(0.0, -L - Rb * 1.1));
    d = max(min(min(shaft, teeth), bow), hole);
    float across = clamp(l.x / (w + 2.0 * sc), -1.0, 1.0);
    vec3 n = normalize(vec3(across * 0.8, 0.0, 1.0));
    float diff = 0.55 + 0.45 * max(dot(n, gL), 0.0);
    float sp = pow(max(dot(n, normalize(gL + vec3(0, 0, 1))), 0.0), 30.0);
    return vec4(vec3(0.86, 0.68, 0.34) * diff + sp * 0.6, 1.0);
  }
  // Scraper: a clear blade across the stroke, an orange body behind it.
  float bw = max(uR, 8.0 * sc);
  float blade = sdBox(l - vec2(0.0, -1.6 * sc), vec2(bw, 1.6 * sc));
  float t = clamp((-l.y - 3.0 * sc) / (28.0 * sc), 0.0, 1.0);
  float hw = mix(bw * 0.92, 9.0 * sc, t);
  float body = max(abs(l.x) - hw, max(l.y + 3.0 * sc, -l.y - 31.0 * sc)) - 1.5 * sc;
  d = min(blade, body);
  if (blade < body) return vec4(vec3(0.82, 0.88, 0.92), 0.85);
  float grip = 0.85 + 0.15 * step(0.5, fract(l.y / (3.0 * sc)));
  float diff = 0.7 + 0.3 * smoothstep(-hw, hw, -l.x);
  return vec4(vec3(0.96, 0.46, 0.14) * diff * (t > 0.35 ? grip : 1.0), 1.0);
}
void main() {
  vec2 t = uDir, n = vec2(-uDir.y, uDir.x);
  vec2 l = vec2(dot(vP, n), dot(vP, t));
  gL = normalize(vec3(dot(uLight.xy, n), dot(uLight.xy, t), uLight.z));
  // Shadow on the card: closer to the tool the harder you press.
  vec2 so = vec2(2.0, 4.0) * uSc * (1.5 - uPress * 0.7);
  vec2 ls = vec2(dot(vP - so, n), dot(vP - so, t));
  float ds;
  shape(ls, ds);
  float sh = (1.0 - smoothstep(-2.0 * uSc, 3.0 * uSc, ds)) * 0.35;
  float d;
  vec4 c = shape(l, d);
  float a = (1.0 - smoothstep(-0.75, 0.75, d)) * c.a;
  vec4 col = vec4(c.rgb * a, a) + vec4(0.0, 0.0, 0.0, sh) * (1.0 - a);
  o = col * uAlpha;
}`;

export interface Look {
  sheen: number;
  streak: number;
  glitter: number;
  lip: number;
  lift: number;
  /** Share of crumbs that roll into curls. */
  curls: number;
}

export interface ToolView {
  /** 0 = none (a fingernail), 1 coin, 2 key, 3 scraper. */
  kind: number;
  x: number;
  y: number;
  ux: number;
  uy: number;
  /** Contact half-width in px. */
  r: number;
  press: number;
  alpha: number;
}

export interface CardPose {
  /** Card rect in device px (y down). */
  x: number;
  y: number;
  w: number;
  h: number;
  angle: number;
  lift: number;
  /** How hard the card is being pressed into the counter (0..1). */
  press: number;
}

export class ScratchRenderer {
  private bg: Program;
  private card: Program;
  private crumb: Program;
  private toolP: Program;
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
    this.toolP = new Program(gl, compile(gl, gl.VERTEX_SHADER, toolVert), toolFrag);
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
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, coat.W, coat.H, 0, gl.RGBA, gl.UNSIGNED_BYTE, coat.tex);
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
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, y0, coat.W, y1 - y0, gl.RGBA, gl.UNSIGNED_BYTE, coat.tex.subarray(y0 * coat.W * 4, y1 * coat.W * 4));
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
    tool: ToolView;
    scale: number;
    dent: [number, number, number];
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
    gl.uniform1f(u.uPress, c.press);
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
    gl.uniform1f(u.uLift, o.look.lift);
    gl.uniform1f(u.uTime, o.time % 1000);
    gl.uniform1f(u.uFlash, o.flash);
    gl.uniform1f(u.uRadius, radius);
    const win = new Float32Array(12);
    o.win.slice(0, 3).forEach((b, i) => win.set(b, i * 4));
    gl.uniform4fv(u['uWin[0]'], win);
    gl.uniform1f(u.uWinOn, o.winOn);
    gl.uniform3f(u.uDent, ...o.dent);
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
      gl.uniform1f(u.uCurl, o.look.curls);
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
    const tv = o.tool;
    if (tv.kind > 0 && tv.alpha > 0.01) {
      const u = this.toolP.use();
      const ext = tv.kind === 1 ? Math.max(tv.r * 1.9, 16 * o.scale) * 2.4 : tv.kind === 2 ? 80 * o.scale : Math.max(tv.r * 1.3, 40 * o.scale);
      gl.uniform2f(u.uRes, o.width, o.height);
      gl.uniform2f(u.uAt, tv.x, tv.y);
      gl.uniform1f(u.uSide, ext * 2);
      gl.uniform1i(u.uKind, tv.kind);
      gl.uniform2f(u.uDir, tv.ux, tv.uy);
      gl.uniform1f(u.uR, tv.r);
      gl.uniform1f(u.uSc, o.scale);
      gl.uniform1f(u.uPress, tv.press);
      gl.uniform1f(u.uAlpha, tv.alpha);
      const L = Math.hypot(-0.4, -0.6, 0.7);
      gl.uniform3f(u.uLight, -0.4 / L, -0.6 / L, 0.7 / L);
      gl.bindVertexArray(this.quad);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
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
