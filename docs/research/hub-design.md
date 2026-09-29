# bobo hub redesign — research & recommendations (2026-09-29)

Scope: 16 physics toys (growing to ~30), 6 shelves (Fluids, Soft & squishy, Cloth & yarn, Sand & powder,
Smash & build, Make & reveal). Target: iPhone 13 mini (375×812 CSS px, DPR 3), 60fps, cheap on data.
Links marked ✓ were fetched and checked on 2026-09-29. Items marked *(obs.)* are observed product
patterns or practitioner knowledge, with no official doc behind them.

## 1. Summary of rules (apply these)

1. **Show the toy, not a description of it.** The preview loop *is* the card. Text on a card: **title only**
   (1 line, 15–17pt semibold), plus at most one tiny status pill ("New"). Blurb, technique, and WebGL2/WebGPU
   move to the detail sheet. NN/g: "the gist should always come before the minutiae."
2. **Type ramp = iOS Dynamic Type defaults**: Large Title 34/41, Title2 22/28 (section headers), Headline 17/22
   semibold (card title), Subhead 15/20, Footnote 13/18, Caption 12/16. **Never below 11pt**, and avoid light weights.
3. **Touch targets ≥ 44×44pt** (Apple default; 28pt absolute minimum). Android: 48×48dp. Leave about 12pt between
   bezelled controls and about 24pt around unbezelled ones.
4. **Safe areas**: pad with `env(safe-area-inset-*)`. Let the background run under the status bar and home
   indicator, and keep controls inside the safe area.
5. **Glass only on the chrome layer.** Blur/translucency ("Liquid Glass") goes on floating controls: sticky header
   on scroll, filter button, sheet. Never on cards. Apple: "Don't use Liquid Glass in the content layer… use sparingly."
6. **Segmented control ≤ 5 segments, and only for closely related views**, not top-level nav. Tab bar only for
   top-level sections, which bobo doesn't have (one screen), so **no tab bar**.
7. **Progressive disclosure, max 2 levels**: grid → sheet → toy. Sort and filter go behind one button.
8. **Motion previews**: muted H.264 MP4 loops, lazy-loaded, played only while visible, **≤ 4 playing at once**,
   poster first. Respect `prefers-reduced-motion` and a user "Autoplay previews" toggle, as App Store and Netflix both offer.
9. **Reserve space** with `aspect-ratio` so posters and videos never shift layout (CLS).
10. **Hero carousel ≤ 5 items, with a visible peek of the next item and no auto-advance** (NN/g).

## 2. HIG / Material 3 specifics

**Apple HIG (iOS 26, Liquid Glass era)**
- Materials ✓: Liquid Glass is "a distinct functional layer for controls and navigation" that floats above content.
  *Regular* variant (blurs, keeps text legible) suits sheets and bars. *Clear* variant suits controls over media and
  needs a ~35% dark dim layer if the content underneath is bright. Pair it with scroll-edge effects: content blurs/fades
  under the bar. Web approximation: `backdrop-filter: blur(20px) saturate(1.6)` plus a `rgba(20,20,28,.55)` fill,
  applied to 1–2 small, fixed elements only. `backdrop-filter` over autoplaying video costs GPU time on every frame,
  so keep the blurred area small.
- Layout ✓: order by importance (top/leading first). Group with negative space rather than boxes and separators.
  Extend backgrounds under bars.
- Typography ✓: the table in rule 2. Large Title (34 bold) collapses to an inline 17pt title on scroll.
- Accessibility ✓: 44×44pt default hit target, 28pt minimum. "Avoid autoplaying… video without discoverable controls,"
  offer a global opt-out of autoplay, support Reduce Motion (cross-fades instead of slides, no animating blurs), and
  support Dim Flashing Lights. That matters for fire/splash toys: avoid strobing frames in loops.
- Segmented controls ✓: ≤ ~5 segments on iPhone, noun labels in Title Case, equal widths, text or icons but not both.
- Tab bars ✓: navigation only, never actions. Keep them visible. Fill-style symbols.
- Sheets ✓: support **medium + large detents** with a grabber for progressive disclosure. Use them for simple, scoped tasks.
- SF Symbols ✓: **outline by default** (toolbars, lists, next to text), **fill for emphasis/selection**. Match the
  symbol's weight to adjacent text. Custom symbols should be simple and recognizable at small sizes.

