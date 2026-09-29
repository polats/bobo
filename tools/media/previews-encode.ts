// Runs in headless Chrome (served by the capture dev server). Turns captured frames into a seamless
// 3 s H.264 MP4 loop + a WebP poster using WebCodecs via Mediabunny. Driven by previews.mjs.
import { BufferTarget, CanvasSource, Mp4OutputFormat, Output } from 'mediabunny';

const FPS = 24;

async function loadFrame(toy: string, i: number) {
  const img = new Image();
  img.src = `./frames/${toy}/${String(i).padStart(4, '0')}.jpg`;
  await img.decode();
  return img;
}

async function encode(toy: string, ts: number[], startSec: number, seconds: number, fadeSec: number, bitrate: number) {
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const g = canvas.getContext('2d')!;
  const t0 = ts[0];
  // Nearest captured frame to a clip time (captures are ~60 fps, previews 24 fps).
  const at = (sec: number) => {
    const target = t0 + sec;
    let best = 0;
    for (let i = 0; i < ts.length; i++) if (Math.abs(ts[i] - target) < Math.abs(ts[best] - target)) best = i;
    return best;
  };
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', bitrate, keyFrameInterval: 1 });
  output.addVideoTrack(source, { frameRate: FPS });
  await output.start();
  const n = Math.round(seconds * FPS);
  const fade = Math.round(fadeSec * FPS);
  let poster = '';
  for (let i = 0; i < n; i++) {
    const sec = startSec + i / FPS;
    g.globalAlpha = 1;
    g.drawImage(await loadFrame(toy, at(sec)), 0, 0, canvas.width, canvas.height);
    // Crossfade the tail into the frames just before the start, so the loop has no visible seam.
    if (i >= n - fade) {
      g.globalAlpha = (i - (n - fade) + 1) / (fade + 1);
      g.drawImage(await loadFrame(toy, at(sec - seconds)), 0, 0, canvas.width, canvas.height);
      g.globalAlpha = 1;
    }
    if (i === Math.floor(n * 0.5)) poster = canvas.toDataURL('image/webp', 0.72);
    await source.add(i / FPS, 1 / FPS);
  }
  await output.finalize();
  const buf = new Uint8Array((output.target as BufferTarget).buffer!);
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return { mp4: btoa(bin), poster: poster.split(',')[1] };
}

(window as unknown as Record<string, unknown>).encodePreview = encode;
(window as unknown as Record<string, unknown>).encoderReady = true;
