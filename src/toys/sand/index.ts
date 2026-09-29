import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop } from '../../shell/sound';
import { SandRenderer } from './render';
import * as M from './sim';
import { Sim } from './sim';

const TOOLS: { id: number; label: string; glyph: string; swatch: string }[] = [
  { id: M.SAND, label: 'Sand', glyph: '⏳', swatch: '#e8b965' },
  { id: M.WATER, label: 'Water', glyph: '💧', swatch: '#2f7cf0' },
  { id: M.FIRE, label: 'Fire', glyph: '🔥', swatch: '#ff7a1a' },
  { id: M.WOOD, label: 'Wood', glyph: '🪵', swatch: '#8a5a2b' },
  { id: M.OIL, label: 'Oil', glyph: '🛢️', swatch: '#6b4c14' },
  { id: M.LAVA, label: 'Lava', glyph: '🌋', swatch: '#ff4a12' },
  { id: M.ACID, label: 'Acid', glyph: '🧪', swatch: '#6cf03a' },
  { id: M.PLANT, label: 'Plant', glyph: '🌱', swatch: '#2e9e3a' },
  { id: M.ICE, label: 'Ice', glyph: '🧊', swatch: '#bfe4ff' },
  { id: M.POWDER, label: 'Gunpowder', glyph: '💥', swatch: '#4a4444' },
  { id: M.STEAM, label: 'Steam', glyph: '♨️', swatch: '#d8dde6' },
  { id: M.WALL, label: 'Stone', glyph: '🧱', swatch: '#6b6d78' },
  { id: M.EMPTY, label: 'Eraser', glyph: '🧽', swatch: '#1b1b27' },
];

export const sandToy: Toy = {
  id: 'sand',
  title: 'Alchemy Sandbox',
  blurb: 'Falling-sand chemistry. Burn wood, boil water, melt ice, grow plants, blow up gunpowder.',
  tech: 'Cellular automaton · WebGL2',
  swatch: 'linear-gradient(135deg,#ff7a1a,#e8b965 45%,#2f7cf0)',
  refs: [
    {
      short: 'Noita GDC 2019',
      title: 'Petri Purho — Exploring the Tech and Design of Noita (GDC 2019)',
      url: 'https://www.youtube.com/watch?v=prXuyMCgbTc',
      use: 'Per-pixel material rules, bottom-up updates with alternating sweeps, and fire spreading through flammables.',
    },
    {
      short: 'Sandspiel',
      title: 'Max Bittker — Sandspiel',
      url: 'https://github.com/MaxBittker/sandspiel',
      use: 'Element palette and reactions (plant grows into water, lava + water → stone, acid eats things).',
    },
  ],
  async create(ctx) {
    return new Alchemy(ctx);
  },
};

class Alchemy implements ToyInstance {
  private sim!: Sim;
  private renderer: SandRenderer;
  private width: number;
  private height: number;
  private tool = M.SAND;
  private dock: HTMLElement;
  private flash = 0;
  private shake = 0;
  private statusTimer = 0;
  private simMs = 0;
  // Sound beds: the brush's pour by material, and the scene's fire, lava and steam from sim counts.
  private grains: Loop;
  private liquid: Loop;
  private fireBed: Loop;
  private lavaBed: Loop;
  private steamBed: Loop;
  private hot = 0;
  private strokeTick = 0;

  readonly cfg = {
    brush: 4,
    cellSize: 3,
    speed: 1,
    glow: 1,
    wrap: false,
  };

  constructor(private ctx: ToyContext) {
    this.grains = ctx.sound.loop('trickle');
    this.liquid = ctx.sound.loop('bubble');
    this.fireBed = ctx.sound.loop('crackle');
    this.lavaBed = ctx.sound.loop('rumble');
    this.steamBed = ctx.sound.loop('hiss');
    this.renderer = new SandRenderer(ctx.canvas);
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.rebuild(false);
    this.scene();
    this.dock = this.buildDock();
    this.buildPanel();
  }

  private gridSize(): [number, number] {
    const cell = this.cfg.cellSize * this.ctx.pixelRatio;
    return [Math.max(32, Math.round(this.width / cell)), Math.max(48, Math.round(this.height / cell))];
  }

