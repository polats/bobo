// Porcelain pieces: a profile of revolution (or a face-on disc for the plate) plus a per-pixel
// glaze painter. Vessels are lit as real surfaces of revolution: the normal comes from the profile
// slope, the glaze gets a studio softbox streak, and the pattern wraps around the body in
// longitude (asin of the horizontal position), so motifs crowd toward the edges like on a real pot.

export type RGB = [number, number, number];
export type Pattern = 'lotus' | 'waves' | 'scroll' | 'plate' | 'hare';

export interface PieceDef {
  name: string;
  shards: number;
  plate?: boolean;
  /** Control points (v, half-width) of the profile, v from foot (0) to rim (1), width 0..1 of the widest point. */
  profile: [number, number][];
  /** Height of the body over the widest diameter. */
  aspect: number;
  /** Half-height of the rim ellipse over the rim half-width: how far we look down into the piece. */
  lip: number;
  /** Top of the unglazed foot ring, in v. */
  footV: number;
  body: RGB;
  inner: RGB;
  foot: RGB;
  ink: RGB;
  /** Colour of the broken edge (the fired body under the glaze). */
  bisque: string;
  pattern: Pattern;
  gloss: number;
}

export const PIECES: PieceDef[] = [
  {
    name: 'Celadon bowl',
    shards: 5,
    profile: [[0, 0.34], [0.07, 0.36], [0.1, 0.46], [0.35, 0.72], [0.7, 0.93], [1, 1]],
    aspect: 0.46,
    lip: 0.24,
    footV: 0.08,
    body: [150, 196, 172],
    inner: [162, 206, 182],
    foot: [196, 170, 136],
    ink: [96, 150, 124],
    bisque: 'rgba(236,228,210,0.95)',
    pattern: 'lotus',
    gloss: 1,
  },
  {
    name: 'Tea cup',
    shards: 6,
    profile: [[0, 0.66], [0.05, 0.68], [0.08, 0.76], [0.5, 0.86], [1, 1]],
    aspect: 0.98,
    lip: 0.22,
    footV: 0.06,
    body: [246, 244, 238],
    inner: [242, 240, 234],
    foot: [214, 200, 178],
    ink: [34, 68, 158],
    bisque: 'rgba(250,248,240,0.95)',
    pattern: 'waves',
    gloss: 1,
  },
  {
    name: 'Blue vase',
    shards: 8,
    profile: [[0, 0.52], [0.04, 0.54], [0.2, 0.8], [0.44, 1], [0.64, 0.88], [0.8, 0.46], [0.9, 0.3], [0.96, 0.34], [1, 0.44]],
    aspect: 1.34,
    lip: 0.3,
    footV: 0.035,
    body: [240, 243, 247],
    inner: [218, 224, 232],
    foot: [214, 198, 172],
    ink: [30, 60, 150],
    bisque: 'rgba(250,248,242,0.95)',
    pattern: 'scroll',
    gloss: 1,
  },
  {
    name: 'Plate',
    shards: 10,
    plate: true,
    profile: [[0, 1], [1, 1]],
    aspect: 1,
    lip: 0,
    footV: 0,
    body: [244, 245, 248],
    inner: [244, 245, 248],
    foot: [210, 200, 180],
    ink: [32, 64, 156],
    bisque: 'rgba(252,250,244,0.95)',
    pattern: 'plate',
    gloss: 1,
  },
  {
    name: 'Tenmoku bowl',
    shards: 12,
    profile: [[0, 0.3], [0.08, 0.32], [0.11, 0.4], [0.5, 0.78], [0.9, 0.98], [1, 1]],
    aspect: 0.52,
    lip: 0.24,
    footV: 0.09,
    body: [44, 30, 24],
    inner: [38, 26, 21],
    foot: [176, 140, 104],
    ink: [158, 92, 44],
    bisque: 'rgba(214,184,150,0.95)',
    pattern: 'hare',
    gloss: 1.2,
  },
];

