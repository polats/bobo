// Records a tour of the hub (New carousel → Updated row → a toy sheet's What's new → swipe it away
// → the grid) and encodes out/bobo-menu.gif. Usage, with the capture server on :5320: node menu.mjs
import { chromium } from 'playwright';
import jpeg from 'jpeg-js';
import { mkdirSync, writeFileSync } from 'node:fs';
import { pickFrames, resize, writeGif } from './gif.mjs';

const VW = 390, VH = 844; // an iPhone-sized viewport
const GW = Number(process.env.GW ?? 300), GH = Math.round((GW * VH) / VW);
const FPS = Number(process.env.FPS ?? 12);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const b = await chromium.launch({ channel: 'chrome', args: ['--autoplay-policy=no-user-gesture-required'] });
const p = await b.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 });
p.on('pageerror', (e) => console.log('pageerror:', e.message));
await p.goto('http://localhost:5320/');
await p.waitForTimeout(2200); // previews load and start

mkdirSync('frames/menu', { recursive: true });
const cdp = await p.context().newCDPSession(p);
const shots = [];
cdp.on('Page.screencastFrame', async (f) => {
  shots.push({ data: f.data, ts: f.metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
});
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: VW * 2, maxHeight: VH * 2, everyNthFrame: 1 });
const t0 = Date.now();

const scrollHub = (top) => p.evaluate((y) => document.querySelector('.hub').scrollTo({ top: y, behavior: 'smooth' }), top);
const secTop = (name) =>
  p.evaluate((n) => {
    const h = [...document.querySelectorAll('.sec h2')].find((e) => e.textContent === n);
    const hub = document.querySelector('.hub');
    return h ? h.getBoundingClientRect().top + hub.scrollTop - 70 : 0;
  }, name);

await wait(1400);
// Flick through the New carousel.
await p.evaluate(() => document.querySelector('.carousel').scrollBy({ left: 330, behavior: 'smooth' }));
await wait(1300);
await p.evaluate(() => document.querySelector('.carousel').scrollBy({ left: 330, behavior: 'smooth' }));
await wait(1100);
// Down to the Updated row: each card says what changed.
await scrollHub(await secTop('Updated'));
await wait(2000);
// Open the Campfire sheet and show its What's new.
await p.locator('.hero-sm[data-toy="fire"]').first().click();
await wait(1500);
await p.evaluate(() => {
  const s = document.querySelector('.sheet.active');
  s.scrollTo({ top: s.scrollHeight, behavior: 'smooth' });
});
await wait(2000);
await p.evaluate(() => document.querySelector('.sheet.active').scrollTo({ top: 0, behavior: 'smooth' }));
await wait(700);
// Swipe it away by the grabber.
const g = await p.locator('.sheet.active .grabber').boundingBox();
await p.mouse.move(g.x + g.width / 2, g.y + 4);
await p.mouse.down();
for (let i = 1; i <= 14; i++) {
  await p.mouse.move(g.x + g.width / 2, g.y + 4 + i * 22);
  await wait(16);
}
await p.mouse.up();
await wait(900);
// And on into the grid of live previews.
await scrollHub(await secTop('All toys'));
await wait(2400);

await cdp.send('Page.stopScreencast');
const dur = (Date.now() - t0) / 1000;
shots.forEach((f, i) => writeFileSync(`frames/menu/${String(i).padStart(4, '0')}.jpg`, Buffer.from(f.data, 'base64')));
writeFileSync('frames/menu/ts.json', JSON.stringify(shots.map((f) => f.ts)));
await b.close();

const N = Math.floor((shots.at(-1).ts - shots[0].ts) * FPS);
const frames = pickFrames('menu', N, FPS);
const { width: sw, height: sh } = frames[0];
mkdirSync('out', { recursive: true });
const bytes = writeGif('out/bobo-menu.gif', frames.map((f) => resize(f.data, sw, sh, GW, GH)), GW, GH, Math.round(1000 / FPS));
writeFileSync('out/bobo-menu-still.jpg', jpeg.encode({ data: Buffer.from(resize(frames[Math.floor(N * 0.3)].data, sw, sh, GW * 2, GH * 2)), width: GW * 2, height: GH * 2 }, 88).data);
console.log(`bobo-menu.gif ${GW}×${GH}, ${N} frames over ${dur.toFixed(1)} s, ${(bytes / 1e6).toFixed(2)} MB`);
