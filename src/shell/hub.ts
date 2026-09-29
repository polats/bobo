// The home screen: a "New" carousel and a grid of live preview cards. Tapping a card opens a sheet
// with the preview, a description and Play; sort, shelves and the previews setting live in a filter sheet.
import type { Toy } from './types';
import { CATEGORIES, lastUpdate, meta, newCutoff, updates, type Category } from './catalog';
import { toyIcon } from './icons';

type Sort = 'newest' | 'az' | 'shelf';
type PreviewMode = 'auto' | 'wifi' | 'off';

// Bundled 3 s loops + posters from tools/media/previews.mjs. Vite hashes them into the build,
// so the native apps play them offline.
const PREVIEW_URLS = import.meta.glob<string>('../previews/*.{mp4,webp}', { eager: true, query: '?url', import: 'default' });
function previewFor(id: string) {
  const mp4 = PREVIEW_URLS[`../previews/${id}.mp4`];
  const poster = PREVIEW_URLS[`../previews/${id}.webp`];
  return mp4 && poster ? { mp4, poster } : null;
}

const SHELF_ICON: Record<Category | 'All', string> = {
  All: '<path d="M12 4v4M12 16v4M4 12h4M16 12h4M6.5 6.5l2.5 2.5M15 15l2.5 2.5M17.5 6.5 15 9M9 15l-2.5 2.5"/>',
  Fluids: '<path d="M12 3.5c3 4 5.5 6.9 5.5 10a5.5 5.5 0 0 1-11 0c0-3.1 2.5-6 5.5-10Z"/>',
  'Soft & squishy': '<path d="M5 17.5c-1.6-3.3-.6-8 2.4-10.3 2.9-2.3 7-2.2 9.6.4 2.8 2.8 3 7.3.7 10-1.3 1.5-3.2 2.2-5.4 2.2H8.1c-1.3 0-2.5-.7-3.1-2.3Z"/>',
  'Cloth & yarn': '<path d="M4 20 18.5 5.5"/><circle cx="19.5" cy="4.5" r="1.4"/><path d="M4 20c3-2 5 1 8-1s4-5 8-6"/>',
  'Sand & powder': '<path d="M7 3.5h10M7 20.5h10M8 3.5c0 4 8 5 8 8.5s-8 4.5-8 8.5M16 3.5c0 4-8 5-8 8.5"/>',
  'Smash & build': '<path d="m14 5 5 5-3 3-5-5z"/><path d="m11 8-7.5 7.5a1.8 1.8 0 0 0 2.5 2.5L13.5 10.5"/>',
  'Make & reveal': '<path d="M12 3.5 13.8 9l5.7 1.1-4.5 3.6 1.1 5.8L12 16.7l-4.1 2.8 1.1-5.8-4.5-3.6L10.2 9Z"/>',
};
const UI_ICON = {
  filter: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  play: '<path d="M7 5.5v13l11-6.5Z" fill="currentColor" stroke="none"/>',
  gpu: '<rect x="4" y="6" width="16" height="12" rx="2"/><path d="M8 10h8M8 14h5"/>',
  chevron: '<path d="m9 6 6 6-6 6"/>',
};
const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

function loadPref<T extends string>(key: string, fallback: T): T {
  try {
    return (localStorage.getItem(`bobo.${key}`) as T) || fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(`bobo.${key}`, value);
  } catch {
    /* private mode: preferences just don't stick */
  }
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const firstSentence = (s: string) => (s.match(/^.*?[.!?](\s|$)/)?.[0] ?? s).trim();

let savedScroll = 0;

/** Plays previews that are mostly on screen, at most MAX at a time; pauses everything on demand. */
class Playback {
  private static MAX = 4;
  private visible = new Set<HTMLVideoElement>();
  private all = new Set<HTMLVideoElement>();
  private io: IntersectionObserver;
  private paused = false;
  private onVisibility = () => this.apply();

  constructor(root: HTMLElement, private enabled: boolean) {
    this.io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const v = e.target as HTMLVideoElement;
          if (e.intersectionRatio >= 0.6) this.visible.add(v);
          else this.visible.delete(v);
          // Fetch a clip just before it scrolls in, not on page load.
          if (e.isIntersecting && !v.src && v.dataset.src && enabled) v.src = v.dataset.src;
        }
        this.apply();
      },
      { root, rootMargin: '200px 0px', threshold: [0, 0.6] },
    );
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  watch(v: HTMLVideoElement) {
    this.all.add(v);
    this.io.observe(v);
  }

  /** Horizontal scrolling doesn't move the vertical root, so re-measure the carousel's videos. */
  remeasure(vs: HTMLVideoElement[]) {
    for (const v of vs) {
      this.io.unobserve(v);
      this.io.observe(v);
    }
  }

  setPaused(p: boolean) {
    this.paused = p;
    this.apply();
  }

  private apply() {
    const allow = this.enabled && !this.paused && !document.hidden;
    const want = allow ? [...this.visible].filter((v) => v.isConnected).slice(0, Playback.MAX) : [];
    for (const v of this.all) if (!want.includes(v) && !v.paused) v.pause();
    for (const v of want) {
      if (!v.src && v.dataset.src) v.src = v.dataset.src;
      // Low Power Mode and similar refuse autoplay; the poster simply stays.
      if (v.paused) v.play().catch(() => {});
    }
  }

  pauseAll(root: ParentNode) {
    root.querySelectorAll('video').forEach((v) => v.pause());
  }

  destroy() {
    for (const v of this.all) v.pause();
    this.all.clear();
    this.visible.clear();
    this.io.disconnect();
    document.removeEventListener('visibilitychange', this.onVisibility);
  }
}

