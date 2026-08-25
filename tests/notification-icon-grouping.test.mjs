import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const source = new URL(
  "../App_Resources/Android/src/main/java/com/faceclaw/app/NotificationIconSourceGrouper.java",
  import.meta.url,
);
const service = readFileSync(
  new URL("../App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java", import.meta.url),
  "utf8",
);

test("HUD notification sources choose one newest representative per app deterministically", () => {
  const directory = mkdtempSync(join(tmpdir(), "hermes-notification-icon-groups-"));
  const packageDir = join(directory, "com", "faceclaw", "app");
  const harnessPath = join(directory, "NotificationIconSourceGrouperHarness.java");
  writeFileSync(harnessPath, `
package com.faceclaw.app;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;

public final class NotificationIconSourceGrouperHarness {
    private static NotificationIconSourceGrouper.Candidate<String> item(
            String app, long time, String key, String value) {
        return new NotificationIconSourceGrouper.Candidate<>(app, time, key, value);
    }

    private static void requireEqual(List<String> actual, String... expected) {
        List<String> wanted = Arrays.asList(expected);
        if (!actual.equals(wanted)) {
            throw new AssertionError("expected " + wanted + " but got " + actual);
        }
    }

    private static List<String> resolveWithFailures(
            List<NotificationIconSourceGrouper.Candidate<String>> input, int limit, final List<String> attempts) {
        return NotificationIconSourceGrouper.selectNewestAvailablePerPackage(
            input,
            limit,
            new NotificationIconSourceGrouper.Resolver<String, String>() {
                @Override
                public String resolve(String value) {
                    attempts.add(value);
                    if (value.equals("mail-new") || value.startsWith("calendar")) {
                        return null;
                    }
                    return "icon:" + value;
                }
            }
        );
    }

    public static void main(String[] args) {
        List<NotificationIconSourceGrouper.Candidate<String>> input = new ArrayList<>();
        input.add(item("com.z.mail", 100, "mail-old", "mail-old"));
        input.add(item("com.m.chat", 200, "chat-z", "chat-z"));
        input.add(item("com.z.mail", 300, "mail-new", "mail-new"));
        input.add(item("com.a.calendar", 200, "calendar", "calendar"));
        input.add(item("com.m.chat", 200, "chat-a", "chat-a"));
        input.add(item("com.a.calendar", 150, "calendar-old", "calendar-old"));
        input.add(item("  ", 999, "blank", "blank"));
        input.add(new NotificationIconSourceGrouper.Candidate<>(null, 999, "null-app", "null-app"));
        input.add(new NotificationIconSourceGrouper.Candidate<>("com.null.value", 999, "null-value", null));
        input.add(null);

        requireEqual(
            NotificationIconSourceGrouper.selectNewestPerPackage(input, 10),
            "mail-new", "calendar", "chat-a"
        );
        requireEqual(
            NotificationIconSourceGrouper.selectNewestPerPackage(input, 2),
            "mail-new", "calendar"
        );
        requireEqual(NotificationIconSourceGrouper.selectNewestPerPackage(input, 0));
        requireEqual(NotificationIconSourceGrouper.selectNewestPerPackage(null, 5));

        List<String> attempts = new ArrayList<>();
        requireEqual(resolveWithFailures(input, 2, attempts), "icon:mail-old", "icon:chat-a");
        requireEqual(attempts, "mail-new", "mail-old", "calendar", "calendar-old", "chat-a");

        Collections.reverse(input);
        requireEqual(
            NotificationIconSourceGrouper.selectNewestPerPackage(input, 10),
            "mail-new", "calendar", "chat-a"
        );
        attempts.clear();
        requireEqual(resolveWithFailures(input, 2, attempts), "icon:mail-old", "icon:chat-a");
        requireEqual(attempts, "mail-new", "mail-old", "calendar", "calendar-old", "chat-a");
    }
}
`);

  try {
    const compile = spawnSync("javac", ["-d", directory, source.pathname, harnessPath], { encoding: "utf8" });
    assert.equal(compile.status, 0, compile.stderr || compile.stdout);
    const run = spawnSync("java", ["-cp", directory, "com.faceclaw.app.NotificationIconSourceGrouperHarness"], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr || run.stdout);
  } finally {
    rmSync(packageDir, { recursive: true, force: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("only the compact HUD icon path groups by package; notification list identity remains intact", () => {
  const iconMethod = service.slice(
    service.indexOf("public static byte[] getActiveNotificationIconGrays"),
    service.indexOf("public static byte[] getNotificationIconGrayForKey"),
  );
  assert.match(iconMethod, /shouldShowNotificationIcon\(service, statusBarNotification\)/);
  assert.match(iconMethod, /statusBarNotification\.getPackageName\(\)/);
  assert.match(iconMethod, /statusBarNotification\.getPostTime\(\)/);
  assert.match(iconMethod, /statusBarNotification\.getKey\(\)/);
  assert.match(iconMethod, /NotificationIconSourceGrouper\.selectNewestAvailablePerPackage/);
  assert.match(iconMethod, /Drawable drawable = loadNotificationIcon/);
  assert.match(iconMethod, /drawable == null \? null : new ResolvedNotificationIcon/,
    "a failed newest drawable must ask the grouper for the next notification from that package");
  assert.match(iconMethod, /for \(ResolvedNotificationIcon representative : representatives\)/);
  assert.doesNotMatch(iconMethod, /getGroupKey|getOverrideGroupKey/,
    "Android group membership must not permit duplicate icons from an ungrouped app");

  const listMethod = service.slice(
    service.indexOf("public static String getActiveNotificationsJson"),
    service.indexOf("public static String getNotificationJsonForKey"),
  );
  assert.doesNotMatch(listMethod, /NotificationIconSourceGrouper|emittedPackages|packageName.*contains/);
  assert.match(listMethod, /out\.put\(buildNotificationJson\(service, statusBarNotification\)\)/,
    "each eligible live notification must remain independently available in list/detail views");
});
