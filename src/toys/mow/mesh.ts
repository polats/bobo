// Tiny flat-shaded mesh builder (mower, stone, cat, flowers) and the few mat4 helpers the
// camera needs. Everything is non-indexed triangles: position, face normal, colour.

export type V3 = [number, number, number];
export type Mat4 = Float32Array;

export interface Mesh {
  vao: WebGLVertexArrayObject;
  buf: WebGLBuffer;
  count: number;
}

export class MeshBuilder {
  readonly data: number[] = [];

  /** One triangle; the normal is flipped to point away from `inside` so winding never matters. */
  tri(a: V3, b: V3, c: V3, col: V3, inside: V3) {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len;
    ny /= len;
    nz /= len;
    const mx = (a[0] + b[0] + c[0]) / 3 - inside[0], my = (a[1] + b[1] + c[1]) / 3 - inside[1], mz = (a[2] + b[2] + c[2]) / 3 - inside[2];
    if (nx * mx + ny * my + nz * mz < 0) {
      nx = -nx;
      ny = -ny;
      nz = -nz;
    }
    for (const p of [a, b, c]) this.data.push(p[0], p[1], p[2], nx, ny, nz, col[0], col[1], col[2]);
  }

  quad(a: V3, b: V3, c: V3, d: V3, col: V3, inside: V3) {
    this.tri(a, b, c, col, inside);
    this.tri(a, c, d, col, inside);
  }

  box(c: V3, h: V3, col: V3) {
    const p = (sx: number, sy: number, sz: number): V3 => [c[0] + sx * h[0], c[1] + sy * h[1], c[2] + sz * h[2]];
    for (let axis = 0; axis < 3; axis++) {
      for (const s of [-1, 1]) {
        const q: V3[] = [];
        for (const [u, v] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
          const k: V3 = [0, 0, 0];
          k[axis] = s;
          k[(axis + 1) % 3] = u;
          k[(axis + 2) % 3] = v;
          q.push(p(k[0], k[1], k[2]));
        }
        this.quad(q[0], q[1], q[2], q[3], col, c);
      }
    }
  }

  /** Frustum (or cylinder) from a to b with end radii r0, r1. */
  cyl(a: V3, b: V3, r0: number, r1: number, seg: number, col: V3, caps = true) {
    const ax: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const len = Math.hypot(...ax) || 1;
    const n: V3 = [ax[0] / len, ax[1] / len, ax[2] / len];
    const helper: V3 = Math.abs(n[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
    const u = norm(cross(n, helper));
    const v = cross(n, u);
    const ring = (o: V3, r: number, k: number): V3 => {
      const t = (k / seg) * Math.PI * 2;
      const cs = Math.cos(t) * r, sn = Math.sin(t) * r;
      return [o[0] + u[0] * cs + v[0] * sn, o[1] + u[1] * cs + v[1] * sn, o[2] + u[2] * cs + v[2] * sn];
    };
    const mid: V3 = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2];
    for (let k = 0; k < seg; k++) {
      const p0 = ring(a, r0, k), p1 = ring(a, r0, k + 1), q0 = ring(b, r1, k), q1 = ring(b, r1, k + 1);
      this.quad(p0, p1, q1, q0, col, mid);
      if (caps) {
        if (r0 > 0) this.tri(a, p0, p1, col, b);
        if (r1 > 0) this.tri(b, q0, q1, col, a);
      }
    }
  }

  /** Ellipsoid; `jitter` roughens it into a rock, `shade` darkens the underside colour. */
  ellipsoid(c: V3, r: V3, col: V3, seg = 10, rings = 6, jitter = 0, rand: () => number = Math.random) {
    const grid: V3[][] = [];
    const noise: number[] = [];
    for (let k = 0; k < seg; k++) noise.push(1 + (rand() - 0.5) * jitter);
    for (let i = 0; i <= rings; i++) {
      const phi = (i / rings) * Math.PI;
      const row: V3[] = [];
      for (let k = 0; k < seg; k++) {
        const th = (k / seg) * Math.PI * 2;
        const j = i === 0 || i === rings ? 1 : noise[(k + i * 3) % seg] * (1 + (rand() - 0.5) * jitter * 0.5);
        row.push([c[0] + Math.sin(phi) * Math.cos(th) * r[0] * j, c[1] + Math.cos(phi) * r[1] * (i === 0 || i === rings ? 1 : j), c[2] + Math.sin(phi) * Math.sin(th) * r[2] * j]);
      }
      grid.push(row);
    }
    for (let i = 0; i < rings; i++) {
      for (let k = 0; k < seg; k++) {
        const k1 = (k + 1) % seg;
        const a = grid[i][k], b = grid[i][k1], cc = grid[i + 1][k1], d = grid[i + 1][k];
        if (i > 0) this.tri(a, b, cc, col, c);
        if (i < rings - 1) this.tri(a, cc, d, col, c);
      }
    }
  }

  upload(gl: WebGL2RenderingContext, into?: Mesh): Mesh {
    const arr = new Float32Array(this.data);
    const vao = into?.vao ?? gl.createVertexArray()!;
    const buf = into?.buf ?? gl.createBuffer()!;
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, arr, gl.STATIC_DRAW);
    if (!into) {
      for (let i = 0; i < 3; i++) {
        gl.enableVertexAttribArray(i);
        gl.vertexAttribPointer(i, 3, gl.FLOAT, false, 36, i * 12);
      }
    }
    gl.bindVertexArray(null);
    return { vao, buf, count: arr.length / 9 };
  }
}

export function cross(a: V3, b: V3): V3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

export function norm(a: V3): V3 {
  const l = Math.hypot(...a) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
}

export function perspective(out: Mat4, fovy: number, aspect: number, near: number, far: number) {
  const f = 1 / Math.tan(fovy / 2);
  out.fill(0);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

export function lookAt(out: Mat4, eye: V3, target: V3, up: V3) {
  const z = norm([eye[0] - target[0], eye[1] - target[1], eye[2] - target[2]]);
  const x = norm(cross(up, z));
  const y = cross(z, x);
  out.set([x[0], y[0], z[0], 0, x[1], y[1], z[1], 0, x[2], y[2], z[2], 0, -dot(x, eye), -dot(y, eye), -dot(z, eye), 1]);
  return out;
}

export function multiply(out: Mat4, a: Mat4, b: Mat4) {
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
  }
  return out;
}

/** Model matrix: local x = heading direction, y = up, z = right-hand side, uniform scale s. */
export function placeY(out: Mat4, x: number, y: number, z: number, heading: number, s = 1, sy = s) {
  const c = Math.cos(heading), n = Math.sin(heading);
  out.set([c * s, 0, n * s, 0, 0, sy, 0, 0, -n * s, 0, c * s, 0, x, y, z, 1]);
  return out;
}

export function dot(a: V3, b: V3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
