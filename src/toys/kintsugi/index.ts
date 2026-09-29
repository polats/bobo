import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import { fracture, type Fracture } from './fracture';
import { GoldNet } from './gold';
import { makeShape, paintPiece, PIECES, type Painter, type PieceDef, type Shape } from './pieces';

export const kintsugiToy: Toy = {
  id: 'kintsugi',
  title: 'Kintsugi',
  blurb: 'Drop a porcelain bowl, fit the shards back together, then pour molten gold along every crack.',
  tech: 'Voronoi fracture + 2.5D tumbling shards + 1D seam flow · Canvas 2D',
  swatch: 'linear-gradient(135deg,#1c2742 0 30%,#9fc7b3 30% 58%,#f4c64e 58% 64%,#9fc7b3 64% 80%,#1c2742 80%)',
  refs: [
    {
      short: 'Kintsugi',
      title: 'Kintsugi (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Kintsugi',
      use: 'The craft: breaks are mended with lacquer and powdered gold, so the repair becomes part of the piece.',
    },
    {
      short: 'Voronoi',
      title: 'Voronoi diagram (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Voronoi_diagram',
      use: 'Shard cells from seeds clustered at the impact point; shared cell edges are the seams.',
    },
    {
      short: 'Midpoint displacement',
      title: 'Diamond-square / midpoint displacement (Wikipedia)',
      url: 'https://en.wikipedia.org/wiki/Diamond-square_algorithm',
      use: 'Each straight Voronoi edge is recursively displaced into a jagged crack, shared by both shards.',
    },
  ],
  async create(ctx) {
    return new Kintsugi(ctx);
  },
};

type Phase = 'hover' | 'fall' | 'broken' | 'done' | 'shelve';

interface Shard {
  sprite: HTMLCanvasElement;
  shadow: HTMLCanvasElement;
  /** Sprite and shadow offsets from the centroid. */
  sx: number;
  sy: number;
  shx: number;
  shy: number;
  /** Outline around the centroid, for hit tests and the home highlight. */
  poly: number[];
  path: Path2D;
  /** Home pose: centroid in piece-local pixels. */
  hx: number;
  hy: number;
  x: number;
  y: number;
  a: number;
  vx: number;
  vy: number;
  w: number;
  z: number;
  vz: number;
  r: number;
  rIn: number;
  seated: boolean;
  /** Seat animation 0..1 (-1 when not seating). */
  seatT: number;
  fx: number;
  fy: number;
  fa: number;
  flash: number;
  held: boolean;
  lift: number;
}

interface Grab {
  kind: 'shard' | 'pour';
  shard: Shard | null;
  ox: number;
  oy: number;
  /** For pours: the landing node and whether we've told the player seams are closed. */
  node: number;
  warned: boolean;
}

/** The next piece, painted a little each frame while the last one is admired. */
interface Prep {
  round: number;
  shape: Shape;
  painter: Painter;
  frac: Fracture | null;
}

interface Shelved {
  img: HTMLCanvasElement;
  w: number;
  h: number;
}

const params = { viscosity: 1, assist: 1 };

const G = 2600;
const SHELF = 5;
const MAX_TIPS = 64;

class Kintsugi implements ToyInstance {
  private g: CanvasRenderingContext2D;
  private width = 1;
  private height = 1;
  private S: number;
  private bg: HTMLCanvasElement;
  private phase: Phase = 'hover';
  private phaseT = 0;
  private time = 0;
  private round = 0;
  private def: PieceDef = PIECES[0];
  private shape!: Shape;
  private frac!: Fracture;
  private image!: HTMLCanvasElement;
  private whole!: HTMLCanvasElement;
  private wholeShadow!: HTMLCanvasElement;
  private wox = 0;
  private woy = 0;
  private silhouette!: Path2D;
  private shards: Shard[] = [];
  private order: Shard[] = [];
  private seated: boolean[] = [];
  private gold!: GoldNet;
  private goldPath: Path2D | null = null;
  private crackPath: Path2D | null = null;
  private goldBody!: CanvasGradient;
  private tips = new Float32Array(MAX_TIPS * 2);
  private ntips = 0;
  private hx = 0;
  private hy = 0;
  private z = 0;
  private vz = 0;
  private shake = 0;
  private grabs = new Map<number, Grab>();
  private pressure = 0;
  private pourX = 0;
  private pourY = 0;
  private pourNode = -1;
  private shelf: Shelved[] = [];
  private flying: Shelved | null = null;
  private shelfY = 0;
  private dust: { x: number; y: number; vx: number; vy: number; life: number; s: number }[] = [];
  private sparks: { x: number; y: number; t: number; life: number; s: number }[] = [];
  private hint: HTMLElement;
  private hintText = '';
  private style: HTMLStyleElement;
  private trickle;
  private celebrations = 0;
  private lastBounce = 0;
  private prep: Prep | null = null;
  /** Seconds the gold has sat still with seams left to fill. */
  private stall = 0;

  constructor(private ctx: ToyContext) {
    const g = ctx.canvas.getContext('2d', { alpha: false });
    if (!g) throw new Error('Canvas 2D is not available.');
    this.g = g;
    this.S = ctx.pixelRatio;
    this.bg = document.createElement('canvas');
    this.trickle = ctx.sound.loop('trickle');
    this.style = document.createElement('style');
    this.style.textContent = STYLE;
    document.head.appendChild(this.style);
    this.hint = document.createElement('div');
    this.hint.className = 'kin-hint';
    ctx.overlay.append(this.hint);
    for (let k = 0; k < 48; k++) this.dust.push({ x: 0, y: 0, vx: 0, vy: 0, life: 0, s: 1 });
    for (let k = 0; k < 20; k++) this.sparks.push({ x: 0, y: 0, t: 1, life: 0, s: 1 });
    ctx.panel.slider(params, 'viscosity', { label: 'Gold viscosity', min: 0.3, max: 3, step: 0.05 });
    ctx.panel.slider(params, 'assist', { label: 'Snap assist', min: 0.4, max: 2.5, step: 0.05 });
    ctx.panel.action('Next piece', () => this.next());
    ctx.panel.action('Drop it again', () => this.newPiece());
    this.width = ctx.canvas.width;
    this.height = ctx.canvas.height;
    this.layout();
    this.newPiece();
    ctx.progress(0, 'mended');
    if (import.meta.env.DEV) {
      const css = (v: number) => Math.round((v / this.S) * 10) / 10;
      (window as unknown as Record<string, unknown>).__kintsugi = () => ({
        phase: this.phase,
        piece: this.def.name,
        round: this.round,
        celebrations: this.celebrations,
        gold: Math.round(this.gold.fraction * 1000) / 1000,
        seams: this.frac.seams.length,
        shelf: this.shelf.length,
        shards: this.shards.map((s) => ({ x: css(s.x), y: css(s.y), hx: css(this.hx + s.hx), hy: css(this.hy + s.hy), a: Math.round(s.a * 100) / 100, z: css(s.z), seated: s.seated })),
        // A few seam points in CSS pixels, for aiming pours.
        seamPts: this.frac.seams.map((m, k) => ({ x: css(this.hx + m.pts[m.pts.length >> 2 << 1]), y: css(this.hy + m.pts[(m.pts.length >> 2 << 1) + 1]), full: !!this.gold.seamFull[k] })),
      });
      const w = window as unknown as Record<string, unknown>;
      w.__kintsugiNext = () => this.next();
      // Seat everything and gild it: for looking at finished pieces quickly.
      w.__kintsugiSolve = () => {
        if (this.phase === 'hover' || this.phase === 'fall') this.shatter();
        for (const s of this.shards) if (!s.seated) this.seat(s);
        this.gold.wetNode(this.gold.sa[0]);
      };
    }
  }

