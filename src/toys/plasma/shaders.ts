// Shaders: glowing channel segments (instanced quads with a Gaussian core and a soft halo, the
// cheap stand-in for Kim & Lin's glow convolution), a separable blur for bloom, burn accumulation
// for the boards, and one composite pass that draws the globe, the wood board or the acrylic block.

export const quadVert = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/** One segment per instance: a = (x0, y0, x1, y1) px, b = (width px, intensity, tint, heat). */
export const segVert = /* glsl */ `#version 300 es
layout(location = 1) in vec4 aA;
layout(location = 2) in vec4 aB;
uniform vec2 uRes;
uniform float uReach;
out vec2 vP;
flat out vec4 vA;
flat out vec4 vB;
void main() {
  int id = gl_VertexID;
  vec2 p0 = aA.xy, p1 = aA.zw;
  vec2 d = p1 - p0;
  float L = length(d);
  vec2 t = L > 1e-4 ? d / L : vec2(1.0, 0.0);
  vec2 n = vec2(-t.y, t.x);
  float r = aB.x * uReach;
  float s = (id == 1 || id == 3) ? 1.0 : 0.0;
  float k = (id >= 2) ? 1.0 : -1.0;
  vec2 p = mix(p0 - t * r, p1 + t * r, s) + n * r * k;
  vP = p;
  vA = aA;
  vB = aB;
  gl_Position = vec4(p / uRes * 2.0 - 1.0, 0.0, 1.0);
}`;

const segDist = /* glsl */ `
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
  return length(pa - ba * h);
}`;

/** Glow: plasma (violet core to pink tips), ember (orange) or lightning (blue-white), set by uPalette. */
export const segFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec4 vA;
flat in vec4 vB;
uniform int uPalette;
out vec4 o;
${segDist}
void main() {
  float d = segDist(vP, vA.xy, vA.zw);
  float w = max(vB.x, 0.5);
  float x = d / w;
  float core = exp(-x * x * 1.6);
  float halo = exp(-x * 0.9) * 0.22;
  vec3 col;
  float tint = vB.z;
  if (uPalette == 0) {
    // Neon-xenon: white-pink core in the hot trunk, magenta, then violet-blue at the cool tips.
    vec3 hot = vec3(1.0, 0.72, 0.95), mid = vec3(0.95, 0.28, 0.85), tip = vec3(0.45, 0.25, 1.0);
    vec3 c = mix(tip, mid, smoothstep(0.0, 0.5, tint));
    c = mix(c, hot, smoothstep(0.55, 1.0, tint));
    col = c * core * (1.0 + vB.w * 1.5) + mid * halo * 0.8;
  } else if (uPalette == 1) {
    vec3 c = mix(vec3(1.0, 0.25, 0.03), vec3(1.0, 0.75, 0.35), clamp(tint, 0.0, 1.0));
    col = c * (core + halo * 0.6);
  } else {
    vec3 c = mix(vec3(0.35, 0.55, 1.0), vec3(0.9, 0.95, 1.0), clamp(tint, 0.0, 1.0));
    col = c * (core * (1.0 + vB.w) + halo);
  }
  o = vec4(col * vB.y, 0.0);
}`;

/** Burn accumulation: R = char (wood) or etch (acrylic), added with ONE/ONE blending. */
export const burnFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
flat in vec4 vA;
flat in vec4 vB;
out vec4 o;
${segDist}
void main() {
  float d = segDist(vP, vA.xy, vA.zw);
  float x = d / max(vB.x, 0.5);
  float a = exp(-x * x * 1.3);
  // G: a scorched halo well beyond the char line (wood browns before it blackens).
  float g = exp(-x * 0.55);
  o = vec4(a * vB.y, g * vB.y * 0.25, 0.0, 0.0);
}`;

