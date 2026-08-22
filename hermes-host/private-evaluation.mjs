#!/usr/bin/env node
import { randomBytes } from "node:crypto";
import { createHomeAssistantTransport, HomeAssistantAdapter } from "./home-assistant-adapter.mjs";

const HELP = `Private Home Assistant living-room evaluation

Default mode is read-only runtime area discovery. It prints bounded labels and
on/off state only; no provider URL, entity ID, token, or raw response is shown.

Usage:
  node hermes-host/private-evaluation.mjs
  node hermes-host/private-evaluation.mjs --apply --label "Floor lamp" --to on --restore

Mutation requires --apply, --restore, an exact unique discovered --label, an
explicit --to on|off target, HA_ALLOW_MUTATION=I_UNDERSTAND, and a configured
provider-side atomic mutation endpoint. Restoration is
receipt-based and refuses to overwrite a later human or automation change.
Credentials are read only from the server-side environment.
`;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function option(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    process.stdout.write(HELP);
    return;
  }
  const baseUrl = process.env.HA_URL;
  const token = process.env.HA_TOKEN;
  if (!baseUrl || !token) {
    fail("Home Assistant credentials must be provided through the server-side environment.");
    return;
  }
  const apply = args.includes("--apply");
  const restore = args.includes("--restore");
  const atomicMutationPath = process.env.HA_ATOMIC_MUTATION_PATH;
  const label = option(args, "--label");
  const target = option(args, "--to");
  if (apply && (!restore || !label || (target !== "on" && target !== "off") ||
      process.env.HA_ALLOW_MUTATION !== "I_UNDERSTAND" || !atomicMutationPath)) {
    fail("Mutation refused: require --restore, exact --label, --to on|off, the explicit gate, and an atomic provider endpoint.");
    return;
  }

  const transport = createHomeAssistantTransport({ baseUrl, getToken: () => token, atomicMutationPath });
  const adapter = new HomeAssistantAdapter({ transport });
  const devices = await adapter.discover({ kind: "area", label: "Living Room" });
  process.stdout.write(`${JSON.stringify({ area: "Living Room", devices: devices.map((device) => ({ label: device.label, kind: device.kind, value: device.value })) }, null, 2)}\n`);
  if (!apply) return;
  const matches = devices.filter((device) => device.label === label);
  if (matches.length !== 1) throw new Error("Mutation refused: label must match exactly one available device");
  const device = matches[0];
  const operationId = `private-${randomBytes(12).toString("hex")}`;
  let receipt = null;
  let interrupted = false;
  const authorized = () => process.env.HA_ALLOW_MUTATION === "I_UNDERSTAND";
  const restoreNow = async () => {
    if (!receipt) return;
    const result = await adapter.restore(receipt, { operationId: `${operationId}-restore`, isAuthorized: authorized });
    process.stdout.write(`${JSON.stringify({ restoration: result.restored ? "restored" : result.reason })}\n`);
    receipt = null;
  };
  // Do not exit while the provider mutation is in flight: its outcome may land
  // after the signal. Let it resolve to a receipt, then the normal finally path
  // performs the only causality-checked restoration available.
  const onSignal = () => { interrupted = true; process.exitCode = 130; };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    receipt = await adapter.setPower({ operationId, handle: device.handle, value: target, expectedRevision: device.revision }, { isAuthorized: authorized });
    process.stdout.write(`${JSON.stringify({ mutation: receipt.changed ? "verified" : "already-set", label: device.label, value: receipt.after.value })}\n`);
    if (interrupted) process.stdout.write(`${JSON.stringify({ interruption: "restoration pending" })}\n`);
  } finally {
    await restoreNow();
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
}

main().catch(() => fail("Private evaluation failed safely; no provider details were logged."));
