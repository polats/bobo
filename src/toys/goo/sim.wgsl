// 2D MLS-MPM (Hu et al. 2018, after taichi's mpm99), in grid units: dx = 1, 4 particles per cell.
// One substep = p2gMass -> p2gStress (scatter with fixed-point atomics) -> gridUpdate (forces,
// walls, clears the atomics for the next substep) -> g2p (gather, APIC C, advect).

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read_write> particles: array<Particle>;
// Per node, fixed point: momentum.x, momentum.y, mass, occupied volume.
@group(0) @binding(2) var<storage, read_write> gridAtomic: array<atomic<i32>>;
// Per node: velocity.xy, mass, occupied volume (for the local mixture density in g2p).
@group(0) @binding(3) var<storage, read_write> gridV: array<vec4f>;

const FIXED: f32 = 30000.0;
const PVOL: f32 = 0.25;
// Per-material density: jelly and snow float on water, sand sinks.
const RHO = array<f32, 4>(1.0, 0.6, 0.6, 1.6);
// Sand stiffness relative to the base solid stiffness (see writeParams in index.ts).
const SAND_H: f32 = 5.0;
const SAND_COHESION: f32 = 500.0;
const ID2: mat2x2f = mat2x2f(1.0, 0.0, 0.0, 1.0);

// Matrix from rows [[a, b], [c, d]] (WGSL matrices are column-major).
fn rows(a: f32, b: f32, c: f32, d: f32) -> mat2x2f {
  return mat2x2f(a, c, b, d);
}

fn diag(v: vec2f) -> mat2x2f {
  return mat2x2f(v.x, 0.0, 0.0, v.y);
}

fn bad(x: f32) -> bool {
  return (bitcast<u32>(x) & 0x7f800000u) == 0x7f800000u;
}

fn polar(F: mat2x2f) -> mat2x2f {
  let x = F[0][0] + F[1][1];
  let y = F[0][1] - F[1][0];
  let s = sqrt(x * x + y * y);
  if (s < 1e-8) {
    return ID2;
  }
  let c = x / s;
  let sn = y / s;
  return rows(c, -sn, sn, c);
}

struct SVD {
  U: mat2x2f,
  sig: vec2f,
  V: mat2x2f,
}

fn svd2(F: mat2x2f) -> SVD {
  let R = polar(F);
  let S = transpose(R) * F;
  let s00 = S[0][0];
  let s11 = S[1][1];
  let s10 = S[0][1];
  var c = 1.0;
  var s = 0.0;
  var s1 = s00;
  var s2 = s11;
  if (abs(s10) >= 1e-6) {
    let tao = 0.5 * (s00 - s11);
    let w = sqrt(tao * tao + s10 * s10);
    var t: f32;
    if (tao > 0.0) {
      t = s10 / (tao + w);
    } else {
      t = s10 / (tao - w);
    }
    c = 1.0 / sqrt(t * t + 1.0);
    s = -t * c;
    s1 = c * c * s00 - 2.0 * c * s * s10 + s * s * s11;
    s2 = s * s * s00 + 2.0 * c * s * s10 + c * c * s11;
  }
  let V = rows(c, s, -s, c);
  return SVD(R * V, vec2f(s1, s2), V);
}

fn cellIndex(c: vec2i) -> u32 {
  return u32(c.y) * P.grid.x + u32(c.x);
}

struct Stencil {
  base: vec2i,
  fx: vec2f,
  wx: array<f32, 3>,
  wy: array<f32, 3>,
}

fn stencil(pos: vec2f) -> Stencil {
  let base = vec2i(floor(pos - vec2f(0.5)));
  let fx = pos - vec2f(base);
  let w0 = 0.5 * (1.5 - fx) * (1.5 - fx);
  let w1 = 0.75 - (fx - 1.0) * (fx - 1.0);
  let w2 = 0.5 * (fx - 0.5) * (fx - 0.5);
  return Stencil(base, fx, array<f32, 3>(w0.x, w1.x, w2.x), array<f32, 3>(w0.y, w1.y, w2.y));
}

fn scatterMomentum(idx: u32, mom: vec2f) {
  atomicAdd(&gridAtomic[idx], i32(round(mom.x * FIXED)));
  atomicAdd(&gridAtomic[idx + 1u], i32(round(mom.y * FIXED)));
}

// Pass 1: mass and APIC momentum for every material.
@compute @workgroup_size(64)
fn p2gMass(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) {
    return;
  }
  let p = particles[i];
  let st = stencil(p.pos);
  let pmass = PVOL * RHO[p.mat];
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      let off = vec2i(a, b);
      let dpos = vec2f(off) - st.fx;
      let weight = st.wx[a] * st.wy[b];
      let idx = cellIndex(st.base + off) * 4u;
      scatterMomentum(idx, weight * pmass * (p.vel + p.C * dpos));
      atomicAdd(&gridAtomic[idx + 2u], i32(round(weight * pmass * FIXED)));
      atomicAdd(&gridAtomic[idx + 3u], i32(round(weight * PVOL * FIXED)));
    }
  }
}

