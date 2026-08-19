package com.faceclaw.app;

import android.graphics.Bitmap;

import java.nio.ByteBuffer;

/**
 * Builds the phone-UI preview bitmap from an 8bpp grayscale frame. The
 * grayscale buffer arrives as a ByteBuffer (NativeScript marshals a JS
 * ArrayBuffer to one without copying element-by-element); doing the
 * gray-to-ARGB expansion here keeps the 165KB-per-frame loop out of the
 * JS/Java bridge, where it used to cost ~150ms per preview.
 */
public final class PreviewBitmapUtil {
    private PreviewBitmapUtil() {}

    public static Bitmap fromGray(ByteBuffer gray, int width, int height, double brightenGamma) {
        if (gray == null || width <= 0 || height <= 0 || gray.remaining() < width * height) {
            throw new IllegalArgumentException("invalid gray preview buffer");
        }
        // The G2 lenses are a monochrome GREEN micro-LED display, so tint the phone
        // preview to match instead of showing grayscale. Each intensity v is scaled
        // onto the Even phosphor-green target #17FF8C (a mint green with a slight
        // teal cast), so black stays black and full-on is bright green. Tune the
        // target here if the green wants to be more sage/neon.
        final int tgtR = 0x17, tgtG = 0xFF, tgtB = 0x8C;
        int[] lut = new int[256];
        for (int g = 0; g < 256; g++) {
            int v = (int) Math.max(0, Math.min(255, Math.round(255 * Math.pow(g / 255.0, brightenGamma))));
            int r = (tgtR * v) / 255;
            int gr = (tgtG * v) / 255;
            int b = (tgtB * v) / 255;
            lut[g] = 0xff000000 | (r << 16) | (gr << 8) | b;
        }
        byte[] bytes = new byte[width * height];
        gray.get(bytes);
        int[] colors = new int[width * height];
        for (int i = 0; i < colors.length; i++) {
            colors[i] = lut[bytes[i] & 0xff];
        }
        return Bitmap.createBitmap(colors, width, height, Bitmap.Config.ARGB_8888);
    }
}
