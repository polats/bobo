package com.polats.bobo;

import android.content.Context;
import android.os.Build;
import android.os.SystemClock;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Continuous haptics for toys: the page sends an intensity and sharpness every frame and this keeps
 * a vibration running that follows them. It picks the best the device offers:
 *  - Android 16+ with envelope support: short intensity/sharpness envelopes, re-sent before they end,
 *    each ramping from the last level to the new one;
 *  - amplitude control: a looping waveform at the current amplitude (sharp settings become a fast
 *    pulse train, since plain amplitude motors can't change frequency);
 *  - neither: short on/off pulses.
 */
@CapacitorPlugin(name = "BoboHaptics")
public class BoboHapticsPlugin extends Plugin {
    private Vibrator vibrator;
    private boolean on = false;
    private float lastI = 0, lastS = 0.5f;
    private long lastSent = 0;

    @Override
    public void load() {
        Context c = getContext();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            VibratorManager m = (VibratorManager) c.getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            vibrator = m != null ? m.getDefaultVibrator() : null;
        } else {
            vibrator = (Vibrator) c.getSystemService(Context.VIBRATOR_SERVICE);
        }
    }

    private String tier() {
        if (vibrator == null || !vibrator.hasVibrator()) return "none";
        if (Build.VERSION.SDK_INT >= 36 && vibrator.areEnvelopeEffectsSupported()) return "envelope";
        if (vibrator.hasAmplitudeControl()) return "amplitude";
        return "on-off";
    }

    @PluginMethod
    public void info(PluginCall call) {
        JSObject r = new JSObject();
        String t = tier();
        r.put("tier", t);
        r.put("continuous", !t.equals("none"));
        call.resolve(r);
    }

    @PluginMethod(returnType = PluginMethod.RETURN_NONE)
    public void level(PluginCall call) {
        float i = Math.max(0f, Math.min(1f, call.getFloat("intensity", 0f)));
        float s = Math.max(0f, Math.min(1f, call.getFloat("sharpness", 0.5f)));
        String t = tier();
        if (t.equals("none")) return;
        long now = SystemClock.uptimeMillis();
        if (i < 0.02f) {
            if (on) vibrator.cancel();
            on = false;
            lastI = 0;
            return;
        }
        boolean changed = Math.abs(i - lastI) > 0.05f || Math.abs(s - lastS) > 0.15f;
        if (t.equals("envelope")) {
            // Envelopes are finite: re-send well before one ends, or sooner when the level moves.
            if (on && now - lastSent < (changed ? 40 : 160)) return;
            playEnvelope(i, s);
        } else {
            // A looping waveform holds by itself: restart it when the level really changes, and every
            // 300 ms anyway, since a one-shot tap from elsewhere in the app cancels it.
            if (on && ((!changed && now - lastSent < 300) || now - lastSent < 50)) return;
            playWaveform(i, s, t.equals("amplitude"));
        }
        on = true;
        lastI = i;
        lastS = s;
        lastSent = now;
    }

    private void playEnvelope(float i, float s) {
        if (Build.VERSION.SDK_INT < 36) return;
        VibrationEffect e = new VibrationEffect.BasicEnvelopeBuilder()
            .setInitialSharpness(on ? lastS : s)
            .addControlPoint(i, s, 40)   // ramp from wherever we were
            .addControlPoint(i, s, 260)  // hold; replaced by the next send long before this ends
            .addControlPoint(0f, s, 40)  // end at zero, as the platform recommends
            .build();
        vibrator.vibrate(e);
    }

    private void playWaveform(float i, float s, boolean amplitude) {
        int amp = Math.max(1, Math.round(i * 255));
        VibrationEffect e;
        if (!amplitude) {
            // On/off only: a pulse rate that rises with intensity.
            long gap = (long) (120 - 90 * i);
            e = VibrationEffect.createWaveform(new long[] {0, 18, gap}, 1);
        } else if (s > 0.6f) {
            e = VibrationEffect.createWaveform(new long[] {14, 16}, new int[] {amp, 0}, 0);
        } else {
            e = VibrationEffect.createWaveform(new long[] {1000}, new int[] {amp}, 0);
        }
        vibrator.vibrate(e);
    }

    @Override
    protected void handleOnPause() {
        if (vibrator != null && on) vibrator.cancel();
        on = false;
        lastI = 0;
    }
}
