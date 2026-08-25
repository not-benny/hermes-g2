import assert from "node:assert/strict";
import test from "node:test";

import { v4, v5, v6 } from "uuid";
import yauzl from "yauzl";

test("uuid rejects partial v5 and v6 writes while preserving v4 generation", () => {
  assert.match(
    v4(),
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );

  assert.throws(
    () => v5("hermes-g2", v5.DNS, new Uint8Array(8), 0),
    (error) =>
      error instanceof RangeError && /out of buffer bounds/.test(error.message),
  );
  assert.throws(
    () => v6({}, new Uint8Array(16), 1),
    (error) =>
      error instanceof RangeError && /out of buffer bounds/.test(error.message),
  );
});

test("yauzl ignores a truncated NTFS timestamp field instead of crashing", () => {
  const entry = new yauzl.Entry();
  entry.extraFields = [{ id: 0x000a, data: Buffer.alloc(4) }];

  assert.doesNotThrow(() => entry.getLastModDate());
});
