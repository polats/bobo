// Hub metadata that isn't the toy's business: when each toy landed and which shelf it sits on.
// Add a line here when a toy ships; toys missing from the table show as brand new.

export type Category = 'Fluids' | 'Soft & squishy' | 'Cloth & yarn' | 'Sand & powder' | 'Smash & build' | 'Make & reveal';

export const CATEGORIES: Category[] = ['Fluids', 'Soft & squishy', 'Cloth & yarn', 'Sand & powder', 'Smash & build', 'Make & reveal'];

interface Entry {
  added: string; // ISO timestamp of the commit that shipped the toy
  category: Category;
}

const CATALOG: Record<string, Entry> = {
  ink: { added: '2026-09-23T13:45:25+02:00', category: 'Fluids' },
  goo: { added: '2026-09-23T14:16:19+02:00', category: 'Soft & squishy' },
  pool: { added: '2026-09-23T14:36:31+02:00', category: 'Fluids' },
  sand: { added: '2026-09-23T14:41:32+02:00', category: 'Sand & powder' },
  cloth: { added: '2026-09-23T15:17:44+02:00', category: 'Cloth & yarn' },
  splash: { added: '2026-09-23T15:32:01+02:00', category: 'Fluids' },
  laundry: { added: '2026-09-23T15:45:26+02:00', category: 'Cloth & yarn' },
  thread: { added: '2026-09-23T15:51:56+02:00', category: 'Cloth & yarn' },
  fire: { added: '2026-09-24T12:39:24+02:00', category: 'Fluids' },
  demolition: { added: '2026-09-24T12:49:33+02:00', category: 'Smash & build' },
  ferro: { added: '2026-09-24T12:50:23+02:00', category: 'Fluids' },
  jelly: { added: '2026-09-24T12:55:17+02:00', category: 'Soft & squishy' },
  marble: { added: '2026-09-29T10:18:46-04:00', category: 'Make & reveal' },
  merge: { added: '2026-09-29T10:18:47-04:00', category: 'Soft & squishy' },
  rinse: { added: '2026-09-29T10:23:12-04:00', category: 'Make & reveal' },
  sandjar: { added: '2026-09-29T10:21:38-04:00', category: 'Make & reveal' },
  bubble: { added: '2026-09-29T20:28:32-04:00', category: 'Fluids' },
  chladni: { added: '2026-09-29T20:02:47-04:00', category: 'Make & reveal' },
  glass: { added: '2026-09-29T20:02:47-04:00', category: 'Make & reveal' },
  frost: { added: '2026-09-29T20:02:47-04:00', category: 'Make & reveal' },
  foundry: { added: '2026-09-29T17:44:12-04:00', category: 'Make & reveal' },
  'ink-letter': { added: '2026-09-29T17:44:12-04:00', category: 'Make & reveal' },
  kintsugi: { added: '2026-09-29T17:44:12-04:00', category: 'Make & reveal' },
  prints: { added: '2026-09-29T17:44:12-04:00', category: 'Make & reveal' },
  knockdown: { added: '2026-09-29T17:06:55-04:00', category: 'Smash & build' },
  peel: { added: '2026-09-29T17:06:55-04:00', category: 'Make & reveal' },
  pour: { added: '2026-09-29T17:06:55-04:00', category: 'Fluids' },
  mow: { added: '2026-09-29T17:06:55-04:00', category: 'Make & reveal' },
  dig: { added: '2026-09-29T12:08:03-04:00', category: 'Sand & powder' },
  spool: { added: '2026-09-29T11:46:37-04:00', category: 'Cloth & yarn' },
};

export interface Update {
  date: string;
  note: string;
  /** Small or across-the-board changes: listed on the toy's sheet but don't flag it as updated. */
  minor?: boolean;
}

const FEEL: Update = { date: '2026-09-29T17:58:04-04:00', note: 'Continuous haptics: a buzz in your hand that follows the action (Core Haptics on iPhone).', minor: true };

const RINGS: Update = { date: '2026-09-29T18:46:29-04:00', note: 'Sound from the simulation: struck things ring with their own material and size; splashes and drops trap bubbles that ring at their own pitch.', minor: true };

