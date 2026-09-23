// Draws every particle as a soft disc into two additive rgba16float targets:
// colour + density, and material extras (opacity, foam, sparkle, grain).

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> particles: array<Particle>;

struct SplatOut {
  @builtin(position) pos: vec4f,
  @location(0) q: vec2f,
  @location(1) color: vec3f,
  @location(2) extra: vec4f, // opacity, foam, sparkle, grain
}

const JELLY_COLORS = array<vec3f, 5>(
  vec3f(1.0, 0.24, 0.55),
  vec3f(0.55, 1.0, 0.25),
  vec3f(1.0, 0.55, 0.12),
  vec3f(0.62, 0.36, 1.0),
  vec3f(0.2, 0.95, 0.85),
);

@vertex
fn splatVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SplatOut {
  let p = particles[ii];
  let corner = vec2f(f32(vi & 1u), f32(vi >> 1u)) * 2.0 - 1.0;
  let world = p.pos + corner * P.particleRadius;
  var o: SplatOut;
  o.pos = vec4f(world / P.domain * 2.0 - 1.0, 0.0, 1.0);
  o.q = corner;
  let speed = length(p.vel);
  if (p.mat == WATER) {
    let foam = smoothstep(90.0, 260.0, speed);
    o.color = mix(vec3f(0.08, 0.42, 1.0), vec3f(0.35, 0.8, 1.0), 0.35 * p.seed + 0.4 * foam);
    o.extra = vec4f(0.5, foam, 0.0, 0.0);
  } else if (p.mat == JELLY) {
    let id = u32(p.jp) % 5u;
    o.color = JELLY_COLORS[id] * (0.92 + 0.12 * p.seed);
    o.extra = vec4f(1.0, 0.0, 0.0, 0.0);
  } else if (p.mat == SNOW) {
    let tw = sin(P.time * (2.0 + 4.0 * p.seed) + p.seed * 91.0);
    let sparkle = pow(max(tw, 0.0), 24.0);
    o.color = vec3f(0.86, 0.92, 1.0) * (0.95 + 0.08 * p.seed);
    o.extra = vec4f(1.0, 0.0, sparkle, 0.0);
  } else {
    o.color = mix(vec3f(0.78, 0.5, 0.2), vec3f(1.0, 0.8, 0.42), p.seed);
    o.extra = vec4f(1.0, 0.0, 0.0, 1.0);
  }
  return o;
}

struct SplatTargets {
  @location(0) a: vec4f,
  @location(1) b: vec4f,
}

@fragment
fn splatFS(in: SplatOut) -> SplatTargets {
  let r2 = dot(in.q, in.q);
  if (r2 > 1.0) {
    discard;
  }
  let k = 1.0 - r2;
  let w = k * k * k;
  return SplatTargets(vec4f(in.color * w, w), in.extra * w);
}