  /** Allocate a grid for the current canvas size, keeping existing cells when asked. */
  private rebuild(keep: boolean) {
    const [w, h] = this.gridSize();
    if (this.sim && this.sim.w === w && this.sim.h === h) return;
    const next = new Sim(w, h);
    next.wrap = this.cfg.wrap;
    if (keep && this.sim) next.copyFrom(this.sim);
    this.sim = next;
    this.renderer.setGrid(w, h);
  }

  private scene() {
    const s = this.sim;
    const { w, h } = s;
    s.clear();
    const X = (f: number) => Math.round(f * (w - 1));
    const Y = (f: number) => Math.round(f * (h - 1));
    // Thick stone floor so the scene sits above the material dock.
    const g = Y(0.135);
    s.rect(0, 0, w - 1, g, M.WALL);
    // Bowl of water with a slick of oil and plants creeping in from the rim.
    const bx0 = X(0.34);
    const bx1 = X(0.94);
    const by0 = g + 1;
    const by1 = Y(0.25);
    s.rect(bx0, by0, bx1, by0 + 1, M.WALL);
    s.rect(bx0, by0, bx0 + 1, by1, M.WALL);
    s.rect(bx1 - 1, by0, bx1, by1, M.WALL);
    s.rect(bx0 + 2, by0 + 2, bx1 - 2, by1 - 5, M.WATER);
    s.rect(bx0 + 2, by1 - 4, bx1 - 2, by1 - 3, M.OIL);
    s.rect(bx0 - 2, by1, bx0 + 3, by1 + 2, M.PLANT);
    s.rect(bx0 + 2, by0 + 2, bx0 + 4, by0 + 8, M.PLANT);
    // Wooden tower on the left with a gunpowder cache on top.
    const tx0 = X(0.05);
    const tx1 = X(0.24);
    const top = Y(0.4);
    s.rect(tx0, g + 1, tx0 + 1, top, M.WOOD);
    s.rect(tx1 - 1, g + 1, tx1, top, M.WOOD);
    s.rect(tx0, Y(0.24), tx1, Y(0.24) + 1, M.WOOD);
    s.rect(tx0, top, tx1, top + 1, M.WOOD);
    s.rect(tx0 + 3, top + 2, tx1 - 3, top + 6, M.POWDER);
    // Lava pocket sealed in rock inside the tower's base: dig or dissolve to let it out.
    s.rect(tx0 + 3, g + 1, tx1 - 3, g + 8, M.ROCK);
    s.rect(tx0 + 5, g + 1, tx1 - 5, g + 5, M.LAVA);
    // Sand heap on a ledge, upper right, with an ice block hanging under it.
    const lx0 = X(0.52);
    const lx1 = X(0.95);
    const ly = Y(0.52);
    s.rect(lx0, ly, lx1, ly + 1, M.WALL);
    for (let y = 0; y < 18; y++) s.rect(lx0 + 6 + y, ly + 2 + y, lx1 - 6 - y, ly + 2 + y, M.SAND);
    s.rect(lx0 + 2, ly - 8, lx0 + 12, ly - 1, M.ICE);
  }

