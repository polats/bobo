import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Panel } from './shell/panel';
import { Pointers } from './shell/pointers';
import { toyIcon } from './shell/icons';
import type { Toy, ToyInstance } from './shell/types';
// Each toy folder exports exactly one Toy from index.ts; the hub lists them in this order.
const ORDER = ['ink', 'goo', 'sand', 'pool', 'splash', 'cloth', 'laundry', 'thread', 'fire', 'jelly', 'demolition', 'ferro'];
const toys = Object.values(import.meta.glob<Record<string, unknown>>('./toys/*/index.ts', { eager: true }))
  .flatMap((m) => Object.values(m).filter(isToy))
  .sort((a, b) => rank(a.id) - rank(b.id));

function isToy(v: unknown): v is Toy {
  return typeof v === 'object' && v !== null && 'create' in v && 'id' in v;
}

function rank(id: string) {
  const i = ORDER.indexOf(id);
  return i < 0 ? ORDER.length : i;
}
const app = document.getElementById('app')!;

let teardown: (() => void) | null = null;

function route() {
  teardown?.();
  teardown = null;
  app.replaceChildren();
  const id = location.hash.replace(/^#\/?/, '');
  const toy = toys.find((t) => t.id === id);
  if (toy) teardown = mountToy(toy);
  else mountHub();
}

function mountHub() {
  const hub = document.createElement('div');
  hub.className = 'hub';
  const inner = document.createElement('div');
  inner.className = 'hub-inner';
  const header = document.createElement('header');
  header.className = 'hub-header';
  header.innerHTML = `<h1>bobo</h1><p class="lede">Physics toys. Poke everything.</p>`;
  const grid = document.createElement('div');
  grid.className = 'tile-grid';
  const gpuTiles: HTMLElement[] = [];
  for (const toy of toys) {
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'tile';
    tile.style.setProperty('--swatch', toy.swatch);
    tile.innerHTML = `<span class="tile-top"><span class="tile-icon"></span><span class="tile-platform"></span></span><span class="tile-text"><b></b><span class="tile-blurb"></span></span><em class="tile-tech"></em>`;
    tile.querySelector('.tile-icon')!.innerHTML = toyIcon(toy.id);
    tile.querySelector('b')!.textContent = toy.title;
    tile.querySelector('.tile-blurb')!.textContent = toy.blurb;
    // "Stable Fluids · WebGL2" → platform badge + technique label.
    const parts = toy.tech.split('·').map((x) => x.trim());
    const platform = parts.find((x) => /WebGL2|WebGPU/.test(x)) ?? '';
    tile.querySelector('.tile-platform')!.textContent = platform;
    tile.querySelector('.tile-tech')!.textContent = parts.filter((x) => x !== platform).join(' · ');
    tile.title = `Based on ${toy.refs.map((r) => r.short).join(' · ')}`;
    tile.addEventListener('click', () => (location.hash = toy.id));
    if (/WebGPU/.test(toy.tech)) gpuTiles.push(tile);
    grid.appendChild(tile);
  }
  const caps = document.createElement('p');
  caps.className = 'caps';
  const gl2 = document.createElement('canvas').getContext('webgl2') ? 'yes' : 'no';
  const setCaps = (gpu: string) => {
    caps.textContent = `WebGPU: ${gpu} · WebGL2: ${gl2} · DPR ${devicePixelRatio}`;
    console.log(`[bobo] ${caps.textContent} · secure ${isSecureContext}`);
    // Flag WebGPU toys that can't run here instead of letting them fail on open.
    if (gpu !== 'yes' && gpu !== 'checking…') gpuTiles.forEach((t) => t.classList.add('needs-gpu'));
  };
  setCaps('checking…');
  if (!navigator.gpu) setCaps(isSecureContext ? 'no' : 'no (insecure context)');
  else
    navigator.gpu
      .requestAdapter()
      .then((a) => setCaps(a ? 'yes' : 'no adapter'))
      .catch(() => setCaps('error'));
  inner.append(header, grid, caps);
  hub.appendChild(inner);
  app.appendChild(hub);
}

function mountToy(toy: Toy): () => void {
  const stage = document.createElement('div');
  stage.className = 'stage';
  const canvas = document.createElement('canvas');
  const overlay = document.createElement('div');
  const back = hudButton('‹ Toys', 'hud-back', () => (location.hash = ''));
  const tune = hudButton('Tune', 'hud-tune', () => panel.toggle());
  const fps = document.createElement('div');
  fps.className = 'hud-fps';
  stage.append(canvas, overlay, back, tune, fps);
  app.appendChild(stage);

  const panel = new Panel(stage);
  const pointers = new Pointers(canvas);
  // Full retina resolution is wasted on fluid sims; cap to keep fill-rate sane on phones.
  const pixelRatio = Math.min(devicePixelRatio, 2);
  let status = '';
  let instance: ToyInstance | null = null;
  let raf = 0;
  let alive = true;

  const resize = () => {
    const r = stage.getBoundingClientRect();
    const w = Math.max(1, Math.round(r.width * pixelRatio));
    const h = Math.max(1, Math.round(r.height * pixelRatio));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    instance?.resize(w, h);
  };
  const ro = new ResizeObserver(resize);
  ro.observe(stage);
  resize();

  console.log(`[bobo] creating ${toy.id}`);
  toy
    .create({ canvas, overlay, panel, pointers, pixelRatio, setStatus: (s) => (status = s), haptic })
    .then((inst) => {
      if (!alive) return inst.destroy();
      instance = inst;
      panel.heading('Based on');
      panel.links(toy.refs.map((r) => ({ title: r.title, url: r.url, note: r.use })));
      console.log(`[bobo] started ${toy.id}`);
      resize();
      start();
    })
    .catch((err) => {
      console.error(`[bobo] ${toy.id} could not start: ${err instanceof Error ? err.message : err}`);
      const n = document.createElement('div');
      n.className = 'notice';
      n.textContent = `${toy.title} could not start: ${err instanceof Error ? err.message : err}`;
      overlay.appendChild(n);
    });

  function start() {
    let last = performance.now();
    const t0 = last;
    let acc = 0;
    let frames = 0;
    let worst = 0;
    let lastLog = last;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const raw = (now - last) / 1000;
      last = now;
      // Clamp both ends: long stalls would explode sims, zero-length frames would divide by zero.
      const dt = Math.min(Math.max(raw, 1 / 1000), 1 / 30);
      if (window.boboAutoplay) autoplay(pointers, (now - t0) / 1000);
      instance!.frame(dt, (now - t0) / 1000);
      pointers.endFrame(dt);
      acc += raw;
      frames++;
      worst = Math.max(worst, raw);
      if (acc >= 0.5) {
        if (window.boboAutoplay && now - lastLog > 5000) {
          lastLog = now;
          console.log(`[bobo] ${toy.id} ${Math.round(frames / acc)} fps worst ${Math.round(worst * 1000)}ms ${status}`);
        }
        fps.textContent = `${Math.round(frames / acc)} fps · worst ${Math.round(worst * 1000)}ms${status ? '\n' + status : ''}`;
        acc = 0;
        frames = 0;
        worst = 0;
      }
    };
    raf = requestAnimationFrame(loop);
  }

  return () => {
    alive = false;
    cancelAnimationFrame(raf);
    ro.disconnect();
    pointers.destroy();
    instance?.destroy();
  };
}