  // ---------------------------------------------------------------- setup

  private layout() {
    const { width: W, height: H } = this;
    this.shelfY = Math.round(H * 0.215);
    this.hx = Math.round(W / 2);
    this.hy = Math.round(H * 0.445);
    this.prep = null;
    this.paintBackground();
  }

  private next() {
    this.round++;
    this.newPiece();
  }

  private prepare(round: number): Prep {
    const shape = makeShape(PIECES[round % PIECES.length], this.width * 0.66, this.height * 0.27);
    return { round, shape, painter: paintPiece(shape, this.S), frac: null };
  }

  /** Later rounds of the same piece break into more, smaller shards. */
  private shardCount(round: number) {
    return Math.min(15, PIECES[round % PIECES.length].shards + Math.floor(round / PIECES.length) * 2);
  }

  private newPiece() {
    const prep = this.prep?.round === this.round ? this.prep : this.prepare(this.round);
    this.prep = null;
    while (!prep.painter.step(1e9));
    this.def = prep.shape.def;
    this.shape = prep.shape;
    this.frac = prep.frac ?? fracture(this.shape, this.shardCount(this.round));
    this.image = prep.painter.canvas;
    this.wox = prep.painter.ox;
    this.woy = prep.painter.oy;
    this.silhouette = polyPath(this.frac.outline, 0, 0);
    this.bakeWhole();
    this.shards = this.frac.shards.map((geo, i) => this.bakeShard(geo.poly, geo.cx, geo.cy, i));
    this.order = this.shards.slice();
    this.seated = this.shards.map(() => false);
    this.gold = new GoldNet(this.frac.seams, this.frac.vertexCount);
    this.goldPath = null;
    this.crackPath = null;
    this.makeGoldGradient();
    this.phase = 'hover';
    this.phaseT = 0;
    this.z = 170 * this.S;
    this.vz = 0;
    this.grabs.clear();
    this.pressure = 0;
    this.stall = 0;
    this.setHint('Tap to drop it');
  }

  private makeGoldGradient() {
    const { h } = this.shape;
    const gr = this.g.createLinearGradient(-h * 0.3, -h * 0.55, h * 0.3, h * 0.55);
    gr.addColorStop(0, '#a86d14');
    gr.addColorStop(0.16, '#f5cf5c');
    gr.addColorStop(0.3, '#b87c18');
    gr.addColorStop(0.46, '#ffe68e');
    gr.addColorStop(0.52, '#fff4c4');
    gr.addColorStop(0.64, '#c98b1e');
    gr.addColorStop(0.8, '#f7d468');
    gr.addColorStop(1, '#9a6210');
    this.goldBody = gr;
  }

  /** The unbroken piece and its soft drop shadow. */
  private bakeWhole() {
    const { S } = this;
    const iw = this.image.width, ih = this.image.height;
    const c = document.createElement('canvas');
    c.width = iw;
    c.height = ih;
    const g = c.getContext('2d')!;
    g.translate(this.wox, this.woy);
    g.fill(this.silhouette);
    g.globalCompositeOperation = 'source-in';
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(this.image, 0, 0);
    this.whole = c;
    this.wholeShadow = shadowSprite(this.frac.outline, 0, 0, 7 * S, 0.5).canvas;
  }

