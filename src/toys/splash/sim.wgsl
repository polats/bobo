// 3D MLS-MPM water (Hu et al. 2018), grid units dx = 1, 8 particles per cell at rest.
// One substep = p2gMass -> p2gStress (fixed-point atomic scatter) -> gridUpdate (forces, probes,
// walls; clears the atomics) -> g2p (gather, APIC C, advect). `columns` reads back the surface.

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
// Per node, fixed point: momentum.xyz, mass.
@group(0) @binding(2) var<storage, read_write> gridAtomic: array<atomic<i32>>;
// Per node: velocity.xyz, mass.
@group(0) @binding(3) var<storage, read_write> gridV: array<vec4f>;
// Per (x, z) column: surface height (cells, -1 when dry), surface velocity.xyz.
@group(0) @binding(4) var<storage, read_write> columns: array<vec4f>;

// Large enough that the smallest 3D stencil weights still carry many integer units of mass.
const FIXED: f32 = 200000.0;
const PVOL: f32 = 0.125;
const WALL: i32 = 2;

fn bad(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u;
}

fn nodeIndex(c: vec3i) -> u32 {
  return (u32(c.z) * P.grid.y + u32(c.y)) * P.grid.x + u32(c.x);
}

struct Stencil {
  base: vec3i,
  fx: vec3f,
  w: array<vec3f, 3>,
}

fn stencil(pos: vec3f) -> Stencil {
  let base = vec3i(floor(pos - vec3f(0.5)));
  let fx = pos - vec3f(base);
  let w0 = 0.5 * (1.5 - fx) * (1.5 - fx);
  let w1 = 0.75 - (fx - 1.0) * (fx - 1.0);
  let w2 = 0.5 * (fx - 0.5) * (fx - 0.5);
  return Stencil(base, fx, array<vec3f, 3>(w0, w1, w2));
}

fn scatter3(o: u32, v: vec3f) {
  atomicAdd(&gridAtomic[o], i32(round(v.x * FIXED)));
  atomicAdd(&gridAtomic[o + 1u], i32(round(v.y * FIXED)));
  atomicAdd(&gridAtomic[o + 2u], i32(round(v.z * FIXED)));
}

@compute @workgroup_size(64)
fn p2gMass(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) {
    return;
  }
  let p = particles[i];
  let st = stencil(p.pos);
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      for (var c = 0; c < 3; c++) {
        let off = vec3i(a, b, c);
        let dpos = vec3f(off) - st.fx;
        let weight = st.w[a].x * st.w[b].y * st.w[c].z;
        let o = nodeIndex(st.base + off) * 4u;
        scatter3(o, weight * PVOL * (p.vel + p.C * dpos));
        atomicAdd(&gridAtomic[o + 3u], i32(round(weight * PVOL * FIXED)));
      }
    }
  }
}

// Pressure comes from how much water is packed around the particle (1.0 = rest), so the pool
// can't silently compress; viscosity is a small symmetric-gradient stress.
@compute @workgroup_size(64)
fn p2gStress(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) {
    return;
  }
  let p = particles[i];
  let st = stencil(p.pos);
  var occ = 0.0;
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      for (var c = 0; c < 3; c++) {
        let weight = st.w[a].x * st.w[b].y * st.w[c].z;
        let o = nodeIndex(st.base + vec3i(a, b, c)) * 4u;
        occ += weight * f32(atomicLoad(&gridAtomic[o + 3u])) / FIXED;
      }
    }
  }
  // Surface particles see a thin grid; clamp so their inflated volume can't amplify forces,
  // and never pull (no tension), or the surface jitters into floating spray.
  let occupancy = clamp(occ, 0.5, 1.6);
  let r2 = occupancy * occupancy;
  let pressure = max(P.waterK * (r2 * r2 - 1.0), 0.0);
  let volume = PVOL / occupancy;
  // Bulk viscosity on the divergence (trace of C) kills the column's breathing mode, which
  // explicit MPM otherwise never damps, so the tank comes to rest instead of shimmering.
  let div = p.C[0][0] + p.C[1][1] + p.C[2][2];
  let iso = -pressure + P.bulk * div;
  let stress = mat3x3f(vec3f(iso, 0.0, 0.0), vec3f(0.0, iso, 0.0), vec3f(0.0, 0.0, iso))
    + P.viscosity * (p.C + transpose(p.C));
  let force = (-P.dt * volume * 4.0) * stress;
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      for (var c = 0; c < 3; c++) {
        let off = vec3i(a, b, c);
        let dpos = vec3f(off) - st.fx;
        let weight = st.w[a].x * st.w[b].y * st.w[c].z;
        scatter3(nodeIndex(st.base + off) * 4u, weight * (force * dpos));
      }
    }
  }
}

