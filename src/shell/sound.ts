// Procedural sound: every voice is synthesised on the fly with Web Audio (no audio files), so it
// costs nothing to download and every hit can vary in pitch and loudness with the physics.
// One-shots are fire-and-forget node graphs; loops are a looping noise bed through a filter whose
// level and brightness a toy drives every frame (pouring sand, running water, a fire's roar).

export type Voice =
  | "pop" // bright bubble pop: merges, bursts
  | "plop" // rising bloop: drops, drips into liquid
  | "squish" // wet squelch: squeezing goo and jelly
  | "boing" // jelly wobble
  | "thud" // soft heavy landing
  | "knock" // hard wood/plastic hit: blocks, marbles
  | "tick" // tiny click: UI, grains, a spool clicking in
  | "snap" // sharp crack: threads snapping, branches
  | "rip" // tearing fabric
  | "splash" // liquid splash
  | "whoosh" // air: throws, sweeps
  | "crumble" // soil and sand collapsing
  | "sizzle" // hot hiss
  | "chime"; // reward sparkle

export interface PlayOpts {
  /** Pitch as a ratio (1 = default, 2 = an octave up). */
  pitch?: number;
  /** 0..1, multiplied into the voice's own level. */
  gain?: number;
  /** -1 (left) .. 1 (right). */
  pan?: number;
}

export type LoopKind = "hiss" | "rumble" | "trickle" | "crackle" | "bubble";

export interface Loop {
  /** Level 0..1 and brightness 0..1; smoothed, so call it every frame. */
  set(level: number, brightness?: number): void;
  stop(): void;
}

export interface Sound {
  play(voice: Voice, opts?: PlayOpts): void;
  loop(kind: LoopKind): Loop;
}

const MAX_VOICES = 14;
/** The same voice can't retrigger faster than this (seconds), so a pile of contacts doesn't buzz. */
const MIN_GAP: Partial<Record<Voice, number>> = {
  tick: 0.018,
  knock: 0.03,
  crumble: 0.05,
  splash: 0.08,
  squish: 0.06,
  boing: 0.08,
};
const KEY = "bobo.sound";
/** Per-voice trim so every voice peaks at roughly the same level (measured offline). */
const LEVEL: Record<Voice, number> = {
  pop: 1.7,
  plop: 2.2,
  squish: 3.2,
  boing: 2.2,
  thud: 1.9,
  knock: 2.6,
  tick: 12,
  snap: 1.3,
  rip: 1.5,
  splash: 1.3,
  whoosh: 1.7,
  crumble: 1.7,
  sizzle: 2.2,
  chime: 0.85,
};

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let noise: AudioBuffer | null = null;
let crackle: AudioBuffer | null = null;
let trickle: AudioBuffer | null = null;
let bubble: AudioBuffer | null = null;
let active = 0;
const lastPlay = new Map<Voice, number>();
let enabled = readPref();
const listeners = new Set<(on: boolean) => void>();

function readPref() {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function soundEnabled() {
  return enabled;
}

export function setSoundEnabled(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* private mode */
  }
  if (master && ctx)
    master.gain.setTargetAtTime(on ? 0.8 : 0, ctx.currentTime, 0.02);
  listeners.forEach((f) => f(on));
}

export function onSoundChange(f: (on: boolean) => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Browsers only start audio from a user gesture; call from the first pointerdown. */
export function unlockSound() {
  const c = audio();
  if (c && c.state !== "running") c.resume().catch(() => {});
}

function audio(): AudioContext | null {
  if (ctx) return ctx;
  const AC =
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!AC) return null;
  ctx = new AC({ latencyHint: "interactive" });
  // A gentle compressor on the master keeps big chain reactions from clipping.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -14;
  comp.knee.value = 12;
  comp.ratio.value = 4;
  comp.attack.value = 0.003;
  comp.release.value = 0.15;
  master = ctx.createGain();
  master.gain.value = enabled ? 0.8 : 0;
  master.connect(comp).connect(ctx.destination);
  const sr = ctx.sampleRate;
  noise = makeBuffer(ctx, 2 * sr, () => Math.random() * 2 - 1);
  // Sparse impulse trains: crackling fire, trickling grains, bubbling liquid.
  crackle = makeBuffer(
    ctx,
    2 * sr,
    () =>
      (Math.random() < 30 / sr
        ? (Math.random() * 2 - 1) * (0.5 + Math.random())
        : 0) +
      (Math.random() * 2 - 1) * 0.02,
  );
  trickle = makeGrains(ctx, 2 * sr, 260, 0.0015);
  bubble = makeBubbles(ctx, 2 * sr);
  return ctx;
}

