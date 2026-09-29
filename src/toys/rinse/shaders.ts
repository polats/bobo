import { objectGlsl } from './objects';

// Passes: bake the object's mask/height/region once, generate dirt, erode it under the jets,
// run grimy water down the screen, reduce to a tiny stats texture for "% clean", then composite.

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
uniform float aspect;     // width / height
uniform vec2 objCenter;   // uv
uniform float objScale;   // uv-height per object unit
vec2 toObj(vec2 uv) { return (uv - objCenter) * vec2(aspect, 1.0) / objScale; }
vec2 fromObj(vec2 p) { return objCenter + p * objScale / vec2(aspect, 1.0); }
${objectGlsl}
`;

const jets = /* glsl */ `
uniform vec4 jets[2];      // xy target uv, z footprint radius (uv-height units), w strength
uniform vec2 jetStretch;   // horizontal stretch per jet (fan)
uniform int jetCount;
float jetAt(vec2 uv, int i) {
  vec4 j = jets[i];
  vec2 d = (uv - j.xy) * vec2(aspect, 1.0);
  d.x /= (i == 0 ? jetStretch.x : jetStretch.y);
  return j.w * exp(-dot(d, d) / (j.z * j.z));
}
float jetSum(vec2 uv) {
  float s = 0.0;
  if (jetCount > 0) s += jetAt(uv, 0);
  if (jetCount > 1) s += jetAt(uv, 1);
  return s;
}
`;

/** objTex: r mask, g dome height, b region / 8, a gloss. */
export const bakeFrag = head + /* glsl */ `
uniform float objPx;
void main() {
  vec3 col; float gloss, reg, h;
  float d = objectSdf(toObj(vUv), col, gloss, reg, h);
  float m = clamp(0.5 - d / objPx, 0.0, 1.0);
  fragColor = vec4(m, h * m, reg / 8.0, gloss);
}`;

/** dirt: r mud, g stubborn grime/moss, b wetness, a "freshly cleaned" sparkle. */
export const genFrag = head + /* glsl */ `
uniform float seed;
uniform float amount;
void main() {
  vec2 p = toObj(vUv);
  vec3 col; float gloss, reg, h;
  float d = objectSdf(p, col, gloss, reg, h);
  float cover = smoothstep(0.02, -0.005, d);
  float mud = clamp(0.8 + 0.9 * (fbm(p * 5.0 + seed) - 0.5), 0.45, 1.0) * cover * amount;
  // Moss clings in patches, thicker toward the bottom where it stays damp.
  float moss = smoothstep(0.5, 0.66, fbm(p * 3.2 + seed * 1.7 + 4.0)) * (0.45 + 0.9 * smoothstep(0.25, -0.45, p.y));
  fragColor = vec4(mud, clamp(moss, 0.0, 1.0) * cover * amount, 0.0, 0.0);
}`;

export const dirtFrag = head + jets + /* glsl */ `
uniform sampler2D uDirt;
uniform sampler2D uObj;
uniform vec2 texel;
uniform vec2 nozzle;
uniform float dt;
uniform float stubborn;
uniform float finish;
void main() {
  vec4 d = texture(uDirt, vUv);
  float I = jetSum(vUv);
  // Incidence: jets hitting the surface head-on clean faster than glancing blows.
  float hl = texture(uObj, vUv - vec2(texel.x, 0.0)).g, hr = texture(uObj, vUv + vec2(texel.x, 0.0)).g;
  float hb = texture(uObj, vUv - vec2(0.0, texel.y)).g, ht = texture(uObj, vUv + vec2(0.0, texel.y)).g;
  vec3 n = normalize(vec3((hl - hr) * 6.0, (hb - ht) * 6.0, 1.0));
  vec3 dir = normalize(vec3((vUv - nozzle) * vec2(aspect, 1.0), -0.7));
  I *= mix(0.35, 1.15, max(0.0, dot(n, -dir)));
  float mud = max(0.0, d.r - I * dt * 9.0);
  // Stubborn grime only starts to lift once the mud over it is gone, and needs lingering.
  float grime = max(0.0, d.g - I * dt * 2.2 / stubborn * smoothstep(0.3, 0.02, mud));
  float removed = (d.r - mud) + (d.g - grime);
  mud *= 1.0 - clamp(finish * dt * 2.5, 0.0, 1.0);
  grime *= 1.0 - clamp(finish * dt * 2.5, 0.0, 1.0);
  float wet = max(d.b * exp(-dt * 0.22), min(1.0, I * 2.5));
  float fresh = max(d.a * exp(-dt * 0.45), min(1.0, removed * 30.0) * step(mud + grime, 0.12));
  fragColor = vec4(mud, grime, wet, fresh);
}`;

/** runoff: r dirty water, g clean water sheen. Flows down the object, drips, pools on the ground. */
export const runFrag = head + jets + /* glsl */ `
uniform sampler2D uRun;
uniform sampler2D uDirt;
uniform sampler2D uObj;
uniform vec2 texel;
uniform float dt;
uniform float time;
uniform float groundY;
uniform float runoff;
void main() {
  float onObj = texture(uObj, vUv).r;
  float wobble = (vnoise(vec2(vUv.x * 50.0, vUv.y * 6.0 + time * 0.4)) - 0.5) * texel.x * 1.6;
  vec4 r;
  if (vUv.y < groundY) {
    // Puddle: spreads sideways, soaks in slowly.
    vec4 c = texture(uRun, vUv);
    vec4 s = texture(uRun, vUv + vec2(texel.x * 2.0, 0.0)) + texture(uRun, vUv - vec2(texel.x * 2.0, 0.0));
    vec4 a = texture(uRun, vUv + vec2(0.0, texel.y * 1.5));
    r = c * 0.6 + s * 0.12 + a * 0.16;
    r *= exp(-dt * 0.35);
  } else {
    float speed = mix(3.0, 1.1, onObj);
    r = texture(uRun, vUv + vec2(wobble, texel.y * speed)) * exp(-dt * mix(0.9, 0.35, onObj));
  }
  float I = jetSum(vUv);
  vec4 d = texture(uDirt, vUv);
  float dirt = clamp(d.r + d.g, 0.0, 1.0);
  r.r += I * dirt * dt * 5.0 * runoff * (0.6 + 0.8 * vnoise(vUv * vec2(90.0, 20.0)));
  r.g += I * dt * 3.0;
  fragColor = vec4(min(r.r, 1.5), min(r.g, 1.2), 0.0, 1.0);
}`;

/** Tiny reduction target: r visible dirt on the object, g object coverage, b region id. */
export const statFrag = head + /* glsl */ `
uniform sampler2D uDirt;
uniform sampler2D uObj;
void main() {
  vec4 o = texture(uObj, vUv);
  vec4 d = texture(uDirt, vUv);
  float vis = max(smoothstep(0.08, 0.24, d.r), smoothstep(0.1, 0.3, d.g));
  fragColor = vec4(vis * step(0.5, o.r), step(0.5, o.r), o.b, 1.0);
}`;

export const displayFrag = head + jets + /* glsl */ `
uniform sampler2D uDirt;
uniform sampler2D uRun;
uniform float objPx;
uniform float time;
uniform float groundY;
uniform float wiggle;
uniform float shine;
uniform vec2 nozzle;
uniform vec2 aim;

