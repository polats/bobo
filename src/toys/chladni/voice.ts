// The plate's own sound: one sine per mode (degenerate pairs share one), whose level follows that
// mode's amplitude in the simulation every frame. The shell's modal voice (sound.modes) fires
// one-shot rings that can't be damped or driven afterwards; here a finger pressed on the plate, a bow
// building a resonance or a held note are heard exactly as the sand feels them. A second sine plays
// the forced response at the sung pitch. It plays on the shell's shared output (mute, compressor,
// and the mic's echo suppression all see it).
import { audioOutput, unlockSound } from '../../shell/sound';

export class PlateVoice {
  private ac: AudioContext | null = null;
  private out: GainNode | null = null;
  private oscs: { o: OscillatorNode; g: GainNode; level: number }[] = [];
  private drive: { o: OscillatorNode; g: GainNode; level: number } | null = null;
  private noise: AudioBuffer | null = null;
  private duck = 1;

  constructor() {
    const shared = audioOutput();
    if (shared) {
      this.ac = shared.ctx;
      this.out = shared.bus;
      const n = this.ac.sampleRate * 0.25;
      this.noise = this.ac.createBuffer(1, n, this.ac.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
  }

  /** Browsers start audio only from a gesture: call on pointerdown. */
  wake() {
    unlockSound();
  }

  get running() {
    return this.ac?.state === 'running';
  }

  /** One oscillator per frequency (the plate's mode clusters). */
  setFrequencies(freqs: number[]) {
    const ac = this.ac, out = this.out;
    if (!ac || !out) return;
    for (const v of this.oscs) {
      v.g.gain.setTargetAtTime(0, ac.currentTime, 0.02);
      v.o.stop(ac.currentTime + 0.2);
    }
    this.oscs = freqs.map((f) => {
      const o = ac.createOscillator();
      o.frequency.value = f;
      const g = ac.createGain();
      g.gain.value = 0;
      o.connect(g).connect(out);
      o.start();
      return { o, g, level: 0 };
    });
    if (!this.drive) {
      const o = ac.createOscillator();
      const g = ac.createGain();
      g.gain.value = 0;
      o.connect(g).connect(out);
      o.start();
      this.drive = { o, g, level: 0 };
    }
  }

  /**
   * Levels (linear gain) per oscillator this frame; `attack` for a strike (a near-instant rise).
   * duck < 1 while the mic listens, so the plate doesn't hear itself and ring on forever.
   */
  update(levels: ArrayLike<number>, driveHz: number, driveLevel: number, attack: boolean, duck: number) {
    const ac = this.ac;
    if (!ac || ac.state !== 'running') return;
    this.duck += (duck - this.duck) * 0.1;
    const t = ac.currentTime;
    for (let i = 0; i < this.oscs.length; i++) {
      const v = this.oscs[i];
      const target = (levels[i] ?? 0) * this.duck;
      if (Math.abs(target - v.level) < 1e-5 && target < 1e-4) continue;
      v.g.gain.setTargetAtTime(target, t, attack && target > v.level ? 0.0015 : 0.012);
      v.level = target;
    }
    if (this.drive) {
      if (driveHz > 0) this.drive.o.frequency.setTargetAtTime(driveHz, t, 0.01);
      const target = driveLevel * this.duck;
      this.drive.g.gain.setTargetAtTime(target, t, 0.02);
      this.drive.level = target;
    }
  }

  /** The knock of the fingertip itself: a very short band of noise, brighter for a harder hit. */
  strike(strength: number, pan: number) {
    const ac = this.ac, out = this.out;
    if (!ac || !out || !this.noise || ac.state !== 'running') return;
    const t = ac.currentTime;
    const s = ac.createBufferSource();
    s.buffer = this.noise;
    const f = ac.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 2200 + 2500 * strength;
    f.Q.value = 0.9;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35 * strength, t + 0.0008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);
    let tail: AudioNode = g;
    if (ac.createStereoPanner) {
      const p = ac.createStereoPanner();
      p.pan.value = pan;
      g.connect(p);
      tail = p;
    }
    s.connect(f).connect(g);
    tail.connect(out);
    s.start(t, Math.random() * 0.2);
    s.stop(t + 0.03);
  }

  destroy() {
    // The context is the shell's: fade and disconnect this toy's bus, never close it.
    for (const o of [...this.oscs.map((v) => v.o), this.drive?.o])
      try {
        o?.stop();
      } catch {
        /* already stopped */
      }
    this.out?.disconnect();
    this.ac = null;
  }
}
