// Screen-space fluid rendering (van der Laan et al. 2009, after WebGPU-Ocean): particle spheres
// -> depth -> bilateral smoothing -> normals; additive thickness + foam; then a composite that
// refracts rays into an analytic scene (tiled tank, beach balls, studio backdrop).

@group(0) @binding(0) var<uniform> P: Params;
@group(0) @binding(1) var<storage, read> particlesR: array<Particle>;
@group(0) @binding(2) var depthIn: texture_2d<f32>;
@group(0) @binding(3) var fluidDepth: texture_2d<f32>;
@group(0) @binding(4) var thickTex: texture_2d<f32>;
@group(0) @binding(5) var samp: sampler;
@group(0) @binding(6) var<uniform> blurDir: vec4f;

const CORNERS = array<vec2f, 4>(vec2f(-1.0, -1.0), vec2f(1.0, -1.0), vec2f(-1.0, 1.0), vec2f(1.0, 1.0));

struct SpriteOut {
  @builtin(position) clip: vec4f,
  @location(0) corner: vec2f,
  @location(1) viewCenter: vec3f,
  @location(2) foam: f32,
}

@vertex
fn spriteVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) ii: u32) -> SpriteOut {
  let p = particlesR[ii];
  let corner = CORNERS[vi];
  let vc = (P.view * vec4f(p.pos, 1.0)).xyz;
  let r = P.radius;
  var out: SpriteOut;
  out.clip = P.proj * vec4f(vc + vec3f(corner * r, 0.0), 1.0);
  out.corner = corner;
  out.viewCenter = vc;
  let speed = length(p.vel);
  out.foam = smoothstep(P.foamThreshold, P.foamThreshold * 2.2, speed);
  return out;
}

struct DepthOut {
  @location(0) depth: f32,
  @builtin(frag_depth) fragDepth: f32,
}

@fragment
fn depthFS(in: SpriteOut) -> DepthOut {
  let r2 = dot(in.corner, in.corner);
  if (r2 > 1.0) {
    discard;
  }
  let z = sqrt(1.0 - r2);
  let viewPos = in.viewCenter + vec3f(in.corner * P.radius, z * P.radius);
  let clip = P.proj * vec4f(viewPos, 1.0);
  var out: DepthOut;
  out.depth = -viewPos.z;
  out.fragDepth = clip.z / clip.w;
  return out;
}

@fragment
fn thickFS(in: SpriteOut) -> @location(0) vec4f {
  let r2 = dot(in.corner, in.corner);
  if (r2 > 1.0) {
    discard;
  }
  let z = sqrt(1.0 - r2);
  let t = 2.0 * z * P.radius * P.thickScale;
  return vec4f(t, in.foam * z, 0.0, 0.0);
}

// ---------------------------------------------------------------- fullscreen

struct QuadOut {
  @builtin(position) clip: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn quadVS(@builtin(vertex_index) vi: u32) -> QuadOut {
  let pos = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  var out: QuadOut;
  out.clip = vec4f(pos[vi], 0.0, 1.0);
  out.uv = pos[vi] * vec2f(0.5, -0.5) + vec2f(0.5);
  return out;
}

// Bilateral depth filter, one axis per pass. The kernel width follows the projected particle
// size, so smoothing looks the same near and far.
@fragment
fn blurFS(in: QuadOut) -> @location(0) f32 {
  let size = vec2i(textureDimensions(depthIn));
  let c = vec2i(in.clip.xy);
  let d0 = textureLoad(depthIn, c, 0).r;
  if (d0 <= 0.0) {
    return 0.0;
  }
  let pxPerUnit = P.proj[1][1] * 0.5 * f32(size.y) / d0;
  let radiusPx = clamp(P.radius * P.smoothing * pxPerUnit, 1.0, 14.0);
  let sigma = radiusPx * 0.5;
  let range = P.radius * 2.5;
  let dir = vec2i(blurDir.xy);
  var sum = d0;
  var wsum = 1.0;
  let n = i32(ceil(radiusPx));
  for (var i = 1; i <= 14; i++) {
    if (i > n) {
      break;
    }
    for (var s = -1; s <= 1; s += 2) {
      let q = clamp(c + dir * i * s, vec2i(0), size - vec2i(1));
      let d = textureLoad(depthIn, q, 0).r;
      if (d > 0.0) {
        let fi = f32(i);
        let dz = (d - d0) / range;
        let w = exp(-fi * fi / (2.0 * sigma * sigma) - dz * dz);
        sum += d * w;
        wsum += w;
      }
    }
  }
  return sum / wsum;
}

// ---------------------------------------------------------------- scene

fn hash2(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(127.1, 311.7))) * 43758.5453);
}

