import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { JarSim, PALETTE, CYCLE, COLOR_NAMES, PICTURES, type Mode } from './sim';
import { JarRenderer } from './render';

export const sandjarToy: Toy = {
  id: 'sandjar',
  title: 'Sand Jar',
  blurb: 'Pour coloured sand into a jar and poke it into swirls, or pour a picture into a frame and watch it reveal.',
  tech: 'Falling-sand art · WebGL2',
  swatch: 'linear-gradient(140deg,#ff5fa2,#ff9a2e 35%,#3cc4b4 70%,#8a5cf6)',
  refs: [
    {
      short: 'Sand Loop',
      title: 'Voodoo — Sand Loop (design reference)',
      url: 'https://apps.apple.com/us/app/sand-loop/id6754363534',
      use: 'The reveal loop: coloured sand fills a picture. Here it is a toy with no failure state.',
    },
    {
      short: 'Noita GDC 2019',
      title: 'Petri Purho — Exploring the Tech and Design of Noita (GDC 2019)',
      url: 'https://www.youtube.com/watch?v=prXuyMCgbTc',
      use: 'Falling-sand grid updated bottom-up with alternating sweeps; grains fall with a little momentum.',
    },
    {
      short: 'Sandspiel',
      title: 'Max Bittker — Sandspiel',
      url: 'https://github.com/MaxBittker/sandspiel',
      use: 'Crisp per-cell grain look with colour variation.',
    },
  ],
  async create(ctx) {
    return new SandJar(ctx);
  },
};

type Tool = 'funnel' | 'stick' | 'scoop';
const TOOLS: { id: Tool; glyph: string; label: string }[] = [
  { id: 'funnel', glyph: '▽', label: 'Funnel' },
  { id: 'stick', glyph: '╿', label: 'Stick' },
  { id: 'scoop', glyph: '◌', label: 'Scoop' },
];
const PICTURE_NAMES = Object.keys(PICTURES);
const SHELF_KEY = 'bobo.sandjar.shelf';

const css = `
.sj-tray{position:absolute;z-index:3;left:50%;transform:translateX(-50%);bottom:calc(10px + var(--safe-bottom));
  display:grid;grid-template-columns:repeat(7,34px);gap:6px;padding:7px;border-radius:20px;
  background:rgba(40,28,20,.45);-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.25)}
.sj-tray button{width:34px;height:34px;border-radius:50%;border:0;padding:0;background:var(--swatch);cursor:pointer;
  box-shadow:inset 0 0 0 2px rgba(255,255,255,.35);opacity:.7}
.sj-tray button[aria-pressed="true"]{opacity:1;box-shadow:inset 0 0 0 3px #fff,0 0 0 2px rgba(0,0,0,.25)}
.sj-rail{position:absolute;z-index:3;right:calc(10px + var(--safe-right));top:50%;transform:translateY(-50%);
  display:flex;flex-direction:column;gap:8px;padding:6px;border-radius:22px;background:rgba(40,28,20,.45);
  -webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);border:1px solid rgba(255,255,255,.25)}
.sj-rail button{width:40px;height:40px;border-radius:50%;border:0;background:rgba(255,255,255,.18);color:#fff;
  font:700 18px/1 ui-rounded,system-ui;cursor:pointer}
.sj-rail button[aria-pressed="true"]{background:#fff;color:#3a2a1c}
.sj-shelf{position:absolute;z-index:3;left:calc(12px + var(--safe-left));top:calc(64px + var(--safe-top));display:flex;
  flex-direction:column;gap:6px;pointer-events:none}
.sj-shelf img{width:30px;height:48px;object-fit:contain;border-radius:6px;background:rgba(255,255,255,.35);
  box-shadow:0 2px 6px rgba(0,0,0,.2)}
`;

