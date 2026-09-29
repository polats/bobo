// "Lay paper": a sheet drops onto the bath, lifts off carrying the pattern, then flies into a
// little gallery of keepsakes. Pure DOM so it costs nothing on the GPU.

const STYLE_ID = 'marble-style';

const css = `
.marble-sheet {
  position: absolute; z-index: 5; left: 5%; right: 5%; top: 7%; bottom: 17%;
  background-color: #f4ecdc; background-size: cover, 180px 180px; background-blend-mode: multiply;
  box-shadow: 0 18px 40px -12px rgba(0,0,0,.55); border-radius: 3px;
  transform: translateY(-120%) rotate(-2deg); transition: transform .38s cubic-bezier(.2,.8,.2,1), opacity .3s;
  pointer-events: none;
}
.marble-gallery {
  position: absolute; z-index: 4; left: calc(12px + var(--safe-left)); top: calc(62px + var(--safe-top));
  display: flex; flex-direction: column; gap: 8px; pointer-events: auto;
}
.marble-gallery button {
  width: 46px; height: 64px; padding: 0; border: 0; border-radius: 3px; cursor: pointer;
  background-size: cover, 90px 90px; background-blend-mode: multiply; background-color: #f4ecdc;
  box-shadow: 0 4px 10px rgba(0,0,0,.45); transform: rotate(var(--tilt));
}
.marble-viewer {
  position: absolute; inset: 0; z-index: 6; display: grid; place-items: center;
  background: rgba(8,6,4,.72); -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
}
.marble-viewer div {
  width: min(78vw, 60vh); aspect-ratio: var(--ratio); border-radius: 3px;
  background-size: cover, 220px 220px; background-blend-mode: multiply; background-color: #f4ecdc;
  box-shadow: 0 24px 60px rgba(0,0,0,.6);
}
.marble-viewer p { margin: 14px 0 0; color: rgba(255,255,255,.75); font-size: 13px; text-align: center; }
`;

let paperUrl = '';

/** Warm paper with fibres and speckles, generated once. */
function paperTexture() {
  if (paperUrl) return paperUrl;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ffffff';
  g.fillRect(0, 0, 256, 256);
  const img = g.getImageData(0, 0, 256, 256);
  for (let i = 0; i < img.data.length; i += 4) {
    const v = 238 + Math.random() * 17;
    img.data[i] = v;
    img.data[i + 1] = v - 3;
    img.data[i + 2] = v - 10;
  }
  g.putImageData(img, 0, 0);
  g.globalAlpha = 0.08;
  g.strokeStyle = '#7a6448';
  for (let k = 0; k < 140; k++) {
    g.beginPath();
    const x = Math.random() * 256, y = Math.random() * 256, a = Math.random() * Math.PI;
    g.moveTo(x, y);
    g.quadraticCurveTo(x + Math.cos(a) * 12 + Math.random() * 6, y + Math.sin(a) * 12, x + Math.cos(a) * 24, y + Math.sin(a) * 24);
    g.stroke();
  }
  paperUrl = c.toDataURL('image/png');
  return paperUrl;
}

/** Rough deckle edge via clip-path. */
function deckle() {
  const pts: string[] = [];
  const n = 26;
  const j = () => (Math.random() * 0.9).toFixed(2);
  for (let i = 0; i <= n; i++) pts.push(`${((i / n) * 100).toFixed(1)}% ${j()}%`);
  for (let i = 0; i <= n; i++) pts.push(`${(100 - +j()).toFixed(2)}% ${((i / n) * 100).toFixed(1)}%`);
  for (let i = n; i >= 0; i--) pts.push(`${((i / n) * 100).toFixed(1)}% ${(100 - +j()).toFixed(2)}%`);
  for (let i = n; i >= 0; i--) pts.push(`${j()}% ${((i / n) * 100).toFixed(1)}%`);
  return `polygon(${pts.join(',')})`;
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class PrintShelf {
  private gallery: HTMLElement;
  private style: HTMLStyleElement | null = null;
  private busy = false;
  prints: string[] = [];

  constructor(private overlay: HTMLElement) {
    if (!document.getElementById(STYLE_ID)) {
      this.style = document.createElement('style');
      this.style.id = STYLE_ID;
      this.style.textContent = css;
      document.head.appendChild(this.style);
    }
    this.gallery = document.createElement('div');
    this.gallery.className = 'marble-gallery';
    overlay.appendChild(this.gallery);
  }

  /** Runs the lay-and-lift animation; `capture` is called while the sheet covers the bath. */
  async lay(capture: () => { url: string; ratio: number }, onLifted: () => void) {
    if (this.busy) return false;
    this.busy = true;
    const sheet = document.createElement('div');
    sheet.className = 'marble-sheet';
    sheet.style.backgroundImage = `url(${paperTexture()})`;
    sheet.style.clipPath = deckle();
    this.overlay.appendChild(sheet);
    await wait(20);
    sheet.style.transform = 'translateY(0) rotate(0deg)';
    await wait(520);
    const { url, ratio } = capture();
    // The sheet peels up with the pattern on it.
    sheet.style.backgroundImage = `url(${url}), url(${paperTexture()})`;
    sheet.style.transition = 'transform .55s cubic-bezier(.3,.7,.2,1), opacity .3s';
    sheet.style.transform = 'translateY(-4%) rotate(-3deg) scale(.92)';
    onLifted();
    await wait(1200);
    // Fly into the gallery.
    this.prints.unshift(url);
    const thumb = this.addThumb(url, ratio);
    const a = sheet.getBoundingClientRect();
    const b = thumb.getBoundingClientRect();
    thumb.style.opacity = '0';
    const sx = b.width / a.width, sy = b.height / a.height;
    sheet.style.transformOrigin = '0 0';
    sheet.style.transition = 'transform .5s cubic-bezier(.5,0,.2,1)';
    sheet.style.transform = `translate(${b.left - a.left}px, ${b.top - a.top}px) scale(${sx}, ${sy}) rotate(4deg)`;
    await wait(520);
    thumb.style.opacity = '1';
    sheet.remove();
    this.busy = false;
    return true;
  }

  private addThumb(url: string, ratio: number) {
    const t = document.createElement('button');
    t.type = 'button';
    t.setAttribute('aria-label', 'View print');
    t.style.backgroundImage = `url(${url}), url(${paperTexture()})`;
    t.style.setProperty('--tilt', `${(Math.random() * 8 - 4).toFixed(1)}deg`);
    t.addEventListener('click', () => this.view(url, ratio));
    this.gallery.prepend(t);
    while (this.gallery.children.length > 5) this.gallery.lastElementChild!.remove();
    return t;
  }

  private view(url: string, ratio: number) {
    const v = document.createElement('div');
    v.className = 'marble-viewer';
    const card = document.createElement('div');
    card.style.backgroundImage = `url(${url}), url(${paperTexture()})`;
    card.style.setProperty('--ratio', String(ratio));
    card.style.clipPath = deckle();
    const note = document.createElement('p');
    note.textContent = 'Tap to close';
    const wrap = document.createElement('section');
    wrap.append(card, note);
    v.appendChild(wrap);
    v.addEventListener('click', () => v.remove());
    this.overlay.appendChild(v);
  }

  destroy() {
    this.gallery.remove();
    this.style?.remove();
  }
}
