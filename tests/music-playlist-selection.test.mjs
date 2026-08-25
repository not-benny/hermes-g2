import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const selectionSource = readFileSync("app/apps/music/playlist-selection.ts", "utf8");
const selectionJs = ts.transpileModule(selectionSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { resolvePlayingQueueIndex } = await import(
  `data:text/javascript;base64,${Buffer.from(selectionJs).toString("base64")}`
);

const item = (title, { subtitle = "", active = false } = {}) => ({ title, subtitle, active });

test("playlist entry selects the authoritative active queue row", () => {
  const queue = Array.from({ length: 10 }, (_, index) => item(`Track ${index}`));
  queue[7] = item("Track 7", { active: true });
  assert.equal(resolvePlayingQueueIndex(queue, { title: "Different metadata", artist: "" }), 7);
});

test("playlist entry falls back to normalized current title when active id is unavailable", () => {
  const queue = [item("First"), item("  CURRENT\u00a0 TRACK "), item("Last")];
  assert.equal(resolvePlayingQueueIndex(queue, { title: "current track", artist: "Artist" }), 1);
});

test("duplicate titles use the queue subtitle to match the current artist", () => {
  const queue = [
    item("Intro", { subtitle: "Artist A" }),
    item("Intro", { subtitle: "Artist B" }),
  ];
  assert.equal(resolvePlayingQueueIndex(queue, { title: "INTRO", artist: "artist b" }), 1);
});

test("playlist entry uses a bounded fallback only when current playback is absent", () => {
  const queue = [item("First"), item("Second")];
  assert.equal(resolvePlayingQueueIndex(queue, { title: "Missing", artist: "" }), 0);
  assert.equal(resolvePlayingQueueIndex(queue, { title: "Missing", artist: "" }, 99), 1);
  assert.equal(resolvePlayingQueueIndex([], { title: "Missing", artist: "" }, 99), 0);
});

test("music layer resolves playback on entry and never resets a chosen queue row to zero", () => {
  const musicSource = readFileSync("app/apps/music/music-app.ts", "utf8");
  assert.match(
    musicSource,
    /this\.selectedQueueIndex = resolvePlayingQueueIndex\(queue, media, 0\);[\s\S]*this\.focusColumn = "playlist"/,
  );
  const queueActivation = musicSource.slice(
    musicSource.indexOf('if (this.focusColumn === "playlist")'),
    musicSource.indexOf('if (this.focusColumn === "playlist")') + 3000,
  );
  assert.doesNotMatch(queueActivation, /selectedQueueIndex = 0/);
  assert.doesNotMatch(queueActivation, /queueScrollRow = 0/);
});

test("native queue bridge carries artist subtitle for duplicate-title matching", () => {
  const bridgeSource = readFileSync("app/native/media-controller.ts", "utf8");
  const javaSource = readFileSync(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaController.java",
    "utf8",
  );
  assert.match(bridgeSource, /subtitle: String\(item\.subtitle \?\? ""\)/);
  assert.match(javaSource, /description\.getSubtitle\(\)/);
  assert.match(javaSource, /entry\.put\("subtitle"/);
});
