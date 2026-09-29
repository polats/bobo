*2026-09-30. Written by a cloud research agent (web search was unavailable to it too, so it fetched conference indexes, arXiv, lab pages and MDN directly). Companion to [2026-gaps.md](2026-gaps.md).*

# Bobo research: simulation papers, sandbox apps and new inputs for new toys (2023–2026)

**How the links were checked:** the web-search tool hit its session limit (200 calls) on my first query, so I couldn't search in the usual way. I built the list from conference programme pages (realtimerendering.com/kesen), the arXiv API, lab publication pages and my own knowledge of the field. Nearly every URL below was then fetched directly and loaded (HTTP 200 or a fetched summary).
- **(DOI†)** means an ACM DOI that exists but blocks automated fetching (403), so I couldn't load it.
- **(no URL)** means I found no source I could fetch; the physics is standard but uncited.
- Effort is S (days), M (1–2 weeks) or L (3+ weeks). Feasibility assumes WebGL2 or Canvas on an iPhone 13 mini at 60 fps.

---

## 1. Papers and demos bobo is missing

### A. Sound that comes out of the simulation (upgrades to the existing audio layer)

| Item | URL | Year | What it simulates | Bobo toy or upgrade | Phone feasibility | Effort |
|---|---|---|---|---|---|---|
| **Improved Water Sound using Coupled Bubbles** (Xue, James et al., SIGGRAPH) | https://graphics.stanford.edu/papers/coupledbubbles/ | 2023 | Bubble clouds as coupled Minnaert oscillators, which gives the low \"glug\" of many bubbles together | **Upgrade for Splash Tank, Pour Sort and Ripple Pool.** When a particle pierces the free surface fast enough, spawn a bubble of radius r. Its tone is f ≈ 3.26 m·Hz / r with a rising chirp as it nears the surface. Clusters are pulled lower in pitch. Pouring faster makes more, bigger bubbles, so the audio \"glugs\". | Very cheap: a damped-sine bank of about 64 voices in an AudioWorklet. Skip the paper's GPU wave solver and keep only the oscillator model. | S |
| Sounding Liquids (Moss, Lin et al.) | https://gamma.cs.unc.edu/SoundingLiquids/ | 2010 | Real-time bubble sound from a fluid simulation's surface curvature | A cheaper heuristic for the same upgrade | Trivial | S |
| Toward Animating Water with Complex Acoustic Bubbles (Langlois, Zheng, James) | http://www.cs.cornell.edu/projects/Sound/bubbles | 2016 | Bubble frequency shifts by shape and wall proximity, plus Helmholtz-resonator popping | Popping bubbles in the Foam and Soap Film toys below; a pitch shift near the tank wall | Trivial | S |
| van den Doel, \"Physically-based models for liquid sounds\" (ACM TAP) | http://persianney.com/kvdoelcsubc/publications/tap05.pdf | 2005 | Real-time stochastic bubble synthesis | The reference for the bubble-bank implementation | Trivial | S |
| **Crumpling Sound Synthesis** (Cirio, Li, Grinspun, Otaduy, Zheng, SIGGRAPH Asia) | https://www.cs.columbia.edu/cg/crumpling/ | 2016 | Detects buckling events in a thin shell and turns each into a modal click | **Upgrade for Tear Sheet, Peel It and Laundry Line.** When a dihedral angle snaps through a threshold, send an impulse, scaled by angular velocity, into a small modal bank. You hear every crease form. | Cheap: per-triangle-pair angle check in the cloth pass | S |
| Motion-Driven Concatenative Synthesis of Cloth Sounds (An, James, Marschner) | https://www.cs.cornell.edu/projects/Sound/cloth | 2012 | Cloth rustle split into crumple and friction parts | **Upgrade for Laundry Line.** Friction noise from the sliding rate of cloth–cloth and cloth–peg contacts, plus crumple grains from the event above. Use procedural noise grains, or ship about 30 short recorded micro-grains. | Cheap | S |
| Rigid-Body Fracture Sound (Zheng, James) | https://www.cs.cornell.edu/projects/FractureSound/ | 2010 | Fracture debris sound from precomputed soundbanks | **Upgrade for Knockdown and Kintsugi:** each shard gets modal frequencies scaled by its size | Cheap | S |
| **Acoustic Emission from Breaking a Bamboo Chopstick** (PRL) | https://arxiv.org/abs/1509.00631 | 2015/16 | Crackle before a break follows earthquake statistics (Gutenberg–Richter, Omori) | **Upgrade for any breaking toy.** As load rises, emit micro-cracks whose sizes follow a power law and whose rate accelerates, so the object warns you before it goes. This is the anticipation signal. | Trivial | S |
| Animating Fire with Sound (Chadwick, James) | https://www.cs.cornell.edu/projects/Sound/fire/ | 2011 | Combustion noise driven by the flame simulation | **Upgrade for Campfire.** Low roar ∝ fuel burn rate, turbulence band-noise from vorticity, and pops when a CPU fuel cell exhausts. Mic-blowing makes it roar. | Cheap | S |
| Synthesizing Contact Sounds Between Textured Models (Ren, Lin) | https://gamma.cs.unc.edu/SlidingSound/ | 2010 | Sliding and rolling sound from surface texture | Scraping in Dig Down and Power Rinse; rolling marbles | Cheap | S |
| Fast Differentiable Modal Simulation of Non-linear Strings, Membranes and Plates | https://arxiv.org/abs/2505.05940 | 2025 | Tension-modulated (nonlinear) modal strings: pitch glides and twang | **Upgrade for Spool Sort and Pull the Thread:** plucked yarn and thread \"twang\" with pitch that depends on tension | Modal step is cheap on CPU | M |
| Differentiable Modal Synthesis for planar string sound | https://arxiv.org/abs/2407.05516 | 2024 | Same family as above | Same | Same | M |
| WaveBlender (SIGGRAPH Asia) | https://graphics.stanford.edu/papers/waveblender/ | 2024 | High-quality sound-source animation | Offline only. Useful as a reference, not something to ship. | No | — |