class SandJar implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private renderer: JarRenderer;
  private sim!: JarSim;
  private width: number;
  private height: number;
  private tool: Tool = 'funnel';
  private color = CYCLE[0];
  private autoColor = true;
  private cycleIdx = 0;
  private pourClock = 0;
  private tickClock = 0;
  private done = false;
  private shimmer = -1;
  private tiltMode = false;
  private sensorTilt: number | null = null;
  private dragTilt = 0;
  private toolPos: [number, number, number, number] = [0, 0, 0, 0];
  private lastPos = new Map<number, [number, number]>();
  private counter = 0;
  private ui: HTMLElement[] = [];
  private trayButtons: HTMLButtonElement[] = [];
  private railButtons = new Map<string, HTMLButtonElement>();
  private shelfEl!: HTMLElement;
  private shelf: string[] = [];
  private onOrient = (e: DeviceOrientationEvent) => {
    if (e.gamma == null) return;
    this.sensorTilt = Math.max(-1, Math.min(1, ((e.gamma ?? 0) * Math.PI) / 180));
  };

  readonly cfg = {
    mode: 'jar' as Mode,
    picture: 'sunset',
    rate: 16,
    grain: 3,
    slide: 0.85,
    glitter: 1,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.renderer = new JarRenderer(gl);
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    const style = document.createElement('style');
    style.textContent = css;
    ctx.overlay.appendChild(style);
    this.ui.push(style);
    this.buildTray();
    this.buildRail();
    this.buildShelf();
    this.buildPanel();
    this.rebuild();
  }

  // ------------------------------------------------------------------ setup

  private rebuild() {
    const cssW = this.width / this.ctx.pixelRatio;
    const cssH = this.height / this.ctx.pixelRatio;
    const W = Math.max(40, Math.round(cssW / this.cfg.grain));
    const H = Math.max(80, Math.round(cssH / this.cfg.grain));
    this.sim = new JarSim(W, H, this.cfg.mode, this.cfg.picture);
    this.sim.slide = this.cfg.slide;
    this.renderer.setSim(this.sim);
    this.done = false;
    this.shimmer = -1;
    this.ctx.progress(0, this.cfg.mode === 'jar' ? 'full' : 'revealed');
  }

  private buildTray() {
    const tray = document.createElement('div');
    tray.className = 'sj-tray';
    const rainbow = document.createElement('button');
    rainbow.type = 'button';
    rainbow.setAttribute('aria-label', 'Rainbow (auto colours)');
    rainbow.style.setProperty('--swatch', 'conic-gradient(#ff5fa2,#ffd23f,#4cc46a,#22b8b0,#3a78e8,#8a5cf6,#ff5fa2)');
    rainbow.addEventListener('click', () => {
      this.autoColor = true;
      this.syncTray();
    });
    this.trayButtons.push(rainbow);
    tray.appendChild(rainbow);
    for (let c = 1; c < PALETTE.length; c++) {
      const b = document.createElement('button');
      b.type = 'button';
      b.setAttribute('aria-label', COLOR_NAMES[c]);
      const [r, g, bl] = PALETTE[c];
      b.style.setProperty('--swatch', `rgb(${r * 255},${g * 255},${bl * 255})`);
      b.dataset.color = String(c);
      b.addEventListener('click', () => {
        this.autoColor = false;
        this.color = c;
        this.syncTray();
      });
      this.trayButtons.push(b);
      tray.appendChild(b);
    }
    this.ctx.overlay.appendChild(tray);
    this.ui.push(tray);
    this.syncTray();
  }

  private syncTray() {
    for (const b of this.trayButtons) {
      const c = b.dataset.color ? Number(b.dataset.color) : 0;
      b.setAttribute('aria-pressed', String(c === 0 ? this.autoColor : !this.autoColor && c === this.color));
    }
  }

  private buildRail() {
    const rail = document.createElement('div');
    rail.className = 'sj-rail';
    const add = (key: string, glyph: string, label: string, fn: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = glyph;
      b.setAttribute('aria-label', label);
      b.addEventListener('click', fn);
      rail.appendChild(b);
      this.railButtons.set(key, b);
      return b;
    };
    for (const t of TOOLS)
      add(t.id, t.glyph, t.label, () => {
        this.tool = t.id;
        this.tiltMode = false;
        this.syncRail();
      });
    add('tilt', '⤾', 'Tilt', () => this.toggleTilt());
    this.ctx.overlay.appendChild(rail);
    this.ui.push(rail);
    this.syncRail();
  }

  private syncRail() {
    for (const t of TOOLS) this.railButtons.get(t.id)?.setAttribute('aria-pressed', String(!this.tiltMode && this.tool === t.id));
    this.railButtons.get('tilt')?.setAttribute('aria-pressed', String(this.tiltMode));
  }

  /** Tilt mode: drag sideways to tip the jar; on phones with motion sensors, tilt the device. */
  private async toggleTilt() {
    this.tiltMode = !this.tiltMode;
    this.syncRail();
    if (!this.tiltMode) return;
    const DOE = DeviceOrientationEvent as unknown as { requestPermission?: () => Promise<string> };
    try {
      if (typeof DOE.requestPermission === 'function') {
        if ((await DOE.requestPermission()) !== 'granted') return;
      }
      addEventListener('deviceorientation', this.onOrient);
    } catch {
      /* no sensors or permission denied: drag-to-tilt still works */
    }
  }

  private buildShelf() {
    this.shelfEl = document.createElement('div');
    this.shelfEl.className = 'sj-shelf';
    this.ctx.overlay.appendChild(this.shelfEl);
    this.ui.push(this.shelfEl);
    try {
      this.shelf = JSON.parse(localStorage.getItem(SHELF_KEY) ?? '[]');
    } catch {
      this.shelf = [];
    }
    this.renderShelf();
  }

  private renderShelf() {
    this.shelfEl.replaceChildren(
      ...this.shelf.slice(-6).map((src) => {
        const img = document.createElement('img');
        img.src = src;
        img.alt = 'A kept sand jar';
        return img;
      }),
    );
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.choice<Mode>('Mode', [{ value: 'jar', label: 'Jar' }, { value: 'reveal', label: 'Reveal' }], c.mode, (m) => {
      c.mode = m;
      this.rebuild();
    });
    panel.choice(
      'Picture (Reveal)',
      PICTURE_NAMES.map((p) => ({ value: p, label: p[0].toUpperCase() + p.slice(1) })),
      c.picture,
      (p) => {
        c.picture = p;
        if (c.mode === 'reveal') this.rebuild();
      },
    );
    panel.slider(c, 'rate', { label: 'Pour rate', min: 3, max: 50, step: 1 });
    panel.slider(c, 'slide', { label: 'Slide (lower = steeper piles)', min: 0.15, max: 1, step: 0.05, onChange: (v) => (this.sim.slide = v) });
    panel.slider(c, 'glitter', { label: 'Glitter', min: 0, max: 3, step: 0.1 });
    panel.choice(
      'Grain size',
      [2, 3, 4, 5].map((v) => ({ value: String(v), label: `${v}px` })),
      String(c.grain),
      (v) => {
        c.grain = Number(v);
        this.rebuild();
      },
    );
    panel.action('Seal & keep', () => this.keep());
    panel.action('Empty', () => this.rebuild());
    panel.action('Clear shelf', () => {
      this.shelf = [];
      this.saveShelf();
      this.renderShelf();
    });
  }

  // ------------------------------------------------------------------ frame

  frame(dt: number, t: number) {
    const s = this.sim;
    this.handleInput(dt);
    // Tilt: sensors when allowed, otherwise the drag springs back upright when released.
    const dragging = this.tiltMode && [...this.ctx.pointers.active.keys()].length > 0;
    if (!dragging) this.dragTilt *= Math.exp(-dt * 3);
    const tilt = this.tiltMode && this.sensorTilt !== null ? this.sensorTilt : this.dragTilt;
    s.tilt = Math.max(-1.05, Math.min(1.05, tilt));
    const view = this.tiltMode && this.sensorTilt !== null ? 0 : this.dragTilt;
    s.step();
    s.step();
    if (s.mode === 'reveal' && !this.done && s.targetCount && s.matched / s.targetCount >= 0.8) this.completeReveal();
    if (this.shimmer >= 0) {
      this.shimmer += dt / 1.6;
      if (this.shimmer > 1) this.shimmer = -1;
    }
    if (++this.counter % 8 === 0) {
      s.countFilled();
      if (s.mode === 'jar') this.ctx.progress(Math.min(1, s.filled / Math.max(1, s.openCount)), 'full');
      else this.ctx.progress(Math.min(1, s.matched / Math.max(1, s.targetCount)), 'revealed');
    }
    this.renderer.draw(s, this.width, this.height, {
      time: t,
      glitter: this.cfg.glitter,
      shimmer: this.shimmer,
      tool: this.toolPos,
      toolColor: this.color,
      view,
    });
    this.ctx.setStatus(`${s.W}×${s.H} grains · ${s.filled} poured${s.mode === 'reveal' ? ` · ${Math.round((100 * s.matched) / Math.max(1, s.targetCount))}% picture` : ''}`);
  }

  private handleInput(dt: number) {
    const s = this.sim;
    const aspect = this.width / this.height;
    this.toolPos = [0, 0, 0, 0];
    const cx = s.jar.cx, cy = (s.jar.y0 + s.jar.yTop) / 2;
    const view = this.tiltMode && this.sensorTilt !== null ? 0 : this.dragTilt;
    for (const p of this.ctx.pointers.active.values()) {
      if (this.tiltMode) {
        // Drag sideways to tip the jar (like tilting the phone).
        this.dragTilt = Math.max(-1.05, Math.min(1.05, this.dragTilt + p.dx * 3.2 * Math.min(1, aspect * 2)));
        continue;
      }
      // Screen → grid, undoing the scene rotation.
      let gx = p.x * s.W, gy = p.y * s.H;
      const dx = gx - cx, dy = gy - cy;
      const c = Math.cos(view), sn = Math.sin(view);
      gx = cx + c * dx - sn * dy;
      gy = cy + sn * dx + c * dy;
      const last = this.lastPos.get(p.id) ?? [gx, gy];
      this.lastPos.set(p.id, [gx, gy]);
      if (this.tool === 'funnel') {
        this.toolPos = [gx, gy + 1, 1, 0];
        if (this.autoColor) {
          this.pourClock += dt;
          if (this.pourClock > 2.2) {
            this.pourClock = 0;
            this.cycleIdx = (this.cycleIdx + 1) % CYCLE.length;
          }
          this.color = CYCLE[this.cycleIdx];
        }
        const made = s.spawn(gx, gy - 1, this.color, Math.round(this.cfg.rate * dt * 60 * 0.5), 1.6);
        this.tickClock += dt;
        if (made && this.tickClock > 0.12) {
          this.tickClock = 0;
          this.ctx.haptic('light');
        }
      } else if (this.tool === 'stick') {
        this.toolPos = [gx, gy, 2, 0];
        // Sweep the stick along its path so fast drags still carve.
        const steps = Math.max(1, Math.ceil(Math.hypot(gx - last[0], gy - last[1])));
        let pushed = 0;
        for (let k = 1; k <= steps; k++) pushed += s.poke(last[0] + ((gx - last[0]) * k) / steps, last[1] + ((gy - last[1]) * k) / steps, 1.6);
        if (pushed > 6) this.ctx.haptic('light');
      } else {
        const r = 5;
        this.toolPos = [gx, gy, 3, r];
        if (s.scoop(gx, gy, r) > 4) this.ctx.haptic('light');
      }
    }
    for (const id of [...this.lastPos.keys()]) if (!this.ctx.pointers.active.has(id)) this.lastPos.delete(id);
  }

  private completeReveal() {
    this.done = true;
    this.sim.completeReveal();
    this.shimmer = 0;
    this.ctx.haptic('heavy');
    this.ctx.celebrate('Revealed!');
    this.keep(false);
  }

  /** Snapshot the jar (or picture) onto the shelf. */
  private keep(reset = true) {
    const s = this.sim;
    const x0 = s.mode === 'jar' ? Math.floor(s.jar.cx - s.jar.half) - 2 : s.frame.x0;
    const x1 = s.mode === 'jar' ? Math.ceil(s.jar.cx + s.jar.half) + 2 : s.frame.x1;
    const y0 = s.mode === 'jar' ? s.jar.y0 - 1 : s.frame.y0;
    const y1 = s.mode === 'jar' ? Math.ceil(s.jar.yTop) + 1 : s.frame.y1;
    const w = x1 - x0, h = y1 - y0;
    const cv = document.createElement('canvas');
    cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    if (!g) return;
    const img = g.createImageData(w, h);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const gx = x0 + x, gy = y0 + (h - 1 - y);
        if (gx < 0 || gy < 0 || gx >= s.W || gy >= s.H) continue;
        const i = gy * s.W + gx;
        const o = (y * w + x) * 4;
        const m = s.mask[i];
        if (s.col[i]) {
          const c = PALETTE[s.col[i]];
          const v = 0.86 + (0.26 * s.vari[i]) / 255;
          img.data.set([c[0] * v * 255, c[1] * v * 255, c[2] * v * 255, 255], o);
        } else if (m === 2) img.data.set(s.mode === 'jar' ? [215, 235, 250, 200] : [140, 90, 55, 255], o);
        else if (m === 1 && gy < y1) img.data.set([245, 240, 230, s.mode === 'jar' ? 60 : 255], o);
      }
    g.putImageData(img, 0, 0);
    this.shelf.push(cv.toDataURL('image/png'));
    if (this.shelf.length > 12) this.shelf.splice(0, this.shelf.length - 12);
    this.saveShelf();
    this.renderShelf();
    if (reset) {
      this.ctx.celebrate('Kept!');
      this.ctx.haptic('heavy');
      this.rebuild();
    }
  }

  private saveShelf() {
    try {
      localStorage.setItem(SHELF_KEY, JSON.stringify(this.shelf));
    } catch {
      /* storage unavailable: the shelf lasts for this session */
    }
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.rebuild();
  }

  destroy() {
    removeEventListener('deviceorientation', this.onOrient);
    this.ctx.progress(null);
    this.ui.forEach((e) => e.remove());
    this.renderer.destroy();
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
