// A scratch-off coat: latex and metal pigment over a release varnish, which has no strength as a
// sheet and comes away in separate flakes. The coat is a thickness grid baked into jittered,
// noise-warped Voronoi flakes with their own adhesion. A tool loads each flake in proportion to
// the share of it under the contact; past its strength the whole flake pops off. Brittle coats
// crack into their already-stressed neighbours, so they come away in clumps. Every tool also
// abrades the coat thinner directly, which is how a fingernail leaves patchy islands.

export interface CoatParams {
  /** Mean flake diameter in cells. */
  flakeSize: number;
  /** 0 = even flakes, 1 = wildly mixed sizes. */
  flakeSpread: number;
  /** Damage a flake takes before it pops (scales every flake's baked adhesion). */
  strength: number;
  /** How much adhesion varies across the card (stubborn patches). */
  adhesionNoise: number;
  /** Share of a popped flake's strength passed on to stressed neighbours. */
  brittleness: number;
  /** Resistance to being worn thin (higher = less scuffing). */
  abrasionResist: number;
  /** How much faster strokes pop flakes. */
  speedGain: number;
  /**
   * Share of its strength a neighbour must already carry before a crack runs into it: 0.2 cracks only
   * through coat the tool is working; 0 lets cracks race ahead into untouched coat (crackle varnish).
   */
  crackReach: number;
  /** How many flakes a crack can run through from the one the tool popped. */
  chainDepth: number;
  /** Share of worn coat that's shoved ahead of the tool instead of crumbling (rubbery latex smears). */
  smear: number;
  /**
   * Sticky coat: 0 = flakes give way to accumulated load. N > 0 = each flake takes one bite per pass
   * (a new touch, a reversal, or a full turn of a scrub), thinning each time, and lets go on the Nth.
   */
  passes: number;
  /**
   * Ductile coat (wax): 0 = flakes and abrasion; 1 = the edge cuts a clean groove (the core of the
   * contact is cleared outright) and shoves a little burr up along its sides.
   */
  cut: number;
}

export interface ToolShape {
  /** Contact half-width across the stroke, in cells. */
  r: number;
  /** 0 = round fingertip, 1 = a flat edge across the stroke. */
  flat: number;
  hardness: number;
  abrasion: number;
}

const MAX_BREAKS = 512;

export class Coat {
  readonly W: number;
  readonly H: number;
  /** Coat thickness per cell, 1 = fresh, 0 = gone. */
  readonly h: Float32Array;
  /** Flake id per cell, -1 where there is no coat. */
  readonly flake: Int32Array;
  /** Per-cell grain (0.5..1.5) so abrasion wears unevenly. */
  private readonly grain: Float32Array;
  /** RGBA8 upload: thickness, flake damage, and the direction the tool has been pushing the flake. */
  readonly tex: Uint8Array;
  /** RGBA8 static: flake tilt x, tilt y, flake edge, adhesion. */
  readonly still: Uint8Array;
  dirty0 = 0;
  dirty1 = 0;

  readonly flakes: number;
  private readonly fStart: Int32Array;
  private readonly fCells: Int32Array;
  readonly fArea: Float32Array;
  readonly fCx: Float32Array;
  readonly fCy: Float32Array;
  private readonly fStrength: Float32Array;
  readonly fDamage: Float32Array;
  /** Sum of push directions (weighted by load): a loosened flake lifts and tilts this way. */
  private readonly fUx: Float32Array;
  private readonly fUy: Float32Array;
  readonly fGone: Uint8Array;
  private readonly nStart: Int32Array;
  private readonly nList: Int32Array;
  private readonly acc: Float32Array;
  private readonly touched: Int32Array;
  private nTouched = 0;
  private readonly queue: Int32Array;
  private readonly depth: Uint8Array;
  coatCells = 0;
  goneFlakes = 0;
  /** CoatParams.strength as of the last settle, so the damage texture reads as a share of it. */
  private k = 1;

