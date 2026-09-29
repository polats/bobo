import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop } from '../../shell/sound';
import { Film, type Handle } from '../peel/sim';
import { CAM_D } from '../peel/render';
import { PrintsRenderer, type Parts, type View } from './render';
import { Powder } from './powder';
import { CASES, type Box, type CaseDef, type PowderId } from './scenes';
import { drawCard, makeRidges, rng, type Pattern, type Ridges } from './fingerprint';

export const printsToy: Toy = {
  id: 'prints',
  title: 'Fingerprint Dust',
  blurb: 'Brush powder over the evidence until hidden prints bloom, blow off the excess, lift the print with tape and match it to a suspect.',
  tech: 'Powder grid + Gabor ridges + XPBD tape · WebGL2',
  swatch: 'radial-gradient(circle at 45% 40%,#d9dde4 0 6%,#3a4250 7% 9%,#d9dde4 10% 12%,#3a4250 13% 15%,#1a1f2a 30%,#07090e)',
  refs: [
    {
      short: 'SFinGe',
      title: 'Cappelli, Erol, Maio, Maltoni — Synthetic Fingerprint-Image Generation (ICPR 2000)',
      url: 'https://doi.org/10.1109/ICPR.2000.903586',
      use: 'Ridges grown by iterated oriented Gabor filtering of noise over an orientation field.',
    },
    {
      short: 'Sherlock 1993',
      title: 'Sherlock, Monro — A model for interpreting fingerprint topology (Pattern Recognition, 1993)',
      url: 'https://doi.org/10.1016/0031-3203(93)90006-I',
      use: 'Zero-pole orientation model: cores and deltas set loops, whorls and arches.',
    },
    {
      short: 'Kendall 1975',
      title: 'Kendall — Thin-film peeling: the elastic term (J. Phys. D, 1975)',
      url: 'https://doi.org/10.1088/0022-3727/8/13/005',
      use: "Lifting tape reuses Peel It's film, whose glue lets go by the peel angle.",
    },
  ],
  async create(ctx) {
    return new FingerprintDust(ctx);
  },
};

type Tool = 'brush' | 'blow' | 'tape';
type Phase = 'dust' | 'taped' | 'lifted' | 'solved';

/** Grid columns across the screen: about 1.2 CSS px per powder cell on a phone. */
const COLS = 320;
/** Screen width in tape world units (Peel It's film is tuned for a ~1.9-unit-wide view). */
const WORLD_W = 2.4;
const LIFT = 0.24;
const GRAB_PX = 44;
const TOP = 132;
const DOCK = 212;

/** Powder colour and how much its flakes glint under the torch. */
const POWDERS: Record<PowderId, { col: [number, number, number]; sparkle: number }> = {
  black: { col: [0.06, 0.06, 0.07], sparkle: 0.05 },
  silver: { col: [0.8, 0.82, 0.86], sparkle: 1 },
  magnetic: { col: [0.2, 0.19, 0.18], sparkle: 0.6 },
};

const SUSPECTS: [string, string][] = [
  ['Vera Lark', 'the courier'],
  ['Otto Brandt', 'the locksmith'],
  ['Mina Sol', 'the diplomat'],
  ['Rex Hale', 'the chauffeur'],
  ['Ivy Crane', 'the cipher clerk'],
  ['Nico Vance', 'the attaché'],
  ['Hugo Marr', 'the bookkeeper'],
  ['Lena Stroud', 'the night porter'],
];
const PATTERNS: Pattern[] = ['loop-l', 'loop-r', 'whorl', 'arch', 'tented', 'double'];

interface Suspect {
  name: string;
  alias: string;
  pattern: Pattern;
  seed: number;
  el: HTMLButtonElement;
}

interface Grab {
  handle: Handle;
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

class FingerprintDust implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private r: PrintsRenderer;
  private powder!: Powder;
  private width = 1;
  private height = 1;
  private cell = 1;
  private S = 1;
  private box!: Box;
  private surface = document.createElement('canvas');
  private art = document.createElement('canvas');
  private caseIdx = 0;
  private def!: CaseDef;
  private caseNo = 0;
  private ridges!: Ridges;
  private printAt: [number, number, number] = [0, 0, 0];
  private ridgeIdx = new Int32Array(0);
  private valleyIdx = new Int32Array(0);
  private suspects: Suspect[] = [];
  private culprit = 0;
  private tool: Tool = 'brush';
  private phase: Phase = 'dust';
  private reveal = 0;
  private haze = 0;
  private revealAtLay = 0;
  private film: Film | null = null;
  private filmRect: [number, number, number, number] = [0, 0, 0, 0];
  private snap = new Uint8Array(0);
  private snapW = 0;
  private snapH = 0;
  private prevStuck = new Uint8Array(0);
  private layT = 1;
  private grabs = new Map<number, Grab>();
  private lastFling: [number, number] = [0, -1];
  private flyingCount = 0;
  private last = new Map<number, [number, number]>();
  /** Fingers that pulled tape: they don't turn into brushes when the tape comes free. */
  private consumed = new Set<number>();
  private light: [number, number, number] = [0, 0, 1];
  private blowAt: [number, number, number] = [0, 0, 0];
  private free: { id: number; x: number; y: number; dx: number; dy: number; justDown: boolean }[] = [];
  private seen = new Set<number>();
  private view!: View;
  private parts!: Parts;
  private brushVis: [number, number, number, number] = [0, 0, 1, 0];
  private brushAng = 0;
  private brushSpeed = 0;
  private blowing = 0;
  private wasBlowing = false;
  private lastWhoosh = 0;
  private lastBuzz = 0;
  private relRate = 0;
  private relTick = 0;
  private relBuzz = 0;
  private handSpeed = 0;
  private peelStarted = false;
  private time = 0;
  private simMs = 0;
  private frameNo = 0;
  private brushedOnce = false;
  private tries = 0;
  private powderPick: 'auto' | PowderId = 'auto';
  private hiss: Loop;
  private trickle: Loop;
  private breath: Loop;
  private crackle: Loop;
  private style: HTMLStyleElement;
  private hud: HTMLElement;
  private caseEl!: HTMLElement;
  private hintEl!: HTMLElement;
  private toolBtns = new Map<Tool, HTMLButtonElement>();
  private evidence!: HTMLCanvasElement;
  private lineup!: HTMLElement;
  private nextBtn!: HTMLButtonElement;
  private ping!: HTMLElement;

