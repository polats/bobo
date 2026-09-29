// The letters: a harmless cover note in ordinary ink, with the real message written between the lines
// in invisible ink. Positions are fractions of the sheet (x right, y down from the top); sizes are in
// world units (the screen's short side = 1).

export interface Line {
  text: string;
  x: number;
  y: number;
  size: number;
  /** 'center' by default. */
  align?: CanvasTextAlign;
  /** Second ink: develops only at a hotter spot, just short of scorching. */
  inkB?: boolean;
}

export interface Letter {
  name: string;
  w: number;
  h: number;
  /** Draught strength: bends the flame (and its heat) side to side. */
  wind: number;
  cover: Line[];
  hidden: Line[];
  /** Optional sketch map in hidden ink, drawn into a box given in sheet fractions. */
  map?: { x: number; y: number; w: number; h: number; inkB?: boolean; kind: 'pier' | 'vault' };
  /** Hint shown as the letter arrives. */
  hint: string;
  /** Shown on the decode card. */
  decoded: string;
}

const hand = (text: string, x: number, y: number, align: CanvasTextAlign = 'left'): Line => ({ text, x, y, size: 0.042, align });

export const LETTERS: Letter[] = [
  {
    name: 'Aunt Mildred',
    w: 0.86,
    h: 0.6,
    wind: 0,
    cover: [
      hand('Dearest Aunt Mildred,', 0.08, 0.12),
      hand('The garden is lovely this spring', 0.08, 0.35),
      hand('and the roses all send their love.', 0.08, 0.58),
      hand('Yours ever, Pip', 0.92, 0.84, 'right'),
    ],
    hidden: [
      { text: "THE MINISTER'S", x: 0.5, y: 0.25, size: 0.075 },
      { text: 'PARROT IS A SPY', x: 0.5, y: 0.47, size: 0.075 },
      { text: 'feed it nothing', x: 0.36, y: 0.71, size: 0.05 },
    ],
    hint: 'Drag the letter over the candle. Gently!',
    decoded: "The minister's parrot is a spy. Feed it nothing.",
  },
  {
    name: 'Cousin Bertram',
    w: 0.9,
    h: 0.66,
    wind: 0,
    cover: [
      hand('Dear Cousin,', 0.08, 0.1),
      hand('Weather fine. Fish biting.', 0.08, 0.32),
      hand('Uncle sends his regards.', 0.08, 0.56),
      hand('Do write soon. B.', 0.92, 0.86, 'right'),
    ],
    hidden: [
      { text: 'DROP AT', x: 0.27, y: 0.22, size: 0.07 },
      { text: 'PIER 9', x: 0.27, y: 0.44, size: 0.085 },
      { text: 'MIDNIGHT', x: 0.27, y: 0.68, size: 0.06 },
    ],
    map: { x: 0.52, y: 0.14, w: 0.42, h: 0.62, kind: 'pier' },
    hint: 'A map is hiding in this one.',
    decoded: 'Drop at Pier 9, midnight. (Follow the map.)',
  },
  {
    name: 'The Draught',
    w: 0.94,
    h: 0.68,
    wind: 0.6,
    cover: [
      hand('My dear Colonel,', 0.08, 0.1),
      hand('Thank you for the lovely jam.', 0.08, 0.33),
      hand('We had it with scones on Sunday.', 0.08, 0.56),
      hand('Warmly, Mrs. H.', 0.92, 0.86, 'right'),
    ],
    hidden: [
      { text: 'THE CODE WORD IS', x: 0.5, y: 0.22, size: 0.06 },
      { text: 'MARMALADE', x: 0.5, y: 0.45, size: 0.095 },
      { text: 'not jam. never jam.', x: 0.5, y: 0.69, size: 0.05 },
    ],
    hint: 'A draught is bending the flame.',
    decoded: 'The code word is MARMALADE. Not jam. Never jam.',
  },
  {
    name: 'Two Inks',
    w: 1.0,
    h: 0.72,
    wind: 0.25,
    cover: [
      hand('Darling Lottie,', 0.08, 0.1),
      hand('The embassy ball is on Friday.', 0.08, 0.32),
      hand('Everyone who is anyone will be there.', 0.08, 0.55),
      hand('Kisses, Dot', 0.92, 0.84, 'right'),
    ],
    hidden: [
      { text: 'THE BALL IS A TRAP', x: 0.5, y: 0.21, size: 0.068 },
      { text: 'WEAR THE RED TIE', x: 0.5, y: 0.44, size: 0.068, inkB: true },
      { text: 'and dance badly', x: 0.5, y: 0.67, size: 0.05 },
    ],
    hint: 'Two inks: the blue one needs more heat.',
    decoded: 'The ball is a trap. Wear the red tie, and dance badly.',
  },
  {
    name: 'The Mole',
    w: 1.14,
    h: 0.8,
    wind: 0.7,
    cover: [
      hand('To the Committee,', 0.07, 0.09),
      hand('Minutes of the flower show are attached.', 0.07, 0.29),
      hand('The judging was, as ever, entirely fair.', 0.07, 0.49),
      hand('The prize marrow was unusually large.', 0.07, 0.69),
      hand('Respectfully, the Secretary', 0.93, 0.88, 'right'),
    ],
    hidden: [
      { text: 'THE MOLE IS', x: 0.3, y: 0.19, size: 0.07 },
      { text: 'THE TEA LADY', x: 0.3, y: 0.39, size: 0.07, inkB: true },
      { text: 'meet at the vault', x: 0.3, y: 0.59, size: 0.05 },
      { text: 'eat this letter', x: 0.3, y: 0.79, size: 0.045 },
    ],
    map: { x: 0.6, y: 0.14, w: 0.35, h: 0.66, kind: 'vault', inkB: true },
    hint: 'Big sheet, strong draught, two inks.',
    decoded: 'The mole is the tea lady. Meet at the vault. Eat this letter.',
  },
];

