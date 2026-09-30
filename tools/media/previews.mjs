// Encodes src/previews/<toy>.mp4 + .webp from frames/<toy>/ (run capture.mjs first).
// Usage (with the capture dev server running on :5320): node previews.mjs [toy …]
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const toys = process.argv.slice(2).length ? process.argv.slice(2) : ['ink', 'goo', 'sand', 'pool', 'splash', 'cloth', 'laundry', 'thread', 'fire', 'jelly', 'demolition', 'ferro', 'marble', 'merge', 'rinse', 'sandjar', 'spool', 'dig', 'knockdown', 'peel', 'pour', 'mow', 'foundry', 'ink-letter', 'kintsugi', 'prints', 'chladni', 'glass', 'frost', 'bubble', 'plasma', 'snap', 'hourglass', 'honey'];
// Where in each 8 s capture the most telling 3 s are (seconds from capture start).
const START = { laundry: 4.6, thread: 2.2, demolition: 5.2, merge: 3.5, rinse: 4.5, spool: 2.5, dig: 1.6, knockdown: 0.6, peel: 1.2, pour: 1.0, mow: 1.4, foundry: 1.0, 'ink-letter': 1.2, kintsugi: 3.8, prints: 0.8, chladni: 3.6, glass: 2.5, frost: 3.5, bubble: 1.0, plasma: 1.0, snap: 1.5, hourglass: 1.2, honey: 1.5 };
const out = '../../src/previews';
mkdirSync(out, { recursive: true });
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage();
p.on('pageerror', (e) => console.log('pageerror:', e.message));
await p.goto('http://localhost:5320/tools/media/previews.html');
await p.waitForFunction(() => window.encoderReady);
let total = 0;
for (const toy of toys) {
  const ts = JSON.parse(readFileSync(`frames/${toy}/ts.json`, 'utf8'));
  const { mp4, poster } = await p.evaluate(([t, s, st]) => window.encodePreview(t, s, st, 3, 0.4, 560_000), [toy, ts, START[toy] ?? 4]);
  const video = Buffer.from(mp4, 'base64');
  const still = Buffer.from(poster, 'base64');
  writeFileSync(`${out}/${toy}.mp4`, video);
  writeFileSync(`${out}/${toy}.webp`, still);
  total += video.length + still.length;
  console.log(`${toy}: mp4 ${(video.length / 1024).toFixed(0)} KB · webp ${(still.length / 1024).toFixed(0)} KB`);
}
console.log(`total ${(total / 1024 / 1024).toFixed(2)} MB`);
await b.close();