function makeBuffer(c: AudioContext, n: number, f: (i: number) => number) {
  const b = c.createBuffer(1, n, c.sampleRate);
  const d = b.getChannelData(0);
  for (let i = 0; i < n; i++) d[i] = f(i);
  return b;
}

/** Many tiny decaying noise grains at random times: sand pouring, gravel. */
function makeGrains(
  c: AudioContext,
  n: number,
  perSecond: number,
  len: number,
) {
  const b = c.createBuffer(1, n, c.sampleRate);
  const d = b.getChannelData(0);
  const sr = c.sampleRate;
  const count = Math.round((perSecond * n) / sr);
  const L = Math.round(len * sr);
  for (let g = 0; g < count; g++) {
    const at = Math.floor(Math.random() * (n - L));
    const amp = 0.2 + Math.random() * 0.8;
    for (let k = 0; k < L; k++)
      d[at + k] += (Math.random() * 2 - 1) * amp * Math.exp((-6 * k) / L);
  }
  return b;
}

/** Little rising sine chirps: liquid bubbling. */
function makeBubbles(c: AudioContext, n: number) {
  const b = c.createBuffer(1, n, c.sampleRate);
  const d = b.getChannelData(0);
  const sr = c.sampleRate;
  for (let g = 0; g < 18; g++) {
    const at = Math.floor(Math.random() * (n - sr * 0.05));
    const f0 = 400 + Math.random() * 900;
    const L = Math.floor(sr * (0.02 + Math.random() * 0.03));
    let ph = 0;
    for (let k = 0; k < L; k++) {
      const t = k / L;
      ph += (2 * Math.PI * f0 * (1 + 1.5 * t)) / sr;
      d[at + k] += Math.sin(ph) * Math.sin(Math.PI * t) * 0.6;
    }
  }
  return b;
}

export const sound: Sound = {
  play(voice, opts = {}) {
    if (!enabled) return;
    const c = audio();
    if (!c || !master || c.state !== "running" || active >= MAX_VOICES) return;
    const now = c.currentTime;
    const gap = MIN_GAP[voice] ?? 0.03;
    if (now - (lastPlay.get(voice) ?? -1) < gap) return;
    lastPlay.set(voice, now);
    const out = c.createGain();
    out.gain.value = Math.max(0, Math.min(1, opts.gain ?? 1)) * LEVEL[voice];
    let tail: AudioNode = out;
    if (opts.pan && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = Math.max(-1, Math.min(1, opts.pan));
      out.connect(p);
      tail = p;
    }
    tail.connect(master);
    // Slight random detune on every hit: repeated sounds never machine-gun.
    const pitch = (opts.pitch ?? 1) * (0.96 + Math.random() * 0.08);
    const dur = VOICES[voice](c, out, now, pitch);
    active++;
    setTimeout(
      () => {
        active--;
        tail.disconnect();
      },
      (dur + 0.1) * 1000,
    );
  },

  loop(kind) {
    const c = audio();
    if (!c || !master) return { set() {}, stop() {} };
    const src = c.createBufferSource();
    src.buffer =
      kind === "crackle"
        ? crackle
        : kind === "trickle"
          ? trickle
          : kind === "bubble"
            ? bubble
            : noise;
    src.loop = true;
    // Start somewhere random so two loops of the same kind don't phase.
    const filter = c.createBiquadFilter();
    const g = c.createGain();
    g.gain.value = 0;
    const cfg = LOOPS[kind];
    filter.type = cfg.type;
    filter.Q.value = cfg.q;
    filter.frequency.value = cfg.lo;
    src.connect(filter).connect(g).connect(master);
    src.start(0, Math.random() * 1.5);
    let stopped = false;
    return {
      set(level, brightness = 0.5) {
        if (stopped || !ctx) return;
        const t = ctx.currentTime;
        g.gain.setTargetAtTime(
          Math.max(0, Math.min(1, level)) * cfg.gain,
          t,
          0.06,
        );
        filter.frequency.setTargetAtTime(
          cfg.lo *
            Math.pow(cfg.hi / cfg.lo, Math.max(0, Math.min(1, brightness))),
          t,
          0.08,
        );
      },
      stop() {
        if (stopped || !ctx) return;
        stopped = true;
        g.gain.setTargetAtTime(0, ctx.currentTime, 0.05);
        setTimeout(() => {
          src.stop();
          g.disconnect();
        }, 300);
      },
    };
  },
};

