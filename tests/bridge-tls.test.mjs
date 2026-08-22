import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

test("Hermes bridge remains WSS-only and trusts only the deployed private bridge CA in addition to system roots", () => {
  const bridge = read("app/assistant/bridge-client.ts");
  const settings = read("app/ui/dashboard-settings.ts");
  const controller = read("app/g2/dashboard-controller.ts");
  const manifest = read("App_Resources/Android/src/main/AndroidManifest.xml");
  const security = read("App_Resources/Android/src/main/res/xml/network_security_config.xml");
  assert.match(bridge, /const url = `wss:\/\//);
  assert.match(manifest, /android:networkSecurityConfig="@xml\/network_security_config"/);
  assert.match(security, /<certificates src="system"\/>/);
  assert.match(security, /<certificates src="@raw\/hermes_g2_bridge_ca"\/>/);
  assert.match(security, /cleartextTrafficPermitted="false"/);
  assert.equal(existsSync(new URL("../App_Resources/Android/src/main/res/raw/hermes_g2_bridge_ca.crt", import.meta.url)), true);
  assert.match(settings, /assistantBridgePortSetting[\s\S]*defaultValue: "8791"/);
  assert.match(controller, /if \(raw === "8790"\)[\s\S]*assistantBridgePortSetting\.set\("8791"\)/);
});
