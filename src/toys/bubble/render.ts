import { Program, compile } from '../../shell/gl';
import { buildLut, LUT_MAX_UM, LUT_SIZE, FILM_N } from './colour';
import { MAX_SLOTS } from './shaders';

// Scene rendering: a perspective camera looks face-on at the wand (the plane z = 0; +z is into the
// scene). Films are shaded by their thickness through the interference lookup, lit by a dark room
// with one bright window and a soft lamp: what a film shows is that room reflected.

const common = /* glsl */ `
uniform vec2 uRes;
uniform float uPxPerM;
uniform float uCamF;
uniform sampler2D uLut;
const float LUT_MAX = ${LUT_MAX_UM.toFixed(1)};
const float N_FILM = ${FILM_N};
const float DISC = 0.92;
vec2 toWorld(vec2 frag) { return (frag - 0.5 * uRes) / uPxPerM; }
vec3 rayDir(vec2 w) { return normalize(vec3(w, uCamF)); }
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
// What the room looks like in direction d (z < 0 is behind the viewer, where films reflect).
vec3 env(vec3 d) {
  if (d.z > 0.0) {
    vec2 q = d.xy / d.z;
    return vec3(0.02, 0.022, 0.035) * (1.0 + 0.5 * q.y);
  }
  vec2 q = d.xy / max(-d.z, 0.05);
  // A dim room behind the camera: pale wall above, darker floor.
  vec3 c = mix(vec3(0.3, 0.28, 0.3), vec3(0.85, 0.87, 0.93), smoothstep(-0.9, 0.7, q.y));
  // Soft lamp low on the right, warm.
  c += vec3(1.0, 0.72, 0.45) * 0.9 * exp(-dot(q - vec2(0.75, -0.3), q - vec2(0.75, -0.3)) * 3.0);
  // A window up and to the left: bright sky panes with a cross of mullions.
  vec2 w = (q - vec2(-0.05, 0.13)) / vec2(0.065, 0.085);
  vec2 aw = abs(w);
  // Rounded-corner pane, soft at the edges.
  float box = 0.7 + length(max(aw - 0.7, 0.0)) / 0.3 + min(max(aw.x, aw.y) - 0.7, 0.0);
  float inW = smoothstep(1.0, 0.55, box);
  float bars = smoothstep(0.02, 0.09, aw.x) * smoothstep(0.02, 0.09, aw.y);
  c += inW * mix(0.35, 1.0, bars) * mix(vec3(1.5, 1.7, 2.0), vec3(2.0, 2.0, 1.9), smoothstep(-1.0, 1.0, -w.y));
  // Its glow on the wall around it.
  c += vec3(0.5, 0.55, 0.62) * 0.5 * exp(-dot(w, w) * 0.6);
  return c;
}
// Film reflectance colour for a thickness (µm) seen at incidence cosine cosI: the optical path uses
// the refracted angle, and the Fresnel amplitude rises towards grazing.
vec3 filmColour(float h, float cosI) {
  float sinT2 = (1.0 - cosI * cosI) / (N_FILM * N_FILM);
  float hEff = h * sqrt(1.0 - sinT2);
  vec3 c = texture(uLut, vec2(clamp(hEff / LUT_MAX, 0.0, 1.0) * (1.0 - 1.0 / ${LUT_SIZE}.0) + 0.5 / ${LUT_SIZE}.0, 0.5)).rgb;
  float f0 = 0.02;
  float f = f0 + (1.0 - f0) * pow(1.0 - cosI, 5.0);
  return c * (f / f0);
}
vec3 tone(vec3 x) { return x / (1.0 + x * 0.6); }
// How torn a film is at uv, softened over a couple of cells so the grid never shows in the rim.
float tornAt(sampler2D t, vec2 uv) {
  vec2 px = 1.2 / vec2(textureSize(t, 0));
  return 0.25 * (smoothstep(0.6, 1.6, texture(t, uv + vec2(px.x, 0.0)).b) + smoothstep(0.6, 1.6, texture(t, uv - vec2(px.x, 0.0)).b)
    + smoothstep(0.6, 1.6, texture(t, uv + vec2(0.0, px.y)).b) + smoothstep(0.6, 1.6, texture(t, uv - vec2(0.0, px.y)).b));
}
`;

const quadVert = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

