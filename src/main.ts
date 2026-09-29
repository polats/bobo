import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';
import { Panel } from './shell/panel';
import { Pointers } from './shell/pointers';
import { mountHub } from './shell/hub';
import { micIcon, soundIcon } from './shell/icons';
import { mic } from './shell/mic';
import { hapticFrame, hapticLevel, hapticStop, hapticTier } from './shell/haptics';
import { onSoundChange, setSoundEnabled, sound, soundEnabled, unlockSound } from './shell/sound';
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
document.addEventListener('visibilitychange', () => document.hidden && hapticStop());
hapticTier().then((t) => console.log(`[bobo] haptics: ${t}`));
// Audio can only start inside a user gesture; every tap re-arms it (iOS suspends it in the background).
document.addEventListener('pointerdown', unlockSound, { capture: true, passive: true });

let teardown: (() => void) | null = null;

function route() {
  teardown?.();
  teardown = null;
  app.replaceChildren();
  const id = location.hash.replace(/^#\/?/, '');
  const toy = toys.find((t) => t.id === id);
  if (toy) teardown = mountToy(toy);
  else teardown = mountHub(app, toys);
}

function mountToy(toy: Toy): () => void {
  const stage = document.createElement('div');
  stage.className = 'stage';
  const canvas = document.createElement('canvas');
  const overlay = document.createElement('div');
  const back = hudButton('‹ Toys', 'hud-back', () => (location.hash = ''));
  const tune = hudButton('Tune', 'hud-tune', () => panel.toggle());
  const clip = hudButton('● Clip', 'hud-clip', () => recordClip(canvas, clip, stage));
  if (!('MediaRecorder' in window) || !canvas.captureStream) clip.hidden = true;
  const mute = hudButton('', 'hud-sound', () => setSoundEnabled(!soundEnabled()));
  const showMute = (on: boolean) => {
    mute.innerHTML = soundIcon(on);
    mute.setAttribute('aria-label', on ? 'Mute sound' : 'Unmute sound');
  };
  showMute(soundEnabled());
  const offSound = onSoundChange(showMute);
  // The mic button only appears for toys that offer it; tapping it asks for permission once.
  let micHint = '';
  const micBtn = hudButton('', 'hud-mic', async () => {
    if (mic.active) {
      mic.stop();
    } else {
      const ok = await mic.start();
      toast(stage, ok ? micHint : 'The microphone isn’t available');
    }
    micBtn.innerHTML = micIcon(mic.active);
    micBtn.classList.toggle('on', mic.active);
  });
  micBtn.innerHTML = micIcon(false);
  micBtn.hidden = true;
  const micCtx = Object.assign(mic, {
    offer(hint: string) {
      micHint = hint;
      micBtn.hidden = false;
    },
  });
  const fps = document.createElement('div');
  fps.className = 'hud-fps';
  const meter = makeMeter();
  stage.append(canvas, overlay, back, tune, clip, mute, micBtn, fps, meter.el);
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
    .create({ canvas, overlay, panel, pointers, pixelRatio, setStatus: (s) => (status = s), sound, haptic, hapticLevel, mic: micCtx, progress: meter.set, celebrate: (msg) => celebrate(stage, msg) })
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
      hapticFrame(now);
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
    offSound();
    hapticStop();
    mic.stop();
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

/** Completion ring for toys that have a goal ("73% clean"). */
function makeMeter() {
  const el = document.createElement('div');
  el.className = 'hud-meter';
  el.hidden = true;
  el.innerHTML = `<svg viewBox="0 0 36 36" aria-hidden="true"><circle class="track" cx="18" cy="18" r="15"/><circle class="fill" cx="18" cy="18" r="15"/></svg><span></span>`;
  const fill = el.querySelector<SVGCircleElement>('.fill')!;
  const text = el.querySelector('span')!;
  const C = 2 * Math.PI * 15;
  fill.style.strokeDasharray = `${C}`;
  let last = '';
  return {
    el,
    set(fraction: number | null, label = '') {
      if (fraction === null) {
        el.hidden = true;
        return;
      }
      const f = Math.max(0, Math.min(1, fraction));
      const key = `${Math.round(f * 100)}|${label}`;
      el.hidden = false;
      if (key === last) return;
      last = key;
      fill.style.strokeDashoffset = `${C * (1 - f)}`;
      text.textContent = `${Math.round(f * 100)}%${label ? ` ${label}` : ''}`;
      el.classList.toggle('done', f >= 1);
    },
  };
}

/** A short message pill over the toy. */
function toast(stage: HTMLElement, message: string) {
  const t = document.createElement('div');
  t.className = 'hud-toast';
  t.textContent = message;
  stage.appendChild(t);
  t.animate([{ opacity: 0, transform: 'translate(-50%, 8px)' }, { opacity: 1, transform: 'translate(-50%, 0)' }], { duration: 220 });
  setTimeout(() => (t.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400 }).onfinish = () => t.remove()), 2200);
}

