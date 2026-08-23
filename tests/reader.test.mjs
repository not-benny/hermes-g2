import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const source = read("app/apps/files/reader-core.ts");
const js = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const moduleUrl = "data:text/javascript;base64," + Buffer.from(js).toString("base64");

const reader = await import(moduleUrl);

test("reader pagination preserves inert Unicode text across bounded pages", () => {
  const input = "# Heading\nFamily 👨‍👩‍👧‍👦 and café e\u0301\n" + "界".repeat(50);
  const result = reader.paginateReaderText(input, { columns: 12, linesPerPage: 3 });

  assert.equal(result.truncated, false);
  assert.ok(result.pages.length > 1);
  assert.equal(result.normalizedText, input);
  assert.equal(result.pages.flatMap((page) => page.lines).join(""), input);
  for (const page of result.pages) {
    assert.ok(page.lines.length <= 3);
    for (const line of page.lines) {
      assert.ok(line.length <= 24, "line remains bounded without splitting astral code points");
      assert.equal(/[\uD800-\uDBFF]$/.test(line), false);
      assert.equal(/^[\uDC00-\uDFFF]/.test(line), false);
    }
  }
});

test("reader pagination fails closed on malformed and hostile oversized input", () => {
  const hostile = "x".repeat(500_000) + "\ud800<script>remote()</script>";
  const result = reader.paginateReaderText(hostile, {
    columns: 20,
    linesPerPage: 5,
    maxChars: 1_000,
  });

  assert.equal(result.truncated, true);
  assert.equal(Array.from(result.normalizedText).length, 1_000);
  assert.ok(result.pages.length <= 10);
  assert.equal(result.normalizedText.includes("<script>"), false);

  const malformed = reader.paginateReaderText("ok\ud800bad\udc00", { columns: 80, linesPerPage: 5 });
  assert.equal(malformed.normalizedText, "ok�bad�");
});

test("production-width wrapping is linear and bounded for a maximum hostile line", () => {
  let measurements = 0;
  const lines = reader.wrapReaderTextByWidth("x".repeat(500_000), {
    maxWidth: 20,
    maxLines: 100,
    maxChars: 1_000,
    measureCodePoint: () => { measurements++; return 1; },
  });
  assert.equal(lines.truncated, true);
  assert.equal(lines.lines.length, 50);
  assert.equal(lines.lines.join("").length, 1_000);
  assert.equal(measurements, 1_000);
});

test("reader auto-scroll owns one timer and rejects stale callbacks after pause, close, and replacement", () => {
  let nextHandle = 1;
  const callbacks = new Map();
  const cleared = [];
  const scheduler = {
    set(delayMs, callback) {
      assert.ok(delayMs >= 250);
      const handle = nextHandle++;
      callbacks.set(handle, callback);
      return handle;
    },
    clear(handle) {
      cleared.push(handle);
      callbacks.delete(handle);
    },
  };
  const changes = [];
  const session = new reader.ReaderSession(scheduler, (snapshot) => changes.push(snapshot));
  session.open({ documentId: "fixture-a", pageCount: 4, pageIndex: 0 });
  session.setOwnership(true, true);
  session.play();
  assert.equal(callbacks.size, 1);

  const firstCallback = callbacks.values().next().value;
  firstCallback();
  assert.equal(session.snapshot().pageIndex, 1);
  assert.equal(callbacks.size, 1);

  const staleAfterPause = callbacks.values().next().value;
  session.pause();
  staleAfterPause();
  assert.equal(session.snapshot().pageIndex, 1);
  assert.equal(callbacks.size, 0);

  session.play();
  const staleAfterReplacement = callbacks.values().next().value;
  session.open({ documentId: "fixture-b", pageCount: 2, pageIndex: 0 });
  staleAfterReplacement();
  assert.equal(session.snapshot().documentId, "fixture-b");
  assert.equal(session.snapshot().pageIndex, 0);

  session.play();
  const staleAfterClose = callbacks.values().next().value;
  session.close();
  staleAfterClose();
  assert.equal(session.snapshot().open, false);
  assert.equal(callbacks.size, 0);
  assert.ok(cleared.length >= 3);
  assert.ok(changes.length > 0);
});

