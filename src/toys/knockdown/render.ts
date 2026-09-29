import { compile, Program } from '../../shell/gl';

// Two draw calls: a full-screen stall backdrop (awning, painted plank wall, candy-striped posts,
// bulbs, and the jam decal texture), then every sprite as one instanced quad batch. Each sprite
// kind is a small SDF "material" in the fragment shader: tin can, glass jar, crate, plank, shard,
// ball, dot, rubber band and the counter front.

/** Instance layout: x, y, hx, hy | angle, kind, variation, alpha | r, g, b, extra.
 * For cans, jars and crates the variation slot is a shade (distance darkening). */
export const FLOATS = 12;
export const enum Sprite {
  Shadow = 0,
  Can = 1,
  Jar = 2,
  Crate = 3,
  Wood = 4,
  Shard = 5,
  Ball = 6,
  Dot = 7,
  Band = 8,
  Counter = 9,
}

/** The jam decal covers this world rectangle (metres) with a DECAL² texture. */
export const DECAL = 512;
export const DECAL_RECT = [-6, 2, 12, 16] as const;

const backVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aPosition;
out vec2 vUv;
void main() { vUv = aPosition * 0.5 + 0.5; gl_Position = vec4(aPosition, 0.0, 1.0); }`;

const backFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vUv;
uniform vec4 view;   // centre x, y, width, height (world metres)
uniform float time;
uniform float awning; // world y of the awning's lower edge
uniform float half_;  // stall half-width: where the posts stand
uniform vec4 decalRect;
uniform sampler2D decal;
out vec4 fragColor;
float hash(float n) { return fract(sin(n) * 43758.5453); }
void main() {
  vec2 w = view.xy + (vUv - 0.5) * view.zw;
  // Painted plank wall: warm boards with dark seams and a little grain.
  float board = floor(w.x / 0.62);
  float fx = fract(w.x / 0.62);
  vec3 col = mix(vec3(0.55, 0.2, 0.18), vec3(0.62, 0.25, 0.2), hash(board));
  col *= 0.94 + 0.06 * sin(w.y * 9.0 + hash(board) * 30.0 + sin(w.y * 1.7) * 2.0);
  col *= mix(0.62, 1.0, smoothstep(0.0, 0.05, fx) * smoothstep(1.0, 0.95, fx));
  // A faded bullseye painted on the back wall.
  float r = length(w - vec2(0.0, 10.4));
  float ring = step(0.5, fract(r / 1.1));
  col = mix(col, col * vec3(1.18, 1.1, 0.95), ring * smoothstep(5.5, 4.5, r) * 0.5);
  // Warm light from the bulbs, falling off toward the counter.
  col *= 0.72 + 0.34 * smoothstep(0.0, 14.0, w.y);
  // Jam splats (premultiplied), with a glossy lift.
  vec2 du = (w - decalRect.xy) / decalRect.zw;
  if (du.x > 0.0 && du.x < 1.0 && du.y > 0.0 && du.y < 1.0) {
    vec4 d = texture(decal, du);
    col = col * (1.0 - d.a) + d.rgb * (0.9 + 0.2 * smoothstep(0.4, 0.9, d.a));
  }
  // Candy-striped posts at the stall's sides.
  float px = abs(w.x) - half_;
  if (px > 0.0) {
    float s = step(0.5, fract((w.y + w.x * sign(w.x)) * 1.4));
    vec3 post = mix(vec3(0.95, 0.93, 0.88), vec3(0.86, 0.16, 0.2), s);
    float round_ = clamp(px / 0.35, 0.0, 1.0);
    post *= 0.75 + 0.35 * sin(round_ * 3.14159);
    // Beyond the posts the neighbouring booths' walls, in shadow.
    col = px < 0.35 ? post : col * 0.55;
  }
  // Awning: red and cream stripes with a scalloped hem, shaded toward the top.
  float sc = awning + 0.28 * sqrt(max(0.0, 1.0 - pow(fract(w.x / 0.9) * 2.0 - 1.0, 2.0)));
  if (w.y > sc - 0.28) {
    float st = step(0.5, fract(w.x / 1.8));
    vec3 aw = mix(vec3(0.97, 0.93, 0.84), vec3(0.87, 0.14, 0.2), st);
    aw *= 0.8 + 0.25 * smoothstep(sc + 3.0, sc, w.y);
    col = mix(col * 0.55, aw, smoothstep(sc - 0.28, sc - 0.24, w.y));
  }
  // A string of bulbs under the hem, twinkling out of phase.
  float bx = fract(w.x / 0.9 + 0.5) - 0.5;
  float by = w.y - (awning - 0.2);
  float bi = floor(w.x / 0.9 + 0.5);
  float bd = length(vec2(bx * 0.9, by));
  float on = 0.75 + 0.25 * sin(time * 3.0 + bi * 1.9);
  col += vec3(1.0, 0.8, 0.45) * (smoothstep(0.1, 0.07, bd) * 0.9 + exp(-bd * 5.0) * 0.25) * on;
  fragColor = vec4(col, 1.0);
}`;

