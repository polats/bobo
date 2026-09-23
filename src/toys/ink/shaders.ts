// GLSL ES 3.00 passes for 2D stable fluids (Stam 1999, after Pavel Dobryakov's WebGL fluid).

export const baseVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
uniform vec2 texelSize;
out vec2 vUv, vL, vR, vT, vB;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  vL = vUv - vec2(texelSize.x, 0.0);
  vR = vUv + vec2(texelSize.x, 0.0);
  vT = vUv + vec2(0.0, texelSize.y);
  vB = vUv - vec2(0.0, texelSize.y);
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

const head = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv, vL, vR, vT, vB;
out vec4 fragColor;
`;

export const clearFrag = head + /* glsl */ `
uniform sampler2D uTexture;
uniform float value;
void main() { fragColor = value * texture(uTexture, vUv); }`;

export const splatFrag = head + /* glsl */ `
uniform sampler2D uTarget;
uniform float aspectRatio;
uniform vec3 color;
uniform vec2 point;
uniform float radius;
void main() {
  vec2 p = vUv - point;
  p.x *= aspectRatio;
  vec3 splat = exp(-dot(p, p) / radius) * color;
  fragColor = vec4(texture(uTarget, vUv).xyz + splat, 1.0);
}`;

export const advectionFrag = head + /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uSource;
uniform vec2 velTexelSize;
uniform float dt;
uniform float dissipation;
void main() {
  vec2 coord = vUv - dt * texture(uVelocity, vUv).xy * velTexelSize;
  fragColor = texture(uSource, coord) / (1.0 + dissipation * dt);
}`;

export const divergenceFrag = head + /* glsl */ `
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).x;
  float R = texture(uVelocity, vR).x;
  float T = texture(uVelocity, vT).y;
  float B = texture(uVelocity, vB).y;
  vec2 C = texture(uVelocity, vUv).xy;
  // Reflect velocity at the walls so ink bounces off screen edges.
  if (vL.x < 0.0) L = -C.x;
  if (vR.x > 1.0) R = -C.x;
  if (vT.y > 1.0) T = -C.y;
  if (vB.y < 0.0) B = -C.y;
  fragColor = vec4(0.5 * (R - L + T - B), 0.0, 0.0, 1.0);
}`;

export const curlFrag = head + /* glsl */ `
uniform sampler2D uVelocity;
void main() {
  float L = texture(uVelocity, vL).y;
  float R = texture(uVelocity, vR).y;
  float T = texture(uVelocity, vT).x;
  float B = texture(uVelocity, vB).x;
  fragColor = vec4(0.5 * (R - L - T + B), 0.0, 0.0, 1.0);
}`;

export const vorticityFrag = head + /* glsl */ `
uniform sampler2D uVelocity;
uniform sampler2D uCurl;
uniform float curl;
uniform float dt;
void main() {
  float L = texture(uCurl, vL).x;
  float R = texture(uCurl, vR).x;
  float T = texture(uCurl, vT).x;
  float B = texture(uCurl, vB).x;
  float C = texture(uCurl, vUv).x;
  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= curl * C;
  force.y *= -1.0;
  vec2 vel = texture(uVelocity, vUv).xy + force * dt;
  fragColor = vec4(clamp(vel, -1000.0, 1000.0), 0.0, 1.0);
}`;

export const pressureFrag = head + /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
void main() {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  float div = texture(uDivergence, vUv).x;
  fragColor = vec4((L + R + B + T - div) * 0.25, 0.0, 0.0, 1.0);
}`;

export const gradientSubtractFrag = head + /* glsl */ `
uniform sampler2D uPressure;
uniform sampler2D uVelocity;
void main() {
  float L = texture(uPressure, vL).x;
  float R = texture(uPressure, vR).x;
  float T = texture(uPressure, vT).x;
  float B = texture(uPressure, vB).x;
  vec2 vel = texture(uVelocity, vUv).xy - vec2(R - L, T - B);
  fragColor = vec4(vel, 0.0, 1.0);
}`;

export const bloomPrefilterFrag = head + /* glsl */ `
uniform sampler2D uTexture;
uniform vec3 curve; // threshold - knee, knee * 2, 0.25 / knee
uniform float threshold;
void main() {
  vec3 c = texture(uTexture, vUv).rgb;
  float br = max(c.r, max(c.g, c.b));
  float rq = clamp(br - curve.x, 0.0, curve.y);
  rq = curve.z * rq * rq;
  c *= max(rq, br - threshold) / max(br, 0.0001);
  fragColor = vec4(c, 0.0);
}`;

export const blurFrag = head + /* glsl */ `
uniform sampler2D uTexture;
void main() {
  vec4 sum = texture(uTexture, vL) + texture(uTexture, vR) + texture(uTexture, vT) + texture(uTexture, vB);
  fragColor = sum * 0.25;
}`;

export const displayFrag = head + /* glsl */ `
uniform sampler2D uTexture;
uniform sampler2D uBloom;
uniform vec2 dyeTexel;
uniform float bloomOn;    // bloom intensity; 0 disables
uniform float paint;      // 0 = neon (additive light), 1 = paint (subtractive pigment)
uniform float shading;
uniform float time;

vec3 aces(vec3 x) {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

void main() {
  vec3 dye = texture(uTexture, vUv).rgb;
  // Fake height from dye amount gives a glossy, embossed-ink surface.
  float hl = length(texture(uTexture, vUv - vec2(dyeTexel.x, 0.0)).rgb);
  float hr = length(texture(uTexture, vUv + vec2(dyeTexel.x, 0.0)).rgb);
  float ht = length(texture(uTexture, vUv + vec2(0.0, dyeTexel.y)).rgb);
  float hb = length(texture(uTexture, vUv - vec2(0.0, dyeTexel.y)).rgb);
  vec3 n = normalize(vec3(hl - hr, hb - ht, 0.08));
  vec3 lightDir = normalize(vec3(-0.4, 0.6, 0.7));
  float diffuse = mix(1.0, clamp(dot(n, lightDir) + 0.55, 0.55, 1.25), shading);
  float spec = pow(max(dot(reflect(-lightDir, n), vec3(0.0, 0.0, 1.0)), 0.0), 24.0) * shading;

  vec3 col;
  if (paint > 0.5) {
    // Dye is pigment absorbance: Beer-Lambert over warm paper mixes colours like real paint.
    vec3 paper = vec3(0.96, 0.93, 0.87);
    col = paper * exp(-dye * 2.2) * diffuse + spec * 0.35 * smoothstep(0.02, 0.3, length(dye));
    col = pow(col, vec3(1.0 / 1.1));
  } else {
    col = dye * diffuse + spec * 0.6 * smoothstep(0.02, 0.5, length(dye));
    col += texture(uBloom, vUv).rgb * bloomOn;
    col = aces(col * 1.1);
    col = pow(col, vec3(1.0 / 2.2));
  }
  // Blue-noise-ish dither kills banding in slow gradients.
  float noise = fract(sin(dot(gl_FragCoord.xy + time, vec2(12.9898, 78.233))) * 43758.5453);
  col += (noise - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;
