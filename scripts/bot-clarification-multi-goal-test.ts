import { botClarificationAnswerText, botClarificationAnswerRequestId } from "../src/shared/bot-conversation";
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
  const works = new WorkService(db, { bots });
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  let sourceIds: string[] = [], toolCalls = 0; let selectedGoal="";
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
      const create = text.startsWith("回答：") && context.messages.at(-1)?.role !== "toolResult";
      const ask = text.startsWith("请生成") && context.messages.at(-1)?.role !== "toolResult"; const content: AssistantMessage["content"] = ask ? [{type:"toolCall",id:"clarify-initial",name:"work_clarify",arguments:{action:"ask",question:"报告用什么格式？",options:[{id:"html",label:"HTML",recommended:true},{id:"pdf",label:"PDF"}],sourceMessageIds:[]}},{type:"toolCall",id:"clarify-second",name:"work_clarify",arguments:{action:"ask",question:"核对结果用什么语言？",options:[{id:"zh",label:"中文"},{id:"en",label:"英文"}],sourceMessageIds:[]}}] : create
        ? [{ type: "toolCall", id: `source-call-${++toolCalls}`, name: "work_create", arguments: {
          clarificationGoalId:selectedGoal,title: "澄清后报告", goalDescription: "HTML 报告", requestedOutcome: "one_time", mode: "once", sourceMessageIds: sourceIds } }]
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
    const first=service.send({botId:DEFAULT_BOT_ID,requestId:"two-goals",text:"请生成报告和逐项核对。"});
    await service.awaitReply(first,AbortSignal.timeout(15000));
    const cards=service.messages.message(first.assistantMessageId)!.clarifications!;
    assert.equal(cards.length,2,"two real work_clarify calls project two cards");
    const workIds:string[]=[];
    for(const [index,card] of cards.entries()) {
      selectedGoal=card.goalId;
      const receipt=service.send({botId:DEFAULT_BOT_ID,conversationId:first.conversationId,
        requestId:botClarificationAnswerRequestId(first.assistantMessageId,card.goalId),referenceMessageId:first.assistantMessageId,
        clarificationGoalId:card.goalId,text:index===0?"回答：HTML":"回答：中文"});
      await service.awaitReply(receipt,AbortSignal.timeout(15000));
      const reply=service.messages.message(receipt.assistantMessageId)!;
      assert.equal(reply.status,"completed",JSON.stringify(reply));assert.equal(reply.workIds.length,1,JSON.stringify(reply));
      workIds.push(reply.workIds[0]!);
      const state=service.messages.message(first.assistantMessageId)!.clarifications!;
      assert.equal(state[index]!.status,"consumed");
      assert.equal(state[index]!.answerText,index===0?"回答：HTML":"回答：中文");
      if(index===0)assert.equal(state[1]!.status,"pending","first goal must not consume sibling");
    }
    assert.notEqual(workIds[0],workIds[1]);
    assert(requests.some(text=>text.includes(cards[0]!.goalId)&&text.includes(cards[1]!.goalId)),"both goals reach real foreground context");
    console.log("PASS multi-goal real tool calls -> two cards -> independent answers -> two Work creations and separate consume");
  } finally {
    coordinator?.close(); await adapter?.close(); await service.close(); app.close();
    assert(root.startsWith(prefix)); rmSync(root, { recursive: true, force: true });
  }
}

await verifyBotDelegationSources();
