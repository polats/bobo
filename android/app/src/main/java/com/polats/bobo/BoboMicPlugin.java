package com.polats.bobo;

import android.Manifest;
import android.media.AudioFormat;
import android.media.AudioRecord;
import android.media.MediaRecorder;
import android.media.audiofx.AcousticEchoCanceler;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * Microphone features for toys (blowing, singing): loudness, pitch and how voiced the sound is,
 * computed on the device from AudioRecord and sent to the page ~30 times a second. Nothing is
 * recorded or stored.
 */
@CapacitorPlugin(name = "BoboMic", permissions = { @Permission(strings = { Manifest.permission.RECORD_AUDIO }, alias = "microphone") })
public class BoboMicPlugin extends Plugin {
    private static final int RATE = 16000;
    private static final int FRAME = 512;
    private volatile boolean running = false;
    private Thread worker;

    @PluginMethod
    public void start(PluginCall call) {
        if (getPermissionState("microphone") != PermissionState.GRANTED) {
            requestPermissionForAlias("microphone", call, "micPermission");
            return;
        }
        begin(call);
    }

    @PermissionCallback
    private void micPermission(PluginCall call) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) begin(call);
        else {
            JSObject r = new JSObject();
            r.put("granted", false);
            call.resolve(r);
        }
    }

    @PluginMethod
    public void stop(PluginCall call) {
        end();
        call.resolve();
    }

    private void begin(PluginCall call) {
        boolean echoCancel = Boolean.TRUE.equals(call.getBoolean("echoCancel", false));
        if (!running) {
            int min = AudioRecord.getMinBufferSize(RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT);
            // UNPROCESSED skips automatic gain and noise suppression, so a harder blow reads louder.
            // Toys listening for singing over their own tone take the voice-call path with the
            // platform's echo canceller instead.
            int source = echoCancel ? MediaRecorder.AudioSource.VOICE_COMMUNICATION
                : android.os.Build.VERSION.SDK_INT >= 24 ? MediaRecorder.AudioSource.UNPROCESSED : MediaRecorder.AudioSource.VOICE_RECOGNITION;
            AudioRecord rec;
            try {
                rec = new AudioRecord(source, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, FRAME * 4));
                if (rec.getState() != AudioRecord.STATE_INITIALIZED) {
                    rec.release();
                    rec = new AudioRecord(MediaRecorder.AudioSource.VOICE_RECOGNITION, RATE, AudioFormat.CHANNEL_IN_MONO, AudioFormat.ENCODING_PCM_16BIT, Math.max(min, FRAME * 4));
                }
            } catch (SecurityException e) {
                call.reject("Microphone permission missing");
                return;
            }
            if (echoCancel && AcousticEchoCanceler.isAvailable()) {
                AcousticEchoCanceler aec = AcousticEchoCanceler.create(rec.getAudioSessionId());
                if (aec != null) aec.setEnabled(true);
            }
            final AudioRecord r = rec;
            running = true;
            worker = new Thread(() -> loop(r), "bobo-mic");
            worker.start();
        }
        JSObject res = new JSObject();
        res.put("granted", true);
        call.resolve(res);
    }

    private void loop(AudioRecord rec) {
        short[] buf = new short[FRAME];
        float[] x = new float[FRAME];
        try {
            rec.startRecording();
            while (running) {
                int n = rec.read(buf, 0, FRAME);
                if (n <= 0) continue;
                for (int i = 0; i < n; i++) x[i] = buf[i] / 32768f;
                double[] f = features(x, n);
                JSObject o = new JSObject();
                o.put("rms", f[0]);
                o.put("pitch", f[1]);
                o.put("clarity", f[2]);
                notifyListeners("frame", o);
            }
        } finally {
            try {
                rec.stop();
            } catch (IllegalStateException ignored) {}
            rec.release();
        }
    }

    private void end() {
        running = false;
        worker = null;
    }

    @Override
    protected void handleOnPause() {
        end();
    }

    /** RMS, and pitch plus clarity from a normalised autocorrelation (70-1000 Hz at 16 kHz). */
    static double[] features(float[] d, int n) {
        double sum = 0;
        for (int i = 0; i < n; i++) sum += d[i] * d[i];
        double rms = Math.sqrt(sum / Math.max(1, n));
        int minLag = RATE / 1000, maxLag = Math.min(n / 2, RATE / 70);
        int m = n - maxLag;
        if (m < 32) return new double[] { rms, 0, 0 };
        double e0 = 0;
        for (int i = 0; i < m; i++) e0 += d[i] * d[i];
        if (e0 < 1e-9) return new double[] { rms, 0, 0 };
        double[] r = new double[maxLag + 1];
        double best = 0;
        for (int lag = minLag; lag <= maxLag; lag++) {
            double c = 0, e1 = 0;
            for (int i = 0; i < m; i++) {
                c += d[i] * d[i + lag];
                e1 += d[i + lag] * d[i + lag];
            }
            r[lag] = c / Math.sqrt(e0 * e1 + 1e-12);
            best = Math.max(best, r[lag]);
        }
        // The shortest lag nearly as periodic as the best, so a note isn't read an octave low.
        int bestLag = 0;
        for (int lag = minLag + 1; lag < maxLag; lag++)
            if (r[lag] >= best * 0.92 && r[lag] >= r[lag - 1] && r[lag] >= r[lag + 1]) {
                bestLag = lag;
                break;
            }
        return new double[] { rms, bestLag > 0 ? (double) RATE / bestLag : 0, Math.max(0, best) };
    }
}
