// Vendored subset of the Mixwell brush library (GLSL), adapted for WebGL2 / GLSL ES 3.00.
// Source: https://github.com/dougjam/mixwell-2026 (public/code/glsl/MixwellBrush.glsl)
// Paper: "Mixwell", Doug L. James and Ethan James, SIGGRAPH 2026. https://dougjam.github.io/mixwell-2026/
//
// Changes: kept only sdSegment, rot90, rdLine1DS, getMixwellBrushMatrix, the adaptive-midpoint brush
// integrator and rdSegment; the integrator got an iteration cap (MAX_BRUSH_STEPS) and a slightly larger
// step factor so a fragment's loop stays bounded on phone GPUs.
//
// ---------------------------------------------------------------------------------------------
// MIT License
//
// Copyright (c) 2026 Doug L. James and Ethan James
//
// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:
//
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.
//
// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.
// ---------------------------------------------------------------------------------------------

export const mixwellGlsl = /* glsl */ `
const float MW_PI = 3.14159265358979323846;
const float RDSEGMENT_MASK_R_FACTOR = 10.0;
const int MAX_BRUSH_STEPS = 160;

float sdSegment(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a;
  vec2 ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return length(pa - ba * h);
}

vec2 rot90(vec2 v) { return vec2(-v.y, v.x); }

// Line RDF: matched series approximation to 1D drift past a cylinder of radius r.
float rdLine1DS(float height, float r) {
  float y = height / r;
  float dx = 0.0;
  float eps = 0.002;
  y = sqrt(y * y + eps * eps);
  if (y > 6.50416858646776) {
    float h = 1.0 / y;
    float h2 = h * h;
    float h3 = h * h2;
    float poly = ((((6615.0 * h2 - 1960.0) * h2 + 600.0) * h2 - 192.0) * h2 + 64.0);
    dx = -(MW_PI / 256.0) * h3 * poly;
  } else if (y > 0.8220844420096408) {
    float dy = y - 2.3;
    float num = (((((-1.01973e-7 * dy + 1.77539e-6) * dy - 0.0068946) * dy - 0.043355) * dy - 0.0937878) * dy - 0.0413839);
    float den = ((((((0.00875686 * dy + 0.115772) * dy + 0.665761) * dy + 2.08615) * dy + 3.66495) * dy + 3.26035) * dy + 1.0);
    dx = num / den;
  } else {
    float z = y * y;
    float A = ((((0.00015811568 * z - 0.00096477622) * z + 0.0076619254) * z - 0.16369764) * z - 0.039720771);
    float B = ((((-0.00018775463 * z + 0.0010681152) * z - 0.0073242188) * z + 0.09375) * z + 0.5);
    dx = A + B * log(y);
  }
  return 2.0 * r * dx;
}

mat2 getMixwellBrushMatrix(vec2 v, float eps) {
  float R2 = dot(v, v);
  float e2 = eps * eps;
  float s = R2 + e2;
  float invSqrtS = inversesqrt(s);
  float invS = invSqrtS * invSqrtS;
  float invD = invS * invSqrtS;
  float invR = inversesqrt(max(R2, 1e-20));
  float R = R2 * invR;
  float Afd = 1.0 - R * (R2 + 2.0 * e2) * invD;
  float Bfd = e2 * invR * invD;
  float xx = Bfd * v.x * v.x;
  float xy = Bfd * v.x * v.y;
  float yy = Bfd * v.y * v.y;
  return mat2(Afd + xx, xy, xy, Afd + yy);
}

// Reverse drift through the Mixwell flow of a radius-eps brush moving a -> b (adaptive midpoint).
vec2 rdMixwellBrushAdaptiveMidpoint(vec2 p0, float eps, vec2 a, vec2 b) {
  vec2 uBrush = a - b;
  float L = length(uBrush);
  if (L <= 1e-20) return vec2(0.0);
  vec2 dir = uBrush / L;
  float distLeft = L;
  vec2 p = p0;
  for (int i = 0; i < MAX_BRUSH_STEPS; i++) {
    if (distLeft <= 0.0) break;
    vec2 v = p - b;
    float R = length(v);
    float dL = min(distLeft, 0.12 * max(eps, R));
    distLeft -= dL;
    vec2 db = dL * dir;
    mat2 K = getMixwellBrushMatrix(v, eps);
    vec2 dp = K * db;
    vec2 vmid = v + 0.5 * (dp - db);
    mat2 Kmid = getMixwellBrushMatrix(vmid, eps);
    p += Kmid * db;
    b += db;
  }
  return p - p0;
}

// Combs a -> b with a tine of radius r (insert/remove flows at the ends), masked beyond 10 r.
vec2 rdSegment(vec2 p, float r, vec2 a, vec2 b) {
  float d = sdSegment(p, a, b);
  float dMax = RDSEGMENT_MASK_R_FACTOR * r;
  if (d >= dMax) return vec2(0.0);
  float mask = 1.0 - smoothstep(0.5 * dMax, dMax, d);
  return mask * rdMixwellBrushAdaptiveMidpoint(p, r, a, b);
}
`;
