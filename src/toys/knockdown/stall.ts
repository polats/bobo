// Stall layouts and the material table. Units are metres; y = 0 is the bottom of the screen, the
// counter top sits at COUNTER and the stall floor (hidden behind the counter) at FLOOR.

export const COUNTER = 3.2;
export const FLOOR = 2.5;

export type Mat = 'can' | 'jar' | 'crate';

export interface Material {
  density: number;
  friction: number;
  restitution: number;
  /** Rolling resistance (Box2D 3.1): low for cans so they roll off, high for crates. */
  rolling: number;
  /** Velocity jump in one step (m/s) that breaks it; Infinity for cans, which only dent. */
  breakDv: number;
  /** Ball hits it takes to break (crates crack first); 0 = breaks on breakDv alone. */
  hits: number;
  /** Deceleration (m/s²) of the item sliding back along its shelf after a hit. */
  slide: number;
}

export const MATERIALS: Record<Mat, Material> = {
  can: { density: 0.45, friction: 0.35, restitution: 0.42, rolling: 0.01, breakDv: Infinity, hits: 0, slide: 3 },
  jar: { density: 1.1, friction: 0.5, restitution: 0.08, rolling: 0.05, breakDv: 3.5, hits: 0, slide: 4 },
  crate: { density: 2.4, friction: 0.75, restitution: 0.02, rolling: 0.12, breakDv: 4.4, hits: 2, slide: 10 },
};

export interface ItemSpec {
  mat: Mat;
  x: number;
  y: number;
  hx: number;
  hy: number;
  /** Can label, jam colour or wood tone. */
  color: number;
}

/** A shelf plank; y is its top surface. */
export interface ShelfSpec {
  x0: number;
  x1: number;
  y: number;
}

export interface StallSpec {
  layout: number;
  shelves: ShelfSpec[];
  items: ItemSpec[];
}

const CAN = [0.22, 0.3];
const JAR_S = [0.26, 0.3];
const JAR_T = [0.28, 0.4];
const CRATE = [0.42, 0.42];
const GAP = 0.02;
/** Bare plank either side of the outermost stacks. */
const SHELF_LIP = 0.3;
const MAX_ITEMS = 17;

const LABELS = [0xe8413c, 0x2f7de1, 0x3fae5a, 0xf2b632, 0xef6a2a, 0x9b59d0];
export const JAMS = [0xc8163a, 0xf08a24, 0x5b2f8e, 0x93c23a, 0xe0457b];
const WOODS = [0xc98d4e, 0xb97c3f, 0xd49a5c];

const LAYOUTS: ShelfSpec[][] = [
  // Three shelves, narrowing upward.
  [
    { x0: -3.5, x1: 3.5, y: 6.3 },
    { x0: -2.9, x1: 2.9, y: 9.3 },
    { x0: -2.3, x1: 2.3, y: 12.3 },
  ],
  // Two side shelves and a high centre one.
  [
    { x0: -3.75, x1: -0.55, y: 7 },
    { x0: 0.55, x1: 3.75, y: 7 },
    { x0: -2.2, x1: 2.2, y: 10.9 },
  ],
  // Two long shelves.
  [
    { x0: -3.7, x1: 3.7, y: 7 },
    { x0: -3.1, x1: 3.1, y: 10.9 },
  ],
  // Steps rising to the right.
  [
    { x0: -3.75, x1: -1.25, y: 6.4 },
    { x0: -1.3, x1: 1.3, y: 9.2 },
    { x0: 1.25, x1: 3.75, y: 12 },
  ],
];

type Group = (x: number, y: number, out: ItemSpec[]) => void;

const pick = <T>(a: T[]) => a[(Math.random() * a.length) | 0];

function can(out: ItemSpec[], x: number, y: number, color: number) {
  out.push({ mat: 'can', x, y: y + CAN[1], hx: CAN[0], hy: CAN[1], color });
}

function jar(out: ItemSpec[], x: number, y: number, tall: boolean) {
  const s = tall ? JAR_T : JAR_S;
  out.push({ mat: 'jar', x, y: y + s[1], hx: s[0], hy: s[1], color: pick(JAMS) });
}

function crate(out: ItemSpec[], x: number, y: number) {
  out.push({ mat: 'crate', x, y: y + CRATE[1], hx: CRATE[0], hy: CRATE[1], color: pick(WOODS) });
}

