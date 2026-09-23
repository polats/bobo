// Shared layout for the Splash Tank sim and renderer. Mirrors the P_* offsets in index.ts.
// Units: one grid cell = 1. The tank interior spans tankMin..tankMax in these coordinates.

struct Params {
  grid: vec3u,
  count: u32,
  gravity: vec3f,        // cells / s^2, in tank coordinates
  dt: f32,               // substep length, seconds
  waterK: f32,           // EOS stiffness
  viscosity: f32,
  time: f32,
  probeCount: u32,
  probes: array<vec4f, 8>,     // centre.xyz (cells), radius (cells)
  probeVel: array<vec4f, 8>,   // velocity.xyz (cells / s), strength
  view: mat4x4f,               // tank -> view
  proj: mat4x4f,
  invView: mat4x4f,
  invProj: mat4x4f,
  camPos: vec3f,               // camera in tank coordinates
  radius: f32,                 // particle render radius (cells)
  screen: vec2f,               // canvas size in pixels
  fluidTexel: vec2f,           // 1 / fluid target size
  tankMin: vec3f,
  absorb: f32,
  tankMax: vec3f,
  foamThreshold: f32,          // speed (cells / s) where particles start to read as foam
  lightDir: vec3f,             // direction towards the light, tank coordinates
  smoothing: f32,              // depth filter radius, in particle radii
  ballCount: u32,
  waterLevel: f32,             // mean surface height (cells) for the fake wall caustics
  fluidScale: f32,             // fluid target size / canvas size
  thickScale: f32,
  balls: array<vec4f, 4>,      // centre.xyz, radius
  ballSpin: array<vec4f, 4>,   // spin angle, colour seed
  bulk: f32,                   // bulk viscosity: damps compression waves, leaves sloshing alone
  affineKeep: f32,             // fraction of APIC's affine C kept each substep (1 = pure APIC)
  pad3: f32,
  pad4: f32,
}

struct Particle {
  pos: vec3f,
  pad0: f32,
  vel: vec3f,
  pad1: f32,
  C: mat3x3f,
}
