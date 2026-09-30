// The glass: bowl shapes, the wall profile, and the (n,0) bending-mode frequencies from French's
// energy-method model of a wineglass (Am. J. Phys. 1983), in the form Terwagne & Bush quote:
//   f(2,0) empty = 1/2π · √(3Y / 5ρg) · a/R² · √(1 + 4/3 (R/H)⁴)
//   (f0 / fh)²   = 1 + (α/5) · (ρl R / ρg a) · (h/H)⁴,  α ≈ 1.25
// The water adds kinetic energy to the wall's motion without adding stiffness, so we model it as
// extra modal mass M(h) = M0 (f0/fh)², which is what lowers the note.

export type ShapeId = 'wine' | 'tulip' | 'balloon';

export interface ShapeDef {
  label: string;
  /** Rim radius, bowl height and wall thickness at size 1, metres. */
  R: number;
  H: number;
  a: number;
  /** Profile: radius fraction w(t) at height fraction t (0 bottom of the bowl, 1 rim). */
  pow: number;
  bulge: number;
  stem: number;
}

export const SHAPES: Record<ShapeId, ShapeDef> = {
  wine: { label: 'Wine', R: 0.04, H: 0.09, a: 0.0012, pow: 0.42, bulge: 0.2, stem: 0.085 },
  tulip: { label: 'Tulip', R: 0.033, H: 0.1, a: 0.0011, pow: 0.55, bulge: 0.14, stem: 0.095 },
  balloon: { label: 'Balloon', R: 0.047, H: 0.085, a: 0.0014, pow: 0.36, bulge: 0.34, stem: 0.07 },
};

const Y_GLASS = 7e10; // Young's modulus of soda-lime glass, Pa
const RHO_GLASS = 2500;
const RHO_WATER = 1000;
const ALPHA = 1.25;
/** Tensile strain at which a real (flawed) glass wall fails: ~70 MPa / 70 GPa. */
export const STRAIN_LIMIT = 1e-3;

export interface Glass {
  shape: ShapeId;
  def: ShapeDef;
  size: number;
  R: number;
  H: number;
  a: number;
  /** Empty (2,0) frequency, Hz, and the (3,0) ratio. */
  f0: number;
  r3: number;
  /** Modal mass of the empty (2,0) mode, kg (radial rim amplitude as the coordinate). */
  M0: number;
  /** Fractional split of each degenerate doublet (no real glass is perfectly round). */
  split: number;
  /** Radial rim amplitude at which the wall reaches the strain limit, metres. */
  breakAmp: number;
}

export function makeGlass(shape: ShapeId, size: number): Glass {
  const def = SHAPES[shape];
  const R = def.R * size, H = def.H * size, a = def.a;
  const f0 = (1 / (2 * Math.PI)) * Math.sqrt((3 * Y_GLASS) / (5 * RHO_GLASS)) * (a / (R * R)) * Math.sqrt(1 + (4 / 3) * (R / H) ** 4);
  // General (n,0) law from the same model: f ∝ (n² − 1) / √(1 + 1/n²).
  const fn = (n: number) => (n * n - 1) / Math.sqrt(1 + 1 / (n * n));
  // Kinetic energy of the wall, radial + tangential (u_t = u_r / n), weighted toward the rim where
  // the bowl moves most (mode shape ~ (z/H)², so ∫(z/H)⁴ dz = H/5).
  const M0 = RHO_GLASS * a * R * Math.PI * (H / 5) * (1 + 1 / 4);
  // Bending strain at the antinode: ε = (a/2) · (n² − 1) u / R².
  const breakAmp = (2 * R * R * STRAIN_LIMIT) / (3 * a);
  return { shape, def, size, R, H, a, f0, r3: fn(3) / fn(2), M0, split: 0.0008 + Math.random() * 0.0022, breakAmp };
}

/** French's liquid loading: f(h) / f0 for water filled to fraction `fill` of the bowl height. */
export function waterRatio(g: Glass, fill: number) {
  const k = (ALPHA / 5) * ((RHO_WATER * g.R) / (RHO_GLASS * g.a)) * fill ** 4;
  return 1 / Math.sqrt(1 + k);
}

/** Wall radius fraction at height fraction t (0 = bottom of the bowl, 1 = rim). */
export function profile(def: ShapeDef, t: number) {
  const c = Math.max(0, Math.min(1, t));
  return Math.pow(c, def.pow) * (1 + def.bulge * Math.sin(Math.PI * c));
}

/** Strain at the antinode for radial rim amplitude u (m). */
export function strain(g: Glass, u: number) {
  return (g.a * 3 * u) / (2 * g.R * g.R);
}