  /** Flakes popped since the last `clearEvents()`: centre (cells), area (cells), how hard it was stuck. */
  readonly bx = new Float32Array(MAX_BREAKS);
  readonly by = new Float32Array(MAX_BREAKS);
  readonly bArea = new Float32Array(MAX_BREAKS);
  readonly bStrength = new Float32Array(MAX_BREAKS);
  /** 1 for a flake that cracked off a neighbour rather than under the tool. */
  readonly bChain = new Uint8Array(MAX_BREAKS);
  /** 1 for a sticky flake letting go on its last pass. */
  readonly bLast = new Uint8Array(MAX_BREAKS);
  /** Bites taken out of sticky flakes this frame (each pass that wore one down). */
  bites = 0;
  /** Current pass: one bite per flake per pass. */
  private pass = 1;
  private readonly fSeen: Int32Array;
  private readonly fWork: Float32Array;
  private readonly fBites: Uint8Array;
  breaks = 0;
  /** Coat worn away by abrasion since the last clearEvents (cells' worth). */
  abraded = 0;
  /** Coat cut out of the groove since the last clearEvents (cells' worth): it becomes the shaving. */
  cutAmt = 0;
  /** Coat under the tool in the last scrape (sum of weight × thickness), for sound. */
  contact = 0;
  /** Bare card under the tool in the last scrape. */
  bare = 0;
  /**
   * Flake boundaries the tool's leading edge has crossed since clearEvents: the coat's own grain,
   * which sets the scrape's pulse rate (fine flakes buzz, coarse ones chatter).
   */
  crossings = 0;
  /** Mean adhesion of the coat under the tool in the last scrape (1 = average): stubborn patches drag. */
  adhesion = 1;
  /** Flake under each sample point along the leading edge, from the previous substep. */
  private edgeIds = new Int32Array(7).fill(-3);

  constructor(W: number, H: number, inside: (x: number, y: number) => boolean, p: CoatParams, seed: number) {
    this.W = W;
    this.H = H;
    const n = W * H;
    this.h = new Float32Array(n);
    this.flake = new Int32Array(n).fill(-1);
    this.grain = new Float32Array(n);
    this.tex = new Uint8Array(n * 4);
    this.still = new Uint8Array(n * 4);
    const rnd = mulberry(seed);

    // Jittered seed lattice with a size weight per seed (multiplicatively weighted Voronoi).
    const s = Math.max(1.5, p.flakeSize);
    const gw = Math.ceil(W / s) + 2;
    const gh = Math.ceil(H / s) + 2;
    const sx = new Float32Array(gw * gh);
    const sy = new Float32Array(gw * gh);
    const sw = new Float32Array(gw * gh);
    for (let j = 0; j < gh; j++)
      for (let i = 0; i < gw; i++) {
        const k = j * gw + i;
        sx[k] = (i - 1 + 0.1 + rnd() * 0.8) * s;
        sy[k] = (j - 1 + 0.1 + rnd() * 0.8) * s;
        const u = rnd();
        sw[k] = 1 + p.flakeSpread * (u * u * 2.2 - 0.6);
      }
    const warp = s * 0.45;
    const nz = noise2(seed + 7);
    const adh = noise2(seed + 13);
    const remap = new Int32Array(gw * gh).fill(-1);
    let flakes = 0;
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = y * W + x;
        this.grain[c] = 0.5 + rnd();
        if (!inside(x, y)) continue;
        const wx = x + warp * nz(x * 0.09, y * 0.09);
        const wy = y + warp * nz(x * 0.09 + 31, y * 0.09 + 17);
        const ci = Math.floor(wx / s) + 1;
        const cj = Math.floor(wy / s) + 1;
        let best = 1e9, bi = 0;
        for (let dj = -2; dj <= 2; dj++)
          for (let di = -2; di <= 2; di++) {
            const ii = ci + di, jj = cj + dj;
            if (ii < 0 || jj < 0 || ii >= gw || jj >= gh) continue;
            const k = jj * gw + ii;
            const d = Math.hypot(wx - sx[k], wy - sy[k]) / sw[k];
            if (d < best) {
              best = d;
              bi = k;
            }
          }
        if (remap[bi] < 0) remap[bi] = flakes++;
        this.flake[c] = remap[bi];
        this.h[c] = 1;
        this.coatCells++;
      }
    this.flakes = flakes;