fn noise2(p: vec2f) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash2(i), hash2(i + vec2f(1.0, 0.0)), u.x), mix(hash2(i + vec2f(0.0, 1.0)), hash2(i + vec2f(1.0, 1.0)), u.x), u.y);
}

// Cheap animated caustic web for surfaces under the water line.
fn caustic(p: vec2f) -> f32 {
  let t = P.time * 0.6;
  var q = p * 0.35;
  var c = 0.0;
  for (var k = 0; k < 3; k++) {
    let n = noise2(q + vec2f(t, -t * 0.7)) + noise2(q * 1.7 - vec2f(t * 0.8, t * 0.4));
    c += pow(1.0 - abs(n - 1.0), 6.0);
    q = q * 1.9 + vec2f(3.1, 1.7);
  }
  return c * 0.5;
}

fn envColor(dir: vec3f) -> vec3f {
  // Studio backdrop in view space so it stays put when the tank tilts.
  let d = normalize((P.view * vec4f(dir, 0.0)).xyz);
  let up = d.y;
  var col = mix(vec3f(0.10, 0.07, 0.16), vec3f(0.34, 0.22, 0.42), smoothstep(-0.6, 0.5, up));
  col = mix(col, vec3f(1.0, 0.78, 0.55), smoothstep(0.35, 1.0, up) * 0.55);
  // A big soft window light up and to the left.
  let win = exp(-8.0 * dot(d.xy - vec2f(-0.45, 0.55), d.xy - vec2f(-0.45, 0.55)));
  col += vec3f(1.0, 0.95, 0.85) * win * 0.9 * smoothstep(0.2, -0.6, d.z);
  return col;
}

fn tileColor(uv: vec2f, seed: f32) -> vec3f {
  let tile = 3.0;
  let cell = floor(uv / tile);
  let f = fract(uv / tile);
  let grout = smoothstep(0.0, 0.07, f.x) * smoothstep(0.0, 0.07, f.y) * smoothstep(1.0, 0.93, f.x) * smoothstep(1.0, 0.93, f.y);
  let h = hash2(cell + seed);
  var base = vec3f(0.93, 0.90, 0.84) - h * 0.06;
  // Scattered accent tiles make refraction wobble easy to read.
  if (h > 0.86) {
    base = vec3f(1.0, 0.45, 0.45);
  } else if (h > 0.78) {
    base = vec3f(0.35, 0.7, 1.0);
  } else if (h > 0.72) {
    base = vec3f(1.0, 0.82, 0.3);
  }
  return base * mix(0.62, 1.0, grout);
}

struct Hit {
  t: f32,
  col: vec3f,
}

fn sphereHit(ro: vec3f, rd: vec3f, c: vec3f, r: f32) -> f32 {
  let oc = ro - c;
  let b = dot(oc, rd);
  let h = b * b - (dot(oc, oc) - r * r);
  if (h < 0.0) {
    return -1.0;
  }
  return -b - sqrt(h);
}

fn ballColor(i: u32, p: vec3f, rd: vec3f) -> vec3f {
  let b = P.balls[i];
  let n = normalize(p - b.xyz);
  let spin = P.ballSpin[i].x;
  let cs = cos(spin);
  let sn = sin(spin);
  let nr = vec3f(cs * n.x - sn * n.y, sn * n.x + cs * n.y, n.z);
  let seg = u32(floor((atan2(nr.x, nr.z) / 6.2831853 + 0.5) * 6.0)) % 6u;
  let palette = array<vec3f, 6>(vec3f(0.95, 0.2, 0.25), vec3f(0.97), vec3f(0.15, 0.45, 0.95), vec3f(1.0, 0.8, 0.15), vec3f(0.97), vec3f(0.2, 0.8, 0.4));
  var base = palette[(seg + u32(P.ballSpin[i].y)) % 6u];
  if (abs(nr.y) > 0.82) {
    base = vec3f(0.97);
  }
  let L = normalize(P.lightDir);
  let diff = clamp(dot(n, L), 0.0, 1.0);
  let spec = pow(max(dot(reflect(rd, n), L), 0.0), 60.0);
  return base * (0.32 + 0.8 * diff) + vec3f(spec * 0.9);
}

