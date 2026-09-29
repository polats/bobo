package com.polats.bobo;

import android.content.pm.ApplicationInfo;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowInsetsController;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        // Debuggable builds only: `adb shell am start -n com.polats.bobo/.MainActivity --es BOBO_TOY goo --ez BOBO_AUTOPLAY true`
        // opens a toy with the autoplay finger, mirroring the iOS launch hooks used by device soaks.
        boolean debuggable = (getApplicationInfo().flags & ApplicationInfo.FLAG_DEBUGGABLE) != 0;
        String toy = getIntent().getStringExtra("BOBO_TOY");
        boolean autoplay = getIntent().getBooleanExtra("BOBO_AUTOPLAY", false);
        if (debuggable && (toy != null || autoplay)) {
            final String js = (autoplay ? "window.boboAutoplay = true;" : "")
                + (toy != null && toy.matches("[a-z0-9-]+") ? "location.hash = '" + toy + "';"
                    // No toy: re-route so the hub remounts and sees the autoplay flag.
                    : "window.dispatchEvent(new HashChangeEvent('hashchange'));");
            getBridge().getWebView().postDelayed(() -> getBridge().getWebView().evaluateJavascript(js, null), 1500);
        }
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (!hasFocus) return;
        // Full-screen toys: hide the status and navigation bars; a swipe brings them back briefly.
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController c = getWindow().getInsetsController();
            if (c != null) {
                c.hide(WindowInsets.Type.statusBars() | WindowInsets.Type.navigationBars());
                c.setSystemBarsBehavior(WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
            }
        } else {
            getWindow().getDecorView().setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY | View.SYSTEM_UI_FLAG_FULLSCREEN | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                    | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION | View.SYSTEM_UI_FLAG_LAYOUT_STABLE);
        }
    }
}
