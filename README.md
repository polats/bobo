# bobo

![bobo — what's new: Knockdown, Peel It, Pour Sort, Foundry, Invisible Ink, Kintsugi, Mow Lines and Fingerprint Dust](docs/media/bobo-latest.gif)

A physics sandbox of 33 small toys built on novel, satisfying, performant simulations (liquid, particles, cloth, yarn, soft bodies, sand, dirt, molten metal, paper and film, soap films, frost, plasma, vibrating plates and glasses), tuned for juicy visuals and sound. It runs in the browser and as an iOS and Android app.

## Toys

![All the toys](docs/media/bobo-cover.gif)

Grouped by the hub's shelves.

| Toy | What it is | Tech |
|---|---|---|
| **Ink Swirl** | Finger-paint glowing fluid; tap to burst, flick to swirl. *Paint* mode mixes colours like real pigment. | Stable Fluids on WebGL2 (`src/toys/ink`) |
| **Ripple Pool** | Poke a sunlit pool, watch caustics dance, grab and fling rubber ducks, make it rain. | Height-field waves + mesh caustics on WebGL2 (`src/toys/pool`) |
| **Splash Tank** | A glass tank of 3D water: tilt the phone (or drag) to slosh it, poke it, drop beach balls, make a big splash. | 3D MLS-MPM + screen-space fluid rendering on WebGPU (`src/toys/splash`) |
| **Campfire** | Stack logs, strike a match, blow on the embers; fire climbs the wood, chars it, and hisses when doused. An oxygen field feeds it: drop a glass jar over the flames and they choke to embers, then lift it for a whoosh of flame. | Stable-fluids fire (heat, smoke, buoyancy) + CPU burning and oxygen cells on WebGL2 (`src/toys/fire`) |
| **Ferro Blob** | Drag a magnet under a dish of black ferrofluid: it crawls after you and bristles with spikes; two fingers split it, taps drop droplets. | Double-density particle liquid + Rosensweig spike lattice + chrome shading on WebGL2 (`src/toys/ferro`) |
| **Pour Sort** | Liquid sort with real pouring: tap a tube, tap another, and a cohesive stream pours across. Liquids have densities, so oil floats up through syrup after a pour. Every level is solver-checked; undo any time. | Layer-stack logic + Clavet double-density particle stream on WebGL2 (`src/toys/pour`) |
| **Bubble Wand** | Dip the wand and a soap film forms; it drains into rainbow bands, swirls under your finger, grows black spots and pops. Blow (into the mic, or hold the button): softly for one big bubble, hard for a stream of small ones. | 2D film thickness field with drainage, Plateau-border suction and Culick rupture (after Ishida et al. 2020), exact thin-film interference colour, WebGL2 (`src/toys/bubble`) |
| **Goo Lab** | Pour water, jelly, snow and sand that all interact; poke and squish them. Snow and sand glitter as grains tumble. | 2D MLS-MPM on WebGPU compute, per-grain glints (`src/toys/goo`) |
| **Jelly Stack** | Tap to drop gummy cubes, stars, hearts and a smiling Bobo; stack them, grab and fling, slap the tower over. | Shape-matching soft bodies + PBD contacts on WebGL2 (`src/toys/jelly`) |
| **Jelly Merge** | Suika with gummies: drop jelly fruit into a jar; matching sizes smoosh together and pop into a bigger one (hit-stop, shockwave, combo pitch), all the way to a giant Bobo. | Jelly Stack's shape matching + merge rules on WebGL2 (`src/toys/merge`) |
| **Chladni Plate** | Tap a metal plate, bow its edge, or sing to it: the sand dances off the parts that move and gathers on the nodal lines of whichever modes are sounding. Hold a finger on a line to keep that figure. | Free-plate modes by the Ritz method (Gander & Kwok), one mode state driving sand, sound and haptics, WebGL2 (`src/toys/chladni`) |
| **Singing Glass** | Wet your finger and circle the rim until the glass locks into a tone; add water to lower it. Sing its note and it resonates until it shatters. | Stick-slip fingertip coupled to the glass's bending modes at 24 kHz; French's law for the water; a driven resonance with a strain limit, Canvas 2D (`src/toys/glass`) |
| **Tear Sheet** | Pull a velvet curtain until it rips, slash it with a swipe, throw balls into a flag or a hammock. | XPBD cloth on CPU + WebGL2 (`src/toys/cloth`) |
| **Laundry Line** | Washing pegged to a sagging line: swipe for gusts, hold for a storm; pegs pop and laundry blows away. | XPBD cloth + rope on CPU + WebGL2 (`src/toys/laundry`) |
| **Pull the Thread** | Grab the loose end of a chunky knit and unravel it stitch by stitch, row by row, into a pile of crinkly yarn. | Stitch grid over XPBD cloth + XPBD yarn strand on WebGL2 (`src/toys/thread`) |
| **Spool Sort** | Hold a spool to reel its colour out of a stranded-colourwork knit. Each colour is its own yarn; floats caught behind other colours tighten, drag the patch and slip free with a snap. | XPBD knit + stranded yarns sliding through capstan-friction catches, Canvas 2D (`src/toys/spool`) |
| **Alchemy Sandbox** | Falling-sand chemistry: fire, water, lava, acid, plants, ice, gunpowder and more react with each other. | Cellular automaton on CPU + WebGL2 glow (`src/toys/sand`) |
| **Hourglass** | Flip the phone and sand pours at a steady rate however full the top is, piles at its angle of repose and craters on top; narrow the neck and it clogs until you shake it. Switch to water to hear it glug and slow. | ~2,000 frictional rolling disks (position-based contacts); Beverloo flow emerges; water with glugging bubbles, WebGL2 (`src/toys/hourglass`) |
| **Dig Down** | Scoop down through a backyard. Ground that loses its support breaks free as rigid slabs that fall, tumble, shatter into grains or settle back into the ground; undercut boulders drop and roll; 12 buried finds fall, roll and can be buried again. | Falling-sand CA + pixel islands traced (marching squares) into soft-step rigid bodies, as in Noita, on Canvas 2D (`src/toys/dig`) |
| **Demolition Tower** | Swing a wrecking ball, drop bombs or flick cannonballs into brick towers, pyramids and castles; blocks shatter into debris and dust. Rubble has rolling resistance and settles, and tall stacks stand still. | Pure-TS 2D rigid bodies (Box2D v3-style soft step, rolling resistance, shock propagation, island waking) + WebGL2 (`src/toys/demolition`) |
| **Snap!** | Bend dry spaghetti with two fingers: it crackles, then shatters into three or more pieces. Twist it first and it breaks cleanly in two. Twigs, chopsticks and pencil lead too. | Bend-and-twist rods with true bending waves; the fracture cascade (Audoly & Neukirch 2005) and twist-to-halve (Heisser et al. 2018) emerge; Canvas 2D (`src/toys/snap`) |
| **Knockdown** | A fairground stall of tin cans, glass jars and wooden crates. Drag back the slingshot, watch the arc, and clear the shelves: glass shatters and splats jam, crates splinter, the last item gets slow-mo. | Demolition's rigid bodies with per-material bounce, baked Voronoi shatter and jam decals on WebGL2 (`src/toys/knockdown`) |
| **Marbling Tray** | Drop inks on a bath, drag combs, rakes and a stylus into feathered ebru patterns, then lay paper to keep a print. | Mixwell analytic marbling brushes (SIGGRAPH 2026 Best Paper) on WebGL2 (`src/toys/marble`) |
| **Power Rinse** | Blast a mud-caked Bobo statue, duck, gnome or mosaic clean; a "% clean" ring fills and hidden details appear. | Erodible mud and moss layers, runoff and spray on WebGL2 (`src/toys/rinse`) |
| **Sand Jar** | Pour coloured sand through a funnel into a bottle, poke scallops, tilt the strata; or pour matching colours to reveal a hidden picture. | Sand-only falling-sand CA with picture targets on WebGL2 (`src/toys/sandjar`) |
| **Peel It** | Peel a screen protector, a sticker, masking tape or a gadget's film. Roll it back slowly and it comes off clean; yank it and it tears, leaving a scrap to pick at. | XPBD film with per-vertex glue that lets go by the Kendall peel relation, on WebGL2 (`src/toys/peel`) |
| **Mow Lines** | Mow a lawn into stripes: each pass leans the stubble your way, so neighbouring passes read light and dark. The motor bogs down in long grass; mind the flower beds, the stone and the cat. | Shell-texture grass with CPU length and lean maps on WebGL2 (`src/toys/mow`) |
| **Foundry** | Pour glowing bronze into a sand mould, let it cool, smash the mould open, and ring what you cast. The note is the casting's own: seams and voids from a hesitant pour, and where you tap, change how it rings. | Falling-sand CA with a hot metal cell, conservative heat and a hydrostatic head; the ring is a plane-stress FEM of the cast shape (shift-invert Lanczos) played as modal synthesis, Canvas 2D (`src/toys/foundry`) |
| **Invisible Ink** | Hold a secret letter over a candle to bring out the hidden message, but keep it moving: the paper browns, chars and catches, and what burns is lost. | Heat, char and fire grid over a hidden-ink mask on WebGL2 (`src/toys/ink-letter`) |
| **Kintsugi** | Drop a porcelain bowl, fit the shards back with a magnetic click, and pour gold that races along every crack. Mended pieces go on a shelf. | Voronoi fracture with shared seam lines, a 1D gold flow over the seam network, Canvas 2D (`src/toys/kintsugi`) |
| **Fingerprint Dust** | Brush powder until hidden prints bloom, blow away the excess, lift the print with tape, and match it to a suspect's card. | Powder grains on a ridge-adhesion mask, Peel It's film for the tape, WebGL2 (`src/toys/prints`) |
| **Frost Window** | Breathe on a cold pane (into the mic, or hold the button) to fog it, draw in the fog, and frost ferns grow from your lines; hold a warm finger to melt a peephole whose drops run and refreeze. | Reiter's hex-lattice snow-crystal growth on the GPU with fog, nucleation seams and melt water, WebGL2 (`src/toys/frost`) |
| **Plasma Globe** | Touch the glass and filaments reach for your finger, thicken as you hold and split between fingers. Wood and acrylic modes burn and etch Lichtenberg figures. | Dielectric breakdown model (Niemeyer et al. 1984) on a multigrid potential, with channel heating and decay, WebGL2 (`src/toys/plasma`) |

## The menu

<img src="docs/media/bobo-menu.gif" alt="The bobo hub: New carousel, Updated row, a toy sheet with What's new, swipe to dismiss" width="300" align="right">

The hub shows each toy as a live preview card. **New** and **Updated** rows sit at the top, and updated toys say what changed right on the card; a yellow or blue dot marks them in the grid. Tap a toy for its sheet: description, a dated **What's new** list, papers and Play. Swipe the sheet down to dismiss it. Sort by newest, A–Z or shelf; previews can be set to Auto, Wi-Fi only or Off. Updates are logged in [`src/shell/catalog.ts`](src/shell/catalog.ts).

Inside a toy there's a **Tune** panel (top right) with live sliders and a **Based on** list linking the papers and reference code it uses. There's also a **Clip** button that records 8 s to share, a sound toggle, and an FPS readout (top centre).

<br clear="right">

## Sound

Every toy has procedural sound, with no audio files. [`src/shell/sound.ts`](src/shell/sound.ts) has three layers:

- **Voices and loops**: 14 one-shot voices (pop, squish, boing, thud, knock, tick, snap, rip, splash, whoosh, crumble, sizzle, chime, plop) and 5 filtered loops (hiss, rumble, trickle, crackle, bubble), with pitch, loudness and stereo position driven by the physics.
- **The resonator pool** ([`resonators.ts`](src/shell/resonators.ts)): up to 96 damped resonators on the audio thread (an AudioWorklet), excited straight from simulation events, so a sound's frequencies come from what the sim knows. `sound.bubble(radius)` rings at the bubble's Minnaert frequency and chirps up (van den Doel 2005); `sound.impact(material, size, strength)` rings with a material's mode pattern pitched by size (glass, tin, wood, ceramic, stone, bronze); `sound.modes(partials)` plays modes a toy computed itself (Foundry's casting); `sound.crumple()` gives buckling clicks and `sound.slip()` a stick-slip voice (Peel It's screech).
- **A shared output** (`audioOutput()`): toys that synthesise their own signal (Chladni Plate's modes, Singing Glass's friction solve) play into the shell's context, so they follow the mute toggle, share the compressor, and are heard by the mic's echo suppression. A meter worklet measures what leaves the speaker.

## Haptics

Taps and hits use `ctx.haptic()`. For feel that runs *with* the action, toys call `ctx.hapticLevel(intensity, sharpness)` every frame; skipping a frame stops it. Power Rinse's jet, Mow Lines' motor bogging down, Peel It's glue letting go, Pour Sort's stream, Spool Sort's reeling, Dig Down's scraping and cave-ins, Foundry's pour and Tear Sheet's strain all use it. [`src/shell/haptics.ts`](src/shell/haptics.ts) sends the level (up to 30 times a second) to a small native plugin that picks the best the phone can do:

| Platform | How |
|---|---|
| iOS | One looping Core Haptics player with live intensity and sharpness (`BoboHapticsPlugin` in `ios/App/App/SceneDelegate.swift`) |
| Android 16+ with envelope support | Short intensity/sharpness envelopes, re-sent before each ends, each ramping from the last level (`BoboHapticsPlugin.java`) |
| Android with amplitude control | A looping waveform at the current amplitude; sharp settings become a fast pulse train. The Galaxy S24 lands here: Android 16, but its motor reports no envelope support |
| Browser | `navigator.vibrate` pulses whose rate follows the intensity |

The app logs its tier at start (`[bobo] haptics: core-haptics`).

## Microphone

Toys can listen for breath and song. A toy calls `ctx.mic.offer(hint)` and a mic button appears in its HUD; nothing listens until the player taps it, and it stops when the toy closes or the app goes to the background. [`src/shell/mic.ts`](src/shell/mic.ts) turns three raw features — loudness, pitch, and how periodic the sound is (a normalised autocorrelation peak) — into `ctx.mic.blow` (loud and unvoiced: breath is turbulent noise), `ctx.mic.level` and `ctx.mic.pitch` (only for a clear note). The features come from a native `BoboMic` plugin (an `AVAudioEngine` tap on iOS, where the web view's audio input reads silence; `AudioRecord` on Android) or from `getUserMedia` in a browser. Audio is analysed on the device and never recorded or sent. Campfire, Fingerprint Dust, Frost Window and Bubble Wand listen for breath; Chladni Plate and Singing Glass listen for a sung note.

**Feedback.** A toy that listens while it plays can hear itself: a plate or glass would keep itself ringing, a crackling fire would "blow" on itself. The shell measures what the speaker is playing, learns how much of it leaks back into the mic, subtracts that echo (with a wider margin for breath), and ignores a pitch it hears while the mic is mostly echo. Singing toys also ask for the platform's echo cancellation (`ctx.mic.offer(hint, { echoCancel: true })`: iOS voice processing, Android's AcousticEchoCanceler); blowing toys keep raw input, which those processors would flatten. On the Galaxy S24, a plate rung hard with nobody singing now reads no pitch, and a loud fire reads no breath.

Play it: https://bobo-ashy-ten.vercel.app. Deploys are manual for now: `npx vercel deploy --prod --archive=tgz` (auto-deploy stopped when the repo moved to ai-asylum).

## Gallery

| | | | |
|:-:|:-:|:-:|:-:|
| ![Ink Swirl](docs/media/ink.gif)<br>**Ink Swirl** | ![Goo Lab](docs/media/goo.gif)<br>**Goo Lab** | ![Alchemy Sandbox](docs/media/sand.gif)<br>**Alchemy Sandbox** | ![Ripple Pool](docs/media/pool.gif)<br>**Ripple Pool** |
| ![Splash Tank](docs/media/splash.gif)<br>**Splash Tank** | ![Tear Sheet](docs/media/cloth.gif)<br>**Tear Sheet** | ![Laundry Line](docs/media/laundry.gif)<br>**Laundry Line** | ![Pull the Thread](docs/media/thread.gif)<br>**Pull the Thread** |
| ![Campfire](docs/media/fire.gif)<br>**Campfire** | ![Jelly Stack](docs/media/jelly.gif)<br>**Jelly Stack** | ![Demolition Tower](docs/media/demolition.gif)<br>**Demolition Tower** | ![Ferro Blob](docs/media/ferro.gif)<br>**Ferro Blob** |
| ![Marbling Tray](docs/media/marble.gif)<br>**Marbling Tray** | ![Jelly Merge](docs/media/merge.gif)<br>**Jelly Merge** | ![Power Rinse](docs/media/rinse.gif)<br>**Power Rinse** | ![Sand Jar](docs/media/sandjar.gif)<br>**Sand Jar** |
| ![Spool Sort](docs/media/spool.gif)<br>**Spool Sort** | ![Dig Down](docs/media/dig.gif)<br>**Dig Down** | ![Knockdown](docs/media/knockdown.gif)<br>**Knockdown** | ![Peel It](docs/media/peel.gif)<br>**Peel It** |
| ![Pour Sort](docs/media/pour.gif)<br>**Pour Sort** | ![Mow Lines](docs/media/mow.gif)<br>**Mow Lines** | ![Foundry](docs/media/foundry.gif)<br>**Foundry** | ![Invisible Ink](docs/media/ink-letter.gif)<br>**Invisible Ink** |
| ![Kintsugi](docs/media/kintsugi.gif)<br>**Kintsugi** | ![Fingerprint Dust](docs/media/prints.gif)<br>**Fingerprint Dust** |  |  |

Captured in headless Chrome with [`tools/media`](tools/media).

## Roadmap

Next up, from [docs/research/2026-gaps-web.md](docs/research/2026-gaps-web.md), [2026-directions.md](docs/research/2026-directions.md), [cloth-knitting.md](docs/research/cloth-knitting.md) and [shear-knit.md](docs/research/shear-knit.md):

| Next | What | Builds on |
|---|---|---|
| **Crumple & Crease** | Paper that keeps a crease where you press it and clicks with each buckle | Tear Sheet cloth + persistent-crease plasticity · [Cirio et al. 2016](https://www.ccs.upm.es/research/publications/crumpling-sound-synthesis/) |
| **Smoke Rings** | Puff (mic or flick) vortex rings that leapfrog and collide | Ink Swirl's fluid · vortex filaments |
| **Shear** | Clip the fleece off a sheep with shell fur and cut maps; the fleece peels off in one piece | Tear Sheet cutting, Laundry Line pins · [Lengyel et al. 2001](https://hhoppe.com/proj/fur/) |
| **Rope & yarn ball** | Ropes, chains and a yarn ball that unspools and tangles as a cat bats it | Pull the Thread's yarn · [Cosserat rods](https://animation.rwth-aachen.de/publication/0550/) |
| **Knit-a-Scarf** | Knit stitch by stitch from your own spun yarn, then dress the sheep | Pull the Thread's knit grid · [Stitch Meshes](https://www.cemyuksel.com/research/stitchmeshes/) |
| **Tablecloth Trick** | Yank a tablecloth out from under a dinner set | Tear Sheet cloth + Demolition's rigid bodies · [C-IPC](https://ipc-sim.github.io/C-IPC/) |

## Run

```sh
npm install
npm run dev        # http://localhost:5280, also on your LAN IP for phones on the same Wi-Fi
```

Goo Lab and Splash Tank need WebGPU: current Chrome/Edge, Safari 26+ (iOS/iPadOS/macOS 26). The other toys run anywhere with WebGL2.

## Android

With an Android device attached (USB debugging on), JDK 21 and the Android SDK installed:

```sh
npm run mobile:android:install   # build a debug APK, install and launch it
node mobile/android-soak.mjs goo 30   # launch a toy with the autoplay finger and print FPS from logcat
```

`ANDROID_SERIAL` picks a device when several are attached. The APK is written to `mobile/out/bobo-debug.apk`.

## iPhone

With an iPhone attached and trusted, and an Apple Development certificate in the keychain:

```sh
npm run mobile:ios:install   # build, sign, install and launch on the attached iPhone
npm run mobile:ios           # build only → mobile/out/ios/Build/Products/Debug-iphoneos/App.app
```

`IOS_TEAM_ID` overrides the signing team read from the certificate; `IOS_DEVICE` picks a device when several are attached. The app bundles the build, so no server is needed on the phone.

## Layout

```
src/main.ts            toy host: frame loop, FPS, resize, haptics, clip recorder, celebrate
src/shell/hub.ts       the hub: preview cards, New carousel, sort/shelf filter, toy sheets
src/shell/catalog.ts   when each toy shipped and which shelf it sits on
src/shell/sound.ts     procedural voices and loops, the resonator pool, the shared output
src/shell/mic.ts       mic features (blow, level, pitch) with echo suppression
src/shell/haptics.ts   continuous haptics
src/shell/             also the Tune panel, multi-touch pointers, icons, shared styles, the Toy interface
src/toys/<toy>/        one folder per toy: export a `Toy` from index.ts and add a catalog.ts line; the hub finds it
src/previews/          3 s hub preview loops (.mp4 + .webp poster), made by tools/media
tools/media/           headless capture → hub previews, README GIFs and the cover
mobile/                Capacitor iOS and Android build, install and FPS soak scripts
```

## Docs

- [docs/research/2026-gaps-web.md](docs/research/2026-gaps-web.md), [2026-gaps.md](docs/research/2026-gaps.md), [2026-gaps-cloud.md](docs/research/2026-gaps-cloud.md) — what bobo's simulations were missing: sound from the physics (bubbles, modes, buckling, stick-slip) and new phenomena (Chladni plates, rod cascades, viscous coiling, dielectric breakdown, granular flow, singing glass, frost)
- [docs/research/2026-audit.md](docs/research/2026-audit.md) — an audit of the newest toys: what the code really does against what it claimed, re-judged on simulation novelty alone
- [docs/research/2026-wave3.md](docs/research/2026-wave3.md) — the wave 3 refresh: SIGGRAPH 2026 simulation papers, the 2026 charts (Smash Fest, sort and chore games), scored candidates and build specs for Knockdown, Peel It, Pour Sort and Mow Lines
- [docs/research/2026-theme-toys.md](docs/research/2026-theme-toys.md) — theme-native toys from the theme-fit study (the theme *is* the physics): Foundry, Invisible Ink, Kintsugi and Fingerprint Dust
- [docs/research/2026-tech.md](docs/research/2026-tech.md), [2026-scene.md](docs/research/2026-scene.md), [2026-directions.md](docs/research/2026-directions.md) — autumn 2026 graphics/physics research, the games scene, and the toy picks they led to (waves 1 and 2)
- [docs/research/physics.md](docs/research/physics.md) — survey of real-time physics simulation techniques (Two Minute Papers, Ten Minute Physics, SIGGRAPH, etc.) and a backlog of sandbox toys to build
- [docs/research/cloth-knitting.md](docs/research/cloth-knitting.md) — cloth, yarn and knitting simulation: techniques, yarn-level research and how to fake it, browser playgrounds, and ten cloth/knit toy ideas (e.g. unravel a sweater)
- [docs/research/hub-design.md](docs/research/hub-design.md) — mobile catalog design (HIG / Material 3), preview video formats and playback budgets behind the hub
- [docs/research/shear-knit.md](docs/research/shear-knit.md) — a shear-the-sheep → spin → knit sandbox: touchscreen haptics and pseudo-haptics, Core Haptics bridge design, shell fur with cut maps, the one-piece fleece as a pinned cloth sheet, spinning twist physics, procedural audio, and a build plan
