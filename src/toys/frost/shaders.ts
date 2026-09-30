// GLSL for Frost Window. The pane is a hexagonal lattice stored in "odd-r" offset rows (odd rows sit
// half a cell right); shaders convert to axial coordinates for neighbour arithmetic.
//
// State A (RGBA32F): r = Reiter mass s (vapour on non-receptive cells, accumulated water on receptive
//                    ones; s >= 1 is ice), g = fog (condensed droplets), b = heat above the pane's
//                    temperature, a = scratch (nucleation seam strength).
// State B (RGBA32F): r = liquid film (melt water), g = step the cell froze, b = glaze (clear refrozen
//                    ice), a = crystal id (inherited from the nucleus, sets each crystal's glint).

export const MAX_STAMPS = 24;

export const quadVert = /* glsl */ `#version 300 es
layout(location = 0) in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const hash = /* glsl */ `
float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1, 0)), f.x), mix(hash12(i + vec2(0, 1)), hash12(i + vec2(1, 1)), f.x), f.y);
}
`;

/** One lattice step: Reiter's local rule for vapour diffusion and attachment, plus the pane's fog, heat and melt water. */
export const stepFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uA;
uniform highp sampler2D uB;
uniform ivec2 uSize;
uniform float uStep;
uniform vec4 uP;      // alpha (diffusion), gamma (background supply), Sw (vapour the cold pane holds), kappa (air exchange)
uniform vec4 uQ;      // H (room air vapour), nucleation threshold on scratches, nucleation rate, refreeze rate
uniform vec4 uBreath; // plume centre (cells), radius, strength
uniform float uTime;
uniform int uN;
uniform vec4 uSA[${MAX_STAMPS}];
uniform vec4 uSB[${MAX_STAMPS}];
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
${hash}
uint pcg(uint v) {
  uint st = v * 747796405u + 2891336453u;
  uint w = ((st >> ((st >> 28u) + 4u)) ^ st) * 277803737u;
  return (w >> 22u) ^ w;
}
const ivec2 D[6] = ivec2[6](ivec2(1, 0), ivec2(1, -1), ivec2(0, -1), ivec2(-1, 0), ivec2(-1, 1), ivec2(0, 1));
const float WARM = 0.12;
const float MELT = 0.22;

ivec2 toOff(ivec2 a) { return clamp(ivec2(a.x + (a.y - (a.y & 1)) / 2, a.y), ivec2(0), uSize - 1); }
vec4 fa(ivec2 ax) { return texelFetch(uA, toOff(ax), 0); }

float segDist(vec2 p, vec2 a, vec2 d) {
  float t = clamp(dot(p - a, d) / max(dot(d, d), 1e-6), 0.0, 1.0);
  return length(p - a - d * t);
}

void main() {
  ivec2 o = ivec2(gl_FragCoord.xy);
  ivec2 ax = ivec2(o.x - (o.y - (o.y & 1)) / 2, o.y);
  vec4 a = texelFetch(uA, o, 0);
  vec4 b = texelFetch(uB, o, 0);
  vec2 ph = vec2(float(o.x) + 0.5 * float(o.y & 1), float(o.y) * 0.8660254);

  // Ice flags on the two rings: a neighbour is receptive if it or any of its own neighbours is ice.
  vec4 an[6];
  bool fn[6], fc[6], fe[6];
  bool anyN = false;
  for (int i = 0; i < 6; i++) {
    an[i] = fa(ax + D[i]);
    fn[i] = an[i].r >= 1.0;
    anyN = anyN || fn[i];
  }
  for (int i = 0; i < 6; i++) {
    fc[i] = fa(ax + 2 * D[i]).r >= 1.0;
    fe[i] = fa(ax + D[i] + D[(i + 1) % 6]).r >= 1.0;
  }
  bool fz = a.r >= 1.0;
  float heat = a.b;
  bool rc = fz || (anyN && heat < WARM);

  // Reiter: receptive cells keep their water out of the diffusing field (u = 0 there).
  float sumU = 0.0, sumH = 0.0;
  for (int i = 0; i < 6; i++) {
    bool rn = fn[i] || (an[i].b < WARM && (fz || fn[(i + 5) % 6] || fn[(i + 1) % 6] || fc[i] || fe[i] || fe[(i + 5) % 6]));
    sumU += rn ? 0.0 : an[i].r;
    sumH += an[i].b;
  }
  float alpha = uP.x, gam = uP.y, Sw0 = uP.z, kap = uP.w;
  // The glass is coldest at the frame and near the bottom (cold air sinks); warmth raises what it holds.
  vec2 uv = (vec2(o) + 0.5) / vec2(uSize);
  float edge = 1.0 - smoothstep(0.0, 0.08, min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y) * 2.1));
  float Sw = Sw0 * (1.0 - 0.1 * edge - 0.05 * (1.0 - uv.y)) * (1.0 + 2.5 * max(heat, 0.0));

  // Breath: a warm, humid plume rising from low on the pane, torn up by turbulence.
  vec2 bq = (ph - uBreath.xy) / max(uBreath.z, 1.0);
  bq.y = bq.y > 0.0 ? bq.y * 0.55 : bq.y * 1.3;
  float turb = vnoise(ph * 0.045 + vec2(0.0, -uTime * 0.9)) * 0.7 + vnoise(ph * 0.11 + vec2(uTime * 0.4, -uTime * 1.7)) * 0.5;
  float plume = uBreath.w * exp(-dot(bq, bq) * 1.6) * (0.35 + turb);
  float Hloc = uQ.x + plume * 1.4;
  float breathIn = plume * 0.002;

  float s = a.r, fog = a.g, wet = b.r, glaze = b.b;
  float froze = b.g, id = b.a;
  // Integer hash: rare events (nucleation) need a uniform tail far below float hash resolution.
  float rnd = float(pcg(uint(o.x) + uint(o.y) * 4099u + pcg(uint(uStep)))) * (1.0 / 4294967296.0);
  if (rc) {
    // Background supply (gamma) scales with the vapour in the air over this spot, with a little
    // per-cell noise so arms side-branch instead of growing as perfect hexagons.
    float supply = clamp(Hloc / Sw0, 0.0, 2.5) * (0.6 + 0.8 * hash12(vec2(o) * 1.37));
    float g = heat < WARM ? gam * supply : 0.0;
    // Supercooled fog droplets that touch the front freeze onto it.
    float take = heat < WARM ? fog * 0.004 : 0.0;
    fog -= take;
    s = s + g + alpha * 0.5 * sumU / 6.0 + take * 0.5;
  } else {
    s = s + alpha * 0.5 * (sumU / 6.0 - s);
    s += kap * (uQ.x - s) + breathIn;
    // Above what the glass holds, vapour condenses as fog; below it, fog evaporates back. Ice keeps
    // the vapour near it low, so fog clears around growing frost (the Bergeron process).
    if (s > Sw) {
      float c = (s - Sw) * 0.12;
      s -= c;
      fog += c;
    } else {
      float e = min(fog, (Sw - s) * 0.0004);
      fog -= e;
      s += e;
    }
    // Heterogeneous nucleation on scratches, grease lines and the frame.
    if (a.a > 0.01 && heat < WARM && s > uQ.y && rnd < uQ.z * a.a * (s - uQ.y) / max(0.05, Sw0 - uQ.y)) {
      s = 1.0;
      id = hash12(vec2(o) * 0.37 + uStep);
    }
  }
  // Heat spreads through the glass and leaks back to the pane's temperature.
  heat += 0.35 * (sumH / 6.0 - heat) - heat * 0.004;
  // Warm glass: fog coalesces into a water film, ice melts at a ragged edge.
  if (heat > 0.04) {
    float c = fog * min(1.0, heat * 0.06);
    fog -= c;
    wet += c * 1.4;
  }
  if (s >= 1.0 && heat > MELT && rnd < (heat - MELT) * 0.35) {
    wet += min(s, 2.5) * 0.35;
    s = min(Sw0, 0.4);
    glaze = 0.0;
  }
  // Heavy fog runs together into a film.
  if (fog > 1.5) {
    float c = (fog - 1.5) * 0.004;
    fog -= c;
    wet += c * 1.4;
  }
  // Melt water refreezes from the edge of neighbouring ice inwards, rarely on its own.
  if (s < 1.0 && wet > 0.04 && heat < 0.03 && rnd < uQ.w * (anyN ? 1.0 : 0.00006)) {
    s = 1.0 + min(wet, 1.5) * 0.5;
    glaze = min(1.0, wet * 1.5);
    wet = 0.0;
    id = anyN ? -1.0 : hash12(vec2(o) + uStep);
  }
  wet -= wet * 0.0015 * max(heat, 0.05);

  // Finger lines, warmth and droplet trails, applied on the first step of the frame.
  for (int k = 0; k < ${MAX_STAMPS}; k++) {
    if (k >= uN) break;
    vec4 sa = uSA[k], sb = uSB[k];
    int kind = int(sa.w);
    float d = kind == 1 || kind >= 3 ? length(ph - sa.xy) : segDist(ph, sa.xy, sb.yz);
    if (d > sa.z * 1.6) continue;
    if (kind == 0) {
      // A fingertip wipes fog (pushing some into a wet bead), scrapes frost and leaves a greasy seam.
      float w = smoothstep(sa.z, sa.z * 0.55, d) * sb.x;
      float rim = smoothstep(sa.z * 1.5, sa.z * 1.05, d) - smoothstep(sa.z * 1.05, sa.z * 0.7, d);
      wet += fog * w * 0.25 + rim * 0.07 * sb.x;
      fog *= 1.0 - w;
      if (s >= 1.0 && w > 0.5) {
        wet += 0.25;
        s = 0.3;
        glaze = 0.0;
      }
      if (s < 1.0) s = min(s, mix(s, Sw0 * 0.9, w));
      a.a = max(a.a, smoothstep(sa.z * 1.1, sa.z * 0.2, d) * sb.w);
      heat += w * 0.01;
    } else if (kind == 1) {
      heat += sb.x * exp(-d * d / (sa.z * sa.z));
    } else if (kind == 2) {
      // A running drop: clears a track, leaves a thin film behind and wets away frost it crosses.
      float w = smoothstep(sa.z, sa.z * 0.4, d);
      fog *= 1.0 - w;
      wet = max(wet, w * sb.x);
      if (s >= 1.0 && w > 0.6 && rnd < 0.5) {
        s = 0.3;
        wet += 0.2;
      }
      a.a = max(a.a, w * 0.5);
    } else if (kind == 3) {
      // A drop that stopped and froze where it sat: a clear bead of ice.
      if (d < sa.z) {
        if (s < 1.0) froze = uStep;
        s = max(s, 1.6);
        glaze = 1.0;
        wet = 0.0;
        fog = 0.0;
        id = sb.w;
      }
    } else if (kind == 4) {
      wet *= smoothstep(sa.z * 0.5, sa.z, d);
    }
  }
  if (a.r < 1.0 && s >= 1.0) {
    froze = uStep;
    if (id < 0.0 || id == b.a) {
      // Grown onto an existing crystal: take its id.
      float best = 0.0;
      for (int i = 0; i < 6; i++) if (fn[i]) best = max(best, texelFetch(uB, toOff(ax + D[i]), 0).a);
      id = best > 0.0 ? best : hash12(vec2(o) + 3.1);
    }
  }
  oA = vec4(min(s, 4.0), clamp(fog, 0.0, 2.0), clamp(heat, -0.2, 3.0), a.a);
  oB = vec4(clamp(wet, 0.0, 2.0), froze, glaze, id);
}
`;

