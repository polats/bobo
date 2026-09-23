# bobo

A physics sandbox for playing with novel, satisfying, performant simulations — liquid, particles, cloth, soft bodies, sand — tuned for juicy visual effects.

## Toys

| Toy | What it is | Tech |
|---|---|---|
| **Ink Swirl** | Finger-paint glowing fluid; tap to burst, flick to swirl. *Paint* mode mixes colours like real pigment. | Stable Fluids on WebGL2 (`src/toys/ink`) |
| **Goo Lab** | Pour water, jelly, snow and sand that all interact; poke and squish them. | 2D MLS-MPM on WebGPU compute (`src/toys/goo`) |
| **Alchemy Sandbox** | Falling-sand chemistry: fire, water, lava, acid, plants, ice, gunpowder and more react with each other. | Cellular automaton on CPU + WebGL2 glow (`src/toys/sand`) |
| **Ripple Pool** | Poke a sunlit pool, watch caustics dance, grab and fling rubber ducks, make it rain. | Height-field waves + mesh caustics on WebGL2 (`src/toys/pool`) |
| **Tear Sheet** | Pull a velvet curtain until it rips, slash it with a swipe, throw balls into a flag or a hammock. | XPBD cloth on CPU + WebGL2 (`src/toys/cloth`) |

Every toy has a **Tune** panel (top right) with live sliders, a **Based on** list linking the papers and reference code it uses, and an FPS readout (top centre).

Play it: https://bobo-ashy-ten.vercel.app (redeploys on every push to `main`).

## Roadmap

Next toys from the backlog in [docs/research/physics.md](docs/research/physics.md#6-toy-backlog-prioritized), with the work each one builds on:

| Toy | Sim | Papers / sources |
|---|---|---|
| **Splash Tank** — tilt the phone to slosh 3D water | 3D MLS-MPM (reuses Goo Lab) + screen-space fluid rendering | [Hu et al. 2018](https://yuanming.taichi.graphics/publication/2018-mlsmpm/) · [van der Laan et al. 2009, SSFR](https://dl.acm.org/doi/10.1145/1507149.1507164) · [WebGPU-Ocean](https://github.com/matsuoka-601/webgpu-ocean) · [Codrops write-up](https://tympanus.net/codrops/2025/02/26/webgpu-fluid-simulations-high-performance-real-time-rendering/) |
| **Jelly Stack** — wobbly blocks to stack and slap | Shape matching / XPBD (2D), VBD later | [Müller et al. 2005, shape matching](https://dl.acm.org/doi/10.1145/1073204.1073216) · [Vertex Block Descent 2024](https://graphics.cs.utah.edu/research/projects/vbd/) · [2MP: Complementary Dynamics](https://www.youtube.com/watch?v=s8Nm_ytwO6w) |
| **Demolition Tower** — 1k-block towers, wrecking ball | AVBD 2D or Box2D v3 | [Augmented VBD 2025](https://graphics.cs.utah.edu/research/projects/avbd/) · [avbd-demo2d](https://github.com/savant117/avbd-demo2d) · [Box2D v3](https://box2d.org/posts/2024/08/releasing-box2d-3.0/) · [Müller et al. 2013, fracture](https://dl.acm.org/doi/10.1145/2461912.2461934) |
| **Campfire** — ignite logs, blow on embers | Ink Swirl's grid fluid + temperature/fuel | [Ten Minute Physics #21 fire](https://matthias-research.github.io/pages/tenMinutePhysics/index.html) · [2MP: Interactive Wood Combustion](https://www.youtube.com/watch?v=2jwVDRKKDME) |
| **Ferro Blob** — magnetic liquid that spikes at your finger | Particle fluid + magnetic forces (or shader fake) | [2MP: Surface-Only Ferrofluids](https://www.youtube.com/watch?v=nJ86LCA0Asw) · [2MP: Large-scale Ferrofluids](https://www.youtube.com/watch?v=goD36hVVl7M) |

## Run

```sh
npm install
npm run dev        # http://localhost:5280, also on your LAN IP for phones on the same Wi-Fi
```

Goo Lab needs WebGPU: current Chrome/Edge, Safari 26+ (iOS/iPadOS/macOS 26). The other toys run anywhere with WebGL2.

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
