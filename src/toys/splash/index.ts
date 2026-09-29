import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import commonSrc from './common.wgsl?raw';
import simSrc from './sim.wgsl?raw';
import renderSrc from './render.wgsl?raw';
import { invert, lookAt, multiply, perspective, rotateAround, transformPoint, type Mat4 } from './mat4';

// Particle layout (80 bytes) mirrors `Particle` in common.wgsl.
const CAPACITY = 120_000;
const STRIDE = 80;
const PARAM_BYTES = 800;
const MAX_POINTERS = 4;
const MAX_BALLS = 4;
const FOV = (38 * Math.PI) / 180;

export const splashToy: Toy = {
  id: 'splash',
  title: 'Splash Tank',
  blurb: 'A glass tank of water in your phone. Tilt it, shake it, poke it, drop beach balls in.',
  tech: 'WebGPU · 3D MLS-MPM · SSFR',
  swatch: 'linear-gradient(150deg,#3fd2ff,#1f5bff 55%,#ff6b6b)',
  refs: [
    {
      short: 'Hu 2018',
      title: 'Hu et al. — MLS-MPM (SIGGRAPH 2018)',
      url: 'https://yuanming.taichi.graphics/publication/2018-mlsmpm/',
      use: 'The solver: 3D moving-least-squares MPM water with APIC transfers.',
    },
    {
      short: 'van der Laan 2009',
      title: 'van der Laan, Green & Sainz — Screen Space Fluid Rendering with Curvature Flow (I3D 2009)',
      url: 'https://dl.acm.org/doi/10.1145/1507149.1507164',
      use: 'The look: sphere depth, smoothed depth → normals, thickness-based absorption.',
    },
    {
      short: 'WebGPU-Ocean',
      title: 'matsuoka-601 — WebGPU-Ocean',
      url: 'https://github.com/matsuoka-601/webgpu-ocean',
      use: 'Browser reference for MLS-MPM on WebGPU (fixed-point atomic P2G) with SSFR.',
    },
    {
      short: 'Codrops',
      title: 'Codrops — WebGPU Fluid Simulations: High Performance & Real-Time Rendering',
      url: 'https://tympanus.net/codrops/2025/02/26/webgpu-fluid-simulations-high-performance-real-time-rendering/',
      use: 'Practical SSFR tricks: bilateral depth filter, thickness, half-res targets.',
    },
  ],
  create,
};

interface Ball {
  pos: [number, number, number];
  vel: [number, number, number];
  r: number;
  spin: number;
  seed: number;
  /** Was the ball touching water last frame (so entering it can splash once). */
  wet: boolean;
}

interface Grab {
  mode: 'push' | 'tilt';
  pos: [number, number, number];
  prev: [number, number, number];
  vel: [number, number, number];
}

