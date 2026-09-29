// Ram a flask full of sand around a bottom-gated cavity: a pouring basin and sprue down the left
// side, a runner along the bottom, ingates up into the cavity, and an open riser on its top. Metal
// falls down the sprue, runs along the runner, and the head in the sprue pushes it up into the
// cavity and on up the riser: when metal shows in the riser, the mould is full.

import { FRAME, FLOOR, FoundrySim, SAND } from './sim';
import type { Shape } from './shapes';

export interface Layout {
  cx: number;
  lipY: number;
  flaskTop: number;
  flaskBot: number;
  floorY: number;
  shelfY: number;
  /** Half-width of the sand inside the frame. */
  half: number;
}

export interface Mould {
  shape: Shape;
  cavTop: number;
  /** Column the crucible pours into (the sprue), and the cavity's centre column. */
  pourX: number;
  cavX: number;
  /** Cell indices of the cavity and of the gating system. */
  cav: Int32Array;
  gate: Int32Array;
  /** Packed sand cells when rammed (for "how broken is it"). */
  sand: number;
  /** Metal needed to fill cavity + gating. */
  volume: number;
}

export function layoutFor(rows: number, cols: number): Layout {
  const oy = Math.max(0, Math.floor((rows - 240) / 2));
  return {
    cx: Math.floor(cols / 2),
    lipY: oy + 40,
    flaskTop: oy + 64,
    flaskBot: oy + 172,
    floorY: oy + 196,
    shelfY: oy + 232,
    half: 42,
  };
}

export function buildMould(sim: FoundrySim, L: Layout, shape: Shape): Mould {
  sim.clear();
  const { W, cells, mask } = sim;
  const { cx, flaskTop, flaskBot, floorY, half } = L;
  for (let x = 0; x < W; x++) cells[floorY * W + x] = FLOOR;
  for (let y = flaskTop; y < flaskBot; y++) for (let x = cx - half; x <= cx + half; x++) cells[y * W + x] = SAND;
  // Frame: side bars stand a few cells proud of the sand so overflow puddles before it spills.
  for (let y = flaskTop - 3; y <= flaskBot; y++)
    for (const x of [cx - half - 2, cx - half - 1, cx + half + 1, cx + half + 2]) cells[y * W + x] = FRAME;
  for (let x = cx - half - 2; x <= cx + half + 2; x++) cells[flaskBot * W + x] = FRAME;
  const pourX = cx - half + 8, cavX = cx + 7;
  const runTop = flaskBot - 8, runBot = runTop + 3;
  const cavBot = runTop - 3, cavTop = cavBot - shape.h;
  const cav: number[] = [], gate: number[] = [];
  const open = (x: number, y: number, m: number) => {
    const k = y * W + x;
    if (mask[k] || cells[k] !== SAND) return;
    cells[k] = 0;
    mask[k] = m;
    (m === 1 ? cav : gate).push(k);
  };
  for (let y = 0; y <= shape.h; y++) for (let dx = -half + 2; dx <= half - 2; dx++) if (shape.inside(dx, y)) open(cavX + dx, cavTop + y, 1);
  // Basin: a cone narrowing into the sprue, which runs down to the runner.
  for (let y = flaskTop; y <= runBot; y++) {
    const j = y - flaskTop;
    const hw = j < 6 ? 6.5 - j * 0.85 : 1.5;
    for (let dx = -Math.floor(hw); dx <= Math.floor(hw); dx++) open(pourX + dx, y, 2);
  }
  // Runner along the bottom, ingates up into the cavity until they meet it.
  const far = Math.max(...shape.gates.map((g) => Math.round(cavX + g))) + 1;
  for (let y = runTop; y <= runBot; y++) for (let x = pourX - 1; x <= far; x++) open(x, y, 2);
  for (const g of shape.gates)
    for (let x = Math.round(cavX + g) - 1; x <= Math.round(cavX + g) + 1; x++)
      for (let y = runTop - 1; y > cavTop && mask[y * W + x] !== 1; y--) open(x, y, 2);
  // Riser: from the cavity's top up through the cope to the open air.
  for (let x = Math.round(cavX + shape.riser) - 1; x <= Math.round(cavX + shape.riser) + 1; x++) {
    let y = cavTop;
    while (y <= cavBot && mask[y * W + x] !== 1) y++;
    if (y > cavBot) continue;
    for (y--; y >= flaskTop; y--) open(x, y, 2);
  }
  let sand = 0;
  for (let y = flaskTop; y < flaskBot; y++) for (let x = cx - half; x <= cx + half; x++) if (cells[y * W + x] === SAND) sand++;
  sim.lo = flaskTop - 30;
  sim.hi = floorY;
  sim.hx0 = cx - half - 3;
  sim.hx1 = cx + half + 4;
  sim.hy0 = flaskTop - 6;
  sim.hy1 = flaskBot + 1;
  return { shape, cavTop, pourX, cavX, cav: Int32Array.from(cav), gate: Int32Array.from(gate), sand, volume: cav.length + gate.length };
}
