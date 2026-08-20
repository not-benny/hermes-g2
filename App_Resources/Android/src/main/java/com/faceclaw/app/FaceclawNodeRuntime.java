package com.faceclaw.app;

import android.content.Context;
import android.content.res.AssetManager;
import android.util.Log;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;

/**
 * Hosts an embedded Node.js runtime (nodejs-mobile libnode.so) that runs the
 * WhatsApp engine. The Node project is bundled under assets/whatsapp-node,
 * unpacked to the app's private files dir on first run, and started on its own
 * thread. Node exposes a 127.0.0.1 loopback HTTP server (bearer-token guarded)
 * that the NativeScript layer talks to.
 */
public final class FaceclawNodeRuntime {
    private static final String TAG = "FaceclawNode";
    private static final String ASSET_DIR = "whatsapp-node";

    static {
        // libnode.so must load first (node-bridge links against it).
        System.loadLibrary("node");
        System.loadLibrary("node-bridge");
    }

    private static FaceclawNodeRuntime instance;
    private boolean started = false;
    private int port = -1;

    public static synchronized FaceclawNodeRuntime getInstance() {
        if (instance == null) {
            instance = new FaceclawNodeRuntime();
        }
        return instance;
    }

    private FaceclawNodeRuntime() {}

    /** Native entry: builds argv and calls node::Start (blocks until Node exits). */
    private native int nativeStartNode(String[] arguments);

    public synchronized boolean isStarted() {
        return started;
    }

    public synchronized int getPort() {
        return port;
    }

    /**
     * Unpack the Node project and start it on a background thread. Idempotent:
     * a second call while running is a no-op.
     */
    public synchronized void start(Context context, int port, String token) {
        if (started) {
            Log.i(TAG, "node runtime already started on port " + this.port);
            return;
        }
        this.port = port;
        final File projectDir;
        try {
            projectDir = unpackProject(context);
        } catch (IOException e) {
            Log.e(TAG, "failed to unpack node project", e);
            return;
        }
        final String mainJs = new File(projectDir, "main.js").getAbsolutePath();
        final String portArg = Integer.toString(port);
        final String tokenArg = token == null ? "" : token;
        started = true;

        Thread thread = new Thread(new Runnable() {
            @Override public void run() {
                Log.i(TAG, "starting node: " + mainJs + " --port " + portArg);
                int code = nativeStartNode(new String[] {
                    "node", mainJs, "--port", portArg, "--token", tokenArg
                });
                Log.w(TAG, "node runtime exited with code " + code);
                synchronized (FaceclawNodeRuntime.this) {
                    started = false;
                }
            }
        }, "faceclaw-node");
        thread.setDaemon(true);
        thread.start();
    }

    /**
     * Copy assets/whatsapp-node into filesDir/whatsapp-node. Overwrites each
     * build so app updates ship a fresh engine; node_modules (added later) are
     * copied the same way.
     */
    private File unpackProject(Context context) throws IOException {
        File dest = new File(context.getFilesDir(), ASSET_DIR);
        copyAssetDir(context.getAssets(), ASSET_DIR, dest);
        return dest;
    }

    private void copyAssetDir(AssetManager assets, String assetPath, File dest) throws IOException {
        String[] children = assets.list(assetPath);
        if (children == null || children.length == 0) {
            // It's a file (or empty). If it opens as a stream, copy it.
            copyAssetFile(assets, assetPath, dest);
            return;
        }
        if (!dest.exists() && !dest.mkdirs()) {
            throw new IOException("could not create " + dest);
        }
        for (String child : children) {
            copyAssetDir(assets, assetPath + "/" + child, new File(dest, child));
        }
    }

    private void copyAssetFile(AssetManager assets, String assetPath, File dest) throws IOException {
        File parent = dest.getParentFile();
        if (parent != null && !parent.exists() && !parent.mkdirs()) {
            throw new IOException("could not create " + parent);
        }
        try (InputStream in = assets.open(assetPath);
             OutputStream out = new FileOutputStream(dest)) {
            byte[] buf = new byte[16 * 1024];
            int n;
            while ((n = in.read(buf)) > 0) {
                out.write(buf, 0, n);
            }
        }
    }
}