// Packed volume around a particle from the occupancy channel; 1.0 = rest packing (4 per cell).
fn occupancyAt(st: Stencil) -> f32 {
  var occ = 0.0;
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      let idx = cellIndex(st.base + vec2i(a, b)) * 4u;
      occ += st.wx[a] * st.wy[b] * f32(atomicLoad(&gridAtomic[idx + 3u])) / FIXED;
    }
  }
  return min(occ, 1.6);
}

// Pass 2: internal forces. Water pressure comes from how much volume is actually packed onto the
// grid, whatever material fills it (so particles can't silently pile up, and heavy sand doesn't
// read as over-compressed water); solids use their deformation gradient.
@compute @workgroup_size(64)
fn p2gStress(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) {
    return;
  }
  var p = particles[i];
  let dt = P.dt;
  let st = stencil(p.pos);
  // Force prefactor: -dt * volume * 4 * stress (Kirchhoff stress with reference volume for solids).
  var force = mat2x2f(0.0, 0.0, 0.0, 0.0);
  var mu = P.mu;
  var la = P.lambda;

  if (p.mat == WATER) {
    // Surface particles see a thin grid; clamp so their inflated volume can't amplify forces,
    // and don't pull (no tension) or they jitter into a floating spray.
    let occupancy = clamp(occupancyAt(st), 0.5, 1.6);
    let r2 = occupancy * occupancy;
    let pressure = max(P.waterK * (r2 * r2 - 1.0), 0.0);
    let volume = PVOL / occupancy;
    let stress = diag(vec2f(-pressure)) + P.viscosity * (p.C + transpose(p.C));
    force = (-dt * volume * 4.0) * stress;
    p.F = ID2;
  } else {
    var F = (ID2 + dt * p.C) * p.F;
    var tau = mat2x2f(0.0, 0.0, 0.0, 0.0);
    var volumeOverride = PVOL; // reference volume (Kirchhoff stress) unless a branch overrides
    if (p.mat == JELLY) {
      // Neo-Hookean: the ln(J) term pushes back harder the more it's crushed.
      mu *= P.jellyH;
      la *= P.jellyH;
      let J = max(determinant(F), 0.05);
      tau = mu * (F * transpose(F) - ID2) + diag(vec2f(la * log(J)));
    } else if (p.mat == SNOW) {
      let d = svd2(F);
      let sig = clamp(d.sig, vec2f(1.0 - 0.025), vec2f(1.0 + 0.0045));
      p.jp = clamp(p.jp * (d.sig.x * d.sig.y) / (sig.x * sig.y), 0.6, 20.0);
      let h = clamp(exp(10.0 * (1.0 - p.jp)), 0.1, 2.0);
      mu *= h;
      la *= h;
      F = d.U * diag(sig) * transpose(d.V);
      let R = d.U * transpose(d.V);
      let J = sig.x * sig.y;
      tau = 2.0 * mu * (F - R) * transpose(F) + diag(vec2f(la * J * (J - 1.0)));
    } else {
      // Sand: granular pressure from the actual packing on the grid (like water, so loosely
      // poured piles compact instead of freezing their voids), plus elastic shear stress capped
      // at friction * pressure (a Drucker-Prager return map on the isochoric part of F).
      let phi = occupancyAt(st);
      let pressure = max(P.waterK * 0.5 * (phi * phi * phi * phi - 1.0), 0.0);
      let d = svd2(F);
      let e = log(max(d.sig, vec2f(1e-4)));
      var dev = e - vec2f(0.5 * (e.x + e.y));
      let shearMu = mu * SAND_H;
      let shear = 2.0 * shearMu * length(dev);
      // Grains near the surface see air in their stencil and read ~zero pressure, so pure
      // friction would let that skin slide off and erode every slope; a little cohesion holds it.
      let limit = P.sandAlpha * pressure + SAND_COHESION;
      if (shear > limit) {
        dev *= limit / max(shear, 1e-8);
      }
      F = d.U * diag(exp(dev)) * transpose(d.V);
      let stress = d.U * diag(2.0 * shearMu * dev) * transpose(d.U) - diag(vec2f(pressure));
      volumeOverride = PVOL / max(phi, 0.5);
      tau = stress;
    }
    if (bad(F[0][0]) || bad(F[0][1]) || bad(F[1][0]) || bad(F[1][1])) {
      F = ID2;
      tau = mat2x2f(0.0, 0.0, 0.0, 0.0);
    }
    p.F = F;
    force = (-dt * volumeOverride * 4.0) * tau;
  }
  particles[i] = p;

  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      let off = vec2i(a, b);
      let dpos = vec2f(off) - st.fx;
      scatterMomentum(cellIndex(st.base + off) * 4u, st.wx[a] * st.wy[b] * (force * dpos));
    }
  }
}

