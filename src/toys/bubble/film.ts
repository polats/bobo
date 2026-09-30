import { Program, compile, createDouble, createTarget, destroyTarget, type DoubleTarget, type Target } from '../../shell/gl';
import * as S from './shaders';

/** Physical knobs shared by every film (SI units unless noted). */
export interface FilmParams {
  buoy: number;
  drag: number;
  curl: number;
  drain: number;
  waves: number;
  waveDamp: number;
  evap: number;
  suction: number;
  rimThin: number;
  rupture: number;
  /** Culick rim speed at 1 µm divided by the pop slow-motion factor, m/s. */
  culick: number;
  /** Common black film thickness (µm) and its hole nucleation rate per cell per second. */
  blackH: number;
  blackRate: number;
  iterations: number;
}

/** Per-slot block statistics from the last completed readback. */
export interface SlotStats {
  /** 1 if any part of the slot has torn. */
  hole: number;
  /** Thinnest intact film, µm. */
  min: number;
  /** Mean intact thickness, µm. */
  mean: number;
  /** Fraction of the disc still covered by film. */
  cover: number;
}

/**
 * A grid of soap-film discs simulated on the GPU: stable fluids for the tangential surface flow
 * (Stam; pass layout as in Ink Swirl) plus a thickness field that the flow carries.
 */
export class FilmSim {
  readonly film: DoubleTarget;
  readonly vel: DoubleTarget;
  private pressure: DoubleTarget;
  private div: Target;
  private curlT: Target;
  private red: { tex: WebGLTexture; fbo: WebGLFramebuffer; w: number; h: number };
  private pbo: WebGLBuffer[];
  private pboIdx = 0;
  private fence: WebGLSync | null = null;
  private pixels: Uint8Array;
  readonly slotInfo: Float32Array;
  readonly stats: SlotStats[];
  readonly cols: number;
  readonly rows: number;
  readonly n: number;
  private seed = 0;
  /** Readbacks issued so far, and which one the current `stats` came from. */
  issued = 0;
  resultIssue = 0;
  private pending = 0;