### B. Foam, bubbles, films, membranes

| Item | URL | Year | What it simulates | Bobo toy | Phone feasibility | Effort |
|---|---|---|---|---|---|---|
| **A Model for Soap Film Dynamics with Evolving Thickness** (Ishida, Wojtan et al., SIGGRAPH) | https://sadashigeishida.bitbucket.io/soapfilm_with_thickness/index.html | 2020 | Film thickness as a degree of freedom: drainage, evaporation, rainbow interference colours, thickness-driven rupture | **New toy: \"Bubble Wand\".** A 2D thickness field on a wand disc. Gravity drains it into horizontal colour bands and Marangoni swirls follow your finger. Blowing into the mic bulges the film into a bubble. It pops when thickness drops too low, the rim retracts and you hear a Helmholtz pop. The colours are real thin-film interference computed from the thickness. | 2D grid of about 256² in WebGL2; interference is a per-pixel lookup | M |
| **Foam Mechanics at the Bubble Scale** (Durian bubble model, PRL) | https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.75.4780 | 1995 | Foam as soft overlapping discs | **New toy: \"Foam Raft\"** (beer head or dish foam). A few thousand soft discs. Gas diffuses from small bubbles to large ones, so the foam coarsens. Pushing it makes neighbours swap places (T1 events) and each swap ticks. Bubbles pop from the top with Minnaert crackle. Tilting drains the liquid. | 2–4k discs on CPU with a spatial hash (see Ten Minute Physics #11) | S–M |
| Differentiable Voronoi Diagrams for Cell-Based Mechanical Systems | https://arxiv.org/abs/2404.18629 | 2024 | Foams and tissues as Voronoi cells | A crisper, polygonal look for Foam Raft | 2D, CPU | M |
| **Mechanics of Pressurized Cellular Sheets** (J. R. Soc. Interface) | https://arxiv.org/abs/2409.12863 | 2024/25 | Why bubble wrap stiffens with internal pressure | **New toy: \"Bubble Wrap\".** Each cell is a pressure soft body (Matyka, below). Squeeze rate and contact area set how fast pressure rises, and a burst threshold decides the pop. A slow squeeze can pop it quietly; a fast one bangs. Popping one cell softens the sheet around it. | Cheap: about 100 cells × 16 nodes | S |
| Pressure Model of Soft Body Simulation (Matyka) | https://arxiv.org/abs/physics/0407003 | 2004 | Soft bodies with gas pressure | Base model for Bubble Wrap and a mic-inflated **Balloon** | Trivial | S |

### C. Rods, threads, knots, snapping

