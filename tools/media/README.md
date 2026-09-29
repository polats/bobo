# Media capture

Regenerates the toy GIFs and the README cover (`docs/media/`).

```sh
npx vite --config tools/media/vite.capture.config.mjs &   # serves the app on :5320
cd tools/media
node render-overlay.mjs        # title tile, labels and grid → overlay.png
node capture.mjs               # records every toy (or: node capture.mjs ink goo) → frames/
TOL=42 FPS=10 node encode.mjs  # → out/<toy>.gif, out/bobo-cover.gif, out/bobo-cover-still.jpg
```

- `capture.mjs` drives most toys with the shell's autoplay finger; Ink Swirl, Goo Lab, Laundry Line and Pull the Thread use scripted moves (see `scripts`).
- `encode.mjs` uses one palette per clip and redraws a pixel only once it drifts past `TOL`, which keeps the 1280×640 cover under ~8 MB.
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
