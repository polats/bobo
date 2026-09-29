# bobo gaps: what the web says we're missing (2026-09-29)

*Web research pass: about 55 searches and 12 page fetches. It skips what 2026-tech.md, 2026-wave3.md, physics.md, cloth-knitting.md, shear-knit.md and 2026-audit.md already cover (Mixwell, Dripping Thin Films, flow maps, Fire-X, FlameForge, HOME-FREE foam, Stable Cosserat, Stressful Tree, Woodstock, DeepFracture, VR-Doh, CK-MPM, MPM Lite, BladeMaster, Better Bending, Glinty, Particles4All and others). Where one of those is still the best pick for a toy, it is marked "(covered)". Phone feasibility is judged against an iPhone 13 mini at 60 fps and is **(est)** unless stated. Effort: S ≈ days, M ≈ 1–2 weeks, L ≈ more.*

## 0. The headline gap: sound that comes out of the simulation

bobo's sound is 14 canned voices plus 5 loops, with pitch and gain driven by physics (README "Sound"). The 2026 audit found that most of the newer toys are rules with physics on top. Sound has the same problem. A "pop" voice scaled by impulse is not the sound of *that* can or *that* bubble. What the literature has, and bobo lacks, is sound whose **frequencies come from the geometry and events in the sim**:

