// The four pourables. Viscosities are room-temperature ballparks (Pa·s); the optics are
// Beer-Lambert absorption per millimetre (r, g, b) plus a diffuse scatter for the cloudy ones.

export type LiquidId = 'honey' | 'syrup' | 'choc' | 'milk';

export interface Liquid {
  id: LiquidId;
  label: string;
  /** Short name for the dock chip. */
  chip: string;
  /** Dynamic viscosity, Pa·s. */
  mu: number;
  /** Density, kg/m³. */
  rho: number;
  /** Absorption per mm of path (r, g, b). */
  absorb: [number, number, number];
  /** Colour light picks up when it scatters inside (cloudy liquids). */
  scatter: [number, number, number];
  /** 0 = clear (honey), 1 = opaque and milky. */
  cloud: number;
  /** How readily it soaks into bread, per second. */
  soak: number;
}

export const LIQUIDS: Record<LiquidId, Liquid> = {
  honey: { id: 'honey', label: 'Honey', chip: 'Honey', mu: 10, rho: 1420, absorb: [0.04, 0.17, 0.62], scatter: [0.95, 0.6, 0.14], cloud: 0.04, soak: 0.05 },
  syrup: { id: 'syrup', label: 'Golden syrup', chip: 'Syrup', mu: 40, rho: 1430, absorb: [0.025, 0.1, 0.42], scatter: [0.98, 0.74, 0.28], cloud: 0.02, soak: 0.03 },
  choc: { id: 'choc', label: 'Chocolate sauce', chip: 'Choc', mu: 6, rho: 1300, absorb: [2.2, 3.2, 4.2], scatter: [0.28, 0.12, 0.05], cloud: 0.85, soak: 0.02 },
  milk: { id: 'milk', label: 'Condensed milk', chip: 'Milk', mu: 4, rho: 1300, absorb: [0.3, 0.36, 0.6], scatter: [0.97, 0.92, 0.78], cloud: 0.9, soak: 0.08 },
};
