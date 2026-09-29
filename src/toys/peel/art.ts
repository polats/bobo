// The four peel scenes, painted procedurally with Canvas 2D: the surface under the film (sharp,
// plus a gloss mask for the shiny reveal) and the film's own print (tab, dust, bubbles, sticker art).
// Everything is drawn in world units with y pointing down (canvas convention; world y is up).

import type { FilmSpec } from './sim';

export type SceneId = 'phone' | 'sticker' | 'tape' | 'gadget';

export interface Scene {
  id: SceneId;
  label: string;
  /** World-space size of the content to fit on screen. */
  bounds: [number, number];
  film: FilmSpec;
  /** The film print covers its colour fully (sticker, tape) instead of tinting a clear film. */
  opaque: boolean;
  /** Trim the film to the print's alpha (die-cut sticker outline). */
  cutout: boolean;
  /** Clear-film tint and haze, and the colour of the film's glued underside. */
  tint: [number, number, number];
  haze: number;
  back: [number, number, number];
  /** How far the finger's drag carries the tab (> 1: you roll the fold, the tab runs ahead). */
  reach: number;
  hint: string;
  drawBase(g: CanvasRenderingContext2D): void;
  drawGloss(g: CanvasRenderingContext2D): void;
  drawPrint(g: CanvasRenderingContext2D): void;
  /** Sticker design index (sticker scene only). */
  design?: number;
}

type G = CanvasRenderingContext2D;

function rr(g: G, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.roundRect(x, y, w, h, r);
}

/** Deterministic noise so a scene paints the same after a resize. */
function rng(seed: number) {
  let s = seed >>> 0 || 1;
  return () => {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return (s >>> 0) / 4294967296;
  };
}

function text(g: G, s: string, x: number, y: number, size: number, color: string, weight = 700, align: CanvasTextAlign = 'center') {
  g.save();
  g.translate(x, y);
  // Fonts misbehave at world-unit sizes (< 1px), so draw at 100x and scale down.
  g.scale(size / 100, size / 100);
  g.font = `${weight} 100px ui-rounded, -apple-system, "SF Pro Rounded", system-ui, sans-serif`;
  g.textAlign = align;
  g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(s, 0, 0);
  g.restore();
}

/** Clear-film print shared by the protector and the gadget film: dust, bubbles, smudges, a tab. */
function clearFilmPrint(g: G, x0: number, y0: number, w: number, h: number, seed: number, tabAt: [number, number], tabColor: string, tabLabel: string) {
  const r = rng(seed);
  // Dust specks and a few lint hairs.
  for (let k = 0; k < 40; k++) {
    g.fillStyle = `rgba(255,255,255,${0.25 + r() * 0.35})`;
    g.beginPath();
    g.arc(x0 + r() * w, y0 + r() * h, 0.003 + r() * 0.006, 0, Math.PI * 2);
    g.fill();
  }
  g.lineWidth = 0.004;
  for (let k = 0; k < 3; k++) {
    const x = x0 + r() * w, y = y0 + r() * h;
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.beginPath();
    g.moveTo(x, y);
    g.bezierCurveTo(x + 0.03, y - 0.02, x + 0.05, y + 0.03, x + 0.08 * r(), y + 0.06);
    g.stroke();
  }
  // Trapped air bubbles: bright rim, faint fill.
  for (let k = 0; k < 4; k++) {
    const x = x0 + 0.15 * w + r() * 0.7 * w, y = y0 + 0.15 * h + r() * 0.7 * h, rad = 0.025 + r() * 0.05;
    g.fillStyle = 'rgba(255,255,255,0.12)';
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 0.006;
    g.beginPath();
    g.ellipse(x, y, rad, rad * (0.7 + r() * 0.3), r() * 3, 0, Math.PI * 2);
    g.fill();
    g.stroke();
  }
  // A thumbprint smudge.
  const fx = x0 + w * (0.3 + r() * 0.4), fy = y0 + h * (0.35 + r() * 0.3);
  g.strokeStyle = 'rgba(255,255,255,0.09)';
  g.lineWidth = 0.008;
  for (let k = 1; k < 9; k++) {
    g.beginPath();
    g.ellipse(fx, fy, k * 0.018, k * 0.024, 0.5, 0, Math.PI * 2);
    g.stroke();
  }
  // Edge line of the film itself.
  g.strokeStyle = 'rgba(255,255,255,0.4)';
  g.lineWidth = 0.008;
  g.strokeRect(x0 + 0.004, y0 + 0.004, w - 0.008, h - 0.008);
  // The pull tab: a printed, non-sticky corner.
  const tx = x0 + tabAt[0] * w, ty = y0 + (1 - tabAt[1]) * h;
  const ix = tx > x0 + w / 2 ? -1 : 1, iy = ty > y0 + h / 2 ? -1 : 1;
  g.fillStyle = tabColor;
  g.beginPath();
  g.moveTo(tx, ty);
  g.lineTo(tx + ix * 0.24, ty);
  g.quadraticCurveTo(tx + ix * 0.2, ty + iy * 0.2, tx, ty + iy * 0.24);
  g.closePath();
  g.fill();
  g.save();
  g.translate(tx + ix * 0.085, ty + iy * 0.085);
  g.rotate(ix * iy > 0 ? -Math.PI / 4 : Math.PI / 4);
  text(g, tabLabel, 0, 0, 0.055, '#fff', 800);
  g.restore();
}

