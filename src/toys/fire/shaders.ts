// Campfire passes on top of Ink Swirl's stable-fluids solver: heat sources, buoyancy, and the
// night-scene composite (sky, ground lit by the fire, wood, smoke, blackbody flame, embers).
// The oxygen field (CPU, see burn.ts) arrives as an R8 texture: 0.5 = fresh air, 1 = blown draught.

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
uniform vec4 jar;   // x, rim y (uv), shown (0/1), seal
uniform vec2 jarR;  // half-width, height (screen-height units)
/** Signed distance to the bell jar's glass (negative inside); far away below the rim or with no jar. */
float jarDist(vec2 uv, float aspect) {
  vec2 q = vec2((uv.x - jar.x) * aspect, uv.y - jar.y) / jarR;
  if (jar.z < 0.5 || q.y < 0.0) return 1e3;
  float d = max(length(q), 1e-4);
  return (d - 1.0) / (length(q / jarR) / d);
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
uniform float aspect;
uniform sampler2D uOxy;
void main() {
  vec3 h = texture(uHeat, vUv).rgb;
  vec4 b = texture(uBurn, vUv);
  float o = texture(uOxy, vUv).r * 2.0;
  float air = smoothstep(0.1, 0.8, o), rich = max(0.0, o - 1.0);
  // Flicker: burning cells pulse in time and space, so flames lick instead of glowing flat.
  float flick = 0.55 + 0.9 * noise(vUv * vec2(40.0, 30.0) + vec2(0.0, -time * 6.0));
  float burning = b.g * step(0.02, b.r);
  // Fed flames pour out heat (and roar when blown); starved ones barely lift and smoke instead.
  h.r += burning * heatRate * flick * (0.2 + 0.8 * air) * (1.0 + rich * 1.8) * dt;
  float smoulder = step(0.04, b.g) * step(0.02, b.r) * (1.0 - air); // choked wood still fumes
  h.g += (burning * (0.3 + 1.3 * (1.0 - air)) + smoulder * 0.5) * dt * (1.0 - b.a);
  h.r = min(h.r, 1.6);
  h.r /= 1.0 + cooling * dt;
  h.g /= 1.0 + 0.35 * dt;
  h.b /= 1.0 + 0.9 * dt;
  if (abs(jarDist(vUv, aspect)) < 0.01) h = vec3(0.0); // nothing passes through the glass
  fragColor = vec4(h, 1.0);
}`;

/** Glass is a wall for the fluid too: zero the velocity along it after projection. */
export const jarVelFrag = head + /* glsl */ `
uniform sampler2D uVelocity;
uniform float aspect;
void main() {
  vec2 v = texture(uVelocity, vUv).xy;
  if (abs(jarDist(vUv, aspect)) < 0.022) v = vec2(0.0);
  fragColor = vec4(v, 0.0, 1.0);
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
uniform sampler2D uOxy;
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
  float o = texture(uOxy, uv).r * 2.0;
  float air = smoothstep(0.1, 0.85, o), rich = max(0.0, o - 1.0);
  // Starved flames burn cooler (deep orange) and dimmer; a blown-on fire runs hotter and whiter.
  float t = h.r * (0.72 + 0.28 * air + 0.25 * rich);
  vec3 e = blackbody(t) * smoothstep(0.08, 0.6, t) * (0.55 + 0.8 * t) * (0.55 + 0.45 * air);
  vec4 b = texture(uBurn, uv);
  // A lean blue lick right above the wood where air is short: the fire gasping.
  float base = texture(uBurn, uv - vec2(0.0, burnTexel.y * 3.0)).g * (1.0 - step(0.3, b.r));
  e += vec3(0.12, 0.28, 1.0) * base * smoothstep(0.6, 0.25, o) * smoothstep(0.02, 0.2, h.r) * 0.7;
  if (b.r > 0.02 || b.b > 0.05) {
    float cracks = noise(uv * vec2(90.0, 60.0) + vec2(time * 0.3, 0.0));
    cracks = smoothstep(0.35, 0.9, cracks) * 0.8 + 0.2;
    float pulse = 0.75 + 0.25 * sin(time * (3.0 - 2.0 * air) + uv.x * 40.0); // embers breathe slowly
    float glowing = max(b.g, smoothstep(0.05, 0.14, b.g) * 0.35); // smoulder still glows red
    e += vec3(1.0, 0.28, 0.04) * glowing * cracks * pulse * 0.55 * smoothstep(0.05, 0.4, b.r + b.b * 0.3);
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

  // The bell jar: faint tinted glass, bright rims where it curves away, a highlight and a knob.
  float jd = jarDist(uv, aspect);
  if (jd < 0.02) {
    float edge = smoothstep(0.012, 0.0, abs(jd)) * 0.5 + smoothstep(0.005, 0.0, abs(jd + 0.003)) * 0.6;
    vec2 q = vec2((uv.x - jar.x) * aspect, uv.y - jar.y) / jarR;
    float streak = smoothstep(0.1, 0.0, abs(q.x + 0.55 - q.y * 0.25)) * smoothstep(0.85, 0.2, q.y) * step(jd, 0.0);
    vec3 glass = vec3(0.55, 0.7, 0.8);
    if (jd < 0.0) col = col * 0.9 + glass * 0.012 + vec3(0.9, 0.42, 0.16) * glow * 0.04;
    col += glass * (edge * (0.25 + glow * 0.5) + streak * 0.08);
  }
  if (jar.z > 0.5) {
    vec2 k = vec2((uv.x - jar.x) * aspect, uv.y - jar.y - jarR.y - 0.012);
    col += vec3(0.55, 0.7, 0.8) * smoothstep(0.016, 0.01, length(k * vec2(1.0, 1.6))) * (0.18 + glow * 0.3);
  }
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
