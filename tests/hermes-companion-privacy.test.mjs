import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("privacy policy names the bounded private MCP flow and excluded material", () => {
  const privacy = readFileSync(new URL("../PRIVACY", import.meta.url), "utf8");
  assert.match(privacy, /There is no Hermes mobile companion or generic administration channel/);
  assert.match(privacy, /authenticated WSS connection carries Host Session MCP and the private phone[\s\S]*Device MCP/);
  assert.match(privacy, /excludes credentials, prompts, raw transcripts, raw tool[\s\S]*unrelated sessions, and private logs/);
  assert.match(privacy, /Cockpit state never become a second[\s\S]*wearer-visible assistant result/);
});
