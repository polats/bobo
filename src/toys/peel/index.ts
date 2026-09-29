import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop } from '../../shell/sound';
import { Film, type Handle } from './sim';
import { PeelRenderer, CAM_D } from './render';
import { DESIGNS, SCENES, makeScene, paintSticker, type Scene, type SceneId } from './art';

export const peelToy: Toy = {
  id: 'peel',
  title: 'Peel It',
  blurb: 'Roll the film off a new phone, a sticker, fresh masking tape. Slow and high comes off clean; yank it and it tears.',
  tech: 'XPBD film + Kendall peel · WebGL2',
  swatch: 'linear-gradient(135deg,#7597de,#ff8fb1 55%,#fff1c1)',
  refs: [
    {
      short: 'Kendall 1975',
      title: 'Kendall — Thin-film peeling: the elastic term (J. Phys. D, 1975)',
      url: 'https://doi.org/10.1088/0022-3727/8/13/005',
      use: 'F = G·w / (1 − cos θ): every glue point lets go at a pull that falls as the peel angle rises.',
    },
    {
      short: 'Macklin 2016',
      title: 'Macklin, Müller, Chentanez — XPBD (MIG 2016)',
      url: 'https://dl.acm.org/doi/10.1145/2994258.2994272',
      use: 'Compliant constraints for the film, the curl hinges and the soft glue layer.',
    },
    {
      short: 'Macklin 2019',
      title: 'Macklin et al. — Small Steps in Physics Simulation (SCA 2019)',
      url: 'https://dl.acm.org/doi/10.1145/3309486.3340247',
      use: 'Ten substeps a frame keep a near-inextensible film stable under a fast pull.',
    },
    {
      short: 'TMP #14',
      title: 'Ten Minute Physics #14 — cloth simulation',
      url: 'https://matthias-research.github.io/pages/tenMinutePhysics/index.html',
      use: 'Grid cloth with stretch constraints and grabbing, flattened here onto a surface.',
    },
  ],
  async create(ctx) {
    return new PeelIt(ctx);
  },
};

const SHELF_KEY = 'bobo.peel.shelf';
/** Tab height when held, in world units: high enough that the first lift peels instead of tearing. */
const LIFT = 0.42;
/** Finger radius for grabbing, CSS px. */
const GRAB_PX = 40;

interface Grab {
  handle: Handle;
  /** Finger on the surface at grab time, and the tab's position then. */
  fx0: number;
  fy0: number;
  ax: number;
  ay: number;
  z: number;
  lastX: number;
  lastY: number;
  vx: number;
  vy: number;
}