| Item | URL | Year | What it simulates | Bobo toy or upgrade | Phone feasibility | Effort |
|---|---|---|---|---|---|---|
| **Stable Cosserat Rods** (Hsu et al., SIGGRAPH) + YarnBall GPU code | https://jerryhsu.io/projects/StableCosseratRods/ · https://github.com/jerry060599/YarnBall | 2025 | Robust bending and twisting of rods; demos include hair, trees, yarn, slingshots and bridges | **Solver upgrade for Pull the Thread and Spool Sort** (the paper claims it is much faster and more stable than XPBD rods). It is also the base for Spaghetti Snap and a \"Twig Bend\" toy. | Gauss–Seidel per segment; hundreds to thousands of segments on CPU | M |
| **Fragmentation of Rods by Cascading Cracks: why spaghetti doesn't break in half** (Audoly, Neukirch, PRL) | https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.95.095505 | 2005 | After the first break, the snap-back wave overloads the rod and causes more breaks | **New toy: \"Spaghetti Snap\".** Bend a bundle of dry spaghetti with two fingers. Each strand is a rod with a curvature fracture limit, and the flexural wave after the first break really does make 3+ pieces fly apart. It uses the chopstick-crackle pre-break sound and a modal \"tik\" for each piece. | 1D rods of about 64 nodes × 20 strands; cheap | S–M |
| Controlling Fracture Cascades through Twisting and Quenching (Heisser, Dunkel et al.) | https://arxiv.org/abs/1802.05402 | 2018 | Twisting before bending makes spaghetti break in exactly two | **Hidden mechanic in Spaghetti Snap:** twist first (two-finger rotate) and it breaks cleanly in two. This is the kind of discovery that should come out of the sim itself. | Adds a twist degree of freedom to the rod | +S |
| **Coiling instability in the kitchen** (Physics of Fluids) | https://arxiv.org/abs/2501.08307 | 2025 | Honey or syrup coiling as it falls | **New toy: \"Honey Drizzle\".** Drag a spoon over toast or a pancake. The viscous thread coils, meanders or draws figure-8s depending on drop height and drag speed. The patterns come from the sim, not from art. | One viscous rod of about 200 nodes + a deposition trail; cheap | M |
| A Numerical Investigation of the Fluid Mechanical Sewing Machine (Brun, Ribe, Audoly) | https://arxiv.org/abs/1201.1378 | 2012 | Thread on a moving belt: 9 of 10 lab patterns reproduced; frequencies lock to simple ratios | Phase diagram to tune Honey Drizzle's dragging, including \"alternating loops\" | — | — |
| Discrete geometric approach for thin viscous threads (Audoly et al.) | https://arxiv.org/abs/1202.4971 | 2012 | Discrete viscous rods | Implementation reference for Honey Drizzle | — | — |
| Tencers: Tension-Constrained Elastic Rods (EPFL, SIGGRAPH Asia) | https://infoscience.epfl.ch/entities/publication/d78a8e72-c425-4d3a-bb28-9800226dbe4d | 2024 | Rods held under strings: deployable, bistable shapes | Possible \"string art that pops into 3D\" toy; lower priority | CPU | M |

### D. Crumpling, folding, fracture, clay, melting

