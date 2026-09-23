// Shared layout for the Goo Lab sim and renderer. Mirrors PARAM_* offsets in sim.ts.

struct Params {
  grid: vec2u,          // grid nodes (x, y)
  domain: vec2f,        // domain size in cells; the canvas maps exactly onto it
  gravity: vec2f,       // cells / s^2
  dt: f32,              // substep length, seconds
  count: u32,           // live particles
  mu: f32,
  lambda: f32,
  waterK: f32,
  viscosity: f32,
  jellyH: f32,
  sandAlpha: f32,
  time: f32,
  pointerCount: u32,
  pointers: array<vec4f, 8>,       // pos.xy (cells), vel.xy (cells/s)
  pointerParams: array<vec4f, 8>,  // radius (cells), strength
  particleRadius: f32,  // render radius in cells
  densityNorm: f32,     // 1 / expected splat density of a filled region
  texel: vec2f,         // 1 / splat target size
  iso: f32,
  glow: f32,
  screen: vec2f,        // canvas size in pixels
}

struct Particle {
  pos: vec2f,
  vel: vec2f,
  C: mat2x2f,
  F: mat2x2f,
  mat: u32,
  jp: f32,     // snow: plastic volume ratio; jelly: colour id
  seed: f32,   // per-particle random in [0, 1)
  pad: f32,
}

const WATER: u32 = 0u;
const JELLY: u32 = 1u;
const SNOW: u32 = 2u;
const SAND: u32 = 3u;
