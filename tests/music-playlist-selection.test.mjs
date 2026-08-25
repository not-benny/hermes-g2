import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const selectionSource = readFileSync("app/apps/music/playlist-selection.ts", "utf8");
const selectionJs = ts.transpileModule(selectionSource, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const {
  reconcilePlaylistSelection,
  resolvePlayingQueueIndex,
  selectPlaylistIndex,
} = await import(
  `data:text/javascript;base64,${Buffer.from(selectionJs).toString("base64")}`
);

const item = (title, { id = title, subtitle = "", active = false } = {}) => ({
  id,
  title,
  subtitle,
  active,
});

test("playlist entry selects the authoritative active queue row", () => {
  const queue = Array.from({ length: 10 }, (_, index) => item(`Track ${index}`));
  queue[7] = item("Track 7", { active: true });
  assert.equal(resolvePlayingQueueIndex(queue, { title: "Different metadata", artist: "" }), 7);
});

test("playlist entry falls back to normalized current title when active id is unavailable", () => {
  const queue = [item("First"), item("  CURRENT\u00a0 TRACK "), item("Last")];
  assert.equal(resolvePlayingQueueIndex(queue, { title: "current track", artist: "Artist" }), 1);
});

test("UNKNOWN_ID rows fall through to current metadata instead of selecting the first row", () => {
  const queue = [
    item("First", { id: "-1" }),
    item("Current", { id: "-1", subtitle: "Artist" }),
    item("Last", { id: "-1" }),
  ];
  assert.equal(resolvePlayingQueueIndex(queue, { title: "Current", artist: "Artist" }, 0), 1);
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

test("a stable queue ID keeps manual selection attached across an async reorder", () => {
  const original = [item("A", { id: "10" }), item("B", { id: "20" }), item("C", { id: "30" })];
  const selected = selectPlaylistIndex(original, 2);
  assert.deepEqual(selected, { index: 2, itemId: "30" });

  const reordered = [original[2], original[0], original[1]];
  assert.deepEqual(reconcilePlaylistSelection(reordered, selected), {
    index: 0,
    itemId: "30",
  });
});

test("a transiently missing selected item is retained for the next queue callback", () => {
  const selected = { index: 2, itemId: "9223372036854775806" };
  const transient = [item("A", { id: "10" }), item("B", { id: "20" })];
  assert.deepEqual(reconcilePlaylistSelection(transient, selected), {
    index: 1,
    itemId: "9223372036854775806",
  });

  const restored = [item("Target", { id: "9223372036854775806" }), ...transient];
  assert.deepEqual(reconcilePlaylistSelection(restored, selected), {
    index: 0,
    itemId: "9223372036854775806",
  });
});

test("unknown or duplicate queue IDs do not pretend to be stable identities", () => {
  assert.deepEqual(selectPlaylistIndex([item("A", { id: "-1" })], 0), {
    index: 0,
    itemId: null,
  });
  assert.deepEqual(
    selectPlaylistIndex([item("A", { id: "7" }), item("B", { id: "7" })], 1),
    { index: 1, itemId: null },
  );
});

test("signed 64-bit queue IDs remain exact strings end to end", () => {
  const hugeId = "9223372036854775806";
  assert.equal(selectPlaylistIndex([item("Huge", { id: hugeId })], 0).itemId, hugeId);

  const bridgeSource = readFileSync("app/native/media-controller.ts", "utf8");
  const javaSource = readFileSync(
    "App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawMediaController.java",
    "utf8",
  );
  assert.match(bridgeSource, /id: String\(item\.id \?\? "-1"\)/);
  assert.match(bridgeSource, /skipToQueueItemById\(id\)/);
  assert.match(javaSource, /entry\.put\("id", Long\.toString\(item\.getQueueId\(\)\)\)/);
  assert.match(javaSource, /Long\.parseLong\(queueId\)/);
  assert.match(
    javaSource,
    /activeId != MediaSession\.QueueItem\.UNKNOWN_ID\s*&& item\.getQueueId\(\) == activeId/,
    "unknown active IDs must leave metadata fallback authoritative",
  );
});

test("music layer resolves playback on entry without an unconditional top-row fallback", () => {
  const musicSource = readFileSync("app/apps/music/music-app.ts", "utf8");
  assert.match(
    musicSource,
    /resolvePlayingQueueIndex\(queue, media, retained\.index\)[\s\S]*this\.focusColumn = "playlist"/,
  );
  assert.doesNotMatch(musicSource, /resolvePlayingQueueIndex\(queue, media, 0\)/);
  const queueActivation = musicSource.slice(
    musicSource.indexOf('if (this.focusColumn === "playlist")'),
    musicSource.indexOf('if (this.focusColumn === "playlist")') + 3000,
  );
  assert.doesNotMatch(queueActivation, /selectedQueueIndex = 0/);
  assert.doesNotMatch(queueActivation, /queueScrollRow = 0/);
  assert.match(musicSource, /this\.pendingQueueItemId \?\? this\.selectedQueueItemId/);
  assert.match(musicSource, /this\.pendingQueueItemId = null;[\s\S]*this\.captureQueueSelection\(queue\)/);
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