| Item | URL | Year | What it simulates | Bobo toy or upgrade | Phone feasibility | Effort |
|---|---|---|---|---|---|---|
| **Cloth Animation with Time-dependent Persistent Wrinkles** (Gong, Yang, Shao, Wang) | https://arxiv.org/abs/2502.13491 | 2025 | Creases that recover if released quickly but become permanent if held | **Upgrade for Tear Sheet and Laundry Line:** plastic rest-angle drift ∝ how long a fold is held. Pinch and hold, and the crease stays. | Adds a per-edge rest-angle update; cheap | S |
| Q3T Prisms: solid-shell element for elastoplastic surfaces (ETH, SIGGRAPH Asia) | listed on https://www.realtimerendering.com/kesen/siga2024Papers.htm | 2024 | Crumpled metal and foil | **\"Foil Ball\"**: crush and re-flatten foil, with creases that persist and crinkle-click sound. Full 3D shells are heavy; a 2.5D height-field crease approximation is realistic. | Full method no; approximation yes | L |
| **Origami Simulator** (Ghassaei, 7OSME) | https://origamisimulator.org/ | 2018 | GPU folding of every crease at once, with a strain heatmap | **New toy: \"Paper Fold\".** Drag the corners of a Miura-ori or waterbomb sheet. It snaps flat to folded in one motion, strain shows red, and folds click. | Already runs in WebGL fragment shaders | M |
| **Uniformly Deployable Kirigami on Arbitrary Planar Graphs** (ETH, SIGGRAPH) | https://igl.ethz.ch/projects/tuttekiri/ · https://github.com/segaviv/tuttekiri | 2026 | Hinged cut sheets that open uniformly | **New toy: \"Kirigami Stretch\".** Pinch-stretch a cut sheet: tiles rotate, it expands sideways as you pull (auxetic), and snaps between states. Simulate as 2D rigid tiles + hinge constraints (XPBD). | 2D; cheap | S–M |
| IsoGami: rigid-deployable kirigami from isohedral tilings | https://thomaszewski.com/projects/isogami/index.html | 2026 | More kirigami patterns | Extra levels for Kirigami Stretch | — | — |
| **Breaking Good: Fracture Modes for Realtime Destruction** (Sellán, Jacobson et al., TOG) | https://arxiv.org/abs/2111.05249 | 2023 | Precomputed fracture modes; cracks depend on where you hit | **Upgrade for Knockdown and Kintsugi:** replace baked Voronoi with impact-dependent fracture, so hitting the rim or the centre breaks differently | Precompute offline, cheap at runtime | M |
| **Implicit Bonded Discrete Element Method** (Lu, Hu et al., TOG / SIGGRAPH Asia 2025) | https://arxiv.org/abs/2308.10459 | 2025 | Bonded particles that crack and crumble; 2.8–12× faster than prior methods | **New toy: \"Snap Bar\".** Chocolate squares, a biscuit or chalk snaps along scored grooves and leaves crumbs. Uses the pre-break crackle and modal snap. | 2D BDEM of about 3–5k particles on CPU or WebGL2 | M |
| **XPBI: position-based dynamics handles continuum inelasticity** (SIGGRAPH Asia) | https://arxiv.org/abs/2405.11694 | 2024 | Clay, dough, sand and snow plasticity inside PBD | **New toy: \"Pottery Wheel\" or \"Dough\".** Spin the wheel and press with a finger: the wall thins and rises, and pressing too hard or too long makes it wobble and collapse. Fits bobo's existing PBD code. | 2D axisymmetric or 2.5D; cheap-ish | M |
| Vertex Block Descent (SIGGRAPH) / **Augmented VBD** (SIGGRAPH) | https://graphics.cs.utah.edu/research/projects/vbd/ · https://graphics.cs.utah.edu/research/projects/avbd/ (browser demo: https://graphics.cs.utah.edu/research/projects/avbd/avbd_demo2d.html) | 2024 / 2025 | Unconditionally stable, parallel solver; AVBD adds hard constraints and rigid stacks | **Solver upgrade for Jelly Stack, Jelly Merge and Demolition Tower.** A 2D JS demo already exists to borrow from. | Yes; 2D demo runs in the browser | M |
| Augmented MPM for Phase Change (Stomakhin et al., Disney) | https://www.disneyanimation.com/publications/augmented-mpm-for-phase-change-and-varied-materials/ | 2014 | Melting and solidifying in MPM | **New toy: \"Candle\" or \"Wax\".** Goo Lab's MLS-MPM plus heat: the wax pool melts around the flame, drips run and freeze into stalactites, and blowing (mic) sputters the flame. | WebGPU (Goo Lab path) | M |
| FlameForge: combustion of wooden structures (SCA) | https://arxiv.org/abs/2412.16735 | 2025 | Wood charring, mass loss and collapse | **Upgrade for Campfire:** logs char, crack and collapse, with sparks | CPU grid | M |
| An Incompressible Crack Model for Volume-Preserving MPM Fracture (I3D) | listed on https://www.realtimerendering.com/kesen/i3d2025Papers.htm | 2025 | MPM fracture without volume gain | Tearing jelly in Goo Lab | WebGPU | M |

### E. Fluids, vortices, vibrating surfaces