// ------------------------------------------------------------------ phone

const TOY_SWATCHES = [
  ['#3a1c71', '#d76d77'],
  ['#11998e', '#38ef7d'],
  ['#f7971e', '#ffd200'],
  ['#1e3c72', '#6dd5fa'],
  ['#b3122e', '#ff6b6b'],
  ['#8e2de2', '#4a00e0'],
  ['#ff5f6d', '#ffc371'],
  ['#00b09b', '#96c93d'],
  ['#fc466b', '#3f5efb'],
  ['#f953c6', '#b91d73'],
  ['#43cea2', '#185a9d'],
  ['#ff9966', '#ff5e62'],
];
const TOY_NAMES = ['Ink', 'Goo', 'Sand', 'Pool', 'Splash', 'Cloth', 'Laundry', 'Thread', 'Fire', 'Jelly', 'Smash', 'Ferro'];

function phone(): Scene {
  const sx = 0.69, sy = 1.49;
  return {
    id: 'phone',
    label: 'Phone',
    bounds: [1.7, 3.3],
    film: { x0: -sx, y0: -sy, w: sx * 2, h: sy * 2, spacing: 0.062, tab: [1, 0], tabR: 0.26 },
    opaque: false,
    cutout: false,
    tint: [0.86, 0.93, 1.0],
    haze: 0.1,
    back: [0.92, 0.95, 1.0],
    reach: 2,
    hint: 'Grab the tab and roll the protector back',
    drawBase(g) {
      desk(g, '#e9dccb', '#dccab4', 11);
      // Phone body with a metal band.
      g.save();
      g.shadowColor = 'rgba(40,25,10,0.35)';
      g.shadowBlur = 40;
      g.shadowOffsetY = 18;
      rr(g, -0.8, -1.6, 1.6, 3.2, 0.26);
      g.fillStyle = '#2b2d33';
      g.fill();
      g.restore();
      const band = g.createLinearGradient(-0.8, 0, 0.8, 0);
      band.addColorStop(0, '#8d9098');
      band.addColorStop(0.1, '#e7e8ec');
      band.addColorStop(0.5, '#5d6068');
      band.addColorStop(0.9, '#d9dade');
      band.addColorStop(1, '#7c7f87');
      g.lineWidth = 0.03;
      g.strokeStyle = band;
      rr(g, -0.785, -1.585, 1.57, 3.17, 0.25);
      g.stroke();
      rr(g, -0.74, -1.54, 1.48, 3.08, 0.2);
      g.fillStyle = '#07080b';
      g.fill();
      // The screen: a bobo hub, inside a phone, inside bobo.
      g.save();
      rr(g, -0.71, -1.51, 1.42, 3.02, 0.18);
      g.clip();
      const wall = g.createLinearGradient(-0.7, -1.5, 0.7, 1.5);
      wall.addColorStop(0, '#2b1055');
      wall.addColorStop(0.45, '#7597de');
      wall.addColorStop(1, '#ff8fb1');
      g.fillStyle = wall;
      g.fillRect(-0.75, -1.55, 1.5, 3.1);
      const blob = (x: number, y: number, r: number, c: string) => {
        const gr = g.createRadialGradient(x, y, 0, x, y, r);
        gr.addColorStop(0, c);
        gr.addColorStop(1, 'rgba(255,255,255,0)');
        g.fillStyle = gr;
        g.fillRect(x - r, y - r, r * 2, r * 2);
      };
      blob(-0.4, -0.6, 0.8, 'rgba(255,120,200,0.55)');
      blob(0.5, 0.7, 0.9, 'rgba(90,220,255,0.45)');
      text(g, '9:41', -0.5, -1.4, 0.07, '#fff', 700);
      rr(g, -0.17, -1.46, 0.34, 0.1, 0.05);
      g.fillStyle = '#000';
      g.fill();
      text(g, 'bobo', 0, -1.12, 0.2, '#fff', 800);
      text(g, 'physics toys', 0, -0.98, 0.065, 'rgba(255,255,255,0.75)', 600);
      for (let k = 0; k < 12; k++) {
        const c = k % 3, r = Math.floor(k / 3);
        const x = -0.44 + c * 0.44, y = -0.62 + r * 0.46;
        const sw = TOY_SWATCHES[k];
        const gr = g.createLinearGradient(x - 0.15, y - 0.15, x + 0.15, y + 0.15);
        gr.addColorStop(0, sw[0]);
        gr.addColorStop(1, sw[1]);
        g.save();
        g.shadowColor = 'rgba(0,0,0,0.25)';
        g.shadowBlur = 8;
        rr(g, x - 0.15, y - 0.17, 0.3, 0.3, 0.075);
        g.fillStyle = gr;
        g.fill();
        g.restore();
        rr(g, x - 0.15, y - 0.17, 0.3, 0.15, 0.075);
        g.fillStyle = 'rgba(255,255,255,0.16)';
        g.fill();
        text(g, TOY_NAMES[k], x, y + 0.2, 0.05, 'rgba(255,255,255,0.92)', 600);
      }
      rr(g, -0.62, 1.12, 1.24, 0.3, 0.12);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      g.fill();
      ['#34c759', '#0a84ff', '#ff9f0a', '#ff375f'].forEach((c, k) => {
        rr(g, -0.53 + k * 0.29, 1.16, 0.22, 0.22, 0.06);
        g.fillStyle = c;
        g.fill();
      });
      g.restore();
    },
    drawGloss(g) {
      rr(g, -0.71, -1.51, 1.42, 3.02, 0.18);
      g.fillStyle = '#fff';
      g.fill();
      g.lineWidth = 0.03;
      g.strokeStyle = '#999';
      rr(g, -0.785, -1.585, 1.57, 3.17, 0.25);
      g.stroke();
    },
    drawPrint(g) {
      clearFilmPrint(g, -sx, -sy, sx * 2, sy * 2, 5, [1, 0], '#2f7bff', 'PULL');
    },
  };
}

