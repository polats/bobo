# Shear & Knit: Research for a Tactile Wool Sandbox in bobo

Companion to [cloth-knitting.md](cloth-knitting.md) and [physics.md](physics.md). This doc doesn't repeat what those cover (XPBD, Cosserat rods, stitch meshes, HYLC/MADYPG, Wu & Yuksel and Zhao yarn rendering, Kajiya-Kay on yarn, Charlie sheen, Kaldor/Cirio). It points back to them where they apply.

Prepared 2026-09-23 for the bobo team (TypeScript, WebGL2/WebGPU, Capacitor iOS, target 60 fps on iPhone 13 mini).

**Link policy.** Every link was checked, either by fetching it directly or, for sites that block bots (ACM DL, ResearchGate, Medium, App Store, GDC Vault), by finding it in search results. YouTube IDs were checked with YouTube oEmbed, which returns the title and channel. Items marked **[unverified]** are claims I couldn't confirm from a primary source. Numbers marked **(est)** are my own estimates and have not been measured.

**What bobo has today (from the repo):**

- **Haptics.** `ToyContext.haptic('light'|'medium'|'heavy')` in `src/main.ts` calls `@capacitor/haptics` `impact()` on native, or `navigator.vibrate` on the web. It is throttled to one call per 40 ms.
- **Audio.** No audio system (no `AudioContext` anywhere in `src`).
- **Cloth and yarn.** `Cloth.cut()` exists in `src/toys/cloth/sim.ts`, "Pull the Thread" already exists as `src/toys/thread` (a `Knit` class with `pop()`), and the laundry toy has breakable pins.

---

## 1. Summary

1. **The satisfaction comes from reveal, completion and coupling, not from the physics.** Four sources point the same way:
   - PowerWash Simulator deliberately cut realism ("replicate the satisfaction of watching pressure-washing videos"), and every object is split into segments with their own progress bars.
   - "Oddly satisfying" research points to a "just right" sense of completion.
   - Apple's audio-haptic guidance is built on *causality, harmony, utility*.
   - Kao et al. (CHI 2024, N=1,699) found that **juice tied to success and with variety raises motivation, while plain amplification lowered it**.

   Shearing fits this perfectly. A real fleece comes off **in one piece**. Its outside is grey and weathered while the cut side is "paler, cleaner, creamy… with drops of golden lanolin". Under it the skin is clean. That makes a built-in reveal and a one-piece "completion" goal.