| Item | URL | Year | What it simulates | Bobo toy or upgrade | Phone feasibility | Effort |
|---|---|---|---|---|---|---|
| **Hidden Degrees of Freedom in Implicit Vortex Filaments** (Ishida, Wojtan, Chern, SIGGRAPH Asia) | https://arxiv.org/abs/2206.02008 | 2022 | Smoke rings as vortex filaments | **New toy: \"Smoke Rings\".** Flick or puff into the mic to fire a vortex ring carrying tracer smoke. Two rings leapfrog, bounce off walls and reconnect, all from the Biot–Savart law. The whoosh scales with ring strength. | A few hundred filament segments + 20–50k tracers advected in WebGL2; very feasible | M |
| Fluid Simulation on Vortex Particle Flow Maps (SIGGRAPH) | https://vpfm.sinanw.com/ | 2025 | Vortex rings and leapfrogging with high fidelity | Visual reference and ground truth for Smoke Rings | Offline | — |
| **Chladni plates**: \"Numerical Chladni figures\" / ChladniSonify | https://arxiv.org/abs/1308.5523 · https://arxiv.org/abs/2605.09846 | 2013 / 2026 | Sand collecting on the nodal lines of a vibrating plate | **New toy: \"Chladni Plate\".** Tap, bow along the edge, or sing into the mic. The existing modal-synthesis layer drives a plate, and 20k grains hop in proportion to the local mode amplitude, so they gather on the nodal lines of the modes that are actually sounding. What you hear is exactly what moves the sand. | Precomputed plate modes as textures + particles; trivial | S |
| **Walking droplets / pilot-wave hydrodynamics** | https://arxiv.org/abs/2510.25073 | 2025 | Droplets bouncing on a vibrated bath, guided by their own waves | **Upgrade for Ripple Pool.** Hold to vibrate the bath (Faraday waves appear above a threshold). Drop beads: they bounce, then \"walk\", orbit and pair up. | Existing height field + a bounce model; cheap | M |
| **Tibetan Singing Bowls** (Terwagne, Bush) | https://arxiv.org/abs/1106.6348 | 2011 | Rim friction excites modes; the water inside forms Faraday ripples and spray | **New toy: \"Singing Bowl\".** Circle the rim with your finger. A stick-slip friction model feeds a modal resonator, the pitch builds, and the water inside ripples and eventually sprays. Adding water changes the pitch. | Modal + height field; cheap | M |
| A Unified Particle-Based Solver for Non-Newtonian Behaviors | https://arxiv.org/abs/2312.04814 | 2023 | Shear-thickening, shear-thinning and viscoplastic fluids | **Upgrade for Goo Lab: oobleck and slime.** A fast punch bounces off, a slow finger sinks; slime stretches, necks and snaps back. | WebGPU MLS-MPM path already exists | M |
| Multiphase Viscoelastic Non-Newtonian Fluid Simulation (SCA) | https://webspace.science.uu.nl/~telea001/PAPERS/PAPERS | 2024 | Viscoelastic multiphase fluids | Same upgrade | — | M |
| Oobleck background | https://en.wikipedia.org/wiki/Oobleck | — | — | — | — | — |
| Cyclogenesis (SIGGRAPH 2024) / Thunderscapes (I3D 2025) | https://computationalsciences.org/publications/amador-herrera-2024-cyclogenesis.html · https://arxiv.org/abs/2412.00703 | 2024 / 2025 | Tornadoes and storms | Probably too heavy; a 2D \"dust devil\" in Ink Swirl at most | Low | L |

### F. Granular flow and erosion

| Item | URL | Year | What it simulates | Bobo toy | Phone feasibility | Effort |
|---|---|---|---|---|---|---|
| **The granular silo as a continuum plastic flow: hour-glass vs clepsydra** | https://arxiv.org/abs/1211.5916 | 2012 | Hourglass flow rate that doesn't depend on fill height (unlike water) | **New toy: \"Hourglass\".** Physically flip the phone (gyro). A steady stream falls, a cone forms at the angle of repose, and a crater dimples the top. Sand gives a steady hiss where water would glug: switch the medium to hear the difference. | Reuse the Sand Jar CA or Goo Lab sand | S |
| **Sebastian Lague Hydraulic Erosion** (code + playable demo) | https://github.com/SebLague/Hydraulic-Erosion · https://sebastian.itch.io/hydraulic-erosion | 2019 | Droplet-based erosion on a height map | **New toy: \"Sand Table River\".** Tilt the phone and pour water from a fingertip. Channels carve, meanders migrate, deltas fan out, and banks collapse. | 256² shallow water + sediment in WebGL2 | M |
| Unerosion: terrain evolution back in time (SCA) | https://www.lix.polytechnique.fr/vista/vista-member/marie-paule_cani/ | 2024 | Reverse erosion | A novel \"rewind\" gesture for Sand Table River | — | — |
| Zen rake garden (height-field sand with angle of repose, after Sumner 1998) | (no URL) | — | Raked grooves that avalanche | Small \"Zen Garden\" toy; the rake scrape sound follows groove depth | Trivial | S |
| Kinetic sand (cohesive Drucker–Prager MPM; Klár et al. 2016) | DOI† 10.1145/2897824.2925906 | 2016 | Cohesive sand you can cut into slices | **Goo Lab mode: slice kinetic sand**, the #1 ASMR format, with clean shear faces | WebGPU | M |

