// Mould cavities as inside-tests in cells: x is relative to the cavity centre, y runs down from the
// cavity top. Every shape is cast right side up and bottom-gated (metal rises into it from ingates
// at `gates`, pushed by the head in the sprue), with a riser at `riser` on its highest point. `thin`
// (0..) is how many rounds of moulds the player has done: walls shed cells each time, which also
// lowers the ring. `f1` is the flawless round-0 casting's fundamental: the one pitch scale per shape
// family that maps the computed eigenvalues to hertz.

export type ShapeId = 'bowl' | 'bell' | 'blade' | 'crest';

export interface Shape {
  id: ShapeId;
  name: string;
  /** Cavity height in cells. */
  h: number;
  /** Fundamental of the flawless round-0 casting, Hz. */
  f1: number;
  /** Ingate x offsets along the cavity bottom, and the riser's x offset on top. */
  gates: number[];
  riser: number;
  /** Name a cell row (0..h) for the verdict: where on the casting a flaw sits. */
  part(y: number): string;
  inside(x: number, y: number): boolean;
}

export const SHAPES: ShapeId[] = ['bowl', 'bell', 'blade', 'crest'];

export function makeShape(id: ShapeId, thin: number): Shape {
  const t = Math.min(thin, 3);
  switch (id) {
    case 'bowl': {
      // A bowl, rim up: a half-ellipse shell over a sand core, standing on a foot ring.
      const rx = 30, ry = 38, h = ry + 5, wall = 8 - t * 1.4;
      return {
        id, name: 'Bowl', h, f1: 262, gates: [0], riser: rx - wall / 2,
        part: (y) => (y < h * 0.3 ? 'rim' : y < ry - 4 ? 'wall' : 'foot'),
        inside(x, y) {
          if (y < 0 || y > h) return false;
          if (y >= ry - 3 && Math.abs(x) < 11) return true;
          const o = (x / rx) ** 2 + (y / ry) ** 2;
          const i = (x / (rx - wall)) ** 2 + (y / (ry - wall)) ** 2;
          return o <= 1 && i > 1;
        },
      };
    }
    case 'bell': {
      // Bell profile: hanging loop, rounded crown, a waist, and a flared sound bow at the lip. Fed
      // at both lips, so the two walls rise together and meet across the crown.
      const h = 66, top = 7, wall = 6 - t, crown = 7 - t * 0.5;
      const outer = (y: number) => {
        const s = (y - top) / (h - top);
        let w = 12 + 5 * s + 14 * s ** 5;
        const R = 7;
        if (y < top + R) w -= R - Math.sqrt(Math.max(0, R * R - (top + R - y) ** 2));
        return w;
      };
      const lip = outer(h) - (wall + 4) / 2;
      return {
        id, name: 'Bell', h, f1: 330, gates: [-lip, lip], riser: 0,
        part: (y) => (y < top + crown + 2 ? 'crown' : y < h * 0.72 ? 'waist' : 'lip'),
        inside(x, y) {
          if (y < 0 || y > h) return false;
          const ax = Math.abs(x);
          if (y < top) return ax <= 5 && !(ax <= 2 && y >= 2 && y <= 4);
          if (ax > outer(y)) return false;
          if (y < top + crown) return true;
          // Sound bow: the wall thickens towards the lip.
          const s = (y - top) / (h - top);
          return ax > outer(y) - (wall + 4 * s ** 4);
        },
      };
    }
    case 'blade': {
      // A sword, point up: fed into the pommel, it rises through the grip and crossguard and has to
      // reach the thin point before it chills.
      const h = 78, bw = 4 - t * 0.5;
      return {
        id, name: 'Blade', h, f1: 587, gates: [0], riser: 0,
        part: (y) => (y < 20 ? 'point' : y < h - 28 ? 'blade' : 'hilt'),
        inside(x, y) {
          if (y < 0 || y > h) return false;
          const ax = Math.abs(x), u = h - y;
          if (u <= 10) return ax * ax + (u - 5) ** 2 <= 30;
          if (u < 23) return ax <= 2;
          if (u < 28) return ax <= 16 - Math.max(0, (u - 25) * 1.2) && ax <= 17;
          if (u < h - 14) return ax <= bw;
          return ax <= bw * ((h - u) / 14) + 0.4;
        },
      };
    }
    case 'crest': {
      // A heater shield with a cross, an openwork frame around four sand islands. Fed at the point,
      // metal climbs both edges and the upright at once; the fronts meet in the crossbar and the top.
      const h = 62, w = 27, rim = 5 - t * 0.7, bar = 5 - t * 0.7;
      const half = (y: number) => (y < 26 ? w : w * Math.sqrt(Math.max(0, 1 - ((y - 26) / (h - 26)) ** 2)));
      return {
        id, name: 'Crest', h, f1: 440, gates: [0], riser: 0,
        part: (y) => (y < rim + 2 ? 'top' : Math.abs(y - 24) < bar ? 'cross' : y < 44 ? 'field' : 'point'),
        inside(x, y) {
          if (y < 0 || y > h) return false;
          const ax = Math.abs(x), hw = half(y);
          if (ax > hw) return false;
          if (y < rim || ax > hw - rim - (y > 26 ? 1.5 : 0)) return true;
          if (ax < bar / 2 + 0.5) return true;
          return Math.abs(y - 24) < bar / 2 + 0.5;
        },
      };
    }
  }
}
