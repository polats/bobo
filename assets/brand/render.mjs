import { chromium } from 'playwright';
// Renders icon.html / splash.html to PNGs with headless Chrome: node assets/brand/render.mjs "$PWD/assets/brand"
const [,, dir] = process.argv;
const b = await chromium.launch({ channel: 'chrome' });
for (const [name, size] of [['icon', 1024], ['splash', 2732]]) {
  const p = await b.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.goto('file://' + dir + '/' + name + '.html');
  await p.waitForTimeout(300);
  await p.screenshot({ path: dir + '/' + name + '.png', clip: { x: 0, y: 0, width: size, height: size } });
}
await b.close();
