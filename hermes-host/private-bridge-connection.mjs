import { randomBytes, timingSafeEqual } from "node:crypto";
import { DynamicGlassesRuntime } from "./dynamic-glasses-runtime.mjs";
import { PrivateDynamicHaTurn } from "./private-dynamic-ha-turn.mjs";
import { PrivatePhoneMcpClient } from "./private-phone-mcp-client.mjs";

function equalSecret(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** One authenticated phone socket and its exact-turn private evaluation owner. */
export class PrivateBridgeConnection {
  #expectedToken;
  #connectionGeneration;
  #send;
  #closeSocket;
  #createTurn;
  #triggerPhrase;
  #onAuthenticated;
  #companionEndpoint;
  #companionAttached = false;
  #authenticated = false;
  #retired = false;
  #closed = false;
  #device = null;
  #active = null;
  #client;

  constructor({ expectedToken, connectionGeneration, send, closeSocket, adapter = null, createTurn = null,
    companionEndpoint = null, triggerPhrase = "open private living room controls", onAuthenticated = async () => {} }) {
    if (typeof expectedToken !== "string" || expectedToken.length < 16 || typeof send !== "function" ||
        typeof closeSocket !== "function" || typeof onAuthenticated !== "function") {
      throw new Error("private bridge connection configuration is invalid");
    }
    if (!createTurn && !adapter) throw new Error("private bridge requires a Home Assistant adapter");
    if (companionEndpoint && (typeof companionEndpoint.attach !== "function" ||
        typeof companionEndpoint.detach !== "function" || typeof companionEndpoint.handleCommand !== "function")) {
      throw new Error("private bridge companion endpoint is invalid");
    }
    this.#expectedToken = expectedToken;
    this.#connectionGeneration = String(connectionGeneration);
    this.#send = send;
    this.#closeSocket = closeSocket;
    this.#triggerPhrase = triggerPhrase;
    this.#onAuthenticated = onAuthenticated;
    this.#companionEndpoint = companionEndpoint;
    this.#createTurn = createTurn ?? (({ phone }) => {
      const runtime = new DynamicGlassesRuntime({ adapter, phone });
      return new PrivateDynamicHaTurn({ runtime, phone });
    });
    this.#client = new PrivatePhoneMcpClient({
      connectionGeneration: this.#connectionGeneration,
      send: (frame) => {
        if (!this.#retired && this.#active?.turnId === frame.turnId) this.#send(frame);
      },
    });
  }

  async receive(frame) {
    if (this.#retired || !frame || typeof frame !== "object" || Array.isArray(frame) || frame.v !== 1) return false;
    if (!this.#authenticated) {
      if (frame.chan !== "ctl" || frame.type !== "hello") return this.#rejectUnauthenticated();
      if (frame.version !== 1 || !equalSecret(frame.token, this.#expectedToken) ||
          typeof frame.deviceName !== "string" || !/^[\x20-\x7e]{1,80}$/.test(frame.deviceName) ||
          !Array.isArray(frame.capabilities) || !frame.capabilities.includes("chat") || !frame.capabilities.includes("mcp")) {
        return this.#rejectUnauthenticated();
      }
      this.#device = frame.deviceName;
      await this.#onAuthenticated();
      if (this.#retired) return false;
      this.#authenticated = true;
      const companionEnabled = Boolean(this.#companionEndpoint && frame.capabilities.includes("hermes-companion-v1"));
      this.#send({ v: 1, chan: "ctl", type: "hello-ack", version: 1, serverName: "private-dynamic-ha-evaluation",
        ...(companionEnabled ? { capabilities: ["hermes-companion-v1"] } : {}) });
      if (companionEnabled) {
        try {
          this.#companionEndpoint.attach(this.#connectionGeneration, (projected) => {
            if (!this.#retired && this.#authenticated) this.#send(projected);
          });
          this.#companionAttached = true;
        } catch {
          this.#retired = true;
          this.#closeSocket(1011, "companion endpoint unavailable");
          return false;
        }
      }
      return true;
    }
    if (frame.chan === "ctl" && frame.type === "ping") {
      this.#send({ v: 1, chan: "ctl", type: "pong", ts: frame.ts });
      return true;
    }
    if (frame.chan === "mcp") {
      if (!this.#active || (frame.turnId !== undefined && frame.turnId !== this.#active.turnId)) return false;
      return this.#active.client.receive(frame.msg);
    }
    if (frame.chan === "companion") {
      if (!this.#companionAttached) return false;
      return this.#companionEndpoint.handleCommand(frame, this.#connectionGeneration);
    }
    if (frame.chan !== "chat" || typeof frame.turnId !== "string" || !/^[A-Za-z0-9._-]{1,80}$/.test(frame.turnId)) return false;
    if (frame.type === "cancel") {
      if (!this.#active || frame.turnId !== this.#active.turnId) return false;
      this.#active.controller.abort();
      await this.#active.promise;
      this.#retired = true;
      this.#closeSocket(1012, "turn cancelled; reconnect required");
      return true;
    }
    if (frame.type !== "utterance" || typeof frame.text !== "string") return false;
    if (this.#active) {
      this.#active.controller.abort();
      await this.#active.promise;
      this.#retired = true;
      this.#closeSocket(1012, "turn replaced; reconnect required");
      return false;
    }
    if (frame.text.trim().toLowerCase() !== this.#triggerPhrase.toLowerCase()) {
      this.#send({ v: 1, chan: "chat", type: "turn-error", turnId: frame.turnId,
        message: `Say exactly: ${this.#triggerPhrase}` });
      return true;
    }
    this.#startTurn(frame.turnId);
    return true;
  }

  whenIdle() {
    return this.#active?.promise ?? Promise.resolve();
  }

  async close(reason = "connection retired") {
    if (this.#closed) return;
    this.#closed = true;
    this.#retired = true;
    if (this.#companionAttached) {
      this.#companionEndpoint.detach(this.#connectionGeneration);
      this.#companionAttached = false;
    }
    if (this.#active) {
      this.#active.controller.abort();
      this.#client.close(reason);
      await this.#active.promise;
    } else {
      this.#client.close(reason);
    }
  }

  #startTurn(turnId) {
    const controller = new AbortController();
    const client = this.#client;
    client.bindTurn(turnId);
    const identity = { tenant: "private-evaluation", device: this.#device,
      connectionGeneration: this.#connectionGeneration, turnGeneration: turnId };
    const turn = this.#createTurn({ phone: client, identity });
    const active = { turnId, controller, client, promise: null };
    this.#active = active;
    active.promise = (async () => {
      try {
        await client.initialize();
        if (controller.signal.aborted) return;
        this.#send({ v: 1, chan: "chat", type: "tool-activity", turnId, label: "Private living-room evaluation" });
        const operationId = `eval-${randomBytes(8).toString("hex")}`;
        const result = await turn.run(identity, { operationId, signal: controller.signal });
        if (!controller.signal.aborted && !this.#retired) {
          this.#send({ v: 1, chan: "chat", type: "turn-done", turnId,
            stopReason: result?.reason === "expired" ? "timeout" : "complete" });
        }
      } catch {
        if (!controller.signal.aborted && !this.#retired) {
          this.#send({ v: 1, chan: "chat", type: "turn-error", turnId, message: "Private evaluation failed safely" });
          this.#retired = true;
          this.#closeSocket(1011, "private evaluation recovery required");
        }
      } finally {
        if (this.#active === active) this.#active = null;
      }
    })();
  }

  #rejectUnauthenticated() {
    this.#send({ v: 1, chan: "ctl", type: "error", message: "authentication failed" });
    this.#retired = true;
    this.#closeSocket(1008, "authentication failed");
    return false;
  }
}
