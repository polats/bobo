// GLSL ES 3.00 passes for the soap-film simulation. One texture can hold several films side by side
// (the wand's disc, or an atlas of free bubbles): `uSlots` is the grid of slots, and each slot holds a
// disc of film seen face-on. Velocities are in cells per second, as in Ink Swirl's stable fluids.
// Film state texture: r = thickness (µm), g = its rate of change (Ishida's thickness "velocity"),
// b = hole front: 0 while intact; once torn, 1 + how far (in cells) the rim has run past this cell.

export const MAX_SLOTS = 12;

export const vert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const head = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform vec2 texel;
uniform vec2 uSlots;
// Per slot: x = metres per cell, y = alive (0/1), z = tangential gravity factor, w = mean thickness (µm).
uniform vec4 uSlot[${MAX_SLOTS}];
const float DISC = 0.92;
int slotOf(vec2 uv) {
  vec2 s = min(floor(uv * uSlots), uSlots - 1.0);
  return int(s.y * uSlots.x + s.x);
}
// Position inside the slot's disc, -1..1 across the slot.
vec2 local(vec2 uv) { return fract(uv * uSlots) * 2.0 - 1.0; }
float inside(vec2 uv) {
  vec2 p = local(uv);
  return step(dot(p, p), DISC * DISC);
}
`;

/** Body forces: thickness buoyancy (thin film is lighter and rises), air drag, walls. */
export const forceFrag = head + /* glsl */ `
uniform sampler2D uVel;
uniform sampler2D uFilm;
uniform float dt;
uniform float buoy;   // m/s^2 per µm of thickness
uniform float drag;   // 1/s
void main() {
  vec4 s = uSlot[slotOf(vUv)];
  vec2 v = texture(uVel, vUv).xy;
  float h = texture(uFilm, vUv).r;
  if (inside(vUv) < 0.5 || s.y < 0.5) { fragColor = vec4(0.0); return; }
  // Heavier (thicker) film sinks, lighter rises. Only departures from the mean drive it (a uniform
  // weight is carried by the rim, and would only load the pressure solve).
  v.y -= dt * buoy * s.z * (h - s.w) / s.x;
  v *= exp(-drag * dt);
  fragColor = vec4(v, 0.0, 1.0);
}`;

/** Finger stir: a Gaussian velocity splat (Ink Swirl's splat, limited to the disc). */
export const splatFrag = head + /* glsl */ `
uniform sampler2D uVel;
uniform vec2 point;
uniform vec2 force;
uniform float radius;
void main() {
  vec2 d = vUv - point;
  vec2 v = texture(uVel, vUv).xy + force * exp(-dot(d, d) / radius) * inside(vUv);
  fragColor = vec4(v, 0.0, 1.0);
}`;

export const curlFrag = head + /* glsl */ `
uniform sampler2D uVel;
void main() {
  float L = texture(uVel, vUv - vec2(texel.x, 0.0)).y;
  float R = texture(uVel, vUv + vec2(texel.x, 0.0)).y;
  float T = texture(uVel, vUv + vec2(0.0, texel.y)).x;
  float B = texture(uVel, vUv - vec2(0.0, texel.y)).x;
  fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

export const vorticityFrag = head + /* glsl */ `
uniform sampler2D uVel;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main() {
  float L = texture(uCurl, vUv - vec2(texel.x, 0.0)).x;
  float R = texture(uCurl, vUv + vec2(texel.x, 0.0)).x;
  float T = texture(uCurl, vUv + vec2(0.0, texel.y)).x;
  float B = texture(uCurl, vUv - vec2(0.0, texel.y)).x;
  float C = texture(uCurl, vUv).x;
  vec2 f = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  f /= length(f) + 1e-4;
  f *= curl * C;
  f.y *= -1.0;
  vec2 v = texture(uVel, vUv).xy + f * dt * inside(vUv);
  fragColor = vec4(clamp(v, -2000.0, 2000.0), 0.0, 1.0);
}`;

/** Divergence with free-slip walls at the wand's rim. */
export const divergenceFrag = head + /* glsl */ `
uniform sampler2D uVel;
void main() {
  vec2 C = texture(uVel, vUv).xy;
  vec2 l = vUv - vec2(texel.x, 0.0), r = vUv + vec2(texel.x, 0.0);
  vec2 t = vUv + vec2(0.0, texel.y), b = vUv - vec2(0.0, texel.y);
  float L = inside(l) > 0.5 ? texture(uVel, l).x : -C.x;
  float R = inside(r) > 0.5 ? texture(uVel, r).x : -C.x;
  float T = inside(t) > 0.5 ? texture(uVel, t).y : -C.y;
  float B = inside(b) > 0.5 ? texture(uVel, b).y : -C.y;
  fragColor = vec4(0.5 * (R - L + T - B) * inside(vUv), 0.0, 0.0, 1.0);
}`;

export const scaleFrag = head + /* glsl */ `
uniform sampler2D uTex;
uniform float value;
void main() { fragColor = value * texture(uTex, vUv); }`;

/** Jacobi step; outside the disc the pressure mirrors the cell (zero normal gradient). */
export const pressureFrag = head + /* glsl */ `
uniform sampler2D uP;
uniform sampler2D uDiv;
void main() {
  float C = texture(uP, vUv).x;
  vec2 l = vUv - vec2(texel.x, 0.0), r = vUv + vec2(texel.x, 0.0);
  vec2 t = vUv + vec2(0.0, texel.y), b = vUv - vec2(0.0, texel.y);
  float L = inside(l) > 0.5 ? texture(uP, l).x : C;
  float R = inside(r) > 0.5 ? texture(uP, r).x : C;
  float T = inside(t) > 0.5 ? texture(uP, t).x : C;
  float B = inside(b) > 0.5 ? texture(uP, b).x : C;
  fragColor = vec4((L + R + T + B - texture(uDiv, vUv).x) * 0.25, 0.0, 0.0, 1.0);
}`;

export const gradientFrag = head + /* glsl */ `
uniform sampler2D uP;
uniform sampler2D uVel;
void main() {
  float C = texture(uP, vUv).x;
  vec2 l = vUv - vec2(texel.x, 0.0), r = vUv + vec2(texel.x, 0.0);
  vec2 t = vUv + vec2(0.0, texel.y), b = vUv - vec2(0.0, texel.y);
  float L = inside(l) > 0.5 ? texture(uP, l).x : C;
  float R = inside(r) > 0.5 ? texture(uP, r).x : C;
  float T = inside(t) > 0.5 ? texture(uP, t).x : C;
  float B = inside(b) > 0.5 ? texture(uP, b).x : C;
  vec2 v = (texture(uVel, vUv).xy - vec2(R - L, T - B)) * inside(vUv);
  fragColor = vec4(v, 0.0, 1.0);
}`;

export const advectVelFrag = head + /* glsl */ `
uniform sampler2D uVel;
uniform float dt;
void main() {
  vec2 back = vUv - dt * texture(uVel, vUv).xy * texel;
  fragColor = vec4(texture(uVel, back).xy * inside(vUv), 0.0, 1.0);
}`;

/**
 * Thickness: advected by the surface flow, drained by gravity (a conservative upwind flux that
 * grows as h^3, so thick film runs and thin film stalls), rippled by surface tension (Ishida's
 * d²h/dt² ∝ ∇²h term), thinned by evaporation and by the rim's Plateau border sucking liquid out
 * (marginal regeneration), and torn open where it falls below the rupture thickness: the hole's
 * rim then runs out at the Culick speed sqrt(2σ/(ρh)) for the local thickness.
 */
export const filmFrag = head + /* glsl */ `
uniform sampler2D uFilm;
uniform sampler2D uVel;
uniform float dt;
uniform float drain;     // m/s of flux velocity per µm² of thickness
uniform float waves;     // surface-tension wave speed², m²/s² (times the thickness Laplacian)
uniform float waveDamp;  // 1/s
uniform float evap;      // µm/s
uniform float suction;   // 1/s, rim band
uniform float rimThin;   // µm the border pulls the film towards
uniform float rupture;   // µm
uniform float blackH;    // common black film thickness, µm
uniform float blackRate; // hole nucleation rate per cell per second in black film
uniform float frame;
// PCG integer hash: tiny per-frame probabilities need far finer steps than fract(sin()) gives.
float rand(vec2 cell) {
  uint v = uint(cell.x) + uint(cell.y) * 4099u + uint(frame) * 16777259u;
  uint st = v * 747796405u + 2891336453u;
  uint w = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u;
  return float((w >> 22u) ^ w) * (1.0 / 4294967296.0);
}
void main() {
  vec4 s = uSlot[slotOf(vUv)];
  vec4 c = texture(uFilm, vUv);
  if (s.y < 0.5) { fragColor = c; return; }
  // Torn cells are left to the front pass.
  if (c.b >= 1.0 && inside(vUv) > 0.5) { fragColor = c; return; }
  if (inside(vUv) < 0.5) {
    // Just outside the rim, copy the neighbouring film so interpolation near the wall stays neutral.
    float sum = 0.0, n = 0.0;
    for (int j = -1; j <= 1; j++) for (int i = -1; i <= 1; i++) {
      vec2 q = vUv + vec2(float(i), float(j)) * texel;
      if (inside(q) > 0.5) { sum += texture(uFilm, q).r; n += 1.0; }
    }
    fragColor = vec4(n > 0.0 ? sum / n : c.r, 0.0, 0.0, 1.0);
    return;
  }
  float cell = s.x;
  // Advect thickness and its rate with the surface flow (semi-Lagrangian).
  vec2 back = vUv - dt * texture(uVel, vUv).xy * texel;
  if (inside(back) < 0.5) back = vUv;
  vec4 a = texture(uFilm, back);
  float h = a.r, hv = a.g;
  // Gravity drainage in flux form: liquid leaves each cell downward at velocity drain*h^2.
  vec2 up = vUv + vec2(0.0, texel.y), dn = vUv - vec2(0.0, texel.y);
  float hc = c.r;
  float hu = inside(up) > 0.5 ? texture(uFilm, up).r : 0.0;
  float g = drain * s.z;
  // (Capped at half a cell's liquid per step, which only binds for very thick film on tiny bubbles.)
  float fin = min(g * hu * hu * hu, 0.5 * hu * cell / dt);   // from the cell above (none through the top of the rim)
  // Into the cell below, or into the bottom Plateau border, which is already brimming and takes it slowly:
  // so liquid piles up into thick bands at the bottom.
  float fout = min(g * hc * hc * hc, 0.5 * hc * cell / dt) * (inside(dn) > 0.5 ? 1.0 : 0.12);
  h += dt * (fin - fout) / cell;
  // Surface tension acting on thickness: a damped wave equation, as in Ishida et al.
  // Zero flux through the rim: a missing neighbour mirrors this cell.
  vec2 lf = vUv - vec2(texel.x, 0.0), rt = vUv + vec2(texel.x, 0.0);
  float hl = inside(lf) > 0.5 ? texture(uFilm, lf).r : hc;
  float hr = inside(rt) > 0.5 ? texture(uFilm, rt).r : hc;
  float hd = inside(dn) > 0.5 ? texture(uFilm, dn).r : hc;
  float hw = inside(up) > 0.5 ? hu : hc;
  float lap = (hl + hr + hw + hd - 4.0 * hc) / (cell * cell);
  // (Black film is a stiff surfactant bilayer: no thickness waves in it.)
  float stiff = smoothstep(0.03, 0.08, hc);
  hv = (hv + dt * waves * lap) * stiff * exp(-waveDamp * dt);
  h += dt * hv;
  // Evaporation stops at black film: what's left is two surfactant layers with almost no water.
  h -= evap * dt * smoothstep(blackH * 0.9, blackH * 2.5, h);
  // Plateau border at the rim sucks liquid out of the film next to it.
  float r = length(local(vUv)) / DISC;
  float band = smoothstep(0.9, 1.0, r);
  h += (min(rimThin, h) - h) * (1.0 - exp(-suction * band * dt));
  // Below ~35 nm the film collapses to common black film (a jump, so black spots have sharp edges).
  if (h < 0.035) h += (blackH - h) * (1.0 - exp(-6.0 * dt));
  h = max(h, 0.0);
  // Rupture: thermal holes nucleate at random, often below the rupture thickness, rarely in
  // black film above it; bigger thin patches are likelier to go.
  float o = 0.0;
  float rate = h < rupture ? 3.0 : (h < blackH * 1.5 ? blackRate : 0.0);
  if (rand(floor(vUv / texel)) < rate * dt) o = 1.0;
  if (o >= 1.0) hv = 0.0;
  fragColor = vec4(h, hv, o, 1.0);
}`;

/**
 * The hole's rim running outward: a torn cell's front advances at the Culick speed for the film it
 * tore through, and an intact cell tears once a torn neighbour's front has run the distance to it.
 * Run in substeps; each is capped so the front stays round rather than taking the stencil's shape.
 */
export const frontFrag = head + /* glsl */ `
uniform sampler2D uFilm;
uniform float dt;
uniform float culick;
const vec2 STENCIL[16] = vec2[16](vec2(1, 0), vec2(-1, 0), vec2(0, 1), vec2(0, -1), vec2(1, 1), vec2(-1, 1), vec2(1, -1), vec2(-1, -1),
  vec2(2, 1), vec2(-2, 1), vec2(2, -1), vec2(-2, -1), vec2(1, 2), vec2(-1, 2), vec2(1, -2), vec2(-1, -2));
void main() {
  vec4 s = uSlot[slotOf(vUv)];
  vec4 c = texture(uFilm, vUv);
  if (s.y < 0.5 || inside(vUv) < 0.5) { fragColor = c; return; }
  if (c.b >= 1.0) {
    float jitter = 0.85 + 0.3 * fract(sin(dot(floor(vUv / texel), vec2(12.9898, 78.233))) * 43758.5453);
    c.b = min(c.b + min(dt * culick * jitter / sqrt(max(c.r, 0.004)) / s.x, 0.9), 6.0e4);
    fragColor = c;
    return;
  }
  float o = 0.0;
  for (int k = 0; k < 16; k++) {
    vec2 q = vUv + STENCIL[k] * texel;
    if (inside(q) < 0.5) continue;
    float f = texture(uFilm, q).b;
    if (f >= 1.0) o = max(o, f - length(STENCIL[k]));
  }
  // The film it tears keeps its thickness (so the rim knows how fast to run) but stops moving.
  fragColor = o >= 1.0 ? vec4(c.r, 0.0, o, 1.0) : c;
}`;

/** Paint fresh film into rows [y0, y1] (the part of the disc that just left the bath). */
export const paintFrag = head + /* glsl */ `
uniform sampler2D uFilm;
uniform float y0, y1, h, seed;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
void main() {
  vec4 c = texture(uFilm, vUv);
  float y = local(vUv).y;
  if (y >= y0 && y < y1) {
    float n = hash(floor(vUv / texel)) - 0.5;
    c = vec4(h * (1.0 + 0.03 * n), 0.0, 0.0, 1.0);
  }
  fragColor = c;
}`;

/** Clear velocity inside rows [y0, y1] too, or everywhere with y0 < -1. */
export const paintVelFrag = head + /* glsl */ `
uniform sampler2D uVel;
uniform float y0, y1;
void main() {
  float y = local(vUv).y;
  fragColor = (y >= y0 && y < y1) ? vec4(0.0) : texture(uVel, vUv);
}`;

/**
 * Inflation feeds fresh film in from the rim: old film is squeezed towards the pole by the area
 * ratio `k` (new/old area); the ring of new film pulled from the rim's meniscus gets thickness hNew.
 * k < 1 runs it the other way and the film drains back into the rim.
 */
export const feedFrag = head + /* glsl */ `
uniform sampler2D uTex;
uniform float k;
uniform float hNew;
uniform float isFilm;
uniform float thin;   // uniform stretch thinning of the film that was already there
uniform float seed;
float hash(vec2 p) { return fract(sin(dot(p, vec2(12.9898, 78.233)) + seed) * 43758.5453); }
void main() {
  vec2 p = local(vUv);
  vec2 q = p * sqrt(k);
  vec2 base = floor(vUv * uSlots) / uSlots;
  vec2 uv = base + (q * 0.5 + 0.5) / uSlots;
  if (length(q) < DISC * 0.97) {
    vec4 c = texture(uTex, uv);
    fragColor = isFilm > 0.5 ? vec4(c.r * thin, c.g * thin, c.ba) : vec4(c.xy / sqrt(k), 0.0, 1.0);
  } else {
    fragColor = isFilm > 0.5 ? vec4(hNew * (1.0 + 0.04 * (hash(floor(vUv / texel)) - 0.5)), 0.0, 0.0, 1.0) : vec4(0.0);
  }
}`;

/** Copy a whole single-slot film (the wand's) into one slot of the atlas. */
export const copyFrag = head + /* glsl */ `
uniform sampler2D uDst;
uniform sampler2D uSrc;
uniform float target;
uniform vec4 mul;
void main() {
  if (float(slotOf(vUv)) != target) { fragColor = texture(uDst, vUv); return; }
  fragColor = texture(uSrc, fract(vUv * uSlots)) * mul;
}`;

/** Open a hole at a point (a finger poking a bubble). */
export const pokeFrag = head + /* glsl */ `
uniform sampler2D uFilm;
uniform vec2 point;
uniform float radius;
void main() {
  vec4 c = texture(uFilm, vUv);
  vec2 d = (vUv - point) / texel;
  if (dot(d, d) < radius * radius) c.b = 1.0;
  fragColor = c;
}`;

/** 8x8 block reduction to RGBA8 for readback: r = any hole, g = sqrt(min h / 3), b = sqrt(mean h / 3). */
export const reduceFrag = head + /* glsl */ `
uniform sampler2D uFilm;
uniform vec2 srcTexel;
void main() {
  vec2 base = floor(gl_FragCoord.xy) * 8.0;
  float o = 0.0, mn = 9.0, sum = 0.0, cnt = 0.0;
  for (int j = 0; j < 8; j++) for (int i = 0; i < 8; i++) {
    vec2 uv = (base + vec2(float(i), float(j)) + 0.5) * srcTexel;
    if (inside(uv) < 0.5) continue;
    vec4 c = texture(uFilm, uv);
    float torn = step(1.0, c.b);
    o = max(o, torn);
    if (torn < 0.5) { mn = min(mn, c.r); sum += c.r; cnt += 1.0; }
  }
  fragColor = vec4(o, sqrt(clamp(mn / 3.0, 0.0, 1.0)), sqrt(clamp(sum / max(cnt, 1.0) / 3.0, 0.0, 1.0)), cnt > 0.0 ? 1.0 : 0.0);
}`;
