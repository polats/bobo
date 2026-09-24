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
| **Demolition Tower** | Swing a wrecking ball, drop bombs or flick cannonballs into brick towers, pyramids and castles; blocks shatter into debris and dust. | Pure-TS 2D rigid bodies (Box2D v3-style soft step, sleeping) + WebGL2 (`src/toys/demolition`) |
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

Next toys from the backlog in [docs/research/physics.md](docs/research/physics.md#6-toy-backlog-prioritized), with the work each one builds on:

| Toy | Sim | Papers / sources |
|---|---|---|
| **Jelly Stack** — wobbly blocks to stack and slap | Shape matching / XPBD (2D), VBD later | [Müller et al. 2005, shape matching](https://dl.acm.org/doi/10.1145/1073204.1073216) · [Vertex Block Descent 2024](https://graphics.cs.utah.edu/research/projects/vbd/) · [2MP: Complementary Dynamics](https://www.youtube.com/watch?v=s8Nm_ytwO6w) |
| **Ferro Blob** — magnetic liquid that spikes at your finger | Particle fluid + magnetic forces (or shader fake) | [2MP: Surface-Only Ferrofluids](https://www.youtube.com/watch?v=nJ86LCA0Asw) · [2MP: Large-scale Ferrofluids](https://www.youtube.com/watch?v=goD36hVVl7M) |

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
