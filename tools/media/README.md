# Media capture

Regenerates the toy GIFs and the README cover (`docs/media/`).

```sh
npx vite --config tools/media/vite.capture.config.mjs &   # serves the app on :5320
cd tools/media
node render-overlay.mjs        # title tile, labels and grid → overlay.png
node capture.mjs               # records every toy (or: node capture.mjs ink goo) → frames/
TOL=42 FPS=10 node encode.mjs  # → out/<toy>.gif (240×320), out/bobo-cover.gif (1344×768, all 18), out/bobo-cover-still.jpg
TOL=42 node cover-latest.mjs   # → out/bobo-latest.gif (1200×640): what's new, the README's top image
TOL=36 node menu.mjs           # records a hub tour → out/bobo-menu.gif (300 px wide)
cp out/*.gif ../../docs/media/   # includes bobo-latest.gif and bobo-menu.gif && cp out/bobo-cover-still.jpg ../../docs/media/bobo-cover.jpg
```

- `capture.mjs` records every toy at 360×480 (the hub card's 3:4). Most toys use the shell's autoplay finger; Ink Swirl, Goo Lab, Laundry Line, Pull the Thread, Jelly Merge, Spool Sort and Dig Down use scripted moves (see `scripts`).
- `cover-latest.mjs` puts the newest and freshly upgraded toys in a 5×2 grid of 240×320 cells, with New/Updated chips and a one-line note from `overlay-latest.html`; edit both lists when the latest batch changes.
- `menu.mjs` scripts the hub (carousel, Updated row, a sheet's What's new, swipe-to-dismiss, the grid) at 390×844 and shares `gif.mjs` with the others.
- The cover is a 7×3 grid of 192×256 cells with the title tile across the first three; `overlay.html` draws the labels and grid lines from a list, and the toy order in `encode.mjs` must match it.
- `encode.mjs` uses one palette per clip and redraws a pixel only once it drifts past `TOL`, which keeps the 18-toy cover under ~8 MB.
- Needs Chrome (Playwright `channel: 'chrome'`) for WebGPU toys. `frames/` and `out/` are git-ignored.

## Hub previews

The hub's preview cards play 3 s H.264 loops from `src/previews/<toy>.mp4` with a `.webp` poster. To regenerate after a toy changes:

```sh
npx vite --config tools/media/vite.capture.config.mjs &   # :5320
cd tools/media
node capture.mjs <toy …>     # 360×480 recordings → frames/
node previews.mjs <toy …>    # WebCodecs H.264 via Mediabunny in headless Chrome → src/previews/
```

`previews.mjs` picks a 3 s window per toy (`START` table), crossfades the last 0.4 s into the start so the loop is seamless, and targets ~560 kbps (≈200 KB per clip). A toy without a preview falls back to its gradient and icon.
