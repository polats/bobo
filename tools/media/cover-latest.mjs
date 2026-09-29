// The "what's new" README cover: the title tile plus the newest and freshly upgraded toys, 1200×640.
// Needs frames/<toy>/ from capture.mjs. Usage: node cover-latest.mjs → out/bobo-latest.gif
import { chromium } from 'playwright';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pickFrames, resize, writeGif } from './gif.mjs';

const FPS = Number(process.env.FPS ?? 10), SECONDS = 8, N = Math.round(FPS * SECONDS);
const W = 1200, H = 640, CW = 240, CH = 320;
// Same order as overlay-latest.html; cells are row-major after the two-cell title.
const toys = ['dig', 'spool', 'merge', 'marble', 'rinse', 'sandjar', 'fire', 'demolition'];
// Where the interesting part of each 8 s capture starts, so short clips show the action.
const START = { demolition: 0, merge: 0 };

const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: W, height: H } });
await p.goto('file://' + process.cwd() + '/overlay-latest.html');
await p.waitForTimeout(200);
const overlay = PNG.sync.read(await p.screenshot({ omitBackground: true }));
await b.close();

const collage = Array.from({ length: N }, () => new Uint8Array(W * H * 4));
toys.forEach((toy, i) => {
  const frames = pickFrames(toy, N, FPS);
  const { width: sw, height: sh } = frames[0];
  const c = i + 2, cx = c % 5, cy = Math.floor(c / 5);
  const skip = Math.round((START[toy] ?? 0) * FPS);
  for (let k = 0; k < N; k++) {
    const f = frames[Math.min(frames.length - 1, (k + skip) % frames.length)];
    const tile = resize(f.data, sw, sh, CW, CH);
    for (let y = 0; y < CH; y++) collage[k].set(tile.subarray(y * CW * 4, (y + 1) * CW * 4), ((cy * CH + y) * W + cx * CW) * 4);
  }
});
for (const dst of collage)
  for (let i = 0; i < W * H; i++) {
    const a = overlay.data[i * 4 + 3] / 255;
    if (a === 0) continue;
    for (let c = 0; c < 3; c++) dst[i * 4 + c] = overlay.data[i * 4 + c] * a + dst[i * 4 + c] * (1 - a);
    dst[i * 4 + 3] = 255;
  }
mkdirSync('out', { recursive: true });
const bytes = writeGif('out/bobo-latest.gif', collage, W, H, Math.round(1000 / FPS));
writeFileSync('out/bobo-latest-still.jpg', jpeg.encode({ data: Buffer.from(collage[Math.floor(N * 0.85)]), width: W, height: H }, 90).data);
console.log(`bobo-latest.gif ${(bytes / 1e6).toFixed(2)} MB, ${N} frames @ ${FPS} fps`);
