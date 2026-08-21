package com.faceclaw.app;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.Looper;
import android.security.keystore.KeyGenParameterSpec;
import android.security.keystore.KeyProperties;
import android.util.Base64;
import android.util.Log;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.KeyStore;
import java.util.concurrent.CopyOnWriteArrayList;

import javax.crypto.Cipher;
import javax.crypto.KeyGenerator;
import javax.crypto.SecretKey;
import javax.crypto.spec.GCMParameterSpec;

/**
 * App settings store shared by every JS isolate (main thread and app
 * workers). Values live in a dedicated SharedPreferences file, distinct from
 * NativeScript's ApplicationSettings file, so this store owns its keys
 * outright (the old TS-side settings were deliberately abandoned, not
 * migrated).
 *
 * Change notifications: each isolate registers one listener from its own
 * thread. The registering thread's Looper is captured, and notifications are
 * posted through it so the JS callback always runs on the isolate's own
 * thread (calling into an isolate from a foreign thread is not allowed).
 * NativeScript worker threads run a message loop, so both the main thread
 * and workers have a Looper; a listener registered from a Looper-less thread
 * is accepted but never notified (it can still read fresh values on demand).
 */
public final class FaceclawSettings {
    private static final String TAG = "FaceclawSettings";
    private static final String PREFS_NAME = "faceclaw_settings";
    private static final String SECURE_PREFS_NAME = "faceclaw_secure_settings";
    private static final String KEYSTORE = "AndroidKeyStore";
    private static final String KEY_ALIAS = "hermes_g2_settings_aes_v1";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static volatile FaceclawSettings instance;

    private final SharedPreferences prefs;
    private final SharedPreferences securePrefs;
    private final CopyOnWriteArrayList<ListenerEntry> listeners = new CopyOnWriteArrayList<>();

    private static final class ListenerEntry {
        final FaceclawSettingsListener listener;
        final Handler handler;

        ListenerEntry(FaceclawSettingsListener listener, Handler handler) {
            this.listener = listener;
            this.handler = handler;
        }
    }

    private FaceclawSettings(Context context) {
        this.prefs = context.getApplicationContext()
                .getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
        this.securePrefs = context.getApplicationContext()
                .getSharedPreferences(SECURE_PREFS_NAME, Context.MODE_PRIVATE);
    }

    /** Initialize (idempotent) and return the singleton. */
    public static FaceclawSettings getInstance(Context context) {
        if (instance == null) {
            synchronized (FaceclawSettings.class) {
                if (instance == null) {
                    instance = new FaceclawSettings(context);
                }
            }
        }
        return instance;
    }

    /** Return the singleton; the main isolate must have initialized it first. */
    public static FaceclawSettings getInstance() {
        FaceclawSettings result = instance;
        if (result == null) {
            throw new IllegalStateException("FaceclawSettings not initialized; call getInstance(context) first");
        }
        return result;
    }

    public String getString(String key, String defaultValue) {
        return prefs.getString(key, defaultValue);
    }

    public void setString(String key, String value) {
        prefs.edit().putString(key, value).apply();
        notifyChanged(key);
    }

    /**
     * Read a Keystore-encrypted setting. A legacy plaintext value is migrated
     * only after the encrypted write commits and decrypts to the same value.
     */
    public synchronized String getSecret(String key, String defaultValue) {
        if (securePrefs.contains(key)) {
            try {
                return decrypt(securePrefs.getString(key, ""));
            } catch (Exception e) {
                Log.w(TAG, "encrypted setting could not be read");
                if (prefs.contains(key)) return prefs.getString(key, defaultValue);
                return defaultValue;
            }
        }
        if (!prefs.contains(key)) return defaultValue;
        String legacy = prefs.getString(key, defaultValue);
        if (setSecretInternal(key, legacy)) {
            try {
                if (legacy.equals(getSecret(key, defaultValue))) {
                    prefs.edit().remove(key).commit();
                }
            } catch (Exception ignored) {
                // Keep the only known-good plaintext copy if verification fails.
            }
        }
        return legacy;
    }

    public synchronized boolean setSecret(String key, String value) {
        boolean stored = setSecretInternal(key, value == null ? "" : value);
        if (stored) {
            prefs.edit().remove(key).commit();
            notifyChanged(key);
        }
        return stored;
    }

    public synchronized boolean removeSecret(String key) {
        boolean secureRemoved = securePrefs.edit().remove(key).commit();
        boolean legacyRemoved = prefs.edit().remove(key).commit();
        if (secureRemoved && legacyRemoved) notifyChanged(key);
        return secureRemoved && legacyRemoved;
    }

