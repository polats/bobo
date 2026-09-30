// Canvas 2D: a warm kitchen wall and a wooden table seen from the side, the rods drawn as shaded
// cylinders (edge, body, translucent core, highlight), with die-cut striations that spiral with the
// simulated twist field, hairline cracks where layers have gone, soft table shadows and crumbs.

import type { Rod, World } from './sim';

export interface View {
  /** Device pixels per metre, the table's front edge (device px) and how far back the table top goes. */
  ppm: number;
  floorY: number;
  band: number;
  width: number;
  height: number;
  /** Device px per CSS px. */
  dpr: number;
}

/** Table depth (0 front .. 1 back) as metres of screen rise. */
export const DEPTH_RISE = 0.055;

export function makeView(width: number, height: number, dpr: number): View {
  // Portrait phones see ~28 cm of table; wide screens keep the height sensible.
  const ppm = Math.min(width / 0.28, height / 0.36);
  const floorY = height * 0.8;
  return { ppm, floorY, band: DEPTH_RISE * ppm, width, height, dpr };
}

export function worldHalfWidth(v: View) {
  return v.width / 2 / v.ppm;
}

/** World (m) to device px, with the rod's table depth lifting it up the screen. */
export function toScreen(v: View, x: number, y: number, depth: number): [number, number] {
  return [v.width / 2 + x * v.ppm, v.floorY - y * v.ppm - depth * v.band];
}

export class Painter {
  private bg: HTMLCanvasElement;
  private bgKey = '';

  constructor(private g: CanvasRenderingContext2D) {
    this.bg = document.createElement('canvas');
  }

  draw(v: View, w: World, fingers: { x: number; y: number }[], t: number) {
    const g = this.g;
    this.background(v);
    g.drawImage(this.bg, 0, 0);
    const rods = [...w.rods].sort((a, b) => b.depth - a.depth);
    for (const r of rods) this.shadow(v, r);
    for (const c of w.crumbs) this.crumb(v, c.x, c.y, c.depth, c.size, c.color);
    for (const r of rods) this.rod(v, r);
    // Fingertips: a soft warm glow where each finger holds.
    for (const f of fingers) {
      const rad = 22 * v.dpr;
      const grd = g.createRadialGradient(f.x, f.y, 0, f.x, f.y, rad);
      grd.addColorStop(0, 'rgba(255,236,200,0.28)');
      grd.addColorStop(1, 'rgba(255,236,200,0)');
      g.fillStyle = grd;
      g.beginPath();
      g.arc(f.x, f.y, rad, 0, Math.PI * 2);
      g.fill();
    }
    void t;
  }