const bgFrag = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
${common}
uniform float uTime;
void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  vec3 c = mix(vec3(0.012, 0.014, 0.03), vec3(0.05, 0.05, 0.085), uv.y);
  // Out-of-focus lights far behind.
  for (int i = 0; i < 7; i++) {
    float fi = float(i);
    vec2 p = vec2(fract(sin(fi * 12.3) * 91.7), 0.35 + 0.6 * fract(sin(fi * 7.1) * 51.3));
    float r = 0.05 + 0.06 * fract(fi * 0.37);
    vec2 d = (uv - p) * vec2(uRes.x / uRes.y, 1.0);
    float b = smoothstep(r, r * 0.8, length(d));
    c += b * 0.03 * mix(vec3(0.5, 0.6, 1.0), vec3(1.0, 0.7, 0.5), fract(fi * 0.61));
  }
  float v = length((uv - vec2(0.5, 0.55)) * vec2(1.0, 0.8));
  c *= 1.0 - 0.55 * v * v;
  c += (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  fragColor = vec4(c, 1.0);
}`;

/** Instanced bubbles: centre (world, m), radius, slot, and an l=2 wobble. */
const bubbleVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
layout(location = 1) in vec4 aBubble;  // x, y, z, R
layout(location = 2) in vec4 aExtra;   // slot (-1 = the wand's film), wobble, wobble axis angle, clip (1 = attached)
uniform vec2 uRes;
uniform float uPxPerM;
uniform float uCamF;
out vec2 vFrag;
flat out vec4 vB;
flat out vec4 vE;
void main() {
  float s = uCamF / (uCamF + aBubble.z);
  vec2 c = aBubble.xy * s * uPxPerM + 0.5 * uRes;
  float r = aBubble.w * s * uPxPerM * 1.25 + 2.0;
  vec2 px = c + aPosition * r;
  vFrag = px;
  vB = aBubble;
  vE = aExtra;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const bubbleFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vFrag;
flat in vec4 vB;
flat in vec4 vE;
out vec4 fragColor;
${common}
uniform sampler2D uAtlas;
uniform sampler2D uWand;
uniform vec2 uSlots;
uniform float uWandR;
vec4 sampleFilm(vec2 p) {
  // p: -1..1 over the bubble's projected disc. Returns thickness, how torn (.b) and the raw front (.a).
  // Slots are offset by 100 (the wand's film: -2) while popping, when the rim gets filtered.
  bool wand = vE.x < 0.0;
  bool popping = vE.x >= 99.5 || vE.x < -1.5;
  // Free bubbles skip the outermost band, which was the wand's Plateau border.
  vec2 l = 0.5 + 0.5 * DISC * clamp(p, -1.0, 1.0) * (wand ? 1.0 : 0.88);
  if (wand) {
    vec4 f = texture(uWand, l);
    return vec4(f.r, 0.0, popping ? tornAt(uWand, l) : smoothstep(0.6, 1.6, f.b), f.b);
  }
  float s = mod(vE.x, 100.0);
  vec2 cell = vec2(mod(s, uSlots.x), floor(s / uSlots.x));
  vec2 uv = (cell + l) / uSlots;
  vec4 f = texture(uAtlas, uv);
  return vec4(f.r, 0.0, popping ? tornAt(uAtlas, uv) : smoothstep(0.6, 1.6, f.b), f.b);
}
void main() {
  vec3 ro = vec3(0.0, 0.0, -uCamF);
  vec3 rd = rayDir(toWorld(vFrag));
  vec3 C = vB.xyz;
  float R = vB.w;
  // An l=2 shape wobble: stretch along one axis, squash across it.
  float wob = vE.y;
  vec2 ax = vec2(cos(vE.z), sin(vE.z));
  vec3 oc = ro - C;
  mat2 M = mat2(ax.x, ax.y, -ax.y, ax.x);
  vec2 d2 = M * rd.xy, o2 = M * oc.xy;
  vec3 k = vec3(1.0 / (1.0 + wob), 1.0 + wob, 1.0);
  vec3 rdS = vec3(d2, rd.z) * k, ocS = vec3(o2, oc.z) * k;
  float A = dot(rdS, rdS), B = dot(ocS, rdS), Cc = dot(ocS, ocS) - R * R;
  float disc = B * B - A * Cc;
  if (disc <= 0.0) discard;
  float sq = sqrt(disc);
  float t0 = (-B - sq) / A, t1 = (-B + sq) / A;
  vec3 col = vec3(0.0);
  float alpha = 0.0;
  float trans = 1.0;
  for (int side = 0; side < 2; side++) {
    float t = side == 0 ? t0 : t1;
    vec3 p = ro + rd * t;
    // Attached bubbles only exist behind the ring plane.
    if (vE.w > 0.5 && p.z < 0.0) continue;
    vec3 pS = vec3(M * (p.xy - C.xy), p.z - C.z) * k;
    vec3 nS = normalize(pS * k);
    vec3 nn = vec3(transpose(M) * nS.xy, nS.z);
    vec3 n = side == 0 ? nn : -nn;
    vec2 q = pS.xy / R;
    // The far wall shows a mirrored patch of the same film.
    vec4 f = sampleFilm(side == 0 ? q : vec2(-q.x, q.y) * 0.96);
    float torn = f.b;
    float cosI = clamp(-dot(rd, n), 0.0, 1.0);
    vec3 refl = env(reflect(rd, n));
    vec3 c = filmColour(f.r, cosI) * refl * 6.5;
    float intact = 1.0 - torn;
    // The retracting rim: a bright bead of the liquid it has gathered, just behind the front.
    float rim = torn * (1.0 - smoothstep(2.0, 4.5, f.a));
    c += rim * vec3(0.9, 0.95, 1.0) * (0.6 + refl * 0.3);
    col += c * intact * trans + rim * c * trans * 0.3;
    alpha += 0.06 * intact * trans;
    trans *= 1.0 - 0.1 * intact;
  }
  fragColor = vec4(tone(col), clamp(alpha, 0.0, 1.0));
}`;

