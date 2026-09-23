# bobo

A physics sandbox for playing with novel, satisfying, performant simulations — liquid, particles, cloth, soft bodies, sand — tuned for juicy visual effects.

## Toys

| Toy | What it is | Tech |
|---|---|---|
| **Ink Swirl** | Finger-paint glowing fluid; tap to burst, flick to swirl. *Paint* mode mixes colours like real pigment. | Stable Fluids on WebGL2 (`src/toys/ink`) |
| **Goo Lab** | Pour water, jelly, snow and sand that all interact; poke and squish them. | 2D MLS-MPM on WebGPU compute (`src/toys/goo`) |

Every toy has a **Tune** panel (top right) with live sliders, and an FPS readout (bottom left).

## Run

```sh
npm install
npm run dev        # http://localhost:5280, also on your LAN IP for phones on the same Wi-Fi
```

Goo Lab needs WebGPU: current Chrome/Edge, Safari 26+ (iOS/iPadOS/macOS 26). Ink Swirl runs anywhere with WebGL2.

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