### G. Electricity, magnetism, crystals

| Item | URL | Year | What it simulates | Bobo toy | Phone feasibility | Effort |
|---|---|---|---|---|---|---|
| **Fractal Dimension of Dielectric Breakdown** (Niemeyer et al., PRL; the DBM) | https://journals.aps.org/prl/abstract/10.1103/PhysRevLett.52.1033 | 1984 | Branching discharge growing along the electric potential | **New toy: \"Plasma Globe\".** Streamers grow toward your finger (your finger is the ground), branch and flicker, and crackle when they grow. **Also a \"Lichtenberg\" mode for Invisible Ink:** fractal burns spreading over wood using the existing char grid. | Laplace solve on a 128² grid + growth; cheap | S |
| Physically Based Animation and Rendering of Lightning (Kim, Lin) | https://gamma.cs.unc.edu/LIGHTNING/ | 2004 | DBM lightning with a glow-rendering kernel | Rendering reference for the glow | Cheap | — |
| Lichtenberg figure | https://en.wikipedia.org/wiki/Lichtenberg_figure | — | — | — | — | — |
| **Strongly Coupled Simulation of Magnetic Rigid Bodies** (RWTH, SCA) | https://animation.rwth-aachen.de/publication/0590/ | 2024 | Strong magnets that snap together stably | **New toy: \"Magnet Beads\".** Ferrite beads chain, ring and snap together with a clack. Iron-filing field lines are drawn from the dipole field. | 2D, about 50 beads with pairwise dipoles; cheap | M |
| **Modeling snow crystal growth III** (Gravner, Griffeath) | https://arxiv.org/abs/0711.4020 | 2008 | Diffusion-limited snowflake growth on a hex grid | **New toy: \"Frost Window\".** Breathe on the glass (mic) to fog it. Frost dendrites grow from scratches you draw, a warm fingertip melts them, and they regrow differently each time. | Hex cellular automaton in WebGL2; cheap | S–M |

---

## 2. Sandbox toys and apps people love, and what makes them feel good

| Toy or app | URL | What makes the feel special, in simulation terms | Lesson for bobo |
|---|---|---|---|
| **The Powder Toy** | https://powdertoy.co.uk/ | A hidden **air-pressure and velocity grid** plus **heat** under the particles; electricity sparks travel through conductors | Add an air or pressure layer under Alchemy Sandbox so explosions push gas and sand around |
| **Sandspiel** (Max Bittker; Rust/WASM + WebGL) | https://github.com/MaxBittker/sandspiel · https://maxbittker.com/making-sandspiel/ | A **wind fluid layer (Pavel's WebGL fluid) under the sand CA**: leaves blow, dust drifts. Simple rules with rich interactions; under 1 ms rendering; no complex gestures on touch. | Drive Alchemy Sandbox and Sand Jar with a stable-fluids wind layer controlled by **mic blowing** |
| **Sandboxels** (R74n) | https://sandboxels.r74n.com/ | 500+ elements with heat, electricity, density, cooking and reactions; mobile-friendly | The breadth comes from temperature-driven phase changes (ice → water → steam) |
| **Powder Game** (Dan-Ball) | https://dan-ball.jp/en/javagame/dust/ | The original: particles advected by an air field; wind and \"fan\" tools | Same as above |
| **Noita** (GDC 2019 talk by Petri Purho) | https://www.noitagame.com/ · https://www.gdcvault.com/play/1025695/Exploring-the-Tech-and-Design | Every pixel simulated, and loose pixels **recombined into rigid bodies** | Dig Down already does this; extend it so liquids push rigid bodies (buoyancy) |
| **Teardown** (Voxagon) | https://teardowngame.com/ · https://blog.voxagon.se/2020/11/05/teardown-design-notes.html | Destruction as the core mechanic, not decoration; voxel bodies break under their own weight | Structural collapse in Demolition Tower should come from load paths, not only impacts |
| **Townscaper** (Oskar Stålberg) | https://store.steampowered.com/app/1291340/Townscaper/ | Not a physics sim: an irregular grid plus constraint solving means every tap produces an instant, readable result | Response under 50 ms and \"every poke is pretty\" are the bar |
| **Tiny Glade** | https://store.steampowered.com/app/2198150/Tiny_Glade/ | Procedural walls that self-organise as you drag them | Continuous drag produces continuous emergent form |
| **Universe Sandbox** | https://universesandbox.com/ | N-body gravity, collisions and material and climate properties; \"a child with a magnifying glass\" destruction joy | A possible 2D **\"Orbit Toy\"**: flick moons, get Roche-limit breakup into rings. Barnes–Hut on CPU. S–M. |
| **Algodoo** | https://www.algodoo.com/ | Draw a shape and it becomes physical; water, lasers and optics, hinges | \"Draw it, then it's physical\" as an input mode |
| **Pavel Dobryakov WebGL Fluid** | https://paveldogreat.github.io/WebGL-Fluid-Simulation/ | Stable fluids + bloom; runs on mobile | Already the Ink Swirl class |
| **Grant Kot: Liquid Layers** | https://grantkot.com/ | Mobile MPM liquids **driven by the accelerometer** | Proof that tilt-driven MPM feels great on phones |
| **WebGPU-Ocean** (MLS-MPM, 100k–300k particles) | https://github.com/matsuoka-601/WebGPU-Ocean · https://webgpu-ocean.netlify.app/ | Fixed-point atomics for particle-to-grid transfer; screen-space fluid rendering | Reference for Splash Tank performance |
| **AVBD 2D/3D browser demos** | https://graphics.cs.utah.edu/research/projects/avbd/ | Stacks with no jitter at low iteration counts | Candidate solver swap for Demolition Tower |
| **Origami Simulator** | https://origamisimulator.org/ | Fold-percent slider plus live strain colouring | See Paper Fold above |
| **Ten Minute Physics** (Müller): 25 web demos | https://matthias-research.github.io/pages/tenMinutePhysics/index.html | Cloth, self-collision, FLIP, height-field water, fire, PBD rigid bodies, joints; all tiny JavaScript | Ready starting code for rods, joints and hashing |

