// A lip-axis crucible: it pivots about its pouring lip, so the stream stays over the basin however
// far it tips. Whatever metal no longer fits below the lip line spills over it, so the pour rate
// comes straight from the tilt, like tipping a real pot.

/** Outer body in cells, lip at the origin, x right, y down, upright. */
export const BODY = [-21, -0.8, 0.9, -0.8, -1.2, 17, -18.8, 17];
/** Inner cavity holding the metal. */
export const INNER = [-19.6, 0.4, -0.8, 0.4, -2.6, 19, -17.6, 19];

const tmpA = new Float32Array(16);

/** Rotate a polygon about the origin into `out` (world offset added). Clockwise on screen for a > 0. */
export function place(poly: number[], a: number, ox: number, oy: number, out: Float32Array) {
  const c = Math.cos(a), s = Math.sin(a);
  for (let i = 0; i < poly.length; i += 2) {
    const x = poly[i], y = poly[i + 1];
    out[i] = ox + x * c - y * s;
    out[i + 1] = oy + x * s + y * c;
  }
  return poly.length >> 1;
}

/** Clip a polygon to the half-plane y >= level; returns vertex count written to `out`. */
export function clipBelow(pts: Float32Array, n: number, level: number, out: Float32Array) {
  let m = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = pts[i * 2], ay = pts[i * 2 + 1], bx = pts[j * 2], by = pts[j * 2 + 1];
    const ain = ay >= level, bin = by >= level;
    if (ain) {
      out[m * 2] = ax;
      out[m * 2 + 1] = ay;
      m++;
    }
    if (ain !== bin) {
      const t = (level - ay) / (by - ay);
      out[m * 2] = ax + (bx - ax) * t;
      out[m * 2 + 1] = level;
      m++;
    }
  }
  return m;
}

export function area(pts: Float32Array, n: number) {
  let s = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    s += pts[i * 2] * pts[j * 2 + 1] - pts[j * 2] * pts[i * 2 + 1];
  }
  return Math.abs(s) * 0.5;
}

/** Area of the (placed) inner polygon below a level line. */
export function areaBelow(inner: Float32Array, n: number, level: number) {
  const m = clipBelow(inner, n, level, tmpA);
  return m < 3 ? 0 : area(tmpA, m);
}
