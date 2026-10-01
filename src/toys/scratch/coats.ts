// Coat materials. Each is a different physical coat, not a reskin: its flake sim settings, how it
// looks, how it sounds and buzzes, and what its crumbs do. Choosing a coat writes its values into the
// toy's settings (the Tune panel then edits that coat live); later, upgrades layer on top.

export type CoatId = 'silver' | 'crackle' | 'latex' | 'holo';

export interface CoatDef {
  id: CoatId;
  label: string;
  /** Shader look: 0 silver latex, 1 crackle lacquer, 2 rubbery latex, 3 holographic grating. */
  mode: number;
  colour: [number, number, number];
  /** Values for the toy's settings object. */
  set: Record<string, number>;
  /** Scrape resonance and grit multipliers, crumple stiffness, haptic sharpness. */
  pitch: number;
  rate: number;
  stiffness: number;
  sharp: number;
  /** Chance a pop also rings like glass (crackle's shards). */
  glassy: number;
}

export const COATS: Record<CoatId, CoatDef> = {
  // Latex and aluminium pigment over a release varnish: brittle flakes and dusty crumbs.
  silver: {
    id: 'silver',
    label: 'Silver',
    mode: 0,
    colour: [0.78, 0.79, 0.82],
    set: {
      flakeSize: 4.5, flakeSpread: 0.55, strength: 1, adhesionNoise: 0.6, brittleness: 0.35, abrasionResist: 1, speedGain: 0.4,
      crackReach: 0.2, chainDepth: 6, smear: 0,
      perFlake: 1.2, friction: 9, curls: 0.45,
      sheen: 1, streak: 0.8, glitter: 1, lip: 3, lift: 0.7,
    },
    pitch: 1,
    rate: 1,
    stiffness: 0.5,
    sharp: 1,
    glassy: 0,
  },
  // A hard lacquer crazed all over: big plates, cracks that race ahead into untouched coat, clumps
  // that shatter off as glassy shards. It hardly scuffs at all.
  crackle: {
    id: 'crackle',
    label: 'Crackle',
    mode: 1,
    colour: [0.1, 0.12, 0.2],
    set: {
      flakeSize: 8, flakeSpread: 0.75, strength: 0.8, adhesionNoise: 0.35, brittleness: 0.45, abrasionResist: 4, speedGain: 0.7,
      crackReach: 0.05, chainDepth: 2, smear: 0,
      perFlake: 2.2, friction: 7, curls: 0,
      sheen: 1.6, streak: 0, glitter: 0.6, lip: 4.5, lift: 1.1,
    },
    pitch: 1.5,
    rate: 0.7,
    stiffness: 1,
    sharp: 1.2,
    glassy: 0.35,
  },
  // Cheap, rubbery latex: it barely pops, it wears and smears ahead of the edge, and rolls into grey
  // eraser crumbs.
  latex: {
    id: 'latex',
    label: 'Budget latex',
    mode: 2,
    colour: [0.55, 0.56, 0.58],
    set: {
      flakeSize: 3, flakeSpread: 0.3, strength: 2.6, adhesionNoise: 0.4, brittleness: 0, abrasionResist: 0.55, speedGain: 0.1,
      crackReach: 0.2, chainDepth: 0, smear: 0.45,
      perFlake: 0.6, friction: 18, curls: 1,
      sheen: 0.15, streak: 0, glitter: 0, lip: 4, lift: 0.4,
    },
    pitch: 0.45,
    rate: 1.8,
    stiffness: 0.15,
    sharp: 0.35,
    glassy: 0,
  },
  // A thin foil embossed with a diffraction grating: scratches clean, and every scrap of it splits the
  // lamp into a spectrum that shifts as the light moves.
  holo: {
    id: 'holo',
    label: 'Holo',
    mode: 3,
    colour: [0.82, 0.84, 0.88],
    set: {
      flakeSize: 3.5, flakeSpread: 0.4, strength: 0.8, adhesionNoise: 0.4, brittleness: 0.2, abrasionResist: 1.6, speedGain: 0.4,
      crackReach: 0.2, chainDepth: 4, smear: 0,
      perFlake: 1, friction: 9, curls: 0.6,
      sheen: 1.2, streak: 0.4, glitter: 1.4, lip: 2, lift: 0.6,
    },
    pitch: 1.35,
    rate: 1.1,
    stiffness: 0.75,
    sharp: 1.1,
    glassy: 0,
  },
};

export const COAT_IDS = Object.keys(COATS) as CoatId[];