/** Fresh pane: vapour at the room's level, a light fog low down, the frame and old scratches as seams. */
export const initFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform ivec2 uSize;
uniform float uH;
uniform float uSeed;
layout(location = 0) out vec4 oA;
layout(location = 1) out vec4 oB;
${hash}
void main() {
  ivec2 o = ivec2(gl_FragCoord.xy);
  vec2 uv = (vec2(o) + 0.5) / vec2(uSize);
  vec2 ph = vec2(float(o.x) + 0.5 * float(o.y & 1), float(o.y) * 0.8660254);
  float frame = min(min(o.x, uSize.x - 1 - o.x), min(o.y, uSize.y - 1 - o.y)) < 2 ? 1.0 : 0.0;
  float n = vnoise(ph * 0.03 + uSeed) * 0.6 + vnoise(ph * 0.09 - uSeed) * 0.4;
  float fog = max(0.0, (0.55 - uv.y) * 0.5) * smoothstep(0.35, 0.7, n) + 0.02;
  // The frame seeds frost in patches (where the putty is rough), not evenly all round.
  float seam = frame * smoothstep(0.6, 0.9, vnoise(ph * 0.05 + uSeed * 3.0));
  oA = vec4(uH, fog, 0.0, seam);
  oB = vec4(0.0);
}
`;

/** Block sums for the CPU: ice cells, cells frozen since the last read, fog, film. */
export const sumFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uA;
uniform highp sampler2D uB;
uniform ivec2 uSize;
uniform ivec2 uBlock;
uniform float uSince;
out vec4 oC;
void main() {
  ivec2 bo = ivec2(gl_FragCoord.xy) * uBlock;
  vec4 acc = vec4(0.0);
  for (int y = 0; y < 128; y++) {
    if (y >= uBlock.y) break;
    for (int x = 0; x < 128; x++) {
      if (x >= uBlock.x) break;
      ivec2 c = min(bo + ivec2(x, y), uSize - 1);
      vec4 a = texelFetch(uA, c, 0);
      vec4 b = texelFetch(uB, c, 0);
      float ice = a.r >= 1.0 ? 1.0 : 0.0;
      acc += vec4(ice, ice * step(uSince, b.g), a.g, b.r);
    }
  }
  oC = acc;
}
`;

