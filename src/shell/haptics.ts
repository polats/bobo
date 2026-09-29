// Continuous haptics: toys call `level(intensity, sharpness)` every frame they want a buzz (a jet
// running, a mower under load, yarn reeling in), and the shell sends the latest value to the native
// BoboHaptics plugin at most ~30 times a second. A frame without a call means "off", so a toy can't
// leave the motor running by forgetting to stop it. Taps and hits stay on ctx.haptic().
import { Capacitor, registerPlugin } from '@capacitor/core';

interface BoboHapticsPlugin {
  level(o: { intensity: number; sharpness: number }): Promise<void>;
  info(): Promise<{ tier: string; continuous: boolean }>;
}

const native = Capacitor.isNativePlatform() ? registerPlugin<BoboHapticsPlugin>('BoboHaptics') : null;
const SEND_EVERY = 1000 / 30;

let want = 0;
let wantSharp = 0.5;
let sent = 0;
let sentSharp = 0.5;
let lastSend = 0;
let lastBuzz = 0;

/** This frame's continuous level, 0..1; sharpness 0 = deep rumble, 1 = crisp buzz. The strongest call wins. */
export function hapticLevel(intensity: number, sharpness = 0.5) {
  const i = Math.max(0, Math.min(1, intensity));
  if (i >= want) {
    want = i;
    wantSharp = Math.max(0, Math.min(1, sharpness));
  }
}

/** Called once per frame by the toy host, after the toy's frame. */
export function hapticFrame(now: number) {
  const i = want, s = wantSharp;
  want = 0;
  if (native) {
    const off = i < 0.02;
    const moved = Math.abs(i - sent) > 0.03 || Math.abs(s - sentSharp) > 0.1;
    if ((off && sent === 0) || (!moved && !off) || (now - lastSend < SEND_EVERY && !(off && sent > 0))) return;
    sent = off ? 0 : i;
    sentSharp = s;
    lastSend = now;
    native.level({ intensity: sent, sharpness: s }).catch(() => {});
  } else if (i > 0.12 && navigator.vibrate) {
    // Browsers can only switch the motor on and off: pulse faster the stronger it is.
    if (now - lastBuzz > 150 - 110 * i) {
      lastBuzz = now;
      navigator.vibrate(Math.round(6 + 10 * i));
    }
  }
}

/** Stop any continuous buzz (toy closed, page hidden). */
export function hapticStop() {
  want = 0;
  if (native && sent > 0) native.level({ intensity: 0, sharpness: 0.5 }).catch(() => {});
  sent = 0;
}

/** Which haptics tier the device gives us, for the debug log. */
export async function hapticTier() {
  if (!native) return 'vibrate' in navigator ? 'web-vibrate' : 'none';
  try {
    return (await native.info()).tier;
  } catch {
    return 'none';
  }
}
