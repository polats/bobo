// Coat materials. Each is a different physical coat, not a reskin: its flake sim settings, how it
// looks, how it sounds and buzzes, and what its crumbs do. Choosing a coat writes its values into the
// toy's settings (the Tune panel then edits that coat live); later, upgrades layer on top.

export type CoatId = 'silver' | 'crackle' | 'latex' | 'holo' | 'gold' | 'wax';

export interface CoatDef {
  id: CoatId;
  label: string;
  /** Shader look: 0 silver latex, 1 crackle lacquer, 2 rubbery latex, 3 holographic grating, 4 gold leaf, 5 scratch-art wax. */
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
  /** A second, tacky layer under the top skin, with its own colour and sound (set `layers: 2`). */
  base?: { colour: [number, number, number]; pitch: number; rate: number; sharp: number };
}

/** Settings for coats without a base layer (the base sliders still need values). */
const NO_BASE = { layers: 1, basePasses: 3, baseFlakeSize: 2.5, baseStrength: 1, baseSmear: 0.2, restick: 0 };

export const COATS: Record<CoatId, CoatDef> = {
  // Latex and aluminium pigment over a release varnish: brittle flakes and dusty crumbs.
  silver: {
    id: 'silver',
    label: 'Silver',
    mode: 0,
    colour: [0.78, 0.79, 0.82],
    set: {
      flakeSize: 4.5, flakeSpread: 0.55, strength: 1, adhesionNoise: 0.6, brittleness: 0.35, abrasionResist: 1, speedGain: 0.4,
      crackReach: 0.2, chainDepth: 6, smear: 0, passes: 0, cut: 0, ...NO_BASE,
      perFlake: 1.2, friction: 9, curls: 0.45, flutter: 0,
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
      crackReach: 0.05, chainDepth: 2, smear: 0, passes: 0, cut: 0, ...NO_BASE,
      perFlake: 2.2, friction: 7, curls: 0, flutter: 0,
      sheen: 1.6, streak: 0, glitter: 0.6, lip: 4.5, lift: 1.1,
    },
    pitch: 1.5,
    rate: 0.7,
    stiffness: 1,
    sharp: 1.2,
    glassy: 0.35,
  },
  // Cheap latex in two layers: a thin grey skin that scuffs and smears off, over a tacky gum that
  // takes one bite per pass (each pass greys and sinks it) and lets go on the second: three strokes in all.
  latex: {
    id: 'latex',
    label: 'Budget latex',
    mode: 2,
    colour: [0.55, 0.56, 0.58],
    set: {
      flakeSize: 3, flakeSpread: 0.3, strength: 1.6, adhesionNoise: 0.4, brittleness: 0, abrasionResist: 0.55, speedGain: 0.1,
      crackReach: 0.2, chainDepth: 0, smear: 0.45, passes: 0, cut: 0,
      layers: 2, basePasses: 2, baseFlakeSize: 2.5, baseStrength: 1, baseSmear: 0.25, restick: 2.5,
      perFlake: 0.6, friction: 18, curls: 1, flutter: 0,
      sheen: 0.15, streak: 0, glitter: 0, lip: 4, lift: 0.4,
    },
    pitch: 0.45,
    rate: 1.8,
    stiffness: 0.15,
    sharp: 0.35,
    glassy: 0,
    base: { colour: [0.62, 0.56, 0.46], pitch: 0.3, rate: 2.4, sharp: 0.2 },
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
      crackReach: 0.2, chainDepth: 4, smear: 0, passes: 0, cut: 0, ...NO_BASE,
      perFlake: 1, friction: 9, curls: 0.6, flutter: 0,
      sheen: 1.2, streak: 0.4, glitter: 1.4, lip: 2, lift: 0.6,
    },
    pitch: 1.35,
    rate: 1.1,
    stiffness: 0.75,
    sharp: 1.1,
    glassy: 0,
  },
  // Gold leaf: metal beaten thinner than paper, laid in overlapping squares. It has almost no strength,
  // tears raggedly at the edge, and its flecks are so light they flutter, flip and catch the lamp, and a
  // breath sends them flying.
  gold: {
    id: 'gold',
    label: 'Gold leaf',
    mode: 4,
    colour: [1, 0.78, 0.36],
    set: {
      flakeSize: 6, flakeSpread: 0.9, strength: 0.45, adhesionNoise: 0.5, brittleness: 0.5, abrasionResist: 0.45, speedGain: 0.3,
      crackReach: 0.1, chainDepth: 2, smear: 0, passes: 0, cut: 0, ...NO_BASE,
      perFlake: 1.6, friction: 5, curls: 0, flutter: 1,
      sheen: 1.4, streak: 0, glitter: 1.2, lip: 0.8, lift: 1.6,
    },
    pitch: 1.7,
    rate: 1.5,
    stiffness: 0.95,
    sharp: 0.5,
    glassy: 0,
  },
  // Scratch-art wax: black wax over a rainbow. It's ductile, so the edge cuts a clean groove and the
  // wax comes off as one continuous shaving that curls into a coil (see shavings.ts). No crumbs.
  wax: {
    id: 'wax',
    label: 'Scratch-art wax',
    mode: 5,
    colour: [0.06, 0.06, 0.07],
    set: {
      flakeSize: 3, flakeSpread: 0.3, strength: 50, adhesionNoise: 0, brittleness: 0, abrasionResist: 1, speedGain: 0,
      crackReach: 0.2, chainDepth: 0, smear: 0, passes: 0, cut: 1, ...NO_BASE,
      perFlake: 0, friction: 9, curls: 0, flutter: 0,
      sheen: 1, streak: 0, glitter: 0, lip: 2.5, lift: 0,
    },
    pitch: 0.6,
    rate: 1,
    stiffness: 0.3,
    sharp: 0.25,
    glassy: 0,
  },
};

export const COAT_IDS = Object.keys(COATS) as CoatId[];