/** Confetti, a toast and a heavy haptic: the shared "you did it" beat. */
function celebrate(stage: HTMLElement, message = 'Done!') {
  haptic('heavy');
  sound.play('chime');
  const colors = ['#ff7ab6', '#ffd166', '#6ee7ff', '#8b5cf6', '#7ee787', '#ffffff'];
  const r = stage.getBoundingClientRect();
  for (let i = 0; i < 70; i++) {
    const c = document.createElement('i');
    c.className = 'confetti';
    c.style.background = colors[i % colors.length];
    c.style.left = `${r.width / 2}px`;
    c.style.top = `${r.height * 0.3}px`;
    stage.appendChild(c);
    const a = Math.random() * Math.PI * 2;
    const v = 120 + Math.random() * 260;
    const dx = Math.cos(a) * v;
    const dy = Math.sin(a) * v - 140;
    c.animate(
      [
        { transform: 'translate(0,0) rotate(0deg)', opacity: 1 },
        { transform: `translate(${dx}px, ${dy + 520}px) rotate(${(Math.random() - 0.5) * 900}deg)`, opacity: 0 },
      ],
      { duration: 1400 + Math.random() * 700, easing: 'cubic-bezier(.2,.6,.4,1)' },
    ).onfinish = () => c.remove();
  }
  const toast = document.createElement('div');
  toast.className = 'hud-toast';
  toast.textContent = message;
  stage.appendChild(toast);
  toast.animate([{ transform: 'translate(-50%, 12px) scale(.9)', opacity: 0 }, { transform: 'translate(-50%, 0) scale(1)', opacity: 1 }], {
    duration: 260,
    easing: 'cubic-bezier(.2,1.4,.4,1)',
  });
  setTimeout(() => toast.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 400 }).onfinish = () => toast.remove(), 1800);
}

/** Records the next 8 s of the toy's canvas, then offers share / save. */
function recordClip(canvas: HTMLCanvasElement, button: HTMLButtonElement, stage: HTMLElement) {
  if (button.classList.contains('recording')) return;
  const types = ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm'];
  const mimeType = types.find((t) => MediaRecorder.isTypeSupported(t)) ?? '';
  let rec: MediaRecorder;
  try {
    rec = new MediaRecorder(canvas.captureStream(30), mimeType ? { mimeType, videoBitsPerSecond: 6_000_000 } : undefined);
  } catch (err) {
    console.error('[bobo] clip failed', err);
    return;
  }
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.onstop = () => {
    button.classList.remove('recording');
    button.textContent = '● Clip';
    const type = rec.mimeType || mimeType || 'video/webm';
    const blob = new Blob(chunks, { type });
    showClip(stage, blob, type.includes('mp4') ? 'mp4' : 'webm');
  };
  button.classList.add('recording');
  let left = 8;
  button.textContent = `● ${left}`;
  const tick = setInterval(() => {
    left--;
    button.textContent = `● ${left}`;
    if (left <= 0) {
      clearInterval(tick);
      rec.stop();
    }
  }, 1000);
  rec.start(250);
  haptic('light');
}

function showClip(stage: HTMLElement, blob: Blob, ext: string) {
  const url = URL.createObjectURL(blob);
  const sheet = document.createElement('div');
  sheet.className = 'clip-sheet';
  sheet.innerHTML = `<div class="clip-card"><video autoplay loop muted playsinline></video><div class="clip-actions"><button type="button" data-share>Share</button><a download>Save</a><button type="button" data-close>Close</button></div></div>`;
  sheet.querySelector('video')!.src = url;
  const save = sheet.querySelector('a')!;
  save.href = url;
  save.download = `bobo-${location.hash.slice(1) || 'toy'}-${Date.now()}.${ext}`;
  const file = new File([blob], save.download, { type: blob.type });
  const shareBtn = sheet.querySelector<HTMLButtonElement>('[data-share]')!;
  if (!navigator.canShare?.({ files: [file] })) shareBtn.hidden = true;
  shareBtn.addEventListener('click', () => navigator.share({ files: [file], title: 'bobo' }).catch(() => {}));
  const close = () => {
    URL.revokeObjectURL(url);
    sheet.remove();
  };
  sheet.querySelector('[data-close]')!.addEventListener('click', close);
  sheet.addEventListener('click', (e) => e.target === sheet && close());
  stage.appendChild(sheet);
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
