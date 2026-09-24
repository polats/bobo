// Jelly silhouettes as closed outlines, star-shaped around the origin so they can be ringed inward.

export type ShapeId = 'cube' | 'slab' | 'ball' | 'star' | 'heart' | 'bobo';

export const SHAPES: { id: ShapeId; label: string; glyph: string }[] = [
  { id: 'cube', label: 'Cube', glyph: '■' },
  { id: 'slab', label: 'Slab', glyph: '▬' },
  { id: 'ball', label: 'Ball', glyph: '●' },
  { id: 'star', label: 'Star', glyph: '★' },
  { id: 'heart', label: 'Heart', glyph: '♥' },
  { id: 'bobo', label: 'Bobo', glyph: '☺' },
];

/** Superellipse radius along angle t: |x/a|^n + |y/b|^n = 1. */
function superellipse(t: number, a: number, b: number, n: number): [number, number] {
  const c = Math.cos(t);
  const s = Math.sin(t);
  const r = Math.pow(Math.pow(Math.abs(c) / a, n) + Math.pow(Math.abs(s) / b, n), -1 / n);
  return [r * c, r * s];
}

/**
 * Outline of `count` points for a shape of nominal size `size` (roughly its width), counter-clockwise,
 * in local coordinates with y up.
 */
export function outline(shape: ShapeId, size: number, count: number): [number, number][] {
  const h = size / 2;
  const pts: [number, number][] = [];
  for (let k = 0; k < count; k++) {
    const t = (k / count) * Math.PI * 2;
    let p: [number, number];
    switch (shape) {
      case 'cube':
        p = superellipse(t, h, h, 7);
        break;
      case 'slab':
        p = superellipse(t, h * 1.45, h * 0.62, 6);
        break;
      case 'ball':
        p = superellipse(t, h, h, 2);
        break;
      case 'star': {
        // Rounded five-point gummy star, one point up.
        const phi = t - Math.PI / 2;
        const lobe = Math.pow((Math.cos(5 * phi) + 1) / 2, 1.6);
        const r = h * 1.08 * (0.56 + 0.44 * lobe);
        p = [r * Math.cos(t), r * Math.sin(t)];
        break;
      }
      case 'heart': {
        // Classic parametric heart, shifted so its middle sits on the origin.
        const u = t;
        const x = 16 * Math.pow(Math.sin(u), 3);
        const y = 13 * Math.cos(u) - 5 * Math.cos(2 * u) - 2 * Math.cos(3 * u) - Math.cos(4 * u);
        p = [(x / 17) * h * 1.12, ((y + 3) / 17) * h * 1.12];
        break;
      }
      case 'bobo': {
        // The mascot: a tall dome that flattens at the bottom.
        const up = Math.sin(t) > 0;
        p = superellipse(t, h * 1.0, h * (up ? 1.12 : 0.9), up ? 2.3 : 4.5);
        break;
      }
    }
    pts.push(p);
  }
  return pts;
}

/** Point in polygon (even-odd). */
export function inside(pts: [number, number][], x: number, y: number) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Distance from a point to the polygon's boundary. */
export function edgeDistance(pts: [number, number][], x: number, y: number) {
  let best = Infinity;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j];
    const [bx, by] = pts[i];
    const ex = bx - ax, ey = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * ex + (y - ay) * ey) / (ex * ex + ey * ey)));
    best = Math.min(best, Math.hypot(x - ax - ex * t, y - ay - ey * t));
  }
  return best;
}