    // Flake cell lists (CSR), areas, centres.
    this.fArea = new Float32Array(flakes);
    this.fCx = new Float32Array(flakes);
    this.fCy = new Float32Array(flakes);
    for (let c = 0; c < n; c++) {
      const f = this.flake[c];
      if (f < 0) continue;
      this.fArea[f]++;
      this.fCx[f] += c % W;
      this.fCy[f] += (c / W) | 0;
    }
    this.fStart = new Int32Array(flakes + 1);
    for (let f = 0; f < flakes; f++) {
      this.fStart[f + 1] = this.fStart[f] + this.fArea[f];
      this.fCx[f] /= this.fArea[f];
      this.fCy[f] /= this.fArea[f];
    }
    this.fCells = new Int32Array(this.fStart[flakes]);
    const fill = this.fStart.slice(0, flakes);
    for (let c = 0; c < n; c++) {
      const f = this.flake[c];
      if (f >= 0) this.fCells[fill[f]++] = c;
    }

    // Adhesion: fbm patches, so some regions resist.
    this.fStrength = new Float32Array(flakes);
    this.fDamage = new Float32Array(flakes);
    this.fUx = new Float32Array(flakes);
    this.fUy = new Float32Array(flakes);
    this.fGone = new Uint8Array(flakes);
    const tilt = new Uint8Array(flakes * 2);
    for (let f = 0; f < flakes; f++) {
      const a = adh(this.fCx[f] * 0.025, this.fCy[f] * 0.025) * 0.65 + adh(this.fCx[f] * 0.07, this.fCy[f] * 0.07) * 0.35;
      this.fStrength[f] = Math.max(0.15, 1 + p.adhesionNoise * a * 1.6) * (0.85 + rnd() * 0.3);
      tilt[f * 2] = rnd() * 255;
      tilt[f * 2 + 1] = rnd() * 255;
    }

