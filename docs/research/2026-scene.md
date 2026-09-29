# Physics-driven play, 2025 → Sept 2026: what's resonating, and what bobo should build next

*Research date: 2026-09-29. Audience: the bobo team. Companion to `docs/research/physics.md`, `cloth-knitting.md` and `shear-knit.md`. This doc skips game-feel theory (Swink, Hicks et al.), which shear-knit.md §2.4 already covers.*

Markers: **(src)** = figure taken from a linked, fetched page. **(est)** = my estimate. **[unverified]** = plausible, but no source was fetched. I ran out of web-search budget partway through, so some sections (SGF/Gamescom 2026, TikTok trend data) are thinner than planned. Those gaps are flagged.

---

## 1. Summary

1. **The money is in simulated *materials* inside a tight puzzle, not in open sandboxes.** The big mobile hits of 2025–26 are all sort-and-reveal puzzles with a tactile material skin:
   - **Pixel Flow**: conveyor shooters clear pixels to reveal a picture. About $94M IAP (src). Loom Games was bought by Scopely at a $1B+ valuation (src).
   - **Sand Loop** (Voodoo): catch falling coloured sand in buckets to reveal art. $13.9M IAP, 9M downloads (src).
   - **Knit Out** (Rollic) and **Yarn Loop**: yarn and bobbins. Knit Out reached the Sort Puzzle grossing Top 5 (src). Yarn Loop has 2.5M+ downloads (src).
   - **Screwdom**: 3D physics screw puzzle. About $206M in 2025 (src).
   - **Magic Sort**: liquid sort. About $50M (src).

   The same pattern repeats each time: a proven puzzle loop plus a material that is satisfying to watch (sand, wool, liquid, pixels), ending in a **reveal**.
2. **On PC, physics is the fun in two flavours: chaotic co-op and chill "one simple joy" games.**
   - Chaotic co-op: *Peak* sold 10M+ in about two months (src). *R.E.P.O.* peaked at 230k concurrent players (src). *RV There Yet?* sold 4.5M+ (src).
   - Chill single-verb games: *A Game About Digging a Hole* sold 1M and was built in about two weeks (src). *Spilled!* sold 50k in a month (src). *PowerWash Simulator 2* sold about 352k on Steam (est, Gamalytic). The first PowerWash has 17M players (src).
   - Big-budget destruction: *Donkey Kong Bananza* uses voxel terrain destruction and sold 4.52M units (src).
3. **Suika is still the reference drop-and-merge physics game.** It has 11M downloads (src), and its sequel *Suika Game Planet* came out in January 2026 in the US (src). *Ball x Pit* (1M+ in about two months; src) shows that "physics balls plus a meta layer" still breaks out.
4. **Web creative coding moved to three.js + WebGPU + TSL.** On Codrops, the 2025–26 WebGPU pieces are about **dissolve, destruction and reveal**: text that explodes into dust and petals, fluid X-ray reveals, liquid glass. They are not about raw simulation scale. The shareable unit is a single-gesture loop of about 8 seconds.
5. **Gap in bobo:** the toys are strong on material *feel* (tearing, unravelling, goo, burning, smashing). They are weak on the three things the charts reward:
   - a **completion or reveal payoff**, with a visible "% done" and a finished picture;
   - **sorting chaos into order**;
   - a **30-second goal** that can wrap in a light puzzle or meta layer.

   Sound is already on the roadmap. The cheapest high-value moves are to add reveal and completion to toys that exist, and to build toys where cleaning, sorting or revealing *is* the sim.

---

## 2. Trending games table