export const blurFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
uniform vec2 uDir;
out vec4 o;
void main() {
  vec3 c = texture(uTex, vUv).rgb * 0.227;
  c += (texture(uTex, vUv + uDir * 1.385).rgb + texture(uTex, vUv - uDir * 1.385).rgb) * 0.316;
  c += (texture(uTex, vUv + uDir * 3.231).rgb + texture(uTex, vUv - uDir * 3.231).rgb) * 0.070;
  o = vec4(c, 1.0);
}`;

export const MAX_PROBES = 5;

export const compFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uGlow;
uniform sampler2D uBloom1;
uniform sampler2D uBloom2;
uniform sampler2D uBurn;
uniform sampler2D uCharge;
uniform vec2 uRes;
uniform int uMode;
uniform vec3 uGlobe;      // centre px, radius px
uniform float uElectrode; // electrode radius px
uniform float uCore;      // electrode brightness
uniform float uHaze;      // gas glow from total current
uniform vec4 uBoard;      // board rect px: x0, y0, x1, y1
uniform vec3 uNail;       // nail px + radius
uniform vec4 uProbe[${MAX_PROBES}]; // probe px, radius, current
uniform int uProbes;
uniform float uTime;
out vec4 o;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 11.7; a *= 0.5; }
  return s;
}
vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

vec3 room(vec2 px) {
  vec2 q = px / uRes;
  float v = 1.0 - 0.6 * length((q - vec2(0.5, 0.55)) * vec2(1.0, 0.8));
  return vec3(0.012, 0.01, 0.022) * v;
}

vec3 globe(vec2 px, vec3 glow) {
  vec3 c = room(px);
  vec2 C = uGlobe.xy;
  float R = uGlobe.z;
  // Table and base.
  float table = uGlobe.y - R * 1.02;
  if (px.y < table) c = mix(vec3(0.02, 0.016, 0.02), vec3(0.035, 0.03, 0.04), noise(px * 0.02)) * (0.6 + 0.4 * px.y / table);
  float by = uGlobe.y - R * 0.86;
  float bw = mix(R * 0.62, R * 0.4, clamp((px.y - (by - R * 0.3)) / (R * 0.3), 0.0, 1.0));
  if (px.y < by && px.y > by - R * 0.3 && abs(px.x - C.x) < bw) {
    float sh = 0.5 + 0.5 * (px.x - C.x) / bw;
    c = vec3(0.03, 0.028, 0.035) + vec3(0.05) * pow(1.0 - abs(sh - 0.35), 6.0);
  }
  vec2 d = (px - C) / R;
  float r = length(d);
  // Violet glow the discharge casts on the table and base.
  c += vec3(0.5, 0.2, 0.7) * uHaze * 0.12 * exp(-max(0.0, r - 1.0) * 2.5);
  if (r < 1.0) {
    float z = sqrt(1.0 - r * r);
    float fres = pow(1.0 - z, 3.0);
    vec3 inside = vec3(0.02, 0.008, 0.04) + vec3(0.25, 0.08, 0.4) * uHaze * (0.25 + 0.75 * (1.0 - r));
    c = mix(c, inside, 0.85);
    // Glass: rim light, a window reflection and a small specular spot, both bent by the sphere.
    c += vec3(0.25, 0.2, 0.35) * fres * 0.5;
    vec2 w = d - vec2(-0.42, 0.45);
    float win = smoothstep(0.2, 0.0, abs(w.x + w.y * 0.25) - 0.08) * smoothstep(0.34, 0.1, abs(w.y));
    c += vec3(0.45, 0.45, 0.55) * win * 0.18 * (0.4 + fres);
    c += vec3(1.0) * pow(max(0.0, 1.0 - length(d - vec2(-0.5, 0.55)) * 7.0), 3.0) * 0.4;
    // The inner electrode: a small glass ball full of glow.
    float e = length(px - C) / uElectrode;
    if (e < 1.0) {
      float ez = sqrt(1.0 - e * e);
      c = mix(c, vec3(0.9, 0.55, 1.0) * uCore * (0.5 + 0.5 * ez) + vec3(0.05, 0.03, 0.06), 0.9);
      c += vec3(1.0) * pow(max(0.0, 1.0 - length((px - C) / uElectrode - vec2(-0.35, 0.4)) * 3.0), 2.0) * 0.5;
    }
    c += vec3(1.0, 0.6, 1.0) * uCore * 0.5 * exp(-max(0.0, e - 1.0) * 1.2) * step(1.0, e);
    // Where fingers press, the glass glows with the current landing on it.
    for (int i = 0; i < ${MAX_PROBES}; i++) {
      if (i >= uProbes) break;
      float pd = length(px - uProbe[i].xy) / uProbe[i].z;
      c += vec3(1.0, 0.55, 0.95) * uProbe[i].w * exp(-pd * pd * 1.5) * 0.6;
    }
  } else {
    // Glass edge highlight just outside.
    c += vec3(0.3, 0.25, 0.4) * exp(-(r - 1.0) * R * 0.35) * 0.35;
  }
  return c;
}

vec3 wood(vec2 px, vec2 q) {
  // Grain runs along y: rings from a warped distance field, plus fine fibres.
  float w = fbm(vec2(q.x * 3.0, q.y * 0.35));
  float rings = fract((q.x * 5.0 + w * 2.2) * 2.4);
  float fib = noise(vec2(q.x * 180.0, q.y * 6.0));
  vec3 base = mix(vec3(0.72, 0.52, 0.32), vec3(0.62, 0.42, 0.24), smoothstep(0.35, 0.9, rings));
  base *= 0.9 + 0.12 * fib;
  return base;
}

vec3 board(vec2 px, vec3 glow) {
  vec2 lo = uBoard.xy, hi = uBoard.zw;
  vec3 c = vec3(0.05, 0.045, 0.04) * (0.7 + 0.3 * noise(px * 0.01));
  vec2 bd = max(lo - px, px - hi);
  float out_ = max(bd.x, bd.y);
  // Shadow under the board.
  c *= 1.0 - 0.6 * exp(-max(0.0, out_) * 0.03);
  if (out_ > 0.0) return c;
  vec2 q = (px - lo) / (hi.y - lo.y);
  vec4 burn = texture(uBurn, px / uRes);
  if (uMode == 1) {
    vec3 wd = wood(px, q);
    // Wet with electrolyte: a faint sheen.
    wd *= 0.92;
    float ch = 1.0 - exp(-burn.r * 1.2);
    float sc = 1.0 - exp(-burn.g * 0.8);
    wd = mix(wd, wd * vec3(0.55, 0.38, 0.22), sc * 0.8);
    wd = mix(wd, vec3(0.05, 0.03, 0.02) + 0.03 * noise(px * 0.3), smoothstep(0.1, 0.8, ch));
    // Bevelled edge.
    float edge = min(min(px.x - lo.x, hi.x - px.x), min(px.y - lo.y, hi.y - px.y));
    wd *= 0.75 + 0.25 * smoothstep(0.0, 10.0, edge);
    c = wd;
  } else {
    // Acrylic block: dark through the clear plastic, charge as a faint blue haze, and the etched figure.
    vec2 cq = (px - lo) / (hi - lo);
    float ch = texture(uCharge, cq).r;
    float edge = min(min(px.x - lo.x, hi.x - px.x), min(px.y - lo.y, hi.y - px.y));
    vec3 ac = vec3(0.03, 0.045, 0.06) + vec3(0.08, 0.14, 0.22) * exp(-edge * 0.06);
    ac += vec3(0.15, 0.3, 0.7) * ch * 0.35;
    float et = 1.0 - exp(-burn.r * 0.9);
    ac += vec3(0.75, 0.85, 1.0) * et * 0.55 + vec3(0.2, 0.3, 0.5) * (1.0 - exp(-burn.g * 0.5)) * 0.2;
    ac += vec3(0.8) * smoothstep(3.0, 0.0, edge) * 0.25;
    c = ac;
  }
  // Brass nail.
  if (uMode == 1) {
    float nd = length(px - uNail.xy) / uNail.z;
    if (nd < 1.0) c = mix(vec3(0.75, 0.6, 0.3), vec3(0.3, 0.22, 0.1), nd) + vec3(0.4) * pow(max(0.0, 1.0 - length((px - uNail.xy) / uNail.z - vec2(-0.3, 0.35)) * 2.5), 2.0);
    else c *= 1.0 - 0.4 * exp(-(nd - 1.0) * 3.0);
  }
  for (int i = 0; i < ${MAX_PROBES}; i++) {
    if (i >= uProbes) break;
    float pd = length(px - uProbe[i].xy) / uProbe[i].z;
    if (uMode == 1 && pd < 1.0) c = mix(vec3(0.7, 0.72, 0.75), vec3(0.25, 0.26, 0.28), pd);
    if (uMode == 2) c += vec3(0.4, 0.6, 1.0) * uProbe[i].w * exp(-pd * pd) * 0.4;
  }
  return c;
}

void main() {
  vec2 px = vUv * uRes;
  vec3 glow = texture(uGlow, vUv).rgb;
  vec3 bloom = texture(uBloom1, vUv).rgb * 0.9 + texture(uBloom2, vUv).rgb * 1.1;
  vec3 c = uMode == 0 ? globe(px, glow) : board(px, glow);
  c += glow + bloom;
  c = aces(c * 1.05);
  c += (hash(px + fract(uTime) * 91.0) - 0.5) / 255.0;
  o = vec4(pow(c, vec3(1.0 / 1.1)), 1.0);
}`;