2. **Fur: use shells, not strands.** Shell texturing (Lengyel et al. 2001; Acerola's 2023 explainer) with a per-texel **length map** that the clippers write into is the only approach that fits a phone budget. Wool needs 16–32 shells (est), and fins are optional because wool is dense and matte. Strand systems (HairWorks, TressFX, Frostbite, Daviet ADMM, AMS) are useful for ideas only.
3. **The fleece peel is a cloth sheet with breakable skin pins.** Put a coarse XPBD sheet over the fleece region. Each particle is pinned to the skin until the clipper passes under it, and then it flops free under gravity with its creamy underside showing. The laundry toy's break-at-force pins and Tear Sheet's `cut()` give you most of this already. Tearing the fleece into pieces with sloppy cuts ("second cuts") is the natural, gentle failure state.
4. **Haptics on iOS need a small native bridge.** `@capacitor/haptics` only gives you discrete impacts, notifications and selection ticks. Clippers need a **continuous** Core Haptics event whose intensity follows wool load, updated live through `CHHapticDynamicParameter`, plus a looping pattern of transients whose `playbackRate` follows the rate of fibres being cut.
   - Core Haptics basics: sharpness maps to about **80–230 Hz** on the Taptic Engine, and a continuous event lasts **at most 30 s**, so loop or restart it.
   - The iOS web fallback is weak. Safari has no `navigator.vibrate`. The `<input type=checkbox switch>` trick gives one tick per *tap* only, and since iOS 18.4 dragging doesn't count as user activation.
   - Write a local Capacitor plugin (**S**). Treat `capacitor-rich-haptics` (MIT, very young) as API inspiration.
5. **Pseudo-haptics carry the "resistance".** Following Lécuyer's control/display-ratio work, slow the clipper relative to the finger in dense wool, snap it to detents on the knitting needles, and drag the spinning wheel. This works everywhere, including the web and Android.
6. **Audio: procedural where it reacts, samples where it's texture.**
   - The clippers are a 100/120 Hz magnetic buzz (twice the mains frequency) whose pitch sags and gains grit under load, plus granular "crunch" grains triggered per cut.
   - Fibre and cloth sounds follow An/James/Marschner (concatenative cloth sound), Cirio et al. (crumpling clicks) and Schweickart et al. (rod sound).
   - All of it is Web Audio (AudioWorklet is available since iOS 14.5).
7. **Loop:** shear (the reveal) → the fleece lies as one blanket → pull tufts to draft and spin on a wheel (twist physics on a rod) → knit a scarf from *your* uneven yarn → put it on the shivering shorn sheep → the wool regrows (the length map grows back) → repeat. It reuses Tear Sheet, Laundry pins and Pull the Thread's `Knit`. Overall effort: **L**, with a very shippable **M** "Shear only" first slice.

---

## 2. Haptics, pseudo-haptics and game feel

### 2.1 Research on tactile feel from a flat glass screen

| Work | Key idea | Use in Shear & Knit |
|---|---|---|
| **Lécuyer, "Simulating Haptic Feedback Using Vision: A Survey of Research and Applications of Pseudo-Haptic Feedback"** (Presence 18(1), 2009) ([MIT Press](https://direct.mit.edu/pvar/article/18/1/39/18739/Simulating-Haptic-Feedback-Using-Vision-A-Survey), [author draft PDF](https://people.rennes.inria.fr/Anatole.Lecuyer/presence_lecuyer_draft.pdf)) | Visual feedback can simulate stiffness, texture and mass. People read these illusions from how the cursor moves relative to the hand. | This is the foundation for all the "resistance" in the toy. |
| **Lécuyer, Burkhardt, Etienne, "Feeling bumps and holes without a haptic interface" (CHI 2004)** ([ACM](https://dl.acm.org/doi/10.1145/985692.985723)) | Change the control/display (C/D) ratio: the cursor slows going up a slope and speeds up going down. Participants could identify and even draw the bump profiles. | The **clipper lags the finger in thick wool** and snaps forward in thin wool. Detents on needles and the wheel. |
| **Costes et al., "Touchy: A Visual Approach for Simulating Haptic Effects on Touchscreens"** (Frontiers in ICT 2019) ([Frontiers](https://www.frontiersin.org/journals/ict/articles/10.3389/fict.2019.00001/full)) | A symbolic cursor under the finger whose shape and motion convey hardness, friction, fine roughness and macro roughness. Needs no actuator. | Use a **clipper "shadow ring" under the finger** that stretches with lag and jitters at the rate fibres are cut. Gives feel on the web and Android too. |
| **Hachisu, Cirio, Marchal, Lécuyer, Kajimoto, "Pseudo-haptic feedback augmented with visual and tactile vibrations"** (ISVRI 2011) ([ResearchGate](https://www.researchgate.net/publication/224234143_Pseudo-haptic_feedback_augmented_with_visual_and_tactile_vibrations)) | Combining visual vibration (jitter) with tactile vibration strengthens the illusion. | Add a 1–2 px clipper jitter synced to the haptic grain loop. |
| **Static friction via pseudo-haptics at the stick-slip transition** ([arXiv 1904.11676](https://arxiv.org/pdf/1904.11676)) | The cursor visibly *sticking*, then releasing, reads as static friction (>90% probability above a threshold, per the abstract). | **Drafting:** fibre sticks, then slips out of the fleece. Also a **stuck clipper** in matted wool. |
| **Romano & Kuchenbecker, "Creating Realistic Virtual Textures from Contact Acceleration Data"** (IEEE ToH 5(2), 2012) ([DOI](https://doi.org/10.1109/toh.2011.38)); **Culbertson et al., Penn Haptic Texture Toolkit** (100 textures) ([Penn page](http://haptics.seas.upenn.edu/index.php/Research/ThePennHapticTextureToolkit)) | Texture vibration is data-driven: record tool acceleration, then fit AR models driven by **speed and force**. | Model the clipper grain loop's rate and intensity as a function of **(finger speed × wool density)**. That is the phone-scale version of speed/force-conditioned texture models. |
| **Bau, Poupyrev, Israr, Harrison, "TeslaTouch" (UIST 2010)** ([ACM](https://dl.acm.org/doi/10.1145/1866029.1866074)) | Electrovibration friction displays. | Background only. iPhones can't do friction modulation, so we fake friction with C/D ratio. |
| **Martín, Weinmann, Hullin, "A Study of Material Sonification in Touchscreen Devices"** (ISS 2018) ([arXiv](https://arxiv.org/pdf/1807.01106)) | Granular rubbing sounds under the finger **didn't improve material judgements, but did raise immersion**. | Audio is for immersion. Don't count on it to "explain" softness; the visuals and haptics have to do that. |
| **Narrative review of tactile feedback in gaming** (2025) ([PMC](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12099099/)) | Haptics usually help immersion, but too much of it becomes a negative. | Set a haptic budget and add a mute option (Apple's HIG says the same). |

### 2.2 Apple Core Haptics: what matters for this toy

- **Two primitives** ([HIG: Playing haptics](https://developer.apple.com/design/human-interface-guidelines/playing-haptics), [Core Haptics](https://developer.apple.com/documentation/corehaptics)). *Transient* events are taps or impulses. *Continuous* events are sustained vibrations. Both take `hapticIntensity` and `hapticSharpness` in the range 0–1 ([intensity](https://developer.apple.com/documentation/corehaptics/chhapticevent/parameterid/hapticintensity), [sharpness](https://developer.apple.com/documentation/corehaptics/chhapticevent/parameterid/hapticsharpness)).
- **Continuous events max out at 30 s** ([hapticContinuous](https://developer.apple.com/documentation/corehaptics/chhapticevent/eventtype/hapticcontinuous)). For a long clipper session, set `loopEnabled` on a `CHHapticAdvancedPatternPlayer` ([loopEnabled](https://developer.apple.com/documentation/corehaptics/chhapticadvancedpatternplayer/loopenabled)) or restart the event.
- **Live modulation** is covered by Apple's HapticPalette sample ([Updating Continuous and Transient Haptic Parameters in Real Time](https://developer.apple.com/documentation/corehaptics/updating-continuous-and-transient-haptic-parameters-in-real-time)), which maps finger x/y to sharpness/intensity on a 100 s continuous event. Two kinds of change are available:
  - `CHHapticDynamicParameter` changes instantly. For intensity, the value *multiplies* the event's value; for sharpness it *adds* to it ([docs](https://developer.apple.com/documentation/corehaptics/chhapticdynamicparameter)).
  - `CHHapticParameterCurve` interpolates linearly, and applies to all events in the pattern ([docs](https://developer.apple.com/documentation/corehaptics/chhapticparametercurve)).
- **`playbackRate`** on the advanced player ([docs](https://developer.apple.com/documentation/corehaptics/chhapticadvancedpatternplayer/playbackrate)). Use a looping pattern of 8–16 short transients and speed it up or slow it down to follow the rate fibres are being cut. That gives "grain" texture without one bridge call per tick.
- **Collision-scaled transients.** In Apple's HapticBounce sample, impact velocity is mapped to normalised intensity and sharpness, and to audio volume too ([docs](https://developer.apple.com/documentation/corehaptics/playing-collision-based-haptic-patterns)).
- **`playsHapticsOnly = true`** lowers start latency when audio isn't routed through Core Haptics ([docs](https://developer.apple.com/documentation/corehaptics/chhapticengine/playshapticsonly)). That's our case, since audio goes through Web Audio.
- **AHAP files** are JSON-like pattern files with `Pattern` and `Version` at the top level. Out-of-range values are clamped and unknown keys are ignored ([Representing Haptic Patterns in AHAP Files](https://developer.apple.com/documentation/corehaptics/representing-haptic-patterns-in-ahap-files)). Author the one-shots (fleece-off fanfare, row complete) as `.ahap` files.
- **Frequency range: 80–230 Hz** ([Hapticlabs Apple notes](https://docs.hapticlabs.io/mobile/apple/)). A search snippet from Daniel Büttner's Medium piece also says the Taptic Engine resonates at about 160 Hz, near sharpness ≈0.73 ([Medium](https://danielbuettner.medium.com/10-things-you-should-know-about-designing-for-apple-core-haptics-9219fdebdcaa)). **[unverified: page returned 403]** The practical takeaway: the strongest buzz for a given intensity sits around sharpness 0.6–0.8. Clippers feel "mechanical" at about 0.5, and wool "softness" wants 0.1–0.3.
- **Design talks:** [WWDC19 "Designing Audio-Haptic Experiences" (810)](https://developer.apple.com/videos/play/wwdc2019/810) ([YouTube](https://www.youtube.com/watch?v=-hvClUdSlhA); [WWDCNotes summary](https://wwdcnotes.com/documentation/wwdcnotes/wwdc19-810-designing-audiohaptic-experiences/)) covers causality, harmony and utility. Also [WWDC19 "Introducing Core Haptics" (520)](https://developer.apple.com/videos/play/wwdc2019/520), [WWDC19 "Expanding the Sensory Experience with Core Haptics" (223)](https://developer.apple.com/videos/play/wwdc2019/223), and [WWDC21 "Practice audio haptic design" (10278)](https://developer.apple.com/videos/play/wwdc2021/10278).
- **HIG rules to obey:** match haptic sharpness and intensity to the animation, keep each pattern's meaning consistent, don't overuse, and make haptics optional.

### 2.3 What's reachable from bobo's web view

| Path | What you get | Limits |
|---|---|---|
| `@capacitor/haptics` (installed, v8) ([docs](https://capacitorjs.com/docs/apis/haptics)) | `impact(style)`, `notification(type)`, `vibrate(duration)`, `selectionStart/Changed/End` | No sharpness, no continuous modulation, no patterns. `selectionChanged` is the best "detent tick" available (use it for needle and wheel detents). One bridge round trip per call. |
| `@capawesome/capacitor-haptics` ([docs](https://capawesome.io/docs/sdks/capacitor/haptics/)) | Patterns of events with per-event intensity and sharpness (Core Haptics on iOS), plus Rigid/Soft impacts | Patterns are fixed once played. No live parameter updates per the docs. |
| `capacitor-rich-haptics` ([GitHub](https://github.com/sergey-faraday/capacitor-rich-haptics)) | `startContinuous` / `updateParameters` / `stopPlayer`, AHAP playback and builder, presets. Android simulates modulation by re-triggering at about 30 Hz. | MIT, but tiny (1 star, 11 commits when fetched). Use it for API shape, or vendor it. |
| **Local Capacitor plugin (recommended)** ([Custom Native iOS Code](https://capacitorjs.com/docs/ios/custom-code)) | A roughly 200-line Swift `CAPPlugin, CAPBridgedPlugin` wrapping `CHHapticEngine` and advanced players, in bobo's own `ios/App` | You own it. Effort **S**. |
| iOS Safari `navigator.vibrate` | Not supported ([caniuse](https://caniuse.com/mdn-api_navigator_vibrate); [MDN BCD discussion](https://github.com/mdn/browser-compat-data/issues/29166)) | — |
| iOS 18+ `<input type=checkbox switch>` hack ([WebKit Safari 18](https://webkit.org/blog/15865/webkit-features-in-safari-18-0/), [tijnjh/ios-haptics](https://github.com/tijnjh/ios-haptics), [ios-vibrator-pro-max](https://github.com/samdenty/ios-vibrator-pro-max)) | Clicking a hidden switch's `<label>` plays the system toggle tick | Since iOS 18.4 it needs a click (not a drag), and the grant expires after 1 s. **Useless during a drag**, so only use it for taps (knit taps on the web build). Whether it works inside a WKWebView is **[unverified]**. |
| Android web `navigator.vibrate(ms or pattern)` | On/off pulses only | Makes an OK "grain" by pulsing 5–10 ms at the cut rate. |

**Proposed bridge API (TS side):**

```ts
interface BoboHaptics {
  prepare(): Promise<void>;                       // create engine, playsHapticsOnly=true, preload AHAPs
  tap(i: number, s: number): void;                // transient
  start(id: string, i: number, s: number): void;  // continuous, looped advanced player
  set(id: string, i: number, s: number, rate?: number): void; // dynamic params + playbackRate
  stop(id: string, fadeMs?: number): void;        // parameter curve to 0 then stop
  play(name: string): void;                       // bundled .ahap
}
```

- Throttle `set()` to about 30 Hz (est) and coalesce updates on the JS side.
- Extend `ToyContext` with `haptics?: BoboHaptics`, keeping the old `haptic()` as the fallback.
- The 40 ms global throttle in `main.ts` must **not** apply to the new API.
- Bridge latency from WKWebView to native is probably a few ms **(est)**. That's fine for continuous modulation. Keep beat-critical ticks (wheel treadle, knit detents) *predictive*: fire when the finger crosses the detent, not when the sim confirms it.

### 2.4 Game-feel literature

- **Steve Swink, *Game Feel* (2008)** ([T&F](https://www.taylorfrancis.com/books/mono/10.1201/9781482267334/game-feel-steve-swink), [Wikipedia](https://en.wikipedia.org/wiki/Game_feel)). Game feel is "real-time control of virtual objects in a simulated space, with interactions emphasised by polish". The response needs to land inside the ~100 ms correction cycle. **Implication:** the clipper must follow the finger in the same frame (only the *visual* clipper lags, and only by design), and the haptic and audio onset must start the moment the fleece contacts.
- **Jonasson & Purho, "Juice it or lose it" (GDC Europe 2012)** ([YouTube](https://www.youtube.com/watch?v=Fy0aCDmgnxg)) and **Nijman, "The art of screenshake" (INDIGO 2013)** ([YouTube](https://www.youtube.com/watch?v=AJdEqssNZ-U), [archive](https://archive.org/details/the-art-of-screenshake)) are the standard toolkits: tweening, particles, hit-stop, shake, sound layering. **For a calm toy, use the soft end:** no screenshake while shearing, a tiny camera push-in when the fleece releases, and a 60–80 ms hit-stop on "fleece off!" (est).
- **Hicks et al., "Juicy Game Design" (CHI PLAY 2019)** ([ACM](https://dl.acm.org/doi/abs/10.1145/3311350.3347171)) and **"Good Game Feel: An Empirically Grounded Framework for Juicy Design"** ([Semantic Scholar](https://www.semanticscholar.org/paper/Good-Game-Feel:-An-Empirically-Grounded-Framework-Hicks-Dickinson/d9f363c5ad318e14e4c810ee88f61f1fcd97e385)) found that juice raises appeal and need satisfaction, but not performance.
- **Kao, Ballou, Gerling, Breitsohl, Deterding, "How does Juicy Game Feedback Motivate?" (CHI 2024)** ([ACM](https://dl.acm.org/doi/10.1145/3613904.3642656), [PDF](https://people.csail.mit.edu/dkao/pdf/3613904.3642656.pdf)):
  - Curiosity was the strongest predictor of enjoyment and the only predictor of playtime.
  - Juice that depends on success raised all the motives they measured.
  - Plain amplification *reduced* them.
  - **Design rule:** make feedback depend on doing it well (a clean blow gets a richer sound and haptic than a scrappy one), and vary it (the lanolin glint, the colour of the next fleece). Don't just make it louder.

### 2.5 Why "oddly satisfying" works, and reference games

- **Completion / "just right".** Discover Magazine's summary of the OCD "incompleteness" research ([Discover](https://www.discovermagazine.com/why-are-oddly-satisfying-videos-sosatisfying-218)) argues that watching something reach a complete, ordered end state triggers a "just right" feeling. The media-studies source is **"Visual tactility: 'Oddly satisfying' videos, sensory genres…"** (Convergence 2022) ([SAGE](https://journals.sagepub.com/doi/10.1177/13548565221105196)), which describes these videos as *visual tactility*: watching makes you feel touch.
- **ASMR as a flow-like state.** Barratt & Davis (PeerJ 2015) ([PeerJ](https://peerj.com/articles/851/)) report that crisp sounds and slow movements are common triggers, and that more triggers go with more flow. **Implication:** sheep shearing is naturally ASMR-ish (clipper buzz, crisp crunch, slow long blows), so keep the tempo unhurried and the mix intimate.
- **Knitting's own reward loop.** Riley, Corkhill, Morris (BJOT 2013, N=3,545) ([SAGE](https://journals.sagepub.com/doi/10.4276/030802213X13603244419077)) found that knitting is used for relaxation, stress relief and a sense of accomplishment. The rhythm itself is the reward, so there should be **no fail state in knitting**.
- **PowerWash Simulator** ([80.lv level design](https://80.lv/articles/level-design-of-powerwash-simulator)). It idealises rather than simulates. Objects start "impossibly dirty", and each is split into segments, each with its own progress bar and a completion ping. **Copy this directly:** split the sheep into Bowen-style regions (belly, hind legs, neck, long blows, other side), each with a "shorn" meter and a completion ping.
- **Hypercasual cutting and ASMR games:**
  - CrazyLabs' **Soap Cutting** ([App Store](https://apps.apple.com/us/app/soap-cutting/id1487932387), [Google Play](https://play.google.com/store/apps/details?id=com.crazylabs.soap.cutting&hl=en_US)): about 100M downloads per its store listing.
  - **ASMR Slicing** ([App Store](https://apps.apple.com/us/app/asmr-slicing/id1494458254)): its listing explicitly advertises "smooth haptic feedback" and different vibrations and sounds per knife, with 4.6★ from 329k ratings when fetched.
  - The genre formula: one continuous gesture, a peel or slice that curls away, a crisp sound, and a haptic tick at the rate of the material.
- **Sheep- and wool-specific (direct competitors):**
  - **Sheary Sheep** ([App Store](https://apps.apple.com/us/app/sheary-sheep/id1504388022)): wash, shear and de-tick sheep, then knit Christmas jumpers from the wool. **It is the closest existing loop**, and 2D with no physics as far as the listing shows.
  - **Sheep Wool** ([Google Play](https://play.google.com/store/apps/details?id=com.pc.sheep.wool&hl=en_US)): tap to gather wool, spin it into yarn, weave pictures. An idle game.
  - Others: **Tiny Sheep** ([App Store](https://apps.apple.com/us/app/tiny-sheep-pet-sim-on-a-farm/id488628767)), **Shepherd** (itch incremental) ([itch](https://alexjgriffith.itch.io/shepherd)), and the knitting puzzle games **Knit Out** ([App Store](https://apps.apple.com/us/app/knit-out/id6740406762)), **Wool Out 3D** ([App Store](https://apps.apple.com/us/app/wool-out-3d-knitting-games/id6468994631)), **Yarn Loop** ([App Store](https://apps.apple.com/us/app/yarn-loop-knit-puzzle/id6755183085)) and **Knit Craft: Unravel & Match** ([App Store](https://apps.apple.com/us/app/knit-craft-unravel-match/id6762808373)).
  - **Where bobo can stand out:** none of these (from their listings) has a *physical* fleece that peels off as one blanket, twist-based spinning, or yarn whose unevenness shows up in the knit.
- **Hair- and barber-sims** as feel references for clippers: [Hairdresser Simulator](https://store.steampowered.com/app/1330560/Hairdresser_Simulator/) and [Barber Shop Simulator](https://store.steampowered.com/app/3585060/Barber_Shop_Simulator/).

---

## 3. Fur / wool simulation and rendering in real time

### 3.1 Rendering

| Technique | Notes | Phone fit |
|---|---|---|
| **Kajiya & Kay, "Rendering fur with three dimensional textures" (SIGGRAPH 1989)** ([ACM](https://dl.acm.org/doi/10.1145/74334.74361)) | Volumetric "texels" plus the anisotropic hair lighting model (already used for yarn in cloth-knitting.md). | The shading model, yes. The volumes, no. |
| **Lengyel, Praun, Finkelstein, Hoppe, "Real-time fur over arbitrary surfaces" (I3D 2001)** ([project](https://hhoppe.com/proj/fur/), [ACM](https://dl.acm.org/doi/10.1145/364338.364407), [PDF](https://hhoppe.com/fur.pdf)) | Precompute a volume texture of simulated hairs, lap it over the surface, render **concentric semi-transparent shells**, and add **fins** at silhouettes. | **The** technique. |
| NVIDIA "Fur: Shells and Fins" SDK 10.5 whitepaper ([PDF](https://developer.download.nvidia.com/SDK/10.5/direct3d/Source/Fur/doc/FurShellsAndFins.pdf)) | Practical D3D10 implementation notes (fetched as binary PDF; contents not reviewed). | Reference |
| **Acerola, "How Do Games Render Fur?" (2023)** ([YouTube](https://www.youtube.com/watch?v=9dr-tRQzij4)) | Modern shell texturing: instanced shells offset along the normal, a per-strand hash in UV cells, a height test per shell, a cone/taper test, **discard instead of blending** (opaque, so no sorting), shell displacement for gravity/physics, and fake AO by shell height. | Excellent. Opaque discard shells work well on tile-based mobile GPUs if overdraw is managed. |
| tmpvar shell texturing PoC ([WebGPU demo](https://tmpvar.com/poc/shell-texturing/)); piellardj fur-threejs ([repo](https://github.com/piellardj/fur-threejs)); AEspinosaDev WebGL fur ([repo](https://github.com/AEspinosaDev/WebGL-RealTimeFur-SEDDI)); three.js shells+fins demo ([YouTube](https://www.youtube.com/watch?v=NnuN9WyShMo)) | Browser proofs: instanced shells, fins precomputed at load, combing via transform feedback (piellardj). | Code to read |
| Unity shell-fur projects with **length painting** ([Propagant/Unity-GrassAndFur](https://github.com/Propagant/Unity-GrassAndFur), [jose-villegas FurRendering](https://github.com/jose-villegas/FurRendering)) | Paint fur length and density masks; the "length control" parameter per layer. | Confirms the length-map approach is standard. |
| Shadow of the Colossus shell fur ([Froyok breakdown](https://www.froyok.fr/blog/2012-10-breakdown-shadow-of-the-colossus-pal-ps2/)) | Shells on PS2, which is proof this ran on 2005 hardware. | — |
| Strand rendering at the high end: **Frostbite strand hair** (Tafuri, SIGGRAPH 2019 Advances) ([PDF](https://advances.realtimerendering.com/s2019/hair_presentation_final.pdf)); **Hair Meshes rendering** (Bhokare & Yuksel, SIGGRAPH 2024: 100 characters × 100k strands in 2 ms on an RTX 4090) ([project](https://www.cemyuksel.com/research/hairmesh_rendering/), [video](https://www.youtube.com/watch?v=rv6e518-VjY)); **HairWorks** ([docs](https://docs.nvidia.com/gameworks/content/artisttools/hairworks/1_0/index.html), [Witcher 3 GDC](https://gdcvault.com/play/1020664/The-Witcher-3-Enabling-Next)); **TressFX** ([GPUOpen](https://gpuopen.com/tressfx/), [repo](https://github.com/GPUOpen-Effects/TressFX)) | Order-independent transparency, deep opacity, Marschner shading, LOD. | Not phone. Borrow the *hair-mesh* idea: generate strands procedurally from a coarse cage. For wool, the cage is the fleece sheet itself. |
| **Grass as "short fur"**: Ghost of Tsushima procedural grass (Wohllaib, GDC 2021) ([YouTube](https://www.youtube.com/watch?v=Ibe1JBF5i5Y), [GDC Vault](https://gdcvault.com/play/1027033/Advanced-Graphics-Summit-Procedural-Grass)); Daniel Ilett "Six grass techniques" ([blog](https://danielilett.com/2022-12-05-tut6-2-six-grass-techniques/)) including a **grass-map texture where 0 means cut/absent**; Lawn Mowing Simulator ([Steam](https://store.steampowered.com/app/1480560/Lawn_Mowing_Simulator/)) | The same "mow a mask, spawn clipping particles" pattern that shearing needs. | Yes (the mask idea) |

**The wool look (what makes it not "cat fur"):**

- **Colour inversion.** The outer tips are grey and dirtier and gather into pointy bits. The cut side is "paler, cleaner, creamy… drops of golden lanolin" and breaks into rows of staples ([Carpe diem: Exploring a Fleece](https://cinereous.blogspot.com/2010/06/exploring-fleece-grading-and-sorting.html)). In the shell shader this is a **height-graded albedo**: cream at the root, grey-brown at the tip. So the *cut* reveals cream, which is the reveal for free.
- **Staples and locks.** Wool clumps into locks (longwools) or blocky, flat-tipped staples (fine wools like Merino), with a crimp of many waves per unit length ([Wool measurement](https://en.wikipedia.org/wiki/Wool_measurement), [George Weil on count/staple/crimp](https://www.georgeweil.com/blog/the-classification-of-wool-fibres-count-staple-length-crimp-and-lustre/)). In the shader, replace per-strand cells with **per-staple Voronoi cells** (about 1–2 cm), a crimp sine offset along height, and a slight clump taper. It's matte, so use a low-contrast Kajiya-Kay term.
- **Skin under the wool.** Pinkish-white with a faint comb-stripe pattern showing each blow (the stubble shell count reads 1–2).

### 3.2 Simulation of hair and fur (for secondary motion and loose tufts)

- **Müller, Kim, Chentanez, "Fast Simulation of Inextensible Hair and Fur" (VRIPHYS 2012)** ([PDF](https://matthias-research.github.io/pages/publications/FTLHairFur.pdf), [video](https://www.youtube.com/watch?v=zB8Fqbfrrpo), [3rd-party impl](https://github.com/derselbst/FurSimulation)). **Dynamic Follow-The-Leader (DFTL)**: each strand particle is projected to rest-length distance from its predecessor in a single pass, then a velocity correction removes the artificial damping. It guarantees inextensibility in one iteration. **Use it for:** stray wool tufts, "second cut" snippets, drafting fibres, and a few dozen guide strands that bend the shells (see below).
- **Sánchez-Banderas et al., "Real-time Inextensible Hair with Volume and Shape" (CEIG 2015)** ([EG DL](https://diglib.eg.org/handle/10.2312/ceig20151194)): DFTL plus shape preservation plus hair-hair volume, GPU-friendly.
- **Herrera et al., "Augmented Mass-Spring model for Real-Time Dense Hair Simulation" (2024)** ([arXiv](https://arxiv.org/abs/2412.17144)): mass-spring with a ghost rest shape; about 15k strands at 67 fps on desktop. Also used in **Digital Salon**, which does *procedural strand cutting* ([project](https://digital-salon.github.io/), [arXiv](https://arxiv.org/html/2507.07387v1)).
- **Daviet, "Interactive Hair Simulation on the GPU using ADMM" (SIGGRAPH 2023)** ([ACM](https://dl.acm.org/doi/10.1145/3588432.3591551), [SIGGRAPH blog](https://blog.siggraph.org/2023/06/say-goodbye-to-split-ends-with-admm.html/)): Kirchhoff rods with Coulomb friction. Groom editing includes **trimming along a cutting plane**.
- Interactive hairstyling with cutting: **ISALON** (UNC) ([project](http://gamma.cs.unc.edu/ISALON/)) and "A Simulation-based VR System for Interactive Hairstyling" ([ResearchGate](https://www.researchgate.net/publication/224643560_A_Simulation-based_VR_System_for_Interactive_Hairstyling)): multiresolution strand groups with a haptic stylus doing cutting and blow-drying. The pattern: **cutting = shorten rest lengths / delete the tail particles of a strand group, and spawn the cut-off part as free debris**.
- Cutting deformables in general: Wu et al., "A Survey of Physically Based Simulation of Cuts in Deformable Bodies" (CGF 2015) ([Wiley](https://onlinelibrary.wiley.com/doi/10.1111/cgf.12528)); Robust XFEM cutting ([project](https://www.animation.rwth-aachen.de/publication/0551/), [2MP #164](https://www.youtube.com/watch?v=R5t74AC6I0A)).
- XPBD/Cosserat rods: see cloth-knitting.md §2. Use them for the spun yarn, not for the fleece.

### 3.3 How to model a fleece that comes off in one piece

What real shearing tells us:

- The goal is to remove the fleece **in one piece**, with the belly wool rolled inside it.
- The **Bowen technique** was designed as about 55 blows for a grown crossbred sheep. Top shearers take under 50 blows and 2–3 minutes. The free hand **stretches the skin flat**, and the sheep is "crimped up" to be small ([Te Ara: Shearing](https://teara.govt.nz/en/shearing/print), [Wikipedia: Sheep shearing](https://en.wikipedia.org/wiki/Sheep_shearing)).
- The order is chest → belly → hind legs → neck → shoulder/flank/back (long blows) → other side ([Fibershed](https://fibershed.org/2019/07/19/choreography-and-skill-how-sheep-are-sheared/)).
- An intact fleece "stays in exactly the same formation as it was on the sheep, forming a blanket".
- The handpiece is a toothed cutter driven back and forth over a comb ([Wikipedia](https://en.wikipedia.org/wiki/Sheep_shearing)).
- "Second cuts" (going over the same spot twice) make short snippets that are bad for spinning. Skirting removes the sweat-stained edge bits ("fribs") afterwards.

**Proposed model ("pinned thick blanket"):**

1. **Fleece sheet.** A coarse XPBD cloth (`Cloth` from Tear Sheet, about 32×24 = 768 particles (est)) laid over the sheep's body UV chart. It represents the fleece as a *coherent mat*. The wool fibres interlock through crimp, lanolin and felting at the base, so the mat has low stretch, moderate shear, low bending and high damping. Every particle has an **attachment constraint** to its skin anchor, a zero-length XPBD constraint to a point on the animated sheep.
2. **Length / "cut" maps.** Two R8 textures over the sheep UV, about 256² (est) with a CPU mirror:
   - `L`, the wool length (1 = full fleece, 0.05 = stubble). The shell shader reads it on the **sheep skin mesh**, which shows stubble and the remaining fleece.
   - `C`, cut coverage. The clipper stamps a comb-width capsule along its path into `C`.
3. **Release.** When `C` under a fleece particle's anchor goes above 0.8, its attachment constraint is removed. The released region hangs off the still-attached region under gravity: the blanket peels and flops over, showing its cream underside. This is the "peel curls away" beat from soap-cutting games, done physically. The skin under it is set to stubble in `L`.
4. **The fleece renders as shells on the sheet itself.** Draw the same shell shader on both sides of the sheet mesh. The outer side uses tips (grey); the inner side uses cut roots (cream + lanolin glints). Thickness is `L` sampled at the time of cutting. If you cut *high* (a shallow blow), `L` on the skin stays partly long and the peeled mat is thinner. That's natural feedback for technique.
5. **Tearing = sloppy technique.** When a released region hangs from a thin bridge (strain over the threshold), use Tear Sheet's vertex-split tear and the piece drops off. Score "one-piece-ness" as the fraction of the area in the largest connected component. It's shown gently, e.g. a rosette at the end, never as a fail.
6. **Second cuts.** Clipping where `L` is already stubble spawns a few DFTL snippets (short strands) and a softer, "dry" sound and haptic (no crunch). That's success-dependent juice per Kao et al.
7. **Skin stretching (the free-hand trick).** A two-finger variant: the second finger held on the sheep "flattens" the local skin, which smooths the length map's curvature, lowers clipper drag and gives a cleaner release. It's optional depth for experts.
8. **Poses.** Don't simulate the sheep. Use 5–6 authored poses following the Bowen order and tween between them when a region's meter completes. Attachment anchors are skinned points, so the peeled fleece swings naturally as the sheep turns.

**Cheaper fallback (web/low-end):** no sheet. The cut fleece becomes a baked "fleece blanket" mesh that grows via the `C` mask and is shown lying beside the sheep. It's still satisfying, just with no flop.

---

## 4. Spinning and knitting

### 4.1 What spinning is, physically, and what to simulate

- **Drafting plus twist.** Fibres are drawn out (drafted) to the target thickness, and twist locks them into yarn. The spinner pinches to stop twist entering undrafted fibre, pulls back to draft, then releases to let the twist run in ([Schacht drop spindle guide](https://schachtspindle.com/blogs/archives/a-beginners-guide-to-spinning-on-a-drop-spindle), [Paradise Fibers park-and-draft](https://paradisefibers.com/blogs/all/the-park-and-draft-drop-spinning)). Z-twist is spun clockwise and S-twist counterclockwise. Sliding the pinch back over wispy fibre lets twist travel up and trap stray fibres ([Riley Wood & Fiber Art guide](https://rileywoodandfiberart.com/blogs/fiber-arts-guides/drop-spindle-spinning-beginners-guide)). See also [Spinning (textiles)](https://en.wikipedia.org/wiki/Spinning_(textiles)) and [Spindle](https://en.wikipedia.org/wiki/Spindle_(textiles)).
- **Twist dynamics** (textile engineering): "Mathematical Modeling of Yarn Dynamics in a Generalized Twisting System" (Sci. Rep. 2016) ([Nature](https://www.nature.com/articles/srep24432)) models twist generation and **twist propagation** along a moving yarn.
- **Game-relevant simplification (est):** keep a 1-D array along the forming yarn rod with thickness `d_i` and twist `τ_i`.
  - The wheel injects twist at the orifice at a rate of `ω_wheel × ratio`.
  - Twist diffuses toward the fibre supply, with conductance ∝ `1/d_i²`, so it pools in thin sections. That is the real "twist goes to the thin spot" behaviour spinners fight.
  - Drafting speed `v_draft` (how fast the second finger pulls away from the fleece) sets `d`, from mass conservation: `d² ∝ feed/v_draft`.
  - **Under-twist** (`τ·d` below a threshold) → the yarn drifts apart. A slip constraint breaks, with a soft "fwump".
  - **Over-twist** → give the rod a rest twist and let the XPBD bend-twist constraint (cloth-knitting.md, Cosserat rods) buckle it into a **pigtail/snarl** when tension drops. A real, visible, cute failure.
  - Store per-segment `d` and colour. This is the **yarn's DNA** for the knitting step.
- **Rendering the yarn:** reuse cloth-knitting.md §3.2 (Zhao procedural yarn vocabulary, Wu & Yuksel ply-twist normals). Here the **helix angle comes from simulated `τ`**, so you literally see the twist tighten. Add fuzz halo density ∝ `1/τ` (loose yarn is fluffier).
- **Felting** (optional side toy): wool fibres have scales that open under heat, moisture and motion and then latch onto each other. Needle felting uses barbed needles to tangle fibres ([Wikipedia: Felt](https://en.wikipedia.org/wiki/Felt)). A felting mini-toy could be "stab to sculpt": each stab raises a density field in a voxel or heightfield blob (MPM is overkill). Tag it a future idea.

### 4.2 Touch interaction design

**Spinning wheel (two thumbs):**

- **Treadle thumb:** circular swipes on the wheel. Angular velocity drives the wheel and the flywheel has inertia. Add a detent tick per spoke with `selectionChanged` or a native transient, and a treadle "clack" every revolution.
- **Drafting finger:** pinch a tuft on the fleece pile and pull away. The C/D ratio drops while fibres grip, then releases (a pseudo-haptic stick-slip). Lifting the finger = releasing the pinch, which lets twist in.
- **Rhythm:** the real park-and-draft cycle (spin → park → draft → release) maps well to a 2-beat loop. Hint the tempo with a soft wheel-creak beat. Never fail on timing; the only consequences are yarn thickness and twist.
- **Drop-spindle alternative** (one thumb, even simpler): flick to spin the spindle, which hangs from a rod and slowly loses spin. The other finger drafts. Good for the web or smaller screens.

**Knitting (tie-in to cloth-knitting.md Toy 2 "Knit-a-Scarf"):**

- One stitch = one gesture with **two detents**: (1) the needle tip enters the loop (tick), (2) wrap and pull through, then slip off (a "pop" transient plus the loop visually sliding across needles).
- Alternate thumbs, left then right, for a natural rocking rhythm. Consistent tempo builds a "flow" meter that only adds juice (warmer light, a purr from the sheep), never penalties. That follows Riley et al. and Kao et al.'s success-dependent juice.
- Auto-knit when holding (for accessibility). Knit/purl toggle for ribbing.
- **Your yarn shows.** The stitch mesh uses per-stitch yarn `d` from the spun yarn, so thick slubs make fat stitches and thin spots make tight ones. Per-stitch scale goes into the MADYPG-lite strain-blended normal atlas (cloth-knitting.md §3.1). Stripes come from the fleece colour, e.g. a black sheep. This is the emotional hook: "I made this from *that* sheep."

**Existing knitting and spinning references:** knitting-themed mobile games are nearly all colour-sort puzzles (Knit Out, Yarn Loop, Wool Out, Knit Craft, above; see also a knitter's review of knitting apps: [WLS Makes Stuff](https://wlsmakesstuff.com/blog-of-making-stuff/knitting-themed-mobile-apps)). No gesture-knitting toy with physical yarn was found. Browser yarn physics references (KnitScape, Crochet Simulator) are already in cloth-knitting.md §4.2.

---

## 5. Audio for satisfaction

### 5.1 Research

- **An, James, Marschner, "Motion-driven Concatenative Synthesis of Cloth Sounds" (SIGGRAPH 2012)** ([project](https://www.cs.cornell.edu/projects/Sound/cloth/), [PDF](https://www.cs.cornell.edu/projects/Sound/cloth/cloth2012.pdf), [video](https://www.youtube.com/watch?v=56lq84Fx47g)). Motion events from the cloth sim drive crumple and friction models, which produce a rough target signal. Then micro-sound units are picked from recorded cloth to match it. **Phone version:** record 30–60 s each of fleece handling, wool friction and yarn tugs. Slice them into 20–80 ms grains tagged by loudness and brightness, and pick grains by sim features (normal velocity and friction speed per region).
- **Cirio, Li, Grinspun, Otaduy, Zheng, "Crumpling Sound Synthesis" (SIGGRAPH Asia 2016)** ([PDF](http://www.cs.columbia.edu/cg/crumpling/crumpling-sound-synthesis-siggraph-asia-2016-cirio-et-al.pdf), [video](https://www.youtube.com/watch?v=Gue12UjXd5U)). Crumpling sound is a superposition of clicks from buckling events: visually significant ones are detected, and insignificant ones are added stochastically. **Use for:** the fleece peel. Each attachment release is a "significant" event (a soft pop), plus a stochastic crackle bed at a rate ∝ release rate.
- **Schweickart, James, Marschner, "Animating Elastic Rods with Sound" (SIGGRAPH 2017)** ([project](https://www.cs.cornell.edu/projects/rodsound/), [2MP #175](https://www.youtube.com/watch?v=6c2T2cykE_A)). Kirchhoff rods with dipole radiation. **Use for:** yarn twang when it snaps taut, and snarl "zip" (a cheap version: a pitched pluck whose frequency ∝ √tension / length).
- **O'Brien et al., "Synthesizing Sounds from Rigid-Body Simulations" (SCA 2002)** ([PDF](http://graphics.berkeley.edu/papers/Obrien-SSR-2002-07/Obrien-SSR-2002-07.pdf)). Modal synthesis. **Use for:** knitting-needle clicks (2–3 damped sinusoids; bamboo sounds low and woody, metal high and ringy).
- **Andy Farnell, *Designing Sound* (MIT Press 2010)** ([MIT Press](https://mitpress.mit.edu/9780262014410/designing-sound/)). The procedural-audio "sound as process" cookbook (motors, friction, creaks). Its motor and creak recipes translate directly to Web Audio graphs.
- **Survey:** "Sound Synthesis, Propagation, and Rendering: A Survey" ([arXiv 2011.05538](https://arxiv.org/pdf/2011.05538)).

### 5.2 Clipper buzz modulated by load (the hero sound)

- **Real reference.** Magnetic/pivot clipper motors vibrate at the mains frequency. The hum is **twice the mains frequency (100 Hz on 50 Hz mains, 120 Hz on 60 Hz)**, and the armature spring is tuned to that rate ([Wikipedia: Mains hum](https://en.wikipedia.org/wiki/Mains_hum), [Wahl vibrator-motor patent](https://www.freepatentsonline.com/5787587.html)). Shearing handpieces are rotary, belt/flex-shaft or electric-driven cutter-over-comb, so they sound more like a whine plus the reciprocating chatter of the cutter.
- **Web Audio patch (est):**
  1. Base: a 120 Hz pulse/saw oscillator plus a 2nd–5th harmonic stack, through a bandpass at about 900 Hz (plastic body), at about −18 dB.
  2. **Load `λ`** comes from the sim: wool density under the comb × finger speed. Pitch drops by `−8%·λ` (motor sag), the drive into a `WaveShaperNode` goes up by `λ` (grit), and the lowpass cutoff falls by 20% (muffled by the wool).
  3. **Crunch grains:** granular playback of recorded wool-cutting (snip/crunch) at a rate ∝ fibre-cut rate (area of `C` changed per frame × `L`), with random ±3 semitone detune and 10–40 ms grains. The grain rate is the same number that drives the haptic `playbackRate`. **One source of truth for audio and haptics** is Apple's "harmony" principle.
  4. **Idle vs contact:** a thin "air" buzz when off the wool, and a noticeably fuller sound at contact. That audible step is part of the causality.
- **Granular in the browser:** zya granular ([demo](https://zya.github.io/granular/), [repo](https://github.com/zya/granular)) and granular-js ([repo](https://github.com/philippfromme/granular-js)) schedule overlapping `AudioBufferSourceNode`s with gain envelopes. That's fine up to about 50–100 grains/s (est). For more, write a tiny `AudioWorkletProcessor` grain engine; AudioWorklet has shipped since Safari 14.1 / iOS 14.5 ([caniuse](https://caniuse.com/mdn-api_audioworklet)).

### 5.3 iOS Web Audio gotchas

- Create and resume the `AudioContext` inside the first `pointerdown`.
- **The silent switch mutes Web Audio** unless the audio session is `playback` ([MDN AudioSession.type](https://developer.mozilla.org/docs/Web/API/AudioSession/type), [W3C explainer](https://github.com/w3c/audio-session/blob/main/explainer.md), [unmute-ios-audio](https://github.com/feross/unmute-ios-audio)). A toy should probably *respect* the silent switch (`ambient`), since ASMR in public is rude. Make it a setting. Whether `navigator.audioSession` is exposed inside Capacitor's WKWebView is **[unverified]**. If not, set `AVAudioSession` natively in the same local plugin.
- Keep audio graph construction out of the frame loop. Pre-decode all buffers at toy start.

---

## 6. Two Minute Papers and talks (all YouTube IDs checked via oEmbed)

The yarn/cloth 2MP episodes are in cloth-knitting.md §5 and not repeated here, except the three most relevant.

| Video | Why watch |
|---|---|
| [Interactive Hair-Solid Simulations — 2MP #90](https://www.youtube.com/watch?v=HvHZXPd0Bjs) | First hair episode: hair–body contact |
| [Automatic Hair Modeling from One Image — 2MP #92](https://www.youtube.com/watch?v=XmM1tF7AxdA) | Grooming or strand-generation ideas |
| [Simulating Liquid-Hair Interactions — 2MP #155](https://www.youtube.com/watch?v=ugdciqeOPeM) | Wet wool, for a possible "wash the fleece" step |
| [Real-Time Hair Rendering With Deep Opacity Maps — 2MP #171](https://www.youtube.com/watch?v=7x2UvvD48Fw) | Self-shadowing in hair volumes (fake it with shell-height AO) |
| [Elastoplastic Hair and Cloth Simulations — 2MP #176](https://www.youtube.com/watch?v=RygQnpQMdPI) | Plastic deformation, for matted or felted wool |
| [Photorealistic Fur With Multi-Scale Rendering — 2MP #183](https://www.youtube.com/watch?v=qKhSZmS6aWw) | Near/far fur reflectance (Yan et al.) |
| [Simulating Cuts On Virtual Bodies — 2MP #164](https://www.youtube.com/watch?v=R5t74AC6I0A) | XFEM cutting |
| [Animating Elastic Rods With Sound — 2MP #175](https://www.youtube.com/watch?v=6c2T2cykE_A) | Yarn sound |
| [NVIDIA Is Simulating 100,000 Hair Strands! — 2MP](https://www.youtube.com/watch?v=eVjhOzY9KvY) | Per third-party summaries this covers Daviet's ADMM hair (SIGGRAPH 2023) **[paper mapping unverified]** |
| [Why Gamers Will Never See Hair The Same Way Again — 2MP](https://www.youtube.com/watch?v=WYTOxOhKl3Y) | Linked from Yuksel's Hair Meshes rendering page (SIGGRAPH 2024) |
| [Opening The First AI Hair Salon! — 2MP](https://www.youtube.com/watch?v=0ISa3uubuac) | SketchHairSalon (image-space; low relevance) |
| [Procedural Yarn Models — 2MP #76](https://www.youtube.com/watch?v=iTRnr6p7iYo), [Real-Time Fiber-Level Cloth Rendering — 2MP #132](https://www.youtube.com/watch?v=JzOc_NNY_zY), [From Mesh To Yarn… In Real Time! — 2MP](https://www.youtube.com/watch?v=d3njVfnCdN0) | Yarn look (already in cloth-knitting.md) |

**Talks and other videos:**

- [Acerola — How Do Games Render Fur?](https://www.youtube.com/watch?v=9dr-tRQzij4)
- [Müller — Fast Simulation of Inextensible Hair and Fur](https://www.youtube.com/watch?v=zB8Fqbfrrpo)
- [Procedural Grass in Ghost of Tsushima (GDC 2021)](https://www.youtube.com/watch?v=Ibe1JBF5i5Y)
- [Hair Meshes rendering (SIGGRAPH 2024)](https://www.youtube.com/watch?v=rv6e518-VjY)
- [Juice it or lose it](https://www.youtube.com/watch?v=Fy0aCDmgnxg)
- [The art of screenshake](https://www.youtube.com/watch?v=AJdEqssNZ-U)
- [WWDC19 Designing Audio-Haptic Experiences](https://www.youtube.com/watch?v=-hvClUdSlhA)
- [Cloth sound synthesis](https://www.youtube.com/watch?v=56lq84Fx47g)
- [Crumpling sound synthesis](https://www.youtube.com/watch?v=Gue12UjXd5U)
- [three.js shells+fins fur](https://www.youtube.com/watch?v=NnuN9WyShMo)

---

## 7. "Shear & Knit" design and tech plan

### 7.1 Core loop

```
 ┌─► SHEAR ──► FLEECE BLANKET ──► (skirt: flick off fribs/burrs) ──► SPIN ──► KNIT ──► DRESS THE SHEEP ─┐
 │   reveal     one-piece rosette      optional, 20 s                  yarn DNA   scarf/sweater   shivers stop │
 └───────────────────────── wool regrows (length map grows back, 30–60 s or on tap) ◄──────────────────────┘
                     (Pull the Thread: unravel the scarf back into yarn → reknit)
```

- **Session target** (est): shear about 60–120 s, spin about 45 s, knit about 60–120 s for a short scarf.
- **Every stage is a toy on its own.** The hub can deep-link to "Shear only", "Spin only" or "Knit only", so bobo's sandbox rule holds: no forced progression.
- **Sheep variety** (the curiosity driver per Kao et al.): white, black, a Jacob with spots (the spots survive into the yarn as tweed), a muddy one (tips very dark, big reveal), and a "Shrek-size" overgrown one (long staples, heavy flop).

### 7.2 Per-step technique and phone budgets (iPhone 13 mini, 60 fps, all **(est)**)

| Step | Technique | CPU (JS) | GPU | Reuses | Effort |
|---|---|---|---|---|---|
| **Shear: fleece render** | Instanced opaque shells with discard (24 near / 12 far) on the sheep mesh (about 4–6k tris); per-staple Voronoi cells; height-graded albedo (cream root, grey tip); crimp offset; shell-height AO; low Kajiya-Kay. Wind and gravity via a per-vertex offset from 16–32 DFTL guide strands. | 0.2 ms (guides) | 3–5 ms at DPR 2 when the sheep fills about 40% of the screen. Fall back to DPR 1.5 or 16 shells if the frame goes over. | Shell shader is new; `shell/gl.ts` | M |
| **Shear: length/cut maps** | R8 256² `L` and `C`, CPU `Uint8Array` mirrors; comb-capsule stamp per frame; `texSubImage2D` of the dirty rect only; per-region coverage counters (6 Bowen regions). | <0.2 ms | <0.1 ms | — | S |
| **Shear: fleece blanket** | XPBD `Cloth` about 32×24 over the body UV chart; zero-length attachment constraints to skinned anchors, released by `C`; strain-based vertex-split tear for sloppy bridges; double-sided shell render (tips out, cream in). | 0.6–1.2 ms (10 substeps) | 1–2 ms (sheet shells, 12–16 layers) | **Tear Sheet** `Cloth`, `cut()`, tearing; **Laundry** break-at-force pins | M |
| **Shear: clipper feel** | C/D-lag clipper (a spring toward the finger, with stiffness ∝ 1/load); 1–2 px jitter synced to the grain rate; comb-stripe decal on the skin; tuft particles (instanced quads, 200 max) at the comb; second-cut DFTL snippets. | 0.2 ms | 0.3 ms | — | S |
| **Sheep** | Authored skinned sheep, 5–6 Bowen poses, tweened; blink, breathing and bleat reactions; shivers when fully shorn. | 0.1 ms | shared | — | M (art) |
| **Skirting (optional)** | Tap or flick "frib" chunks at the blanket edge: `Cloth` vertex-split along a predefined weak seam, then fling. | — | — | Tear Sheet | S |
| **Spin** | Wheel as a 1-DOF flywheel; forming yarn = XPBD/Cosserat rod, 200–600 segments; 1-D twist/thickness arrays with twist diffusion ∝ 1/d²; slip-break and snarl (rest-twist buckling); bobbin build-up as a parametric "cop" mesh; fleece-pile drafting zone with a DFTL fibre fan (about 40 strands) converging into the yarn. | 0.5–1 ms | 0.5 ms (yarn tubes, instanced) | **Pull the Thread** rod/yarn render (`thread/render.ts`), cloth-knitting.md rods | M–L |
| **Knit** | Growing XPBD strip plus stitch grid (Knit-a-Scarf, cloth-knitting.md Toy 2), 20 wide × ≤120 rows, coarsened far rows; per-stitch `d` and colour from the yarn DNA into a data texture; knit/purl atlas with strain blend. | 1–2 ms | 1 ms | **Pull the Thread** `Knit` (stitch grid, `pop()` in reverse = knit), laundry/cloth solver | M |
| **Dress the sheep** | Scarf `Cloth` with capsule colliders on the neck and body; drag to wrap; LRA tether to the neck ring. Sweater = a pre-authored garment mesh whose texture is the knitted swatch (don't simulate a whole sweater). | 0.5 ms | shared | Cloth ball/SDF colliders | S–M |
| **Regrow and unravel** | `L` grows back per frame (+ noise); scarf → Pull the Thread → yarn → back to Knit. | — | — | **Pull the Thread** | S |
| **Haptics bridge** | Local Capacitor plugin (§2.3); `ToyContext.haptics`. | — | — | extends `main.ts` `haptic()` | S |
| **Audio engine** | Shared `src/shell/audio.ts`: context unlock, sample bank, grain scheduler (AudioWorklet), motor-patch factory, modal click. | 0.3 ms (audio thread separate) | — | new, reusable by all toys | M |

**Frame budget check (shear scene, the heaviest):** CPU about 2–3 ms and GPU about 5–7 ms (est), so it fits in 16.6 ms with headroom. Watch overdraw first. Profile with Safari Web Inspector timelines plus Xcode GPU frame capture on the device.

### 7.3 Haptic pattern table

Values are Core Haptics intensity (**I**) and sharpness (**S**), 0–1. "Cont" = a continuous looped player updated through dynamic parameters. "Grain" = a looping pattern of 12 transients (I 0.35, S 0.55) whose `playbackRate` is modulated. All values are starting points **(est)**; tune them on the device.

| Event | iOS Core Haptics (native bridge) | `@capacitor/haptics` only (today) | Web fallback |
|---|---|---|---|
| Clippers on, in the air | Cont I 0.12, S 0.55 (thin buzz) | none (too coarse) | none |
| Clippers in wool (load λ 0–1) | Cont I 0.25 + 0.5λ, S 0.50 − 0.15λ (duller as it bogs down); Grain rate 0.5–2.5× ∝ fibre-cut rate | `impact(Light)` every ~80 ms while cutting, scaled by λ | Android: `vibrate(6)` at the cut rate (≤25 Hz); iOS web: none |
| Clean long blow finished (≥30 cm, no second cut) | Transient I 0.6, S 0.4, then a 120 ms fade on Cont | `impact(Medium)` | Android `vibrate(15)` |
| Fleece region releases (attachment pops) | Transient per pop, I 0.2–0.35 random, S 0.2 (soft), max 20/s | `selectionChanged()` (throttled 60 ms) | — |
| Region complete (PowerWash ping) | AHAP: 2 transients (I 0.5/0.7, S 0.6/0.8, 80 ms apart) | `notification(Success)` | Android `vibrate([10,60,15])`; iOS web: switch-tick if on tap |
| Fleece off in one piece | AHAP "fanfare": swell Cont 0→0.6 over 300 ms (S 0.3) + 3 rising transients | `notification(Success)` + `impact(Heavy)` | Android pattern |
| Fleece tears (sloppy) | Transient I 0.45, S 0.9 (a sharp "rip") | `impact(Rigid)` or Medium | Android `vibrate(8)` |
| Second cut (already shorn) | Grain rate ×0.5, Cont S +0.2, I ×0.6 (thin, "empty") | nothing (the absence is the feedback) | — |
| Clipper hits a burr or matted knot | Transient I 0.8, S 1.0 + a 150 ms Cont stall (I 0.7, S 0.2) | `impact(Heavy)` | Android `vibrate(25)` |
| Spinning wheel turning (ω) | Cont I 0.1 + 0.25·ω̂, S 0.15 (low purr); transient I 0.3, S 0.5 per revolution ("treadle") | `selectionChanged()` per spoke | Android `vibrate(4)` per revolution |
| Drafting: fibres grip, then slip | Cont modulated by the stick-slip: I 0.3 while sticking, then a transient I 0.4, S 0.7 at the slip | `selectionChanged()` at the slip | — |
| Yarn over-twist snarl | Transient burst ×3 (I 0.3, S 0.9, 30 ms apart) | `impact(Light)` ×1 | — |
| Yarn breaks (under-twist) | Transient I 0.5, S 0.1 (dull "fwump") | `impact(Soft)` / Light | Android `vibrate(12)` |
| Knit detent 1 (tip into loop) | Transient I 0.25, S 0.8 (a click) | `selectionChanged()` | iOS web: switch-tick (tap mode only) |
| Knit detent 2 (slip off, stitch made) | Transient I 0.45, S 0.35 (a soft pop) | `impact(Light)` | Android `vibrate(8)` |
| Row complete | AHAP: short roll of 4 transients, I 0.3→0.6 | `notification(Success)` | Android pattern |
| Scarf wrapped on sheep / sheep happy | AHAP "purr": Cont I 0.2, S 0.1, 1.2 s, with a 4 Hz intensity curve | `impact(Soft)` | — |

**Rules (from HIG and the literature):**

- One meaning per pattern.
- Keep a global haptic budget, e.g. at most 1 continuous player and at most 25 transients/s in total.
- Tie every event to a visible cause.
- Provide a haptics toggle and a strength slider (a global intensity multiplier on the native side).
- Make the richest feedback depend on success (a clean blow, a steady rhythm), not just on activity.

### 7.4 Audio table

| Event | Source | Parameters driven by sim | Notes |
|---|---|---|---|
| Clipper motor | Procedural: 120 Hz pulse + harmonics → waveshaper → bandpass | pitch −8%·λ, drive +λ, lowpass −20%·λ | Idle → contact is a clear audible step |
| Wool crunch | Granular from recorded wool-cutting samples (record your own: scissors through roving/fleece) | grain rate = fibre-cut rate (shared with haptic Grain), pitch ±3 st | 10–40 ms grains, Hann envelopes |
| Fleece peel | Crumpling-style: sparse soft pops per attachment release + stochastic crackle bed (filtered noise bursts) | pop count = releases/frame; bed density ∝ release rate | After Cirio 2016 |
| Fleece flop / thud | Short low "whumpf" sample, pitch ∝ 1/mass of the released chunk | impact speed of sheet particles on the floor | Layered with a camera nudge |
| Region complete | Pentatonic chime, rising per region (6 notes → the full fleece "resolves" the scale) | region index | PowerWash-style completion |
| Fleece off (one piece) | Chime chord + sheep "baa" + soft crowd-less "ta-da" | one-piece score changes the chord (major / sus) | Success-dependent juice |
| Second cut | Thin "tick-tick" dry snips, no crunch bed | — | Absence of crunch = feedback |
| Burr hit | Metallic "tink" (modal, 2 partials about 3.2/5.1 kHz) + motor bog | — | |
| Sheep | Bleat samples (4–6 variants), breaths, contented hum | pose, completion, shiver | Keep it cute, not distressed |
| Wheel | Wooden creak loop (Farnell-style friction creak) + whirr (noise → bandpass at the wheel's spoke-pass frequency) + treadle clack per revolution | ω | |
| Drafting | Friction "fsss" (noise → high shelf) ∝ draft speed; stick-slip ticks | v_draft, stick state | |
| Yarn twang / snap | Plucked string (Karplus-Strong in the AudioWorklet), f ∝ √tension/L | rod tension spikes | After rod-sound ideas |
| Needle click | Modal: bamboo (about 1.2 kHz + 2.9 kHz, τ 25 ms) or metal (about 3 kHz + 7 kHz, τ 120 ms) | per detent; ±5% random pitch | After O'Brien 2002 |
| Yarn pull-through | Soft fabric friction grain (cloth sample bank) | loop slide speed | After An 2012 |
| Row complete | Wooden "tock" + soft chime | row index | |
| Ambience | Farm room tone, birds, far-off sheep | — | Duck by 6 dB while clipping |

### 7.5 Rendering tricks (juice list)

- **The reveal (the single most important visual):** cream cut side, golden lanolin glints (sparkle: sparse, high-spec flecks on the inner side, animated by view angle), and the clean pink-white skin with comb stripes.
- **The peel:** let the released blanket curl away with gravity, and bias it slightly outward with a small "peel" force along the blow direction for 200 ms. Soap-cutting games live on the curl.
- **Tufts:** a small burst of fluff quads at the comb (velocity-aligned, drag-heavy, 0.6 s life), density ∝ cut rate. Motes of lanolin "dust" in a backlight.
- **Camera:** gentle follow-zoom toward the clipper; a slow push-in and 70 ms hit-stop on "fleece off"; *no* screenshake while shearing.
- **Sheep acting:** it leans into long blows, wiggles an ear at the neck, shivers when shorn, and smiles in the scarf. The acting sells the "care" fantasy.
- **Progress:** subtle region outlines that fill (PowerWash) plus a one-piece rosette. No timers.
- **Yarn:** twist-driven helix angle and fuzz; the thick-thin yarn looks handspun and is proudly shown on the bobbin.
- **Knit:** stitches visibly carry your yarn's slubs and colours. The row-complete glint sweeps across the row.

### 7.6 Build order and effort

| Milestone | Scope | Effort | Ship as |
|---|---|---|---|
| M0 | `shell/audio.ts` (unlock, sample bank, grain scheduler, motor patch) + local `BoboHaptics` Capacitor plugin + `ToyContext.haptics` with fallback to the current `haptic()` | S + M | Retrofit existing toys (Tear Sheet rip, Laundry pin pop, Pull the Thread stitch pops) for immediate wins |
| M1 | Shell-fur shader + length/cut maps + clipper C/D lag + audio/haptics on a *static* sheep; "stubble reveal" | M | "Shear" v0 (already satisfying) |
| M2 | Fleece blanket (XPBD sheet with attachment release, double-sided shells, tearing, one-piece score), Bowen poses, region meters | M | **"Shear" toy** |
| M3 | Spinning wheel (twist/thickness rod, drafting, snarl/break, bobbin) using the fleece-pile colour | M–L | "Spin" toy |
| M4 | Knitting with yarn DNA (extends Knit-a-Scarf / `thread` `Knit`) + dress the sheep + regrow + unravel link | M | **"Shear & Knit"** full loop |
| Later | Wash/scour (lanolin suds, reuse ink/goo fluid), carding, needle-felting side toy, black/Jacob/muddy sheep variants | S each | Content |

**Total:** about L (roughly 6–9 weeks for one engineer plus an artist (est)). M0–M2 alone (about 3 weeks, est) gives a standalone, highly shareable "Shear" toy.

**Risks:**

1. **Shell overdraw on a full-screen sheep.** Mitigate with distance-based shell count, DPR drop, and early-out on `L < 0.1`.
2. **Bridge latency and jitter for haptic updates.** Mitigate with native loops (grain `playbackRate`) rather than per-tick calls.
3. **Sheep art and animation** is the long pole, not tech.
4. **Tone.** Keep the sheep happy and comfortable. Never nick the skin, which a real shearer avoids and players would find upsetting.

---

## 8. References

**Haptics and pseudo-haptics**
- Lécuyer 2009, Pseudo-haptic survey: https://direct.mit.edu/pvar/article/18/1/39/18739/Simulating-Haptic-Feedback-Using-Vision-A-Survey · draft PDF https://people.rennes.inria.fr/Anatole.Lecuyer/presence_lecuyer_draft.pdf
- Lécuyer, Burkhardt, Etienne 2004, Feeling bumps and holes: https://dl.acm.org/doi/10.1145/985692.985723
- Costes et al. 2019, Touchy: https://www.frontiersin.org/journals/ict/articles/10.3389/fict.2019.00001/full
- Hachisu et al. 2011, Pseudo-haptic + visual/tactile vibrations: https://www.researchgate.net/publication/224234143_Pseudo-haptic_feedback_augmented_with_visual_and_tactile_vibrations
- Static friction via pseudo-haptics (stick-slip): https://arxiv.org/pdf/1904.11676
- Romano & Kuchenbecker 2012: https://doi.org/10.1109/toh.2011.38
- Penn Haptic Texture Toolkit: http://haptics.seas.upenn.edu/index.php/Research/ThePennHapticTextureToolkit
- TeslaTouch 2010: https://dl.acm.org/doi/10.1145/1866029.1866074
- Martín, Weinmann, Hullin 2018, Material sonification on touchscreens: https://arxiv.org/pdf/1807.01106
- Tactile feedback in gaming, narrative review: https://www.ncbi.nlm.nih.gov/pmc/articles/PMC12099099/

**Apple / Capacitor / web haptics**
- HIG Playing haptics: https://developer.apple.com/design/human-interface-guidelines/playing-haptics
- Core Haptics: https://developer.apple.com/documentation/corehaptics
- Real-time parameter updates (HapticPalette): https://developer.apple.com/documentation/corehaptics/updating-continuous-and-transient-haptic-parameters-in-real-time
- Collision-based haptics (HapticBounce): https://developer.apple.com/documentation/corehaptics/playing-collision-based-haptic-patterns
- AHAP format: https://developer.apple.com/documentation/corehaptics/representing-haptic-patterns-in-ahap-files
- CHHapticDynamicParameter: https://developer.apple.com/documentation/corehaptics/chhapticdynamicparameter · CHHapticParameterCurve: https://developer.apple.com/documentation/corehaptics/chhapticparametercurve · hapticContinuous (30 s max): https://developer.apple.com/documentation/corehaptics/chhapticevent/eventtype/hapticcontinuous · playbackRate: https://developer.apple.com/documentation/corehaptics/chhapticadvancedpatternplayer/playbackrate · loopEnabled: https://developer.apple.com/documentation/corehaptics/chhapticadvancedpatternplayer/loopenabled · playsHapticsOnly: https://developer.apple.com/documentation/corehaptics/chhapticengine/playshapticsonly
- WWDC19 810: https://developer.apple.com/videos/play/wwdc2019/810 · https://www.youtube.com/watch?v=-hvClUdSlhA · WWDC19 520: https://developer.apple.com/videos/play/wwdc2019/520 · WWDC19 223: https://developer.apple.com/videos/play/wwdc2019/223 · WWDC21 10278: https://developer.apple.com/videos/play/wwdc2021/10278 · WWDCNotes: https://wwdcnotes.com/documentation/wwdcnotes/wwdc19-810-designing-audiohaptic-experiences/
- Hapticlabs Apple notes (80–230 Hz): https://docs.hapticlabs.io/mobile/apple/
- Büttner, 10 things about Core Haptics (403 on fetch; claim from snippet): https://danielbuettner.medium.com/10-things-you-should-know-about-designing-for-apple-core-haptics-9219fdebdcaa
- Lofelt Nice Vibrations (audio→haptic clips, reference): https://github.com/Lofelt/NiceVibrations
- Capacitor Haptics: https://capacitorjs.com/docs/apis/haptics · Custom native iOS code: https://capacitorjs.com/docs/ios/custom-code
- Capawesome Haptics: https://capawesome.io/docs/sdks/capacitor/haptics/
- capacitor-rich-haptics: https://github.com/sergey-faraday/capacitor-rich-haptics
- caniuse vibrate: https://caniuse.com/mdn-api_navigator_vibrate · MDN BCD issue: https://github.com/mdn/browser-compat-data/issues/29166
- WebKit Safari 18 (switch haptics): https://webkit.org/blog/15865/webkit-features-in-safari-18-0/ · tijnjh/ios-haptics: https://github.com/tijnjh/ios-haptics · ios-vibrator-pro-max: https://github.com/samdenty/ios-vibrator-pro-max

**Game feel and satisfaction**
- Swink, Game Feel: https://www.taylorfrancis.com/books/mono/10.1201/9781482267334/game-feel-steve-swink · https://en.wikipedia.org/wiki/Game_feel
- Juice it or lose it: https://www.youtube.com/watch?v=Fy0aCDmgnxg
- The art of screenshake: https://www.youtube.com/watch?v=AJdEqssNZ-U · https://archive.org/details/the-art-of-screenshake
- Hicks et al. 2019, Juicy Game Design: https://dl.acm.org/doi/abs/10.1145/3311350.3347171 · Good Game Feel: https://www.semanticscholar.org/paper/Good-Game-Feel:-An-Empirically-Grounded-Framework-Hicks-Dickinson/d9f363c5ad318e14e4c810ee88f61f1fcd97e385
- Kao et al. 2024, How does Juicy Game Feedback Motivate?: https://dl.acm.org/doi/10.1145/3613904.3642656 · https://people.csail.mit.edu/dkao/pdf/3613904.3642656.pdf
- Visual tactility ("oddly satisfying"): https://journals.sagepub.com/doi/10.1177/13548565221105196
- Discover, Why oddly satisfying videos are satisfying: https://www.discovermagazine.com/why-are-oddly-satisfying-videos-sosatisfying-218
- Barratt & Davis 2015, ASMR flow-like state: https://peerj.com/articles/851/
- Riley, Corkhill, Morris 2013, Knitting wellbeing: https://journals.sagepub.com/doi/10.4276/030802213X13603244419077
- PowerWash Simulator level design: https://80.lv/articles/level-design-of-powerwash-simulator

**Games (store pages)**
- Soap Cutting: https://apps.apple.com/us/app/soap-cutting/id1487932387 · https://play.google.com/store/apps/details?id=com.crazylabs.soap.cutting&hl=en_US
- ASMR Slicing: https://apps.apple.com/us/app/asmr-slicing/id1494458254
- Sheary Sheep: https://apps.apple.com/us/app/sheary-sheep/id1504388022
- Sheep Wool: https://play.google.com/store/apps/details?id=com.pc.sheep.wool&hl=en_US
- Tiny Sheep: https://apps.apple.com/us/app/tiny-sheep-pet-sim-on-a-farm/id488628767
- Shepherd (itch): https://alexjgriffith.itch.io/shepherd
- Knit Out: https://apps.apple.com/us/app/knit-out/id6740406762 · Wool Out 3D: https://apps.apple.com/us/app/wool-out-3d-knitting-games/id6468994631 · Yarn Loop: https://apps.apple.com/us/app/yarn-loop-knit-puzzle/id6755183085 · Knit Craft: https://apps.apple.com/us/app/knit-craft-unravel-match/id6762808373 · knitting-app review: https://wlsmakesstuff.com/blog-of-making-stuff/knitting-themed-mobile-apps
- Hairdresser Simulator: https://store.steampowered.com/app/1330560/Hairdresser_Simulator/ · Barber Shop Simulator: https://store.steampowered.com/app/3585060/Barber_Shop_Simulator/ · Lawn Mowing Simulator: https://store.steampowered.com/app/1480560/Lawn_Mowing_Simulator/

**Fur / hair rendering and simulation**
- Kajiya & Kay 1989: https://dl.acm.org/doi/10.1145/74334.74361
- Lengyel et al. 2001: https://hhoppe.com/proj/fur/ · https://dl.acm.org/doi/10.1145/364338.364407 · https://hhoppe.com/fur.pdf
- NVIDIA Fur Shells and Fins (SDK 10.5): https://developer.download.nvidia.com/SDK/10.5/direct3d/Source/Fur/doc/FurShellsAndFins.pdf
- Acerola, How Do Games Render Fur?: https://www.youtube.com/watch?v=9dr-tRQzij4
- tmpvar shell texturing: https://tmpvar.com/poc/shell-texturing/ · piellardj/fur-threejs: https://github.com/piellardj/fur-threejs · AEspinosaDev WebGL fur: https://github.com/AEspinosaDev/WebGL-RealTimeFur-SEDDI · three.js shells+fins video: https://www.youtube.com/watch?v=NnuN9WyShMo
- Unity-GrassAndFur: https://github.com/Propagant/Unity-GrassAndFur · jose-villegas FurRendering: https://github.com/jose-villegas/FurRendering
- Shadow of the Colossus breakdown: https://www.froyok.fr/blog/2012-10-breakdown-shadow-of-the-colossus-pal-ps2/
- Frostbite strand hair 2019: https://advances.realtimerendering.com/s2019/hair_presentation_final.pdf
- Hair Meshes rendering 2024: https://www.cemyuksel.com/research/hairmesh_rendering/ · https://www.youtube.com/watch?v=rv6e518-VjY
- HairWorks: https://docs.nvidia.com/gameworks/content/artisttools/hairworks/1_0/index.html · Witcher 3 GDC: https://gdcvault.com/play/1020664/The-Witcher-3-Enabling-Next
- TressFX: https://gpuopen.com/tressfx/ · https://github.com/GPUOpen-Effects/TressFX
- Müller, Kim, Chentanez 2012, FTL hair: https://matthias-research.github.io/pages/publications/FTLHairFur.pdf · https://www.youtube.com/watch?v=zB8Fqbfrrpo · https://github.com/derselbst/FurSimulation
- Sánchez-Banderas et al. 2015: https://diglib.eg.org/handle/10.2312/ceig20151194
- Herrera et al. 2024, Augmented Mass-Spring hair: https://arxiv.org/abs/2412.17144
- Digital Salon: https://digital-salon.github.io/ · https://arxiv.org/html/2507.07387v1
- Daviet 2023, ADMM hair: https://dl.acm.org/doi/10.1145/3588432.3591551 · https://blog.siggraph.org/2023/06/say-goodbye-to-split-ends-with-admm.html/
- ISALON: http://gamma.cs.unc.edu/ISALON/ · VR hairstyling: https://www.researchgate.net/publication/224643560_A_Simulation-based_VR_System_for_Interactive_Hairstyling
- Cutting survey (Wu et al. 2015): https://onlinelibrary.wiley.com/doi/10.1111/cgf.12528 · XFEM cutting: https://www.animation.rwth-aachen.de/publication/0551/
- Ghost of Tsushima grass: https://www.youtube.com/watch?v=Ibe1JBF5i5Y · https://gdcvault.com/play/1027033/Advanced-Graphics-Summit-Procedural-Grass
- Daniel Ilett, Six grass techniques: https://danielilett.com/2022-12-05-tut6-2-six-grass-techniques/

**Sheep, wool, spinning, felting**
- Te Ara, Shearing: https://teara.govt.nz/en/shearing/print
- Wikipedia, Sheep shearing: https://en.wikipedia.org/wiki/Sheep_shearing
- Fibershed, How sheep are sheared: https://fibershed.org/2019/07/19/choreography-and-skill-how-sheep-are-sheared/
- Exploring a fleece (outer vs cut side): https://cinereous.blogspot.com/2010/06/exploring-fleece-grading-and-sorting.html
- Wool measurement: https://en.wikipedia.org/wiki/Wool_measurement · George Weil, wool classification: https://www.georgeweil.com/blog/the-classification-of-wool-fibres-count-staple-length-crimp-and-lustre/
- Schacht drop spindle guide: https://schachtspindle.com/blogs/archives/a-beginners-guide-to-spinning-on-a-drop-spindle · Paradise Fibers park-and-draft: https://paradisefibers.com/blogs/all/the-park-and-draft-drop-spinning · Riley Wood & Fiber Art: https://rileywoodandfiberart.com/blogs/fiber-arts-guides/drop-spindle-spinning-beginners-guide
- Spinning (textiles): https://en.wikipedia.org/wiki/Spinning_(textiles) · Spindle: https://en.wikipedia.org/wiki/Spindle_(textiles)
- Yarn twist dynamics (Sci. Rep. 2016): https://www.nature.com/articles/srep24432
- Felt: https://en.wikipedia.org/wiki/Felt

**Audio**
- An, James, Marschner 2012, cloth sounds: https://www.cs.cornell.edu/projects/Sound/cloth/ · https://www.youtube.com/watch?v=56lq84Fx47g
- Cirio et al. 2016, Crumpling sound: http://www.cs.columbia.edu/cg/crumpling/crumpling-sound-synthesis-siggraph-asia-2016-cirio-et-al.pdf · https://www.youtube.com/watch?v=Gue12UjXd5U
- Schweickart, James, Marschner 2017, Rod sound: https://www.cs.cornell.edu/projects/rodsound/
- O'Brien et al. 2002, Rigid-body sounds: http://graphics.berkeley.edu/papers/Obrien-SSR-2002-07/Obrien-SSR-2002-07.pdf
- Sound synthesis survey: https://arxiv.org/pdf/2011.05538
- Farnell, Designing Sound: https://mitpress.mit.edu/9780262014410/designing-sound/
- Mains hum: https://en.wikipedia.org/wiki/Mains_hum · Wahl vibrator motor patent: https://www.freepatentsonline.com/5787587.html
- zya granular: https://zya.github.io/granular/ · https://github.com/zya/granular · granular-js: https://github.com/philippfromme/granular-js
- AudioWorklet support: https://caniuse.com/mdn-api_audioworklet
- AudioSession: https://developer.mozilla.org/docs/Web/API/AudioSession/type · https://github.com/w3c/audio-session/blob/main/explainer.md · unmute-ios-audio: https://github.com/feross/unmute-ios-audio

**Two Minute Papers:** see the §6 table (all IDs checked via oEmbed).
