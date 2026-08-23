#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const ACTION = "com.faceclaw.app.DEBUG_CONTROL_V1";
const COMPONENT = "com.faceclaw.app/com.faceclaw.app.FaceclawDebugControlReceiver";
const MAX_REQUEST_CHARS = 2048;
const MAX_RECEIPT_CHARS = 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const COMMANDS = new Set([
  "state", "display.wake", "display.blank", "window.open",
  "voice.start", "voice.stop", "voice.fixture",
]);

function output(receipt, status = 0) {
  process.stdout.write(`${JSON.stringify(receipt)}\n`);
  process.exitCode = status;
}

function exactKeys(value, expected) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validRequest(raw) {
  if (raw.length === 0 || raw.length > MAX_REQUEST_CHARS) return false;
  let request;
  try { request = JSON.parse(raw); } catch { return false; }
  if (!request || typeof request !== "object" || Array.isArray(request) || request.v !== 1 ||
      typeof request.command !== "string" || !COMMANDS.has(request.command) ||
      typeof request.id !== "string" || !ID.test(request.id)) return false;
  const state = request.command === "state";
  const keys = state
    ? ["v", "id", "command", "args"]
    : ["v", "id", "command", "processGeneration", "sessionGeneration", "windowGeneration", "captureGeneration", "args"];
  return exactKeys(request, keys) && request.args && typeof request.args === "object" && !Array.isArray(request.args);
}

function run(adb, args) {
  return spawnSync(adb, args, { encoding: "utf8", timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true });
}

function remoteShellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function selectedSerial(devicesOutput, override) {
  const devices = devicesOutput.split(/\r?\n/).slice(1).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [serial, state] = line.split(/\s+/, 2);
    return { serial, state };
  });
  if (override) {
    return devices.some((device) => device.serial === override && device.state === "device")
      ? { serial: override }
      : { error: "target-unavailable" };
  }
  const online = devices.filter((device) => device.state === "device");
  if (online.length === 0) return { error: "no-online-target" };
  if (online.length !== 1) return { error: "ambiguous-target" };
  return { serial: online[0].serial };
}

const raw = await new Promise((resolve) => {
  let input = "";
  let tooLarge = false;
  let settled = false;
  const finish = () => {
    if (settled) return;
    settled = true;
    resolve(tooLarge ? "" : input.trim());
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    if (tooLarge) return;
    input += chunk;
    if (input.length > MAX_REQUEST_CHARS) {
      tooLarge = true;
      input = "";
    }
  });
  process.stdin.on("end", finish);
  process.stdin.on("close", finish);
  process.stdin.on("error", () => {
    tooLarge = true;
    finish();
  });
});

if (!validRequest(raw)) {
  output({ ok: false, code: "malformed-input" }, 2);
} else {
  const cliArgs = process.argv.slice(2);
  let override = process.env.HERMES_G2_ADB_SERIAL || process.env.ANDROID_SERIAL || "";
  if (cliArgs.length !== 0) {
    if (cliArgs.length === 2 && cliArgs[0] === "--serial" && cliArgs[1] && !override) override = cliArgs[1];
    else {
      output({ ok: false, code: "invalid-options" }, 2);
      override = null;
    }
  }
  if (override !== null) {
    const adb = process.env.ADB || "adb";
    const listed = run(adb, ["devices", "-l"]);
    if (listed.error || listed.status !== 0 || typeof listed.stdout !== "string") {
      output({ ok: false, code: "adb-unavailable" }, 3);
    } else {
      const target = selectedSerial(listed.stdout, override);
      if (!target.serial) {
        output({ ok: false, code: target.error }, 3);
      } else {
        const sent = run(adb, [
          "-s", target.serial, "shell", "am", "broadcast", "-W",
          "-a", ACTION, "-n", COMPONENT, "--es", "request", remoteShellQuote(raw),
        ]);
        if (sent.error || sent.status !== 0 || typeof sent.stdout !== "string") {
          output({ ok: false, code: "adb-failed" }, 4);
        } else {
          const match = sent.stdout.match(/(?:^|\n)Broadcast completed: result=-?\d+, data=([^\r\n]*)\s*(?:\r?\n|$)/);
          let receipt;
          try {
            const wire = match?.[1]?.trim() ?? "";
            if (wire.length === 0 || wire.length > MAX_RECEIPT_CHARS + 2) throw new Error("invalid receipt");
            let encoded;
            try {
              encoded = JSON.parse(wire);
            } catch {
              encoded = wire.startsWith('"') && wire.endsWith('"') ? wire.slice(1, -1) : "";
            }
            if (typeof encoded !== "string") encoded = wire;
            if (encoded.length === 0 || encoded.length > MAX_RECEIPT_CHARS) throw new Error("invalid receipt");
            receipt = JSON.parse(encoded);
            if (!receipt || typeof receipt !== "object" || Array.isArray(receipt) || typeof receipt.ok !== "boolean") throw new Error("invalid receipt");
          } catch {
            receipt = { ok: false, code: "invalid-receipt" };
          }
          output(receipt, receipt.ok ? 0 : 5);
        }
      }
    }
  }
}
