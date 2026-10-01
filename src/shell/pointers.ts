export interface PointerState {
  id: number;
  /** Position in canvas UV space: x right, y up, both 0..1. */
  x: number;
  y: number;
  /** Movement since the previous frame in UV units. */
  dx: number;
  dy: number;
  down: boolean;
  /** True only on the first frame after the pointer went down. */
  justDown: boolean;
  /** Seconds the pointer has been held. */
  held: number;
  /** Reported force 0..1 (0.5 on screens that can't sense it). */
  pressure: number;
  /** Contact diameter in CSS px as the screen reports it (1 for a mouse). */
  size: number;
}

/**
 * Multi-touch tracker. Toys read `active` each frame; deltas accumulate between
 * frames so fast swipes are never lost to low frame rates.
 */
export class Pointers {
  readonly active = new Map<number, PointerState>();
  private readonly el: HTMLElement;
  private readonly ups: number[] = [];
  private readonly off: () => void;

  constructor(el: HTMLElement) {
    this.el = el;
    const down = (e: PointerEvent) => {
      el.setPointerCapture?.(e.pointerId);
      const [x, y] = this.uv(e);
      this.active.set(e.pointerId, { id: e.pointerId, x, y, dx: 0, dy: 0, down: true, justDown: true, held: 0, pressure: e.pressure || 0.5, size: Math.max(e.width || 1, e.height || 1) });
    };
    const move = (e: PointerEvent) => {
      const p = this.active.get(e.pointerId);
      if (!p) return;
      const events = e.getCoalescedEvents?.() ?? [e];
      const last = events[events.length - 1] ?? e;
      const [x, y] = this.uv(last);
      p.dx += x - p.x;
      p.dy += y - p.y;
      p.x = x;
      p.y = y;
      p.pressure = last.pressure || p.pressure;
      p.size = Math.max(last.width || 1, last.height || 1);
    };
    const up = (e: PointerEvent) => {
      if (this.active.has(e.pointerId)) this.ups.push(e.pointerId);
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
    this.off = () => {
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
    };
  }

  /** Call once at the end of every frame, after toys have consumed input. */
  endFrame(dt: number) {
    for (const p of this.active.values()) {
      p.dx = 0;
      p.dy = 0;
      p.justDown = false;
      p.held += dt;
    }
    for (const id of this.ups) this.active.delete(id);
    this.ups.length = 0;
  }

  /** Aspect ratio (width / height) of the tracked element. */
  get aspect() {
    const r = this.el.getBoundingClientRect();
    return r.width / Math.max(1, r.height);
  }

  destroy() {
    this.off();
  }

  private uv(e: PointerEvent): [number, number] {
    const r = this.el.getBoundingClientRect();
    return [(e.clientX - r.left) / r.width, 1 - (e.clientY - r.top) / r.height];
  }
}