/** The night outside: sky, rooftops, a sodium streetlight and falling snow; bl blurs it (fog, frost). */
const scene = /* glsl */ `
uniform vec2 uWorld;   // screen size in short-side units
uniform vec2 uLamp;    // lamp position (world)
uniform float uTime;
vec3 LAMP = vec3(1.0, 0.66, 0.3);
float lampGlow(vec2 q, float bl) {
  float d = length(q - uLamp);
  float sg = 0.012 + 0.09 * bl;
  return exp(-d * d / (2.0 * sg * sg)) * (0.012 * 0.012) / (sg * sg) * 3.0 + exp(-d / (0.16 + 0.18 * bl)) * (0.22 + 0.25 * bl) + exp(-d / 0.6) * 0.05;
}
vec3 scene(vec2 q, float bl) {
  float Y = uWorld.y;
  vec3 col = mix(vec3(0.03, 0.045, 0.09), vec3(0.01, 0.015, 0.04), clamp(q.y / Y, 0.0, 1.0));
  // Snowy ground lit by the lamp, then a row of dark houses with a few lit windows.
  float soft = 0.004 + 0.05 * bl;
  float ground = Y * 0.2;
  float gx = q.x - uLamp.x;
  vec3 snow = vec3(0.1, 0.11, 0.16) + LAMP * 0.55 * exp(-(gx * gx) / 0.06 - pow((q.y - ground * 0.6) / (ground * 0.8), 2.0));
  float cellX = floor(q.x * 3.2);
  float hx = fract(q.x * 3.2);
  float h = Y * (0.3 + 0.1 * hash12(vec2(cellX, 3.0)));
  float roof = h + (0.5 - abs(hx - 0.5)) * 0.12 * step(0.35, hash12(vec2(cellX, 7.0)));
  float house = smoothstep(roof + soft, roof - soft, q.y) * smoothstep(ground - soft, ground + soft, q.y);
  vec3 wall = vec3(0.012, 0.014, 0.03);
  // Windows: 2x2 per house, some lit warm.
  vec2 wq = vec2(hx * 4.0, (q.y - ground) / (h - ground) * 3.0);
  vec2 wi = floor(wq), wf = fract(wq);
  float lit = step(0.62, hash12(vec2(cellX * 4.0 + wi.x, wi.y + 11.0))) * step(0.5, wi.x) * step(wi.x, 2.5) * step(0.5, wi.y) * step(wi.y, 2.2);
  float wbox = smoothstep(0.5, 0.5 - 0.1 - bl * 1.5, max(abs(wf.x - 0.5) * 1.6, abs(wf.y - 0.5) * 1.3));
  wall += vec3(1.0, 0.7, 0.35) * lit * wbox * (0.35 - 0.2 * bl);
  col = mix(col, wall, house);
  col = mix(col, snow, smoothstep(ground + soft, ground - soft, q.y));
  // The lamp post.
  float post = smoothstep(0.004 + soft, soft * 0.5, abs(q.x - uLamp.x - (uLamp.y - q.y) * 0.02)) * step(q.y, uLamp.y) * step(ground * 0.5, q.y);
  col = mix(col, vec3(0.005), post * (1.0 - bl * 0.8));
  // Snow drifting through the light.
  for (int l = 0; l < 2; l++) {
    float sc = l == 0 ? 22.0 : 13.0;
    vec2 sp = q * sc + vec2(sin(uTime * 0.3 + float(l)) * 0.8, uTime * (l == 0 ? 0.9 : 1.6));
    vec2 ci = floor(sp), cf = fract(sp) - 0.5;
    float r = hash12(ci + float(l) * 17.0);
    vec2 off = vec2(hash12(ci + 3.3), hash12(ci + 5.7)) - 0.5;
    float fl = step(0.7, r) * smoothstep(0.09 + bl * 0.4, 0.0, length(cf - off * 0.6));
    col += fl * (0.05 + LAMP * lampGlow(q, 0.8) * 1.5) * (1.0 - bl * 0.6);
  }
  col += LAMP * lampGlow(q, bl);
  return col;
}
`;

