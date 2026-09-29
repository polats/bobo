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
  marble: { added: '2026-09-29T18:00:00+02:00', category: 'Make & reveal' },
  merge: { added: '2026-09-29T18:00:00+02:00', category: 'Soft & squishy' },
  rinse: { added: '2026-09-29T18:00:00+02:00', category: 'Make & reveal' },
  sandjar: { added: '2026-09-29T18:00:00+02:00', category: 'Make & reveal' },
  spool: { added: '2026-09-29T11:40:34-04:00', category: 'Cloth & yarn' },
};

export function meta(id: string): { added: Date; category: Category } {
  const e = CATALOG[id];
  return { added: e ? new Date(e.added) : new Date(), category: e?.category ?? 'Make & reveal' };
}

/** "New" means the latest batch: anything that landed within a day and a half of the newest toy. */
export function newCutoff(ids: string[]) {
  const latest = Math.max(...ids.map((id) => meta(id).added.getTime()));
  return latest - 36 * 3600e3;
}
