// The four crime-scene surfaces, painted with Canvas 2D in CSS px around the scene box: a whisky
// glass, a coffee mug, a brass door knob and a wall safe. Each says where its print sits and which
// powder a technician would reach for (silver on dark, black on light, magnetic on metal).

export type PowderId = 'black' | 'silver' | 'magnetic';
export type CaseId = 'glass' | 'mug' | 'knob' | 'safe';

export interface Box {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Object size scale (1 = a 390 x 500 box). */
  k: number;
}

export interface CaseDef {
  id: CaseId;
  title: string;
  /** What you brush, for the hint ("Brush the glass"). */
  noun: string;
  powder: PowderId;
  /** Print centre relative to the box centre (CSS px, before k), rotation in radians. */
  print: [number, number, number];
  /** Latent smudges: centre, radii (CSS px before k). */
  smudges: [number, number, number, number][];
  paint(g: CanvasRenderingContext2D, b: Box): void;
}

type G = CanvasRenderingContext2D;

function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function fillAll(g: G, b: Box, style: string | CanvasGradient) {
  g.fillStyle = style;
  g.fillRect(b.cx - 2000, b.cy - 2000, 4000, 4000);
}

function glow(g: G, x: number, y: number, r: number, color: string, a: number) {
  const gr = g.createRadialGradient(x, y, 0, x, y, r);
  gr.addColorStop(0, color.replace('A', String(a)));
  gr.addColorStop(1, color.replace('A', '0'));
  g.fillStyle = gr;
  g.fillRect(x - r, y - r, r * 2, r * 2);
}

/** Fine speckle for brushed metal, wood pores, ceramic. */
function speckle(g: G, x: number, y: number, w: number, h: number, n: number, seed: number, light: string, dark: string, size = 1) {
  const r = rng(seed);
  for (let i = 0; i < n; i++) {
    g.fillStyle = r() < 0.5 ? light : dark;
    g.fillRect(x + r() * w, y + r() * h, size * (0.5 + r()), size * (0.5 + r()));
  }
}

// ------------------------------------------------------------------ glass

