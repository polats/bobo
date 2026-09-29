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

fn hash11(x: f32) -> f32 {
  return fract(sin(x * 127.1 + 311.7) * 43758.5453);
}

// Glinty grains: each grain carries one mirror micro-facet (random tilt and azimuth from its seed)
// that flashes when it lines up with the half vector of a slowly orbiting light. The facet spins
// with the grain's rotation (polar angle of F) and with distance travelled, so moving grains
// shimmer and a settled pile only twinkles gently as the light drifts: no per-frame noise.
fn glint(p: Particle, share: f32, sharp: f32) -> f32 {
  let h1 = hash11(p.seed * 17.0);
  let h2 = hash11(p.seed * 29.0 + 3.1);
  if (hash11(p.seed * 41.0 + 7.7) > share) {
    return 0.0;
  }
  let rot = atan2(p.F[0].y - p.F[1].x, p.F[0].x + p.F[1].y);
  let roll = dot(p.pos, vec2f(0.61, 0.43)) * 1.6;
  let az = h1 * 6.2831853 + rot + roll;
  let tilt = mix(0.1, 0.75, h2);
  let m = vec3f(sin(tilt) * vec2f(cos(az), sin(az)), cos(tilt));
  let la = P.time * 0.7;
  let L = normalize(vec3f(0.8 * cos(la), 0.8 * sin(la), 1.0));
  let H = normalize(L + vec3f(0.0, 0.0, 1.0));
  return pow(max(dot(m, H), 0.0), sharp);
}

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
    var sparkle = pow(max(tw, 0.0), 24.0);
    if (P.glitter > 0.5) {
      sparkle = glint(p, 0.55, 600.0);
    }
    o.color = vec3f(0.86, 0.92, 1.0) * (0.95 + 0.08 * p.seed);
    o.extra = vec4f(1.0, 0.0, sparkle, 0.0);
  } else {
    o.color = mix(vec3f(0.78, 0.5, 0.2), vec3f(1.0, 0.8, 0.42), p.seed);
    var sparkle = 0.0;
    if (P.glitter > 0.5) {
      sparkle = glint(p, 0.3, 1400.0);
    }
    o.extra = vec4f(1.0, 0.0, sparkle, 1.0);
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
  var extra = in.extra * w;
  if (P.glitter > 0.5) {
    // Glints land as a tight point at the grain centre, left unnormalised in the composite,
    // so one flashing grain stays a crisp bright pixel instead of being averaged away.
    extra.z = in.extra.z * smoothstep(0.11, 0.0, r2);
  }
  return SplatTargets(vec4f(in.color * w, w), extra);
}