/** Debug soak input: a fake finger tracing a figure-eight so FPS is measured under interaction. */
function autoplay(pointers: Pointers, t: number) {
  const id = -1;
  const x = 0.5 + 0.32 * Math.sin(t * 1.3);
  const y = 0.5 + 0.25 * Math.sin(t * 2.6);
  const p = pointers.active.get(id);
  // Lift the finger for half a second every 6 seconds so tap/pour-start paths run too.
  if (t % 6 > 5.5) {
    pointers.active.delete(id);
    return;
  }
  if (!p) pointers.active.set(id, { id, x, y, dx: 0, dy: 0, down: true, justDown: true, held: 0 });
  else {
    p.dx = x - p.x;
    p.dy = y - p.y;
    p.x = x;
    p.y = y;
  }
}

function hudButton(text: string, cls: string, onClick: () => void) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `hud-btn ${cls}`;
  b.textContent = text;
  b.addEventListener('click', onClick);
  return b;
}

let lastHaptic = 0;
function haptic(strength: 'light' | 'medium' | 'heavy' = 'light') {
  const now = performance.now();
  if (now - lastHaptic < 40) return;
  lastHaptic = now;
  if (Capacitor.isNativePlatform()) {
    const style = strength === 'heavy' ? ImpactStyle.Heavy : strength === 'medium' ? ImpactStyle.Medium : ImpactStyle.Light;
    Haptics.impact({ style }).catch(() => {});
  } else {
    navigator.vibrate?.(strength === 'heavy' ? 18 : strength === 'medium' ? 10 : 5);
  }
}

declare global {
  interface Window {
    boboStartToy?: string;
    boboAutoplay?: boolean;
  }
}

// Surface uncaught errors in the native console (Capacitor forwards console.* to the device log).
addEventListener('error', (e) => console.error(`[bobo] uncaught: ${e.message} @ ${e.filename}:${e.lineno}`));
addEventListener('unhandledrejection', (e) => console.error(`[bobo] unhandled rejection: ${e.reason}`));

addEventListener('hashchange', route);
if (window.boboStartToy && !location.hash) location.hash = window.boboStartToy;
else route();
