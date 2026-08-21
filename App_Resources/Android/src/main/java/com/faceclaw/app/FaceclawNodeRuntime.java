package com.faceclaw.app;

import android.content.Context;
import android.content.pm.PackageManager;
import android.util.Log;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileOutputStream;
import java.io.FileReader;
import java.io.FileWriter;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * Hosts an embedded Node.js runtime (nodejs-mobile libnode.so) that runs the
 * WhatsApp engine. The Node project is bundled under assets/whatsapp-node,
 * unpacked to the app's private files dir on first run, and started on its own
 * thread. Node exposes a 127.0.0.1 loopback HTTP server (bearer-token guarded)
 * that the NativeScript layer talks to.
 */
public final class FaceclawNodeRuntime {
    private static final String TAG = "FaceclawNode";
    private static final String ASSET_ZIP = "whatsapp-node.zip";
    private static final String PROJECT_DIR = "whatsapp-node";

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
        // boot.js installs globalThis.crypto (WebCrypto) then imports main.js.
        final String mainJs = new File(projectDir, "boot.js").getAbsolutePath();
        final String portArg = Integer.toString(port);
        final String tokenArg = token == null ? "" : token;
        // App-private, persistent WhatsApp session (Android has no usable $HOME).
        final File sessionDir = new File(context.getFilesDir(), "whatsapp/session");
        sessionDir.mkdirs();
        final String sessionArg = sessionDir.getAbsolutePath();
        started = true;

        Thread thread = new Thread(new Runnable() {
            @Override public void run() {
                Log.i(TAG, "starting node: " + mainJs + " --port " + portArg);
                int code = nativeStartNode(new String[] {
                    "node", mainJs, "--port", portArg, "--token", tokenArg, "--session", sessionArg
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
     * Unzip assets/whatsapp-node.zip (the engine + its node_modules) into
     * filesDir/whatsapp-node. Re-unzips only when the app has been updated
     * (keyed on lastUpdateTime), so normal launches skip the ~33MB extract.
     */
    private File unpackProject(Context context) throws IOException {
        File dest = new File(context.getFilesDir(), PROJECT_DIR);
        File stampFile = new File(dest, ".stamp");
        String stamp = currentStamp(context);

        if (new File(dest, "main.js").exists() && stamp.equals(readStamp(stampFile))) {
            return dest;
        }
        Log.i(TAG, "unpacking whatsapp engine (stamp " + stamp + ")");
        deleteRecursive(dest);
        if (!dest.mkdirs()) throw new IOException("could not create " + dest);
        unzipAsset(context, ASSET_ZIP, dest);
        try (FileWriter w = new FileWriter(stampFile)) { w.write(stamp); }
        return dest;
    }

    private String currentStamp(Context context) {
        try {
            return Long.toString(context.getPackageManager()
                .getPackageInfo(context.getPackageName(), 0).lastUpdateTime);
        } catch (PackageManager.NameNotFoundException e) {
            return "0";
        }
    }

    private String readStamp(File stampFile) {
        if (!stampFile.exists()) return "";
        try (BufferedReader r = new BufferedReader(new FileReader(stampFile))) {
            String line = r.readLine();
            return line == null ? "" : line.trim();
        } catch (IOException e) {
            return "";
        }
    }

    private void unzipAsset(Context context, String assetName, File dest) throws IOException {
        byte[] buf = new byte[64 * 1024];
        try (ZipInputStream zin = new ZipInputStream(context.getAssets().open(assetName))) {
            ZipEntry entry;
            while ((entry = zin.getNextEntry()) != null) {
                File out = new File(dest, entry.getName());
                // Guard against path traversal.
                if (!out.getCanonicalPath().startsWith(dest.getCanonicalPath() + File.separator)) {
                    throw new IOException("bad zip entry: " + entry.getName());
                }
                if (entry.isDirectory()) {
                    out.mkdirs();
                } else {
                    File parent = out.getParentFile();
                    if (parent != null) parent.mkdirs();
                    try (OutputStream os = new FileOutputStream(out)) {
                        int n;
                        while ((n = zin.read(buf)) > 0) os.write(buf, 0, n);
                    }
                }
                zin.closeEntry();
            }
        }
    }

    private void deleteRecursive(File f) {
        if (f == null || !f.exists()) return;
        File[] children = f.listFiles();
        if (children != null) {
            for (File c : children) deleteRecursive(c);
        }
        // Best-effort.
        f.delete();
    }
}
