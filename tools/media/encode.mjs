// Encodes frames/<toy>/ into per-toy GIFs (240×320) and a 1344×768 collage GIF (8 s loop).
import gifenc from 'gifenc';
const { GIFEncoder, quantize, applyPalette } = gifenc;
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const FPS = Number(process.env.FPS ?? 12.5);
const SECONDS = 8;
const N = Math.round(FPS * SECONDS);
const DELAY = Math.round(1000 / FPS);
const toys = ['ink', 'goo', 'sand', 'pool', 'splash', 'cloth', 'laundry', 'thread', 'fire', 'jelly', 'demolition', 'ferro', 'marble', 'merge', 'rinse', 'sandjar', 'spool', 'dig'];
// 7×3 grid, row-major; the title tile takes the first three cells (see overlay.html).
const cells = Object.fromEntries(toys.map((t, i) => [t, [(i + 3) % 7, Math.floor((i + 3) / 7)]]));
mkdirSync('out', { recursive: true });

function pickFrames(toy) {
  const ts = JSON.parse(readFileSync(`frames/${toy}/ts.json`, 'utf8'));
  const out = [];
  let j = 0;
  for (let k = 0; k < N; k++) {
    const t = ts[0] + k / FPS;
    while (j + 1 < ts.length && Math.abs(ts[j + 1] - t) <= Math.abs(ts[j] - t)) j++;
    out.push(j);
  }
  return out.map((i) => jpeg.decode(readFileSync(`frames/${toy}/${String(i).padStart(4, '0')}.jpg`), { useTArray: true }));
}

function resize(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const fy = ((y + 0.5) * sh) / dh - 0.5, y0 = Math.max(0, Math.floor(fy)), y1 = Math.min(sh - 1, y0 + 1), wy = fy - y0;
    for (let x = 0; x < dw; x++) {
      const fx = ((x + 0.5) * sw) / dw - 0.5, x0 = Math.max(0, Math.floor(fx)), x1 = Math.min(sw - 1, x0 + 1), wx = fx - x0;
      for (let c = 0; c < 4; c++) {
        const a = src[(y0 * sw + x0) * 4 + c] * (1 - wx) + src[(y0 * sw + x1) * 4 + c] * wx;
        const b = src[(y1 * sw + x0) * 4 + c] * (1 - wx) + src[(y1 * sw + x1) * 4 + c] * wx;
        out[(y * dw + x) * 4 + c] = a * (1 - wy) + b * wy;
      }
    }
  }
  return out;
}

/**
 * One global palette (255 colours + a transparent slot) sampled across the clip, and pixels
 * unchanged since the previous frame written as transparent, so static regions cost ~nothing.
 */
function writeGif(path, frames, w, h) {
  const sampleIdx = Array.from({ length: 12 }, (_, i) => Math.floor((i * (frames.length - 1)) / 11));
  const px = w * h;
  const stride = 3; // sample every 3rd pixel of each sampled frame
  const sample = new Uint8Array(Math.ceil(px / stride) * 4 * sampleIdx.length);
  let o = 0;
  for (const k of sampleIdx) for (let i = 0; i < px; i += stride) { sample.set(frames[k].subarray(i * 4, i * 4 + 4), o); o += 4; }
  const palette = quantize(sample.subarray(0, o), 255, { format: 'rgb565' });
  const T = palette.length;
  palette.push([0, 0, 0]);
  const gif = GIFEncoder();
  // What the viewer currently sees; a pixel is only redrawn once it drifts visibly from it.
  const shown = new Int16Array(px * 3);
  const TOL = Number(process.env.TOL ?? 28);
  frames.forEach((rgba, k) => {
    const idx = applyPalette(rgba, palette.slice(0, T), 'rgb565');
    const out = new Uint8Array(px);
    for (let i = 0; i < px; i++) {
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      if (k > 0 && Math.abs(r - shown[i * 3]) + Math.abs(g - shown[i * 3 + 1]) + Math.abs(b - shown[i * 3 + 2]) < TOL) {
        out[i] = T;
        continue;
      }
      out[i] = idx[i];
      const c = palette[idx[i]];
      shown[i * 3] = c[0];
      shown[i * 3 + 1] = c[1];
      shown[i * 3 + 2] = c[2];
    }
    gif.writeFrame(out, w, h, k === 0 ? { palette, delay: DELAY } : { delay: DELAY, transparent: true, transparentIndex: T, dispose: 1 });
  });
  gif.finish();
  writeFileSync(path, gif.bytes());
  return gif.bytes().length;
}

const W = 1344, H = 768, TW = 192, TH = 256, GW = 240, GH = 320;
const overlay = PNG.sync.read(readFileSync('overlay.png'));
const collage = Array.from({ length: N }, () => new Uint8Array(W * H * 4));
for (const toy of toys) {
  const frames = pickFrames(toy);
  const { width: sw, height: sh } = frames[0];
  if (!process.env.COLLAGE_ONLY) {
    const bytes = writeGif(`out/${toy}.gif`, frames.map((f) => resize(f.data, sw, sh, GW, GH)), GW, GH);
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
const bytes = writeGif('out/bobo-cover.gif', collage, W, H);
console.log(`bobo-cover.gif ${(bytes / 1e6).toFixed(2)} MB, ${N} frames @ ${FPS} fps`);
writeFileSync('out/bobo-cover-still.jpg', jpeg.encode({ data: Buffer.from(collage[Math.floor(N * 0.6)]), width: W, height: H }, 90).data);
