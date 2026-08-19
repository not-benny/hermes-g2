import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Deepgram is a selectable streaming voice provider with a masked key setting", () => {
  const settings = read("app/ui/dashboard-settings.ts");
  const voice = read("app/native/voice-control.ts");
  const client = read("app/native/deepgram-stt.ts");
  const keys = read("app/phone-ui/api-keys-view-model.ts");
  const keysPage = read("app/phone-ui/api-keys-page.xml");

  assert.match(settings, /"deepgram"/);
  assert.match(settings, /deepgramApiKeySetting/);
  assert.match(voice, /DeepgramSttClient/);
  assert.match(voice, /provider === "deepgram"/);
  assert.match(client, /wss:\/\/api\.deepgram\.com\/v1\/listen/);
  assert.match(client, /"Authorization"/);
  assert.match(client, /`Token \$\{this\.options\.apiKey\}`/);
  assert.match(client, /"CloseStream"/);
  assert.match(keys, /deepgramApiKeySetting/);
  assert.match(keysPage, /Deepgram API key/);
  assert.match(keysPage, /secure="true"/);
});
