// Shell-textured lawn (Lengyel et al. 2001, via Acerola's opaque-discard recipe): the lawn quad is
// drawn N times at rising heights; each shell keeps only the fragments inside a hashed blade cell
// that is still that tall. Length and lean come from CPU-mirrored textures (lawn.ts).

export const MAX_SHADOWS = 4;

const common = /* glsl */ `
vec3 hash32(vec2 p) {
  // Dave Hoskins' sine-free hash: stable across GPUs, no banding at large cell ids.
  vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
  p3 += dot(p3, p3.yxz + 33.33);
  return fract((p3.xxy + p3.yzz) * p3.zyx);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash32(i).x, hash32(i + vec2(1, 0)).x, f.x), mix(hash32(i + vec2(0, 1)).x, hash32(i + vec2(1, 1)).x, f.x), f.y);
}`;

export const shellVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
uniform mat4 viewProj;
uniform vec2 lawnSize;
uniform float grassH;
uniform int shells;
uniform float time;
uniform float windAmp;
uniform vec2 windDir;
out vec3 vWorld;
out vec3 vWind; // xy = sway at the tip, z = gust phase
out float vPatch;
flat out float vH;
flat out int vShell;
${common}

// Curl of an analytic stream function: divergence-free swirls, so gusts flow instead of pulsing.
float psi(vec2 q, float t) {
  return sin(q.x * 3.1 + t * 1.3) * sin(q.y * 2.3 - t * 0.9) + 0.5 * sin(q.x * 7.0 - q.y * 5.0 + t * 2.1);
}
vec2 curlWind(vec2 p, float t) {
  const float e = 0.02;
  return vec2(psi(p + vec2(0.0, e), t) - psi(p - vec2(0.0, e), t), psi(p - vec2(e, 0.0), t) - psi(p + vec2(e, 0.0), t)) / (2.0 * e);
}