// Everything behind the water: balls, the tank's inside walls, and the backdrop.
fn sceneColor(ro: vec3f, rd: vec3f) -> vec3f {
  var best = Hit(1e9, vec3f(0.0));
  for (var i = 0u; i < P.ballCount; i++) {
    let t = sphereHit(ro, rd, P.balls[i].xyz, P.balls[i].w);
    if (t > 0.0 && t < best.t) {
      best = Hit(t, ballColor(i, ro + rd * t, rd));
    }
  }

  // Far side of the tank box along the ray.
  let inv = 1.0 / rd;
  let t0 = (P.tankMin - ro) * inv;
  let t1 = (P.tankMax - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tEnter = max(max(tmin.x, tmin.y), tmin.z);
  let tExit = min(min(tmax.x, tmax.y), tmax.z);
  if (tExit > max(tEnter, 0.0) && tExit < best.t) {
    let p = ro + rd * tExit;
    let size = P.tankMax - P.tankMin;
    let e = 1e-3;
    var col: vec3f;
    var lightK = 1.0;
    var wet = 0.0;
    if (p.y > P.tankMax.y - e) {
      return select(envColor(rd), best.col, best.t < 1e8);
    } else if (p.y < P.tankMin.y + e) {
      // Sandy floor with pebbles.
      let g = noise2(p.xz * 2.3) * 0.5 + noise2(p.xz * 7.1) * 0.25;
      col = mix(vec3f(0.86, 0.72, 0.5), vec3f(0.98, 0.88, 0.66), g);
      let peb = step(0.8, noise2(p.xz * 0.9 + 11.0));
      col = mix(col, vec3f(0.55, 0.5, 0.48), peb * 0.6);
      wet = 1.0;
      lightK = 0.95;
    } else if (p.z < P.tankMin.z + e) {
      col = tileColor(p.xy, 0.0);
      wet = step(p.y, P.waterLevel);
      lightK = mix(0.75, 1.0, smoothstep(P.tankMin.y, P.tankMax.y, p.y));
    } else if (p.z > P.tankMax.z - e) {
      return select(envColor(rd) * 0.8, best.col, best.t < 1e8);
    } else {
      col = tileColor(vec2f(p.z, p.y), 7.0) * 0.82;
      wet = step(p.y, P.waterLevel);
    }
    col *= lightK;
    if (wet > 0.0) {
      col += col * caustic(select(p.xy, p.xz, p.y < P.tankMin.y + e)) * 0.55;
    }
    return col;
  }
  if (best.t < 1e8) {
    return best.col;
  }
  return envColor(rd);
}

fn viewRay(uv: vec2f) -> vec3f {
  let ndc = vec2f(uv.x * 2.0 - 1.0, 1.0 - uv.y * 2.0);
  let v = P.invProj * vec4f(ndc, 1.0, 1.0);
  return normalize(v.xyz / v.w);
}

fn viewPosAt(px: vec2i) -> vec3f {
  let d = textureLoad(fluidDepth, px, 0).r;
  let uv = (vec2f(px) + 0.5) * P.fluidTexel;
  let dir = viewRay(uv);
  return dir * (d / -dir.z);
}

fn aces(x: vec3f) -> vec3f {
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), vec3f(0.0), vec3f(1.0));
}

// Glass box outline: bright where the ray crosses the box near two faces at once.
fn edgeGlow(p: vec3f, dist: f32) -> f32 {
  let lo = P.tankMin - vec3f(0.35);
  let hi = P.tankMax + vec3f(0.35);
  let dmin = min(abs(p - lo), abs(p - hi));
  let w = 0.1 + dist * 0.004;
  let a = select(0.0, 1.0, dmin.x < w) + select(0.0, 1.0, dmin.y < w) + select(0.0, 1.0, dmin.z < w);
  return step(1.5, a);
}