async function create(ctx: ToyContext): Promise<ToyInstance> {
  if (!navigator.gpu) {
    throw new Error('Splash Tank needs WebGPU, which this browser does not expose. Try Safari on iOS 26+ or desktop Chrome.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available on this device.');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => console.error('[splash] WebGPU:', (e as GPUUncapturedErrorEvent).error.message));

  const context = ctx.canvas.getContext('webgpu');
  if (!context) throw new Error('Could not create a WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const s = {
    resolution: 24,
    level: 0.4,
    maxParticles: 40000,
    substeps: 6,
    gravity: 260,
    stiffness: 1,
    viscosity: 0.15,
    size: 1,
    smoothing: 4,
    absorb: 0.09,
    foam: 45,
    quality: 0.75,
    pokeSize: 3.2,
    shake: 1.4,
    bulk: 0.5,
    affine: 0.75,
  };

  // ---------------------------------------------------------------- GPU resources

  const paramBuf = device.createBuffer({ size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const particleBuf = device.createBuffer({ size: CAPACITY * STRIDE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const paramData = new ArrayBuffer(PARAM_BYTES);
  const pf = new Float32Array(paramData);
  const pu = new Uint32Array(paramData);

  const simModule = device.createShaderModule({ label: 'splash-sim', code: commonSrc + simSrc });
  const renderModule = device.createShaderModule({ label: 'splash-render', code: commonSrc + renderSrc });

  const simLayout = device.createBindGroupLayout({
    entries: [0, 1, 2, 3, 4].map((binding) => ({
      binding,
      visibility: GPUShaderStage.COMPUTE,
      buffer: { type: binding === 0 ? ('uniform' as const) : ('storage' as const) },
    })),
  });
  const simPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [simLayout] });
  const computePipeline = (entryPoint: string) =>
    device.createComputePipeline({ layout: simPipelineLayout, compute: { module: simModule, entryPoint } });
  const p2gMassPipe = computePipeline('p2gMass');
  const p2gStressPipe = computePipeline('p2gStress');
  const gridPipe = computePipeline('gridUpdate');
  const g2pPipe = computePipeline('g2p');
  const columnsPipe = computePipeline('surfaceColumns');

  const depthPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: renderModule, entryPoint: 'spriteVS' },
    fragment: { module: renderModule, entryPoint: 'depthFS', targets: [{ format: 'r32float' }] },
    primitive: { topology: 'triangle-strip' },
    depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less' },
  });
  const additive: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  };
  const thickPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: renderModule, entryPoint: 'spriteVS' },
    fragment: { module: renderModule, entryPoint: 'thickFS', targets: [{ format: 'rg16float', blend: additive }] },
    primitive: { topology: 'triangle-strip' },
  });
  const blurPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: renderModule, entryPoint: 'quadVS' },
    fragment: { module: renderModule, entryPoint: 'blurFS', targets: [{ format: 'r32float' }] },
  });
  const compositePipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: renderModule, entryPoint: 'quadVS' },
    fragment: { module: renderModule, entryPoint: 'compositeFS', targets: [{ format }] },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear' });
  const blurDirBufs = [
    [1, 0],
    [0, 1],
    [1, 0],
    [0, 1],
  ].map(([x, y]) => {
    const b = device.createBuffer({ size: 16, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
    device.queue.writeBuffer(b, 0, new Float32Array([x, y, 0, 0]));
    return b;
  });

  const spriteBindGroup = (pipe: GPURenderPipeline) =>
    device.createBindGroup({
      layout: pipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramBuf } },
        { binding: 1, resource: { buffer: particleBuf } },
      ],
    });
  const depthBind = spriteBindGroup(depthPipe);
  const thickBind = spriteBindGroup(thickPipe);

  // ---------------------------------------------------------------- domain

  let gx = 0;
  let gy = 0;
  let gz = 0;
  let gridAtomic: GPUBuffer | null = null;
  let gridV: GPUBuffer | null = null;
  let columnsBuf: GPUBuffer | null = null;
  let readback: GPUBuffer[] = [];
  let readbackBusy: boolean[] = [];
  let simBindGroup: GPUBindGroup | null = null;
  let columns = new Float32Array(0);
  let columnsFresh = false;
  let count = 0;
  let canvasW = ctx.canvas.width;
  let canvasH = ctx.canvas.height;
  let domainAspect = canvasW / canvasH;

  function buildDomain() {
    gridAtomic?.destroy();
    gridV?.destroy();
    columnsBuf?.destroy();
    readback.forEach((b) => b.destroy());
    const aspect = canvasW / canvasH;
    domainAspect = aspect;
    const n = s.resolution;
    const longSide = Math.round(n * Math.min(2, Math.max(1, (aspect < 1 ? 1 / aspect : aspect) * 0.85)));
    gx = aspect < 1 ? n : longSide;
    gy = aspect < 1 ? longSide : n;
    gz = Math.max(10, Math.round(n * 0.6));
    const nodes = gx * gy * gz;
    gridAtomic = device.createBuffer({ size: nodes * 16, usage: GPUBufferUsage.STORAGE });
    gridV = device.createBuffer({ size: nodes * 16, usage: GPUBufferUsage.STORAGE });
    columnsBuf = device.createBuffer({ size: gx * gz * 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
    readback = [0, 1].map(() => device.createBuffer({ size: gx * gz * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }));
    readbackBusy = [false, false];
    columns = new Float32Array(gx * gz * 4).fill(-1);
    columnsFresh = false;
    simBindGroup = device.createBindGroup({
      layout: simLayout,
      entries: [
        { binding: 0, resource: { buffer: paramBuf } },
        { binding: 1, resource: { buffer: particleBuf } },
        { binding: 2, resource: { buffer: gridAtomic } },
        { binding: 3, resource: { buffer: gridV } },
        { binding: 4, resource: { buffer: columnsBuf } },
      ],
    });
    buildCamera();
  }

  const tankMin: [number, number, number] = [2, 2, 2];
  const tankMax = (): [number, number, number] => [gx - 2, gy - 2, gz - 2];

  /** Fill the bottom of the tank with water at 8 particles per cell (2x2x2, jittered). */
  function resetWater() {
    const [x1, y1, z1] = tankMax();
    const ix = x1 - 2;
    const iz = z1 - 2;
    const iy = y1 - 2;
    const fromLevel = Math.round(iy * s.level);
    const fromBudget = Math.floor(Math.min(s.maxParticles, CAPACITY) / (8 * ix * iz));
    const h = Math.max(1, Math.min(fromLevel, fromBudget));
    count = ix * h * iz * 8;
    const data = new Float32Array(count * (STRIDE / 4));
    let k = 0;
    for (let z = 0; z < iz * 2; z++)
      for (let y = 0; y < h * 2; y++)
        for (let x = 0; x < ix * 2; x++) {
          const o = k * (STRIDE / 4);
          data[o] = 2 + (x + 0.25 + Math.random() * 0.5) * 0.5;
          data[o + 1] = 2 + (y + 0.25 + Math.random() * 0.5) * 0.5;
          data[o + 2] = 2 + (z + 0.25 + Math.random() * 0.5) * 0.5;
          k++;
        }
    device.queue.writeBuffer(particleBuf, 0, data);
  }

  // ---------------------------------------------------------------- render targets

  let depthTex: GPUTexture | null = null;
  let zbuf: GPUTexture | null = null;
  let blurTex: GPUTexture | null = null;
  let thickTex: GPUTexture | null = null;
  let blurBinds: GPUBindGroup[] = [];
  let compositeBind: GPUBindGroup | null = null;
  let fluidW = 1;
  let fluidH = 1;

  function buildTargets() {
    [depthTex, zbuf, blurTex, thickTex].forEach((t) => t?.destroy());
    fluidW = Math.max(1, Math.round(canvasW * s.quality));
    fluidH = Math.max(1, Math.round(canvasH * s.quality));
    const usage = GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING;
    depthTex = device.createTexture({ size: [fluidW, fluidH], format: 'r32float', usage });
    blurTex = device.createTexture({ size: [fluidW, fluidH], format: 'r32float', usage });
    zbuf = device.createTexture({ size: [fluidW, fluidH], format: 'depth32float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    thickTex = device.createTexture({ size: [fluidW, fluidH], format: 'rg16float', usage });
    const blurBind = (src: GPUTexture, dir: GPUBuffer) =>
      device.createBindGroup({
        layout: blurPipe.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: paramBuf } },
          { binding: 2, resource: src.createView() },
          { binding: 6, resource: { buffer: dir } },
        ],
      });
    // depth -> blur (x) -> depth (y) -> blur (x) -> depth (y): two rounds, result in depthTex.
    blurBinds = [blurBind(depthTex, blurDirBufs[0]), blurBind(blurTex, blurDirBufs[1])];
    compositeBind = device.createBindGroup({
      layout: compositePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramBuf } },
        { binding: 3, resource: depthTex.createView() },
        { binding: 4, resource: thickTex.createView() },
        { binding: 5, resource: sampler },
      ],
    });
  }

  // ---------------------------------------------------------------- camera

  let viewBase: Mat4 = lookAt([0, 0, 1], [0, 0, 0], [0, 1, 0]);
  let proj: Mat4 = perspective(FOV, 1, 1, 400);
  let view: Mat4 = viewBase;
  let invView: Mat4 = invert(view);
  let invProj: Mat4 = invert(proj);
  let camPos: [number, number, number] = [0, 0, 0];
  let center: [number, number, number] = [0, 0, 0];

  function buildCamera() {
    const aspect = canvasW / canvasH;
    center = [gx / 2, gy / 2 - 1, gz / 2];
    const tanY = Math.tan(FOV / 2);
    // Fit the tank with room for the HUD at the top and the ball button at the bottom.
    const fitH = (gy * 0.5 * 1.28) / tanY;
    const fitW = (gx * 0.5 * 1.18) / (tanY * aspect);
    const dist = Math.max(fitH, fitW) + gz * 0.5;
    const eye: [number, number, number] = [center[0], center[1] + dist * 0.2, center[2] + dist];
    viewBase = lookAt(eye, [center[0], center[1] - gy * 0.04, center[2]], [0, 1, 0]);
    proj = perspective(FOV, aspect, 1, dist * 4);
    invProj = invert(proj);
  }

  function updateView() {
    // Drag-tilt rotates the tank on screen about its centre (roll) and a little towards you (pitch).
    const model = rotateAround(center, tiltRoll, tiltPitch);
    view = multiply(viewBase, model);
    invView = invert(view);
    camPos = transformPoint(invView, [0, 0, 0]);
  }

  // ---------------------------------------------------------------- tilt & shake

  let tiltRoll = 0;
  let tiltRollV = 0;
  let tiltPitch = 0;
  let tiltPitchV = 0;
  let motion: [number, number, number] | null = null;
  let motionLow: [number, number, number] | null = null;
  let motionSeen = false;
  let splashKick = 0;
  let splashDir: [number, number, number] = [0, 1, 0];
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null || a.z == null) return;
    // Device frame: x right, y up the screen, z out of it. iOS reports gravity as it points;
    // other platforms report the reaction force, so flip.
    const sign = isIOS ? 1 : -1;
    let x = (a.x * sign) / 9.81;
    let y = (a.y * sign) / 9.81;
    const z = (a.z * sign) / 9.81;
    const angle = (screen.orientation?.angle ?? (window as unknown as { orientation?: number }).orientation ?? 0) as number;
    const r = (-angle * Math.PI) / 180;
    [x, y] = [x * Math.cos(r) - y * Math.sin(r), x * Math.sin(r) + y * Math.cos(r)];
    motion = [x, y, z];
    if (!motionLow) motionLow = [x, y, z];
    motionSeen = true;
    hideTiltButton();
  };

  let tiltButton: HTMLButtonElement | null = null;
  function hideTiltButton() {
    tiltButton?.remove();
    tiltButton = null;
  }
  const DME = typeof DeviceMotionEvent !== 'undefined' ? (DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> }) : null;
  const touchDevice = navigator.maxTouchPoints > 0;
  if (DME && typeof DME.requestPermission === 'function' && touchDevice) {
    tiltButton = document.createElement('button');
    tiltButton.type = 'button';
    tiltButton.className = 'hud-btn';
    tiltButton.textContent = 'Enable tilt';
    Object.assign(tiltButton.style, { left: '50%', transform: 'translateX(-50%)', top: 'calc(96px + var(--safe-top))' });
    tiltButton.addEventListener('click', async () => {
      try {
        const res = await DME.requestPermission!();
        if (res === 'granted') {
          addEventListener('devicemotion', onMotion);
          if (tiltButton) tiltButton.textContent = 'Tilt your phone';
          setTimeout(() => !motionSeen && hideTiltButton(), 2500);
        } else if (tiltButton) {
          tiltButton.textContent = 'Tilt blocked · drag to tilt';
          setTimeout(hideTiltButton, 2500);
        }
      } catch {
        if (tiltButton) tiltButton.textContent = 'Drag empty space to tilt';
        setTimeout(hideTiltButton, 2500);
      }
    });
    ctx.overlay.appendChild(tiltButton);
  } else if (touchDevice) {
    addEventListener('devicemotion', onMotion);
  }

  // ---------------------------------------------------------------- balls & input UI

  const balls: Ball[] = [];
  function dropBall() {
    const [x1, y1, z1] = tankMax();
    const r = Math.max(1.6, s.resolution * 0.1);
    if (balls.length >= MAX_BALLS) balls.shift();
    balls.push({
      pos: [2 + r + Math.random() * (x1 - 2 - 2 * r), y1 - r - 0.5, 2 + r + Math.random() * (z1 - 2 - 2 * r)],
      vel: [(Math.random() - 0.5) * 10, -30, 0],
      r,
      spin: Math.random() * 6,
      seed: Math.floor(Math.random() * 6),
      wet: false,
    });
    ctx.haptic('light');
    ctx.sound.play('whoosh', { pitch: 1.3, gain: 0.25, pan: panX(balls[balls.length - 1].pos[0]) });
  }

  const dock = document.createElement('div');
  dock.className = 'dock';
  const mkButton = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.addEventListener('click', fn);
    dock.appendChild(b);
  };
  mkButton('🏐 Drop ball', dropBall);
  mkButton('💥 Splash', () => bigSplash());
  ctx.overlay.appendChild(dock);

  function bigSplash() {
    const a = Math.random() * Math.PI * 2;
    splashDir = [Math.cos(a) * 0.8, 1.6, Math.sin(a) * 0.5];
    splashKick = 0.14;
    ctx.haptic('heavy');
    ctx.sound.play('splash', { pitch: 0.7, gain: 1 });
    ctx.sound.play('whoosh', { pitch: 0.6, gain: 0.4 });
    slosh = 1;
  }

  // ---------------------------------------------------------------- panel

  const p = ctx.panel;
  p.heading('Water');
  p.slider(s, 'gravity', { label: 'Gravity', min: 40, max: 600, step: 5 });
  p.slider(s, 'viscosity', { label: 'Thickness (viscosity)', min: 0, max: 1, step: 0.01 });
  p.slider(s, 'stiffness', { label: 'Incompressibility', min: 0.3, max: 1.6, step: 0.05 });
  p.slider(s, 'affine', { label: 'Liveliness (APIC kept)', min: 0.4, max: 1, step: 0.01 });
  p.slider(s, 'substeps', { label: 'Substeps', min: 3, max: 12, step: 1 });
  p.slider(s, 'shake', { label: 'Shake response', min: 0, max: 4, step: 0.1 });
  p.slider(s, 'pokeSize', { label: 'Finger size', min: 1.5, max: 6, step: 0.1 });
  p.slider(s, 'level', { label: 'Water level', min: 0.15, max: 0.7, step: 0.01, onChange: () => resetWater() });
  p.heading('Look');
  p.slider(s, 'smoothing', { label: 'Surface smoothing', min: 0, max: 8, step: 0.1 });
  p.slider(s, 'size', { label: 'Droplet size', min: 0.6, max: 1.8, step: 0.05 });
  p.slider(s, 'absorb', { label: 'Water tint', min: 0, max: 0.3, step: 0.005 });
  p.slider(s, 'foam', { label: 'Foam threshold', min: 8, max: 80, step: 1 });
  p.choice(
    'Render quality',
    [
      { value: '0.5', label: 'Fast' },
      { value: '0.75', label: 'Sharp' },
      { value: '1', label: 'Full' },
    ],
    String(s.quality),
    (v) => {
      s.quality = Number(v);
      buildTargets();
    },
  );
  p.heading('Budget');
  p.slider(s, 'maxParticles', { label: 'Max particles', min: 5000, max: CAPACITY, step: 1000, onChange: () => resetWater() });
  p.choice(
    'Grid resolution',
    [20, 24, 32, 40].map((v) => ({ value: String(v), label: String(v) })),
    String(s.resolution),
    (v) => {
      s.resolution = Number(v);
      buildDomain();
      resetWater();
      balls.length = 0;
    },
  );
  p.action('Reset water', () => {
    resetWater();
    balls.length = 0;
  });
  p.action('Big splash', bigSplash);

  // ---------------------------------------------------------------- input

  const grabs = new Map<number, Grab>();

  function pointerRay(x: number, y: number) {
    const ndc = [x * 2 - 1, y * 2 - 1];
    const near = transformPoint(invView, transformPoint(invProj, [ndc[0], ndc[1], 0]));
    const far = transformPoint(invView, transformPoint(invProj, [ndc[0], ndc[1], 1]));
    const d = [far[0] - near[0], far[1] - near[1], far[2] - near[2]];
    const len = Math.hypot(d[0], d[1], d[2]);
    return { o: near, d: [d[0] / len, d[1] / len, d[2] / len] as [number, number, number] };
  }

  /** Where a finger ray crosses the tank's middle plane, clamped inside the tank. */
  function fingerPoint(x: number, y: number): [number, number, number] {
    const { o, d } = pointerRay(x, y);
    const zc = gz / 2;
    const t = Math.abs(d[2]) > 1e-5 ? (zc - o[2]) / d[2] : 0;
    const [x1, y1, z1] = tankMax();
    return [clamp(o[0] + d[0] * t, 2, x1), clamp(o[1] + d[1] * t, 2, y1 + 6), clamp(zc, 2, z1)];
  }

  function surfaceAt(x: number, z: number, spread = 1) {
    if (!columnsFresh) return Infinity;
    const cx = clamp(Math.round(x), 0, gx - 1);
    const cz = clamp(Math.round(z), 0, gz - 1);
    // The surface under the point, or its neighbours if the column is mid-splash.
    let h = -1;
    for (let dz = -spread; dz <= spread; dz++)
      for (let dx = -spread; dx <= spread; dx++) {
        const ix = clamp(cx + dx, 0, gx - 1);
        const iz = clamp(cz + dz, 0, gz - 1);
        h = Math.max(h, columns[(iz * gx + ix) * 4]);
      }
    return h;
  }

  function handleInput(dt: number) {
    const aspect = canvasW / canvasH;
    for (const ptr of ctx.pointers.active.values()) {
      let g = grabs.get(ptr.id);
      const hit = fingerPoint(ptr.x, ptr.y);
      if (!g || ptr.justDown) {
        const wet = hit[1] <= surfaceAt(hit[0], hit[2]) + 2.5;
        g = { mode: wet ? 'push' : 'tilt', pos: hit, prev: hit, vel: [0, 0, 0] };
        grabs.set(ptr.id, g);
        if (wet) {
          ctx.haptic('light');
          ctx.sound.play('plop', { pitch: 0.9, gain: 0.4, pan: panX(hit[0]) });
        }
      }
      if (g.mode === 'push') {
        g.prev = g.pos;
        g.pos = hit;
        const k = 1 / Math.max(dt, 1 / 120);
        const v: [number, number, number] = [(hit[0] - g.prev[0]) * k, (hit[1] - g.prev[1]) * k, 0];
        const sp = Math.hypot(v[0], v[1]);
        const vmax = 120;
        g.vel = sp > vmax ? [(v[0] * vmax) / sp, (v[1] * vmax) / sp, 0] : v;
        churn = Math.max(churn, Math.min(sp, vmax) / vmax);
      } else {
        // Tilt the tank like a snow globe: sideways drag rolls it, vertical drag pitches it.
        tiltRoll = clamp(tiltRoll - ptr.dx * aspect * 2.4, -0.55, 0.55);
        tiltPitch = clamp(tiltPitch + ptr.dy * 1.6, -0.35, 0.35);
        tiltRollV = 0;
        tiltPitchV = 0;
      }
    }
    for (const id of grabs.keys()) if (!ctx.pointers.active.has(id)) grabs.delete(id);
    // Released tilt springs back upright with a little overshoot, which sloshes the water.
    const tilting = [...grabs.values()].some((g) => g.mode === 'tilt');
    if (!tilting) {
      tiltRollV += (-tiltRoll * 40 - tiltRollV * 5) * dt;
      tiltPitchV += (-tiltPitch * 40 - tiltPitchV * 5) * dt;
      tiltRoll += tiltRollV * dt;
      tiltPitch += tiltPitchV * dt;
    }
  }

  function gravityVector(dt: number): [number, number, number] {
    let g: [number, number, number] = [0, -1, 0];
    if (motion && motionLow) {
      // Low-passed gravity sets "down"; the high-passed remainder is shake.
      const k = 1 - Math.exp(-dt * 6);
      motionLow = [motionLow[0] + (motion[0] - motionLow[0]) * k, motionLow[1] + (motion[1] - motionLow[1]) * k, motionLow[2] + (motion[2] - motionLow[2]) * k];
      const shake = [motion[0] - motionLow[0], motion[1] - motionLow[1], motion[2] - motionLow[2]];
      const len = Math.hypot(...motionLow) || 1;
      g = [motionLow[0] / len + shake[0] * s.shake, motionLow[1] / len + shake[1] * s.shake, motionLow[2] / len + shake[2] * s.shake];
      const jolt = Math.hypot(...shake);
      if (jolt > 0.8) {
        ctx.haptic('light');
        if (sloshCool <= 0) {
          sloshCool = 0.25;
          ctx.sound.play('splash', { gain: Math.min(0.8, jolt * 0.4), pan: clamp(shake[0], -1, 1) * 0.6 });
        }
      }
    }
    // Screen-down seen through the tank's current tilt.
    const cr = Math.cos(tiltRoll);
    const sr = Math.sin(tiltRoll);
    const cp = Math.cos(tiltPitch);
    const sp = Math.sin(tiltPitch);
    // Inverse of R = Rz(roll) * Rx(pitch) applied to g.
    let x = cr * g[0] + sr * g[1];
    let y = -sr * g[0] + cr * g[1];
    let z = g[2];
    [y, z] = [cp * y + sp * z, -sp * y + cp * z];
    if (splashKick > 0) {
      splashKick -= dt;
      x += splashDir[0] * 2.5;
      y += splashDir[1] * 2.5;
      z += splashDir[2] * 2.5;
    }
    return [x * s.gravity, y * s.gravity, z * s.gravity];
  }

  function updateBalls(dt: number, g: [number, number, number]) {
    const [x1, y1, z1] = tankMax();
    for (const b of balls) {
      // The ball pushes water out of its own column, so read the surface on a ring around it.
      let surface = 0;
      let wetN = 0;
      const wv = [0, 0, 0];
      if (columnsFresh) {
        const ring = b.r + 1.5;
        for (let k = 0; k < 8; k++) {
          const a = (k / 8) * Math.PI * 2;
          const cx = clamp(Math.round(b.pos[0] + Math.cos(a) * ring), 2, gx - 3);
          const cz = clamp(Math.round(b.pos[2] + Math.sin(a) * ring), 2, gz - 3);
          const o = (cz * gx + cx) * 4;
          if (columns[o] < 0) continue;
          surface += columns[o];
          for (let i = 0; i < 3; i++) wv[i] += columns[o + 1 + i];
          wetN++;
        }
        if (wetN) {
          surface /= wetN;
          for (let i = 0; i < 3; i++) wv[i] /= wetN;
        }
      }
      const sub = wetN ? clamp((surface - (b.pos[1] - b.r)) / (2 * b.r), 0, 1) : 0;
      // Hitting the water: splash scaled by how fast the ball was coming down.
      if (sub > 0 && !b.wet && b.vel[1] < -8) {
        const hit = Math.min(1, -b.vel[1] / 60);
        ctx.sound.play('splash', { pitch: 1.3 - hit * 0.5, gain: 0.3 + hit * 0.6, pan: panX(b.pos[0]) });
        if (hit > 0.4) ctx.haptic('medium');
      }
      b.wet = sub > 0;
      // Light ball: buoyancy up to 2.5x its weight, dragged along by the water it sits in.
      const buoy = 1 - sub * 2.5;
      for (let i = 0; i < 3; i++) {
        b.vel[i] += g[i] * buoy * dt;
        b.vel[i] += (wv[i] - b.vel[i]) * Math.min(1, sub * 5 * dt);
        b.vel[i] *= 1 - Math.min(1, sub * 1.2 * dt);
      }
      for (let i = 0; i < 3; i++) b.pos[i] += b.vel[i] * dt;
      const lo = 2 + b.r;
      const hi = [x1 - b.r, y1 + 4 - b.r, z1 - b.r];
      let knock = 0;
      for (let i = 0; i < 3; i++) {
        if (b.pos[i] < lo) { knock = Math.max(knock, -b.vel[i]); b.pos[i] = lo; b.vel[i] = Math.abs(b.vel[i]) * 0.4; }
        if (b.pos[i] > hi[i]) { knock = Math.max(knock, b.vel[i]); b.pos[i] = hi[i]; b.vel[i] = -Math.abs(b.vel[i]) * 0.4; }
      }
      // A hollow beach ball bonking the glass.
      if (knock > 12) ctx.sound.play('thud', { pitch: 1.5, gain: Math.min(0.6, knock / 80), pan: panX(b.pos[0]) });
      b.spin += (b.vel[0] / b.r) * dt * 0.8;
    }
    // Balls bump each other.
    for (let i = 0; i < balls.length; i++)
      for (let j = i + 1; j < balls.length; j++) {
        const a = balls[i];
        const c = balls[j];
        const d = [c.pos[0] - a.pos[0], c.pos[1] - a.pos[1], c.pos[2] - a.pos[2]];
        const dist = Math.hypot(d[0], d[1], d[2]) || 1e-4;
        const min = a.r + c.r;
        if (dist < min) {
          const push = (min - dist) / 2;
          for (let k = 0; k < 3; k++) {
            a.pos[k] -= (d[k] / dist) * push;
            c.pos[k] += (d[k] / dist) * push;
          }
        }
      }
  }

  // ---------------------------------------------------------------- params

  function writeParams(dtSub: number, t: number, g: [number, number, number]) {
    // Stable while the pressure wave crosses < 0.65 cells per substep. EOS p = K(r^4 - 1) has
    // c^2 = 4K at rest; K = maxStiff / 8 leaves 2x headroom for squeeze.
    const maxStiff = (0.65 / dtSub) ** 2;
    const [x1, y1, z1] = tankMax();
    pu[0] = gx;
    pu[1] = gy;
    pu[2] = gz;
    pu[3] = count;
    pf[4] = g[0];
    pf[5] = g[1];
    pf[6] = g[2];
    pf[7] = dtSub;
    pf[8] = (s.stiffness * maxStiff) / 8;
    pf[9] = s.viscosity * (0.04 / dtSub);
    pf[10] = t;
    // Probes: push-mode fingers then balls.
    let n = 0;
    for (const gr of grabs.values()) {
      if (gr.mode !== 'push' || n >= MAX_POINTERS) continue;
      pf.set([gr.pos[0], gr.pos[1], gr.pos[2], s.pokeSize], 12 + n * 4);
      pf.set([gr.vel[0], gr.vel[1], gr.vel[2], 1], 44 + n * 4);
      n++;
    }
    for (const b of balls) {
      pf.set([b.pos[0], b.pos[1], b.pos[2], b.r * 0.95], 12 + n * 4);
      pf.set([b.vel[0], b.vel[1], b.vel[2], -0.6], 44 + n * 4);
      n++;
    }
    pu[11] = n;
    pf.set(view, 76);
    pf.set(proj, 92);
    pf.set(invView, 108);
    pf.set(invProj, 124);
    pf.set(camPos, 140);
    pf[143] = 0.62 * s.size;
    pf[144] = canvasW;
    pf[145] = canvasH;
    pf[146] = 1 / fluidW;
    pf[147] = 1 / fluidH;
    pf.set(tankMin, 148);
    pf[151] = s.absorb;
    pf.set([x1, y1, z1], 152);
    pf[155] = s.foam;
    const L = normalize([-0.4, 0.8, 0.45]);
    pf.set(L, 156);
    pf[159] = s.smoothing;
    pu[160] = balls.length;
    pf[161] = waterLevel;
    pf[162] = s.quality;
    pf[163] = 0.55;
    balls.forEach((b, i) => {
      pf.set([b.pos[0], b.pos[1], b.pos[2], b.r], 164 + i * 4);
      pf.set([b.spin, b.seed, 0, 0], 180 + i * 4);
    });
    pf[196] = s.bulk * (0.1 / dtSub);
    pf[197] = s.affine;
    device.queue.writeBuffer(paramBuf, 0, paramData);
  }

  let waterLevel = 0;
  // ---------------------------------------------------------------- sound
  let surfaceFlow = 0;
  let churn = 0;
  let slosh = 0;
  let flowLevel = 0;
  let sloshCool = 0;
  let lastTilt = 0;
  const panX = (x: number) => ((x - 2) / Math.max(1, gx - 4) - 0.5) * 1.2;

  function updateSound(dt: number) {
    // Tilt swinging (dragged or springing back) sloshes too, known without any readback.
    const tilt = Math.hypot(tiltRoll, tiltPitch);
    const swing = Math.min(1, Math.abs(tilt - lastTilt) / Math.max(dt, 1e-3) / 3);
    lastTilt = tilt;
    const target = Math.min(1, Math.max(surfaceFlow / 30, swing * 0.6, slosh));
    flowLevel += (target - flowLevel) * (1 - Math.exp(-dt * (target > flowLevel ? 8 : 2)));
    // Settled water sits below the floor so the bed goes fully quiet at rest.
    const audible = Math.max(0, flowLevel - 0.1) / 0.9;
    waterLoop.set(audible * 0.45, 0.3 + audible * 0.6);
    churnLoop.set(churn * 0.4, 0.4 + churn * 0.5);
    // A sudden surge in surface speed reads as a slosh hitting the wall.
    sloshCool -= dt;
    if (surfaceFlow / 30 > 0.55 && target > flowLevel + 0.2 && sloshCool <= 0) {
      sloshCool = 0.5;
      ctx.sound.play('splash', { pitch: 0.9, gain: Math.min(0.7, surfaceFlow / 60) });
    }
    slosh = Math.max(0, slosh - dt * 1.5);
    churn = 0;
  }
  function readColumns(i: number) {
    const buf = readback[i];
    readbackBusy[i] = true;
    const expected = buf;
    buf
      .mapAsync(GPUMapMode.READ)
      .then(() => {
        if (readback[i] !== expected) return;
        columns = new Float32Array(buf.getMappedRange().slice(0));
        buf.unmap();
        readbackBusy[i] = false;
        columnsFresh = true;
        let sum = 0;
        let nWet = 0;
        for (let k = 0; k < columns.length; k += 4)
          if (columns[k] >= 0) {
            sum += columns[k];
            nWet++;
          }
        waterLevel = nWet ? sum / nWet : 0;
        // Mean surface speed from the same readback drives the flowing-water bed.
        let flow = 0;
        for (let k = 0; k < columns.length; k += 4) if (columns[k] >= 0) flow += Math.hypot(columns[k + 1], columns[k + 2], columns[k + 3]);
        surfaceFlow = nWet ? flow / nWet : 0;
      })
      .catch(() => {
        readbackBusy[i] = false;
      });
  }

  buildDomain();
  buildTargets();
  resetWater();
  updateView();
  let frameNo = 0;

  if (import.meta.env.DEV) {
    // Dev-only probe for headless tests: speed and height statistics of the live particles.
    (window as unknown as Record<string, unknown>).__splashSet = (k: keyof typeof s, v: number) => {
      (s as Record<string, number>)[k] = v;
      if (k === 'resolution') buildDomain();
      resetWater();
    };
    (window as unknown as Record<string, unknown>).__splash = async () => {
      const rb = device.createBuffer({ size: count * STRIDE, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(particleBuf, 0, rb, 0, count * STRIDE);
      device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const f = new Float32Array(rb.getMappedRange().slice(0));
      rb.destroy();
      const speeds: number[] = [];
      let yMax = 0;
      let ySum = 0;
      for (let i = 0; i < count; i++) {
        const o = i * (STRIDE / 4);
        speeds.push(Math.hypot(f[o + 4], f[o + 5], f[o + 6]));
        yMax = Math.max(yMax, f[o + 1]);
        ySum += f[o + 1];
      }
      speeds.sort((a, b) => a - b);
      const q = (x: number) => speeds[Math.floor(x * (speeds.length - 1))].toFixed(1);
      return { count, yMean: (ySum / count).toFixed(2), yMax: yMax.toFixed(1), speed50: q(0.5), speed90: q(0.9), speed99: q(0.99), level: waterLevel.toFixed(2) };
    };
  }

  const waterLoop = ctx.sound.loop('trickle');
  const churnLoop = ctx.sound.loop('bubble');

  return {
    frame(dt, t) {
      handleInput(dt);
      const g = gravityVector(dt);
      updateBalls(dt, g);
      updateSound(dt);
      updateView();
      const steps = Math.round(s.substeps);
      const dtSub = 1 / 60 / steps;
      writeParams(dtSub, t, g);

      const enc = device.createCommandEncoder();
      const cp = enc.beginComputePass();
      cp.setBindGroup(0, simBindGroup!);
      const pw = Math.ceil(count / 64);
      const gw = Math.ceil((gx * gy * gz) / 64);
      for (let i = 0; i < steps; i++) {
        cp.setPipeline(p2gMassPipe);
        cp.dispatchWorkgroups(pw);
        cp.setPipeline(p2gStressPipe);
        cp.dispatchWorkgroups(pw);
        cp.setPipeline(gridPipe);
        cp.dispatchWorkgroups(gw);
        cp.setPipeline(g2pPipe);
        cp.dispatchWorkgroups(pw);
      }
      cp.setPipeline(columnsPipe);
      cp.dispatchWorkgroups(Math.ceil((gx * gz) / 64));
      cp.end();
      const slot = frameNo % 2;
      const doRead = !readbackBusy[slot];
      if (doRead) enc.copyBufferToBuffer(columnsBuf!, 0, readback[slot], 0, gx * gz * 16);

      // Sphere depth with a z-buffer, then additive thickness + foam.
      const dp = enc.beginRenderPass({
        colorAttachments: [{ view: depthTex!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
        depthStencilAttachment: { view: zbuf!.createView(), depthLoadOp: 'clear', depthStoreOp: 'discard', depthClearValue: 1 },
      });
      dp.setPipeline(depthPipe);
      dp.setBindGroup(0, depthBind);
      dp.draw(4, count);
      dp.end();
      const tp = enc.beginRenderPass({
        colorAttachments: [{ view: thickTex!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
      });
      tp.setPipeline(thickPipe);
      tp.setBindGroup(0, thickBind);
      tp.draw(4, count);
      tp.end();
      // Two rounds of separable bilateral smoothing, ping-ponging depth <-> blur.
      for (let round = 0; round < 2; round++) {
        for (let axis = 0; axis < 2; axis++) {
          const target = axis === 0 ? blurTex! : depthTex!;
          const bp = enc.beginRenderPass({
            colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 0 } }],
          });
          bp.setPipeline(blurPipe);
          bp.setBindGroup(0, blurBinds[axis]);
          bp.draw(3);
          bp.end();
        }
      }
      const cpass = enc.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: { r: 0, g: 0, b: 0, a: 1 } }],
      });
      cpass.setPipeline(compositePipe);
      cpass.setBindGroup(0, compositeBind!);
      cpass.draw(3);
      cpass.end();
      device.queue.submit([enc.finish()]);
      if (doRead) readColumns(slot);
      frameNo++;
      if (frameNo % 15 === 0) {
        ctx.setStatus(`${count.toLocaleString()} particles · grid ${gx}×${gy}×${gz} · ${steps} substeps${motionSeen ? ' · tilt' : ''}`);
      }
    },
    resize(width, height) {
      if (width === canvasW && height === canvasH) return;
      canvasW = width;
      canvasH = height;
      const aspect = width / height;
      if (Math.abs(aspect / domainAspect - 1) > 0.05) {
        buildDomain();
        resetWater();
        balls.length = 0;
      } else {
        buildCamera();
      }
      buildTargets();
    },
    destroy() {
      waterLoop.stop();
      churnLoop.stop();
      removeEventListener('devicemotion', onMotion);
      dock.remove();
      hideTiltButton();
      [depthTex, zbuf, blurTex, thickTex].forEach((t) => t?.destroy());
      [gridAtomic, gridV, columnsBuf, paramBuf, particleBuf, ...readback, ...blurDirBufs].forEach((b) => b?.destroy());
      context.unconfigure();
      device.destroy();
    },
  };
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}

function normalize(v: [number, number, number]): [number, number, number] {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
}
