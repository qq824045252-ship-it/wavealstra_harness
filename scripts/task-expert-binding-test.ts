import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-task-expert-binding-test-"));
process.env.USERPROFILE = sandbox;
process.env.HOME = sandbox;
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { TaskExpertBindingService } = await import("../src/main/experts/TaskExpertBindingService");
const db = new AppDatabase(join(sandbox, "app.db"));
const privateRoot = join(sandbox, "template", "skills");
const globalRoot = join(sandbox, "global-skill");
mkdirSync(join(privateRoot, "calibration", "references"), { recursive: true });
mkdirSync(globalRoot, { recursive: true });
writeFileSync(join(privateRoot, "calibration", "SKILL.md"), "---\nname: calibration\ndescription: calibration skill\n---\nRead references/curve.txt\n");
writeFileSync(join(privateRoot, "calibration", "references", "curve.txt"), "original calibration curve");
writeFileSync(join(globalRoot, "SKILL.md"), "---\nname: global-skill\ndescription: global fixture\n---\nfixture\n");
let available = true, globalEnabled = true;
let template = { id: "analyst", revision: "template-v1", name: "分析员", instructions: "Identity v1", enabled: true,
  skills: ["calibration"], mcpIds: ["selected-server", "disabled-server"], connectorIds: ["expert-connector"] };
const experts: any = {
  getDetail: (id: string) => { if (id !== "analyst" || !available) throw new Error("专家未安装"); return { ...template }; },
  getPrivateSkillsDir: () => available ? privateRoot : null,
};
const options = { rootDir: join(sandbox, "bindings"), resolveSkillDirectory: (id: string) => id === "global-skill" ? globalRoot : undefined,
  isSkillEnabled: (id: string) => id !== "global-skill" || globalEnabled };
