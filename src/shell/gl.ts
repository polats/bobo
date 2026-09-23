/** Minimal WebGL2 helpers for fullscreen-pass simulations. */

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  width: number;
  height: number;
  texelX: number;
  texelY: number;
}

export interface DoubleTarget {
  read: Target;
  write: Target;
  width: number;
  height: number;
  texelX: number;
  texelY: number;
  swap(): void;
}

export class Program {
  readonly program: WebGLProgram;
  readonly uniforms: Record<string, WebGLUniformLocation> = {};

  constructor(private gl: WebGL2RenderingContext, vert: WebGLShader, fragSrc: string) {
    const frag = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
    const p = gl.createProgram()!;
    gl.attachShader(p, vert);
    gl.attachShader(p, frag);
    gl.bindAttribLocation(p, 0, 'aPosition');
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? 'link failed');
    this.program = p;
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS) as number;
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i)!.name;
      this.uniforms[name] = gl.getUniformLocation(p, name)!;
    }
  }

  use() {
    this.gl.useProgram(this.program);
    return this.uniforms;
  }
}

export function compile(gl: WebGL2RenderingContext, type: number, src: string) {
  const s = gl.createShader(type)!;
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? 'compile failed');
  return s;
}

export function createTarget(gl: WebGL2RenderingContext, w: number, h: number, filter: number): Target {
  const tex = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
  const fbo = gl.createFramebuffer()!;
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
    throw new Error('This device cannot render to half-float textures');
  }
  gl.viewport(0, 0, w, h);
  gl.clearColor(0, 0, 0, 0);
  gl.clear(gl.COLOR_BUFFER_BIT);
  return { tex, fbo, width: w, height: h, texelX: 1 / w, texelY: 1 / h };
}

export function createDouble(gl: WebGL2RenderingContext, w: number, h: number, filter: number): DoubleTarget {
  let a = createTarget(gl, w, h, filter);
  let b = createTarget(gl, w, h, filter);
  return {
    get read() {
      return a;
    },
    get write() {
      return b;
    },
    width: w,
    height: h,
    texelX: 1 / w,
    texelY: 1 / h,
    swap() {
      [a, b] = [b, a];
    },
  };
}

export function destroyTarget(gl: WebGL2RenderingContext, t: Target) {
  gl.deleteTexture(t.tex);
  gl.deleteFramebuffer(t.fbo);
}

/** Simulation grid size with `base` cells along the short side, matching the canvas aspect. */
export function gridSize(base: number, width: number, height: number): [number, number] {
  const aspect = width / height;
  return aspect >= 1
    ? [Math.round(base * aspect), base]
    : [base, Math.round(base / aspect)];
}