const LOOPS: Record<
  LoopKind,
  { type: BiquadFilterType; q: number; lo: number; hi: number; gain: number }
> = {
  hiss: { type: "highpass", q: 0.7, lo: 1200, hi: 5000, gain: 0.1 },
  rumble: { type: "lowpass", q: 0.8, lo: 180, hi: 1400, gain: 0.35 },
  trickle: { type: "bandpass", q: 0.9, lo: 1500, hi: 6000, gain: 0.9 },
  crackle: { type: "highpass", q: 0.5, lo: 600, hi: 3000, gain: 0.8 },
  bubble: { type: "lowpass", q: 0.5, lo: 900, hi: 3000, gain: 0.3 },
};

type Synth = (
  c: AudioContext,
  out: GainNode,
  t: number,
  pitch: number,
) => number;

function env(
  g: AudioParam,
  t: number,
  peak: number,
  attack: number,
  decay: number,
) {
  g.setValueAtTime(0.0001, t);
  g.exponentialRampToValueAtTime(peak, t + attack);
  g.exponentialRampToValueAtTime(0.0001, t + attack + decay);
}

function osc(
  c: AudioContext,
  type: OscillatorType,
  f0: number,
  f1: number,
  t: number,
  dur: number,
  out: AudioNode,
  peak: number,
  attack = 0.004,
) {
  const o = c.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) o.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain();
  env(g.gain, t, peak, attack, dur);
  o.connect(g).connect(out);
  o.start(t);
  o.stop(t + attack + dur + 0.02);
  return o;
}

function burst(
  c: AudioContext,
  t: number,
  dur: number,
  out: AudioNode,
  peak: number,
  type: BiquadFilterType,
  f0: number,
  f1: number,
  q = 1,
  attack = 0.002,
) {
  const s = c.createBufferSource();
  s.buffer = noise;
  const f = c.createBiquadFilter();
  f.type = type;
  f.Q.value = q;
  f.frequency.setValueAtTime(f0, t);
  if (f1 !== f0) f.frequency.exponentialRampToValueAtTime(f1, t + dur);
  const g = c.createGain();
  env(g.gain, t, peak, attack, dur);
  s.connect(f).connect(g).connect(out);
  s.start(t, Math.random() * 1.5);
  s.stop(t + attack + dur + 0.02);
}