    private boolean setSecretInternal(String key, String value) {
        boolean hadPreviousEncrypted = securePrefs.contains(key);
        String previousEncrypted = hadPreviousEncrypted ? securePrefs.getString(key, "") : null;
        boolean replacementCommitted = false;
        try {
            String encrypted = encrypt(value);
            if (!securePrefs.edit().putString(key, encrypted).commit()) return false;
            replacementCommitted = true;
            if (value.equals(decrypt(securePrefs.getString(key, "")))) return true;
        } catch (Exception e) {
            Log.w(TAG, "encrypted setting could not be written");
        }
        if (replacementCommitted) restoreEncryptedValue(key, hadPreviousEncrypted, previousEncrypted);
        return false;
    }

    private void restoreEncryptedValue(String key, boolean hadPreviousEncrypted, String previousEncrypted) {
        SharedPreferences.Editor editor = securePrefs.edit();
        if (hadPreviousEncrypted) editor.putString(key, previousEncrypted);
        else editor.remove(key);
        if (!editor.commit()) Log.w(TAG, "encrypted setting rollback failed");
    }

    private SecretKey getOrCreateSecretKey() throws Exception {
        KeyStore keyStore = KeyStore.getInstance(KEYSTORE);
        keyStore.load(null);
        if (keyStore.containsAlias(KEY_ALIAS)) {
            return ((KeyStore.SecretKeyEntry) keyStore.getEntry(KEY_ALIAS, null)).getSecretKey();
        }
        KeyGenerator generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, KEYSTORE);
        generator.init(new KeyGenParameterSpec.Builder(
                KEY_ALIAS,
                KeyProperties.PURPOSE_ENCRYPT | KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setRandomizedEncryptionRequired(true)
                .build());
        return generator.generateKey();
    }

    private String encrypt(String value) throws Exception {
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey());
        byte[] iv = cipher.getIV();
        byte[] ciphertext = cipher.doFinal(value.getBytes(StandardCharsets.UTF_8));
        ByteBuffer packed = ByteBuffer.allocate(1 + iv.length + ciphertext.length);
        packed.put((byte) iv.length).put(iv).put(ciphertext);
        return Base64.encodeToString(packed.array(), Base64.NO_WRAP);
    }

    private String decrypt(String encoded) throws Exception {
        byte[] packed = Base64.decode(encoded, Base64.NO_WRAP);
        ByteBuffer buffer = ByteBuffer.wrap(packed);
        int ivLength = buffer.get() & 0xff;
        if (ivLength < 12 || ivLength > 32 || buffer.remaining() <= ivLength) {
            throw new IllegalArgumentException("invalid encrypted setting");
        }
        byte[] iv = new byte[ivLength];
        buffer.get(iv);
        byte[] ciphertext = new byte[buffer.remaining()];
        buffer.get(ciphertext);
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(Cipher.DECRYPT_MODE, getOrCreateSecretKey(), new GCMParameterSpec(128, iv));
        return new String(cipher.doFinal(ciphertext), StandardCharsets.UTF_8);
    }

    public boolean getBoolean(String key, boolean defaultValue) {
        return prefs.getBoolean(key, defaultValue);
    }

    public void setBoolean(String key, boolean value) {
        prefs.edit().putBoolean(key, value).apply();
        notifyChanged(key);
    }

    /**
     * Register a change listener. Must be called from the thread whose
     * isolate owns the listener; that thread's Looper is captured for
     * dispatch.
     */
    public void registerListener(FaceclawSettingsListener listener) {
        Looper looper = Looper.myLooper();
        if (looper == null) {
            Log.w(TAG, "settings listener registered from a Looper-less thread; it will never be notified");
        }
        listeners.add(new ListenerEntry(listener, looper != null ? new Handler(looper) : null));
    }

    public void unregisterListener(FaceclawSettingsListener listener) {
        for (ListenerEntry entry : listeners) {
            if (entry.listener == listener) {
                listeners.remove(entry);
            }
        }
    }

    private void notifyChanged(String key) {
        for (ListenerEntry entry : listeners) {
            if (entry.handler == null) continue;
            entry.handler.post(() -> {
                try {
                    entry.listener.onSettingChanged(key);
                } catch (Exception e) {
                    Log.w(TAG, "settings listener failed for key " + key, e);
                }
            });
        }
    }
}
