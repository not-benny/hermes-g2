import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Hermes G2 embeds the reviewed 2.2.8.4 fixed firmware patch set", () => {
  const patches = read("app/g2/firmware/cfw-patches.ts");
  assert.match(patches, /"base":\s*"g2_2\.2\.8\.4_stock\.bin"/);
  assert.match(patches, /"baseSha256":\s*"df7b8bd18727765eba73be5ab836e0ee4cfd17b5e680046003b8d608d2fbfda7"/);
  assert.match(patches, /"outputSha256":\s*"bf143aa220d634969fc7ea856716bfccd6cf197fe93f41bec2b87ebd8add7584"/);
  assert.doesNotMatch(patches, /g2_2\.2\.6\.10/);

  const builder = read("app/g2/firmware-builder.ts");
  assert.match(builder, /d495a1dffb919795e95135e144345f04\.bin/);
  assert.match(builder, /g2_2\.2\.8\.4_cfw\.bin/);

  const compatibility = read("app/g2/firmware-compat.ts");
  const wrapper = read("app/native/firmware-flasher.ts");
  const nativeFlasher = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawFirmwareFlasher.java");
  assert.match(compatibility, /FLASHABLE_STOCK_VERSION\s*=\s*\[2,\s*2,\s*8,\s*4\]/);
  assert.match(compatibility, /REQUIRED_CFW_CONTRACT\s*=\s*"EVENCFW\/9"/);
  assert.match(compatibility, /tokens\.includes\(REQUIRED_CFW_CONTRACT\)/);
  assert.match(compatibility, /EXPERIMENTAL_FIRMWARE_INSTALL_ENABLED\s*=\s*false/);
  assert.match(wrapper, /if \(!isFirmwareFlashingEnabled\(\)\)/);
  assert.match(nativeFlasher, /FIRMWARE_FLASHING_ENABLED = false/);

  assert.match(builder, /if \(!isFirmwareFlashingEnabled\(\)\)/);
  const onboarding = read("app/phone-ui/onboarding-firmware-check-view-model.ts");
  assert.match(onboarding, /case "blocked":/);
  assert.match(onboarding, /case "flashable-stock":/);
  assert.match(onboarding, /case "newer-stock":/);
  assert.match(onboarding, /hardware testing and recovery validation/i);
});

test("all firmware write paths consult the shared policy gate", () => {
  const builder = read("app/g2/firmware-builder.ts");
  for (const name of ["buildCustomFirmware", "buildStockFirmware"]) {
    const start = builder.indexOf(`export async function ${name}(`);
    assert.notEqual(start, -1, `${name} is exported`);
    const next = builder.indexOf("\nexport ", start + 1);
    const body = builder.slice(start, next === -1 ? builder.length : next);
    assert.match(body, /isFirmwareFlashingEnabled\(\)/, `${name} rejects while disabled`);
  }

  const flashPage = read("app/phone-ui/onboarding-flash-view-model.ts");
  for (const signature of [
    "private async beginPrompt(): Promise<void> {",
    "private async buildFirmware(): Promise<void> {",
    "private startFlashing(): void {",
  ]) {
    const start = flashPage.indexOf(signature);
    assert.notEqual(start, -1, `${signature} exists`);
    const next = flashPage.indexOf("\n  private ", start + signature.length);
    const body = flashPage.slice(start, next === -1 ? flashPage.length : next);
    assert.match(body, /requireFlashingEnabled\(\)/, `${signature} rejects while disabled`);
  }
});

test("native flasher accepts only the canonical six-component stock or CFW image", () => {
  const flasher = read("App_Resources/Android/src/main/java/com/faceclaw/app/FaceclawFirmwareFlasher.java");
  assert.match(flasher, /EXPECTED_CFW_IMAGE_SHA256\s*=\s*"bf143aa220d634969fc7ea856716bfccd6cf197fe93f41bec2b87ebd8add7584"/);
  assert.match(flasher, /EXPECTED_STOCK_IMAGE_SHA256\s*=\s*"df7b8bd18727765eba73be5ab836e0ee4cfd17b5e680046003b8d608d2fbfda7"/);
  assert.match(flasher, /requireCanonicalImageDigest\(img\)/);
  assert.match(flasher, /MessageDigest\.getInstance\("SHA-256"\)/);
  assert.doesNotMatch(flasher, /EXPECTED_SEGMENTS/);
});