**Material 3 / M3 Expressive (2025)**
- Expressive research ✓ (46 studies, 18k participants): users spotted key elements **up to 4× faster**. The levers are
  **color, shape, size, containment, motion**. The caveat is "no amount of expressive design will beat basic
  functionality": keep a familiar grid/list.
- Carousel ✓: four layouts. **Hero** (one large item plus a peek of the next, for featured content), **multi-browse**
  (large/medium/small), **uncontained** (fixed-width items flowing off the edge, text below), **full-screen** (vertical,
  portrait). Reference values are 16dp content padding and 8dp item spacing, with extra-large corners (28dp) on
  masked items.
- Chips ✓: *filter chips* are for refining content (toggle, check when selected). They belong near the content they
  filter and shouldn't be a permanent row of 7 when 16 items fit on about 3 screens.
- Touch target ✓: 48×48dp.
- Expressive motion *(obs.)*: spring-based "spatial" and "effects" motion. Press feedback is a quick scale to ~0.96
  that springs back, and shapes morph on selection.

**Web-specific**
- NN/g mobile UX ✓: small screens mean ruthless prioritization, and sessions are short (~72s on average), so the time
  from opening the app to playing a toy matters most.
- NN/g progressive disclosure ✓: at most 2 levels, with clear labels.
- Thumb zone *(obs., Hoober)*: the bottom-center of the screen is easiest to reach. Put the filter/sort trigger and the
  sheet's Play button low, and keep the top for the title and passive content.
- web.dev CLS ✓: set width/height or `aspect-ratio` on media.

## 3. Catalog app patterns *(obs., except where linked)*

| App | Pattern | Take for bobo? |
|---|---|---|
| App Store Today / Apple Arcade | Big editorial hero cards with autoplaying muted video, a tiny eyebrow label + title, tap to expand (card → full-screen detail transition). App previews autoplay muted and show a **poster frame** when autoplay is off ✓ | **Yes**: one hero for the newest toy |
| Netflix / Disney+ mobile | Hero at the top, then horizontal **shelves** of poster art with little or no text. Previews autoplay only in the hero/detail, and there is a user toggle "Autoplay previews" ✓ | Shelves are too sparse for 16 items (≈2–4 per shelf). Copy the toggle |
| TikTok / Reels | Full-screen vertical feed, one video playing at a time | No as the hub. Maybe later as a "Shuffle" mode |
| Google Play Games | Featured carousel plus rows. Video on the featured card only | Same as the hero idea |
| Apple TV app | "Up Next" row plus large artwork. Motion only on the focused item | Supports "only a few videos play at once" |
| Steam mobile / itch.io | Capsule image plus title, GIF/video on hover or detail. Heavy text, which bobo shouldn't copy | No |

Fit for 16–30 items: **a hero plus one 2-column grid of preview cards** beats shelves. Horizontal rows hide
items off-screen, and with 6 categories × 2–4 toys each row would look empty. Shelves start to pay off around 40+
items or 5+ per category. Long-press/peek is undiscoverable on the web (it conflicts with iOS's text-selection
callout), so use a plain tap → sheet and keep long-press optional.

## 4. Iconography

- **Line (SF Symbols–style) icons** work for *controls*: filter, close, play, share, papers. Use one stroke weight
  matched to the text (1.75–2px at 24px), round caps, 24px grid, `currentColor`. Keep bobo's existing line icons for UI chrome.
- **Filled** icons mark selected state (Material Symbols uses its FILL axis for this ✓; tab bars use fill ✓).
- **App-icon squircles / 3D "clay" icons** *(obs. trend)*: they look good in a launcher but cost art time per toy, and
  at 16+ toys they become just as generic as line icons.
- **A live preview makes a content icon unnecessary.** An icon tells you the category ("fluid"), while a 2-second loop
  shows the actual toy (ink blooming, goo stretching). Icons still help in three places: (a) the filter sheet's category
  rows, (b) reduced-motion/no-video fallback on the poster, (c) the tiny glyph in the sheet header.
