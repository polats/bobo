// Line icons for the hub, drawn on a 24×24 grid with round caps; `currentColor` strokes.

const svg = (body: string) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;

const ICONS: Record<string, string> = {
  // Ink Swirl: a spiral of ink.
  ink: svg('<path d="M12 12c0-1.1.9-2 2-2s2 .9 2 2.2c0 2.2-1.9 3.8-4 3.8-2.8 0-5-2.3-5-5.2C7 7.6 9.7 5 13 5c3.9 0 7 3.2 7 7.2C20 16.5 16.4 20 12 20c-4.9 0-8.5-3.8-8.5-8.6"/>'),
  // Goo Lab: a wobbly jelly blob with a highlight.
  goo: svg('<path d="M5 17.5c-1.6-3.3-.6-8 2.4-10.3 2.9-2.3 7-2.2 9.6.4 2.8 2.8 3 7.3.7 10-1.3 1.5-3.2 2.2-5.4 2.2H8.1c-1.3 0-2.5-.7-3.1-2.3Z"/><path d="M9 9.5c.6-.8 1.5-1.3 2.5-1.4"/><path d="M4 20.5h16"/>'),
  // Alchemy Sandbox: a flask with bubbles.
  sand: svg('<path d="M9.5 3.5h5"/><path d="M10.5 3.5v5.2L5.4 17.6A2 2 0 0 0 7.1 20.5h9.8a2 2 0 0 0 1.7-2.9l-5.1-8.9V3.5"/><path d="M7.5 14.5h9"/><circle cx="11" cy="17.3" r=".6" fill="currentColor"/><circle cx="13.8" cy="16.3" r=".6" fill="currentColor"/>'),
  // Ripple Pool: a rubber duck on ripples.
  pool: svg('<path d="M7.5 12.5c-1.9 0-3-1.4-3-3 0-1.9 1.5-3.5 3.5-3.5s3.5 1.6 3.5 3.5c0 .6-.1 1.1-.4 1.6H15c2.1 0 3.4-1.1 4-2.6.6 1.1 1 2.3 1 3.5 0 2.8-2.7 4-6.5 4h-2C8.5 16 7 14.5 7.5 12.5Z"/><path d="M4.5 9.2 3 9.8"/><path d="M3 20c1.5 0 1.5-1 3-1s1.5 1 3 1 1.5-1 3-1 1.5 1 3 1 1.5-1 3-1 1.5 1 3 1"/>'),
  // Splash Tank: a glass tank with a sloshing wave.
  splash: svg('<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M4 13c2-1.6 3.8-1.6 5.5 0s3.6 1.6 5.4 0 3.5-1.5 5.1-.3"/><path d="M8 7.5v2"/><path d="M11.5 6v1.5"/>'),
  // Tear Sheet: scissors.
  cloth: svg('<circle cx="6.5" cy="17" r="2.5"/><circle cx="17.5" cy="17" r="2.5"/><path d="M8.3 15.3 18 4"/><path d="M15.7 15.3 6 4"/>'),
  // Laundry Line: a t-shirt.
  laundry: svg('<path d="M9 4 4.5 6.5 3 11l3 1 .5-1.5V20h11v-9.5L18 12l3-1-1.5-4.5L15 4c-.4 1.4-1.6 2.2-3 2.2S9.4 5.4 9 4Z"/>'),
  // Pull the Thread: a ball of yarn with a loose end.
  thread: svg('<circle cx="11" cy="11" r="7"/><path d="M5.3 8.2c3.6-1.3 8-.7 11.3 1.8"/><path d="M4.1 11.6c4-1.4 9-.7 12.6 2.2"/><path d="M6.2 15.8c3-1.3 6.6-1 9.6.7"/><path d="M16.9 14.6c1.2 2 2.2 4.1 4.1 5.4"/>'),
  // Campfire: a flame over crossed logs.
  fire: svg('<path d="M12 3c.6 2.6 3.8 4.4 3.8 8.1A3.8 3.8 0 0 1 12 15a3.8 3.8 0 0 1-3.8-3.9c0-1.7.9-2.8 1.8-3.8.2 1.2.8 2 1.6 2.3C11.2 7.8 11.4 5 12 3Z"/><path d="m4.5 20.5 15-3"/><path d="m4.5 17.5 15 3"/>'),
  // Jelly Stack: two stacked wobbly blocks.
  jelly: svg('<path d="M6.5 20.5h11c.8 0 1.5-.7 1.5-1.5v-3.2c0-.9-.7-1.6-1.6-1.6-1 0-1.3-.7-2.4-.7s-1.4.7-2.5.7-1.4-.7-2.5-.7-1.4.7-2.4.7c-.9 0-1.6.7-1.6 1.6V19c0 .8.7 1.5 1.5 1.5Z"/><path d="M8.5 12.5V9c0-.8.6-1.4 1.4-1.4h4.2c.8 0 1.4.6 1.4 1.4v3.5"/><path d="M10.2 5.2c.6-.9 1.3-1.4 1.8-1.4s1.2.5 1.8 1.4"/>'),
  // Demolition Tower: a wrecking ball swinging at a brick stack.
  demolition: svg('<path d="M3 3.5h8"/><path d="M5 3.5 12 12"/><circle cx="13.5" cy="13.5" r="2.5"/><rect x="16" y="15" width="5" height="3" rx=".5"/><rect x="16" y="18" width="5" height="2.5" rx=".5"/><rect x="18" y="12" width="3" height="3" rx=".5"/>'),
  // Ferro Blob: spikes rising toward a magnet.
  ferro: svg('<path d="M3.5 19.5c2.5-1 3-5.5 4-5.5s1.2 4 2.5 4 1.4-7 2-7 .8 7 2 7 1.5-4 2.5-4 1.5 4.5 4 5.5"/><path d="M3 20.5h18"/><path d="M8 4v3a4 4 0 0 0 8 0V4"/><path d="M8 4h2.5v3"/><path d="M16 4h-2.5v3"/>'),
  // Marbling Tray: a comb dragged through feathered swirls.
  marble: svg('<path d="M3 15c3-4 5 4 8 0s5-4 10 0"/><path d="M3 19c3-3 5 3 8 0s5-3 10 0"/><path d="M6 3v8"/><path d="M10 3v8"/><path d="M14 3v8"/><path d="M18 3v8"/><path d="M5 3h14"/>'),
  // Jelly Merge: two gummies squishing into one.
  merge: svg('<circle cx="7.5" cy="14.5" r="3.5"/><circle cx="16.5" cy="14.5" r="3.5"/><path d="M12 10.5V4"/><path d="m9.5 6.5 2.5-2.5 2.5 2.5"/><path d="M5 21h14"/>'),
  // Power Rinse: a spray nozzle with droplets.
  rinse: svg('<path d="M3 17h6l2-3h4"/><path d="M9 17v3"/><path d="M15 14l2-1"/><path d="m18 9 3-2"/><path d="m18 12 3.5 0"/><path d="m18 15 3 2"/><path d="M4 13h5"/>'),
  // Sand Jar: a jar with layered sand.
  sandjar: svg('<path d="M8 3h8"/><path d="M9 3v3c-2 1-3 2.5-3 5v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-8c0-2.5-1-4-3-5V3"/><path d="M6 14c2-1 4 1 6 0s4-1 6 0"/><path d="M6 18c2-1 4 1 6 0s4-1 6 0"/>'),
};

const FALLBACK = svg('<circle cx="12" cy="12" r="7"/><path d="M12 8v4l2.5 2.5"/>');

export function toyIcon(id: string) {
  return ICONS[id] ?? FALLBACK;
}
