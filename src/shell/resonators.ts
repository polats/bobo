// A pool of damped resonators on the audio thread, excited by simulation events. Every voice is a
// decaying complex rotation (one multiply per sample, no oscillators or envelopes to schedule), so a
// splash can spawn dozens of bubbles and a collapse dozens of rings without allocating audio nodes.
// Kinds of excitation:
//   ring  — one mode of a struck object: frequency, amplitude, time to -60 dB (modal synthesis,
//           van den Doel & Pai; FoleyAutomatic, SIGGRAPH 2001);
//   chirp — the same, with the frequency rising while it decays: a Minnaert bubble, which pitches
//           up as it rises and its surroundings change (van den Doel, "Physically based models for
//           liquid sounds", ACM TAP 2005);
//   slip  — a persistent stick-slip source: a train of slip pulses at a rate set every frame,
//           filtered by two resonators (tape screech, a finger on a wet glass rim).

const SOURCE = /* js */ `
const MAX = 96;
class Resonators extends AudioWorkletProcessor {
  constructor() {
    super();
    // Per voice: state (re, im), per-sample decay r, angular frequency w, its rise per block, pans.
    this.re = new Float64Array(MAX); this.im = new Float64Array(MAX);
    this.r = new Float64Array(MAX); this.w = new Float64Array(MAX); this.dw = new Float64Array(MAX);
    this.gl = new Float64Array(MAX); this.gr = new Float64Array(MAX); this.live = new Uint8Array(MAX);
    this.slips = new Map();
    this.port.onmessage = (e) => { for (const m of e.data) this.take(m); };
  }
  take(m) {
    if (m.k === 'slip') {
      let s = this.slips.get(m.id);
      if (!s) { s = { phase: 0, next: 1, a: [0, 0, 0, 0], level: 0, target: 0 }; this.slips.set(m.id, s); }
      s.target = m.level; s.rate = m.rate; s.f1 = m.f1; s.f2 = m.f2; s.q = m.q; s.pan = m.pan;
      if (m.stop) s.target = 0, s.stop = true;
      return;
    }
    // Take a free voice, or steal the quietest one.
    let v = -1, quiet = Infinity;
    for (let i = 0; i < MAX; i++) {
      if (!this.live[i]) { v = i; break; }
      const e = this.re[i] * this.re[i] + this.im[i] * this.im[i];
      if (e < quiet) { quiet = e; v = i; }
    }
    const sr = sampleRate;
    this.w[v] = 2 * Math.PI * Math.min(m.f, sr * 0.45) / sr;
    // -60 dB after m.d seconds: r^(d*sr) = 1e-3.
    this.r[v] = Math.pow(1e-3, 1 / Math.max(1, m.d * sr));
    // A bubble's pitch rises linearly, f(t) = f0 (1 + chirp t), applied once per 128-sample block.
    this.dw[v] = m.chirp ? this.w[v] * m.chirp * 128 / sr : 0;
    this.re[v] = m.a; this.im[v] = 0;
    const p = Math.max(-1, Math.min(1, m.pan || 0));
    this.gl[v] = Math.cos((p + 1) * Math.PI / 4); this.gr[v] = Math.sin((p + 1) * Math.PI / 4);
    this.live[v] = 1;
  }
  process(_in, outputs) {
    const out = outputs[0], L = out[0], R = out[1] || out[0], n = L.length;
    for (let v = 0; v < MAX; v++) {
      if (!this.live[v]) continue;
      let re = this.re[v], im = this.im[v];
      const w = this.w[v], r = this.r[v];
      const c = r * Math.cos(w), s = r * Math.sin(w), gl = this.gl[v], gr = this.gr[v];
      for (let i = 0; i < n; i++) {
        const nr = re * c - im * s;
        im = re * s + im * c;
        re = nr;
        L[i] += im * gl;
        R[i] += im * gr;
      }
      this.re[v] = re; this.im[v] = im;
      if (this.dw[v]) this.w[v] = Math.min(w + this.dw[v], Math.PI * 0.9);
      if (re * re + im * im < 1e-10) this.live[v] = 0;
    }
    // Stick-slip sources: impulses at a jittered rate into two resonators.
    for (const [id, s] of this.slips) {
      const sr = sampleRate;
      const r = Math.pow(1e-3, 1 / Math.max(1, (s.q || 0.02) * sr));
      const w1 = 2 * Math.PI * s.f1 / sr, w2 = 2 * Math.PI * s.f2 / sr;
      const c1 = r * Math.cos(w1), s1 = r * Math.sin(w1), c2 = r * Math.cos(w2), s2 = r * Math.sin(w2);
      const p = Math.max(-1, Math.min(1, s.pan || 0)), gl = Math.cos((p + 1) * Math.PI / 4), gr = Math.sin((p + 1) * Math.PI / 4);
      let [ar, ai, br, bi] = s.a;
      for (let i = 0; i < n; i++) {
        s.level += (s.target - s.level) * 0.002;
        s.phase += (s.rate || 0) / sr;
        if (s.phase >= s.next && s.level > 1e-4) {
          // Each slip releases a different amount of stored energy: irregular, like real stick-slip.
          const k = s.level * (0.5 + Math.random());
          ar += k; br += k * 0.6;
          s.phase = 0; s.next = 0.75 + Math.random() * 0.5;
        }
        let t = ar * c1 - ai * s1; ai = ar * s1 + ai * c1; ar = t;
        t = br * c2 - bi * s2; bi = br * s2 + bi * c2; br = t;
        const y = (ai + bi) * 0.5;
        L[i] += y * gl; R[i] += y * gr;
      }
      s.a = [ar, ai, br, bi];
      if (s.stop && s.level < 1e-4) this.slips.delete(id);
    }
    return true;
  }
}
registerProcessor('bobo-resonators', Resonators);
`;

export class ResonatorPool {
  private node: AudioWorkletNode | null = null;
  private queue: object[] = [];
  private failed = false;

  constructor(private ctx: AudioContext, out: AudioNode) {
    if (!ctx.audioWorklet) {
      this.failed = true;
      return;
    }
    const url = URL.createObjectURL(new Blob([SOURCE], { type: 'application/javascript' }));
    ctx.audioWorklet
      .addModule(url)
      .then(() => {
        this.node = new AudioWorkletNode(ctx, 'bobo-resonators', { numberOfInputs: 0, outputChannelCount: [2] });
        this.node.connect(out);
        this.flush();
        console.log('[bobo] resonators: audio worklet ready');
      })
      .catch((e) => {
        this.failed = true;
        console.log(`[bobo] resonators unavailable: ${e instanceof Error ? e.message : e}`);
      })
      .finally(() => URL.revokeObjectURL(url));
  }

  get ready() {
    return !!this.node;
  }

  get unavailable() {
    return this.failed;
  }

  /** Batched per frame: toys may fire many events in one step. */
  send(msg: object) {
    this.queue.push(msg);
    // Until the worklet loads, keep only the latest events: stale bubbles are worse than none.
    if (!this.node && this.queue.length > 128) this.queue.splice(0, this.queue.length - 128);
    if (this.queue.length === 1) queueMicrotask(() => this.flush());
  }

  private flush() {
    if (!this.node || !this.queue.length) return;
    this.node.port.postMessage(this.queue);
    this.queue = [];
  }
}