/** Stack builders, each with its footprint width. Everything sits exactly on what's below it. */
const GROUPS: [number, Group][] = [
  // The classic 3-2-1 can pyramid.
  [
    6 * CAN[0] + 2 * GAP,
    (x, y, out) => {
      const c = pick(LABELS);
      const w = 2 * CAN[0] + GAP;
      for (let row = 0; row < 3; row++)
        for (let i = 0; i < 3 - row; i++) can(out, x + (i - (2 - row) / 2) * w, y + row * 2 * CAN[1], row === 2 ? pick(LABELS) : c);
    },
  ],
  // 2-1 can pyramid.
  [
    4 * CAN[0] + GAP,
    (x, y, out) => {
      const c = pick(LABELS);
      const w = 2 * CAN[0] + GAP;
      can(out, x - w / 2, y, c);
      can(out, x + w / 2, y, c);
      can(out, x, y + 2 * CAN[1], pick(LABELS));
    },
  ],
  // A tower of cans.
  [
    2 * CAN[0],
    (x, y, out) => {
      const n = 2 + ((Math.random() * 2) | 0);
      for (let i = 0; i < n; i++) can(out, x, y + i * 2 * CAN[1], pick(LABELS));
    },
  ],
  // A row of jam jars.
  [
    6 * JAR_S[0] + 2 * GAP,
    (x, y, out) => {
      const w = 2 * JAR_S[0] + GAP;
      for (let i = -1; i <= 1; i++) jar(out, x + i * w, y, false);
    },
  ],
  // Two tall jars with a small one balanced on top.
  [
    4 * JAR_T[0] + GAP,
    (x, y, out) => {
      const w = 2 * JAR_T[0] + GAP;
      jar(out, x - w / 2, y, true);
      jar(out, x + w / 2, y, true);
      jar(out, x, y + 2 * JAR_T[1], false);
    },
  ],
  // A crate with a jar or a pair of cans on top.
  [
    2 * CRATE[0],
    (x, y, out) => {
      crate(out, x, y);
      const top = y + 2 * CRATE[1];
      if (Math.random() < 0.5) jar(out, x, top, Math.random() < 0.5);
      else {
        const c = pick(LABELS);
        can(out, x - CAN[0] - GAP / 2, top, c);
        can(out, x + CAN[0] + GAP / 2, top, c);
      }
    },
  ],
  // Two crates stacked, a can on top.
  [
    2 * CRATE[0],
    (x, y, out) => {
      crate(out, x, y);
      crate(out, x, y + 2 * CRATE[1]);
      can(out, x, y + 4 * CRATE[1], pick(LABELS));
    },
  ],
];

/** A random stall: one of the layouts, each shelf filled with random stacks, centred on the plank. */
export function randomStall(avoid = -1): StallSpec {
  // Keep stalls to a size 3-5 balls can clear.
  let best: StallSpec | null = null;
  for (let i = 0; i < 12; i++) {
    const s = tryStall(avoid);
    if (s.items.length >= 8 && s.items.length <= MAX_ITEMS) return s;
    if (!best || s.items.length < best.items.length) best = s;
  }
  return best!;
}

function tryStall(avoid: number): StallSpec {
  let layout = (Math.random() * LAYOUTS.length) | 0;
  if (layout === avoid) layout = (layout + 1) % LAYOUTS.length;
  const shelves = LAYOUTS[layout].map((s) => ({ ...s }));
  const items: ItemSpec[] = [];
  const kinds = new Set<Mat>();
  for (const s of shelves) {
    const row: ItemSpec[] = [];
    const placed: [number, number, Group][] = [];
    let used = 0;
    const room = s.x1 - s.x0 - 0.3;
    for (let tries = 0; tries < 12; tries++) {
      const g = pick(GROUPS);
      const gap = placed.length ? 0.35 + Math.random() * 0.4 : 0;
      if (used + gap + g[0] > room) continue;
      used += gap + g[0];
      placed.push([gap, g[0], g[1]]);
      // Each shelf holds 1-3 stacks (2 when there are three shelves).
      if (placed.length >= (shelves.length > 2 ? 2 : 3)) break;
    }
    let x = (s.x0 + s.x1) / 2 - used / 2;
    for (const [gap, w, build] of placed) {
      x += gap;
      build(x + w / 2, s.y, row);
      x += w;
    }
    // Trim the plank to its stacks, so a good shove sends things over the edge.
    if (placed.length) {
      const c = (s.x0 + s.x1) / 2;
      s.x0 = Math.max(s.x0, c - used / 2 - SHELF_LIP);
      s.x1 = Math.min(s.x1, c + used / 2 + SHELF_LIP);
    }
    for (const it of row) kinds.add(it.mat);
    items.push(...row);
  }
  // Every stall gets some glass: it's the best bit.
  if (!kinds.has('jar')) {
    const s = shelves[shelves.length - 1];
    const tops = items.filter((it) => it.y > s.y && it.y < s.y + 3);
    const x = tops.length ? Math.max(...tops.map((t) => t.x + t.hx)) + 0.3 + JAR_S[0] : (s.x0 + s.x1) / 2;
    if (x + JAR_S[0] < s.x1) jar(items, x, s.y, false);
    else if (tops.length) {
      // No room at the end of the shelf: put a jar on top of the highest stack instead.
      const top = tops.reduce((a, b) => (b.y + b.hy > a.y + a.hy ? b : a));
      jar(items, top.x, top.y + top.hy, false);
    }
  }
  return { layout, shelves, items };
}

/** 3 balls for a small stall, up to 5 for a big one. */
export function shotsFor(items: number) {
  return items <= 10 ? 3 : items <= 14 ? 4 : 5;
}