const SOUND: Update = { date: '2026-09-29T11:46:37-04:00', note: 'Sound: procedural effects that follow the physics, with a mute toggle.', minor: true };

/** What changed since each toy shipped, newest first. Add a line when a toy gets a notable update. */
const UPDATES: Record<string, Update[]> = {
  merge: [
    { date: '2026-09-29T11:35:29-04:00', note: 'Sound: squishes and pops that climb a semitone with every combo.' },
    { date: '2026-09-29T11:21:46-04:00', note: 'Merges smoosh together and pop: hit-stop, a stretched spring-back, a shockwave that jolts the pile.' },
    { date: '2026-09-29T11:09:10-04:00', note: 'Fixed gummies getting stuck inside each other and flying off.' },
  ],
  spool: [
    { date: '2026-09-29T18:46:29-04:00', note: 'Real yarn tension: each colour is its own strand; floats caught behind other colours drag the knit until they slip free with a snap.' },
    { date: '2026-09-29T11:57:26-04:00', note: 'The rack never jams: spools now bring colours you can reach.', minor: true },
  ],
  dig: [{ date: '2026-09-29T18:54:53-04:00', note: 'Ground that loses its support breaks free as rigid slabs that fall, tumble and shatter; boulders drop and roll, finds can be buried again.' }],
  foundry: [{ date: '2026-09-29T18:46:29-04:00', note: 'Rings from its own shape: seams and voids, and where you tap, change the note. Metal now rises into bottom-fed moulds.' }],
  fire: [{ date: '2026-09-29T19:12:12-04:00', note: 'Blow into the mic (tap the mic button) and your breath feeds the fire: it brightens and roars.' }, { date: '2026-09-29T12:34:05-04:00', note: 'Oxygen: drop a glass jar over the fire to choke it to embers, lift it for a whoosh of flame. Blowing feeds the fire air.' }, SOUND],
  demolition: [
    { date: '2026-09-29T12:36:24-04:00', note: 'The wrecking ball now knocks sleeping towers apart, rubble stops rolling, and tall stacks stand still.' },
    SOUND,
  ],
  prints: [{ date: '2026-09-29T19:12:12-04:00', note: 'Blow into the mic to clear the loose powder off the print.' }],
  goo: [{ date: '2026-09-29T12:34:05-04:00', note: 'Snow and sand glitter: each grain catches the light as it tumbles (toggle in Tune).' }, SOUND],
};

/** Toys whose sound now comes from the resonator pool. */
const RINGING = ['knockdown', 'demolition', 'kintsugi', 'pour', 'splash', 'pool', 'peel'];

/** Toys that drive ctx.hapticLevel. */
const FELT = ['rinse', 'mow', 'peel', 'pour', 'spool', 'dig', 'foundry', 'cloth'];

/** A toy's updates, newest first (the shared sound and haptics passes included). */
export function updates(id: string): Update[] {
  const own = [...(RINGING.includes(id) ? [RINGS] : []), ...(FELT.includes(id) ? [FEEL] : []), ...(UPDATES[id] ?? [])];
  return own.includes(SOUND) || ['merge', 'spool', 'dig', 'knockdown', 'peel', 'pour', 'mow', 'foundry', 'ink-letter', 'kintsugi', 'prints', 'chladni', 'glass', 'frost', 'bubble'].includes(id) ? own : [...own, SOUND];
}

/** Latest notable update, if any. */
export function lastUpdate(id: string): Update | undefined {
  return updates(id).find((u) => !u.minor);
}

export function meta(id: string): { added: Date; category: Category } {
  const e = CATALOG[id];
  return { added: e ? new Date(e.added) : new Date(), category: e?.category ?? 'Make & reveal' };
}

/** "New" means the latest batch: anything that landed within a day and a half of the newest toy. */
export function newCutoff(ids: string[]) {
  const latest = Math.max(...ids.map((id) => meta(id).added.getTime()));
  return latest - 36 * 3600e3;
}
