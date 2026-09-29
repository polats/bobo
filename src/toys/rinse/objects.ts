// Procedural objects to clean, as 2D signed-distance shapes in "object space" (y up, roughly ±0.45).
// Each returns the silhouette SDF and writes the clean albedo, gloss, a region id (1..5, for the
// per-part completion pings) and a dome height used for fake 3D lighting and jet incidence.

export const OBJECTS = [
  { id: 'bobo', label: 'Bobo statue', regions: 3 },
  { id: 'duck', label: 'Rubber duck', regions: 4 },
  { id: 'gnome', label: 'Garden gnome', regions: 4 },
  { id: 'mosaic', label: 'Mosaic sign', regions: 5 },
] as const;

export const objectGlsl = /* glsl */ `
float hash21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash21(i), hash21(i + vec2(1, 0)), f.x), mix(hash21(i + vec2(0, 1)), hash21(i + vec2(1, 1)), f.x), f.y);
}
float fbm(vec2 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 4; i++) { s += a * vnoise(p); p = p * 2.03 + 17.1; a *= 0.5; }
  return s;
}
float sdCircle(vec2 p, float r) { return length(p) - r; }
float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdEllipse(vec2 p, vec2 r) { float k = length(p / r); return (k - 1.0) * min(r.x, r.y); }
float smin(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0); return mix(b, a, h) - k * h * (1.0 - h); }
float dot2(vec2 v) { return dot(v, v); }
float sdTri(vec2 p, vec2 p0, vec2 p1, vec2 p2) {
  vec2 e0 = p1 - p0, e1 = p2 - p1, e2 = p0 - p2;
  vec2 v0 = p - p0, v1 = p - p1, v2 = p - p2;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)), vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))), vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
// Heart with its tip at the origin, about 1 unit tall.
float sdHeart(vec2 p) {
  p.x = abs(p.x);
  if (p.y + p.x > 1.0) return sqrt(dot2(p - vec2(0.25, 0.75))) - sqrt(2.0) / 4.0;
  return sqrt(min(dot2(p - vec2(0.0, 1.0)), dot2(p - 0.5 * max(p.x + p.y, 0.0)))) * sign(p.x - p.y);
}
float sdStar(vec2 p, float r, float rf) {
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0, 1);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}
float dome(float d, float r) { return sqrt(clamp(-d / r, 0.0, 1.0)); }
float smax(float a, float b, float k) { float h = clamp(0.5 + 0.5 * (a - b) / k, 0.0, 1.0); return mix(b, a, h) + k * h * (1.0 - h); }

float objBobo(vec2 p, out vec3 col, out float gloss, out float reg, out float h) {
  vec2 q = p - vec2(0.0, -0.05);
  // One smooth blob (a gently squashed ellipse) so the fake dome lighting has no creases.
  vec2 qb = q - vec2(0.0, -0.02);
  qb.y *= 1.0 + 0.45 * smoothstep(0.05, -0.25, qb.y);
  qb.x *= 1.0 - 0.08 * smoothstep(0.0, 0.25, qb.y);
  float body = sdEllipse(qb, vec2(0.3, 0.28));
  float ped = sdBox(p - vec2(0.0, -0.34), vec2(0.34, 0.075), 0.025);
  if (body < ped) {
    col = mix(vec3(0.95, 0.24, 0.52), vec3(1.0, 0.6, 0.8), smoothstep(-0.25, 0.3, q.y));
    gloss = 0.9;
    reg = q.y > -0.03 ? 1.0 : 2.0;
    vec2 e = vec2(abs(q.x) - 0.095, q.y - 0.03);
    if (sdEllipse(e, vec2(0.04, 0.052)) < 0.0) col = vec3(0.16, 0.04, 0.18);
    if (length(e - vec2(0.013, 0.022)) < 0.014) col = vec3(1.0);
    if (sdEllipse(vec2(abs(q.x) - 0.17, q.y + 0.05), vec2(0.045, 0.024)) < 0.0) col = mix(col, vec3(1.0, 0.2, 0.45), 0.55);
    if (abs(sdCircle(q - vec2(0.0, 0.03), 0.075)) < 0.012 && q.y < 0.0) col = vec3(0.16, 0.04, 0.18);
    // Hidden under the mud: a gold heart on the belly.
    if (sdHeart((q - vec2(0.0, -0.22)) / 0.11) < 0.0) { col = vec3(1.0, 0.74, 0.18) * 1.7; gloss = 1.0; }
    h = dome(body, 0.34);
    return min(body, ped);
  }
  float vein = smoothstep(0.03, 0.0, abs(fbm(p * 9.0) - 0.5));
  col = mix(vec3(0.72, 0.72, 0.76), vec3(0.56, 0.56, 0.62), vein * 0.6);
  // Carved nameplate
  if (sdBox(p - vec2(0.0, -0.34), vec2(0.16, 0.035), 0.01) < 0.0) col = vec3(0.85, 0.66, 0.3);
  gloss = 0.25;
  reg = 3.0;
  h = dome(ped, 0.04) * 0.5;
  return min(body, ped);
}

float objDuck(vec2 p, out vec3 col, out float gloss, out float reg, out float h) {
  float body = smin(sdEllipse(p - vec2(-0.02, -0.05), vec2(0.3, 0.19)), sdCircle(p - vec2(-0.3, 0.04), 0.06), 0.06);
  float head = sdCircle(p - vec2(0.1, 0.18), 0.14);
  float beak = sdEllipse(p - vec2(0.27, 0.15), vec2(0.09, 0.042));
  float crate = sdBox(p - vec2(0.0, -0.36), vec2(0.3, 0.1), 0.015);
  float duck = smin(body, head, 0.05);
  float d = min(min(duck, beak), crate);
  if (crate < min(duck, beak)) {
    float plank = fract((p.y + 0.46) / 0.066);
    col = vec3(0.62, 0.4, 0.22) * (0.85 + 0.25 * vnoise(vec2(p.x * 40.0, floor((p.y + 0.46) / 0.066) * 7.0)));
    col *= mix(0.6, 1.0, smoothstep(0.0, 0.08, plank) * smoothstep(1.0, 0.92, plank));
    if (length(vec2(abs(p.x) - 0.26, fract((p.y + 0.46) / 0.066) * 0.066 - 0.033)) < 0.008) col = vec3(0.3);
    gloss = 0.15;
    reg = 4.0;
    h = dome(crate, 0.04) * 0.5;
    return d;
  }
  if (beak < duck) {
    col = vec3(1.0, 0.45, 0.08);
    gloss = 0.8;
    reg = 3.0;
    h = dome(beak, 0.04) * 0.8;
    return d;
  }
  col = vec3(1.0, 0.8, 0.1);
  gloss = 0.95;
  reg = head < body ? 1.0 : 2.0;
  // Wing crease and eye.
  if (abs(sdEllipse(p - vec2(-0.06, -0.06), vec2(0.15, 0.08))) < 0.01 && p.y > -0.1) col *= 0.8;
  if (length(p - vec2(0.15, 0.22)) < 0.025) col = vec3(0.05);
  if (length(p - vec2(0.157, 0.228)) < 0.008) col = vec3(1.0);
  // Hidden: a pink flower sticker on the side.
  vec2 f = p - vec2(-0.12, -0.1);
  float a = atan(f.y, f.x);
  float petals = length(f) - 0.055 * (0.65 + 0.35 * cos(a * 5.0));
  if (petals < 0.0) col = vec3(1.0, 0.45, 0.72);
  if (length(f) < 0.018) col = vec3(1.0, 0.95, 0.4);
  h = smax(dome(body, 0.26), dome(head, 0.17), 0.35);
  return d;
}

float objGnome(vec2 p, out vec3 col, out float gloss, out float reg, out float h) {
  float hat = sdTri(p, vec2(0.0, 0.54), vec2(-0.17, 0.2), vec2(0.17, 0.2)) - 0.015;
  float face = sdCircle(p - vec2(0.0, 0.14), 0.1);
  float beard = sdEllipse(p - vec2(0.0, 0.03), vec2(0.13, 0.14));
  float body = sdBox(p - vec2(0.0, -0.15), vec2(0.16, 0.13), 0.06);
  float boots = min(sdEllipse(p - vec2(-0.08, -0.29), vec2(0.07, 0.035)), sdEllipse(p - vec2(0.08, -0.29), vec2(0.07, 0.035)));
  float base = sdEllipse(p - vec2(0.0, -0.36), vec2(0.3, 0.07));
  float d = min(min(min(hat, face), min(beard, body)), min(boots, base));
  gloss = 0.7;
  if (hat <= d + 1e-4) {
    col = vec3(0.86, 0.14, 0.14);
    reg = 1.0;
    // Hidden: a gold star on the hat.
    if (sdStar(p - vec2(0.0, 0.34), 0.05, 0.45) < 0.0) { col = vec3(1.0, 0.8, 0.2); gloss = 1.0; }
    h = dome(hat, 0.12);
  } else if (face <= d + 1e-4 || beard <= d + 1e-4) {
    bool isFace = face < beard && p.y > 0.09;
    col = isFace ? vec3(1.0, 0.78, 0.66) : vec3(0.97, 0.96, 0.93) * (0.9 + 0.1 * vnoise(p * 60.0));
    if (length(p - vec2(0.0, 0.12)) < 0.035) col = vec3(0.98, 0.56, 0.5);
    if (length(vec2(abs(p.x) - 0.045, p.y - 0.165)) < 0.013) col = vec3(0.1);
    reg = 2.0;
    h = smax(dome(face, 0.12), dome(beard, 0.15), 0.35);
  } else if (body <= d + 1e-4) {
    col = vec3(0.18, 0.42, 0.85);
    if (abs(p.y + 0.18) < 0.025) col = vec3(0.25, 0.14, 0.08);
    if (sdBox(p - vec2(0.0, -0.18), vec2(0.03, 0.022), 0.004) < 0.0) col = vec3(1.0, 0.8, 0.25);
    reg = 3.0;
    h = dome(body, 0.16);
  } else if (boots <= d + 1e-4) {
    col = vec3(0.3, 0.18, 0.1);
    reg = 3.0;
    h = dome(boots, 0.03);
  } else {
    col = mix(vec3(0.24, 0.55, 0.2), vec3(0.4, 0.7, 0.3), vnoise(p * 30.0));
    gloss = 0.2;
    reg = 4.0;
    h = dome(base, 0.05) * 0.5;
  }
  return d;
}

float objMosaic(vec2 p, out vec3 col, out float gloss, out float reg, out float h) {
  vec2 c = p - vec2(0.0, 0.04);
  float frame = sdBox(c, vec2(0.38, 0.38), 0.03);
  float posts = min(sdBox(p - vec2(-0.26, -0.43), vec2(0.03, 0.08), 0.01), sdBox(p - vec2(0.26, -0.43), vec2(0.03, 0.08), 0.01));
  float d = min(frame, posts);
  float inner = sdBox(c, vec2(0.33, 0.33), 0.01);
  if (inner < 0.0) {
    float n = 9.0;
    vec2 g = (c + 0.33) / 0.66 * n;
    vec2 cell = floor(g);
    vec2 f = fract(g);
    vec2 cc = (cell + 0.5) / n * 0.66 - 0.33;
    bool heart = sdHeart((cc - vec2(0.0, -0.22)) / 0.42) < 0.0;
    float v = hash21(cell);
    col = heart ? mix(vec3(0.92, 0.12, 0.3), vec3(1.0, 0.45, 0.55), step(0.5, v)) : mix(vec3(0.1, 0.55, 0.62), vec3(0.2, 0.36, 0.78), v);
    float grout = smoothstep(0.0, 0.07, f.x) * smoothstep(1.0, 0.93, f.x) * smoothstep(0.0, 0.07, f.y) * smoothstep(1.0, 0.93, f.y);
    col = mix(vec3(0.85, 0.83, 0.78), col, grout);
    gloss = 0.85 * grout;
    reg = 1.0 + (c.x > 0.0 ? 1.0 : 0.0) + (c.y > 0.0 ? 2.0 : 0.0);
    h = 0.35 + 0.1 * grout;
    return d;
  }
  col = vec3(0.55, 0.34, 0.18) * (0.85 + 0.2 * vnoise(vec2(p.x * 6.0, p.y * 60.0)));
  gloss = 0.2;
  reg = 5.0;
  h = dome(min(frame, posts), 0.04) * 0.4;
  return d;
}

uniform int objId;
float objectSdf(vec2 p, out vec3 col, out float gloss, out float reg, out float h) {
  if (objId == 0) return objBobo(p, col, gloss, reg, h);
  if (objId == 1) return objDuck(p, col, gloss, reg, h);
  if (objId == 2) return objGnome(p, col, gloss, reg, h);
  return objMosaic(p, col, gloss, reg, h);
}
`;
