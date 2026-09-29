// Records each toy with autoplay input via CDP screencast into frames/<toy>/ as JPEGs + timestamps.
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
const toys = process.argv.slice(2).length ? process.argv.slice(2) : ['ink', 'goo', 'sand', 'pool', 'splash', 'cloth', 'laundry', 'thread', 'fire', 'jelly', 'demolition', 'ferro', 'marble', 'merge', 'rinse', 'sandjar', 'spool', 'dig', 'knockdown', 'peel', 'pour', 'mow', 'foundry', 'ink-letter', 'kintsugi', 'prints'];
const WARM = 1500, DUR = 8400;
// Capture size: 360×480 (3:4) matches the hub's preview cards; scripted moves were authored at 300×375.
const VW = Number(process.env.VW ?? 360), VH = Number(process.env.VH ?? 480);
const scaled = (p) => {
  const sx = VW / 300, sy = VH / 375;
  return {
    raw: p,
    evaluate: (...a) => p.evaluate(...a),
    mouse: {
      move: (x, y, o) => p.mouse.move(x * sx, y * sy, o),
      down: (o) => p.mouse.down(o),
      up: (o) => p.mouse.up(o),
      click: (x, y, o) => p.mouse.click(x * sx, y * sy, o),
    },
  };
};
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Hand-authored moves for toys where the generic autoplay finger doesn't show them off.
const scripts = {
  async thread(q) {
    const p = q.raw;
    for (let k = 0; k < 9; k++) {
      const t = await p.evaluate(() => window.__thread());
      const x = t.near.x, y = t.near.y + 6;
      await p.mouse.move(x, y); await p.mouse.down();
      for (let i = 1; i <= 14; i++) { await p.mouse.move(x + Math.sin(i / 3) * 6, y + i * 7); await wait(24); }
      await p.mouse.up(); await wait(180);
    }
  },
  async ink(p) {
    // Separate swirls so each picks a fresh colour instead of mixing into mud.
    const strokes = [[60, 90, 240, 280], [250, 60, 60, 300], [150, 340, 150, 40], [40, 200, 260, 200], [240, 330, 70, 80], [70, 300, 230, 90]];
    const start = Date.now();
    for (let s = 0; Date.now() - start < 7600; s++) {
      const [x0, y0, x1, y1] = strokes[s % strokes.length];
      await p.mouse.move(x0, y0); await p.mouse.down();
      for (let i = 1; i <= 18; i++) {
        const f = i / 18;
        await p.mouse.move(x0 + (x1 - x0) * f + Math.sin(f * 9) * 30, y0 + (y1 - y0) * f + Math.cos(f * 9) * 30);
        await wait(28);
      }
      await p.mouse.up();
      // A quick tap burst between swirls keeps the screen bright.
      await p.mouse.click(x1, y1); await wait(250);
    }
  },
  async goo(p) {
    const tool = (name) => p.evaluate((n) => [...document.querySelectorAll('button')].find((b) => b.getAttribute('aria-label') === n || b.textContent?.trim() === n)?.click(), name);
    const pour = async (x, y, ms, dx = 0) => {
      await p.mouse.move(x, y); await p.mouse.down();
      const steps = Math.max(1, Math.round(ms / 30));
      for (let i = 1; i <= steps; i++) { await p.mouse.move(x + (dx * i) / steps, y); await wait(30); }
      await p.mouse.up();
    };
    await tool('Jelly'); await pour(80, 80, 120); await wait(250); await pour(220, 70, 120); await wait(300);
    await tool('Snow'); await pour(150, 60, 700, 60);
    await tool('Sand'); await pour(60, 90, 700, 40);
    await tool('Water'); await pour(250, 60, 900, -40);
    await wait(900);
    await tool('Poke'); await pour(30, 300, 1500, 240);
  },
  // Wave 3 and the theme toys drive their dev hooks on the raw 360×480 page.
  async knockdown(q) {
    const p = q.raw;
    await wait(500);
    for (const [x, dx] of [[180, -14], [180, 16], [180, 0]]) {
      await p.mouse.move(x, 380); await p.mouse.down();
      for (let i = 1; i <= 10; i++) { await p.mouse.move(x - (dx * i) / 10, 380 + i * 8); await wait(16); }
      await p.mouse.up();
      await wait(1900);
    }
  },
  async peel(q) {
    const p = q.raw;
    await wait(300);
    const t = await p.evaluate(() => window.__peel.tab());
    const tx = 360 - t.x, ty = 480 - t.y;
    await p.mouse.move(t.x, t.y); await p.mouse.down();
    for (let i = 1; i <= 110; i++) { await p.mouse.move(t.x + ((tx - t.x) * i) / 110, t.y + ((ty - t.y) * i) / 110); await wait(55); }
    await p.mouse.up();
  },
  async pour(q) {
    const p = q.raw;
    await wait(400);
    const moves = (await p.evaluate(() => window.__pour.solve())) ?? [];
    for (const [a, b] of moves.slice(0, 5)) {
      for (const i of [a, b]) {
        const [x, y] = await p.evaluate((k) => window.__pour.tubeXY(k), i);
        await p.mouse.click(x, y);
        await wait(250);
      }
      await wait(1100);
    }
  },
  async mow(q) {
    const p = q.raw;
    await wait(300);
    let y = 150;
    await p.mouse.move(40, y); await p.mouse.down();
    for (let row = 0; row < 5; row++, y += 38) {
      const [x0, x1] = row % 2 ? [320, 40] : [40, 320];
      for (let i = 0; i <= 24; i++) { await p.mouse.move(x0 + ((x1 - x0) * i) / 24, y); await wait(40); }
      for (let i = 1; i <= 4; i++) { await p.mouse.move(x1, y + (38 * i) / 4); await wait(30); }
    }
    await p.mouse.up();
  },
  async foundry(q) {
    const p = q.raw;
    await wait(300);
    await p.mouse.move(180, 160); await p.mouse.down();
    await wait(3600);
    await p.mouse.up();
    await wait(1600);
    for (let i = 0; i < 4; i++) { await p.mouse.click(180, 330); await wait(260); }
    await wait(900);
    await p.mouse.click(180, 380);
  },
  async 'ink-letter'() {
    // The first letter sways over the candle on its own for 6.5 s, which is the hook.
  },
  async kintsugi(q) {
    const p = q.raw;
    await wait(2300); // it drops and shatters on its own
    await p.evaluate(() => window.__kintsugiSolve());
  },
  async prints(q) {
    const p = q.raw;
    await wait(300);
    const r = await p.evaluate(() => window.__prints.print());
    await p.mouse.move(r.x - r.w, r.y - r.h); await p.mouse.down();
    for (let k = 0; k < 7; k++) {
      const yy = r.y - r.h + ((2 * r.h) * k) / 6;
      for (let i = 0; i <= 12; i++) { await p.mouse.move(r.x + (k % 2 ? 1 : -1) * r.w * (1 - (2 * i) / 12), yy); await wait(28); }
    }
    await p.mouse.up();
  },
  async dig(p) {
    // Dig a pit under the lawn, tunnel sideways to undercut it, then drill down.
    const stroke = async (pts, delay) => {
      await p.mouse.move(...pts[0]); await p.mouse.down();
      for (const q of pts.slice(1)) { await p.mouse.move(...q); await wait(delay); }
      await p.mouse.up();
    };
    await wait(400);
    await stroke(Array.from({ length: 26 }, (_, i) => [140 + Math.sin(i / 2) * 30, 118 + i * 4]), 22);
    await stroke(Array.from({ length: 22 }, (_, i) => [140 + i * 5, 205 + Math.sin(i / 3) * 8]), 22);
    await wait(900);
    await stroke(Array.from({ length: 90 }, (_, i) => [150 + Math.sin(i / 4) * 50, 290 + Math.sin(i / 7) * 10]), 26);
  },
  async spool(p) {
    // Tap the four spools in turn so several yarns reel at once.
    await wait(700);
    for (let i = 0; i < 16; i++) {
      await p.mouse.click([44, 115, 186, 257][i % 4], 314);
      await wait(420);
    }
  },
  async merge(p) {
    for (let i = 0; i < 12; i++) {
      const x = 90 + ((i * 53) % 130);
      await p.mouse.move(x, 70); await p.mouse.down(); await p.mouse.move(x + 4, 72); await p.mouse.up();
      await wait(620);
    }
  },
  async laundry(p) {
    const swipe = async (x0, y0, dx, steps, delay) => {
      await p.mouse.move(x0, y0); await p.mouse.down();
      for (let i = 1; i <= steps; i++) { await p.mouse.move(x0 + (dx * i) / steps, y0 - i * 2); await wait(delay); }
      await p.mouse.up();
    };
    await wait(3000);
    await swipe(20, 345, 70, 10, 32);
    await wait(1500);
    await swipe(20, 335, 150, 12, 22);
    await wait(900);
    await p.mouse.move(24, 60); await p.mouse.down(); await wait(1500); await p.mouse.up();
  },
};
const b = await chromium.launch({ channel: 'chrome', args: ['--enable-unsafe-webgpu', '--ignore-gpu-blocklist', '--use-angle=metal', '--enable-gpu'] });
for (const toy of toys) {
  const dir = `frames/${toy}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const p = await b.newPage({ viewport: { width: VW, height: VH }, deviceScaleFactor: 2 });
  if (!scripts[toy]) await p.addInitScript(() => { window.boboAutoplay = true; });
  p.on('pageerror', (e) => console.log(toy, 'pageerror:', e.message));
  await p.goto(`http://localhost:5320/#${toy}`);
  await p.addStyleTag({ content: '.stage > div, .stage > button, .panel { display: none !important; }' });
  await p.waitForTimeout(WARM);
  const cdp = await p.context().newCDPSession(p);
  const frames = [];
  cdp.on('Page.screencastFrame', async (f) => {
    frames.push({ data: f.data, ts: f.metadata.timestamp });
    await cdp.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {});
  });
  await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 88, maxWidth: VW * 2, maxHeight: VH * 2, everyNthFrame: 1 });
  const t0 = Date.now();
  if (scripts[toy]) await scripts[toy](scaled(p));
  await p.waitForTimeout(Math.max(0, DUR - (Date.now() - t0)));
  await cdp.send('Page.stopScreencast');
  frames.forEach((f, i) => writeFileSync(`${dir}/${String(i).padStart(4, '0')}.jpg`, Buffer.from(f.data, 'base64')));
  writeFileSync(`${dir}/ts.json`, JSON.stringify(frames.map((f) => f.ts)));
  const span = frames.length ? frames.at(-1).ts - frames[0].ts : 0;
  console.log(toy, frames.length, 'frames over', span.toFixed(2), 's');
  await p.close();
}
await b.close();
