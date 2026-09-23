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
};

const FALLBACK = svg('<circle cx="12" cy="12" r="7"/><path d="M12 8v4l2.5 2.5"/>');

export function toyIcon(id: string) {
  return ICONS[id] ?? FALLBACK;
}