class PeelIt implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private renderer: PeelRenderer;
  private film!: Film;
  private scene!: Scene;
  private width = 1;
  private height = 1;
  /** Pixels per world unit and the world origin on the canvas (device px, y down). */
  private S = 1;
  private cx = 0;
  private cy = 0;
  private baseCanvas = document.createElement('canvas');
  private glossCanvas = document.createElement('canvas');
  private printCanvas = document.createElement('canvas');
  private grabs = new Map<number, Grab>();
  private crackle: Loop;
  private relRate = 0;
  private relTick = 0;
  private relBuzz = 0;
  private handSpeed = 0;
  private done = false;
  private doneAt = 0;
  private time = 0;
  private flash = 0;
  private flyingCount = 0;
  private simMs = 0;
  private design = 0;
  private sceneIdx = 0;
  private hud: HTMLElement;
  private hint!: HTMLElement;
  private next!: HTMLButtonElement;
  private shelf!: HTMLElement;
  private style: HTMLStyleElement;
  private grabbedOnce = false;
  private message = '';
  private lastFling: [number, number] = [0, 1];

  readonly cfg = { stick: 0.03, tough: 0.3, reach: 1 };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, stencil: true });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.renderer = new PeelRenderer(gl);
    this.crackle = ctx.sound.loop('crackle');
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hud = this.buildHud();
    this.design = Math.floor(Math.random() * DESIGNS.length);
    this.buildPanel();
    this.load('phone');
    if (import.meta.env.DEV) {
      // Dev-only probes for headless tests.
      const w = window as unknown as Record<string, unknown>;
      w.__peel = {
        stats: () => ({
          scene: this.scene.id,
          released: this.film.released,
          total: this.film.total,
          progress: this.film.released / Math.max(1, this.film.total),
          tears: this.film.tears,
          torn: this.film.everTorn,
          pieces: this.film.compCount,
          done: this.done,
          message: this.message,
          held: this.grabs.size,
          simMs: this.simMs,
          maxStrain: this.film.maxStrain,
        }),
        /** Where the tab is, in CSS px from the canvas's top-left. */
        tab: () => {
          const f = this.film;
          let x = 0, y = 0, n = 0;
          for (let i = 0; i < f.n; i++)
            if (f.isTab[i]) {
              x += f.pos[i * 3];
              y += f.pos[i * 3 + 1];
              n++;
            }
          const [px, py] = this.toScreen(x / n, y / n, 0);
          return { x: px / this.ctx.pixelRatio, y: py / this.ctx.pixelRatio };
        },
        /** A world point on the surface, in CSS px. */
        at: (x: number, y: number) => {
          const [px, py] = this.toScreen(x, y, 0);
          return { x: px / this.ctx.pixelRatio, y: py / this.ctx.pixelRatio };
        },
        /** A free edge of what's left (after a tear), lowest on screen first, in CSS px. */
        edge: () => {
          const f = this.film;
          let best = -1;
          for (let i = 0; i < f.n; i++) if (!f.fly[i] && f.boundary[i] && (best < 0 || f.pos[i * 3 + 1] < f.pos[best * 3 + 1])) best = i;
          if (best < 0) return null;
          const [px, py] = this.toScreen(f.pos[best * 3], f.pos[best * 3 + 1], f.pos[best * 3 + 2]);
          return { x: px / this.ctx.pixelRatio, y: py / this.ctx.pixelRatio };
        },
        load: (id: SceneId) => this.load(id),
      };
    }
  }

  // ---------------------------------------------------------------- scenes

  private load(id: SceneId) {
    this.sceneIdx = SCENES.indexOf(id);
    this.scene = makeScene(id, this.design);
    this.grabs.clear();
    this.done = false;
    this.flash = 0;
    this.message = '';
    this.flyingCount = 0;
    this.grabbedOnce = false;
    this.paintPrint();
    const film = this.scene.film;
    if (this.scene.cutout) {
      // Stickers: glue only inside the die-cut shape, and put the tab on its lower-right edge.
      const pc = this.printCanvas;
      const px = pc.getContext('2d')!.getImageData(0, 0, pc.width, pc.height).data;
      const alpha = (u: number, v: number) => {
        const x = Math.min(pc.width - 1, Math.max(0, Math.round(u * (pc.width - 1))));
        const y = Math.min(pc.height - 1, Math.max(0, Math.round((1 - v) * (pc.height - 1))));
        return px[(y * pc.width + x) * 4 + 3] / 255;
      };
      film.shape = alpha;
      // The tab goes on the furthest-out tip in the lower right: a point you can get a nail under.
      let best = 0, bu = 0.7, bv = 0.3;
      for (let a = -1.4; a <= -0.2; a += 0.05) {
        const du = Math.cos(a), dv = Math.sin(a);
        let t = 0;
        while (t < 0.7 && alpha(0.5 + t * du, 0.5 + t * dv) > 0.5) t += 0.005;
        if (t > best) {
          best = t;
          bu = 0.5 + (t - 0.035) * du;
          bv = 0.5 + (t - 0.035) * dv;
        }
      }
      film.tab = [bu, bv];
    }
    this.film = new Film(film);
    this.syncCfg();
    this.renderer.setFilm(this.film);
    this.layout();
    this.hint.textContent = this.scene.hint;
    this.hint.classList.remove('gone');
    this.next.hidden = true;
    this.shelf.hidden = id !== 'sticker';
    this.renderShelf();
  }

  private syncCfg() {
    this.film.cfg.stick = this.cfg.stick;
    this.film.cfg.tough = this.cfg.tough;
  }

  private nextScene() {
    if (this.scene.id === 'sticker') this.design = (this.design + 1) % DESIGNS.length;
    this.load(SCENES[(this.sceneIdx + 1) % SCENES.length]);
  }

  private layout() {
    const pr = this.ctx.pixelRatio;
    const W = this.width, H = this.height;
    const top = 120 * pr;
    const bottom = (this.scene.id === 'sticker' ? 84 : 24) * pr;
    const [bw, bh] = this.scene.bounds;
    this.S = Math.min((W * 0.94) / bw, (H - top - bottom) / bh);
    this.cx = W / 2;
    this.cy = top + (H - top - bottom) / 2;
    this.renderer.scale = [(2 * this.S) / W, (2 * this.S) / H];
    this.renderer.offset = [(2 * (this.cx - W / 2)) / W, (2 * (H / 2 - this.cy)) / H];
    this.paintBase();
  }

  private paintBase() {
    const b = this.baseCanvas;
    b.width = this.width;
    b.height = this.height;
    const g = b.getContext('2d')!;
    g.setTransform(this.S, 0, 0, this.S, this.cx, this.cy);
    this.scene.drawBase(g);
    this.renderer.upload('base', b);
    const gc = this.glossCanvas;
    gc.width = Math.max(1, this.width >> 1);
    gc.height = Math.max(1, this.height >> 1);
    const gg = gc.getContext('2d')!;
    gg.fillStyle = '#000';
    gg.fillRect(0, 0, gc.width, gc.height);
    gg.setTransform(this.S / 2, 0, 0, this.S / 2, this.cx / 2, this.cy / 2);
    this.scene.drawGloss(gg);
    this.renderer.upload('gloss', gc);
  }

  private paintPrint() {
    const f = this.scene.film;
    const P = 1024 / Math.max(f.w, f.h);
    const pc = this.printCanvas;
    pc.width = Math.round(f.w * P);
    pc.height = Math.round(f.h * P);
    const g = pc.getContext('2d', { willReadFrequently: true })!;
    g.clearRect(0, 0, pc.width, pc.height);
    // Art coords are y-down world: the film's top edge is at y = -(y0 + h).
    g.setTransform(P, 0, 0, P, -f.x0 * P, (f.y0 + f.h) * P);
    this.scene.drawPrint(g);
    this.renderer.upload('print', pc);
  }

  // ---------------------------------------------------------------- HUD

  private buildHud() {
    const hud = document.createElement('div');
    hud.className = 'peel-hud';
    this.hint = document.createElement('div');
    this.hint.className = 'peel-hint';
    this.next = document.createElement('button');
    this.next.type = 'button';
    this.next.className = 'peel-next';
    this.next.textContent = 'Next ›';
    this.next.hidden = true;
    this.next.addEventListener('click', () => this.nextScene());
    this.shelf = document.createElement('div');
    this.shelf.className = 'peel-shelf';
    hud.append(this.hint, this.next, this.shelf);
    this.ctx.overlay.appendChild(hud);
    return hud;
  }

  private readShelf(): number[] {
    try {
      const v = JSON.parse(localStorage.getItem(SHELF_KEY) ?? '[]');
      return Array.isArray(v) ? v.filter((x) => Number.isInteger(x)) : [];
    } catch {
      return [];
    }
  }

  private addToShelf(design: number) {
    const list = [...this.readShelf(), design].slice(-60);
    try {
      localStorage.setItem(SHELF_KEY, JSON.stringify(list));
    } catch {
      /* private mode: the shelf just doesn't persist */
    }
    this.renderShelf(true);
  }

  private renderShelf(pop = false) {
    if (this.shelf.hidden) return;
    const list = this.readShelf();
    this.shelf.replaceChildren();
    const label = document.createElement('span');
    label.textContent = list.length ? `Sticker shelf · ${list.length}` : 'Sticker shelf · peel one to keep it';
    this.shelf.appendChild(label);
    const row = document.createElement('div');
    for (const [k, d] of list.slice(-9).entries()) {
      const c = document.createElement('canvas');
      c.width = c.height = 72;
      const g = c.getContext('2d')!;
      g.setTransform(28, 0, 0, 28, 36, 36);
      paintSticker(g, DESIGNS[d % DESIGNS.length]);
      if (pop && k === Math.min(8, list.length - 1)) c.className = 'pop';
      row.appendChild(c);
    }
    this.shelf.appendChild(row);
  }

  private buildPanel() {
    const { panel } = this.ctx;
    panel.choice<SceneId>(
      'Scene',
      SCENES.map((s) => ({ value: s, label: makeScene(s).label })),
      'phone',
      (v) => this.load(v),
    );
    panel.slider(this.cfg, 'stick', { label: 'Stickiness', min: 0.012, max: 0.07, step: 0.002, onChange: () => this.syncCfg() });
    panel.slider(this.cfg, 'tough', { label: 'Film strength', min: 0.12, max: 0.8, step: 0.01, onChange: () => this.syncCfg() });
    panel.slider(this.cfg, 'reach', { label: 'Roll reach', min: 0.5, max: 1.5, step: 0.05 });
    panel.action('Next scene', () => this.nextScene());
    panel.action('Stick it back (reset)', () => this.load(this.scene.id));
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    const f = this.film;
    this.handleInput(dt);
    const t0 = performance.now();
    f.step(dt);
    this.simMs += (performance.now() - t0 - this.simMs) * 0.1;
    if (f.tornThisFrame) this.onTear();
    this.feel(dt);
    this.checkDone();
    // Flying pieces: count those gone, so the renderer drops their triangles.
    let gone = 0;
    for (let i = 0; i < f.n; i++) if (f.fly[i] === 2) gone++;
    this.flyingCount = gone;
    if (this.done) this.flash = Math.min(1, (t - this.doneAt) / 1.3);
    this.ctx.progress(f.released / Math.max(1, f.total), 'peeled');
    this.renderer.draw(f, this.scene, this.width, this.height, t, this.done ? this.flash : 0, 1.2 * this.ctx.pixelRatio, gone);
    let held: Grab | undefined;
    for (const g of this.grabs.values()) held = g;
    const angle = held ? Math.round((Math.acos(Math.max(-1, 1 - 1 / f.peelFactor(held.handle.verts[0]))) * 180) / Math.PI) : 0;
    this.ctx.setStatus(`${Math.round((100 * f.released) / Math.max(1, f.total))}% peeled · ${f.tears} tears${held ? ` · peel ${angle}°` : ''} · sim ${this.simMs.toFixed(1)}ms`);
  }

  private handleInput(dt: number) {
    const f = this.film;
    const pr = this.ctx.pixelRatio;
    let speed = 0;
    for (const p of this.ctx.pointers.active.values()) {
      let gr = this.grabs.get(p.id);
      const [wx, wy] = this.toWorld(p.x, p.y, 0);
      if (!gr) {
        if (!p.justDown || this.done) continue;
        const idx = this.pick(p.x, p.y, (GRAB_PX * pr) / this.S);
        if (idx < 0) continue;
        gr = this.makeGrab(idx, wx, wy);
        this.grabs.set(p.id, gr);
        f.handles.push(gr.handle);
        f.updateComponents();
        this.ctx.haptic('light');
        this.ctx.sound.play('tick', { pitch: 1.6, gain: 0.5, pan: this.pan(p.x) });
        if (!this.grabbedOnce) {
          this.grabbedOnce = true;
          this.hint.classList.add('gone');
        }
      }
      // The tab follows the finger, scaled by reach: with the film rolled back on itself the fold
      // moves at half the tab's speed, so this keeps the peel front under your finger.
      const reach = this.cfg.reach * this.scene.reach;
      const tx = gr.ax + (wx - gr.fx0) * reach;
      const ty = gr.ay + (wy - gr.fy0) * reach;
      gr.z += (LIFT - gr.z) * Math.min(1, dt * 9);
      gr.handle.target[0] = tx;
      gr.handle.target[1] = ty;
      gr.handle.target[2] = gr.z;
      if (dt > 0) {
        const vx = (tx - gr.lastX) / dt, vy = (ty - gr.lastY) / dt;
        gr.vx += (vx - gr.vx) * Math.min(1, dt * 14);
        gr.vy += (vy - gr.vy) * Math.min(1, dt * 14);
        speed = Math.max(speed, Math.hypot(gr.vx, gr.vy) / reach);
      }
      gr.lastX = tx;
      gr.lastY = ty;
    }
    // Let go: whatever piece is no longer glued anywhere flies off.
    let released = false;
    for (const [id, gr] of this.grabs) {
      if (this.ctx.pointers.active.has(id)) continue;
      this.grabs.delete(id);
      f.handles = f.handles.filter((h) => h !== gr.handle);
      this.lastFling = [gr.vx, gr.vy];
      released = true;
    }
    if (released) {
      f.updateComponents();
      this.flingLoose();
    }
    this.handSpeed = speed;
    f.speed = speed;
  }

  /** Nearest grabbable vertex: loose film (the tab, a peeled flap), or after a tear any free edge. */
  private pick(u: number, v: number, radius: number) {
    const f = this.film;
    const [sx, sy] = this.renderer.scale;
    const [ox, oy] = this.renderer.offset;
    const fu = u * 2 - 1, fv = v * 2 - 1;
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < f.n; i++) {
      if (f.fly[i]) continue;
      const loose = !f.stuck[i] && (f.sticky[i] || f.isTab[i]);
      if (!loose && !(f.everTorn && f.boundary[i])) continue;
      // Compare on screen (lifted film sits a little off its ground position), in world units.
      const k = CAM_D / (CAM_D - f.pos[i * 3 + 2]);
      const dx = ((f.pos[i * 3] * sx + ox) * k - fu) / sx;
      const dy = ((f.pos[i * 3 + 1] * sy + oy) * k - fv) / sy;
      // Prefer loose film a little over picking at a glued edge.
      const d = (dx * dx + dy * dy) * (loose ? 0.6 : 1);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** A pinch-sized patch around the picked vertex, held softly (strong at the centre, light at the rim). */
  private makeGrab(idx: number, wx: number, wy: number): Grab {
    const f = this.film;
    const R = 3 * f.spacing;
    const cx = f.pos[idx * 3], cy = f.pos[idx * 3 + 1], cz = f.pos[idx * 3 + 2];
    const verts: number[] = [];
    const offsets: number[] = [];
    const weights: number[] = [];
    const rx = f.rest[idx * 2], ry = f.rest[idx * 2 + 1];
    for (let i = 0; i < f.n; i++) {
      if (f.fly[i] || f.comp[i] !== f.comp[idx]) continue;
      // Near along the film, not just in space: a folded flap lies right on top of glued film.
      const d = Math.hypot(f.rest[i * 2] - rx, f.rest[i * 2 + 1] - ry);
      const dx = f.pos[i * 3] - cx, dy = f.pos[i * 3 + 1] - cy, dz = f.pos[i * 3 + 2] - cz;
      if (d > R || Math.hypot(dx, dy, dz) > R * 1.5) continue;
      verts.push(i);
      offsets.push(dx, dy, dz);
      weights.push(0.05 + 0.3 * (1 - (d / R) ** 2));
      f.release(i);
    }
    // The picked vertex first: it names the piece this hand is pulling.
    const at = verts.indexOf(idx);
    if (at > 0) {
      [verts[0], verts[at]] = [verts[at], verts[0]];
      for (let k = 0; k < 3; k++) [offsets[k], offsets[at * 3 + k]] = [offsets[at * 3 + k], offsets[k]];
      [weights[0], weights[at]] = [weights[at], weights[0]];
    }
    return {
      handle: { verts: Int32Array.from(verts), offsets: Float32Array.from(offsets), weights: Float32Array.from(weights), target: [cx, cy, cz] },
      fx0: wx,
      fy0: wy,
      ax: cx,
      ay: cy,
      z: Math.max(cz, 0.05),
      lastX: cx,
      lastY: cy,
      vx: 0,
      vy: 0,
    };
  }

  private onTear() {
    const f = this.film;
    const n = f.tornThisFrame;
    const [sx] = this.toScreen(f.tearX, 0, 0);
    this.ctx.haptic('medium');
    this.ctx.sound.play('rip', { gain: Math.min(1, 0.4 + n * 0.06), pitch: 1.3 * 0.95 ** Math.min(8, n), pan: this.pan(sx / this.width) });
    f.updateComponents();
    this.flingLoose();
    if (!this.done) {
      this.hint.textContent = 'Torn! Pick at the stuck scrap';
      this.hint.classList.remove('gone');
      this.placeHint();
      clearTimeout(this.hintTimer);
      this.hintTimer = window.setTimeout(() => this.hint.classList.add('gone'), 2200);
    }
  }
  private hintTimer = 0;

  /** Pieces with no glue left and no finger on them come away. */
  private flingLoose() {
    const f = this.film;
    for (let c = 0; c < f.compCount; c++) {
      if (f.compStuck[c] > 0) continue;
      if (f.handles.some((h) => f.comp[h.verts[0]] === c)) continue;
      let alive = false;
      for (let i = 0; i < f.n; i++)
        if (f.comp[i] === c && !f.fly[i]) {
          alive = true;
          break;
        }
      if (!alive) continue;
      const [vx, vy] = this.lastFling;
      const s = Math.hypot(vx, vy);
      const k = s > 0.5 ? 1.2 / s : 0;
      f.fling(c, vx * k, vy * k + (k ? 0 : 0.8));
      this.ctx.sound.play('whoosh', { gain: 0.35, pitch: 1.2 });
    }
  }

  private checkDone() {
    const f = this.film;
    if (this.done || f.released < f.total) return;
    this.done = true;
    this.doneAt = this.time;
    this.message = f.everTorn ? 'Peeled!' : 'One clean peel!';
    this.ctx.celebrate(this.message);
    this.ctx.sound.play('whoosh', { gain: 0.6, pitch: 0.9 });
    // The film comes free: out of your hand and away (a sticker flies down to the shelf).
    for (const gr of this.grabs.values()) this.lastFling = [gr.vx, gr.vy];
    this.grabs.clear();
    f.handles = [];
    f.updateComponents();
    const toShelf = this.scene.id === 'sticker';
    for (let c = 0; c < f.compCount; c++) f.fling(c, toShelf ? 0 : this.lastFling[0] * 0.4, toShelf ? -3.2 : 1.2 + this.lastFling[1] * 0.4);
    if (toShelf) window.setTimeout(() => this.addToShelf(this.design), 450);
    this.next.hidden = false;
    this.hint.classList.add('gone');
  }

  /** Crackle while the glue lets go, ticks per cluster of releases, a buzz you can feel. */
  private feel(dt: number) {
    const f = this.film;
    const n = f.releasedThisFrame;
    if (dt > 0) this.relRate += (n / dt - this.relRate) * Math.min(1, dt * 10);
    const pan = n ? this.pan(this.toScreen(f.releaseX, 0, 0)[0] / this.width) : 0;
    this.crackle.set(Math.min(1, this.relRate / 260) * 0.9, Math.min(1, 0.25 + this.handSpeed / 2));
    this.relTick += n;
    this.relBuzz += n;
    if (this.relTick >= 8) {
      this.relTick = 0;
      this.ctx.sound.play('tick', { pitch: 2 + Math.min(1, this.handSpeed / 2), gain: 0.28, pan });
    }
    if (this.relBuzz >= 6) {
      this.relBuzz = 0;
      this.ctx.haptic('light');
    }
    this.placeHint();
  }

  private placeHint() {
    if (this.hint.classList.contains('gone')) return;
    const f = this.film;
    let x = 0, y = 0, k = 0;
    for (let i = 0; i < f.n; i++)
      if (f.isTab[i] && !f.fly[i]) {
        x += f.pos[i * 3];
        y += f.pos[i * 3 + 1];
        k++;
      }
    if (!k) return;
    const pr = this.ctx.pixelRatio;
    const [px, py] = this.toScreen(x / k, y / k, 0);
    const cssW = this.width / pr;
    const half = this.hint.offsetWidth / 2 + 12;
    const hx = Math.min(cssW - half, Math.max(half, px / pr));
    this.hint.style.transform = `translate(${hx}px, ${py / pr}px) translate(-50%, ${py / pr > this.height / pr - 140 ? '-190%' : '90%'})`;
  }

  // ---------------------------------------------------------------- coordinates

  /** Screen UV (y up) to the world point at height z under it. */
  private toWorld(u: number, v: number, z: number): [number, number] {
    const [sx, sy] = this.renderer.scale;
    const [ox, oy] = this.renderer.offset;
    const k = CAM_D / (CAM_D - z);
    return [((u * 2 - 1) / k - ox) / sx, ((v * 2 - 1) / k - oy) / sy];
  }

  /** World point to canvas device px (y down). */
  private toScreen(x: number, y: number, z: number): [number, number] {
    const [sx, sy] = this.renderer.scale;
    const [ox, oy] = this.renderer.offset;
    const k = CAM_D / (CAM_D - z);
    const cx = (x * sx + ox) * k, cy = (y * sy + oy) * k;
    return [((cx + 1) / 2) * this.width, ((1 - cy) / 2) * this.height];
  }

  private pan(x: number) {
    return (x - 0.5) * 1.2;
  }

  resize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.layout();
  }

  destroy() {
    this.crackle.stop();
    clearTimeout(this.hintTimer);
    this.hud.remove();
    this.style.remove();
    this.renderer.destroy();
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__peel;
  }
}

