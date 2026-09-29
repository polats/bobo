// One fullscreen composite for the whole scene (wall, desk, candle, flame, the letter and its fire),
// plus a point pass for embers and smoke. World units: the screen's short side = 1, y up.

export const quadVert = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }`;

export const sceneFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp sampler2D;
out vec4 fragColor;
uniform sampler2D uS1;    // r temp/1.5, g dose/2, b fire progress, a hole
uniform sampler2D uS2;    // r ink A developed, g ink B developed
uniform sampler2D uMask;  // r hidden ink A, g hidden ink B, b cover ink
uniform float uPx;        // device pixels per world unit
uniform vec2 uWorld;      // world size
uniform vec4 uSheet;      // centre, half size
uniform vec2 uRot;        // cos, sin of the sheet's tilt
uniform vec2 uCell;       // grid cells across, down
uniform vec3 uCandle;     // x, wick top y, radius
uniform float uDesk;      // desk top y
uniform vec3 uFlame;      // size, bend (-1..1), flicker 0..1
uniform float uTime;
uniform float uLift;      // 0 resting .. 1 held up (shadow grows)
uniform float uFireOn;    // any burning cells: enables the tongue taps
uniform float uGlow;      // decode flash

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), f.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) { return noise(p) * 0.55 + noise(p * 2.03 + 7.1) * 0.3 + noise(p * 4.1 + 3.3) * 0.15; }
vec3 lin(vec3 c) { return c * c; }

vec3 blackbody(float t) {
  t = clamp(t, 0.0, 1.6);
  vec3 c = vec3(1.0, 0.22, 0.03) * smoothstep(0.0, 0.35, t);
  c = mix(c, vec3(1.0, 0.55, 0.1), smoothstep(0.3, 0.7, t));
  c = mix(c, vec3(1.0, 0.85, 0.45), smoothstep(0.65, 1.1, t));
  c = mix(c, vec3(1.0, 0.97, 0.9), smoothstep(1.05, 1.6, t));
  return c;
}

// Candle flame: a teardrop that leans with the draught and licks with noise.
// Returns emission in rgb and how much it hides what's behind in a.
vec4 flame(vec2 p) {
  float fs = uFlame.x;
  float len = 0.19 * fs;
  vec2 q = p - vec2(uCandle.x, uCandle.y + 0.004);
  float h = clamp(q.y / len, 0.0, 1.4);
  float lick = (noise(vec2(uTime * 6.0, h * 2.0)) - 0.5) * (0.4 + abs(uFlame.y));
  q.x -= (uFlame.y * 0.55 * h * h + lick * 0.14 * h * h) * len;
  q.y += abs(uFlame.y) * 0.18 * len * h;
  float stretch = 1.0 + 0.08 * sin(uTime * 13.0) * uFlame.z;
  vec2 f = vec2(q.x, q.y - 0.28 * len);
  float sy = f.y > 0.0 ? len * 0.8 * stretch : len * 0.28;
  float sx = 0.036 * fs * (1.0 - 0.6 * clamp(f.y / (len * 0.85), 0.0, 1.0));
  float d = length(vec2(f.x / sx, f.y / sy));
  float body = smoothstep(1.0, 0.7, d);
  float inner = smoothstep(0.85, 0.35, length(vec2(f.x / (sx * 0.85), (f.y + len * 0.08) / (sy * 0.85))));
  float core = smoothstep(0.55, 0.05, length(vec2(f.x / (sx * 0.6), (f.y + len * 0.12) / (sy * 0.6))));
  vec3 e = vec3(0.9, 0.22, 0.03) * body;
  e = mix(e, vec3(1.0, 0.62, 0.16), inner);
  e = mix(e, vec3(1.0, 0.93, 0.72) * 1.6, core);
  // Blue skirt round the wick, dark unburnt vapour just above it.
  float base = smoothstep(0.026 * fs, 0.0, abs(q.y - 0.014 * fs)) * smoothstep(0.04 * fs, 0.012 * fs, abs(q.x));
  e = mix(e, vec3(0.12, 0.25, 0.9), base * 0.6);
  e *= 1.0 - 0.6 * smoothstep(0.022 * fs, 0.0, length(vec2(q.x * 1.8, q.y - 0.024 * fs))) * step(q.y, 0.05 * fs);
  return vec4(e * (0.92 + 0.08 * uFlame.z), max(body, base * 0.5) * 0.9);
}

float halo(vec2 p) {
  vec2 d = p - vec2(uCandle.x + uFlame.y * 0.05 * uFlame.x, uCandle.y + 0.07 * uFlame.x);
  return exp(-dot(d, d) * 4.0) * (0.85 + 0.15 * uFlame.z);
}

// Wall and desk, lit by the flame.
vec3 room(vec2 p, float glow) {
  float near = exp(-dot(p - vec2(uCandle.x, uCandle.y + 0.07), p - vec2(uCandle.x, uCandle.y + 0.07)) * 1.1);
  vec3 wall = lin(vec3(0.16, 0.1, 0.075)) * (0.55 + 0.25 * fbm(p * vec2(3.0, 1.2)));
  // Faded damask stripes.
  wall *= 0.94 + 0.06 * smoothstep(0.3, 0.7, sin(p.x * 60.0 + sin(p.y * 18.0) * 1.5) * 0.5 + 0.5);
  vec3 col = wall * (0.35 + 1.8 * near + 1.4 * glow);
  // Moonlight through venetian blinds, slanting across the upper wall.
  vec2 bq = vec2(p.x - uWorld.x * 0.62 + (p.y - uWorld.y) * 0.45, uWorld.y * 0.86 - p.y);
  float win = smoothstep(0.5, 0.2, abs(bq.x)) * smoothstep(0.55, 0.15, abs(bq.y - 0.1));
  float slats = smoothstep(0.35, 0.6, fract((p.y + p.x * 0.28) * 16.0));
  col += lin(vec3(0.45, 0.55, 0.8)) * win * slats * 0.05;
  if (p.y < uDesk) {
    float gy = uDesk - p.y;
    float grain = fbm(vec2(p.x * 3.0 + fbm(p * vec2(2.0, 18.0)) * 1.4, p.y * 40.0));
    vec3 wood = mix(lin(vec3(0.16, 0.08, 0.04)), lin(vec3(0.36, 0.19, 0.09)), grain * grain);
    col = wood * (0.25 + 1.6 * near) * (1.0 - 0.5 * smoothstep(0.0, 0.3, gy));
    col += lin(vec3(1.0, 0.7, 0.4)) * smoothstep(0.006, 0.0, gy) * (0.2 + near); // lit front edge
  }
  return col;
}

// The candle stands in front of the letter: brass holder, wax pillar, wick.
vec3 candle(vec2 p, vec3 col) {
  float near = exp(-dot(p - vec2(uCandle.x, uCandle.y + 0.07), p - vec2(uCandle.x, uCandle.y + 0.07)) * 1.1);
  // Brass holder.
  vec2 hq = vec2((p.x - uCandle.x) / (uCandle.z * 2.1), (p.y - uDesk - 0.012) / 0.022);
  if (length(hq) < 1.0) {
    float sh = 0.25 + 0.75 * smoothstep(-1.0, 0.7, hq.y);
    float spec = smoothstep(0.25, 0.0, abs(hq.y - 0.45 + hq.x * hq.x * 0.3)) * (1.0 - abs(hq.x));
    col = lin(vec3(0.5, 0.34, 0.12)) * sh * (0.3 + 1.1 * near) + lin(vec3(1.0, 0.78, 0.45)) * spec * 0.5 * near;
  }
  // Wax pillar: ivory, darker at the rim, a couple of drips, and lit from inside near the flame.
  float dx = (p.x - uCandle.x) / uCandle.z;
  float top = uCandle.y - 0.012 + 0.008 * sqrt(max(0.0, 1.0 - dx * dx));
  float drips = max(smoothstep(0.1, 0.0, abs(dx - 0.55)) * 0.07, smoothstep(0.08, 0.0, abs(dx + 0.3)) * 0.035);
  float wax = abs(dx) < 1.0 && p.y > uDesk + 0.02 && p.y < top ? 1.0 : 0.0;
  if (wax > 0.0) {
    float cyl = sqrt(1.0 - dx * dx);
    float down = top - p.y;
    float sss = exp(-down * 11.0) * (0.5 + 0.5 * cyl);
    float drip = smoothstep(drips, drips - 0.01, down) * step(0.004, drips);
    vec3 ivory = lin(vec3(0.92, 0.84, 0.68));
    col = ivory * (0.03 + 0.55 * pow(cyl, 1.5) * (0.06 + 0.9 * exp(-down * 4.0))) * (0.55 + 0.45 * smoothstep(0.6, -0.6, dx));
    col += lin(vec3(1.0, 0.58, 0.25)) * sss * (0.9 + 0.1 * uFlame.z);
    col += ivory * drip * 0.12 * (0.3 + near) * cyl;
    col *= 0.9 + 0.1 * noise(vec2(dx * 6.0, p.y * 80.0));
  }
  // The melted pool on top: a thin glowing ellipse.
  vec2 pq = vec2(dx, (p.y - (uCandle.y - 0.012)) / 0.009);
  if (length(pq) < 1.0) col = mix(col, lin(vec3(1.0, 0.72, 0.38)) * (0.6 + 0.4 * uFlame.z), smoothstep(1.0, 0.7, length(pq)) * 0.85);
  // Wick.
  if (abs(p.x - uCandle.x - uFlame.y * 0.004) < 0.0025 && p.y > top - 0.004 && p.y < uCandle.y + 0.014) col = vec3(0.02, 0.012, 0.008);
  return col;
}

float sheetDist(vec2 q) {
  vec2 d = abs(q) - uSheet.zw;
  return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
}

void main() {
  vec2 p = gl_FragCoord.xy / uPx;
  float glow = halo(p);
  vec4 fl = flame(p);
  vec3 col = room(p, glow);

  // Sheet-local position.
  vec2 r = p - uSheet.xy;
  vec2 q = vec2(uRot.x * r.x + uRot.y * r.y, -uRot.y * r.x + uRot.x * r.y);
  vec2 uv = q / (2.0 * uSheet.zw) + 0.5;

  // Soft shadow the floating sheet casts on the wall behind it.
  vec2 so = q - vec2(0.02, -0.035) * (0.6 + uLift);
  float sd = sheetDist(so);
  col *= 1.0 - 0.55 * smoothstep(0.05 + 0.03 * uLift, -0.02, sd);

  float edge = -sheetDist(q) + (fbm(q * 90.0) - 0.5) * 0.006;
  if (edge > 0.0) {
    vec4 s1 = texture(uS1, uv);
    vec4 s2 = texture(uS2, uv);
    vec3 m = texture(uMask, uv).rgb;
    // Four diagonal taps soften the fire and heat so burning reads as a glow, not as cells.
    vec2 tx = 0.8 / uCell;
    vec4 blur = (texture(uS1, uv + tx) + texture(uS1, uv - tx) + texture(uS1, uv + vec2(tx.x, -tx.y)) + texture(uS1, uv - vec2(tx.x, -tx.y))) * 0.25;
    float T = mix(s1.r, blur.r, 0.6) * 1.5, dose = s1.g * 2.0, fire = blur.b, holeV = mix(s1.a, blur.a, 0.5);
    // Ragged burn edge: noise decides where the filtered hole field cuts through.
    float hn = holeV + (fbm(uv * uCell * 0.6) - 0.5) * 0.55;
    float dn = dose + (fbm(uv * uCell * 0.35 + 5.0) - 0.5) * 0.35;
    if (hn < 0.5) {
      // Aged paper: fibres, foxing, darker deckle edges and two fold creases.
      vec2 w = q * 1.0;
      float fib = noise(w * vec2(900.0, 260.0)) * 0.5 + noise(w * 300.0) * 0.5;
      vec3 paper = mix(vec3(0.82, 0.71, 0.52), vec3(0.9, 0.82, 0.64), fbm(w * 5.0));
      paper *= 0.94 + 0.09 * fib;
      paper = mix(paper, vec3(0.7, 0.54, 0.34), smoothstep(0.6, 0.85, fbm(w * 9.0 + 2.0)) * 0.45);
      paper = mix(paper, vec3(0.6, 0.43, 0.25), smoothstep(0.12, 0.0, edge) * 0.6);
      for (int k = 1; k <= 2; k++) {
        float cy = uv.y - float(k) / 3.0;
        paper *= 1.0 - 0.09 * exp(-pow(cy * uSheet.w * 2.0 / 0.004, 2.0));
        paper *= 1.0 + 0.05 * exp(-pow((cy - 0.009) * uSheet.w * 2.0 / 0.006, 2.0));
      }
      // Cover note in faded iron-gall ink, then the hidden inks as they develop.
      paper = mix(paper, vec3(0.16, 0.16, 0.26), m.b * 0.82);
      float a = smoothstep(0.0, 0.9, s2.r) * m.r;
      paper = mix(paper, mix(vec3(0.55, 0.33, 0.14), vec3(0.27, 0.13, 0.04), smoothstep(0.3, 1.0, s2.r)), a * 0.95);
      float b = smoothstep(0.0, 0.7, s2.g) * m.g;
      paper = mix(paper, mix(vec3(0.22, 0.32, 0.6), vec3(0.05, 0.14, 0.45), smoothstep(0.3, 1.0, s2.g)), b * 0.95);
      paper += vec3(0.5, 0.3, 0.0) * uGlow * (a + b) * 0.6;
      // Browning to toast, then char, mottled.
      paper = mix(paper, paper * vec3(0.7, 0.45, 0.22), smoothstep(0.0, 0.85, dn));
      paper = mix(paper, vec3(0.1, 0.06, 0.035), smoothstep(0.95, 1.45, dn));
      paper = mix(paper, vec3(0.03, 0.022, 0.018), smoothstep(0.2, 0.46, hn)); // black lip round a hole
      vec3 pc = lin(paper);
      // Lit by the candle, and glowing through where the flame is right behind it.
      float thin = 1.0 - 0.8 * smoothstep(0.3, 1.2, dn);
      pc *= 0.32 + 0.75 * glow + 0.25 * exp(-dot(p - vec2(uCandle.x, uCandle.y + 0.3), p - vec2(uCandle.x, uCandle.y + 0.3)) * 1.2);
      pc *= 1.0 + vec3(0.35, 0.08, -0.15) * glow * thin;
      // Hot paper glows faintly before it scorches (the warning), char glows like embers.
      pc *= 1.0 + vec3(0.5, 0.05, -0.2) * smoothstep(0.5, 1.2, T) * thin;
      float cracks = smoothstep(0.45, 0.85, noise(uv * uCell * 1.3 + uTime * 0.4));
      vec3 emit = vec3(1.0, 0.25, 0.03) * smoothstep(0.6, 1.3, T) * smoothstep(1.0, 1.45, dn) * (0.25 + cracks) * 0.6;
      // Glowing ember rim right at the burn front.
      float rim = smoothstep(0.3, 0.46, hn) * smoothstep(0.52, 0.46, hn);
      emit += blackbody(0.3 + T * 0.3) * rim * smoothstep(0.1, 0.7, T) * 1.1;
      emit += blackbody(0.45 + 0.45 * fire) * smoothstep(0.0, 0.45, fire) * (0.35 + 0.65 * noise(uv * uCell * 0.7 + vec2(0.0, -uTime * 5.0))) * 0.7;
      // Burning paper is dark underneath its glow; compress so the glow stays orange, not white.
      pc = pc * (1.0 - smoothstep(0.0, 0.4, fire) * 0.8) + emit / (1.0 + 0.8 * max(emit.r, 0.0));
      col = mix(col, pc, smoothstep(0.0, 0.0015, edge));
    }
  }

  // Flames licking up from burning paper, past the top edge too.
  if (uFireOn > 0.5 && uv.x > -0.05 && uv.x < 1.05 && uv.y > -0.05 && uv.y < 1.3) {
    float acc = 0.0;
    float stepY = 0.012 / (2.0 * uSheet.w);
    float j = hash(gl_FragCoord.xy + fract(uTime * 7.0)); // dithered taps: no banding
    float sway = (noise(vec2(uv.y * 14.0 - uTime * 3.0, uTime)) - 0.5) * 0.02;
    for (int k = 0; k < 7; k++) {
      float fk = float(k) + j;
      vec2 tu = uv - vec2(sway * fk / 7.0, stepY * fk);
      if (tu.x > 0.0 && tu.x < 1.0 && tu.y > 0.0 && tu.y < 1.0) acc += smoothstep(0.0, 0.4, texture(uS1, tu).b) * (1.0 - fk / 8.0);
    }
    float n = noise(vec2(uv.x * uCell.x * 0.5, uv.y * uCell.y * 0.3 - uTime * 6.0));
    float t = acc * (0.15 + 1.2 * n * n) * 0.5;
    // Composited over (not added), so the flames stay orange against bright paper.
    float fa = smoothstep(0.15, 0.6, t) * 0.85;
    col = mix(col, blackbody(0.3 + t * 0.45) * (0.8 + 0.4 * n), fa);
  }

  col = candle(p, col);
  vec2 fd = p - vec2(uCandle.x + uFlame.y * 0.04 * uFlame.x, uCandle.y + 0.08 * uFlame.x);
  float aura = exp(-dot(fd, fd * vec2(1.6, 0.7)) / (0.006 * uFlame.x)) * (0.85 + 0.15 * uFlame.z);
  col = col * (1.0 - fl.a) + fl.rgb + vec3(1.0, 0.42, 0.12) * aura * 0.22;

  // Filmic curve, gamma, vignette, dither.
  col = clamp((col * (2.51 * col + 0.03)) / (col * (2.43 * col + 0.59) + 0.14), 0.0, 1.0);
  col = sqrt(col);
  vec2 vq = gl_FragCoord.xy / (uPx * uWorld) - 0.5;
  col *= 1.0 - 0.35 * dot(vq, vq) * 1.6;
  col += (hash(gl_FragCoord.xy + fract(uTime)) - 0.5) / 255.0;
  fragColor = vec4(col, 1.0);
}`;

