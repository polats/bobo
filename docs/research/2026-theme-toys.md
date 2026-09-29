# bobo theme toys: next picks and build specs

*2026-09-29. A follow-up to [2026-wave3.md](2026-wave3.md). Where the earlier docs chose toys from trend × tech, this pass adds a third input: which game **themes** are rising, from ai-asylum's `theme-fit` study. Written for the bobo agent to build from. It does not replace wave 3 (Knockdown, Peel It, Pour Sort, Mow Lines), which is in progress; build these after it, or alongside if the team says so.*

**Markers.** **(est)** is an estimate, not measured. **(src)** points at a file in `theme-fit` where the number is computed.

**Short answer.** Build **Foundry** first, then **Invisible Ink**, then **Kintsugi**. **Fingerprint Dust** is the alternate. All four run on WebGL2 or Canvas, reuse existing bobo code, end in a payoff, and make the theme *be* the physics.

---

## 1. Why these

- **Themes rising in several sources.** theme-fit checked themes across Wikipedia attention, Google Trends, YouTube, IGDB and Steam releases, Twitch and Roblox. Historical, dark fantasy, post-apocalyptic and psychological horror are rising and games are following; political thriller, crime drama, espionage and supernatural horror are rising with few games yet. (src: `theme-fit/site/data/discovery.json`, "Opportunity matrix")
- **The theme has to be the physics.** A blind review of bobo toys reskinned with themes found grafted themes read as forced: a pressure-washer uncovering political evidence made immediate sense to one evaluator in three. The same theme as its own physics (heating a secret letter over a candle) made immediate sense to all three. (src: `theme-fit/docs/concepts.md`, `theme-fit/docs/bobo-theme-physics.md`)
- **Blind review of eleven new toy ideas.** Each was read cold as a one-line store hook by three independent evaluators. Foundry was the only one all three found clear, fresh and worth a tap. The evaluators are language models reading text, not players: treat this as a ranking of what to prototype.

| Toy | Makes sense | Fresh | Would tap | Scored on the bobo rubric |
|---|---|---|---|:-:|
| Foundry | 3 of 3 | 3 of 3 | 3 of 3 | 21 |
| Invisible Ink | 3 of 3 | 2 of 3 | 2 of 3 | 20 |
| Kintsugi | 2 of 3 | 3 of 3 | 2 of 3 | 20 |
| Fingerprint Dust | 2 of 3 | 1 of 3 | 2 of 3 | 21 |

Not picked, and why: **Ghost Sheet** (sheet over invisible ghosts; novel, but only 1 of 3 found the hook clear from text; worth revisiting if the ad opens on the sheet settling over a ghost), **Siege** (Knockdown rethemed; all three called it tired), **Lockpick** and **Rust & Salvage** (clear but familiar), **Blight** (read as tower defence).

---

## 2. Common rules

Same as wave 3:

- Call `ctx.progress(fraction, label)` from the first frame, and `ctx.celebrate(msg)` exactly once per piece finished.
- Haptics go through `ctx.haptic('light' | 'medium' | 'heavy')`. Tie every buzz to a visible event.
- Sound goes through `ctx.sound.play(voice, { pitch, gain, pan })` and the loops (`hiss`, `rumble`, `trickle`, `crackle`, `bubble`) every frame. Voices available: pop, plop, squish, boing, thud, knock, tick, snap, rip, splash, whoosh, crumble, sizzle, chime.
- Budgets for the iPhone 13 mini at 60 fps (est): CPU physics ≤ 4 ms, GPU ≤ 6 ms, zero allocations per frame.
- WebGL2 or Canvas only, so each toy can also ship as a 15-second playable ad (ad webviews have no WebGPU).
- **Show the payoff inside the first eight seconds of any run**, because the clip is also the ad. The review's weakest hooks were the ones that described a reveal instead of showing it.
- Add each toy to `src/shell/catalog.ts` when it ships; all four sit on the **Make & reveal** shelf.

---

## 3. Picks and build specs

### 3.1 Foundry ★ (`src/toys/foundry`)

**Hook.** Pour glowing molten bronze into a sand mould, let it cool, smash the mould open to reveal your bell or blade, then ring it to hear how well you cast it.

**Theme.** Historical and dark fantasy (a bell for a keep, a blade for a knight).

**Loop.**
1. A sand mould with a cavity (bell, blade, bowl, crest) sits in a flask. Pack loose spots with taps if needed.
2. Hold to tilt the crucible and pour. Metal flows down the sprue and fills the cavity; overflow and gaps are visible.
3. The metal cools from white to orange to dark bronze (colour from temperature).
4. Swipe or tap to break the mould: sand crumbles away and the casting drops out.
5. Tap the casting to ring it. The `chime` pitch and clarity come from fill quality: voids and cold shuts dull the note.
6. The casting goes on a shelf; the next mould is harder (thin walls, a long sprue).

**Built on.**
- Mould and crumble: `src/toys/dig/sim.ts` (`DigSim` cell types and cohesion, LOOSE flag) or `src/toys/sandjar/sim.ts` for the sand; a new METAL cell with temperature.
- Pour: falling-cell liquid in the same CA, with viscosity rising as it cools (stop flowing below a set temperature).
- Glow: the heat-to-colour ramp and glow pass from Campfire (`src/toys/fire`).
- Break-out: `crumble` voice and debris; optionally hand large chunks to `src/toys/demolition/physics.ts` (`World`, breakable bodies) for the smash.

