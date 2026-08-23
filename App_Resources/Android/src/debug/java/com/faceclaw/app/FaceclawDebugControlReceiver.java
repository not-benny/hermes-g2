package com.faceclaw.app;

import android.app.Activity;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Bundle;

/** Debug-source-set-only, DUMP-protected ADB entry point. */
public final class FaceclawDebugControlReceiver extends BroadcastReceiver {
    public interface ResultCallback {
        void complete(String receipt);
    }

    public interface Handler {
        void dispatch(String request, ResultCallback callback);
    }

    private static final int MAX_REQUEST_CHARS = 2048;
    private static volatile Handler handler;

    public static void register(Handler next) {
        if (!BuildConfig.DEBUG || next == null) {
            throw new SecurityException("debug control unavailable");
        }
        handler = next;
    }

    public static void unregister() {
        handler = null;
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        if (!BuildConfig.DEBUG) {
            finish("{\"ok\":false,\"code\":\"disabled\"}", Activity.RESULT_CANCELED);
            return;
        }
        if (intent == null || !"com.faceclaw.app.DEBUG_CONTROL_V1".equals(intent.getAction())) {
            finish("{\"ok\":false,\"code\":\"malformed\"}", Activity.RESULT_CANCELED);
            return;
        }
        Bundle extras = intent.getExtras();
        if (extras == null || extras.keySet().size() != 1 || !extras.containsKey("request")) {
            finish("{\"ok\":false,\"code\":\"malformed\"}", Activity.RESULT_CANCELED);
            return;
        }
        Object raw = extras.get("request");
        if (!(raw instanceof String) || ((String) raw).length() == 0 || ((String) raw).length() > MAX_REQUEST_CHARS) {
            finish("{\"ok\":false,\"code\":\"malformed\"}", Activity.RESULT_CANCELED);
            return;
        }
        Handler current = handler;
        if (current == null) {
            finish("{\"ok\":false,\"code\":\"offline\"}", Activity.RESULT_CANCELED);
            return;
        }
        final PendingResult pending = goAsync();
        try {
            current.dispatch((String) raw, receipt -> {
                String bounded = receipt;
                int code = Activity.RESULT_OK;
                if (bounded == null || bounded.length() == 0 || bounded.length() > 1024) {
                    bounded = "{\"ok\":false,\"code\":\"failed\"}";
                    code = Activity.RESULT_CANCELED;
                }
                pending.setResultCode(code);
                pending.setResultData(bounded);
                pending.finish();
            });
        } catch (Throwable ignored) {
            pending.setResultCode(Activity.RESULT_CANCELED);
            pending.setResultData("{\"ok\":false,\"code\":\"failed\"}");
            pending.finish();
        }
    }

    private void finish(String data, int code) {
        setResultCode(code);
        setResultData(data);
    }
}
