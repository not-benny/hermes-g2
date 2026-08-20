import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
const transpile = (source) => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const dataUrl = (js) => `data:text/javascript;base64,${Buffer.from(js).toString("base64")}`;
const replaceImport = (js, specifier, url) => js.replaceAll(JSON.stringify(specifier), JSON.stringify(url));

const historyUrl = dataUrl(transpile(read("app/health/health-history.ts")));
const hourlyUrl = dataUrl(replaceImport(transpile(read("app/health/health-hourly.ts")), "./health-history", historyUrl));
const parserUrl = dataUrl(transpile(read("app/health/ring-parser.ts")));
const ringStoreUrl = dataUrl(replaceImport(transpile(read("app/health/ring-health-store.ts")), "./ring-parser", parserUrl));
let modelJs = transpile(read("app/health/health-store.ts"));
modelJs = replaceImport(modelJs, "./health-history", historyUrl);
modelJs = replaceImport(modelJs, "./health-hourly", hourlyUrl);
modelJs = replaceImport(modelJs, "./ring-health-store", ringStoreUrl);
const modelUrl = dataUrl(modelJs);
const registryUrl = dataUrl(transpile(read("app/assistant/tool-registry.ts")));
const nativeUrl = dataUrl(`
  let consent = false;
  let consentSequence = [];
  let document = {};
  export const getHermesConsent = () => consentSequence.length ? consentSequence.shift() : consent;
  export const loadHealthDocument = () => document;
  export const setTestConsent = (value) => { consent = value; consentSequence = []; };
  export const setConsentSequence = (values) => { consentSequence = [...values]; };
  export const setTestDocument = (value) => { document = value; };
`);
let toolsJs = transpile(read("app/assistant/health-tools.ts"));
toolsJs = replaceImport(toolsJs, "./tool-registry", registryUrl);
toolsJs = replaceImport(toolsJs, "../health/health-store", modelUrl);
toolsJs = replaceImport(toolsJs, "../native/health-store", nativeUrl);
const toolsUrl = dataUrl(toolsJs);
let mcpJs = transpile(read("app/assistant/mcp-server.ts"));
mcpJs = replaceImport(mcpJs, "./tool-registry", registryUrl);
const mcpUrl = dataUrl(mcpJs);

const { ToolRegistry } = await import(registryUrl);
const { AssistantMcpServer } = await import(mcpUrl);
const { registerHealthTools } = await import(toolsUrl);
const native = await import(nativeUrl);

const TOOL_NAME = "health.get_ring_data";
const TODAY = (() => {
  const d = new Date();
  const pad = (value) => String(value).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
const daily = (dateKey, over = {}) => ({
  dateKey,
  restingHr: null,
  hrMin: null,
  hrMax: null,
  hrvAvg: null,
  spo2Avg: null,
  steps: null,
  sleepScore: null,
  sleepDurationMin: null,
  sleepDeepMin: null,
  sleepRemMin: null,
  bodyTempC: null,
  readinessScore: null,
  updatedAtMs: Date.now(),
  ...over,
});

function setup() {
  native.setTestConsent(false);
  native.setTestDocument({ history: [daily(TODAY, { steps: 12, bridgeToken: "forbidden" })], hourly: [] });
  const registry = new ToolRegistry();
  registerHealthTools(registry);
  registerHealthTools(registry);
  return registry;
}

test("consent off hides the health tool and rejects calls", async () => {
  const registry = setup();
  assert.equal(registry.listTools().some((tool) => tool.name === TOOL_NAME), false);
  const result = await registry.callTool(TOOL_NAME, {});
  assert.equal(result.ok, false);
  assert.match(result.error, /not currently available/);
});

test("consent on lists exactly the bounded read-only schema once", () => {
  const registry = setup();
  native.setTestConsent(true);
  const tools = registry.listTools().filter((tool) => tool.name === TOOL_NAME);
  assert.equal(tools.length, 1);
  assert.deepEqual(tools[0].inputSchema, {
    type: "object",
    properties: {
      end_date: { type: "string", description: "Inclusive local end date (YYYY-MM-DD); defaults to today." },
      days: { type: "integer", minimum: 1, maximum: 31, description: "Number of local calendar days; defaults to 7." },
      include_hourly: { type: "boolean", description: "Include retained hourly points; defaults to false." },
    },
    additionalProperties: false,
  });
  assert.equal(tools[0].proactive, undefined);
});

test("default call returns compact bounded daily JSON without forbidden fields", async () => {
  const registry = setup();
  native.setTestConsent(true);
  const result = await registry.callTool(TOOL_NAME, {});
  assert.equal(result.ok, true);
  const value = JSON.parse(result.content);
  assert.equal(value.source, "hermes-g2-ring");
  assert.equal(value.hourlyIncluded, false);
  assert.equal("hourly" in value, false);
  for (const forbidden of ["slots", "dayBaseSec", "timezoneOffsetMinutes", "bridgeToken", "firmwareVersion", "token"]) {
    assert.equal(JSON.stringify(value).includes(forbidden), false, forbidden);
  }
});

test("hourly is opt-in and semantic old/future/invalid dates fail normally", async () => {
  const registry = setup();
  native.setTestConsent(true);
  native.setTestDocument({ history: [daily(TODAY)], hourly: [
    { dateKey: TODAY, hourIdx: 8, hr: { avg: 60, max: 70, min: 50 } },
  ] });
  const hourly = await registry.callTool(TOOL_NAME, { days: 1, include_hourly: true });
  assert.equal(hourly.ok, true);
  assert.equal(JSON.parse(hourly.content).hourly.length, 1);
  for (const end_date of ["2026-02-30", "2999-01-01", "2000-01-01"]) {
    const result = await registry.callTool(TOOL_NAME, { end_date });
    assert.equal(result.ok, false, end_date);
  }
});

test("handler rechecks consent, revocation blocks the very next call, and tool is conversation-only", async () => {
  const registry = setup();
  native.setTestConsent(true);
  assert.equal((await registry.callTool(TOOL_NAME, {})).ok, true);
  assert.equal((await registry.callTool(TOOL_NAME, {}, { proactive: true })).ok, false);
  native.setConsentSequence([true, false]);
  const raced = await registry.callTool(TOOL_NAME, {});
  assert.equal(raced.ok, false);
  assert.match(raced.error, /access is off/);
  native.setTestConsent(false);
  assert.equal((await registry.callTool(TOOL_NAME, {})).ok, false);
});

test("health tool works through initialized MCP tools/list and tools/call", async () => {
  const registry = setup();
  native.setTestConsent(true);
  const sent = [];
  const server = new AssistantMcpServer({ send: (message) => sent.push(message), isTurnActive: () => true,
    allowProactive: () => false, registry });
  server.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  server.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" });
  server.handleMessage({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
  assert.equal(sent.at(-1).result.tools.some((tool) => tool.name === TOOL_NAME), true);
  server.handleMessage({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: TOOL_NAME, arguments: {} } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  const reply = sent.find((message) => message.id === 3);
  assert.equal(reply.result.isError, false);
  assert.equal(JSON.parse(reply.result.content[0].text).source, "hermes-g2-ring");
});