// ------------------------------------------------------------------ sticker

export interface StickerDesign {
  name: string;
  fill: [string, string];
  path: (g: G) => void;
  face: boolean;
}

function starPath(g: G, points: number, inner: number) {
  g.beginPath();
  for (let k = 0; k < points * 2; k++) {
    const a = -Math.PI / 2 + (k * Math.PI) / points;
    const r = k % 2 ? inner : 1;
    g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
  }
  g.closePath();
}

export const DESIGNS: StickerDesign[] = [
  { name: 'Star', fill: ['#ffd23f', '#ff9f1c'], face: true, path: (g) => starPath(g, 5, 0.52) },
  {
    name: 'Heart',
    fill: ['#ff7aa2', '#ff2e63'],
    face: true,
    path: (g) => {
      g.beginPath();
      g.moveTo(0, 0.9);
      g.bezierCurveTo(-1.25, 0.05, -0.85, -1.05, 0, -0.45);
      g.bezierCurveTo(0.85, -1.05, 1.25, 0.05, 0, 0.9);
      g.closePath();
    },
  },
  {
    name: 'Cloud',
    fill: ['#bde0fe', '#7ab8ff'],
    face: true,
    path: (g) => {
      // A union of puffs (filled and outlined as one: interior outlines are painted over).
      g.beginPath();
      for (const [x, y, r] of [[-0.52, 0.12, 0.36], [-0.12, -0.22, 0.48], [0.42, -0.02, 0.4], [0.1, 0.22, 0.36]]) {
        g.moveTo(x + r, y);
        g.arc(x, y, r, 0, Math.PI * 2);
      }
      g.roundRect(-0.86, 0.02, 1.66, 0.46, 0.23);
    },
  },
  {
    name: 'Bolt',
    fill: ['#c3f73a', '#57cc04'],
    face: false,
    path: (g) => {
      g.beginPath();
      g.moveTo(0.18, -1);
      g.lineTo(-0.62, 0.12);
      g.lineTo(-0.06, 0.12);
      g.lineTo(-0.22, 1);
      g.lineTo(0.62, -0.18);
      g.lineTo(0.06, -0.18);
      g.closePath();
    },
  },
  {
    name: 'Flower',
    fill: ['#e0aaff', '#9d4edd'],
    face: true,
    path: (g) => {
      g.beginPath();
      for (let k = 0; k <= 180; k++) {
        const a = (k / 180) * Math.PI * 2;
        const r = 0.72 + 0.26 * Math.cos(a * 6);
        g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      }
      g.closePath();
    },
  },
  {
    name: 'Planet',
    fill: ['#ffb4a2', '#e5989b'],
    face: true,
    path: (g) => {
      g.beginPath();
      g.arc(0, 0, 0.72, 0, Math.PI * 2);
      g.closePath();
    },
  },
];