/** The wand's film (a spherical cap), its ring and handle, and the soap bowl in front. */
const wandFrag = /* glsl */ `#version 300 es
precision highp float;
out vec4 fragColor;
${common}
uniform sampler2D uWand;
uniform vec2 uWandC;     // ring centre, world m
uniform float uWandR;    // ring radius, m
uniform float uBulge;    // cap height, m (+ = away from the viewer)
uniform float uFilmOn;   // draw the cap
uniform vec4 uBowl;      // centre x, surface y, half width, half depth of the surface ellipse
uniform float uRipple;   // seconds since the wand hit the bath
uniform float uTime;
uniform int uPart;       // 0 = film and ring, 1 = bowl, 2 = handle (each drawn under its own scissor)
uniform float uPopping;  // the film is tearing: filter its rim
vec4 over(vec4 dst, vec4 src) { return src + dst * (1.0 - src.a); }
void main() {
  vec2 w = toWorld(gl_FragCoord.xy);
  vec3 rd = rayDir(w);
  vec4 out4 = vec4(0.0);
  vec2 p = w - uWandC;
  float a = uWandR;
  float r = length(p);
  // Film: a spherical cap over the ring; soap films don't refract, so only the reflection bends.
  if (uPart == 0 && uFilmOn > 0.5 && r < a) {
    vec2 fuv = 0.5 + 0.5 * DISC * p / a;
    vec4 f = texture(uWand, fuv);
    float H = uBulge;
    vec3 n = vec3(0.0, 0.0, -1.0);
    if (abs(H) > 1e-5) {
      float Rc = (a * a + H * H) / (2.0 * H);
      // Normal of the cap on the viewer's side: towards the centre of curvature when it bows away
      // (concave), away from it when a wobble bows it towards us (convex).
      float zc = sqrt(max(Rc * Rc - r * r, 0.0));
      n = normalize(vec3(-sign(H) * p, -zc));
    }
    float cosI = clamp(-dot(rd, n), 0.0, 1.0);
    vec3 refl = env(reflect(rd, n));
    vec3 c = filmColour(f.r, cosI) * refl * 6.5;
    float torn = uPopping > 0.5 ? tornAt(uWand, fuv) : smoothstep(0.6, 1.6, f.b);
    float intact = 1.0 - torn;
    float rim = torn * (1.0 - smoothstep(2.0, 4.5, f.b));
    c = c * intact + rim * vec3(0.9, 0.95, 1.0) * (0.5 + 0.2 * refl);
    out4 = vec4(tone(c), 0.05 * intact);
  }
  // Ring: a round plastic tube.
  float tube = a * 0.075;
  float dr = r - a;
  if (uPart == 0 && abs(dr) < tube) {
    float u = dr / tube;
    vec3 n = normalize(vec3(p / max(r, 1e-6) * u, -sqrt(max(1.0 - u * u, 0.0))));
    vec3 base = vec3(0.95, 0.35, 0.55);
    float diff = 0.35 + 0.65 * max(dot(n, normalize(vec3(-0.4, 0.6, -0.7))), 0.0);
    vec3 c = base * diff * 0.55 + env(reflect(rd, n)) * 0.12;
    out4 = over(out4, vec4(tone(c), smoothstep(1.0, 0.85, abs(u))));
  }
  // Handle: a capsule from the bottom-right of the ring down off screen.
  vec2 h0 = uWandC + vec2(0.7, -0.72) * (a + tube * 0.6);
  vec2 hd = normalize(vec2(0.55, -1.0));
  float along = dot(w - h0, hd);
  float across = dot(w - h0, vec2(-hd.y, hd.x));
  float hw = tube * 1.1;
  if (uPart == 2 && along > 0.0 && abs(across) < hw) {
    float u = across / hw;
    vec3 n = normalize(vec3(vec2(-hd.y, hd.x) * u, -sqrt(max(1.0 - u * u, 0.0))));
    vec3 c = vec3(0.95, 0.35, 0.55) * (0.3 + 0.55 * max(dot(n, normalize(vec3(-0.4, 0.6, -0.7))), 0.0)) + env(reflect(rd, n)) * 0.1;
    out4 = over(out4, vec4(tone(c), smoothstep(1.0, 0.85, abs(u))));
  }
  // Bowl of soap solution, in front of everything.
  if (uPart != 1) { fragColor = out4; return; }
  vec2 e = (w - uBowl.xy) / uBowl.zw;
  float ell = dot(e, e);
  float below = w.y < uBowl.y ? 1.0 : 0.0;
  float bodyX = abs(w.x - uBowl.x) / (uBowl.z * (1.0 - 0.18 * clamp((uBowl.y - w.y) / (uBowl.y + 0.5 * uRes.y / uPxPerM), 0.0, 1.0)));
  if (ell < 1.0) {
    // Liquid surface: faint rainbow from the soapy skin, the window reflected, ripples after a dip.
    float rr = length(e * vec2(1.0, 1.0));
    float rip = uRipple < 3.0 ? sin(rr * 40.0 - uRipple * 18.0) * exp(-uRipple * 1.3) * smoothstep(0.0, 0.2, rr) : 0.0;
    vec3 n = normalize(vec3(e.x * 0.12 + rip * 0.08, 1.0, -0.35 + rip * 0.05));
    vec3 refl = env(reflect(rd, normalize(vec3(n.x, n.z, -n.y))));
    float th = 0.35 + 0.25 * sin(e.x * 3.0 + uTime * 0.2) + 0.15 * sin(e.y * 5.0 - uTime * 0.13);
    vec3 c = vec3(0.07, 0.09, 0.13) + filmColour(th, 0.8) * refl * 3.0 + refl * 0.04;
    out4 = over(out4, vec4(tone(c), 0.97));
  } else if (below > 0.5 && bodyX < 1.0) {
    // Glass wall of the bowl.
    float edge = pow(bodyX, 6.0);
    vec3 c = mix(vec3(0.05, 0.07, 0.1), vec3(0.12, 0.15, 0.2), edge) + vec3(0.6, 0.7, 0.8) * smoothstep(0.93, 0.99, bodyX) * 0.4;
    float lip = exp(-abs(ell - 1.0) * 30.0);
    c += vec3(0.8, 0.85, 0.9) * lip * 0.3;
    out4 = over(out4, vec4(tone(c), 0.96));
  }
  if (ell >= 1.0 && ell < 1.15 && w.y >= uBowl.y) {
    // The bowl's back lip.
    float lip = exp(-abs(ell - 1.06) * 60.0);
    out4 = over(out4, vec4(vec3(0.5, 0.55, 0.62) * lip * 0.5, lip * 0.5));
  }
  fragColor = out4;
}`;