    // Neighbour lists, and the static texture (tilt, flake edge, adhesion).
    const pairs = new Set<number>();
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        const c = y * W + x;
        const f = this.flake[c];
        const o = c * 4;
        if (f < 0) continue;
        let edge = 0;
        const r = x + 1 < W ? this.flake[c + 1] : -1;
        const d = y + 1 < H ? this.flake[c + W] : -1;
        const l = x > 0 ? this.flake[c - 1] : -1;
        const u = y > 0 ? this.flake[c - W] : -1;
        if (r !== f || d !== f || l !== f || u !== f) edge = 255;
        if (r >= 0 && r !== f) pairs.add(Math.min(f, r) * flakes + Math.max(f, r));
        if (d >= 0 && d !== f) pairs.add(Math.min(f, d) * flakes + Math.max(f, d));
        this.still[o] = tilt[f * 2];
        this.still[o + 1] = tilt[f * 2 + 1];
        this.still[o + 2] = edge;
        this.still[o + 3] = Math.min(255, (this.fStrength[f] / 2.2) * 255);
      }
    const deg = new Int32Array(flakes);
    for (const k of pairs) {
      deg[Math.floor(k / flakes)]++;
      deg[k % flakes]++;
    }
    this.nStart = new Int32Array(flakes + 1);
    for (let f = 0; f < flakes; f++) this.nStart[f + 1] = this.nStart[f] + deg[f];
    this.nList = new Int32Array(this.nStart[flakes]);
    const nf = this.nStart.slice(0, flakes);
    for (const k of pairs) {
      const a = Math.floor(k / flakes), b = k % flakes;
      this.nList[nf[a]++] = b;
      this.nList[nf[b]++] = a;
    }

    this.acc = new Float32Array(flakes);
    this.touched = new Int32Array(flakes);
    this.queue = new Int32Array(flakes);
    this.depth = new Uint8Array(flakes);
    this.fSeen = new Int32Array(flakes);
    this.fWork = new Float32Array(flakes);
    this.fBites = new Uint8Array(flakes);
    this.markDirty(0, H);
  }

  markDirty(y0: number, y1: number) {
    y0 = Math.max(0, Math.floor(y0));
    y1 = Math.min(this.H, Math.ceil(y1));
    if (y1 <= y0) return;
    if (this.dirty1 <= this.dirty0) {
      this.dirty0 = y0;
      this.dirty1 = y1;
    } else {
      this.dirty0 = Math.min(this.dirty0, y0);
      this.dirty1 = Math.max(this.dirty1, y1);
    }
  }

  /** Pack the dirty rows into the upload buffer; returns the row range, or null. */
  pack(): [number, number] | null {
    const { dirty0: y0, dirty1: y1, W, h, flake, fDamage, fStrength, fUx, fUy, tex, k } = this;
    if (y1 <= y0) return null;
    for (let i = y0 * W; i < y1 * W; i++) {
      const f = flake[i];
      const o = i * 4;
      // Thickness is stored over 0..1.25 so smeared ridges (above a fresh coat) survive the upload.
      tex[o] = Math.min(255, h[i] * 204);
      if (f < 0) {
        tex[o + 1] = 0;
        tex[o + 2] = tex[o + 3] = 128;
        continue;
      }
      tex[o + 1] = Math.min(255, (fDamage[f] / (fStrength[f] * k)) * 255);
      const l = Math.hypot(fUx[f], fUy[f]) || 1;
      tex[o + 2] = 128 + (fUx[f] / l) * 127;
      tex[o + 3] = 128 + (fUy[f] / l) * 127;
    }
    this.dirty0 = this.dirty1 = 0;
    return [y0, y1];
  }

  /** A new pass: every sticky flake can take one more bite. */
  newPass() {
    this.pass++;
  }

  clearEvents() {
    this.cutAmt = 0;
    this.bites = 0;
    this.breaks = 0;
    this.abraded = 0;
    this.crossings = 0;
  }

  /** The tool lifted: forget what its edge was over. */
  lift() {
    this.edgeIds.fill(-3);
  }

  /**
   * One substep of a tool dragged by (dx, dy) cells to (x, y). `ux, uy` is the stroke direction;
   * the contact is a superellipse that goes from a disc (flat 0) to a thin edge across the stroke.
   */
  /** `cover`: a layer on top of this one; cells still under it (thicker than 0.35) are out of reach. */
  scrape(x: number, y: number, ux: number, uy: number, dl: number, t: ToolShape, p: CoatParams, speed: number, press = 1, cover?: Float32Array) {
    const { W, H, h, flake, grain, acc, touched } = this;
    const r = t.r;
    const rb = Math.max(0.9, r * (1 - t.flat * 0.82));
    const pe = 2 + t.flat * 6;
    const reach = Math.ceil(Math.max(r, rb)) + 1;
    const x0 = Math.max(0, Math.floor(x - reach)), x1 = Math.min(W - 1, Math.ceil(x + reach));
    const y0 = Math.max(0, Math.floor(y - reach)), y1 = Math.min(H - 1, Math.ceil(y + reach));
    const wear = (dl * t.abrasion * 0.07 * press) / Math.max(0.05, p.abrasionResist);
    const load = dl * t.hardness * 0.45 * press * (1 + p.speedGain * Math.min(2, speed / 220));
    let contact = 0, bare = 0, adh = 0, nt = this.nTouched;
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const ox = xx - x, oy = yy - y;
        const along = (ox * ux + oy * uy) / rb;
        const across = (ox * -uy + oy * ux) / r;
        const d = Math.pow(Math.pow(Math.abs(along), pe) + Math.pow(Math.abs(across), pe), 1 / pe);
        if (d >= 1) continue;
        const w = t.flat > 0.5 ? Math.min(1, (1 - d) * 5) : 1 - d * d;
        const c = yy * W + xx;
        if (cover && cover[c] > 0.35) continue;
        const f = flake[c];
        const hc = h[c];
        if (f < 0 || hc <= 0 || this.fGone[f]) {
          bare += w;
          // Smeared coat on bare card wears off again under the tool.
          if (hc > 0) h[c] = Math.max(0, hc - (wear * 2 + dl * 0.05 * t.hardness * press) * w);
          continue;
        }
        contact += w * hc;
        adh += w * hc * this.fStrength[f];
        if (p.cut > 0) {
          // Wax: the core of the edge clears the groove; its rim ploughs up a burr.
          if (w > 0.35) {
            this.cutAmt += hc;
            h[c] = 0;
          } else h[c] = Math.min(1.2, hc + p.cut * 0.12 * w * dl);
          continue;
        }
        const a = Math.min(hc, wear * w * grain[c]);
        h[c] = hc - a;
        if (p.smear > 0 && a > 0) {
          // Rubbery coat rolls ahead of the edge: onto coat it piles up, onto bare card it leaves a smudge.
          const sx = Math.round(xx + ux * (rb + 1.5)), sy = Math.round(yy + uy * (rb + 1.5));
          if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
            const c2 = sy * W + sx, f2 = flake[c2];
            const m = a * p.smear;
            if (f2 >= 0 && !this.fGone[f2]) h[c2] = Math.min(1.25, h[c2] + m * 0.6);
            else h[c2] = Math.min(0.3, h[c2] + m);
          }
        }
        this.abraded += a * (1 - p.smear);
        if (this.fGone[f]) continue;
        if (acc[f] === 0) touched[nt++] = f;
        const l = w * (hc - a) * load;
        acc[f] += l;
        this.fUx[f] += ux * l;
        this.fUy[f] += uy * l;
      }
    }
    this.nTouched = nt;
    this.contact = contact;
    this.bare = bare;
    this.adhesion = contact > 0 ? adh / contact : 1;
    // Sample the leading edge: every change of flake (or between coat and bare card) is one catch.
    const ns = t.flat > 0.5 ? 7 : 3;
    for (let k = 0; k < ns; k++) {
      const a = (ns > 1 ? (k / (ns - 1)) * 2 - 1 : 0) * 0.8 * r;
      const sx = Math.round(x - uy * a + ux * rb * 0.9), sy = Math.round(y + ux * a + uy * rb * 0.9);
      let id = -2;
      if (sx >= 0 && sy >= 0 && sx < W && sy < H) {
        const c = sy * W + sx;
        const f = flake[c];
        id = f >= 0 && h[c] > 0.3 ? f : -1;
      }
      const was = this.edgeIds[k];
      if (was !== -3 && id !== was && (id >= 0 || was >= 0)) this.crossings++;
      this.edgeIds[k] = id;
    }
    this.markDirty(y0 - 3, y1 + 4);
  }

  /** Apply the loads gathered over this frame's substeps, popping flakes that give way. */
  settle(p: CoatParams) {
    const { acc, touched, fArea, fDamage, fStrength, fGone } = this;
    const k = (this.k = p.strength);
    let qn = 0;
    for (let i = 0; i < this.nTouched; i++) {
      const f = touched[i];
      if (p.passes > 0) {
        // Sticky: work done this pass only counts once; enough of it takes one bite.
        if (this.fSeen[f] !== this.pass) this.fWork[f] += acc[f] / fArea[f];
        acc[f] = 0;
        if (fGone[f] || this.fSeen[f] === this.pass || this.fWork[f] < 0.6 * fStrength[f] * k) continue;
        this.fSeen[f] = this.pass;
        this.fWork[f] = 0;
        const b = ++this.fBites[f];
        this.bites++;
        fDamage[f] = (fStrength[f] * k * Math.min(b, p.passes - 0.001)) / p.passes;
        if (b >= p.passes) {
          fGone[f] = 4;
          this.depth[f] = 0;
          this.queue[qn++] = f;
        } else this.thin(f, 1 - (0.45 * b) / p.passes);
        continue;
      }
      fDamage[f] += acc[f] / fArea[f];
      acc[f] = 0;
      if (!fGone[f] && fDamage[f] >= fStrength[f] * k) {
        fGone[f] = 2;
        this.depth[f] = 0;
        this.queue[qn++] = f;
      }
    }
    this.nTouched = 0;
    // Pop, and let brittle coat crack on into neighbours that are already stressed.
    let qi = 0;
    while (qi < qn) {
      const f = this.queue[qi++];
      this.pop(f, fGone[f] === 3, fGone[f] === 4);
      if (p.brittleness <= 0 || qi > 600 || this.depth[f] >= p.chainDepth) continue;
      for (let j = this.nStart[f]; j < this.nStart[f + 1]; j++) {
        const g = this.nList[j];
        if (fGone[g] || fDamage[g] < p.crackReach * fStrength[g] * k) continue;
        fDamage[g] += p.brittleness * 0.55 * fStrength[g] * k * (0.5 + Math.random());
        if (fDamage[g] >= fStrength[g] * k) {
          fGone[g] = 3;
          this.depth[g] = this.depth[f] + 1;
          this.queue[qn++] = g;
        } else this.markDirty(this.fCy[g] - 6, this.fCy[g] + 6);
      }
    }
  }

  /** A gum crumb settling back: a blob of coat over the cells around (x, y), radius r (cells). */
  blob(x: number, y: number, r: number, to: number) {
    const { W, H, h } = this;
    const x0 = Math.max(0, Math.floor(x - r)), x1 = Math.min(W - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r)), y1 = Math.min(H - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++)
      for (let xx = x0; xx <= x1; xx++) {
        const d = Math.hypot(xx - x, yy - y) / r;
        if (d >= 1) continue;
        const c = yy * W + xx;
        h[c] = Math.max(h[c], to * (1 - d * d * 0.6));
      }
    this.markDirty(y0, y1 + 1);
  }

  /** A sticky flake worn down a pass: its cells thin to at most `to` (they grey and sink). */
  private thin(f: number, to: number) {
    const { fCells, h } = this;
    for (let k = this.fStart[f]; k < this.fStart[f + 1]; k++) {
      const c = fCells[k];
      if (h[c] > to) h[c] = to;
    }
    const y = this.fCy[f];
    this.markDirty(y - Math.sqrt(this.fArea[f]) - 2, y + Math.sqrt(this.fArea[f]) + 2);
  }

  /** Pop a flake right away (finishing the card, or a chain). */
  pop(f: number, chain = false, last = false) {
    const { fCells, h, W } = this;
    let mass = 0;
    let ymin = this.H, ymax = 0;
    for (let k = this.fStart[f]; k < this.fStart[f + 1]; k++) {
      const c = fCells[k];
      mass += h[c];
      h[c] = 0;
      const y = (c / W) | 0;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
    if (!this.fGone[f]) this.fGone[f] = 1;
    this.goneFlakes++;
    this.fDamage[f] = this.fStrength[f] * this.k;
    this.markDirty(ymin, ymax + 1);
    if (mass < 0.5 || this.breaks >= MAX_BREAKS) return;
    const b = this.breaks++;
    this.bx[b] = this.fCx[f];
    this.by[b] = this.fCy[f];
    this.bArea[b] = mass;
    this.bStrength[b] = this.fStrength[f];
    this.bChain[b] = chain ? 1 : 0;
    this.bLast[b] = last ? 1 : 0;
  }

  /** Share of coat cells in the box [x0,x1)×[y0,y1) worn below `edge`; samples every other cell. */
  revealed(x0: number, y0: number, x1: number, y1: number, edge = 0.4, under?: Coat | null) {
    const { W, h, flake } = this;
    const hu = under?.h;
    let n = 0, open = 0;
    for (let y = Math.max(0, y0 | 0); y < Math.min(this.H, y1); y += 2)
      for (let x = Math.max(0, x0 | 0); x < Math.min(W, x1); x += 2) {
        const c = y * W + x;
        if (flake[c] < 0) continue;
        n++;
        if (h[c] < edge && (!hu || hu[c] < edge)) open++;
      }
    return n ? open / n : 1;
  }
}

export function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Smooth value noise in -1..1. */
export function noise2(seed: number) {
  const hash = (i: number, j: number) => {
    let x = Math.imul(i, 374761393) + Math.imul(j, 668265263) + Math.imul(seed | 0, 982451653);
    x = Math.imul(x ^ (x >>> 13), 1274126177);
    return ((x ^ (x >>> 16)) >>> 0) / 2147483648 - 1;
  };
  return (x: number, y: number) => {
    const i = Math.floor(x), j = Math.floor(y);
    const fx = x - i, fy = y - j;
    const u = fx * fx * (3 - 2 * fx), v = fy * fy * (3 - 2 * fy);
    const a = hash(i, j), b = hash(i + 1, j), c = hash(i, j + 1), d = hash(i + 1, j + 1);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  };
}