let bindings = new TaskExpertBindingService(db, experts, options);
const task = (id: string, expertId?: string) => db.upsertTask({ id, title: id, updatedAt: Date.now(), welcomeMode: "general", expertId });
try {
  task("bound");
  const initial = bindings.save({ taskId: "bound", expertId: "analyst", expectedRevision: null });
  assert.equal(initial.active, null);
  assert.equal(initial.pending, true);
  assert.doesNotMatch(JSON.stringify(initial), /relativePath|privateSkills|bindings[\\/]/);
  const firstRevision = initial.desired!.revision;
  bindings.promote("bound");
  assert.equal(bindings.active("bound")!.instructions, "Identity v1");
  const copiedSkill = bindings.activeSkillDirectories("bound")[0];
  assert.equal(readFileSync(join(copiedSkill, "references", "curve.txt"), "utf8"), "original calibration curve");
  assert.equal(db.getTask("bound")!.expertBinding!.active!.revision, firstRevision, "task read projection uses pure binding lookup");
  template = { ...template, instructions: "template changed", revision: "template-v2" };
  assert.equal(bindings.active("bound")!.instructions, "Identity v1", "template updates never mutate a task revision");

  available = false;
  rmSync(join(sandbox, "template"), { recursive: true, force: true });
  const edited = bindings.save({ taskId: "bound", expectedRevision: firstRevision, custom: {
    name: "任务分析员", instructions: "Task-only v2", skillIds: ["calibration", "global-skill"], mcpIds: [], connectorIds: [],
  } });
  assert.equal(bindings.active("bound")!.instructions, "Identity v1", "saving does not alter active instructions");
  assert.equal(edited.pending, true);
  assert.throws(() => bindings.save({ taskId: "bound", expertId: null, expectedRevision: firstRevision }), /已被修改/);
  bindings = new TaskExpertBindingService(db, experts, options);
  assert.equal(bindings.active("bound")!.revision, firstRevision, "reopening preserves active and pending revisions separately");
  assert.equal(bindings.get("bound")!.desired!.instructions, "Task-only v2");
  bindings.promote("bound");
  assert.equal(bindings.activeSkillDirectories("bound").length, 2);
  assert.equal(readFileSync(join(bindings.activeSkillDirectories("bound")[0], "references", "curve.txt"), "utf8"), "original calibration curve");
  globalEnabled = false;
  assert.equal(bindings.activeSkillDirectories("bound").length, 1, "global disable does not resurrect through a task copy");
  assert.equal(bindings.active("bound")!.sourceRevision, "template-v1", "task editing retains its original template provenance");
  const cleared = bindings.save({ taskId: "bound", expertId: null, expectedRevision: edited.desired!.revision });
  assert.equal(cleared.desired, null);
  assert(cleared.active && cleared.pending, "pending removal retains running identity");
  bindings.promote("bound");
  assert.equal(bindings.get("bound")!.active, null);
  assert.equal(bindings.activeSkillDirectories("bound").length, 0);
  assert(existsSync(copiedSkill), "old revisions remain intact until task deletion");
  assert.throws(() => bindings.purge("bound"), /永久删除/);
  console.log("PASS task-owned prompt and complete skill package survive template updates/uninstall, pending edit/restart and CAS");

  task("legacy-missing", "missing-expert");
  const missing = bindings.ensureLegacy("legacy-missing")!;
  assert.equal(missing.active, null);
  assert(missing.warnings?.[0].includes("原专家无法迁移"));
  assert.equal(db.getTask("legacy-missing")!.expertId, undefined);
  assert.deepEqual(bindings.ensureLegacy("legacy-missing"), missing, "cleared legacy binding is not repeatedly re-imported");
  available = true;
  template = { ...template, skills: [] };
  task("legacy-valid", "analyst");
  const migrated = bindings.ensureLegacy("legacy-valid")!;
  assert(migrated.active && migrated.desired && !migrated.pending, "legacy adoption captures the previously active identity");
  assert.equal(migrated.active.instructions, "template changed");
  console.log("PASS legacy adoption and explicit unavailable-template clearing");

  const { DurableBotService } = await import("../src/main/agent/durable/DurableBotService");
  const { BACKGROUND_CONTEXT: context } = await import("@earendil-works/chord/context");
  const { createAssistantMessageEventStream } = await import("@earendil-works/pi-ai/compat");
  const { getCurrentTools } = await import("@earendil-works/pi-ai");
  const { Type } = await import("typebox");
  const { defineTool } = await import("@earendil-works/pi-durable");
  const model: any = { id: "fixture", provider: "fixture", name: "fixture", api: "openai-completions", input: ["text"],
    contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  const seen: Array<{ identity: string; mcp: string }> = [];
  let held = 0, generations = 0;
  const fixtureModels: any = { getAuth: async () => undefined, refresh: async () => {}, getModel: () => model, getAvailable: async () => [model],
    streamSimple: (_model: any, input: any) => {
      const stream = createAssistantMessageEventStream();
      void Promise.resolve().then(() => {
        const sections = new Map<string, string>();
        for (const message of input.messages) if (message.role === "system") for (const [key, value] of Object.entries(message.sections ?? {})) {
          if (value === null) sections.delete(key); else sections.set(key, String(value));
        }
        const identity = sections.get("mybuddy");
        if (identity) seen.push({ identity, mcp: getCurrentTools(input.messages).find(tool => tool.name === "mcp_list_tools")?.description ?? "" });
        const callHold = identity && ++generations === 1;
        const lastUser = input.messages.findLastIndex((message: any) => message.role === "user");
        const scopeProbe = lastUser >= 0 && JSON.stringify(input.messages[lastUser].content).includes("codemode-scope-probe") &&
          !input.messages.slice(lastUser).some((message: any) => message.role === "toolResult");
        const content: any = callHold ? [{ type: "toolCall", id: "hold-call", name: "hold", arguments: {} }]
          : scopeProbe ? [{ type: "toolCall", id: "scope-call", name: "codemode", arguments: { code: 'await tools.mcp_call_tool({server:"selected",tool:"old_tool",arguments:{}});' } }]
          : [{ type: "text", text: identity ? "identity reply" : "checkpoint summary" }];
        const stopReason = callHold || scopeProbe ? "toolUse" : "stop";
        const message: any = { role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
          timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      });
      return stream;
    },
  };
  fixtureModels.completeSimple = (model: any, input: any, options: any) => fixtureModels.streamSimple(model, input, options).result();
  const hold = defineTool({ name: "hold", description: "hold fixture until restart", parameters: Type.Object({}), replay: "unsafe",
    execute: async (_args, _api, ctx) => {
      held++;
      await new Promise<void>((_resolve, reject) => {
        assert(ctx.abortSignal);
        if (ctx.abortSignal.aborted) reject(new Error("aborted"));
        else ctx.abortSignal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
      return { output: [{ type: "text", text: "unreachable" }] };
    },
  });
  const cwd = join(sandbox, "bot-cwd"); mkdirSync(cwd);
  task("durable");
  const initialBot = bindings.save({ taskId: "durable", expectedRevision: null, custom: {
    name: "旧身份", instructions: "stable-old-identity", skillIds: [], mcpIds: ["selected", "disabled"], connectorIds: [],
  } });
  const patches: any[] = [];
  const createService = () => {
    const service = new DurableBotService({ db, agentDir: join(sandbox, "bot-agent"), mcpDir: join(sandbox, "bot-mcp"),
      models: fixtureModels, expertBindings: bindings, resolveCwd: () => cwd, defaultModel: () => "fixture/fixture", toolMode: task => task.modePresetId === "codemode" ? "codemode" : "native",
      instructions: task => bindings.active(task.id)?.instructions ?? "default-identity", emit: patch => patches.push(patch), tools: async () => ({ tools: [hold], contextHooks: [] }),
    });
    (service as any).config.loadRuntimeConfig = () => ({ mcpServers: {
      selected: { url: "http://127.0.0.1:1/mcp", enabled: true },
      other: { url: "http://127.0.0.1:2/mcp", enabled: true },
      disabled: { url: "http://127.0.0.1:3/mcp", enabled: false },
    } });
    return service;
  };
  const request = (id: string) => ({ taskId: "durable", text: id, userMessageId: id, assistantMessageId: `${id}-reply`, streamingBehavior: "followUp" as const });
  const until = async (ready: () => boolean | Promise<boolean>) => {
    const deadline = Date.now() + 15_000;
    while (!await ready()) { if (Date.now() > deadline) throw new Error("fixture timed out"); await new Promise(resolve => setTimeout(resolve, 15)); }
  };
  let service = createService();
  try {
    await service.prompt(request("first"), true);
    await until(() => held === 1);
    assert.equal(bindings.active("durable")!.revision, initialBot.desired!.revision);
    assert(seen[0].mcp.includes("selected") && !seen[0].mcp.includes("disabled") && !seen[0].mcp.includes("other"), "only selected enabled MCP servers are assembled");
    const nextBot = bindings.save({ taskId: "durable", expectedRevision: initialBot.desired!.revision, custom: {
      name: "新身份", instructions: "stable-new-identity", skillIds: [], mcpIds: ["other", "disabled"], connectorIds: [],
    } });
    await service.prompt(request("queued-before-restart"), true);
    assert.equal(bindings.active("durable")!.revision, initialBot.desired!.revision, "queue admission cannot promote a pending identity");
    await service.close();
    service = createService();
    await service.resumePersisted();
    await until(async () => { const history = await service.history("durable"); return !history.durable?.busy && history.durable?.queued === 0; });
    assert.equal(held, 1, "unsafe tool is not replayed after restart");
    assert(seen.length >= 3 && seen.every(item => item.identity === "stable-old-identity"), "resumed generation and all pre-existing queued inputs retain active identity");
    assert.equal(bindings.get("durable")!.pending, true);
    await service.prompt(request("new-input-after-idle"), false);
    assert.equal(bindings.active("durable")!.revision, nextBot.desired!.revision);
    assert.equal(seen.at(-1)!.identity, "stable-new-identity");
    assert(seen.at(-1)!.mcp.includes("other") && !seen.at(-1)!.mcp.includes("selected") && !seen.at(-1)!.mcp.includes("disabled"));
    assert(patches.some(patch => patch.type === "expert_binding" && patch.binding.active?.revision === nextBot.desired!.revision && !patch.binding.pending));
    await service.compact("durable");
    await service.prompt(request("after-compaction"), false);
    assert.equal(seen.at(-1)!.identity, "stable-new-identity", "compaction regenerates the active identity section");
    await service.prompt({ ...request("codemode-scope-probe"), modePresetId: "codemode" }, false);
    const denied = (await service.history("durable")).messages.flatMap(message => message.tools ?? []).filter(tool => tool.tool === "codemode");
    assert(denied.some(tool => tool.status === "error"), "Code Mode rejects an explicitly requested MCP server removed from active identity");
    console.log("PASS Durable binding stays stable through tools, queue and restart; idle input promotes identity/MCP and compaction retains it");
  } finally { await service.close(); }

  const { AgentService } = await import("../src/main/agent/AgentService");
  const agent = new AgentService(db);
  // Keep this fixture's retained skill root; production uses the service's default task-owned root.
  (agent as any).expertBindings = bindings;
  try {
    task("custom-ordinary");
    bindings.save({ taskId: "custom-ordinary", expectedRevision: null, custom: {
      name: "独立身份", instructions: "CUSTOM_WITHOUT_TEMPLATE", skillIds: [], mcpIds: [], connectorIds: ["from-identity"],
    } });
    bindings.promote("custom-ordinary");
    const runningRevision = bindings.active("custom-ordinary")!.revision;
    let prematureRelease = 0;
    const releaseIfIdle = (agent as any).sessionLifecycle.releaseIfIdle;
    (agent as any).sessionLifecycle.releaseIfIdle = () => { prematureRelease++; return "released"; };
    try {
      const pending = agent.saveTaskExpertBinding({ taskId: "custom-ordinary", expectedRevision: runningRevision, custom: {
        name: "待生效身份", instructions: "PENDING_MUST_NOT_INTERRUPT_PREPARATION", skillIds: [], mcpIds: [], connectorIds: [],
      } });
      assert.equal(prematureRelease, 0, "UI save must not release a session that appears native-idle during prompt preparation");
      assert.equal(pending.active!.revision, runningRevision, "saving never promotes or changes the active request identity");
      assert.equal(pending.pending, true);
    } finally { (agent as any).sessionLifecycle.releaseIfIdle = releaseIfIdle; }
    for (const welcomeMode of ["working", "coding"] as const) {
      const trace = agent.assembleModePreview({ taskId: "custom-ordinary", welcomeMode, cwd });
      assert(trace.segments.some(segment => segment.id === "expert" && segment.content.includes("CUSTOM_WITHOUT_TEMPLATE")), `${welcomeMode} preserves custom identity without sourceExpertId`);
    }
    assert.deepEqual((agent as any).expertConnectorIds("custom-ordinary", ["manual-connector"]), ["manual-connector", "from-identity"]);
    bindings.save({ taskId: "custom-ordinary", expertId: null });
    bindings.promote("custom-ordinary");
    assert.deepEqual((agent as any).expertConnectorIds("custom-ordinary", ["manual-connector"]), ["manual-connector"], "unbinding removes only identity-owned connector selections");
    const oldConnectorPaths = (agent as any).connectorsService.getPrivateSkillDirs;
    (agent as any).connectorsService.getPrivateSkillDirs = () => ["manual-connector-path"];
    try {
      assert.deepEqual((agent as any).expertSkillPaths("legacy-valid", "analyst", ["manual-connector"], false), ["manual-connector-path"], "policy-denied expert never contributes retained private skills");
    } finally { (agent as any).connectorsService.getPrivateSkillDirs = oldConnectorPaths; }
    console.log("PASS working/coding custom identity, expert policy gate and manual connector provenance");
  } finally { agent.dispose(); }
  db.deleteTask("bound");
  bindings.purge("bound");
  assert.equal(bindings.get("bound"), null);
  assert.equal(existsSync(copiedSkill), false, "permanent deletion cleans retained revisions only after the task row is deleted");
} finally {
  db.close();
}
console.log("Task expert binding fixtures retained at", sandbox);
