// Streams the rim simulation's own samples to the speakers. The shell's voices are event-driven
// (rings, slip pulse trains), but a singing glass is one continuous waveform whose every cycle
// comes out of the friction solve, so the toy streams it through a ring-buffer
// worklet. The main thread integrates the sim for the wall-clock time each frame covers and
// posts the block; the worklet resamples it to the device rate and nudges its read speed by at
// most ±0.4% to hold ~60 ms of buffer, so frame jitter never clicks.
import { audioOutput, unlockSound } from '../../shell/sound';

/** The worklet can only be registered once per context; later visits reuse it. */
const loaded = new WeakMap<AudioContext, Promise<void>>();

const WORKLET = /* js */ `
class GlassStream extends AudioWorkletProcessor {
  constructor(o) {
    super();
    const n = 1 << 14;
    this.mask = n - 1;
    this.L = new Float32Array(n);
    this.R = new Float32Array(n);
    this.w = 0;
    this.r = 0;
    this.step = o.processorOptions.src / sampleRate;
    this.target = o.processorOptions.target;
    this.primed = false;
    this.fade = 0;
    this.port.onmessage = (e) => {
      const [l, r] = e.data;
      for (let i = 0; i < l.length; i++) {
        this.L[(this.w + i) & this.mask] = l[i];
        this.R[(this.w + i) & this.mask] = r[i];
      }
      this.w += l.length;
      // Far behind (a stalled tab): drop the backlog rather than play it late.
      if (this.w - this.r > this.mask - 512) this.r = this.w - this.target;
    };
  }
  process(_in, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0];
    let avail = this.w - this.r;
    if (!this.primed && avail >= this.target) this.primed = true;
    const corr = 1 + Math.max(-0.004, Math.min(0.004, ((avail - this.target) / this.target) * 0.004));
    const step = this.step * corr;
    for (let i = 0; i < L.length; i++) {
      avail = this.w - this.r;
      if (!this.primed || avail < 2) {
        this.primed = false;
        this.fade *= 0.995;
        L[i] = R[i] = 0;
        continue;
      }
      this.fade += (1 - this.fade) * 0.01;
      const p = Math.floor(this.r), f = this.r - p;
      const a = p & this.mask, b = (p + 1) & this.mask;
      // Soft limiter: a glass near breaking is loud, but never clips.
      L[i] = Math.tanh(this.L[a] + (this.L[b] - this.L[a]) * f) * this.fade;
      R[i] = Math.tanh(this.R[a] + (this.R[b] - this.R[a]) * f) * this.fade;
      this.r += step;
    }
    return true;
  }
}
registerProcessor('glass-stream', GlassStream);
`;

export class GlassAudio {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private out: GainNode | null = null;
  private readonly unlock = () => unlockSound();

  constructor(private src: number, private el: HTMLElement) {
    // The shell's shared output: mute, compressor and the mic's echo suppression all see the glass.
    const shared = audioOutput();
    if (!shared || !shared.ctx.audioWorklet) return;
    const c = (this.ctx = shared.ctx);
    this.out = shared.bus;
    this.out.gain.value = 0.9;
    let ready = loaded.get(c);
    if (!ready) {
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      ready = c.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
      loaded.set(c, ready);
    }
    ready
      .then(() => {
        if (!this.ctx || !this.out) return;
        this.node = new AudioWorkletNode(c, 'glass-stream', {
          numberOfInputs: 0,
          outputChannelCount: [2],
          processorOptions: { src, target: Math.round(src * 0.06) },
        });
        this.node.connect(this.out);
      })
      .catch((e) => console.log(`[bobo] glass audio unavailable: ${e instanceof Error ? e.message : e}`));
    // Browsers only start audio from a gesture.
    el.addEventListener('pointerdown', this.unlock);
  }

  /** True when blocks sent now will be heard. */
  get live() {
    return !!this.node && this.ctx?.state === 'running';
  }

  push(L: Float32Array, R: Float32Array) {
    if (!this.live) return;
    // Copies: the sim reuses its buffers every frame.
    const l = L.slice(), r = R.slice();
    this.node!.port.postMessage([l, r], [l.buffer, r.buffer]);
  }

  destroy() {
    this.el.removeEventListener('pointerdown', this.unlock);
    this.node?.disconnect();
    this.node = null;
    // The context is the shell's: disconnect this toy's bus, never close it.
    this.out?.disconnect();
    this.out = null;
    this.ctx = null;
  }
}
