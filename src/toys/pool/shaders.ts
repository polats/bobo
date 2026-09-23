// Height-field water (after Evan Wallace's WebGL Water): wave-equation update, drops,
// mesh-projected caustics and a top-down refractive composite with floating ducks.

export const quadVert = /* glsl */ `#version 300 es
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
`;

/** Water texel: r = height, g = vertical velocity, ba = surface normal xz. */
export const updateFrag = head + /* glsl */ `
uniform sampler2D uWater;
uniform vec2 delta;
uniform float waveSpeed; // 0..1, fraction of the stable limit
uniform float damping;
uniform float breeze;
uniform float time;
uniform vec2 world;
void main() {
  vec4 info = texture(uWater, vUv);
  // Breeze: a few slow travelling sinusoids at irrational angles keep a live caustic web.
  vec2 x = vUv * world;
  float f = sin(dot(x, vec2(41.3, 17.9)) - time * 3.1) + sin(dot(x, vec2(-23.7, 52.1)) - time * 3.7)
          + sin(dot(x, vec2(57.1, -31.3)) - time * 4.3) + sin(dot(x, vec2(-15.9, -66.7)) - time * 4.9)
          + 0.6 * sin(dot(x, vec2(83.3, 29.1)) - time * 6.1) + 0.6 * sin(dot(x, vec2(-47.1, 91.7)) - time * 6.7);
  info.g += breeze * 0.00004 * f;
  vec2 dx = vec2(delta.x, 0.0);
  vec2 dy = vec2(0.0, delta.y);
  float average = (
    texture(uWater, vUv - dx).r + texture(uWater, vUv + dx).r +
    texture(uWater, vUv - dy).r + texture(uWater, vUv + dy).r) * 0.25;
  info.g += (average - info.r) * 2.0 * waveSpeed;
  info.g *= damping;
  info.r += info.g;
  // Gentle pull back to rest so accumulated drops never drift the mean level.
  info.r *= 0.9995;
  fragColor = info;
}`;

export const normalFrag = head + /* glsl */ `
uniform sampler2D uWater;
uniform vec2 delta;
uniform vec2 world; // world size of the pool in the same units as height
uniform float heightScale;
void main() {
  vec4 info = texture(uWater, vUv);
  float hx = texture(uWater, vUv + vec2(delta.x, 0.0)).r - texture(uWater, vUv - vec2(delta.x, 0.0)).r;
  float hy = texture(uWater, vUv + vec2(0.0, delta.y)).r - texture(uWater, vUv - vec2(0.0, delta.y)).r;
  vec3 n = normalize(vec3(-hx * heightScale / (2.0 * delta.x * world.x), 1.0, -hy * heightScale / (2.0 * delta.y * world.y)));
  info.ba = n.xz;
  fragColor = info;
}`;

export const dropFrag = head + /* glsl */ `
uniform sampler2D uWater;
uniform vec2 center;
uniform float radius;
uniform float strength;
uniform float aspect;
const float PI = 3.141592653589793;
void main() {
  vec4 info = texture(uWater, vUv);
  vec2 d = center - vUv;
  d.x *= aspect;
  float drop = max(0.0, 1.0 - length(d) / radius);
  drop = 0.5 - cos(drop * PI) * 0.5;
  info.r += drop * strength;
  fragColor = info;
}`;

// Shared helpers for ray refraction onto the pool floor.
const refractLib = /* glsl */ `
const float IOR_AIR = 1.0;
const float IOR_WATER = 1.333;
vec3 surfaceNormal(vec4 info) {
  return vec3(info.b, sqrt(max(0.0, 1.0 - dot(info.ba, info.ba))), info.a);
}
// Intersect a ray from p (world, y up) with the floor plane y = -depth; returns floor xz.
vec2 hitFloor(vec3 p, vec3 r, float depth) {
  float t = (-depth - p.y) / r.y;
  return p.xz + r.xz * t;
}
`;

