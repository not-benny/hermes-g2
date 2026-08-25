import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const dataUrl = (source) => `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`;
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;

const imageStub = dataUrl(`
export class GrayImage {
  constructor(width, height, fill = 0) {
    this.width = width;
    this.height = height;
    this.pixels = new Uint8Array(width * height).fill(fill);
  }
  clone() {
    const copy = new GrayImage(this.width, this.height);
    copy.pixels.set(this.pixels);
    return copy;
  }
}
`);
const timingStub = dataUrl(`
export const logCurrent = () => {};
export const spanCurrent = (_name, action) => action();
`);
const settingsStub = dataUrl(`
export const onSettingsStoreChanged = () => () => {};
`);
const arrayStub = dataUrl(`
export const toUint8Array = (value) => value instanceof Uint8Array ? value : new Uint8Array(value);
`);

function loadNotificationIconsModule() {
  const js = transpile(read("app/native/notification-icons.ts"))
    .replace('"../graphics/image"', JSON.stringify(imageStub))
    .replace('"./frame-timings"', JSON.stringify(timingStub))
    .replace('"./settings-store"', JSON.stringify(settingsStub))
    .replace('"../util/array-util"', JSON.stringify(arrayStub));
  return import(dataUrl(js));
}

test("active notification icon cache refetches on expansion and slices on contraction", async () => {
  const previousAndroid = global.isAndroid;
  const previousCom = global.com;
  const fetchLimits = [];
  let totalIcons = 5;
  global.isAndroid = true;
  global.com = {
    faceclaw: { app: { FaceclawMediaNotificationListenerService: {
      getActiveNotificationIconGrays: (size, limit) => {
        fetchLimits.push(limit);
        const count = Math.min(totalIcons, limit);
        const bytes = new Uint8Array(size * size * count);
        for (let index = 0; index < count; index++) {
          bytes.fill(index + 1, index * size * size, (index + 1) * size * size);
        }
        return bytes;
      },
      dismissNotification: () => true,
    } } },
  };

  try {
    const { dismissNotification, readActiveNotificationIcons } = await loadNotificationIconsModule();

    const narrow = readActiveNotificationIcons(1, false);
    assert.equal(narrow.icons.length, 1);
    assert.deepEqual(fetchLimits, [1]);

    narrow.icons[0].pixels[0] = 99;
    const expanded = readActiveNotificationIcons(3, false);
    assert.equal(expanded.icons.length, 3);
    assert.equal(expanded.icons[0].pixels[0], 1, "callers receive clones, not mutable cache entries");
    assert.deepEqual(fetchLimits, [1, 3], "a low-limit cache entry cannot suppress a wider native fetch");

    const contracted = readActiveNotificationIcons(2.9, false);
    assert.equal(contracted.icons.length, 2);
    assert.deepEqual(fetchLimits, [1, 3], "a wider cache serves and bounds a narrower HUD without refetching");

    const exhaustive = readActiveNotificationIcons(6, false);
    assert.equal(exhaustive.icons.length, 5);
    assert.deepEqual(fetchLimits, [1, 3, 6]);
    assert.equal(readActiveNotificationIcons(10, false).icons.length, 5);
    assert.deepEqual(fetchLimits, [1, 3, 6], "a short native result proves all renderable app groups are cached");

    assert.equal(dismissNotification("notification-key"), true);
    const stale = readActiveNotificationIcons(4, true);
    assert.equal(stale.stale, true);
    assert.equal(stale.icons.length, 4);
    assert.deepEqual(fetchLimits, [1, 3, 6], "allowStale remains non-blocking after invalidation");

    totalIcons = 5;
    assert.equal(readActiveNotificationIcons(4, false).icons.length, 4);
    assert.deepEqual(fetchLimits, [1, 3, 6, 4]);
    assert.equal(readActiveNotificationIcons(Number.NaN, false).icons.length, 0);
    assert.deepEqual(fetchLimits, [1, 3, 6, 4]);
  } finally {
    global.isAndroid = previousAndroid;
    global.com = previousCom;
  }
});