/** Monotone-ish cubic Hermite through the profile points. */
export function profileFn(pts: [number, number][]) {
  const n = pts.length;
  const m = pts.map((_, k) => {
    const a = pts[Math.max(0, k - 1)], b = pts[Math.min(n - 1, k + 1)];
    return (b[1] - a[1]) / Math.max(1e-6, b[0] - a[0]);
  });
  return (v: number) => {
    if (v <= pts[0][0]) return pts[0][1];
    for (let k = 0; k < n - 1; k++) {
      const [v0, w0] = pts[k], [v1, w1] = pts[k + 1];
      if (v > v1) continue;
      const h = v1 - v0, t = (v - v0) / h, t2 = t * t, t3 = t2 * t;
      return (2 * t3 - 3 * t2 + 1) * w0 + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * w1 + (t3 - t2) * h * m[k + 1];
    }
    return pts[n - 1][1];
  };
}

/** Piece size and mapping from the fracture square (u -1..1, v 0..1) to local pixels (y down, origin at the bbox centre). */
export interface Shape {
  def: PieceDef;
  R: number;
  /** Body height (vessels). */
  Hh: number;
  /** Rim ellipse half-width and half-height. */
  rw: number;
  L: number;
  /** Bounding box size. */
  w: number;
  h: number;
  width: (v: number) => number;
  map(u: number, v: number, out: number[]): void;
}

export function makeShape(def: PieceDef, maxW: number, maxH: number): Shape {
  const width = profileFn(def.profile);
  if (def.plate) {
    const R = Math.floor(Math.min(maxW, maxH * 1.1) / 2);
    return {
      def, R, Hh: 2 * R, rw: R, L: 0, w: 2 * R, h: 2 * R, width,
      // Elliptical grid mapping: a square onto a disc with little distortion.
      map(u, v, out) {
        const s = 2 * v - 1;
        out[0] = R * u * Math.sqrt(Math.max(0, 1 - (s * s) / 2));
        out[1] = -R * s * Math.sqrt(Math.max(0, 1 - (u * u) / 2));
      },
    };
  }
  let wMax = 0;
  for (let k = 0; k <= 100; k++) wMax = Math.max(wMax, width(k / 100));
  const w1 = width(1);
  const R = Math.floor(Math.min(maxW / (2 * wMax), maxH / (2 * def.aspect + def.lip * w1)));
  const Hh = 2 * R * def.aspect;
  const rw = R * w1, L = def.lip * rw;
  const h = Hh + L;
  return {
    def, R, Hh, rw, L, w: 2 * R * wMax, h, width,
    map(u, v, out) {
      // The top of the square lifts onto the back half of the rim ellipse.
      const lift = v < 0.7 ? 0 : ((v - 0.7) / 0.3) ** 2;
      const up = v * Hh + lift * L * Math.sqrt(Math.max(0, 1 - u * u));
      out[0] = u * R * width(v);
      out[1] = h / 2 - up;
    },
  };
}

// ---------------------------------------------------------------- painting

function hash(x: number, y: number) {
  let h = (x * 374761393 + y * 668265263) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(x: number, y: number) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy), b = hash(ix + 1, iy), c = hash(ix, iy + 1), d = hash(ix + 1, iy + 1);
  return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** A thin line of half-width hw (in the same units as d), anti-aliased over aa. */
const line = (d: number, hw: number, aa: number) => 1 - smooth(hw, hw + aa, Math.abs(d));

/** Seigaiha (overlapping wave scales): ink amount at (x, y) in tile units, y up. */
function seigaiha(x: number, y: number, rings: number, aa: number) {
  const j0 = Math.floor(y / 0.25);
  // Rows a quarter apart, lower rows in front: the lowest circle that covers the point wins.
  for (let j = j0 - 2; j <= j0; j++) {
    const off = (j & 1) * 0.5;
    const i = Math.round(x - off);
    const cx = i + off, cy = j * 0.25;
    const d = Math.hypot(x - cx, y - cy);
    if (d < 0.5 && y >= cy) {
      const r = (d / 0.5) * rings;
      return line(r - Math.round(r), 0.13, aa * rings * 2) * (d > 0.06 ? 1 : 0);
    }
  }
  return 0;
}

