// Marbling passes. The bath is an RGBA16F colour texture; every stroke is one fullscreen pass that
// reads the previous bath at the stroke's reverse-drifted coordinate (Mixwell), so strokes compose.
import { mixwellGlsl } from './mixwell';

export const MAX_TINES = 16;

export const quadVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() {
  vUv = aPosition * 0.5 + 0.5;
  gl_Position = vec4(aPosition, 0.0, 1.0);
}`;

/** Catmull-Rom (9-tap) sampling: exact at texel centres, much less blur than bilinear on repeated resamples. */
const sampleLib = /* glsl */ `
vec4 sampleCR(sampler2D tex, vec2 uv, vec2 texSize) {
  vec2 samplePos = uv * texSize;
  vec2 tp1 = floor(samplePos - 0.5) + 0.5;
  vec2 f = samplePos - tp1;
  vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
  vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
  vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
  vec2 w3 = f * f * (-0.5 + 0.5 * f);
  vec2 w12 = w1 + w2;
  vec2 o12 = w2 / w12;
  vec2 t0 = (tp1 - 1.0) / texSize;
  vec2 t3 = (tp1 + 2.0) / texSize;
  vec2 t12 = (tp1 + o12) / texSize;
  vec4 r = vec4(0.0);
  r += texture(tex, vec2(t0.x, t0.y)) * w0.x * w0.y;
  r += texture(tex, vec2(t12.x, t0.y)) * w12.x * w0.y;
  r += texture(tex, vec2(t3.x, t0.y)) * w3.x * w0.y;
  r += texture(tex, vec2(t0.x, t12.y)) * w0.x * w12.y;
  r += texture(tex, vec2(t12.x, t12.y)) * w12.x * w12.y;
  r += texture(tex, vec2(t3.x, t12.y)) * w3.x * w12.y;
  r += texture(tex, vec2(t0.x, t3.y)) * w0.x * w3.y;
  r += texture(tex, vec2(t12.x, t3.y)) * w12.x * w3.y;
  r += texture(tex, vec2(t3.x, t3.y)) * w3.x * w3.y;
  return clamp(r, 0.0, 1.0);
}
`;

export const strokeFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uState;
uniform vec2 texSize;
uniform vec2 world;        // bath size in short-side units
uniform int mode;          // 0 drop, 1 tines (stylus / comb), 2 swirl
uniform vec2 center;
uniform float radius;
uniform vec3 color;
uniform vec4 seg[${MAX_TINES}];
uniform int nSeg;
uniform float tineR;
uniform float angle;
${mixwellGlsl}
${sampleLib}
void main() {
  vec2 q = vUv * world;
  vec2 src = q;
  if (mode == 0) {
    // Ink drop (area-preserving radial push): everything outside moves out to make room.
    vec2 d = q - center;
    float r2 = radius * radius;
    float dd = dot(d, d);
    float px = 1.2 / texSize.y * world.y;
    if (dd > r2) src = center + d * sqrt(1.0 - r2 / dd);
    vec3 old = sampleCR(uState, src / world, texSize).rgb;
    float inside = 1.0 - smoothstep(radius - px, radius + px, sqrt(dd));
    fragColor = vec4(mix(old, color, inside), 1.0);
    return;
  }
  if (mode == 1) {
    vec2 rd = vec2(0.0);
    for (int i = 0; i < ${MAX_TINES}; i++) {
      if (i >= nSeg) break;
      rd += rdSegment(q, tineR, seg[i].xy, seg[i].zw);
    }
    src = q + rd;
  } else {
    // Swirl: rotation whose angle falls off with distance keeps area (a vortex stirring the bath).
    vec2 d = q - center;
    float fall = exp(-dot(d, d) / (radius * radius));
    float a = -angle * fall;
    float c = cos(a), s = sin(a);
    src = center + vec2(c * d.x - s * d.y, s * d.x + c * d.y);
  }
  fragColor = vec4(sampleCR(uState, src / world, texSize).rgb, 1.0);
}`;

/** Fill the bath with the size colour, optionally keeping a faint ghost of the old pattern (a lifted print). */
export const clearFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uState;
uniform vec3 base;
uniform float ghost;
void main() {
  vec3 old = texture(uState, vUv).rgb;
  fragColor = vec4(mix(base, old, ghost), 1.0);
}`;

/** Copy (downsampled). For prints, dividing out the bath colour leaves bare paper where there's no ink. */
export const copyFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uState;
uniform vec3 base;      // (1,1,1) for a plain copy
void main() { fragColor = vec4(clamp(texture(uState, vUv).rgb / base, 0.0, 1.0), 1.0); }`;

export const displayFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
in vec2 vUv;
out vec4 fragColor;
uniform sampler2D uState;
uniform vec2 texSize;
uniform vec2 world;
uniform float time;
uniform float drift;
${sampleLib}
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  vec2 q = vUv * world;
  // Gentle idle wobble of the floating ink (display only, the bath itself stays put).
  vec2 wob = drift * 0.0015 * vec2(sin(time * 0.7 + q.y * 9.0), cos(time * 0.55 + q.x * 8.0));
  vec2 uv = vUv + wob / world;
  vec3 ink = sampleCR(uState, uv, texSize).rgb;
  // Fake film relief from colour edges catches a soft sheen.
  vec2 e = 1.5 / texSize;
  float lx = dot(texture(uState, uv + vec2(e.x, 0.0)).rgb - texture(uState, uv - vec2(e.x, 0.0)).rgb, vec3(0.33));
  float ly = dot(texture(uState, uv + vec2(0.0, e.y)).rgb - texture(uState, uv - vec2(0.0, e.y)).rgb, vec3(0.33));
  vec3 n = normalize(vec3(-lx * 1.6, -ly * 1.6, 1.0));
  vec3 L = normalize(vec3(-0.4, 0.55, 0.75));
  float diff = 0.94 + 0.08 * dot(n, L);
  // A broad window reflection sliding slowly across the liquid surface.
  float band = smoothstep(0.35, 0.0, abs(q.x * 0.55 + q.y * 0.35 - 0.55 - 0.05 * sin(time * 0.2)));
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 60.0);
  vec3 col = ink * diff + band * 0.05 + spec * 0.12;
  // Tray rim: the meniscus darkens and curls up toward the edges.
  vec2 edge = min(vUv, 1.0 - vUv) * world;
  float rim = smoothstep(0.0, 0.06, min(edge.x, edge.y));
  col = mix(col * 0.55 + vec3(0.02, 0.015, 0.01), col, rim);
  col += (1.0 - rim) * 0.06 * vec3(1.0, 0.95, 0.85) * smoothstep(0.0, 0.015, min(edge.x, edge.y));
  col += (hash(gl_FragCoord.xy + time) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;