vec3 background(vec2 uv) {
  vec3 col;
  if (uv.y < groundY) {
    // Paving stones.
    vec2 g = vec2(uv.x * aspect * 7.0 + floor(uv.y * 26.0) * 0.5, uv.y * 26.0);
    vec2 cell = floor(g), f = fract(g);
    float edge = smoothstep(0.0, 0.08, f.x) * smoothstep(1.0, 0.92, f.x) * smoothstep(0.0, 0.1, f.y) * smoothstep(1.0, 0.9, f.y);
    col = mix(vec3(0.4, 0.39, 0.37), vec3(0.62, 0.6, 0.56), hash21(cell) * 0.6 + 0.2 * vnoise(uv * 200.0));
    col *= mix(0.55, 1.0, edge);
    col *= 0.75 + 0.25 * smoothstep(0.0, groundY, uv.y);
  } else if (uv.y < 0.86) {
    // Wooden fence.
    float x = uv.x * aspect * 9.0;
    float plank = fract(x);
    col = vec3(0.72, 0.5, 0.32) * (0.85 + 0.2 * hash21(vec2(floor(x), 3.0))) * (0.9 + 0.12 * vnoise(vec2(x * 3.0, uv.y * 80.0)));
    col *= mix(0.45, 1.0, smoothstep(0.0, 0.05, plank) * smoothstep(1.0, 0.95, plank));
    col *= mix(1.0, 0.8, smoothstep(0.7, 0.86, uv.y) * 0.5);
    if (abs(uv.y - 0.72) < 0.012 || abs(uv.y - 0.34) < 0.012) col *= 0.75;
  } else {
    col = mix(vec3(0.62, 0.8, 0.98), vec3(0.35, 0.6, 0.95), (uv.y - 0.86) / 0.14);
  }
  return col;
}