  readonly cfg = { brush: 24, blow: 70 };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: true, depth: true, stencil: true, preserveDrawingBuffer: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.r = new PrintsRenderer(gl);
    this.hiss = ctx.sound.loop('hiss');
    this.trickle = ctx.sound.loop('trickle');
    this.breath = ctx.sound.loop('rumble');
    this.crackle = ctx.sound.loop('crackle');
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hud = this.buildHud();
    this.buildPanel();
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.caseIdx = 0;
    this.load();
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__prints = {
        stats: () => ({
          case: this.def.id,
          phase: this.phase,
          tool: this.tool,
          reveal: this.reveal,
          haze: this.haze,
          revealAtLay: this.revealAtLay,
          grains: this.powder.count,
          blown: this.powder.blown,
          peeled: this.film ? this.film.released / Math.max(1, this.film.total) : this.phase === 'dust' ? 0 : 1,
          tears: this.film?.tears ?? 0,
          released: this.film?.released ?? 0,
          total: this.film?.total ?? 0,
          grabs: this.grabs.size,
          culprit: this.culprit,
          tries: this.tries,
          simMs: this.simMs,
        }),
        /** Print centre and half-size, CSS px. */
        print: () => {
          const pr = this.ctx.pixelRatio;
          const [x, y] = this.printAt;
          return { x: (x * this.cell) / pr, y: (y * this.cell) / pr, w: (this.ridges.w * this.cell) / pr / 2, h: (this.ridges.h * this.cell) / pr / 2 };
        },
        /** The tape's pull tab, CSS px. */
        tab: () => {
          const f = this.film;
          if (!f) return null;
          let x = 0, y = 0, n = 0;
          for (let i = 0; i < f.n; i++)
            if (f.isTab[i] && !f.fly[i]) {
              x += f.pos[i * 3];
              y += f.pos[i * 3 + 1];
              n++;
            }
          if (!n) return null;
          const [px, py] = this.toScreen(x / n, y / n, 0);
          return { x: px / this.ctx.pixelRatio, y: py / this.ctx.pixelRatio };
        },
        tool: (t: Tool) => this.pickTool(t),
        match: (i: number) => this.accuse(i),
        next: () => this.nextCase(),
      };
    }
  }

  // ---------------------------------------------------------------- cases

  private load() {
    const { width: W, height: H } = this;
    const pr = this.ctx.pixelRatio;
    this.def = CASES[this.caseIdx % CASES.length];
    this.cell = W / COLS;
    this.S = W / WORLD_W;
    const GW = COLS, GH = Math.ceil(H / this.cell);
    this.powder = new Powder(GW, GH);
    const cssW = W / pr, cssH = H / pr;
    const top = TOP, bottom = DOCK;
    const bh = Math.max(200, cssH - top - bottom);
    this.box = { cx: cssW / 2, cy: top + bh / 2, w: cssW, h: bh, k: Math.min(cssW / 390, bh / 470) };
    // Surface.
    const sc = this.surface;
    sc.width = W;
    sc.height = H;
    const g = sc.getContext('2d')!;
    g.setTransform(pr, 0, 0, pr, 0, 0);
    this.def.paint(g, this.box);
    this.r.uploadCanvas('surface', sc);
    // Suspects and the culprit's print.
    const r = rng(Date.now() & 0xffff);
    const pool = [...SUSPECTS].sort(() => r() - 0.5).slice(0, 3);
    const pats = [...PATTERNS].sort(() => r() - 0.5);
    this.culprit = Math.floor(r() * 3);
    const cp = pats[0];
    // Later cases put a decoy with the same pattern type in the lineup: compare the details.
    const hard = this.caseNo % CASES.length >= 1;
    const decoys: Pattern[] = hard ? [cp, pats[1]] : [pats[1], pats[2]];
    let di = 0;
    for (const s of this.suspects) s.el.remove();
    this.suspects = pool.map(([name, alias], i) => {
      const pattern = i === this.culprit ? cp : decoys[di++];
      const seed = Math.floor(r() * 1e6) + 1;
      const el = document.createElement('button');
      el.type = 'button';
      el.className = 'pr-card';
      return { name, alias, pattern, seed, el };
    });
    this.suspects.forEach((s, i) => this.paintCard(s, i));
    this.lineup.append(...this.suspects.map((s) => s.el));
    const c = this.suspects[this.culprit];
    this.ridges = makeRidges({ pattern: c.pattern, seed: c.seed });
    // Stamp the latent print and smudges into the adhesion mask.
    const [ox, oy, rot] = this.def.print;
    const k = this.box.k;
    const toCell = (x: number, y: number): [number, number] => [((this.box.cx + x * k) * pr) / this.cell, ((this.box.cy + y * k) * pr) / this.cell];
    const [pcx, pcy] = toCell(ox, oy);
    const prot = rot + (r() - 0.5) * 0.2;
    this.printAt = [pcx, pcy, prot];
    this.powder.stampPrint(this.ridges, pcx, pcy, prot, c.seed);
    this.def.smudges.forEach(([x, y, rx, ry], i) => {
      const [sx, sy] = toCell(x, y);
      this.powder.stampSmudge(sx, sy, (rx * k * pr) / this.cell, (ry * k * pr) / this.cell, i + c.seed);
    });
    // Cells that score the reveal: ridge crests, and the valleys between them.
    const ridge: number[] = [];
    const valley: number[] = [];
    const R = Math.hypot(this.ridges.w, this.ridges.h) / 2;
    const cs = Math.cos(prot), sn = Math.sin(prot);
    for (let y = Math.max(0, Math.floor(pcy - R)); y < Math.min(GH, pcy + R); y++)
      for (let x = Math.max(0, Math.floor(pcx - R)); x < Math.min(GW, pcx + R); x++) {
        const dx = x - pcx, dy = y - pcy;
        const lx = cs * dx + sn * dy, ly = -sn * dx + cs * dy;
        const e = Math.hypot(lx / (this.ridges.w * 0.42), ly / (this.ridges.h * 0.44));
        if (e > 1) continue;
        const m = this.powder.mask[y * GW + x];
        if (m > 0.6) ridge.push(y * GW + x);
        else if (m < 0.15) valley.push(y * GW + x);
      }
    this.ridgeIdx = Int32Array.from(ridge);
    this.valleyIdx = Int32Array.from(valley);
    this.r.setGrid(GW, GH, this.powder.tex);
    this.powder.markDirty(0, GH);
    // Reset state.
    this.phase = 'dust';
    this.film = null;
    this.grabs.clear();
    this.reveal = this.haze = this.revealAtLay = 0;
    this.tries = 0;
    this.peelStarted = false;
    this.brushedOnce = false;
    this.light = [pcx * this.cell, H - pcy * this.cell, 250 * pr];
    this.pickTool('brush');
    this.caseEl.innerHTML = `<b>CASE ${String(this.caseNo + 1).padStart(2, '0')}</b> ${this.def.title}`;
    this.setHint(`Brush the ${this.def.noun} to raise prints`);
    this.clearEvidence();
    this.nextBtn.hidden = true;
    this.lineup.classList.remove('ready');
    this.ping.hidden = false;
    this.ping.style.left = `${(pcx * this.cell) / pr}px`;
    this.ping.style.top = `${(pcy * this.cell) / pr}px`;
    this.ctx.progress(0, 'lifted');
  }

  private nextCase() {
    this.caseIdx = (this.caseIdx + 1) % CASES.length;
    this.caseNo++;
    this.load();
  }

  private powderId(): PowderId {
    return this.powderPick === 'auto' ? this.def.powder : this.powderPick;
  }

  // ---------------------------------------------------------------- HUD

  private buildHud() {
    const hud = document.createElement('div');
    hud.className = 'pr-hud';
    this.caseEl = document.createElement('div');
    this.caseEl.className = 'pr-case';
    this.hintEl = document.createElement('div');
    this.hintEl.className = 'pr-hint';
    this.ping = document.createElement('div');
    this.ping.className = 'pr-ping';
    const dock = document.createElement('div');
    dock.className = 'pr-dock';
    const tools = document.createElement('div');
    tools.className = 'pr-tools';
    const defs: [Tool, string, string][] = [
      ['brush', 'Brush', '<path d="M14 3l7 7-6 6-7-7z" fill="currentColor" opacity=".35"/><path d="M8 9l7 7-3 3c-2 2-6 3-9 2 1-3 1-6 2-7l3-5z" fill="currentColor"/>'],
      ['blow', 'Blow', '<path d="M3 8h11a3 3 0 1 0-3-3M3 12h15a3 3 0 1 1-3 3M3 16h7" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/>'],
      ['tape', 'Lift tape', '<rect x="4" y="3" width="16" height="18" rx="2" fill="currentColor" opacity=".3"/><path d="M4 16h16v3a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z" fill="currentColor"/>'],
    ];
    for (const [t, label, icon] of defs) {
      const b = document.createElement('button');
      b.type = 'button';
      b.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span>${label}</span>`;
      b.addEventListener('click', () => this.pickTool(t));
      this.toolBtns.set(t, b);
      tools.appendChild(b);
    }
    this.lineup = document.createElement('div');
    this.lineup.className = 'pr-lineup';
    const ev = document.createElement('div');
    ev.className = 'pr-evidence';
    this.evidence = document.createElement('canvas');
    const lab = document.createElement('span');
    lab.textContent = 'LIFT';
    ev.append(this.evidence, lab);
    this.lineup.appendChild(ev);
    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.className = 'pr-next';
    this.nextBtn.textContent = 'Next case ›';
    this.nextBtn.hidden = true;
    this.nextBtn.addEventListener('click', () => this.nextCase());
    dock.append(tools, this.lineup);
    hud.append(this.caseEl, this.ping, this.hintEl, this.nextBtn, dock);
    this.ctx.overlay.appendChild(hud);
    return hud;
  }

  private buildPanel() {
    const { panel } = this.ctx;
    panel.slider(this.cfg, 'brush', { label: 'Brush size', min: 12, max: 44, step: 1 });
    panel.choice<'auto' | PowderId>(
      'Powder',
      [
        { value: 'auto', label: 'Auto' },
        { value: 'black', label: 'Black' },
        { value: 'silver', label: 'Silver' },
        { value: 'magnetic', label: 'Magnetic' },
      ],
      'auto',
      (v) => (this.powderPick = v),
    );
    panel.action('Next case', () => this.nextCase());
    panel.action('Start this case over', () => this.load());
  }

  private pickTool(t: Tool) {
    if (t === 'tape') {
      if (this.phase !== 'dust') return;
      if (this.reveal < 0.25) {
        this.setHint(`Dust first: brush over the ${this.def.noun} until ridges show`);
        this.toolBtns.get('tape')!.classList.add('nope');
        setTimeout(() => this.toolBtns.get('tape')?.classList.remove('nope'), 400);
        return;
      }
      this.layTape();
      t = 'brush';
    }
    this.tool = t;
    for (const [k, b] of this.toolBtns) b.setAttribute('aria-pressed', String(k === t));
  }

  private setHint(s: string) {
    if (this.hintEl.textContent === s) return;
    this.hintEl.textContent = s;
    this.hintEl.classList.remove('pop');
    void this.hintEl.offsetWidth;
    this.hintEl.classList.add('pop');
  }

  private paintCard(s: Suspect, i: number) {
    const pr = Math.min(2, this.ctx.pixelRatio);
    const c = document.createElement('canvas');
    c.width = 64 * pr;
    c.height = 80 * pr;
    const g = c.getContext('2d')!;
    g.fillStyle = '#f1ead8';
    g.fillRect(0, 0, c.width, c.height);
    const rid = makeRidges({ pattern: s.pattern, seed: s.seed });
    const sc = Math.min(c.width / rid.w, c.height / rid.h) * 0.92;
    drawCard(g, rid, '#1b1f2e', (c.width - rid.w * sc) / 2, (c.height - rid.h * sc) / 2, sc);
    const letter = 'ABC'[i];
    s.el.innerHTML = `<b>${letter}</b><i>${s.name}</i><em>${s.alias}</em>`;
    s.el.prepend(c);
    s.el.onclick = () => this.accuse(i);
  }

  private clearEvidence() {
    const pr = Math.min(2, this.ctx.pixelRatio);
    const c = this.evidence;
    c.width = 64 * pr;
    c.height = 80 * pr;
    const g = c.getContext('2d')!;
    g.clearRect(0, 0, c.width, c.height);
    c.parentElement?.classList.remove('got');
  }

  /** Mount the lifted tape on a backing card: contrasting colour, turned upright like an examiner would. */
  private paintEvidence() {
    const c = this.evidence;
    const g = c.getContext('2d')!;
    const pid = this.powderId();
    const dark = pid === 'silver';
    g.fillStyle = dark ? '#15171c' : '#f4f1e8';
    g.fillRect(0, 0, c.width, c.height);
    const t = document.createElement('canvas');
    t.width = this.snapW;
    t.height = this.snapH;
    const tg = t.getContext('2d')!;
    const img = tg.createImageData(this.snapW, this.snapH);
    const col = POWDERS[pid].col.map((v) => Math.round(v * 255));
    if (!dark && pid === 'magnetic') col.fill(40);
    for (let i = 0; i < this.snapW * this.snapH; i++) {
      const a = Math.min(1, (this.snap[i * 4 + 1] / 255) * 2.4 + (this.snap[i * 4] / 255) * 0.6);
      img.data[i * 4] = col[0];
      img.data[i * 4 + 1] = col[1];
      img.data[i * 4 + 2] = col[2];
      img.data[i * 4 + 3] = a * 255;
    }
    tg.putImageData(img, 0, 0);
    const [pcx, pcy, rot] = this.printAt;
    const sc = (Math.min(c.width / this.ridges.w, c.height / this.ridges.h) * 0.92);
    g.save();
    g.translate(c.width / 2, c.height / 2);
    g.rotate(-rot);
    g.scale(sc, sc);
    g.drawImage(t, this.filmRect[0] - pcx, this.filmRect[1] - pcy);
    g.restore();
    c.parentElement?.classList.add('got');
  }

  // ---------------------------------------------------------------- tape

  private layTape() {
    const { cell, S, width: W, height: H } = this;
    const [pcx, pcy, rot] = this.printAt;
    const c = Math.abs(Math.cos(rot)), s = Math.abs(Math.sin(rot));
    const hw = (c * this.ridges.w + s * this.ridges.h) / 2 * 0.9 + 8;
    const hh = (s * this.ridges.w + c * this.ridges.h) / 2 * 0.9 + 8;
    // Grid rect (cells, y down), with extra length at the bottom for the pull tab.
    const gx0 = Math.round(pcx - hw), gx1 = Math.round(pcx + hw);
    const gy0 = Math.round(pcy - hh), gy1 = Math.round(pcy + hh + 16);
    this.filmRect = [gx0, gy0, gx1 - gx0, gy1 - gy0];
    const x0 = (gx0 * cell - W / 2) / S, x1 = (gx1 * cell - W / 2) / S;
    const yTop = (H / 2 - gy0 * cell) / S, yBot = (H / 2 - gy1 * cell) / S;
    const f = new Film({ x0, y0: yBot, w: x1 - x0, h: yTop - yBot, spacing: 0.05, tab: [0.5, 0], tabR: 0.15 });
    f.cfg.stick = 0.028;
    f.cfg.tough = 0.5;
    this.film = f;
    this.prevStuck = Uint8Array.from(f.stuck);
    this.r.setFilm(f);
    // The tape takes a snapshot of the powder under it; that's what it will carry away.
    const tw = gx1 - gx0, th = gy1 - gy0;
    const p = this.powder;
    p.pack();
    this.snap = new Uint8Array(tw * th * 4);
    this.snapW = tw;
    this.snapH = th;
    const tabY = th - ((0.15 * S) / cell) * 0.9;
    for (let y = 0; y < th; y++)
      for (let x = 0; x < tw; x++) {
        const gx = gx0 + x, gy = gy0 + y;
        if (gx < 0 || gy < 0 || gx >= p.W || gy >= p.H) continue;
        const o = (y * tw + x) * 4, k = (gy * p.W + gx) * 4;
        this.snap[o] = p.tex[k];
        this.snap[o + 1] = p.tex[k + 1];
        this.snap[o + 3] = 255;
        // The folded tab is dry: it doesn't pick anything up.
        if (y > tabY && Math.hypot(x - tw / 2, y - th) < (0.15 * S) / cell) this.snap[o] = this.snap[o + 1] = 0;
      }
    this.r.setTape(tw, th, this.snap);
    this.r.rect = [gx0, gy0, tw, th];
    p.cover = [gx0, gy0, gx1, gy1];
    this.paintArt(tw, th);
    this.layT = 0;
    this.revealAtLay = this.reveal;
    this.phase = 'taped';
    this.peelStarted = false;
    this.ctx.haptic('medium');
    this.ctx.sound.play('squish', { pitch: 0.6, gain: 0.35 });
    this.ctx.sound.play('whoosh', { pitch: 1.6, gain: 0.2 });
    this.setHint('Peel the tape up from its tab');
  }

  /** Tape print: a frosted pull tab with a label, and a faint matte edge. */
  private paintArt(tw: number, th: number) {
    const a = this.art;
    a.width = 256;
    a.height = Math.round((256 * th) / tw);
    const g = a.getContext('2d')!;
    g.clearRect(0, 0, a.width, a.height);
    const R = ((0.15 * this.S) / this.cell / tw) * a.width;
    g.fillStyle = 'rgba(236,232,220,0.92)';
    g.beginPath();
    g.arc(a.width / 2, a.height, R, Math.PI, 0);
    g.fill();
    g.fillStyle = '#b3261e';
    g.font = `800 ${Math.round(R * 0.28)}px ui-monospace, Menlo, monospace`;
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('LIFT', a.width / 2, a.height - R * 0.45);
    g.fillStyle = 'rgba(40,40,40,0.5)';
    g.fillRect(a.width / 2 - R * 0.5, a.height - R * 0.2, R, 2);
    this.r.uploadCanvas('art', a);
  }

  private stepTape(dt: number) {
    const f = this.film;
    if (!f) return;
    this.layT = Math.min(1, this.layT + dt * 2.6);
    this.r.lay = this.layT;
    f.step(dt);
    if (f.tornThisFrame) this.onTear();
    // Where the glue let go, the powder under it leaves with the tape.
    const p = this.powder;
    const half = (f.spacing * this.S) / this.cell / 2 + 0.6;
    let n = 0;
    for (let i = 0; i < f.n; i++) {
      if (!this.prevStuck[i] || f.stuck[i]) continue;
      this.prevStuck[i] = 0;
      const [gx, gy] = this.worldToCell(f.rest[i * 2], f.rest[i * 2 + 1]);
      p.cover = null;
      p.clear(gx - half, gy - half, gx + half, gy + half);
      n++;
    }
    if (n) p.cover = [this.filmRect[0], this.filmRect[1], this.filmRect[0] + this.filmRect[2], this.filmRect[1] + this.filmRect[3]];
    if (n && !this.peelStarted) {
      this.peelStarted = true;
      this.ctx.sound.play('rip', { pitch: 1.5, gain: 0.3 });
    }
    this.feel(dt);
    if (this.phase === 'taped' && f.released >= f.total) this.onLifted();
    let gone = 0, alive = 0;
    for (let i = 0; i < f.n; i++) f.fly[i] === 2 ? gone++ : alive++;
    this.flyingCount = gone;
    if (this.phase !== 'taped' && !alive) this.film = null;
  }

  private onLifted() {
    const f = this.film!;
    this.phase = 'lifted';
    this.powder.cover = null;
    this.ctx.sound.play('rip', { pitch: 1.1, gain: 0.7 });
    this.ctx.sound.play('whoosh', { pitch: 0.9, gain: 0.5 });
    this.ctx.haptic('medium');
    for (const gr of this.grabs.values()) this.lastFling = [gr.vx, gr.vy];
    this.grabs.clear();
    f.handles = [];
    f.updateComponents();
    // Off it goes, down toward the evidence slot.
    for (let c = 0; c < f.compCount; c++) f.fling(c, this.lastFling[0] * 0.3, -2.6);
    window.setTimeout(() => {
      this.paintEvidence();
      this.lineup.classList.add('ready');
      this.ctx.sound.play('tick', { pitch: 1.2, gain: 0.6 });
    }, 380);
    this.setHint('Whose print is it? Tap the matching card');
  }

  private onTear() {
    const f = this.film!;
    this.ctx.haptic('medium');
    this.ctx.sound.play('rip', { gain: Math.min(1, 0.4 + f.tornThisFrame * 0.06), pitch: 1.2 });
    f.updateComponents();
    this.flingLoose();
    this.setHint('Torn! Pick up the stuck scrap');
  }

  private flingLoose() {
    const f = this.film!;
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
    }
  }

  /** Crackle while the glue lets go, ticks per cluster, a buzz you can feel. */
  private feel(dt: number) {
    const f = this.film!;
    const n = f.releasedThisFrame;
    if (dt > 0) this.relRate += (n / dt - this.relRate) * Math.min(1, dt * 10);
    this.crackle.set(Math.min(1, this.relRate / 200) * 0.9, Math.min(1, 0.3 + this.handSpeed / 2));
    this.relTick += n;
    this.relBuzz += n;
    if (this.relTick >= 8) {
      this.relTick = 0;
      this.ctx.sound.play('tick', { pitch: 2 + Math.min(1, this.handSpeed / 2), gain: 0.25 });
    }
    if (this.relBuzz >= 6) {
      this.relBuzz = 0;
      this.ctx.haptic('light');
    }
  }

  // ---------------------------------------------------------------- matching

  private accuse(i: number) {
    const s = this.suspects[i];
    if (!s) return;
    if (this.phase === 'solved') return;
    if (this.phase !== 'lifted') {
      this.setHint(this.phase === 'taped' ? 'Peel the tape first' : 'Lift a print before you accuse anyone');
      this.ctx.sound.play('tick', { pitch: 0.8, gain: 0.3 });
      return;
    }
    this.tries++;
    if (i === this.culprit) {
      this.phase = 'solved';
      s.el.classList.add('match');
      const letter = 'ABC'[i];
      this.ctx.celebrate(`Match: Suspect ${letter}`);
      window.setTimeout(() => this.ctx.sound.play('chime', { pitch: 1.5, gain: 0.6 }), 140);
      this.setHint(`${s.name}, ${s.alias}. Case closed.`);
      this.nextBtn.hidden = false;
      this.lineup.classList.remove('ready');
    } else {
      s.el.classList.remove('miss');
      void s.el.offsetWidth;
      s.el.classList.add('miss');
      this.ctx.haptic('medium');
      this.ctx.sound.play('knock', { pitch: 0.7, gain: 0.6 });
      this.ctx.sound.play('thud', { pitch: 0.8, gain: 0.4 });
      this.setHint('No match. Compare the core and the ridge flow');
    }
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.frameNo++;
    const p = this.powder;
    p.captured = 0;
    p.blown = 0;
    const t0 = performance.now();
    this.handleInput(dt);
    p.step(dt);
    if (this.phase === 'dust' && this.frameNo % 4 === 0) {
      p.reveal(this.ridgeIdx, this.valleyIdx);
      this.reveal = p.revealed;
      this.haze = p.haze;
    }
    this.stepTape(dt);
    this.simMs += (performance.now() - t0 - this.simMs) * 0.1;
    this.juice(dt);
    this.hints();
    const rows = p.pack();
    if (rows) this.r.uploadRows(p.tex, rows[0], rows[1]);
    this.draw();
    const lifted = this.phase === 'lifted' || this.phase === 'solved';
    const peel = lifted ? 1 : this.film ? this.film.released / Math.max(1, this.film.total) : 0;
    const rev = this.phase === 'dust' ? this.reveal : this.revealAtLay;
    this.ctx.progress(lifted ? 1 : Math.min(0.99, 0.7 * Math.min(1, rev / 0.85) + 0.3 * peel), 'lifted');
    this.ctx.setStatus(`${Math.round(rev * 100)}% ridges · haze ${Math.round(this.haze * 100)}% · ${p.count} grains · sim ${this.simMs.toFixed(1)}ms`);
  }

  private handleInput(dt: number) {
    const f = this.film;
    const pr = this.ctx.pixelRatio;
    const { cell, width: W, height: H } = this;
    let speed = 0;
    // Fingers on the tape pull it; the rest dust or blow.
    const free = this.free;
    let nFree = 0;
    for (const pt of this.ctx.pointers.active.values()) {
      let gr = this.grabs.get(pt.id);
      if (!gr && f && this.phase === 'taped' && pt.justDown && this.layT >= 1) {
        const idx = this.pick(pt.x, pt.y, (GRAB_PX * pr) / this.S);
        if (idx >= 0) {
          const [wx, wy] = this.toWorld(pt.x, pt.y, 0);
          gr = this.makeGrab(idx, wx, wy);
          this.grabs.set(pt.id, gr);
          this.consumed.add(pt.id);
          f.handles.push(gr.handle);
          f.updateComponents();
          this.ctx.haptic('light');
          this.ctx.sound.play('tick', { pitch: 1.6, gain: 0.5 });
        }
      }
      if (gr && f) {
        const [wx, wy] = this.toWorld(pt.x, pt.y, 0);
        const reach = 1.35;
        const tx = gr.ax + (wx - gr.fx0) * reach;
        const ty = gr.ay + (wy - gr.fy0) * reach;
        gr.z += (LIFT - gr.z) * Math.min(1, dt * 9);
        gr.handle.target[0] = tx;
        gr.handle.target[1] = ty;
        gr.handle.target[2] = gr.z;
        if (dt > 0) {
          gr.vx += ((tx - gr.lastX) / dt - gr.vx) * Math.min(1, dt * 14);
          gr.vy += ((ty - gr.lastY) / dt - gr.vy) * Math.min(1, dt * 14);
          speed = Math.max(speed, Math.hypot(gr.vx, gr.vy) / reach);
        }
        gr.lastX = tx;
        gr.lastY = ty;
        continue;
      }
      if (this.consumed.has(pt.id)) continue;
      const q = free[nFree] ?? (free[nFree] = { id: 0, x: 0, y: 0, dx: 0, dy: 0, justDown: false });
      nFree++;
      q.id = pt.id;
      q.x = pt.x * W;
      q.y = (1 - pt.y) * H;
      q.dx = pt.dx * W;
      q.dy = -pt.dy * H;
      q.justDown = pt.justDown;
    }
    if (f) {
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

    const p = this.powder;
    let brushing = false;
    let blowing = false;
    const seen = this.seen;
    seen.clear();
    if (nFree >= 2 || (nFree && this.tool === 'blow')) {
      // Two fingers (or the Blow tool): a puff of air from between them; swiping blows harder.
      let x = 0, y = 0, sp = 0;
      for (let i = 0; i < nFree; i++) {
        const q = free[i];
        x += q.x;
        y += q.y;
        sp = Math.max(sp, Math.hypot(q.dx, q.dy));
        seen.add(q.id);
      }
      x /= nFree;
      y /= nFree;
      const power = 0.8 + Math.min(1.2, (sp / pr) * 0.05);
      blowing = true;
      this.blowAt[0] = x;
      this.blowAt[1] = y;
      this.blowAt[2] = power;
      p.blow(x / cell, y / cell, (this.cfg.blow * pr) / cell, dt, power);
    } else
      for (let i = 0; i < nFree; i++) {
        const q = free[i];
        seen.add(q.id);
        const r = (this.cfg.brush * pr) / cell;
        const gx = q.x / cell, gy = q.y / cell;
        let prev = this.last.get(q.id);
        if (!prev) this.last.set(q.id, (prev = [gx, gy]));
        const mx = gx - prev[0], my = gy - prev[1];
        const d = Math.hypot(mx, my);
        const steps = Math.max(1, Math.min(8, Math.ceil(d / (r * 0.4))));
        for (let k = 1; k <= steps; k++) p.brush(prev[0] + (mx * k) / steps, prev[1] + (my * k) / steps, r, mx / steps, my / steps, dt / steps, q.justDown ? 0.6 : 1);
        prev[0] = gx;
        prev[1] = gy;
        brushing = true;
        this.brushSpeed += (d / Math.max(dt, 1e-3) / 120 - this.brushSpeed) * Math.min(1, dt * 12);
        this.brushVis[0] = q.x;
        this.brushVis[1] = H - q.y;
        this.brushVis[3] = Math.min(1, this.brushVis[3] + dt * 8);
        this.brushAng += (d * 0.05 + dt * 0.6) * (mx >= 0 ? 1 : -1);
        this.light[0] += (q.x - this.light[0]) * Math.min(1, dt * 4);
        this.light[1] += (H - q.y - this.light[1]) * Math.min(1, dt * 4);
        if (!this.brushedOnce) {
          this.brushedOnce = true;
          this.ping.hidden = true;
        }
      }
    for (const id of this.last.keys()) if (!seen.has(id)) this.last.delete(id);
    for (const id of this.consumed) if (!this.ctx.pointers.active.has(id)) this.consumed.delete(id);
    if (!brushing) {
      this.brushVis[3] = Math.max(0, this.brushVis[3] - dt * 6);
      this.brushSpeed *= Math.max(0, 1 - dt * 8);
    }
    const b = this.blowAt;
    if (blowing) {
      this.light[0] += (b[0] - this.light[0]) * Math.min(1, dt * 3);
      this.light[1] += (H - b[1] - this.light[1]) * Math.min(1, dt * 3);
      this.blowing += (b[2] - this.blowing) * Math.min(1, dt * 10);
      if (!this.wasBlowing || (b[2] > 1.4 && this.time - this.lastWhoosh > 0.45)) {
        this.lastWhoosh = this.time;
        this.ctx.sound.play('whoosh', { pitch: 0.8 + Math.random() * 0.3, gain: 0.35 + 0.25 * Math.min(1, b[2] - 0.8) });
        this.ctx.haptic('light');
      }
    } else this.blowing *= Math.max(0, 1 - dt * 6);
    this.wasBlowing = blowing;
    this.brushVis[2] = (this.cfg.brush * pr) * 1.05;
  }

  /** Grain ticks, brush swish, breath; haptics tied to the brush touching powder. */
  private juice(dt: number) {
    const p = this.powder;
    const s = this.ctx.sound;
    this.hiss.set(Math.min(1, this.brushSpeed * 0.6) * (this.brushVis[3] > 0.5 ? 1 : 0), 0.3 + Math.min(0.5, this.brushSpeed * 0.2));
    this.trickle.set(Math.min(0.5, p.landed / 60), 0.8);
    this.breath.set(Math.min(1, this.blowing * 0.7), 0.3 + Math.min(0.6, this.blowing * 0.3));
    if (p.landed && Math.random() < Math.min(0.8, p.landed * 0.05)) s.play('tick', { pitch: 2.6 + Math.random() * 1.4, gain: 0.05 + Math.random() * 0.07, pan: (Math.random() - 0.5) * 0.6 });
    if (p.captured > 25 && Math.random() < 0.3) s.play('tick', { pitch: 1.8 + Math.random() * 0.5, gain: 0.1 });
    const touching = this.brushVis[3] > 0.5 && this.brushSpeed > 0.08;
    if (touching && this.time - this.lastBuzz > (p.captured > 25 ? 0.07 : 0.12)) {
      this.lastBuzz = this.time;
      this.ctx.haptic('light');
    }
    // The torch drifts slowly over the scene when nobody's working.
    if (this.brushVis[3] <= 0 && this.blowing < 0.05) {
      const pr = this.ctx.pixelRatio;
      const [x, y] = this.printAt;
      const tx = x * this.cell + Math.sin(this.time * 0.4) * 50 * pr, ty = this.height - y * this.cell + Math.cos(this.time * 0.31) * 40 * pr;
      this.light[0] += (tx - this.light[0]) * Math.min(1, dt * 0.8);
      this.light[1] += (ty - this.light[1]) * Math.min(1, dt * 0.8);
    }
    this.light[2] = 250 * this.ctx.pixelRatio;
  }

  private hints() {
    const tape = this.toolBtns.get('tape')!;
    tape.classList.toggle('ready', this.phase === 'dust' && this.reveal >= 0.5);
    tape.disabled = this.phase !== 'dust';
    if (this.phase !== 'dust') return;
    if (this.reveal >= 0.5 && this.haze > 0.16) this.setHint('Blow off the loose powder: two fingers, or Blow');
    else if (this.reveal >= 0.5) this.setHint('Crisp! Lift it with tape');
    else if (this.reveal >= 0.12) this.setHint('Keep brushing: the ridges are coming up');
  }

  private draw() {
    const pw = POWDERS[this.powderId()];
    const p = this.powder;
    const pr = this.ctx.pixelRatio;
    const v = (this.view ??= {
      w: 1,
      h: 1,
      cell: 1,
      scale: [1, 1],
      light: this.light,
      powder: pw.col,
      sparkle: 0,
      sheen: 0,
      brush: [0, 0, 1, 0],
      brushAng: 0,
      blow: [0, 0, 1, 0],
      time: 0,
    });
    v.w = this.width;
    v.h = this.height;
    v.cell = this.cell;
    v.scale[0] = (2 * this.S) / this.width;
    v.scale[1] = (2 * this.S) / this.height;
    v.light = this.light;
    v.powder = pw.col;
    v.sparkle = pw.sparkle;
    v.sheen = this.def.id === 'glass' ? 1 : this.def.id === 'mug' ? 0.5 : 0.8;
    const bv = this.brushVis[3] > 0 && this.tool === 'brush';
    v.brush[0] = this.brushVis[0];
    v.brush[1] = this.brushVis[1];
    v.brush[2] = this.brushVis[2];
    v.brush[3] = bv ? this.brushVis[3] : 0;
    v.brushAng = this.brushAng;
    v.blow[0] = this.blowAt[0];
    v.blow[1] = this.height - this.blowAt[1];
    v.blow[2] = this.cfg.blow * pr * 1.3;
    v.blow[3] = Math.min(1, this.blowing);
    v.time = this.time;
    const parts = (this.parts ??= { x: p.px, y: p.py, z: p.pz, life: p.life, n: 0 });
    parts.x = p.px;
    parts.y = p.py;
    parts.z = p.pz;
    parts.life = p.life;
    parts.n = p.count;
    this.r.draw(v, parts, this.film, this.flyingCount);
  }

  // ---------------------------------------------------------------- tape grabbing (from Peel It)

  private pick(u: number, v: number, radius: number) {
    const f = this.film!;
    const [sx, sy] = [(2 * this.S) / this.width, (2 * this.S) / this.height];
    const fu = u * 2 - 1, fv = v * 2 - 1;
    let best = -1;
    let bestD = radius * radius;
    for (let i = 0; i < f.n; i++) {
      if (f.fly[i]) continue;
      const loose = !f.stuck[i] && (f.sticky[i] || f.isTab[i]);
      if (!loose && !(f.everTorn && f.boundary[i])) continue;
      const k = CAM_D / (CAM_D - f.pos[i * 3 + 2]);
      const dx = (f.pos[i * 3] * sx * k - fu) / sx;
      const dy = (f.pos[i * 3 + 1] * sy * k - fv) / sy;
      const d = (dx * dx + dy * dy) * (loose ? 0.6 : 1);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  private makeGrab(idx: number, wx: number, wy: number): Grab {
    const f = this.film!;
    const R = 3 * f.spacing;
    const cx = f.pos[idx * 3], cy = f.pos[idx * 3 + 1], cz = f.pos[idx * 3 + 2];
    const verts: number[] = [];
    const offsets: number[] = [];
    const weights: number[] = [];
    const rx = f.rest[idx * 2], ry = f.rest[idx * 2 + 1];
    for (let i = 0; i < f.n; i++) {
      if (f.fly[i] || f.comp[i] !== f.comp[idx]) continue;
      const d = Math.hypot(f.rest[i * 2] - rx, f.rest[i * 2 + 1] - ry);
      const dx = f.pos[i * 3] - cx, dy = f.pos[i * 3 + 1] - cy, dz = f.pos[i * 3 + 2] - cz;
      if (d > R || Math.hypot(dx, dy, dz) > R * 1.5) continue;
      verts.push(i);
      offsets.push(dx, dy, dz);
      weights.push(0.05 + 0.3 * (1 - (d / R) ** 2));
      f.release(i);
    }
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

  // ---------------------------------------------------------------- coordinates

  private toWorld(u: number, v: number, z: number): [number, number] {
    const k = CAM_D / (CAM_D - z);
    return [((u * 2 - 1) / k) * (this.width / (2 * this.S)), ((v * 2 - 1) / k) * (this.height / (2 * this.S))];
  }

  private toScreen(x: number, y: number, z: number): [number, number] {
    const k = CAM_D / (CAM_D - z);
    return [this.width / 2 + x * this.S * k, this.height / 2 - y * this.S * k];
  }

  private worldToCell(x: number, y: number): [number, number] {
    return [(this.width / 2 + x * this.S) / this.cell, (this.height / 2 - y * this.S) / this.cell];
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.load();
  }

  destroy() {
    this.hiss.stop();
    this.trickle.stop();
    this.breath.stop();
    this.crackle.stop();
    this.hud.remove();
    this.style.remove();
    this.r.destroy();
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__prints;
  }
}

const STYLE = `
.pr-hud { position: absolute; inset: 0; pointer-events: none; font-family: ui-rounded, -apple-system, system-ui, sans-serif; color: #e8ecf2; }
.pr-case { position: absolute; left: 14px; top: calc(${TOP - 16}px + env(safe-area-inset-top, 0px)); font: 600 12px/1 ui-monospace, Menlo, monospace; letter-spacing: 0.06em; text-transform: uppercase; color: rgba(232,236,242,0.78); text-shadow: 0 1px 2px #000; }
.pr-case b { display: inline-block; margin-right: 6px; padding: 3px 6px; border-radius: 4px; background: #b3261e; color: #fff; font-weight: 800; }
.pr-hint { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(${DOCK + 10}px + env(safe-area-inset-bottom, 0px)); max-width: calc(100vw - 28px); padding: 8px 14px; border-radius: 12px; background: rgba(8,10,16,0.72); -webkit-backdrop-filter: blur(8px); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.1); font-size: 13px; font-weight: 700; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-hint.pop { animation: pr-pop .35s cubic-bezier(.2,1.5,.4,1); }
.pr-ping { position: absolute; width: 150px; height: 150px; margin: -75px 0 0 -75px; border-radius: 50%; border: 2px dashed rgba(255,255,255,0.28); animation: pr-ping 1.8s ease-in-out infinite; }
.pr-ping[hidden] { display: none; }
.pr-dock { position: absolute; left: 0; right: 0; bottom: 0; padding: 8px 10px calc(10px + env(safe-area-inset-bottom, 0px)); background: linear-gradient(180deg, rgba(6,8,12,0), rgba(6,8,12,0.88) 22%); pointer-events: auto; }
.pr-tools { display: flex; gap: 6px; justify-content: center; margin: 4px 0 8px; }
.pr-tools button { display: flex; align-items: center; gap: 6px; height: 40px; padding: 0 14px; border-radius: 99px; border: 1px solid rgba(255,255,255,0.14); background: rgba(24,28,38,0.85); color: #d6dbe4; font: 700 14px/1 inherit; cursor: pointer; }
.pr-tools svg { width: 18px; height: 18px; }
.pr-tools button:disabled { opacity: .4; }
.pr-tools button[aria-pressed="true"] { background: #e8ecf2; color: #10131a; border-color: #e8ecf2; }
.pr-tools button.ready { box-shadow: 0 0 0 2px #f2c14e, 0 0 18px rgba(242,193,78,0.55); animation: pr-glow 1.2s ease-in-out infinite; }
.pr-tools button.nope { animation: pr-shake .35s; }
.pr-lineup { display: flex; gap: 6px; justify-content: center; }
.pr-evidence, .pr-card { position: relative; width: 78px; flex: 0 0 78px; padding: 5px 5px 6px; border-radius: 8px; box-sizing: border-box; }
.pr-evidence { border: 1.5px dashed rgba(255,255,255,0.25); display: grid; place-items: center; }
.pr-evidence span { position: absolute; left: 0; right: 0; bottom: 5px; text-align: center; font: 800 10px/1 ui-monospace, Menlo, monospace; letter-spacing: .12em; color: rgba(255,255,255,0.45); }
.pr-evidence.got { border: 1.5px solid #f2c14e; background: rgba(242,193,78,0.12); animation: pr-pop .45s cubic-bezier(.2,1.6,.4,1); }
.pr-evidence.got span { color: #f2c14e; }
.stage .pr-evidence canvas, .stage .pr-card canvas { position: static; inset: auto; display: block; width: 64px; height: 80px; border-radius: 3px; }
.pr-evidence canvas { margin-bottom: 14px; }
.pr-card { border: 0; background: #e9e1cc; color: #1b1f2e; text-align: left; cursor: pointer; font: inherit; box-shadow: 0 4px 12px rgba(0,0,0,0.4); transform: rotate(var(--tilt, 0deg)); transition: transform .2s; }
.pr-card:nth-of-type(1) { --tilt: -1.5deg; } .pr-card:nth-of-type(3) { --tilt: 1.2deg; }
.pr-card b { position: absolute; top: 3px; right: 4px; padding: 1px 4px; border-radius: 3px; background: #1b1f2e; color: #e9e1cc; font: 800 10px/1.2 ui-monospace, Menlo, monospace; }
.pr-card i { display: block; margin-top: 4px; font: 800 10.5px/1.1 inherit; font-style: normal; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-card em { display: block; font: 600 9px/1.1 inherit; font-style: italic; opacity: .65; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.pr-lineup.ready .pr-card { animation: pr-bob 1.4s ease-in-out infinite; }
.pr-lineup.ready .pr-card:nth-of-type(2) { animation-delay: .15s; } .pr-lineup.ready .pr-card:nth-of-type(3) { animation-delay: .3s; }
.pr-card.miss { animation: pr-shake .4s !important; opacity: .55; }
.pr-card.match { box-shadow: 0 0 0 3px #7ee787, 0 0 26px rgba(126,231,135,0.6); }
.pr-card.match::after { content: 'MATCH'; position: absolute; left: 50%; top: 38%; transform: translate(-50%, -50%) rotate(-14deg); padding: 3px 6px; border: 2.5px solid #c62828; border-radius: 4px; color: #c62828; font: 900 14px/1 ui-monospace, Menlo, monospace; letter-spacing: .08em; background: rgba(233,225,204,0.7); animation: pr-stamp .35s cubic-bezier(.2,1.6,.4,1); }
.pr-next { position: absolute; left: 50%; transform: translateX(-50%); bottom: calc(${DOCK + 56}px + env(safe-area-inset-bottom, 0px)); pointer-events: auto; padding: 12px 22px; border: 0; border-radius: 99px; background: #f2c14e; color: #1a1408; font: 800 16px/1 inherit; box-shadow: 0 8px 24px rgba(0,0,0,0.4); cursor: pointer; animation: pr-rise .4s cubic-bezier(.2,1.4,.4,1); }
.pr-next[hidden] { display: none; }
@keyframes pr-pop { 0% { transform: translateX(-50%) scale(.92); } 100% { transform: translateX(-50%) scale(1); } }
.pr-evidence.got { animation-name: pr-pop2; }
@keyframes pr-pop2 { 0% { transform: scale(1.25); } 100% { transform: scale(1); } }
@keyframes pr-ping { 0%, 100% { transform: scale(.9); opacity: .35; } 50% { transform: scale(1.05); opacity: .8; } }
@keyframes pr-glow { 50% { box-shadow: 0 0 0 2px #f2c14e, 0 0 28px rgba(242,193,78,0.85); } }
@keyframes pr-shake { 0%, 100% { transform: translateX(0) rotate(var(--tilt, 0deg)); } 25% { transform: translateX(-6px) rotate(var(--tilt, 0deg)); } 75% { transform: translateX(6px) rotate(var(--tilt, 0deg)); } }
@keyframes pr-bob { 50% { transform: translateY(-4px) rotate(var(--tilt, 0deg)); } }
@keyframes pr-stamp { from { transform: translate(-50%, -50%) rotate(-14deg) scale(2.2); opacity: 0; } to { opacity: 1; } }
@keyframes pr-rise { from { transform: translateX(-50%) scale(.5); opacity: 0; } to { transform: translateX(-50%); opacity: 1; } }
`;
