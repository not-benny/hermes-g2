package com.faceclaw.app;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * Deterministically selects one HUD notification representative per Android
 * package. The full notification list deliberately does not use this helper:
 * grouping is a compact-tray presentation rule, not a loss of notification
 * identity.
 */
public final class NotificationIconSourceGrouper {
    private NotificationIconSourceGrouper() {
    }

    /** Metadata needed to pick a stable representative without Android types. */
    public static final class Candidate<T> {
        private final String packageName;
        private final long postTime;
        private final String stableKey;
        private final T value;

        public Candidate(String packageName, long postTime, String stableKey, T value) {
            this.packageName = packageName == null ? "" : packageName.trim();
            this.postTime = postTime;
            this.stableKey = stableKey == null ? "" : stableKey;
            this.value = value;
        }
    }

    /** Resolve a candidate to a usable representation; null asks for the next candidate in that package. */
    public interface Resolver<T, R> {
        R resolve(T value);
    }

    /**
     * Returns at most {@code maxPackages} values, one per package. A package's
     * newest notification represents it; equal timestamps are resolved by
     * package name and notification key so Android's input-array order cannot
     * change the HUD. The limit therefore counts source apps, not individual
     * notifications.
     */
    public static <T> List<T> selectNewestPerPackage(List<Candidate<T>> candidates, int maxPackages) {
        return selectNewestAvailablePerPackage(candidates, maxPackages, new Resolver<T, T>() {
            @Override
            public T resolve(T value) {
                return value;
            }
        });
    }

    /**
     * Selects one successfully resolved value per package. Packages are ordered
     * by their newest eligible notification, while candidates inside each
     * package are tried newest-first. This preserves source-app ordering and
     * lets a package fall back to an older notification when icon extraction
     * for its newest notification fails. The limit counts successful packages.
     */
    public static <T, R> List<R> selectNewestAvailablePerPackage(
            List<Candidate<T>> candidates, int maxPackages, Resolver<T, R> resolver) {
        List<R> selected = new ArrayList<>();
        if (candidates == null || maxPackages <= 0 || resolver == null) {
            return selected;
        }

        List<Candidate<T>> ordered = new ArrayList<>();
        for (Candidate<T> candidate : candidates) {
            if (candidate == null || candidate.value == null || candidate.packageName.isEmpty()) {
                continue;
            }
            ordered.add(candidate);
        }
        ordered.sort(new Comparator<Candidate<T>>() {
            @Override
            public int compare(Candidate<T> left, Candidate<T> right) {
                int byTime = Long.compare(right.postTime, left.postTime);
                if (byTime != 0) {
                    return byTime;
                }
                int byPackage = left.packageName.compareTo(right.packageName);
                if (byPackage != 0) {
                    return byPackage;
                }
                return left.stableKey.compareTo(right.stableKey);
            }
        });

        Map<String, List<T>> candidatesByPackage = new LinkedHashMap<>();
        for (Candidate<T> candidate : ordered) {
            List<T> packageCandidates = candidatesByPackage.get(candidate.packageName);
            if (packageCandidates == null) {
                packageCandidates = new ArrayList<>();
                candidatesByPackage.put(candidate.packageName, packageCandidates);
            }
            packageCandidates.add(candidate.value);
        }

        for (List<T> packageCandidates : candidatesByPackage.values()) {
            R resolved = null;
            for (T candidate : packageCandidates) {
                resolved = resolver.resolve(candidate);
                if (resolved != null) {
                    break;
                }
            }
            if (resolved == null) {
                continue;
            }
            selected.add(resolved);
            if (selected.size() >= maxPackages) {
                break;
            }
        }
        return selected;
    }
}
