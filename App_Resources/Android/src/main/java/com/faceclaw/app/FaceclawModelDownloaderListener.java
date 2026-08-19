package com.faceclaw.app;

/** Progress callbacks for FaceclawModelDownloader, posted to the creating thread's Looper. */
public interface FaceclawModelDownloaderListener {
    void onProgress(long bytesDownloaded, long totalBytes);

    /** The file is fully downloaded, verified, and moved to its final path. */
    void onDone(String path);

    void onError(String message);
}
