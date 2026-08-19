import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("media controls trust an active notification listener before a Settings.Secure fallback", () => {
  const listener = read(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaNotificationListenerService.java",
  );
  const media = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaController.java");
  const detector = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawEvenAppDetector.java");

  assert.match(listener, /static boolean isNotificationAccessActive\(\)/);
  assert.match(media, /FaceclawMediaNotificationListenerService\.isNotificationAccessActive\(\)/);
  assert.match(detector, /FaceclawMediaNotificationListenerService\.isNotificationAccessActive\(\)/);
});
