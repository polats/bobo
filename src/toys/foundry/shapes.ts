// Mould cavities as inside-tests in cells: x is relative to the flask centre, y runs down from the
// cavity top. Every cavity is fed from its top centre, since a falling-cell liquid can only fill
// downwards (bowls are cast upside down, as foundries do). `thin` (0..) is how many rounds of moulds
// the player has done: walls shed cells and the sprue gets longer each time.

export type ShapeId = 'bowl' | 'bell' | 'blade' | 'crest';

export interface Shape {
  id: ShapeId;
  name: string;
  /** Cavity height in cells. */
  h: number;
  /** Rows of sand between the flask top and the cavity (the sprue runs through them). */
  sprue: number;
  /** Ring pitch ratio for the chime (big bells ring low). */
  pitch: number;
  /** Chill multiplier: thin sections lose heat to the sand faster. */
  chill: number;
  inside(x: number, y: number): boolean;
}

export const SHAPES: ShapeId[] = ['bowl', 'bell', 'blade', 'crest'];

export function makeShape(id: ShapeId, thin: number): Shape {
  const t = Math.min(thin, 3);
  switch (id) {
    case 'bowl': {
      // An upturned bowl: a thick dome shell over a sand core, with the foot ring on top.
      const h = 44, rx = 30, ry = 39, wall = 9 - t * 1.5;
      return {
        id, name: 'Bowl', h, sprue: 12 + t * 6, pitch: 0.78, chill: 1 + t * 0.3,
        inside(x, y) {
          if (y > h) return false;
          if (y >= h - ry - 5 && y < h - ry + 2 && Math.abs(x) < 11) return true;
          const o = (x / rx) ** 2 + ((h - y) / ry) ** 2;
          const i = (x / (rx - wall)) ** 2 + ((h - y) / (ry - wall)) ** 2;
          return o <= 1 && i > 1;
        },
      };
    }
    case 'bell': {
      // Bell profile: rounded crown, a waist, and a flared sound bow at the lip; hanging loop on top.
      const h = 66, top = 7, wall = 6 - t, crown = 7 - t * 0.5;
      const outer = (y: number) => {
        const s = (y - top) / (h - top);
        let w = 13 + 6 * s + 16 * s ** 5;
        const R = 7;
        if (y < top + R) w -= R - Math.sqrt(Math.max(0, R * R - (top + R - y) ** 2));
        return w;
      };
      return {
        id, name: 'Bell', h, sprue: 18 + t * 6, pitch: 0.62, chill: 1.1 + t * 0.3,
        inside(x, y) {
          if (y > h) return false;
          const ax = Math.abs(x);
          if (y < top) return ax <= 5 && !(ax <= 2 && y >= 2 && y <= 4);
          if (ax > outer(y)) return false;
          if (y < top + crown) return true;
          // Sound bow: the wall thickens towards the lip.
          const s = (y - top) / (h - top);
          const wt = wall + 4 * s ** 4;
          return ax > outer(y) - wt || false;
        },
      };
    }
    case 'blade': {
      // A sword, point down: pommel, grip, crossguard, and a long blade that chills fast.
      const h = 78, bw = 4 - t * 0.5;
      return {
        id, name: 'Blade', h, sprue: 24 + t * 5, pitch: 1.25, chill: 1.35 + t * 0.3,
        inside(x, y) {
          if (y < 0 || y > h) return false;
          const ax = Math.abs(x);
          if (y <= 10) return ax * ax + (y - 5) ** 2 <= 30;
          if (y < 23) return ax <= 2;
          if (y < 28) return ax <= 16 - Math.max(0, (y - 25) * 1.2) && ax <= 17;
          if (y < h - 14) return ax <= bw;
          return ax <= bw * ((h - y) / 14) + 0.4;
        },
      };
    }
    case 'crest': {
      // A heater shield with a cross, cast as an openwork frame around four sand islands.
      const h = 62, w = 27, rim = 5 - t * 0.7, bar = 5 - t * 0.7;
      const half = (y: number) => (y < 26 ? w : w * Math.sqrt(Math.max(0, 1 - ((y - 26) / (h - 26)) ** 2)));
      return {
        id, name: 'Crest', h, sprue: 30 + t * 4, pitch: 0.95, chill: 1.25 + t * 0.3,
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
