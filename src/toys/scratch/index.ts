import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import type { Loop, Slip } from '../../shell/sound';
import { Coat, type CoatParams, type ToolShape } from './coat';
import { Crumbs, type CrumbParams } from './crumbs';
import { CARD_ASPECT, COAT_BOX, inCoat, makeCard, paintCard, paintCoatPrint, type Card } from './card';
import { COAT_IDS, COATS, type CoatDef, type CoatId } from './coats';
import { ScratchRenderer, type CardPose, type ToolView } from './render';

export const scratchToy: Toy = {
  id: 'scratch',
  title: 'Scratch Off',
  blurb: 'Scratch the silver off a night-market ticket. The coat cracks off in flakes and the crumbs pile up ahead of your coin until you blow them away. A fingernail scuffs, a coin pops, a key gouges.',
  tech: 'Voronoi flake coat with per-flake adhesion and brittle crack spread, ploughed crumbs, lit height-field foil · WebGL2',
  swatch: 'linear-gradient(135deg,#d8243a 0 30%,#c9ccd3 30% 70%,#f6c445 70%)',
  refs: [
    {
      short: 'US8627536',
      title: 'Scratch-off coating patent US8627536B1: a removable coat with no linking material through its structure',
      url: 'https://patents.google.com/patent/US8627536B1/en',
      use: 'Why the coat comes away as separate flakes and crumbs, never as a sheet.',
    },
    {
      short: 'Worley 1996',
      title: 'Worley — A Cellular Texture Basis Function (SIGGRAPH 1996)',
      url: 'https://doi.org/10.1145/237170.237267',
      use: 'Jittered-lattice Voronoi cells, here noise-warped and size-weighted, as the coat\'s flakes.',
    },
    {
      short: 'Scraping synthesis',
      title: 'Physically-based scraping and rolling sound synthesis as an impact stream (arXiv 2112.08984)',
      url: 'https://arxiv.org/abs/2112.08984',
      use: 'Each popped flake is one short impact on the resonator pool; the scrape bed is a stick-slip voice tuned per tool.',
    },
  ],
  async create(ctx) {
    return new ScratchOff(ctx);
  },
};

type ToolId = 'nail' | 'coin' | 'key' | 'scraper';

interface ToolDef {
  label: string;
  /** Contact half-width in CSS px. */
  r: number;
  flat: number;
  hardness: number;
  abrasion: number;
  /** Scrape resonance (Hz), haptic sharpness, grit pulse rate per unit speed. */
  freq: number;
  sharp: number;
  rough: number;
}

/** Which tool drawing the renderer uses (the nail is your own finger). */
const TOOL_VIEW: Record<ToolId, number> = { nail: 0, coin: 1, key: 2, scraper: 3 };

const TOOLS: Record<ToolId, ToolDef> = {
  nail: { label: 'Nail', r: 6, flat: 0.1, hardness: 0.35, abrasion: 0.45, freq: 900, sharp: 0.3, rough: 0.6 },
  coin: { label: 'Coin', r: 11, flat: 0.85, hardness: 1, abrasion: 0.35, freq: 2600, sharp: 0.8, rough: 1 },
  key: { label: 'Key', r: 2.5, flat: 0.45, hardness: 1.5, abrasion: 0.5, freq: 3800, sharp: 0.95, rough: 1.3 },
  scraper: { label: 'Scraper', r: 22, flat: 1, hardness: 0.85, abrasion: 0.3, freq: 1500, sharp: 0.6, rough: 0.8 },
};

/** Room left for the HUD above the card and the dock below it (CSS px). */
const TOP = 150;
const DOCK = 92;

type Phase = 'scratch' | 'burst' | 'done' | 'out' | 'in';

class ScratchOff implements ToyInstance {
  private gl: WebGL2RenderingContext;
  private r: ScratchRenderer;
  private width = 1;
  private height = 1;
  private card!: Card;
  private coat!: Coat;
  private crumbs!: Crumbs;
  private GW = 1;
  private GH = 1;
  private art = document.createElement('canvas');
  private print = document.createElement('canvas');
  private pose: CardPose = { x: 0, y: 0, w: 1, h: 1, angle: 0, lift: 0, press: 0 };
  /** The card sliding and twisting a little under strokes, sprung back to rest (px, rad). */
  private nudge = { x: 0, y: 0, vx: 0, vy: 0, a: 0, va: 0, fx: 0, fy: 0, torque: 0 };
  private dent: [number, number, number] = [0, 0, 0];
  private phase: Phase = 'scratch';
  private phaseT = 0;
  private time = 0;
  private frameNo = 0;
  private seed = (Math.random() * 1e9) | 0;
  private tool: ToolId = 'coin';
  /** 'card' = each ticket's own coat; otherwise every card gets this one. */
  private coatPick: CoatId | 'card' = 'card';
  private coatDef: CoatDef = COATS.silver;
  private coatApplied = false;
  private last = new Map<number, { x: number; y: number; ux: number; uy: number }>();
  private toolView: ToolView = { kind: 0, x: 0, y: 0, ux: 0, uy: 1, r: 1, press: 1, alpha: 0 };
  /** Range of pressure and contact size seen so far: if either moves, the screen can sense it. */
  private pRange = [1, 0];
  private sRange = [1e9, 0];
  private press = 1;
  private pressMode: 'force' | 'size' | 'hold' = 'hold';
  private seen = new Set<number>();
  private light: [number, number, number] = [0.3, 0.1, 0.7];
  private pinged: boolean[] = [];
  private symCount = new Map<string, number>();
  private revealed = 0;
  private burstOrder = new Int32Array(0);
  private burstDist = new Float32Array(0);
  private burstAt = 0;
  private burstFrom: [number, number] = [0, 0];
  private flash = 0;
  private winOn = 0;
  private winnings = 0;
  private cards = 0;
  private scratchedOnce = false;
  private meanArea = 10;
  private recoatTimer = 0;
  private simMs = 0;
  /** Space kept clear above and below the card (CSS px). */
  private margin = [TOP, DOCK];

