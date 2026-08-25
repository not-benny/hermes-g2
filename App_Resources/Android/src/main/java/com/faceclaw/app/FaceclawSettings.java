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
import java.util.HashSet;
import java.util.Set;
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
    // Tombstones for integrations removed from the product. Keep these keys
    // here so an upgrade deletes both current encrypted values and every
    // legacy/pending copy instead of orphaning credentials indefinitely.
    private static final String[] RETIRED_SETTING_KEYS = {
            "integrations.roam.graphName",
            "integrations.roam.apiToken",
            "integrations.nightscout.siteUrl",
            "integrations.nightscout.apiToken"
    };
    private static final String[] RETIRED_SECRET_SETTING_KEYS = {
            "integrations.roam.apiToken",
            "integrations.nightscout.apiToken"
    };
    private static volatile FaceclawSettings instance;

    private final SharedPreferences prefs;
    private final SharedPreferences securePrefs;
    private final Set<String> pendingCleanupRequired = new HashSet<>();
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
        purgeRetiredIntegrationSettings();
    }

    /**
     * Idempotent upgrade cleanup. A failed commit is retried on the next
     * process start; no retired value is read, decrypted, or copied.
     */
    private void purgeRetiredIntegrationSettings() {
        boolean cleanupRequired = false;
        for (String key : RETIRED_SETTING_KEYS) {
            if (prefs.contains(key)) cleanupRequired = true;
        }
        for (String key : RETIRED_SECRET_SETTING_KEYS) {
            if (securePrefs.contains(key) || securePrefs.contains(key + ".__pending")) {
                cleanupRequired = true;
            }
        }
        if (!cleanupRequired) return;

        SharedPreferences.Editor plaintext = prefs.edit();
        for (String key : RETIRED_SETTING_KEYS) plaintext.remove(key);

        SharedPreferences.Editor encrypted = securePrefs.edit();
        for (String key : RETIRED_SECRET_SETTING_KEYS) {
            encrypted.remove(key);
            encrypted.remove(key + ".__pending");
        }

        boolean plaintextRemoved = plaintext.commit();
        boolean encryptedRemoved = encrypted.commit();
        if (!plaintextRemoved || !encryptedRemoved) {
            Log.w(TAG, "retired integration cleanup will retry");
        }
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

    public boolean setString(String key, String value) {
        boolean committed = prefs.edit().putString(key, value).commit();
        if (committed) notifyChanged(key);
        return committed;
    }

    public boolean removeString(String key) {
        boolean committed = prefs.edit().remove(key).commit();
        if (committed) notifyChanged(key);
        return committed;
    }

    /**
     * Read a Keystore-encrypted setting. A legacy plaintext value is migrated
     * only after the encrypted write commits and decrypts to the same value.
     */
    public synchronized String getSecret(String key, String defaultValue) {
        String pendingKey = key + ".__pending";
        if (pendingCleanupRequired.contains(key) || securePrefs.contains(pendingKey)) {
            pendingCleanupRequired.add(key);
            if (!securePrefs.edit().remove(pendingKey).commit()) {
                Log.w(TAG, "pending encrypted-setting cleanup will retry");
                // A failed cleanup must not hide a primary value that is
                // already the exact same verified ciphertext. A different
                // pending payload may represent a crash before primary commit,
                // so that ambiguous case still fails closed.
                String primaryCiphertext = securePrefs.getString(key, null);
                String pendingCiphertext = securePrefs.getString(pendingKey, null);
                if (primaryCiphertext == null ||
                        (pendingCiphertext != null && !primaryCiphertext.equals(pendingCiphertext))) {
                    return defaultValue;
                }
            } else {
                pendingCleanupRequired.remove(key);
            }
        }
        if (securePrefs.contains(key)) {
            try {
                String decrypted = decrypt(securePrefs.getString(key, ""));
                if (prefs.contains(key) && !prefs.edit().remove(key).commit()) {
                    Log.w(TAG, "legacy encrypted-setting cleanup will retry");
                }
                return decrypted;
            } catch (Exception e) {
                Log.w(TAG, "encrypted setting could not be read");
                if (prefs.contains(key)) return prefs.getString(key, defaultValue);
                return defaultValue;
            }
        }
        if (!prefs.contains(key)) return defaultValue;
        String legacy = prefs.getString(key, defaultValue);
        if (setSecretInternal(key, legacy)) {
            prefs.edit().remove(key).commit();
        }
        return legacy;
    }

    /**
     * Whether any durable representation of a secret exists. This does not
     * decrypt, log, or return the value; callers use it to distinguish a truly
     * absent key from getSecret's fail-closed default after a read failure.
     */
    public synchronized boolean hasStoredSecret(String key) {
        return securePrefs.contains(key) ||
                securePrefs.contains(key + ".__pending") ||
                prefs.contains(key);
    }

    public synchronized boolean setSecret(String key, String value) {
        boolean stored = setSecretInternal(key, value == null ? "" : value);
        if (stored) {
            // The encrypted primary commit is the write transaction. A stale
            // legacy plaintext copy is cleanup work: getSecret retries its
            // removal, so it must not make callers report that the already
            // durable new value failed to save.
            if (!prefs.edit().remove(key).commit()) {
                Log.w(TAG, "legacy encrypted-setting cleanup will retry");
            }
            notifyChanged(key);
        }
        return stored;
    }

    public synchronized boolean removeSecret(String key) {
        boolean secureRemoved = securePrefs.edit()
                .remove(key)
                .remove(key + ".__pending")
                .commit();
        if (secureRemoved) pendingCleanupRequired.remove(key);
        boolean legacyRemoved = prefs.edit().remove(key).commit();
        if (secureRemoved && legacyRemoved) notifyChanged(key);
        return secureRemoved && legacyRemoved;
    }

    private boolean setSecretInternal(String key, String value) {
        String pendingKey = key + ".__pending";
        try {
            String encrypted = encrypt(value);
            if (!securePrefs.edit().putString(pendingKey, encrypted).commit()) return false;
            pendingCleanupRequired.add(key);
            if (!value.equals(decrypt(securePrefs.getString(pendingKey, "")))) {
                if (securePrefs.edit().remove(pendingKey).commit()) pendingCleanupRequired.remove(key);
                return false;
            }
            if (!securePrefs.edit().putString(key, encrypted).commit()) {
                if (securePrefs.edit().remove(pendingKey).commit()) pendingCleanupRequired.remove(key);
                return false;
            }
            // The verified primary ciphertext is now durable and defines the
            // transaction's success. The pending copy is only a recovery
            // marker: failure to remove it must not report a failed write after
            // callers and restart will observe the committed primary value.
            try {
                if (securePrefs.edit().remove(pendingKey).commit()) {
                    pendingCleanupRequired.remove(key);
                } else {
                    Log.w(TAG, "pending encrypted-setting cleanup will retry");
                }
            } catch (Exception cleanupError) {
                Log.w(TAG, "pending encrypted-setting cleanup will retry");
            }
            return true;
        } catch (Exception e) {
            Log.w(TAG, "encrypted setting could not be written");
            if (securePrefs.edit().remove(pendingKey).commit()) pendingCleanupRequired.remove(key);
            return false;
        }
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
