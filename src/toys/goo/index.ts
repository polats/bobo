import type { Toy, ToyContext, ToyInstance } from '../../shell/types';
import commonSrc from './common.wgsl?raw';
import simSrc from './sim.wgsl?raw';
import splatSrc from './splat.wgsl?raw';
import compositeSrc from './composite.wgsl?raw';

// Particle layout (64 bytes) mirrors `Particle` in common.wgsl.
const CAPACITY = 100_000;
const STRIDE = 64;
const FLOATS = STRIDE / 4;
const PARAM_BYTES = 352;
const SPLAT_SCALE = 0.5;
const MAX_POINTERS = 8;

const WATER = 0;
const JELLY = 1;
const SNOW = 2;
const SAND = 3;

type Tool = 'poke' | 'water' | 'jelly' | 'snow' | 'sand';

const TOOLS: { id: Tool; label: string; glyph: string; swatch: string }[] = [
  { id: 'poke', label: 'Poke', glyph: '👆', swatch: '#f1eee8' },
  { id: 'water', label: 'Water', glyph: '💧', swatch: '#3d8bff' },
  { id: 'jelly', label: 'Jelly', glyph: '🍮', swatch: '#ff3d8b' },
  { id: 'snow', label: 'Snow', glyph: '❄️', swatch: '#dde8ff' },
  { id: 'sand', label: 'Sand', glyph: '⏳', swatch: '#f0b458' },
];

export const gooToy: Toy = {
  id: 'goo',
  title: 'Goo Lab',
  blurb: 'Jelly, snow, sand and water from one solver. Pour, drop, stir.',
  tech: 'WebGPU · MLS-MPM',
  swatch: 'linear-gradient(135deg, #ff3d8b, #3d8bff 55%, #f0b458)',
  create,
};

