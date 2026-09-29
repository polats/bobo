import type { Panel } from './panel';
import type { Pointers } from './pointers';
import type { Sound } from './sound';
import type { Mic } from './mic';

export interface ToyContext {
  canvas: HTMLCanvasElement;
  /** Container for toy-owned overlay UI (docks, notices). */
  overlay: HTMLElement;
  panel: Panel;
  pointers: Pointers;
  /** Render-resolution multiplier on top of CSS pixels, already capped for the device. */
  pixelRatio: number;
  /** Short status text shown under the FPS meter (e.g. particle count). */
  setStatus(text: string): void;
  /** Procedural sound effects and loops (src/shell/sound.ts); silent when muted or locked. */
  sound: Sound;
  /** Light haptic tick on impacts; no-op where unsupported. */
  haptic(strength?: 'light' | 'medium' | 'heavy'): void;
  /**
   * Continuous vibration for this frame: intensity 0..1, sharpness 0 (rumble) .. 1 (crisp). Call every
   * frame it should run; skip a frame and it stops. Core Haptics on iOS, the best Android tier, or
   * pulses in the browser.
   */
  hapticLevel(intensity: number, sharpness?: number): void;
  /**
   * Microphone features (blow, level, pitch). Nothing listens until the player opts in: call
   * `offer(hint)` to show the mic button in the HUD; the shell stops listening when the toy closes.
   */
  mic: Mic & { offer(hint: string): void };
  /**
   * Shared completion meter (a ring at the top of the screen). Pass 0..1 with an optional label
   * ("clean", "revealed"); pass null to hide it. Cheap to call every frame.
   */
  progress(fraction: number | null, label?: string): void;
  /** One-shot "done!" payoff: confetti burst, chime-ready hook, heavy haptic. Optional message. */
  celebrate(message?: string): void;
}

export interface ToyInstance {
  /** dt is clamped seconds since last frame; t is seconds since start. */
  frame(dt: number, t: number): void;
  /** Called with the canvas size in device pixels whenever the stage changes size. */
  resize(width: number, height: number): void;
  destroy(): void;
}

/** A paper, talk or reference implementation a toy is built on. */
export interface Reference {
  /** Short credit shown on the hub card, e.g. "Stam 1999". */
  short: string;
  title: string;
  url: string;
  /** What the toy takes from it. */
  use: string;
}

export interface Toy {
  id: string;
  title: string;
  blurb: string;
  tech: string;
  swatch: string;
  refs: Reference[];
  create(ctx: ToyContext): Promise<ToyInstance>;
}
