// Campfire passes on top of Ink Swirl's stable-fluids solver: heat sources, buoyancy, and the
// night-scene composite (sky, ground lit by the fire, wood, smoke, blackbody flame, embers).

const head = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 fragColor;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
`;

/** heat texture: r = temperature, g = smoke, b = steam. */
export const sourceFrag = head + /* glsl */ `
uniform sampler2D uHeat;
uniform sampler2D uBurn;   // r fuel, g burning, b char, a wet
uniform float dt;
uniform float time;
uniform float heatRate;
uniform float cooling;
uniform float oxygen;
void main() {
  vec3 h = texture(uHeat, vUv).rgb;
  vec4 b = texture(uBurn, vUv);
  // Flicker: burning cells pulse in time and space, so flames lick instead of glowing flat.
  float flick = 0.55 + 0.9 * noise(vUv * vec2(40.0, 30.0) + vec2(0.0, -time * 6.0));
  float burning = b.g * step(0.02, b.r);
  h.r += burning * heatRate * flick * (1.0 + oxygen * 1.5) * dt;
  h.g += burning * (0.35 + 0.4 * (1.0 - oxygen)) * dt * (1.0 - b.a);
  h.r = min(h.r, 1.6);
  h.r /= 1.0 + cooling * dt;
  h.g /= 1.0 + 0.35 * dt;
  h.b /= 1.0 + 0.9 * dt;
  fragColor = vec4(h, 1.0);
}`;

export const buoyancyFrag = head + /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uHeat;
uniform float dt;
uniform float buoyancy;
uniform float wind;
void main() {
  vec2 v = texture(uVelocity, vUv).xy;
  vec3 h = texture(uHeat, vUv).rgb;
  v.y += (h.r * buoyancy - h.g * 6.0 + h.b * buoyancy * 0.5) * dt;
  v.x += wind * h.r * 40.0 * dt;
  fragColor = vec4(v, 0.0, 1.0);
}`;

const scene = /* glsl */ `
uniform sampler2D uHeat;
uniform sampler2D uBurn;
uniform vec2 burnTexel;
uniform float time;
uniform float groundY;
uniform float aspect;
uniform vec3 light;        // xy = fire centre (uv), z = intensity

vec3 blackbody(float t) {
  // Deep red -> orange -> yellow -> white as temperature rises.
  t = clamp(t, 0.0, 1.6);
  vec3 c = vec3(1.0, 0.22, 0.03) * smoothstep(0.0, 0.35, t);
  c = mix(c, vec3(1.0, 0.55, 0.1), smoothstep(0.3, 0.7, t));
  c = mix(c, vec3(1.0, 0.85, 0.45), smoothstep(0.65, 1.1, t));
  c = mix(c, vec3(1.0, 0.97, 0.9), smoothstep(1.05, 1.6, t));
  return c;
}

/** Emission only (flame + glowing wood), shared by the bloom source and the final composite. */
vec3 emission(vec2 uv) {
  vec3 h = texture(uHeat, uv).rgb;
  float t = h.r;
  vec3 e = blackbody(t) * smoothstep(0.08, 0.6, t) * (0.55 + 0.8 * t);
  vec4 b = texture(uBurn, uv);
  if (b.r > 0.02 || b.b > 0.05) {
    float cracks = noise(uv * vec2(90.0, 60.0) + vec2(time * 0.3, 0.0));
    cracks = smoothstep(0.35, 0.9, cracks) * 0.8 + 0.2;
    float pulse = 0.75 + 0.25 * sin(time * 3.0 + uv.x * 40.0);
    e += vec3(1.0, 0.28, 0.04) * b.g * cracks * pulse * 0.55 * smoothstep(0.05, 0.4, b.r + b.b * 0.3);
  }
  return e;
}
`;

export const emissionFrag = head + scene + /* glsl */ `
void main() { fragColor = vec4(emission(vUv), 1.0); }`;