/** One vertex per water texel; each is refracted onto the floor and the triangle area change is its brightness. */
export const causticsVert = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec2 aGrid;
uniform sampler2D uWater;
uniform vec3 light;   // direction of travel of sunlight (pointing down)
uniform vec2 world;
uniform float depth;
uniform float heightScale;
out vec2 vOld;
out vec2 vNew;
${refractLib}
void main() {
  vec4 info = texture(uWater, aGrid);
  vec3 n = surfaceNormal(info);
  vec3 p = vec3(aGrid.x * world.x, info.r * heightScale, aGrid.y * world.y);
  vec3 flatRay = refract(light, vec3(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);
  vec3 ray = refract(light, n, IOR_AIR / IOR_WATER);
  vOld = hitFloor(vec3(p.x, 0.0, p.z), flatRay, depth);
  vNew = hitFloor(p, ray, depth);
  // Shift so the flat-water projection lands exactly on its own texel.
  vec2 shift = vOld - p.xz;
  vec2 uv = (vNew - shift) / world;
  gl_Position = vec4(uv * 2.0 - 1.0, 0.0, 1.0);
}`;

export const causticsFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vOld;
in vec2 vNew;
out vec4 fragColor;
void main() {
  float oldArea = length(dFdx(vOld)) * length(dFdy(vOld));
  float newArea = length(dFdx(vNew)) * length(dFdy(vNew));
  float ratio = oldArea / max(newArea, 1e-9);
  fragColor = vec4(min(ratio, 12.0), 0.0, 0.0, 1.0);
}`;

export const blurFrag = head + /* glsl */ `
uniform sampler2D uTexture;
uniform vec2 dir;
void main() {
  vec4 c = texture(uTexture, vUv) * 0.4;
  c += (texture(uTexture, vUv + dir) + texture(uTexture, vUv - dir)) * 0.24;
  c += (texture(uTexture, vUv + 2.0 * dir) + texture(uTexture, vUv - 2.0 * dir)) * 0.06;
  fragColor = c;
}`;

export const MAX_DUCKS = 12;

export const compositeFrag = head + /* glsl */ `
uniform sampler2D uWater;
uniform sampler2D uCaustics;
uniform vec2 world;
uniform float depth;
uniform float heightScale;
uniform vec3 light;
uniform float causticStrength;
uniform float theme;      // 0 = day pool, 1 = night pool
uniform float time;
uniform vec2 texel;
uniform int duckCount;
uniform vec4 ducks[${MAX_DUCKS}]; // xy = uv, z = radius (uv of short side), w = unused
${refractLib}

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

vec3 floorColor(vec2 fp) {
  // Square tiles with grout, slight per-tile tint and a darker painted lane stripe.
  float tile = 0.075;
  vec2 cell = floor(fp / tile);
  vec2 f = fract(fp / tile);
  float grout = smoothstep(0.0, 0.06, f.x) * smoothstep(0.0, 0.06, f.y) *
                smoothstep(1.0, 0.94, f.x) * smoothstep(1.0, 0.94, f.y);
  float v = hash(cell) * 0.08;
  vec3 day = vec3(0.78, 0.93, 0.97) - v;
  vec3 night = vec3(0.30, 0.42, 0.55) - v;
  vec3 base = mix(day, night, theme);
  float lane = smoothstep(0.02, 0.0, abs(fp.x - world.x * 0.5) - tile * 0.5);
  base = mix(base, mix(vec3(0.12, 0.28, 0.55), vec3(0.08, 0.14, 0.3), theme), lane * 0.85);
  return base * mix(0.55, 1.0, grout);
}

void main() {
  vec4 info = texture(uWater, vUv);
  vec3 n = surfaceNormal(info);
  vec3 p = vec3(vUv.x * world.x, info.r * heightScale, vUv.y * world.y);
  vec3 view = vec3(0.0, -1.0, 0.0);

  // Refract the eye ray through the surface and read the lit floor where it lands.
  vec3 ray = refract(view, n, IOR_AIR / IOR_WATER);
  vec2 fp = hitFloor(p, ray, depth);
  // Caustics were rasterised shifted by the flat-water light offset; undo that here.
  vec3 flatRay = refract(light, vec3(0.0, 1.0, 0.0), IOR_AIR / IOR_WATER);
  vec2 fuv = (fp - flatRay.xz * (depth / -flatRay.y)) / world;
  vec3 floorCol = floorColor(fp);
  // Outside the lit footprint the pool wall shades the floor.
  vec2 inside = step(vec2(0.0), fuv) * step(fuv, vec2(1.0));
  vec2 soft = smoothstep(vec2(0.0), vec2(0.02), fuv) * smoothstep(vec2(1.0), vec2(0.98), fuv);
  float caustic = texture(uCaustics, fuv).r * inside.x * inside.y * soft.x * soft.y;
  float ambient = mix(0.32, 0.22, theme);
  vec3 lit = floorCol * (ambient + causticStrength * caustic * mix(vec3(1.0, 0.98, 0.9), vec3(0.6, 0.8, 1.0), theme));

  // Duck shadows: soft blobs on the floor, offset along the sunlight.
  vec2 shadowShift = light.xz / max(-light.y, 0.2) * depth;
  float aspect = world.x / world.y;
  for (int i = 0; i < ${MAX_DUCKS}; i++) {
    if (i >= duckCount) break;
    vec2 d = (fp - (ducks[i].xy * world + shadowShift));
    float r = ducks[i].z * min(world.x, world.y) * 1.1;
    lit *= 1.0 - 0.45 * smoothstep(r, r * 0.3, length(d * vec2(1.0, 1.25)));
  }

  // Beer-Lambert absorption along the refracted path.
  float path = (depth + p.y) / max(-ray.y, 0.2);
  vec3 absorb = mix(vec3(0.9, 0.35, 0.22), vec3(1.2, 0.6, 0.35), theme);
  vec3 col = lit * exp(-absorb * path * 1.6);

  // Surface: Fresnel sky reflection and a sharp sun glint.
  float cosT = max(dot(n, vec3(0.0, 1.0, 0.0)), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  vec3 sky = mix(vec3(0.75, 0.88, 1.0), vec3(0.05, 0.08, 0.18), theme);
  col = mix(col, sky, clamp(fresnel * 6.0, 0.0, 0.6));
  vec3 refl = reflect(view, n);
  float glint = pow(max(dot(refl, -light), 0.0), 2500.0);
  float slope = length(n.xz);
  col += glint * mix(vec3(1.6, 1.55, 1.4), vec3(1.0, 1.2, 1.6), theme) * smoothstep(0.004, 0.03, slope);

  // Night mode: warm underwater lights along the walls.
  if (theme > 0.5) {
    vec2 w = vUv;
    float edge = min(min(w.x, 1.0 - w.x) * aspect, min(w.y, 1.0 - w.y));
    float spots = 0.5 + 0.5 * cos(w.y * 18.0);
    col += vec3(0.25, 0.55, 0.7) * exp(-edge * 9.0) * spots * 0.6;
  }

  // Tonemap, vignette, dither.
  col = col / (1.0 + col * 0.35);
  vec2 q = vUv - 0.5;
  col *= 1.0 - dot(q, q) * 0.55;
  col = pow(col, vec3(1.0 / 1.15));
  col += (hash(gl_FragCoord.xy + time) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;

/** Instanced rubber ducks: SDF sprite that bobs and tilts with the water under it. */
export const duckVert = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aDuck;  // xy = uv position, z = heading, w = radius (uv of short side)
layout(location = 2) in float aSquash;
uniform sampler2D uWater;
uniform vec2 world;
uniform float heightScale;
out vec2 vLocal;
out vec2 vTilt;
out float vLift;
void main() {
  vec4 info = texture(uWater, aDuck.xy);
  float lift = info.r * heightScale;
  float c = cos(aDuck.z), s = sin(aDuck.z);
  float scale = aDuck.w * (1.0 + lift * 4.0);
  vec2 local = aCorner * 1.35;
  vec2 squash = vec2(1.0 + aSquash * 0.35, 1.0 - aSquash * 0.35);
  vec2 rot = vec2(c * local.x - s * local.y, s * local.x + c * local.y) * squash;
  float shortSide = min(world.x, world.y);
  vec2 offset = rot * scale * shortSide / world;
  vLocal = local;
  vTilt = vec2(c * info.b + s * info.a, -s * info.b + c * info.a);
  vLift = lift;
  gl_Position = vec4((aDuck.xy + offset) * 2.0 - 1.0, 0.0, 1.0);
}`;

export const duckFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vTilt;
in float vLift;
out vec4 fragColor;

float sdEllipse(vec2 p, vec2 r) {
  float k = length(p / r);
  return (k - 1.0) * min(r.x, r.y);
}
float smin(float a, float b, float k) {
  float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
  return mix(b, a, h) - k * h * (1.0 - h);
}

vec3 shade(vec3 base, vec2 domeP, vec2 tilt) {
  float z = sqrt(max(0.0, 1.0 - dot(domeP, domeP)));
  vec3 n = normalize(vec3(domeP * 0.9 + tilt * 3.0, z + 0.15));
  vec3 L = normalize(vec3(-0.45, 0.55, 0.7));
  float diff = clamp(dot(n, L), 0.0, 1.0);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 36.0);
  return base * (0.5 + 0.65 * diff) + spec * 0.85;
}

