import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AgentDoc, defineTool } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { Type } from "typebox";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { ActiveDurableConversation } from "../src/main/agent/durable/DurableConversationBranch";

const root = mkdtempSync(join(tmpdir(), "durable-passive-"));
const cwd = join(root, "cwd");
mkdirSync(cwd);
process.env.USERPROFILE = root;
process.env.HOME = root;
const directory = join(root, "durable", createHash("sha256").update("task").digest("hex"));
const db = new AppDatabase(join(root, "app.db"));
const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
  modelsStorePath: join(root, "models.json"), refreshOnCreate: false });
let requests = 0, effects = 0;
models.registerProvider("fixture", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
  models: [{ id: "fixture", name: "fixture", input: ["text"], reasoning: false, contextWindow: 128000, maxTokens: 512,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
  streamSimple: (model, context) => {
    const stream = createAssistantMessageEventStream();
    queueMicrotask(() => {
      requests++;
      const user = context.messages.filter(message => message.role === "user").at(-1);
      const value = typeof user?.content === "string" ? user.content : JSON.stringify(user?.content);
      const content: AssistantMessage["content"] = context.messages.at(-1)?.role === "toolResult"
        ? [{ type: "text", text: "complete" }]
        : value?.includes("pending-business") ? [{ type: "toolCall", id: `call-${requests}`, name: "codemode",
          arguments: { code: "await tools.fixture_effect({}); text('business complete');" } }]
        : value?.includes("seed") ? [{ type: "toolCall", id: `call-${requests}`, name: "codemode",
          arguments: { code: "store('mark','kept'); text('seeded');" } }]
        : [{ type: "text", text: "complete" }];
      const stopReason = content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
      const message: AssistantMessage = { role: "assistant", content, stopReason, api: model.api, provider: model.provider,
        model: model.id, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: stopReason, message });
      stream.end();
    });
    return stream;
  },
});
const tool = defineTool({ name: "fixture_effect", description: "actual isolated effect", parameters: Type.Object({}), replay: "unsafe",
  execute: async () => { effects++; appendFileSync(join(cwd, "effects.txt"), "effect\n"); return { output: [{ type: "text", text: "written" }] }; } });
const options = { directory, cwd, models, model: { provider: "fixture", modelId: "fixture" }, toolMode: "codemode" as const,
  tools: [tool], instructions: () => "fixture", onSnapshot: () => {} };
const files = () => Object.fromEntries(readdirSync(directory).filter(name => name.endsWith(".jsonl")).sort()
  .map(name => [name, createHash("sha256").update(readFileSync(join(directory, name))).digest("hex")]));