void main() {
  // Top shell first: lower shells hidden behind blades already drawn fail the depth test early.
  int i = shells - 1 - gl_InstanceID;
  float h = float(i) / float(shells - 1);
  vec2 xz = (aPosition - 0.5) * lawnSize;
  vWorld = vec3(xz.x, h * grassH, xz.y);
  vH = h;
  vShell = i;
  // Wind and patchiness vary slowly, so they're computed per vertex of the lawn grid, not per pixel.
  float gust = 0.5 + 0.5 * sin(dot(xz, windDir) * 7.0 - time * 2.4 + sin(xz.y * 3.0 + time * 0.7));
  vWind = vec3((windDir * (0.35 + 0.65 * gust) + 0.12 * curlWind(xz, time)) * windAmp, gust);
  vPatch = vnoise(xz * 5.0);
  gl_Position = viewProj * vec4(vWorld, 1.0);
}`;

export const shellFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec3 vWorld;
in vec3 vWind;
in float vPatch;
flat in float vH;
flat in int vShell;
uniform sampler2D uLen;
uniform sampler2D uLean;
uniform sampler2D uKind;
uniform vec2 lawnSize;
uniform float grassH;
uniform float density;
uniform float cutLevel;
uniform vec3 camPos;
uniform vec4 shadows[${MAX_SHADOWS}];
out vec4 fragColor;
${common}

void main() {
  vec2 p = vWorld.xz;
  vec2 uv = p / lawnSize + 0.5;
  float L = texture(uLen, uv).r;
  float h = vH;
  // Nothing grows this tall here: the mown lawn gets cheaper as you go.
  if (vShell > 0 && h > L) discard;
  vec2 lean = texture(uLean, uv).rg * (255.0 / 127.0) - (128.0 / 127.0);
  float tall = smoothstep(cutLevel + 0.06, cutLevel + 0.35, L);

  // Wind sways tall grass (tips most); mown stubble leans the way the deck travelled.
  vec2 disp = lean * h * grassH * 0.9 + vWind.xy * tall * h * h;
  vec2 root = p - disp;

  // The blade grid is rotated and row-staggered so no axis-aligned lattice shows through;
  // stubble is finer than the uncut sward, so a mown lawn reads as a carpet, not a mosaic.
  vec2 cell = mat2(0.866, 0.5, -0.5, 0.866) * root * density * mix(1.8, 1.0, step(0.5, tall));
  cell.x += floor(cell.y) * 0.5;
  vec3 r = hash32(floor(cell));
  vec2 f = fract(cell) - 0.5 - (r.xy - 0.5) * 0.5;
  float natural = 0.62 + 0.38 * r.z;
  float top = min(natural, L);
  float rel = h / natural;
  if (vShell > 0) {
    if (h > top) discard;
    // Taper toward the natural tip; a cut blade keeps the width it had at the cut (blunt).
    float rad = 0.52 * (1.0 - rel) + 0.07 + 0.08 * (1.0 - tall);
    if (dot(f, f) > rad * rad) discard;
  }

  float cut = 1.0 - tall;
  float canopy = h / max(L, 0.04);
  vec3 lo = vec3(0.05, 0.16, 0.03);
  vec3 hi = mix(vec3(0.24, 0.52, 0.1), vec3(0.34, 0.6, 0.14), r.x);
  vec3 col = mix(lo, hi, smoothstep(0.0, 1.0, canopy));
  // Uncut tips go lighter and yellower; fresh cut ends are paler still.
  col = mix(col, vec3(0.52, 0.7, 0.24), tall * smoothstep(0.78, 1.0, rel) * 0.6);
  col = mix(col, vec3(0.46, 0.7, 0.22), cut * smoothstep(0.5, 1.0, canopy) * 0.55);
  col *= (0.88 + 0.24 * r.y) * (0.86 + 0.28 * vPatch);
  if (vShell == 0) {
    float kind = texture(uKind, uv).r;
    vec3 soil = mix(vec3(0.24, 0.15, 0.08), vec3(0.34, 0.22, 0.12), vnoise(p * 60.0));
    // Under short stubble the gaps are shallow, so they're less dark than under the tall sward.
    col = mix(mix(vec3(0.07, 0.12, 0.04), vec3(0.14, 0.26, 0.07), cut), soil, smoothstep(0.3, 0.5, kind));
  }

  // Stripes: stubble bent away from the eye shows its lit side, bent toward it shows shadow.
  vec2 away = normalize(p - camPos.xz);
  float s = dot(lean, normalize(away + vec2(0.35, 0.0)));
  col *= 1.0 + (s > 0.0 ? 0.3 : 0.24) * s * cut * (0.35 + 0.65 * canopy);
  col += vec3(0.05, 0.06, 0.04) * max(s, 0.0) * cut * canopy;
  col *= 1.0 + 0.14 * (vWind.z - 0.5) * tall * h;

  for (int i = 0; i < ${MAX_SHADOWS}; i++) {
    vec4 sh = shadows[i];
    if (sh.w <= 0.0) continue;
    float d = length(p - sh.xy) / sh.z;
    col *= 1.0 - sh.w * (1.0 - smoothstep(0.35, 1.0, d)) * (0.6 + 0.4 * (1.0 - h));
  }
  fragColor = vec4(col * vec3(1.06, 1.02, 0.94), 1.0);
}`;