  // Sound state.
  private scrape: Slip;
  private grit: Loop;
  private paper: Loop;
  private air: Loop;
  private scrapeLvl = 0;
  private paperLvl = 0;
  private speedS = 0;
  private blowing = 0;
  private wasBlowing = false;
  private lastWhoosh = -1;
  private crossRate = 0;
  private lastPopTick = 0;

  private dock: HTMLElement;
  private toolBtns: HTMLButtonElement[] = [];
  private nextBtn: HTMLButtonElement;
  private hint: HTMLElement;
  private banner: HTMLElement;
  private purse: HTMLElement;
  private style: HTMLStyleElement;

  /** Every feel knob, one object; the Tune panel writes straight into it. */
  readonly cfg = {
    // Coat
    flakeSize: 4.5,
    flakeSpread: 0.55,
    strength: 1,
    adhesionNoise: 0.6,
    brittleness: 0.35,
    abrasionResist: 1,
    speedGain: 0.4,
    crackReach: 0.2,
    chainDepth: 6,
    smear: 0,
    // Tool
    toolSize: 1,
    toolHardness: 1,
    pressureGain: 1,
    dwellBite: 1,
    // Sound and touch texture
    cardGive: 1,
    grain: 1,
    drag: 1,
    popTicks: true,
    // Crumbs
    perFlake: 1.2,
    push: 0.85,
    friction: 9,
    blow: 1,
    // Feel
    grit: 1,
    scrapeGain: 1,
    hapticGain: 1,
    // Reveal
    symbolAt: 0.62,
    autoFinish: 0.9,
    winChance: 0.4,
    // Look
    sheen: 1,
    streak: 0.8,
    glitter: 1,
    lip: 3,
    lift: 0.7,
    curls: 0.45,
  };

  constructor(private ctx: ToyContext) {
    const gl = ctx.canvas.getContext('webgl2', { alpha: false, antialias: false, depth: false, stencil: false, premultipliedAlpha: false });
    if (!gl) throw new Error('WebGL2 is not available on this device.');
    this.gl = gl;
    this.r = new ScratchRenderer(gl);
    this.scrape = ctx.sound.slip();
    this.grit = ctx.sound.loop('crackle');
    this.paper = ctx.sound.loop('hiss');
    this.air = ctx.sound.loop('rumble');

    this.style = document.createElement('style');
    this.style.textContent = `
      .so-next { position: absolute; z-index: 3; left: 50%; transform: translateX(-50%);
        bottom: calc(${DOCK - 30}px + var(--safe-bottom)); height: 46px; padding: 0 24px; border: 0; border-radius: 99px;
        background: linear-gradient(135deg, #ffd45a, #f08a1c); color: #2a1400; font: 800 16px/1 inherit;
        box-shadow: 0 10px 26px -10px rgba(240, 140, 20, 0.9); cursor: pointer; animation: so-pop 0.35s cubic-bezier(.2,1.6,.4,1); }
      .so-next[hidden], .so-hint[hidden], .so-banner[hidden] { display: none; }
      .so-hint { position: absolute; z-index: 2; left: 50%; transform: translateX(-50%); top: calc(54% + 0px);
        padding: 8px 14px; border-radius: 99px; background: rgba(10,10,16,0.62); color: #fff; font: 600 14px/1.2 inherit;
        pointer-events: none; white-space: nowrap; transition: opacity 0.4s; }
      .so-banner { position: absolute; z-index: 3; left: 50%; bottom: calc(${DOCK + 30}px + var(--safe-bottom)); transform: translateX(-50%);
        padding: 10px 18px; border-radius: 14px; background: rgba(10,10,16,0.7); color: #fff; font: 800 18px/1.1 inherit;
        pointer-events: none; animation: so-pop 0.4s cubic-bezier(.2,1.6,.4,1); text-align: center; }
      .so-purse { position: absolute; z-index: 2; left: 50%; transform: translateX(-50%); top: calc(116px + var(--safe-top, 0px));
        padding: 7px 12px; border-radius: 99px; background: rgba(10,10,16,0.55); color: #ffe7a0; font: 700 13px/1 inherit; pointer-events: none; }
      .so-purse.bump { animation: so-pop 0.4s cubic-bezier(.2,1.6,.4,1); }
      @keyframes so-pop { from { transform: translateX(-50%) scale(0.6); opacity: 0; } to { transform: translateX(-50%) scale(1); opacity: 1; } }`;
    document.head.appendChild(this.style);

    this.dock = document.createElement('div');
    this.dock.className = 'dock';
    this.toolBtns = (Object.keys(TOOLS) as ToolId[]).map((id) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = TOOLS[id].label;
      b.addEventListener('click', () => this.setTool(id));
      return b;
    });
    this.dock.append(...this.toolBtns);
    ctx.overlay.appendChild(this.dock);
    this.setTool('coin', true);

    this.nextBtn = document.createElement('button');
    this.nextBtn.type = 'button';
    this.nextBtn.className = 'so-next';
    this.nextBtn.textContent = 'Next card ›';
    this.nextBtn.hidden = true;
    this.nextBtn.addEventListener('click', () => this.nextCard());
    this.hint = document.createElement('div');
    this.hint.className = 'so-hint';
    this.hint.textContent = 'Scratch the silver';
    this.banner = document.createElement('div');
    this.banner.className = 'so-banner';
    this.banner.hidden = true;
    this.purse = document.createElement('div');
    this.purse.className = 'so-purse';
    ctx.overlay.append(this.nextBtn, this.hint, this.banner, this.purse);
    this.updatePurse();