  constructor(private gl: WebGL2RenderingContext, private p: FilmPrograms, private quad: WebGLVertexArrayObject, n: number, cols: number, rows: number) {
    this.n = n;
    this.cols = cols;
    this.rows = rows;
    const w = n * cols, h = n * rows;
    this.film = createDouble(gl, w, h, gl.LINEAR);
    this.vel = createDouble(gl, w, h, gl.LINEAR);
    this.pressure = createDouble(gl, w, h, gl.NEAREST);
    this.div = createTarget(gl, w, h, gl.NEAREST);
    this.curlT = createTarget(gl, w, h, gl.NEAREST);
    const rw = w / 8, rh = h / 8;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, rw, rh, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    this.red = { tex, fbo, w: rw, h: rh };
    this.pixels = new Uint8Array(rw * rh * 4);
    // Two pack buffers, alternated, so a readback never lands in one still being fetched.
    this.pbo = [0, 1].map(() => {
      const b = gl.createBuffer()!;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, b);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, this.pixels.byteLength, gl.STREAM_READ);
      return b;
    });
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.slotInfo = new Float32Array(S.MAX_SLOTS * 4);
    this.stats = Array.from({ length: cols * rows }, () => ({ hole: 1, min: 0, mean: 0, cover: 0 }));
  }

  /** Metres per cell, alive flag and gravity factor for one slot. */
  setSlot(i: number, metresPerCell: number, alive: boolean, gravity = 1) {
    this.slotInfo.set([metresPerCell, alive ? 1 : 0, gravity, this.slotInfo[i * 4 + 3] || 1], i * 4);
  }

  private common(prog: Program) {
    const gl = this.gl;
    const u = prog.use();
    gl.uniform2f(u.texel, this.film.texelX, this.film.texelY);
    gl.uniform2f(u.uSlots, this.cols, this.rows);
    if (u['uSlot[0]']) gl.uniform4fv(u['uSlot[0]'], this.slotInfo);
    return u;
  }

  /** `fronts`: substeps of hole-front growth this frame (more while something is popping). */
  step(dt: number, P: FilmParams, fronts = 1) {
    const gl = this.gl;
    const p = this.p;
    const { vel, film, pressure } = this;
    gl.disable(gl.BLEND);
    // Buoyancy is measured against each film's own mean thickness.
    this.stats.forEach((st, i) => {
      if (st.mean > 0) this.slotInfo[i * 4 + 3] = st.mean;
    });

    let u = this.common(p.force);
    gl.uniform1i(u.uVel, 0);
    gl.uniform1i(u.uFilm, 1);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.buoy, P.buoy);
    gl.uniform1f(u.drag, P.drag);
    this.bind(0, vel.read.tex);
    this.bind(1, film.read.tex);
    this.blit(vel.write);
    vel.swap();

    u = this.common(p.curl);
    gl.uniform1i(u.uVel, 0);
    this.bind(0, vel.read.tex);
    this.blit(this.curlT);

    u = this.common(p.vorticity);
    gl.uniform1i(u.uVel, 0);
    gl.uniform1i(u.uCurl, 1);
    gl.uniform1f(u.curl, P.curl);
    gl.uniform1f(u.dt, dt);
    this.bind(0, vel.read.tex);
    this.bind(1, this.curlT.tex);
    this.blit(vel.write);
    vel.swap();

    u = this.common(p.divergence);
    gl.uniform1i(u.uVel, 0);
    this.bind(0, vel.read.tex);
    this.blit(this.div);

    u = this.common(p.scale);
    gl.uniform1i(u.uTex, 0);
    gl.uniform1f(u.value, 0.98);
    this.bind(0, pressure.read.tex);
    this.blit(pressure.write);
    pressure.swap();

    u = this.common(p.pressure);
    gl.uniform1i(u.uP, 0);
    gl.uniform1i(u.uDiv, 1);
    this.bind(1, this.div.tex);
    for (let i = 0; i < P.iterations; i++) {
      this.bind(0, pressure.read.tex);
      this.blit(pressure.write);
      pressure.swap();
    }

    u = this.common(p.gradient);
    gl.uniform1i(u.uP, 0);
    gl.uniform1i(u.uVel, 1);
    this.bind(0, pressure.read.tex);
    this.bind(1, vel.read.tex);
    this.blit(vel.write);
    vel.swap();

    u = this.common(p.advectVel);
    gl.uniform1i(u.uVel, 0);
    gl.uniform1f(u.dt, dt);
    this.bind(0, vel.read.tex);
    this.blit(vel.write);
    vel.swap();

    u = this.common(p.film);
    gl.uniform1i(u.uFilm, 0);
    gl.uniform1i(u.uVel, 1);
    gl.uniform1f(u.dt, dt);
    gl.uniform1f(u.drain, P.drain);
    gl.uniform1f(u.waves, P.waves);
    gl.uniform1f(u.waveDamp, P.waveDamp);
    gl.uniform1f(u.evap, P.evap);
    gl.uniform1f(u.suction, P.suction);
    gl.uniform1f(u.rimThin, P.rimThin);
    gl.uniform1f(u.rupture, P.rupture);
    gl.uniform1f(u.blackH, P.blackH);
    gl.uniform1f(u.blackRate, P.blackRate);
    gl.uniform1f(u.frame, (this.seed = (this.seed + 1) % 1e6));
    this.bind(0, film.read.tex);
    this.bind(1, vel.read.tex);
    this.blit(film.write);
    film.swap();

    u = this.common(p.front);
    gl.uniform1i(u.uFilm, 0);
    gl.uniform1f(u.dt, dt / fronts);
    gl.uniform1f(u.culick, P.culick);
    for (let i = 0; i < fronts; i++) {
      this.bind(0, film.read.tex);
      this.blit(film.write);
      film.swap();
    }
  }

  /** Stir: velocity splat at uv with a force in cells/s. */
  splat(x: number, y: number, fx: number, fy: number, radius: number) {
    const gl = this.gl;
    const u = this.common(this.p.splat);
    gl.uniform1i(u.uVel, 0);
    gl.uniform2f(u.point, x, y);
    gl.uniform2f(u.force, fx, fy);
    gl.uniform1f(u.radius, radius);
    this.bind(0, this.vel.read.tex);
    this.blit(this.vel.write);
    this.vel.swap();
  }

  /** Fresh film of thickness h (µm) over slot-local rows y0..y1 (-1 bottom .. 1 top). */
  paint(y0: number, y1: number, h: number) {
    const gl = this.gl;
    let u = this.common(this.p.paint);
    gl.uniform1i(u.uFilm, 0);
    gl.uniform1f(u.y0, y0);
    gl.uniform1f(u.y1, y1);
    gl.uniform1f(u.h, h);
    gl.uniform1f(u.seed, Math.random() * 100);
    this.bind(0, this.film.read.tex);
    this.blit(this.film.write);
    this.film.swap();
    u = this.common(this.p.paintVel);
    gl.uniform1i(u.uVel, 0);
    gl.uniform1f(u.y0, y0);
    gl.uniform1f(u.y1, y1);
    this.bind(0, this.vel.read.tex);
    this.blit(this.vel.write);
    this.vel.swap();
  }

  /** Inflate (k > 1) or deflate the film by area ratio k, feeding new film of thickness hNew at the rim and scaling the old film by `thin`. */
  feed(k: number, hNew: number, thin = 1) {
    const gl = this.gl;
    for (const [t, isFilm] of [[this.film, 1], [this.vel, 0]] as const) {
      const u = this.common(this.p.feed);
      gl.uniform1i(u.uTex, 0);
      gl.uniform1f(u.k, k);
      gl.uniform1f(u.hNew, hNew);
      gl.uniform1f(u.isFilm, isFilm);
      gl.uniform1f(u.thin, thin);
      gl.uniform1f(u.seed, Math.random() * 100);
      this.bind(0, t.read.tex);
      this.blit(t.write);
      t.swap();
    }
  }

  /** Copy a single-slot film into slot `i`; velocity is rescaled by `velScale` (cells per metre changes). */
  copyFrom(src: FilmSim, i: number, velScale: number) {
    const gl = this.gl;
    for (const [dst, from, m] of [[this.film, src.film, 1], [this.vel, src.vel, velScale]] as const) {
      const u = this.common(this.p.copy);
      gl.uniform1i(u.uDst, 0);
      gl.uniform1i(u.uSrc, 1);
      gl.uniform1f(u.target, i);
      gl.uniform4f(u.mul, m, m, 1, 1);
      this.bind(0, dst.read.tex);
      this.bind(1, from.read.tex);
      this.blit(dst.write);
      dst.swap();
    }
  }

  /** Nucleate a hole at uv (radius in cells). */
  poke(x: number, y: number, radius: number) {
    const gl = this.gl;
    const u = this.common(this.p.poke);
    gl.uniform1i(u.uFilm, 0);
    gl.uniform2f(u.point, x, y);
    gl.uniform1f(u.radius, radius);
    this.bind(0, this.film.read.tex);
    this.blit(this.film.write);
    this.film.swap();
  }

  /**
   * Kick off an async readback of per-block stats and collect the previous one if the GPU is done
   * with it (a fence, so the CPU never stalls waiting on the GPU).
   */
  readback() {
    const gl = this.gl;
    if (this.fence) {
      if (gl.getSyncParameter(this.fence, gl.SYNC_STATUS) !== gl.SIGNALED) return;
      gl.deleteSync(this.fence);
      this.fence = null;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[this.pboIdx]);
      gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, this.pixels);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
      this.collect();
      this.resultIssue = this.pending;
    }
    const u = this.common(this.p.reduce);
    gl.uniform1i(u.uFilm, 0);
    gl.uniform2f(u.srcTexel, this.film.texelX, this.film.texelY);
    this.bind(0, this.film.read.tex);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.red.fbo);
    gl.viewport(0, 0, this.red.w, this.red.h);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
    this.pboIdx = 1 - this.pboIdx;
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, this.pbo[this.pboIdx]);
    gl.readPixels(0, 0, this.red.w, this.red.h, gl.RGBA, gl.UNSIGNED_BYTE, 0);
    gl.bindBuffer(gl.PIXEL_PACK_BUFFER, null);
    this.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
    this.pending = ++this.issued;
    gl.flush();
  }

  private collect() {
    const bw = this.n / 8;
    const d = this.pixels;
    for (let s = 0; s < this.stats.length; s++) {
      const sx = s % this.cols, sy = Math.floor(s / this.cols);
      let hole = 0, mn = 9, sum = 0, cells = 0, blocks = 0;
      for (let j = 0; j < bw; j++)
        for (let i = 0; i < bw; i++) {
          const k = ((sy * bw + j) * this.red.w + sx * bw + i) * 4;
          if (!d[k + 3]) continue;
          blocks++;
          hole = Math.max(hole, d[k] / 255);
          const m = (d[k + 1] / 255) ** 2 * 3;
          const mean = (d[k + 2] / 255) ** 2 * 3;
          if (mean > 0) {
            mn = Math.min(mn, m);
            sum += mean;
            cells++;
          }
        }
      const st = this.stats[s];
      st.hole = hole;
      st.min = cells ? mn : 0;
      st.mean = cells ? sum / cells : 0;
      st.cover = blocks ? cells / blocks : 0;
    }
  }

  private bind(unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
  }

  private blit(t: Target) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
    gl.viewport(0, 0, t.width, t.height);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  destroy() {
    const gl = this.gl;
    for (const d of [this.film, this.vel, this.pressure]) {
      destroyTarget(gl, d.read);
      destroyTarget(gl, d.write);
    }
    destroyTarget(gl, this.div);
    destroyTarget(gl, this.curlT);
    gl.deleteTexture(this.red.tex);
    gl.deleteFramebuffer(this.red.fbo);
    this.pbo.forEach((b) => gl.deleteBuffer(b));
    if (this.fence) gl.deleteSync(this.fence);
  }
}

