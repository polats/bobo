// Encodes frames/<toy>/ into per-toy GIFs (240×320) and a 1008×1344 collage GIF (8 s loop).
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { pickFrames, resize, writeGif } from './gif.mjs';

const FPS = Number(process.env.FPS ?? 12.5);
const SECONDS = 8;
const N = Math.round(FPS * SECONDS);
const DELAY = Math.round(1000 / FPS);
const toys = ['ink', 'goo', 'sand', 'pool', 'splash', 'cloth', 'laundry', 'thread', 'fire', 'jelly', 'demolition', 'ferro', 'marble', 'merge', 'rinse', 'sandjar', 'spool', 'dig', 'knockdown', 'peel', 'pour', 'mow', 'foundry', 'ink-letter', 'kintsugi', 'prints', 'chladni', 'glass', 'frost', 'bubble', 'plasma', 'snap', 'hourglass', 'honey'];
// 6×6 grid, row-major; the title tile takes the first two cells (see overlay.html).
const cells = Object.fromEntries(toys.map((t, i) => [t, [(i + 2) % 6, Math.floor((i + 2) / 6)]]));
mkdirSync('out', { recursive: true });

const W = 1008, H = 1344, TW = 168, TH = 224, GW = 240, GH = 320;
const overlay = PNG.sync.read(readFileSync('overlay.png'));
const collage = Array.from({ length: N }, () => new Uint8Array(W * H * 4));
for (const toy of toys) {
  const frames = pickFrames(toy, N, FPS);
  const { width: sw, height: sh } = frames[0];
  if (!process.env.COLLAGE_ONLY) {
    const bytes = writeGif(`out/${toy}.gif`, frames.map((f) => resize(f.data, sw, sh, GW, GH)), GW, GH, DELAY);
    console.log(`${toy}.gif ${(bytes / 1e6).toFixed(2)} MB`);
  }
  const [cx, cy] = cells[toy];
  frames.forEach((f, k) => {
    const tile = resize(f.data, sw, sh, TW, TH);
    const dst = collage[k];
    for (let y = 0; y < TH; y++) dst.set(tile.subarray(y * TW * 4, (y + 1) * TW * 4), ((cy * TH + y) * W + cx * TW) * 4);
  });
}
// Composite the title tile, labels and grid lines.
for (const dst of collage)
  for (let i = 0; i < W * H; i++) {
    const a = overlay.data[i * 4 + 3] / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) dst[i * 4 + c] = overlay.data[i * 4 + c] * a + dst[i * 4 + c] * (1 - a);
    dst[i * 4 + 3] = 255;
  }
const bytes = writeGif('out/bobo-cover.gif', collage, W, H, DELAY);
console.log(`bobo-cover.gif ${(bytes / 1e6).toFixed(2)} MB, ${N} frames @ ${FPS} fps`);
writeFileSync('out/bobo-cover-still.jpg', jpeg.encode({ data: Buffer.from(collage[Math.floor(N * 0.6)]), width: W, height: H }, 90).data);