export interface Word {
  /** Sheet-fraction box, y down. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  inkB: boolean;
  shown: boolean;
  lost: boolean;
}

const HIDDEN_FONT = "700 {px}px Georgia, 'Times New Roman', serif";
const HAND_FONT = "italic {px}px 'Snell Roundhand', 'Apple Chancery', 'Segoe Script', 'Brush Script MT', cursive";

/**
 * Paint the letter's inks into an RGB mask (r = hidden ink A, g = hidden ink B, b = cover ink), sized
 * `pxPerUnit` pixels per world unit, and list the hidden words' boxes so they can tick as they appear.
 */
export function paintLetter(L: Letter, pxPerUnit: number) {
  const W = Math.round(L.w * pxPerUnit), H = Math.round(L.h * pxPerUnit);
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true })!;
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  g.textBaseline = 'middle';
  const words: Word[] = [];

  const line = (ln: Line, font: string, color: string, track: boolean) => {
    let px = ln.size * pxPerUnit;
    g.font = font.replace('{px}', px.toFixed(1));
    let tw = g.measureText(ln.text).width;
    const max = W * 0.9;
    if (tw > max) {
      px *= max / tw;
      g.font = font.replace('{px}', px.toFixed(1));
      tw = max;
    }
    const align = ln.align ?? 'center';
    let x = ln.x * W - (align === 'center' ? tw / 2 : align === 'right' ? tw : 0);
    const y = ln.y * H;
    g.textAlign = 'left';
    g.fillStyle = color;
    g.fillText(ln.text, x, y);
    if (!track) return;
    const space = g.measureText(' ').width;
    for (const word of ln.text.split(' ')) {
      const ww = g.measureText(word).width;
      words.push({ x0: x / W, x1: (x + ww) / W, y0: (y - px * 0.45) / H, y1: (y + px * 0.45) / H, inkB: !!ln.inkB, shown: false, lost: false });
      x += ww + space;
    }
  };

  for (const ln of L.cover) line(ln, HAND_FONT, '#0000ff', false);
  for (const ln of L.hidden) line(ln, HIDDEN_FONT, ln.inkB ? '#00ff00' : '#ff0000', true);
  if (L.map) {
    const m = L.map;
    g.save();
    g.translate(m.x * W, m.y * H);
    const s = Math.min(m.w * W, m.h * H);
    const col = m.inkB ? '#00ff00' : '#ff0000';
    g.strokeStyle = g.fillStyle = col;
    g.lineCap = g.lineJoin = 'round';
    if (m.kind === 'pier') drawPier(g, m.w * W, m.h * H, s);
    else drawVault(g, m.w * W, m.h * H, s);
    g.restore();
    words.push({ x0: m.x, x1: m.x + m.w, y0: m.y, y1: m.y + m.h, inkB: !!m.inkB, shown: false, lost: false });
  }
  return { canvas: c, words, W, H };
}