const spriteVert = /* glsl */ `#version 300 es
precision highp float;
layout(location = 0) in vec2 aCorner;
layout(location = 1) in vec4 aA;  // x, y, hx, hy
layout(location = 2) in vec4 aB;  // angle, kind, variation, alpha
layout(location = 3) in vec4 aC;  // r, g, b, extra
uniform vec4 view;
out vec2 vLocal;
out vec2 vHalf;
out vec4 vB;
out vec4 vC;
void main() {
  float pad = aB.y == 0.0 ? 0.16 : 0.03; // shadows are blurred past their edge
  vec2 lp = aCorner * (aA.zw + pad);
  float c = cos(aB.x), s = sin(aB.x);
  vec2 wp = aA.xy + vec2(c * lp.x - s * lp.y, s * lp.x + c * lp.y);
  vLocal = lp;
  vHalf = aA.zw;
  vB = aB;
  vC = aC;
  gl_Position = vec4((wp - view.xy) / view.zw * 2.0, 0.0, 1.0);
}`;

const spriteFrag = /* glsl */ `#version 300 es
precision highp float;
in vec2 vLocal;
in vec2 vHalf;
in vec4 vB;
in vec4 vC;
out vec4 fragColor;

float sdRoundBox(vec2 p, vec2 b, float r) {
  vec2 q = abs(p) - b + r;
  return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}
float sdTri(vec2 p, vec2 a, vec2 b, vec2 c) {
  vec2 e0 = b - a, e1 = c - b, e2 = a - c;
  vec2 v0 = p - a, v1 = p - b, v2 = p - c;
  vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
  vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
  vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
  float s = sign(e0.x * e2.y - e0.y * e2.x);
  vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                   vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                   vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
  return -sqrt(d.x) * sign(d.y);
}
float cover(float d) {
  float aa = fwidth(d) * 1.1;
  return 1.0 - smoothstep(-aa, aa, d);
}
float hash(float n) { return fract(sin(n) * 43758.5453); }

void main() {
  float kind = vB.y;
  vec2 p = vLocal, h = vHalf;
  vec3 col = vC.rgb;
  float alpha = vB.w;
  if (kind < 0.5) {
    // Soft shadow cast on the back wall.
    float d = sdRoundBox(p, h, vC.a);
    float a = (1.0 - smoothstep(-0.1, 0.14, d)) * alpha;
    fragColor = vec4(0.08, 0.0, 0.02, 1.0) * a;
    return;
  }
  if (kind < 1.5) {
    // Tin can: brushed-steel cylinder, a printed label band, ribbed ends and rolled rims.
    float d = sdRoundBox(p, h, 0.035);
    float cv = cover(d);
    if (cv <= 0.001) discard;
    float u = p.x / h.x;
    float n = sqrt(max(0.0, 1.0 - u * u));
    float y = p.y / h.y;
    vec3 steel = vec3(0.62, 0.66, 0.72) * (0.45 + 0.6 * n) + pow(max(0.0, 1.0 - abs(u + 0.45) * 3.5), 3.0) * 0.55;
    steel *= 0.93 + 0.07 * sin(p.y * 170.0);
    vec3 c = steel;
    if (abs(y) < 0.66) {
      vec3 lab = col;
      if (vC.a > 0.5 && abs(y - 0.12) < 0.13) lab = vec3(0.98, 0.95, 0.88);
      if (vC.a <= 0.5 && abs(y) < 0.3) lab = mix(lab, vec3(0.98, 0.95, 0.88), step(length(vec2(u * 1.3, y * 1.6)), 0.45));
      c = lab * (0.5 + 0.55 * n) + pow(max(0.0, 1.0 - abs(u + 0.45) * 3.0), 4.0) * 0.35;
    }
    if (abs(y) > 0.9) c *= 1.18;
    c *= mix(0.45, 1.0, smoothstep(0.0, 0.02, -d)) * vB.z;
    fragColor = vec4(c * cv * alpha, cv * alpha);
    return;
  }
  if (kind < 2.5) {
    // Glass jar of jam: gingham cloth lid, clear shoulders, jam fill, cream label, rim highlight.
    float lidD = sdRoundBox(p - vec2(0.0, h.y * 0.84), vec2(h.x * 0.86, h.y * 0.16), 0.02);
    float bodyD = sdRoundBox(p - vec2(0.0, -h.y * 0.14), vec2(h.x, h.y * 0.86), min(0.1, h.x * 0.45));
    float d = min(lidD, bodyD);
    float cv = cover(d);
    if (cv <= 0.001) discard;
    float u = p.x / h.x;
    float n = sqrt(max(0.0, 1.0 - u * u));
    vec4 c;
    if (lidD < bodyD) {
      float hx = mod(floor(p.x * 16.0), 2.0) + mod(floor(p.y * 16.0), 2.0);
      vec3 cloth = hx > 1.5 ? vec3(0.78, 0.1, 0.16) : hx > 0.5 ? vec3(0.93, 0.55, 0.57) : vec3(0.98, 0.95, 0.92);
      cloth *= 0.7 + 0.35 * n;
      c = vec4(cloth, 1.0);
    } else {
      float fill = h.y * (vC.a * 2.0 - 1.0) - h.y * 0.14;
      float edge = 1.0 - n;
      if (p.y < fill) {
        vec3 jam = col * (0.45 + 0.6 * n);
        jam += vec3(1.0) * pow(max(0.0, 1.0 - abs(u + 0.5) * 4.0), 3.0) * 0.35;
        c = vec4(jam, 1.0);
      } else {
        // Clear glass: mostly see-through, more opaque at grazing edges.
        float a = 0.18 + 0.55 * pow(edge, 2.0);
        c = vec4(vec3(0.82, 0.93, 0.97) * a, a);
      }
      // Paper label.
      float ly = p.y + h.y * 0.18;
      if (abs(ly) < h.y * 0.24 && abs(u) < 0.82) {
        vec3 lab = vec3(0.98, 0.93, 0.8) * (0.6 + 0.45 * n);
        if (abs(ly) > h.y * 0.19) lab = col * 0.9;
        c = vec4(lab, 1.0);
      }
      // Specular streak down the left and a bright rim at the neck.
      float streak = pow(max(0.0, 1.0 - abs(u + 0.58) * 7.0), 2.0) * smoothstep(-0.9, 0.2, p.y / h.y);
      float rim = smoothstep(0.03, 0.0, abs(p.y - h.y * 0.66)) * 0.7;
      c.rgb += vec3(1.0) * (streak * 0.6 + rim);
      c.a = max(c.a, streak * 0.6 + rim);
    }
    c.rgb *= mix(0.55, 1.0, smoothstep(0.0, 0.018, -d)) * vB.z;
    fragColor = vec4(c.rgb * cv * alpha, c.a * cv * alpha);
    return;
  }
  if (kind < 3.5) {
    // Wooden crate: three slats, a frame, a diagonal brace and nail heads.
    float d = sdRoundBox(p, h, 0.03);
    float cv = cover(d);
    if (cv <= 0.001) discard;
    float fr = 0.075;
    float inner = sdRoundBox(p, h - fr, 0.0);
    vec3 wood = col * (0.92 + 0.08 * sin(p.x * 34.0 + sin(p.y * 9.0 + col.g * 20.0) * 2.5));
    vec3 c = wood;
    if (inner < 0.0) {
      float slat = fract((p.y + h.y) / (2.0 * h.y) * 3.0);
      c *= 0.88 * mix(0.55, 1.0, smoothstep(0.0, 0.07, slat) * smoothstep(1.0, 0.93, slat));
      float brace = abs(p.x * h.y - p.y * h.x) / length(h);
      if (brace < 0.06) c = wood * (1.05 - 0.1 * smoothstep(0.045, 0.06, brace));
    } else c *= 1.08;
    vec2 q = abs(p) - (h - fr * 0.5);
    c = mix(c, vec3(0.25, 0.2, 0.16), smoothstep(0.022, 0.012, length(q)));
    if (vC.a > 0.5) {
      // Cracked by a first hit: a jagged split with a short branch.
      float zig = 0.04 * sign(sin(p.y * 38.0)) * fract(p.y * 19.0);
      float crack = abs(p.x - 0.22 * p.y - zig);
      float branch = abs(p.y - 0.1 - 0.6 * (p.x - 0.05)) + step(0.0, -p.x + 0.02) + step(0.25, p.x);
      c = mix(c, vec3(0.12, 0.07, 0.04), smoothstep(0.02, 0.008, min(crack, branch)));
    }
    c *= mix(0.5, 1.0, smoothstep(0.0, 0.02, -d));
    c *= (0.93 + 0.1 * clamp(p.y / h.y, -1.0, 1.0)) * vB.z;
    fragColor = vec4(c * cv * alpha, cv * alpha);
    return;
  }
  if (kind < 4.5) {
    // Plank: shelves, splinters and the slingshot. extra > 0.5 gives splintered, ragged ends.
    vec2 hh = h;
    if (vC.a > 0.5) hh.x -= (0.5 + 0.5 * sin(p.y * 70.0 + vB.z * 40.0)) * min(0.07, h.x * 0.3);
    float d = sdRoundBox(p, hh, min(0.03, 0.4 * min(h.x, h.y)));
    float cv = cover(d);
    if (cv <= 0.001) discard;
    vec3 c = col * (0.9 + 0.1 * sin(p.y * 60.0 + sin(p.x * 5.0 + vB.z * 17.0) * 3.0));
    c *= 0.85 + 0.25 * smoothstep(-h.y, h.y, p.y);
    c *= mix(0.5, 1.0, smoothstep(0.0, 0.02, -d));
    fragColor = vec4(c * cv * alpha, cv * alpha);
    return;
  }
  if (kind < 5.5) {
    // Glass shard: one of three jagged triangles, clear with a bright edge.
    vec2 q = p / h;
    float v = vB.z;
    float d = v < 0.33 ? sdTri(q, vec2(-1.0, -1.0), vec2(1.0, -0.5), vec2(-0.3, 1.0))
            : v < 0.66 ? sdTri(q, vec2(-1.0, 0.7), vec2(1.0, 1.0), vec2(0.2, -1.0))
            : sdTri(q, vec2(-1.0, -0.2), vec2(0.9, -1.0), vec2(0.6, 1.0));
    d *= min(h.x, h.y);
    float cv = cover(d);
    if (cv <= 0.001) discard;
    float e = smoothstep(0.018, 0.0, -d);
    float a = 0.35 + 0.6 * e;
    vec3 c = mix(vec3(0.78, 0.92, 0.98), vec3(1.0), e) * a;
    if (vC.a > 0.0) c = mix(c, col * 0.8, 0.6 * smoothstep(0.2, -0.6, q.y));
    fragColor = vec4(c * cv * alpha, max(a, vC.a * 0.6) * cv * alpha);
    return;
  }
  if (kind < 6.5) {
    // Softball: matte cream sphere with red stitching that turns with the ball.
    float r = h.x;
    float l = length(p) / r;
    float cv = 1.0 - smoothstep(1.0 - fwidth(l) * 1.2, 1.0 + fwidth(l) * 1.2, l);
    if (cv <= 0.001) discard;
    vec3 n = vec3(p / r, sqrt(max(0.0, 1.0 - l * l)));
    vec3 L = normalize(vec3(-0.5, 0.7, 0.6));
    float c0 = cos(-vB.x), s0 = sin(-vB.x);
    vec2 rp = vec2(c0 * p.x - s0 * p.y, s0 * p.x + c0 * p.y) / r;
    float st = min(abs(length(rp - vec2(1.35, 0.0)) - 0.95), abs(length(rp + vec2(1.35, 0.0)) - 0.95));
    float dash = step(0.5, fract(atan(rp.y, abs(rp.x) - 1.35) * 3.0));
    vec3 base = vec3(0.97, 0.94, 0.86);
    base = mix(base, vec3(0.85, 0.12, 0.12), smoothstep(0.07, 0.04, st) * dash);
    vec3 c = base * (0.3 + 0.8 * max(dot(n, L), 0.0)) + pow(max(dot(reflect(-L, n), vec3(0, 0, 1)), 0.0), 12.0) * 0.18;
    fragColor = vec4(c * cv * alpha, cv * alpha);
    return;
  }
  if (kind < 7.5) {
    // Dot: jam droplets (extra 0, glossy) and the aim arc / sparkles (extra 1, soft glow).
    float l = length(p) / h.x;
    if (vC.a > 0.5) {
      float a = pow(max(0.0, 1.0 - l), 1.5) * alpha;
      fragColor = vec4(col, 1.0) * a;
      return;
    }
    float cv = 1.0 - smoothstep(1.0 - fwidth(l) * 1.2, 1.0, l);
    if (cv <= 0.001) discard;
    vec3 c = col * (0.8 + 0.3 * (p.y / h.x)) + smoothstep(0.35, 0.1, length(p / h.x - vec2(-0.35, 0.35))) * 0.5;
    fragColor = vec4(c * cv * alpha, cv * alpha);
    return;
  }
  if (kind < 8.5) {
    // Rubber band.
    float d = sdRoundBox(p, h, h.y);
    float cv = cover(d);
    if (cv <= 0.001) discard;
    vec3 c = col * (0.75 + 0.4 * smoothstep(-h.y, h.y, p.y));
    fragColor = vec4(c * cv * alpha, cv * alpha);
    return;
  }
  // Counter front: red and cream stripes under a wooden top rail with a brass trim line.
  vec3 c;
  float top = h.y - p.y;
  if (top < 0.3) {
    c = vec3(0.62, 0.38, 0.2) * (0.85 + 0.1 * sin(p.x * 23.0 + sin(p.x * 3.0) * 2.0));
    c *= 0.8 + 0.35 * smoothstep(0.3, 0.0, top);
    c = mix(c, vec3(1.0, 0.9, 0.7), smoothstep(0.03, 0.0, abs(top - 0.035)) * 0.6);
  } else if (top < 0.38) {
    c = vec3(0.95, 0.74, 0.3) * (0.8 + 0.3 * smoothstep(0.38, 0.3, top));
  } else {
    float s = step(0.5, fract(p.x / 0.9));
    c = mix(vec3(0.95, 0.9, 0.8), vec3(0.82, 0.14, 0.18), s);
    c *= 0.62 + 0.38 * smoothstep(2.0 * h.y, 0.4, top);
    c *= 1.0 - 0.35 * smoothstep(0.55, 0.38, top);
  }
  fragColor = vec4(c * alpha, alpha);
}`;