const VOICES: Record<Voice, Synth> = {
  pop(c, out, t, p) {
    osc(c, "sine", 520 * p, 1400 * p, t, 0.06, out, 0.55, 0.002);
    osc(c, "triangle", 1400 * p, 300 * p, t + 0.05, 0.09, out, 0.25);
    burst(c, t, 0.015, out, 0.2, "highpass", 3000, 3000);
    return 0.16;
  },
  plop(c, out, t, p) {
    osc(c, "sine", 180 * p, 620 * p, t, 0.08, out, 0.6);
    return 0.1;
  },
  squish(c, out, t, p) {
    burst(c, t, 0.16, out, 0.5, "bandpass", 1400 * p, 380 * p, 5, 0.01);
    osc(c, "sine", 140 * p, 90 * p, t, 0.14, out, 0.25, 0.01);
    return 0.18;
  },
  boing(c, out, t, p) {
    // A pitch that wobbles and settles, like the jelly it comes from.
    const o = c.createOscillator();
    o.type = "sine";
    o.frequency.setValueAtTime(190 * p, t);
    const lfo = c.createOscillator();
    lfo.frequency.value = 16;
    const depth = c.createGain();
    depth.gain.setValueAtTime(70 * p, t);
    depth.gain.exponentialRampToValueAtTime(1, t + 0.35);
    lfo.connect(depth).connect(o.frequency);
    const g = c.createGain();
    env(g.gain, t, 0.45, 0.005, 0.35);
    o.connect(g).connect(out);
    o.start(t);
    lfo.start(t);
    o.stop(t + 0.4);
    lfo.stop(t + 0.4);
    return 0.4;
  },
  thud(c, out, t, p) {
    osc(c, "sine", 110 * p, 45 * p, t, 0.16, out, 0.8, 0.003);
    burst(c, t, 0.08, out, 0.35, "lowpass", 500 * p, 150, 0.7);
    return 0.2;
  },
  knock(c, out, t, p) {
    osc(c, "triangle", 620 * p, 480 * p, t, 0.05, out, 0.45, 0.001);
    osc(c, "sine", 1580 * p, 1500 * p, t, 0.03, out, 0.15, 0.001);
    burst(c, t, 0.02, out, 0.25, "bandpass", 2500 * p, 1800, 2, 0.001);
    return 0.08;
  },
  tick(c, out, t, p) {
    osc(c, "square", 2600 * p, 2200 * p, t, 0.012, out, 0.12, 0.001);
    return 0.03;
  },
  snap(c, out, t, p) {
    burst(c, t, 0.03, out, 0.7, "highpass", 2500 * p, 2500, 0.7, 0.001);
    osc(c, "triangle", 1800 * p, 700 * p, t, 0.05, out, 0.3, 0.001);
    return 0.08;
  },
  rip(c, out, t, p) {
    // A quick train of fibre snaps: tearing cloth.
    const n = 7 + Math.floor(Math.random() * 5);
    for (let k = 0; k < n; k++)
      burst(
        c,
        t + k * 0.022 + Math.random() * 0.012,
        0.018,
        out,
        0.35 + Math.random() * 0.3,
        "bandpass",
        (1800 + Math.random() * 1600) * p,
        1200 * p,
        1.5,
        0.001,
      );
    burst(c, t, n * 0.024, out, 0.12, "highpass", 900, 2200, 0.7, 0.01);
    return n * 0.026 + 0.05;
  },
  splash(c, out, t, p) {
    burst(c, t, 0.4, out, 0.5, "lowpass", 5000 * p, 700 * p, 0.8, 0.004);
    for (let k = 0; k < 3; k++)
      osc(
        c,
        "sine",
        (300 + Math.random() * 400) * p,
        (900 + Math.random() * 500) * p,
        t + 0.03 + Math.random() * 0.15,
        0.05,
        out,
        0.18,
      );
    return 0.45;
  },
  whoosh(c, out, t, p) {
    const s = c.createBufferSource();
    s.buffer = noise;
    const f = c.createBiquadFilter();
    f.type = "bandpass";
    f.Q.value = 1.2;
    f.frequency.setValueAtTime(300 * p, t);
    f.frequency.exponentialRampToValueAtTime(1600 * p, t + 0.14);
    f.frequency.exponentialRampToValueAtTime(400 * p, t + 0.32);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.4, t + 0.13);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.34);
    s.connect(f).connect(g).connect(out);
    s.start(t, Math.random());
    s.stop(t + 0.36);
    return 0.36;
  },
  crumble(c, out, t, p) {
    const n = 6 + Math.floor(Math.random() * 6);
    for (let k = 0; k < n; k++)
      burst(
        c,
        t + Math.random() * 0.22,
        0.04 + Math.random() * 0.06,
        out,
        0.2 + Math.random() * 0.3,
        "lowpass",
        (500 + Math.random() * 1400) * p,
        250,
        0.8,
        0.002,
      );
    osc(c, "sine", 80 * p, 50 * p, t, 0.2, out, 0.25, 0.01);
    return 0.32;
  },
  sizzle(c, out, t, p) {
    burst(c, t, 0.35, out, 0.25, "highpass", 3500 * p, 5000 * p, 0.7, 0.01);
    return 0.38;
  },
  chime(c, out, t, p) {
    // Rising major arpeggio of soft bells (fundamental plus an inharmonic partial).
    const notes = [1, 1.26, 1.5, 2];
    notes.forEach((m, k) => {
      const f = 880 * p * m;
      osc(c, "sine", f, f, t + k * 0.07, 0.9, out, 0.22, 0.003);
      osc(c, "sine", f * 2.76, f * 2.76, t + k * 0.07, 0.25, out, 0.05, 0.002);
    });
    return 1.2;
  },
};