- **Recommendation for bobo:** drop the per-tile 24px icon. Each card = **poster frame (a real snapshot of the toy) +
  muted loop**. Keep one line-icon set (6 category glyphs plus about 8 UI glyphs) drawn in SVG from the existing
  `icons.ts`, and use it only in chrome, filters and the sheet. For the app icon and hero art, consider a single
  squircle "bobo" mark.

## 5. Preview media & performance

**Formats (Safari/WKWebView first)**
| Format | Size for a 3s 360×480 loop | Decode | Safari iOS | Verdict |
|---|---|---|---|---|
| GIF | 1–4 MB | CPU, full-frame | yes | **Never.** web.dev ✓: GIF 3.7 MB → MP4 551 KB → WebM 341 KB |
| **MP4 H.264 (Main/High)** | 120–300 KB | **hardware** everywhere | yes | **Primary** |
| WebM VP9 | ~20–30% smaller | HW only on some devices | full since iOS 17.4 ✓ | Optional second `<source>` for Android/Chrome |
| WebM/MP4 AV1 | smallest | HW decode only on newest iPhones (A17 Pro+/M3) *(obs.)*, software on a 13 mini | yes | **Avoid on iOS** (battery, dropped frames) |
| Animated WebP/AVIF | between GIF and video | CPU, no HW | AVIF iOS 16+ ✓ | Avoid for loops. **Use static AVIF/WebP for posters** |

