# Cloth and Knitting Physics Playgrounds: Research for bobo

Companion to [physics.md](physics.md). The current cloth toy is Tear Sheet (`src/toys/cloth`).

Prepared 2026-09-23. Audience: the bobo team (TypeScript, WebGL2/WebGPU, target 60 fps on iPhone 13 mini). Every link below was checked, either by fetching it directly or, for sites that block bots (ACM DL, ResearchGate, Shadertoy, CodePen), by finding it in search results. Numbers marked **(est)** are my own estimates and have not been measured.

---

## 1. Summary

- **Keep XPBD with substeps as the core solver.** Use "Small Steps" (many substeps, 1 iteration each), long-range attachments, and a spatial hash for self-collision. It is the best-understood, cheapest and most robust method that works in the browser, and Ten Minute Physics #14/#15 give you readable reference JS for all of it. Vertex Block Descent (VBD, 2024), Augmented VBD (2025) and Offset Geometric Contact (OGC, 2025) are where the field is heading. On a phone they are only worth it with a GPU backend, and XPBD is enough for toys.
- **Don't simulate real yarn-level knits on a phone.** Yarn-level knit simulation (Kaldor 2008/2010, Cirio 2014, Leaf 2018) is offline or desktop-GPU-bound. The practical trick comes from Sperl et al.: simulate a coarse cloth sheet, then deform or animate yarn geometry on top of it based on triangle strain (Homogenized Yarn-Level Cloth 2020, then Mechanics-Aware Deformation of Yarn Pattern Geometry 2021, which has open-source code). The player sees loops tighten and stretch, while the physics stays a few thousand particles.
- **Treat unravelling as a topology event, not a yarn simulation.** Keep a knit graph (stitch mesh). When the player pulls the free end, stitches pop one at a time: cloth particles/triangles are removed and turned into rod segments that join a free yarn strand (an XPBD/Cosserat rod). The strand keeps a crimp or kink rest shape, which gives the ramen-noodle look. This is the single most novel and satisfying toy on the list.
- **Rendering does half the "juice".** Use knit normal maps whose UVs are warped by cloth strain, a Charlie/Estevez-Kulla sheen, Kajiya-Kay highlights on yarn strands, a procedural ply twist and fuzz (after Wu and Yuksel's real-time fiber rendering), and ambient occlusion in the loop valleys. All of this is cheap in a fragment shader.
- **Phone budget (est):** CPU/JS XPBD cloth at about 1.5k–4k particles, 10–20 substeps. WASM+SIMD gives roughly 2x that. WebGPU compute (Safari 26 / iOS 26 ships WebGPU) gives 16k–64k particles if you use graph-coloured Gauss-Seidel or Jacobi+Chebyshev. Rods for yarn: 500–3k segments on CPU.

---

## 2. Technique catalog

| Technique | What it is / why it matters for toys | Browser/phone fit | Key refs |
|---|---|---|---|
| **PBD** (Müller et al. 2007) | Projects positions onto constraints directly. Unconditionally stable and easy to control, but stiffness depends on iteration count. | Excellent; the baseline | [PDF](https://www.cs.toronto.edu/~jacobson/seminar/mueller-et-al-2007.pdf) |
| **XPBD** (Macklin, Müller, Chentanez 2016) | Adds compliance (α) and Lagrange multipliers so stiffness is physical and independent of timestep and iteration count. Lets you tune separate stretch, shear and bend "materials". | Excellent | [ACM DL](https://dl.acm.org/doi/10.1145/2994258.2994272) |
| **Small Steps** (Macklin et al. 2019) | n substeps × 1 iteration beats 1 step × n iterations: stiffer cloth, less damping, simpler code. What TMP #14 uses. | Excellent; CPU cost scales linearly with substeps | [PDF](https://mmacklin.com/smallsteps.pdf) |
| **Long-Range Attachments (LRA)** (Kim, Chentanez, Müller 2012) | Unilateral "max distance" tethers from each particle to its pin points. Stops rubbery stretching of hanging cloth for almost no cost. Great for flags, curtains, hammocks and scarves hanging off needles. | Excellent; O(N) | [ACM DL](https://dl.acm.org/doi/10.5555/2422356.2422399) |
| **Bending models** | (a) distance constraint across the two opposite vertices of each triangle pair (cheap, what TMP #14 does); (b) dihedral-angle constraint (more accurate, costs a trig per edge); (c) isometric/quadratic bending (a constant matrix per edge, well suited to near-inextensible cloth). For knits use *low* bending. For woven or "cardboard" materials use high bending. | (a) best for phones | TMP #14 ([demo](https://matthias-research.github.io/pages/tenMinutePhysics/14-cloth.html), [notes PDF](https://matthias-research.github.io/pages/tenMinutePhysics/14-cloth.pdf)) |
| **Self-collision** (TMP #15) | Particle-particle self-collision over a spatial hash (from TMP #11), plus "five tricks" for stability. My paraphrase, not checked against the video: particle thickness relative to rest length, skipping pairs that are already close in the rest pose, friction, clamping per-substep motion, and querying the hash once per frame rather than every substep. | Good up to about 2–4k particles on CPU (est) | [demo](https://matthias-research.github.io/pages/tenMinutePhysics/15-selfCollision.html), [video](https://youtu.be/XY3dLpgOk4Q), [hashing #11](https://matthias-research.github.io/pages/tenMinutePhysics/11-hashing.html) |
| **GPU cloth: graph colouring** | Colour constraints so no two in a colour share a particle, then run Gauss-Seidel one colour at a time in parallel. Grid cloth needs only about 4 colours for stretch (8–12 including shear and bend). Vivace does randomized colouring per frame, which supports tearing and topology changes. | WebGPU compute; 1 dispatch per colour per substep | [Vivace (Fratarcangeli 2016)](https://mfratarcangeli.github.io/publication/sigasia2016/) |
| **GPU cloth: Jacobi + Chebyshev** | Solve all constraints at once, average the corrections, and accelerate convergence with Chebyshev. Fewer dispatches than colouring, and it also works in WebGL2 via ping-pong textures. | WebGPU **or** WebGL2 fragment GPGPU | [Wang 2015](https://wanghmin.github.io/publication/wang-2015-csi/) |
| **Projective Dynamics** (Bouaziz et al. 2014) | Local projections plus a global solve with a prefactored matrix. Converges fast, but prefactoring is costly after topology changes such as tearing, so it's not ideal for tearable toys. | Meh for tearing, fine for fixed meshes | [PDF](https://users.cs.utah.edu/~ladislav/bouaziz14projective/bouaziz14projective.pdf) |
| **Vertex Block Descent** (Chen, Liu, Yang, Yuksel, SIGGRAPH 2024) | Per-vertex Newton step on the implicit-Euler variational energy, run Gauss-Seidel style with vertex colouring. Unconditionally stable, handles high mass ratios where XPBD fails (per the authors: 1:2000), and runs to a fixed iteration budget. Code: [Gaia](https://github.com/AnkaChan/Gaia) and [TinyVBD](https://github.com/AnkaChan/TinyVBD). | Good on WebGPU (per-vertex parallel). Heavier per iteration than XPBD. | [project](https://ankachan.github.io/Projects/VertexBlockDescent/index.html), [arXiv](https://arxiv.org/abs/2403.06321) |
| **Augmented VBD** (Giles, Diaz, Yuksel, SIGGRAPH 2025) | VBD plus augmented Lagrangian: hard constraints, joints, rigid stacking and rigid–soft coupling in one solver. Jure Triglav's WebGPU rigid-body port exists ([demo](https://jure.github.io/webphysics), [repo](https://github.com/jure/webphysics)). | Promising for a unified cloth+rigid world on WebGPU | [project](https://graphics.cs.utah.edu/research/projects/avbd/), [video](https://www.youtube.com/watch?v=bwJgifqvd5M) |
| **Offset Geometric Contact** (Chen et al., SIGGRAPH 2025) | Each face is offset along its normal to form a contact volume. Per-vertex displacement bounds guarantee no penetration without CCD, and it runs massively parallel. Per the authors: 246K verts at 6.3 ms/step on an RTX 4090. | The *displacement-bound* idea is a cheap trick to steal for CPU XPBD (clamp per-substep motion to about 0.4×thickness). The full method needs GPU. | [project](https://graphics.cs.utah.edu/research/projects/ogc/), [video](https://www.youtube.com/watch?v=xxyniqSLJik), [3rd-party impl](https://github.com/mmtmn/OGC) |
| **IPC / C-IPC** (Li, Kaufman, Jiang 2021) | Barrier-based, intersection-free, strain-limited. Home of the famous tablecloth-pull demo. | Offline; use it as a *visual reference*, not a technique | [project](https://ipc-sim.github.io/C-IPC/) |
| **Tearing: constraint removal** | Delete a distance constraint when strain exceeds a threshold. Trivial, but leaves "hairy" edges and the render mesh doesn't split unless you rebuild the index buffer. | Easiest; FurkanZhlp's cloth-sim rebuilds tri/edge buffers on the fly | [cloth-sim](https://github.com/FurkanZhlp/cloth-sim) |
| **Tearing: vertex splitting** | When an edge breaks, duplicate one endpoint, split the incident triangles by a plane perpendicular to the edge, and reassign them. Gives clean cuts and render-correct seams. Mark the new boundary edges for a frayed-edge shader. | Recommended for bobo; O(valence) per tear | [Fast Simulation of Cloth Tearing](https://www.researchgate.net/publication/264457835_Fast_Simulation_of_Cloth_Tearing), [soft-body tearing under 10 ms in VR](https://arxiv.org/pdf/2205.00914) |
| **Cloth–rigid / ball coupling** | Simplest: analytic sphere/capsule/box SDF colliders, with the positional correction applied to the particle only (one-way). Two-way: apply the inverse-mass-weighted correction to the rigid body as a positional impulse (XPBD rigid bodies, Müller et al. 2020; TMP #22). | Good; balls on a trampoline, dishes on a tablecloth | [XPBD rigid bodies](https://onlinelibrary.wiley.com/doi/10.1111/cgf.14105), [TMP #22 video](https://youtu.be/euypZDssYxE) |
| **Wind / aerodynamics** | Per-triangle drag and lift: `F = ½ρ·Cd·A·(v_rel·n)|v_rel|·n` plus a small tangential friction term, split across the 3 vertices. Add gusts with curl-noise in world space. Scaled by fabric areal density so it doesn't depend on mesh resolution. | Very cheap; one pass over triangles | [cloth-sim README](https://github.com/FurkanZhlp/cloth-sim) (same model) |
| **Elastic rods (DER)** (Bergou et al. 2008) | Centreline plus twist via a discrete material frame. The canonical model for yarn, hair and rope. | Implementable on CPU for about 1k segments (est) | [project](https://www.cs.columbia.edu/cg/rods/) |
| **XPBD / Cosserat rods** (Kugelstadt & Schömer 2016; Deul et al. 2018) | Quaternion per segment with stretch-shear and bend-twist constraints. Fits straight into an XPBD cloth solver. Deul's direct solver handles stiff rods. Reference C++: [PositionBasedDynamics](https://github.com/InteractiveComputerGraphics/PositionBasedDynamics). | Excellent. The recommended yarn model for bobo. | [Kugelstadt](https://animation.rwth-aachen.de/publication/0550/), [Deul](https://animation.rwth-aachen.de/publication/0557/) |

---

## 3. Yarn / knit / woven research, and what's fakeable

### 3.1 The core papers

| Paper | Key idea | Real-time feasibility on phone | Fake/approx strategy for bobo |
|---|---|---|---|
| **Kaldor, Marschner, James — Simulating Knitted Cloth at the Yarn Level (SIGGRAPH 2008)** ([PDF](https://www.cs.cornell.edu/~srm/publications/SG08-knit-lr.pdf), [Cornell project](https://research.cs.cornell.edu/YarnCloth/)) | Each yarn is an inextensible B-spline tube with contact penalties. The yarn end is "glued" to stop it unravelling. | No: minutes per frame on 2008 hardware | Borrow the *glue constraint* idea. The yarn end is pinned until the player grabs it, and releasing the glue is what starts the unravel. |
| **Kaldor, James, Marschner — Efficient Yarn-based Cloth with Adaptive Contact Linearization (SIGGRAPH 2010)** ([ACM DL](https://dl.acm.org/doi/10.1145/1833349.1778842)) | Linearizes yarn–yarn contact forces and updates them adaptively, since internal contacts are temporally coherent. | No | The general lesson: contacts inside a knit are persistent, so precompute them rather than detect them. |
| **Cirio, Lopez-Moreno, Miraut, Otaduy — Yarn-Level Simulation of Woven Cloth (SIGGRAPH Asia 2014)** ([ACM DL](https://dl.acm.org/doi/10.1145/2661229.2661279)) | Discretizes at yarn *crossings*, with Eulerian sliding coordinates so contact is implicit. Follow-ups (2015–2017) extend this to knits with persistent or sliding contacts. | Close: a small woven patch (e.g. 32×32 crossings) is feasible on CPU (est) | **Loom toy:** warp and weft as rods whose crossing nodes are shared particles with a 1-D sliding DOF. Pull a single thread and watch the weave pucker. |
| **Yuksel, Kaldor, James, Marschner — Stitch Meshes (SIGGRAPH 2012)** ([project](https://www.cemyuksel.com/research/stitchmeshes/)) | A polygonal "stitch mesh", where each face is a stitch type (knit, purl, increase, decrease…), is converted into yarn curves and relaxed. | The *data structure* is perfect for games | Use a stitch mesh as bobo's knit graph: each quad face has its own yarn loop tile, rows are ordered, and the ordering defines the unravel sequence. |
| **Wu, Swan, Yuksel — Knittable Stitch Meshes (TOG 2019)** ([project](https://kuiwuchn.github.io/KnittableStitchMesh/), [video](https://www.youtube.com/watch?v=9jcoREh70Bg)) | Stitch meshes that are guaranteed hand-knittable, plus a scheduling algorithm that generates step-by-step instructions. | Data/algorithm only | "Knit it for real" export: a bobo creation produces real knitting instructions. Nice shareable hook. |
| **Leaf, Wu, Schweickart, James, Marschner — Interactive Design of Periodic Yarn-Level Cloth Patterns (SIGGRAPH Asia 2018)** ([PDF](https://graphics.stanford.edu/projects/yarnsim/assets/interactive_design_of_periodic_yarn_level_cloth_patterns.pdf), [video](https://www.youtube.com/watch?v=APPLKMRU9WU)) | Simulates only a *small periodic tile* (periodic boundaries) on the GPU, so you can edit patterns interactively. Includes a public pattern dataset. | A single periodic tile of about 1–4 stitches is feasible (est) | **Offline:** bake relaxed loop geometry per stitch type. **Runtime:** instance the baked tile. You could even run a tiny live tile sim in a "zoom lens" UI. |
| **Sperl, Narain, Wojtan — Homogenized Yarn-Level Cloth (SIGGRAPH 2020)** ([project](https://visualcomputing.ist.ac.at/publications/2020/HYLC/), [talk](https://www.youtube.com/watch?v=qrDczRcuB3Y)) | Runs yarn-level simulations of periodic tiles offline and fits an energy-density function of strain, which a thin-shell solver then uses. Captures knit anisotropy and stretchiness. | The *resulting material* is cheap | Approximate with **anisotropic XPBD compliance**: course direction much softer than wale, very soft shear, low bending, plus a strain-limit tether at about 1.6× (est). That gives the floppy, stretchy "knit" feel. |
| **Sperl, Narain, Wojtan — Mechanics-Aware Deformation of Yarn Pattern Geometry (SIGGRAPH 2021)** ([project](https://visualcomputing.ist.ac.at/publications/2021/MADYPG/), [code](https://github.com/kamleshbhalui/MADYPG), [video](https://www.youtube.com/watch?v=rO10fjzOzWM)) | Precomputes yarn geometry as a function of in-plane strain, then interpolates it per triangle on a real-time cloth mesh, so loops tighten when stretched. Explicitly real-time. | **Yes**, the key enabler | Cheap version: store 3–5 baked normal/height maps of a stitch tile at different strains (relaxed, stretched in X, stretched in Y, sheared). The fragment shader blends them using per-vertex strain passed from the solver. Full version: vertex-shader yarn tubes à la MADYPG. |
| **Kaldor/Cirio follow-ups on unravelling** | Unravelling is mostly *avoided* in the research (the glue constraint). Materials-science work studies it mechanically ([Unravelling the Mechanics of Knitted Fabrics, 2023](https://arxiv.org/pdf/2307.12360)). | n/a | This gap is bobo's opportunity: design unravel as a gameplay topology event (see Toy 1). |
| **KnitScape (CHI 2024)** ([repo](https://github.com/knitscape/knitscape), [CHI24 demo](https://machineagency.github.io/knitscape-2024/), [video](https://www.youtube.com/watch?v=rtc72bLLm6w)) | A **browser JS** yarn-level spring simulation built on a topology graph (TopoKnit) for slip/tuck colourwork. | **Yes**: runs client-side in JS today | The closest existing proof that browser yarn-level knitting is feasible on 2D patches. Study its graph representation. |

### 3.2 Knit and fibre rendering

- **Wu & Yuksel, Real-time Fiber-level Cloth Rendering (I3D 2017)** ([TVCG PDF](https://www.cemyuksel.com/research/papers/real-time_cloth_rendering_with_fiber-level_detail_tvcg2017.pdf), [page](https://people.csail.mit.edu/kuiwu/rtfr.html)): generates fibres procedurally from yarn control points on the GPU and collapses the core fibres into one. For phone, use the shader idea only: ply twist as a helical normal perturbation along the tube's v coordinate, plus flyaway fuzz as alpha-tested fins or a rim-lit noise halo.
- **Zhao, Luan, Bala, Fitting Procedural Yarn Models (SIGGRAPH 2016)** ([ACM DL](https://dl.acm.org/doi/10.1145/2897824.2925932)): gives the parameter vocabulary for procedural yarn: ply count, ply twist, fibre migration, flyaways. Useful for designing yarn "presets" such as chunky wool, cotton or mohair.
- **Sheen:** [Estevez & Kulla "Charlie" sheen (2017)](https://blog.selfshadow.com/publications/s2017-shading-course/imageworks/s2017_pbs_imageworks_sheen.pdf); the same model is used by [glTF KHR_materials_sheen](https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_sheen/README.md). Cheap and it reads as "fabric" immediately.
- **Strand highlights:** Kajiya-Kay/Marschner-style anisotropic highlights along the yarn tangent. The cloth UV's course direction gives the tangent for free.
- **Shadertoy reference:** "Knits & Sips", a Revision 2023 4k entry with a knitted object ([shadertoy.com/view/csVXzK](https://www.shadertoy.com/view/csVXzK)), and "Cloth Shading" ([4tfBzn](https://www.shadertoy.com/view/4tfBzn)).

---

## 4. Existing playgrounds, demos and code

### 4.1 Browser cloth, rod and soft-body code

| Project | What / why look | Link |
|---|---|---|
| Ten Minute Physics (Müller) | Tiny single-file JS demos with videos. #14 cloth, #15 self-collision, #16 GPU sim, #11 hashing, #10 soft bodies, #22 rigid bodies, #25 joints. Canonical reference for bobo's CPU solver. | [index](https://matthias-research.github.io/pages/tenMinutePhysics/index.html), [repo](https://github.com/matthias-research/pages), [#14 video](https://youtu.be/z5oWopN39OU), [#16 GPU video](https://youtu.be/q4rNoupGr8U) |
| FurkanZhlp/cloth-sim | Single-file browser XPBD cloth: 10–30 substeps, self-collision via hash, per-triangle aero wind, tearing with index-buffer rebuild, WebGL2 fabric shading. The closest existing thing to bobo's current toy. | [repo](https://github.com/FurkanZhlp/cloth-sim), [live](https://furkanzhlp.github.io/cloth-sim/) |
| Carmen Cincotti WebGPU XPBD cloth | Blog series plus code: XPBD, spatial hash, self-collision on WebGPU. | [repo](https://github.com/ccincotti3/webgpu_cloth_simulator), [blog](https://carmencincotti.com/posts/categories/cloth-simulation/) |
| jspdown/cloth | WebGPU XPBD with small steps, fully on GPU. | [repo](https://github.com/jspdown/cloth) |
| RykaKa/webgpu-xpbd-cloth | Another WebGPU XPBD cloth. | [repo](https://github.com/RykaKa/webgpu-xpbd-cloth) |
| nakjun/Cloth-Simulation-WebGPU | WebGPU mass-spring with BVH collision. Its paper reports 640K nodes at 60 fps on an RTX 4070 Ti (desktop only). | [repo](https://github.com/nakjun/Cloth-Simulation-WebGPU), [paper](https://arxiv.org/html/2507.11794) |
| three.js WebGPU compute cloth | Official example: verlet cloth in TSL compute shaders. | [example](https://threejs.org/examples/webgpu_compute_cloth.html) |
| bandinopla/three-simplecloth | three.js WebGPU cloth on skinned meshes, sphere colliders, grabbing. | [repo](https://github.com/bandinopla/three-simplecloth) |
| cannon-es cloth | Classic particle-and-spring cloth demo (baseline "feel" comparison). | [demo](https://pmndrs.github.io/cannon-es/examples/threejs_cloth) |
| JoltPhysics.js | WASM Jolt with XPBD soft bodies: cloth, bend and LRA constraints, pressure soft bodies. Rapier has no cloth/soft bodies. | [demos](https://jrouwe.github.io/JoltPhysics.js/) |
| WebPhysics (AVBD on WebGPU) | Rigid-only today, but it shows AVBD running in the browser. | [demo](https://jure.github.io/webphysics), [repo](https://github.com/jure/webphysics) |
| Newton (NVIDIA/Disney/DeepMind) | Warp-based engine with the official VBD solver (cloth, AVBD rigid, coupling) by Anka Chen. The best-maintained VBD reference code. | [repo](https://github.com/newton-physics/newton) |
| PositionBasedDynamics (Bender) | C++ reference for PBD/XPBD cloth, Cosserat rods and the direct stiff-rod solver. Port the rod constraints from here. | [repo](https://github.com/InteractiveComputerGraphics/PositionBasedDynamics) |
| aryamancodes Rope-and-Cloth | Simple p5.js verlet rope and cloth. | [repo](https://github.com/aryamancodes/Rope-and-Cloth-Simulation) |

### 4.2 Knitting and crochet web toys and tools

| Project | Notes | Link |
|---|---|---|
| KnitScape | Browser yarn-level spring sim of knit topology; JS | [repo](https://github.com/knitscape/knitscape), [demo](https://machineagency.github.io/knitscape-2024/) |
| Crochet Simulator | Rust→WASM plus Next.js. Real loop-through-loop crochet topology relaxed with springs and a **Discrete Elastic Rod bending term**; renders yarn tubes. The best existing proof of browser yarn physics for crochet. | [repo](https://github.com/yunniko/crochet-simulator), [live](https://crochet.app.craftodejnice.cz) |
| Stitch Maps | Grid-free knit charts showing how stitches flow row to row (a UX reference for a knit editor) | [site](https://stitch-maps.com/) |

### 4.3 Games with satisfying cloth or yarn (feel references)

- **Unravel** (Coldwood/EA, 2016): Yarny unspools a finite yarn trail used as a tether, swing rope and bridge. The finite-length yarn is both the core mechanic and the emotional hook. [Steam](https://store.steampowered.com/app/1225560/Unravel/)
- **Kirby's Epic Yarn** (2010) and **Yoshi's Woolly World** (2015): photographed real fabrics on polygons, deformable yarn outlines and a "yarn whip". They show that stylized textures plus soft deformation read as "yarn" without any real yarn simulation. [KEY wiki](https://en.wikipedia.org/wiki/Kirby%27s_Epic_Yarn), [Woolly World wiki](https://en.wikipedia.org/wiki/Yoshi%27s_Woolly_World)
- **Woolly Boy and the Circus** (2023, iOS/Steam): a hand-painted point-and-click puzzle game. Its store pages describe **no yarn physics**, so it's only an art-style reference. [Steam](https://store.steampowered.com/app/2233920/woolly_boy_and_the_circus/)

---

## 5. Two Minute Papers and other videos (checked via YouTube oEmbed)

"2MP #n" is a Two Minute Papers episode number; elsewhere in this doc "TMP #n" means Ten Minute Physics.

| Video | Topic |
|---|---|
| [Efficient Yarn-based Cloth Simulations — 2MP #166](https://www.youtube.com/watch?v=oltKUPTBz9Q) | Kaldor et al. 2010 adaptive contact linearization |
| [Modeling Knitted Clothing — 2MP #140](https://www.youtube.com/watch?v=UEPbzj-ekAI) | Stitch Meshes (Yuksel et al.) |
| [9 Years of Progress In Cloth Simulation!](https://www.youtube.com/watch?v=rzIiuGrOZAo) | Per a community index of Two Minute Papers episodes, this is the episode covering Homogenized Yarn-Level Cloth (Sperl 2020) |
| [From Mesh To Yarn... In Real Time!](https://www.youtube.com/watch?v=d3njVfnCdN0) | Mechanics-Aware Deformation of Yarn Pattern Geometry (Sperl 2021): the most relevant one for bobo |
| [Finally, This Table Cloth Pull is Now Possible!](https://www.youtube.com/watch?v=KZhoU_3k0Nk) | C-IPC tablecloth pull |
| [Episode 500 - 8 Years Of Progress In Cloth Simulations!](https://www.youtube.com/watch?v=7O7W-_FKRMQ) | Cloth progress overview |
| [Is Simulating Tiny Cloth Wrinkles Possible?](https://www.youtube.com/watch?v=Mrdkyv0yXxY) | Fine wrinkle detail |
| [Why Are Cloth Simulations So Hard?](https://www.youtube.com/watch?v=UoKXJzTYDpw) | General |
| [Procedural Yarn Models for Cloth Rendering — 2MP #76](https://www.youtube.com/watch?v=iTRnr6p7iYo) | Zhao et al. 2016 |
| [Real-Time Fiber-Level Cloth Rendering — 2MP #132](https://www.youtube.com/watch?v=JzOc_NNY_zY) | Wu & Yuksel 2017 |
| [Elastoplastic Hair and Cloth Simulations — 2MP #176](https://www.youtube.com/watch?v=RygQnpQMdPI) | Hair and cloth plasticity |
| [Animating Elastic Rods With Sound — 2MP #175](https://www.youtube.com/watch?v=6c2T2cykE_A) | Rod sound synthesis (audio juice idea) |
| [5 Crazy Simulations That Were Previously Impossible!](https://www.youtube.com/watch?v=lxzGraohijU) | IPC-family contact demos |
| [Adaptive Cloth Simulations — 2MP #14](https://www.youtube.com/watch?v=LU3pdWTD4Rw) | Adaptive remeshing |

Other useful videos: [OGC SIGGRAPH 2025](https://www.youtube.com/watch?v=xxyniqSLJik), [AVBD SIGGRAPH 2025](https://www.youtube.com/watch?v=bwJgifqvd5M), [Playing with AVBD (Alexander Sannikov)](https://www.youtube.com/watch?v=iUT-E7-mSdI), [HYLC talk](https://www.youtube.com/watch?v=qrDczRcuB3Y), [MADYPG](https://www.youtube.com/watch?v=rO10fjzOzWM), [Knittable Stitch Meshes](https://www.youtube.com/watch?v=9jcoREh70Bg), [Periodic yarn patterns (Leaf)](https://www.youtube.com/watch?v=APPLKMRU9WU), [Ten Minute Physics #14 cloth](https://youtu.be/z5oWopN39OU), [Ten Minute Physics #15 self-collision](https://youtu.be/XY3dLpgOk4Q).

---

## 6. Toy ideas for bobo

The shared engine is one XPBD solver with particles, distance/bend/tether constraints, Cosserat-rod segments, SDF colliders and a spatial hash. Every budget figure below is **(est)** for iPhone 13 mini on the CPU/JS path at 60 fps with about 4–6 ms of physics budget, unless noted otherwise.

### Toy 1: "Pull the Thread" (unravel a sweater) ★ signature toy
- **Fantasy:** A cosy sweater, scarf or mitten sits on screen. A loose yarn end pokes out. Drag it and stitches pop out row by row, the garment shrinks, and a kinked noodle of yarn piles up on the floor. Pull fast for a zip-zip-zip cascade, or slowly for a satisfying pop, pop, pop.
- **Core technique:** A knit graph (stitch mesh) over an XPBD cloth grid, with 1 cloth particle per stitch-column/row intersection. Each stitch has a yarn length L_s. The free yarn is a Cosserat/XPBD rod. When pull tension on the rod exceeds a threshold, the "front" stitch is consumed: delete its cloth constraints (vertex-split any triangle faces) and append about 4–6 rod segments carrying its yarn length, with rest curvature set to a crimp or zigzag (yarn memory). Unravel order follows knit-row order, so a row is consumed back and forth, or spirals for a tube.
- **Budget (est):** 40×30 stitches is 1.2k cloth particles, plus up to about 1.5k rod segments on the floor. Put rod segments that have come to rest to sleep, then freeze and merge them into a static "yarn pile" mesh.
- **Rendering juice:** A knit tile normal map plus strain-blended tightened/loosened variants (MADYPG-lite). The free yarn is an instanced tube with helical ply normals, Kajiya-Kay highlights and fuzz rim. A tiny puff of fibre particles and a pitch-rising pluck sound on each stitch pop. Camera nudge on row completion.
- **Effort:** M–L.
- **Refs:** Stitch Meshes, Kaldor 2008 (glue constraint), MADYPG, Kugelstadt/Deul rods, Unravel (feel).

### Toy 2: "Knit-a-Scarf" (live stitch growth)
- **Fantasy:** Two needles. Each tap or swipe knits a stitch, rows grow downward, and the scarf dangles and swings from the needles. Swap colour anytime to get stripes, and switch knit/purl for ribbing. Grab and fling the scarf at the end.
- **Core technique:** An XPBD cloth strip that grows: append a row of particles at the needle, re-pin the top row to the needle rod, and use LRA tethers to the needle so the long scarf doesn't stretch. Knit anisotropy comes from per-constraint compliance (soft course, stiffer wale, very soft shear) to approximate HYLC. Per-stitch colour lives in a data texture.
- **Budget (est):** 20 stitches wide × up to 150 rows is 3k particles. Cap it, or coarsen old rows (2×2 merge) far from the needle.
- **Rendering juice:** Stitch-type-indexed normal/height atlas (knit V, purl bump, rib), Charlie sheen and loop-valley AO. The yarn ball on the side spins and shrinks as you knit.
- **Effort:** M.
- **Refs:** Stitch Meshes, Knittable Stitch Meshes (bonus "export real instructions"), HYLC, LRA.

### Toy 3: "Tablecloth Trick"
- **Fantasy:** A dinner set on a tablecloth. Yank the cloth: fast and the dishes stay put, slow and everything crashes. It's a skill toy, and slow motion on a successful pull is a big payoff.
- **Core technique:** A 48×48 XPBD cloth (2.3k particles) with LRA-style strain limiting to prevent stretch. Plates, cups and a vase are small rigid bodies (XPBD rigid, TMP #22) with two-way positional coupling via sphere/capsule proxies. Coulomb friction on cloth–rigid contacts is the game knob. The table edge is an SDF box.
- **Budget (est):** 2.3k cloth particles plus about 10 rigid bodies. Contact is against a few proxies only, not self-collision.
- **Rendering juice:** Woven linen sheen with a subtle weave normal map, a checker/gingham pattern, clatter SFX, and ceramic shatter as a canned effect.
- **Effort:** M.
- **Refs:** C-IPC tablecloth ([video](https://www.youtube.com/watch?v=KZhoU_3k0Nk)), XPBD rigid bodies, TMP #22.

### Toy 4: "Laundry Line / Flag Field in Wind"
- **Fantasy:** A clothesline of socks, shirts, bedsheets and flags. Swipe to blow a gust, or hold to make a storm. Clothespins pop off and items tumble away. Tearable flags.
- **Core technique:** Several small XPBD cloths (16×16 to 24×32) pinned by clothespins that break at a force threshold. Per-triangle aerodynamic drag/lift with curl-noise gusts. Tearing by vertex splitting.
- **Budget (est):** 6–8 items × 300–700 particles, about 3.5k total. Self-collision off, or only per item.
- **Rendering juice:** Translucency (back-lit wrap lighting), fringe/fray shader on torn edges, cloth flutter SFX tied to triangle normal velocity.
- **Effort:** S (the fastest win on top of the existing tearable cloth).
- **Refs:** TMP #14, cloth-sim aero model, tearing refs.

### Toy 5: "Trampoline and Hammock"
- **Fantasy:** Drop balls, jelly blobs and bobo characters onto a stretchy trampoline or sagging hammock. Pull the net back like a slingshot and launch them.
- **Core technique:** A circular or rectangular XPBD membrane with springy (compliant) stretch and edge rings pinned to a frame. Balls are rigid spheres with two-way coupling, so their mass sets how deep they sink. Store elastic energy for slingshot releases. The hammock variant uses LRA plus high-mass sag.
- **Budget (est):** 32×32 = 1k particles plus about 20 balls. Trivially fits.
- **Rendering juice:** Woven net (alpha-tested mesh texture) or macramé rope render. Squash-and-stretch on the balls, and a bounce SFX pitch-mapped to impact.
- **Effort:** S.
- **Refs:** XPBD, XPBD rigid bodies.

### Toy 6: "Cat and Yarn Ball"
- **Fantasy:** Bat a yarn ball around a room (as the cat, or with a cat NPC). It rolls, unspools a trail, tangles around chair legs, and can be rewound by dragging.
- **Core technique:** The ball is a rigid sphere whose radius shrinks as yarn length leaves it (volume ∝ remaining length), with the rod emitted tangentially at its contact point. The yarn is an XPBD/Cosserat rod with capsule collisions against furniture and a cheap rod–rod self-collision via the spatial hash (particle radius equals yarn radius). Tangles emerge naturally, and rewinding reverses the emission.
- **Budget (est):** 1–2k rod segments. Sleep and freeze settled segments.
- **Rendering juice:** Instanced yarn tube with ply twist and fuzz. The ball uses a precomputed "wound yarn" normal map with parallax. Purr and yarn-rub sounds.
- **Effort:** M.
- **Refs:** Kugelstadt/Deul rods, DER, Unravel.

### Toy 7: "Crochet Blob" (amigurumi inflate)
- **Fantasy:** Crochet a round by tapping (spiral rounds with increases), then close it and it puffs into a squishy amigurumi. Poke, squish and throw it, and stack several.
- **Core technique:** A closed triangle mesh generated from crochet spiral rounds (magic ring: 6, 12, 18… stitches). XPBD distance plus bending, a pressure/volume constraint (global volume target, as in TMP #10 or Jolt's pressure soft bodies), and a low-stiffness shape-matching term to keep its "toy" shape.
- **Budget (est):** 300–800 particles per blob, 3–5 blobs.
- **Rendering juice:** A crochet "V" stitch normal map aligned to the spiral rounds, stuffing-bulge AO between stitches, embroidered safety-eye decals.
- **Effort:** M.
- **Refs:** Crochet Simulator (topology), TMP #10 soft bodies, JoltPhysics.js pressure demos.

### Toy 8: "Scissors and Seams" (tailor's table)
- **Fantasy:** Drag scissors to cut fabric along any path, pin pieces together, and "sew" edges by drawing stitches that zip the cloth closed. Make a cape, then flap it in wind.
- **Core technique:** Cutting by vertex splitting along a polyline (split the edges it crosses and duplicate vertices). Sewing adds zero-rest-length XPBD constraints between boundary vertices, animated as a zipper pull. Uses the self-collision from TMP #15.
- **Budget (est):** 2–3k particles total.
- **Rendering juice:** Frayed edge shader (alpha noise along boundary edges), a dashed stitch-line render on seams, fabric presets (denim, silk, knit) that switch both the compliance set and the shading.
- **Effort:** M.
- **Refs:** Tearing refs, TMP #15.

### Toy 9: "Loom" (woven tug-of-thread)
- **Fantasy:** A small woven patch on a loom. Pluck or pull any single warp or weft thread and the fabric puckers and gathers. Pull it fully out and the weave loosens.
- **Core technique:** A Cirio-style crossing grid: warp and weft rods share crossing nodes, and each node has a sliding coordinate along each thread (a 1-D Eulerian DOF) with friction. Removing a thread deletes its crossings.
- **Budget (est):** 32×32 crossings is about 1k nodes plus sliding DOFs.
- **Rendering juice:** Alternating over/under tube instancing, sheen, and colour-per-thread plaid.
- **Effort:** L (the research-y one).
- **Refs:** Cirio 2014, Leaf 2018.

### Toy 10 (bonus): "Rope and Chain Playground"
- XPBD rope, knotted yarn, bead chains (TMP #05 beads, TMP #25 joints), and swinging with the Unravel-style tether mechanic. **Effort:** S. It reuses the rod core from Toys 1 and 6.

---

## 7. Recommended path for bobo

1. **Harden the CPU core (week 1–2, S).** On the existing XPBD toy:
   - Small Steps (about 15 substeps, 1 iteration).
   - LRA tethers.
   - Per-triangle aero wind.
   - Vertex-splitting tearing.
   - Sleep/freeze.
   - OGC-style per-substep displacement clamp (≤0.4×thickness) to kill tunnelling cheaply.
   - Keep solver data in flat `Float32Array` SoA and avoid allocations per frame.
   - Ship **Toy 4 (Laundry Line)** and **Toy 5 (Trampoline)**.
2. **Add rods (week 2–3, S–M).** Port Cosserat or stretch-shear/bend-twist constraints from PositionBasedDynamics, plus rod-particle collision via the existing hash. Ship **Toy 10 (Rope)** and **Toy 6 (Cat and Yarn Ball)**.
3. **Knit look (week 3–4, M).** Build a stitch-mesh data structure plus knit/purl/rib normal atlases and a strain-blended "MADYPG-lite" shader, with Charlie sheen, Kajiya-Kay highlights and fuzz rim. Ship **Toy 2 (Knit-a-Scarf)**.
4. **Signature (week 4–7, M–L).** Build **Toy 1 (Pull the Thread)** on the stitch graph plus the cloth→rod conversion. This is the novel, shareable one.
5. **GPU path (parallel, M–L).** WebGPU is now available on iOS 26 / Safari 26 ([WebKit](https://webkit.org/blog/17333/webkit-features-in-safari-26-0/)), and iPhone 13 mini runs iOS 26. Port the cloth solver to WebGPU compute with graph colouring, or Jacobi+Chebyshev (which also allows a WebGL2 fallback). That opens 16k–64k particles (est) for bigger garments. Consider VBD/AVBD later if you want unified cloth+rigid stacking (Toy 3 at scale).
6. **Perf guardrails.** Keep physics at or under 5 ms (est) on the target device. Run a fixed 60 Hz sim with substeps, and adapt the substep count by frame time. Put GPU upload in one `bufferSubData`/`writeBuffer` per frame. Instance the yarn tube geometry, and build tubes in the vertex shader from rod positions stored in a texture or storage buffer.

---

## 8. References (all checked)

**Solvers and cloth**
- Müller et al. 2007, Position Based Dynamics: https://www.cs.toronto.edu/~jacobson/seminar/mueller-et-al-2007.pdf
- Macklin, Müller, Chentanez 2016, XPBD: https://dl.acm.org/doi/10.1145/2994258.2994272
- Macklin et al. 2019, Small Steps in Physics Simulation: https://mmacklin.com/smallsteps.pdf
- Kim, Chentanez, Müller 2012, Long Range Attachments: https://dl.acm.org/doi/10.5555/2422356.2422399
- Bouaziz et al. 2014, Projective Dynamics: https://users.cs.utah.edu/~ladislav/bouaziz14projective/bouaziz14projective.pdf
- Wang 2015, Chebyshev semi-iterative PD/PBD: https://wanghmin.github.io/publication/wang-2015-csi/
- Fratarcangeli et al. 2016, Vivace: https://mfratarcangeli.github.io/publication/sigasia2016/
- Chen et al. 2024, Vertex Block Descent: https://ankachan.github.io/Projects/VertexBlockDescent/index.html · https://arxiv.org/abs/2403.06321 · https://github.com/AnkaChan/Gaia · https://github.com/AnkaChan/TinyVBD
- Giles, Diaz, Yuksel 2025, Augmented VBD: https://graphics.cs.utah.edu/research/projects/avbd/
- Chen et al. 2025, Offset Geometric Contact: https://graphics.cs.utah.edu/research/projects/ogc/ · https://github.com/mmtmn/OGC
- Li, Kaufman, Jiang 2021, C-IPC: https://ipc-sim.github.io/C-IPC/
- Müller et al. 2020, Detailed Rigid Body Simulation with XPBD: https://onlinelibrary.wiley.com/doi/10.1111/cgf.14105
- Fast Simulation of Cloth Tearing: https://www.researchgate.net/publication/264457835_Fast_Simulation_of_Cloth_Tearing
- Realistic soft-body tearing under 10 ms in VR: https://arxiv.org/pdf/2205.00914
- Real-Time Cloth Simulation Using WebGPU (2025): https://arxiv.org/html/2507.11794
- Newton (VBD solver): https://github.com/newton-physics/newton

**Rods**
- Bergou et al. 2008, Discrete Elastic Rods: https://www.cs.columbia.edu/cg/rods/
- Kugelstadt & Schömer 2016, Position and Orientation Based Cosserat Rods: https://animation.rwth-aachen.de/publication/0550/
- Deul et al. 2018, Direct Position-Based Solver for Stiff Rods: https://animation.rwth-aachen.de/publication/0557/
- PositionBasedDynamics library: https://github.com/InteractiveComputerGraphics/PositionBasedDynamics

**Yarn / knit / woven**
- Kaldor, Marschner, James 2008, Simulating Knitted Cloth at the Yarn Level: https://www.cs.cornell.edu/~srm/publications/SG08-knit-lr.pdf · https://research.cs.cornell.edu/YarnCloth/
- Kaldor, James, Marschner 2010, Efficient Yarn-based Cloth: https://dl.acm.org/doi/10.1145/1833349.1778842
- Cirio et al. 2014, Yarn-Level Simulation of Woven Cloth: https://dl.acm.org/doi/10.1145/2661229.2661279
- Yuksel et al. 2012, Stitch Meshes: https://www.cemyuksel.com/research/stitchmeshes/
- Wu, Swan, Yuksel 2019, Knittable Stitch Meshes: https://kuiwuchn.github.io/KnittableStitchMesh/
- Leaf et al. 2018, Periodic Yarn-Level Cloth Patterns: https://graphics.stanford.edu/projects/yarnsim/assets/interactive_design_of_periodic_yarn_level_cloth_patterns.pdf
- Sperl, Narain, Wojtan 2020, Homogenized Yarn-Level Cloth: https://visualcomputing.ist.ac.at/publications/2020/HYLC/
- Sperl, Narain, Wojtan 2021, Mechanics-Aware Deformation of Yarn Pattern Geometry: https://visualcomputing.ist.ac.at/publications/2021/MADYPG/ · https://github.com/kamleshbhalui/MADYPG
- Unravelling the Mechanics of Knitted Fabrics (2023): https://arxiv.org/pdf/2307.12360
- KnitScape (CHI 2024): https://github.com/knitscape/knitscape · https://machineagency.github.io/knitscape-2024/

**Rendering**
- Wu & Yuksel 2017, Real-time Fiber-level Cloth Rendering: https://www.cemyuksel.com/research/papers/real-time_cloth_rendering_with_fiber-level_detail_tvcg2017.pdf · https://people.csail.mit.edu/kuiwu/rtfr.html
- Zhao, Luan, Bala 2016, Fitting Procedural Yarn Models: https://dl.acm.org/doi/10.1145/2897824.2925932
- Estevez & Kulla 2017, Production Friendly Microfacet Sheen BRDF: https://blog.selfshadow.com/publications/s2017-shading-course/imageworks/s2017_pbs_imageworks_sheen.pdf
- glTF KHR_materials_sheen: https://github.com/KhronosGroup/glTF/blob/main/extensions/2.0/Khronos/KHR_materials_sheen/README.md
- Shadertoy "Knits & Sips": https://www.shadertoy.com/view/csVXzK · "Cloth Shading": https://www.shadertoy.com/view/4tfBzn

**Demos and code**
- Ten Minute Physics: https://matthias-research.github.io/pages/tenMinutePhysics/index.html · https://github.com/matthias-research/pages · https://www.youtube.com/@TenMinutePhysics
- FurkanZhlp/cloth-sim: https://github.com/FurkanZhlp/cloth-sim · https://furkanzhlp.github.io/cloth-sim/
- ccincotti3/webgpu_cloth_simulator: https://github.com/ccincotti3/webgpu_cloth_simulator · https://carmencincotti.com/posts/categories/cloth-simulation/
- jspdown/cloth: https://github.com/jspdown/cloth
- RykaKa/webgpu-xpbd-cloth: https://github.com/RykaKa/webgpu-xpbd-cloth
- nakjun/Cloth-Simulation-WebGPU: https://github.com/nakjun/Cloth-Simulation-WebGPU
- three.js WebGPU compute cloth: https://threejs.org/examples/webgpu_compute_cloth.html
- bandinopla/three-simplecloth: https://github.com/bandinopla/three-simplecloth
- cannon-es cloth: https://pmndrs.github.io/cannon-es/examples/threejs_cloth
- JoltPhysics.js demos: https://jrouwe.github.io/JoltPhysics.js/
- WebPhysics (AVBD WebGPU): https://jure.github.io/webphysics · https://github.com/jure/webphysics
- Crochet Simulator: https://github.com/yunniko/crochet-simulator · https://crochet.app.craftodejnice.cz
- Stitch Maps: https://stitch-maps.com/
- aryamancodes Rope-and-Cloth: https://github.com/aryamancodes/Rope-and-Cloth-Simulation
- Safari 26 WebGPU: https://webkit.org/blog/17333/webkit-features-in-safari-26-0/

**Games**
- Unravel: https://store.steampowered.com/app/1225560/Unravel/
- Kirby's Epic Yarn: https://en.wikipedia.org/wiki/Kirby%27s_Epic_Yarn
- Yoshi's Woolly World: https://en.wikipedia.org/wiki/Yoshi%27s_Woolly_World
- Woolly Boy and the Circus: https://store.steampowered.com/app/2233920/woolly_boy_and_the_circus/
