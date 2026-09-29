# bobo directions, autumn 2026

*2026-09-29. Synthesis of [2026-tech.md](2026-tech.md) (new graphics/physics, mid-2024 → Sept 2026) and [2026-scene.md](2026-scene.md) (what physics-driven play is resonating in games and on the web), plus what we learned shipping the first 12 toys.*

## What we learned from 12 toys

- **Every sim family we tried holds 60 fps on an iPhone 13 mini** when budgeted: stable fluids, 2D/3D MLS-MPM, falling-sand CA, height fields, CPU XPBD cloth/rope/yarn, shape matching, a TS rigid-body solver. Tech risk is low; the constraint is design.
- **Feel lives in small details we had to find by iterating**: tearing only satisfied once cracks opened across the pull and ran; pulls felt good once you grabbed a patch, not a point; the first stitch had to pop within one short drag. Build → soak on device → watch → fix is the loop that works.
- **What's missing across the board** (2026-scene.md §5): a *payoff* — a reveal, a "% done", a finished thing you keep — and *order from chaos* (sorting). Sound is still absent. We have no in-app way to share a clip.

## What the world is rewarding

- **Mobile money is "material + tight loop + reveal"**: Pixel Flow (~$94M, $1B+ Scopely deal), Sand Loop ($13.9M), Screwdom (~$206M), the wool/knit sort wave (Knit Out top-5 sort grossing, Yarn Loop 2.5M+). Sorting alone did ~1B downloads in 2025.
- **PC: chill single-verb joys and cleaning** — A Game About Digging a Hole (1M, built in ~2 weeks), PowerWash (17M players; PWS2 at 91%), Spilled! — and **merge/drop physics** (Suika 11M, Suika Game Planet 2026).
- **Web**: three.js + WebGPU + TSL loops about dissolve, destroy and reveal, ~8 seconds, one gesture.

## What's new in the tech that we can actually ship

- **Mixwell** (SIGGRAPH 2026 Best Paper): analytic paper-marbling brushes, MIT GLSL library + WebGPU demo — a near-free marbling toy.
- **Dripping Thin Films** (EG 2026, WebGL2 demo): paint that runs and drips when you tilt.
- **Fire-X** (SIGGRAPH Asia 2025): oxygen-limited, fuel-coloured fire — a cheap Campfire upgrade.
- **Stable Cosserat Rods** (SIGGRAPH 2025; now in Jolt 5.6): the rod core for rope, yarn and knots.
- **LBM foams, vortex flow maps, glinty NDFs, deformable textures, shock propagation, Box2D 3.1 rolling resistance** — foam/smoke-ring toys and polish for existing ones.

## The picks

Chosen for (trend fit) × (novelty/tech edge) × (reuse of what we have) × (fits 60 fps on the phone). Wave 1 is small and fast; wave 2 is bigger.

### Wave 1 — build now

| Toy | Hook | Why this one | Built on | Effort |
|---|---|---|---|---|
| **Marbling Tray** | Drip inks on a bath, drag combs and rakes into feathered patterns, lay paper to keep a print | The year's best paper, open source and shader-only; cozy creation with a keepsake payoff; nobody has shipped it | Mixwell GLSL brushes + Ink Swirl's paint look | S–M |
| **Jelly Merge** | Suika with gummies: drop jelly fruit into a jar, same sizes squish into a bigger one, chase the giant Bobo gummy | Suika 11M + sequel; merge/drop is the proven "one more go" loop; 90% of the tech exists | Jelly Stack's shape matching | S |
| **Power Rinse** | Blast a mud-caked Bobo, duck or bike clean; "% clean" ring fills; hidden paint and stickers appear | PowerWash/Spilled! — cleaning + reveal + completion, our biggest gap | Stable fluids runoff (Ink/Campfire), erodible dirt texture | S–M |
| **Sand Jar** | Pour coloured sand through a funnel into strata, then lift the stencil to reveal the picture | Sand Loop's reveal loop in a pure toy; tiny effort | Alchemy's falling-sand CA | S |

### Wave 2 — next

| Toy | Hook | Why | Built on | Effort |
|---|---|---|---|---|
| **Spool Sort** | Tap a bobbin and it reels in its colour from a knitted picture, unravelling it live | The knit-puzzle wave, but with real yarn physics nobody else has | Pull the Thread's knit + yarn | M |
| **Dig Down** | Scoop a backyard cross-section; soil holds until undercut, then crumbles; dig up finds for a shelf | A Game About Digging a Hole + DK Bananza's destruction-as-reveal | Sand CA (cohesive soil) + Demolition rigid bodies | S–M |

### Shell features alongside wave 1

- **Reveal / "% done" widget** any toy can drive (Power Rinse, Sand Jar, Spool Sort, Dig Down).
- **"Clip" button**: record the last ~8 s of the canvas (MediaRecorder) to share — the unit the web and ads run on.

### Parked for later (good, but lower fit now)

Soap Suds / beer foam (LBM), Smoke Rings (vortex particles), Snap the Branch and Knot It (Cosserat rods), Drip Wall (thin films), Peel It, Screw Loose, Geode Crack, Pottery Wheel, Liquid Sort, Bathtub. Quick upgrades to existing toys (Fire-X oxygen for Campfire, rolling resistance and shock propagation for Demolition, glitter on Goo Lab's snow) are listed in [2026-tech.md §6](2026-tech.md).