/** A shoreline, a pier with numbered berths, a dotted route and an X. */
function drawPier(g: CanvasRenderingContext2D, w: number, h: number, s: number) {
  g.lineWidth = s * 0.018;
  g.beginPath();
  g.moveTo(w * 0.05, 0);
  g.bezierCurveTo(w * 0.35, h * 0.2, w * 0.05, h * 0.45, w * 0.3, h * 0.6);
  g.bezierCurveTo(w * 0.5, h * 0.72, w * 0.25, h * 0.9, w * 0.4, h);
  g.stroke();
  // Waves offshore.
  g.lineWidth = s * 0.012;
  for (let k = 0; k < 4; k++) {
    const x = w * (0.62 + (k % 2) * 0.2), y = h * (0.12 + k * 0.22);
    g.beginPath();
    g.moveTo(x - s * 0.05, y);
    g.quadraticCurveTo(x - s * 0.025, y - s * 0.03, x, y);
    g.quadraticCurveTo(x + s * 0.025, y + s * 0.03, x + s * 0.05, y);
    g.stroke();
  }
  // The pier, sticking out to sea.
  g.lineWidth = s * 0.016;
  g.strokeRect(w * 0.3, h * 0.44, w * 0.5, h * 0.07);
  for (let k = 1; k < 5; k++) {
    g.beginPath();
    g.moveTo(w * (0.3 + k * 0.1), h * 0.44);
    g.lineTo(w * (0.3 + k * 0.1), h * 0.51);
    g.stroke();
  }
  g.font = `700 ${Math.round(s * 0.1)}px Georgia, serif`;
  g.textAlign = 'center';
  g.fillText('9', w * 0.75, h * 0.4);
  // Route from the road to the pier's end.
  g.setLineDash([s * 0.03, s * 0.035]);
  g.lineWidth = s * 0.014;
  g.beginPath();
  g.moveTo(w * 0.1, h * 0.95);
  g.bezierCurveTo(w * 0.1, h * 0.7, w * 0.25, h * 0.62, w * 0.45, h * 0.58);
  g.lineTo(w * 0.72, h * 0.56);
  g.stroke();
  g.setLineDash([]);
  cross(g, w * 0.75, h * 0.61, s * 0.06, s * 0.03);
  // Compass.
  g.lineWidth = s * 0.012;
  g.beginPath();
  g.moveTo(w * 0.85, h * 0.95);
  g.lineTo(w * 0.85, h * 0.78);
  g.lineTo(w * 0.82, h * 0.83);
  g.stroke();
  g.font = `700 ${Math.round(s * 0.07)}px Georgia, serif`;
  g.fillText('N', w * 0.85, h * 0.73);
}

/** A floor plan: rooms, a stair, the vault door and an X. */
function drawVault(g: CanvasRenderingContext2D, w: number, h: number, s: number) {
  g.lineWidth = s * 0.02;
  g.strokeRect(w * 0.05, h * 0.05, w * 0.9, h * 0.9);
  g.lineWidth = s * 0.014;
  g.beginPath();
  g.moveTo(w * 0.05, h * 0.4);
  g.lineTo(w * 0.6, h * 0.4);
  g.moveTo(w * 0.6, h * 0.05);
  g.lineTo(w * 0.6, h * 0.62);
  g.moveTo(w * 0.35, h * 0.4);
  g.lineTo(w * 0.35, h * 0.95);
  g.stroke();
  // Stairs.
  for (let k = 0; k < 5; k++) {
    g.beginPath();
    g.moveTo(w * 0.1, h * (0.1 + k * 0.055));
    g.lineTo(w * 0.28, h * (0.1 + k * 0.055));
    g.stroke();
  }
  // Vault door: a circle with a wheel.
  const cx = w * 0.72, cy = h * 0.78, r = s * 0.1;
  g.beginPath();
  g.arc(cx, cy, r, 0, Math.PI * 2);
  g.stroke();
  for (let k = 0; k < 3; k++) {
    const a = (k * Math.PI) / 3;
    g.beginPath();
    g.moveTo(cx - Math.cos(a) * r * 0.6, cy - Math.sin(a) * r * 0.6);
    g.lineTo(cx + Math.cos(a) * r * 0.6, cy + Math.sin(a) * r * 0.6);
    g.stroke();
  }
  g.setLineDash([s * 0.03, s * 0.035]);
  g.beginPath();
  g.moveTo(w * 0.2, h * 0.38);
  g.lineTo(w * 0.2, h * 0.6);
  g.lineTo(w * 0.5, h * 0.6);
  g.lineTo(w * 0.5, h * 0.78);
  g.lineTo(cx - r * 1.3, cy);
  g.stroke();
  g.setLineDash([]);
  cross(g, w * 0.8, h * 0.2, s * 0.06, s * 0.03);
  g.font = `700 ${Math.round(s * 0.075)}px Georgia, serif`;
  g.textAlign = 'center';
  g.fillText('VAULT', cx, cy - r * 1.55);
}

function cross(g: CanvasRenderingContext2D, x: number, y: number, r: number, lw: number) {
  g.lineWidth = lw;
  g.beginPath();
  g.moveTo(x - r, y - r);
  g.lineTo(x + r, y + r);
  g.moveTo(x + r, y - r);
  g.lineTo(x - r, y + r);
  g.stroke();
}
