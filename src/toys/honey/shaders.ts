// GLSL for Honey Drizzle. Colours are computed in linear light and encoded to sRGB-ish (gamma 2.2)
// on output; the scene texture the honey refracts is decoded back before it is tinted.

const COMMON = /* glsl */ `
precision highp float;
uniform vec3 uEye;
uniform vec3 uLight;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
float fbm(vec2 p) {
  float s = 0.0, a = 0.5;
  for (int i = 0; i < 4; i++) { s += a * noise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
// A kitchen: warm room below, pale ceiling, a big window front-left and a lamp behind.
vec3 env(vec3 r) {
  vec3 c = mix(vec3(0.16, 0.11, 0.07), vec3(0.64, 0.58, 0.5), smoothstep(-0.25, 0.7, r.y));
  vec3 w = normalize(vec3(-0.55, 0.62, 0.56));
  float d = dot(r, w);
  vec3 side = normalize(cross(w, vec3(0.0, 1.0, 0.0)));
  float bx = abs(dot(r - w * d, side)), by = abs(dot(r - w * d, cross(side, w)));
  c += vec3(3.2, 3.1, 2.9) * smoothstep(0.34, 0.3, bx) * smoothstep(0.22, 0.18, by) * step(0.0, d);
  c += vec3(2.4, 1.8, 1.1) * smoothstep(0.985, 0.995, dot(r, normalize(vec3(0.6, 0.55, -0.6))));
  return c;
}
vec3 toLin(vec3 c) { return pow(c, vec3(2.2)); }
vec3 toOut(vec3 c) {
  c = c / (1.0 + max(c - 0.85, 0.0) * 0.8);
  return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2));
}
`;

/** Honey optics shared by the thread and the dipper coat. */
const HONEY = /* glsl */ `
uniform vec3 uAbsorb;
uniform vec3 uScatter;
uniform float uCloud;
uniform sampler2D uScene;
uniform vec2 uRes;
// n: normal, v: to eye, path: mm of honey the view ray crosses, bg: refracted background (linear).
vec3 honeyShade(vec3 n, vec3 v, float path, vec3 bg) {
  vec3 T = exp(-uAbsorb * path);
  float cloud = uCloud * (1.0 - exp(-path * 2.5));
  float ndl = max(dot(n, uLight), 0.0);
  // Clear body: the refracted scene, tinted; light that soaks through from behind glows amber.
  vec3 body = bg * T;
  float back = pow(max(dot(-v, uLight), 0.0), 3.0);
  // Honey isn't perfectly clear: some light scatters inside and it glows with its own colour.
  float wrap = max(dot(n, uLight) * 0.5 + 0.5, 0.0);
  body += uScatter * (1.0 - T) * (0.3 + 0.45 * wrap + 1.1 * back) * (1.0 - uCloud);
  // Cloudy body (chocolate, condensed milk): diffuse like paint.
  vec3 diff = uScatter * (0.3 + 0.85 * ndl);
  vec3 c = mix(body, diff, cloud);
  float f = 0.04 + 0.96 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  vec3 r = reflect(-v, n);
  c += env(r) * f * mix(0.8, 0.6, uCloud);
  c += vec3(1.6, 1.45, 1.2) * pow(max(dot(r, uLight), 0.0), 200.0) * 1.5;
  return c;
}
`;