@compute @workgroup_size(64)
fn gridUpdate(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= P.grid.x * P.grid.y) {
    return;
  }
  let o = idx * 4u;
  let mx = atomicLoad(&gridAtomic[o]);
  let my = atomicLoad(&gridAtomic[o + 1u]);
  let mm = atomicLoad(&gridAtomic[o + 2u]);
  let occ = atomicLoad(&gridAtomic[o + 3u]);
  atomicStore(&gridAtomic[o], 0);
  atomicStore(&gridAtomic[o + 1u], 0);
  atomicStore(&gridAtomic[o + 2u], 0);
  atomicStore(&gridAtomic[o + 3u], 0);

  var v = vec2f(0.0);
  let m = f32(mm) / FIXED;
  if (m > 1e-5) {
    v = vec2f(f32(mx), f32(my)) / FIXED / m;
    v += P.dt * P.gravity;
    let cell = vec2f(f32(idx % P.grid.x), f32(idx / P.grid.x));

    // Poke: each finger is a solid disc stirrer. Inside the disc, matter can't move inward
    // relative to the finger and gets nudged out; a soft rim drags matter along.
    for (var k = 0u; k < P.pointerCount; k++) {
      let pp = P.pointers[k];
      let r = P.pointerParams[k].x;
      let strength = P.pointerParams[k].y;
      let delta = cell - pp.xy;
      let d = length(delta);
      if (d < r * 1.6) {
        let n = delta / max(d, 1e-4);
        var rel = v - pp.zw;
        if (d < r) {
          let vn = dot(rel, n);
          if (vn < 0.0) {
            rel -= vn * n;
          }
          rel += n * (r - d) * 25.0 * strength;
          v = pp.zw + rel;
        } else {
          let f = 1.0 - (d - r) / (r * 0.6);
          v = mix(v, pp.zw, clamp(f * f * 0.15 * strength, 0.0, 1.0));
        }
      }
    }

    let lo = 2.0;
    let hi = P.domain - vec2f(2.0);
    if (cell.x < lo && v.x < 0.0) { v.x = 0.0; }
    if (cell.x > hi.x && v.x > 0.0) { v.x = 0.0; }
    if (cell.y > hi.y && v.y > 0.0) { v.y = 0.0; }
    if (cell.y < lo) {
      if (v.y < 0.0) { v.y = 0.0; }
    }
    if (cell.y < lo + 1.0) {
      v.x *= 0.3; // grippy floor: on a frictionless one any granular pile spreads out forever
    }
    let vmax = 0.6 / P.dt;
    let sp = length(v);
    if (sp > vmax) {
      v *= vmax / sp;
    }
  }
  gridV[idx] = vec4f(v, f32(mm) / FIXED, f32(occ) / FIXED);
}

@compute @workgroup_size(64)
fn g2p(@builtin(global_invocation_id) gid: vec3u) {
  let i = gid.x;
  if (i >= P.count) {
    return;
  }
  var p = particles[i];
  let st = stencil(p.pos);
  var v = vec2f(0.0);
  var mass = 0.0;
  var vol = 0.0;
  var B = mat2x2f(0.0, 0.0, 0.0, 0.0);
  for (var a = 0; a < 3; a++) {
    for (var b = 0; b < 3; b++) {
      let off = vec2i(a, b);
      let dpos = vec2f(off) - st.fx;
      let weight = st.wx[a] * st.wy[b];
      let node = gridV[cellIndex(st.base + off)];
      let gv = node.xy;
      mass += weight * node.z;
      vol += weight * node.w;
      v += weight * gv;
      B += (4.0 * weight) * mat2x2f(gv * dpos.x, gv * dpos.y);
    }
  }
  p.vel = v;
  p.C = B;
  // Grains can't move relative to the fluid they share nodes with, so porous sand would float
  // and loose snow sink. Give sand and snow a kinematic buoyancy slip along gravity; it vanishes
  // wherever the grain is surrounded by its own material.
  var drift = vec2f(0.0);
  if (p.mat == SAND || p.mat == SNOW) {
    // Mass-weighted, so empty air nodes around a pile's surface don't count as "lighter" matter.
    let mixture = mass / max(vol, 1e-6);
    drift = P.gravity * clamp(RHO[p.mat] - mixture, -1.0, 1.0) * 0.2;
  }
  p.pos = clamp(p.pos + P.dt * (v + drift), vec2f(2.0), P.domain - vec2f(2.0));
  if (bad(p.pos.x) || bad(p.pos.y) || bad(v.x) || bad(v.y)) {
    p.pos = P.domain * vec2f(0.5, 0.8);
    p.vel = vec2f(0.0);
    p.C = mat2x2f(0.0, 0.0, 0.0, 0.0);
    p.F = ID2;
  }
  particles[i] = p;
}
