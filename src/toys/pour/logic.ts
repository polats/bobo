// Puzzle rules, kept tiny and pure so undo is a snapshot and the solver can search it.
// A tube is a stack of units (liquid ids, bottom → top). Liquids have densities: after every pour a
// tube settles with a stable sort, heaviest at the bottom, so oil floats up and syrup sinks.
// You may pour onto an empty tube, onto the same liquid, or onto a liquid of a different density
// (they don't mix, they re-order). Same-density waters of different colours don't stack.

export type Kind = 0 | 1 | 2; // water, oil, syrup

export interface Liquid {
  name: string;
  rgb: [number, number, number];
  density: number;
  kind: Kind;
}

export interface Puzzle {
  cap: number;
  liquids: Liquid[];
  tubes: number[][];
}

const WATERS: Liquid[] = [
  { name: 'red', rgb: [0.97, 0.25, 0.34], density: 1, kind: 0 },
  { name: 'blue', rgb: [0.2, 0.5, 1.0], density: 1, kind: 0 },
  { name: 'green', rgb: [0.2, 0.82, 0.42], density: 1, kind: 0 },
  { name: 'purple', rgb: [0.64, 0.38, 0.98], density: 1, kind: 0 },
  { name: 'yellow', rgb: [1.0, 0.84, 0.2], density: 1, kind: 0 },
  { name: 'pink', rgb: [1.0, 0.48, 0.78], density: 1, kind: 0 },
  { name: 'teal', rgb: [0.14, 0.84, 0.82], density: 1, kind: 0 },
  { name: 'orange', rgb: [1.0, 0.56, 0.16], density: 1, kind: 0 },
];
export const OIL: Liquid = { name: 'oil', rgb: [0.98, 0.86, 0.5], density: 0.8, kind: 1 };
export const SYRUP: Liquid = { name: 'syrup', rgb: [0.46, 0.07, 0.2], density: 1.5, kind: 2 };

export const top = (t: number[]) => t[t.length - 1];

/** Length of the run of identical units at the top. */
export function run(t: number[]) {
  let k = t.length - 1;
  while (k > 0 && t[k - 1] === t[k]) k--;
  return t.length - k;
}

export function canPour(p: Puzzle, tubes: number[][], a: number, b: number) {
  const A = tubes[a], B = tubes[b];
  if (a === b || !A.length || B.length >= p.cap) return false;
  if (!B.length || top(A) === top(B)) return true;
  return p.liquids[top(A)].density !== p.liquids[top(B)].density;
}

/** Units that would move from a to b. */
export function pourAmount(p: Puzzle, tubes: number[][], a: number, b: number) {
  return Math.min(run(tubes[a]), p.cap - tubes[b].length);
}

/** Stable sort by density, heaviest first (bottom). */
export function settle(p: Puzzle, t: number[]) {
  return t
    .map((u, i) => [u, i])
    .sort((x, y) => p.liquids[y[0]].density - p.liquids[x[0]].density || x[1] - y[1])
    .map((x) => x[0]);
}

export function applyPour(p: Puzzle, tubes: number[][], a: number, b: number) {
  const n = pourAmount(p, tubes, a, b);
  const liq = top(tubes[a]);
  const next = tubes.map((t) => t.slice());
  next[a].length -= n;
  for (let i = 0; i < n; i++) next[b].push(liq);
  next[b] = settle(p, next[b]);
  return { tubes: next, n, liq };
}

export function tubeSolved(p: Puzzle, t: number[]) {
  return t.length === p.cap && t.every((u) => u === t[0]);
}

export function solved(p: Puzzle, tubes: number[][]) {
  return tubes.every((t) => !t.length || tubeSolved(p, t));
}

const key = (tubes: number[][]) => tubes.map((t) => String.fromCharCode(...t.map((u) => 65 + u))).sort().join('|');

/** How unsorted: colour boundaries inside tubes plus colours split across tubes. */
function score(p: Puzzle, tubes: number[][]) {
  let h = 0;
  const seen = new Set<number>();
  for (const t of tubes) {
    for (let i = 1; i < t.length; i++) if (t[i] !== t[i - 1]) h++;
    if (t.length) {
      if (seen.has(t[0])) h++;
      seen.add(t[0]);
    }
  }
  return h;
}

/**
 * Best-first search for a move list that sorts the puzzle (not always the shortest, but it finds
 * one fast and says null only if the space runs out under the budget).
 */
