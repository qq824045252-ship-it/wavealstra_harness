import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, TextContent, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { CONFIG_DIR_NAME, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ToolRegistration, JsonObject } from "@earendil-works/pi-durable";
import type { PermissionMode } from "../src/shared/agent-ipc";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ConversationInteractionRepository } from "../src/main/agent/ConversationInteractionRepository";
import { ConversationInteractionService } from "../src/main/agent/ConversationInteractionService";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService } from "../src/main/agent/work/WorkService";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { ExecutionAttemptRepository } from "../src/main/agent/ExecutionAttemptRepository";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { currentDurableExecutionContext } from "../src/main/agent/durable/DurableExecutionContext";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { createDurableToolPolicy } from "../src/main/agent/durable/DurableToolPolicy";
import { createDurableSubagentTools } from "../src/main/agent/durable/DurableSubagents";
import { computeChildTools, tightenPolicy, READONLY_TOOLS, RECURSION_TOOLS } from "../src/main/capabilities/subagent/policy";
import type { ExternalEffectRecovery } from "../src/main/agent/durable/DurableEffectRecovery";

const root = await mkdtemp(join(tmpdir(), "mybuddy-team-child-policy-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const db = new AppDatabase(join(root, "app.db"));
const attempts = new ExecutionAttemptRepository(db.connection);
const failures = new ExecutionFailureRepository(db.connection);
const policyBots = new BotRegistry(db.connection);
policyBots.ensureDefaultBot(LOCAL_USER_ID);
const goals = new ConversationGoalService(new WorkService(db.connection, { bots: policyBots }), () => {}, { userId: LOCAL_USER_ID });
let interactions = new ConversationInteractionService(new ConversationInteractionRepository(db.connection), () => {});
const call = (name: string, args: JsonObject, id = `fixture-${name}`): AssistantMessage["content"] => [{ type: "toolCall", id, name, arguments: args }];
const text = (value: string): TextContent[] => [{ type: "text", text: value }];

async function fixture(taskId: string, respond: (request: TranscriptContext) => AssistantMessage["content"],
  mode: "native" | "codemode" = "native", extraTools: ToolRegistration[] = [], isolatedSourceRoots: string[] = [], effectRecovery?: ExternalEffectRecovery, withSubagents = false) {
  const cwd = join(root, taskId);
  await mkdir(cwd);
  db.upsertTask({ id: taskId, title: taskId, updatedAt: Date.now() });
  const models = await ModelRuntime.create({ authPath: join(cwd, "auth.json"), modelsPath: null, modelsStorePath: join(cwd, "catalog.json"), refreshOnCreate: false });
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, request) => {
      const stream = createAssistantMessageEventStream();
      queueMicrotask(() => {
        const content = respond(request);
        const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api,
          provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 11,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  const state: { permission: PermissionMode; allowed: boolean; deniedTools: Set<string>;
    admit?: (input: { operationId: string; actionKind: string }) => string | undefined;
    settle?: (operationId: string, outcome: "consumed" | "released" | "unknown") => void } = { permission: "auto", allowed: true, deniedTools: new Set<string>() };
  const open = async () => {
    const policy = createDurableToolPolicy({ taskId, taskRoot: cwd, getPermissionMode: () => state.permission,
      interactions, attempts, failures, getPolicy: () => new TaskFileAccessPolicy({ taskId, taskRoot: cwd, isolatedSourceRoots }),
      effectRecovery,
      admitWorkAction: input => state.admit?.(input), settleWorkAction: (operationId, outcome) => state.settle?.(operationId, outcome),
      toolAllowed: name => !state.deniedTools.has(name) && (state.allowed || !["write", "mcp__filesystem__write_file"].includes(name)),
    });
    const domain = await durableDomainTools([createConversationRuntimeExtension({ interaction: interactions, goal: goals,
      resolveContext: currentDurableExecutionContext,
      requestInteraction: (context, request, signal, toolCallId) => interactions.requestDurable(context, request, { key: toolCallId, signal }),
    })], { taskId, cwd, models });
    return DurableBotRuntime.open({ taskId, cwd, directory: join(cwd, "state"), models,
      model: { provider: "fixture", modelId: "model" }, toolMode: mode, tools: [...domain.tools, ...extraTools, ...(withSubagents ? createDurableSubagentTools({ taskId, cwd, models, permissionMode: () => state.permission }) : [])],
      contextHooks: domain.contextHooks, toolHooks: policy.hooks, instructions: () => "fixture", onSnapshot: () => {},
    });
  };
  return { taskId, cwd, state, open };
}

try {
  assert.equal(computeChildTools({ permissionMode: "default" }).tools, null);
  assert.equal(computeChildTools({ permissionMode: "auto" }).tools, null);
  assert(computeChildTools({ permissionMode: "default", confirmTools: ["read"] }).excludeTools.includes("read"), "saved explicit default restriction remains effective");
  assert.deepEqual(computeChildTools({ permissionMode: "readonly" }).tools, [...READONLY_TOOLS]);
  assert.deepEqual(computeChildTools({ permissionMode: "default", roleTools: ["read"] }).tools, ["read"]);
  assert(computeChildTools({ permissionMode: "default", denyTools: ["write"] }).excludeTools.includes("write"));
  assert(RECURSION_TOOLS.every(tool => computeChildTools({}).excludeTools.includes(tool)));
  assert.equal(tightenPolicy({ tools: null, excludeTools: [] }, "default").tools, null);
  assert.deepEqual(tightenPolicy({ tools: ["read", "write"], excludeTools: [] }, "readonly").tools, ["read"]);
  console.log("PASS default inherits tools, explicit role and deny rules persist, readonly narrows and recursion stays excluded");

  const run = async (name: string, scopeWrite: boolean, permission: PermissionMode = "auto", outside = false) => {
    const seen: Array<{ operationId: string; actionKind: string }> = [];
    const leafResults: string[] = [];
    let parentResult = "";
    const f = await fixture(name, request => {
      const parent = request.messages.some(message => message.role === "system" && message.toolsAdded?.some(tool => tool.name === "subagent"));
      const results = request.messages.filter(message => message.role === "toolResult");
      if (parent) {
        if (results.length) { parentResult = JSON.stringify(results); return text("Collected exact child result; no inferred success."); }
        return call("subagent", { agent: "worker", task: "read seed.txt then write output.txt with content verified", model: "fixture/model", agentScope: "project", confirmProjectAgents: false, isolation: "shared", ...(outside ? { cwd: ".." } : {}) });
      }
      if (!results.length) return call("read", { path: "seed.txt" }, "child-read");
      if (results.length === 1) return call("write", { path: "output.txt", content: "verified" }, "child-write");
      leafResults.push(JSON.stringify(results));
      return text(results.some(result => result.isError) ? "FAILED: child tool rejected; file was not written" : "READBACK: " + JSON.stringify(results));
    }, "native", [], [], undefined, true);
    f.state.permission = permission;
    f.state.admit = input => { seen.push(input); return !scopeWrite && input.actionKind === "workspace:write" ? "fixture parent scope is read-only" : undefined; };
    await mkdir(join(f.cwd, CONFIG_DIR_NAME, "agents"), { recursive: true });
    await writeFile(join(f.cwd, CONFIG_DIR_NAME, "agents", "worker.md"), "---\nname: worker\ndescription: Inherit parent tools\n---\nRead and write only the requested local evidence.\n");
    await writeFile(join(f.cwd, "seed.txt"), `identity:${name}`);
    const r = await f.open();
    try {
      assert.equal((await (await r.submit("dispatch native child", name)).wait(ctx)).status, "done");
      assert(!seen.some(item => item.actionKind === "delegate"), "local child container does not request unrelated business delegation authority");
      if (outside) {
        assert(parentResult.includes("超出任务绑定范围"));
        assert.equal(leafResults.length, 0);
      } else {
        assert(leafResults.some(result => result.includes(`identity:${name}`)), "child reads this task identity, not another task");
        for (const other of ["team-a-writable", "team-b-writable", "team-c-scope-denied", "team-d-readonly", "team-e-outside"].filter(other => other !== name)) assert(!leafResults.some(result => result.includes(`identity:${other}`)), "child never receives another task evidence");
        if (permission !== "readonly") assert(seen.some(item => item.actionKind === "workspace:write"), "child write reaches parent admission");
        if (!scopeWrite) assert(parentResult.includes("FAILED: child tool rejected"), "scope failure returns to parent, not a fabricated successful write");
      }
      if (scopeWrite && permission !== "readonly" && !outside) assert.equal(await readFile(join(f.cwd, "output.txt"), "utf8"), "verified");
      else await assert.rejects(access(join(f.cwd, "output.txt")));
      assert.equal(interactions.listByTask(name).filter(item => item.status === "pending").length, 0);
    } finally { await r.close(); }
    return { seen, parentResult };
  };
  await Promise.all([run("team-a-writable", true), run("team-b-writable", true), run("team-c-scope-denied", false), run("team-d-readonly", false, "readonly"), run("team-e-outside", true, "auto", true)]);
  console.log("PASS five concurrent native task runtimes: child read/write, parent scope denial, explicit readonly, identity-local evidence, outside-workspace rejection, and truthful failure return");
} finally { db.close(); }