@fragment
fn compositeFS(in: QuadOut) -> @location(0) vec4f {
  let uv = in.uv;
  let dirView = viewRay(uv);
  let rd = normalize((P.invView * vec4f(dirView, 0.0)).xyz);
  let ro = P.camPos;
  var col = sceneColor(ro, rd);

  let fsize = vec2i(textureDimensions(fluidDepth));
  let fpx = clamp(vec2i(uv / P.fluidTexel), vec2i(0), fsize - vec2i(1));
  let d = textureLoad(fluidDepth, fpx, 0).r;
  let thick = textureSampleLevel(thickTex, samp, uv, 0.0);
  var fluidT = 1e9;
  if (d > 0.0) {
    // Normals from the smoothed depth, taking the smaller one-sided difference at silhouettes.
    let pc = viewPosAt(fpx);
    let px1 = viewPosAt(min(fpx + vec2i(1, 0), fsize - vec2i(1))) - pc;
    let px0 = pc - viewPosAt(max(fpx - vec2i(1, 0), vec2i(0)));
    let py1 = viewPosAt(min(fpx + vec2i(0, 1), fsize - vec2i(1))) - pc;
    let py0 = pc - viewPosAt(max(fpx - vec2i(0, 1), vec2i(0)));
    let ddx = select(px0, px1, abs(px1.z) < abs(px0.z));
    let ddy = select(py0, py1, abs(py1.z) < abs(py0.z));
    var nView = normalize(cross(ddy, ddx));
    if (nView.z < 0.0) {
      nView = -nView;
    }
    let n = normalize((P.invView * vec4f(nView, 0.0)).xyz);
    let wp = (P.invView * vec4f(pc, 1.0)).xyz;
    fluidT = length(wp - ro);

    let t = max(thick.r, 0.0);
    let refr = refract(rd, n, 1.0 / 1.33);
    // Bend the ray a little further through thick water so depth reads as lensing.
    let refrColor = sceneColor(wp + refr * 0.05, normalize(refr + (refr - rd) * min(t * 0.03, 0.6)));
    let trans = exp(-t * P.absorb * vec3f(0.95, 0.32, 0.12));
    let deep = vec3f(0.02, 0.18, 0.32);
    var water = refrColor * trans + deep * (1.0 - trans) * 0.6;
    let cosT = clamp(dot(n, -rd), 0.0, 1.0);
    let fresnel = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
    water = mix(water, envColor(reflect(rd, n)), fresnel);
    let L = normalize(P.lightDir);
    let spec = pow(max(dot(reflect(rd, n), L), 0.0), 120.0);
    water += vec3f(spec * 1.6);
    // Thin sheets fade in so spray edges don't look cut out.
    let alpha = smoothstep(0.0, 1.2, t);
    // A beach ball nearer than the water surface stays on top.
    var ballFront = false;
    for (var i = 0u; i < P.ballCount; i++) {
      let tb = sphereHit(ro, rd, P.balls[i].xyz, P.balls[i].w);
      if (tb > 0.0 && tb < fluidT) {
        ballFront = true;
      }
    }
    if (!ballFront) {
      col = mix(col, water, alpha);
    }
  }
  // Foam and spray: the fraction of fast-moving water along the ray, so a deep splash reads as
  // white crests rather than a fog through the whole tank. Loose spray (thin) still shows.
  let foamFrac = clamp(thick.g * 2.0 * P.radius * P.thickScale / max(thick.r, 1e-3), 0.0, 1.0);
  let foamAmt = foamFrac * smoothstep(0.05, 0.6, thick.r) * 0.55;
  col = mix(col, vec3f(0.92, 0.97, 1.0), foamAmt);

  // Glass: faint sheen on the front pane plus bright edges.
  let lo = P.tankMin - vec3f(0.35);
  let hi = P.tankMax + vec3f(0.35);
  let inv = 1.0 / rd;
  let t0 = (lo - ro) * inv;
  let t1 = (hi - ro) * inv;
  let tmin = min(t0, t1);
  let tmax = max(t0, t1);
  let tEnter = max(max(tmin.x, tmin.y), tmin.z);
  let tExit = min(min(tmax.x, tmax.y), tmax.z);
  if (tExit > max(tEnter, 0.0)) {
    let pe = ro + rd * tEnter;
    let px = ro + rd * tExit;
    col += vec3f(0.85, 0.95, 1.0) * edgeGlow(px, tExit) * 0.18;
    col += vec3f(0.9, 0.97, 1.0) * edgeGlow(pe, tEnter) * 0.55;
    let sheen = smoothstep(0.35, 0.0, abs(uv.x - uv.y * 0.5 - 0.1)) * 0.06;
    col += vec3f(sheen);
  }

  col = aces(col * 1.05);
  let q = uv - 0.5;
  col *= 1.0 - dot(q, q) * 0.5;
  col = pow(col, vec3f(1.0 / 2.2));
  col += (hash2(in.clip.xy + P.time) - 0.5) / 255.0;
  return vec4f(col, 1.0);
}