export function solve(p: Puzzle, start: number[][], budget = 60000): [number, number][] | null {
  interface Node {
    tubes: number[][];
    parent: number;
    move: [number, number];
    g: number;
  }
  const nodes: Node[] = [{ tubes: start, parent: -1, move: [-1, -1], g: 0 }];
  const seen = new Set([key(start)]);
  const heap = new MinHeap();
  heap.push(score(p, start), 0);
  while (heap.size && nodes.length < budget) {
    const i = heap.pop();
    const cur = nodes[i];
    if (solved(p, cur.tubes)) {
      const out: [number, number][] = [];
      for (let k = i; nodes[k].parent >= 0; k = nodes[k].parent) out.push(nodes[k].move);
      return out.reverse();
    }
    const T = cur.tubes;
    for (let a = 0; a < T.length; a++) {
      if (!T[a].length || tubeSolved(p, T[a])) continue;
      for (let b = 0; b < T.length; b++) {
        if (!canPour(p, T, a, b)) continue;
        // Moving a whole single-liquid tube into an empty one only relabels tubes.
        if (!T[b].length && run(T[a]) === T[a].length) continue;
        const next = applyPour(p, T, a, b).tubes;
        const k = key(next);
        if (seen.has(k)) continue;
        seen.add(k);
        nodes.push({ tubes: next, parent: i, move: [a, b], g: cur.g + 1 });
        heap.push(score(p, next) * 2 + (cur.g + 1) * 0.5, nodes.length - 1);
      }
    }
  }
  return null;
}

class MinHeap {
  private k: number[] = [];
  private v: number[] = [];
  get size() {
    return this.k.length;
  }
  push(key: number, val: number) {
    const { k, v } = this;
    let i = k.length;
    k.push(key);
    v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= k[i]) break;
      [k[p], k[i]] = [k[i], k[p]];
      [v[p], v[i]] = [v[i], v[p]];
      i = p;
    }
  }
  pop() {
    const { k, v } = this;
    const out = v[0];
    const lk = k.pop()!, lv = v.pop()!;
    if (k.length) {
      k[0] = lk;
      v[0] = lv;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i;
        if (l < k.length && k[l] < k[m]) m = l;
        if (r < k.length && k[r] < k[m]) m = r;
        if (m === i) break;
        [k[m], k[i]] = [k[i], k[m]];
        [v[m], v[i]] = [v[i], v[m]];
        i = m;
      }
    }
    return out;
  }
}

// ------------------------------------------------------------------ levels

interface Plan {
  waters: number;
  oil: boolean;
  syrup: boolean;
  cap: number;
  minMoves: number;
}

export function plan(level: number): Plan {
  const L = level;
  if (L <= 1) return { waters: 4, oil: false, syrup: false, cap: 3, minMoves: 5 };
  if (L === 2) return { waters: 4, oil: false, syrup: false, cap: 4, minMoves: 7 };
  if (L === 3) return { waters: 3, oil: true, syrup: false, cap: 4, minMoves: 6 };
  if (L === 4) return { waters: 5, oil: false, syrup: false, cap: 4, minMoves: 9 };
  if (L === 5) return { waters: 3, oil: false, syrup: true, cap: 4, minMoves: 6 };
  if (L === 6) return { waters: 3, oil: true, syrup: true, cap: 4, minMoves: 8 };
  // Endless: rotate through bigger mixes, never more than 6 liquids (8 tubes).
  const mix: [number, boolean, boolean][] = [
    [4, true, true],
    [5, false, true],
    [5, true, false],
    [6, false, false],
  ];
  const [waters, oil, syrup] = mix[L % mix.length];
  return { waters, oil, syrup, cap: 4, minMoves: 10 };
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Deal a random mix, settle every tube, and keep it only if the solver can finish it and it isn't
 * trivially short. The deal is seeded by the level, so "restart" gives the same puzzle.
 */
export function generate(level: number): Puzzle {
  const pl = plan(level);
  const rand = mulberry(level * 7919 + 17);
  // Keep oil and syrup visually distinct from the waters next to them.
  const pool = WATERS.filter((w) => !(pl.oil && (w.name === 'yellow' || w.name === 'orange')) && !(pl.syrup && w.name === 'purple'));
  const liquids: Liquid[] = pool.slice(0, pl.waters);
  if (pl.oil) liquids.push(OIL);
  if (pl.syrup) liquids.push(SYRUP);
  const nl = liquids.length;
  let fallback: Puzzle | null = null;
  for (let attempt = 0; attempt < 400; attempt++) {
    const units: number[] = [];
    for (let i = 0; i < nl; i++) for (let k = 0; k < pl.cap; k++) units.push(i);
    for (let i = units.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [units[i], units[j]] = [units[j], units[i]];
    }
    const p: Puzzle = { cap: pl.cap, liquids, tubes: [] };
    for (let t = 0; t < nl; t++) p.tubes.push(settle(p, units.slice(t * pl.cap, (t + 1) * pl.cap)));
    p.tubes.push([], []);
    if (p.tubes.some((t) => tubeSolved(p, t))) continue;
    const sol = solve(p, p.tubes, 20000);
    if (!sol) continue;
    fallback ??= p;
    if (sol.length >= pl.minMoves) return p;
  }
  if (fallback) return fallback;
  // Can't happen in practice; a guaranteed-solvable fallback is a solved state with legal reverse moves.
  const p: Puzzle = { cap: pl.cap, liquids, tubes: liquids.map((_, i) => Array(pl.cap).fill(i)) };
  p.tubes.push([top(p.tubes[0])], [top(p.tubes[1])]);
  p.tubes[0].pop();
  p.tubes[1].pop();
  return p;
}
