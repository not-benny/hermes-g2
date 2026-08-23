#!/usr/bin/env node
import { createInterface } from "node:readline";
import { HermesCockpitAdapter } from "./hermes-cockpit-adapter.mjs";

const adapter = new HermesCockpitAdapter();
adapter.connect("fake_connection_generation");
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of input) {
  if (!line.trim()) continue;
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    process.stdout.write(JSON.stringify({ error: "invalid_json" }) + "\n");
    continue;
  }
  let result = null;
  try {
    if (request.op === "share") result = adapter.share(request);
    else if (request.op === "unshare") result = { removed: adapter.unshare(request.publicSessionId) };
    else if (request.op === "snapshot") result = adapter.snapshot();
    else if (request.op === "event") result = adapter.ingest(request.event, request.generation);
    else if (request.op === "command") result = adapter.handleCommand(request.command, (rpc) => rpc);
    else if (request.op === "observe") result = adapter.observeSession(request.hermesSessionId, request.update);
    else if (request.op === "disconnect") {
      adapter.disconnect();
      result = { disconnected: true };
    } else if (request.op === "connect") {
      adapter.connect(request.connectionGeneration);
      result = { connected: true };
    } else result = { error: "unsupported_operation" };
  } catch {
    // Stable error only: never echo request content, private IDs, or payloads.
    result = { error: "operation_rejected" };
  }
  process.stdout.write(JSON.stringify(result) + "\n");
}
