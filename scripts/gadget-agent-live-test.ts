/** Opt-in real model regression. All sessions, Gadgets and writes are temporary;
 * only the selected gateway credentials are read into memory from models.json. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { ModelRuntime, SessionManager, SettingsManager, DefaultResourceLoader, createAgentSession } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { GadgetRepository } from "../src/main/gadget/GadgetRepository";
import { GadgetStorage } from "../src/main/gadget/GadgetStorage";
import { GadgetRegistry } from "../src/main/gadget/GadgetRegistry";
import { GadgetRuntime } from "../src/main/gadget/GadgetRuntime";
import { GadgetService } from "../src/main/gadget/GadgetService";
import { createGadgetAgentExtension } from "../src/main/gadget/gadget-agent-extension";
import { activateResolvedSessionTools } from "../src/main/agent/PromptAssembly";
import { registerMyBuddyProviders } from "../src/main/agent/providers";

const modelId = process.env.MYBUDDY_GADGET_LIVE_MODEL;
if (!modelId) { console.log("SKIP: set MYBUDDY_GADGET_LIVE_MODEL and MYBUDDY_GADGET_LIVE_MODELS to opt into a real Magpie model call"); process.exit(0); }
const config = JSON.parse(readFileSync(process.env.MYBUDDY_GADGET_LIVE_MODELS ?? join(homedir(), ".mybuddy/models.json"), "utf8")).providers.magpie;
const configured = config.models.find((model: any) => model.id === modelId);
assert(configured, "The selected model must already be configured");
const root = mkdtempSync(join(tmpdir(), "mybuddy-gadget-live-"));
const taskRoot = join(root, "task"); mkdirSync(taskRoot);
const db = new AppDatabase(":memory:");
const space = db.createSpace({ name: "Isolated live fixture", path: root });
db.upsertTask({ id: "live-fixture", title: "Fixture", spaceId: space.id, updatedAt: Date.now() });
const storage = new GadgetStorage(join(root, "gadgets"));
const registry = new GadgetRegistry();
const host = new GadgetRuntime(storage, registry);
const events: string[] = [];
const service = new GadgetService({ repository: new GadgetRepository(db.connection), storage, registry, runtime: host,
  onChanged: (event: { type: string }) => events.push(event.type), workspaceExists: (id: string) => Boolean(db.getSpace(id)),
  workspaceEffectiveArchived: () => false, taskExists: (id: string) => Boolean(db.getTask(id)),
  taskWorkspaceId: (id: string) => db.getTask(id)?.spaceId ?? null, workspaceAncestors: () => [],
} as any);
const gadget = service.create({ name: "VPS fixture", scope: { type: "workspace", workspaceId: space.id },
  files: [{ path: "index.html", content: "<!doctype html><html><body><h1>VPS original</h1><p>Keep fixture marker 7821.</p></body></html>" }] });
const extension = createGadgetAgentExtension({ taskId: "live-fixture", service, getPermissionMode: () => "auto",
  getWorkspaceId: () => space.id, requestApproval: async () => { throw Error("No approval expected in this isolated fixture"); } } as any);
const definitions: any[] = []; await extension({ registerTool: (tool: any) => definitions.push(tool) } as any);
const manager = SessionManager.create(taskRoot, join(root, "sessions"));
const { name, description, parameters } = definitions.find(tool => tool.name === "gadget_create");
manager.appendMessage({ role: "system", content: "Previously saved task", toolsAdded: [{ name, description, parameters }], timestamp: Date.now() });
manager.appendMessage({ role: "user", content: "查看已有 Gadget", timestamp: Date.now() });
manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "之前的工具列表中只有创建功能。" }], api: "openai-responses", provider: "magpie", model: modelId,
  stopReason: "stop", timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const runtime = await ModelRuntime.create({ modelsPath: join(root, "models.json"), authPath: join(root, "auth.json"), allowModelNetwork: false, refreshOnCreate: false });
registerMyBuddyProviders(runtime);
runtime.registerProvider("magpie", { ...config, models: [configured] });
const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
const loader = new DefaultResourceLoader({ cwd: taskRoot, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [extension] });
await loader.reload();
const { session } = await createAgentSession({ cwd: taskRoot, agentDir: root, model: runtime.getModel("magpie", modelId), modelRuntime: runtime,
  sessionManager: SessionManager.open(manager.getSessionFile()!), settingsManager: settings, resourceLoader: loader, thinkingLevel: "low" });
const calls: string[] = [];
const timeout = setTimeout(() => void session.abort(), 120000);
try {
  await session.bindExtensions({ mode: "rpc" });
  assert(!session.getActiveToolNames().includes("gadget_list"));
  activateResolvedSessionTools(session, {}, "working");
  session.subscribe(event => { if (event.type === "tool_execution_start") { calls.push(event.toolName); if (calls.length > 8) void session.abort(); } });
  await session.prompt("当前工作空间已有一个名为 VPS fixture 的 Gadget。请找到它，读取现有源码，把页面主标题改成 VPS live verified，保留其他内容，再打开。不要创建新 Gadget。");
  assert(!session.state.errorMessage, session.state.errorMessage);
  assert.deepEqual(calls, ["gadget_list", "gadget_read", "gadget_update", "gadget_open"]);
  const html = service.readSource(gadget.id).files.find(file => file.path === "index.html")!.content;
  assert(html.includes("VPS live verified")); assert(html.includes("Keep fixture marker 7821."));
  assert(events.includes("open-requested"));
  assert.equal(service.list({ scope: { type: "workspace", workspaceId: space.id } }).length, 1);
  console.log(JSON.stringify({ passed: true, model: modelId, calls, fixture: root, updatedSameGadget: true, openRequested: true }));
} finally { clearTimeout(timeout); session.dispose(); await host.disposeAll(); db.close(); }
