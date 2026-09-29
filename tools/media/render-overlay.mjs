import { chromium } from 'playwright';
const b = await chromium.launch({ channel: 'chrome' });
const p = await b.newPage({ viewport: { width: 1344, height: 768 } });
await p.goto('file://' + process.cwd() + '/overlay.html');
await p.waitForTimeout(200);
await p.screenshot({ path: 'overlay.png', omitBackground: true });
await b.close();
