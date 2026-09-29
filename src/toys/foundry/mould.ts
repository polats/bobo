// Ram a flask full of sand around a cavity: pouring basin on top, a sprue down to the cavity, an
// iron frame and bottom board holding it all, the grate floor below.

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
  /** Cell indices of the cavity and of the basin + sprue. */
  cav: Int32Array;
  gate: Int32Array;
  /** Packed sand cells when rammed (for "how broken is it"). */
  sand: number;
  /** Metal needed to fill cavity + gate. */
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
  const cavTop = Math.min(flaskTop + shape.sprue, flaskBot - 5 - shape.h);
  const cav: number[] = [], gate: number[] = [];
  for (let y = 0; y <= shape.h; y++)
    for (let dx = -half + 2; dx <= half - 2; dx++) {
      if (!shape.inside(dx, y)) continue;
      const k = (cavTop + y) * W + cx + dx;
      cells[k] = 0;
      mask[k] = 1;
      cav.push(k);
    }
  // Basin: a cone narrowing to the sprue; the sprue runs down until it meets the cavity.
  for (let y = flaskTop; y < cavTop + 2; y++) {
    const j = y - flaskTop;
    const hw = j < 6 ? 6.5 - j * 0.85 : 1.5;
    for (let dx = -Math.floor(hw); dx <= Math.floor(hw); dx++) {
      const k = y * W + cx + dx;
      if (mask[k]) continue;
      cells[k] = 0;
      mask[k] = 2;
      gate.push(k);
    }
  }
  let sand = 0;
  for (let y = flaskTop; y < flaskBot; y++) for (let x = cx - half; x <= cx + half; x++) if (cells[y * W + x] === SAND) sand++;
  sim.lo = flaskTop - 30;
  sim.hi = floorY;
  return { shape, cavTop, cav: Int32Array.from(cav), gate: Int32Array.from(gate), sand, volume: cav.length + gate.length };
}