void main() {
  vec2 p = vLocal; // heading is +x, viewed from above
  vec2 bodyC = vec2(-0.14, 0.0);
  float body = smin(sdEllipse(p - bodyC, vec2(0.68, 0.5)), sdEllipse(p - vec2(-0.78, 0.0), vec2(0.2, 0.12)), 0.12);
  vec2 headC = vec2(0.46, 0.0);
  float headD = length(p - headC) - 0.29;
  float beak = sdEllipse(p - vec2(0.8, 0.0), vec2(0.17, 0.11));
  float shape = min(min(body, headD), beak);
  float aa = fwidth(shape) * 1.2;
  float alpha = 1.0 - smoothstep(-aa, aa, shape);
  if (alpha <= 0.001) discard;

  vec3 yellow = vec3(1.0, 0.8, 0.1);
  vec3 col;
  if (headD < 0.0) {
    col = shade(yellow * 1.05, (p - headC) / 0.29, vTilt);
    // Eyes with a tiny glint.
    vec2 e = vec2(0.56, 0.14 * sign(p.y + 1e-4));
    float eye = length(p - e) - 0.055;
    col = mix(col, vec3(0.04), 1.0 - smoothstep(-0.012, 0.012, eye));
    col = mix(col, vec3(1.0), 1.0 - smoothstep(-0.01, 0.01, length(p - e - vec2(0.018, 0.016)) - 0.016));
  } else if (beak < 0.0 && body > 0.0) {
    col = shade(vec3(1.0, 0.42, 0.06), (p - vec2(0.8, 0.0)) / vec2(0.17, 0.11), vTilt);
  } else {
    col = shade(yellow, (p - bodyC) / vec2(0.72, 0.54), vTilt);
    // Folded wings: a darker crease along each side.
    float wing = abs(sdEllipse(vec2(p.x + 0.2, abs(p.y) - 0.24), vec2(0.36, 0.14)));
    col *= mix(0.78, 1.0, smoothstep(0.0, 0.03, wing));
    // Shadow ring where the head sits on the body.
    col *= mix(0.7, 1.0, smoothstep(0.0, 0.07, headD));
  }
  // Soft outline so ducks pop against bright caustics.
  col *= mix(0.55, 1.0, smoothstep(0.0, 0.07, -shape));
  fragColor = vec4(col, alpha);
}`;