**Oddly-satisfying, slime and kinetic-sand apps:** I could not fetch app-store pages for specific titles. The recurring hooks are:
- slicing kinetic sand or soap, which needs cohesion and clean shear faces;
- slime stretching and poking, which needs viscoelastic necking and air-pocket pops;
- pressure washing, which bobo already has in Power Rinse;
- popping bubble wrap.

Each of these works because the sound is tied to the deformation event, which is exactly what section A adds.

### Interaction inputs bobo isn't using yet

| Input | Web API (verified MDN links) | Best toys for it | Notes |
|---|---|---|---|
| **Mic blow** | [getUserMedia](https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia) | Bubble Wand, Smoke Rings, Frost Window, Campfire and Candle, Sandspiel-style wind, Balloon | Detect a blow as loud low-frequency broadband noise with high spectral flatness. Turn off echo cancellation and noise suppression. Needs a permission prompt. |
| **Mic pitch or singing** | same | Chladni Plate, Singing Bowl, Ripple Pool Faraday waves | Detected pitch drives the matching plate mode, so sound becomes pattern |
| **Gyro and tilt** | [DeviceMotionEvent.requestPermission](https://developer.mozilla.org/en-US/docs/Web/API/DeviceMotionEvent/requestPermission_static) | Hourglass (flip), Sand Table River, Pour Sort, Foam Raft draining | iOS 13+ needs a tap to grant permission |
| **Shake** | devicemotion acceleration | Snow globe in Goo Lab, soda fizz and foam, Magnet Beads scatter | Use high-pass-filtered acceleration |
| **Pinch and two-finger stretch or twist** | Pointer or Touch events | Kirigami Stretch, Spaghetti Snap (bend and twist), slime, Honey Drizzle | Twisting before bending is Spaghetti Snap's hidden mechanic |
| **Long-press dwell** | timers | Persistent creases, Pottery collapse, Plasma Globe charge-up, Bubble Wrap slow squeeze | Pressure-like input that works on every phone |
| **Pressure** | [Touch.force](https://developer.mozilla.org/en-US/docs/Web/API/Touch/force), [radiusX](https://developer.mozilla.org/en-US/docs/Web/API/Touch/radiusX), [PointerEvent.pressure](https://developer.mozilla.org/en-US/docs/Web/API/PointerEvent/pressure) | Bubble Wrap, Pottery, Chladni bowing | The iPhone 13 mini has no 3D Touch (my understanding, not checked in this session), so force stays at 0. Use contact radius where it is reported, and otherwise dwell time plus how fast the finger moves. |

---

## 3. Top 10

Score = (Novelty × Authenticity × Satisfaction, each 1–5) ÷ effort, with S = 1, S–M = 1.5 and M = 2.

| # | Toy or upgrade | N | A | Sat | Effort | Score | Why it ranks here |
|---|---|---|---|---|---|---|---|
| 1 | **Chladni Plate** (new; mic or tap drives the existing modal synth, sand finds the nodal lines) | 4 | 5 | 5 | S | **100** | What you hear is literally what moves the sand, and it reuses the existing modal layer |
| 2 | **Spaghetti Snap** (Cosserat rods + cascade fracture + twist-to-halve) | 5 | 5 | 5 | S–M | **83** | A real physics surprise (Feynman's puzzle) that you find with your fingers |
| 3 | **Minnaert bubble sound** for Splash Tank, Pour Sort and Ripple Pool | 4 | 5 | 4 | S | **80** | Instantly makes three existing toys sound like real water |
| 4 | **Crumple clicks + persistent creases** for Tear Sheet, Peel It and Laundry Line | 4 | 4 | 4 | S | **64** | Every crease is heard and remembered |
| 5 | **Plasma Globe and Lichtenberg** (DBM, finger as ground) | 4 | 4 | 4 | S | **64** | Cheap, glowing, reacts to the finger, with crackle driven by growth |
| 6 | **Smoke Rings** (vortex filaments; flick or mic puff) | 5 | 5 | 5 | M | **62** | Leapfrogging and colliding rings are mesmerising and not seen in phone toys |
| 7 | **Bubble Wand** (soap film thickness, interference colours, mic inflate, pop) | 5 | 5 | 5 | M | **62** | The colours and the pop both come from the thickness field |
| 8 | **Bubble Wrap** (pressure cells, squeeze-rate bursts) | 3 | 4 | 5 | S | **60** | A universal ASMR hook with honest physics; slow squeezes don't pop |
| 9 | **Foam Raft** (Durian bubbles, coarsening, T1 ticks, crackle) | 5 | 4 | 4 | S–M | **53** | Novel material; it ages as you watch |
| 10 | **Honey Drizzle** (viscous coiling and meandering thread) | 5 | 5 | 4 | M | **50** | The patterns come from the sim; it is cheap, being one rod |

Just missed the cut: Hourglass with gyro (48), Frost Window (43), Singing Bowl (40), Walking Droplets for Ripple Pool (37), Snap Bar with bonded DEM (32), Kirigami Stretch (32), Pottery Wheel via XPBI (~30), and the solver swaps (Breaking Good fracture modes for Knockdown, AVBD for the stacking toys), which add depth rather than new toys.

**Caveat:** the conference listings at realtimerendering.com were only partly readable (Cloudflare blocks the raw HTML), so some 2024–2026 papers may be missing. Recent sound papers were checked through arXiv and the Stanford and Cornell labs of Doug James. I found no fetchable source for these physics notes: singing lake ice (its dispersive \"pew\" chirp from cracking), popcorn and rain-stick physics, and the Weißmann–Pinkall filament smoke and Dobashi aerodynamic \"whoosh\" papers (their ACM DOIs block fetching)."}],"container":null,"stop_reason":"end_turn","stop_sequence":null,"stop_details":null,"usage":{"input_tokens":2,"cache_creation_input_tokens":1659,"cache_read_input_tokens":115704,"output_tokens":17735,"output_tokens_details":{"thinking_tokens":4182},"server_tool_use":{"web_search_requests":0,"web_fetch_requests":0},"service_tier":"standard","cache_creation":{"ephemeral_1h_input_tokens":0,"ephemeral_5m_input_tokens":1659},"inference_geo":"global","iterations":[{"input_tokens":2,"output_tokens":17735,"cache_read_input_tokens":115704,"cache_creation_input_tokens":1659,"cache_creation":{"ephemeral_5m_input_tokens":1659,"ephemeral_1h_input_tokens":0},"type":"message"}],"speed":"standard"},"input_transformations":[],"diagnostics":null,"context_management":null},"apiBlockIndex":1,"requestId":"req_011CfYXUR2cLJjSpmsq5Q8sc","attributionAgent":"general-purpose","type":"assistant","uuid":"e61439ec-beb5-415f-ac49-a1e20ed9683f","timestamp":"2026-09-29T22:36:20.343Z","advisorModel":"claude-opus-5-5","effort":"medium","perTurnEffort":"medium","userType":"external","entrypoint":"cli","cwd":"/Users/paulgadi/projects/bobo/.claude/worktrees/agent-aedc5070ae6a018b6","sessionId":"d0d4d77f-230c-4578-999e-9e8967b318ec","version":"2.1.280","gitBranch":"HEAD","slug":"indexed-juggling-volcano"}
