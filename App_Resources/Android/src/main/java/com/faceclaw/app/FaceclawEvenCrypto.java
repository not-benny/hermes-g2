package com.faceclaw.app;

import java.nio.charset.StandardCharsets;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.Mac;
import javax.crypto.spec.IvParameterSpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * Crypto primitives for the Even cloud API client (see app/native/even-api.ts):
 * HMAC-SHA256 request signing and AES-256-CBC/PKCS5 password encryption, both
 * matching the official com.even.sg app. Keys and IVs are passed as UTF-8
 * strings (the app derives them from string literals the same way). Kept in
 * native code so we use the platform crypto rather than a JS reimplementation.
 */
public final class FaceclawEvenCrypto {
    private FaceclawEvenCrypto() {}

    /** Base64 of HMAC-SHA256(message) keyed by the UTF-8 bytes of key. */
    public static String hmacSha256Base64(String key, String message) {
        return Base64.getEncoder().encodeToString(hmacSha256(key, message));
    }

    /** Lowercase hex of HMAC-SHA256(message) keyed by the UTF-8 bytes of key. */
    public static String hmacSha256Hex(String key, String message) {
        byte[] raw = hmacSha256(key, message);
        StringBuilder sb = new StringBuilder(raw.length * 2);
        for (byte b : raw) {
            int v = b & 0xff;
            sb.append(Character.forDigit(v >>> 4, 16));
            sb.append(Character.forDigit(v & 0x0f, 16));
        }
        return sb.toString();
    }

    private static byte[] hmacSha256(String key, String message) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            return mac.doFinal(message.getBytes(StandardCharsets.UTF_8));
        } catch (Exception e) {
            throw new RuntimeException("HMAC-SHA256 failed: " + e.getMessage(), e);
        }
    }

    /**
     * AES-256-CBC / PKCS5 encrypt of plaintext, returned base64. key and iv are
     * UTF-8 strings; the key must be 32 bytes and the iv 16 bytes (the caller
     * derives them exactly as the app does).
     */
    public static String aesCbcEncryptBase64(String key, String iv, String plaintext) {
        try {
            Cipher cipher = Cipher.getInstance("AES/CBC/PKCS5Padding");
            cipher.init(
                Cipher.ENCRYPT_MODE,
                new SecretKeySpec(key.getBytes(StandardCharsets.UTF_8), "AES"),
                new IvParameterSpec(iv.getBytes(StandardCharsets.UTF_8))
            );
            byte[] out = cipher.doFinal(plaintext.getBytes(StandardCharsets.UTF_8));
            return Base64.getEncoder().encodeToString(out);
        } catch (Exception e) {
            throw new RuntimeException("AES-CBC encrypt failed: " + e.getMessage(), e);
        }
    }
}