export const displayFrag = head + scene + /* glsl */ `
uniform sampler2D uBloom;
uniform float bloomIntensity;

vec3 aces(vec3 x) { return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0); }

void main() {
  vec2 uv = vUv;
  float flick = 0.85 + 0.15 * noise(vec2(time * 7.0, 0.0)) + 0.08 * sin(time * 23.0);
  vec2 d = (uv - light.xy) * vec2(aspect, 1.0);
  float glow = light.z * flick * exp(-dot(d, d) * 16.0);

  // Night sky with stars, a treeline and a warm haze around the fire.
  vec3 col = mix(vec3(0.006, 0.007, 0.02), vec3(0.014, 0.012, 0.035), uv.y);
  vec2 sg = floor(uv * vec2(aspect, 1.0) * 520.0);
  float star = step(0.9985, hash(sg)) * smoothstep(groundY + 0.25, 1.0, uv.y) * (0.6 + 0.4 * sin(time * 2.0 + hash(sg) * 30.0));
  col += star * 0.8;
  float tree = groundY + 0.07 + 0.05 * noise(vec2(uv.x * aspect * 9.0, 0.0)) + 0.03 * noise(vec2(uv.x * aspect * 31.0, 1.0));
  if (uv.y < tree) col = vec3(0.002, 0.003, 0.005);
  col += vec3(1.0, 0.45, 0.15) * glow * 0.12;

  // Ground: dark earth with pebbles, lit orange by the flames.
  if (uv.y < groundY) {
    float g = noise(uv * vec2(aspect, 1.0) * 70.0) * 0.5 + noise(uv * vec2(aspect, 1.0) * 210.0) * 0.5;
    vec3 soil = vec3(0.018, 0.012, 0.009) * (0.7 + 0.6 * g);
    col = soil + vec3(0.9, 0.42, 0.16) * glow * (0.25 + 0.25 * g);
  }

  vec3 h = texture(uHeat, uv).rgb;
  // Smoke: dark and soft, underlit orange near the flames. Steam: pale.
  float smoke = clamp(h.g * 0.9, 0.0, 0.85);
  vec3 smokeCol = mix(vec3(0.025, 0.024, 0.026), vec3(0.45, 0.16, 0.05), clamp(h.r * 0.8 + glow * 0.3, 0.0, 1.0));
  col = mix(col, smokeCol, smoke);
  col = mix(col, vec3(0.75, 0.78, 0.82), clamp(h.b, 0.0, 0.7));

  // Wood: bark with grain, charring to black, ash where it's burnt through.
  vec4 b = texture(uBurn, uv);
  float wood = smoothstep(0.08, 0.5, b.r);
  if (wood > 0.0) {
    float grain = noise(uv * vec2(260.0, 30.0)) * 0.5 + noise(uv * vec2(40.0, 8.0)) * 0.5;
    vec3 bark = mix(vec3(0.045, 0.022, 0.01), vec3(0.11, 0.058, 0.026), grain);
    bark *= 0.55 + 0.45 * smoothstep(0.0, 0.8, b.r);          // thin edges read darker (round logs)
    bark = mix(bark, vec3(0.008, 0.006, 0.005), b.b);        // char
    bark = mix(bark, bark * 0.6 + vec3(0.02, 0.03, 0.05), b.a * 0.6); // damp
    bark += vec3(0.9, 0.42, 0.16) * glow * 0.12;
    col = mix(col, bark, wood);
  } else if (b.b > 0.2) {
    float ash = noise(uv * 300.0);
    col = mix(col, vec3(0.08, 0.075, 0.07) * (0.6 + 0.4 * ash), smoothstep(0.2, 0.9, b.b) * 0.6);
  }

  col += emission(uv);
  col += texture(uBloom, uv).rgb * bloomIntensity;
  col = aces(col * 1.05);
  col = pow(col, vec3(1.0 / 2.2));
  col += (hash(gl_FragCoord.xy + time) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;

export const emberVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aEmber; // x, y (uv), life, size
uniform float pixelRatio;
out float vLife;
void main() {
  vLife = aEmber.z;
  gl_Position = vec4(aEmber.xy * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = aEmber.w * pixelRatio * (2.0 + 2.5 * clamp(aEmber.z, 0.0, 1.0));
}`;

export const emberFrag = /* glsl */ `#version 300 es
precision highp float;
in float vLife;
out vec4 fragColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.0, dot(p, p));
  float t = clamp(vLife, 0.0, 1.0);
  vec3 c = mix(vec3(1.0, 0.18, 0.02), vec3(1.0, 0.85, 0.4), t);
  fragColor = vec4(c * a * (0.4 + t), 1.0);
}`;