/** Spray droplets from popped rims. */
const dropVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aDrop; // x, y, z, life 0..1
uniform vec2 uRes;
uniform float uPxPerM;
uniform float uCamF;
out float vLife;
void main() {
  float s = uCamF / (uCamF + aDrop.z);
  vec2 px = aDrop.xy * s * uPxPerM + 0.5 * uRes;
  vLife = aDrop.w;
  gl_PointSize = max(1.5, 3.2 * s * uRes.x / 780.0) ;
  gl_Position = vec4(px / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const dropFrag = /* glsl */ `#version 300 es
precision highp float;
in float vLife;
out vec4 fragColor;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.2, length(d)) * vLife;
  fragColor = vec4(vec3(0.75, 0.82, 0.95) * a, a * 0.5);
}`;

export interface BubbleDraw {
  x: number;
  y: number;
  z: number;
  r: number;
  slot: number;
  wobble: number;
  axis: number;
  attached: boolean;
  popping: boolean;
}

export interface SceneState {
  pxPerM: number;
  camF: number;
  time: number;
  wandC: [number, number];
  wandR: number;
  bulge: number;
  filmOn: boolean;
  popping: boolean;
  bowl: [number, number, number, number];
  ripple: number;
  bubbles: BubbleDraw[];
  drops: Float32Array;
  dropCount: number;
  wandTex: WebGLTexture;
  atlasTex: WebGLTexture;
  slots: [number, number];
}

export class SceneRenderer {
  private bg: Program;
  private bubble: Program;
  private wand: Program;
  private drop: Program;
  private lut: WebGLTexture;
  private quad: WebGLVertexArrayObject;
  private bubbleVao: WebGLVertexArrayObject;
  private inst: WebGLBuffer;
  private instData = new Float32Array(MAX_SLOTS * 2 * 8);
  private dropVao: WebGLVertexArrayObject;
  private dropBuf: WebGLBuffer;
  private bgTex: WebGLTexture | null = null;
  private bgFbo: WebGLFramebuffer | null = null;
  private bgW = 0;
  private bgH = 0;

  constructor(private gl: WebGL2RenderingContext, quad: WebGLVertexArrayObject) {
    this.quad = quad;
    const v = compile(gl, gl.VERTEX_SHADER, quadVert);
    this.bg = new Program(gl, v, bgFrag);
    this.wand = new Program(gl, v, wandFrag);
    this.bubble = new Program(gl, compile(gl, gl.VERTEX_SHADER, bubbleVert), bubbleFrag);
    this.drop = new Program(gl, compile(gl, gl.VERTEX_SHADER, dropVert), dropFrag);

    this.lut = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.lut);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, LUT_SIZE, 1, 0, gl.RGBA, gl.FLOAT, buildLut());

    // Bubble quads: a unit square per instance.
    this.bubbleVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.bubbleVao);
    const corners = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    gl.bufferData(gl.ARRAY_BUFFER, this.instData.byteLength, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(1);
    gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
    gl.vertexAttribDivisor(1, 1);
    gl.enableVertexAttribArray(2);
    gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
    gl.vertexAttribDivisor(2, 1);

    this.dropVao = gl.createVertexArray()!;
    gl.bindVertexArray(this.dropVao);
    this.dropBuf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.dropBuf);
    gl.bufferData(gl.ARRAY_BUFFER, 4 * 4 * 512, gl.DYNAMIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 4, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private base(p: Program, s: SceneState, w: number, h: number) {
    const gl = this.gl;
    const u = p.use();
    gl.uniform2f(u.uRes, w, h);
    gl.uniform1f(u.uPxPerM, s.pxPerM);
    gl.uniform1f(u.uCamF, s.camF);
    if (u.uLut) {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.lut);
      gl.uniform1i(u.uLut, 0);
    }
    return u;
  }

  /** The backdrop never changes: draw it once per size and copy it in each frame. */
  private backdrop(s: SceneState, w: number, h: number) {
    const gl = this.gl;
    if (!this.bgFbo || this.bgW !== w || this.bgH !== h) {
      if (this.bgTex) gl.deleteTexture(this.bgTex);
      if (this.bgFbo) gl.deleteFramebuffer(this.bgFbo);
      this.bgTex = gl.createTexture()!;
      gl.bindTexture(gl.TEXTURE_2D, this.bgTex);
      gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, w, h);
      this.bgFbo = gl.createFramebuffer()!;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.bgFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.bgTex, 0);
      gl.viewport(0, 0, w, h);
      gl.disable(gl.BLEND);
      const u = this.base(this.bg, s, w, h);
      gl.uniform1f(u.uTime, 0);
      gl.bindVertexArray(this.quad);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
      this.bgW = w;
      this.bgH = h;
    }
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, this.bgFbo);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, null);
    gl.blitFramebuffer(0, 0, w, h, 0, 0, w, h, gl.COLOR_BUFFER_BIT, gl.NEAREST);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  render(s: SceneState, w: number, h: number) {
    const gl = this.gl;
    this.backdrop(s, w, h);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, w, h);
    let u: Record<string, WebGLUniformLocation>;
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    // Far bubbles first.
    const list = s.bubbles.slice().sort((a, b) => b.z - a.z);
    if (list.length) {
      const d = this.instData;
      list.forEach((b, i) => d.set([b.x, b.y, b.z, b.r, b.slot < 0 ? (b.popping ? -2 : -1) : b.slot + (b.popping ? 100 : 0), b.wobble, b.axis, b.attached ? 1 : 0], i * 8));
      gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, d, 0, list.length * 8);
      u = this.base(this.bubble, s, w, h);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, s.atlasTex);
      gl.uniform1i(u.uAtlas, 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, s.wandTex);
      gl.uniform1i(u.uWand, 2);
      gl.uniform2f(u.uSlots, s.slots[0], s.slots[1]);
      gl.uniform1f(u.uWandR, s.wandR);
      gl.bindVertexArray(this.bubbleVao);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, list.length);
    }

    if (s.dropCount) {
      u = this.base(this.drop, s, w, h);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.dropBuf);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, s.drops, 0, s.dropCount * 4);
      gl.bindVertexArray(this.dropVao);
      gl.drawArrays(gl.POINTS, 0, s.dropCount);
    }

    u = this.base(this.wand, s, w, h);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, s.wandTex);
    gl.uniform1i(u.uWand, 1);
    gl.uniform2f(u.uWandC, s.wandC[0], s.wandC[1]);
    gl.uniform1f(u.uWandR, s.wandR);
    gl.uniform1f(u.uBulge, s.bulge);
    gl.uniform1f(u.uFilmOn, s.filmOn ? 1 : 0);
    gl.uniform1f(u.uPopping, s.popping ? 1 : 0);
    gl.uniform4f(u.uBowl, ...s.bowl);
    gl.uniform1f(u.uRipple, s.ripple);
    gl.uniform1f(u.uTime, s.time % 1000);
    gl.bindVertexArray(this.quad);
    // Each part only over the pixels it can touch.
    const px = (x: number) => x * s.pxPerM + w / 2, py = (y: number) => y * s.pxPerM + h / 2;
    const R = s.wandR * 1.12;
    const cx = px(s.wandC[0]), cy = py(s.wandC[1]), rp = R * s.pxPerM;
    const hy = py(s.wandC[1] - s.wandR * 0.7);
    const parts: [number, number, number, number, number][] = [
      [0, cx - rp, cy - rp, 2 * rp, 2 * rp],
      [2, cx + s.wandR * 0.5 * s.pxPerM, 0, w, hy],
      [1, 0, 0, w, py(s.bowl[1] + s.bowl[3] * 1.2)],
    ];
    gl.enable(gl.SCISSOR_TEST);
    for (const [part, x, y, pw, ph] of parts) {
      const x0 = Math.max(0, Math.floor(x)), y0 = Math.max(0, Math.floor(y));
      const x1 = Math.min(w, Math.ceil(x + pw)), y1 = Math.min(h, Math.ceil(y + ph));
      if (x1 <= x0 || y1 <= y0) continue;
      gl.scissor(x0, y0, x1 - x0, y1 - y0);
      gl.uniform1i(u.uPart, part);
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
    gl.disable(gl.SCISSOR_TEST);
    gl.disable(gl.BLEND);
  }

  destroy() {
    const gl = this.gl;
    gl.deleteTexture(this.lut);
    if (this.bgTex) gl.deleteTexture(this.bgTex);
    if (this.bgFbo) gl.deleteFramebuffer(this.bgFbo);
    gl.deleteBuffer(this.inst);
    gl.deleteBuffer(this.dropBuf);
  }
}