  private buildDock() {
    injectDockStyle();
    const dock = document.createElement('div');
    dock.className = 'dock sand-dock';
    const buttons = TOOLS.map((t) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'swatch';
      b.textContent = t.glyph;
      b.setAttribute('aria-label', t.label);
      b.title = t.label;
      b.style.setProperty('--swatch', t.swatch);
      b.setAttribute('aria-pressed', String(t.id === this.tool));
      b.addEventListener('click', () => {
        this.tool = t.id;
        buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      });
      return b;
    });
    dock.append(...buttons);
    this.ctx.overlay.appendChild(dock);
    return dock;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    panel.slider(c, 'brush', { label: 'Brush size', min: 1, max: 12, step: 1 });
    panel.choice(
      'Cell size (px)',
      [2, 3, 4, 5].map((v) => ({ value: String(v), label: String(v) })),
      String(c.cellSize),
      (v) => {
        c.cellSize = Number(v);
        this.sim = undefined as unknown as Sim;
        this.rebuild(false);
        this.scene();
      },
    );
    panel.choice(
      'Simulation speed',
      [1, 2, 3].map((v) => ({ value: String(v), label: `${v}×` })),
      String(c.speed),
      (v) => (c.speed = Number(v)),
    );
    panel.slider(c, 'glow', { label: 'Glow', min: 0, max: 2.5, step: 0.05 });
    panel.choice('Edges', [{ value: 'walls', label: 'Walls' }, { value: 'wrap', label: 'Wrap around' }], 'walls', (v) => {
      c.wrap = v === 'wrap';
      this.sim.wrap = c.wrap;
    });
    panel.action('Reset scene', () => this.scene());
    panel.action('Clear', () => this.sim.clear());
  }

  frame(dt: number, t: number) {
    const s = this.sim;
    const r = this.cfg.brush;
    let pour = 0;
    let stroke = 0;
    let px0 = 0;
    for (const p of this.ctx.pointers.active.values()) {
      const x = p.x * s.w;
      const y = p.y * s.h;
      // Paint along the drag so fast strokes leave no gaps.
      const px = x - p.dx * s.w;
      const py = y - p.dy * s.h;
      const steps = Math.max(1, Math.ceil(Math.hypot(x - px, y - py) / Math.max(1, r * 0.5)));
      for (let k = 1; k <= steps; k++) s.paint(px + ((x - px) * k) / steps, py + ((y - py) * k) / steps, r, this.tool);
      if (p.justDown) {
        this.ctx.haptic('light');
        this.brushDown(p.x);
      }
      pour = Math.max(pour, 0.5 + Math.min(0.5, Math.hypot(p.dx, p.dy) * 30));
      stroke += Math.hypot(x - px, y - py);
      px0 = p.x;
    }
    this.brushSound(dt, pour, stroke, px0);

    let booms = 0;
    let boomSize = 0;
    let flames = 0;
    let molten = 0;
    let quench = 0;
    const t0 = performance.now();
    for (let k = 0; k < this.cfg.speed; k++) {
      s.step();
      booms += s.booms;
      boomSize = Math.max(boomSize, s.boomSize);
      flames += s.flames;
      molten += s.molten;
      quench += s.quench;
    }
    this.sceneSound(dt, flames / this.cfg.speed, molten / this.cfg.speed, quench / this.cfg.speed, booms, boomSize);
    this.simMs += (performance.now() - t0 - this.simMs) * 0.1;
    if (booms > 0) {
      this.flash = Math.min(0.75, this.flash + 0.2 * booms);
      this.shake = Math.min(0.6, this.shake + 0.14 * booms);
      this.ctx.haptic(booms > 2 ? 'heavy' : 'medium');
    }
    this.flash *= Math.exp(-dt * 9);
    this.shake *= Math.exp(-dt * 12);
    const sx = (Math.random() - 0.5) * this.shake * (6 / s.w);
    const sy = (Math.random() - 0.5) * this.shake * (6 / s.h);

    this.renderer.draw(s.mat, s.vari, s.life, {
      width: this.width,
      height: this.height,
      time: t,
      glow: this.cfg.glow,
      flash: this.flash,
      shake: [sx, sy],
    });

    // Counting cells is a full sweep; twice a second is plenty for the HUD.
    this.statusTimer -= dt;
    if (this.statusTimer <= 0) {
      this.statusTimer = 0.5;
      this.ctx.setStatus(`grid ${s.w}×${s.h} · ${s.count().toLocaleString()} cells · sim ${this.simMs.toFixed(1)}ms`);
    }
  }

  // ---------------------------------------------------------------- sound

  /** A tap of the brush: a little onset that says what you picked up. */
  private brushDown(u: number) {
    const pan = (u - 0.5) * 1.2;
    const m = this.tool;
    if (m === M.SAND || m === M.POWDER) this.ctx.sound.play('crumble', { gain: 0.3, pitch: m === M.POWDER ? 0.8 : 1.1, pan });
    else if (m === M.WATER || m === M.OIL || m === M.ACID) this.ctx.sound.play('plop', { gain: 0.35, pitch: m === M.OIL ? 0.7 : 1, pan });
    else if (m === M.FIRE || m === M.LAVA) this.ctx.sound.play('sizzle', { gain: 0.3, pitch: m === M.LAVA ? 0.6 : 1, pan });
    else if (m === M.STEAM || m === M.EMPTY) this.ctx.sound.play('whoosh', { gain: 0.25, pitch: 1.3, pan });
    else if (m === M.PLANT) this.ctx.sound.play('pop', { gain: 0.25, pitch: 1.6, pan });
    else this.ctx.sound.play('knock', { gain: 0.35, pitch: m === M.ICE ? 1.6 : m === M.WOOD ? 1 : 0.7, pan });
  }

  /** Loops that follow the brush: grains trickle, liquids burble, solids tick as they are laid. */
  private brushSound(dt: number, pour: number, stroke: number, u: number) {
    const m = this.tool;
    const grain = m === M.SAND || m === M.POWDER;
    const wet = m === M.WATER || m === M.OIL || m === M.ACID;
    this.grains.set(grain ? pour * 0.7 : 0, m === M.POWDER ? 0.35 : 0.65);
    this.liquid.set(wet ? pour * 0.6 : 0, m === M.OIL ? 0.15 : m === M.ACID ? 0.85 : 0.5);
    // Painting fire, lava or steam leans on the scene beds below; mark it so they swell at once.
    if (pour > 0 && (m === M.FIRE || m === M.LAVA || m === M.STEAM)) this.hot = Math.max(this.hot, 0.5);
    // Solids and the eraser: a soft tick every few cells of stroke.
    if (m === M.WALL || m === M.WOOD || m === M.ICE || m === M.PLANT || m === M.EMPTY) {
      this.strokeTick += stroke;
      if (this.strokeTick > 14) {
        this.strokeTick = 0;
        this.ctx.sound.play('tick', { gain: 0.25, pitch: m === M.ICE ? 1.8 : m === M.EMPTY ? 1.3 : 0.9, pan: (u - 0.5) * 1.2 });
      }
    }
    this.hot *= Math.exp(-dt * 3);
  }

  /** Beds from what the sim is doing this frame: fire crackles, lava rumbles, quenching hisses. */
  private sceneSound(dt: number, flames: number, molten: number, quench: number, booms: number, boomSize: number) {
    const m = this.tool;
    const painting = this.hot > 0.05;
    this.fireBed.set(Math.min(1, Math.sqrt(flames / 700) + (painting && m === M.FIRE ? this.hot * 0.4 : 0)), 0.4 + Math.min(0.5, flames / 3000));
    this.lavaBed.set(Math.min(0.7, Math.sqrt(molten / 1500) * 0.7 + (painting && m === M.LAVA ? this.hot * 0.3 : 0)), 0.3);
    this.steamBed.set(Math.min(1, Math.sqrt(quench / 60) + (painting && m === M.STEAM ? this.hot * 0.5 : 0)), 0.6);
    // A burst of quenching gets a sharp sizzle on top of the hiss.
    if (quench > 25 && Math.random() < dt * 6) this.ctx.sound.play('sizzle', { gain: Math.min(0.8, quench / 150) });
    if (booms > 0) {
      const big = Math.min(1, (boomSize - 4) / 6);
      this.ctx.sound.play('thud', { pitch: 0.55 + (1 - big) * 0.3, gain: Math.min(1, 0.5 + booms * 0.15) });
      this.ctx.sound.play('snap', { pitch: 0.7 + Math.random() * 0.4, gain: Math.min(0.9, 0.4 + booms * 0.1) });
      if (booms > 1) this.ctx.sound.play('crumble', { pitch: 0.7, gain: 0.5 });
    }
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.rebuild(true);
  }

  destroy() {
    this.grains.stop();
    this.liquid.stop();
    this.fireBed.stop();
    this.lavaBed.stop();
    this.steamBed.stop();
    this.dock.remove();
    this.renderer.destroy();
  }
}

/** Thirteen tools don't fit one row on a phone: wrap them into a compact two-row tray. */
function injectDockStyle() {
  if (document.getElementById('sand-dock-style')) return;
  const st = document.createElement('style');
  st.id = 'sand-dock-style';
  st.textContent = `
.dock.sand-dock {
  flex-wrap: wrap;
  justify-content: center;
  gap: 5px;
  padding: 6px 8px;
  border-radius: 22px;
  width: max-content;
  max-width: min(330px, calc(100vw - 24px));
  overflow: visible;
}
.dock.sand-dock button.swatch {
  width: 36px;
  height: 36px;
  min-width: 36px;
  font-size: 17px;
  opacity: 0.75;
}
.dock.sand-dock button.swatch[aria-pressed="true"] { opacity: 1; transform: scale(1.08); }
`;
  document.head.appendChild(st);
}
