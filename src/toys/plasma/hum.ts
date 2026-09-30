// Mains hum from the globe's driver: the transformer's magnetostriction buzzes at twice the mains
// frequency (120 Hz on 60 Hz mains) with a stack of harmonics; the discharge loads it, so level and
// brightness follow the total current. A second, noisy band is the corona fizz of the filaments.
import { audioOutput } from '../../shell/sound';

export class Hum {
  private ac: AudioContext | null = null;
  private bus: GainNode | null = null;
  private g: GainNode | null = null;
  private lp: BiquadFilterNode | null = null;
  private o: OscillatorNode | null = null;
  private fizz: GainNode | null = null;
  private src: AudioBufferSourceNode | null = null;

  constructor(mains = 60) {
    const s = audioOutput();
    if (!s) return;
    const ac = (this.ac = s.ctx);
    this.bus = s.bus;
    // Harmonics of the mains: 2f strongest, odd ones from core saturation.
    const N = 16;
    const re = new Float32Array(N + 1), im = new Float32Array(N + 1);
    const amp = [0, 0.25, 1, 0.35, 0.6, 0.2, 0.35, 0.12, 0.22, 0.08, 0.15, 0.05, 0.1, 0.04, 0.07, 0.03, 0.05];
    for (let k = 1; k <= N; k++) im[k] = amp[k];
    const o = (this.o = ac.createOscillator());
    o.setPeriodicWave(ac.createPeriodicWave(re, im));
    o.frequency.value = mains;
    const lp = (this.lp = ac.createBiquadFilter());
    lp.type = 'lowpass';
    lp.frequency.value = 400;
    lp.Q.value = 0.7;
    const g = (this.g = ac.createGain());
    g.gain.value = 0;
    o.connect(lp).connect(g).connect(this.bus);
    o.start();
    // Corona fizz: band-passed noise.
    const n = ac.sampleRate;
    const buf = ac.createBuffer(1, n, n);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    const src = (this.src = ac.createBufferSource());
    src.buffer = buf;
    src.loop = true;
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.frequency.value = 5200;
    bp.Q.value = 0.8;
    const fz = (this.fizz = ac.createGain());
    fz.gain.value = 0;
    src.connect(bp).connect(fz).connect(this.bus);
    src.start();
  }

  /** load 0..1 (total current), fizz 0..1. Call every frame. */
  set(load: number, fizz: number) {
    const ac = this.ac;
    if (!ac || ac.state !== 'running' || !this.g || !this.lp || !this.fizz) return;
    const t = ac.currentTime;
    const l = Math.max(0, Math.min(1, load));
    this.g.gain.setTargetAtTime(0.012 + 0.07 * l, t, 0.05);
    this.lp.frequency.setTargetAtTime(260 + 1600 * l * l, t, 0.05);
    this.fizz.gain.setTargetAtTime(0.03 * Math.max(0, Math.min(1, fizz)), t, 0.04);
  }

  stop() {
    const ac = this.ac;
    if (!ac) return;
    this.g?.gain.setTargetAtTime(0, ac.currentTime, 0.03);
    this.fizz?.gain.setTargetAtTime(0, ac.currentTime, 0.03);
    setTimeout(() => {
      this.o?.stop();
      this.src?.stop();
      this.bus?.disconnect();
    }, 250);
  }
}
