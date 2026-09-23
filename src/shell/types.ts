import type { Panel } from './panel';
import type { Pointers } from './pointers';

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
  /** Light haptic tick on impacts; no-op where unsupported. */
  haptic(strength?: 'light' | 'medium' | 'heavy'): void;
}

export interface ToyInstance {
  /** dt is clamped seconds since last frame; t is seconds since start. */
  frame(dt: number, t: number): void;
  /** Called with the canvas size in device pixels whenever the stage changes size. */
  resize(width: number, height: number): void;
  destroy(): void;
}

export interface Toy {
  id: string;
  title: string;
  blurb: string;
  tech: string;
  swatch: string;
  create(ctx: ToyContext): Promise<ToyInstance>;
}