**Juice.** `sizzle` loop while pouring, `trickle` for flow, `crumble` on the break-out, `chime` for the ring (pitch from quality), heavy haptic when the casting drops out. `ctx.progress(fill, 'filled')` during the pour, `ctx.celebrate('Rang true!')` on a clean cast.

**Budget (est).** Canvas 2D CA at the Dig Down grid size: ≤ 3 ms CPU. Effort M.

**Done when.** A full pour → cool → break → ring cycle takes under 20 s; a bad pour audibly rings worse than a good one; one mould is clear to a first-time player without text.

### 3.2 Invisible Ink ★ (`src/toys/ink-letter`)

**Hook.** Hold a secret letter over a candle to bring out the hidden message, but pull it away before the paper browns, chars and catches fire.

**Theme.** Political thriller, espionage.

**Loop.**
1. A letter lies over a candle. Drag it to move it over the flame.
2. A hidden message (text or a sketch map) darkens into view where the paper is warm.
3. Too long in one spot and the paper browns, then chars, then catches: the message is lost where it burns.
4. Reveal enough of the message (`ctx.progress(revealed, 'revealed')`) without burning past a limit, and the letter is decoded.
5. Letters get harder: bigger sheets, draughts that bend the flame, two inks that develop at different heats.

**Built on.**
- Heat and char: `Burn` in `src/toys/fire/burn.ts` already tracks per-cell `heat` and `char` on a grid. Run it over a paper-sized grid with the flame as a moving heat source.
- Reveal: a hidden-message mask (text rendered to a texture) developed by accumulated heat, the way Power Rinse (`src/toys/rinse`) reveals under a mask and reports a fraction.
- Flame: Campfire's flame and oxygen look for the candle.

**Juice.** `crackle` loop rising with char, `sizzle` at the edge of burning, `whoosh` when paper catches, `chime` on decode. Light haptic ticks as words appear.

**Budget (est).** One small heat grid plus a mask: ≤ 2 ms. Effort S (the cheapest pick, and the best first proof that a theme-native toy works).

**Done when.** The message visibly appears in the first five seconds; burning is readable before it happens (browning); a careful player can decode a letter with no char.

### 3.3 Kintsugi ★ (`src/toys/kintsugi`)

**Hook.** Drop a porcelain bowl, piece the shards back together, and run molten gold along every crack to make it more beautiful than before.

**Theme.** Historical.

**Loop.**
1. Tap to drop a bowl; it breaks into 4 to 9 shards.
2. Drag shards back into place; each snaps when close to its fit (a magnetic assist).
3. Pour gold along the seams; it runs along the crack lines and fills them.
4. The finished bowl, gold veins and all, goes on a shelf. Later pieces break into more, smaller shards.

**Built on.**
- Break: `src/toys/demolition/physics.ts` breakable bodies and fracture pieces (`breakable`, `breakSpeed`, fresh pieces not re-breaking) for the drop; then freeze pieces as draggable rigid shards.
- Snap: a joint or position constraint to the shard's home pose when within a threshold.
- Gold: a 1D flow along the crack polyline (fill fraction per segment, speed from slope and a viscosity slider), drawn with a glinty gold shader. The thin-film drip work in [2026-tech.md](2026-tech.md) (Dripping Thin Films) is the upgrade path if the 1D version feels flat.

**Juice.** `snap` and `knock` on the break, `tick` when a shard seats, `trickle` loop while gold flows, `chime` when the last seam fills. `ctx.progress(seamsFilled, 'mended')`.

**Budget (est).** A few rigid bodies and seam polylines: ≤ 2 ms. Effort M (fracture patterns and a good gold look are the work).

**Done when.** Seating a shard feels like a click; gold visibly races along a crack; the finished bowl is worth keeping (screenshot-worthy).

### 3.4 Fingerprint Dust (alternate) (`src/toys/prints`)

**Hook.** Brush powder over a crime scene until hidden fingerprints bloom, blow away the excess, and lift each print with tape to match the suspect.

**Theme.** Crime drama, espionage.

**Built on.** Powder as falling-sand grains (`src/toys/sand`, `src/toys/sandjar`) with a hidden adhesion mask (fingerprint ridges) where grains stick; blow to clear loose grains; lift with tape using Peel It's peel (`src/toys/peel`, in progress). `ctx.progress(printRevealed, 'lifted')`.

**Juice.** `whoosh` on blowing, soft `tick`s as grains land, `rip` on the tape lift, `chime` on a match.

**Effort.** S. Clear and tappable in review, but the most familiar of the four.

---

## 4. Build order

1. **Invisible Ink** first if you want the quickest proof, since it is mostly Campfire's `Burn`; otherwise **Foundry** first as the strongest.
2. **Foundry.**
3. **Kintsugi.**
4. **Fingerprint Dust** once Peel It has shipped, since it reuses the tape peel.

After each: soak on device (`node mobile/android-soak.mjs <toy> 30`), capture the hub preview with `tools/media`, and record an 8-second clip. The clip is what the theme-fit ad test would run.

---

## Sources

- theme-fit study (ai-asylum/theme-fit, local): `docs/bobo-theme-physics.md` (candidates, rubric, blind review), `docs/concepts.md` (the grafted-theme review), `site/data/discovery.json` (themes and matrix), `model/raw/physics_review/2026-09-29/` (verbatim evaluator answers).
- bobo research this builds on: [2026-directions.md](2026-directions.md), [2026-scene.md](2026-scene.md), [2026-tech.md](2026-tech.md), [2026-wave3.md](2026-wave3.md).
