/**
 * Issue #26 行为测试：会话分支的 as-of 压缩状态、手动整理取消、状态投影一致性。
 *
 * 真实运行 DurableBotRuntime + 真实 JSONL 存储；provider 由本地 fixture 代替（不上网）。
 * 前置：`pnpm -s test:durable-context-management` 已覆盖自动整理/原文回查/重启；
 * 本文件只覆盖那组测试没有覆盖、但 Issue #26 C.4 / E.3 明确要求的边界。
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableContextManager } from "../src/main/agent/durable/context/DurableContextManager";
import { DurableSubagentIdentity } from "../src/main/agent/durable/DurableSubagents";
import { DurableConsultIdentity } from "../src/main/agent/durable/DurableConsultSession";
import { captureDurableBranch, resolveDurableBranch } from "../src/main/agent/durable/DurableTaskBranch";
import type { DurableBranchSeed } from "../src/main/agent/durable/DurableTaskBranch";
import type { ContextManagementStatusDto } from "../src/shared/context-management";

const MODEL_CONTEXT_WINDOW = 128_000;
const CHARS_PER_TOKEN = 3.5;
const DEADLINE_MS = 20_000;
const SUMMARY_MARKER_PATTERN = /\[Compressed[^\]]*\]/;
const SUMMARY_TEXT = "Earlier seed history was folded into this section summary.";
const SEED_OLD_MARKER = "SEED_OLD_MARKER_BRANCH";
const BETA_MARKER = "BETA_FUTURE_MARKER_BRANCH";
const ALPHA_MARKER = "ALPHA_ANCHOR_MARKER_BRANCH";

interface RecordedRequest {
  messages: readonly Message[];
  tokens: number;
}

interface FixtureModels {
  api: DurableBotOptions["models"];
  requests: RecordedRequest[];
  summaryCalls: number;
  replyQueue: Array<{ kind: "text"; text: string } | { kind: "tool"; name: string; arguments: Record<string, unknown> }>;
  summaryDelayMs: number;
}

function withTimeout<T>(promise: Promise<T>, label: string, ms = DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[deadline] ${label} 在 ${ms}ms 内没有结束`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<T>;
}

function messageText(message: Message | { role: string; content?: unknown }): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!part || typeof part !== "object") return "";
    const typed = part as { type?: unknown; text?: unknown };
    return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
  }).join("\n");
}

function requestText(record: RecordedRequest): string {
  return record.messages.map(message => messageText(message)).join("\n");
}

function tokensOf(messages: readonly Message[]): number {
  return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function assistantMessage(content: AssistantMessage["content"], stopReason: "stop" | "toolUse", inputTokens: number, outputTokens: number, timestamp = Date.now()): AssistantMessage {
  return {
    role: "assistant", content, stopReason, api: "openai-completions", provider: "fixture", model: "fixture", timestamp,
    usage: { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

function createFixture(): FixtureModels {
  const model = {
    id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false,
    input: ["text"], contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const requests: RecordedRequest[] = [];
  const replyQueue: FixtureModels["replyQueue"] = [];
  const fixture: FixtureModels = { api: undefined as unknown as DurableBotOptions["models"], requests, summaryCalls: 0, replyQueue, summaryDelayMs: 0 };

  const streamSimple = (_model: unknown, context: { messages?: readonly Message[] }): unknown => {
    const messages = context.messages ?? [];
    requests.push({ messages, tokens: tokensOf(messages) });
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(() => {
      const reply = replyQueue.shift();
      if (!reply) throw new Error(`fixture 没有为第 ${requests.length} 次生成请求调度回复`);
      const content: AssistantMessage["content"] = [];
      if (reply.kind === "tool") content.push({ type: "toolCall", id: `fixture-call-${requests.length}`, name: reply.name, arguments: reply.arguments as never });
      else content.push({ type: "text", text: reply.text });
      const stopReason: "stop" | "toolUse" = reply.kind === "tool" ? "toolUse" : "stop";
      const message = assistantMessage(content, stopReason, tokensOf(messages), 32);
      stream.push({ type: "done", reason: stopReason, message } as never);
      stream.end();
    }).catch(error => {
      const failure = assistantMessage([{ type: "text", text: "" }], "stop", 0, 0);
      failure.stopReason = "error";
      failure.errorMessage = error instanceof Error ? error.message : String(error);
      stream.push({ type: "error", reason: "aborted", error: failure } as never);
      stream.end();
    });
    return stream;
  };

  const completeSimple = async (_model: unknown, context: { messages?: readonly Message[] }, options?: { signal?: AbortSignal }): Promise<AssistantMessage> => {
    fixture.summaryCalls += 1;
    if (fixture.summaryDelayMs > 0) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, fixture.summaryDelayMs);
        options?.signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          const error = new Error("summary aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    const messages = context.messages ?? [];
    return assistantMessage([{ type: "text", text: SUMMARY_TEXT }], "stop", tokensOf(messages), 32);
  };

  fixture.api = { getAuth: async () => undefined, getModel: () => model, streamSimple, completeSimple } as unknown as DurableBotOptions["models"];
  return fixture;
}

function seedFiller(chars: number): string {
  const unit = "seed context sentence about wind observations and archive references. ";
  return unit.repeat(Math.max(1, Math.ceil(chars / unit.length)));
}

function seedHistory(totalTokens = 80_000): Message[] {
  const messageCount = 8;
  const perMessageChars = Math.floor(totalTokens * CHARS_PER_TOKEN / messageCount);
  const messages: Message[] = [];
  for (let index = 0; index < messageCount; index++) {
    const head = index === 0 ? "Seed block 1 anchor notes." : index === 1 ? `${SEED_OLD_MARKER} seed detail.` : `Seed block ${index + 1}.`;
    const text = `${head}\n${seedFiller(perMessageChars)}`.slice(0, perMessageChars);
    if (index % 2 === 0) messages.push({ role: "user", content: text, timestamp: index + 1 });
    else messages.push(assistantMessage([{ type: "text", text }], "stop", perMessageChars, 20, index + 1));
  }
  return messages;
}

function runtimeOptions(input: {
  directory: string; workspace: string; fixture: FixtureModels; seed?: readonly Message[];
  statuses?: ContextManagementStatusDto[]; initialBranch?: DurableBranchSeed; ratio?: number; ratioRef?: { value: number }; toolMode?: "native" | "codemode";
  engineRef?: { value: "billion-context" | "native" };
}): DurableBotOptions {
  return {
    directory: input.directory,
    cwd: input.workspace,
    models: input.fixture.api,
    model: { provider: "fixture", modelId: "fixture" },
    toolMode: input.toolMode ?? "native",
    instructions: () => "Branch/cancel fixture.",
    onSnapshot: () => {},
    ...(input.seed ? { initialHistory: { messages: input.seed, context: [] } } : {}),
    ...(input.initialBranch ? { initialBranch: input.initialBranch } : {}),
    contextManagement: {
      policy: () => ({ ratio: input.ratioRef?.value ?? input.ratio ?? 0.8, absoluteTokens: null }),
      engine: () => input.engineRef?.value ?? "billion-context",
      toolEstimateTokens: () => 0,
      ...(input.statuses ? { onStatus: status => input.statuses!.push(status) } : {}),
    },
  };
}

async function submitTurn(runtime: DurableBotRuntime, text: string, requestId: string): Promise<void> {
  const submission = await withTimeout(runtime.submit(text, requestId), `submit ${requestId}`);
  const settled = await withTimeout(submission.wait(ctx), `wait ${requestId}`);
  assert.equal(settled.status, "done", `回合 ${requestId} 未完成：${JSON.stringify(settled)}`);
}

async function userEntryId(runtime: DurableBotRuntime, marker: string): Promise<number> {
  const page = await withTimeout(runtime.conversation.entries({ order: "ascending" }, 500, undefined, ctx), "scan entries");
  const entry = page.items.find(item => (item.model ?? []).some(message => message.role === "user" && messageText(message).includes(marker)));
  assert(entry, `找不到包含 ${marker} 的用户 entry`);
  return entry.id;
}

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-context-branch-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const workspace = join(root, "workspace");
await mkdir(workspace, { recursive: true });
const runtimes: DurableBotRuntime[] = [];
const directories: string[] = [];

try {
  // ── 1) 分支 as-of：锚点之后新增的摘要块不得进入分支的压缩状态 ────────────────
  {
    const directory = join(root, "branch-state");
    directories.push(directory);
    const fixture = createFixture();
    const seed = seedHistory();
    let main = await withTimeout(DurableBotRuntime.open(runtimeOptions({ directory, workspace, fixture, seed, ratio: 0.5 })), "open branch runtime");
    runtimes.push(main);

    fixture.replyQueue.push({ kind: "text", text: "alpha answer" });
    await submitTurn(main, `${ALPHA_MARKER} turn after seed.`, "branch-alpha");
    fixture.replyQueue.push({ kind: "text", text: "beta answer" });
    // beta 轮必须足够大，确保 fork 之前 BC 已经产生覆盖 beta 的摘要块（否则 as-of 断言无法区分 current/asOf）。
    const betaText = `${BETA_MARKER} future turn that must not leak into the fork.\n${seedFiller(280_000)}`;
    await submitTurn(main, betaText, "branch-beta");
    await withTimeout(main.conversation.waitForIdle(ctx), "wait branch source idle");

    const betaUserId = await userEntryId(main, BETA_MARKER);
    const page = await withTimeout(main.conversation.entries({ order: "ascending" }, 500, undefined, ctx), "scan branch entries");
    const betaUserIndex = page.items.findIndex(item => item.id === betaUserId);
    assert(betaUserIndex >= 0, "找不到 beta 用户 entry 的位置");
    // 锚点 = beta 用户消息之前的 assistant 回复（alpha 轮结束处）。
    const anchorEntryId = page.items[Math.max(0, betaUserIndex - 1)]!.id;
    const summaryBeforeFork = main.contextManagementStatus()?.summaries ?? [];
    const betaBlockLeaked = summaryBeforeFork.some(summary => summary.entryIds.some(id => id > anchorEntryId));

    const forkId = await withTimeout(main.forkAt(anchorEntryId), "fork at anchor");
    console.log(`[branch-test] anchor=${anchorEntryId} fork=${forkId} summariesBeforeFork=${summaryBeforeFork.length} betaLeakBeforeFork=${betaBlockLeaked}`);
    await withTimeout(main.close(), "close main before reopen");

    main = await withTimeout(DurableBotRuntime.open(runtimeOptions({ directory, workspace, fixture })), "reopen forked runtime");
    runtimes.push(main);
    fixture.replyQueue.push({ kind: "text", text: "gamma answer" });
    await submitTurn(main, "gamma after fork: continue from the anchor only.", "branch-gamma");

    const lastRequest = fixture.requests.at(-1)!;
    const text = requestText(lastRequest);
    assert(!text.includes(BETA_MARKER), "分支请求包含了锚点之后的 beta 消息：fork 没有按 as-of 截断历史");
    assert(text.includes("gamma after fork"), "分支请求缺少分支上的新用户消息");

    const status = main.contextManagementStatus();
    assert(status, "分支运行时必须暴露上下文管理状态");
    assert.equal(status.engine, "billion-context", "分支运行时引擎必须保持 billion-context");
    for (const summary of status.summaries ?? []) {
      assert(summary.entryIds.every(id => id <= anchorEntryId),
        `分支压缩状态包含锚点之后的摘要块：锚点=${anchorEntryId}，块=${JSON.stringify(summary)}`);
    }
    console.log(`[branch-test] PASS branch as-of: anchor=${anchorEntryId}, summaries=${(status.summaries ?? []).length}, providerTokens=${lastRequest.tokens}`);
    await withTimeout(main.close(), "close forked runtime");
  }

  // ── 2) 手动整理取消：取消后不得伪报完成，也不得把已取消的结果当成功提交 ──────
  {
    const directory = join(root, "cancel-state");
    directories.push(directory);
    const fixture = createFixture();
    fixture.summaryDelayMs = 1_500;
    const runtime = await withTimeout(DurableBotRuntime.open(runtimeOptions({ directory, workspace, fixture, seed: seedHistory() })), "open cancel runtime");
    runtimes.push(runtime);

    const outcomePromise = runtime.compact();
    const started = Date.now();
    while (fixture.summaryCalls === 0 && Date.now() - started < 8_000) await new Promise(resolve => setTimeout(resolve, 20));
    assert(fixture.summaryCalls > 0, "手动整理没有调用摘要模型，无法验证取消语义");
    const aborted = await withTimeout(runtime.abortCompaction(), "abort manual compaction");
    assert.equal(aborted, true, "取消手动整理必须返回 true（本次整理确实在运行）");
    const outcome = await withTimeout(outcomePromise, "await cancelled compaction");
    assert.equal(outcome.applied, false, `已取消的手动整理不得报告 applied=true：${JSON.stringify(outcome)}`);
    assert(String(outcome.skippedReason ?? "").includes("取消"), `取消原因必须明确，实际 skippedReason=${String(outcome.skippedReason)}`);
    const status = runtime.contextManagementStatus();
    assert(status, "取消后仍必须能读到状态");
    assert.equal(status.phase, "cancelled", `取消必须产生明确的 cancelled 终态，实际 phase=${status.phase}`);
    console.log(`[branch-test] PASS cancel manual compaction: phase=${status.phase} skippedReason=${String(outcome.skippedReason)}`);
    await withTimeout(runtime.close(), "close cancel runtime");
  }

  // ── 3) 原生 overflow 兜底：替摘要请求本身必须有界，不能把整段 raw prefix 一次发出 ──
  {
    const calls: number[] = [];
    const fakeModels = {
      getAuth: async () => undefined,
      getModel: () => ({ provider: "fixture", modelId: "fixture", contextWindow: MODEL_CONTEXT_WINDOW, api: "openai-completions" }),
      completeSimple: async (_model: unknown, context: { messages?: readonly Message[] }) => {
        calls.push(tokensOf(context.messages ?? []));
        return assistantMessage([{ type: "text", text: SUMMARY_TEXT }], "stop", 0, 0);
      },
    } as unknown as DurableBotOptions["models"];
    const fakeDoc = () => ({
      schemaVersion: 1, kernelVersion: "", configDigest: "", headEntryId: null, watermarkEntryId: 0, epoch: 1,
      refs: {}, archivedRefs: [], stateJson: "", summaries: [], stats: { rounds: 0, folds: 0, tokensCompressed: 0 },
    });
    const fakeConversation = {
      id: 1 as never,
      context: async () => ({ head: undefined, entries: [], messages: [] }),
      commit: async (fn: (tx: { doc: () => Promise<ReturnType<typeof fakeDoc>> }) => unknown) => fn({ doc: async () => fakeDoc() }),
      agent: async () => ({ model: { provider: "fixture", modelId: "fixture" } }),
    } as never;
    const manager = new DurableContextManager({
      conversation: fakeConversation, models: fakeModels,
      policy: () => ({ ratio: 0.8, absoluteTokens: null }),
      contextWindow: () => MODEL_CONTEXT_WINDOW,
      modelKey: () => "fixture/fixture",
      log: () => {},
    });
    const huge: Message[] = Array.from({ length: 12 }, (_, index) => ({
      role: "user" as const, content: `huge section ${index}\n${seedFiller(24_000)}`, timestamp: index,
    }));
    assert(tokensOf(huge) > MODEL_CONTEXT_WINDOW * 0.45, "overflow 兜底测试的输入必须超过 45% 窗口预算");
    const decision = await manager.beforeCompact({ reason: "overflow", messages: huge }, { models: fakeModels } as never, ctx);
    assert(decision !== undefined && "summary" in decision,
      `overflow 且输入超出摘要预算时必须返回有界摘要，实际 ${JSON.stringify(decision)}`);
    assert(calls.length >= 2, `分块摘要必须多次调用而不是一次吞下全部原文，实际 ${calls.length} 次`);
    assert(calls.every(tokens => tokens <= 26_000), `每次摘要请求的输入必须远小于窗口，实际 ${calls.join(",")} tokens`);
    const threshold = await manager.beforeCompact({ reason: "threshold", messages: huge }, { models: fakeModels } as never, ctx);
    assert(threshold !== undefined && "decline" in threshold, "BC 健康时 threshold 压缩必须 decline，交给请求前投影处理");
    manager.dispose();
    console.log(`[branch-test] PASS overflow fallback: chunks=${calls.length} tokens=${calls.join(",")}`);
  }
  // ── 4) 子代理/会诊会话：每个 conversation 有自己的 BC 投影，不套用主会话 refs ──
  {
    const directory = join(root, "child-state");
    directories.push(directory);
    const fixture = createFixture();
    const main = await withTimeout(DurableBotRuntime.open(runtimeOptions({ directory, workspace, fixture })), "open child-main runtime");
    runtimes.push(main);
    const seed = seedHistory(80_000);
    const parentAgent = await withTimeout(main.conversation.agent(ctx), "read parent agent");
    const child = await withTimeout(main.harness.createConversation({
      ownership: { kind: "ownerless" },
      init: async (tx, id) => {
        const identity = await tx.doc(DurableSubagentIdentity, id);
        identity.value = { role: "test-child" } as never;
        for (const message of seed) {
          await tx.appendEntry(id, {
            kind: message.role === "user" ? "pi.user" : "pi.assistant", model: [message],
          });
        }
      },
    }, ctx), "create child conversation");
    await withTimeout(child.configure({ model: { provider: "fixture", modelId: "fixture" }, tools: [...parentAgent.callable] }, ctx), "configure child");
    fixture.replyQueue.push({ kind: "text", text: "child answer" });
    const submission = await withTimeout(child.submit({ type: "input", content: "child task: continue from the seed context" }, ctx), "submit child input");
    assert.equal((await withTimeout(submission.wait(ctx), "wait child")).status, "done", "子会话回合未完成");
    const childRequest = fixture.requests.at(-1)!;
    const childText = requestText(childRequest);
    assert(SUMMARY_MARKER_PATTERN.test(childText), "子会话请求里没有 BC 摘要投影：子代理没有自己的协调器");
    assert(childRequest.tokens < tokensOf(seed) * 0.5, `子会话投影必须显著变小：seed≈${tokensOf(seed)}，实际=${childRequest.tokens}`);
    assert(!childText.includes(SEED_OLD_MARKER), "子会话请求仍包含已被折叠的旧 marker");
    console.log(`[branch-test] PASS child conversation: tokens ${tokensOf(seed)} -> ${childRequest.tokens}, summaries applied in own conversation`);
    await withTimeout(main.close(), "close child-main runtime");
  }
  // ── 5) 独立新任务分支：只复制锚点前历史，压缩状态按分支自己的可见历史重建 ──────
  {
    const sourceDirectory = join(root, "task-source");
    const targetDirectory = join(root, "task-target");
    directories.push(sourceDirectory, targetDirectory);
    const fixture = createFixture();
    const seed = seedHistory(80_000);
    const source = await withTimeout(DurableBotRuntime.open(runtimeOptions({ directory: sourceDirectory, workspace, fixture, seed })), "open task-branch source");
    runtimes.push(source);
    fixture.replyQueue.push({ kind: "text", text: "alpha answer" });
    await submitTurn(source, `${ALPHA_MARKER} source turn that becomes the branch anchor.`, "task-branch-alpha");
    fixture.replyQueue.push({ kind: "text", text: "beta answer" });
    await submitTurn(source, `${BETA_MARKER} source turn after the anchor.`, "task-branch-beta");

    await withTimeout(source.conversation.waitForIdle(ctx), "wait source idle");
    const page = await withTimeout(source.conversation.entries({ order: "ascending" }, 500, undefined, ctx), "scan source entries for anchor");
    const alphaUserIndex = page.items.findIndex(item => (item.model ?? []).some(message => message.role === "user" && messageText(message).includes(ALPHA_MARKER)));
    assert(alphaUserIndex >= 0, "source 里找不到 alpha 锚点");
    const alphaUserId = page.items[alphaUserIndex]!.id;
    const anchor = await withTimeout(resolveDurableBranch(source, { sourceTaskId: "task", requestId: "req", entryId: String(alphaUserId), position: "after_reply" }), "resolve task branch anchor");
    const branchSeed = await withTimeout(captureDurableBranch(source, anchor), "capture task branch");
    await withTimeout(source.close(), "close task-branch source");

    const target = await withTimeout(DurableBotRuntime.open(runtimeOptions({ directory: targetDirectory, workspace, fixture, initialBranch: branchSeed, ratio: 0.5 })), "open task-branch target");
    runtimes.push(target);
    fixture.replyQueue.push({ kind: "text", text: "branch target answer" });
    await submitTurn(target, "continue this independent task branch from the copied anchor only", "task-branch-gamma");
    const targetRequest = fixture.requests.at(-1)!;
    const targetText = requestText(targetRequest);
    assert(targetText.includes(ALPHA_MARKER), "任务分支必须包含锚点之前的历史");
    assert(!targetText.includes(BETA_MARKER), "任务分支包含了锚点之后的 beta 内容：分支没有按锚点截断");
    const targetStatus = target.contextManagementStatus();
    assert(targetStatus, "任务分支运行时必须暴露上下文管理状态");
    assert.equal(targetStatus.engine, "billion-context", "任务分支必须使用同一个上下文管理引擎");
    assert(targetRequest.tokens < 60_000, `任务分支必须按自己的可见历史重新整理（providerTokens=${targetRequest.tokens}）`);
    // 分支摘要只能引用该分支自己的 entry，不能引用源会话的 entry/ref。
    const targetEntryIds = new Set<number>((await withTimeout(target.conversation.entries({ order: "ascending" }, 500, undefined, ctx), "scan target entry ids")).items.map(item => Number(item.id)));
    for (const summary of targetStatus.summaries ?? []) {
      assert(summary.entryIds.every(id => targetEntryIds.has(Number(id))),
        `任务分支摘要引用了不属于该分支的 entry：${JSON.stringify(summary)}`);
    }
    const targetEntries = (await withTimeout(target.conversation.entries({ order: "ascending" }, 500, undefined, ctx), "scan target entries")).items;
    console.log(`[branch-test] PASS independent task branch: anchor=${alphaUserId}, sourceEntries=${page.items.length}, seedEntries=${branchSeed.entries.length}, seedKinds=${JSON.stringify(branchSeed.entries.map(item => item.entry.kind))}, targetEntries=${targetEntries.length}, providerTokens=${targetRequest.tokens}, blocks=${targetStatus.blocks ?? 0}`);
    await withTimeout(target.close(), "close task-branch target");
  }
  // ── 6) Code Mode：工具面只暴露 codemode，但脚本内可调用 acp_* 工具 ──────────
  {
    const directory = join(root, "codemode-state");
    directories.push(directory);
    const fixture = createFixture();
    const runtime = await withTimeout(DurableBotRuntime.open(runtimeOptions({
      directory, workspace, fixture, seed: seedHistory(80_000), toolMode: "codemode",
    })), "open codemode runtime");
    runtimes.push(runtime);
    fixture.replyQueue.push({ kind: "tool", name: "codemode", arguments: {
      code: "const status = await tools.acp_status({}); text(typeof status === 'string' ? status : JSON.stringify(status));",
    } });
    fixture.replyQueue.push({ kind: "text", text: "status inspected" });
    await submitTurn(runtime, "Inspect the current context-management state from Code Mode.", "codemode-status");
    const firstRequest = fixture.requests.at(-2)!;
    const resultRequest = fixture.requests.at(-1)!;
    assert(SUMMARY_MARKER_PATTERN.test(requestText(firstRequest)), "Code Mode 首轮也必须使用 BC 摘要投影");
    const resultText = requestText(resultRequest);
    assert(resultText.includes("billion-context"), `Code Mode 脚本内调用 acp_status 没有返回引擎信息：${resultText.slice(-800)}`);
    assert(resultText.includes("triggerTokens"), `Code Mode 脚本内调用 acp_status 没有返回阈值：${resultText.slice(-800)}`);
    console.log("[branch-test] PASS Code Mode tool face: acp_status callable from codemode script");
    await withTimeout(runtime.close(), "close codemode runtime");
  }

  // ── 7) 运行中修改设置：无需重开会话，下一轮按新阈值整理 ──────────────────────
  {
    const directory = join(root, "hot-settings-state");
    directories.push(directory);
    const fixture = createFixture();
    const ratioRef = { value: 0.9 };
    const runtime = await withTimeout(DurableBotRuntime.open(runtimeOptions({
      directory, workspace, fixture, seed: seedHistory(40_000), ratioRef,
    })), "open hot-settings runtime");
    runtimes.push(runtime);
    fixture.replyQueue.push({ kind: "text", text: "warm answer" });
    await submitTurn(runtime, "warm up the session", "hot-settings-warm");
    const warmRequest = fixture.requests.at(-1)!;
    assert(!SUMMARY_MARKER_PATTERN.test(requestText(warmRequest)), "ratio=0.9 时 40K 历史不应自动整理");
    assert.equal(runtime.contextManagementStatus()?.triggerTokens, Math.floor(MODEL_CONTEXT_WINDOW * 0.9),
      "ratio=0.9 的触发线必须是 115200");

    ratioRef.value = 0.2;
    fixture.replyQueue.push({ kind: "text", text: "post-change answer" });
    await submitTurn(runtime, `after hot change: ${"large turn content ".repeat(5_000)}`, "hot-settings-change");
    const changedRequest = fixture.requests.at(-1)!;
    const statusAfterChange = runtime.contextManagementStatus()!;
    assert.equal(statusAfterChange.triggerTokens, Math.floor(MODEL_CONTEXT_WINDOW * 0.2),
      "运行中改成 ratio=0.2 后触发线必须变为 25600（无需重开会话）");
    assert(SUMMARY_MARKER_PATTERN.test(requestText(changedRequest)),
      "阈值调低后下一轮必须自动整理（设置 getter 必须每轮重新读取）");
    console.log(`[branch-test] PASS hot settings: trigger ${statusAfterChange.triggerTokens}, request tokens=${changedRequest.tokens}`);
    await withTimeout(runtime.close(), "close hot-settings runtime");
  }
  // ── 8) 多模型会诊：会诊 child 同样是独立 conversation，拥有自己的 BC 投影 ──────
  {
    const directory = join(root, "consult-state");
    directories.push(directory);
    const fixture = createFixture();
    const main = await withTimeout(DurableBotRuntime.open(runtimeOptions({ directory, workspace, fixture })), "open consult-main runtime");
    runtimes.push(main);
    const seed = seedHistory(80_000);
    const parentAgent = await withTimeout(main.conversation.agent(ctx), "read consult parent agent");
    const consult = await withTimeout(main.harness.createConversation({
      ownership: { kind: "ownerless" },
      init: async (tx, id) => {
        const identity = await tx.doc(DurableConsultIdentity, id);
        identity.key = "consult-test";
        identity.cwd = workspace;
        identity.deadline = Date.now() + 60_000;
        identity.maxToolCalls = 4;
        for (const message of seed) {
          await tx.appendEntry(id, { kind: message.role === "user" ? "pi.user" : "pi.assistant", model: [message] });
        }
      },
    }, ctx), "create consult conversation");
    await withTimeout(consult.configure({ model: { provider: "fixture", modelId: "fixture" }, tools: [...parentAgent.callable] }, ctx), "configure consult");
    fixture.replyQueue.push({ kind: "text", text: "consult answer" });
    const submission = await withTimeout(consult.submit({ type: "input", content: "consult task over the seed context" }, ctx), "submit consult input");
    assert.equal((await withTimeout(submission.wait(ctx), "wait consult")).status, "done", "会诊回合未完成");
    const request = fixture.requests.at(-1)!;
    assert(SUMMARY_MARKER_PATTERN.test(requestText(request)), "会诊 conversation 没有自己的 BC 摘要投影");
    assert(request.tokens < tokensOf(seed) * 0.5, `会诊投影必须显著变小：seed≈${tokensOf(seed)}，实际=${request.tokens}`);
    console.log(`[branch-test] PASS consult conversation: tokens ${tokensOf(seed)} -> ${request.tokens}, own summaries applied`);
    await withTimeout(main.close(), "close consult-main runtime");
  }
  // ── 9) 设置切换引擎：billion-context ↔ 按比例压缩（Pi 原生），无需重开会话 ──────
  {
    const directory = join(root, "engine-toggle-state");
    directories.push(directory);
    const fixture = createFixture();
    const engineRef: { value: "billion-context" | "native" } = { value: "billion-context" };
    const runtime = await withTimeout(DurableBotRuntime.open(runtimeOptions({
      directory, workspace, fixture, seed: seedHistory(80_000), engineRef,
    })), "open engine-toggle runtime");
    runtimes.push(runtime);

    fixture.replyQueue.push({ kind: "text", text: "bc answer" });
    await submitTurn(runtime, "first turn under billion-context", "engine-toggle-bc");
    const bcRequest = fixture.requests.at(-1)!;
    assert(SUMMARY_MARKER_PATTERN.test(requestText(bcRequest)), "billion-context 引擎首轮必须出现 BC 摘要投影");

    engineRef.value = "native";
    fixture.replyQueue.push({ kind: "text", text: "native answer" });
    await submitTurn(runtime, "second turn must use Pi native proportional compression", "engine-toggle-native");
    const nativeRequest = fixture.requests.at(-1)!;
    assert(!SUMMARY_MARKER_PATTERN.test(requestText(nativeRequest)),
      "切到按比例压缩后不得再出现 billion-context 摘要投影");
    assert(nativeRequest.tokens > 60_000, `按比例压缩轮应看到完整历史（实测 ${nativeRequest.tokens} tokens）`);
    const nativeStatus = runtime.contextManagementStatus()!;
    assert.equal(nativeStatus.engine, "native", "状态投影必须显示当前引擎为 native");
    assert.equal(nativeStatus.enabled, false, "native 引擎时 billion-context 必须为 disabled");

    engineRef.value = "billion-context";
    fixture.replyQueue.push({ kind: "text", text: "bc resumed answer" });
    await submitTurn(runtime, "third turn returns to billion-context", "engine-toggle-back");
    const resumedRequest = fixture.requests.at(-1)!;
    assert(SUMMARY_MARKER_PATTERN.test(requestText(resumedRequest)), "切回 billion-context 后必须恢复摘要投影（state 不丢失）");
    assert.equal(runtime.contextManagementStatus()?.engine, "billion-context", "切回后状态引擎必须恢复");
    console.log(`[branch-test] PASS engine toggle: bc=${bcRequest.tokens} native=${nativeRequest.tokens} bcResumed=${resumedRequest.tokens}`);
    await withTimeout(runtime.close(), "close engine-toggle runtime");
  }

  // ── 10) native 引擎下手动整理走 Pi 原生路径，不伪报为 billion-context ──────────
  {
    const directory = join(root, "native-manual-state");
    directories.push(directory);
    const fixture = createFixture();
    const engineRef: { value: "billion-context" | "native" } = { value: "native" };
    const runtime = await withTimeout(DurableBotRuntime.open(runtimeOptions({
      directory, workspace, fixture, seed: seedHistory(80_000), engineRef,
    })), "open native-manual runtime");
    runtimes.push(runtime);
    const outcome = await withTimeout(runtime.compact(), "native manual compact");
    assert.equal(outcome.engine, "native", `按比例压缩模式下手动整理必须报告 native 引擎：${JSON.stringify(outcome)}`);
    assert.equal(outcome.applied, true, `真实历史应能被 Pi 原生压缩：${JSON.stringify(outcome)}`);
    const status = runtime.contextManagementStatus()!;
    assert.equal(status.engine, "native", "手动整理后状态引擎必须是 native");
    console.log(`[branch-test] PASS native manual compact: applied=${outcome.applied} engine=${outcome.engine}`);
    await withTimeout(runtime.close(), "close native-manual runtime");
  }
  // ── 11) native 引擎确实按产品阈值压缩；随后切回 BC 能按新边界重建 ───────────
  {
    const directory = join(root, "engine-native-threshold-state");
    directories.push(directory);
    const fixture = createFixture();
    const engineRef: { value: "billion-context" | "native" } = { value: "billion-context" };
    const ratioRef = { value: 0.8 };
    const runtime = await withTimeout(DurableBotRuntime.open(runtimeOptions({
      directory, workspace, fixture, seed: seedHistory(80_000), engineRef, ratioRef,
    })), "open native-threshold runtime");
    runtimes.push(runtime);

    fixture.replyQueue.push({ kind: "text", text: "bc warm answer" });
    await submitTurn(runtime, "warm under billion-context", "native-threshold-bc");
    assert(SUMMARY_MARKER_PATTERN.test(requestText(fixture.requests.at(-1)!)), "billion-context 首轮应有 BC 摘要");

    engineRef.value = "native";
    ratioRef.value = 0.3;
    // 第一次 native 请求可能会沿用上一条 assistant 的旧 usage（来自 BC 投影后的较小请求），
    // Pi 的原生阈值估计因此偏小；该请求仍能安全发送，下一次请求会以真实 usage 重新判断。
    fixture.replyQueue.push({ kind: "text", text: "native first answer" });
    await submitTurn(runtime, "native first turn after switching engine", "native-threshold-native-1");
    const firstNative = fixture.requests.at(-1)!;
    assert(!SUMMARY_MARKER_PATTERN.test(requestText(firstNative)), "native 模式不得出现 billion-context 摘要标记");
    fixture.replyQueue.push({ kind: "text", text: "native proportional answer" });
    await submitTurn(runtime, "native second turn must respect the proportional threshold", "native-threshold-native-2");
    const nativeRequest = fixture.requests.at(-1)!;
    assert(!SUMMARY_MARKER_PATTERN.test(requestText(nativeRequest)), "native 模式不得出现 billion-context 摘要标记");
    assert(nativeRequest.tokens < 60_000, `native 引擎必须按产品阈值压缩（80K 历史，ratio=0.3/trigger=38400），实际 ${nativeRequest.tokens} tokens`);
    assert.equal(runtime.contextManagementStatus()?.engine, "native", "native 引擎状态必须为 native");

    engineRef.value = "billion-context";
    ratioRef.value = 0.8;
    fixture.replyQueue.push({ kind: "text", text: "bc after native answer" });
    await submitTurn(runtime, "back to billion-context after native compaction", "native-threshold-back");
    const resumedRequest = fixture.requests.at(-1)!;
    assert(resumedRequest.tokens < 60_000, `切回 BC 后应沿用原生压缩后的新边界，实际 ${resumedRequest.tokens} tokens`);
    assert.equal(runtime.contextManagementStatus()?.engine, "billion-context", "切回后引擎状态必须是 billion-context");
    console.log(`[branch-test] PASS native threshold + BC rebase: bc=${nativeRequest.tokens} resumed=${resumedRequest.tokens}`);
    await withTimeout(runtime.close(), "close native-threshold runtime");
  }
  console.log("durable context branch/cancel tests passed");
} finally {
  for (const runtime of runtimes) { try { await runtime.close(); } catch { /* already closed */ } }
  for (const directory of directories) { try { await rm(directory, { recursive: true, force: true }); } catch { /* windows lock */ } }
  try { await rm(root, { recursive: true, force: true }); } catch { /* windows lock */ }
}