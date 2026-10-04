import assert from "node:assert/strict";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAgentSession,
  createCodemodeExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type ModelRuntime,
} from "@earendil-works/pi-coding-agent";

const root = join(tmpdir(), "mybuddy-pi100-context-boundary-" + process.pid + "-" + Date.now());
const agentDir = join(root, ".mybuddy");
const extensionDir = join(agentDir, "extensions");
mkdirSync(extensionDir, { recursive: true });
const marker = join(root, "disk-extension-executed.txt");
const extensionFile = join(extensionDir, "context-mode-fixture.mjs");
writeFileSync(extensionFile, [
  'import { writeFileSync } from "node:fs";',
  'writeFileSync(' + JSON.stringify(marker) + ', "loaded");',
  'export default function(pi){',
  '  pi.registerTool({ name:"ctx_execute", label:"ctx_execute", description:"must never load", parameters:{type:"object",properties:{}}, execute:async()=>({content:[{type:"text",text:"bad"}]}) });',
  '  pi.on("context",(event)=>{ event.messages.push({role:"user",content:"context-mode active. Hierarchy: ctx_execute"}); return {messages:event.messages}; });',
  '}',
].join("\n"), "utf8");

const settings = SettingsManager.inMemory({ defaultTools: ["+codemode", "+tool_search"] });
const loader = new DefaultResourceLoader({
  cwd: root,
  agentDir,
  settingsManager: settings,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
  extensionFactories: [
    createCodemodeExtension({ mode: "on", models: false }),
    createToolSearchExtension(),
  ],
});
await loader.reload();

const model: any = {
  id: "fixture", provider: "fixture", api: "openai-completions", name: "fixture",
  baseUrl: "https://unused.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const runtime: any = {
  getModel: () => model,
  hasConfiguredAuth: () => true,
  getAuth: async () => ({ auth: { apiKey: "never-used" } }),
};
const { session } = await createAgentSession({
  cwd: root,
  agentDir,
  model,
  modelRuntime: runtime as ModelRuntime,
  settingsManager: settings,
  sessionManager: SessionManager.inMemory(root),
  resourceLoader: loader,
});
try {
  await session.bindExtensions({ mode: "rpc" });
  const all = session.getAllTools().map((tool) => tool.name);
  const active = session.getActiveToolNames();
  assert.equal(existsSync(marker), false, "disk extension module executed despite noExtensions=true");
  assert(!all.includes("ctx_execute"), "third-party ctx tool leaked into MyBuddy-style session");
  assert(all.includes("codemode"), "native Pi codemode inline factory must remain registered");
  assert(all.includes("tool_search"), "native Pi tool_search inline factory must remain registered");
  assert(active.includes("codemode"), "native Pi codemode must remain active in coding fixture");
  assert(active.includes("tool_search"), "native Pi tool_search must remain active");  const { readFileSync } = await import("node:fs");
  const source = readFileSync(join(process.cwd(), "src/main/agent/AgentService.ts"), "utf8");
  assert(source.includes("noExtensions: true"), "main session must keep Pi disk-extension discovery disabled");
  assert(source.includes("extensionFactories"), "main session must use explicit inline capability factories");
  assert(!/context-mode|ctx_execute|ctx_search/i.test(source), "AgentService must not contain context-mode routing");

  console.log(JSON.stringify({
    passed: true,
    diskExtensionExecuted: false,
    ctxToolsRegistered: all.filter((name) => /^ctx_/.test(name)),
    nativeRegistered: all.filter((name) => name === "codemode" || name === "tool_search"),
    nativeActive: active.filter((name) => name === "codemode" || name === "tool_search"),
  }, null, 2));
} finally {
  session.dispose();
  rmSync(root, { recursive: true, force: true });
}