    ctx.mic.offer('Blow to clear the crumbs', { echoCancel: true });
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.layout();
    this.newCard();
    this.buildPanel();
    if (import.meta.env.DEV) {
      const w = window as unknown as Record<string, unknown>;
      w.__scratch = {
        stats: () => ({ phase: this.phase, revealed: this.revealed, crumbs: this.crumbs.count, flakes: this.coat.flakes, gone: this.coat.goneFlakes, simMs: this.simMs, prize: this.card.prize }),
        /** Hub-preview capture: fill the frame with a winning card (the HUD is hidden there). */
        preview: () => {
          this.margin = [10, 10];
          this.cfg.winChance = 1;
          this.layout();
          this.newCard();
        },
        /** Scratch area in CSS px. */
        box: () => {
          const pr = this.ctx.pixelRatio, P = this.pose, b = COAT_BOX;
          return { x0: (P.x + b.x0 * P.w) / pr, y0: (P.y + b.y0 * P.h) / pr, x1: (P.x + b.x1 * P.w) / pr, y1: (P.y + b.y1 * P.h) / pr };
        },
      };
    }
  }

  // ---------------------------------------------------------------- setup

  private layout() {
    const pr = this.ctx.pixelRatio;
    const availH = this.height - (this.margin[0] + this.margin[1]) * pr;
    const availW = this.width - 28 * pr;
    const w = Math.min(availW, availH * CARD_ASPECT, 480 * pr);
    const h = w / CARD_ASPECT;
    this.pose.w = w;
    this.pose.h = h;
    this.pose.x = (this.width - w) / 2;
    this.pose.y = this.margin[0] * pr + (availH - h) / 2;
  }

  /** Card rect at rest. */
  private rest() {
    const pr = this.ctx.pixelRatio;
    const availH = this.height - (this.margin[0] + this.margin[1]) * pr;
    return { x: (this.width - this.pose.w) / 2, y: this.margin[0] * pr + (availH - this.pose.h) / 2 };
  }

  private coatParams(): CoatParams {
    const c = this.cfg;
    return {
      flakeSize: c.flakeSize,
      flakeSpread: c.flakeSpread,
      strength: c.strength,
      adhesionNoise: c.adhesionNoise,
      brittleness: c.brittleness,
      abrasionResist: c.abrasionResist,
      speedGain: c.speedGain,
      crackReach: c.crackReach,
      chainDepth: c.chainDepth,
      smear: c.smear,
    };
  }

  private crumbParams(): CrumbParams {
    const c = this.cfg;
    return { perFlake: c.perFlake, push: c.push, friction: c.friction, blow: c.blow };
  }

  private newCard() {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    this.card = makeCard(this.seed, this.cfg.winChance);
    this.applyCoat(this.coatPick === 'card' ? this.card.design.coat : this.coatPick);
    const pr = this.ctx.pixelRatio;
    this.GW = Math.round(Math.min(300, Math.max(170, this.pose.w / pr / 1.3)));
    this.GH = Math.round(this.GW / CARD_ASPECT);
    const artW = Math.min(1400, Math.round(this.pose.w));
    paintCard(this.card, this.art, artW);
    paintCoatPrint(this.card, this.print, Math.round(artW * 0.6));
    this.crumbs = new Crumbs();
    this.recoat();
  }

  /** Load a coat's settings (the Tune panel then edits that coat). */
  private applyCoat(id: CoatId) {
    const def = COATS[id];
    if (def === this.coatDef && this.coatApplied) return;
    this.coatDef = def;
    this.coatApplied = true;
    Object.assign(this.cfg, def.set);
    this.ctx.panel.sync();
  }

  private recoat() {
    const { GW, GH } = this;
    this.coat = new Coat(GW, GH, (x, y) => inCoat((x + 0.5) / GW, (y + 0.5) / GH), this.coatParams(), this.seed);
    this.meanArea = this.coat.coatCells / Math.max(1, this.coat.flakes);
    this.crumbs.clear();
    this.r.setCard(this.art, this.print, this.coat);
    this.pinged = this.card.cells.map(() => false);
    this.symCount.clear();
    this.revealed = 0;
    this.winOn = 0;
    this.phase = this.phase === 'out' ? 'in' : 'scratch';
    this.phaseT = 0;
    this.banner.hidden = true;
    this.nextBtn.hidden = true;
    this.ctx.progress(0, 'scratched');
  }

  private setTool(id: ToolId, quiet = false) {
    if (!quiet && id !== this.tool) this.ctx.sound.play('tick', { pitch: 0.8 + TOOLS[id].sharp * 0.6, gain: 0.5 });
    this.tool = id;
    this.toolBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(Object.keys(TOOLS)[i] === id)));
  }

  private buildPanel() {
    const { panel } = this.ctx;
    const c = this.cfg;
    const later = () => {
      clearTimeout(this.recoatTimer);
      this.recoatTimer = window.setTimeout(() => this.recoat(), 250);
    };
    panel.action('New card', () => this.nextCard());
    panel.action('Re-coat this card', () => this.recoat());
    panel.heading('Coat');
    panel.choice(
      'Material',
      [{ value: 'card' as const, label: "Card's own" }, ...COAT_IDS.map((id) => ({ value: id, label: COATS[id].label }))],
      this.coatPick,
      (v) => {
        this.coatPick = v;
        this.applyCoat(v === 'card' ? this.card.design.coat : v);
        this.recoat();
      },
    );
    panel.slider(c, 'flakeSize', { label: 'Flake size', min: 1.5, max: 14, step: 0.5, onChange: later });
    panel.slider(c, 'flakeSpread', { label: 'Flake size spread', min: 0, max: 1, step: 0.05, onChange: later });
    panel.slider(c, 'adhesionNoise', { label: 'Stubborn patches', min: 0, max: 1, step: 0.05, onChange: later });
    panel.slider(c, 'strength', { label: 'Adhesion', min: 0.2, max: 4, step: 0.05 });
    panel.slider(c, 'brittleness', { label: 'Brittleness', min: 0, max: 1.5, step: 0.05 });
    panel.slider(c, 'abrasionResist', { label: 'Scuff resistance', min: 0.2, max: 5, step: 0.1 });
    panel.slider(c, 'speedGain', { label: 'Speed bite', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'crackReach', { label: 'Crack reach (0 = runs ahead)', min: 0, max: 0.6, step: 0.01 });
    panel.slider(c, 'chainDepth', { label: 'Crack run (flakes)', min: 0, max: 12, step: 1 });
    panel.slider(c, 'smear', { label: 'Smear', min: 0, max: 0.9, step: 0.05 });
    panel.heading('Tool');
    panel.slider(c, 'toolSize', { label: 'Size', min: 0.4, max: 3, step: 0.05 });
    panel.slider(c, 'toolHardness', { label: 'Hardness', min: 0.2, max: 3, step: 0.05 });
    panel.slider(c, 'pressureGain', { label: 'Pressure bite', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'dwellBite', { label: 'Hold-still bite', min: 0, max: 3, step: 0.05 });
    panel.heading('Crumbs');
    panel.slider(c, 'perFlake', { label: 'Crumbs per flake', min: 0, max: 4, step: 0.1 });
    panel.slider(c, 'push', { label: 'Plough', min: 0, max: 1.5, step: 0.05 });
    panel.slider(c, 'friction', { label: 'Friction', min: 1, max: 30, step: 0.5 });
    panel.slider(c, 'blow', { label: 'Blow strength', min: 0.2, max: 3, step: 0.05 });
    panel.heading('Feel');
    panel.slider(c, 'grit', { label: 'Grit clicks', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'scrapeGain', { label: 'Scrape', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'hapticGain', { label: 'Haptics', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'cardGive', { label: 'Card give (dent, slide)', min: 0, max: 3, step: 0.05 });
    panel.slider(c, 'grain', { label: 'Coat grain (scrape chatter)', min: 0, max: 3, step: 0.05 });
    panel.slider(c, 'drag', { label: 'Stubborn drag', min: 0, max: 2, step: 0.05 });
    panel.toggleSwitch(c, 'popTicks', 'A haptic tick per pop');
    panel.heading('Reveal');
    panel.slider(c, 'symbolAt', { label: 'Symbol shows at', min: 0.3, max: 0.95, step: 0.01 });
    panel.slider(c, 'autoFinish', { label: 'Auto-finish at', min: 0.5, max: 1, step: 0.01 });
    panel.slider(c, 'winChance', { label: 'Win chance (next card)', min: 0, max: 1, step: 0.05 });
    panel.heading('Look');
    panel.slider(c, 'sheen', { label: 'Sheen', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'streak', { label: 'Brushed streaks', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'glitter', { label: 'Glitter', min: 0, max: 3, step: 0.05 });
    panel.slider(c, 'lip', { label: 'Coat thickness', min: 0, max: 8, step: 0.1 });
    panel.slider(c, 'lift', { label: 'Flake lift', min: 0, max: 2, step: 0.05 });
    panel.slider(c, 'curls', { label: 'Curled crumbs', min: 0, max: 1, step: 0.05 });
  }

  private toolShape(): ToolShape & ToolDef {
    const t = TOOLS[this.tool];
    const cellsPerCss = this.GW / (this.pose.w / this.ctx.pixelRatio);
    return { ...t, r: t.r * this.cfg.toolSize * cellsPerCss, hardness: t.hardness * this.cfg.toolHardness };
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    const t0 = performance.now();
    this.time = t;
    this.frameNo++;
    this.phaseT += dt;
    this.coat.clearEvents();
    this.crumbs.ploughed = 0;
    let touching = false;
    let contact = 0, bare = 0, speed = 0, pan = 0;
    const tool = this.toolShape();
    const cp = this.crumbParams();
    const pts = [...this.ctx.pointers.active.values()];
    const W = this.width, H = this.height, P = this.pose;
    // Screen to coat cells, undoing the card's small twist about its centre.
    const toCell = (u: number, v: number): [number, number] => {
      const cx = P.x + P.w / 2, cy = P.y + P.h / 2;
      const dx = u * W - cx, dy = (1 - v) * H - cy;
      const sn = Math.sin(-P.angle), cs = Math.cos(-P.angle);
      return [((dx * cs - dy * sn + P.w / 2) / P.w) * this.GW, ((dx * sn + dy * cs + P.h / 2) / P.h) * this.GH];
    };
    const ng = this.nudge;
    ng.fx = ng.fy = ng.torque = 0;
    let dentAt: [number, number] | null = null;

    let blowing = false;
    let blowPower = 0;
    if (this.phase === 'scratch' || this.phase === 'done') {
      this.seen.clear();
      if (pts.length >= 2) {
        // Two fingers: a puff of air from between them.
        let u = 0, v = 0, sp = 0;
        for (const q of pts) {
          u += q.x / pts.length;
          v += q.y / pts.length;
          sp = Math.max(sp, Math.hypot(q.dx * W, q.dy * H));
        }
        const [bx, by] = toCell(u, v);
        blowPower = (0.8 + Math.min(1.5, sp / this.ctx.pixelRatio / 12)) * this.cfg.blow;
        this.crumbs.blow(bx, by, this.GW * 0.18, blowPower, dt);
        blowing = true;
      } else if (this.phase === 'scratch') {
        for (const q of pts) {
          this.seen.add(q.id);
          const [gx, gy] = toCell(q.x, q.y);
          let prev = this.last.get(q.id);
          if (!prev || q.justDown) {
            this.coat.lift();
            prev = { x: gx, y: gy, ux: prev?.ux ?? 0, uy: prev?.uy ?? 1 };
            this.last.set(q.id, prev);
            if (!this.scratchedOnce) {
              this.scratchedOnce = true;
              this.hint.hidden = true;
            }
          }
          const mx = gx - prev.x, my = gy - prev.y;
          const d = Math.hypot(mx, my);
          if (d > 0.05) {
            // The edge turns to face the stroke, with a little lag (a wrist, not a compass).
            const k = Math.min(1, 0.25 + d * 0.15);
            let ux = prev.ux + (mx / d - prev.ux) * k, uy = prev.uy + (my / d - prev.uy) * k;
            const l = Math.hypot(ux, uy) || 1;
            prev.ux = ux / l;
            prev.uy = uy / l;
          }
          const press = this.pressOf(q.pressure, q.size, dt);
          const rb = Math.max(0.9, tool.r * (1 - tool.flat * 0.82));
          const steps = Math.max(1, Math.min(24, Math.ceil(d / (rb * 0.5))));
          const sp = d / Math.max(dt, 1e-3);
          // Holding still (or crawling) keeps working the coat under the edge.
          const dwell = this.cfg.dwellBite * dt * 7 * Math.exp(-sp / 50);
          const tvx = mx / Math.max(dt, 1e-3), tvy = my / Math.max(dt, 1e-3);
          let c = 0, b = 0;
          for (let k = 1; k <= steps; k++) {
            const x = prev.x + (mx * k) / steps, y = prev.y + (my * k) / steps;
            const dl = d / steps + dwell / steps;
            this.coat.scrape(x, y, prev.ux, prev.uy, dl, tool, this.coatParams(), sp, press);
            c += this.coat.contact / steps;
            b += this.coat.bare / steps;
            this.crumbs.plough(x, y, prev.ux, prev.uy, tvx, tvy, tool.r, tool.flat, cp);
          }
          prev.x = gx;
          prev.y = gy;
          touching = true;
          contact += c;
          bare += b;
          speed = Math.max(speed, sp);
          pan = (gx / this.GW) * 2 - 1;
          this.lightTo(q.x, q.y, dt);
          const tv = this.toolView, P = this.pose;
          tv.x = q.x * W;
          tv.y = (1 - q.y) * H;
          // Friction drags the card along the stroke (more when pressing and on coat), twisting it about its centre.
          const f = Math.min(1, sp / 300) * press * (0.3 + 0.7 * Math.min(1, c / Math.max(1, tool.r * tool.r))) * this.cfg.cardGive;
          const fx = prev.ux * f, fy = prev.uy * f;
          ng.fx += fx;
          ng.fy += fy;
          ng.torque += ((tv.x - (P.x + P.w / 2)) * fy - (tv.y - (P.y + P.h / 2)) * fx) / P.w;
          dentAt = [(gx / this.GW) * P.w, (gy / this.GH) * P.h];
          tv.ux = prev.ux;
          tv.uy = prev.uy;
          tv.r = (tool.r / this.GW) * P.w;
          tv.press = press;
          tv.alpha = Math.min(1, tv.alpha + dt * 12);
          // Abrasion dust: fine crumbs shed off the back of the stroke.
          const dust = this.coat.abraded / 5;
          for (let n = Math.floor(dust + Math.random()); n > 0; n--)
            this.crumbs.add(gx - prev.ux * rb + (Math.random() - 0.5) * tool.r, gy - prev.uy * rb + (Math.random() - 0.5) * tool.r, 0.6 + Math.random() * 0.7, (Math.random() - 0.5) * 20, (Math.random() - 0.5) * 20, 0, 0.7 + Math.random() * 0.2);
          this.coat.abraded = 0;
        }
        for (const id of this.last.keys()) if (!this.seen.has(id)) this.last.delete(id);
      }
    }
    // Spring-damped give: a few px of slide and a fraction of a degree of twist.
    const pr = this.ctx.pixelRatio;
    const K = 260, D = 2 * Math.sqrt(K) * 0.55;
    ng.vx += (ng.fx * 900 * pr - K * ng.x - D * ng.vx) * dt;
    ng.vy += (ng.fy * 900 * pr - K * ng.y - D * ng.vy) * dt;
    ng.va += (ng.torque * 1.6 - K * ng.a - D * ng.va) * dt;
    ng.x += ng.vx * dt;
    ng.y += ng.vy * dt;
    ng.a += ng.va * dt;
    const lim = 4 * pr;
    ng.x = Math.max(-lim, Math.min(lim, ng.x));
    ng.y = Math.max(-lim, Math.min(lim, ng.y));
    ng.a = Math.max(-0.012, Math.min(0.012, ng.a));
    const dz = dentAt ? Math.min(1, 0.35 + 0.45 * this.press) * this.cfg.cardGive : 0;
    if (dentAt) {
      this.dent[0] = dentAt[0];
      this.dent[1] = dentAt[1];
    }
    this.dent[2] += (dz - this.dent[2]) * Math.min(1, dt * 14);
    P.press = this.dent[2];
    if (!touching) {
      this.lightTo(-1, -1, dt);
      this.toolView.alpha = Math.max(0, this.toolView.alpha - dt * 8);
    }
    this.toolView.kind = TOOL_VIEW[this.tool];

    // Breath into the mic clears crumbs from the middle of the card outwards.
    const breath = this.ctx.mic.blow;
    if (breath > 0.06 && !blowing) {
      blowPower = (0.7 + breath * 1.6) * this.cfg.blow;
      this.crumbs.blow(this.GW * 0.5, this.GH * 0.62, this.GW * 0.3, blowPower, dt);
      blowing = true;
    }

    if (this.phase === 'scratch') {
      this.coat.settle(this.coatParams());
      this.spawnFromBreaks(touching ? this.last.values().next().value ?? null : null, tool);
    }
    this.crumbs.step(dt, cp, (x, y) => x >= 0 && y >= 0 && x < this.GW && y < this.GH);

    this.stepPhase(dt);
    if (this.phase === 'scratch' && this.frameNo % 4 === 0) this.checkReveal();
    this.juice(dt, { touching, contact, bare, speed, pan, tool, blowing, blowPower });

    this.simMs += (performance.now() - t0 - this.simMs) * 0.1;
    this.r.update(this.coat);
    const L = this.light;
    this.r.draw({
      width: this.width,
      height: this.height,
      pose: this.pose,
      lamp: [this.width * (0.5 + (L[0] - 0.5) * 0.25), this.height * 0.2],
      light: L,
      foil: this.coatDef.id === 'silver' ? this.card.design.foil : this.coatDef.colour,
      mode: this.coatDef.mode,
      look: this.cfg,
      time: t,
      flash: this.flash,
      win: this.card.cells.filter((c) => c.win).map((c) => [c.x0, c.y0, c.x1, c.y1]),
      winOn: this.winOn,
      crumbs: this.crumbs,
      tool: this.toolView,
      scale: this.ctx.pixelRatio,
      dent: this.dent,
    });
    this.flash *= Math.exp(-dt * 7);
    this.ctx.setStatus(`${this.crumbs.count} crumbs · ${this.coat.goneFlakes}/${this.coat.flakes} flakes · sim ${this.simMs.toFixed(1)}ms · press ${this.pressMode} ${this.press.toFixed(2)}`);
  }

  /**
   * How hard the finger is pressing, ~0.5..1.6 (1 = normal). Uses force where the screen senses it,
   * else the contact size (a pressed fingertip flattens), else 1. Either only counts once it has
   * been seen to vary, since unsupported screens report a constant.
   */
  private pressOf(pressure: number, size: number, dt: number) {
    const P = this.pRange, S = this.sRange;
    P[0] = Math.min(P[0], pressure);
    P[1] = Math.max(P[1], pressure);
    if (size > 1) {
      S[0] = Math.min(S[0], size);
      S[1] = Math.max(S[1], size);
    }
    let raw = 1;
    this.pressMode = 'hold';
    if (P[1] - P[0] > 0.12) {
      raw = 0.5 + pressure * 1.1;
      this.pressMode = 'force';
    } else if (S[1] - S[0] > 5) {
      raw = 0.6 + ((size - S[0]) / (S[1] - S[0])) * 0.9;
      this.pressMode = 'size';
    }
    const target = 1 + (raw - 1) * this.cfg.pressureGain;
    this.press += (target - this.press) * Math.min(1, dt * 15);
    return this.press;
  }

  /** The lamp's highlight follows the finger a little; idle, it drifts so the foil keeps shimmering. */
  private lightTo(u: number, v: number, dt: number) {
    const L = this.light;
    let tx: number, ty: number;
    if (u >= 0) {
      const P = this.pose;
      const cx = (u * this.width - P.x) / P.w, cy = ((1 - v) * this.height - P.y) / P.h;
      tx = cx * 0.6 + 0.1;
      ty = cy * 0.5 - 0.15;
    } else {
      tx = 0.5 + Math.sin(this.time * 0.37) * 0.45;
      ty = 0.15 + Math.sin(this.time * 0.23 + 1) * 0.25;
    }
    const k = Math.min(1, dt * (u >= 0 ? 3 : 0.8));
    L[0] += (tx - L[0]) * k;
    L[1] += (ty - L[1]) * k;
  }

  /** Popped flakes become crumbs and grit clicks. */
  private spawnFromBreaks(stroke: { ux: number; uy: number } | null, tool: ToolShape & ToolDef) {
    const co = this.coat;
    const n = co.breaks;
    if (!n) return;
    const s = this.ctx.sound;
    let clicks = 0;
    const budget = Math.round(6 * Math.min(1.5, this.cfg.grit));
    for (let i = 0; i < n; i++) {
      const area = co.bArea[i];
      const rel = area / this.meanArea;
      const count = Math.floor(this.cfg.perFlake * (0.5 + 0.5 * Math.sqrt(rel)) + Math.random());
      const fly = stroke ? 60 : 25;
      for (let k = 0; k < count; k++) {
        const sz = Math.sqrt(area / Math.max(1, count)) * (0.75 + Math.random() * 0.25);
        const vx = (stroke ? stroke.ux * fly : 0) + (Math.random() - 0.5) * 50;
        const vy = (stroke ? stroke.uy * fly : 0) + (Math.random() - 0.5) * 50;
        this.crumbs.add(co.bx[i] + (Math.random() - 0.5) * 2, co.by[i] + (Math.random() - 0.5) * 2, sz, vx, vy, Math.random() < 0.25 ? 6 + Math.random() * 12 : 0, 0.85 + Math.random() * 0.3);
      }
      if (clicks < budget && this.cfg.grit > 0) {
        clicks++;
        const e = Math.min(1, (Math.sqrt(area) / 5) * (0.5 + co.bStrength[i] * 0.4) * (0.55 + tool.sharp * 0.45)) * Math.min(1, this.cfg.grit);
        const cd = this.coatDef, pan = (co.bx[i] / this.GW) * 2 - 1;
        s.crumple(e * (co.bChain[i] ? 0.7 : 1), { stiffness: Math.min(1, cd.stiffness * 0.6 + this.cfg.brittleness * 0.2 + tool.sharp * 0.25), pan });
        // Lacquer shards ring like tiny bits of glass.
        if (cd.glassy && Math.random() < cd.glassy) s.impact('glass', 0.008 + Math.sqrt(area) * 0.0015, Math.min(1, e * 1.2), { pan });
      }
    }
  }

  private checkReveal() {
    const { GW, GH, coat, card, cfg } = this;
    card.cells.forEach((c, i) => {
      if (this.pinged[i]) return;
      const f = coat.revealed(c.x0 * GW, c.y0 * GH, c.x1 * GW, c.y1 * GH);
      if (f < cfg.symbolAt) return;
      this.pinged[i] = true;
      const same = (this.symCount.get(c.sym) ?? 0) + 1;
      this.symCount.set(c.sym, same);
      // A matching symbol rings a step up the chord: two of a kind is audible tension.
      const pitch = [1, 1.26, 1.5][Math.min(2, same - 1)];
      this.ctx.sound.play(same > 1 ? 'chime' : 'tick', { pitch: same > 1 ? pitch * 0.9 : 1.4, gain: same > 1 ? 0.3 + same * 0.12 : 0.55, pan: (c.x0 + c.x1) - 1 });
      this.ctx.haptic(same > 1 ? 'medium' : 'light');
    });
    const b = COAT_BOX;
    this.revealed = coat.revealed(b.x0 * GW, b.y0 * GH, b.x1 * GW, b.y1 * GH);
    this.ctx.progress(this.revealed, 'scratched');
    if (this.pinged.every(Boolean) || this.revealed >= cfg.autoFinish) this.startBurst();
  }

  /** The rest of the coat bursts off in a wave from where you last scratched. */
  private startBurst() {
    const co = this.coat;
    const last = [...this.last.values()][0];
    this.burstFrom = last ? [last.x, last.y] : [this.GW / 2, this.GH / 2];
    const left: number[] = [];
    for (let f = 0; f < co.flakes; f++) if (!co.fGone[f]) left.push(f);
    const [fx, fy] = this.burstFrom;
    const dist = left.map((f) => Math.hypot(co.fCx[f] - fx, co.fCy[f] - fy) + Math.random() * 6);
    const idx = left.map((_, i) => i).sort((a, b) => dist[a] - dist[b]);
    this.burstOrder = Int32Array.from(idx.map((i) => left[i]));
    this.burstDist = Float32Array.from(idx.map((i) => dist[i]));
    this.burstAt = 0;
    this.phase = 'burst';
    this.phaseT = 0;
    this.last.clear();
    this.crumbs.scatter(fx, fy);
    this.ctx.sound.play('whoosh', { pitch: 1.2, gain: 0.5 });
    this.ctx.progress(1, 'scratched');
  }

  private stepPhase(dt: number) {
    const rest = this.rest();
    const P = this.pose;
    if (this.phase === 'burst') {
      const co = this.coat;
      const front = this.phaseT * this.GW * 2.2;
      const [fx, fy] = this.burstFrom;
      let popped = 0;
      while (this.burstAt < this.burstOrder.length && this.burstDist[this.burstAt] < front) {
        const f = this.burstOrder[this.burstAt++];
        co.pop(f);
        popped++;
        if (Math.random() < 0.35) {
          const ox = co.fCx[f] - fx, oy = co.fCy[f] - fy;
          const d = Math.hypot(ox, oy) + 1;
          const s = 120 + Math.random() * 220;
          this.crumbs.add(co.fCx[f], co.fCy[f], Math.sqrt(co.fArea[f]) * 0.8, (ox / d) * s, (oy / d) * s, 10 + Math.random() * 25, 0.9 + Math.random() * 0.2, true);
        }
      }
      co.clearEvents();
      this.grit.set(Math.min(1, popped / 40), 0.9);
      if (popped && Math.random() < 0.6) this.ctx.sound.crumple(0.5 + Math.random() * 0.4, { stiffness: 0.7, pan: (Math.random() - 0.5) * 0.8 });
      this.ctx.hapticLevel(Math.min(1, popped / 60) * this.cfg.hapticGain, 0.7);
      if (this.burstAt >= this.burstOrder.length) this.finish();
    } else if (this.phase === 'done') {
      this.winOn = Math.min(1, this.winOn + dt * 3) * (this.card.prize ? 1 : 0);
    } else if (this.phase === 'out') {
      const k = Math.min(1, this.phaseT / 0.32);
      const e = k * k;
      P.x = rest.x - e * this.width * 0.9;
      P.y = rest.y - e * this.height * 0.25;
      P.angle = -e * 0.5;
      P.lift = k;
      if (k >= 1) {
        this.newCard();
        P.x = rest.x;
        P.y = this.height + 20;
        P.angle = 0.12;
      }
    } else if (this.phase === 'in') {
      const k = Math.min(1, this.phaseT / 0.45);
      const e = 1 - Math.pow(1 - k, 3) * Math.cos(k * 4);
      P.x = rest.x;
      P.y = this.height + (rest.y - this.height) * e;
      P.angle = 0.12 * (1 - e);
      P.lift = 1 - k;
      if (k >= 1) {
        P.y = rest.y;
        P.angle = 0;
        P.lift = 0;
        this.phase = 'scratch';
        this.phaseT = 0;
        this.ctx.sound.play('thud', { pitch: 1.6, gain: 0.35 });
        this.ctx.haptic('light');
      }
    } else {
      const ng = this.nudge;
      P.x = rest.x + ng.x;
      P.y = rest.y + ng.y;
      P.angle = ng.a;
    }
  }

  private finish() {
    this.phase = 'done';
    this.phaseT = 0;
    this.cards++;
    const c = this.card;
    this.banner.hidden = false;
    if (c.prize) {
      this.flash = 0.35;
      this.winnings += c.prize;
      this.banner.hidden = true;
      this.ctx.celebrate(`You won $${c.prize}!`);
      this.updatePurse(true);
    } else {
      this.banner.textContent = 'No match this time';
      this.ctx.sound.play('plop', { pitch: 0.7, gain: 0.35 });
      this.updatePurse();
    }
    this.nextBtn.hidden = false;
  }

  private nextCard() {
    if (this.phase === 'out' || this.phase === 'in') return;
    this.phase = 'out';
    this.phaseT = 0;
    this.banner.hidden = true;
    this.nextBtn.hidden = true;
    this.ctx.progress(null);
    this.ctx.sound.play('whoosh', { pitch: 0.9, gain: 0.4 });
  }

  private updatePurse(bump = false) {
    this.purse.textContent = `Won $${this.winnings} · ${this.cards} card${this.cards === 1 ? '' : 's'}`;
    if (bump) {
      this.purse.classList.remove('bump');
      void this.purse.offsetWidth;
      this.purse.classList.add('bump');
    }
  }

  /** Scrape bed, grit, paper hiss, breath; haptics that follow the fracture rate. */
  private juice(
    dt: number,
    o: { touching: boolean; contact: number; bare: number; speed: number; pan: number; tool: ToolShape & ToolDef; blowing: boolean; blowPower: number },
  ) {
    const { cfg, ctx } = this;
    const area = Math.max(1, o.tool.r * o.tool.r * (1.2 - o.tool.flat * 0.7));
    const onCoat = Math.min(1, o.contact / area);
    const onPaper = Math.min(1, o.bare / area);
    const sp = Math.min(1.5, o.speed / 160);
    this.speedS += (sp - this.speedS) * Math.min(1, dt * 14);
    const k = Math.min(1, dt * 20);
    this.scrapeLvl += ((o.touching ? onCoat * Math.min(1, this.speedS * 1.4 + 0.08) : 0) - this.scrapeLvl) * k;
    this.paperLvl += ((o.touching ? onPaper * this.speedS : 0) - this.paperLvl) * k;
    const breaks = this.phase === 'scratch' ? this.coat.breaks : 0;
    if (this.phase !== 'burst') {
      // The scrape's pulse rate is the coat's grain: one catch per flake edge the tool crosses. Pressing
      // harder scrapes louder and a little lower; stubborn patches drag it louder and lower still.
      const pr = this.press;
      const cross = o.touching ? this.coat.crossings / Math.max(dt, 1e-3) : 0;
      this.crossRate += (cross - this.crossRate) * Math.min(1, dt * 18);
      const drag = Math.min(1.6, Math.max(0.6, 1 + cfg.drag * (this.coat.adhesion - 1) * 0.5));
      const cd = this.coatDef;
      const rate = Math.min(700, 20 + this.crossRate * cfg.grain * o.tool.rough * cd.rate);
      const freq = (o.tool.freq * cd.pitch * (0.85 + onCoat * 0.3) * (1.12 - 0.12 * pr)) / Math.sqrt(drag);
      this.scrape.set(this.scrapeLvl * cfg.scrapeGain * (0.65 + 0.35 * pr) * drag, rate, freq, o.pan * 0.6);
      this.grit.set(Math.min(1, Math.max(0, breaks - 6) / 14) * cfg.grit, 0.85);
    } else this.scrape.set(0, 30, o.tool.freq);
    this.paper.set(this.paperLvl * 0.22 * cfg.scrapeGain, 0.55);
    this.blowing += ((o.blowing ? Math.min(1, o.blowPower * 0.5) : 0) - this.blowing) * Math.min(1, dt * 8);
    this.air.set(this.blowing * 0.6, 0.5);
    if (o.blowing && (!this.wasBlowing || (o.blowPower > 1.6 && this.time - this.lastWhoosh > 0.5))) {
      this.lastWhoosh = this.time;
      ctx.sound.play('whoosh', { pitch: 0.8 + Math.random() * 0.3, gain: 0.3 });
    }
    this.wasBlowing = o.blowing;
    // A crisp tick per pop (a burst for a clump), over the continuous scrape.
    if (cfg.popTicks && breaks && this.phase === 'scratch' && this.time - this.lastPopTick > 0.045) {
      this.lastPopTick = this.time;
      let chain = 0;
      for (let i = 0; i < breaks; i++) chain += this.coat.bChain[i];
      ctx.haptic(chain > 3 || breaks > 10 ? 'medium' : 'light');
    }
    if (o.touching && this.phase === 'scratch') {
      const level = (onCoat * Math.min(1, this.speedS) * 0.35 + Math.min(0.65, breaks * 0.07) + onPaper * this.speedS * 0.08) * cfg.hapticGain;
      if (level > 0.02) ctx.hapticLevel(Math.min(1, level * (0.7 + 0.3 * this.press)), Math.min(1, o.tool.sharp * this.coatDef.sharp));
    }
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    const oldW = this.pose.w;
    this.layout();
    // The coat grid is in card units; only the art is resolution-bound, so repaint it.
    if (Math.abs(this.pose.w - oldW) > 2) {
      const artW = Math.min(1400, Math.round(this.pose.w));
      paintCard(this.card, this.art, artW);
      paintCoatPrint(this.card, this.print, Math.round(artW * 0.6));
      this.r.setCard(this.art, this.print, this.coat);
    }
  }

  destroy() {
    clearTimeout(this.recoatTimer);
    this.scrape.stop();
    this.grit.stop();
    this.paper.stop();
    this.air.stop();
    this.r.destroy();
    this.dock.remove();
    this.nextBtn.remove();
    this.hint.remove();
    this.banner.remove();
    this.purse.remove();
    this.style.remove();
    this.ctx.progress(null);
    this.gl.getExtension('WEBGL_lose_context')?.loseContext();
  }
}