/** Paint a sticker (white die-cut border, glossy fill, a face) centred at 0, radius 1 in local units. */
export function paintSticker(g: G, d: StickerDesign) {
  g.save();
  g.lineJoin = 'round';
  g.lineWidth = 0.2;
  g.strokeStyle = '#fff';
  g.fillStyle = '#fff';
  d.path(g);
  g.stroke();
  g.fill();
  const gr = g.createLinearGradient(-0.8, -0.9, 0.7, 0.9);
  gr.addColorStop(0, d.fill[0]);
  gr.addColorStop(1, d.fill[1]);
  g.fillStyle = gr;
  d.path(g);
  g.fill();
  if (d.name === 'Planet') {
    g.strokeStyle = 'rgba(255,255,255,0.85)';
    g.lineWidth = 0.09;
    g.beginPath();
    g.ellipse(0, 0.05, 0.98, 0.26, -0.35, 0.1, Math.PI - 0.1);
    g.stroke();
  }
  // A glossy highlight clipped to the shape.
  g.save();
  d.path(g);
  g.clip();
  g.fillStyle = 'rgba(255,255,255,0.35)';
  g.beginPath();
  g.ellipse(-0.3, -0.45, 0.55, 0.25, -0.5, 0, Math.PI * 2);
  g.fill();
  g.restore();
  if (d.face) {
    g.fillStyle = '#2b1d2e';
    for (const x of [-0.2, 0.2]) {
      g.beginPath();
      g.ellipse(x, 0.02, 0.07, 0.1, 0, 0, Math.PI * 2);
      g.fill();
    }
    g.fillStyle = '#fff';
    for (const x of [-0.22, 0.18]) {
      g.beginPath();
      g.arc(x, -0.02, 0.025, 0, Math.PI * 2);
      g.fill();
    }
    g.strokeStyle = '#2b1d2e';
    g.lineWidth = 0.05;
    g.lineCap = 'round';
    g.beginPath();
    g.arc(0, 0.14, 0.1, 0.2, Math.PI - 0.2);
    g.stroke();
    g.fillStyle = 'rgba(255,90,120,0.45)';
    for (const x of [-0.36, 0.36]) {
      g.beginPath();
      g.ellipse(x, 0.16, 0.08, 0.05, 0, 0, Math.PI * 2);
      g.fill();
    }
  }
  g.restore();
}

