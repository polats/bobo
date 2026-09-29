// Turns the splatted density field into a metaball surface with fake normals, specular,
// rim light, refraction through water and a soft glow.

@group(0) @binding(0) var<uniform> P: Params;

@group(0) @binding(1) var fieldA: texture_2d<f32>;
@group(0) @binding(2) var fieldB: texture_2d<f32>;
@group(0) @binding(3) var samp: sampler;

@vertex
fn fullscreenVS(@builtin(vertex_index) vi: u32) -> @builtin(position) vec4f {
  let x = f32((vi << 1u) & 2u) * 2.0 - 1.0;
  let y = f32(vi & 2u) * 2.0 - 1.0;
  return vec4f(x, y, 0.0, 1.0);
}

fn hash(p: vec2f) -> f32 {
  return fract(sin(dot(p, vec2f(12.9898, 78.233))) * 43758.5453);
}

fn background(uv: vec2f) -> vec3f {
  let top = vec3f(0.035, 0.03, 0.075);
  let bottom = vec3f(0.01, 0.012, 0.02);
  var c = mix(top, bottom, uv.y);
  let v = length((uv - 0.5) * vec2f(1.0, 0.8));
  c *= 1.0 - 0.55 * v * v;
  // faint dot grid gives the refraction something to bend
  let g = fract(uv * vec2f(28.0, 28.0 * P.domain.y / P.domain.x)) - 0.5;
  c += vec3f(0.018, 0.02, 0.04) * smoothstep(0.08, 0.0, length(g));
  return c;
}

fn dens(uv: vec2f) -> f32 {
  return textureSampleLevel(fieldA, samp, uv, 0.0).a * P.densityNorm;
}

fn height(uv: vec2f) -> f32 {
  return smoothstep(P.iso * 0.4, P.iso * 1.8, dens(uv));
}

// Upward-positive gradient of the height field (screen y grows downward).
fn slope(uv: vec2f, t: vec2f) -> vec2f {
  let gx = height(uv + vec2f(t.x, 0.0)) - height(uv - vec2f(t.x, 0.0));
  let gy = height(uv - vec2f(0.0, t.y)) - height(uv + vec2f(0.0, t.y));
  return vec2f(gx, gy);
}

@fragment
fn compositeFS(@builtin(position) fc: vec4f) -> @location(0) vec4f {
  let uv = fc.xy / P.screen;
  let a = textureSampleLevel(fieldA, samp, uv, 0.0);
  let b = textureSampleLevel(fieldB, samp, uv, 0.0);
  let d = a.a * P.densityNorm;
  // Height field = density clamped just above the iso level, so interiors are flat and only
  // edges bevel. A fine and a coarse gradient together read as a rounded, pillowy surface.
  let fine = slope(uv, P.texel * 2.0) * 1.4;
  let coarse = slope(uv, P.texel * 7.0) * 2.6;
  let n = normalize(vec3f(-(fine + coarse), 1.0));

  let inv = 1.0 / max(a.a, 1e-5);
  let col = a.rgb * inv;
  let ex = b * inv;
  let opacity = clamp(ex.x, 0.0, 1.0);
  let foam = clamp(ex.y, 0.0, 1.0);
  let sparkle = ex.z;
  let grain = clamp(ex.w, 0.0, 1.0);

  let L = normalize(vec3f(-0.45, 0.65, 0.75));
  let H = normalize(L + vec3f(0.0, 0.0, 1.0));
  let diffuse = 0.55 + 0.45 * max(dot(n, L), 0.0);
  let gloss = mix(1.0, 0.15, grain);
  let spec = pow(max(dot(n, H), 0.0), mix(70.0, 18.0, grain)) * gloss;
  let rim = pow(1.0 - n.z, 1.5);

  var surface = col * diffuse + col * rim * 0.9 + vec3f(spec) * 0.85 + vec3f(foam * 0.55);
  // Water (opacity < 1) darkens with depth and gets a slow caustic shimmer.
  let wet = clamp((1.0 - opacity) * 2.0, 0.0, 1.0);
  let aspect = P.screen.y / P.screen.x;
  let wave = sin(uv.x * 38.0 + sin(uv.y * aspect * 31.0 + P.time * 1.3) * 2.2 + P.time * 0.9)
    * sin(uv.y * aspect * 27.0 - P.time * 0.7 + sin(uv.x * 23.0 - P.time) * 1.8);
  surface *= mix(1.0, mix(1.0, 0.55, smoothstep(0.5, 1.0, uv.y)), wet);
  surface += vec3f(0.35, 0.7, 1.0) * pow(max(wave, 0.0), 6.0) * 0.35 * wet;
  let noise = hash(floor(fc.xy / 1.5));
  surface *= 1.0 + (noise - 0.5) * 0.3 * grain;
  if (P.glitter > 0.5) {
    // b.z is the raw sum of grain glints (see splatFS): sharpen the core, favour slopes facing
    // the key light, and tint cold blue-white on snow, a paler warm gold on sand.
    let g = smoothstep(0.2, 0.75, b.z) * (0.6 + 0.55 * max(dot(n, L), 0.0));
    let tint = mix(vec3f(0.82, 0.93, 1.0) * 2.4, vec3f(1.0, 0.93, 0.72) * 2.0, grain);
    surface += tint * g * opacity;
  } else {
    surface += vec3f(1.0, 0.98, 0.9) * sparkle * 1.6 * step(0.55, noise);
  }

  let mask = smoothstep(P.iso - 0.07, P.iso + 0.07, d);
  let bgRefracted = background(uv + vec2f(n.x, -n.y) * 0.035 * mask);
  let body = mix(bgRefracted * (0.7 + 0.6 * col), surface, opacity);
  var outc = mix(background(uv), body, mask);

  // soft glow from a ring of wide taps
  var halo = vec4f(0.0);
  for (var i = 0; i < 8; i++) {
    let ang = f32(i) * 0.7853982;
    halo += textureSampleLevel(fieldA, samp, uv + vec2f(cos(ang), sin(ang)) * P.texel * 9.0, 0.0);
  }
  let glowCol = halo.rgb / max(halo.a, 1e-5);
  let glowAmt = smoothstep(0.02, 0.9, halo.a * P.densityNorm / 8.0) * (1.0 - mask);
  outc += glowCol * glowAmt * P.glow;

  return vec4f(outc, 1.0);
}