export function mountHub(app: HTMLElement, toys: Toy[]): () => void {
  const cutoff = newCutoff(toys.map((t) => t.id));
  const isNew = (t: Toy) => meta(t.id).added.getTime() >= cutoff;
  // "Updated" works like "New": a notable update within a day and a half of the latest one.
  const updatedAt = (t: Toy) => new Date(lastUpdate(t.id)?.date ?? 0).getTime();
  const updCutoff = Math.max(0, ...toys.map(updatedAt)) - 36 * 3600e3;
  const isUpdated = (t: Toy) => !!lastUpdate(t.id) && updatedAt(t) >= updCutoff;
  const needsGpu = (t: Toy) => /WebGPU/.test(t.tech);
  let sort = loadPref<Sort>('sort', 'newest');
  let filter = loadPref<string>('filter', 'All');
  let previews = loadPref<PreviewMode>('previews', 'auto');
  let gpuOk: boolean | null = null;

  const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const connection = (navigator as Navigator & { connection?: { type?: string } }).connection;
  // Safari exposes no connection info; treat unknown as Wi-Fi so "Wi-Fi only" still plays there.
  const onWifi = !connection?.type || connection.type === 'wifi' || connection.type === 'ethernet';
  const motionOn = () => !reduceMotion && (previews === 'auto' || (previews === 'wifi' && onWifi));

  const hub = document.createElement('div');
  hub.className = 'hub';
  const inner = document.createElement('div');
  inner.className = 'hub-inner';
  hub.appendChild(inner);

  const head = document.createElement('header');
  head.className = 'hub-head';
  head.innerHTML = `<h1 class="wordmark">bobo</h1><button type="button" class="icon-btn" data-open-filter aria-label="Sort and filter">${svg(UI_ICON.filter)}<i class="filter-dot" hidden></i></button>`;
  const body = document.createElement('div');
  inner.append(head, body);

  const scrim = document.createElement('div');
  scrim.className = 'sheet-scrim';
  const toySheet = document.createElement('div');
  toySheet.className = 'sheet';
  toySheet.setAttribute('role', 'dialog');
  toySheet.setAttribute('aria-modal', 'true');
  const filterSheet = document.createElement('div');
  filterSheet.className = 'sheet';
  filterSheet.setAttribute('role', 'dialog');
  filterSheet.setAttribute('aria-label', 'Sort and filter');
  hub.append(scrim, toySheet, filterSheet);
  app.appendChild(hub);

  let playback = new Playback(hub, motionOn());

  function media(t: Toy, cls: string) {
    const p = previewFor(t.id);
    if (!p) return `<div class="${cls} media-fallback" style="--swatch:${esc(t.swatch)}">${toyIcon(t.id)}</div>`;
    return `<div class="${cls}"><video muted loop playsinline preload="none" disablepictureinpicture poster="${p.poster}" data-src="${p.mp4}"></video></div>`;
  }

  function card(t: Toy) {
    const gpuMark = needsGpu(t) ? `<span class="card-gpu" title="Needs WebGPU">GPU</span>` : '';
    return `<button type="button" class="card${needsGpu(t) && gpuOk === false ? ' dim' : ''}" data-toy="${t.id}">
      ${media(t, 'card-media')}
      <span class="card-title">${isNew(t) ? '<i class="new-dot" aria-label="New"></i>' : isUpdated(t) ? '<i class="new-dot upd-dot" aria-label="Updated"></i>' : ''}<span>${esc(t.title)}</span>${gpuMark}</span>
    </button>`;
  }

  function render() {
    playback.destroy();
    playback = new Playback(hub, motionOn());
    head.querySelector<HTMLElement>('.filter-dot')!.hidden = filter === 'All' && sort === 'newest';
    const shown = toys.filter((t) => filter === 'All' || meta(t.id).category === filter);
    const fresh = [...toys].filter(isNew).sort((a, b) => meta(b.id).added.getTime() - meta(a.id).added.getTime());
    let html = '';
    if (filter === 'All' && fresh.length) {
      const day = meta(fresh[0].id).added.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
      html += `<div class="sec"><h2>New</h2><span>${fresh.length} toys · ${day}</span></div><div class="carousel">${fresh
        .map(
          (t) => `<div class="hero" data-toy="${t.id}">
            ${media(t, 'hero-media')}
            <span class="hero-new">New</span>${isUpdated(t) ? '<span class="hero-new hero-upd">Updated</span>' : ''}
            <div class="hero-meta"><div><b>${esc(t.title)}</b><small>${esc(firstSentence(t.blurb))}</small></div>
            <button type="button" class="hero-play" data-play="${t.id}" aria-label="Play ${esc(t.title)}">${svg(UI_ICON.play)}Play</button></div>
          </div>`,
        )
        .join('')}</div>`;
    }
    // Recently updated toys (not already in New), each showing what changed.
    const touched = toys.filter((t) => isUpdated(t) && !isNew(t)).sort((a, b) => updatedAt(b) - updatedAt(a));
    if (filter === 'All' && touched.length) {
      html += `<div class="sec"><h2>Updated</h2><span>${touched.length} ${touched.length === 1 ? 'toy' : 'toys'}</span></div><div class="carousel">${touched
        .map(
          (t) => `<div class="hero hero-sm" data-toy="${t.id}">
            ${media(t, 'hero-media')}
            <span class="hero-new hero-upd">Updated</span>
            <div class="hero-meta"><div><b>${esc(t.title)}</b><small>${esc(lastUpdate(t.id)!.note)}</small></div>
            <button type="button" class="hero-play" data-play="${t.id}" aria-label="Play ${esc(t.title)}">${svg(UI_ICON.play)}Play</button></div>
          </div>`,
        )
        .join('')}</div>`;
    }
    const byNewest = (a: Toy, b: Toy) => meta(b.id).added.getTime() - meta(a.id).added.getTime();
    if (sort === 'shelf') {
      for (const c of CATEGORIES) {
        const items = shown.filter((t) => meta(t.id).category === c).sort(byNewest);
        if (items.length) html += `<div class="sec"><h2>${c}</h2><span>${items.length}</span></div><div class="grid">${items.map(card).join('')}</div>`;
      }
    } else {
      const items = [...shown].sort(sort === 'az' ? (a, b) => a.title.localeCompare(b.title) : byNewest);
      const title = filter === 'All' ? 'All toys' : filter;
      html += `<div class="sec"><h2>${title}</h2><span>${items.length}</span></div>`;
      html += items.length ? `<div class="grid">${items.map(card).join('')}</div>` : `<p class="hub-empty">Nothing on this shelf yet.</p>`;
    }
    body.innerHTML = html;
    body.querySelectorAll('video').forEach((v) => playback.watch(v));
    const carousel = body.querySelector<HTMLElement>('.carousel');
    if (carousel) {
      const vids = [...carousel.querySelectorAll('video')];
      let raf = 0;
      carousel.addEventListener(
        'scroll',
        () => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => playback.remeasure(vids));
        },
        { passive: true },
      );
    }
  }

  // ---------------- sheets ----------------

  function openSheet(sheet: HTMLElement) {
    for (const s of [toySheet, filterSheet]) s.classList.toggle('active', s === sheet);
    hub.classList.add('sheet-open');
    playback.setPaused(true);
  }
  function closeSheets() {
    hub.classList.remove('sheet-open');
    toySheet.querySelector('video')?.pause();
    playback.setPaused(false);
  }

  function showToy(t: Toy) {
    const p = previewFor(t.id);
    const blocked = needsGpu(t) && gpuOk === false;
    const tags = [
      `<span class="tag">${svg(SHELF_ICON[meta(t.id).category])}${meta(t.id).category}</span>`,
      needsGpu(t) ? `<span class="tag">${svg(UI_ICON.gpu)}${blocked ? 'Needs WebGPU · not on this device' : 'WebGPU'}</span>` : '',
      isNew(t) ? `<span class="tag tag-new">New</span>` : '',
      isUpdated(t) ? `<span class="tag tag-upd">Updated</span>` : '',
    ].join('');
    const log = updates(t.id);
    const day = (d: string) => new Date(d).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const whatsNew = log.length
      ? `<div class="whats-new"><h4>What's new</h4><ul>${log.map((u) => `<li><time>${day(u.date)}</time><span>${esc(u.note)}</span></li>`).join('')}</ul></div>`
      : '';
    toySheet.innerHTML = `<div class="grabber"></div>
      <div class="sheet-media">${
        p
          ? `<video muted loop playsinline ${motionOn() ? 'autoplay' : ''} disablepictureinpicture poster="${p.poster}" src="${p.mp4}"></video>`
          : `<div class="media-fallback" style="--swatch:${esc(t.swatch)}">${toyIcon(t.id)}</div>`
      }</div>
      <h3>${esc(t.title)}</h3>
      <p class="sheet-blurb">${esc(t.blurb)}</p>
      <div class="tags">${tags}</div>
      <button type="button" class="cta" data-play="${t.id}" ${blocked ? 'disabled' : ''}>${svg(UI_ICON.play)}${blocked ? 'Not available here' : 'Play'}</button>
      ${whatsNew}
      <details class="papers"><summary>Based on ${t.refs.length} ${t.refs.length === 1 ? 'source' : 'papers & sources'}${svg(UI_ICON.chevron)}</summary>
        <ul>${t.refs.map((r) => `<li><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a></li>`).join('')}</ul>
      </details>`;
    toySheet.setAttribute('aria-label', t.title);
    openSheet(toySheet);
    toySheet.querySelector<HTMLButtonElement>('.cta')?.focus({ preventScroll: true });
  }

  function renderFilter() {
    const count = (c: string) => (c === 'All' ? toys.length : toys.filter((t) => meta(t.id).category === c).length);
    const sorts: [Sort, string][] = [
      ['newest', 'Newest'],
      ['az', 'A–Z'],
      ['shelf', 'Shelf'],
    ];
    const modes: [PreviewMode, string][] = [
      ['auto', 'Auto'],
      ['wifi', 'Wi-Fi only'],
      ['off', 'Off'],
    ];
    filterSheet.innerHTML = `<div class="grabber"></div>
      <div class="sheet-head"><b>Sort & filter</b><button type="button" class="link-btn" data-close>Done</button></div>
      <div class="sort-seg" role="group" aria-label="Sort">${sorts
        .map(([v, l]) => `<button type="button" data-sort="${v}" aria-pressed="${v === sort}">${l}</button>`)
        .join('')}</div>
      <div class="shelves">${(['All', ...CATEGORIES] as (Category | 'All')[])
        .map(
          (c) =>
            `<button type="button" class="shelf" data-shelf="${c}" aria-pressed="${c === filter}">${svg(SHELF_ICON[c])}<span>${c}</span><em>${count(c)}</em></button>`,
        )
        .join('')}</div>
      <div class="pref-row"><span>Previews${reduceMotion ? ' <small>(Reduce Motion is on)</small>' : ''}</span><div class="mini-seg">${modes
        .map(([v, l]) => `<button type="button" data-previews="${v}" aria-pressed="${v === previews}">${l}</button>`)
        .join('')}</div></div>`;
  }

  // ---------------- events ----------------

  const launch = (id: string) => {
    savedScroll = hub.scrollTop;
    location.hash = id;
  };

  hub.addEventListener('click', (e) => {
    const el = e.target as HTMLElement;
    const play = el.closest<HTMLElement>('[data-play]');
    if (play && !(play as HTMLButtonElement).disabled) return launch(play.dataset.play!);
    if (el.closest('[data-close]') || el === scrim) return closeSheets();
    if (el.closest('[data-open-filter]')) {
      renderFilter();
      return openSheet(filterSheet);
    }
    const sortBtn = el.closest<HTMLElement>('[data-sort]');
    if (sortBtn) {
      sort = sortBtn.dataset.sort as Sort;
      savePref('sort', sort);
      renderFilter();
      return render();
    }
    const shelf = el.closest<HTMLElement>('[data-shelf]');
    if (shelf) {
      filter = shelf.dataset.shelf!;
      savePref('filter', filter);
      renderFilter();
      render();
      return;
    }
    const mode = el.closest<HTMLElement>('[data-previews]');
    if (mode) {
      previews = mode.dataset.previews as PreviewMode;
      savePref('previews', previews);
      renderFilter();
      return render();
    }
    const item = el.closest<HTMLElement>('[data-toy]');
    if (item && !el.closest('.sheet')) {
      const t = toys.find((x) => x.id === item.dataset.toy);
      if (t) showToy(t);
    }
  });
  const onKey = (e: KeyboardEvent) => e.key === 'Escape' && closeSheets();
  document.addEventListener('keydown', onKey);

  // Swipe a sheet down to dismiss it: from anywhere on the sheet while it's scrolled to the top.
  // Touch events (not pointer events) so the browser's own scrolling can't cancel the drag.
  for (const sheet of [toySheet, filterSheet]) {
    let y0 = 0;
    let t0 = 0;
    let dy = 0;
    let dragging = false;
    const setDrag = (d: number) => {
      sheet.style.transform = d ? `translateY(${d}px)` : '';
      scrim.style.transition = d ? 'none' : '';
      scrim.style.opacity = d ? String(Math.max(0, 1 - d / Math.max(1, sheet.offsetHeight))) : '';
    };
    sheet.addEventListener(
      'touchstart',
      (e) => {
        y0 = e.touches[0].clientY;
        t0 = performance.now();
        dy = 0;
        dragging = false;
      },
      { passive: true },
    );
    sheet.addEventListener(
      'touchmove',
      (e) => {
        const d = e.touches[0].clientY - y0;
        if (!dragging && d > 8 && sheet.scrollTop <= 0) {
          dragging = true;
          sheet.classList.add('dragging');
        }
        if (!dragging) return;
        e.preventDefault();
        dy = Math.max(0, d);
        setDrag(dy);
      },
      { passive: false },
    );
    const end = () => {
      if (!dragging) return;
      dragging = false;
      sheet.classList.remove('dragging');
      const velocity = dy / Math.max(1, performance.now() - t0); // px per ms
      setDrag(0);
      if (dy > 110 || (dy > 30 && velocity > 0.6)) closeSheets();
    };
    sheet.addEventListener('touchend', end);
    sheet.addEventListener('touchcancel', end);
    // Mouse / pen: drag the grabber area.
    sheet.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' || !(e.target as HTMLElement).closest('.grabber, .sheet-head')) return;
      y0 = e.clientY;
      t0 = performance.now();
      dy = 0;
      dragging = true;
      sheet.classList.add('dragging');
      sheet.setPointerCapture(e.pointerId);
    });
    sheet.addEventListener('pointermove', (e) => {
      if (!dragging || e.pointerType === 'touch') return;
      dy = Math.max(0, e.clientY - y0);
      setDrag(dy);
    });
    sheet.addEventListener('pointerup', (e) => e.pointerType !== 'touch' && end());
  }

  render();
  hub.scrollTop = savedScroll;

  // Device soak (BOBO_AUTOPLAY): scroll the hub up and down and log FPS with previews playing.
  let soakRaf = 0;
  if ((window as Window & { boboAutoplay?: boolean }).boboAutoplay) {
    let last = performance.now();
    let frames = 0;
    let worst = 0;
    let dir = 1;
    let acc = 0;
    const step = (now: number) => {
      soakRaf = requestAnimationFrame(step);
      const dt = now - last;
      last = now;
      frames++;
      acc += dt;
      worst = Math.max(worst, dt);
      hub.scrollTop += dir * 6;
      if (hub.scrollTop + hub.clientHeight >= hub.scrollHeight - 2) dir = -1;
      if (hub.scrollTop <= 0) dir = 1;
      if (acc >= 5000) {
        const playing = [...hub.querySelectorAll('video')].filter((v) => !v.paused).length;
        console.log(`[bobo] hub ${Math.round((frames * 1000) / acc)} fps worst ${Math.round(worst)}ms · ${playing} previews playing`);
        frames = 0;
        acc = 0;
        worst = 0;
      }
    };
    soakRaf = requestAnimationFrame(step);
  }

  // WebGPU toys get dimmed (and their Play disabled) where no adapter is available.
  const setGpu = (ok: boolean) => {
    gpuOk = ok;
    console.log(`[bobo] WebGPU: ${ok ? 'yes' : 'no'} · WebGL2: ${document.createElement('canvas').getContext('webgl2') ? 'yes' : 'no'} · DPR ${devicePixelRatio}`);
    if (!ok) for (const t of toys) if (needsGpu(t)) hub.querySelectorAll(`.card[data-toy="${t.id}"]`).forEach((c) => c.classList.add('dim'));
  };
  if (!navigator.gpu) setGpu(false);
  else navigator.gpu.requestAdapter().then((a) => setGpu(!!a), () => setGpu(false));

  return () => {
    cancelAnimationFrame(soakRaf);
    playback.destroy();
    document.removeEventListener('keydown', onKey);
  };
}