export class KnockdownRenderer {
  private back: Program;
  private sprite: Program;
  private quad: WebGLVertexArrayObject;
  private vao: WebGLVertexArrayObject;
  private inst: WebGLBuffer;
  private capacity = 0;
  private decalTex: WebGLTexture;
  /** CPU copy of the jam decal, premultiplied RGBA; stamped in place and uploaded by region. */
  readonly decal = new Uint8Array(DECAL * DECAL * 4);

  constructor(private gl: WebGL2RenderingContext) {
    this.back = new Program(gl, compile(gl, gl.VERTEX_SHADER, backVert), backFrag);
    this.sprite = new Program(gl, compile(gl, gl.VERTEX_SHADER, spriteVert), spriteFrag);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const qb = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, qb);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const corner = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, corner);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    this.inst = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    for (let k = 0; k < 3; k++) {
      gl.enableVertexAttribArray(1 + k);
      gl.vertexAttribPointer(1 + k, 4, gl.FLOAT, false, FLOATS * 4, k * 16);
      gl.vertexAttribDivisor(1 + k, 1);
    }
    gl.bindVertexArray(null);

    this.decalTex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.decalTex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, DECAL, DECAL, 0, gl.RGBA, gl.UNSIGNED_BYTE, this.decal);
  }

  clearDecal() {
    this.decal.fill(0);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.decalTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, DECAL, DECAL, gl.RGBA, gl.UNSIGNED_BYTE, this.decal);
  }

  /** Upload one w×h region of the CPU decal (a 32² stamp) without copying it out first. */
  uploadDecal(x: number, y: number, w: number, h: number) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.decalTex);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, DECAL);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, x);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, y);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, this.decal);
    gl.pixelStorei(gl.UNPACK_ROW_LENGTH, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_PIXELS, 0);
    gl.pixelStorei(gl.UNPACK_SKIP_ROWS, 0);
  }

  draw(width: number, height: number, view: [number, number, number, number], time: number, awning: number, half: number, data: Float32Array, count: number) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.disable(gl.DEPTH_TEST);
    let u = this.back.use();
    gl.uniform4f(u.view, ...view);
    gl.uniform1f(u.time, time);
    gl.uniform1f(u.awning, awning);
    gl.uniform1f(u.half_, half);
    gl.uniform4f(u.decalRect, ...DECAL_RECT);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.decalTex);
    gl.uniform1i(u.decal, 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    if (!count) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.inst);
    if (count > this.capacity) {
      this.capacity = Math.max(count, this.capacity * 2, 1024);
      gl.bufferData(gl.ARRAY_BUFFER, this.capacity * FLOATS * 4, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * FLOATS);
    u = this.sprite.use();
    gl.uniform4f(u.view, ...view);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.bindVertexArray(this.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, count);
    gl.disable(gl.BLEND);
  }

  destroy() {
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
