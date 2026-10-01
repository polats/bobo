// Card designs: the printed ticket under the coat, the ink printed on the coat itself, and the
// outcome. The outcome is fixed when the card is made, as on a real ticket; scratching only
// shows it. Layout is in card units: x 0..1 across, y 0..1 down.

import { mulberry } from './coat';
import type { CoatId } from './coats';

export const CARD_ASPECT = 0.64;
/** The scratch area, in card units. */
export const COAT_BOX = { x0: 0.075, y0: 0.27, x1: 0.925, y1: 0.855, r: 0.035 };

type Painter = (g: CanvasRenderingContext2D, s: number) => void;

interface Sym {
  id: string;
  /** Prize when three show up; rarer symbols pay more. */
  prize: number;
  weight: number;
  paint: Painter;
}

const gold = (g: CanvasRenderingContext2D, s: number) => {
  const gr = g.createLinearGradient(0, -s, 0, s);
  gr.addColorStop(0, '#fff2a8');
  gr.addColorStop(0.5, '#f2b632');
  gr.addColorStop(1, '#b06c12');
  return gr;
};

const SYMBOLS: Sym[] = [
  {
    id: 'cherry', prize: 2, weight: 30,
    paint(g, s) {
      g.strokeStyle = '#2f7d32';
      g.lineWidth = s * 0.09;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(-s * 0.35, s * 0.15);
      g.quadraticCurveTo(-s * 0.2, -s * 0.5, s * 0.15, -s * 0.72);
      g.moveTo(s * 0.35, s * 0.25);
      g.quadraticCurveTo(s * 0.3, -s * 0.35, s * 0.15, -s * 0.72);
      g.stroke();
      for (const [x, y] of [[-s * 0.36, s * 0.32], [s * 0.36, s * 0.42]]) {
        const gr = g.createRadialGradient(x - s * 0.1, y - s * 0.1, s * 0.03, x, y, s * 0.3);
        gr.addColorStop(0, '#ff8a8a');
        gr.addColorStop(1, '#b3101e');
        g.fillStyle = gr;
        g.beginPath();
        g.arc(x, y, s * 0.28, 0, Math.PI * 2);
        g.fill();
      }
    },
  },
  {
    id: 'lantern', prize: 5, weight: 24,
    paint(g, s) {
      g.fillStyle = gold(g, s);
      g.fillRect(-s * 0.28, -s * 0.72, s * 0.56, s * 0.16);
      g.fillRect(-s * 0.28, s * 0.52, s * 0.56, s * 0.16);
      const gr = g.createRadialGradient(-s * 0.15, -s * 0.15, s * 0.05, 0, 0, s * 0.7);
      gr.addColorStop(0, '#ff9a6b');
      gr.addColorStop(1, '#c4161c');
      g.fillStyle = gr;
      g.beginPath();
      g.ellipse(0, 0, s * 0.6, s * 0.56, 0, 0, Math.PI * 2);
      g.fill();
      g.strokeStyle = 'rgba(120,10,10,0.55)';
      g.lineWidth = s * 0.04;
      for (const k of [-0.3, 0, 0.3]) {
        g.beginPath();
        g.ellipse(0, 0, s * 0.6 * Math.abs(k) + s * 0.04, s * 0.56, 0, 0, Math.PI * 2);
        g.stroke();
      }
      g.strokeStyle = '#f2b632';
      g.lineWidth = s * 0.05;
      g.beginPath();
      g.moveTo(0, s * 0.68);
      g.lineTo(0, s * 0.92);
      g.stroke();
    },
  },
  {
    id: 'clover', prize: 10, weight: 18,
    paint(g, s) {
      g.fillStyle = '#2fa84f';
      for (let k = 0; k < 4; k++) {
        const a = (k * Math.PI) / 2 + Math.PI / 4;
        g.beginPath();
        g.arc(Math.cos(a) * s * 0.3, Math.sin(a) * s * 0.3 - s * 0.08, s * 0.27, 0, Math.PI * 2);
        g.fill();
      }
      g.strokeStyle = '#1f6e33';
      g.lineWidth = s * 0.08;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(0, s * 0.1);
      g.quadraticCurveTo(s * 0.1, s * 0.5, s * 0.3, s * 0.75);
      g.stroke();
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.beginPath();
      g.arc(-s * 0.28, -s * 0.38, s * 0.08, 0, Math.PI * 2);
      g.fill();
    },
  },
  {
    id: 'bell', prize: 20, weight: 12,
    paint(g, s) {
      g.fillStyle = gold(g, s);
      g.beginPath();
      g.moveTo(-s * 0.62, s * 0.45);
      g.quadraticCurveTo(-s * 0.48, s * 0.3, -s * 0.45, -s * 0.1);
      g.quadraticCurveTo(-s * 0.42, -s * 0.7, 0, -s * 0.72);
      g.quadraticCurveTo(s * 0.42, -s * 0.7, s * 0.45, -s * 0.1);
      g.quadraticCurveTo(s * 0.48, s * 0.3, s * 0.62, s * 0.45);
      g.closePath();
      g.fill();
      g.beginPath();
      g.arc(0, s * 0.56, s * 0.14, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = 'rgba(255,255,255,0.45)';
      g.beginPath();
      g.ellipse(-s * 0.2, -s * 0.25, s * 0.07, s * 0.25, 0.2, 0, Math.PI * 2);
      g.fill();
    },
  },
  {
    id: 'moon', prize: 50, weight: 8,
    paint(g, s) {
      g.save();
      g.beginPath();
      g.arc(0, 0, s * 0.66, 0, Math.PI * 2);
      g.arc(s * 0.32, -s * 0.18, s * 0.56, 0, Math.PI * 2, true);
      g.clip('evenodd');
      const gr = g.createRadialGradient(-s * 0.3, s * 0.1, s * 0.1, 0, 0, s * 0.7);
      gr.addColorStop(0, '#fffbe0');
      gr.addColorStop(1, '#e0b03a');
      g.fillStyle = gr;
      g.fillRect(-s, -s, s * 2, s * 2);
      g.restore();
      g.fillStyle = '#f2b632';
      star(g, s * 0.42, s * 0.4, s * 0.16);
    },
  },
  {
    id: 'diamond', prize: 100, weight: 5,
    paint(g, s) {
      const pts: [number, number][] = [[-s * 0.62, -s * 0.2], [-s * 0.32, -s * 0.55], [s * 0.32, -s * 0.55], [s * 0.62, -s * 0.2], [0, s * 0.68]];
      g.fillStyle = '#3fd0ff';
      g.beginPath();
      pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.fill();
      g.fillStyle = '#a8ecff';
      g.beginPath();
      g.moveTo(-s * 0.62, -s * 0.2);
      g.lineTo(-s * 0.32, -s * 0.55);
      g.lineTo(s * 0.32, -s * 0.55);
      g.lineTo(s * 0.62, -s * 0.2);
      g.closePath();
      g.fill();
      g.strokeStyle = 'rgba(10,80,140,0.6)';
      g.lineWidth = s * 0.035;
      g.beginPath();
      g.moveTo(-s * 0.62, -s * 0.2);
      g.lineTo(s * 0.62, -s * 0.2);
      g.moveTo(-s * 0.2, -s * 0.2);
      g.lineTo(0, s * 0.68);
      g.lineTo(s * 0.2, -s * 0.2);
      g.stroke();
    },
  },
  {
    id: 'seven', prize: 500, weight: 2,
    paint(g, s) {
      g.font = `900 ${s * 1.55}px Georgia, 'Times New Roman', serif`;
      g.textAlign = 'center';
      g.textBaseline = 'middle';
      g.lineWidth = s * 0.12;
      g.strokeStyle = '#5a0a0a';
      g.strokeText('7', 0, s * 0.06);
      const gr = g.createLinearGradient(0, -s * 0.7, 0, s * 0.7);
      gr.addColorStop(0, '#ff6b5b');
      gr.addColorStop(1, '#b3101e');
      g.fillStyle = gr;
      g.fillText('7', 0, s * 0.06);
    },
  },
];

function star(g: CanvasRenderingContext2D, x: number, y: number, r: number) {
  g.beginPath();
  for (let k = 0; k < 10; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / 5;
    const rr = k % 2 ? r * 0.45 : r;
    g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  g.closePath();
  g.fill();
}

interface Design {
  title: string;
  sub: string;
  top: string;
  bottom: string;
  ink: string;
  accent: string;
  /** Coat tint: silver by default. */
  foil: [number, number, number];
  /** The coat this ticket is printed with. */
  coat: CoatId;
}

const DESIGNS: Design[] = [
  { title: 'LUCKY LANTERN', sub: 'NIGHT MARKET', top: '#d8243a', bottom: '#5e0b1f', ink: '#fff1c9', accent: '#f6c445', foil: [0.78, 0.79, 0.82], coat: 'silver' },
  { title: 'MOON FRUIT', sub: 'MIDNIGHT ORCHARD', top: '#1d6f8c', bottom: '#0b2140', ink: '#ffe9f2', accent: '#ff8fb8', foil: [0.8, 0.8, 0.84], coat: 'crackle' },
  { title: 'JADE FORTUNE', sub: 'TEA HOUSE SPECIAL', top: '#1e8a5a', bottom: '#0b3324', ink: '#fdf6dc', accent: '#f2d27a', foil: [0.82, 0.78, 0.66], coat: 'latex' },
  { title: 'NEON CHERRY', sub: 'ARCADE ALLEY', top: '#7a2bd6', bottom: '#1c0a3d', ink: '#f5ecff', accent: '#45f0d2', foil: [0.76, 0.78, 0.84], coat: 'holo' },
];

export interface CellBox {
  /** In card units. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  sym: string;
  win: boolean;
}

export interface Card {
  seed: number;
  design: Design;
  cells: CellBox[];
  /** 0 for a losing card. */
  prize: number;
  price: number;
  winSym: string | null;
}

/** Decide a card. `winChance` is the share of cards that pay. */
export function makeCard(seed: number, winChance = 0.4): Card {
  const rnd = mulberry(seed);
  const design = DESIGNS[(rnd() * DESIGNS.length) | 0];
  const total = SYMBOLS.reduce((a, s) => a + s.weight, 0);
  const pick = () => {
    let u = rnd() * total;
    for (const s of SYMBOLS) if ((u -= s.weight) < 0) return s;
    return SYMBOLS[0];
  };
  const win = rnd() < winChance ? pick() : null;
  const syms: Sym[] = [];
  const counts = new Map<string, number>();
  if (win) {
    syms.push(win, win, win);
    counts.set(win.id, 3);
  }
  while (syms.length < 9) {
    const s = pick();
    const c = counts.get(s.id) ?? 0;
    if (c >= 2) continue;
    counts.set(s.id, c + 1);
    syms.push(s);
  }
  for (let i = syms.length - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    [syms[i], syms[j]] = [syms[j], syms[i]];
  }
  const b = COAT_BOX;
  const pad = 0.02;
  const cw = (b.x1 - b.x0 - pad * 4) / 3;
  const ch = (b.y1 - b.y0 - pad * 4) / 3;
  const cells = syms.map((s, i) => {
    const cx = i % 3, cy = (i / 3) | 0;
    const x0 = b.x0 + pad + cx * (cw + pad);
    const y0 = b.y0 + pad + cy * (ch + pad);
    return { x0, y0, x1: x0 + cw, y1: y0 + ch, sym: s.id, win: !!win && s.id === win.id };
  });
  return { seed, design, cells, prize: win ? win.prize : 0, price: 1, winSym: win?.id ?? null };
}

const symById = (id: string) => SYMBOLS.find((s) => s.id === id)!;

/** Paint the printed ticket (what's under the coat, and the frame around it). */
export function paintCard(card: Card, cv: HTMLCanvasElement, width: number) {
  const W = (cv.width = Math.round(width));
  const H = (cv.height = Math.round(width / CARD_ASPECT));
  const g = cv.getContext('2d')!;
  const d = card.design;
  const rnd = mulberry(card.seed ^ 0x51ed);
  const bg = g.createLinearGradient(0, 0, 0, H);
  bg.addColorStop(0, d.top);
  bg.addColorStop(1, d.bottom);
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);
  // Guilloche security pattern over the whole ticket.
  g.save();
  g.globalAlpha = 0.12;
  g.strokeStyle = d.ink;
  g.lineWidth = Math.max(1, W / 700);
  for (let k = 0; k < 26; k++) {
    g.beginPath();
    for (let x = 0; x <= W; x += 4) {
      const y = H * 0.06 + k * H * 0.038 + Math.sin(x / (W * 0.05) + k * 0.7) * H * 0.012 + Math.sin(x / (W * 0.13) - k) * H * 0.008;
      x ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
  }
  g.restore();
  // Title.
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillStyle = d.accent;
  g.font = `700 ${W * 0.042}px ui-rounded, 'Avenir Next', system-ui, sans-serif`;
  g.fillText(`★  ${d.sub}  ★`, W / 2, H * 0.06);
  g.font = `900 ${W * 0.115}px ui-rounded, 'Avenir Next', system-ui, sans-serif`;
  g.lineWidth = W * 0.016;
  g.strokeStyle = 'rgba(0,0,0,0.35)';
  g.strokeText(d.title, W / 2, H * 0.135, W * 0.78);
  g.fillStyle = d.ink;
  g.fillText(d.title, W / 2, H * 0.135, W * 0.78);
  g.font = `600 ${W * 0.04}px ui-rounded, 'Avenir Next', system-ui, sans-serif`;
  g.fillStyle = d.ink;
  g.globalAlpha = 0.85;
  g.fillText('MATCH 3 SYMBOLS TO WIN THAT PRIZE', W / 2, H * 0.215);
  g.globalAlpha = 1;
  // Scratch area: paper.
  const b = COAT_BOX;
  roundRect(g, b.x0 * W, b.y0 * H, (b.x1 - b.x0) * W, (b.y1 - b.y0) * H, b.r * W);
  g.fillStyle = '#fbf3e0';
  g.fill();
  g.save();
  g.clip();
  g.globalAlpha = 0.08;
  g.fillStyle = d.top;
  for (let i = 0; i < 400; i++) g.fillRect(rnd() * W, b.y0 * H + rnd() * (b.y1 - b.y0) * H, W * 0.004, W * 0.004);
  g.restore();
  for (const c of card.cells) {
    const s = symById(c.sym);
    const cx = ((c.x0 + c.x1) / 2) * W, cy = (c.y0 * 0.42 + c.y1 * 0.58) * H - H * 0.012;
    const sz = Math.min(c.x1 - c.x0, (c.y1 - c.y0) * 1.1) * W * 0.36;
    roundRect(g, c.x0 * W, c.y0 * H, (c.x1 - c.x0) * W, (c.y1 - c.y0) * H, W * 0.02);
    g.fillStyle = 'rgba(0,0,0,0.035)';
    g.fill();
    g.save();
    g.translate(cx, cy);
    s.paint(g, sz);
    g.restore();
    g.font = `800 ${W * 0.045}px ui-rounded, 'Avenir Next', system-ui, sans-serif`;
    g.fillStyle = '#3a2a1a';
    g.fillText(`$${s.prize}`, cx, c.y1 * H - H * 0.022);
  }
  // Footer.
  g.font = `600 ${W * 0.03}px ui-monospace, Menlo, monospace`;
  g.fillStyle = d.ink;
  g.globalAlpha = 0.7;
  g.fillText(`No. ${String(card.seed % 1e7).padStart(7, '0')}  ·  $${card.price}  ·  PLAY FOR FUN`, W / 2, H * 0.93);
  g.globalAlpha = 1;
}

/** Paint the ink printed on top of the coat (comes off with it): white = ink. */
export function paintCoatPrint(card: Card, cv: HTMLCanvasElement, width: number) {
  const W = (cv.width = Math.round(width));
  const H = (cv.height = Math.round(width / CARD_ASPECT));
  const g = cv.getContext('2d')!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  const b = COAT_BOX;
  g.fillStyle = '#fff';
  g.strokeStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.save();
  roundRect(g, b.x0 * W, b.y0 * H, (b.x1 - b.x0) * W, (b.y1 - b.y0) * H, b.r * W);
  g.clip();
  g.lineWidth = W * 0.006;
  roundRect(g, (b.x0 + 0.012) * W, (b.y0 + 0.008) * H, (b.x1 - b.x0 - 0.024) * W, (b.y1 - b.y0 - 0.016) * H, b.r * W * 0.8);
  g.stroke();
  for (const c of card.cells) {
    const cx = ((c.x0 + c.x1) / 2) * W, cy = ((c.y0 + c.y1) / 2) * H;
    g.globalAlpha = 0.5;
    g.font = `900 ${W * 0.1}px ui-rounded, 'Avenir Next', system-ui, sans-serif`;
    g.fillText('?', cx, cy);
    g.globalAlpha = 0.22;
    g.lineWidth = W * 0.004;
    roundRect(g, (c.x0 + 0.01) * W, (c.y0 + 0.008) * H, (c.x1 - c.x0 - 0.02) * W, (c.y1 - c.y0 - 0.016) * H, W * 0.02);
    g.stroke();
  }
  g.globalAlpha = 0.4;
  g.font = `800 ${W * 0.032}px ui-rounded, 'Avenir Next', system-ui, sans-serif`;
  g.fillText('SCRATCH HERE', W / 2, (b.y1 - 0.008) * H - W * 0.012);
  g.restore();
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Is card point (u, v) inside the rounded scratch area? */
export function inCoat(u: number, v: number) {
  const b = COAT_BOX;
  const rx = b.r, ry = b.r * CARD_ASPECT;
  if (u < b.x0 || u > b.x1 || v < b.y0 || v > b.y1) return false;
  const cx = Math.min(Math.max(u, b.x0 + rx), b.x1 - rx);
  const cy = Math.min(Math.max(v, b.y0 + ry), b.y1 - ry);
  return ((u - cx) / rx) ** 2 + ((v - cy) / ry) ** 2 <= 1;
}
