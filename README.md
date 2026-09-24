# bobo

![bobo — physics toys you can poke](docs/media/bobo-cover.gif)

A physics sandbox for playing with novel, satisfying, performant simulations — liquid, particles, cloth, soft bodies, sand — tuned for juicy visual effects.

## Toys

| Toy | What it is | Tech |
|---|---|---|
| **Ink Swirl** | Finger-paint glowing fluid; tap to burst, flick to swirl. *Paint* mode mixes colours like real pigment. | Stable Fluids on WebGL2 (`src/toys/ink`) |
| **Goo Lab** | Pour water, jelly, snow and sand that all interact; poke and squish them. | 2D MLS-MPM on WebGPU compute (`src/toys/goo`) |
| **Alchemy Sandbox** | Falling-sand chemistry: fire, water, lava, acid, plants, ice, gunpowder and more react with each other. | Cellular automaton on CPU + WebGL2 glow (`src/toys/sand`) |
| **Ripple Pool** | Poke a sunlit pool, watch caustics dance, grab and fling rubber ducks, make it rain. | Height-field waves + mesh caustics on WebGL2 (`src/toys/pool`) |
| **Splash Tank** | A glass tank of 3D water: tilt the phone (or drag) to slosh it, poke it, drop beach balls, make a big splash. | 3D MLS-MPM + screen-space fluid rendering on WebGPU (`src/toys/splash`) |
| **Tear Sheet** | Pull a velvet curtain until it rips, slash it with a swipe, throw balls into a flag or a hammock. | XPBD cloth on CPU + WebGL2 (`src/toys/cloth`) |
| **Pull the Thread** | Grab the loose end of a chunky knit and unravel it stitch by stitch, row by row, into a pile of crinkly yarn. | Stitch grid over XPBD cloth + XPBD yarn strand on WebGL2 (`src/toys/thread`) |
| **Campfire** | Stack logs, strike a match, blow on the embers; fire climbs the wood, chars it, and hisses when doused. | Stable-fluids fire (heat, smoke, buoyancy) + CPU burning cells on WebGL2 (`src/toys/fire`) |
| **Jelly Stack** | Tap to drop gummy cubes, stars, hearts and a smiling Bobo; stack them, grab and fling, slap the tower over. | Shape-matching soft bodies + PBD contacts on WebGL2 (`src/toys/jelly`) |
| **Demolition Tower** | Swing a wrecking ball, drop bombs or flick cannonballs into brick towers, pyramids and castles; blocks shatter into debris and dust. | Pure-TS 2D rigid bodies (Box2D v3-style soft step, sleeping) + WebGL2 (`src/toys/demolition`) |
| **Ferro Blob** | Drag a magnet under a dish of black ferrofluid: it crawls after you and bristles with spikes; two fingers split it, taps drop droplets. | Double-density particle liquid + Rosensweig spike lattice + chrome shading on WebGL2 (`src/toys/ferro`) |
| **Laundry Line** | Washing pegged to a sagging line: swipe for gusts, hold for a storm; pegs pop and laundry blows away. | XPBD cloth + rope on CPU + WebGL2 (`src/toys/laundry`) |

Every toy has a **Tune** panel (top right) with live sliders, a **Based on** list linking the papers and reference code it uses, and an FPS readout (top centre).

Play it: https://bobo-ashy-ten.vercel.app (redeploys on every push to `main`).

## Gallery

| | | | |
|:-:|:-:|:-:|:-:|
| ![Ink Swirl](docs/media/ink.gif)<br>**Ink Swirl** | ![Goo Lab](docs/media/goo.gif)<br>**Goo Lab** | ![Alchemy Sandbox](docs/media/sand.gif)<br>**Alchemy Sandbox** | ![Ripple Pool](docs/media/pool.gif)<br>**Ripple Pool** |
| ![Splash Tank](docs/media/splash.gif)<br>**Splash Tank** | ![Tear Sheet](docs/media/cloth.gif)<br>**Tear Sheet** | ![Laundry Line](docs/media/laundry.gif)<br>**Laundry Line** | ![Pull the Thread](docs/media/thread.gif)<br>**Pull the Thread** |

Captured in headless Chrome with [`tools/media`](tools/media).

## Roadmap

Next up, from [docs/research/cloth-knitting.md](docs/research/cloth-knitting.md) and [docs/research/shear-knit.md](docs/research/shear-knit.md):

| Next | What | Builds on |
|---|---|---|
| **Sound + haptics layer** | Shared Web Audio engine (grains, procedural motors, modal clicks) and a native Core Haptics bridge for continuous, load-driven vibration; retrofit every toy | [shear-knit.md §2, §5](docs/research/shear-knit.md) · [Core Haptics](https://developer.apple.com/documentation/corehaptics) |
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

## iPhone

With an iPhone attached and trusted, and an Apple Development certificate in the keychain:

```sh
npm run mobile:ios:install   # build, sign, install and launch on the attached iPhone
npm run mobile:ios           # build only → mobile/out/ios/Build/Products/Debug-iphoneos/App.app
```

`IOS_TEAM_ID` overrides the signing team read from the certificate; `IOS_DEVICE` picks a device when several are attached. The app bundles the build, so no server is needed on the phone.

## Layout

```
src/main.ts            hub + toy host (frame loop, FPS, resize, haptics)
src/shell/             panel (sliders), multi-touch pointers, shared styles, Toy interface
src/toys/<toy>/        one folder per toy; export a `Toy` from index.ts and add it to main.ts
mobile/build-ios.mjs   Capacitor iOS build/install
```

## Docs

- [docs/research/physics.md](docs/research/physics.md) — survey of real-time physics simulation techniques (Two Minute Papers, Ten Minute Physics, SIGGRAPH, etc.) and a backlog of sandbox toys to build
- [docs/research/cloth-knitting.md](docs/research/cloth-knitting.md) — cloth, yarn and knitting simulation: techniques, yarn-level research and how to fake it, browser playgrounds, and ten cloth/knit toy ideas (e.g. unravel a sweater)
- [docs/research/shear-knit.md](docs/research/shear-knit.md) — a shear-the-sheep → spin → knit sandbox: touchscreen haptics and pseudo-haptics, Core Haptics bridge design, shell fur with cut maps, the one-piece fleece as a pinned cloth sheet, spinning twist physics, procedural audio, and a build plan
