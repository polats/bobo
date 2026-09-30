// Brittle rods. Spaghetti is Heisser et al. 2018's measured Barilla no. 3 (2r = 1.4 mm, E = 3.8 GPa,
// µ = 1.5 GPa, ρ = 1.5 g/cm³, L = 24 cm, limit curvature ≈ 14 m⁻¹ at zero twist, pure torsion
// failing near 360°); the others are handbook-order estimates.

export type MatId = 'spaghetti' | 'twig' | 'chopstick' | 'lead';

export interface Mat {
  id: MatId;
  label: string;
  /** Radius (m), length (m), Young's and shear moduli (Pa), density (kg/m³). */
  r: number;
  L: number;
  E: number;
  mu: number;
  rho: number;
  /** Limit curvature (1/m) with no twist and no damage. */
  kc: number;
  /** Limit twist rate (rad/m) with no bending. */
  tc: number;
  /** Strength scatter between nodes (coefficient of variation), from flaws. */
  cov: number;
  /**
   * Cross-section layers that crack one at a time before the rod separates (Tsai et al. 2016's
   * layered section): count, depth fraction each, stress ratio at which the first one goes.
   * Brittle rods have a few shallow surface layers, then the crack runs through.
   */
  layers: number;
  layerDepth: number;
  layerStart: number;
  /** Threshold of the deepest layer: above 1, fibre bridging toughens the crack as it grows (an R-curve). */
  layerEnd: number;
  /** Fibrous: cracks arrest between layers and the rod hinges; brittle: past the skin the crack runs. */
  fibrous: boolean;
  /** A cracked node's bending stiffness falls as (1 − D)^soften: 3 for an open crack, less with bridging fibres. */
  soften: number;
  /** Mechanical quality factor (bending modes), for the rod's own ring-down and its sound. */
  Q: number;
  /** Table bounce restitution and friction. */
  bounce: number;
  friction: number;
  /** Drawing: radius on screen as a multiple of the true one, and colours. */
  drawScale: number;
  base: string;
  edge: string;
  core: string;
  crumb: string;
  /** Pitch of the crack transient (1 = spaghetti). */
  crackPitch: number;
}

export const MATS: Record<MatId, Mat> = {
  spaghetti: {
    id: 'spaghetti',
    label: 'Spaghetti',
    r: 0.7e-3,
    L: 0.24,
    E: 3.8e9,
    mu: 1.5e9,
    rho: 1500,
    kc: 14.3,
    tc: 25.6,
    cov: 0.06,
    layers: 3,
    layerDepth: 0.03,
    layerStart: 0.84,
    fibrous: false,
    layerEnd: 0.985,
    soften: 3,
    Q: 45,
    bounce: 0.35,
    friction: 0.35,
    drawScale: 2.3,
    base: '#f1d27e',
    edge: '#c99a3c',
    core: '#fff1bf',
    crumb: '#f3dc9a',
    crackPitch: 1.25,
  },
  twig: {
    id: 'twig',
    label: 'Twig',
    r: 2.6e-3,
    L: 0.21,
    E: 8e9,
    mu: 0.6e9,
    rho: 600,
    kc: 3.6,
    tc: 9,
    cov: 0.12,
    layers: 7,
    layerDepth: 0.09,
    layerStart: 0.8,
    fibrous: true,
    layerEnd: 1.25,
    soften: 1.5,
    Q: 22,
    bounce: 0.3,
    friction: 0.5,
    drawScale: 1.1,
    base: '#8a6845',
    edge: '#4f3a26',
    core: '#b18e66',
    crumb: '#6d5236',
    crackPitch: 0.7,
  },
  chopstick: {
    id: 'chopstick',
    label: 'Chopstick',
    r: 2.4e-3,
    L: 0.21,
    E: 1.5e10,
    mu: 1.0e9,
    rho: 700,
    kc: 5.4,
    tc: 12,
    cov: 0.08,
    layers: 10,
    layerDepth: 0.075,
    layerStart: 0.78,
    fibrous: true,
    layerEnd: 1.6,
    soften: 1,
    Q: 70,
    bounce: 0.4,
    friction: 0.4,
    drawScale: 1.1,
    base: '#e2c796',
    edge: '#b08d57',
    core: '#f3e2bd',
    crumb: '#e8d3a8',
    crackPitch: 0.85,
  },
  lead: {
    id: 'lead',
    label: 'Pencil lead',
    r: 1.0e-3,
    L: 0.13,
    E: 1.4e10,
    mu: 5.5e9,
    rho: 1900,
    kc: 6.5,
    tc: 14,
    cov: 0.07,
    layers: 2,
    layerDepth: 0.03,
    layerStart: 0.9,
    fibrous: false,
    layerEnd: 0.985,
    soften: 3,
    Q: 110,
    bounce: 0.45,
    friction: 0.3,
    drawScale: 1.8,
    base: '#4a4d55',
    edge: '#23252b',
    core: '#8c909b',
    crumb: '#3a3c42',
    crackPitch: 1.6,
  },
};

/** Bending stiffness EI (N m²), mass per length (kg/m), and the bending "diffusivity" √(EI/ρA) (m²/s). */
export function derived(m: Mat) {
  const A = Math.PI * m.r * m.r;
  const I = (Math.PI * m.r ** 4) / 4;
  const EI = m.E * I;
  const rhoA = m.rho * A;
  return { A, I, EI, rhoA, cb: Math.sqrt(EI / rhoA), ct: Math.sqrt(m.mu / m.rho) };
}

/**
 * Free-free Euler-Bernoulli bar: βL for the first modes. Frequencies f_n = (β_n L)² / (2π L²) · √(EI/ρA),
 * so a piece half as long rings four times higher.
 */
export const BAR_BL = [4.73004, 7.85321, 10.99561, 14.13717, 17.27876, 20.42035];

/** Free-free mode shape n at fraction u (0..1) along the bar, normalised to 2 at the ends. */
export function barShape(n: number, u: number) {
  const b = BAR_BL[n];
  const s = (Math.cosh(b) - Math.cos(b)) / (Math.sinh(b) - Math.sin(b));
  const x = b * u;
  return Math.cosh(x) + Math.cos(x) - s * (Math.sinh(x) + Math.sin(x));
}