  private bakeShard(poly: number[], cx: number, cy: number, i: number): Shard {
    const { S } = this;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const local: number[] = [];
    for (let k = 0; k < poly.length; k += 2) {
      const x = poly[k] - cx, y = poly[k + 1] - cy;
      local.push(x, y);
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
    // Sprite pixels line up with the piece image, so seated shards redraw it exactly.
    const pad = 2;
    const ix0 = Math.floor(this.wox + cx + x0) - pad, iy0 = Math.floor(this.woy + cy + y0) - pad;
    const sw = Math.ceil(x1 - x0) + pad * 2 + 2, shh = Math.ceil(y1 - y0) + pad * 2 + 2;
    const c = document.createElement('canvas');
    c.width = sw;
    c.height = shh;
    const g = c.getContext('2d')!;
    const ax = this.wox - ix0, ay = this.woy - iy0; // piece origin in sprite pixels
    g.save();
    g.fill(polyPath(poly, ax, ay));
    g.globalCompositeOperation = 'source-in';
    g.drawImage(this.image, -ix0, -iy0);
    g.globalCompositeOperation = 'source-atop';
    // Broken edges show the fired body under the glaze.
    g.strokeStyle = this.def.bisque;
    g.lineWidth = 2.4 * S;
    g.lineJoin = 'round';
    g.beginPath();
    for (const m of this.frac.seams) {
      if (m.i !== i && m.j !== i) continue;
      g.moveTo(m.pts[0] + ax, m.pts[1] + ay);
      for (let k = 2; k < m.pts.length; k += 2) g.lineTo(m.pts[k] + ax, m.pts[k + 1] + ay);
    }
    g.stroke();
    g.restore();
    let r = 0;
    for (let k = 0; k < local.length; k += 2) r = Math.max(r, Math.hypot(local[k], local[k + 1]));
    const area = Math.abs(polyArea(local));
    const sh = shadowSprite(local, 0, 0, 5 * S, 0.55);
    return {
      sprite: c, shadow: sh.canvas,
      sx: ix0 - this.wox - cx, sy: iy0 - this.woy - cy,
      shx: sh.x, shy: sh.y,
      poly: local, path: polyPath(local, 0, 0),
      hx: cx, hy: cy,
      x: this.hx + cx, y: this.hy + cy, a: 0, vx: 0, vy: 0, w: 0, z: 0, vz: 0,
      r, rIn: Math.sqrt(area / Math.PI),
      seated: false, seatT: -1, fx: 0, fy: 0, fa: 0, flash: 0, held: false, lift: 0,
    };
  }

  private paintBackground() {
    const { width: W, height: H, S } = this;
    const c = this.bg;
    c.width = W;
    c.height = H;
    const g = c.getContext('2d')!;
    const sy = this.shelfY;
    // Indigo work cloth.
    const cloth = g.createLinearGradient(0, 0, 0, H);
    cloth.addColorStop(0, '#1a2236');
    cloth.addColorStop(0.3, '#1f2b47');
    cloth.addColorStop(1, '#172038');
    g.fillStyle = cloth;
    g.fillRect(0, 0, W, H);
    // Hitomezashi sashiko: running stitches whose offsets flip at random per line.
    const step = 22 * S, dash = step;
    g.strokeStyle = 'rgba(214,224,246,0.075)';
    g.lineWidth = 1.4 * S;
    g.lineCap = 'round';
    g.beginPath();
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let y = sy + step; y < H; y += step) {
      const off = rnd() < 0.5 ? 0 : dash;
      for (let x = off - dash * 2; x < W; x += dash * 2) {
        g.moveTo(x + 2 * S, y);
        g.lineTo(x + dash - 2 * S, y);
      }
    }
    for (let x = step / 2; x < W; x += step) {
      const off = rnd() < 0.5 ? 0 : dash;
      for (let y = sy + off - dash * 2; y < H; y += dash * 2) {
        if (y + dash < sy) continue;
        g.moveTo(x, Math.max(sy + 4 * S, y + 2 * S));
        g.lineTo(x, y + dash - 2 * S);
      }
    }
    g.stroke();
    // Soft pool of light where the piece is mended.
    const spot = g.createRadialGradient(this.hx, this.hy, 0, this.hx, this.hy, W * 0.62);
    spot.addColorStop(0, 'rgba(150,176,230,0.2)');
    spot.addColorStop(1, 'rgba(150,176,230,0)');
    g.fillStyle = spot;
    g.fillRect(0, 0, W, H);
    // Wall above the shelf.
    const wall = g.createLinearGradient(0, 0, 0, sy);
    wall.addColorStop(0, '#11151f');
    wall.addColorStop(1, '#1b2133');
    g.fillStyle = wall;
    g.fillRect(0, 0, W, sy);
    // Hinoki shelf plank: top face, grain, front edge, cast shadow.
    const top = 9 * S, edge = 9 * S;
    const shadow = g.createLinearGradient(0, sy + edge, 0, sy + edge + 26 * S);
    shadow.addColorStop(0, 'rgba(0,0,0,0.45)');
    shadow.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = shadow;
    g.fillRect(0, sy + edge, W, 26 * S);
    const face = g.createLinearGradient(0, sy - top, 0, sy);
    face.addColorStop(0, '#caa071');
    face.addColorStop(1, '#e2bd8c');
    g.fillStyle = face;
    g.fillRect(0, sy - top, W, top);
    const front = g.createLinearGradient(0, sy, 0, sy + edge);
    front.addColorStop(0, '#b3844f');
    front.addColorStop(1, '#8d6238');
    g.fillStyle = front;
    g.fillRect(0, sy, W, edge);
    g.strokeStyle = 'rgba(120,80,40,0.25)';
    g.lineWidth = 1 * S;
    for (let k = 0; k < 7; k++) {
      const y = sy + edge * (0.2 + 0.12 * k);
      g.beginPath();
      g.moveTo(0, y);
      for (let x = 0; x <= W; x += 20 * S) g.lineTo(x, y + Math.sin(x * 0.01 / S + k * 1.7) * 1.2 * S);
      g.stroke();
    }
    g.fillStyle = 'rgba(255,240,210,0.35)';
    g.fillRect(0, sy - top, W, 1 * S);
    // Vignette.
    const vg = g.createRadialGradient(W / 2, H * 0.5, H * 0.3, W / 2, H * 0.5, H * 0.75);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,0.4)');
    g.fillStyle = vg;
    g.fillRect(0, 0, W, H);
  }

  private setHint(t: string) {
    if (t === this.hintText) return;
    this.hintText = t;
    this.hint.textContent = t;
    this.hint.classList.toggle('show', !!t);
  }

  // ---------------------------------------------------------------- frame

  frame(dt: number, t: number) {
    this.time = t;
    this.phaseT += dt;
    this.input(dt);
    const { S } = this;
    switch (this.phase) {
      case 'hover':
        // Payoff first: if nobody taps, it drops by itself.
        if (this.phaseT > (this.round === 0 && this.shelf.length === 0 ? 0.8 : 3.5)) this.drop();
        break;
      case 'fall':
        this.vz -= G * S * dt;
        this.z += this.vz * dt;
        if (this.z <= 0) this.shatter();
        break;
      case 'broken':
        this.stepShards(dt);
        this.stepGold(dt);
        break;
      case 'done':
        this.stepShards(dt);
        this.stepGold(dt);
        if (this.phaseT > 2.4) this.startShelve();
        break;
      case 'shelve':
        if (this.phaseT > 0.9) {
          if (this.flying) {
            if (this.shelf.length >= SHELF) this.shelf.shift();
            this.shelf.push(this.flying);
          }
          this.flying = null;
          while (this.shelf.length > SHELF) this.shelf.shift();
          this.next();
        }
        break;
    }
    if (this.phase === 'done' || this.phase === 'shelve') {
      if (this.prep?.round !== this.round + 1) this.prep = this.prepare(this.round + 1);
      const pr = this.prep;
      if (pr.painter.step(2.5) && !pr.frac) pr.frac = fracture(pr.shape, this.shardCount(pr.round));
    }
    this.stepFx(dt);
    this.shake = Math.max(0, this.shake - dt);
    this.trickle.set(this.phase === 'broken' || this.phase === 'done' ? Math.min(1, this.gold.fronts / 5) * (0.4 + 0.6 * this.pressure) : 0, 0.7);
    this.draw();
    // Fitting shards counts too, so the ring moves from the first seated piece, not only once gold flows.
    const fitted = this.shards.length ? this.shards.filter((sh) => sh.seated).length / this.shards.length : 0;
    this.ctx.progress(this.phase === 'shelve' ? 1 : 0.4 * fitted + 0.6 * this.gold.fraction, 'mended');
    let sn = 0;
    for (const b of this.seated) if (b) sn++;
    const n = this.shards.length;
    this.ctx.setStatus(`${this.def.name} · ${sn}/${n} shards · ${Math.round(this.gold.fraction * 100)}% gold`);
  }

  private input(dt: number) {
    const P = this.ctx.pointers;
    for (const p of P.active.values()) {
      const x = p.x * this.width, y = (1 - p.y) * this.height;
      let gr = this.grabs.get(p.id);
      if (!gr && p.justDown) gr = this.begin(p.id, x, y);
      if (!gr) continue;
      if (gr.kind === 'shard' && gr.shard) this.drag(gr.shard, x + gr.ox, y + gr.oy, dt, p.id);
      else if (gr.kind === 'pour') this.pour(gr, x, y);
    }
    for (const [id, gr] of this.grabs) {
      if (P.active.has(id)) continue;
      if (gr.kind === 'shard' && gr.shard) this.release(gr.shard);
      this.grabs.delete(id);
    }
    let pouring = false;
    for (const gr of this.grabs.values()) if (gr.kind === 'pour' && gr.node >= 0) pouring = true;
    this.pressure += ((pouring ? 1 : 0) - this.pressure) * Math.min(1, dt * (pouring ? 8 : 2));
  }

  private begin(id: number, x: number, y: number): Grab | undefined {
    if (this.phase === 'hover') {
      this.drop();
      return;
    }
    if (this.phase !== 'broken') return;
    // Topmost loose shard under the finger, or the nearest one within a fingertip.
    let hit: Shard | null = null;
    for (let k = this.order.length - 1; k >= 0 && !hit; k--) {
      const s = this.order[k];
      if (s.seated || s.held) continue;
      const c = Math.cos(-s.a), sn = Math.sin(-s.a);
      const lx = (x - s.x) * c - (y - s.y) * sn, ly = (x - s.x) * sn + (y - s.y) * c;
      if (inPoly(s.poly, lx, ly)) hit = s;
    }
    if (!hit) {
      let bd = (26 * this.S) ** 2;
      for (const s of this.shards) {
        if (s.seated || s.held) continue;
        const d = (s.x - x) ** 2 + (s.y - y) ** 2 - s.rIn * s.rIn;
        if (d < bd) [hit, bd] = [s, d];
      }
    }
    if (hit) {
      hit.held = true;
      hit.vx = hit.vy = hit.w = 0;
      this.order.splice(this.order.indexOf(hit), 1);
      this.order.push(hit);
      this.ctx.sound.play('tick', { pitch: 0.8, gain: 0.35 });
      const gr: Grab = { kind: 'shard', shard: hit, ox: hit.x - x, oy: hit.y - y, node: -1, warned: false };
      this.grabs.set(id, gr);
      return gr;
    }
    // Otherwise it's a pour, if the finger is over the piece.
    const { w, h } = this.shape;
    const m = 40 * this.S;
    if (Math.abs(x - this.hx) < w / 2 + m && Math.abs(y - 56 * this.S - this.hy) < h / 2 + m * 2) {
      const gr: Grab = { kind: 'pour', shard: null, ox: 0, oy: 0, node: -1, warned: false };
      this.grabs.set(id, gr);
      return gr;
    }
  }

  private drag(s: Shard, tx: number, ty: number, dt: number, id: number) {
    const { S } = this;
    const homeX = this.hx + s.hx, homeY = this.hy + s.hy;
    // Magnetic assist: the closer to its fit, the harder the pull.
    const assist = 64 * S * params.assist;
    const d = Math.hypot(tx - homeX, ty - homeY);
    const pull = d < assist ? (1 - d / assist) ** 2 * 0.85 : 0;
    const gx = tx + (homeX - tx) * pull, gy = ty + (homeY - ty) * pull;
    const k = Math.min(1, dt * 30);
    s.x += (gx - s.x) * k;
    s.y += (gy - s.y) * k;
    // Lifted shards turn to face their fit, so dragging alone is enough.
    s.a = wrap(s.a);
    s.a *= Math.exp(-dt * (7 + pull * 20));
    s.lift += (1 - s.lift) * Math.min(1, dt * 14);
    s.z = 16 * S * s.lift;
    const snap = 20 * S * params.assist;
    if (Math.hypot(s.x - homeX, s.y - homeY) < snap && Math.abs(s.a) < 0.3) {
      this.grabs.delete(id);
      this.seat(s);
    }
  }

  private release(s: Shard) {
    s.held = false;
    if (s.seated) return;
    const d = Math.hypot(s.x - this.hx - s.hx, s.y - this.hy - s.hy);
    if (d < 64 * this.S * params.assist * 1.1) return this.seat(s);
    s.vz = 0;
  }

  private seat(s: Shard) {
    s.held = false;
    s.seated = true;
    s.seatT = 0;
    s.fx = s.x;
    s.fy = s.y;
    s.fa = wrap(s.a);
    s.vx = s.vy = s.w = s.vz = 0;
    this.seated[this.shards.indexOf(s)] = true;
    this.gold.updateOpen(this.seated);
    this.crackPath = null;
    this.goldPath = null;
  }

  private pour(gr: Grab, x: number, y: number) {
    const { S } = this;
    // Aim above the finger so the landing point stays visible.
    const ax = x, ay = y - 56 * S;
    const n = this.gold.nearestOpen(ax - this.hx, ay - this.hy, 60 * S);
    this.pourX = ax;
    this.pourY = ay;
    if (n < 0) {
      gr.node = -1;
      if (!gr.warned && !this.gold.anyOpen()) {
        gr.warned = true;
        this.setHint('Seat two neighbouring shards first');
      }
      return;
    }
    if (gr.node < 0) {
      this.ctx.sound.play('plop', { pitch: 0.6, gain: 0.5 });
      this.ctx.haptic('light');
    }
    gr.node = n;
    this.pourNode = n;
    this.gold.wetNode(n);
  }

  private drop() {
    if (this.phase !== 'hover') return;
    this.phase = 'fall';
    this.phaseT = 0;
    this.vz = -300 * this.S;
    this.setHint('');
    this.ctx.sound.play('whoosh', { pitch: 0.8, gain: 0.5 });
  }

  private shatter() {
    const { S } = this;
    this.phase = 'broken';
    this.phaseT = 0;
    this.z = 0;
    this.shake = 0.28;
    const ix = this.hx + (Math.random() - 0.5) * this.shape.w * 0.3;
    const iy = this.hy + this.shape.h * (this.def.plate ? 0.1 : 0.4);
    for (const s of this.shards) {
      s.x = this.hx + s.hx;
      s.y = this.hy + s.hy;
      let dx = s.x - ix, dy = s.y - iy;
      const l = Math.hypot(dx, dy) || 1;
      dx /= l;
      dy /= l;
      const sp = (300 + Math.random() * 420) * S;
      // Biased down onto the open cloth, where there's room to sort them.
      s.vx = dx * sp + (Math.random() - 0.5) * 120 * S;
      s.vy = dy * sp * 0.45 + (220 + Math.random() * 380) * S;
      s.vz = (260 + Math.random() * 300) * S;
      s.z = 0;
      s.w = (Math.random() < 0.5 ? -1 : 1) * (5 + Math.random() * 9);
      s.a = 0;
    }
    for (const d of this.dust) {
      const a = Math.random() * Math.PI * 2, sp = (60 + Math.random() * 380) * S;
      d.x = ix + (Math.random() - 0.5) * 30 * S;
      d.y = iy;
      d.vx = Math.cos(a) * sp;
      d.vy = Math.sin(a) * sp * 0.7 - 80 * S;
      d.life = 0.4 + Math.random() * 0.6;
      d.s = (1 + Math.random() * 2.2) * S;
    }
    const snd = this.ctx.sound;
    snd.play('snap', { pitch: 1.25, gain: 1 });
    snd.play('knock', { pitch: 0.75, gain: 1 });
    snd.play('crumble', { pitch: 1.8, gain: 0.7 });
    snd.play('tick', { pitch: 2.2, gain: 0.8 });
    this.ctx.haptic('heavy');
    this.setHint('Drag the shards back into place');
  }

  // ---------------------------------------------------------------- simulation

  private stepShards(dt: number) {
    const { S, width: W, height: H } = this;
    const top = this.shelfY + 20 * S, bottom = H - 16 * S;
    const bw = this.shape.w / 2 + 14 * S, bh = this.shape.h / 2 + 14 * S;
    const sideRoom = W / 2 - bw;
    for (const s of this.shards) {
      if (s.seated) {
        if (s.seatT >= 0 && s.seatT < 1) {
          s.seatT = Math.min(1, s.seatT + dt / 0.09);
          const e = 1 - (1 - s.seatT) ** 3;
          s.x = s.fx + (this.hx + s.hx - s.fx) * e;
          s.y = s.fy + (this.hy + s.hy - s.fy) * e;
          s.a = s.fa * (1 - e);
          s.z = 16 * S * s.lift * (1 - e);
          if (s.seatT >= 1) this.landed(s);
        }
        s.flash = Math.max(0, s.flash - dt * 3);
        continue;
      }
      if (s.held) continue;
      s.lift = Math.max(0, s.lift - dt * 6);
      // A little hop and tumble, then friction on the cloth.
      if (s.z > 0 || s.vz > 0) {
        s.vz -= G * S * dt;
        s.z += s.vz * dt;
        if (s.z <= 0) {
          s.z = 0;
          const hit = -s.vz;
          if (hit > 90 * S) {
            s.vz = hit * 0.36;
            s.w *= 0.6;
            s.vx *= 0.75;
            s.vy *= 0.75;
            if (this.time - this.lastBounce > 0.03) {
              this.lastBounce = this.time;
              const small = Math.min(1, s.rIn / (40 * S));
              this.ctx.sound.play(hit > 400 * S ? 'knock' : 'tick', { pitch: 1.9 - small * 0.6, gain: Math.min(1, hit / (900 * S)), pan: (s.x / W) * 2 - 1 });
            }
          } else s.vz = 0;
        }
      }
      if (s.z === 0) {
        const f = Math.exp(-dt * 4.2);
        s.vx *= f;
        s.vy *= f;
        s.w *= Math.exp(-dt * 5);
        // Loose shards slide off the mending spot so it stays clear.
        const dx = s.x - this.hx, dy = s.y - this.hy;
        const px = bw + s.rIn * 0.5 - Math.abs(dx), py = bh + s.rIn * 0.5 - Math.abs(dy);
        if (px > 0 && py > 0) {
          const push = 1500 * S * dt;
          if (px < py * 0.8 && sideRoom > s.rIn * 1.2) s.vx += Math.sign(dx || 1) * push;
          else s.vy += push;
        }
      } else {
        s.vx *= Math.exp(-dt * 0.3);
        s.vy *= Math.exp(-dt * 0.3);
      }
      s.x += s.vx * dt;
      s.y += s.vy * dt;
      s.a += s.w * dt;
      // The cloth's edges.
      const m = Math.min(s.r, s.rIn * 1.3);
      if (s.x < m) [s.x, s.vx] = [m, Math.abs(s.vx) * 0.4];
      if (s.x > W - m) [s.x, s.vx] = [W - m, -Math.abs(s.vx) * 0.4];
      if (s.y < top + m * 0.6) [s.y, s.vy] = [top + m * 0.6, Math.abs(s.vy) * 0.4];
      if (s.y > bottom - m) [s.y, s.vy] = [bottom - m, -Math.abs(s.vy) * 0.4];
    }
    // Resting shards nudge each other apart.
    const n = this.shards.length;
    for (let i = 0; i < n; i++) {
      const a = this.shards[i];
      if (a.seated || a.held || a.z > 2 * S) continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.shards[j];
        if (b.seated || b.held || b.z > 2 * S) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const rr = (a.rIn + b.rIn) * 0.85;
        const d2 = dx * dx + dy * dy;
        if (d2 >= rr * rr || d2 < 1e-6) continue;
        const d = Math.sqrt(d2);
        const push = ((rr - d) / d) * Math.min(1, dt * 6) * 0.5;
        a.x -= dx * push;
        a.y -= dy * push;
        b.x += dx * push;
        b.y += dy * push;
      }
    }
  }

  /** The click: a shard has landed in its fit. */
  private landed(s: Shard) {
    const { S } = this;
    s.x = this.hx + s.hx;
    s.y = this.hy + s.hy;
    s.a = 0;
    s.z = 0;
    s.flash = 1;
    const snd = this.ctx.sound;
    snd.play('tick', { pitch: 1.5 + Math.random() * 0.2, gain: 1 });
    snd.play('knock', { pitch: 2.4, gain: 0.35 });
    this.ctx.haptic('medium');
    // A puff of porcelain dust along the join.
    let k = 0;
    for (const d of this.dust) {
      if (d.life > 0 || k >= 10) continue;
      const q = (Math.floor(Math.random() * (s.poly.length / 2)) * 2);
      d.x = s.x + s.poly[q];
      d.y = s.y + s.poly[q + 1];
      const a = Math.random() * Math.PI * 2, sp = (20 + Math.random() * 60) * S;
      d.vx = Math.cos(a) * sp;
      d.vy = Math.sin(a) * sp;
      d.life = 0.3 + Math.random() * 0.3;
      d.s = (0.8 + Math.random()) * S;
      k++;
    }
    const all = this.seated.every(Boolean);
    this.setHint(all ? 'Hold on a crack to pour the gold' : this.gold.anyOpen() && !this.gold.wet.some(Boolean) ? 'Hold on a crack to pour gold — or keep fitting' : 'Drag the shards back into place');
  }

  private stepGold(dt: number) {
    const gold = this.gold;
    const was = gold.filledLen;
    gold.step(dt, (250 * this.S * (0.7 + 0.3 * this.pressure)) / params.viscosity);
    if (gold.justCompleted && !gold.done) {
      this.ctx.haptic('light');
      this.ctx.sound.play('tick', { pitch: 2.6, gain: 0.5 });
    }
    // Some cracks run edge to edge without meeting the others: each needs its own pour.
    const stalled = gold.fronts === 0 && gold.filledLen > 0 && !gold.done && this.seated.every(Boolean);
    this.stall = stalled ? this.stall + dt : 0;
    if (this.stall > 0.6 && this.phase === 'broken') this.setHint('Pour on the other cracks too');
    if (gold.filledLen > was) {
      // Glints sprinkle over freshly gilded seams.
      this.spark(gold.done ? 0 : 0.35);
    }
    if (this.phase === 'broken' && gold.done && this.seated.every(Boolean) && this.shards.every((s) => s.seatT >= 1)) {
      this.phase = 'done';
      this.phaseT = 0;
      this.celebrations++;
      this.ctx.sound.play('chime', { pitch: 1, gain: 1 });
      this.ctx.sound.play('chime', { pitch: 1.5, gain: 0.6 });
      this.ctx.haptic('heavy');
      this.ctx.celebrate(`${this.def.name} mended in gold`);
      this.setHint('');
      for (let k = 0; k < 14; k++) this.spark(1);
    }
  }

  private spark(chance: number) {
    if (Math.random() > chance && chance < 1) return;
    const gold = this.gold;
    for (let tries = 0; tries < 6; tries++) {
      const s = Math.floor(Math.random() * gold.segCount);
      if (!gold.full[s]) continue;
      for (const sp of this.sparks) {
        if (sp.t < 1) continue;
        sp.x = gold.nx[gold.sa[s]];
        sp.y = gold.ny[gold.sa[s]];
        sp.t = 0;
        sp.life = 0.35 + Math.random() * 0.4;
        sp.s = (3 + Math.random() * 4) * this.S;
        return;
      }
      return;
    }
  }

  private stepFx(dt: number) {
    for (const d of this.dust) {
      if (d.life <= 0) continue;
      d.life -= dt;
      d.vx *= Math.exp(-dt * 5);
      d.vy *= Math.exp(-dt * 5);
      d.x += d.vx * dt;
      d.y += d.vy * dt;
    }
    for (const sp of this.sparks) if (sp.t < 1) sp.t += dt / sp.life;
    // Ambient twinkle on finished gold.
    if (this.phase === 'done' || (this.gold.filledLen > 0 && Math.random() < dt * 3)) this.spark(this.phase === 'done' ? dt * 10 : 1);
  }

  private startShelve() {
    this.phase = 'shelve';
    this.phaseT = 0;
    // Bake the mended piece for the shelf.
    const iw = this.image.width, ih = this.image.height;
    const c = document.createElement('canvas');
    c.width = iw;
    c.height = ih;
    const g = c.getContext('2d')!;
    for (const s of this.shards) g.drawImage(s.sprite, this.wox + s.hx + s.sx, this.woy + s.hy + s.sy);
    g.translate(this.wox, this.woy);
    this.goldPath = null;
    this.drawGold(g, 0, false);
    this.flying = { img: c, w: iw, h: ih };
    this.ctx.sound.play('whoosh', { pitch: 1.2, gain: 0.4 });
  }

  // ---------------------------------------------------------------- draw

  private draw() {
    const { g, S } = this;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.globalAlpha = 1;
    g.globalCompositeOperation = 'source-over';
    g.drawImage(this.bg, 0, 0);
    this.drawShelf();
    if (this.shake > 0) {
      const m = this.shake * 40 * S;
      g.setTransform(1, 0, 0, 1, (Math.random() - 0.5) * m, (Math.random() - 0.5) * m);
    }
    const hx = this.hx, hy = this.hy;
    if (this.phase === 'hover' || this.phase === 'fall') {
      const z = this.phase === 'hover' ? this.z + Math.sin(this.time * 2.4) * 6 * S : this.z;
      const sc = 1 + z / (1100 * S);
      g.globalAlpha = Math.max(0.25, 1 - z / (500 * S));
      g.drawImage(this.wholeShadow, hx - this.wholeShadow.width / 2 + z * 0.18 + 3 * S, hy - this.wholeShadow.height / 2 + z * 0.3 + 5 * S);
      g.globalAlpha = 1;
      g.setTransform(sc, 0, 0, sc, hx, hy - z * 0.12);
      g.drawImage(this.whole, -this.wox, -this.woy);
      g.setTransform(1, 0, 0, 1, 0, 0);
      return;
    }
    if (this.phase === 'shelve') return this.drawFlying();

    // Ghost of the piece where it's mended.
    g.setTransform(1, 0, 0, 1, hx, hy);
    const allSeated = this.seated.every(Boolean);
    if (!allSeated) {
      g.fillStyle = 'rgba(200,215,245,0.06)';
      g.fill(this.silhouette);
      g.setLineDash([5 * S, 6 * S]);
      g.strokeStyle = 'rgba(220,230,250,0.28)';
      g.lineWidth = 1.5 * S;
      g.stroke(this.silhouette);
      g.setLineDash([]);
    }
    // Seated shards, then the hairline cracks and the gold over them.
    for (const s of this.shards) if (s.seated) this.drawShard(s, false);
    g.setTransform(1, 0, 0, 1, hx, hy);
    if (!this.crackPath) {
      this.crackPath = new Path2D();
      this.gold.traceOpen(this.crackPath);
    }
    g.lineJoin = 'round';
    g.lineCap = 'round';
    g.strokeStyle = this.def.pattern === 'hare' ? 'rgba(10,6,4,0.8)' : 'rgba(40,36,44,0.55)';
    g.lineWidth = 1.1 * S;
    g.stroke(this.crackPath);
    if (this.stall > 0.6) {
      // Unfilled cracks glow softly to show where to pour next.
      g.strokeStyle = `rgba(255,214,120,${0.25 + 0.2 * Math.sin(this.time * 5)})`;
      g.lineWidth = 2.6 * S;
      g.stroke(this.crackPath);
    }
    this.drawGold(g, this.time, true);
    g.setTransform(1, 0, 0, 1, hx, hy);
    this.drawSparks();
    if (this.phase === 'done') this.drawSheen();
    this.drawPour();
    // Highlight the fit of every shard in hand.
    for (const s of this.shards) {
      if (!s.held) continue;
      g.setTransform(1, 0, 0, 1, hx + s.hx, hy + s.hy);
      g.strokeStyle = 'rgba(255,236,170,0.75)';
      g.lineWidth = 2 * S;
      g.stroke(s.path);
      g.fillStyle = 'rgba(255,236,170,0.08)';
      g.fill(s.path);
    }
    // Loose shards, low to high, the held ones on top.
    this.order.sort((a, b) => (a.held ? 1 : 0) - (b.held ? 1 : 0) || a.z - b.z);
    for (const s of this.order) if (!s.seated) this.drawShard(s, true);
    g.setTransform(1, 0, 0, 1, 0, 0);
    // Dust
    g.fillStyle = this.def.pattern === 'hare' ? '#cfae8a' : '#f4f1ea';
    for (const d of this.dust) {
      if (d.life <= 0) continue;
      g.globalAlpha = Math.min(1, d.life * 2.5);
      g.fillRect(d.x - d.s / 2, d.y - d.s / 2, d.s, d.s);
    }
    g.globalAlpha = 1;
  }

  private drawShard(s: Shard, shadow: boolean) {
    const { g, S } = this;
    const sc = 1 + s.z / (420 * S);
    if (shadow) {
      g.setTransform(1, 0, 0, 1, s.x + 2 * S + s.z * 0.4, s.y + 3 * S + s.z * 0.65);
      g.rotate(s.a);
      g.globalAlpha = Math.max(0.35, 1 - s.z / (200 * S));
      g.drawImage(s.shadow, s.shx, s.shy);
      g.globalAlpha = 1;
    }
    const c = Math.cos(s.a) * sc, sn = Math.sin(s.a) * sc;
    g.setTransform(c, sn, -sn, c, s.x, s.y);
    g.drawImage(s.sprite, s.sx, s.sy);
    if (s.flash > 0) {
      g.globalCompositeOperation = 'lighter';
      g.globalAlpha = s.flash * 0.45;
      g.drawImage(s.sprite, s.sx, s.sy);
      g.globalAlpha = 1;
      g.globalCompositeOperation = 'source-over';
    }
  }

  /** Gold in piece-local coordinates (the caller sets the transform). */
  private drawGold(g: CanvasRenderingContext2D, t: number, live: boolean) {
    const { S } = this;
    if (!this.goldPath || this.gold.changed) {
      this.goldPath = new Path2D();
      this.ntips = this.gold.trace(this.goldPath, this.tips);
      this.gold.changed = false;
    }
    if (this.gold.filledLen <= 0 && this.ntips === 0) return;
    const p = this.goldPath;
    const w = 3.8 * S;
    g.save();
    g.lineJoin = 'round';
    g.lineCap = 'round';
    // Raised bead: a cast shadow, a dark rim, the metal, then a hard specular ridge.
    g.translate(0.6 * S, 1.2 * S);
    g.strokeStyle = 'rgba(30,16,4,0.42)';
    g.lineWidth = w * 1.55;
    g.stroke(p);
    g.translate(-0.6 * S, -1.2 * S);
    g.strokeStyle = '#5e3806';
    g.lineWidth = w * 1.28;
    g.stroke(p);
    g.strokeStyle = this.goldBody;
    g.lineWidth = w;
    g.stroke(p);
    if (live) {
      // A band of light sweeps across the gold.
      const { h } = this.shape;
      const c = ((t * 0.45) % 1.8) - 0.4;
      const band = g.createLinearGradient(-h * 0.8, -h * 0.8, h * 0.8, h * 0.8);
      const a = Math.max(0, Math.min(1, c - 0.1)), b = Math.max(0, Math.min(1, c)), e = Math.max(0, Math.min(1, c + 0.1));
      band.addColorStop(a, 'rgba(255,250,220,0)');
      band.addColorStop(b, 'rgba(255,250,225,0.95)');
      band.addColorStop(e, 'rgba(255,250,220,0)');
      g.strokeStyle = band;
      g.lineWidth = w * 0.8;
      g.stroke(p);
    }
    g.translate(-0.45 * S, -0.7 * S);
    g.strokeStyle = 'rgba(255,248,214,0.8)';
    g.lineWidth = w * 0.3;
    g.stroke(p);
    g.restore();
    if (!live) return;
    // Molten beads at the racing fronts.
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = 'rgba(255,170,50,0.22)';
    for (let k = 0; k < this.ntips; k++) {
      g.beginPath();
      g.arc(this.tips[2 * k], this.tips[2 * k + 1], w * 1.25, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = 'rgba(255,248,215,0.95)';
    for (let k = 0; k < this.ntips; k++) {
      g.beginPath();
      g.arc(this.tips[2 * k], this.tips[2 * k + 1], w * 0.62, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  private drawSparks() {
    const { g, S } = this;
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(255,250,225,0.95)';
    g.lineCap = 'round';
    for (const sp of this.sparks) {
      if (sp.t >= 1) continue;
      const k = Math.sin(sp.t * Math.PI);
      const r = sp.s * k;
      g.lineWidth = 1.1 * S;
      g.beginPath();
      g.moveTo(sp.x - r, sp.y);
      g.lineTo(sp.x + r, sp.y);
      g.moveTo(sp.x, sp.y - r * 1.3);
      g.lineTo(sp.x, sp.y + r * 1.3);
      g.stroke();
      g.fillStyle = `rgba(255,236,160,${0.5 * k})`;
      g.beginPath();
      g.arc(sp.x, sp.y, r * 0.45, 0, Math.PI * 2);
      g.fill();
    }
    g.globalCompositeOperation = 'source-over';
  }

  /** A slow glint over the whole mended piece. */
  private drawSheen() {
    const { g } = this;
    const { w, h } = this.shape;
    const c = Math.min(1.3, this.phaseT * 0.8) - 0.15;
    const gr = g.createLinearGradient(-w / 2, -h / 2, w / 2, h / 2);
    const a = Math.max(0, Math.min(1, c - 0.12)), b = Math.max(0, Math.min(1, c)), e = Math.max(0, Math.min(1, c + 0.12));
    gr.addColorStop(a, 'rgba(255,255,255,0)');
    gr.addColorStop(b, 'rgba(255,255,255,0.28)');
    gr.addColorStop(e, 'rgba(255,255,255,0)');
    g.globalCompositeOperation = 'lighter';
    g.fillStyle = gr;
    g.fill(this.silhouette);
    g.globalCompositeOperation = 'source-over';
  }

  private drawPour() {
    const { g, S } = this;
    let active = false;
    for (const gr of this.grabs.values()) if (gr.kind === 'pour') active = true;
    if (!active) return;
    const x = this.pourX - this.hx, y = this.pourY - this.hy;
    const n = this.pourNode;
    let has = false;
    for (const gr of this.grabs.values()) if (gr.kind === 'pour' && gr.node >= 0) has = n >= 0;
    // A small crucible, tipped, with a molten stream down to where the gold lands.
    const cx = x - 22 * S, cy = y - 46 * S;
    if (has) {
      const tx = this.gold.nx[n], ty = this.gold.ny[n];
      const wob = Math.sin(this.time * 30) * 1.2 * S;
      g.strokeStyle = '#f2c14e';
      g.lineWidth = 2.6 * S;
      g.lineCap = 'round';
      g.beginPath();
      // From the spout (local 14u, -9u) of the tipped crucible.
      const u = S * 1.55, c = Math.cos(0.85), sn = Math.sin(0.85);
      const lx = cx + 14 * u * c + 9 * u * sn, ly = cy + 14 * u * sn - 9 * u * c;
      g.moveTo(lx, ly);
      g.quadraticCurveTo(lx + 3 * S + wob, (ly + ty) / 2, tx, ty);
      g.stroke();
      g.strokeStyle = 'rgba(255,248,210,0.9)';
      g.lineWidth = 0.9 * S;
      g.stroke();
      g.globalCompositeOperation = 'lighter';
      g.fillStyle = 'rgba(255,200,90,0.45)';
      g.beginPath();
      g.arc(tx, ty, 6 * S, 0, Math.PI * 2);
      g.fill();
      g.globalCompositeOperation = 'source-over';
    }
    g.save();
    g.translate(cx, cy);
    g.rotate(has ? 0.85 : 0.35);
    const u = S * 1.55;
    const body = g.createLinearGradient(-11 * u, 0, 11 * u, 0);
    body.addColorStop(0, '#6b5446');
    body.addColorStop(0.45, '#a88a72');
    body.addColorStop(1, '#4a382e');
    g.fillStyle = body;
    g.beginPath();
    g.moveTo(-11 * u, -7 * u);
    g.lineTo(11 * u, -7 * u);
    g.lineTo(14 * u, -9 * u);
    g.quadraticCurveTo(10 * u, 10 * u, 0, 10 * u);
    g.quadraticCurveTo(-10 * u, 10 * u, -11 * u, -7 * u);
    g.fill();
    const melt = g.createRadialGradient(-2 * u, -7 * u, 0, 0, -7 * u, 11 * u);
    melt.addColorStop(0, '#fff6c8');
    melt.addColorStop(0.5, has ? '#ffc94a' : '#e0a93a');
    melt.addColorStop(1, '#b57614');
    g.fillStyle = melt;
    g.beginPath();
    g.ellipse(0, -7 * u, 11 * u, 3.2 * u, 0, 0, Math.PI * 2);
    g.fill();
    g.strokeStyle = '#3b2c24';
    g.lineWidth = 1.4 * u;
    g.stroke();
    g.restore();
  }

  /** Shelf slot centre and size; the right end stays clear of the HUD buttons above it. */
  private slot(i: number) {
    const { width: W, S } = this;
    const sw = (W - 84 * S) / SHELF;
    return { x: 14 * S + sw * (i + 0.5), w: sw * 0.88, h: Math.min(56 * S, this.shelfY * 0.3) };
  }

  private drawShelf() {
    const { g, S } = this;
    const top = this.shelfY - 9 * S;
    for (let i = 0; i < this.shelf.length; i++) {
      const it = this.shelf[i];
      const sl = this.slot(i);
      const sc = Math.min(sl.w / it.w, sl.h / it.h);
      const w = it.w * sc, h = it.h * sc;
      g.fillStyle = 'rgba(40,24,10,0.35)';
      g.beginPath();
      g.ellipse(sl.x, top - 1 * S, w * 0.4, 3 * S, 0, 0, Math.PI * 2);
      g.fill();
      g.drawImage(it.img, sl.x - w / 2, top - h, w, h);
    }
  }

  private drawFlying() {
    const { g, S } = this;
    const it = this.flying;
    if (!it) return;
    const t = Math.min(1, this.phaseT / 0.9);
    const e = t * t * (3 - 2 * t);
    const sl = this.slot(Math.min(this.shelf.length, SHELF - 1));
    const top = this.shelfY - 9 * S;
    const sc1 = Math.min(sl.w / it.w, sl.h / it.h);
    const sc = 1 + (sc1 - 1) * e;
    const x = this.hx + (sl.x - this.hx) * e;
    const y = this.hy + (top - (it.h * sc1) / 2 - this.hy) * e - Math.sin(t * Math.PI) * 50 * S;
    g.setTransform(sc, 0, 0, sc, x, y);
    g.drawImage(it.img, -it.w / 2, -it.h / 2);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }

  resize(width: number, height: number) {
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.layout();
    this.newPiece();
  }

  destroy() {
    this.trickle.stop();
    this.hint.remove();
    this.style.remove();
    if (import.meta.env.DEV) delete (window as unknown as Record<string, unknown>).__kintsugi;
  }
}

// ---------------------------------------------------------------- helpers

function wrap(a: number) {
  return a - Math.round(a / (Math.PI * 2)) * Math.PI * 2;
}

function polyPath(poly: number[], ox: number, oy: number) {
  const p = new Path2D();
  p.moveTo(poly[0] + ox, poly[1] + oy);
  for (let k = 2; k < poly.length; k += 2) p.lineTo(poly[k] + ox, poly[k + 1] + oy);
  p.closePath();
  return p;
}

function polyArea(poly: number[]) {
  let a = 0;
  for (let k = 0; k < poly.length; k += 2) {
    const j = (k + 2) % poly.length;
    a += poly[k] * poly[j + 1] - poly[j] * poly[k + 1];
  }
  return a / 2;
}

function inPoly(poly: number[], x: number, y: number) {
  let inside = false;
  for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
    const xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** A blurred silhouette for drop shadows; returns the canvas and its offset from the polygon origin. */
function shadowSprite(poly: number[], ox: number, oy: number, blur: number, alpha: number) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let k = 0; k < poly.length; k += 2) {
    x0 = Math.min(x0, poly[k]); y0 = Math.min(y0, poly[k + 1]); x1 = Math.max(x1, poly[k]); y1 = Math.max(y1, poly[k + 1]);
  }
  const pad = Math.ceil(blur * 2.5);
  const c = document.createElement('canvas');
  c.width = Math.ceil(x1 - x0) + pad * 2;
  c.height = Math.ceil(y1 - y0) + pad * 2;
  const g = c.getContext('2d')!;
  // Draw far off-canvas and let only the blurred shadow land on it.
  const off = c.width + 1000;
  g.shadowColor = `rgba(4,8,20,${alpha})`;
  g.shadowBlur = blur;
  g.shadowOffsetX = off;
  g.fillStyle = '#000';
  g.fill(polyPath(poly, pad - x0 + ox - off, pad - y0 + oy));
  return { canvas: c, x: x0 - pad, y: y0 - pad };
}

const STYLE = `
.kin-hint { position: absolute; left: 50%; bottom: calc(26px + env(safe-area-inset-bottom, 0px)); transform: translate(-50%, 8px); padding: 9px 16px; border-radius: 999px; background: rgba(250, 244, 230, 0.92); color: #2a2233; font: 700 15px/1.1 ui-rounded, system-ui, sans-serif; white-space: nowrap; opacity: 0; pointer-events: none; transition: opacity .35s, transform .35s; box-shadow: 0 6px 20px rgba(0,0,0,0.3); }
.kin-hint.show { opacity: 1; transform: translate(-50%, 0); }
`;