/** Ink (pattern) amount on the vessel body at longitude th (-pi/2..pi/2) and height v. */
function vesselInk(p: Pattern, th: number, v: number, aa: number) {
  const a = th / Math.PI + 0.5; // 0..1 across the visible half
  if (p === 'lotus') {
    // Incised lotus petals and a double line under the rim; the glaze pools darker in the cuts.
    let ink = line(v - 0.86, 0.004, aa) + line(v - 0.83, 0.003, aa);
    const band = (v - 0.16) / 0.5;
    if (band > 0 && band < 1) {
      const k = a * 7 - Math.floor(a * 7) - 0.5;
      const edge = 0.46 * Math.sin(Math.PI * Math.min(1, band * 1.1)) ** 0.6;
      ink += line(Math.abs(k) - edge, 0.012, aa * 7) * (band < 0.98 ? 1 : 0);
      ink += line(k, 0.006, aa * 7) * smooth(0.15, 0.4, band) * (1 - smooth(0.7, 0.85, band)) * 0.6;
    }
    return Math.min(1, ink);
  }
  if (p === 'waves') {
    let ink = smooth(0.9, 0.9 + aa, v) * (1 - smooth(0.955, 0.955 + aa, v));
    ink += line(v - 0.865, 0.006, aa) + line(v - 0.14, 0.006, aa) + line(v - 0.17, 0.003, aa);
    if (v > 0.24 && v < 0.78) {
      const s = seigaiha(a * 6.5, (v - 0.24) * 7, 4, aa * 7);
      const fade = smooth(0.24, 0.27, v) * (1 - smooth(0.75, 0.78, v));
      ink += s * fade;
    }
    return Math.min(1, ink);
  }
  if (p === 'scroll') {
    // Blue-and-white: banded neck, lappets on the shoulder, a peony scroll round the belly,
    // lotus petals at the foot.
    let ink = 0;
    ink += smooth(0.955, 0.965, v);
    ink += line(v - 0.9, 0.004, aa) + line(v - 0.8, 0.006, aa) + line(v - 0.63, 0.004, aa);
    ink += line(v - 0.1, 0.006, aa) + line(v - 0.285, 0.004, aa);
    if (v > 0.8 && v < 0.9) {
      const k = a * 14 - Math.floor(a * 14);
      ink += line(k - 0.5, 0.06 * (0.9 - v) * 10, aa * 14) * 0.9;
    }
    const lappet = (t: number, n: number, fillA: number) => {
      const k = a * n - Math.floor(a * n) - 0.5;
      const edge = 0.46 * Math.max(0, 1 - t) ** 0.7;
      return line(Math.abs(k) - edge, 0.02, aa * n) + (Math.abs(k) < edge - 0.07 ? fillA : 0) + line(Math.abs(k) - edge + 0.11, 0.01, aa * n) * 0.7;
    };
    if (v > 0.645 && v < 0.795) ink += lappet((0.795 - v) / 0.15, 9, 0.16);
    if (v > 0.12 && v < 0.27) ink += lappet((v - 0.12) / 0.15, 11, 0);
    if (v > 0.3 && v < 0.62) {
      const vine = 0.46 + 0.07 * Math.sin(a * Math.PI * 6);
      ink += line(v - vine, 0.0035, aa);
      // Peonies sit on the vine's crests and troughs, leaves between.
      for (let f = 0; f < 6; f++) {
        const fa = (f + 0.25) / 6;
        const fv = 0.46 + 0.07 * Math.sin(fa * Math.PI * 6) + (f & 1 ? -0.055 : 0.055);
        const dx = (a - fa) * 2.2, dy = v - fv;
        const r = Math.hypot(dx, dy), ang = Math.atan2(dy, dx);
        const petal = 0.064 * (0.78 + 0.22 * Math.cos(ang * 5));
        if (r < petal) ink += 0.9 - 0.55 * line(r - petal * 0.55, 0.004, aa) - 0.4 * (r < 0.011 ? 1 : 0);
        for (const side of [-1, 1]) {
          const lx = (a - fa - side * 0.06) * 2.2, ly = v - (fv + (f & 1 ? 0.03 : -0.03));
          if (Math.abs(lx) < 0.035 && Math.abs(ly) < 0.016 * (1 - (lx / 0.035) ** 2)) ink += 0.8;
        }
      }
    }
    return Math.min(1, ink);
  }
  if (p === 'hare') {
    // Hare's-fur streaks: iron runs down from the thin glaze at the rim.
    const streak = noise(a * 90, v * 3) * 0.6 + noise(a * 210, v * 1.5) * 0.4;
    return smooth(0.45, 0.85, streak) * smooth(0.15, 0.95, v) * 0.9;
  }
  return 0;
}

