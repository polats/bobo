import { Kind, Shape, type World } from './physics';

export type SceneId = 'tower' | 'castle' | 'pyramid' | 'jenga';

const BRICK = [0xc4553b, 0xb84a34, 0xd0654a, 0xa9432f, 0xc75f3f];
const STONE = [0xb8a58c, 0xa8957c, 0xc4b29a, 0x9d8b74];
const SAND = [0xe6b566, 0xdca858, 0xefc27a, 0xd49e4f];
const WOOD = [0xd9a066, 0xc98f55, 0xe3ae76, 0xbf854d];
const TOY = [0xff5d73, 0xffc145, 0x4cc3ff, 0x7bdc6b, 0xa98bff, 0xff8a3d];

const pick = (pal: number[], i: number) => pal[(Math.imul(i + 1, 2654435761) >>> 0) % pal.length];

export function ground(world: World) {
  world.add({ shape: Shape.Box, kind: Kind.Static, x: 0, y: -5, hx: 200, hy: 5, friction: 0.8, color: 0x5d8a3a });
}

function brick(world: World, x: number, y: number, hx: number, hy: number, color: number, density = 1) {
  return world.add({ shape: Shape.Box, x, y, hx, hy, color, breakable: true, sleeping: true, density });
}

/** Running-bond brick wall: whole bricks with half bricks at the ends of alternate courses. */
function wall(world: World, left: number, width: number, bottom: number, rows: number, bw: number, bh: number, pal: number[], seed = 0) {
  const cols = Math.round(width / bw);
  let n = 0;
  for (let r = 0; r < rows; r++) {
    const y = bottom + bh * (r + 0.5);
    if (r % 2 === 0) {
      for (let c = 0; c < cols; c++) brick(world, left + bw * (c + 0.5), y, bw / 2, bh / 2, pick(pal, seed + n++));
    } else {
      brick(world, left + bw * 0.25, y, bw / 4, bh / 2, pick(pal, seed + n++));
      for (let c = 0; c < cols - 1; c++) brick(world, left + bw * (c + 1), y, bw / 2, bh / 2, pick(pal, seed + n++));
      brick(world, left + width - bw * 0.25, y, bw / 4, bh / 2, pick(pal, seed + n++));
    }
  }
}

export function buildScene(world: World, id: SceneId) {
  ground(world);
  if (id === 'tower') {
    wall(world, -2.4, 4.8, 0, 32, 0.8, 0.4, BRICK);
    // A little toy flag-block crown on top.
    for (let i = 0; i < 4; i++) brick(world, -1.8 + i * 1.2, 32 * 0.4 + 0.25, 0.25, 0.25, TOY[i]);
  } else if (id === 'pyramid') {
    const rows = 20, s = 0.56;
    for (let r = 0; r < rows; r++) {
      const count = rows - r;
      for (let c = 0; c < count; c++) {
        const x = (c - (count - 1) / 2) * s;
        brick(world, x, s * (r + 0.5), s / 2, s / 2, pick(SAND, r * 31 + c));
      }
    }
  } else if (id === 'castle') {
    const bw = 0.7, bh = 0.35;
    wall(world, -4.9, 2.1, 0, 30, bw, bh, STONE, 1);
    wall(world, 2.8, 2.1, 0, 30, bw, bh, STONE, 7);
    wall(world, -2.8, 5.6, 0, 14, bw, bh, STONE, 3);
    // Battlements: alternating merlons on the wall and both towers.
    for (let i = 0; i < 4; i++) brick(world, -2.45 + i * 1.6, 14 * bh + 0.2, 0.35, 0.2, pick(STONE, i + 11));
    for (const left of [-4.9, 2.8]) for (let i = 0; i < 2; i++) brick(world, left + 0.35 + i * 1.4, 30 * bh + 0.2, 0.35, 0.2, pick(STONE, i + 5));
    // A gold keep block on each tower.
    brick(world, -3.85, 30 * bh + 0.6, 0.6, 0.2, 0xffc145);
    brick(world, 3.85, 30 * bh + 0.6, 0.6, 0.2, 0xffc145);
  } else {
    // Jenga, side view: a long plank, then three blocks end-on, alternating.
    const L = 2.4, th = 0.3;
    let y = th / 2;
    for (let layer = 0; layer < 22; layer++, y += th) {
      if (layer % 2 === 0) world.add({ shape: Shape.Box, x: 0, y, hx: L / 2, hy: th / 2, color: pick(WOOD, layer), sleeping: true, friction: 0.5, breakable: false });
      else for (let i = 0; i < 3; i++) world.add({ shape: Shape.Box, x: (i - 1) * (L / 3), y, hx: L / 6 - 0.004, hy: th / 2, color: pick(WOOD, layer * 3 + i), sleeping: true, friction: 0.5, breakable: false });
    }
  }
}

export const BUILD_COLORS = TOY;