- **Bubbles → Minnaert tones.** Each bubble rings at a frequency set by its radius (f ≈ 3.26 m/s ÷ r), chirping upward as it rises. This is where nearly all liquid sound comes from ([van den Doel 2005](https://dl.acm.org/doi/abs/10.1145/1101530.1101554); [Xue et al. 2023, coupled bubbles](https://graphics.stanford.edu/papers/coupledbubbles/), [MIT code](https://github.com/kangruix/FluidSound); [Farnell's Pd bubbles](https://aspress.co.uk/sd/)).
- **Rigid objects → modal banks.** An object's shape gives a set of damped sinusoids; the contact point and impulse set how hard each one rings ([DiffSound 2024](https://arxiv.org/pdf/2409.13486), [RealImpact 2023](https://arxiv.org/pdf/2306.09944), [Deep-Modal](https://dl.acm.org/doi/abs/10.1145/3394171.3413572); an npm [modal-synthesis](https://www.npmjs.com/package/modal-synthesis) Web Audio package exists).
- **Thin sheets → buckling clicks.** Crumpling is a stream of discrete buckling pops whose energies follow a power law ([Cirio et al. 2016, Crumpling Sound Synthesis](https://www.ccs.upm.es/research/publications/crumpling-sound-synthesis/)).
- **Friction → stick-slip trains.** Squeaks, singing glasses and peeling tape are all trains of slip pulses ([friction sound models](https://www.researchgate.net/publication/252729141_The_sound_of_friction_Real-time_models_playability_and_musical_applications)). The tape case was only explained in Feb 2026 ([Phys. Rev. E](https://journals.aps.org/pre/abstract/10.1103/p19h-9ysx)).
- **Fracture → sounds of the pieces.** Each shard rings with its own new modes ([Zheng & James 2010, fracture soundbanks](https://www.cs.cornell.edu/projects/FractureSound/files/fractureSound_comp.pdf)).

All five are cheap on a phone, because the sim already knows the radius, shape, contact or slip event. What they need is a small **modal/Minnaert voice pool in `sound.ts`**: N damped sine oscillators (or biquad resonators) retriggered from sim events. SIGGRAPH 2025–26 had almost no new sound-synthesis papers (confirmed on Ke-Sen Huang's indexes). The useful methods are 2005–2024, and nobody has shipped them in a phone toy.

---

## 1. Recent simulation work bobo doesn't use (2023–2026, plus classics where they're the right tool)

### 1a. Sound driven by physics

| Item | Year | What it simulates | bobo toy / upgrade (poke → see / hear / feel) | Phone | Effort |
|---|---|---|---|---|---|
| [Improved Water Sound Synthesis using Coupled Bubbles](https://graphics.stanford.edu/papers/coupledbubbles/) ([code](https://github.com/kangruix/FluidSound)) | 2023 | Bubble clouds as coupled oscillators, giving fuller low end than independent Minnaert bubbles | Pour Sort, Splash Tank, Ripple Pool rain: spawn a bubble whenever the stream or a drop entrains air. Hear the glug pitch fall as the tube fills | High for the uncoupled Minnaert version (≤32 voices). The coupled solver is offline C++ | S |
| [Physically based models for liquid sounds](https://dl.acm.org/doi/abs/10.1145/1101530.1101554) (van den Doel) | 2005 | Stochastic Minnaert bubbles, driven by a real-time fluid | The cheap real-time recipe for the row above | High | S |
| [Crumpling Sound Synthesis](https://www.ccs.upm.es/research/publications/crumpling-sound-synthesis/) (Cirio, Li, Grinspun, Otaduy, Zheng) | 2016 | Buckling events plus a power-law stochastic fill, then modal sound of the pieces | New **Crumple & Crease** toy; Peel It film crinkle; Tear Sheet | High if the events come from hinge-angle snaps in XPBD and each click is a short filtered burst | S (sound) |
| [Interactive procedural simulation of paper tearing with sound](https://manteapi.github.io/pages/publications/tearing_MIG2015/index.html) | 2015 | Tear direction from a cone deformation, plus procedural tear sound | Tear Sheet and Invisible Ink: tear rate and fibre noise drive the rip voice, not a canned "rip" | High | S |
| [Screeching sound of peeling tape](https://journals.aps.org/pre/abstract/10.1103/p19h-9ysx) (Thoroddsen, KAUST, PRE) | Feb 2026 | Stick-slip peeling: transverse cracks at about 450–600 m/s, each one sending a weak shock when it reaches the tape edge; about 37k pulses/s fuse into a screech ([summary](https://www.earth.com/news/science-explains-why-removing-adhesive-tape-makes-that-unbearable-squeaky-noise/)) | **Peel It**: pulse rate ∝ glue-front speed ÷ stick length, so a slow peel crackles and a fast yank screams. Haptic sharpness follows the same pulse rate | High (a pulse train or grain voice) | S |
| [Rigid-body fracture sound with precomputed soundbanks](https://www.cs.cornell.edu/projects/FractureSound/files/fractureSound_comp.pdf) | 2010 | Each fragment's own modal sound at the moment of fracture | Knockdown, Demolition, Kintsugi drop: shards "tink" at pitches set by their size | High (modes from 2D shard area and aspect ratio) | S–M |
| [DiffSound](https://arxiv.org/pdf/2409.13486) / [RealImpact](https://arxiv.org/pdf/2306.09944) | 2024 / 2023 | Differentiable modal rendering; a dataset of measured impacts on 50 real objects | Calibrate modal damping and frequency ratios per material (ceramic, tin, glass, wood, bronze) for Foundry, Kintsugi and Knockdown | Offline calibration only | S |
| [NeuroSonic](https://onlinelibrary.wiley.com/doi/10.1002/cav.70162) | 2026 | Instant neural impact sound with acoustic transfer | Not needed. Analytic modes are enough in 2D | Low | — |
| [Singing-bowl / wineglass waveguide models](https://ccrma.stanford.edu/~carmenng/250b/icmc2002.pdf) ([bowl acoustics](https://arxiv.org/pdf/1106.5657)) | 2002 / 2011 | A rubbed rim: stick-slip excites mainly the (2,0) mode | New **Singing Glass**: circle a wet finger round the rim and the tone swells once your speed locks. Water level sets pitch and ripples the surface | High | S–M |
| [Friction sound: real-time models](https://www.researchgate.net/publication/252729141_The_sound_of_friction_Real-time_models_playability_and_musical_applications) | 2000s | Stribeck and stick-slip friction driving resonators | Squeaky drag on glass (Kintsugi pieces), rubber duck squeak, Mow Lines wheel | High | S |

### 1b. New simulations and toys

| Item | Year | What it simulates | bobo toy (poke → see / hear / feel) | Phone | Effort |
|---|---|---|---|---|---|
| [Chladni figures](https://arxiv.org/pdf/1308.5523) (numerical), [luciopaiva/chladni](https://github.com/luciopaiva/chladni), [schroffl WebGL](https://github.com/schroffl/chladni-simulation) | classic; demos 2020s | Plate eigenmodes; sand collects on the nodal lines | New **Chladni Plate**: tap or bow the plate, slide the pitch, and sand leaps to the pattern of whichever mode you're near resonance with. **The tone you hear is the same mode.** Grain hiss and haptic buzz follow plate amplitude | High (precomputed modes, about 10k grains) | S |
| [Origami Simulator](https://origamisimulator.org/) ([paper](https://amandaghassaei.com/projects/origami_simulator/files/FastInteractiveOrigamiSimGPU.pdf), [code](https://github.com/amandaghassaei/OrigamiSimulator)) | 2018 | GPU folding of a crease pattern | Reference for a **Fold** toy; the crease pattern is fixed in advance | High (WebGL) | M |
| [Crease Lab](https://github.com/lukacslacko/origami) (XPBD paper) | 2026 | Elastic bending, stick-slip on the desk, **plastic creasing** where a fingertip presses the bend radius below a threshold, with adaptive refinement. Canvas 2D renderer plus optional WebGPU solver | New **Crumple & Crease**: press a fold flat and it stays; scrunch and the sheet keeps its creases; buckling clicks per Cirio. The closest open code to what bobo needs | High (it's already browser JS) | M |
| [Learnable Persistent Wrinkle Formation in Cloth](https://arxiv.org/pdf/2609.13707) | Sep 2026 | Friction plus plasticity; recoverable folds versus permanent creases | Tear Sheet / Laundry: crumpled cloth stays crumpled | Idea-level | M |
| [Discrete Viscous Threads](http://www.cs.columbia.edu/cg/pdfs/171-threads.pdf) (Bergou, Audoly, Vouga) + [Ribe coiling regimes](https://www.researchgate.net/publication/6524917_Dynamics_of_liquid_rope_coiling) | 2010 / 2006 | A viscous thread as an elastic-rod analogue; coiling, folding, "fluid sewing machine" | New **Honey Drizzle**: drag the spoon over toast; lift higher and the coil tightens and speeds up (Ω ~ (g/H)^½ in the inertio-gravitational regime); move fast and it meanders like the sewing machine. Soft sticky haptic tick per coil | High (a 1D rod of about 200 nodes on CPU, with bobo's XPBD rod) | M |
| [Controlling fracture cascades through twisting and quenching](https://www.pnas.org/doi/10.1073/pnas.1802831115) (Heisser et al.) | 2018 | Bent rods snap into 3+ pieces because of the snap-back flexural wave. Twisting first diverts that energy, so they break into 2 | New **Snap!** (spaghetti, breadsticks, twigs): two fingers bend, rotating them adds twist. Untwisted, it shatters into shards; twisted near 360°, it snaps clean in two. Modal "tick" per fragment | High (discrete rod with a curvature-rate fracture criterion) | M |
| [Beverloo law](https://arxiv.org/pdf/1211.5916) ([hourglass friction study](https://arxiv.org/pdf/2104.08186), ["sands of time run faster near the end"](https://www.nature.com/articles/ncomms15551)) | classic / 2017–2021 | Granular discharge rate ∝ (D − kd)^(5/2), **independent of fill height**, unlike water | New **Hourglass**, or a Sand Jar mode: flip the phone (gyro) and grains stream at a constant rate while the cone and crater form. Add water and it clepsydras (slows as it drains). The hiss stays level, like real sand | High (bobo's sand CA plus an outlet-rate governor) | S |
| [Fast Simulation of Laplacian Growth](http://gamma.cs.unc.edu/FRAC/laplacian_large.pdf) / [Fast Animation of Lightning (DBM)](https://gamma.cs.unc.edu/FAST_LIGHTNING/lightning_tvcg_2007.pdf) | 2007 | Dielectric breakdown model: a potential solve plus probabilistic growth | New **Plasma Globe / Lightning Jar**: touch the glass and filaments seek your finger, branching fractally; long-press charges a strike. Crackle grains per new branch. Also Alchemy "spark" | High (a 128² Jacobi potential on GPU, grown a few cells per frame) | S–M |
| [Gravner–Griffeath snow crystals](https://arxiv.org/pdf/0711.4020) ([WebGL2 port "First Snow"](https://github.com/sitara-systems/first-snow), [ibiblio WebGL](https://www.ibiblio.org/e-notes/webgl/snow/snowflake.htm)) | 2008; ports 2020s | A mesoscopic lattice map of vapour diffusion, attachment and melting | New **Snowflake**: breathe on the window (native mic RMS raises humidity) or hold a finger (cold) to steer growth; branches, plates and sectors appear per Nakaya | High (hex CA in a fragment shader, 512²) | S |
| [Strongly Coupled Simulation of Magnetic Rigid Bodies](https://onlinelibrary.wiley.com/doi/10.1111/cgf.15185) (SCA 2024), [Fast Stabilization of Inducible Magnet Simulation](https://rtg.hufs.ac.kr/publications/SIGGRAPHASIA22.pdf) (SA 2022), [Magnetic Modeling survey](https://onlinelibrary.wiley.com/doi/10.1111/cgf.70418) (2026) | 2022–2026 | Dipole and induced magnets inside the rigid solver, with no jitter | New **Magnet Desk** (ball magnets, paperclips, a steel bowl): chains snap together, clack, and tumble. Also makes **Kintsugi's** "magnetic click" real, and gives Ferro Blob rigid steel props | High in 2D for fewer than 100 dipoles in Demolition's solver | M |
| [Water droplets on glass: real-time](https://www.researchgate.net/publication/3422696_Real-time_simulation_Water_droplets_on_glass_windows) / [hydrophobic windshield](https://www.researchgate.net/publication/268438621_Animation_of_Water_Droplets_on_a_Hydrophobic_Windshield) | 2000s | Drops as masses with contact-angle hysteresis; they merge, then run as rivulets | New **Rainy Window**: tilt and drops stick, then slip, merging into runners that follow wet trails; wipe with a finger and fog returns. Minnaert-free "tick" when drops merge | High (a height texture plus CPU drops) | S–M |
| [Shear-thickening fluid with history stiffness](https://www.researchgate.net/publication/283433549_Simulating_the_Dynamic_Behavior_of_Shear_Thickening_Fluids) / [SPH DST model](https://arxiv.org/pdf/2311.13759) | 2015 / 2023 | Viscosity that jumps with strain rate and history | Goo Lab **Oobleck**: poke slowly and your finger sinks; slap it and it cracks like a solid, then melts back. Haptic sharpness switches with the regime | Medium (a rate-dependent yield in the existing MLS-MPM) | S–M |
| [Momentum-conserving implicit MPM for surface energies](https://arxiv.org/pdf/2101.12408) (candle wax example) | 2021 | Wax melting near a flame and re-solidifying as it flows away | **Candle** (Campfire sibling): drips run and freeze into stalactite drips. A 2D CA version (Foundry's cooling-metal cell, reused) is the phone path | 2D CA: high | M |
| [Mixed MPM for Stiff Elastoplasticity](https://research.nvidia.com/labs/prl/mixed_mpm/) (SIGGRAPH 2026) | 2026 | CFL-rate MPM up to incompressible: snow, sand, elastic solids, clay-like viscoplastic | Goo Lab clay or dough reference. Offline (4 s/frame), so only its flow rules help | Low | — |
| [Fast Cutting of Cage-Based Deformation with Walk on Spheres](https://hoskillua.github.io/wos_cutting_siggraph26/) (SIGGRAPH 2026) | 2026 | Real-time cutting of cage-deformed shapes, reusing about 90% of WoS walks after each cut | Jelly Stack "slice": a 2D cage around a gummy, cut it and both halves wobble on | Medium in 2D | M |
| [Vortex Particle-on-Mesh for Soap Films](https://taoningxiao.github.io/) (SIGGRAPH 2024) | 2024 | Vortex particles on a film mesh giving thin-film swirls | Bubble Wand (in 2026-tech) now has a second method. Film swirl colours on a 2D disc | Medium | M |
| [Unified Multi-Scale Two-Phase Immiscible Flows](https://www.physicsbasedanimation.com/2026/09/17/a-unified-multi-scale-method-for-simulating-two-phase-immiscible-flows/) (SA 2026) | 2026 | Grid-resolved bubbles blending into sub-grid bubbles | Offline; the idea is "small bubbles as sub-grid particles", as with Weta's unibubbles | Low | — |
| [Generalizing Shallow Water with Dispersive Surface Waves](https://d1qx31qr3h6wln.cloudfront.net/publications/Dispersive_Waves_in_a_Shallow_Water_Framework.pdf) (Jeschke & Wojtan) | 2023 | Shallow water plus correct wave dispersion: short ripples travel at a different speed from long swells, and boat wakes form | **Ripple Pool**: a poke gives a real ring train (fast long waves ahead, capillary ripples behind); a dragged duck leaves a Kelvin wake | Medium-high (an extra FFT or iterated filter on the height field) | M |
| [Real-Time Hybrid Ocean: wave particles + FFT](https://arxiv.org/abs/2511.02852) | 2025 | Local wave particles around objects inside an FFT background | Ripple Pool alternative for ducks | Medium | M |
| [Bubble wrap popping](https://en.wikipedia.org/wiki/Bubble_wrap) ([acoustic-testing study](https://techxplore.com/news/2025-10-enable-power-free-acoustic.html)) | 2025 | Overpressure about 0.1 atm released in under 1 ms gives a 1–3 kHz click; bursts reach 40 kHz | **Bubble Wrap** (tiny toy or a Peel It extra): each cell is a pressure volume in a film; squeeze two and air shifts to its neighbour; pop pitch depends on cell size | High | S |

---

## 2. Per existing toy: the most relevant paper

| Toy | Most relevant (2023–26 unless noted) | What it adds (poke → see / hear / feel) | Effort |
|---|---|---|---|
| Ink Swirl | [VPFM](https://arxiv.org/abs/2505.21946) (covered) | New angle: **breath as input**. Blow and a jet enters from the bottom edge, scaled by mic RMS (native plugin, §3b) | S |
| Ripple Pool | [Dispersive shallow water](https://d1qx31qr3h6wln.cloudfront.net/publications/Dispersive_Waves_in_a_Shallow_Water_Framework.pdf) (2023) + Minnaert rain | Real ring trains and duck wakes; raindrops "plink" at the bubble's pitch, not a sample | M |
| Splash Tank | [Coupled bubbles](https://graphics.stanford.edu/papers/coupledbubbles/) (2023) | Slosh loudness and pitch spread come from entrainment events (particles crossing the surface fast) | S |
| Campfire | [Fire-X](https://helgewrede.github.io/firex/) (covered, O₂ already done) | Crackle from cell burn-out events (a Poisson rate ∝ burning cells); breath via native mic instead of a swipe | S |
| Ferro Blob | [Magnetic survey 2026](https://onlinelibrary.wiley.com/doi/10.1111/cgf.70418) / [ferrofluid sim](https://dl.acm.org/doi/10.1145/3306346.3322973) (2019) | Steel ball bearings that the blob engulfs and that clack onto the magnet | M |
| Pour Sort | [Coupled bubbles](https://graphics.stanford.edu/papers/coupledbubbles/) + [Tube Maps](https://gatc.cs.columbia.edu/projects/tubemaps.html) (2026) | The **rising glug pitch** as the tube fills, from the air-column resonance plus bubble Minnaert tones; stream hits make bubbles | S |
| Goo Lab | [Shear-thickening model](https://www.researchgate.net/publication/283433549_Simulating_the_Dynamic_Behavior_of_Shear_Thickening_Fluids) | **Oobleck** material: punch-solid, poke-liquid | S–M |
| Jelly Stack / Merge | [Fast cutting with WoS](https://hoskillua.github.io/wos_cutting_siggraph26/) (2026) | Slice a gummy and both halves keep jiggling | M |
| Tear Sheet | [Paper tearing with sound](https://manteapi.github.io/pages/publications/tearing_MIG2015/index.html) + [persistent wrinkles](https://arxiv.org/pdf/2609.13707) (2026) | Rip sound from tear speed; crumpled velvet stays crumpled | S / M |
| Laundry Line | Dynamic Wrinkling on Coarse Cloth (SCA 2026, covered) | Flag-flap sound from edge velocity (a flutter pulse train) | S |
| Pull the Thread | [Curvature Space Editing of Highly-Coiled Hair](https://alvin.pizza/curvatureSpaceEditing/) (SIGGRAPH 2026) | Unravelled yarn keeps its stitch kink (rest curvature memory), so the pile looks like real frogged yarn | S–M |
| Spool Sort | Interactive yarn-level knitwear (SIGGRAPH 2026, covered) | (already being reworked) | — |
| Alchemy Sandbox | [The Powder Toy](https://github.com/The-Powder-Toy/The-Powder-Toy) air grid | **Pressure and velocity maps**: explosions shove powders, walls hold pressure, ambient heat. The thing that makes TPT feel physical | M |
| Dig Down | [Noita GDC](https://www.gdcvault.com/play/1025695/Exploring-the-Tech-and-Design) (2019; rework in progress) + [LBM-MPM air-water-sand](https://dl.acm.org/doi/10.1145/3811302) (2026) | Cohesion that rises with water saturation: damp soil holds walls, soaked soil slumps | S |
| Demolition Tower | [Fracture soundbanks](https://www.cs.cornell.edu/projects/FractureSound/files/fractureSound_comp.pdf) + [S4R](https://frank-zy-dou.github.io/projects/S4R/) (SA 2026) | Each brick fragment rings at its own size; S4R-style overlap scaling for spawned debris | S |
| Knockdown | [RealImpact](https://arxiv.org/pdf/2306.09944) calibrated modal banks | A tin can rings and rattles, a jar clinks at a higher pitch, a crate thuds, all modulated by impact point | S |
| Marbling Tray | Mixwell (shipped) | (none needed) | — |
| Power Rinse | [LBM-MPM air-water-sand](https://dl.acm.org/doi/10.1145/3811302) (2026) | Mud softens with wetting before it sheds (saturation-dependent cohesion) | S |
| Sand Jar | [Beverloo law](https://arxiv.org/pdf/1211.5916) | The funnel pours at a constant rate set by its neck; a wider neck is faster by the 5/2 power; grains jam (arch) when the neck is under about 5 grains wide | S |
| Peel It | [Tape screech, PRE 2026](https://journals.aps.org/pre/abstract/10.1103/p19h-9ysx) | Stick-slip pulse-train audio and haptics from glue-front speed | S |
| Mow Lines | No strong 2023–26 paper found | Keep it; maybe engine load → pitch sag (already) | — |
| Foundry | [DiffSound](https://arxiv.org/pdf/2409.13486) / Chladni modes (rework in progress) | Compute 2D plate modes of the cast silhouette (a small FEM or grid eigen-solve once per cast), so a bell-shaped casting rings like a bell | M |
| Invisible Ink | [Paper tearing sound](https://manteapi.github.io/pages/publications/tearing_MIG2015/index.html) (crackle stochastic model) | Char front crackle ∝ front length × speed | S |
| Kintsugi | [Magnetic rigid bodies](https://onlinelibrary.wiley.com/doi/10.1111/cgf.15185) (2024) + fracture soundbank | Shards pull in by a real dipole force and snap (not a lerp); each shard tinks at its own pitch when dropped | M |
| Fingerprint Dust | Native mic RMS | Actually blow the excess powder off | S |

---

## 3. Sandboxes whose *feel* comes from simulation, and inputs bobo doesn't use

### 3a. What makes them feel special (in simulation terms)

| Sandbox | What the sim does that makes it feel alive | Lesson for bobo |
|---|---|---|
| [The Powder Toy](https://github.com/The-Powder-Toy/The-Powder-Toy) | Separate **air pressure and velocity grids** that feed each other, plus per-particle heat conduction and ambient heat ([TPT wiki](https://powdertoy.co.uk/Wiki/W/Temperature.html)). Explosions are pressure, not a sprite | Alchemy and Dig Down have no air. Add a 64² pressure/velocity grid |
| [Noita](https://www.gdcvault.com/play/1025695/Exploring-the-Tech-and-Design) ([80.lv](https://80.lv/articles/noita-a-game-based-on-falling-sand-simulation)) | Every pixel simulated; **pixels know which rigid body owns them**, and cutting one re-marching-squares it into new bodies; 64² dirty-rect chunks | Dig Down's rework is right; Kintsugi and Knockdown could use pixel bodies too |
| [Teardown](https://80.lv/articles/teardown-developer-breaks-down-multiplayer-and-voxel-destruction-tech) | Voxel volumes make destruction exact: no mesh cutting, arbitrary holes, then structural collapse | A 2D pixel-body Demolition (break anywhere, not along baked Voronoi) |
| [Townscaper](https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making) | A constraint solver (WFC) answers each click with a surprising but fitting result; "a toy, not a game" | Tap-to-place that the system *resolves*. It fits a structural toy (e.g. an arch or dry-stone wall that settles) |
| [Universe Sandbox](https://universesandbox.com/blog/2025/03/universe-sandbox-2025-roadmap/) ([collision wiki](https://universesandbox.fandom.com/wiki/Collision)) | Unified collision: ejecta direction follows impact angle, and shockwaves run across surfaces | Knockdown and Demolition debris should inherit impact direction |
| [Sandspiel](https://maxbittker.com/making-sandspiel/) ([code](https://github.com/MaxBittker/sandspiel)) | A Rust CA plus a **GLSL stable-fluids wind layer** that particles ride | Alchemy could reuse Ink Swirl's fluid as wind (cheap, and bobo has both) |
| [Origami Simulator](https://origamisimulator.org/) | All creases fold at once; strain shown as colour | Show strain in Crumple & Crease |
| ASMR slicing/slime apps ([ASMR Slicing](https://apps.apple.com/tc/app/asmr-slicing/id1494458254), [Slime Simulator](https://apps.apple.com/us/app/slime-simulator-relaxing-asmr/id6449640960)) | Mostly canned mesh splits plus sampled crunch sounds with haptics. **The sound is the product**, and it is not simulated | bobo's edge is that the sound comes from the sim (§0). BladeMaster-cut kinetic sand in Goo Lab with grain-count crunch audio would outclass them |
| [Pocket Galaxy](https://apps.apple.com/us/app/pocket-galaxy-gravity-sandbox/id1248321746) | N-body on phone; flinging bodies into orbit | Gravity-slingshot interaction is untouched in bobo |

### 3b. Input channels

| Input | Status in bobo | Platform facts (verified) | Toys it unlocks |
|---|---|---|---|
| **Mic blowing** | Campfire and Prints "blow" appear to be gestures | Safari and Android web can read `getUserMedia` into an `AnalyserNode` ([webrtcHacks](https://webrtchacks.com/getusermedia-volume/)). **In a Capacitor iOS WKWebView the AnalyserNode gets silence** (128s/zeros); the fix is a native `AVAudioEngine` tap plugin that sends RMS to JS ([dev.to, Apr 2026](https://dev.to/felix_zeller_6f3c43a7513f/how-we-solved-ios-audio-analysis-for-breathwork-biofeedback-5lo)). bobo already has a native haptics plugin, so this is the same shape | Campfire embers, Fingerprint Dust, Snowflake (humidity), Ink Swirl jet, Bubble Wand, dandelion |
| **Gyro / tilt** | Splash Tank tilt | WKWebView gives device motion without `requestPermission` (Safari needs a gesture-gated prompt) ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent), [A-Frame issue](https://github.com/aframevr/aframe/issues/4508)) | Hourglass flip, Rainy Window, Sand Jar strata, Honey Drizzle angle, Pour Sort pour by tilting |
| **Shake** | none found | `devicemotion` acceleration spikes (same API) | Snow globe, Magnet Desk scatter, Chladni "reset" |
| **Two-finger twist / pinch** | multi-touch pointers exist | Standard pointer events | Snap! (twist before bend), jar lids, clay pinch, Singing Glass (circle) |
| **Long-press accumulation** | some | — | Lightning charge, wax heat, crystal growth |
| **Pressure** | — | **Not available**: 3D Touch was removed from iPhone 11 onward, and Haptic Touch cannot sense pressure ([Wikipedia](https://en.wikipedia.org/wiki/Force_Touch), [MacRumors](https://www.macrumors.com/guide/haptic-touch-vs-3d-touch-whats-the-difference/)). Use dwell time or speed as a pressure proxy instead | — |

---

## 4. TOP 10

Scored 1–5 on simulation novelty (N), authenticity (A: sound and look emerge from the sim and respond to *how* you touch), and satisfaction (S); divided by effort (S=1, S–M=1.5, M=2).

| # | Pick | N | A | S | Effort | Score | Why |
|---|---|:-:|:-:|:-:|:-:|:-:|---|
| 1 | **Minnaert bubble voice** in `sound.ts` → Pour Sort, Splash Tank, Ripple Pool rain, Power Rinse | 4 | 5 | 5 | S | 100 | Every liquid toy starts sounding like *that* liquid, and the pitch rises as the tube fills. Tiny code |
| 2 | **Chladni Plate** (new) | 5 | 5 | 4 | S | 100 | What you see *is* what you hear: the same eigenmode drives the sand and the tone. Novel on phones |
| 3 | **Peel It tape screech** (2026 PRE stick-slip) | 4 | 5 | 4 | S | 80 | Slow peel crackles, yank screams, and the haptics match. It's a 2026 finding |
| 4 | **Modal ring voice from shape** → Knockdown, Demolition, Kintsugi, Foundry | 4 | 5 | 5 | S–M | 67 | Shards and cans ring at their own sizes and materials. It fixes the audit's "decoration" critique across four toys |
| 5 | **Singing Glass** (stick-slip rim + water-level pitch) | 5 | 5 | 4 | S–M | 67 | A finger circling a rim is a natively tactile phone gesture. Tone lock-in emerges from the friction model. S is 4 because tuning the lock-in is a risk |
| 6 | **Hourglass** (Beverloo; flip the phone) | 3 | 5 | 4 | S | 60 | Constant-rate flow and crater cone are a real, famous granular fact. Reuses the sand CA plus gyro |
| 7 | **Plasma Globe / Lightning** (DBM) | 4 | 4 | 5 | S–M | 53 | Filaments seek your finger; crackle comes from branch events. Cheap GPU |
| 8 | **Crumple & Crease** (Crease Lab XPBD plasticity + Cirio buckling clicks) | 5 | 5 | 4 | M | 50 | Paper that remembers where you pressed, with a crinkle that comes from the buckles |
| 9 | **Snap!** (twist-then-bend rod fragmentation, Heisser 2018) | 5 | 5 | 4 | M | 50 | Two-finger twist changes whether it breaks in 2 or in 3+ pieces, a real physics surprise |
| 10 | **Honey Drizzle** (viscous thread coiling) | 5 | 5 | 4 | M | 50 | Height sets coil frequency by Ribe's regimes; drag makes sewing-machine meanders |

Runners-up: Snowflake with breath (needs the mic plugin), Magnet Desk (also fixes Kintsugi's click), Oobleck in Goo Lab, Powder Toy air grid for Alchemy, Rainy Window, dispersive Ripple Pool.

**Shared prerequisites:** (1) a modal/Minnaert resonator pool in `sound.ts` (it unlocks #1, #2, #3, #4, #6 and #7's sound); (2) a native mic-RMS Capacitor plugin (it unlocks breath across 5+ toys and has to be native on iOS).

---

## Sources

**Sound**
- Xue et al. 2023, Coupled Bubbles: https://graphics.stanford.edu/papers/coupledbubbles/ · code https://github.com/kangruix/FluidSound · https://dl.acm.org/doi/10.1145/3592424
- van den Doel 2005, liquid sounds: https://dl.acm.org/doi/abs/10.1145/1101530.1101554
- Sounding Liquids (UNC): http://gamma.cs.unc.edu/SoundingLiquids/
- Farnell, Designing Sound (Pd code): https://aspress.co.uk/sd/ · https://aspress.co.uk/sd/practical13.html
- Cirio et al. 2016, Crumpling Sound Synthesis: https://www.ccs.upm.es/research/publications/crumpling-sound-synthesis/
- Lejemble et al. 2015, paper tearing with sound: https://manteapi.github.io/pages/publications/tearing_MIG2015/index.html
- Screeching sound of peeling tape (PRE 2026): https://journals.aps.org/pre/abstract/10.1103/p19h-9ysx · https://phys.org/news/2026-02-screech-sticky-tape-conceals-rapid.html · https://www.earth.com/news/science-explains-why-removing-adhesive-tape-makes-that-unbearable-squeaky-noise/
- Zheng & James 2010, fracture sound: https://www.cs.cornell.edu/projects/FractureSound/files/fractureSound_comp.pdf
- DiffSound 2024: https://arxiv.org/pdf/2409.13486 · RealImpact 2023: https://arxiv.org/pdf/2306.09944 · Deep-Modal: https://dl.acm.org/doi/abs/10.1145/3394171.3413572 · NeuroSonic 2026: https://onlinelibrary.wiley.com/doi/10.1002/cav.70162
- modal-synthesis (npm): https://www.npmjs.com/package/modal-synthesis
- Bowl resonators: https://ccrma.stanford.edu/~carmenng/250b/icmc2002.pdf · https://arxiv.org/pdf/1106.5657
- Friction sound models: https://www.researchgate.net/publication/252729141_The_sound_of_friction_Real-time_models_playability_and_musical_applications
- Acoustic Reliefs (SA 2025, not needed): https://cdl.ethz.ch/publications/acoustic-reliefs/

**Simulation**
- Chladni: https://arxiv.org/pdf/1308.5523 · https://github.com/luciopaiva/chladni · https://github.com/schroffl/chladni-simulation
- Origami Simulator: https://origamisimulator.org/ · https://github.com/amandaghassaei/OrigamiSimulator
- Crease Lab: https://github.com/lukacslacko/origami
- Persistent wrinkles 2026: https://arxiv.org/pdf/2609.13707
- Discrete Viscous Threads: http://www.cs.columbia.edu/cg/pdfs/171-threads.pdf · Ribe coiling: https://www.researchgate.net/publication/6524917_Dynamics_of_liquid_rope_coiling
- Heisser et al. 2018: https://www.pnas.org/doi/10.1073/pnas.1802831115 · https://phys.org/news/2018-08-mathematicians-age-old-spaghetti-mystery.html
- Beverloo / hourglass: https://arxiv.org/pdf/1211.5916 · https://arxiv.org/pdf/2104.08186 · https://www.nature.com/articles/ncomms15551
- Lightning / Laplacian growth: http://gamma.cs.unc.edu/FRAC/laplacian_large.pdf · https://gamma.cs.unc.edu/FAST_LIGHTNING/lightning_tvcg_2007.pdf
- Snow crystals: https://arxiv.org/pdf/0711.4020 · https://github.com/sitara-systems/first-snow · https://www.ibiblio.org/e-notes/webgl/snow/snowflake.htm
- Magnets: https://onlinelibrary.wiley.com/doi/10.1111/cgf.15185 · https://rtg.hufs.ac.kr/publications/SIGGRAPHASIA22.pdf · https://onlinelibrary.wiley.com/doi/10.1111/cgf.70418 · ferrofluids https://dl.acm.org/doi/10.1145/3306346.3322973
- Droplets on glass: https://www.researchgate.net/publication/3422696_Real-time_simulation_Water_droplets_on_glass_windows · https://www.researchgate.net/publication/268438621_Animation_of_Water_Droplets_on_a_Hydrophobic_Windshield
- Shear thickening: https://www.researchgate.net/publication/283433549_Simulating_the_Dynamic_Behavior_of_Shear_Thickening_Fluids · https://arxiv.org/pdf/2311.13759
- Wax MPM: https://arxiv.org/pdf/2101.12408
- Mixed MPM (SIGGRAPH 2026): https://research.nvidia.com/labs/prl/mixed_mpm/
- WoS cage cutting (SIGGRAPH 2026): https://hoskillua.github.io/wos_cutting_siggraph26/
- Soap film vortex particle-on-mesh (2024): https://taoningxiao.github.io/
- Two-phase immiscible (SA 2026): https://www.physicsbasedanimation.com/2026/09/17/a-unified-multi-scale-method-for-simulating-two-phase-immiscible-flows/
- S4R (SA 2026): https://frank-zy-dou.github.io/projects/S4R/
- Curvature Space Editing of Coiled Hair (SIGGRAPH 2026): https://alvin.pizza/curvatureSpaceEditing/
- Dispersive shallow water 2023: https://d1qx31qr3h6wln.cloudfront.net/publications/Dispersive_Waves_in_a_Shallow_Water_Framework.pdf · Hybrid ocean 2025: https://arxiv.org/abs/2511.02852 · Hamiltonian waves/3D 2026: https://arxiv.org/abs/2608.25203
- LBM-MPM air-water-sand (SIGGRAPH 2026): https://dl.acm.org/doi/10.1145/3811302
- Tube Maps (SIGGRAPH 2026): https://gatc.cs.columbia.edu/projects/tubemaps.html
- Bubble wrap: https://en.wikipedia.org/wiki/Bubble_wrap · https://techxplore.com/news/2025-10-enable-power-free-acoustic.html
- Paper indexes checked: https://kesen.realtimerendering.com/sig2026.html · https://www.realtimerendering.com/kesen/sig2025.html · https://www.realtimerendering.com/kesen/siga2025Papers.htm · https://kesen.realtimerendering.com/eg2026Papers.htm · https://www.physicsbasedanimation.com/2026/05/29/siggraph-2026/ · https://www.physicsbasedanimation.com/2026/09/08/siggraph-asia-2026/ · https://kesen.realtimerendering.com/sca2025-Changelog.htm

**Sandboxes and inputs**
- The Powder Toy: https://github.com/The-Powder-Toy/The-Powder-Toy · https://powdertoy.co.uk/Wiki/W/Temperature.html
- Noita GDC: https://www.gdcvault.com/play/1025695/Exploring-the-Tech-and-Design · https://80.lv/articles/noita-a-game-based-on-falling-sand-simulation
- Teardown: https://80.lv/articles/teardown-developer-breaks-down-multiplayer-and-voxel-destruction-tech
- Townscaper: https://www.gamedeveloper.com/game-platforms/how-townscaper-works-a-story-four-games-in-the-making
- Universe Sandbox: https://universesandbox.com/blog/2025/03/universe-sandbox-2025-roadmap/ · https://universesandbox.fandom.com/wiki/Collision
- Sandspiel: https://maxbittker.com/making-sandspiel/ · https://github.com/MaxBittker/sandspiel
- ASMR apps: https://apps.apple.com/tc/app/asmr-slicing/id1494458254 · https://apps.apple.com/us/app/slime-simulator-relaxing-asmr/id6449640960 · Pocket Galaxy https://apps.apple.com/us/app/pocket-galaxy-gravity-sandbox/id1248321746
- Mic in WKWebView: https://dev.to/felix_zeller_6f3c43a7513f/how-we-solved-ios-audio-analysis-for-breathwork-biofeedback-5lo · https://webrtchacks.com/getusermedia-volume/
- Device motion: https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent · https://github.com/aframevr/aframe/issues/4508
- No pressure on iPhone: https://en.wikipedia.org/wiki/Force_Touch · https://www.macrumors.com/guide/haptic-touch-vs-3d-touch-whats-the-difference/

*Unverified or weak: "Vibrational Affine Body Dynamics" (SIGGRAPH Asia 2026) has no public page yet; the tape-screech numbers (450–600 m/s, 37k pulses/s) come from press summaries, not the paper PDF; Beverloo arching at about 5 grain widths is the usual rule of thumb, not checked here; no Ten Minute Physics episode after #25 found.*