function plateInk(x: number, y: number, r: number, aa: number) {
  // Scalloped rim band, rings, and seigaiha waves in the well.
  let ink = 0;
  const ang = Math.atan2(y, x);
  const scal = 0.855 + 0.012 * Math.cos(ang * 36);
  ink += smooth(scal, scal + aa, r) * (1 - smooth(0.945, 0.945 + aa, r));
  if (r > 0.86 && r < 0.94) {
    // White reserve dots in the band
    const k = ((ang / (Math.PI * 2)) * 36 + 0.5) % 1;
    const dd = Math.hypot((k - 0.5) * 0.15, r - 0.9);
    ink -= (1 - smooth(0.012, 0.012 + aa, dd)) * 0.95;
  }
  ink += line(r - 0.66, 0.004, aa) + line(r - 0.62, 0.002, aa);
  if (r < 0.56) ink += seigaiha(x * 4.2 + 10, -y * 4.2 + 10, 4, aa * 4.2) * (1 - smooth(0.54, 0.56, r));
  ink += line(r - 0.575, 0.004, aa);
  return Math.max(0, Math.min(1, ink));
}

const LIGHT: [number, number, number] = (() => {
  const l = [-0.45, 0.6, 0.66];
  const n = Math.hypot(l[0], l[1], l[2]);
  return [l[0] / n, l[1] / n, l[2] / n];
})();
const HALF = (() => {
  const h = [LIGHT[0], LIGHT[1], LIGHT[2] + 1];
  const n = Math.hypot(h[0], h[1], h[2]);
  return [h[0] / n, h[1] / n, h[2] / n];
})();

export interface Painter {
  canvas: HTMLCanvasElement;
  /** Local origin in canvas pixels. */
  ox: number;
  oy: number;
  /** Paint rows for up to `ms` milliseconds; true once the canvas is complete. */
  step(ms: number): boolean;
}

/**
 * Paint the whole unbroken piece into a canvas, a few rows at a time so the next piece can be
 * prepared during the celebration without a hitch. Painted a pixel beyond the silhouette:
 * shards are cut out with anti-aliased clip paths.
 */
