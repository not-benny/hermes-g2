import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("the Even cloud client signs requests and reads synced ring health", () => {
  const api = read("app/native/even-api.ts");

  // Correct host + endpoints for login and the latest-health read.
  assert.match(api, /https:\/\/api\.evenrealities\.com/);
  assert.match(api, /"\/v2\/g\/login"/);
  assert.match(api, /"\/v2\/g\/health\/get_latest_data"/);

  // HMAC-SHA256 signing + AES password encryption go through native crypto.
  assert.match(api, /FaceclawEvenCrypto\.hmacSha256Base64/);
  assert.match(api, /FaceclawEvenCrypto\.aesCbcEncryptBase64/);
  assert.match(api, /function buildCanonicalString/);

  // Login stores a token and health fetches auto-(re)login.
  assert.match(api, /evenAuthTokenSetting\.set\(token\)/);
  assert.match(api, /export async function evenGetLatestHealth/);
});

test("native crypto helper provides HMAC-SHA256 and AES-256-CBC", () => {
  const java = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawEvenCrypto.java");
  assert.match(java, /HmacSHA256/);
  assert.match(java, /AES\/CBC\/PKCS5Padding/);
  assert.match(java, /hmacSha256Base64/);
  assert.match(java, /aesCbcEncryptBase64/);
});

test("Even Health has a phone screen wired into the app", () => {
  const vm = read("app/phone-ui/even-health-view-model.ts");
  const xml = read("app/phone-ui/even-health-page.xml");
  const main = read("app/phone-ui/main-view-model.ts");
  const mainXml = read("app/phone-ui/main-page.xml");

  assert.match(vm, /onSignInTap|evenLogin/);
  assert.match(vm, /onFetchHealthTap|evenGetLatestHealth/);
  assert.match(xml, /Fetch latest health/);
  assert.match(main, /navigate\("phone-ui\/even-health-page"\)/);
  assert.match(mainXml, /onEvenHealthTap/);
});
