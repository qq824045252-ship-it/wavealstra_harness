import assert from "node:assert/strict";
import { join } from "node:path";
import { getCurrentSystemPrompt, getCurrentTools, type AssistantMessage, type TranscriptContext, type Models } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import type { AgentPromptRequest } from "../src/shared/agent-ipc";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness, MemoryStorage, createRegistry, type EntryDraft } from "@earendil-works/pi-durable";
import { DurableSkillProjection, durableInputAuditSchema } from "../src/main/agent/durable/DurableSkillProjection";
import { AgentLoadoutObservationService } from "../src/main/agent/AgentLoadoutObservationService";
import { MemorySkillEffectivenessService } from "../src/main/memory/MemorySkillEffectivenessService";

/** Only the provider boundary is deterministic; admission, native storage, tools and product projections are real. */
export async function createAgentDurableFixture(root: string, db: AppDatabase,
  respond: (request: TranscriptContext) => AssistantMessage["content"] = () => [{ type: "text", text: "[]" }]) {
  const { ModelRuntime, SettingsManager } = await import("@earendil-works/pi-coding-agent");
  const { AgentService } = await import("../src/main/agent/AgentService");
  const { TaskExecutionWorkspace } = await import("../src/main/task/TaskExecutionWorkspace");
  const requests: Array<{ instructions: string; tools: string[]; input: TranscriptContext }> = [];
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"), allowModelNetwork: false, refreshOnCreate: false });
  models.registerProvider("fixture", { api: "openai-completions", apiKey: "isolated-fixture", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, input) => {
      const stream = createAssistantMessageEventStream();
      const tools = getCurrentTools(input.messages).map(tool => tool.name);
      if (tools.length) requests.push({ instructions: getCurrentSystemPrompt(input.messages), tools, input });
      queueMicrotask(() => {
        const content = respond(input);
        const stopReason = content.some(part => part.type === "toolCall") ? "toolUse" : "stop";
        const message: AssistantMessage = { role: "assistant", content, stopReason, provider: model.provider, model: model.id, api: model.api,
          timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: stopReason, message }); stream.end();
      });
      return stream;
    },
  });
  await models.refresh({ allowNetwork: false });
  const settings = SettingsManager.create(root, join(root, ".mybuddy"));
  settings.setDefaultModelAndProvider("fixture", "model"); settings.setEnabledModels(["fixture/model"]);
  const agent = new AgentService(db, new TaskExecutionWorkspace(join(root, "task-workspaces")), { models });
  await agent.init();
  await agent.resumePersistedTasks();
  return {
    agent, models, requests,
    prompt: async (input: AgentPromptRequest) => {
      const accepted = await agent.prompt({ ...input, modelId: "fixture/model" });
      assert(accepted.receipt, "native admission returns a receipt");
      const settled = await agent.waitForSubmission(accepted.receipt);
      assert.equal(settled.receipt?.status, "done");
      await agent.loadTaskHistory(input.taskId);
      return settled;
    },
    skills: () => [...(requests.at(-1)?.instructions.split("## Skills\n").at(-1) ?? "").matchAll(/^- ([^:]+): .*\((.+)\)$/gm)]
      .map(match => ({ name: match[1]!, filePath: match[2]! })),
    close: async () => { await agent.closeDurableBots(); agent.dispose(); },
  };
}

