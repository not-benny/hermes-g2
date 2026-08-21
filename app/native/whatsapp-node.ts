/**
 * Starts and talks to the embedded Node.js WhatsApp engine (nodejs-mobile
 * libnode.so, driven by FaceclawNodeRuntime.java). The engine hosts a
 * 127.0.0.1 loopback HTTP server, bearer-token guarded, that this module
 * reaches with the runtime's http-request plumbing.
 *
 * Milestone 1a: prove the runtime starts and /health responds. The full
 * WhatsApp API (pairing, chats, send, media, reactions) lands on top of this.
 */

import { ApplicationSettings, Http, Utils } from "@nativescript/core";

declare const com: any;

const NODE_PORT = 8799; // 127.0.0.1 on the phone; unrelated to the LAN bridge port
export const WHATSAPP_PRODUCTION_ENABLED = false;
let token = "";
let started = false;

function makeToken(): string {
  const bytes = new java.security.SecureRandom().generateSeed(32) as any;
  const chars = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const value = Number(bytes[i]) & 0xff;
    out += chars[(value >>> 4) & 0x0f] + chars[value & 0x0f];
  }
  if (out.length !== 64) throw new Error("secure loopback token generation failed");
  return out;
}

/** Start the embedded Node runtime (idempotent). No-op off Android. */
export function startWhatsAppNode(): void {
  if (!WHATSAPP_PRODUCTION_ENABLED) return;
  if (started || !global.isAndroid) return;
  try {
    token = makeToken();
    const context = Utils.android.getApplicationContext();
    com.faceclaw.app.FaceclawNodeRuntime.getInstance().start(context, NODE_PORT, token);
    started = true;
    console.log(`[whatsapp-node] runtime start requested on 127.0.0.1:${NODE_PORT}`);
  } catch (error) {
    console.error("[whatsapp-node] failed to start runtime");
  }
}

function authHeaders(extra?: Record<string, string>): Record<string, string> {
  return { authorization: `Bearer ${token}`, ...(extra ?? {}) };
}

/**
 * Request a WhatsApp pairing code for a phone number (E.164 digits). The engine
 * starts the socket and calls requestPairingCode; the 8-char code is returned
 * to the caller. The user enters it in WhatsApp > Linked devices > Link with phone
 * number. Resolves null on failure.
 */
export async function requestWhatsAppPairing(phoneNumber: string): Promise<string | null> {
  if (!WHATSAPP_PRODUCTION_ENABLED) return null;
  try {
    const res = await Http.request({
      url: `http://127.0.0.1:${NODE_PORT}/pair`,
      method: "POST",
      headers: authHeaders({ "content-type": "application/json" }),
      content: JSON.stringify({ phoneNumber }),
      timeout: 30000,
    });
    const body = JSON.parse(res.content?.toString() || "{}");
    if (body.ok && body.code) {
      console.log("[whatsapp-node] pairing authorization received");
      return body.code;
    }
    console.error(`[whatsapp-node] pair failed with status ${res.statusCode}`);
    return null;
  } catch (error) {
    console.error("[whatsapp-node] pair request failed");
    return null;
  }
}

/** Current engine/link status. */
export async function whatsAppStatus(): Promise<any | null> {
  try {
    const res = await Http.request({
      url: `http://127.0.0.1:${NODE_PORT}/status`,
      method: "GET",
      headers: authHeaders(),
      timeout: 2000,
    });
    return JSON.parse(res.content?.toString() || "{}");
  } catch {
    return null;
  }
}

/** Fetch the engine health, retrying while Node boots. Resolves null on failure. */
export async function whatsAppNodeHealth(retries = 10, delayMs = 500): Promise<any | null> {
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await Http.request({
        url: `http://127.0.0.1:${NODE_PORT}/health`,
        method: "GET",
        headers: { authorization: `Bearer ${token}` },
        timeout: 2000,
      });
      const body = res.content?.toString() ?? "";
      if (res.statusCode === 200) {
        console.log(`[whatsapp-node] health OK: ${body}`);
        return JSON.parse(body);
      }
    } catch {
      // Node not up yet; wait and retry.
    }
    await new Promise((r) => setTimeout(r, delayMs));
  }
  console.error("[whatsapp-node] health check failed after retries");
  return null;
}