**Encoding target per toy**
- 3:4 portrait (matches the card), **360×480** (≈2× a 165pt card; DPR-3 sharpness isn't worth the bytes for motion).
  24 fps, 2.5–4s, **seamless loop**: pick frames where the sim returns to a similar state, or cross-fade the last 0.3s.
- H.264 **Main profile level 3.1 (`avc1.4d401f`)**, VBR ~500–700 kbps, keyframe every 1–2s, no audio track.
  `faststart`, i.e. moov atom before the data. Budget: **≤ 250 KB per loop** and a **≤ 25 KB poster** (AVIF/WebP from
  the first frame, JPEG fallback).
- Hero may be 540×720 at ≤ 450 KB.
- Whole hub at first paint: posters for the first screen (~8 × 20 KB) plus 1 hero video ≈ **≤ 600 KB**. Everything
  else lazy.

**Producing H.264 MP4 without ffmpeg (verified on this Mac)**
- This machine has **Google Chrome 154** (headless via Playwright `channel:'chrome'`). Probed on 2026-09-29:
  `VideoEncoder.isConfigSupported` → **`avc1.42001f` / `avc1.4d401f` / `avc1.640028` all supported (HW and SW)**,
  VP9/AV1 software only. `MediaRecorder.isTypeSupported('video/mp4;codecs=avc1.42E01E')` → **true**.
  Note that WebCodecs needs a secure context, so serve via `https`/`localhost` or `page.route` a fake https URL.
  `about:blank` has no `VideoEncoder`.
- **Recipe A (best quality, deterministic):** a capture page loads the toy with a fixed timestep and scripted pokes,
  draws each frame into a canvas, then does `new VideoFrame(canvas,{timestamp})` → `VideoEncoder`
  (`avc1.4d401f`, 360×480, `bitrate: 600_000`, `latencyMode:'quality'`, `avc:{format:'avc'}`) → **Mediabunny** ✓
  (MPL-2.0, successor to mp4-muxer) with `Mp4OutputFormat({fastStart:'in-memory'})` → write the file via Playwright.
  Frame-stepping (not real time) gives perfectly smooth loops even if the sim runs slowly.
- **Recipe B (quick):** `canvas.captureStream(24)` + `MediaRecorder({mimeType:'video/mp4;codecs=avc1.42E01E',
  videoBitsPerSecond:600_000})` in Chrome. Simpler, but it records in real time, so frames can drop and timing isn't
  exact.
- **Recipe C (macOS-native):** dump PNG frames, then assemble with a ~40-line Swift `AVAssetWriter` script (H.264/HEVC
  via VideoToolbox). `/usr/bin/avconvert` exists but only re-encodes AVFoundation-readable sources (mov/mp4), not webm.
- Avoid: **Playwright `recordVideo`** produces VP8 WebM of the whole page (not just the canvas), and the Playwright
  cache holds only a stripped VP8-only ffmpeg. Also note the Playwright-bundled Chromium/WebKit builds here are out of
  date (launch failed), and the open-source Chromium lacks proprietary codecs, so use `channel:'chrome'`.
- Posters: grab the chosen frame with `canvas.toBlob('image/webp', 0.8)` (Chrome encodes WebP; AVIF encoding isn't
  exposed by canvas). Pre-render in the same capture script.

**Markup**
```html
<video class="pv" muted playsinline loop preload="none" disablepictureinpicture
       poster="/pv/ink.webp" width="360" height="480" aria-hidden="true">
  <source data-src="/pv/ink.mp4" type='video/mp4; codecs="avc1.4d401f"'>
</video>
```
Set `muted` as both attribute and property (`v.muted = true`) before calling `play()`. Don't put `autoplay` in the HTML:
JS starts playback.

**Playback controller (one IntersectionObserver)**
- `rootMargin: '200px 0px'` with a load threshold > 0: set `src` and `load()` shortly before a video enters the
  viewport (web.dev lazy-video pattern ✓).
- A play threshold of 0.6: `play()` only when ≥ 60% visible, and `pause()` below that. WebKit already pauses
  offscreen autoplay video ✓, but pausing explicitly also covers WKWebView and Android.
- **Cap concurrent playing videos at 4** (hero + the ~3 most visible cards). Apple documents no hard decoder limit;
  4 × 360p H.264 is well within an A15's HW decoder, and above ~6 you see stutter/black frames on older iPhones
  *(obs.)*. When the cap is hit, pause the least visible video.
- Pause everything on `visibilitychange` hidden, while a toy is open (free the GPU for the sim), and while the
  sheet is open (except the sheet's own preview). When launching a toy, remove `src` + `load()` to release decoders.
- Fallback: `play()` returns a promise; on `NotAllowedError`, keep the poster and stop retrying. MDN ✓ also lists
  `navigator.getAutoplayPolicy('mediaelement')` (Firefox only for now). **iOS Low Power Mode** is widely reported to
  block muted autoplay in Safari (play() rejects). That isn't in Apple docs, so test it on a device. The poster fallback
  covers it either way.
- **Reduced motion** (`matchMedia('(prefers-reduced-motion: reduce)')` ✓, widely supported): show posters only and
  play the preview only inside the sheet on tap.
- **Data saving**: `navigator.connection?.saveData` and the `Save-Data` header ✓ are **not supported in Safari**, so on
  iOS rely on a user toggle ("Autoplay previews: On / Wi-Fi only / Off", stored in localStorage, like Netflix ✓ and the
  App Store ✓). On Chrome/Android also honor `saveData` and `effectiveType` of `2g`/`3g`.
- Don't render live WebGL toys inside tiles: each needs its own context (browsers cap active WebGL contexts at roughly
  16), and running them would compete with 60fps scrolling.
- Scrolling at 60fps: static cards (no per-frame JS), `contain: layout paint` on cards, and `will-change` only
  while pressed. No `backdrop-filter` on cards. Rounded-corner clipping via `overflow:hidden; border-radius` on the
  video wrapper is fine. Avoid box-shadows on moving elements.

## 6. Capacitor / WKWebView notes

- **iOS (verified in Capacitor source ✓ `CAPBridgeViewController.swift`):** Capacitor already sets
  `allowsInlineMediaPlayback = true`, `mediaTypesRequiringUserActionForPlayback = []`, `allowsAirPlayForMediaPlayback = true`.
  There is **no `capacitor.config.json` key** for these (config docs ✓ list none), and none is needed. Still set
  `playsinline` + `muted` so the same markup works in mobile Safari (web build) ✓.
- **Android (verified ✓ `Bridge.java`):** `setMediaPlaybackRequiresUserGesture(false)` is set by default.
- Bundle previews inside `dist/` (webDir) so the native app plays them offline with zero data cost. The web build
  serves the same files from Vercel with long cache headers (`Cache-Control: public, max-age=31536000, immutable`
  on hashed names).
- `ios.contentInset: "never"` (current config) means the page must handle `env(safe-area-inset-*)` itself. Keep
  `viewport-fit=cover`.
- Low Power Mode in WKWebView with an empty `mediaTypesRequiringUserActionForPlayback` hasn't been verified, so test
  on a device.

## 7. Recommended bobo hub design

**Structure (top → bottom)**
1. **Large title "bobo"** (34/41 bold, the existing gradient wordmark is fine at this size). Right-aligned, a 44pt round
   **filter button** (line "sliders" glyph, filled with a count badge when a filter is active). No lede, and no
   "16 toys · 3 new" line (or show it as 13pt secondary text under the title). On scroll, the title collapses into a
   sticky 44pt glass bar (regular glass, small blurred area) with "bobo" inline.
2. **Hero "New" carousel**: 1–3 newest toys (≤ 5 max). Full-width minus 16px gutters, 4:5 or 3:4, 28px radius,
   next card peeking 24px. Plays muted and doesn't auto-advance. Overlay: "NEW" eyebrow (11pt caps, 0.06em tracking)
   plus title (22pt bold) on a bottom gradient scrim, and a 44pt glass ▶ button bottom-right that launches directly.
   If only one toy is new, show a single hero card.
3. **Single 2-column grid of all toys** (gap 12px, 16px gutters → 165.5px cards on the 13 mini). Card = **3:4 preview**
   (poster → loop), 20px radius, and **title below the media** (15–17pt semibold, 1 line, ellipsis). A small "New" dot/pill
   sits on the media corner only for toys from the last 7 days. The title goes below rather than on top because it
   needs no scrim and reads more calmly; the M3 "uncontained" style puts text outside the media. That means no blurb,
   no tech label, and no WebGL2/WebGPU badge on cards. For toys that can't run (`needs-gpu`), dim the card and put
   "Needs WebGPU" in the sheet.
4. **Sort/filter sheet** (medium detent): a segmented control **Newest | A–Z | Shelf** (3 segments ✓), then 6 category
   rows with line glyphs and checkmarks (single-select, plus "All"). Replaces the permanent tabs and chip row. When
   filtered, show one dismissible input chip under the title ("Fluids ✕").
   - "Shelf" sort = the grid with 6 section headers (Title3 20pt, count in secondary), not horizontal rows.
   - Drop the date-grouped headers from the default view. The hero already carries "new".
5. Footer: the caps line (WebGPU/WebGL2/DPR) in 12pt tertiary text, or move it into the sheet as a diagnostics row.

**Tap behavior**: tap card → **bottom sheet** (medium detent, grabber). The sheet contains a larger playing preview
(16:10 or 1:1), title (22pt), a **1-line** blurb (15pt secondary, the existing blurb shortened to ≤ 60 chars), tiny
meta ("Stable Fluids · WebGL2", 13pt), a full-width 50pt **Play** button in the thumb zone, and a "Papers" link row.
- Offer a fast path too: the hero's ▶ button and a **double-tap / "Play" in the sheet**. Consider a setting "Open toys
  directly" later. Since most toys are self-explanatory once seen, the sheet mainly exists to hold text that used to
  crowd the cards, and to keep an accidental tap cheap.
- Transitions: card → sheet slides up with a spring (~350ms). Under reduced motion, use a 200ms cross-fade. The
  press state scales to 0.97 (already implemented).

**Visual system**: dark background `#07070b` with elevated card surface `#14141c` (the media fills the card, so the
per-toy
`--swatch` gradient only shows as the loading placeholder behind the poster). Text: primary `#f5f5f7`, secondary
at 60% alpha, tertiary at 38%. One accent for selection/Play. System font stack
(`-apple-system, system-ui`), weights 400/600/700 only.

**Performance budget**
| Item | Budget |
|---|---|
| Hub JS+CSS (excluding toys) | ≤ 30 KB gz, toys code-split |
| First screen media | ≤ 600 KB (8 posters ≤ 25 KB each + 1 hero ≤ 450 KB) |
| Per-card loop | ≤ 250 KB, 360×480, 24fps, 2.5–4s H.264 Main |
| Full catalog of 30 previews | ≤ 8 MB, bundled in the app, lazy on web |
| Simultaneously playing videos | ≤ 4 (≤ 1 under Low Power Mode fallback / reduced motion = 0) |
| Scroll | 60fps on 13 mini: no per-frame JS, no card backdrop-filter, IO-driven only |
| Time to first poster | < 1s on 4G. Posters `fetchpriority="high"` for the first 4 |

**Build step**: `tools/capture-previews.mjs` launches Playwright with `channel:'chrome'` and, for each toy, runs a
scripted interaction with a fixed timestep, then encodes with WebCodecs + Mediabunny → `public/pv/<id>.mp4`
+ `<id>.webp`. It fails the build if any file exceeds its budget. Re-run only for toys whose source changed.

## 8. References (✓ = fetched 2026-09-29)

- ✓ Apple HIG – Materials (Liquid Glass): https://developer.apple.com/design/human-interface-guidelines/materials
- ✓ Apple HIG – Typography (Dynamic Type sizes): https://developer.apple.com/design/human-interface-guidelines/typography
- ✓ Apple HIG – Layout: https://developer.apple.com/design/human-interface-guidelines/layout
- ✓ Apple HIG – Accessibility (44pt, autoplay, Reduce Motion): https://developer.apple.com/design/human-interface-guidelines/accessibility
- ✓ Apple HIG – Tab bars: https://developer.apple.com/design/human-interface-guidelines/tab-bars
- ✓ Apple HIG – Segmented controls: https://developer.apple.com/design/human-interface-guidelines/segmented-controls
- ✓ Apple HIG – Sheets: https://developer.apple.com/design/human-interface-guidelines/sheets
- ✓ Apple HIG – SF Symbols: https://developer.apple.com/design/human-interface-guidelines/sf-symbols
- ✓ App Store app previews (muted autoplay, poster frame): https://developer.apple.com/app-store/app-previews/
- ✓ M3 Expressive research (Google Design): https://design.google/library/expressive-material-design-google-research
- ✓ M3 carousel (Compose): https://developer.android.com/develop/ui/compose/components/carousel
- ✓ M3 carousel (MDC Android): https://github.com/material-components/material-components-android/blob/master/docs/components/Carousel.md
- ✓ M3 chips (Compose): https://developer.android.com/develop/ui/compose/components/chip
- M3 carousel spec (JS-rendered, not text-fetchable): https://m3.material.io/components/carousel/guidelines
- ✓ Android touch targets 48dp: https://developer.android.com/guide/topics/ui/accessibility/apps
- ✓ Material Symbols axes: https://developers.google.com/fonts/docs/material_symbols
- ✓ NN/g Mobile UX: https://www.nngroup.com/articles/mobile-ux/
- ✓ NN/g Progressive disclosure: https://www.nngroup.com/articles/progressive-disclosure/
- ✓ NN/g Designing effective carousels: https://www.nngroup.com/articles/designing-effective-carousels/
- ✓ web.dev Replace GIFs with video: https://web.dev/articles/replace-gifs-with-videos
- ✓ web.dev Lazy-loading video: https://web.dev/articles/lazy-loading-video
- ✓ web.dev CLS: https://web.dev/articles/optimize-cls
- ✓ WebKit – New video policies for iOS: https://webkit.org/blog/6784/new-video-policies-for-ios/
- ✓ MDN Autoplay guide: https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Autoplay
- ✓ MDN prefers-reduced-motion: https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/At-rules/@media/prefers-reduced-motion
- ✓ MDN Save-Data (no Safari): https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Save-Data
- ✓ MDN VideoEncoder.isConfigSupported: https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder/isConfigSupported_static
- ✓ MDN VideoEncoder.configure: https://developer.mozilla.org/en-US/docs/Web/API/VideoEncoder/configure
- ✓ Mediabunny (MP4/WebM muxing, MPL-2.0): https://mediabunny.dev/
- ✓ caniuse AVIF: https://caniuse.com/avif · ✓ caniuse WebM: https://caniuse.com/webm
- ✓ Capacitor config: https://capacitorjs.com/docs/config
- ✓ Capacitor iOS WKWebView config: https://github.com/ionic-team/capacitor/blob/main/ios/Capacitor/Capacitor/CAPBridgeViewController.swift
- ✓ Capacitor Android WebView config: https://github.com/ionic-team/capacitor/blob/main/android/capacitor/src/main/java/com/getcapacitor/Bridge.java
- ✓ Playwright videos: https://playwright.dev/docs/videos
- ✓ Netflix autoplay previews toggle: https://help.netflix.com/en/node/2102
