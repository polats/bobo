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

## 5. The idle layer (opt-in, later phases)

- **Loop:** coins → buy a card → scratch → cash out → upgrade → better cards.
- **Upgrades:** tools (nail → coin → key → scraper), width, luck, blower, card feeder, and an **auto-scratcher**: a visible hand that scratches through the same sim, so idle cards still crumble and click.
- **Hand scratching keeps its own rewards:** "lucky flakes" that only a finger dislodges, streaks for one long stroke, premium cards bots can't handle.
- **Maths:**
  - costs `base · 1.15^n` with ×2 at milestones
  - each card tier pays 0.9–1.2× its price
  - prestige grows with the cube root of lifetime earnings
  - offline time capped at 2–8 h, paid as **a stack of unscratched cards**
- A headless economy simulator (`tools/`) balances the curves before any UI is built.
- **Fair-play rules:** odds and expected value are shown on every card, outcomes are fixed when you buy the card, near-misses pay shards towards a pity reward, and there is no debt.
- **Saving:** versioned JSON in `bobo.scratch.save`.

## 6. Phases

1. **Feel prototype.** Silver coat, flakes, crumbs, blowing, four tools, a classic match-3 card underneath, the full Tune panel. *Gate:* 60 fps on an iPhone 13 mini, and the feel is signed off.
2. **Payoff.** Per-symbol pings, the merge win, auto-finish, coins into the jar.
3. **Card types and coats.** Gold leaf, scratch-art wax curls, holo.
4. **Economy.** Simulator, upgrades as param modifiers, saving, offline card stack.
5. **Automation.** Auto-scratcher, feeder, lucky flakes.
6. **Polish.** Hub preview, README, catalog.

**Budgets (iPhone 13 mini, est.)** CPU sim ≤ 2 ms, GPU ≤ 4 ms. The coat grid is about 260 × 420 cells, uploaded only in dirty rows. Crumbs are capped at 2,500 in a pooled buffer and drawn in one `POINTS` call.