export function paintPiece(sh: Shape, S: number): Painter {
  const { def, R, Hh, rw, L } = sh;
  const iw = Math.ceil(sh.w) + 6, ih = Math.ceil(sh.h) + 6;
  const ox = Math.floor(iw / 2), oy = Math.floor(ih / 2);
  const cv = document.createElement('canvas');
  cv.width = iw;
  cv.height = ih;
  const g = cv.getContext('2d')!;
  const img = g.createImageData(iw, ih);
  const d = img.data;
  const [br, bg, bb] = def.body, [ir, ig, ib] = def.inner, [kr, kg, kb] = def.ink, [fr, fg, fb] = def.foot;
  const lipW = 1.3 * S;
  const gl = def.gloss;
  let row = 0;
  const paintRow = (y: number) => {
    for (let x = 0; x < iw; x++) {
      const px = x - ox + 0.5, py = y - oy + 0.5;
      let r = 0, gg = 0, b = 0;
      if (def.plate) {
        const rr = Math.hypot(px, py) / R;
        if (rr > 1 + 2 / R) continue;
        // Height field: flat well, cavetto slope up to the rim, rounded bead at the edge.
        const dh = (q: number) => smooth(0.66, 0.84, q) * 0.1 - smooth(0.95, 1.0, q) * 0.05;
        const slope = (dh(rr + 0.004) - dh(rr - 0.004)) / 0.008;
        const nx0 = rr > 1e-4 ? px / (rr * R) : 0, ny0 = rr > 1e-4 ? -py / (rr * R) : 0;
        let nx = -slope * nx0 * 2.2, ny = -slope * ny0 * 2.2, nz = 1;
        const nn = Math.hypot(nx, ny, nz);
        nx /= nn; ny /= nn; nz /= nn;
        const diff = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
        const spec = Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]) ** 90;
        // A broad sheen across the glaze, as if a window is reflected in it.
        const sheen = Math.exp(-(((px + py * 0.55) / R + 0.55) ** 2) * 14) * 0.18;
        const ink = plateInk(px / R, -py / R, rr, 1.2 / R);
        const n = 0.97 + noise(px * 0.05, py * 0.05) * 0.05;
        const mr = br + (kr - br) * ink, mg = bg + (kg - bg) * ink, mb = bb + (kb - bb) * ink;
        const sh2 = (0.5 + 0.62 * diff) * n;
        const lipb = line(rr - 0.975, 0.012, 0.01) * 0.12;
        r = mr * sh2 + 255 * (spec * 0.8 + sheen + lipb);
        gg = mg * sh2 + 255 * (spec * 0.8 + sheen + lipb);
        b = mb * sh2 + 255 * (spec * 0.8 + sheen + lipb) + 6;
      } else {
        const up = sh.h / 2 - py;
        if (up < -2 || up > sh.h + 2) continue;
        const v = Math.max(0, Math.min(1, up / Hh));
        const hw = R * sh.width(v);
        const ex = px / rw, ey = (up - Hh) / L;
        const e = ex * ex + ey * ey;
        const se = Math.sqrt(e);
        const inside = se < 1 && up > Hh - L;
        if (up > Hh && se > 1 + 2 / L) continue;
        if (up <= Hh && Math.abs(px) > hw + 2 && !inside) continue;
        if (inside) {
          // Inner wall seen through the opening: lit at the back, shadowed under the front rim.
          const q = (up - (Hh - L * Math.sqrt(Math.max(0, 1 - ex * ex)))) / Math.max(1, 2 * L * Math.sqrt(Math.max(0, 1 - ex * ex)));
          const shadow = smooth(0.0, 0.45, q);
          let f = (0.42 + 0.5 * shadow) * (0.9 + 0.18 * ex) * (1 - 0.25 * ex * ex);
          const glint = Math.exp(-(((ex - 0.3) / 0.16) ** 2 + ((q - 0.72) / 0.14) ** 2)) * 0.28 * gl;
          let cr = ir, cg = ig, cb = ib;
          if (def.pattern === 'hare') {
            const st = smooth(0.5, 0.85, noise(ex * 40, q * 2.5)) * smooth(0.3, 0.95, q) * 0.8;
            cr += (kr - cr) * st; cg += (kg - cg) * st; cb += (kb - cb) * st;
          } else if (def.pattern !== 'lotus') {
            const band = line(q - 0.88, 0.02, 0.02) * (def.pattern === 'scroll' ? 1 : 0.9);
            cr += (kr - cr) * band; cg += (kg - cg) * band; cb += (kb - cb) * band;
          }
          f *= 0.97 + noise(px * 0.04, up * 0.04) * 0.06;
          r = cr * f + 255 * glint;
          gg = cg * f + 255 * glint;
          b = cb * f + 255 * glint;
        } else {
          const u = Math.max(-1, Math.min(1, px / Math.max(1, hw)));
          const slope = ((sh.width(Math.min(1, v + 0.01)) - sh.width(Math.max(0, v - 0.01))) / 0.02) * (R / Hh);
          const k = Math.hypot(1, slope);
          const nz0 = Math.sqrt(Math.max(0, 1 - u * u));
          const nx = u / k, ny = -slope / k, nz = nz0 / k;
          const diff = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);
          const spec = Math.max(0, nx * HALF[0] + ny * HALF[1] + nz * HALF[2]) ** 70;
          // Softbox streak: the tall window highlight of a studio product shot.
          const streak = Math.exp(-(((u + 0.52) / 0.09) ** 2)) * smooth(def.footV, def.footV + 0.12, v) * (1 - smooth(0.9, 0.99, v)) * 0.34;
          const streak2 = Math.exp(-(((u - 0.72) / 0.06) ** 2)) * 0.1 * smooth(0.2, 0.5, v);
          const fres = (1 - nz0) ** 3;
          const th = Math.asin(u);
          let cr: number, cg: number, cb: number, f: number, s: number;
          if (v < def.footV) {
            // Unglazed foot ring: matte and a little gritty.
            const grit = 0.9 + hash(x, y) * 0.12;
            cr = fr * grit; cg = fg * grit; cb = fb * grit;
            f = 0.45 + 0.6 * diff;
            s = 0;
          } else {
            const ink = vesselInk(def.pattern, th, v, (1.2 / hw) * 2);
            // Glaze runs thicker (darker, greener) toward the foot.
            const pool = def.pattern === 'lotus' ? 1 - 0.14 * (1 - smooth(0.1, 0.6, v)) : 1;
            cr = (br + (kr - br) * ink) * pool;
            cg = (bg + (kg - bg) * ink) * pool;
            cb = (bb + (kb - bb) * ink) * pool;
            if (def.pattern === 'hare') {
              const rim = smooth(0.9, 0.99, v);
              cr += (150 - cr) * rim * 0.7; cg += (84 - cg) * rim * 0.7; cb += (44 - cb) * rim * 0.7;
            }
            f = (0.4 + 0.66 * diff) * (1 - 0.35 * fres);
            s = (spec * 0.9 + streak + streak2) * gl;
            // Glaze skin: a whisper of low-frequency variation.
            f *= 0.96 + noise(th * 6, v * 5) * 0.08;
          }
          // Contact shadow where the body meets the foot.
          f *= 1 - 0.25 * line(v - def.footV, 0.004, 0.02);
          r = cr * f + 255 * s + 30 * fres;
          gg = cg * f + 255 * s + 40 * fres;
          b = cb * f + 255 * s + 62 * fres;
        }
        // The rim lip catches the light all the way round.
        const lipd = Math.abs(se - 1) * Math.min(rw, L * 1.6);
        if (lipd < lipW + 1 && (up > Hh - L)) {
          const a = 1 - smooth(lipW * 0.4, lipW + 1, lipd);
          const lr = def.pattern === 'hare' ? 150 : Math.min(255, ir * 1.12 + 20);
          const lg = def.pattern === 'hare' ? 90 : Math.min(255, ig * 1.12 + 20);
          const lb = def.pattern === 'hare' ? 50 : Math.min(255, ib * 1.12 + 20);
          const lit = 0.8 + 0.3 * (1 - ex) * 0.5;
          r += (lr * lit - r) * a;
          gg += (lg * lit - gg) * a;
          b += (lb * lit - b) * a;
        }
      }
      const o = (y * iw + x) * 4;
      d[o] = r;
      d[o + 1] = gg;
      d[o + 2] = b;
      d[o + 3] = 255;
    }
  };
  return {
    canvas: cv,
    ox,
    oy,
    step(ms) {
      if (row >= ih) return true;
      const t0 = performance.now();
      while (row < ih) {
        paintRow(row++);
        if ((row & 1) === 0 && performance.now() - t0 > ms) break;
      }
      if (row < ih) return false;
      g.putImageData(img, 0, 0);
      return true;
    },
  };
}