/** Embers (additive) and smoke (premultiplied over), one point each: x, y (world), life 0..1, size, kind. */
export const partVert = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aP;
layout(location = 1) in float aKind;
uniform vec2 uWorld;
uniform float uPx;
out float vLife;
out float vKind;
void main() {
  vLife = aP.z;
  vKind = aKind;
  gl_Position = vec4(aP.xy / uWorld * 2.0 - 1.0, 0.0, 1.0);
  float grow = aKind > 0.5 ? (1.0 + (1.0 - aP.z) * 3.0) : 1.0;
  gl_PointSize = aP.w * uPx * grow;
}`;

export const partFrag = /* glsl */ `#version 300 es
precision highp float;
in float vLife;
in float vKind;
out vec4 fragColor;
uniform float uPass; // 0 embers, 1 smoke
void main() {
  if (abs(vKind - uPass) > 0.5) discard;
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float r = dot(p, p);
  if (uPass < 0.5) {
    float a = smoothstep(1.0, 0.0, r);
    float t = clamp(vLife, 0.0, 1.0);
    vec3 c = mix(vec3(1.0, 0.2, 0.02), vec3(1.0, 0.85, 0.45), t);
    fragColor = vec4(c * a * (0.5 + t), 1.0);
  } else {
    float a = smoothstep(1.0, 0.1, r) * 0.22 * sin(3.14159 * clamp(vLife, 0.0, 1.0));
    fragColor = vec4(vec3(0.16, 0.13, 0.11) * a, a);
  }
}`;