export const BLIT_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() { vUv = aPosition * 0.5 + 0.5; gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

export const BLIT_FS = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uTex;
out vec4 o;
void main() { o = vec4(texture(uTex, vUv).rgb, 1.0); }
`;

/** Lit meshes (table, plate, wood): position, normal and one extra channel. */
export const MESH_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in vec2 aExtra;
uniform mat4 uViewProj;
uniform mat4 uModel;
out vec3 vWorld;
out vec3 vNormal;
out vec2 vExtra;
out vec3 vLocal;
void main() {
  vec4 w = uModel * vec4(aPos, 1.0);
  vWorld = w.xyz;
  vLocal = aPos;
  vNormal = mat3(uModel) * aNormal;
  vExtra = aExtra;
  gl_Position = uViewProj * w;
}
`;

export const TABLE_FS = /* glsl */ `#version 300 es
${COMMON}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vExtra;
in vec3 vLocal;
out vec4 o;
void main() {
  // Oak boards running left to right.
  vec2 p = vWorld.xz;
  float board = floor(p.y * 9.0 + 0.5);
  float g = fbm(vec2(p.x * 14.0 + board * 7.0, p.y * 180.0 + board * 3.0));
  float ring = 0.5 + 0.5 * sin(p.y * 900.0 + g * 9.0 + board * 2.0);
  vec3 wood = mix(vec3(0.42, 0.25, 0.13), vec3(0.62, 0.42, 0.24), g * 0.8 + ring * 0.25);
  // Dark seams between boards.
  wood *= 1.0 - 0.5 * smoothstep(0.0012, 0.0, abs(fract(p.y * 9.0 + 0.5) - 0.5) / 9.0 - 0.0);
  vec3 v = normalize(uEye - vWorld);
  vec3 n = vec3(0.0, 1.0, 0.0);
  vec3 c = toLin(wood) * (0.35 + 0.75 * max(dot(n, uLight), 0.0));
  c += env(reflect(-v, n)) * (0.03 + 0.2 * pow(1.0 - max(dot(n, v), 0.0), 5.0));
  // Fall off into the dark away from the plate.
  c *= mix(0.35, 1.0, smoothstep(0.34, 0.08, length(vWorld.xz - vec2(0.0, -0.02))));
  o = vec4(toOut(c), 1.0);
}
`;

export const PLATE_FS = /* glsl */ `#version 300 es
${COMMON}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vExtra;
in vec3 vLocal;
out vec4 o;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  vec3 base = vec3(0.86, 0.87, 0.85);
  float rimBand = smoothstep(0.086, 0.09, length(vLocal.xz)) * smoothstep(0.1, 0.097, length(vLocal.xz));
  base = mix(base, vec3(0.34, 0.5, 0.62), rimBand * 0.8);
  vec3 c = base * (0.42 + 0.62 * max(dot(n, uLight), 0.0));
  float f = 0.05 + 0.95 * pow(1.0 - max(dot(n, v), 0.0), 5.0);
  c += env(reflect(-v, n)) * f * 0.9;
  o = vec4(toOut(c), 1.0);
}
`;

export const WOOD_FS = /* glsl */ `#version 300 es
${COMMON}
in vec3 vWorld;
in vec3 vNormal;
in vec2 vExtra;
in vec3 vLocal;
out vec4 o;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  // Beech: grain runs along the axis (local x); grooves (vExtra.x) sit in shadow; honey stain (vExtra.y).
  float g = fbm(vec2(vLocal.x * 60.0, atan(vLocal.z, vLocal.y) * 3.0));
  vec3 wood = mix(vec3(0.72, 0.52, 0.3), vec3(0.86, 0.68, 0.44), g);
  wood = mix(wood, vec3(0.62, 0.36, 0.12), vExtra.y * 0.6);
  vec3 c = toLin(wood) * (0.42 + 0.75 * max(dot(n, uLight) * 0.7 + 0.3, 0.0)) * (1.0 - 0.5 * vExtra.x);
  c += env(reflect(-v, n)) * 0.04;
  o = vec4(toOut(c), 1.0);
}
`;

/** The toast/pancake/plate height field with the honey film on it. */
export const SURF_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aUv;
uniform mat4 uViewProj;
uniform sampler2D uBase;   // r: bare height (mm), g: signed distance to the bread edge (mm)
uniform sampler2D uHoney;  // r: honey depth (mm), g: soak
uniform float uHalf;
uniform vec2 uOffset;
uniform float uTexel;
out vec2 vUv;
out vec3 vWorld;
out float vFar;
out float vSdf;
void main() {
  vec2 local = (aUv * 2.0 - 1.0) * uHalf;
  vec4 base = texture(uBase, aUv);
  vFar = base.g > 2.9 * 2000.0 * uHalf * uTexel ? 1.0 : 0.0;
  float y = (base.r + texture(uHoney, aUv).r) * 0.001;
  // Vertices either side of the bread's outline slide onto it, so the crust wall is vertical and
  // clean instead of stair-stepped by the grid.
  float cellMm = 2000.0 * uHalf * uTexel;
  vSdf = base.g;
  if (base.g > -0.9 * cellMm && base.g < 2.9 * cellMm) {
    vSdf = -0.01;
    vec2 g = vec2(texture(uBase, aUv + vec2(uTexel, 0)).g - texture(uBase, aUv - vec2(uTexel, 0)).g,
                  texture(uBase, aUv + vec2(0, uTexel)).g - texture(uBase, aUv - vec2(0, uTexel)).g);
    if (length(g) > 1e-4) local -= normalize(g) * base.g * 0.001;
  }
  vUv = aUv;
  vWorld = vec3(local.x + uOffset.x, y, local.y + uOffset.y);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}
`;

export const SURF_FS = /* glsl */ `#version 300 es
${COMMON}
uniform sampler2D uBase;
uniform sampler2D uHoney;
uniform float uHalf;
uniform vec2 uOffset;
uniform float uTexel;
uniform float uPancake;
uniform vec3 uAbsorb;
uniform vec3 uScatter;
uniform float uCloud;
in vec2 vUv;
in vec3 vWorld;
in float vFar;
in float vSdf;
out vec4 o;

vec3 breadAlbedo(vec2 p, float sdf, float pore) {
  if (uPancake > 0.5) {
    float r = length(p);
    vec3 c = mix(vec3(0.66, 0.38, 0.14), vec3(0.8, 0.54, 0.24), smoothstep(0.0, 0.05, r));
    c = mix(c, vec3(0.93, 0.78, 0.5), smoothstep(-6.0, -1.5, sdf));
    c *= 0.86 + 0.28 * fbm(p * 160.0);
    c = mix(c, vec3(0.5, 0.27, 0.1), smoothstep(0.62, 0.8, fbm(p * 420.0 + 3.0)) * 0.55);
    return c;
  }
  // Toasted crumb: paler in the middle, deeper toward the crust, in blotches, with fine grain.
  float r = length(p / vec2(0.048, 0.046));
  vec3 crumb = mix(vec3(0.95, 0.8, 0.52), vec3(0.86, 0.6, 0.3), smoothstep(0.15, 0.85, r + (fbm(p * 45.0) - 0.5) * 0.7));
  crumb = mix(crumb, vec3(0.66, 0.4, 0.17), smoothstep(0.58, 0.82, fbm(p * 22.0 + 3.0)) * 0.55);
  crumb *= 0.9 + 0.2 * fbm(p * 420.0);
  crumb *= 1.0 - pore;
  vec3 crust = mix(vec3(0.44, 0.23, 0.09), vec3(0.6, 0.35, 0.14), fbm(p * 300.0));
  return mix(crumb, crust, smoothstep(-4.5, -3.0, sdf));
}

float heightAt(vec2 uv) { return (texture(uBase, uv).r + texture(uHoney, uv).r) * 0.001; }
float baseAt(vec2 uv) { return texture(uBase, uv).r * 0.001; }

void main() {
  vec2 local = vWorld.xz - uOffset;
  vec4 base = texture(uBase, vUv);
  vec4 hon = texture(uHoney, vUv);
  // The outline distance comes from the vertices: the wall between snapped vertices is all bread.
  float sdf = vSdf;
  float hmm = hon.r;
  float e = uTexel, dx = 2.0 * uHalf * e;
  vec3 n = normalize(vec3(heightAt(vUv - vec2(e, 0)) - heightAt(vUv + vec2(e, 0)), 2.0 * dx, heightAt(vUv - vec2(0, e)) - heightAt(vUv + vec2(0, e))));
  vec3 nb = normalize(vec3(baseAt(vUv - vec2(e, 0)) - baseAt(vUv + vec2(e, 0)), 2.0 * dx, baseAt(vUv - vec2(0, e)) - baseAt(vUv + vec2(0, e))));
  vec3 v = normalize(uEye - vWorld);
  float ndl = max(dot(nb, uLight), 0.0);
  // Bare plate beyond the bread: the plate mesh underneath shows instead.
  if (vFar > 0.999 && hmm < 0.003) discard;
  // The plate is flat (the bread's wall next to it must not tilt its normal).
  if (sdf > 0.0) {
    nb = vec3(0.0, 1.0, 0.0);
    if (hmm < 0.003) n = nb;
  }
  vec3 bare;
  if (sdf > 0.0) {
    // Plate glaze.
    vec3 c = vec3(0.86, 0.87, 0.85) * (0.42 + 0.62 * ndl);
    c += env(reflect(-v, nb)) * (0.05 + 0.95 * pow(1.0 - max(dot(nb, v), 0.0), 5.0)) * 0.9;
    bare = c;
  } else {
    float crown = uPancake > 0.5 ? 1.0 * (1.0 - dot(local, local) / 0.0031) : 0.8 * (1.0 - dot(local, local) / 0.0025);
    float pore = uPancake > 0.5 ? 0.0 : clamp((crown - base.r) * 0.9, 0.0, 0.42) * smoothstep(-2.5, -4.0, sdf);
    vec3 alb = toLin(breadAlbedo(local, sdf, pore));
    // Soaked crumb goes darker and richer.
    alb = mix(alb, alb * vec3(0.6, 0.47, 0.3), hon.g * 0.75);
    bare = alb * (0.32 + 0.85 * ndl);
    bare += env(reflect(-v, nb)) * 0.02;
  }
  if (hmm < 0.003) {
    o = vec4(toOut(bare), 1.0);
    return;
  }
  // The honey film: bread seen through it (displaced by refraction), tinted by the path length
  // down to the bread and back out; cloudy liquids turn opaque with depth.
  float cv = max(dot(n, v), 0.08);
  float path = hmm * (1.0 / cv + 1.0 / max(dot(n, uLight), 0.25));
  vec3 T = exp(-uAbsorb * path);
  vec2 off = -n.xz * hmm * 0.0006;
  vec3 under = bare;
  if (sdf <= 0.0) {
    vec3 alb = toLin(breadAlbedo(local + off, sdf, 0.0));
    alb = mix(alb, alb * vec3(0.6, 0.47, 0.3), hon.g * 0.75);
    under = alb * (0.32 + 0.85 * ndl);
  }
  // The meniscus at a film's edge bends light away: a thin darker rim outlines every trail.
  float rim = smoothstep(0.08, 0.5, length(n.xz)) * smoothstep(0.6, 0.05, hmm);
  under *= 1.0 - 0.35 * rim;
  vec3 body = under * T + uScatter * (1.0 - T) * (0.16 + 0.3 * max(dot(n, uLight), 0.0)) * (1.0 - uCloud);
  float cloud = uCloud * (1.0 - exp(-hmm * 3.0));
  vec3 diff = uScatter * (0.3 + 0.85 * max(dot(n, uLight), 0.0));
  vec3 c = mix(body, diff, cloud);
  float f = 0.04 + 0.96 * pow(1.0 - cv, 5.0);
  vec3 r = reflect(-v, n);
  vec3 spec = env(r) * f * mix(1.0, 0.6, uCloud) + vec3(1.6, 1.45, 1.2) * pow(max(dot(r, uLight), 0.0), 160.0) * 1.3;
  float cover = smoothstep(0.003, 0.03, hmm);
  c = mix(bare, c, cover) + spec * cover;
  o = vec4(toOut(c), 1.0);
}
`;

/** Thread ribbons: camera-facing strips shaded as round tubes. */
export const THREAD_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aSide;
layout(location = 2) in vec2 aAcross; // x: -1..1 across the strip, y: true radius (m)
layout(location = 3) in float aCover;
uniform mat4 uViewProj;
uniform vec2 uRes;
out vec3 vWorld;
out vec3 vSide;
out float vAcross;
out float vRadius;
out float vCover;
out vec2 vSideScreen;
out float vRadiusPx;
void main() {
  vWorld = aPos;
  vSide = aSide;
  vAcross = aAcross.x;
  vRadius = aAcross.y;
  vCover = aCover;
  vec4 c = uViewProj * vec4(aPos, 1.0);
  vec4 s = uViewProj * vec4(aPos + aSide * aAcross.y, 1.0);
  vec2 d = (s.xy / s.w - c.xy / c.w) * 0.5 * uRes;
  vRadiusPx = length(d);
  vSideScreen = vRadiusPx > 1e-5 ? d / vRadiusPx : vec2(1.0, 0.0);
  gl_Position = c;
}
`;

export const THREAD_FS = /* glsl */ `#version 300 es
${COMMON}
${HONEY}
in vec3 vWorld;
in vec3 vSide;
in float vAcross;
in float vRadius;
in float vCover;
in vec2 vSideScreen;
in float vRadiusPx;
out vec4 o;
void main() {
  vec3 v = normalize(uEye - vWorld);
  float u = clamp(vAcross, -1.0, 1.0);
  float w = sqrt(max(0.0, 1.0 - u * u));
  vec3 side = normalize(vSide - v * dot(vSide, v));
  vec3 n = normalize(side * u + v * w);
  float path = 2000.0 * vRadius * w;
  // A round thread is a lens: what's behind it shows through flipped and squeezed.
  vec2 px = gl_FragCoord.xy - vSideScreen * u * vRadiusPx * 1.6 * vCover;
  vec3 bg = toLin(texture(uScene, px / uRes).rgb);
  vec3 c = honeyShade(n, v, path, bg);
  // Threads thinner than a pixel are drawn a pixel wide and faded to their true coverage.
  vec3 behind = toLin(texture(uScene, gl_FragCoord.xy / uRes).rgb);
  c = mix(behind, c, clamp(vCover, 0.0, 1.0) * smoothstep(1.0, 0.8, abs(u)));
  o = vec4(toOut(c), 1.0);
}
`;

/** The honey coat on the dipper: a translucent shell over the wood. */
export const COAT_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec3 aNormal;
layout(location = 2) in float aThick;
uniform mat4 uViewProj;
out vec3 vWorld;
out vec3 vNormal;
out float vThick;
void main() {
  vWorld = aPos;
  vNormal = aNormal;
  vThick = aThick;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const COAT_FS = /* glsl */ `#version 300 es
${COMMON}
${HONEY}
uniform mat4 uViewProj;
in vec3 vWorld;
in vec3 vNormal;
in float vThick;
out vec4 o;
void main() {
  vec3 n = normalize(vNormal);
  vec3 v = normalize(uEye - vWorld);
  float cv = max(dot(n, v), 0.15);
  // Light crosses the coat, bounces off the wood and comes back out: roughly twice the depth.
  float path = 1000.0 * vThick * (1.0 + 0.6 / cv) + 0.4;
  vec4 cs = uViewProj * vec4(vWorld - n * vThick * 2.0, 1.0);
  vec2 uv = cs.xy / cs.w * 0.5 + 0.5;
  vec3 bg = toLin(texture(uScene, uv).rgb);
  vec3 c = honeyShade(n, v, path, bg);
  // A coat over wood also glows with the light it scatters back (thin threads have no such backing).
  c += uScatter * (1.0 - exp(-uAbsorb * path)) * 0.22 * (1.0 - uCloud);
  float a = smoothstep(0.00002, 0.00012, vThick);
  vec3 behind = toLin(texture(uScene, gl_FragCoord.xy / uRes).rgb);
  o = vec4(toOut(mix(behind, c, a)), 1.0);
}
`;

/** Shadows laid on the surface: multiply-ish blend (dst * (rgb + a)), so a thread can also focus light. */
export const SHADOW_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aShade; // rgb: tint, a: strength
uniform mat4 uViewProj;
out vec4 vShade;
void main() {
  vShade = aShade;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const SHADOW_FS = /* glsl */ `#version 300 es
precision highp float;
in vec4 vShade;
out vec4 o;
void main() {
  // factor = rgb + a: 1 - k + k * tint.
  o = vec4(vShade.rgb * vShade.a, 1.0 - vShade.a);
}
`;

/** Soft round blob (dipper shadow): aShade.a scaled by a radial falloff in aPos-space uv. */
export const BLOB_VS = /* glsl */ `#version 300 es
layout(location = 0) in vec3 aPos;
layout(location = 1) in vec4 aShade; // xy: -1..1 across the blob, z: strength
uniform mat4 uViewProj;
out vec3 vB;
void main() {
  vB = aShade.xyz;
  gl_Position = uViewProj * vec4(aPos, 1.0);
}
`;

export const BLOB_FS = /* glsl */ `#version 300 es
precision highp float;
in vec3 vB;
out vec4 o;
void main() {
  float r = length(vB.xy);
  float k = vB.z * smoothstep(1.0, 0.2, r);
  o = vec4(vec3(0.35, 0.25, 0.18) * k, 1.0 - k);
}
`;