void main() {
  vec2 uv = vUv;
  vec3 col = background(uv);
  // Soft contact shadow under the object.
  vec2 sd = (uv - vec2(objCenter.x, groundY + 0.005)) * vec2(aspect / (0.38 * objScale), 1.0 / (0.03 * objScale + 0.01));
  col *= 1.0 - 0.35 * exp(-dot(sd, sd));

  // The object (wiggles when finished).
  vec2 p = toObj(uv);
  float w = wiggle * sin(time * 20.0);
  vec2 pw = vec2(p.x * (1.0 + w * 0.06), (p.y + 0.45) * (1.0 - w * 0.06) - 0.45);
  vec3 alb; float gloss, reg, h;
  float d = objectSdf(pw, alb, gloss, reg, h);
  float m = clamp(0.5 - d / objPx, 0.0, 1.0);
  // Derivatives must be taken in uniform control flow, before the early-out below.
  float hx = dFdx(h) / objPx, hy = dFdy(h) / objPx;
  if (m > 0.0) {
  vec2 duv = fromObj(pw);
  vec4 dirt = texture(uDirt, duv);
  vec3 n = normalize(vec3(-hx * 0.22, -hy * 0.22, 1.0));
  vec3 L = normalize(vec3(-0.45, 0.6, 0.66));
  float diff = clamp(dot(n, L) * 0.7 + 0.45, 0.0, 1.2);
  float spec = pow(max(dot(reflect(-L, n), vec3(0.0, 0.0, 1.0)), 0.0), 30.0);
  vec3 clean = alb * diff + spec * gloss * 0.6;

  // Moss and mud with organic, crisp edges.
  float edgeN = vnoise(pw * 160.0) * 0.6 + vnoise(pw * 380.0) * 0.4 - 0.5;
  float mossVis = smoothstep(0.1, 0.22, dirt.g + edgeN * 0.12);
  float mudVis = smoothstep(0.08, 0.18, dirt.r + edgeN * 0.08);
  vec3 moss = mix(vec3(0.17, 0.26, 0.07), vec3(0.33, 0.43, 0.13), vnoise(pw * 40.0)) * (0.7 + 0.4 * vnoise(pw * 160.0));
  vec3 mud = mix(vec3(0.28, 0.19, 0.11), vec3(0.46, 0.34, 0.21), vnoise(pw * 18.0)) * (0.8 + 0.3 * vnoise(pw * 90.0));
  float crack = smoothstep(0.035, 0.0, abs(vnoise(pw * 16.0) - 0.5)) * (1.0 - dirt.b);
  mud *= 1.0 - crack * 0.45;
  vec3 surf = mix(clean, moss * mix(diff, 0.95, 0.4), mossVis);
  // Mud and moss are thick and soft: they only half follow the surface underneath.
  float soft = mix(diff, 0.95, 0.55);
  surf = mix(surf, mud * soft, mudVis);
  // Wet darkens and adds a sheen; fresh-cleaned areas glitter.
  surf *= 1.0 - 0.28 * dirt.b;
  surf += spec * dirt.b * 0.35;
  float glint = step(0.988, hash21(floor(gl_FragCoord.xy / 3.0) + floor(time * 9.0) * 7.13));
  surf += vec3(1.3) * glint * clamp(dirt.a + shine, 0.0, 1.0) * (1.0 - mudVis) * (1.0 - mossVis);
  col = mix(col, surf, m);
  }

  // Runoff: grimy streaks and a puddle.
  vec4 run = texture(uRun, uv);
  col = mix(col, vec3(0.24, 0.17, 0.1) * (0.8 + 0.3 * vnoise(uv * 120.0)), clamp(run.r * 0.8, 0.0, 0.7));
  col += vec3(0.12, 0.14, 0.16) * clamp(run.g * 0.35, 0.0, 0.25) * (0.5 + vnoise(uv * vec2(80.0, 12.0) + time));

  // Water jets from the nozzle.
  vec2 A = nozzle * vec2(aspect, 1.0);
  for (int i = 0; i < 2; i++) {
    if (i >= jetCount) break;
    vec2 B = jets[i].xy * vec2(aspect, 1.0);
    vec2 P = uv * vec2(aspect, 1.0);
    vec2 ab = B - A;
    float t = clamp(dot(P - A, ab) / dot(ab, ab), 0.0, 1.0);
    float dist = length(P - (A + ab * t));
    float stretch = i == 0 ? jetStretch.x : jetStretch.y;
    float width = mix(0.004, jets[i].z * 0.45 * stretch, t * t);
    float streak = 0.65 + 0.35 * vnoise(vec2(t * 40.0 - time * 30.0, dist * 300.0));
    float beam = smoothstep(width, width * 0.3, dist) * streak;
    col = mix(col, vec3(0.85, 0.94, 1.0), beam * 0.7);
    vec2 q = (P - B);
    q.x /= stretch;
    float splash = exp(-dot(q, q) / (jets[i].z * jets[i].z * 0.5)) * (0.5 + 0.5 * vnoise(q * 90.0 + time * 12.0));
    col = mix(col, vec3(0.92, 0.97, 1.0), splash * 0.55);
  }
  // The lance: a steel wand from the bottom of the screen to the nozzle, pointing at the aim.
  vec2 dirA = normalize((aim - nozzle) * vec2(aspect, 1.0));
  vec2 back = A - dirA * 0.26;
  vec2 P2 = uv * vec2(aspect, 1.0);
  vec2 ab2 = A - back;
  float t2 = clamp(dot(P2 - back, ab2) / dot(ab2, ab2), 0.0, 1.0);
  float dl = length(P2 - (back + ab2 * t2));
  float rod = smoothstep(0.011, 0.008, dl);
  vec3 steel = mix(vec3(0.35, 0.37, 0.4), vec3(0.85, 0.87, 0.9), smoothstep(0.008, -0.004, dl - 0.004));
  if (t2 < 0.35) steel = mix(vec3(0.95, 0.72, 0.1), vec3(1.0, 0.85, 0.3), smoothstep(0.008, 0.0, dl));
  col = mix(col, steel, rod);
  float tip = smoothstep(0.016, 0.012, length(P2 - A));
  col = mix(col, vec3(0.2, 0.2, 0.22), tip);

  col = pow(col, vec3(1.0 / 1.1));
  col += (hash21(gl_FragCoord.xy + time) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;

export const mistVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec4 aP; // x, y uv, life 0..1, size
uniform float pixelRatio;
out float vLife;
void main() {
  vLife = aP.z;
  gl_Position = vec4(aP.xy * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = aP.w * pixelRatio;
}`;

export const mistFrag = /* glsl */ `#version 300 es
precision highp float;
in float vLife;
out vec4 fragColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float a = smoothstep(1.0, 0.2, dot(p, p)) * vLife * 0.55;
  fragColor = vec4(vec3(0.9, 0.96, 1.0) * a, a);
}`;