function sticker(design: number): Scene {
  const d = DESIGNS[design % DESIGNS.length];
  const R = 0.62;
  const cx = 0, cy = -0.12; // art coords (y down): a little above centre
  const fx0 = cx - 0.78, fy0 = cy - 0.78, fw = 1.56, fh = 1.56;
  // Film rect in world coords (y up).
  const film: FilmSpec = { x0: fx0, y0: -(fy0 + fh), w: fw, h: fh, spacing: 0.052, tab: [0.8, 0.2], tabR: 0.16 };
  const scene: Scene = {
    id: 'sticker',
    label: 'Sticker',
    bounds: [1.8, 2.9],
    film,
    opaque: true,
    cutout: true,
    tint: [1, 1, 1],
    haze: 0,
    back: [0.95, 0.95, 0.97],
    reach: 1.5,
    hint: 'Lift the sticker from its corner',
    design,
    drawBase(g) {
      desk(g, '#cdeee4', '#b9e3d6', 23);
      // Backing sheet.
      g.save();
      g.shadowColor = 'rgba(20,60,50,0.3)';
      g.shadowBlur = 30;
      g.shadowOffsetY = 12;
      rr(g, -0.84, -1.3, 1.68, 2.6, 0.05);
      g.fillStyle = '#fbfaf7';
      g.fill();
      g.restore();
      // Grid printed on the liner, like a real sticker sheet.
      g.strokeStyle = 'rgba(120,150,190,0.18)';
      g.lineWidth = 0.004;
      for (let x = -0.8; x <= 0.8; x += 0.1) {
        g.beginPath();
        g.moveTo(x, -1.26);
        g.lineTo(x, 1.26);
        g.stroke();
      }
      for (let y = -1.26; y <= 1.26; y += 0.1) {
        g.beginPath();
        g.moveTo(-0.8, y);
        g.lineTo(0.8, y);
        g.stroke();
      }
      text(g, 'bobo stickers', 0, -1.16, 0.08, '#8aa0c2', 800);
      // The kiss-cut outline of the big sticker, pressed into the glossy liner.
      g.save();
      g.translate(cx, cy);
      g.scale(R, R);
      g.lineJoin = 'round';
      g.strokeStyle = 'rgba(150,160,180,0.55)';
      g.lineWidth = 0.21;
      d.path(g);
      g.stroke();
      g.strokeStyle = '#fbfaf7';
      g.lineWidth = 0.17;
      d.path(g);
      g.stroke();
      g.fillStyle = '#f1f3f7';
      d.path(g);
      g.fill();
      g.restore();
      // Small stickers still on the sheet.
      const small: [number, number, number, number][] = [
        [-0.52, 0.86, 0.2, 5],
        [0, 0.9, 0.2, (design + 2) % DESIGNS.length],
        [0.52, 0.86, 0.2, 3],
      ];
      for (const [x, y, r, k] of small) {
        g.save();
        g.translate(x, y);
        g.scale(r, r);
        paintSticker(g, DESIGNS[k]);
        g.restore();
      }
    },
    drawGloss(g) {
      rr(g, -0.84, -1.3, 1.68, 2.6, 0.05);
      g.fillStyle = 'rgba(255,255,255,0.35)';
      g.fill();
      g.save();
      g.translate(cx, cy);
      g.scale(R, R);
      g.fillStyle = '#fff';
      d.path(g);
      g.fill();
      g.restore();
    },
    drawPrint(g) {
      g.save();
      g.translate(cx, cy);
      g.scale(R, R);
      paintSticker(g, d);
      g.restore();
    },
  };
  return scene;
}

// ------------------------------------------------------------------ tape