const nativeOpen = DurableBotRuntime.open;
let service: DurableBotService | undefined;
try {
  let runtime = await DurableBotRuntime.open(options);
  await (await runtime.submit("seed", "seed-request")).wait(ctx);
  await runtime.conversation.waitForIdle(ctx);
  const agentBefore = await runtime.harness.snapshot(AgentDoc, runtime.conversation.id, ctx);
  await runtime.forkForRegeneration(undefined, { operationId: "pending-regeneration", content: "pending-business" });
  const pendingBefore = await runtime.harness.snapshot(ActiveDurableConversation, ctx);
  await runtime.close();
  const committed = files(), initialRequests = requests;
  runtime = await DurableBotRuntime.open({ ...options, readOnly: true, instructions: () => { throw new Error("viewer must not build prompts"); } });
  assert.deepEqual(await runtime.harness.snapshot(ActiveDurableConversation, ctx), pendingBefore);
  assert.deepEqual(await runtime.harness.snapshot(AgentDoc, runtime.conversation.id, ctx), agentBefore);
  assert.equal(requests, initialRequests);
  assert.equal(effects, 0);
  await assert.rejects(runtime.submit("forbidden", "viewer-write"), /read.?only/i);
  await assert.rejects(runtime.configure(options.model, "native"), /read.?only/i);
  await runtime.close();
  assert.deepEqual(files(), committed, "passive native viewer must not rewrite the journal, agent or pending regeneration");
  const main = join(directory, "main.jsonl"), valid = readFileSync(main, "utf8");
  for (const suffix of [valid.trimEnd().split("\n").at(-1)! + "\n", '{"format":']) {
    writeFileSync(main, valid + suffix);
    const damaged = files();
    await assert.rejects(DurableBotRuntime.open({ ...options, readOnly: true }), /read.only|corruption|sequence/i);
    assert.deepEqual(files(), damaged, "neither custom repair nor SDK torn-tail recovery may mutate a passive view");
    writeFileSync(main, valid);
  }

  db.upsertTask({ id: "task", title: "task", cwd, modelId: "fixture/fixture", updatedAt: Date.now() });
  let factoryBroken = true;
  service = new DurableBotService({ db, models, agentDir: root, mcpDir: join(root, "mcp"), resolveCwd: () => cwd,
    instructions: () => "fixture", toolMode: () => "codemode", defaultModel: () => "fixture/fixture", emit: () => {},
    tools: async () => { if (factoryBroken) throw new Error("factory unavailable"); return { tools: [tool], contextHooks: [] }; } });
  db.connection.prepare("INSERT INTO durable_bot_bindings VALUES (?, 'pi-durable', ?, ?)").run("task", directory, cwd);
  const history = await service.history("task");
  assert.equal(history.historyError, undefined);
  assert.deepEqual(files(), committed);
  assert.equal(requests, initialRequests);
  assert.equal(effects, 0);

  let markOpened!: () => void, release!: () => void;
  const opened = new Promise<void>(resolve => { markOpened = resolve; });
  const hold = new Promise<void>(resolve => { release = resolve; });
  DurableBotRuntime.open = async input => {
    const viewer = await nativeOpen(input);
    if (input.readOnly) { markOpened(); await hold; }
    return viewer;
  };
  const reading = service.history("task");
  await opened;
  factoryBroken = false;
  let admitted = false;
  const strict = service.submit({ taskId: "task", userMessageId: "strict-input", assistantMessageId: "strict-answer", text: "hello" })
    .then(result => { admitted = true; return result; });
  await Promise.resolve();
  assert.equal(admitted, false);
  assert.equal(requests, initialRequests);
  assert.equal(effects, 0);
  release();
  assert.equal((await reading).historyError, undefined, "strict reopening must not close the active history reader");
  const accepted = await strict;
  assert(accepted.receipt);
  const result = await service.submissionStatus(accepted.receipt, true);
  assert.equal(result.error, undefined);
  assert.equal(effects, 1, "only a genuine strict runtime may resume the pending business once");
  assert.equal(readFileSync(join(cwd, "effects.txt"), "utf8"), "effect\n");
  await service.release("task");
  factoryBroken = true;
  const openedAgain = new Promise<void>(resolve => { markOpened = resolve; });
  const heldAgain = new Promise<void>(resolve => { release = resolve; });
  DurableBotRuntime.open = async input => {
    const viewer = await nativeOpen(input);
    if (input.readOnly) { markOpened(); await heldAgain; }
    return viewer;
  };
  const readingBeforeDelete = service.history("task");
  await openedAgain;
  db.deleteTask("task");
  let purged = false;
  const deleting = service.purge("task").then(() => { purged = true; });
  await Promise.resolve();
  assert.equal(purged, false);
  assert(existsSync(directory));
  release();
  assert.equal((await readingBeforeDelete).historyError, undefined);
  await deleting;
  assert.equal(existsSync(directory), false, "permanent purge waits until the passive reader releases its lease");
  console.log("PASS passive native history preserves pending work and Code Mode configuration; strict concurrent reopening runs one actual effect");
} finally {
  DurableBotRuntime.open = nativeOpen;
  await service?.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