@compute @workgroup_size(64)
fn gridUpdate(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= P.grid.x * P.grid.y * P.grid.z) {
    return;
  }
  let o = idx * 4u;
  let mx = atomicLoad(&gridAtomic[o]);
  let my = atomicLoad(&gridAtomic[o + 1u]);
  let mz = atomicLoad(&gridAtomic[o + 2u]);
  let mm = atomicLoad(&gridAtomic[o + 3u]);
  atomicStore(&gridAtomic[o], 0);
  atomicStore(&gridAtomic[o + 1u], 0);
  atomicStore(&gridAtomic[o + 2u], 0);
  atomicStore(&gridAtomic[o + 3u], 0);

  var v = vec3f(0.0);
  let m = f32(mm) / FIXED;
  if (m > 1e-6) {
    v = vec3f(f32(mx), f32(my), f32(mz)) / FIXED / m;
    v += P.dt * P.gravity;
    let gx = P.grid.x;
    let gy = P.grid.y;
    let cell = vec3f(f32(idx % gx), f32((idx / gx) % gy), f32(idx / (gx * gy)));

    // Probes are solid spheres (fingers, balls): matter inside can't move inward relative to the
    // probe and is pushed out; a thin rim drags nearby water along.
    for (var k = 0u; k < P.probeCount; k++) {
      let pc = P.probes[k].xyz;
      let r = P.probes[k].w;
      let pv = P.probeVel[k].xyz;
      let strength = P.probeVel[k].w;
      let delta = cell - pc;
      let d = length(delta);
      if (d < r * 1.5) {
        let n = delta / max(d, 1e-4);
        var rel = v - pv;
        if (d < r) {
          let vn = dot(rel, n);
          if (vn < 0.0) {
            rel -= vn * n;
          }
          rel += n * (r - d) * 20.0 * abs(strength);
          v = pv + rel;
        } else if (strength > 0.0) {
          // Only fingers drag water along; a ball doing it would lift water and float on it.
          let f = 1.0 - (d - r) / (r * 0.5);
          v = mix(v, pv, clamp(f * f * 0.12 * strength, 0.0, 1.0));
        }
      }
    }

    // Slip walls on all six faces, one node thicker than the particle clamp so the grid stops
    // particles before the clamp does (clamped particles pile onto one plane and blow up).
    let lo = f32(WALL) + 1.0;
    let hi = vec3f(P.grid) - vec3f(f32(WALL) + 2.0);
    if (cell.x < lo && v.x < 0.0) { v.x = 0.0; }
    if (cell.x > hi.x && v.x > 0.0) { v.x = 0.0; }
    if (cell.y < lo && v.y < 0.0) { v.y = 0.0; }
    if (cell.y > hi.y && v.y > 0.0) { v.y = 0.0; }
    if (cell.z < lo && v.z < 0.0) { v.z = 0.0; }
    if (cell.z > hi.z && v.z > 0.0) { v.z = 0.0; }
    let vmax = 0.6 / P.dt;
    let sp = length(v);
    if (sp > vmax) {
      v *= vmax / sp;
    }
  }
  gridV[idx] = vec4f(v, m);
}

@compute @workgroup_size(64)
fn g2p(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) {
    return;
  }
  var p = particles[i];
  let st = stencil(p.pos);
  var v = vec3f(0.0);
  var B = mat3x3f(vec3f(0.0), vec3f(0.0), vec3f(0.0));
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      for (var c = 0; c < 3; c++) {
        let off = vec3i(a, b, c);
        let dpos = vec3f(off) - st.fx;
        let weight = st.w[a].x * st.w[b].y * st.w[c].z;
        let gv = gridV[nodeIndex(st.base + off)].xyz;
        v += weight * gv;
        B += (4.0 * weight) * mat3x3f(gv * dpos.x, gv * dpos.y, gv * dpos.z);
      }
    }
  }
  p.vel = v;
  // Keeping slightly less than all of C bleeds off particle-scale jitter that pure APIC
  // preserves forever, without the syrupy look a big viscosity gives.
  p.C = B * P.affineKeep;
  let lo = vec3f(f32(WALL));
  let hi = vec3f(P.grid) - vec3f(f32(WALL));
  p.pos = clamp(p.pos + P.dt * v, lo, hi);
  if (bad(p.pos.x) || bad(p.pos.y) || bad(p.pos.z) || bad(v.x) || bad(v.y) || bad(v.z)) {
    p.pos = vec3f(P.grid) * vec3f(0.5, 0.7, 0.5);
    p.vel = vec3f(0.0);
    p.C = mat3x3f(vec3f(0.0), vec3f(0.0), vec3f(0.0));
  }
  particles[i] = p;
}

// Surface readback for the CPU (finger hit-tests and floating balls): the top of the water that
// is connected to the floor, so spray and droplets clinging to a ball don't count as depth.
@compute @workgroup_size(64)
fn surfaceColumns(@builtin(global_invocation_id) gid: vec3u) {
  let k = gid.x;
  if (k >= P.grid.x * P.grid.z) {
    return;
  }
  let x = i32(k % P.grid.x);
  let z = i32(k / P.grid.x);
  var out = vec4f(-1.0, 0.0, 0.0, 0.0);
  var wet = false;
  for (var y = 0; y < i32(P.grid.y); y++) {
    let node = gridV[nodeIndex(vec3i(x, y, z))];
    if (node.w > 0.35) {
      wet = true;
      out = vec4f(f32(y) + clamp(node.w, 0.0, 1.0) - 0.5, node.xyz);
    } else if (wet) {
      break;
    }
  }
  columns[k] = out;
}