function glass(g: G, b: Box) {
  const { cx, cy, k } = b;
  const bg = g.createLinearGradient(0, cy - b.h, 0, cy + b.h);
  bg.addColorStop(0, '#070a12');
  bg.addColorStop(1, '#121826');
  fillAll(g, b, bg);
  // A desk lamp somewhere off to the right, and the bar's neon far behind.
  glow(g, cx + 170 * k, cy - 230 * k, 260 * k, 'rgba(255,170,90,A)', 0.22);
  glow(g, cx - 200 * k, cy - 120 * k, 180 * k, 'rgba(70,120,255,A)', 0.12);
  // Desk top.
  const deskY = cy + 170 * k;
  const desk = g.createLinearGradient(0, deskY, 0, deskY + 200 * k);
  desk.addColorStop(0, '#2b1a12');
  desk.addColorStop(1, '#120a07');
  g.fillStyle = desk;
  g.fillRect(cx - 1000, deskY, 2000, 1000);
  speckle(g, cx - 260 * k, deskY, 520 * k, 160 * k, 900, 5, 'rgba(255,200,150,0.05)', 'rgba(0,0,0,0.25)', 2 * k);
  // Tumbler: a slightly tapered cylinder.
  const tw = 136 * k, bw = 122 * k, top = cy - 190 * k, bot = cy + 180 * k;
  const body = () => {
    g.beginPath();
    g.moveTo(cx - tw, top);
    g.lineTo(cx + tw, top);
    g.lineTo(cx + bw, bot - 10 * k);
    g.quadraticCurveTo(cx + bw, bot, cx + bw - 12 * k, bot);
    g.lineTo(cx - bw + 12 * k, bot);
    g.quadraticCurveTo(cx - bw, bot, cx - bw, bot - 10 * k);
    g.closePath();
  };
  g.save();
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.ellipse(cx + 10 * k, bot + 4 * k, bw * 1.2, 16 * k, 0, 0, Math.PI * 2);
  g.fill();
  body();
  g.clip();
  const gl = g.createLinearGradient(cx - tw, 0, cx + tw, 0);
  gl.addColorStop(0, 'rgba(190,210,240,0.2)');
  gl.addColorStop(0.18, 'rgba(160,185,220,0.06)');
  gl.addColorStop(0.7, 'rgba(160,185,220,0.03)');
  gl.addColorStop(1, 'rgba(190,210,240,0.16)');
  g.fillStyle = gl;
  g.fillRect(cx - tw, top, tw * 2, bot - top);
  // Whisky in the bottom third, with a meniscus and warm light through it.
  const wy = cy + 70 * k;
  const wh = g.createLinearGradient(0, wy, 0, bot);
  wh.addColorStop(0, 'rgba(214,122,38,0.85)');
  wh.addColorStop(0.6, 'rgba(140,62,14,0.9)');
  wh.addColorStop(1, 'rgba(70,28,6,0.95)');
  g.fillStyle = wh;
  g.fillRect(cx - tw, wy, tw * 2, bot - wy);
  g.fillStyle = 'rgba(255,196,110,0.5)';
  g.beginPath();
  g.ellipse(cx, wy, tw * 0.97, 9 * k, 0, 0, Math.PI * 2);
  g.fill();
  glow(g, cx + 40 * k, wy + 50 * k, 90 * k, 'rgba(255,190,90,A)', 0.35);
  // Ice cube.
  g.fillStyle = 'rgba(220,235,255,0.14)';
  g.strokeStyle = 'rgba(230,240,255,0.35)';
  g.lineWidth = 1.5 * k;
  g.beginPath();
  g.roundRect(cx - 70 * k, wy - 34 * k, 70 * k, 64 * k, 8 * k);
  g.fill();
  g.stroke();
  // Thick base.
  const base = g.createLinearGradient(0, bot - 38 * k, 0, bot);
  base.addColorStop(0, 'rgba(255,255,255,0.03)');
  base.addColorStop(0.5, 'rgba(255,230,200,0.22)');
  base.addColorStop(1, 'rgba(255,255,255,0.05)');
  g.fillStyle = base;
  g.fillRect(cx - tw, bot - 38 * k, tw * 2, 38 * k);
  // Vertical highlight streaks.
  const hl = (x: number, w: number, a: number) => {
    const s = g.createLinearGradient(x - w, 0, x + w, 0);
    s.addColorStop(0, 'rgba(255,255,255,0)');
    s.addColorStop(0.5, `rgba(255,255,255,${a})`);
    s.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = s;
    g.fillRect(x - w, top, w * 2, bot - top);
  };
  hl(cx - tw * 0.72, 14 * k, 0.32);
  hl(cx - tw * 0.55, 4 * k, 0.4);
  hl(cx + tw * 0.8, 8 * k, 0.18);
  g.restore();
  // Rim and outline.
  g.strokeStyle = 'rgba(220,235,255,0.55)';
  g.lineWidth = 2 * k;
  body();
  g.stroke();
  g.beginPath();
  g.ellipse(cx, top, tw, 12 * k, 0, 0, Math.PI * 2);
  g.strokeStyle = 'rgba(230,240,255,0.6)';
  g.stroke();
}

// ------------------------------------------------------------------ mug