  private background(v: View) {
    const key = `${v.width}x${v.height}`;
    if (key === this.bgKey) return;
    this.bgKey = key;
    const c = this.bg;
    c.width = v.width;
    c.height = v.height;
    const g = c.getContext('2d')!;
    const W = v.width, H = v.height;
    const back = v.floorY - v.band * 1.25;
    // Wall: warm plaster, lit from a window up and to the left.
    const wall = g.createLinearGradient(0, 0, 0, back);
    wall.addColorStop(0, '#e9d3b2');
    wall.addColorStop(1, '#d9bc93');
    g.fillStyle = wall;
    g.fillRect(0, 0, W, back);
    const sun = g.createRadialGradient(W * 0.18, H * 0.12, 0, W * 0.18, H * 0.12, Math.max(W, H) * 0.75);
    sun.addColorStop(0, 'rgba(255,244,222,0.75)');
    sun.addColorStop(0.5, 'rgba(255,236,205,0.2)');
    sun.addColorStop(1, 'rgba(255,236,205,0)');
    g.fillStyle = sun;
    g.fillRect(0, 0, W, back);
    // Plaster speckle.
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < (W * back) / 900; i++) {
      g.fillStyle = rnd() < 0.5 ? 'rgba(120,80,40,0.035)' : 'rgba(255,255,255,0.05)';
      g.fillRect(rnd() * W, rnd() * back, 1.5 * v.dpr, 1.5 * v.dpr);
    }
    // A tiled backsplash strip just above the table.
    const tileH = v.band * 1.7;
    const t0 = back - tileH;
    g.fillStyle = '#efe4cf';
    g.fillRect(0, t0, W, tileH);
    const tile = tileH / 2;
    g.strokeStyle = 'rgba(150,120,85,0.35)';
    g.lineWidth = Math.max(1, v.dpr * 0.8);
    for (let row = 0; row < 2; row++) {
      const y = t0 + row * tile;
      g.beginPath();
      g.moveTo(0, y);
      g.lineTo(W, y);
      g.stroke();
      for (let x = (row % 2) * tile * 0.5; x < W; x += tile) {
        g.beginPath();
        g.moveTo(x, y);
        g.lineTo(x, y + tile);
        g.stroke();
      }
    }
    const glaze = g.createLinearGradient(0, t0, 0, back);
    glaze.addColorStop(0, 'rgba(255,255,255,0.25)');
    glaze.addColorStop(1, 'rgba(120,90,60,0.12)');
    g.fillStyle = glaze;
    g.fillRect(0, t0, W, tileH);
    // Table top: warm oak seen at a low angle, grain running across.
    const top = g.createLinearGradient(0, back, 0, v.floorY);
    top.addColorStop(0, '#9a6a3f');
    top.addColorStop(1, '#c08a55');
    g.fillStyle = top;
    g.fillRect(0, back, W, v.floorY - back);
    for (let i = 0; i < 90; i++) {
      const y = back + (v.floorY - back) * Math.pow(rnd(), 0.8);
      const amp = (1 + rnd() * 3) * v.dpr * ((y - back) / (v.floorY - back) + 0.2);
      const k = 0.002 + rnd() * 0.006;
      const ph = rnd() * 6;
      g.strokeStyle = `rgba(${rnd() < 0.5 ? '90,55,28' : '230,190,140'},${0.05 + rnd() * 0.1})`;
      g.lineWidth = (0.6 + rnd() * 1.4) * v.dpr;
      g.beginPath();
      for (let x = 0; x <= W; x += 12 * v.dpr) {
        const yy = y + Math.sin(x * k + ph) * amp;
        if (x === 0) g.moveTo(x, yy);
        else g.lineTo(x, yy);
      }
      g.stroke();
    }
    const sheen = g.createRadialGradient(W * 0.3, back, 0, W * 0.3, back, W * 0.8);
    sheen.addColorStop(0, 'rgba(255,230,190,0.35)');
    sheen.addColorStop(1, 'rgba(255,230,190,0)');
    g.fillStyle = sheen;
    g.fillRect(0, back, W, v.floorY - back);
    // Front edge and the shadow under the table.
    const edge = 0.018 * v.ppm;
    const fe = g.createLinearGradient(0, v.floorY, 0, v.floorY + edge);
    fe.addColorStop(0, '#d79b5f');
    fe.addColorStop(0.25, '#a8703f');
    fe.addColorStop(1, '#6b4323');
    g.fillStyle = fe;
    g.fillRect(0, v.floorY, W, edge);
    const under = g.createLinearGradient(0, v.floorY + edge, 0, H);
    under.addColorStop(0, '#3a2718');
    under.addColorStop(1, '#241810');
    g.fillStyle = under;
    g.fillRect(0, v.floorY + edge, W, H - v.floorY - edge);
  }

  /** A soft shadow on the table top straight below the rod, fading and spreading with height. */
  private shadow(v: View, r: Rod) {
    const g = this.g;
    const R = r.mat.r * r.mat.drawScale * v.ppm;
    const ty = v.floorY - r.depth * v.band;
    let h = 0;
    for (let i = 0; i < r.n; i++) h += r.y[i];
    h = Math.max(0, h / r.n - r.mat.r);
    const spread = 1 + h * 40;
    const a = 0.32 / spread;
    if (a < 0.01) return;
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    for (const [wid, al] of [
      [2.8, 0.45],
      [1.6, 1],
    ] as const) {
      g.strokeStyle = `rgba(50,28,12,${a * al})`;
      g.lineWidth = R * wid * spread;
      g.beginPath();
      for (let i = 0; i < r.n; i++) {
        const x = v.width / 2 + r.x[i] * v.ppm + h * v.ppm * 0.25;
        const y = ty + R * 0.8 - Math.max(0, r.y[i] - r.mat.r) * v.ppm * 0.08;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      }
      g.stroke();
    }
    g.restore();
  }

  private crumb(v: View, x: number, y: number, depth: number, size: number, color: string) {
    const [sx, sy] = toScreen(v, x, y, depth);
    const s = Math.max(1.2 * v.dpr, size * v.ppm * 2);
    this.g.fillStyle = color;
    this.g.fillRect(sx - s / 2, sy - s / 2, s, s * 0.7);
  }

  private rod(v: View, r: Rod) {
    const g = this.g;
    const m = r.mat;
    const R = m.r * m.drawScale * v.ppm;
    const n = r.n;
    const X = scratchX(n), Y = scratchY(n);
    for (let i = 0; i < n; i++) {
      X[i] = v.width / 2 + r.x[i] * v.ppm;
      Y[i] = v.floorY - r.y[i] * v.ppm - r.depth * v.band;
    }
    const path = (dx: number, dy: number) => {
      g.beginPath();
      g.moveTo(X[0] + dx, Y[0] + dy);
      for (let i = 1; i < n; i++) g.lineTo(X[i] + dx, Y[i] + dy);
    };
    g.save();
    g.lineCap = 'round';
    g.lineJoin = 'round';
    // Edge (the rim of a translucent cylinder reads darker and more saturated), body, glowing core, highlight.
    g.globalAlpha = 0.92;
    g.strokeStyle = m.edge;
    g.lineWidth = R * 2;
    path(0, 0);
    g.stroke();
    g.globalAlpha = 1;
    g.strokeStyle = m.base;
    g.lineWidth = R * 1.45;
    path(0, -R * 0.08);
    g.stroke();
    g.globalAlpha = m.id === 'spaghetti' ? 0.75 : 0.45;
    g.strokeStyle = m.core;
    g.lineWidth = R * 0.75;
    path(0, -R * 0.22);
    g.stroke();
    // Striations: longitudinal die marks (grain, for wood) at fixed angles round the section; they
    // turn with the twist θ, so a twisted rod shows them spiralling and a released one unwinding.
    this.striations(v, r, X, Y, R);
    g.globalAlpha = m.id === 'lead' ? 0.55 : 0.7;
    g.strokeStyle = m.id === 'lead' ? '#cfd3dc' : '#fffbea';
    g.lineWidth = Math.max(0.8 * v.dpr, R * 0.28);
    path(0, -R * 0.52);
    g.stroke();
    // Hairline cracks on the stretched side where layers have given way.
    g.globalAlpha = 1;
    for (let i = 1; i < n - 1; i++) {
      const d = r.D[i];
      if (d <= 0.004) continue;
      const tx = X[i + 1] - X[i - 1], ty = Y[i + 1] - Y[i - 1];
      const tl = Math.hypot(tx, ty) || 1;
      let nx = -ty / tl, ny = tx / tl;
      // Tension side: away from the centre of curvature.
      const cx = X[i - 1] + X[i + 1] - 2 * X[i], cy = Y[i - 1] + Y[i + 1] - 2 * Y[i];
      if (nx * cx + ny * cy > 0) (nx = -nx), (ny = -ny);
      const len = R * Math.min(2, 0.4 + d * 5);
      g.strokeStyle = m.fibrous ? 'rgba(60,35,15,0.85)' : `rgba(255,255,240,${Math.min(0.95, 0.35 + d * 6)})`;
      g.lineWidth = Math.max(0.8, R * 0.18);
      g.beginPath();
      g.moveTo(X[i] + nx * R, Y[i] + ny * R);
      g.lineTo(X[i] + nx * (R - len), Y[i] + ny * (R - len));
      g.stroke();
    }
    g.restore();
  }

  private striations(v: View, r: Rod, X: Float64Array, Y: Float64Array, R: number) {
    const g = this.g;
    const n = r.n, m = r.mat;
    const lines = m.id === 'lead' ? 0 : m.id === 'spaghetti' ? 3 : 5;
    if (!lines || R < 1.5) return;
    g.strokeStyle = m.id === 'spaghetti' ? 'rgba(170,120,40,0.45)' : 'rgba(80,50,25,0.4)';
    g.lineWidth = Math.max(0.6 * v.dpr, R * 0.14);
    g.globalAlpha = 1;
    for (let k = 0; k < lines; k++) {
      const ph = (k * 2 * Math.PI) / lines + 0.4;
      g.beginPath();
      let on = false;
      for (let i = 0; i < n; i++) {
        const a = r.th[i] + ph;
        const s = Math.sin(a);
        if (s < 0.15) {
          on = false;
          continue;
        }
        const i0 = Math.max(0, i - 1), i1 = Math.min(n - 1, i + 1);
        const tx = X[i1] - X[i0], ty = Y[i1] - Y[i0];
        const tl = Math.hypot(tx, ty) || 1;
        const o = Math.cos(a) * R * 0.8;
        const px = X[i] - (ty / tl) * o, py = Y[i] + (tx / tl) * o;
        if (!on) g.moveTo(px, py);
        else g.lineTo(px, py);
        on = true;
      }
      g.stroke();
    }
  }
}

let SX = new Float64Array(64), SY = new Float64Array(64);
function scratchX(n: number) {
  if (SX.length < n) SX = new Float64Array(n * 2);
  return SX;
}
function scratchY(n: number) {
  if (SY.length < n) SY = new Float64Array(n * 2);
  return SY;
}