/** The garden around the lawn: brick edging, a gravel path and a hedge band. */
export const groundVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
uniform mat4 viewProj;
out vec2 vP;
void main() {
  vP = aPosition * 4.0;
  gl_Position = viewProj * vec4(vP.x, 0.0, vP.y, 1.0);
}`;

export const groundFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vP;
uniform vec2 lawnSize;
out vec4 fragColor;
${common}
void main() {
  vec2 q = abs(vP) - lawnSize * 0.5;
  float d = max(q.x, q.y); // outside distance to the lawn rectangle (square corners)
  if (d < 0.0) discard;
  vec3 col;
  if (d < 0.028) {
    // Brick edging, bricks running along the edge.
    bool side = q.x > q.y;
    vec2 b = side ? vec2(vP.y, d) : vec2(vP.x, d);
    b *= vec2(1.0 / 0.05, 1.0 / 0.028);
    b.x += floor(b.y) * 0.5;
    vec2 g = abs(fract(b) - 0.5);
    float mortar = step(0.46, max(g.x, g.y * 0.2 + 0.26));
    vec3 brick = mix(vec3(0.62, 0.3, 0.2), vec3(0.72, 0.4, 0.26), hash32(floor(b)).x);
    col = mix(brick, vec3(0.75, 0.7, 0.62), mortar);
  } else if (d < 0.17) {
    float n = vnoise(vP * 180.0) * 0.6 + vnoise(vP * 45.0) * 0.4;
    col = mix(vec3(0.66, 0.6, 0.5), vec3(0.84, 0.79, 0.68), n);
    col *= 0.8 + 0.2 * smoothstep(0.028, 0.05, d);
  } else {
    // Hedge: leafy clumps (a few octaves of value noise), dark in the gaps.
    float n = vnoise(vP * 7.0) * 0.5 + vnoise(vP * 17.0 + 3.1) * 0.3 + vnoise(vP * 37.0 + 7.7) * 0.2;
    col = mix(vec3(0.03, 0.08, 0.03), vec3(0.19, 0.38, 0.12), smoothstep(0.3, 0.8, n));
    col *= 0.55 + 0.45 * smoothstep(0.17, 0.2, d) * (1.0 - smoothstep(0.2, 1.2, d) * 0.4);
    col *= 0.6 + 0.4 * smoothstep(0.17, 0.2, d);
  }
  fragColor = vec4(col, 1.0);
}`;

export const meshVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec3 aPosition;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec3 aColor;
uniform mat4 viewProj;
uniform mat4 model;
out vec3 vN;
out vec3 vC;
void main() {
  vN = mat3(model) * aNormal;
  vC = aColor;
  gl_Position = viewProj * model * vec4(aPosition, 1.0);
}`;

export const meshFrag = /* glsl */ `#version 300 es
precision highp float;
in vec3 vN;
in vec3 vC;
uniform vec3 sun;
uniform vec3 tint;
out vec4 fragColor;
void main() {
  vec3 n = normalize(vN);
  float diff = max(dot(n, sun), 0.0);
  float sky = 0.5 + 0.5 * n.y;
  vec3 col = vC * tint * (0.34 * mix(vec3(0.5, 0.45, 0.35), vec3(0.75, 0.85, 1.0), sky) + 0.85 * diff * vec3(1.0, 0.96, 0.86));
  fragColor = vec4(col, 1.0);
}`;

/** Clippings and petals: perspective-sized point sprites shaped like little slivers. */
export const partVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aPosition; // xyz, size
layout(location = 1) in vec4 aColor;
uniform mat4 viewProj;
uniform float pxPerUnit;
out vec4 vC;
flat out float vAngle;
void main() {
  gl_Position = viewProj * vec4(aPosition.xyz, 1.0);
  gl_PointSize = max(1.5, aPosition.w * pxPerUnit / gl_Position.w);
  vC = aColor;
  vAngle = float(gl_VertexID) * 2.399;
}`;

export const partFrag = /* glsl */ `#version 300 es
precision highp float;
in vec4 vC;
flat in float vAngle;
out vec4 fragColor;
void main() {
  vec2 q = gl_PointCoord - 0.5;
  float c = cos(vAngle), s = sin(vAngle);
  q = vec2(c * q.x - s * q.y, s * q.x + c * q.y);
  if (abs(q.x) > 0.48 || abs(q.y) > 0.16 + 0.1 * vC.a) discard;
  fragColor = vec4(vC.rgb * (0.85 + 0.3 * (0.5 - q.y)), 1.0);
}`;

export const compositeVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

export const compositeFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uScene;
out vec4 fragColor;
void main() {
  vec3 col = texture(uScene, vUv).rgb;
  vec2 v = vUv - 0.5;
  col *= 1.0 - 0.35 * dot(v, v);
  // Gentle filmic lift: warm highlights, cooler shadows.
  col = mix(col, col * vec3(0.92, 0.98, 1.06), 1.0 - smoothstep(0.0, 0.4, dot(col, vec3(0.33))));
  fragColor = vec4(pow(col, vec3(0.95)), 1.0);
}`;
