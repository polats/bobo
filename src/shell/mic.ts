// Microphone input for toys: blow on a fire, blow dust away, sing a note. The native BoboMic plugin
// (iOS AVAudioEngine tap, Android AudioRecord) or, in a browser, getUserMedia + an AnalyserNode,
// yields three raw features per ~25 ms: RMS, pitch and clarity (normalised autocorrelation peak).
// Here they become what toys use: `level` (loudness above the room's noise floor), `blow` (loud and
// unvoiced: breath is turbulent noise) and `pitch` (only when the sound is clearly a note).
// Nothing is recorded or stored; listening stops when the toy closes or the app is backgrounded.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';

interface BoboMicPlugin {
  start(): Promise<{ granted: boolean }>;
  stop(): Promise<void>;
  addListener(event: 'frame', fn: (f: Frame) => void): Promise<PluginListenerHandle>;
}

interface Frame {
  rms: number;
  pitch: number;
  clarity: number;
}

export interface Mic {
  /** True while listening. */
  readonly active: boolean;
  /** Loudness above the room's noise floor, 0..1. */
  readonly level: number;
  /** Breath: loud and unvoiced, 0..1. Smoothed for a quick rise and a short tail. */
  readonly blow: number;
  /** The sung or hummed note in Hz, or 0 when there isn't a clear one. */
  readonly pitch: number;
  /** Ask for permission (first time only) and start listening. Resolves false if refused. */
  start(): Promise<boolean>;
  stop(): void;
}

const native = Capacitor.isNativePlatform() ? registerPlugin<BoboMicPlugin>('BoboMic') : null;

class MicInput implements Mic {
  active = false;
  level = 0;
  blow = 0;
  pitch = 0;
  private floorDb = -60;
  private calib = 0;
  private frames = 0;
  private handle: PluginListenerHandle | null = null;
  private stream: MediaStream | null = null;
  private raf = 0;
  private audio: AudioContext | null = null;

  async start() {
    if (this.active) return true;
    this.calib = 0;
    try {
      if (native) {
        this.handle = await native.addListener('frame', (f) => this.take(f));
        const r = await native.start();
        if (!r.granted) {
          await this.handle.remove();
          this.handle = null;
          return false;
        }
      } else {
        if (!navigator.mediaDevices?.getUserMedia) return false;
        // Raw input: echo cancellation and auto gain would flatten a blow into nothing.
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
        const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        this.audio = new AC();
        const an = this.audio.createAnalyser();
        an.fftSize = 2048;
        this.audio.createMediaStreamSource(this.stream).connect(an);
        const buf = new Float32Array(an.fftSize);
        const rate = this.audio.sampleRate;
        const tick = () => {
          this.raf = requestAnimationFrame(tick);
          an.getFloatTimeDomainData(buf);
          this.take(features(buf, rate));
        };
        tick();
      }
      this.active = true;
      this.frames = 0;
      console.log(`[bobo] mic listening (${native ? 'native' : 'web'})`);
      return true;
    } catch (e) {
      console.log(`[bobo] mic unavailable: ${e instanceof Error ? e.message : e}`);
      this.stop();
      return false;
    }
  }

  stop() {
    this.active = false;
    this.level = this.blow = this.pitch = 0;
    this.handle?.remove();
    this.handle = null;
    native?.stop().catch(() => {});
    cancelAnimationFrame(this.raf);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.audio?.close().catch(() => {});
    this.audio = null;
  }

  /** Last raw frame, for debugging. */
  last: Frame = { rms: 0, pitch: 0, clarity: 0 };

  private take(f: Frame) {
    this.last = f;
    if (++this.frames === 40) console.log(`[bobo] mic: ${Math.round(20 * Math.log10(f.rms + 1e-12))} dB, clarity ${f.clarity.toFixed(2)}`);
    // Near-digital silence (the first buffers, a muted input; no real mic sits below about -85 dB)
    // says nothing about the room: skip it.
    const db = 20 * Math.log10(f.rms + 1e-12);
    if (db < -85) return;
    // The first ~half second measures the room; after that the noise floor follows the quietest
    // recent level: it falls at once and rises slowly.
    if (this.calib < 20) {
      this.floorDb = this.calib++ === 0 ? db : Math.min(this.floorDb, db);
      return;
    }
    // Sound only a little above the floor is the room settling (inputs often fade in): catch up
    // fast. Well above it is a blow or a held note: barely move, so neither fades into the floor.
    const above = db - this.floorDb;
    this.floorDb = Math.max(-90, above < 0 ? db : this.floorDb + (above < 14 ? 0.35 : 0.004));
    const level = Math.max(0, Math.min(1, (db - this.floorDb - 6) / 30));
    this.level += (level - this.level) * 0.5;
    // Breath is noise: loud with little periodicity. A held note is loud but clearly periodic.
    const breath = level * Math.max(0, Math.min(1, (0.75 - f.clarity) / 0.4));
    this.blow = breath > this.blow ? this.blow + (breath - this.blow) * 0.6 : this.blow * 0.82;
    this.pitch = f.clarity > 0.85 && level > 0.15 ? f.pitch : 0;
  }
}

/** Same features as the native plugins, for the browser path. */
function features(x: Float32Array, rate: number): Frame {
  let sum = 0;
  for (let i = 0; i < x.length; i++) sum += x[i] * x[i];
  const rms = Math.sqrt(sum / x.length);
  const n = x.length >> 2;
  const d = new Float32Array(n);
  for (let i = 0; i < n; i++) d[i] = (x[i * 4] + x[i * 4 + 1] + x[i * 4 + 2] + x[i * 4 + 3]) * 0.25;
  const sr = rate / 4;
  const minLag = Math.max(2, Math.floor(sr / 1000)), maxLag = Math.min(n >> 1, Math.floor(sr / 70));
  const m = n - maxLag;
  let e0 = 0;
  for (let i = 0; i < m; i++) e0 += d[i] * d[i];
  if (e0 < 1e-9) return { rms, pitch: 0, clarity: 0 };
  const r = new Float32Array(maxLag + 1);
  let best = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let c = 0, e1 = 0;
    for (let i = 0; i < m; i++) {
      c += d[i] * d[i + lag];
      e1 += d[i + lag] * d[i + lag];
    }
    r[lag] = c / Math.sqrt(e0 * e1 + 1e-12);
    best = Math.max(best, r[lag]);
  }
  // The shortest lag that's nearly as periodic as the best: a note also matches itself at 2x and 3x
  // its period, and taking the overall maximum would read it an octave low.
  let bestLag = 0;
  for (let lag = minLag + 1; lag < maxLag; lag++)
    if (r[lag] >= best * 0.92 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
      bestLag = lag;
      break;
    }
  return { rms, pitch: bestLag ? sr / bestLag : 0, clarity: Math.max(0, best) };
}

export const mic = new MicInput();

if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__mic = mic;