function tape(): Scene {
  const x0 = -0.3, x1 = 0.06; // tape edges (the crisp line is at x1)
  const y0 = -1.7, y1 = 1.7;
  const A = '#5e8c7a';
  const B = '#ff7b54';
  const brush = (y: number) => x1 - 0.13 + 0.03 * Math.sin(y * 7.3) + 0.02 * Math.sin(y * 23.1 + 1);
  return {
    id: 'tape',
    label: 'Tape',
    bounds: [1.7, 3.6],
    film: { x0, y0, w: x1 - x0, h: y1 - y0, spacing: 0.045, tab: [0.5, 0], tabR: 0.2 },
    opaque: true,
    cutout: false,
    tint: [1, 1, 1],
    haze: 0,
    back: [0.93, 0.88, 0.76],
    reach: 2,
    hint: 'Peel the tape back along itself',
    drawBase(g) {
      // Wall: the first colour, dry and matt; then fresh paint right of the tape line.
      g.fillStyle = A;
      g.fillRect(-40, -40, 80, 80);
      const r = rng(7);
      for (let k = 0; k < 900; k++) {
        g.fillStyle = `rgba(255,255,255,${r() * 0.05})`;
        g.fillRect(-2 + r() * 4, -3 + r() * 6, 0.01, 0.01);
      }
      g.fillStyle = B;
      g.fillRect(x1, -40, 40, 80);
      // Roller stipple in the wet paint, and a soft light falloff down the wall.
      for (let k = 0; k < 2600; k++) {
        g.fillStyle = `rgba(${r() < 0.5 ? '255,235,225' : '150,40,20'},${0.05 + r() * 0.08})`;
        g.fillRect(x1 + r() * 2.2, -2.4 + r() * 4.2, 0.006 + r() * 0.01, 0.006 + r() * 0.01);
      }
      const light = g.createLinearGradient(0, -2.4, 0, 1.8);
      light.addColorStop(0, 'rgba(255,255,255,0.08)');
      light.addColorStop(1, 'rgba(0,0,0,0.12)');
      g.fillStyle = light;
      g.fillRect(-40, -40, 80, 41.78);
      // A skirting board and a light switch for scale.
      g.fillStyle = '#f4efe6';
      g.fillRect(-40, 1.78, 80, 40);
      g.fillStyle = 'rgba(0,0,0,0.15)';
      g.fillRect(-40, 1.78, 80, 0.02);
    },
    drawGloss(g) {
      g.fillStyle = '#fff';
      g.fillRect(x1, -40, 40, 41.78);
    },
    drawPrint(g) {
      // Crepe paper: warm beige with fine crinkles across the tape.
      g.fillStyle = '#e8d9ae';
      g.fillRect(x0, y0, x1 - x0, y1 - y0);
      const r = rng(3);
      for (let y = y0; y < y1; y += 0.008) {
        g.fillStyle = `rgba(${r() < 0.5 ? '255,250,230' : '150,120,60'},${0.03 + r() * 0.05})`;
        g.fillRect(x0, y, x1 - x0, 0.004);
      }
      for (let k = 0; k < 500; k++) {
        g.fillStyle = `rgba(140,110,50,${0.05 + r() * 0.08})`;
        g.fillRect(x0 + r() * (x1 - x0), y0 + r() * (y1 - y0), 0.003, 0.02 + r() * 0.04);
      }
      // Paint brushed over the tape from the right, with a ragged dry-brush edge.
      g.fillStyle = B;
      g.beginPath();
      g.moveTo(x1 + 0.01, y0);
      for (let y = y0; y <= y1; y += 0.02) g.lineTo(brush(y), y);
      g.lineTo(x1 + 0.01, y1);
      g.closePath();
      g.fill();
      for (let k = 0; k < 160; k++) {
        const y = y0 + r() * (y1 - y0);
        g.fillStyle = `rgba(255,123,84,${0.4 + r() * 0.5})`;
        g.fillRect(brush(y) - 0.04 * r(), y, 0.05, 0.004 + r() * 0.01);
      }
      // The folded-over dry end you grab.
      g.fillStyle = 'rgba(120,90,40,0.25)';
      g.fillRect(x0, y1 - 0.2, x1 - x0, 0.2);
      text(g, '↑', (x0 + x1) / 2, y1 - 0.1, 0.12, 'rgba(90,60,20,0.6)', 800);
    },
  };
}

// ------------------------------------------------------------------ gadget

