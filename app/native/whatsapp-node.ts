/**
 * Starts and talks to the embedded Node.js WhatsApp engine (nodejs-mobile
 * libnode.so, driven by FaceclawNodeRuntime.java). The engine hosts a
 * 127.0.0.1 loopback HTTP server, bearer-token guarded, that this module
 * reaches with the runtime's http-request plumbing.
 *
 * Milestone 1a: prove the runtime starts and /health responds. The full
 * WhatsApp API (pairing, chats, send, media, reactions) lands on top of this.
 */

import { Http, Utils } from "@nativescript/core";

declare const com: any;

const NODE_PORT = 8799; // 127.0.0.1 on the phone; unrelated to the LAN bridge port
let token = "";
let started = false;

function makeToken(): string {
  let out = "";
  for (let i = 0; i < 24; i++) out += Math.floor(Math.random() * 16).toString(16);
  return out;
}

/** Start the embedded Node runtime (idempotent). No-op off Android. */
export function startWhatsAppNode(): void {
  if (started || !global.isAndroid) return;
  try {
    token = makeToken();
    const context = Utils.android.getApplicationContext();
    com.faceclaw.app.FaceclawNodeRuntime.getInstance().start(context, NODE_PORT, token);
    started = true;
    console.log(`[whatsapp-node] runtime start requested on 127.0.0.1:${NODE_PORT}`);
  } catch (error) {
    console.error(`[whatsapp-node] failed to start runtime: ${error}`);
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
