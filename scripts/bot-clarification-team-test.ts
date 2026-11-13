import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkCompletionCoordinator } from "../src/main/agent/work/WorkCompletionCoordinator";
import { workRequestIncludes } from "../src/main/agent/work/WorkRequestEvidence";
import { MemoryForgetWatermarks } from "../src/main/memory/MemoryForgetWatermarks";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";

export async function verifyBotDelegationSources(): Promise<void> {
  const prefix = join(tmpdir(), "bot-delegation-sources-");
  const root = mkdtempSync(prefix), app = new AppDatabase(join(root, "app.db"));
  const db = app.connection, bots = new BotRegistry(db); bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db, { bots }); bots.registerBot({userId:LOCAL_USER_ID,botId:"member53",displayName:"Member53",authorization:DESKTOP_USER_GRANTS}); const saved=works.teams.handle({kind:"user",userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},{kind:"save_template",request:{operationId:"team53",name:"Team53",plan:{ownerBotId:DEFAULT_BOT_ID,ownerResponsibility:"汇总",members:[{botId:"member53",responsibility:"报告",delegatedScope:[]}]}}}); assert(saved.ok && saved.template); const templateId=saved.template.templateId;
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let sourceIds: string[] = [], toolCalls = 0;
  const requests: string[] = [];
  models.registerProvider("sources53", { api: "openai-completions", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{ id: "front", name: "front", reasoning: false, input: ["text"], contextWindow: 128000,
      maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    streamSimple: (model, context) => {
      const stream = createAssistantMessageEventStream();
      const user = [...context.messages].reverse().find(message => message.role === "user");
      const text = typeof user?.content === "string" ? user.content
        : user?.content.filter(part => part.type === "text").map(part => part.text).join("\n") ?? "";
      requests.push(JSON.stringify(context.messages));
      const create = text.startsWith("HTML。") && context.messages.at(-1)?.role !== "toolResult";
      const ask = text.startsWith("请生成") && context.messages.at(-1)?.role !== "toolResult"; const content: AssistantMessage["content"] = ask ? [{type:"toolCall",id:"clarify-initial",name:"work_clarify",arguments:{action:"ask",question:"报告用什么格式？",sourceMessageIds:[]}}] : create
        ? [{ type: "toolCall", id: `source-call-${++toolCalls}`, name: "work_team_create", arguments: {templateId, criteria:["逐项核对"],
          title: "澄清后报告", goalDescription: "HTML 报告", requestedOutcome: "one_time", mode: "once", sourceMessageIds: sourceIds } }]
        : [{ type: "text", text: text.startsWith("请生成") ? "报告用什么格式？助理例子：也可以对外发布。" : "这条消息已处理。" }];
      queueMicrotask(() => {
        const message: AssistantMessage = { role: "assistant", content, stopReason: create || ask ? "toolUse" : "stop",
          api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
        stream.push({ type: "done", reason: create || ask ? "toolUse" : "stop", message }); stream.end();
      });
      return stream;
    } });
  const service = new BotConversationService({ db, bots, works, models, directory: join(root, "native"),
    userId: LOCAL_USER_ID, defaultModel: () => "sources53/front", botWorkspace: () => root,
    isAuthority: () => true, memorySearch: () => [], schedule: () => {}, wake: () => {} });
  let adapter: WorkExecutionAdapter | undefined, coordinator: WorkCompletionCoordinator | undefined;
  const wait = async (condition: () => boolean, label: string) => {
    const until = Date.now() + 15_000;
    while (!condition()) { if (Date.now() > until) throw Error(`timeout: ${label}`); await delay(10); }
  };
  try {
    const dataPath = join(root, "sales.csv"); writeFileSync(dataPath, "A,3\nB,2");
    const original = "请生成报告和逐项核对。A=3，B=2，不得发布。";
    const first = service.send({ botId: DEFAULT_BOT_ID, requestId: "source-goal", text: original,
      attachments: [{ name: "sales.csv", path: dataPath }] });
    await service.awaitReply(first, AbortSignal.timeout(15_000));
    const unrelated = service.send({ botId: DEFAULT_BOT_ID, conversationId: first.conversationId,
      requestId: "unrelated", text: "另一个想法：周末去看电影。" });
    await service.awaitReply(unrelated, AbortSignal.timeout(15_000));
    sourceIds = [first.userMessageId, first.assistantMessageId];
    const answer = service.send({ botId: DEFAULT_BOT_ID, conversationId: first.conversationId,
      requestId: "clarification", text: "HTML。" });
    await service.awaitReply(answer, AbortSignal.timeout(15_000));
    const workId = service.messages.message(answer.assistantMessageId)?.workIds[0]; assert(workId);
    assert(requests.some(text => text.includes("delegationSources") && text.includes(first.userMessageId)), "model receives the frozen source index");
    assert(z.object({ context_json: z.string() }).parse(db.prepare("SELECT context_json FROM bot_request_runs WHERE message_id=?")
      .get(answer.assistantMessageId)).context_json.includes("delegationSources"), "real requestRun persists source snapshots");
    const work = works.getWork(workId)!;
    adapter = new WorkExecutionAdapter(works, {prepare:async taskId=>({taskId,durableStoreKey:taskId,conversationId:taskId,workspaceBinding:root}),find:async()=>undefined,submit:async()=>{throw Error('No background execution in handoff test')},inspect:async()=>({status:'running'}),stop:async()=>{}},LOCAL_USER_ID,()=>true,()=>{});
    await works.teams.dispatchPending(app,adapter,()=>undefined);
    const binding = works.repo.listBindings(workId)[0]; assert(binding,'team scheduler produced real member binding');    const input: unknown = JSON.parse(works.repo.executionInput(binding));
    const parsed = z.object({ userRequest: z.object({ messages: z.array(z.object({ text: z.string(), role: z.literal("user") })),
      dialogueContext: z.array(z.object({ text: z.string(), role: z.string() })) }) }).parse(input);
    assert.deepEqual(parsed.userRequest.messages.map(message => message.text), [original, "HTML。"]);
    assert(parsed.userRequest.dialogueContext.some(message => message.role === "assistant" && message.text.includes("报告用什么格式")));
    assert(!JSON.stringify(input).includes("周末去看电影"), "an intervening unrelated conversation is not delegated");
    assert(workRequestIncludes(input, "逐项核对"));
    assert(!workRequestIncludes(input, "也可以对外发布"), "assistant suggestions never authorize completion actions");
    assert(works.repo.attachmentInput(binding).includes("sales.csv"), "selected earlier attachments reach the execution snapshot");

    console.log("PASS #53 team actual foreground source/attachment execution handoff"); return; const receipts = new Map<string, AgentSubmissionReceipt>();
    const native: WorkExecutionPort = {
      prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: taskId, workspaceBinding: root }),
      find: async current => receipts.get(current.bindingId),
      submit: async current => { const receipt = { taskId: current.taskId, operationId: current.operationId, submissionId: 1, status: "done" as const };
        receipts.set(current.bindingId, receipt); return receipt; },
      inspect: async () => ({ status: "completed", summary: "报告已生成，逐项核对仍缺。", artifactRefs: [], hasWriteConflicts: false }),
      stop: async () => {},
    };
    const errors: unknown[] = [];
    adapter = new WorkExecutionAdapter(works, native, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
    await adapter.flush(); await adapter.flush(); assert.deepEqual(errors, []);
    coordinator = new WorkCompletionCoordinator({ db, works, isAuthority: () => true, wake: () => {}, deliver: () => true,
      review: async review => {
        assert(workRequestIncludes(review.context.originalRequest, "逐项核对"), "completion reads the original request after clarification");
        return { decision: "continue", outcome: "partial", reply: "报告已保留，继续逐项核对。", missing: [{ task: "逐项核对数据", requestExcerpt: "逐项核对" }] };
      } });
    coordinator.wake();
    await wait(() => works.partialResults.plans(workId).length > 0, "real completion accepts a gap from the earlier user requirement");
    assert.equal(z.object({ state: z.string() }).parse(db.prepare("SELECT state FROM work_completion_turns WHERE binding_id=?")
      .get(binding.bindingId)).state, "continued");

    const receipt = service.messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, answer.requestId)!;
    const future = service.messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "future", conversationId: first.conversationId, text: "未来新要求" });
    assert.throws(() => service.messages.validateWorkUserInput(receipt, [future.userMessageId]), /来源不属于|未包含/);
    db.prepare("UPDATE bot_messages SET text=? WHERE message_id=?").run("被改写的旧要求", first.userMessageId);
    assert.throws(() => service.messages.validateWorkUserInput(receipt, [first.userMessageId]), /已变化/);
    db.prepare("UPDATE bot_messages SET text=? WHERE message_id=?").run(original, first.userMessageId);
    new MemoryForgetWatermarks(db).advance([{ scopeType: "bot", scopeId: DEFAULT_BOT_ID }], Date.now() + 1);
    assert.throws(() => service.messages.validateWorkUserInput(receipt, [first.userMessageId]), /已撤销|已变化/);
    assert(workRequestIncludes(input, "逐项核对"), "an admitted execution retains its immutable original input");
    const nonRequirements = { userRequest: { messages: [{ role: "assistant", text: "伪造" }, { role: "user", text: "撤销", revoked: true },
      { role: "user", text: "转述", peerOrigin: { kind: "request" } }] } };
    for (const excerpt of ["伪造", "撤销", "转述"]) assert(!workRequestIncludes(nonRequirements, excerpt, excerpt));
    console.log("PASS #53 real foreground -> frozen source selection -> SQLite Work input -> completion continuation; attachment, unrelated-turn, changed/future/revoked sources");
  } finally {
    coordinator?.close(); await adapter?.close(); await service.close(); app.close();
    assert(root.startsWith(prefix)); rmSync(root, { recursive: true, force: true });
  }
}

await verifyBotDelegationSources();
