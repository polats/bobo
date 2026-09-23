# Physics Sandbox Research: Satisfying Physics for Browser and Mobile

*Research compiled 2026-09-23. For a game team building a browser/mobile "physics sandbox" of novel, satisfying, performant, juicy VFX simulations.*

> **Link policy:** every URL in this doc was returned by a live web search or fetched during research. Particle counts marked **(src)** come from the project's own README or article. Counts marked **(est)** are engineering estimates for a mid-range 2024+ phone or laptop iGPU, and you should benchmark them.

---

## 1. Executive summary

- **The best-value core is a GPU particle system plus a hash grid, with one of three solvers on top.**
  - **MLS-MPM** covers goo, snow, sand, jelly and water in one solver.
  - **PBD/XPBD** covers cloth, ropes, soft bodies and Position Based Fluids.
  - **Grid Eulerian "Stable Fluids"** covers smoke, ink and fire.
  
  All three have working WebGPU/WebGL browser implementations with source code. Together they cover roughly 80% of the "satisfying" catalog.
- **MLS-MPM is the standout for the browser.** matsuoka-601's WebGPU-Ocean runs about 100k particles on integrated graphics and about 300k on decent GPUs **(src)**. Codrops reports it running smoothly on a 2017 iPad Air 3. MPM avoids neighbour searches, and one solver changes material just by swapping the constitutive model.
- **2D matters on mobile.** Falling-sand cellular automata (Noita, Sandspiel) and 2D grid fluids (Pavel Dobryakov's WebGL fluid) are cheap, run on WebGL2, and are the most proven "toy" formats on phones.
- **New for rigid/soft stacks: Vertex Block Descent and AVBD (Roblox / U. Utah, 2024–2025).** They are unconditionally stable, GPU-parallel, and handle stacks, joints and soft-rigid mixing. A 2D C++/WASM reference ([avbd-demo2d](https://github.com/savant117/avbd-demo2d), MIT) and an experimental WebGPU port ([jure/webphysics](https://github.com/jure/webphysics)) already exist.
- **For conventional rigid bodies, use a WASM engine rather than writing one.** Options are Box2D v3 ([box2d3-wasm](https://github.com/Birch-san/box2d3-wasm)), Rapier ([rapier.rs](https://rapier.rs/)) or Jolt ([JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js/)).
- **Much of the "juice" comes from rendering, not simulation.** The key tricks are screen-space fluid rendering, velocity-stretched particles, bloom, curl-noise secondary particles, and additive dye with vorticity confinement.
- **Recommended stack:** TypeScript + WebGPU compute (raw WGSL or three.js TSL), with a WebGL2 fragment-shader fallback for 2D grid toys and CA sand. Add a WASM rigid engine and a shared post-processing chain.

---

## 2. Technique catalog (at a glance)

Particle/element counts are for a 60 fps budget in the browser.

| # | Technique | Best for | Browser tech | Count @60fps | Complexity | Reference implementation |
|---|---|---|---|---|---|---|
| 1 | Stable Fluids (grid, semi-Lagrangian) | Smoke, ink, dye swirls, fire | WebGL2 frag / WebGPU | 256²–1024² 2D grid; 64³–128³ 3D **(est)** | S | [PavelDoGreat WebGL fluid](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation), [TMP #17](https://matthias-research.github.io/pages/tenMinutePhysics/index.html) |
| 2 | Vorticity confinement + buoyancy (fire) | Fire, curling smoke | same as #1 | same as #1 | S | [TMP #21 fire](https://matthias-research.github.io/pages/tenMinutePhysics/index.html), [Chimera's Breath (Shadertoy)](https://www.shadertoy.com/view/4tGfDW) |
| 3 | SPH | Water splashes | WebGPU compute | 20k–100k 3D **(est)**; "tens of thousands" **(src, jeantimex)** | M | [jeantimex/fluid](https://github.com/jeantimex/fluid), [SebLague/Fluid-Sim](https://github.com/SebLague/Fluid-Sim) (Unity, port-able) |
| 4 | Position Based Fluids (PBF) | Stable water with big timesteps | WebGPU compute | 30k–150k **(est)** | M | Paper: [Macklin publications](https://blog.mmacklin.com/publications/) |
| 5 | PIC/FLIP/APIC | Lively splashy water | WebGPU (CPU in 2D) | 2D: 10k–50k on CPU; 3D: 50k–200k GPU **(est)** | M | [TMP #18 FLIP](https://matthias-research.github.io/pages/tenMinutePhysics/index.html), [jeantimex/fluid](https://github.com/jeantimex/fluid) |
| 6 | MLS-MPM | Goo, jelly, snow, sand, water, all in one | WebGPU compute | ~100k iGPU / ~300k dGPU **(src)** | M | [WebGPU-Ocean](https://github.com/matsuoka-601/webgpu-ocean), [holtsetio/flow](https://github.com/holtsetio/flow), [three.js MPM example](https://threejs.org/examples/webgpu_compute_particles_fluid.html), [mpm88](https://github.com/taichi-dev/taichi/blob/master/python/taichi/examples/simulation/mpm88.py), [mls-mpm.js](https://github.com/r03ert0/mls-mpm.js) |
| 7 | PBD / XPBD | Cloth, rope, soft bodies, joints | CPU/JS or WebGPU | Cloth 64²–256² verts; 1k–10k tets **(est)** | S–M | [TMP #09–#15, #22, #25](https://matthias-research.github.io/pages/tenMinutePhysics/index.html), [ten-minute-physics-rs](https://github.com/lucas-schuermann/ten-minute-physics-rs), WebGPU cloth repos (§4.7) |
| 8 | Shape matching | Jelly blobs, "JellyCar" feel | CPU/JS | 100s of blobs **(est)** | S | [Müller 2005 PDF](https://pdfs.semanticscholar.org/0064/0fb3fb1efce64421baa95a6d3543c9d6ce31.pdf) |
| 9 | Vertex Block Descent (VBD) | Huge soft bodies, stable | WebGPU compute | 10k–100k verts **(est)** | M–L | [Utah project](https://graphics.cs.utah.edu/research/projects/vbd/), [Newton VBD solver](https://github.com/newton-physics/newton/tree/main/newton/_src/solvers/vbd) |
| 10 | AVBD | Rigid stacks, joints, rigid+soft, destruction | WASM (2D) / WebGPU | 2D: 1k–5k boxes WASM; GPU: 10k+ **(est)** | M–L | [avbd-demo2d](https://github.com/savant117/avbd-demo2d), [avbd-demo3d](https://github.com/savant117/avbd-demo3d), [jure/webphysics](https://github.com/jure/webphysics) |
| 11 | Falling-sand cellular automata | Sand, water, fire, gas, acid, "Noita" worlds | WASM CPU or GPU (Margolus) | 512²–1024² cells (1M on GPU) **(est)** | S–M | [Sandspiel](https://github.com/MaxBittker/sandspiel), [GPU-Falling-Sand-CA](https://github.com/GelamiSalami/GPU-Falling-Sand-CA) |
| 12 | Height-field water | Ripples, pools, caustics | WebGL2/WebGPU | 256²–1024² grid **(est)** | S | [evanw/webgl-water](https://github.com/evanw/webgl-water), [TMP #20](https://matthias-research.github.io/pages/tenMinutePhysics/index.html), [WebGPU port](https://jeantimex.github.io/webgpu-water/) |
| 13 | Rigid bodies (Box2D v3 / Rapier / Jolt) | Stacks, dominoes, ragdolls | WASM (+SIMD/threads) | 2D: thousands of bodies **(src demo: 120-high pyramid)**; 3D: 1k–5k **(est)** | S (integration) | [box2d3-wasm](https://github.com/Birch-san/box2d3-wasm), [Rapier JS](https://rapier.rs/docs/user_guides/javascript/getting_started_js/), [JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js/) |
| 14 | Fracture (Voronoi / VACD-style) | Destruction, shattering | CPU/WASM + rigid engine | 10s–100s of fragments **(est)** | M | [Müller et al. 2013 (ACM)](https://dl.acm.org/doi/10.1145/2461912.2461934), [browser GPU fracture (student)](https://github.com/kainino0x/cis565final) |
| 15 | IPC / cubic barrier / OGC | Penetration-free cloth, knots | Offline/desktop GPU (study only) | n/a in browser | L | [IPC](https://github.com/ipc-sim/IPC), [ppf-contact-solver](https://github.com/st-tech/ppf-contact-solver), [OGC](https://graphics.cs.utah.edu/research/projects/ogc/) |
| 16 | Unified particles (FleX-style) | Mixed cloth + fluid + rigid on one particle set | WebGPU compute | 50k–100k **(est)** | L | [FleX preprint](https://mmacklin.com/uppfrta_preprint.pdf) |

---

## 3. Browser platform notes (2026)

- **WebGPU compute is the key enabler.** It gives storage buffers, atomics (needed for particle-to-grid scatter in MPM), and workgroup shared memory. It ships in Chromium browsers, and Safari/Firefox have added support over 2025. Still, keep a WebGL2 path for older iOS/Android devices and in-app webviews.
- **WebGL2 fallback.** Grid fluids, height-field water and CA sand map cleanly onto ping-pong render-to-texture in fragment shaders. Pavel's fluid proves this works on mobile. Particle solvers that need scatter (MPM P2G) are painful without compute. The workaround is point-sprite additive blending into float textures, which works but is imprecise.
- **WASM.** The rigid engines (Box2D v3, Rapier, Jolt) are compiled with SIMD, and some use threads. Threads need `SharedArrayBuffer`, which requires COOP/COEP headers on your host. Rapier's WASM build is cross-platform deterministic ([docs](https://rapier.rs/docs/user_guides/javascript/determinism/)), which is useful for replays and sharing.
- **Mobile thermal budget.** Plan for 30–50% of desktop iGPU numbers. Sustained sessions throttle, so give every toy an adaptive quality knob (particle count, grid resolution, substeps).

---

## 4. Per-technique deep dives

### 4.1 Stable Fluids / Eulerian grid smoke (Jos Stam)
- **What:** Navier–Stokes on a grid. Each step runs advect (semi-Lagrangian backtrace), add forces, then pressure projection (Jacobi or Gauss–Seidel) to make the velocity field divergence-free. It is unconditionally stable.
- **Why it's satisfying:** Swirling colour ink responds instantly to a finger drag. Vorticity confinement adds curly detail, and bloom makes it glow. Pavel Dobryakov's demo is the canonical "fidget toy" and even shipped as a mobile app.
- **Browser feasibility:** Excellent on WebGL2. A 2D grid of 256²–512² runs easily on phones. 3D smoke needs WebGPU and around 64³–128³.
- **Complexity:** S.
- **References:**
  - Stam, *Stable Fluids*, SIGGRAPH 1999 — [ACM](https://dl.acm.org/doi/10.1145/311535.311548), [Stam publications](https://www.dgp.toronto.edu/~stam/reality/Research/pub.html)
  - Stam, *Real-Time Fluid Dynamics for Games*, GDC 2003 — [PDF](https://pdfs.semanticscholar.org/5127/ac7b58e36ffd13ca4437fc123c6a018dc436.pdf)
  - GPU Gems ch. 38 *Fast Fluid Dynamics Simulation on the GPU* — [NVIDIA](https://developer.nvidia.com/gpugems/gpugems/part-vi-beyond-triangles/chapter-38-fast-fluid-dynamics-simulation-gpu)
  - Code: [PavelDoGreat/WebGL-Fluid-Simulation](https://github.com/PavelDoGreat/WebGL-Fluid-Simulation) ([live](https://paveldogreat.github.io/WebGL-Fluid-Simulation/)); [Ten Minute Physics #17 "Eulerian fluid in 200 lines"](https://matthias-research.github.io/pages/tenMinutePhysics/index.html); Sebastian Lague, [*Coding Adventure: Simulating Smoke*](https://www.youtube.com/watch?v=Q78wvrQ9xsU) (2025, covers SOR, parallel pressure solve, vortex shedding, temperature)
  - Shadertoy: nimitz, [*Chimera's Breath*](https://www.shadertoy.com/view/4tGfDW), a single-pass fluid with vorticity confinement

### 4.2 Fire
- **What:** Grid fluid plus temperature and fuel scalars, with buoyancy and a black-body colour ramp. Ten Minute Physics #21 is a web-page fire sim.
- **Why it's satisfying:** Flicker, licking flames, and embers when you add spark particles advected by the velocity field.
- **Browser feasibility:** Same as smoke. **Complexity:** S–M.
- **References:** [TMP #21](https://matthias-research.github.io/pages/tenMinutePhysics/index.html). Two Minute Papers covered *Interactive Wood Combustion for Botanical Tree Models* ([video](http://y2u.be/2jwVDRKKDME)), which is good inspiration for "burn the tree" toys.

### 4.3 SPH (Smoothed Particle Hydrodynamics)
- **What:** Particles carry mass. Density comes from kernel sums over neighbours, and pressure and viscosity forces follow from density. It needs a spatial hash or sorted grid for neighbour search.
- **Why it's satisfying:** Splashes and sloshing. Colour particles by speed and it becomes mesmerising.
- **Browser feasibility:** WebGPU compute with counting-sort binning (prefix sum) handles tens of thousands of particles at 60 fps. The neighbour search is the bottleneck.
- **Complexity:** M.
- **References:**
  - Code: [jeantimex/fluid](https://github.com/jeantimex/fluid) (WebGPU SPH + PIC/FLIP, six renderers incl. screen-space and marching cubes, [live](https://jeantimex.github.io/fluid/)); [mjwatkins2/WebGL-SPH](https://github.com/mjwatkins2/WebGL-SPH); [asadm/SPHjs](https://github.com/asadm/SPHjs); WebGPU-Ocean also has an SPH toggle
  - Tutorial: Sebastian Lague, [*Coding Adventure: Simulating Fluids*](https://www.youtube.com/watch?v=rSKMYc1CQHE), code at [SebLague/Fluid-Sim](https://github.com/SebLague/Fluid-Sim)
  - Spatial hashing: [TMP #11](https://matthias-research.github.io/pages/tenMinutePhysics/index.html)

### 4.4 Position Based Fluids (Macklin & Müller, SIGGRAPH 2013)
- **What:** SPH density treated as a PBD constraint and solved iteratively. It stays stable at large timesteps and adds surface-tension-like artificial pressure and vorticity confinement.
- **Why it's satisfying:** Incompressible-looking water that never explodes, which suits aggressive user input on a touchscreen.
- **Browser feasibility:** WebGPU compute, similar cost to SPH per iteration (usually 2–4 iterations).
- **Complexity:** M.
- **References:** [ACM](https://dl.acm.org/doi/10.1145/2461912.2461984); PDF via [Macklin publications](https://blog.mmacklin.com/publications/). The follow-up *Unified Particle Physics for Real-Time Applications* (FleX, SIGGRAPH 2014) is at [project page](http://blog.mmacklin.com/project/flex/) and [preprint](https://mmacklin.com/uppfrta_preprint.pdf). It is the blueprint for a single particle solver where cloth, rigid, fluid and gas all interact.

### 4.5 PIC / FLIP / APIC (hybrid particle–grid liquids)
- **What:** Particles carry velocity. Each step transfers it to a MAC grid, runs a pressure projection, and transfers back. FLIP (lively but noisy), PIC (damped) and APIC (affine, low dissipation, no noise) differ in the back-transfer.
- **Why it's satisfying:** The most "cinematic" splashes per particle. Houdini FLIP is the VFX-industry default.
- **Browser feasibility:** In 2D it runs on CPU/JS (TMP #18 is a browser demo). In 3D it needs WebGPU, and the pressure solve on the grid is the main cost.
- **Complexity:** M.
- **References:**
  - Jiang et al., *The Affine Particle-In-Cell Method*, SIGGRAPH 2015 — [ACM](https://dl.acm.org/doi/10.1145/2766996)
  - [TMP #18 "How to write a FLIP water simulator"](https://matthias-research.github.io/pages/tenMinutePhysics/index.html)
  - Two Minute Papers #61 *Narrow Band FLIP* ([video](https://www.youtube.com/watch?v=nfPBT71xYVQ))
  - Code: [jeantimex/fluid](https://github.com/jeantimex/fluid)

### 4.6 MLS-MPM (Moving Least Squares Material Point Method)
- **What:** Particles carry deformation gradient F and the APIC affine matrix C. Each step scatters particles to the grid (P2G), updates grid velocity with boundary conditions, and gathers back (G2P). Material behaviour comes entirely from the stress function:
  - Neo-Hookean gives jelly.
  - Fixed-corotated elasticity with plasticity clamping gives snow (Stomakhin 2013).
  - Drucker–Prager gives sand.
  - Equation of state only gives water.
- **Why it's satisfying:** One solver produces jiggly jelly, crumbling snow, pouring sand and sloshing water, and they all interact. Two Minute Papers called the 88-line version "This Jello Simulation Uses Only ~88 Lines of Code".
- **Browser feasibility:** Proven. There is no neighbour search. P2G needs atomics, done in WebGPU with fixed-point `atomicAdd` on i32 as WebGPU-Ocean does.
- **Performance:** ~100k particles on iGPU and ~300k on decent GPUs **(src)**. The three.js team ships an MLS-MPM example in core.
- **Complexity:** M, the best effort-to-wow ratio in this catalog.
- **References:**
  - Hu et al., *A Moving Least Squares Material Point Method with Displacement Discontinuity and Two-Way Rigid Body Coupling*, SIGGRAPH 2018 — [project](https://yuanming.taichi.graphics/publication/2018-mlsmpm/), [code](https://github.com/yuanming-hu/taichi_mpm) (incl. `mls-mpm88-explained.cpp`)
  - Stomakhin et al., *A Material Point Method for Snow Simulation*, SIGGRAPH 2013 — [page](http://alexey.stomakhin.com/research/snow.html)
  - Taichi [mpm88.py](https://github.com/taichi-dev/taichi/blob/master/python/taichi/examples/simulation/mpm88.py); [mls_mpm_88_extensions](https://github.com/taichi-dev/mls_mpm_88_extensions)
  - Browser implementations:
    - [matsuoka-601/WebGPU-Ocean](https://github.com/matsuoka-601/webgpu-ocean) ([demo](https://webgpu-ocean.netlify.app/)) and [WaterBall](https://github.com/matsuoka-601/waterball) ([demo](https://waterball.netlify.app/))
    - Codrops write-up: [*WebGPU Fluid Simulations: High Performance & Real-Time Rendering*](https://tympanus.net/codrops/2025/02/26/webgpu-fluid-simulations-high-performance-real-time-rendering/)
    - [holtsetio/flow](https://github.com/holtsetio/flow) (three.js TSL, [demo](https://holtsetio.com/lab/flow/))
    - [three.js webgpu_compute_particles_fluid](https://threejs.org/examples/webgpu_compute_particles_fluid.html)
    - [r03ert0/mls-mpm.js](https://github.com/r03ert0/mls-mpm.js) (plain JS port of mpm88, good for a CPU 2D version)
- **2025 research to watch:** *Hybrid Neural-MPM for Interactive Fluid Simulations in Real-Time* ([arXiv 2505.18926](https://arxiv.org/abs/2505.18926)).

### 4.7 PBD / XPBD (Position Based Dynamics)
- **What:** Predict positions, project constraints (distance, bending, volume, collision) Gauss–Seidel style, then derive velocity from the position change. XPBD adds compliance, so stiffness no longer depends on the iteration count. The "small steps" variant uses many substeps with one iteration each and is the modern default.
- **Why it's satisfying:**
  - Cloth that tears.
  - Ropes and chains.
  - Squishy soft bodies that can't be broken.
  - Pinball and bead toys.
  
  It never explodes, which is essential for players who fling things.
- **Browser feasibility:** Small scenes run in plain JS. For big cloth, use WebGPU with graph colouring or Jacobi-style parallel constraint solves.
- **Complexity:** S for 2D ropes, M for 3D cloth with self-collision.
- **References:**
  - Müller et al., *Position Based Dynamics*, 2007 — [PDF](https://matthias-research.github.io/pages/publications/posBasedDyn.pdf)
  - Macklin, Müller, Chentanez, *XPBD*, MIG 2016 — [ACM](https://dl.acm.org/doi/10.1145/2994258.2994272); [TMP #09 XPBD notes PDF](https://matthias-research.github.io/pages/tenMinutePhysics/09-xpbd.pdf)
  - Müller et al., *Detailed Rigid Body Simulation with Extended Position Based Dynamics*, SCA 2020 (Two Minute Papers ["Finally, Deformation Simulation… in Real Time!"](http://y2u.be/F0QwAhUnpr4)); [TMP #22 rigid bodies](https://matthias-research.github.io/pages/tenMinutePhysics/index.html)
  - Ten Minute Physics browser demos (all JS/three.js): #10 soft bodies, #12 soft-body skinning ("100x speedup"), #14 cloth, #15 self-collision, #16 GPU cloth (PDF + Python), #25 joints — see [index](https://matthias-research.github.io/pages/tenMinutePhysics/index.html) and [repo](https://github.com/matthias-research/pages)
  - Rust/WASM port: [ten-minute-physics-rs](https://github.com/lucas-schuermann/ten-minute-physics-rs)
  - WebGPU XPBD cloth: [ccincotti3/webgpu_cloth_simulator](https://github.com/ccincotti3/webgpu_cloth_simulator) (with blog guides), [jspdown/cloth](https://github.com/jspdown/cloth), [RykaKa/webgpu-xpbd-cloth](https://github.com/RykaKa/webgpu-xpbd-cloth), [nakjun/Cloth-Simulation-WebGPU](https://github.com/nakjun/Cloth-Simulation-WebGPU)
  - 2024 extensions: *Position-Based Nonlinear Gauss-Seidel for Quasistatic Hyperelasticity* ([ACM](https://dl.acm.org/doi/10.1145/3658154)); *XPBI* (PBD for inelastic continua, [arXiv 2405.11694](https://arxiv.org/pdf/2405.11694)); *MGPBD* multigrid XPBD 2025 ([arXiv 2505.13390](https://arxiv.org/pdf/2505.13390))

### 4.8 Shape matching (meshless deformation)
- **What:** Each cluster of particles is pulled toward a best-fit rigid (or linear/quadratic) transform of its rest shape. There is no mesh and it is unconditionally stable.
- **Why it's satisfying:** Classic "JellyCar" blobs that wobble and recover. It works very well in 2D mobile games.
- **Browser feasibility:** Trivial on CPU. **Complexity:** S.
- **Reference:** Müller et al., SIGGRAPH 2005 — [PDF](https://pdfs.semanticscholar.org/0064/0fb3fb1efce64421baa95a6d3543c9d6ce31.pdf), [ACM](https://dl.acm.org/doi/10.1145/1073204.1073216).

### 4.9 Vertex Block Descent (VBD, SIGGRAPH 2024)
- **Authors:** Anka He Chen, Ziheng Liu, Yin Yang, Cem Yuksel (U. Utah / Roblox).
- **What:** Block coordinate descent on the implicit-Euler variational energy. Each vertex does a local 3×3 Newton step, vertices are graph-coloured, and colours run in parallel. It is unconditionally stable and you can stop at any iteration budget.
- **Why it's satisfying:** Enormous, highly stiff jelly without instability. Two Minute Papers: ["Crazy 50,000,000 Point Bouncy Jelly Experiment!"](https://www.youtube.com/watch?v=w_7fHVcHqkY) (May 2024).
- **Browser feasibility:** Good fit for WebGPU. The work is per-vertex local, with no global solve. Graph colouring is precomputed on the CPU.
- **Complexity:** M–L. You need tet meshes (see TMP #13 tetrahedralize PDF) and a Neo-Hookean energy Hessian.
- **References:** [Utah project](https://graphics.cs.utah.edu/research/projects/vbd/), [PDF](https://graphics.cs.utah.edu/research/projects/vbd/vbd-siggraph2024.pdf), [arXiv 2403.06321](https://arxiv.org/abs/2403.06321), [ACM](https://dl.acm.org/doi/10.1145/3658179). There is a production implementation in NVIDIA/Disney/DeepMind's [Newton](https://github.com/newton-physics/newton) ([VBD solver dir](https://github.com/newton-physics/newton/tree/main/newton/_src/solvers/vbd)) that you can read as reference.

### 4.10 Augmented VBD (AVBD, SIGGRAPH 2025)
- **Authors:** Chris Giles, Elie Diaz, Cem Yuksel (Roblox / Utah).
- **What:** VBD plus an augmented-Lagrangian treatment of hard constraints. It handles infinitely stiff joints, contact with friction, large stacks and high mass ratios, and mixes rigid and soft bodies. The paper demos over a million interacting objects in real time.
- **Why it's satisfying:** Towers of thousands of blocks, chains and wrecking balls, all stable, which is ideal for destruction toys.
- **Browser feasibility:** The authors ship web demos. [avbd-demo2d](https://github.com/savant117/avbd-demo2d) is MIT C++ with an Emscripten build ([2D demo](https://graphics.cs.utah.edu/research/projects/avbd/avbd_demo2d.html), [3D demo](https://graphics.cs.utah.edu/research/projects/avbd/avbd_demo3d.html), [3D source](https://github.com/savant117/avbd-demo3d)). [jure/webphysics](https://github.com/jure/webphysics) is an experimental WebGPU AVBD with LBVH broadphase and graph colouring, Chrome-only and proof-of-concept.
- **Complexity:** M for 2D, based on the reference. L for a robust GPU 3D version.
- **References:** [project](https://graphics.cs.utah.edu/research/projects/avbd/), [ACM](https://doi.org/10.1145/3731195), [paper video](https://www.youtube.com/watch?v=bwJgifqvd5M). Two Minute Papers: ["Roblox Solved The Physics Problem That Stumped Everyone!"](https://www.youtube.com/watch?v=TzIKbjuSy2A) (July 2025).

### 4.11 Falling-sand cellular automata (Noita / Sandspiel)
- **What:** A pixel grid where each cell holds a material. Local rules move cells, for example sand falls down and then diagonally, water also spreads sideways, and fire consumes wood and spawns smoke.
  - **Noita** splits the world into 64×64 chunks updated in a checkerboard across threads. It also turns pixel islands into rigid bodies using marching squares plus Box2D.
- **Why it's satisfying:** Emergent chemistry, since everything burns, melts and reacts. It is the most shareable toy format (Sandspiel's community element editor).
- **Browser feasibility:** A CPU in WASM handles about 300×300–512×512. On GPU, use Margolus 2×2 block CA to avoid write conflicts, which reaches 1M cells or more.
- **Complexity:** S for basic, M for Noita-style chunks and rigid-body islands.
- **References:**
  - Petri Purho, GDC 2019, *Exploring the Tech and Design of Noita* — [YouTube](https://www.youtube.com/watch?v=prXuyMCgbTc), [GDC Vault](https://www.gdcvault.com/play/1025695/Exploring-the-Tech-and-Design)
  - [MaxBittker/sandspiel](https://github.com/MaxBittker/sandspiel) (Rust→WASM CA plus a WebGL fluid for wind)
  - GPU CA: [GelamiSalami/GPU-Falling-Sand-CA](https://github.com/GelamiSalami/GPU-Falling-Sand-CA) (Margolus), [felixcharbonneau/Falling-sand-sim](https://github.com/felixcharbonneau/Falling-sand-sim), [m4ym4y/falling-sand-shader](https://github.com/m4ym4y/falling-sand-shader), [meatbatgames GPU falling sand blog](https://meatbatgames.com/blog/falling-sand-gpu/)

### 4.12 Height-field water and shallow water
- **What:** A 2D grid of water heights driven by a wave equation or shallow-water equations. Rendering does the heavy lifting with refraction, caustics and reflections.
- **Why it's satisfying:** Finger ripples on a pool, floating ducks, caustics on the floor.
- **Browser feasibility:** Excellent on WebGL2. **Complexity:** S.
- **References:**
  - [evanw/webgl-water](https://github.com/evanw/webgl-water) ([live](https://madebyevan.com/webgl-water/)), [WebGPU port](https://jeantimex.github.io/webgpu-water/), [PlayCanvas WebGPU port](https://github.com/willeastcott/webgpu-water-playcanvas)
  - [TMP #20](https://matthias-research.github.io/pages/tenMinutePhysics/index.html)
  - Research: Jeschke & Wojtan, *Generalizing Shallow Water Simulations with Dispersive Surface Waves*, SIGGRAPH 2023 ([NVIDIA](https://research.nvidia.com/publication/2023-08_generalizing-shallow-water-simulations-dispersive-surface-waves), [ISTA](https://visualcomputing.ist.ac.at/publications/2023/GSWSDSW/)) gives boat wakes and beach sloshing in real time. *Ships, Splashes, and Waves on a Vast Ocean* ([arXiv](https://arxiv.org/pdf/2108.05481)) is also relevant.

### 4.13 Rigid bodies via WASM engines
- **Box2D v3** (Erin Catto, 2024): new "Soft Step" solver using sub-stepping and soft constraints. It handles big stacks, long chains and high mass ratios. See the [release post](https://box2d.org/posts/2024/08/releasing-box2d-3.0/) and [Solver2D post](https://box2d.org/posts/2024/02/solver2d/). Web build: [Birch-san/box2d3-wasm](https://github.com/Birch-san/box2d3-wasm) (SIMD + Web Workers), with a [pyramid demo](https://birch-san.github.io/box2d3-wasm/demo/modern/?threading=1&pyramidHeight=120).
- **Rapier** (Rust→WASM, 2D and 3D): deterministic, with SIMD builds (`@dimforge/rapier3d-simd`) — [rapier.rs](https://rapier.rs/), [2025 review](https://dimforge.com/blog/2026/01/09/the-year-2025-in-dimforge/).
- **Jolt** (3D, used in Horizon Forbidden West): [JoltPhysics.js](https://github.com/jrouwe/JoltPhysics.js/), available on npm as `jolt-physics`.
- **Complexity:** S to integrate. Use these as the rigid layer that GPU particles collide against (one-way coupling). Two-way coupling is where AVBD or MPM rigid coupling is needed.

### 4.14 Destruction / fracture
- **What:**
  - Pre-fractured Voronoi pieces with an impact-driven "glue" break threshold.
  - Runtime Voronoi slicing around the impact point, the VACD approach from Müller, Chentanez & Kim, SIGGRAPH 2013 ([ACM](https://dl.acm.org/doi/10.1145/2461912.2461934)).
  - In 2D, a pixel-destruction approach like Noita's (CA plus marching squares to rebuild rigid shapes).
  - In MPM, damage models give natural tearing and crumbling. Two Minute Papers covered CD-MPM ["Simulating Breaking Bread"](http://y2u.be/9IqRdEs4_JU) and AnisoMPM ["Tearing Meat"](http://y2u.be/fE9BqmJrrW0).
- **Why it's satisfying:** Shattering glass or stone, debris dust, and slow-motion replays.
- **Browser feasibility:** Rigid engine plus CPU fracture, with GPU debris particles for the juice. A browser GPU fracture student project exists: [kainino0x/cis565final](https://github.com/kainino0x/cis565final).
- **Complexity:** M.

### 4.15 Contact-heavy research (study for ideas, not for the browser)
These give cinematic results but are desktop-GPU/offline class. They are useful for inspiration and for "fake it" references.
- **IPC** (Li et al., SIGGRAPH 2020): guaranteed intersection- and inversion-free — [site](https://ipc-sim.github.io/), [code](https://github.com/ipc-sim/IPC). C-IPC gives the table-cloth pull: [site](https://ipc-sim.github.io/C-IPC/).
- **Cubic Barrier** (Ryoichi Ando, SIGGRAPH Asia 2024): [ACM](https://dl.acm.org/doi/abs/10.1145/3687908), [ppf-contact-solver](https://github.com/st-tech/ppf-contact-solver). Two Minute Papers: ["The Worst Bug In Games Is Now Gone Forever"](https://www.youtube.com/watch?v=VOORiyip4_c) (Oct 2025).
- **Offset Geometric Contact** (Chen, Hsu, Liu, Macklin, Yang, Yuksel, SIGGRAPH 2025): penetration-free cloth using only parallel local operations, more than 100× faster than prior work — [project](https://graphics.cs.utah.edu/research/projects/ogc/). This is the most likely of the three to become real-time-feasible.
- **JGS2** (Lan et al., 2025): near-second-order Jacobi/Gauss–Seidel for GPU elastodynamics — [arXiv 2506.06494](https://arxiv.org/abs/2506.06494). Two Minute Papers: ["They Said This Will Never Run In Real Time"](https://www.youtube.com/watch?v=uO5cvkzh3P0) (2026, per [ai-tldr summary](https://ai-tldr.dev/releases/two-minute-papers-jgs2-jul3/)).
- **Granule-In-Cell** (Tang et al., SIGGRAPH Asia 2025): DEM sand coupled with PIC water — [arXiv 2504.00745](https://arxiv.org/abs/2504.00745).
- **Genesis** (2024): a multi-solver engine (rigid, MPM, SPH, FEM, PBD, Stable Fluid) for robotics — [GitHub](https://github.com/Genesis-Embodied-AI/Genesis). It is not a browser target, but its solver set mirrors the one proposed here.

---

## 5. Two Minute Papers episode list (physics simulation)

The main source for 2015–early 2022 is the community gist [*Paper title to Two Minute Papers video*](https://gist.github.com/randompast/1633dc353a7bfa3bf3fbaa54c4a5cd35). Later entries were each verified by search. `y2u.be/ID` is a YouTube short link (= `youtube.com/watch?v=ID`). Venues are given where known. Most are SIGGRAPH or SIGGRAPH Asia papers published in ACM TOG.

**Legend:** ★ marks strong browser-toy inspiration.

### Liquids and water
| Date | Video | Paper | Link |
|---|---|---|---|
| 2015-09 | Adaptive Fluid Simulations (#10) | Highly Adaptive Liquid Simulations on Tetrahedral Meshes | [video](https://www.youtube.com/watch?v=dH1s49-lrBk) |
| 2015-10 | Modeling Colliding and Merging Fluids (#18) | Multimaterial Mesh-Based Surface Tracking | [video](https://www.youtube.com/watch?v=uj8b5mu0P7Y) |
| 2016-04 | Narrow Band Liquid Simulations (#61) | Narrow Band FLIP for Liquid Simulations | [video](https://www.youtube.com/watch?v=nfPBT71xYVQ) |
| 2016-05 | Surface-Only Liquids (#69) | Surface-Only Liquids | [video](http://y2u.be/-rf_MDh-FiE) |
| 2016-11 | Water Wave Simulation with Dispersion Kernels (#110) ★ | Dispersion Kernels for Water Wave Simulation | [video](http://y2u.be/FeMSEaHR8aw) |
| 2016-12 | Multiphase Fluid Simulations (#113) | Multiphase SPH Simulation for Interactive Fluids and Solids | [video](http://y2u.be/cUWDeDRet4c) |
| 2017 | What is The Best Way To Simulate Liquids? (#189) | Perceptual Evaluation of Liquid Simulation Methods | [video](https://www.youtube.com/watch?v=TItYXBoJ1sc) |
| 2017-05 | Simulating Honey Coiling (#158) ★ | Variational Stokes: A Unified Pressure-Viscosity Solver | [video](http://y2u.be/ZEjUqZU1hNQ) |
| 2018-01 | Efficient Viscoelastic Fluid Simulations (#220) | Conformation Constraints for Efficient Viscoelastic Fluid Simulation | [video](http://y2u.be/MCHw6fUyLMY) |
| 2019-06 | How Can This Liquid Climb? ★ | On the Accurate Large-scale Simulation of Ferrofluids | [video](http://y2u.be/goD36hVVl7M) |
| 2019-10 | Is a Realistic Honey Simulation Possible? | Geometrically Consistent Viscous Fluid Solver with Two-Way Coupling | [video](http://y2u.be/7SM816P5G9s) |
| 2020-01 | Is a Realistic Water Bubble Simulation Possible? ★ | Unified Spray, Foam and Bubbles for Particle-Based Fluids | [video](http://y2u.be/O-52enqUSNw) |
| 2020-05 | Finally, A Blazing Fast Fluid Simulator! | Fast Fluid Simulations with Sparse Volumes on the GPU | [video](http://y2u.be/i4KWiq3guRU) |
| 2020-08 | How Can We Simulate Water Droplets? | Codimensional Surface Tension Flow using MLS Particles | [video](http://y2u.be/SxIkQt04WCo) |
| 2020-09 | Can We Simulate Merging Bubbles? | Constraint Bubbles and Affine Regions | [video](http://y2u.be/MD_k3p4MH-A) |
| 2021-01 | Building A Liquid Labyrinth! ★ | Surface-Only Ferrofluids | [video](http://y2u.be/nJ86LCA0Asw) |
| 2021-01 | All Duckies Shall Pass! | Interlinked SPH Pressure Solvers for Strong Fluid-Rigid Coupling | [video](http://y2u.be/2wrOHdvAiNc) |
| 2021-04 | Soap Bubble Simulations Are Now Possible! ★ | A Model for Soap Film Dynamics with Evolving Thickness | [video](http://y2u.be/6SJ19OgHi4w) |
| 2021-05 | Beautiful Fluid Simulations…In Just 40 Seconds! | Wave Curves | [video](http://y2u.be/LtyvS7NYonw) |
| 2021-07 | A Simulation That Looks Like Reality! | Solid-Fluid Interaction with Surface-Tension-Dominant Contact | [video](http://y2u.be/VqeNSZqiBzc) |
| 2021-08 | Beautiful Thin Film Simulations Are Now Possible! | Thin-Film Smoothed Particle Hydrodynamics Fluid | [video](http://y2u.be/eQRZ7FUkwKo) |
| 2021-10 | This New Method Can Simulate a Vast Ocean! | Ships, Splashes, and Waves on a Vast Ocean | [video](http://y2u.be/ia-VBSF4KXA) |
| 2021-11 | Virtual Reality Fluid Drawing Is Here! ★ | Interactive Liquid Splash Modeling by User Sketches | [video](http://y2u.be/ReBeJcmIlnA) |
| 2021-11 | Hooray, Virtual Sponges Can Sink Too! | Unified particle system for multiple-fluid flow and porous material | [video](http://y2u.be/qeSoAbJoi7c) |
| 2024-09 | NVIDIA's Tech: Impossible Water Simulation! ★ | NVIDIA + ISTA large-scale shallow/dispersive water (likely Jeschke & Wojtan 2023, see §4.12) | [video](https://www.youtube.com/watch?v=TixUHjIVovE) |

### Smoke, fire and turbulence
| Date | Video | Paper | Link |
|---|---|---|---|
| 2015 | Fluid Simulations with Blender and Wavelet Turbulence (#1) | Wavelet Turbulence for Fluid Simulation | [video](https://www.youtube.com/watch?v=5xLSbj5SsSE) |
| 2017-01 | Neural Network Learns The Physics of Fluids and Smoke (#118) | Accelerating Eulerian Fluid Simulation With Convolutional Networks | [video](https://www.youtube.com/watch?v=iOWamCtnwTc) |
| 2017-09 | AI Learns To Improve Smoke Simulations (#188) | Data-Driven Synthesis of Smoke Flows with CNN-based Feature Descriptors | [video](http://y2u.be/Mu0ew2F-SSA) |
| 2018-07 | Style Transfer…For Smoke and Fluids! (#264) | Example-based Turbulence Style Transfer | [video](https://www.youtube.com/watch?v=lCoR-4OlIZI) |
| 2019-10 | Finally, Style Transfer For Smoke Simulations! | Transport-Based Neural Style Transfer for Smoke Simulations | [video](http://y2u.be/leoRHsBsv6Q) |
| 2020-09 | Can We Simulate a Rocket Launch? | Fast and Scalable Turbulent Flow Simulation with Two-Way Coupling | [video](http://y2u.be/bfuBQp1JmX8) |
| 2021-05 | Burning Down Virtual Trees… In Real Time! ★ | Interactive Wood Combustion for Botanical Tree Models | [video](http://y2u.be/2jwVDRKKDME) |
| 2021-06 | Burning Down an Entire Virtual Forest! | Fire in Paradise: Mesoscale Simulation of Wildfires | [video](http://y2u.be/AGCH1GR7pPU) |
| 2021-06 | Is Style Transfer For Fluid Simulations Possible? | Lagrangian Neural Style Transfer for Fluids | [video](http://y2u.be/b8sCSumMUvM) |
| 2022-01 | Wow, A Simulation That Matches Reality! | Fast and Versatile Fluid-Solid Coupling for Turbulent Flow Simulation | [video](http://y2u.be/v8n4JEMJrrU) |
| 2022-02 | Is Simulating Turbulent Smoke Possible? | Predicting High-Resolution Turbulence Details in Space and Time | [video](http://y2u.be/dQMvii1KGOY) |

### MPM, snow, sand and goo
| Date | Video | Paper | Link |
|---|---|---|---|
| 2017-06 | Simulating Wet Sand (#160) ★ | Multi-species simulation of porous sand and water mixtures | [video](https://www.youtube.com/watch?v=4Df_BluxwkU) |
| 2019-04 | Beautiful Gooey Simulations, Now 10 Times Faster | GPU Optimization of Material Point Methods | [video](http://y2u.be/-jL2o_15s1E) |
| 2019-05 | Simulating Grains of Sand, Now 6 Times Faster | Hybrid Grains: Adaptive Coupling of Discrete and Continuum Granular Media | [video](http://y2u.be/e_9f5Z0sMYE) |
| 2019-07 | This Jello Simulation Uses Only ~88 Lines of Code ★★ | MLS-MPM with Compatible Particle-in-Cell (Hu et al. 2018) | [video](http://y2u.be/9M18rc9-VWU) |
| 2019-08 | Simulating Water and Debris Flows | Animating Fluid Sediment Mixture in Particle-Laden Flows | [video](http://y2u.be/CSQPD3oyvD8) |
| 2020-01 | Baking And Melting Chocolate Simulations ★ | A Thermomechanical Material Point Method for Baking and Cooking | [video](http://y2u.be/SIGQSgifs6s) |
| 2020-01 | This Beautiful Fluid Simulator Warps Time…Kind Of | Temporally Adaptive MPM with Regional Time Stepping | [video](http://y2u.be/wsFgrzYwchQ) |
| 2020-01 | Finally, Differentiable Physics is Here! | DiffTaichi | [video](http://y2u.be/T7w7QuYa4SQ) |
| 2020-02 | Simulating Breaking Bread ★ | CD-MPM: Continuum Damage MPM for Dynamic Fracture | [video](http://y2u.be/9IqRdEs4_JU) |
| 2020-04 | Is Simulating Soft and Bouncy Jelly Possible? | A Hybrid MPM for Frictional Contact with Diverse Materials | [video](http://y2u.be/54YvCE8_7lM) |
| 2020-08 | Can We Simulate Tearing Meat? | AnisoMPM: Animating Anisotropic Damage Mechanics | [video](http://y2u.be/fE9BqmJrrW0) |
| 2020-10 | This Is What Simulating a 100 Million Particles Looks Like! | A Massively Parallel and Scalable Multi-GPU MPM | [video](http://y2u.be/5ePD83StI6A) |
| 2020-10 | Beautiful Elastic Simulations, Now Much Faster! | IQ-MPM | [video](http://y2u.be/DxW_kk5LWYQ) |
| 2021-02 | 7 Years of Progress In Snow Simulation! ★ | An Implicit Compressible SPH Solver for Snow Simulation | [video](http://y2u.be/JSNE_PIG1UQ) |
| 2021-04 | Is Simulating Wet Papers Possible? | MLS reproducing kernel particle method for multiphase continuum | [video](http://y2u.be/_4fL4jnC8xQ) |
| 2021-07 | One Simulation Paper, Tons of Progress! | Revisiting Integration in the Material Point Method | [video](http://y2u.be/Lp4k4O_HEeQ) |
| 2022-01 | Adobe's New Simulation: Bunnies Everywhere! | FrictionalMonolith (granular + rigid) | [video](http://y2u.be/uBGY9-GaSdo) |

### Soft bodies, cloth, hair and rods
| Date | Video | Paper | Link |
|---|---|---|---|
| 2015-10 | Adaptive Cloth Simulations (#14) | Adaptive Anisotropic Remeshing for Cloth Simulation | [video](https://www.youtube.com/watch?v=LU3pdWTD4Rw) |
| 2015-08 | Simulating Breaking Glass (#4) ★ | Adaptive Tearing and Cracking of Thin Sheets | [video](http://y2u.be/A7Gut679I-o) |
| 2016-10 | Real-Time Soft Body Dynamics for Video Games (#103) ★ | Vivace: a Practical Gauss-Seidel Method for Stable Soft Body Dynamics | [video](http://y2u.be/fl-7e8yBUic) |
| 2017-06 | Efficient Yarn-based Cloth Simulations (#166) | Efficient Yarn-based Cloth with Adaptive Contact Linearization | [video](https://www.youtube.com/watch?v=oltKUPTBz9Q) |
| 2017-08 | Elastoplastic Hair and Cloth Simulations (#176) | Anisotropic Elastoplasticity for Cloth, Knit and Hair | [video](http://y2u.be/RygQnpQMdPI) |
| 2019-04 | Why Are Cloth Simulations So Hard? | I-Cloth: Incremental Collision Handling for GPU Cloth | [video](http://y2u.be/UoKXJzTYDpw) |
| 2019-07 | Tighten the Towel! | A Multi-Scale Model for Liquid-Fabric Interactions | [video](http://y2u.be/OEQf0AtSSsc) |
| 2020-03 | Deformable Simulations…Running In Real Time! | A Scalable Galerkin Multigrid Method for Real-time Deformables | [video](http://y2u.be/HcB3ImpYeQU) |
| 2020-04 | Muscle Simulation…Now In Real Time! | VIPER: Volume Invariant Position-based Elastic Rods | [video](http://y2u.be/higGxGmwDbs) |
| 2020-10 | Finally, Deformation Simulation… in Real Time! ★ | Detailed Rigid Body Simulation with XPBD | [video](http://y2u.be/F0QwAhUnpr4) |
| 2020-12 | Soft Body Wiggles And Jiggles…Effortlessly! ★★ | Complementary Dynamics (secondary jiggle on animated rigs) | [video](http://y2u.be/s8Nm_ytwO6w) |
| 2021-01 | Episode 500 – 8 Years Of Progress In Cloth Simulations! | Robust Eulerian-On-Lagrangian Rods | [video](https://www.youtube.com/watch?v=7O7W-_FKRMQ) |
| 2021-04 | 9 Years of Progress In Cloth Simulation! | Homogenized Yarn-Level Cloth | [video](http://y2u.be/rzIiuGrOZAo) |
| 2021-11 | Is Simulating Tiny Cloth Wrinkles Possible? | GPU-based Simulation of Cloth Wrinkles at Submillimeter Levels | [video](http://y2u.be/Mrdkyv0yXxY) |
| 2024-05 | Crazy 50,000,000 Point Bouncy Jelly Experiment! ★★ | Vertex Block Descent (SIGGRAPH 2024) | [video](https://www.youtube.com/watch?v=w_7fHVcHqkY) |
| 2025-07 | Roblox Solved The Physics Problem That Stumped Everyone! ★★ | Augmented Vertex Block Descent (SIGGRAPH 2025) | [video](https://www.youtube.com/watch?v=TzIKbjuSy2A) |
| 2025-10 | The Worst Bug In Games Is Now Gone Forever | A Cubic Barrier with Elasticity-Inclusive Dynamic Stiffness (SIGGRAPH Asia 2024) | [video](https://www.youtube.com/watch?v=VOORiyip4_c) |
| 2026 | They Said This Will Never Run In Real Time | JGS2 (arXiv 2506.06494) | [video](https://www.youtube.com/watch?v=uO5cvkzh3P0) |

### Rigid bodies, contact and fracture
| Date | Video | Paper | Link |
|---|---|---|---|
| 2017-06 | Simulating Cuts On Virtual Bodies (#164) | Robust eXtended Finite Elements for Complex Cutting | [video](http://y2u.be/R5t74AC6I0A) |
| 2020-10 | Simulating Dragons Under Cloth Sheets! | Local Optimization for Robust SDF Collision | [video](http://y2u.be/ooZ9rUYOFI4) |
| 2020-12 | Is Simulating Jelly And Bunnies Possible? | Monolith: Pressure-Viscosity-Contact Solver | [video](http://y2u.be/tiO43nJKGJY) |
| 2021-03 | 5 Crazy Simulations That Were Previously Impossible! | Incremental Potential Contact (IPC) | [video](http://y2u.be/lxzGraohijU) |
| 2021-09 | The Tale Of The Unscrewable Bolt! | Intersection-free Rigid Body Dynamics | [video](http://y2u.be/CfJ074h9K8s) |
| 2021-10 | Watch This Virtual Dinosaur Fall Into A Cactus! | Medial IPC | [video](http://y2u.be/M2QJ9iyGQ48) |
| 2021-12 | Finally, This Table Cloth Pull is Now Possible! ★ | Codimensional IPC (C-IPC) | [video](http://y2u.be/KZhoU_3k0Nk) |
| 2022-01 | Stanford Invented The Ultimate Bouncy Simulator! ★ | Bounce Maps: Restitution Model for Real-Time Rigid-Body Impact | [video](http://y2u.be/55PJtqpXAm4) |

### Other fun ones (paint, glitter, magnets)
- *Painting with Fluid Simulations* (#33), Wetbrush — [video](http://y2u.be/1aVSb-UbYWc)
- *Next Level Paint Simulations Are Coming!*, Practical Pigment Mixing for Digital Painting (Mixbox) — [video](http://y2u.be/b2D_5G_npVI). Kubelka–Munk pigment mixing would make the ink toy's colours mix like real paint ★.
- *Beautiful Glitter Simulation…Faster Than Real Time!*, Procedural BRDF for Real-Time Glints — [video](http://y2u.be/x2zDrSgrlYQ) ★ (glinty sand and snow).
- *This Magnetic Simulation Took Nearly A Month!*, Level-Set Magnetic Substances — [video](http://y2u.be/I04zRq6UlIg).
- Channel playlist: [Fluid, Cloth and Hair Simulations](https://www.youtube.com/playlist?list=PLujxSBD-JXgnnd16wIjedAcvfQcLw0IJI).

---

## 6. Toy backlog (prioritized)

Scoring considers fun, the juice ceiling, feasibility on mobile, and code reuse with later toys. Build order goes top to bottom. Toys 1–3 establish the three shared engines (grid, particle and CA).

| P | Toy | Core sim | Tech | Why first / fun hook | Effort |
|---|---|---|---|---|---|
| 1 | **Ink Swirl** — finger-painting glowing fluid, colour palettes, "blow" gesture, pigment mixing | Stable Fluids 2D + vorticity confinement | WebGL2 frag (works everywhere); WebGPU later | Proven viral fidget toy (Pavel). Builds the grid-solver and post-FX chain. Add Mixbox-like subtractive colour mixing as the twist. | S (1–2 wks) |
| 2 | **Goo Lab** — jelly, snow, sand and water from one emitter, with a material dial and a squish tool | MLS-MPM (2D first, then 3D) | WebGPU compute; CPU 2D fallback via mls-mpm.js-style code | Best wow-per-line. One engine gives four materials. Two Minute Papers "88 lines" is the pitch. | M (2–4 wks) |
| 3 | **Alchemy Sandbox** — Noita/Sandspiel falling sand with fire, water, acid, lava, plant and steam | Cellular automata (Margolus on GPU) | WASM CPU (Rust/Zig) or WebGPU; WebGL2 frag fallback | Emergent reactions and endless replay. Element recipes are data-driven for later UGC. | S–M |
| 4 | **Splash Tank** — tilt your phone (DeviceOrientation) to slosh 3D water, drop objects, splash | MLS-MPM or PBF 3D + screen-space fluid rendering | WebGPU | "Water in your phone" is the killer mobile demo. Reuses toy 2's solver with the SSFR renderer. | M |
| 5 | **Tear Sheet** — cloth, flags, curtains and bedsheets you slash with a finger; ropes and chains | XPBD small-steps | JS/WASM for 2D and small 3D; WebGPU for 128²+ | Tearing is intensely satisfying. TMP #14/#15 give a direct recipe. | S–M |
| 6 | **Jelly Stack** — wobbly jelly blocks you stack, slap and drop; squash/stretch everything | XPBD soft bodies or shape matching (2D); VBD (3D, later) | JS CPU (2D), WebGPU (3D) | Toy-box feel. Pairs with Complementary Dynamics-style secondary jiggle for faked juice. | S (2D) / L (VBD 3D) |
| 7 | **Demolition Tower** — build towers of 1k+ blocks, hit them with a wrecking ball or bomb, debris and dust | AVBD 2D (port of avbd-demo2d) or Box2D v3; Voronoi pre-fracture | WASM (+threads) | Destruction plus slow-mo replay is peak satisfaction. AVBD gives stable huge stacks and joints. | M |
| 8 | **Ripple Pool** — touch a caustic-lit pool, float rubber ducks, rain mode | Height-field waves (+ optional shallow water) | WebGL2 | Cheap, gorgeous, calming. The rendering showcase (caustics, refraction). | S |
| 9 | **Campfire / Dragon Breath** — draw logs, ignite, blow on embers; fire spreads | Grid fluid + temperature + fuel + ember particles; CA for burning spread | WebGL2/WebGPU | Reuses toy 1's solver. Combustion was a Two Minute Papers favourite. | S–M |
| 10 | **Ferro Blob** — magnetic liquid that spikes toward your finger | Particle fluid (PBF/SPH) with magnetic attraction forces and surface-tension-ish cohesion; or a fake using a normal-mapped SDF metaball surface | WebGPU (or pure shader fake) | Novel and rarely seen in browsers. The Two Minute Papers ferrofluid episodes make a strong pitch. The spikes can be faked in the shader. | M |
| 11 | *(stretch)* **Chocolate Kitchen** — melt, pour and bake with a temperature brush | MPM + thermal (viscosity vs. temperature) | WebGPU | Based on the thermomechanical MPM paper, and ties to food and ASMR trends. | M–L |
| 12 | *(stretch)* **Soap Bubbles** — blow, merge and pop bubbles with thin-film iridescence | Fake it: sphere or metaball physics plus thin-film interference shader | WebGL2 | Mostly a rendering trick, with high juice for low cost. | S |

**MVP recommendation:** ship toys 1, 2, 3 and 8 first. They are all WebGL2-fallback-friendly except the 3D mode of toy 2, and they cover grid, particle, CA and height-field. Together they give four very different textures.

---

## 7. Juice: rendering and feel tricks

**Fluids**
- **Screen-space fluid rendering (SSFR)** turns particles into a smooth liquid surface without meshing. It is used by WebGPU-Ocean and jeantimex/fluid.
  - Render sphere depth, smooth it with a bilateral filter or curvature flow, then reconstruct normals.
  - Add thickness-based absorption (Beer–Lambert) and Fresnel reflection and refraction.
  - Source: van der Laan, Green & Sainz, *Screen Space Fluid Rendering with Curvature Flow*, I3D 2009 ([ACM](https://dl.acm.org/doi/10.1145/1507149.1507164)).
  - matsuoka-601's extra tricks: velocity-stretched particles, density-based particle size, edge highlighting at depth discontinuities, half-resolution buffers ([Codrops](https://tympanus.net/codrops/2025/02/26/webgpu-fluid-simulations-high-performance-real-time-rendering/)).
- **Metaballs / SDF blobs** work best for 2D goo and ferrofluid. Additively splat radial falloff into a texture, threshold with smoothstep, then derive a normal from the gradient for fake specular.
- **Foam and spray secondary particles** are cheap, non-interacting particles spawned where velocity divergence or curvature is high. They add apparent detail for free (per the *Unified Spray, Foam and Bubbles* paper).
- **Vorticity confinement** re-injects curl lost to numerical dissipation. It is the difference between mushy and delicious smoke.

**Colour and light**
- **Bloom and HDR.** Use float buffers, dye values above 1, and a mip-chain bloom. Pavel's fluid owes much of its appeal to this.
- **Velocity-based colour ramps** (speed mapped to a palette, as in holtsetio/flow), temperature-to-blackbody for fire, and depth- or thickness-tinted water.

**Motion**
- **Motion blur and streaks.** Stretch particle billboards along velocity, use a temporal accumulation or feedback buffer, or draw trails.
- **Squash and stretch.** Scale sprites along the velocity or impact normal. For soft bodies, exaggerate by lowering stiffness briefly after impacts.
- **Hit-stop, screen shake and slow motion.** Freeze 30–60 ms on big impacts, add a camera shake scaled to impulse, and offer slow-motion replay for destruction. The canonical reference is *Juice it or lose it* by Jonasson & Purho, GDC Europe 2012 ([YouTube](https://www.youtube.com/watch?v=Fy0aCDmgnxg)).

**Feedback**
- **Audio.** Tie granular synth or sample pitch and volume to particle impact energy per frame. It is cheap and very effective.
- **Haptics.** `navigator.vibrate()` on Android pulses on impacts. iOS Safari does not support it.

**Scene and interaction**
- **Emissive glints.** Use sparkle BRDF noise on sand and snow (Two Minute Papers glitter episodes).
- **Caustics.** Project refracted rays from the height field onto the floor texture ([evanw/webgl-water](https://github.com/evanw/webgl-water)).
- **Input design.** Drags inject velocity plus dye, pinches push radial force, device tilt drives gravity, and a long-press spawns a material. The sim should react within one frame.

---

## 8. Recommended tech stack

```
App shell:     TypeScript + Vite (static hosting; add COOP/COEP headers for WASM threads)
GPU layer:     WebGPU (WGSL compute + render)  ── primary
               WebGL2 (fragment-shader ping-pong) ── fallback for 2D grid / CA / height-field toys
               Option: three.js WebGPURenderer + TSL (has built-in MLS-MPM example; auto-falls back
               to WebGL2 for render, but compute-heavy toys still need WebGPU)
CPU layer:     Rust or C++ → WASM (SIMD) for CA sand, 2D XPBD, AVBD-2D, fracture; run in a Worker
Rigid bodies:  Box2D v3 (box2d3-wasm) for 2D; Rapier (deterministic) or Jolt for 3D
Shared GPU kit (build once):
   - particle buffers + counting-sort spatial hash (prefix-sum)       → SPH/PBF/XPBD collisions
   - P2G/G2P with fixed-point atomics                                  → MLS-MPM
   - ping-pong grid + Jacobi/Red-black GS pressure                     → smoke/fire/FLIP
   - post chain: HDR target → bloom → tonemap → optional feedback blur
   - SSFR pass (depth, thickness, bilateral blur, shade)
Quality scaler: per-device tier (particle count, grid res, substeps) + runtime fps governor
```

**Capability detection:** use `navigator.gpu` together with a successful `requestAdapter()` and the required limits (e.g. `maxStorageBufferBindingSize`, `maxComputeWorkgroupsPerDimension`). If that fails, choose the WebGL2 variant of the toy, or hide the toy.

**Why not a single engine?** No existing browser engine covers grid fluids, MPM and CA together. Genesis and Newton do in Python/CUDA, but that does not help in the browser. The shared-kit approach above keeps each toy small (a solver file plus a renderer plus UI) while reusing about 70% of the code.

---

## 9. Learning path for the team
1. Ten Minute Physics #01–#18. Each is about 10 minutes with a runnable JS demo: [index](https://matthias-research.github.io/pages/tenMinutePhysics/index.html), [source repo](https://github.com/matthias-research/pages).
2. Sebastian Lague, *Simulating Fluids* (SPH) and *Simulating Smoke* (grid), for intuition and debugging visualisations.
3. `mls-mpm88-explained.cpp` ([taichi_mpm](https://github.com/yuanming-hu/taichi_mpm)), then read WebGPU-Ocean's WGSL.
4. The Noita GDC talk for CA architecture.
5. The AVBD 2D reference for modern rigid/soft solvers.

---

## 10. References (verified)

**Foundational papers**
- Stam, *Stable Fluids*, SIGGRAPH 1999 — https://dl.acm.org/doi/10.1145/311535.311548
- Stam, *Real-Time Fluid Dynamics for Games*, GDC 2003 — https://pdfs.semanticscholar.org/5127/ac7b58e36ffd13ca4437fc123c6a018dc436.pdf
- Müller et al., *Meshless Deformations Based on Shape Matching*, SIGGRAPH 2005 — https://dl.acm.org/doi/10.1145/1073204.1073216
- Müller et al., *Position Based Dynamics*, 2007 — https://matthias-research.github.io/pages/publications/posBasedDyn.pdf
- van der Laan, Green, Sainz, *Screen Space Fluid Rendering with Curvature Flow*, I3D 2009 — https://dl.acm.org/doi/10.1145/1507149.1507164
- Macklin & Müller, *Position Based Fluids*, SIGGRAPH 2013 — https://dl.acm.org/doi/10.1145/2461912.2461984
- Stomakhin et al., *A Material Point Method for Snow Simulation*, SIGGRAPH 2013 — http://alexey.stomakhin.com/research/snow.html
- Müller, Chentanez, Kim, *Real Time Dynamic Fracture with VACD*, SIGGRAPH 2013 — https://dl.acm.org/doi/10.1145/2461912.2461934
- Macklin et al., *Unified Particle Physics for Real-Time Applications*, SIGGRAPH 2014 — https://mmacklin.com/uppfrta_preprint.pdf
- Jiang et al., *The Affine Particle-In-Cell Method*, SIGGRAPH 2015 — https://dl.acm.org/doi/10.1145/2766996
- Klár et al., *Drucker-Prager Elastoplasticity for Sand Animation*, SIGGRAPH 2016 — https://dl.acm.org/doi/10.1145/2897824.2925906
- Macklin, Müller, Chentanez, *XPBD*, MIG 2016 — https://dl.acm.org/doi/10.1145/2994258.2994272
- Hu et al., *MLS-MPM*, SIGGRAPH 2018 — https://yuanming.taichi.graphics/publication/2018-mlsmpm/
- Li et al., *Incremental Potential Contact*, SIGGRAPH 2020 — https://ipc-sim.github.io/

**Recent work (2023–2026)**
- Jeschke & Wojtan, *Generalizing Shallow Water Simulations with Dispersive Surface Waves*, SIGGRAPH 2023 — https://research.nvidia.com/publication/2023-08_generalizing-shallow-water-simulations-dispersive-surface-waves
- Chen, Liu, Yang, Yuksel, *Vertex Block Descent*, SIGGRAPH 2024 — https://graphics.cs.utah.edu/research/projects/vbd/ · https://arxiv.org/abs/2403.06321
- *Position-Based Nonlinear Gauss-Seidel for Quasistatic Hyperelasticity*, SIGGRAPH 2024 — https://dl.acm.org/doi/10.1145/3658154
- Ando, *A Cubic Barrier with Elasticity-Inclusive Dynamic Stiffness*, SIGGRAPH Asia 2024 — https://dl.acm.org/doi/abs/10.1145/3687908
- Giles, Diaz, Yuksel, *Augmented Vertex Block Descent*, SIGGRAPH 2025 — https://graphics.cs.utah.edu/research/projects/avbd/
- Chen et al., *Offset Geometric Contact*, SIGGRAPH 2025 — https://graphics.cs.utah.edu/research/projects/ogc/
- Lan et al., *JGS2*, 2025 — https://arxiv.org/abs/2506.06494
- Xu et al., *Hybrid Neural-MPM for Interactive Fluid Simulations in Real-Time*, 2025 — https://arxiv.org/abs/2505.18926
- Tang et al., *The Granule-In-Cell Method for Simulating Sand–Water Mixtures*, SIGGRAPH Asia 2025 — https://arxiv.org/abs/2504.00745
- *MGPBD: Multigrid Accelerated Global XPBD*, 2025 — https://arxiv.org/pdf/2505.13390

**Code and demos**
- Ten Minute Physics — https://matthias-research.github.io/pages/tenMinutePhysics/index.html · https://github.com/matthias-research/pages · Rust port https://github.com/lucas-schuermann/ten-minute-physics-rs
- Pavel Dobryakov WebGL fluid — https://github.com/PavelDoGreat/WebGL-Fluid-Simulation
- WebGPU-Ocean (MLS-MPM + SSFR) — https://github.com/matsuoka-601/webgpu-ocean · WaterBall https://github.com/matsuoka-601/waterball
- holtsetio/flow (three.js TSL MLS-MPM) — https://github.com/holtsetio/flow
- three.js WebGPU examples — https://threejs.org/examples/webgpu_compute_particles_fluid.html · https://threejs.org/examples/webgpu_compute_particles.html
- jeantimex/fluid (WebGPU SPH/FLIP, 6 renderers) — https://github.com/jeantimex/fluid
- Sebastian Lague Fluid-Sim — https://github.com/SebLague/Fluid-Sim
- Taichi mpm88 — https://github.com/taichi-dev/taichi/blob/master/python/taichi/examples/simulation/mpm88.py · taichi_mpm https://github.com/yuanming-hu/taichi_mpm · JS port https://github.com/r03ert0/mls-mpm.js
- WebGPU XPBD cloth — https://github.com/ccincotti3/webgpu_cloth_simulator · https://github.com/jspdown/cloth
- AVBD reference — https://github.com/savant117/avbd-demo2d · https://github.com/savant117/avbd-demo3d · WebGPU port https://github.com/jure/webphysics
- Sandspiel — https://github.com/MaxBittker/sandspiel · GPU CA https://github.com/GelamiSalami/GPU-Falling-Sand-CA
- WebGL water — https://github.com/evanw/webgl-water
- Box2D v3 WASM — https://github.com/Birch-san/box2d3-wasm · Rapier https://rapier.rs/ · Jolt https://github.com/jrouwe/JoltPhysics.js/
- IPC — https://github.com/ipc-sim/IPC · PPF contact solver https://github.com/st-tech/ppf-contact-solver
- Genesis — https://github.com/Genesis-Embodied-AI/Genesis · NVIDIA Newton https://github.com/newton-physics/newton
- Shadertoy *Chimera's Breath* — https://www.shadertoy.com/view/4tGfDW

**Talks and videos**
- Noita GDC 2019 — https://www.youtube.com/watch?v=prXuyMCgbTc
- Juice it or lose it (GDC EU 2012) — https://www.youtube.com/watch?v=Fy0aCDmgnxg
- Sebastian Lague, Simulating Fluids — https://www.youtube.com/watch?v=rSKMYc1CQHE · Simulating Smoke — https://www.youtube.com/watch?v=Q78wvrQ9xsU
- Codrops, WebGPU Fluid Simulations — https://tympanus.net/codrops/2025/02/26/webgpu-fluid-simulations-high-performance-real-time-rendering/
- Two Minute Papers → paper index (gist) — https://gist.github.com/randompast/1633dc353a7bfa3bf3fbaa54c4a5cd35

**Caveats**
- The Two Minute Papers 2015–2022 entries come from the community gist and were not re-watched.
- The 2024-09 "Impossible Water Simulation" episode's paper is inferred from summaries describing an NVIDIA + ISTA shallow-water paper.
- The JGS2 video date and URL come from a third-party summary site.
- Particle counts marked (est) are unbenchmarked.
