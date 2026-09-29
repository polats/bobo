// Procedural fingerprints, SFinGe-style: an orientation field from the zero-pole model (cores and
// deltas), then oriented Gabor filtering of noise, repeated until ridges settle into a clean
// pattern with natural minutiae (ridge endings, forks). Result: a ridge map 0..1 in print space.

export type Pattern = 'loop-l' | 'loop-r' | 'whorl' | 'arch' | 'tented' | 'double';

export interface PrintSpec {
  pattern: Pattern;
  seed: number;
}

export interface Ridges {
  w: number;
  h: number;
  /** Ridge strength 0..1 (1 = ridge crest) inside the fingertip, 0 outside. Row 0 is the top. */
  data: Float32Array;
}

/** Ridge period in print cells; the toy's powder grid uses the same cells. */
export const PERIOD = 4.4;
export const PRINT_W = 100;
export const PRINT_H = 128;

export function rng(seed: number) {
  let s = (seed * 2654435761) >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

/** Ridge direction (radians, mod π) at every cell. Cores and deltas in normalised coords (-1..1). */
function orientation(spec: PrintSpec, w: number, h: number, r: () => number) {
  const out = new Float32Array(w * h);
  const j = (a: number) => (r() - 0.5) * a;
  let cores: [number, number][] = [];
  let deltas: [number, number][] = [];
  let arch = 0;
  const p = spec.pattern;
  // y is down in print space; the fingertip is the top of the ellipse.
  if (p === 'loop-l' || p === 'loop-r') {
    const s = p === 'loop-l' ? 1 : -1;
    cores = [[s * (0.08 + j(0.12)), -0.12 + j(0.14)]];
    deltas = [[s * (-0.62 + j(0.12)), 0.42 + j(0.14)]];
  } else if (p === 'whorl') {
    const a = j(0.6);
    cores = [[0.1 * Math.cos(a) + j(0.05), -0.1 + 0.1 * Math.sin(a)], [-0.1 * Math.cos(a) + j(0.05), -0.1 - 0.1 * Math.sin(a)]];
    deltas = [[-0.7 + j(0.1), 0.48 + j(0.1)], [0.7 + j(0.1), 0.48 + j(0.1)]];
  } else if (p === 'double') {
    cores = [[-0.16 + j(0.06), -0.22 + j(0.08)], [0.16 + j(0.06), 0.04 + j(0.08)]];
    deltas = [[-0.72 + j(0.1), 0.5 + j(0.1)], [0.66 + j(0.1), 0.34 + j(0.1)]];
  } else if (p === 'tented') {
    cores = [[j(0.1), -0.02 + j(0.1)]];
    deltas = [[j(0.1), 0.3 + j(0.08)]];
  } else arch = 0.9 + j(0.4);
  const rot = j(0.25);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const u = (x / (w - 1)) * 2 - 1, v = (y / (h - 1)) * 2 - 1;
      let t = rot;
      if (arch) {
        // Plain arch: ridges run across and hump up in the middle, flatter towards the bottom.
        t += -Math.atan(arch * 2.2 * u * Math.exp(-((v + 0.05) ** 2) * 2.5)) * 0.9;
      } else {
        for (const [cx, cy] of deltas) t -= 0.5 * Math.atan2(v - cy, u - cx);
        for (const [cx, cy] of cores) t += 0.5 * Math.atan2(v - cy, u - cx);
      }
      out[y * w + x] = t;
    }
  return out;
}

const ORIENTS = 24;
const KR = 5;

/** Oriented Gabor kernels, one per quantised ridge direction. */
function kernels() {
  const n = 2 * KR + 1;
  const ks: Float32Array[] = [];
  const f = 1 / PERIOD;
  for (let o = 0; o < ORIENTS; o++) {
    const th = (o / ORIENTS) * Math.PI;
    const k = new Float32Array(n * n);
    let sum = 0;
    for (let y = -KR; y <= KR; y++)
      for (let x = -KR; x <= KR; x++) {
        const along = x * Math.cos(th) + y * Math.sin(th);
        const across = -x * Math.sin(th) + y * Math.cos(th);
        const g = Math.exp(-(along * along) / (2 * 3.2 * 3.2) - (across * across) / (2 * 2.4 * 2.4)) * Math.cos(2 * Math.PI * f * across);
        k[(y + KR) * n + x + KR] = g;
        sum += Math.abs(g);
      }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    ks.push(k);
  }
  return ks;
}
let KS: Float32Array[] | null = null;

/** Fingertip outline: an egg, wider near the top, with a ragged rim where the skin barely touched. */
export function envelope(x: number, y: number, w: number, h: number, ph = 0) {
  const u = (x / (w - 1)) * 2 - 1, v = (y / (h - 1)) * 2 - 1;
  const ww = 0.92 - 0.12 * Math.max(0, v);
  const a = Math.atan2(v, u);
  const d = Math.hypot(u / ww, v / 0.97) + 0.035 * Math.sin(a * 5 + ph) + 0.025 * Math.sin(a * 11 - ph * 2);
  return Math.max(0, Math.min(1, (1 - d) * 6));
}

const cache = new Map<string, Ridges>();

export function makeRidges(spec: PrintSpec): Ridges {
  const key = `${spec.pattern}:${spec.seed}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const w = PRINT_W, h = PRINT_H;
  const r = rng(spec.seed);
  const th = orientation(spec, w, h, r);
  const oi = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    let t = th[i] % Math.PI;
    if (t < 0) t += Math.PI;
    oi[i] = Math.round((t / Math.PI) * ORIENTS) % ORIENTS;
  }
  KS ??= kernels();
  let a = new Float32Array(w * h);
  let b = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) a[i] = r() - 0.5;
  const n = 2 * KR + 1;
  for (let it = 0; it < 9; it++) {
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const k = KS[oi[y * w + x]];
        let s = 0;
        for (let ky = -KR; ky <= KR; ky++) {
          const yy = Math.min(h - 1, Math.max(0, y + ky));
          const row = yy * w, kr = (ky + KR) * n + KR;
          for (let kx = -KR; kx <= KR; kx++) {
            const xx = Math.min(w - 1, Math.max(0, x + kx));
            s += a[row + xx] * k[kr + kx];
          }
        }
        // Soft clip keeps ridges binary-ish while they self-organise.
        b[y * w + x] = Math.tanh(s * 6);
      }
    [a, b] = [b, a];
  }
  const data = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      data[i] = Math.max(0, Math.min(1, a[i] * 0.9 + 0.5)) * envelope(x, y, w, h, spec.seed % 7);
    }
  const res = { w, h, data };
  cache.set(key, res);
  return res;
}

/** Ink-on-card rendering (suspect cards and the lifted print). */
export function drawCard(g: CanvasRenderingContext2D, rid: Ridges, ink: string, x: number, y: number, s: number) {
  const img = g.createImageData(rid.w, rid.h);
  const [r, gg, b] = [parseInt(ink.slice(1, 3), 16), parseInt(ink.slice(3, 5), 16), parseInt(ink.slice(5, 7), 16)];
  for (let i = 0; i < rid.w * rid.h; i++) {
    const v = Math.max(0, Math.min(1, (rid.data[i] - 0.45) * 3.2));
    img.data[i * 4] = r;
    img.data[i * 4 + 1] = gg;
    img.data[i * 4 + 2] = b;
    img.data[i * 4 + 3] = v * 235;
  }
  const c = document.createElement('canvas');
  c.width = rid.w;
  c.height = rid.h;
  c.getContext('2d')!.putImageData(img, 0, 0);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(c, x, y, rid.w * s, rid.h * s);
}