async function create(ctx: ToyContext): Promise<ToyInstance> {
  if (!navigator.gpu) {
    throw new Error('Goo Lab needs WebGPU, which this browser does not expose. Try Safari on iOS 26+ or desktop Chrome.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new Error('No WebGPU adapter is available on this device.');
  const device = await adapter.requestDevice();
  device.addEventListener('uncapturederror', (e) => console.error('[goo] WebGPU:', (e as GPUUncapturedErrorEvent).error.message));

  const context = ctx.canvas.getContext('webgpu');
  if (!context) throw new Error('Could not create a WebGPU canvas context.');
  const format = navigator.gpu.getPreferredCanvasFormat();
  context.configure({ device, format, alphaMode: 'opaque' });

  const s = {
    substeps: 12,
    speed: 1,
    gravity: 280,
    tilt: false,
    // Stiffnesses are fractions of the stiffest material the current substep can carry stably.
    solid: 0.8,
    jelly: 0.6,
    water: 0.9,
    viscosity: 0.5,
    // Friction coefficient: shear stress in sand is capped at this times its packing pressure.
    sandFriction: 1.2,
    size: 1.0,
    glow: 0.35,
    maxParticles: 40000,
    resolution: 128,
    pokeSize: 7,
  };

  // ---------------------------------------------------------------- GPU resources

  const paramBuf = device.createBuffer({ size: PARAM_BYTES, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const particleBuf = device.createBuffer({ size: CAPACITY * STRIDE, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST | GPUBufferUsage.COPY_SRC });
  const paramData = new ArrayBuffer(PARAM_BYTES);
  const pf = new Float32Array(paramData);
  const pu = new Uint32Array(paramData);

  const simModule = device.createShaderModule({ label: 'goo-sim', code: commonSrc + simSrc });
  const splatModule = device.createShaderModule({ label: 'goo-splat', code: commonSrc + splatSrc });
  const compositeModule = device.createShaderModule({ label: 'goo-composite', code: commonSrc + compositeSrc });

  const simLayout = device.createBindGroupLayout({
    entries: [
      { binding: 0, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'uniform' } },
      { binding: 1, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 2, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
      { binding: 3, visibility: GPUShaderStage.COMPUTE, buffer: { type: 'storage' } },
    ],
  });
  const simPipelineLayout = device.createPipelineLayout({ bindGroupLayouts: [simLayout] });
  const computePipeline = (entryPoint: string) =>
    device.createComputePipeline({ layout: simPipelineLayout, compute: { module: simModule, entryPoint } });
  const p2gMassPipe = computePipeline('p2gMass');
  const p2gStressPipe = computePipeline('p2gStress');
  const gridPipe = computePipeline('gridUpdate');
  const g2pPipe = computePipeline('g2p');

  const additive: GPUBlendState = {
    color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
    alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
  };
  const splatPipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: splatModule, entryPoint: 'splatVS' },
    fragment: {
      module: splatModule,
      entryPoint: 'splatFS',
      targets: [
        { format: 'rgba16float', blend: additive },
        { format: 'rgba16float', blend: additive },
      ],
    },
    primitive: { topology: 'triangle-strip' },
  });
  const splatBindGroup = device.createBindGroup({
    layout: splatPipe.getBindGroupLayout(0),
    entries: [
      { binding: 0, resource: { buffer: paramBuf } },
      { binding: 1, resource: { buffer: particleBuf } },
    ],
  });
  const compositePipe = device.createRenderPipeline({
    layout: 'auto',
    vertex: { module: compositeModule, entryPoint: 'fullscreenVS' },
    fragment: { module: compositeModule, entryPoint: 'compositeFS', targets: [{ format }] },
    primitive: { topology: 'triangle-list' },
  });
  const sampler = device.createSampler({ magFilter: 'linear', minFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

  // Domain: the canvas maps exactly onto a grid with `resolution` cells across its short side.
  let canvasW = ctx.canvas.width;
  let canvasH = ctx.canvas.height;
  let domainW = 0;
  let domainH = 0;
  let gridW = 0;
  let gridH = 0;
  let gridAtomicBuf: GPUBuffer | null = null;
  let gridVBuf: GPUBuffer | null = null;
  let simBindGroup: GPUBindGroup | null = null;

  function buildDomain() {
    const cellPx = Math.min(canvasW, canvasH) / s.resolution;
    domainW = canvasW / cellPx;
    domainH = canvasH / cellPx;
    gridW = Math.ceil(domainW) + 1;
    gridH = Math.ceil(domainH) + 1;
    gridAtomicBuf?.destroy();
    gridVBuf?.destroy();
    gridAtomicBuf = device.createBuffer({ size: gridW * gridH * 4 * 4, usage: GPUBufferUsage.STORAGE });
    gridVBuf = device.createBuffer({ size: gridW * gridH * 16, usage: GPUBufferUsage.STORAGE });
    simBindGroup = device.createBindGroup({
      layout: simLayout,
      entries: [
        { binding: 0, resource: { buffer: paramBuf } },
        { binding: 1, resource: { buffer: particleBuf } },
        { binding: 2, resource: { buffer: gridAtomicBuf } },
        { binding: 3, resource: { buffer: gridVBuf } },
      ],
    });
  }

  let fieldA: GPUTexture | null = null;
  let fieldB: GPUTexture | null = null;
  let compositeBindGroup: GPUBindGroup | null = null;

  function buildTargets() {
    fieldA?.destroy();
    fieldB?.destroy();
    const size = [Math.max(1, Math.round(canvasW * SPLAT_SCALE)), Math.max(1, Math.round(canvasH * SPLAT_SCALE))];
    const desc: GPUTextureDescriptor = {
      size,
      format: 'rgba16float',
      usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.TEXTURE_BINDING,
    };
    fieldA = device.createTexture(desc);
    fieldB = device.createTexture(desc);
    compositeBindGroup = device.createBindGroup({
      layout: compositePipe.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: paramBuf } },
        { binding: 1, resource: fieldA.createView() },
        { binding: 2, resource: fieldB.createView() },
        { binding: 3, resource: sampler },
      ],
    });
  }

  // ---------------------------------------------------------------- particles

  let count = 0;
  let cursor = 0;
  let jellyColor = 0;
  const staging = new ArrayBuffer(16384 * STRIDE);
  const sf = new Float32Array(staging);
  const su = new Uint32Array(staging);
  let pending = 0;

  function spawn(mat: number, x: number, y: number, vx: number, vy: number, tag = 1) {
    if (pending * STRIDE >= staging.byteLength) flush();
    if (x < 2.2 || y < 2.2 || x > domainW - 2.2 || y > domainH - 2.2) return;
    const o = pending * FLOATS;
    sf[o] = x;
    sf[o + 1] = y;
    sf[o + 2] = vx;
    sf[o + 3] = vy;
    sf.fill(0, o + 4, o + 8); // C
    sf[o + 8] = 1; // F = identity (column-major)
    sf[o + 9] = 0;
    sf[o + 10] = 0;
    sf[o + 11] = 1;
    su[o + 12] = mat;
    sf[o + 13] = tag;
    sf[o + 14] = Math.random();
    sf[o + 15] = 0;
    pending++;
  }

  /** Upload pending particles into free slots, overwriting the oldest once full. */
  function flush() {
    let runStart = -1;
    let runSrc = 0;
    let runLen = 0;
    const commit = () => {
      if (runLen > 0) device.queue.writeBuffer(particleBuf, runStart * STRIDE, staging, runSrc * STRIDE, runLen * STRIDE);
      runLen = 0;
    };
    for (let i = 0; i < pending; i++) {
      let slot: number;
      if (count < s.maxParticles) slot = count++;
      else {
        slot = cursor;
        cursor = (cursor + 1) % s.maxParticles;
      }
      if (runLen > 0 && slot === runStart + runLen) runLen++;
      else {
        commit();
        runStart = slot;
        runSrc = i;
        runLen = 1;
      }
    }
    commit();
    pending = 0;
  }

  const jitter = () => (Math.random() - 0.5) * 0.2;

  function spawnBox(mat: number, x0: number, y0: number, x1: number, y1: number, tag = 1, vx = 0, vy = 0) {
    for (let y = y0; y < y1; y += 0.5) for (let x = x0; x < x1; x += 0.5) spawn(mat, x + jitter(), y + jitter(), vx, vy, tag);
  }

  function spawnDisk(mat: number, cx: number, cy: number, r: number, tag = 1, vx = 0, vy = 0) {
    for (let y = -r; y <= r; y += 0.5)
      for (let x = -r; x <= r; x += 0.5) if (x * x + y * y <= r * r) spawn(mat, cx + x + jitter(), cy + y + jitter(), vx, vy, tag);
  }

  function clear() {
    count = 0;
    cursor = 0;
    pending = 0;
  }

  function resetScene() {
    clear();
    const w = domainW;
    const h = domainH;
    const short = Math.min(w, h);
    spawnBox(WATER, 2.3, 2.3, w - 2.3, 2.3 + h * 0.2);
    const b = short * 0.16;
    spawnBox(JELLY, w * 0.28 - b / 2, h * 0.5, w * 0.28 + b / 2, h * 0.5 + b, 0);
    spawnBox(JELLY, w * 0.7 - b * 0.4, h * 0.64, w * 0.7 + b * 0.4, h * 0.64 + b * 0.8, 1);
    spawnDisk(JELLY, w * 0.5, h * 0.8, short * 0.075, 3);
    spawnDisk(SNOW, w * 0.22, h * 0.88, short * 0.06);
    jellyColor = 4;
    flush();
  }

  // ---------------------------------------------------------------- input

  let tool: Tool = 'poke';
  const pour = new Map<number, { acc: number; vx: number; vy: number; nextBall: number }>();
  let tiltX = 0;
  let tiltY = -1;

  const dock = document.createElement('div');
  dock.className = 'dock';
  const dockButtons = TOOLS.map((t) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.textContent = t.glyph;
    b.title = t.label;
    b.setAttribute('aria-label', t.label);
    b.style.setProperty('--swatch', t.swatch);
    b.setAttribute('aria-pressed', String(t.id === tool));
    b.addEventListener('click', () => {
      tool = t.id;
      dockButtons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    });
    return b;
  });
  dock.append(...dockButtons);
  // Vertical rail on the right edge so the tools never cover the pool at the bottom.
  Object.assign(dock.style, {
    left: 'auto',
    right: 'calc(10px + var(--safe-right))',
    top: '50%',
    bottom: 'auto',
    transform: 'translateY(-50%)',
    flexDirection: 'column',
    maxWidth: 'none',
  });
  ctx.overlay.appendChild(dock);

  function gravityDir(): [number, number] {
    if (!s.tilt) return [0, -1];
    const l = Math.hypot(tiltX, tiltY);
    return l < 1e-3 ? [0, 0] : [tiltX / l, tiltY / l];
  }

  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const onMotion = (e: DeviceMotionEvent) => {
    const a = e.accelerationIncludingGravity;
    if (!a || a.x == null || a.y == null) return;
    // iOS reports gravity as negative acceleration along the down axis; Android the opposite.
    let x = (isIOS ? a.x : -a.x) / 9.81;
    let y = (isIOS ? a.y : -a.y) / 9.81;
    const angle = ((screen.orientation?.angle ?? 0) * Math.PI) / 180;
    const c = Math.cos(angle);
    const sn = Math.sin(angle);
    [x, y] = [x * c + y * sn, -x * sn + y * c];
    tiltX = tiltX * 0.8 + x * 0.2;
    tiltY = tiltY * 0.8 + y * 0.2;
  };

  async function setTilt(on: boolean) {
    if (!on) {
      removeEventListener('devicemotion', onMotion);
      return;
    }
    const DME = DeviceMotionEvent as unknown as { requestPermission?: () => Promise<string> };
    if (typeof DME.requestPermission === 'function') {
      try {
        if ((await DME.requestPermission()) !== 'granted') {
          s.tilt = false;
          return;
        }
      } catch {
        s.tilt = false;
        return;
      }
    }
    addEventListener('devicemotion', onMotion);
  }

  const smoothVel = new Map<number, [number, number]>();
  const pokes: number[] = [];

  function handleInput(dt: number) {
    pokes.length = 0;
    const [gx, gy] = gravityDir();
    for (const p of ctx.pointers.active.values()) {
      const x = p.x * domainW;
      const y = p.y * domainH;
      const rawVx = (p.dx * domainW) / Math.max(dt, 1e-3);
      const rawVy = (p.dy * domainH) / Math.max(dt, 1e-3);
      const sv = smoothVel.get(p.id) ?? [0, 0];
      const vx = (sv[0] = p.justDown ? 0 : sv[0] * 0.5 + rawVx * 0.5);
      const vy = (sv[1] = p.justDown ? 0 : sv[1] * 0.5 + rawVy * 0.5);
      smoothVel.set(p.id, sv);

      if (tool === 'poke') {
        if (pokes.length / 6 < MAX_POINTERS) pokes.push(x, y, vx, vy, s.pokeSize, 1);
        if (p.justDown) ctx.haptic('light');
        continue;
      }
      let st = pour.get(p.id);
      if (!st || p.justDown) {
        st = { acc: 0, vx: 0, vy: 0, nextBall: 0 };
        pour.set(p.id, st);
      }
      if (tool === 'jelly') {
        st.nextBall -= dt;
        if (st.nextBall <= 0) {
          const r = Math.min(domainW, domainH) * (0.05 + Math.random() * 0.03);
          spawnDisk(JELLY, x, y, r, jellyColor++ % 5, vx * 0.5, vy * 0.5);
          st.nextBall = 0.28;
          ctx.haptic('medium');
        }
        continue;
      }
      // Pour a stream along gravity: add rows at particle spacing as the stream advances.
      const mat = tool === 'water' ? WATER : tool === 'snow' ? SNOW : SAND;
      const speed = 55;
      const half = tool === 'sand' ? 3 : 2.5;
      const dx = gx || 0;
      const dy = gx || gy ? gy : -1;
      const vx0 = dx * speed + vx * 0.4;
      const vy0 = dy * speed + vy * 0.4;
      st.acc += speed * dt;
      while (st.acc >= 0.5) {
        st.acc -= 0.5;
        for (let u = -half; u <= half; u += 0.5) {
          const along = st.acc;
          spawn(mat, x - dy * u + dx * along + jitter(), y + dx * u + dy * along + jitter(), vx0, vy0);
        }
      }
    }
    for (const id of smoothVel.keys()) if (!ctx.pointers.active.has(id)) smoothVel.delete(id);
    for (const id of pour.keys()) if (!ctx.pointers.active.has(id)) pour.delete(id);
  }

  // ---------------------------------------------------------------- panel

  const p = ctx.panel;
  p.heading('Sim');
  p.slider(s, 'substeps', { label: 'Substeps', min: 2, max: 24, step: 1 });
  p.choice(
    'Speed',
    [
      { value: '1', label: '1×' },
      { value: '0.5', label: '½×' },
      { value: '0.25', label: '¼×' },
    ],
    '1',
    (v) => (s.speed = Number(v)),
  );
  p.slider(s, 'gravity', { label: 'Gravity', min: 0, max: 800, step: 10 });
  p.toggleSwitch(s, 'tilt', 'Tilt gravity', (on) => void setTilt(on));
  p.heading('Materials');
  p.slider(s, 'solid', { label: 'Solid stiffness', min: 0.05, max: 1, step: 0.01 });
  p.slider(s, 'jelly', { label: 'Jelly firmness', min: 0.05, max: 1, step: 0.01 });
  p.slider(s, 'water', { label: 'Water stiffness', min: 0.05, max: 1, step: 0.01 });
  p.slider(s, 'viscosity', { label: 'Water goopiness', min: 0, max: 60, step: 0.5 });
  p.slider(s, 'sandFriction', { label: 'Sand friction', min: 0.1, max: 1.5, step: 0.01 });
  p.heading('Look');
  p.slider(s, 'size', { label: 'Blob size', min: 0.7, max: 2, step: 0.05 });
  p.slider(s, 'glow', { label: 'Glow', min: 0, max: 1, step: 0.01 });
  p.slider(s, 'pokeSize', { label: 'Poke size', min: 3, max: 18, step: 0.5 });
  p.heading('Budget');
  p.slider(s, 'maxParticles', {
    label: 'Max particles',
    min: 5000,
    max: CAPACITY,
    step: 1000,
    onChange: () => {
      if (count > s.maxParticles) count = s.maxParticles;
      cursor = count < s.maxParticles ? 0 : cursor % s.maxParticles;
    },
  });
  p.choice(
    'Grid resolution',
    [
      { value: '96', label: '96' },
      { value: '128', label: '128' },
      { value: '160', label: '160' },
    ],
    String(s.resolution),
    (v) => {
      s.resolution = Number(v);
      buildDomain();
      resetScene();
    },
  );
  p.action('Clear', clear);
  p.action('Reset scene', resetScene);

  // ---------------------------------------------------------------- frame

  buildDomain();
  buildTargets();
  resetScene();
  let simAspect = canvasW / canvasH;
  let statusTimer = 0;

  function writeParams(dtSub: number, t: number) {
    // Stable while the pressure wave crosses < 0.65 cells per substep (rho = 1, so c^2 = modulus).
    // Hydrostatic squash is g*depth/modulus, so this is also what keeps piles from pancaking.
    const maxStiff = (0.65 / dtSub) ** 2;
    const nu = 0.2;
    // P-wave modulus la + 2mu = E(1-nu)/((1+nu)(1-2nu)); halve it so snow can harden 2x.
    // Solids are 0.6x as dense as water, which raises their wave speed by 1/sqrt(0.6); scale down.
    const E = (0.5 * 0.6 * s.solid * maxStiff * (1 + nu) * (1 - 2 * nu)) / (1 - nu);
    const mu = E / (2 * (1 + nu));
    const la = (E * nu) / ((1 + nu) * (1 - 2 * nu));
    const [gx, gy] = gravityDir();
    const tiltScale = s.tilt ? Math.min(1, Math.hypot(tiltX, tiltY)) : 1;
    pu[0] = gridW;
    pu[1] = gridH;
    pf[2] = domainW;
    pf[3] = domainH;
    pf[4] = gx * s.gravity * tiltScale;
    pf[5] = gy * s.gravity * tiltScale;
    pf[6] = dtSub;
    pu[7] = count;
    pf[8] = mu;
    pf[9] = la;
    // Water EOS p = K((rho/rho0)^4 - 1): sound speed^2 at rest is 4K; leave 2x headroom for squeeze.
    pf[10] = (s.water * maxStiff) / 8;
    pf[11] = Math.min(s.viscosity, 0.1 / dtSub);
    pf[12] = s.jelly;
    pf[13] = s.sandFriction;
    pf[14] = t;
    const n = pokes.length / 6;
    pu[15] = n;
    for (let i = 0; i < n; i++) {
      pf.set(pokes.slice(i * 6, i * 6 + 4), 16 + i * 4);
      pf[48 + i * 4] = pokes[i * 6 + 4];
      pf[48 + i * 4 + 1] = pokes[i * 6 + 5];
    }
    const radius = 1.35 * s.size;
    pf[80] = radius;
    pf[81] = 1 / (Math.PI * radius * radius);
    pf[82] = 1 / fieldA!.width;
    pf[83] = 1 / fieldA!.height;
    pf[84] = 0.33;
    pf[85] = s.glow;
    pf[86] = canvasW;
    pf[87] = canvasH;
    device.queue.writeBuffer(paramBuf, 0, paramData);
  }

  if (import.meta.env.DEV) {
    // Dev-only probe for headless tests: per-material stats of the live particles.
    (window as unknown as Record<string, unknown>).__goo = async () => {
      const n = count;
      const rb = device.createBuffer({ size: Math.max(STRIDE, n * STRIDE), usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const enc = device.createCommandEncoder();
      enc.copyBufferToBuffer(particleBuf, 0, rb, 0, n * STRIDE);
      device.queue.submit([enc.finish()]);
      await rb.mapAsync(GPUMapMode.READ);
      const f = new Float32Array(rb.getMappedRange().slice(0));
      const u = new Uint32Array(f.buffer);
      rb.destroy();
      const stats: Record<string, { n: number; yMin: number; yMax: number; yMean: number; J: number; Jmin: number }> = {};
      for (let i = 0; i < n; i++) {
        const o = i * FLOATS;
        const key = ['water', 'jelly', 'snow', 'sand'][u[o + 12]] + (u[o + 12] === JELLY ? f[o + 13] : '');
        const J = f[o + 8] * f[o + 11] - f[o + 10] * f[o + 9];
        const st = (stats[key] ??= { n: 0, yMin: 1e9, yMax: -1e9, yMean: 0, J: 0, Jmin: 9 });
        st.n++;
        st.yMin = Math.min(st.yMin, f[o + 1]);
        st.yMax = Math.max(st.yMax, f[o + 1]);
        st.yMean += f[o + 1];
        st.J += J;
        st.Jmin = Math.min(st.Jmin, J);
      }
      for (const st of Object.values(stats)) {
        st.yMean = +(st.yMean / st.n).toFixed(1);
        st.J = +(st.J / st.n).toFixed(3);
        st.yMin = +st.yMin.toFixed(1);
        st.yMax = +st.yMax.toFixed(1);
        st.Jmin = +st.Jmin.toFixed(3);
      }
      return { domain: [domainW, domainH], stats };
    };
    (window as unknown as Record<string, unknown>).__gooBox = (mat: number, x0: number, y0: number, x1: number, y1: number) => {
      spawnBox(mat, x0, y0, x1, y1);
      flush();
    };
    (window as unknown as Record<string, unknown>).__gooClear = clear;
  }

  return {
    frame(dt, t) {
      handleInput(dt);
      flush();
      const steps = Math.round(s.substeps);
      const dtSub = ((1 / 60) * s.speed) / steps;
      writeParams(dtSub, t);

      const enc = device.createCommandEncoder();
      if (count > 0) {
        const cp = enc.beginComputePass();
        cp.setBindGroup(0, simBindGroup!);
        const pw = Math.ceil(count / 64);
        const gw = Math.ceil((gridW * gridH) / 64);
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
        cp.end();
      }
      const clearColor = { r: 0, g: 0, b: 0, a: 0 };
      const sp = enc.beginRenderPass({
        colorAttachments: [
          { view: fieldA!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: clearColor },
          { view: fieldB!.createView(), loadOp: 'clear', storeOp: 'store', clearValue: clearColor },
        ],
      });
      if (count > 0) {
        sp.setPipeline(splatPipe);
        sp.setBindGroup(0, splatBindGroup);
        sp.draw(4, count);
      }
      sp.end();
      const out = enc.beginRenderPass({
        colorAttachments: [{ view: context.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store', clearValue: clearColor }],
      });
      out.setPipeline(compositePipe);
      out.setBindGroup(0, compositeBindGroup!);
      out.draw(3);
      out.end();
      device.queue.submit([enc.finish()]);

      statusTimer -= dt;
      if (statusTimer <= 0) {
        statusTimer = 0.25;
        ctx.setStatus(`${count.toLocaleString()} particles · grid ${gridW}×${gridH} · ${steps} substeps`);
      }
    },

    resize(width, height) {
      if (width === canvasW && height === canvasH && fieldA) return;
      canvasW = width;
      canvasH = height;
      buildTargets();
      const aspect = width / height;
      if (Math.abs(aspect - simAspect) / simAspect > 0.05) {
        simAspect = aspect;
        buildDomain();
        resetScene();
      }
    },

    destroy() {
      removeEventListener('devicemotion', onMotion);
      dock.remove();
      context.unconfigure();
      fieldA?.destroy();
      fieldB?.destroy();
      gridAtomicBuf?.destroy();
      gridVBuf?.destroy();
      particleBuf.destroy();
      paramBuf.destroy();
      device.destroy();
    },
  };
}