/** Composite: the night through glass, fog scattering the lamp, faceted ice with refraction and glints. */
export const compFrag = /* glsl */ `#version 300 es
precision highp float;
precision highp int;
uniform highp sampler2D uA;
uniform highp sampler2D uB;
uniform ivec2 uSize;
uniform float uCellPx;
uniform float uPx;
uniform float uStep;
uniform float uFrame;
out vec4 fragColor;
${hash}
${scene}
ivec2 toOff(ivec2 a) { return clamp(ivec2(a.x + (a.y - (a.y & 1)) / 2, a.y), ivec2(0), uSize - 1); }
void main() {
  vec2 frag = gl_FragCoord.xy;
  vec2 q = frag / uPx;
  // Pixel -> hex lattice (axial basis), then the lattice triangle that contains it.
  vec2 ph = frag / uCellPx;
  float bb = ph.y / 0.8660254;
  float aa = ph.x - 0.5 * bb;
  vec2 fl = floor(vec2(aa, bb));
  vec2 fr = vec2(aa, bb) - fl;
  ivec2 c0 = ivec2(fl);
  bool up = fr.x + fr.y > 1.0;
  ivec2 p0 = up ? c0 + ivec2(1, 1) : c0;
  ivec2 p1 = c0 + ivec2(1, 0);
  ivec2 p2 = c0 + ivec2(0, 1);
  vec3 w = up ? vec3(fr.x + fr.y - 1.0, 1.0 - fr.y, 1.0 - fr.x) : vec3(1.0 - fr.x - fr.y, fr.x, fr.y);
  vec4 A0 = texelFetch(uA, toOff(p0), 0), A1 = texelFetch(uA, toOff(p1), 0), A2 = texelFetch(uA, toOff(p2), 0);
  vec4 B0 = texelFetch(uB, toOff(p0), 0), B1 = texelFetch(uB, toOff(p1), 0), B2 = texelFetch(uB, toOff(p2), 0);
  vec3 ice3 = vec3(A0.r, A1.r, A2.r);
  vec3 cov3 = clamp((ice3 - 0.97) * 30.0, 0.0, 1.0);
  vec3 th3 = cov3 * (0.6 + clamp(ice3 - 1.0, 0.0, 2.0) * 0.6);
  float cov = smoothstep(0.2, 0.8, dot(w, cov3));
  float thick = dot(w, th3);
  float fog = dot(w, vec3(A0.g, A1.g, A2.g));
  float heat = dot(w, vec3(A0.b, A1.b, A2.b));
  float wet = dot(w, vec3(B0.r, B1.r, B2.r));
  float glaze = dot(w, vec3(B0.b, B1.b, B2.b));
  float froze = max(max(B0.g * cov3.x, B1.g * cov3.y), B2.g * cov3.z);
  // Nearest corner's crystal id picks this facet's orientation.
  float id = w.x > w.y && w.x > w.z ? B0.a : (w.y > w.z ? B1.a : B2.a);
  // Faceted gradient of the ice thickness: flat within each lattice triangle, like cut crystal.
  float da = up ? th3.x - th3.z : th3.y - th3.x;
  float db = up ? th3.x - th3.y : th3.z - th3.x;
  vec2 grad = vec2(da, -0.57735 * da + 1.1547 * db);

  float fogO = 1.0 - exp(-fog * 4.5);
  float wetO = clamp(wet * 3.0, 0.0, 1.0);
  // Film ripples refract a little; ice refracts along its facets.
  vec2 wn = vec2(vnoise(ph * 0.35 + 3.0) - 0.5, vnoise(ph * 0.35 + 9.0) - 0.5);
  vec2 refr = grad * 0.018 * (1.0 - glaze * 0.5) + wn * 0.02 * wetO;
  float bl = clamp(fogO * 0.95 + cov * (0.35 - 0.3 * glaze), 0.0, 1.0);
  vec3 col = scene(q + refr, bl);

  // Fog: tiny droplets scatter the lamp into a broad halo and dim everything behind.
  float grain = 0.85 + 0.3 * hash12(floor(frag / max(1.0, uPx * 0.004)));
  float lampI = lampGlow(q, 1.0);
  vec3 fogCol = vec3(0.07, 0.08, 0.1) + LAMP * lampI * 1.2 + vec3(0.02, 0.025, 0.04) * (1.0 - q.y / uWorld.y);
  col = mix(col, col * 0.3 + fogCol * grain, fogO * 0.88);
  // A water film: clearer, with a bright rim where it ends.
  col += LAMP * lampI * wetO * 0.15;

  // Ice: white where thick and feathery, clear where glazed, lit from behind by the lamp.
  // Lit from behind by the lamp and faintly from the room side.
  vec3 iceBase = vec3(0.7, 0.78, 0.9) * (0.26 + 1.2 * lampI) + vec3(0.05, 0.06, 0.09);
  float iceO = cov * (0.5 + 0.4 * clamp(thick, 0.0, 1.0)) * (1.0 - 0.7 * glaze);
  col = mix(col, iceBase + col * 0.4, iceO);
  // Specular off each facet toward the lamp, and fresh growth fronts glowing briefly.
  vec3 n = normalize(vec3(-grad * 1.5, 1.0));
  vec3 L = normalize(vec3(uLamp - q, 0.6));
  vec3 H = normalize(L + vec3(0.0, 0.0, 1.0));
  float orient = fract(id * 7.13);
  float spec = pow(max(dot(n, H), 0.0), 40.0 + 60.0 * orient) * cov;
  col += LAMP * spec * (0.2 + 1.8 * lampI) * (0.4 + glaze);
  float fresh = cov * exp(-max(0.0, uStep - froze) / 90.0) * step(1.0, froze);
  col += vec3(0.6, 0.8, 1.0) * fresh * 0.35;
  // Glints: a few facets catch the light as it shimmers through the snow outside.
  float gl = hash12(vec2(toOff(p0)) + floor(uFrame / 20.0 + orient * 3.0) * 1.7);
  float glint = step(0.994 - 0.006 * lampI, gl) * cov * clamp(length(grad) * 2.0, 0.0, 1.0);
  col += (vec3(0.9, 0.95, 1.0) + LAMP) * glint * (0.35 + 1.5 * lampI);

  // Wet glass: a faint sheen and the lamp's glint in the film.
  col += vec3(0.02, 0.025, 0.035) * wetO + LAMP * pow(max(0.0, 1.0 - length(q - uLamp) * 2.0), 3.0) * wetO * 0.3;
  float fx = min(q.x, uWorld.x - q.x), fy = min(q.y, uWorld.y - q.y);
  float fw = 0.022;
  float frameM = smoothstep(fw, fw - 0.003, min(fx, fy));
  vec3 frameC = vec3(0.035, 0.03, 0.028) * (0.7 + 0.6 * (min(fx, fy) / fw)) + LAMP * lampGlow(q, 1.0) * 0.1;
  col = mix(col, frameC, frameM);
  // Tonemap.
  col = col / (1.0 + col * 0.55);
  fragColor = vec4(pow(col, vec3(0.9)), 1.0);
}
`;