export type FilmPrograms = Record<'force' | 'front' | 'splat' | 'curl' | 'vorticity' | 'divergence' | 'scale' | 'pressure' | 'gradient' | 'advectVel' | 'film' | 'paint' | 'paintVel' | 'feed' | 'copy' | 'poke' | 'reduce', Program>;

export function filmPrograms(gl: WebGL2RenderingContext): FilmPrograms {
  const v = compile(gl, gl.VERTEX_SHADER, S.vert);
  const mk = (src: string) => new Program(gl, v, src);
  return {
    force: mk(S.forceFrag),
    front: mk(S.frontFrag),
    splat: mk(S.splatFrag),
    curl: mk(S.curlFrag),
    vorticity: mk(S.vorticityFrag),
    divergence: mk(S.divergenceFrag),
    scale: mk(S.scaleFrag),
    pressure: mk(S.pressureFrag),
    gradient: mk(S.gradientFrag),
    advectVel: mk(S.advectVelFrag),
    film: mk(S.filmFrag),
    paint: mk(S.paintFrag),
    paintVel: mk(S.paintVelFrag),
    feed: mk(S.feedFrag),
    copy: mk(S.copyFrag),
    poke: mk(S.pokeFrag),
    reduce: mk(S.reduceFrag),
  };
}
