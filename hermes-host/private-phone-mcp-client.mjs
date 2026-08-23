const MCP_PROTOCOL_VERSION = "2025-06-18";

/** Exact-turn MCP client for the phone side of the private bridge protocol. */
export class PrivatePhoneMcpClient {
  #send;
  #turnId;
  #connectionGeneration;
  #requestTimeoutMs;
  #nextId = 0;
  #pending = new Map();
  #closed = false;
  #initialized = false;

  constructor({ send, turnId, connectionGeneration, requestTimeoutMs = 15_000 }) {
    if (typeof send !== "function" || typeof turnId !== "string" || !turnId ||
        (typeof connectionGeneration !== "string" && typeof connectionGeneration !== "number")) {
      throw new Error("exact phone MCP connection and turn are required");
    }
    this.#send = send;
    this.#turnId = turnId;
    this.#connectionGeneration = String(connectionGeneration);
    this.#requestTimeoutMs = requestTimeoutMs;
  }

  async initialize() {
    if (this.#initialized) return;
    const result = await this.#request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "hermes-g2-private-evaluation", version: "1.0.0" },
    });
    if (result?.protocolVersion !== MCP_PROTOCOL_VERSION) throw new Error("phone MCP protocol mismatch");
    this.#sendFrame({ jsonrpc: "2.0", method: "notifications/initialized" });
    this.#initialized = true;
  }

  async callTool(name, args) {
    if (typeof name !== "string" || !name.startsWith("glasses.dynamic_apps.") || !args || typeof args !== "object" || Array.isArray(args)) {
      throw new Error("private phone tool request rejected");
    }
    const result = await this.#request("tools/call", { name, arguments: args });
    if (result?.isError === true) throw new Error("phone tool failed safely");
    const content = result?.content;
    if (!Array.isArray(content) || content.length !== 1 || content[0]?.type !== "text" || typeof content[0].text !== "string") {
      throw new Error("phone tool response is malformed");
    }
    try {
      const parsed = JSON.parse(content[0].text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      return parsed;
    } catch {
      throw new Error("phone tool response is malformed");
    }
  }

  receive(message) {
    if (this.#closed || !message || message.jsonrpc !== "2.0" || (typeof message.id !== "string" && typeof message.id !== "number")) return false;
    const key = `${typeof message.id}:${String(message.id)}`;
    const pending = this.#pending.get(key);
    if (!pending) return false;
    this.#pending.delete(key);
    clearTimeout(pending.timer);
    if (message.error) pending.reject(new Error("phone MCP request failed safely"));
    else if (!("result" in message)) pending.reject(new Error("phone MCP response is malformed"));
    else pending.resolve(message.result);
    return true;
  }

  close(reason = "connection closed") {
    if (this.#closed) return;
    this.#closed = true;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.#pending.clear();
  }

  #request(method, params) {
    if (this.#closed) return Promise.reject(new Error("phone MCP connection is closed"));
    const id = `${this.#connectionGeneration}:${++this.#nextId}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(`string:${id}`);
        reject(new Error("phone MCP request timed out"));
      }, this.#requestTimeoutMs);
      this.#pending.set(`string:${id}`, { resolve, reject, timer });
      try { this.#sendFrame({ jsonrpc: "2.0", id, method, params }); }
      catch {
        clearTimeout(timer);
        this.#pending.delete(`string:${id}`);
        reject(new Error("phone MCP transport failed"));
      }
    });
  }

  #sendFrame(msg) {
    if (this.#closed) throw new Error("phone MCP connection is closed");
    this.#send({ v: 1, chan: "mcp", turnId: this.#turnId, msg });
  }
}