test("reader ownership loss cancels synchronously and stale callbacks cannot advance", () => {
  let nextHandle = 1;
  const callbacks = new Map();
  const scheduler = {
    set(_delayMs, callback) { const handle = nextHandle++; callbacks.set(handle, callback); return handle; },
    clear(handle) { callbacks.delete(handle); },
  };
  const session = new reader.ReaderSession(scheduler);
  session.open({ documentId: "fixture", pageCount: 3 });
  session.setOwnership(true, true);
  session.play();
  const stale = callbacks.values().next().value;
  session.setOwnership(false, true);
  assert.equal(callbacks.size, 0);
  stale();
  assert.equal(session.snapshot().pageIndex, 0);
  assert.equal(session.snapshot().playing, true);
  session.setOwnership(true, true);
  assert.equal(callbacks.size, 1);
  session.setOwnership(true, false);
  assert.equal(callbacks.size, 0);
});

test("reader progress restart state is minimal, versioned, bounded, and paused", () => {
  const encoded = reader.encodeReaderProgress({
    uri: "content://fixture/document/1",
    pageIndex: 8,
    bookmarkPage: 3,
    fontSize: "medium",
    lineSpacing: "wide",
    speedMs: 900,
  });
  assert.equal(encoded.includes("private fixture body"), false);
  assert.deepEqual(reader.decodeReaderProgress(encoded), {
    uri: "content://fixture/document/1",
    pageIndex: 8,
    bookmarkPage: 3,
    fontSize: "medium",
    lineSpacing: "wide",
    speedMs: 900,
  });
  assert.equal(reader.decodeReaderProgress("{broken"), null);
  assert.equal(reader.decodeReaderProgress(JSON.stringify({ version: 99, uri: "content://old" })), null);
  assert.equal(reader.decodeReaderProgress(JSON.stringify({ version: 1, uri: "file:///broad/path", pageIndex: 1 })), null);
  assert.equal(reader.decodeReaderProgress("x".repeat(10_000)), null);
});

test("reader is reachable from Android SAF and receives foreground, screen, and close lifecycle", () => {
  const phonePage = read("app/phone-ui/main-page.xml");
  const importer = read("app/native/reader-import.ts");
  const layers = read("app/ui/layers.ts");
  const inProcess = read("app/ui/shell/in-process-window.ts");
  const files = read("app/apps/files/files-app.ts") + read("app/apps/files/text-viewer.ts");

  assert.match(phonePage, /Open local document/);
  assert.match(importer, /ACTION_OPEN_DOCUMENT/);
  assert.match(importer, /CATEGORY_OPENABLE/);
  assert.match(importer, /takePersistableUriPermission/);
  assert.match(importer, /const imported = readReaderDocument[\s\S]*takePersistableUriPermission/);
  assert.match(importer, /if \(!mime\)/);
  assert.match(importer, /MAX_READER_IMPORT_BYTES/);
  assert.match(layers, /onForegroundChanged\?/);
  assert.match(layers, /onScreenChanged\?/);
  assert.match(inProcess, /notifyBaseRemoved/);
  assert.match(inProcess, /onForegroundChanged/);
  assert.match(inProcess, /onScreenChanged/);
  assert.match(files, /Start auto-scroll/);
  assert.match(files, /Set bookmark/);
  assert.match(files, /Font:/);
  assert.match(files, /Line spacing:/);
  assert.match(files, /restored !== null && restored\.uri === this\.sourceUri/);
  assert.match(files, /pendingProgressRatio/);
  assert.match(files, /pendingBookmarkRatio/);
});