const STYLE = `
.peel-hud { position: absolute; inset: 0; pointer-events: none; font-family: ui-rounded, -apple-system, system-ui, sans-serif; }
.peel-hint { position: absolute; left: 0; top: 0; padding: 8px 12px; border-radius: 12px; background: rgba(10,10,16,0.72); color: #fff; font-size: 13px; font-weight: 700; white-space: nowrap; transition: opacity .35s; -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); }
.peel-hint.gone { opacity: 0; }
.peel-next { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(96px + env(safe-area-inset-bottom, 0px)); pointer-events: auto; padding: 12px 22px; border: 0; border-radius: 99px; background: #fff; color: #1a1420; font: 800 16px/1 inherit; box-shadow: 0 8px 24px rgba(0,0,0,0.3); cursor: pointer; animation: peel-rise .4s cubic-bezier(.2,1.4,.4,1); }
.peel-next[hidden] { display: none; }
.peel-shelf { white-space: nowrap; position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(10px + env(safe-area-inset-bottom, 0px)); padding: 6px 12px 8px; border-radius: 16px; background: rgba(255,255,255,0.7); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); color: #2c5a4c; font-size: 11px; font-weight: 800; text-align: center; max-width: calc(100vw - 32px); box-sizing: border-box; }
.peel-shelf[hidden] { display: none; }
.peel-shelf div { display: flex; justify-content: center; gap: 2px; min-height: 36px; margin-top: 2px; }
.stage .peel-shelf canvas { position: static; inset: auto; width: 36px; height: 36px; filter: drop-shadow(0 1px 1px rgba(0,0,0,0.25)); }
.stage .peel-shelf canvas.pop { animation: peel-in .5s cubic-bezier(.2,1.6,.4,1); }
@keyframes peel-rise { from { transform: translateX(-50%) scale(0.5); opacity: 0; } to { transform: translateX(-50%); opacity: 1; } }
@keyframes peel-in { from { transform: scale(0.3) translateY(-20px); opacity: 0; } to { opacity: 1; } }
`;