function gadget(): Scene {
  const fx = 0.7, fy = 1.24;
  return {
    id: 'gadget',
    label: 'Gadget',
    bounds: [1.8, 3.0],
    film: { x0: -fx, y0: -fy, w: fx * 2, h: fy * 2, spacing: 0.062, tab: [0, 1], tabR: 0.26 },
    opaque: false,
    cutout: false,
    tint: [0.82, 0.9, 1.0],
    haze: 0.14,
    back: [0.9, 0.94, 1.0],
    reach: 2,
    hint: 'Grab the tab, peel the film off the shiny new toy',
    drawBase(g) {
      desk(g, '#2c3440', '#252c36', 31);
      g.save();
      g.shadowColor = 'rgba(0,0,0,0.55)';
      g.shadowBlur = 50;
      g.shadowOffsetY = 20;
      rr(g, -0.8, -1.34, 1.6, 2.68, 0.3);
      g.fillStyle = '#d7263d';
      g.fill();
      g.restore();
      // Candy-red lacquer: deep gradient plus a sky reflection band.
      const body = g.createLinearGradient(-0.8, -1.34, 0.8, 1.34);
      body.addColorStop(0, '#ff5a6e');
      body.addColorStop(0.45, '#d7263d');
      body.addColorStop(1, '#7d0a1c');
      rr(g, -0.8, -1.34, 1.6, 2.68, 0.3);
      g.fillStyle = body;
      g.fill();
      g.save();
      rr(g, -0.8, -1.34, 1.6, 2.68, 0.3);
      g.clip();
      g.fillStyle = 'rgba(255,255,255,0.18)';
      g.beginPath();
      g.moveTo(-0.8, -0.2);
      g.lineTo(0.8, -1.0);
      g.lineTo(0.8, -0.75);
      g.lineTo(-0.8, 0.05);
      g.fill();
      g.restore();
      // Screen bezel and glass.
      rr(g, -0.62, -1.12, 1.24, 1.02, 0.08);
      g.fillStyle = '#1b1c22';
      g.fill();
      const scr = g.createLinearGradient(-0.5, -1, 0.5, -0.2);
      scr.addColorStop(0, '#9be15d');
      scr.addColorStop(1, '#00b894');
      rr(g, -0.5, -1.02, 1.0, 0.82, 0.03);
      g.fillStyle = scr;
      g.fill();
      text(g, 'bobo', 0, -0.68, 0.2, '#0b3d2e', 800);
      text(g, 'PRESS START', 0, -0.44, 0.06, '#0b3d2e', 700);
      text(g, 'bobo boy', -0.42, -0.02, 0.07, 'rgba(255,255,255,0.85)', 800, 'left');
      // D-pad.
      g.fillStyle = '#2a2a33';
      rr(g, -0.56, 0.36, 0.36, 0.12, 0.03);
      g.fill();
      rr(g, -0.44, 0.24, 0.12, 0.36, 0.03);
      g.fill();
      // A / B buttons.
      for (const [x, y] of [[0.46, 0.34], [0.24, 0.48]] as [number, number][]) {
        const bg = g.createRadialGradient(x - 0.03, y - 0.03, 0.01, x, y, 0.1);
        bg.addColorStop(0, '#ffe066');
        bg.addColorStop(1, '#f2a900');
        g.fillStyle = bg;
        g.beginPath();
        g.arc(x, y, 0.09, 0, Math.PI * 2);
        g.fill();
      }
      for (const x of [-0.16, 0.08]) {
        rr(g, x, 0.78, 0.14, 0.05, 0.025);
        g.fillStyle = '#5c0b17';
        g.fill();
      }
      g.fillStyle = 'rgba(60,0,10,0.5)';
      for (let k = 0; k < 6; k++) {
        rr(g, 0.28 + k * 0.05, 0.95, 0.02, 0.22, 0.01);
        g.fill();
      }
    },
    drawGloss(g) {
      rr(g, -0.8, -1.34, 1.6, 2.68, 0.3);
      g.fillStyle = '#fff';
      g.fill();
    },
    drawPrint(g) {
      g.save();
      g.rotate(-0.5);
      for (let r = -6; r <= 6; r++)
        for (let c = -2; c <= 2; c++) text(g, 'REMOVE BEFORE USE', c * 0.9 + (r % 2) * 0.45, r * 0.26, 0.055, 'rgba(90,170,255,0.28)', 800);
      g.restore();
      clearFilmPrint(g, -fx, -fy, fx * 2, fy * 2, 9, [0, 1], '#20c997', 'PEEL');
    },
  };
}

function desk(g: G, a: string, b: string, seed: number) {
  // Far past any screen edge, landscape included.
  g.fillStyle = a;
  g.fillRect(-40, -40, 80, 80);
  const r = rng(seed);
  for (let k = 0; k < 60; k++) {
    g.fillStyle = b;
    g.globalAlpha = 0.25 + r() * 0.3;
    g.fillRect(-40, -3 + r() * 6, 80, 0.004 + r() * 0.01);
  }
  g.globalAlpha = 1;
}

export const SCENES: SceneId[] = ['phone', 'sticker', 'tape', 'gadget'];

export function makeScene(id: SceneId, design = 0): Scene {
  return id === 'phone' ? phone() : id === 'sticker' ? sticker(design) : id === 'tape' ? tape() : gadget();
}