/** Feed committed native records to the audit projection, including intermediate model failures. */
export async function verifySkillProjectionRecovery(db: AppDatabase, root: string, models: Models): Promise<void> {
  const taskId = "audit-recovery";
  db.upsertTask({ id: taskId, title: "Audit recovery", updatedAt: 1 });
  const loadouts = new AgentLoadoutObservationService(db), effectiveness = new MemorySkillEffectivenessService(db);
  const projection = new DurableSkillProjection(loadouts, effectiveness);
  const harness = await Harness.open(new MemoryStorage(), { registry: createRegistry(), models }, BACKGROUND_CONTEXT);
  const conversation = await harness.root(BACKGROUND_CONTEXT);
  const longPath = join(root, "long-".repeat(55), "SKILL.md");
  const audit = durableInputAuditSchema.parse({ userMessageId: "audit-user", assistantMessageId: "audit-answer", cwd: root,
    skills: [{ id: "long-skill", name: "long-skill", path: longPath }], recommendation: { query: "run", mode: "coding",
      context: { memoryIds: [], scenarioIds: [], profileIds: [] }, capabilities: [{ kind: "skill", id: "long-skill", label: "long-skill",
        score: 1, recommended: true, actual: true, blocked: false, evidence: [] }] } });
  const append = async (draft: EntryDraft) => {
    const entry = await conversation.commit(tx => tx.appendEntry(conversation.id, draft), BACKGROUND_CONTEXT);
    projection.entries(taskId, String(conversation.id), [entry]);
    return entry;
  };
  const partial = (stopReason: "error" | "aborted" | "stop"): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text: stopReason }],
    api: "openai-completions", provider: "fixture", model: "model", timestamp: Date.now(), stopReason,
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
  try {
    await append({ kind: "mybuddy.user", data: { mybuddyInput: { audit } } });
    await append({ kind: "pi.assistant", model: [partial("error")] });
    assert.equal(loadouts.getByTurn(taskId, "audit-answer")?.outcome, "pending", "a retryable error is not a final run failure");
    await append({ kind: "pi.assistant", model: [partial("aborted")] });
    assert.equal(loadouts.getByTurn(taskId, "audit-answer")?.outcome, "pending", "an interrupted partial remains resumable");
    await append({ kind: "pi.tool-result", model: [{ role: "toolResult", toolCallId: "code", toolName: "codemode", timestamp: Date.now(), isError: false,
      content: [{ type: "text", text: "cancelled" }], details: { calls: [{ name: "read", args: JSON.stringify({ path: longPath }), status: "cancelled" }] } }] });
    assert.deepEqual(loadouts.getByTurn(taskId, "audit-answer")?.usedSkillIds, [], "cancelled nested previews are never read evidence");
    await append({ kind: "mybuddy.skill-read", data: { callId: "native-read", path: longPath, userMessageIds: ["audit-user"], at: Date.now() } });
    assert.deepEqual(loadouts.getByTurn(taskId, "audit-answer")?.usedSkillIds, ["long-skill"], "full native arguments survive the display-preview limit");
    await append({ kind: "pi.assistant", model: [partial("stop")] });
    assert.equal(loadouts.getByTurn(taskId, "audit-answer")?.outcome, "pending", "only native run completion settles the audit");
    const completed = await append({ kind: "mybuddy.input-outcome", data: { userMessageId: "audit-user", assistantMessageId: "audit-answer", outcome: "completed", at: Date.now() } });
    assert.equal(loadouts.getByTurn(taskId, "audit-answer")?.outcome, "completed");
    new DurableSkillProjection(loadouts, effectiveness).entries(taskId, String(conversation.id), [completed]);
    assert.equal(loadouts.getByTurn(taskId, "audit-answer")?.outcome, "completed", "checkpoint replay does not duplicate or regress outcome");
    await append({ kind: "mybuddy.user", data: { mybuddyInput: { audit: { ...audit, userMessageId: "failed-user", assistantMessageId: "failed-answer" } } } });
    await append({ kind: "pi.assistant", model: [partial("error")] });
    await append({ kind: "mybuddy.input-outcome", data: { userMessageId: "failed-user", assistantMessageId: "failed-answer", outcome: "failed", at: Date.now() } });
    await append({ kind: "mybuddy.user", data: { mybuddyInput: { audit: { ...audit, userMessageId: "next-user", assistantMessageId: "next-answer" } } } });
    await append({ kind: "pi.assistant", model: [partial("stop")] });
    await append({ kind: "mybuddy.input-outcome", data: { userMessageId: "next-user", assistantMessageId: "next-answer", outcome: "completed", at: Date.now() } });
    assert.equal(loadouts.getByTurn(taskId, "failed-answer")?.outcome, "failed", "a later successful receipt cannot settle the earlier failed turn");
    assert.equal(loadouts.getByTurn(taskId, "next-answer")?.outcome, "completed");
  } finally { await harness.close(BACKGROUND_CONTEXT); }
}