| Game | Platform / date | What the physics/sim does | Signal (verified unless marked) | Why it resonates |
|---|---|---|---|---|
| **Pixel Flow** (Loom Games) | Mobile, Aug 2025 | Conveyor shooters clear coloured pixel blocks and reveal an image | $94M IAP, 26.4M downloads ([NextBigGames](https://nextbiggames.com/2026/05/30/hybrid-casual-puzzle-trends-2025/)); peak about $550K/day, about 1M DAU, Scopely at $1B+ ([AppSamurai](https://appsamurai.com/blog/pixel-flow-an-analysis-of-its-rapid-rise/), [Gamigion](https://www.gamigion.com/scopely-acquired-majority-stake-in-pixel-flow-maker-loom-games-at-1b-valuation/)); about 1 h/day across about 10 sessions ([Deconstructor of Fun](https://www.deconstructoroffun.com/blog/2026/2/13/pixel-flow-the-publishers-dream)) | Reveal a picture; speed and execution come back into sort puzzles; meme-themed levels make cheap ad creatives ([Gamigion](https://www.gamigion.com/pixel-flow-success-analysis/)) |
| **Sand Loop** (Voodoo) | Mobile, 2025 | Buckets on a conveyor catch falling coloured sand, fill regions and reveal artwork | $13.9M IAP, 9M downloads ([NextBigGames](https://nextbiggames.com/2026/05/30/hybrid-casual-puzzle-trends-2025/)); 4.4★ from 21k ratings, #85 Simulation US ([App Store](https://apps.apple.com/us/app/sand-loop/id6754363534)) | "Physics, collection and visual satisfaction". Under the hood it is closer to a rhythm/timing game ([guide](https://www.sandloop.org/en/blog/sand-loop-mechanics-guide)) |
| **Knit Out** (Rollic) | Mobile, Mar 2025 | Ropes and knots unravel off a board onto matching bobbins | 4.7★ from 36k ratings on iOS ([App Store](https://apps.apple.com/us/app/knit-out/id6740406762)); 1M+ downloads, about 270k in 30 days, 4.48★ from 49k ratings (AppBrain, via search); Sort Puzzle grossing Top 5 ([AppMagic H1 2025](https://appmagic.rocks/research/casual-report-h1-2025), via search snippet) | Wool is a tactile skin over screw/sort mechanics; the unravel and wind-up animations are the reward |
| **Yarn Loop: Knit Puzzle** | Mobile, Nov 2025 | Bobbins collect stitches of their colour from a knitted picture | 2.5M+ downloads, 4.7★ from 70.9k ratings ([MWM](https://mwm.ai/apps/yarn-flow/6755183085)) | Knitted picture gets unmade or filled in; soft and warm, no timer |
| Wool sort wave (Wool Craze, Wool Saga 3D, Wool Sort 3D…) | Mobile, 2025 | Spools of thread sorted and woven into images | App stores filled with "wool / thread / yarn / tangle" titles (AppMagic, via search snippet); Wool Saga 3D has 500k+ installs ([Play](https://play.google.com/store/apps/details?id=wool.thread.saga.triple.match.sort&hl=en_US)) | Thematic re-skin of screw puzzles; moving from hypercasual to hybrid-casual |
| **Screwdom** (iKame) | Mobile | 3D physics screw-and-plank puzzle | About $206M in 2025, 17% D30 retention ([Naavik](https://naavik.co/digest/how-niche-subgenres-are-reshaping-the-mobile-puzzle-market/)) | Planks swing and clatter when you pull a screw; "stuck" states |
| **Magic Sort / Hexa Sort** (sort genre) | Mobile | Liquid and hex-stack sorting | Sort genre about 1B downloads in 2025, about $280M; Magic Sort about $50M ([Naavik](https://naavik.co/digest/how-niche-subgenres-are-reshaping-the-mobile-puzzle-market/)) | "Organizing chaos into order" |
| **Color Block Jam** (Rollic) | Mobile | Block-slide puzzle | About $183M in 2025 ([Naavik](https://naavik.co/digest/how-niche-subgenres-are-reshaping-the-mobile-puzzle-market/)) | Mass-market UA plus simple spatial puzzle |
| Foodie Sizzle / Grill Sort | Mobile | BBQ-themed sort | $8.4M / 22.9M dl and $2.9M / 22M dl ([NextBigGames](https://nextbiggames.com/2026/05/30/hybrid-casual-puzzle-trends-2025/)) | Cooking-ASMR skin on sort |
| **Suika Game** → **Suika Game Planet** | Switch/mobile; Planet JP Dec 2025, US Jan 2026 | Drop fruits; physics stacking; same fruits merge | 11M downloads by Oct 2024 ([Wikipedia](https://en.wikipedia.org/wiki/Suika_Game)) | 10-second rules; physics makes every board different |
| **Ball x Pit** (Kenny Sun / Devolver) | PC/console Oct 2025, mobile Mar 2026 | Arkanoid physics balls plus town-building meta | 1M+ by Dec 2025 ([Wikipedia](https://en.wikipedia.org/wiki/Ball_x_Pit)) | Bouncing ball chaos with a progression loop |
| **PowerWash Simulator 2** (FuturLab) | PC/console, Oct 2025 | Dirt-mask erosion by water jet | 91% of about 11.9k Steam reviews; about 352k Steam copies (est, [Gamalytic](https://gamalytic.com/game/2968420)); PWS1 at 17M players ([VGChartz](https://www.vgchartz.com/article/464291/powerwash-simulator-tops-17-million-players/)); [Wikipedia](https://en.wikipedia.org/wiki/PowerWash_Simulator_2) | Completion %, every pass visibly improves the scene, zero failure |
| **Spilled!** | PC, Mar 2025 | Clean oil and trash from waterways with a boat and hose | 50k sold in a month, driven by social virality ([Wikipedia](https://en.wikipedia.org/wiki/Spilled!)) | One-hour, one-verb cleaning; viral clips |
| **A Game About Digging a Hole** (Cyberwave) | PC Feb 2025, later mobile | Dig terrain, find ores, upgrade shovel | 250k in first week, 1M by Aug 2025, built in about two weeks ([Wikipedia](https://en.wikipedia.org/wiki/A_Game_About_Digging_a_Hole)) | "Taps into a simple joy". Pure dig-reveal-upgrade loop |
| **Peak** (Aggro Crab + Landfall) | PC, Jun 2025 | Stamina and physics climbing, ropes, pitons | 10M+ copies by mid-Aug 2025 ([Wikipedia](https://en.wikipedia.org/wiki/Peak_(video_game))) | Clumsy co-op physics creates shareable fails |
| **R.E.P.O.** | PC EA, Feb 2025 | Physics carrying of fragile valuables | 230k peak CCU ([Wikipedia](https://en.wikipedia.org/wiki/R.E.P.O.)) | "Lethal Company was missing physics": fragility adds tension and comedy |
| **RV There Yet?** (Nuggets Ent.) | PC, Oct 2025 | Chaotic co-op RV driving physics | 4.5M+ by Dec 2025; won Steam Award "Sit Back and Relax" ([Wikipedia](https://en.wikipedia.org/wiki/RV_There_Yet%3F)) | Wobbly vehicle physics as comedy |
| **Donkey Kong Bananza** (Nintendo) | Switch 2, Jul 2025 | Voxel terrain destruction; smash almost any surface | 4.52M units by Mar 2026; MC 91 ([Wikipedia](https://en.wikipedia.org/wiki/Donkey_Kong_Bananza)) | Destruction as traversal and treasure-reveal |
| **Cairn** (The Game Bakers) | PC/PS5, Jan 2026 | Manual limb-by-limb climbing sim | 300k in a week ([Wikipedia](https://en.wikipedia.org/wiki/Cairn_(video_game))) | Physical, tactile, deliberate input |
| **Teardown** multiplayer (Tuxedo Labs) | PC | Voxel destruction synchronised over the network | Dev write-up, Mar 2026 ([Voxagon](https://blog.voxagon.se/2026/03/13/teardown-multiplayer.html)) | Destruction stays evergreen |
| *Tiny Glade* (reference, 2024) | PC; macOS May 2026 | Procedural cozy building | Cozy creation with no unlocks ([Wikipedia](https://en.wikipedia.org/wiki/Tiny_Glade)) | Every gesture makes something pretty |

**Not verified this round:** pottery-wheel mobile games; soap/kinetic-sand cutting ASMR apps; slime simulators; peeling/cutting hypercasuals; TikTok view counts for "oddly satisfying" physics clips. These are well-known genres, but I have no 2025–26 numbers for them. All are **[unverified]**.

### Why the yarn/knit puzzles chart (synthesis)
- **Skin over a proven loop.** Wool Sort is described as screw-puzzle mechanics with spools instead of bolts (AppMagic snippet). Rollic, a hybrid-casual specialist, took the theme into the Top 5.
- **A tactile, cozy material.** Yarn reads as soft, warm and calm ("no timer", "soothing" in store copy). It also skews toward a broad casual, largely female audience [unverified demographic].
- **Reveal and unmake.** The picture is either knitted up or unravelled. Each move produces a visible strand animation, which makes the game **ad-friendly**: an 8-second clip explains the whole game.
- **Monetisation friction points.** Limited bobbin slots create stuck states (App Store reviews complain about coin costs and ads). The satisfaction layer hides a hard-friction economy.
- **What bobo should take from it:** Pull the Thread is already a better *physical* yarn toy than any of these. What it lacks is a **picture to reveal or complete** and **colour-sorted sinks** (bobbins).

---

## 3. Talks and devlogs 2025–2026

**GDC 2026** ([GDC Vault listing](https://gdcvault.com/browse/gdc-26)). Physics and game-feel talks found:
- *Constructive Destruction: Fusing Voxel Tech and 3D Action Platforming in Donkey Kong Bananza*, Kenta Motokura (Nintendo). This is the key destruction talk of the year: voxel destruction used as level design and reveal, not only as spectacle.
- *Learning to Move: Physics-Based Enemy Locomotion in ARC Raiders*, Martin Singh-Blom (Embark).
- *Battlefield 6: Game Feel is the Message*, Jac Carlsson (DICE).
- *Grappling with Success: Smooth Movement on an Indie Budget*, Salaar Kohari (CAGE).
- *Co-Creating Possibility: The Future of Mobile Gaming Performance*, Lukas Medek (Sumo Digital).
- *Developing Large Procedural Systems with Low Friction and Fast Generation*, Chris Murphy (Epic).

**Summer Game Fest / Gamescom 2026:** not verified. The Wikipedia pages were missing and the search budget was used up. Fill this in manually.

**Devlogs and educators:**
- **Sebastian Lague** ([GitHub](https://github.com/SebLague?tab=repositories&sort=updated)). Recent repos: *Fluid-Sim* (updated Oct 2025, 1.3k★), *Smoke-Simulation* (Nov 2025), *Audio-Experiments* (Apr 2026), *Visual-Debug* (Apr 2026), *Rubiks-Cube* (Jun 2026). Audio-Experiments hints at procedural/synth audio work, which fits bobo's sound layer [the video content itself is unverified].
- **Acerola** ([GitHub](https://github.com/GarrettGunnell?tab=repositories&sort=updated)). Repos: *God-Machine*, multiple-neighbourhood cellular automata (Sep 2025), directly relevant to making Alchemy Sandbox more "alive"; *Godot-Terrain* (Jun 2025); *AcerolaFX-Godot* (Sep 2026).
- **Dennis Gustafsson / Teardown.** [*The unlikely story of Teardown Multiplayer*](https://blog.voxagon.se/2026/03/13/teardown-multiplayer.html) (Mar 2026). Destruction is replicated as a deterministic command stream (voxel cuts, joint changes); everything else is state-synced. For bobo this is relevant if "shared/replayable destruction" ever matters: record inputs and commands, not state.
- **Ten Minute Physics** ([index](https://matthias-research.github.io/pages/tenMinutePhysics/index.html)). Latest episodes are #23 sweep-and-prune, #24 BVH and #25 joints (XPBD). Useful for screw/plank joints.
- **Freya Holmér:** no 2025–26 item verified.

**Supercell-relevant mobile trends:**
- **Hybrid-casual is now the default.** You learn the mechanic in about 10 seconds, and the meta layers (collections, events) carry retention ([Azur Games 2026 report](https://azurgames.com/blog/hypercasual-and-hybrid-casual-in-2026-full-report/), [GameGrowthAdvisor](https://gamegrowthadvisor.com/blog/2026-04-16-hybrid-casual-game-design-strategy-2026/)).
- **Installs are falling as short-form video competes for attention, while revenue rises** (Azur). The ad creative, meaning the 8-second satisfying clip, *is* the acquisition channel. Pixel Flow's trend-jacked levels are a creative strategy as much as a design one ([Gamigion](https://www.gamigion.com/pixel-flow-success-analysis/)).
- **Deterministic and skill-based beats random.** Pixel Flow's boards are deterministic and players improve on them ([DoF](https://www.deconstructoroffun.com/blog/2026/2/13/pixel-flow-the-publishers-dream)). For physics toys, this means the *toy* can be chaotic, but a *goal wrapper* should be readable.
- **Physics in playable ads:** screw, sand and wool puzzles are playable-ad staples [unverified; no ad-library data fetched].

---

## 4. Web and creative-coding scene

- **three.js + WebGPU + TSL is the mainstream stack.** The Codrops [WebGPU tag](https://tympanus.net/codrops/tag/webgpu/) runs from Mar 2025 to Sep 2026 and is dominated by TSL pieces:
  - *Interactive Text Destruction* (Jul 2025): per-vertex springs push geometry out from the pointer and it settles back ([article](https://tympanus.net/codrops/2025/07/22/interactive-text-destruction-with-three-js-webgpu-and-tsl/)).
  - *WebGPU Gommage Effect: dissolving MSDF text into dust and petals* (Jan 2026).
  - *Dual-Scene Fluid X-Ray Reveal* (Mar 2026).
  - *Infinite Liquid Glass Grid* (Sep 2026).
  - *Drawing With Light: lit GPU tubes* (Sep 2026).
  - *Still: generative ink-wash garden in WebGPU* (Sep 2026).
  - *Garden Anomaly: a tiny WebGPU experiment* (Aug 2026).
- **Themes:** dissolve, reveal, destruction, liquid glass and growing gardens. These are short, cursor-driven loops.
- **three.js forum showcase** ([Showcase](https://discourse.threejs.org/c/showcase/7)). Current items include *JellyBlob* (wobbly jellies and slime-trail combat), *MyoHeat* (a 186-muscle biomechanics sim), *ALIVE: a night farm* (fully procedural) and *[WebGPU] Hashing Spaces*. Soft, squishy creatures and procedural growth are recurring.
- **Browser simulation at scale is solved enough.** [WebGPU-Ocean](https://github.com/matsuoka-601/WebGPU-Ocean) runs about 100k MLS-MPM particles on integrated GPUs and about 300k on dGPUs (src), and bobo already builds on it. The web scene has moved from "can we simulate X" to "what's the one gesture and the payoff".
- **What's shareable** (synthesis, est):
  - one continuous gesture (drag, hold or swipe);
  - a clear before/after inside about 8 seconds;
  - a material change (solid → dust, dirty → clean, knitted → strand);
  - a tidy loop point, so the clip can repeat seamlessly.

  bobo can't currently export a clip. A "record last 8 s" button in the shell would help every toy.

---

## 5. Resonance patterns and bobo gap analysis

| Pattern | Evidence | bobo toys that hit it | Gap |
|---|---|---|---|
| **One-gesture input** | Suika, Sand Loop taps, Codrops pointer toys | All 12 (drag/tap first) | None. This is a strength |
| **Reveal / completion (% bar, finished picture)** | Pixel Flow, Sand Loop, Yarn Loop, PowerWash, Digging a Hole | Weak: Pull the Thread (sweater gone), Demolition (tower down) | **Big gap.** No toy shows "% done" or ends in a picture or trophy |
| **Order from chaos (sorting)** | Sort genre about 1B downloads; Knit Out, Magic Sort | None | **Big gap** |
| **Cleaning / restoration** | PowerWash 17M players, PWS2, Spilled! | Campfire douse (partial) | **Gap** |
| **Destruction** | DK Bananza, Teardown, Codrops text destruction | Demolition, Tear Sheet, Laundry storm, Alchemy | Covered. Could add *reveal-through-destruction* (geode, DK-style treasure) |
| **Transformation of material** | Codrops dissolve, Alchemy-style games | Campfire (char), Alchemy, Goo, Thread (knit → yarn) | Strong |
| **Collection / progression hook** | Digging a Hole upgrades, Ball x Pit meta, hybrid-casual meta | None | Gap. Even a sticker book of "finds" would do |
| **Cozy creation** | Tiny Glade, knit themes | Ink paint mode, Jelly Stack | Partial. Nothing you *make and keep* |
| **ASMR audio + haptics** | PowerWash hiss, knit/yarn softness | Roadmap (sound + haptics layer) | In progress. Highest-leverage retrofit |
| **Fragile / comedic physics** | R.E.P.O., Peak, RV There Yet? | Jelly Stack fling, Laundry pegs popping | Partial. No "don't break it" tension |
| **Shareable 8-second loop** | Pixel Flow creatives, Spilled! virality | GIF capture tool exists (tools/media) | No in-app clip export |
| **Physics merge / drop** | Suika 11M, Suika Planet | Jelly Stack (drop, no merge) | Easy win: add merge |

**Cheap retrofits** (est; no new toy needed):
- *Pull the Thread*: yarn winds onto colour bobbins, and the sweater gets a pattern picture that unravels by colour.
- *Demolition*: a treasure is hidden in the tower, plus a "% rubble" star rating.
- *Jelly Stack*: same-shape merge (Suika).
- *Campfire*: "keep the fire alive N seconds" or a marshmallow toast meter.
- Shell: an 8-second clip export and a "finds" sticker book shared across toys.

---

## 6. Twelve toy concepts

Phone feasibility is estimated for iPhone 13 mini at 60 fps, based on bobo's existing toys.

Overlap with existing backlogs: *Chocolate Kitchen* and *Soap Bubbles* (physics.md), *Cat & Yarn Ball*, *Scissors*, *Loom* (cloth-knitting.md) and *Shear* (shear-knit.md) are already listed, so they are not repeated here.

### 1. Power Rinse ★
- **Fantasy/hook:** blast a mud-caked Bobo, rubber duck, bike or garden gnome back to sparkling. A "% clean" ring fills and the object does a happy wiggle at 100%.
- **Gesture:** hold and drag to spray. Two fingers widen the fan nozzle.
- **Why:** PowerWash has 17M players and its sequel sold well; *Spilled!* went viral from social clips; the "restoration" before/after clip is ideal ad material.
- **Sim:**
  - A dirt-thickness texture on the object is eroded by jet impact, weighted by the jet's angle to the surface and its distance.
  - Grimy runoff uses Ink Swirl's stable-fluids dye advected down-screen with gravity. Drips are Goo-style particles.
  - Spray is a particle stream with a mist sprite.
  - Hidden layers under the grime (paint colour, stickers, a message) give the reveal.
- **Phone:** high. It's 2D texture ops plus a small fluid grid (est).
- **Effort:** S–M.
- **Reuses:** stable fluids (Ink/Campfire), particle spray, and the sound layer (hiss changes with distance to the surface).

### 2. Sand Jar Reveal ★
- **Fantasy/hook:** pour coloured sand through a funnel into a glass jar or over a stencil. At the end, lift the stencil (or tip out the jar) to reveal the picture, or keep the layered-sand jar.
- **Gesture:** drag the funnel. Tapping a colour swatch switches sand.
- **Why:** Sand Loop earned $13.9M with 9M downloads from falling-sand reveal; Pixel Flow's reveal loop.
- **Sim:** the falling-sand CA from Alchemy Sandbox with only sand-like elements. Add a friction/angle-of-repose parameter so layers slump in pretty strata. The stencil is a cell mask; tilting the phone slides the dunes.
- **Phone:** high. The Alchemy CA already runs (est).
- **Effort:** S.
- **Reuses:** falling-sand CA and its glow renderer. **Goal-mode variant:** a Sand Loop / Pixel Flow-style target picture with a "% match" meter.

### 3. Spool Sort (Unravel onto Bobbins) ★
- **Fantasy/hook:** a knitted picture (a cat, a heart) hangs on the wall. Tap a coloured bobbin and it reels in the matching yarn, unravelling those stitches live. Empty the picture, or rebuild it in reverse.
- **Gesture:** tap a bobbin. Holding speeds up the reel.
- **Why:** Knit Out (Sort Puzzle Top 5), Yarn Loop (2.5M+) and the wool-sort wave. bobo already has a more physical yarn sim than any of them.
- **Sim:** Pull the Thread's stitch grid, now with per-stitch colour. An XPBD yarn strand runs from the picture to a spinning bobbin that winds the strand into a helical build-up. Slot limits (a bobbin rack) give the puzzle wrapper.
- **Phone:** medium–high. One strand is active at a time (est).
- **Effort:** M.
- **Reuses:** knit/yarn and XPBD rope.

### 4. Jelly Merge ★
- **Fantasy/hook:** Suika with gummies. Drop jelly fruits into a jar. Two of the same squish together into a bigger one with a wobbly pop and a sugar burst. Try to reach the giant Bobo gummy.
- **Gesture:** drag to aim, release to drop.
- **Why:** Suika has 11M downloads and its sequel *Suika Game Planet* shipped in 2026; the ten-second rules.
- **Sim:** Jelly Stack's shape-matching bodies. On contact between same-tier bodies, blend both into a larger rest shape over about 150 ms, which gives a satisfying squish-merge. Pressure-based jiggle.
- **Phone:** high. Tens of bodies (est).
- **Effort:** S.
- **Reuses:** shape matching and PBD contacts.

### 5. Dig Down ★
- **Fantasy/hook:** a side-view backyard cross-section. Scoop dirt with a finger-shovel; clods crumble and trickle. Dig up bones, gems and a lost rubber duck, then fill a "finds" shelf. A mole occasionally tunnels past.
- **Gesture:** drag to dig. Long-press drops a small charge.
- **Why:** *A Game About Digging a Hole* (1M copies, built in about two weeks, "a simple joy"); DK Bananza's destruction-as-treasure-reveal.
- **Sim:** falling-sand CA with a **cohesive soil** state. Soil stays put until undercut, then collapses as sand. Buried objects are CA stamps that pop out as rigid bodies (Demolition solver) when exposed. Depth strata change colour and sound.
- **Phone:** high (est).
- **Effort:** S–M.
- **Reuses:** falling-sand CA and rigid bodies.

### 6. Liquid Sort (real fluid)
- **Fantasy/hook:** the "water sort" puzzle with real liquid. Tip glass tubes to pour layered coloured liquids into each other. They slosh, and oil-like layers stay separate. Finish with each tube a single colour.
- **Gesture:** drag a tube over another and tilt with the drag angle. Phone tilt sloshes everything.
- **Why:** the sort genre had about 1B downloads and about $280M in 2025, and Magic Sort earned about $50M; "organizing chaos into order". No competitor has real fluid.
- **Sim:** 2D MLS-MPM (Goo Lab) with immiscible phases (a density per phase). Or cheaper: a per-tube 1D layer stack for logic, with MPM only for the pour stream and slosh visuals.
- **Phone:** medium on WebGPU; the layer-stack fake is high (est).
- **Effort:** M.
- **Reuses:** MLS-MPM and Splash Tank tilt input.

### 7. Screw Loose
- **Fantasy/hook:** a board of wooden planks held by brass screws. Unscrew one and planks swing on the rest, clack into each other, and tumble into a bin. Clear the board.
- **Gesture:** tap and twist (a circular drag unscrews, with haptic ticks).
- **Why:** Screwdom made about $206M in 2025 with strong D30; the wool-sort genre grew out of screw puzzles.
- **Sim:** Demolition's 2D rigid bodies plus revolute joints (TMP #25 XPBD joints). Planks are compound boxes with a wood-knock modal audio sound.
- **Phone:** high (est).
- **Effort:** S.
- **Reuses:** rigid bodies. It's a good test bed for the audio layer's modal clicks.

### 8. Geode Crack
- **Fantasy/hook:** a lumpy grey rock. Tap with a hammer to chip it; chips fly and dust puffs. Crack it right and it splits to reveal glowing crystals (procedural), which go into a collection.
- **Gesture:** tap. Holding charges a bigger hit.
- **Why:** DK Bananza voxel destruction; the dig-reveal loop; "oddly satisfying" rock-cutting clips [unverified].
- **Sim:** a 2D voxel/cell rock (CA cells with a hardness field). Chips become Demolition rigid fragments or sand grains. The crystal interior is rendered with a refraction/sparkle shader (reuse Ferro chrome shading ideas).
- **Phone:** high (est).
- **Effort:** S–M.
- **Reuses:** falling-sand CA and rigid bodies.

### 9. Pottery Wheel
- **Fantasy/hook:** a lump of wet clay spins. Press in to open it, pull up to raise walls, pinch to thin. Too thin and it wobbles and collapses. Glaze it, fire it, and keep it on a shelf.
- **Gesture:** hold and drag, vertical and inward.
- **Why:** cozy crafting (Tiny Glade's "every gesture makes something pretty"); pottery-wheel ASMR clips [unverified]; knit-style tactile craft.
- **Sim:** an axisymmetric profile (radius and wall thickness per height ring) with volume conservation. Pushing in moves clay up; spring smoothing plus wobble noise gives an instability when the wall is thin. Collapse swaps to a shape-matching soft body. Wet sheen shader; throwing hum.
- **Phone:** high (est).
- **Effort:** M.
- **Reuses:** shape matching for collapse. The profile sim is new but small.

### 10. Peel It
- **Fantasy/hook:** peel the protective film off a new phone, a sticker off a sheet, a banana, or tape off a fresh paint line. The film stretches, bubbles, and snaps free to reveal a glossy surface.
- **Gesture:** grab a corner and drag.
- **Why:** reveal plus ASMR ("peel" satisfaction clips [unverified]); the same before/after hook as PowerWash, in one gesture.
- **Sim:** an XPBD cloth sheet with **adhesion constraints** to the surface that break past a peel-force threshold, like Laundry Line's pegs. A curl bias toward the peel direction, a stretch shader (whitening), and air-bubble particles under the film.
- **Phone:** high. A 40×60 sheet (est).
- **Effort:** S–M.
- **Reuses:** XPBD cloth and pin-breaking.

### 11. Don't Drop the Cake
- **Fantasy/hook:** carry a wobbly tiered jelly cake, a tray of teacups or a stack of plates across a bumpy kitchen. It sways, things slide, and a "value" meter drops on every clink. Or just enjoy the wobble.
- **Gesture:** drag the tray. Tilting the phone tips it.
- **Why:** R.E.P.O.'s fragile-valuables tension (230k peak CCU); Peak and RV There Yet? comedic wobble physics.
- **Sim:** rigid bodies (cups, plates) and shape-matching jelly tiers on a kinematic tray driven by finger acceleration. Breaking cups shatter via Demolition fracture.
- **Phone:** high (est).
- **Effort:** S–M.
- **Reuses:** rigid bodies and shape matching.

### 12. Slice Slime / Kinetic Sand Cutter
- **Fantasy/hook:** a block of kinetic sand, soap or slime. Slice it with a knife swipe; slices lean, fall and crumble. Squish the crumbs back into a block.
- **Gesture:** swipe to slice. Press to squish.
- **Why:** kinetic sand and soap cutting are staple "oddly satisfying" and ASMR content [unverified numbers]; material transformation; Codrops' dissolve and destruction aesthetic.
- **Sim:** Goo Lab's 2D MLS-MPM with a Drucker-Prager sand material plus cohesion (kinetic sand) or elastoplastic (soap). A slice is a plane that zeroes particle–grid coupling across the cut for a few frames. Crunchy granular audio.
- **Phone:** medium on WebGPU with 20–40k particles (est).
- **Effort:** M.
- **Reuses:** MLS-MPM.

### Summary grid

| # | Toy | Pattern | Reuses | Phone (est) | Effort |
|---|---|---|---|---|---|
| 1 | Power Rinse | Cleaning, reveal, % | Stable fluids | High | S–M |
| 2 | Sand Jar Reveal | Reveal, cozy creation | Sand CA | High | S |
| 3 | Spool Sort | Sort, reveal, knit trend | Knit/yarn, XPBD | Med–high | M |
| 4 | Jelly Merge | Merge/drop | Shape matching | High | S |
| 5 | Dig Down | Dig, reveal, collection | Sand CA, rigid | High | S–M |
| 6 | Liquid Sort | Sort | MLS-MPM | Med / High (fake) | M |
| 7 | Screw Loose | Screw puzzle, clatter | Rigid + joints | High | S |
| 8 | Geode Crack | Destruction reveal, collection | CA, rigid | High | S–M |
| 9 | Pottery Wheel | Cozy creation | Shape matching (+ new) | High | M |
| 10 | Peel It | Reveal, ASMR | XPBD cloth | High | S–M |
| 11 | Don't Drop the Cake | Fragile/comedy | Rigid, shape matching | High | S–M |
| 12 | Slice Slime | Transformation, ASMR | MLS-MPM | Med | M |

**Suggested order:**
1. **Jelly Merge**, then **Sand Jar Reveal**. Both are S effort and give immediate reveal and merge proof points.
2. **Power Rinse**, then **Dig Down**. These are the strongest trend fits.
3. **Spool Sort**. It pairs with the knit roadmap and the sound layer.

Ship the "% done / reveal" shell widget and the 8-second clip export alongside the first of these.

---

## 7. References (all fetched or seen in search results)

**Mobile market**
- NextBigGames, 10 Hybrid Casual Puzzle Trends: https://nextbiggames.com/2026/05/30/hybrid-casual-puzzle-trends-2025/
- Naavik, niche puzzle subgenres: https://naavik.co/digest/how-niche-subgenres-are-reshaping-the-mobile-puzzle-market/
- Azur Games, Hypercasual & hybrid casual in 2026: https://azurgames.com/blog/hypercasual-and-hybrid-casual-in-2026-full-report/
- GameGrowthAdvisor, hybrid casual 2026 (search result): https://gamegrowthadvisor.com/blog/2026-04-16-hybrid-casual-game-design-strategy-2026/
- AppMagic Casual Report H1 2025 (search snippet only): https://appmagic.rocks/research/casual-report-h1-2025
- Deconstructor of Fun, Pixel Flow: https://www.deconstructoroffun.com/blog/2026/2/13/pixel-flow-the-publishers-dream
- Gamigion, Pixel Flow analysis: https://www.gamigion.com/pixel-flow-success-analysis/ · Scopely deal: https://www.gamigion.com/scopely-acquired-majority-stake-in-pixel-flow-maker-loom-games-at-1b-valuation/
- AppSamurai, Pixel Flow (search result): https://appsamurai.com/blog/pixel-flow-an-analysis-of-its-rapid-rise/
- Sand Loop App Store: https://apps.apple.com/us/app/sand-loop/id6754363534 · mechanics guide: https://www.sandloop.org/en/blog/sand-loop-mechanics-guide
- Knit Out App Store: https://apps.apple.com/us/app/knit-out/id6740406762 · AppBrain (search result): https://www.appbrain.com/app/knit-out/com.sbg.knitout
- Yarn Loop (MWM): https://mwm.ai/apps/yarn-flow/6755183085
- Wool Saga 3D (Play, search result): https://play.google.com/store/apps/details?id=wool.thread.saga.triple.match.sort&hl=en_US

**PC/console games**
- Suika Game: https://en.wikipedia.org/wiki/Suika_Game
- Ball x Pit: https://en.wikipedia.org/wiki/Ball_x_Pit
- PowerWash Simulator 2: https://en.wikipedia.org/wiki/PowerWash_Simulator_2 · Gamalytic (search result): https://gamalytic.com/game/2968420 · PWS 17M players: https://www.vgchartz.com/article/464291/powerwash-simulator-tops-17-million-players/
- Spilled!: https://en.wikipedia.org/wiki/Spilled!
- A Game About Digging a Hole: https://en.wikipedia.org/wiki/A_Game_About_Digging_a_Hole
- Peak: https://en.wikipedia.org/wiki/Peak_(video_game)
- R.E.P.O.: https://en.wikipedia.org/wiki/R.E.P.O.
- RV There Yet?: https://en.wikipedia.org/wiki/RV_There_Yet%3F
- Donkey Kong Bananza: https://en.wikipedia.org/wiki/Donkey_Kong_Bananza
- Cairn: https://en.wikipedia.org/wiki/Cairn_(video_game)
- Tiny Glade: https://en.wikipedia.org/wiki/Tiny_Glade

**Talks and devlogs**
- GDC 2026 Vault: https://gdcvault.com/browse/gdc-26
- Voxagon, Teardown Multiplayer: https://blog.voxagon.se/2026/03/13/teardown-multiplayer.html
- Sebastian Lague repos: https://github.com/SebLague?tab=repositories&sort=updated
- Acerola repos: https://github.com/GarrettGunnell?tab=repositories&sort=updated
- Ten Minute Physics: https://matthias-research.github.io/pages/tenMinutePhysics/index.html

**Web and creative coding**
- Codrops WebGPU tag: https://tympanus.net/codrops/tag/webgpu/
- Codrops, Interactive Text Destruction: https://tympanus.net/codrops/2025/07/22/interactive-text-destruction-with-three-js-webgpu-and-tsl/
- three.js forum Showcase: https://discourse.threejs.org/c/showcase/7
- WebGPU-Ocean: https://github.com/matsuoka-601/WebGPU-Ocean
