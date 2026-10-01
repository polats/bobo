# Scratch Off: build spec

*2026-10-01. A scratch-card toy with an opt-in idle game on top. This is the first bobo toy with an economy, so it follows [game-design.md](game-design.md): the scratching has to satisfy with the economy turned off, and every upgrade has to change how the scratching feels.*

## 1. Why it isn't just a mask reveal

The audit marks down "rub a mask until the secret appears" (Power Rinse, Invisible Ink, Fingerprint Dust, Mow Lines). In those toys a brush lowers a number per pixel. A real scratch-off coat works differently: it is a rubbery latex binder with metallic pigment, laid over a release varnish, and it has nothing holding it together as a sheet ([US8627536B1](https://patents.google.com/patent/US8627536B1/en)). It comes away in **separate flakes**: a coin gets under them and pops them off, a fingernail scuffs and leaves islands behind. The toy simulates that:

- **Flakes, not pixels.** The coat is baked into jittered, noise-warped Voronoi flakes. Each flake has its own adhesion, from fbm noise, so some patches resist. The tool loads each flake in proportion to the share of the flake it covers, times its speed and hardness. Once a flake's damage passes its strength, the whole flake breaks off. Stroke edges come out jagged and chip-shaped, never a smooth circle.
- **Brittleness spreads cracks.** A flake that breaks off adds damage to its neighbours, so a brittle coat comes away in clumps with a crackle, and a tough coat comes off one chip at a time.
- **Abrasion is a second path.** Every tool also wears the coat thinner directly: a soft nail mostly does this, a hard coin mostly pops flakes. Thin coat shows grey residue speckle that a second pass cleans off.
- **Crumbs are real.** Each flake that breaks off becomes a crumb particle in the coat's sheen. The tool pushes crumbs ahead of it, so they pile up at the end of a stroke and hide the print until you blow them away (mic or two fingers) or sweep them off the edge.
- **The coat has thickness.** The shader lights the coat's height field, so every scratch has a bright lip and a shadow, and the intact foil carries a moving brushed-metal highlight.

**Sound and haptics come from the fracture events.**
- Each flake that breaks off plays a `sound.crumple` click sized by the flake (the impact-stream model of scraping, [arXiv 2112.08984](https://arxiv.org/abs/2112.08984)).
- A `sound.slip` bed follows contact pressure and speed, and its resonance changes per tool. On bare paper it switches to a soft hiss.
- `hapticLevel` follows the fracture rate, with sharpness set by the tool.

## 2. Tools (an upgrade path that changes the feel)

| Tool | Contact | Feel |
|---|---|---|
| Nail | small round, soft | mostly abrades; patchy, leaves islands, quiet |
| Coin | a flat edge across the stroke | pops flakes cleanly; bright clicky grit |
| Key | narrow and hard | gouges thin lines; great for chasing a symbol |
| Scraper | wide flat blade | clears whole bands; deep scrape |

## 3. Theme

Cards are a **night-market ticket counter**: a warm lamp over a worn counter, tickets in many designs. Each card *type* plays differently, and later card types bring **new coat materials**, each with its own physics:

| Coat | Physics | Reveal |
|---|---|---|
| Silver latex | brittle flakes and crumbs (phase 1) | classic prize grid |
| Gold leaf | very thin, tears into fluttering leaf that breath lifts | big-prize cards |
| Scratch-art wax | ductile: the tool ploughs **curling shavings** whose curl radius follows cut depth and speed (orthogonal cutting chip curl) | rainbow line art you draw into |
| Holo foil | thin-film interference sheen (Bubble Wand's colour code) | rare cards |

The win moment borrows Jelly Merge's escalation: matching symbols fly together and merge, with a combo pitch ladder and a brief freeze on contact (hit-stop). Winnings pour as **coins into a jar** (Hourglass's frictional disks clinking with `impact('tin')`). The jar is your bank, and it should be satisfying to look at.

## 4. Tunable parameters

One `ScratchParams` object holds everything, and every field is a Tune slider. An upgrade is a modifier on these params, so feel and economy share one set of knobs.

- **Coat:** flake size, flake spread, strength, adhesion noise, brittleness, abrasion resistance
- **Tool:** radius, flatness (round to edge), hardness, speed gain
- **Crumbs:** crumbs per flake, push, friction, blow strength
- **Feel:** grit gain, scrape gain, haptic gain
- **Reveal:** symbol threshold, auto-finish %
- **Look:** sheen, streaks, glitter, lip height

## 5. The idle layer: upgrades change the scratch

The meta exists to change the scratching. Currency only pays for upgrades. Every upgrade is a new tool, coat or behaviour that you can see, hear or feel under your finger.

**How it works.** The effective settings are layered: the Tune base, then the card's coat, then the owned upgrades. An upgrade is data: the settings it changes, plus any behaviour flags it switches on.
- The Tune panel has a **meta off** switch, so the raw scratch can be judged (the audit rule).
- Each upgrade has its own A/B toggle, so you can feel the difference while scratching.
- **Rule:** an upgrade that only changes a number is not allowed.
- Free mode keeps every tool and coat. Idle mode is opt-in and starts you at the bottom of each track.

| Track | Early → late | What changes in the scratch |
|---|---|---|
| **Tool** | nail → penny → quarter → key → scraper → sander | Contact shape, hardness and edge; the visible tool, the scrape pitch and the sharpness of the buzz. Sub-upgrades: **milled edge** (coarser grit, more cracking), **sharpened** (cleaner pops, fewer worn patches). |
| **Technique** | heavy hand → flick → steady hand | Bite from pressure or from holding still, bite from speed, clean edges on long strokes. |
| **Coat** (comes with better cards) | sticky budget latex → standard silver → crackle coat → gold leaf → scratch-art wax → holo | Better cards are more satisfying to scratch: budget latex smears and resists, crackle coat shatters off in clumps, wax ploughs into curls. |
| **Crumbs** | none → cling → sweep → collect | Crumbs build up on the tool's edge and drop off in clumps; a brush stroke sweeps them; crumbs swept off the card edge pay a **silver dust bonus** on top of the card's prize (not a separate currency for now). |
| **Streaks** | off → combo → crit flakes | Long strokes chain pops into a streak with a rising pitch ladder; **lucky flakes** (gold, hidden in the coat) pop only for a hand. These keep hand play worth more than automation. |
| **Automation** | none → zigzag → spiral → smart | A visible hand drags a coin through the same sim, and its path gets better as it's upgraded. Premium coats and lucky flakes still want your finger. |

**The coin jar.** The merge win and coin jar are parked on the `scratch-jar` branch. They return as the bank, the place your coins visibly go.

**Maths and fair play** (for the economy step):
- costs `base · 1.15^n` with ×2 at milestones
- each card tier pays 0.9–1.2× its price
- prestige grows with the cube root of lifetime earnings
- offline time capped at 2–8 h, paid as **a stack of unscratched cards**
- odds and expected value are shown on every card, outcomes are fixed when you buy the card, near-misses pay shards, and there is no debt
- a headless simulator in `tools/` balances the curves against how strong each upgrade feels
- saving is versioned JSON in `bobo.scratch.save`

## 6. Phases

1. **Feel prototype** (done). Silver coat, flakes, crumbs, blowing, four tools, a match-3 card, the full Tune panel. 60 fps on an iPhone 13 mini.
2. **Scratch feel** (now). A visible tool held at the stroke's angle; flakes that lift and curl before they pop; crumbs that roll into curls; pressure, contact size or holding still biting deeper. Each piece is a setting from the start, so upgrades can change it. Soak and tune on both phones.
3. **Coats** (moved ahead of the upgrade layer: the biggest change you can see and feel, and the content upgrades need). *First pass built* (`coats.ts`): each coat bundles its sim settings, look, sound and crumb behaviour; each card design has its own, and Tune's Material choice puts any coat on any card.
   - **Silver:** the phase 1 coat.
   - **Crackle:** a dark lacquer crazed with pale lines; big plates, cracks that run a couple of flakes into untouched coat, straight-edged shards, glassy ticks (`impact('glass')`).
   - **Budget latex:** matte rubber that barely pops; it wears and smears ahead of the edge into grey smudges and ridges, rolls into eraser curls, squeaks low and buzzes soft.
   - **Holo:** a foil embossed with concentric grating rings; colour from the grating equation (first and second orders, CIE observer) that sweeps round as the lamp moves; rainbow crumbs.
   - **Next:** gold leaf (tearing, fluttering leaf), then scratch-art wax (a continuous curling shaving ribbon).
4. **Upgrade layer.** The base → coat → upgrades stack, meta off, A/B toggles, and the Tool and Technique tracks.
5. **Crumbs and streaks.** Cling, sweep, the silver dust bonus, the combo ladder, lucky flakes.
6. **Economy.** Prices, the balancing simulator, saving, the offline card stack, the jar as the bank.
7. **Automation.** The robot hand.

**Budgets (iPhone 13 mini, est.)** CPU sim ≤ 2 ms, GPU ≤ 4 ms. The coat grid is about 260 × 420 cells, uploaded only in dirty rows. Crumbs are capped at 2,600 in a pooled buffer and drawn in one `POINTS` call.