function mug(g: G, b: Box) {
  const { cx, cy, k } = b;
  const bg = g.createLinearGradient(0, cy - b.h, 0, cy + b.h);
  bg.addColorStop(0, '#15120f');
  bg.addColorStop(1, '#241c16');
  fillAll(g, b, bg);
  glow(g, cx - 150 * k, cy - 220 * k, 280 * k, 'rgba(255,220,170,A)', 0.14);
  // Formica counter.
  const deskY = cy + 170 * k;
  g.fillStyle = '#3a3d3a';
  g.fillRect(cx - 1000, deskY, 2000, 1000);
  speckle(g, cx - 300 * k, deskY, 600 * k, 200 * k, 1400, 9, 'rgba(255,255,255,0.08)', 'rgba(0,0,0,0.2)', 1.5 * k);
  const mw = 124 * k, top = cy - 165 * k, bot = cy + 175 * k;
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.ellipse(cx + 16 * k, bot + 4 * k, mw * 1.3, 18 * k, 0, 0, Math.PI * 2);
  g.fill();
  // Handle behind-right.
  g.lineCap = 'round';
  g.strokeStyle = '#cfc7b8';
  g.lineWidth = 30 * k;
  g.beginPath();
  g.moveTo(cx + mw - 6 * k, top + 70 * k);
  g.bezierCurveTo(cx + mw + 110 * k, top + 60 * k, cx + mw + 110 * k, bot - 90 * k, cx + mw - 6 * k, bot - 70 * k);
  g.stroke();
  g.strokeStyle = 'rgba(255,255,255,0.35)';
  g.lineWidth = 6 * k;
  g.beginPath();
  g.moveTo(cx + mw + 10 * k, top + 64 * k);
  g.bezierCurveTo(cx + mw + 96 * k, top + 60 * k, cx + mw + 100 * k, bot - 110 * k, cx + mw + 40 * k, bot - 84 * k);
  g.stroke();
  // Body with cylinder shading.
  const body = g.createLinearGradient(cx - mw, 0, cx + mw, 0);
  body.addColorStop(0, '#8d877c');
  body.addColorStop(0.28, '#f6f1e6');
  body.addColorStop(0.42, '#fffdf7');
  body.addColorStop(0.8, '#d9d2c4');
  body.addColorStop(1, '#8a8378');
  g.fillStyle = body;
  g.beginPath();
  g.moveTo(cx - mw, top);
  g.lineTo(cx - mw, bot - 16 * k);
  g.quadraticCurveTo(cx - mw, bot, cx - mw + 18 * k, bot);
  g.lineTo(cx + mw - 18 * k, bot);
  g.quadraticCurveTo(cx + mw, bot, cx + mw, bot - 16 * k);
  g.lineTo(cx + mw, top);
  g.closePath();
  g.fill();
  speckle(g, cx - mw, top, mw * 2, bot - top, 500, 13, 'rgba(255,255,255,0.3)', 'rgba(90,80,60,0.12)', 1.2 * k);
  // Rim and coffee.
  g.fillStyle = '#e9e3d6';
  g.beginPath();
  g.ellipse(cx, top, mw, 20 * k, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#2a170c';
  g.beginPath();
  g.ellipse(cx, top + 2 * k, mw - 9 * k, 14 * k, 0, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = 'rgba(255,220,180,0.18)';
  g.beginPath();
  g.ellipse(cx - 30 * k, top + 1 * k, 30 * k, 4 * k, 0, 0, Math.PI * 2);
  g.fill();
  // Department logo, a lipstick mark and a coffee drip.
  g.save();
  g.translate(cx + 58 * k, cy + 70 * k);
  g.strokeStyle = 'rgba(40,60,110,0.75)';
  g.lineWidth = 3 * k;
  g.beginPath();
  g.arc(0, 0, 30 * k, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = 'rgba(40,60,110,0.8)';
  g.font = `800 ${13 * k}px ui-monospace, Menlo, monospace`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('DEPT', 0, -6 * k);
  g.fillText('7', 0, 9 * k);
  g.restore();
  g.fillStyle = 'rgba(80,40,20,0.55)';
  g.beginPath();
  g.roundRect(cx - 90 * k, top + 12 * k, 7 * k, 46 * k, 4 * k);
  g.fill();
}

// ------------------------------------------------------------------ door knob

function knob(g: G, b: Box) {
  const { cx, cy, k } = b;
  // Walnut door with vertical grain.
  const door = g.createLinearGradient(cx - b.w / 2, 0, cx + b.w / 2, 0);
  door.addColorStop(0, '#2a160c');
  door.addColorStop(0.5, '#3b2012');
  door.addColorStop(1, '#23120a');
  fillAll(g, b, door);
  const r = rng(21);
  for (let i = 0; i < 90; i++) {
    const x = cx - b.w + r() * b.w * 2;
    g.strokeStyle = r() < 0.5 ? 'rgba(0,0,0,0.25)' : 'rgba(255,190,130,0.06)';
    g.lineWidth = (0.5 + r() * 2) * k;
    g.beginPath();
    g.moveTo(x, cy - b.h);
    g.bezierCurveTo(x + (r() - 0.5) * 30 * k, cy - 100 * k, x + (r() - 0.5) * 30 * k, cy + 100 * k, x + (r() - 0.5) * 16 * k, cy + b.h);
    g.stroke();
  }
  // Brass rose and a keyhole escutcheon below it.
  const R = 150 * k, kr = 124 * k;
  const ky = cy - 10 * k;
  g.fillStyle = 'rgba(0,0,0,0.45)';
  g.beginPath();
  g.arc(cx + 14 * k, ky + 18 * k, R + 6 * k, 0, Math.PI * 2);
  g.fill();
  const rose = g.createLinearGradient(cx - R, ky - R, cx + R, ky + R);
  rose.addColorStop(0, '#c9a458');
  rose.addColorStop(0.5, '#7a5a22');
  rose.addColorStop(1, '#3d2a0e');
  g.fillStyle = rose;
  g.beginPath();
  g.arc(cx, ky, R, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = 'rgba(255,230,160,0.35)';
  g.lineWidth = 2 * k;
  g.beginPath();
  g.arc(cx, ky, R - 8 * k, 0, Math.PI * 2);
  g.stroke();
  // The knob: domed, lit from the upper left, with lathe rings.
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.arc(cx + 18 * k, ky + 22 * k, kr, 0, Math.PI * 2);
  g.fill();
  const dome = g.createRadialGradient(cx - 50 * k, ky - 55 * k, 8 * k, cx, ky, kr);
  dome.addColorStop(0, '#fff1c4');
  dome.addColorStop(0.18, '#e2bf6e');
  dome.addColorStop(0.6, '#a07a30');
  dome.addColorStop(0.9, '#5a3f12');
  dome.addColorStop(1, '#2e1f08');
  g.fillStyle = dome;
  g.beginPath();
  g.arc(cx, ky, kr, 0, Math.PI * 2);
  g.fill();
  for (let i = 1; i < 12; i++) {
    g.strokeStyle = i % 2 ? 'rgba(255,240,200,0.06)' : 'rgba(60,40,10,0.08)';
    g.lineWidth = 1.2 * k;
    g.beginPath();
    g.arc(cx, ky, (kr * i) / 12, 0, Math.PI * 2);
    g.stroke();
  }
  // Worn patina on the lower right, where hands grip.
  glow(g, cx + 50 * k, ky + 60 * k, 70 * k, 'rgba(60,50,20,A)', 0.35);
  g.save();
  g.translate(cx - 58 * k, ky - 62 * k);
  g.rotate(-0.7);
  g.scale(1, 0.45);
  glow(g, 0, 0, 34 * k, 'rgba(255,250,230,A)', 0.7);
  g.restore();
  // Keyhole plate.
  const ey = cy + 200 * k;
  g.fillStyle = '#8a6a2c';
  g.beginPath();
  g.roundRect(cx - 22 * k, ey - 40 * k, 44 * k, 80 * k, 20 * k);
  g.fill();
  g.fillStyle = '#0d0703';
  g.beginPath();
  g.arc(cx, ey - 8 * k, 8 * k, 0, Math.PI * 2);
  g.fill();
  g.fillRect(cx - 4 * k, ey - 8 * k, 8 * k, 26 * k);
}

// ------------------------------------------------------------------ safe

function safe(g: G, b: Box) {
  const { cx, cy, k } = b;
  const steel = g.createLinearGradient(0, cy - b.h, 0, cy + b.h);
  steel.addColorStop(0, '#26302d');
  steel.addColorStop(1, '#161c1a');
  fillAll(g, b, steel);
  // Brushed steel: faint horizontal streaks.
  const r = rng(33);
  for (let i = 0; i < 700; i++) {
    g.fillStyle = r() < 0.5 ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.08)';
    g.fillRect(cx - b.w + r() * b.w * 2, cy - b.h / 2 - 60 + r() * (b.h + 120), (20 + r() * 90) * k, 1 * k);
  }
  // Door panel with a bevel and rivets.
  const pw = 170 * k, ph = 226 * k;
  g.strokeStyle = 'rgba(0,0,0,0.55)';
  g.lineWidth = 6 * k;
  g.beginPath();
  g.roundRect(cx - pw, cy - ph, pw * 2, ph * 2, 14 * k);
  g.stroke();
  g.strokeStyle = 'rgba(200,220,210,0.12)';
  g.lineWidth = 2 * k;
  g.beginPath();
  g.roundRect(cx - pw + 5 * k, cy - ph + 5 * k, pw * 2 - 10 * k, ph * 2 - 10 * k, 11 * k);
  g.stroke();
  for (const [x, y] of [[-1, -1], [1, -1], [-1, 1], [1, 1], [-1, 0], [1, 0]]) {
    const rx = cx + x * (pw - 20 * k), ry = cy + y * (ph - 20 * k);
    const rv = g.createRadialGradient(rx - 2 * k, ry - 2 * k, 0, rx, ry, 7 * k);
    rv.addColorStop(0, '#9aa8a2');
    rv.addColorStop(1, '#1d2422');
    g.fillStyle = rv;
    g.beginPath();
    g.arc(rx, ry, 7 * k, 0, Math.PI * 2);
    g.fill();
  }
  // Combination dial.
  const dx = cx, dy = cy - 128 * k, dr = 72 * k;
  g.fillStyle = 'rgba(0,0,0,0.5)';
  g.beginPath();
  g.arc(dx + 8 * k, dy + 10 * k, dr + 10 * k, 0, Math.PI * 2);
  g.fill();
  const ring = g.createLinearGradient(dx - dr, dy - dr, dx + dr, dy + dr);
  ring.addColorStop(0, '#c9d2ce');
  ring.addColorStop(1, '#4a5350');
  g.fillStyle = ring;
  g.beginPath();
  g.arc(dx, dy, dr + 8 * k, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#101413';
  g.beginPath();
  g.arc(dx, dy, dr, 0, Math.PI * 2);
  g.fill();
  g.strokeStyle = '#d7ddd9';
  g.fillStyle = '#d7ddd9';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.font = `700 ${10 * k}px ui-monospace, Menlo, monospace`;
  for (let i = 0; i < 100; i += 2) {
    const a = (i / 100) * Math.PI * 2 - Math.PI / 2;
    const l = i % 10 === 0 ? 10 : 5;
    g.lineWidth = (i % 10 === 0 ? 1.6 : 1) * k;
    g.beginPath();
    g.moveTo(dx + Math.cos(a) * (dr - 2 * k), dy + Math.sin(a) * (dr - 2 * k));
    g.lineTo(dx + Math.cos(a) * (dr - l * k), dy + Math.sin(a) * (dr - l * k));
    g.stroke();
    if (i % 10 === 0) g.fillText(String(i), dx + Math.cos(a) * (dr - 20 * k), dy + Math.sin(a) * (dr - 20 * k));
  }
  const knobG = g.createRadialGradient(dx - 8 * k, dy - 8 * k, 2 * k, dx, dy, 34 * k);
  knobG.addColorStop(0, '#6d7773');
  knobG.addColorStop(1, '#1a1f1d');
  g.fillStyle = knobG;
  g.beginPath();
  g.arc(dx, dy, 32 * k, 0, Math.PI * 2);
  g.fill();
  g.fillStyle = '#e04a3a';
  g.beginPath();
  g.moveTo(dx, dy - dr - 12 * k);
  g.lineTo(dx - 5 * k, dy - dr - 20 * k);
  g.lineTo(dx + 5 * k, dy - dr - 20 * k);
  g.fill();
  // Spoked handle on the right.
  const hx = cx + 118 * k, hy = cy + 30 * k;
  g.lineCap = 'round';
  for (let i = 0; i < 3; i++) {
    const a = (i / 3) * Math.PI * 2 - 0.4;
    g.strokeStyle = '#0c100f';
    g.lineWidth = 12 * k;
    g.beginPath();
    g.moveTo(hx + 4 * k, hy + 5 * k);
    g.lineTo(hx + Math.cos(a) * 44 * k + 4 * k, hy + Math.sin(a) * 44 * k + 5 * k);
    g.stroke();
    g.strokeStyle = '#8d9994';
    g.lineWidth = 9 * k;
    g.beginPath();
    g.moveTo(hx, hy);
    g.lineTo(hx + Math.cos(a) * 44 * k, hy + Math.sin(a) * 44 * k);
    g.stroke();
  }
  g.fillStyle = '#b8c4bf';
  g.beginPath();
  g.arc(hx, hy, 13 * k, 0, Math.PI * 2);
  g.fill();
  // Maker's plate.
  g.fillStyle = '#9c7b3a';
  g.beginPath();
  g.roundRect(cx - 62 * k, cy + 166 * k, 124 * k, 22 * k, 4 * k);
  g.fill();
  g.fillStyle = '#2a1f0c';
  g.font = `800 ${10 * k}px ui-monospace, Menlo, monospace`;
  g.fillText('HARLOW & VANE · 1954', cx, cy + 177 * k);
}

export const CASES: CaseDef[] = [
  { id: 'glass', title: 'The Whisky Glass', noun: 'glass', powder: 'silver', print: [-6, -58, -0.18], smudges: [[70, -120, 34, 22], [-80, 30, 26, 40]], paint: glass },
  { id: 'mug', title: 'The Coffee Mug', noun: 'mug', powder: 'black', print: [-26, -26, 0.22], smudges: [[70, 110, 30, 24], [-70, 120, 22, 30]], paint: mug },
  { id: 'knob', title: 'The Door Knob', noun: 'door knob', powder: 'magnetic', print: [6, -12, -0.4], smudges: [[-70, 60, 28, 20]], paint: knob },
  { id: 'safe', title: 'The Wall Safe', noun: 'safe door', powder: 'silver', print: [-40, 66, 0.12], smudges: [[70, -130, 30, 24], [100, 150, 24, 30], [-120, -40, 22, 18]], paint: safe },
];