/** Water drops: lenses that show the night upside down, with a bright rim and a highlight. */
export const dropVert = /* glsl */ `#version 300 es
layout(location = 0) in vec4 aDrop; // x, y (world), radius (world), stretch
uniform vec2 uWorld;
uniform float uPx;
out vec2 vC;
out float vR;
out float vS;
void main() {
  vC = aDrop.xy;
  vR = aDrop.z;
  vS = aDrop.w;
  gl_Position = vec4(aDrop.xy / uWorld * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = aDrop.z * 2.0 * (1.0 + aDrop.w) * uPx + 2.0;
}
`;

export const dropFrag = /* glsl */ `#version 300 es
precision highp float;
uniform float uPx;
in vec2 vC;
in float vR;
in float vS;
out vec4 fragColor;
${hash}
${scene}
void main() {
  vec2 q = gl_FragCoord.xy / uPx;
  vec2 d = (q - vC) / vR;
  // Moving drops pull into a teardrop: narrow, with a tail above.
  float s = 1.0 + vS;
  d.x *= s * 0.9;
  d.y = d.y > 0.0 ? d.y / s : d.y * 1.1;
  float r2 = dot(d, d);
  if (r2 > 1.0) discard;
  float z = sqrt(1.0 - r2);
  // A lens: the scene flipped and shrunk through the drop.
  vec3 col = scene(vC - d * vR * 6.0, 0.5) * 1.1 + vec3(0.03, 0.035, 0.05);
  // The rim gathers light from all around it (and from the room behind you).
  float rim = pow(1.0 - z, 2.0);
  col += (LAMP * lampGlow(vC, 1.0) * 1.2 + vec3(0.12, 0.14, 0.18)) * rim * smoothstep(1.0, 0.7, r2);
  col *= 1.0 - 0.5 * smoothstep(0.75, 1.0, r2) * (1.0 - rim);
  vec2 hl = d - vec2(-0.35, 0.4);
  col += LAMP * lampGlow(vC, 0.6) * 1.5 * exp(-dot(hl, hl) * 18.0) + vec3(0.85, 0.92, 1.0) * exp(-dot(hl, hl) * 70.0) * 0.9;
  // The lamp's own image, small and bright, on the far side of the lens.
  vec2 li = d - normalize(uLamp - vC + 1e-4) * -0.45;
  col += LAMP * exp(-dot(li, li) * 90.0) * 0.8;
  float a = smoothstep(1.0, 0.85, r2);
  fragColor = vec4(col * a, a);
}
`;
