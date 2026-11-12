/**
 * Issue #26 验收：Durable 会话的「billion-context」自动上下文管理。
 *
 * 这个测试**真实运行** DurableBotRuntime：临时 HOME、真实 SQLite Durable 存储、真实工具执行，
 * 只有模型 provider 是本地 fixture（不上网）。因此断言的是 provider 实际收到的 `context.messages`，
 * 不是内部投影函数自报的数字。
 *
 * 覆盖：
 *  1. 产品阈值生效：128000 窗口 × ratio → triggerTokens 严格等于产品口径（main 场景 ratio 0.8 = 102400）；
 *     另用两个 fresh runtime（ratio 0.9 / 0.2）证明“设置确实改变了自动整理是否发生”。
 *  2. 自动整理：连续提交大轮次，某一轮之后 provider 请求出现摘要标记、已折叠旧 marker/原句消失、
 *     token 明显小于 fixture 自己的未压缩 payloadTokens 基线；之后每轮请求持续保持压缩投影。
 *  3. 原文回查：模型真实调用 `acp_retrieve({ref})`，Durable 里出现真实 `pi.tool-result` entry，
 *     下一次 provider 请求里的 toolResult 逐字包含种子历史中的唯一句子与句子后的细节（摘要 topic 只有
 *     120 字符，不可能包含细节，因此能证明文本来自原文 entry 而非摘要）。
 *  4. 重启恢复：close 后用同一 options 重新 open，下一次 provider 请求仍不含旧 marker、
 *     `contextManagementStatus()` 报告 engine=billion-context / blocks>0，且摘要模型调用次数不因重启增长。
 *  5. 无可整理内容：干净会话 `compact()` 返回 `{ applied:false, skippedReason 非空 }`，且不调用摘要模型。
 *
 * 所有等待都有 20s deadline；finally 关闭 runtime、删除临时目录、恢复 HOME/USERPROFILE。
 */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getCurrentTools, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import { estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";
import { openDurablePassiveStorage } from "../src/main/agent/durable/DurableStorage";
import { selectedDurableSqlite } from "../src/main/agent/durable/DurableStorageMigration";
import { DurableContextStateDoc } from "../src/main/agent/durable/context/DurableContextState";
import type { ContextManagementStatusDto } from "../src/shared/context-management";

const DEADLINE_MS = 20_000;
const MODEL_CONTEXT_WINDOW = 128_000;
/** 产品策略 ratio=0.8 → 触发线 102400（native 若用 reserveTokens 会算成 111616，正是 Issue #26 要修的偏差）。 */
const EXPECTED_TRIGGER_TOKENS = 102_400;
/** acp-kernel 的“首见质量旁路”压力带：usage ≥ 45% 窗口时可能提前 fold（上游设计，不由产品阈值决定）。 */
const KERNEL_PRESSURE_BAND = Math.floor(MODEL_CONTEXT_WINDOW * 0.45);
const CHARS_PER_TOKEN = 3.5;
/** 设置生效对照场景的种子：≈40K token = 31% 窗口（<45%，不触发内核旁路）。 */
const RATIO_SEED_TOKENS = 40_000;

/** 种子历史里的唯一原句：只存在于第 1 条原始 entry，任何时候都不允许被摘要伪造。 */
const SEED_RETRIEVE_SENTENCE = "Exact original fact for ref m00001: the north wind carried the brass key past the observatory at 03:17 UTC.";
/** 原句之后的原文细节：摘要 topic 最多 120 字符，绝不可能包含它，用来证明回查文本来自原文 entry。 */
const SEED_RETRIEVE_TAIL = "Verbatim tail detail: the brass key was stamped with the serial NB-7/4412 before the storm.";
/** 一个永远不该被回查的旧 marker：压缩后必须从 provider 请求里消失。 */
const SEED_OLD_MARKER = "Superseded seed fact: the archive vault was sealed with the emerald stamp on 1998-04-12.";
/** 自动整理后插入的摘要标记（DurableContextManager.SUMMARY_MARKER 的宽松匹配，避免把措辞写死）。 */
const SUMMARY_MARKER_PATTERN = /\[Compressed[^\]]*\]/;
/** 主场景的种子历史规模（token 估算，char/3.5 口径）。 */
const SEED_TOTAL_TOKENS = 80_000;
const SEED_MESSAGE_COUNT = 8;
const SUMMARY_TEXT = "Earlier seed history was folded: eight long blocks described wind observations, archive references and retrieval details.";

type FixtureReply = { kind: "text"; text: string } | { kind: "tool"; name: string; arguments: Record<string, string> };
interface RecordedGeneration {
  index: number;
  at: number;
  tokens: number;
  messages: readonly Message[];
  toolNames: string[];
}
interface RecordedSummaryCall {
  family: "billion-context" | "native";
  at: number;
  promptChars: number;
}
type FixtureModels = ReturnType<typeof createFixtureModels>;

function withTimeout<T>(promise: Promise<T>, label: string, ms = DEADLINE_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`[deadline] ${label} 在 ${ms}ms 内没有结束（可能是 Durable 任务挂起）`)), ms);
  });
  return Promise.race([promise, deadline]).finally(() => { if (timer) clearTimeout(timer); }) as Promise<T>;
}

/** 一条消息的纯文本；provider 收到的是 pi Message，content 可能是字符串或 part 数组。 */
function messageText(message: Message | { role: string; content?: unknown }): string {
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    const typed = part as { type?: unknown; text?: unknown; thinking?: unknown; name?: unknown; arguments?: unknown };
    if (typed.type === "text" && typeof typed.text === "string") parts.push(typed.text);
    else if (typed.type === "thinking" && typeof typed.thinking === "string") parts.push(typed.thinking);
    else if (typed.type === "toolCall") parts.push(`[tool ${String(typed.name)} ${JSON.stringify(typed.arguments ?? {})}]`);
    else if (typed.type === "image") parts.push("[image]");
  }
  return parts.join("\n");
}

/** provider 请求的“出站体积”口径：逐消息估算（含 system+工具 schema），与 manager 的本地估算一致。 */
function payloadTokens(messages: readonly Message[]): number {
  let total = 0;
  for (const message of messages) total += estimateMessageTokens(message);
  return total;
}

function requestText(record: RecordedGeneration): string {
  return record.messages.map(message => messageText(message)).join("\n");
}

function summaryMessages(record: RecordedGeneration): Message[] {
  return record.messages.filter(message =>
    (message.role === "user" || message.role === "system") && SUMMARY_MARKER_PATTERN.test(messageText(message)));
}

function assistantMessage(content: AssistantMessage["content"], stopReason: "stop" | "toolUse", inputTokens: number, outputTokens: number, timestamp = Date.now()): AssistantMessage {
  return {
    role: "assistant", content, stopReason, api: "openai-completions", provider: "fixture", model: "fixture", timestamp,
    usage: { input: inputTokens, output: outputTokens, cacheRead: 0, cacheWrite: 0, totalTokens: inputTokens + outputTokens,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
}

/**
 * 本地 provider fixture：记录每次生成请求真实收到的 messages；摘要调用（models.completeSimple）
 * 单独计数并区分 billion-context / native 两个来源。串行调度因此没有并发竞争。
 */
function createFixtureModels() {
  const model = {
    id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false,
    input: ["text"], contextWindow: MODEL_CONTEXT_WINDOW, maxTokens: 4_096,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
  const requests: RecordedGeneration[] = [];
  const summaryCalls: RecordedSummaryCall[] = [];
  const replyQueue: FixtureReply[] = [];

  const streamSimple = (_model: unknown, context: { messages?: readonly Message[] }): unknown => {
    const messages = context.messages ?? [];
    const record: RecordedGeneration = {
      index: requests.length, at: Date.now(), tokens: payloadTokens(messages), messages,
      toolNames: getCurrentTools(messages).map(tool => tool.name),
    };
    requests.push(record);
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(() => {
      const reply = replyQueue.shift();
      if (!reply) throw new Error(`fixture 没有为第 ${record.index + 1} 次生成请求调度回复（真实实现多发了请求时不会伪造通过）`);
      const content: AssistantMessage["content"] = [];
      if (reply.kind === "text") content.push({ type: "text", text: reply.text });
      else content.push({ type: "toolCall", id: `fixture-call-${record.index + 1}`, name: reply.name, arguments: reply.arguments });
      const stopReason = reply.kind === "tool" ? "toolUse" : "stop";
      const outputTokens = reply.kind === "text" ? Math.max(1, Math.ceil(reply.text.length / CHARS_PER_TOKEN)) : 32;
      const message = assistantMessage(content, stopReason, record.tokens, outputTokens);
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

  const completeSimple = async (_model: unknown, context: { messages?: readonly Message[] }): Promise<AssistantMessage> => {
    const messages = context.messages ?? [];
    const systemText = messages.filter(item => item.role === "system").map(item => messageText(item)).join("\n");
    summaryCalls.push({
      family: systemText.includes("compress conversation history") ? "billion-context" : "native",
      at: Date.now(),
      promptChars: messages.reduce((total, item) => total + messageText(item).length, 0),
    });
    return assistantMessage([{ type: "text", text: SUMMARY_TEXT }], "stop", 128, 32);
  };

  const api: Record<string, unknown> = { getAuth: async () => undefined, getModel: () => model, streamSimple, completeSimple };
  return { api: api as unknown as DurableBotOptions["models"], model, requests, summaryCalls, replyQueue };
}

function seedFiller(targetChars: number): string {
  const unit = "seed context sentence about wind observations and archive references. ";
  return unit.repeat(Math.max(1, Math.ceil(targetChars / unit.length)));
}

/**
 * 种子历史（默认 ≈80K tokens）：第 1 条 user 含唯一原句与句子后的细节，第 2 条 assistant 含旧 marker。
 * 每条首行都是与 marker 无关的普通文本，避免摘要 topic（首行 120 字符）意外带上 marker。
 */
function seedHistory(totalTokens = SEED_TOTAL_TOKENS): Message[] {
  const perMessageChars = Math.floor(totalTokens * CHARS_PER_TOKEN / SEED_MESSAGE_COUNT);
  const messages: Message[] = [];
  let cumulativeTokens = 0;
  for (let index = 0; index < SEED_MESSAGE_COUNT; index++) {
    const lines = [`Seed block ${index + 1}.`];
    if (index === 0) lines.push(SEED_RETRIEVE_SENTENCE, SEED_RETRIEVE_TAIL);
    if (index === 1) lines.push(SEED_OLD_MARKER);
    const text = `${lines.join("\n")}\n${seedFiller(perMessageChars)}`.slice(0, perMessageChars);
    cumulativeTokens += Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
    const timestamp = index + 1;
    if (index % 2 === 0) messages.push({ role: "user", content: text, timestamp });
    else messages.push(assistantMessage([{ type: "text", text }], "stop", cumulativeTokens, 20, timestamp));
  }
  return messages;
}

function turnText(label: string, tokens: number): string {
  const head = `Turn ${label}: please review the seed observations and archive references. `;
  const chars = Math.max(head.length, Math.floor(tokens * CHARS_PER_TOKEN));
  return `${head}${seedFiller(chars)}`.slice(0, chars);
}

function botOptions(input: { directory: string; withSeed: boolean; seed: readonly Message[]; workspace: string;
  fixture: FixtureModels; statusHistory: ContextManagementStatusDto[]; ratio?: number }): DurableBotOptions {
  const ratio = input.ratio ?? 0.8;
  return {
    directory: input.directory,
    cwd: input.workspace,
    models: input.fixture.api,
    model: { provider: "fixture", modelId: "fixture" },
    toolMode: "native",
    instructions: () => "Context-management fixture. Answer only as the fixture user asks.",
    onSnapshot: () => {},
    ...(input.withSeed ? { initialHistory: { messages: input.seed, context: [] } } : {}),
    contextManagement: {
      policy: () => ({ ratio, absoluteTokens: null }),
      toolEstimateTokens: () => 0,
      onStatus: status => input.statusHistory.push(status),
    },
  };
}

async function openRuntime(options: DurableBotOptions, label: string): Promise<DurableBotRuntime> {
  return await withTimeout(DurableBotRuntime.open(options), `open ${label}`);
}

async function submitTurn(runtime: DurableBotRuntime, text: string, requestId: string): Promise<void> {
  const submission = await withTimeout(runtime.submit(text, requestId), `submit ${requestId}`);
  const settled = await withTimeout(submission.wait(ctx), `wait ${requestId}`);
  assert.equal(settled.status, "done", `回合 ${requestId} 未完成：${JSON.stringify(settled)}`);
}

async function statusOf(runtime: DurableBotRuntime): Promise<ContextManagementStatusDto> {
  assert.equal(typeof runtime.contextManagementStatus, "function",
    "DurableBotRuntime.contextManagementStatus() 不存在：Issue #26 的 runtime 接线尚未落地");
  const status = await withTimeout(Promise.resolve(runtime.contextManagementStatus()), "contextManagementStatus");
  assert(status, "contextManagementStatus() 在启用 contextManagement 后必须返回状态，不得返回 undefined");
  return status;
}

async function findSeedEntryId(runtime: DurableBotRuntime): Promise<number> {
  const page = await withTimeout(runtime.conversation.entries({ order: "ascending" }, 500, undefined, ctx), "scan seed entries");
  const entry = page.items.find(item => (item.model ?? []).some(message => messageText(message).includes(SEED_RETRIEVE_SENTENCE)));
  assert(entry, "种子历史没有落成可回查的 Durable entry");
  return entry.id;
}

async function readPersistedContextState(runtime: DurableBotRuntime) {
  return await withTimeout(runtime.harness.snapshot(DurableContextStateDoc, runtime.conversation.id, ctx), "read context-management doc");
}

/** 压缩后的请求：必须有摘要标记，且被折叠的旧原文/细节不再出现。 */
function assertCompacted(record: RecordedGeneration, label: string, options: { retrievedOriginal?: boolean } = {}): void {
  const text = requestText(record);
  assert(SUMMARY_MARKER_PATTERN.test(text),
    `${label}：provider 请求里没有摘要标记（期望形如 [Compressed conversation section]），自动整理没有投影到出站请求`);
  assert(!text.includes(SEED_OLD_MARKER), `${label}：provider 请求仍包含已被折叠的旧 marker，已提交摘要没有在后续请求重放`);
  if (options.retrievedOriginal) {
    // 原文回查之后，最近的 toolResult 会合法地带着原句与细节；它们只能出现在 toolResult 里，
    // 摘要消息与其他历史消息都不得出现（否则就是摘要冒充原文）。
    const summaryText = summaryMessages(record).map(message => messageText(message)).join("\n");
    assert(!summaryText.includes(SEED_RETRIEVE_TAIL), `${label}：摘要消息里出现原文细节，摘要不得冒充原文`);
    const nonToolResultText = record.messages.filter(message => message.role !== "toolResult").map(message => messageText(message)).join("\n");
    assert(!nonToolResultText.includes(SEED_RETRIEVE_TAIL), `${label}：非 toolResult 消息里出现原文细节，旧原文没有被折叠`);
    assert(!nonToolResultText.includes(SEED_RETRIEVE_SENTENCE), `${label}：非 toolResult 消息里出现种子原句，旧原文没有被折叠`);
    assert(record.messages.some(message => message.role === "toolResult" && messageText(message).includes(SEED_RETRIEVE_TAIL)),
      `${label}：回查后的原文细节必须只来自 toolResult`);
  } else {
    assert(!text.includes(SEED_RETRIEVE_TAIL), `${label}：provider 请求仍包含已被折叠的原文细节`);
    assert(!text.includes(SEED_RETRIEVE_SENTENCE), `${label}：provider 请求仍包含已被折叠的原句`);
  }
}

const root = await mkdtemp(join(tmpdir(), "mybuddy-durable-context-management-"));
const home = join(root, "home");
const workspace = join(root, "workspace");
const mainDirectory = join(root, "state-main");
const emptyDirectory = join(root, "state-empty");
const envKeys = ["HOME", "USERPROFILE", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "PI_CODING_AGENT_DIR"];
const savedEnv = new Map<string, string | undefined>(envKeys.map(key => [key, process.env[key]]));
const seeded = seedHistory();
const fixture = createFixtureModels();
const statusHistory: ContextManagementStatusDto[] = [];
const runtimes: DurableBotRuntime[] = [];
let main: DurableBotRuntime | undefined;
let empty: DurableBotRuntime | undefined;

try {
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.PI_CODING_AGENT_DIR = join(home, ".pi-agent");
  console.log("[context-test] isolated root:", root);

  /** 一个 fresh runtime + 一次小回合，用来验证 policy 是否真的改变了自动整理行为。 */
  const ratioScenario = async (label: string, ratio: number) => {
    const scenarioFixture = createFixtureModels();
    const scenarioStatus: ContextManagementStatusDto[] = [];
    const seed = seedHistory(RATIO_SEED_TOKENS);
    const runtime = await openRuntime(botOptions({ directory: join(root, `state-${label}`), withSeed: true, seed,
      workspace, fixture: scenarioFixture, statusHistory: scenarioStatus, ratio }), label);
    runtimes.push(runtime);
    try {
      const status = await statusOf(runtime);
      scenarioFixture.replyQueue.push({ kind: "text", text: `${label} answer` });
      await submitTurn(runtime, turnText(label, 2_000), `ratio-${label}`);
      assert.equal(scenarioFixture.requests.length, 1, `${label}：单回合必须只有 1 次生成请求`);
      return { request: scenarioFixture.requests[0]!, status };
    } finally {
      await withTimeout(runtime.close(), `close ${label}`);
    }
  };

  // ── 1) 真 SQLite 存储 + 独立 HOME 上打开 runtime ─────────────────────────────
  main = await openRuntime(botOptions({ directory: mainDirectory, withSeed: true, seed: seeded, workspace, fixture, statusHistory }), "main runtime");
  runtimes.push(main);
  assert.equal(typeof main.compact, "function", "DurableBotRuntime.compact() 不存在：Issue #26 的 runtime 接线尚未落地");
  const seedEntryId = await findSeedEntryId(main);

  // ── 2) 连续大轮次直到自动整理发生（不点任何按钮）────────────────────────────
  const bigTurns = [
    { id: "context-turn-1", tokens: 8_000 },
    { id: "context-turn-2", tokens: 30_000 },
    { id: "context-turn-3", tokens: 30_000 },
    { id: "context-turn-4", tokens: 30_000 },
  ];
  const submittedTurnTexts: string[] = [];
  let compressedAt = -1;
  for (const turn of bigTurns) {
    const text = turnText(turn.id, turn.tokens);
    submittedTurnTexts.push(text);
    fixture.replyQueue.push({ kind: "text", text: `answer for ${turn.id}` });
    await submitTurn(main, text, turn.id);
    const latest = fixture.requests.at(-1)!;
    console.log(`[context-test] ${turn.id}: request #${latest.index + 1} tokens=${latest.tokens} messages=${latest.messages.length} summary=${summaryMessages(latest).length > 0}`);
    compressedAt = fixture.requests.findIndex(record => summaryMessages(record).length > 0);
    if (compressedAt >= 0) break;
  }
  assert(compressedAt >= 0, `连续 ${bigTurns.length} 轮后自动整理仍未生效（每次请求 token=${fixture.requests.map(r => r.tokens).join(",")}；` +
    `摘要模型调用=${JSON.stringify(fixture.summaryCalls.map(call => call.family))}；期望 provider 请求里出现 [Compressed …] 摘要标记）`);
  if (compressedAt >= 1) {
    assert(requestText(fixture.requests[compressedAt - 1]!).includes(SEED_OLD_MARKER),
      "压缩发生前的 provider 请求必须包含完整种子历史（否则本测试没有压缩前基线）");
  } else {
    console.log("[context-test] 内核首见质量旁路在第 1 次请求即完成整理：用 fixture 自身 payloadTokens 重建未压缩基线");
  }

  // 压缩之后继续提交若干轮：这些请求必须持续复用已提交摘要（自动整理不是一次性效果）。
  for (const turn of [{ id: "context-persist-1", tokens: 4_000 }, { id: "context-persist-2", tokens: 4_000 }]) {
    fixture.replyQueue.push({ kind: "text", text: `answer for ${turn.id}` });
    await submitTurn(main, turnText(turn.id, turn.tokens), turn.id);
    console.log(`[context-test] ${turn.id}: request #${fixture.requests.at(-1)!.index + 1} tokens=${fixture.requests.at(-1)!.tokens}`);
  }

  // 未压缩基线：压缩发生在前几轮时取那一轮的 provider 实测；第 1 轮就压缩时用 fixture 自己的 payloadTokens 重建。
  const compressed = fixture.requests[compressedAt]!;
  const systemTokens = payloadTokens(compressed.messages.filter(message => message.role === "system"));
  const firstTurnMessage = { role: "user" as const, content: submittedTurnTexts[0]!, timestamp: 0 } as Message;
  const expectedRawTokens = compressedAt >= 1
    ? fixture.requests[compressedAt - 1]!.tokens
    : systemTokens + payloadTokens(seeded) + payloadTokens([firstTurnMessage]);
  assert(compressed.tokens < expectedRawTokens * 0.75,
    `自动整理后 provider 请求必须显著变小：uncompressed≈${expectedRawTokens} after=${compressed.tokens}`);
  assertCompacted(compressed, "自动整理轮");
  console.log(`[context-test] automatic compaction at request #${compressedAt + 1}: uncompressed≈${expectedRawTokens} -> ${compressed.tokens} tokens`);

  // 自动整理状态由真实 manager 发布：必须说明 before/after 下降且发生在内核压力带（≥45% 窗口）。
  const automaticStatus = statusHistory.find(status => status.phase === "completed" && (status.blocks ?? 0) > 0
    && status.beforeTokens !== undefined && status.afterTokens !== undefined && status.afterTokens < status.beforeTokens);
  assert(automaticStatus, `自动整理没有发布 completed 状态：${JSON.stringify(statusHistory.map(status => ({ phase: status.phase, reason: status.reason, blocks: status.blocks, before: status.beforeTokens, after: status.afterTokens })))}`);
  assert(automaticStatus.reason === "threshold" || automaticStatus.reason === "growth",
    `自动整理的 reason 必须是 threshold 或 growth，实际 ${automaticStatus.reason}`);
  assert.equal(automaticStatus.automatic, true, "这次整理必须是自动触发（测试没有调用 compact 手动整理）");
  assert((automaticStatus.beforeTokens ?? 0) >= KERNEL_PRESSURE_BAND,
    `自动整理必须发生在内核压力带（≥${KERNEL_PRESSURE_BAND} tokens），实际 beforeTokens=${automaticStatus.beforeTokens}`);
  console.log(`[context-test] automatic operation status: reason=${automaticStatus.reason} ${automaticStatus.beforeTokens} -> ${automaticStatus.afterTokens} tokens, blocks=${automaticStatus.blocks}`);

  const statusAfterCompaction = await statusOf(main);
  assert.equal(statusAfterCompaction.engine, "billion-context", "启用了 contextManagement 的会话状态引擎必须是 billion-context");
  assert.equal(statusAfterCompaction.enabled, true, "自动上下文管理必须处于 enabled 状态");
  assert.equal(statusAfterCompaction.contextWindow, MODEL_CONTEXT_WINDOW, `contextWindow 必须来自 fixture 模型（${MODEL_CONTEXT_WINDOW}）`);
  assert.equal(statusAfterCompaction.triggerTokens, EXPECTED_TRIGGER_TOKENS,
    `产品策略 ratio=0.8 × ${MODEL_CONTEXT_WINDOW} 必须给出 ${EXPECTED_TRIGGER_TOKENS} 触发线（native reserveTokens 口径是 111616）`);
  assert((statusAfterCompaction.blocks ?? 0) > 0, `自动整理后必须报告摘要块，实际 blocks=${statusAfterCompaction.blocks}`);
  assert((statusAfterCompaction.summaries?.length ?? 0) > 0, "状态里必须有已提交摘要块");
  assert(statusAfterCompaction.summaries!.every(summary => summary.entryIds.length > 0), "每个摘要块必须映射到原始 entryIds");
  assert.equal(fixture.summaryCalls.filter(call => call.family === "native").length, 0,
    "BC 健康时不得触发 native 摘要：beforeCompact 必须在 reason=threshold 时 decline");
  assert.equal(fixture.requests[0]!.toolNames.includes("acp_retrieve"), true,
    "启用 contextManagement 后 acp_retrieve 必须进入 native 工具集（模型才能主动回查原文）");

  // ── 3) 原文回查：模型真实调用 acp_retrieve(ref)，下一次请求逐字收到原文 ────────
  const persisted = await readPersistedContextState(main);
  const refs = persisted?.refs ?? {};
  const refEntry = Object.entries(refs).find(([, locator]) => locator.entryId === seedEntryId);
  assert(refEntry, `持久化 refs 必须包含种子 entry ${seedEntryId}：${JSON.stringify(refs)}`);
  const [seedRef] = refEntry;
  assert(/^m\d{5}$/.test(seedRef), `ref 必须是 mNNNNN 形式，实际 ${seedRef}`);

  fixture.replyQueue.push({ kind: "tool", name: "acp_retrieve", arguments: { ref: seedRef } });
  fixture.replyQueue.push({ kind: "text", text: "retrieved the original seed entry" });
  const retrieveStart = fixture.requests.length;
  await submitTurn(main, `Retrieve ${seedRef} from the original transcript and quote it exactly.`, "context-retrieve");
  assert.equal(fixture.requests.length, retrieveStart + 2,
    `原文回查回合必须有两次生成请求（toolCall + toolResult），实际新增 ${fixture.requests.length - retrieveStart} 次`);

  const callRequest = fixture.requests[retrieveStart]!;
  const resultRequest = fixture.requests[retrieveStart + 1]!;
  assertCompacted(callRequest, "原文回查首轮");
  const toolResult = resultRequest.messages.find(message =>
    message.role === "toolResult" && messageText(message).includes(SEED_RETRIEVE_SENTENCE));
  assert(toolResult, `回查后的 provider 请求里没有逐字包含原句的 toolResult：${requestText(resultRequest).slice(0, 800)}`);
  const toolResultText = messageText(toolResult);
  assert.equal((toolResult as { isError?: boolean }).isError, false, "原文回查工具结果不得是错误");
  assert(toolResultText.includes(SEED_RETRIEVE_TAIL), "toolResult 必须包含原句之后的原文细节（摘要 topic 只有 120 字符，不可能伪造）");
  assert(toolResultText.includes(`[entry ${seedEntryId} ·`), `toolResult 必须标注来源 entry ${seedEntryId}：${toolResultText.slice(0, 300)}`);
  assert(toolResultText.includes("[source: original Durable entries"), "toolResult 必须明确标注为原始 Durable entry 文本");
  assert(!summaryMessages(resultRequest).some(message => messageText(message).includes(SEED_RETRIEVE_TAIL)),
    "摘要消息不得包含原句之后的细节：回查文本只能来自原文 entry");

  // Durable 自己的 entry 事实源里必须有真实执行的 tool-result（不是模型伪造）。
  const entryPage = await withTimeout(main.conversation.entries({ order: "ascending" }, 500, undefined, ctx), "scan tool-result entries");
  const durableToolResults = entryPage.items.filter(entry => entry.kind === "pi.tool-result")
    .flatMap(entry => (entry.model ?? []).filter(message => message.role === "toolResult"));
  const retrievedEntry = durableToolResults.find(message => (message as { toolName?: string }).toolName === "acp_retrieve");
  assert(retrievedEntry, `Durable 存储里必须有真实执行的 acp_retrieve tool-result entry，实际 ${durableToolResults.map(item => (item as { toolName?: string }).toolName).join(",")}`);
  assert.equal((retrievedEntry as { isError?: boolean }).isError, false);
  assert(messageText(retrievedEntry).includes(SEED_RETRIEVE_SENTENCE), "Durable 存储里的工具结果必须逐字包含原句");
  assert(messageText(retrievedEntry).includes(SEED_RETRIEVE_TAIL), "Durable 存储里的工具结果必须包含原句之后的原文细节");

  // Authoritative SQLite artifact plus an independent physical reader, not an in-memory marker.
  const sqlitePath = selectedDurableSqlite(mainDirectory);
  assert(sqlitePath, "Durable must select the official SQLite artifact");
  assert.equal((await readFile(sqlitePath)).subarray(0, 16).toString("binary"), "SQLite format 3\0");
  const passiveStore = await openDurablePassiveStorage(mainDirectory, ctx);
  assert(passiveStore);
  try {
    const persisted = await passiveStore.scanEntries({ conversationId: main.conversation.id, order: "ascending" }, 500, undefined, ctx);
    assert(persisted.items.some(entry => entry.id === seedEntryId && JSON.stringify(entry).includes(SEED_RETRIEVE_SENTENCE)), "independent SQLite reader must return exact original");
  } finally { await passiveStore.close(ctx); }

  // ── 4) 重启恢复：同一 options 重新 open，摘要继续生效且不重复生成 ─────────────
  const summaryCallsBeforeRestart = fixture.summaryCalls.length;
  const blocksBeforeRestart = (await statusOf(main)).blocks ?? 0;
  await withTimeout(main.close(), "close main runtime");
  main = await openRuntime(botOptions({ directory: mainDirectory, withSeed: true, seed: seeded, workspace, fixture, statusHistory }), "reopen main runtime");
  runtimes.push(main);

  const importedEntries = (await withTimeout(main.conversation.entries({ order: "ascending" }, 500, undefined, ctx), "scan imported entries"))
    .items.filter(entry => {
      const data = entry.data as { mybuddyImported?: unknown } | undefined;
      return Boolean(data) && data!.mybuddyImported === true;
    });
  assert.equal(importedEntries.length, SEED_MESSAGE_COUNT, "重启不得重复导入种子历史");

  const statusAfterReopen = await statusOf(main);
  assert.equal(statusAfterReopen.engine, "billion-context", "重启后状态引擎仍必须是 billion-context");

  const restartStart = fixture.requests.length;
  fixture.replyQueue.push({ kind: "text", text: "post restart answer" });
  await submitTurn(main, "After restart: answer without re-reading the old seed blocks.", "context-restart");
  assert.equal(fixture.requests.length, restartStart + 1, "重启后回合只应有 1 次生成请求");
  const restartRequest = fixture.requests[restartStart]!;
  assertCompacted(restartRequest, "重启后轮", { retrievedOriginal: true });
  assert(restartRequest.tokens < expectedRawTokens,
    `重启后 provider 请求必须仍小于未压缩基线：uncompressed≈${expectedRawTokens} after=${restartRequest.tokens}`);
  assert.equal(fixture.summaryCalls.length, summaryCallsBeforeRestart,
    `重启后不得重新生成同一摘要：摘要调用次数 ${summaryCallsBeforeRestart} -> ${fixture.summaryCalls.length}`);

  const statusAfterRestart = await statusOf(main);
  assert((statusAfterRestart.blocks ?? 0) > 0, `重启后 blocks 必须 > 0（实际 ${statusAfterRestart.blocks}，重启前 ${blocksBeforeRestart}）`);
  assert((statusAfterRestart.summaries?.length ?? 0) > 0, "重启后必须仍能列出已提交摘要块");
  assert.equal(statusAfterRestart.triggerTokens, EXPECTED_TRIGGER_TOKENS, "重启后产品阈值口径必须保持不变");

  // 压缩之后的每一次 provider 请求都必须持续保持压缩形态（含重启后）。
  for (let index = compressedAt; index < fixture.requests.length; index++) {
    const record = fixture.requests[index]!;
    assertCompacted(record, `第 ${index + 1} 次 provider 请求`, { retrievedOriginal: index >= retrieveStart + 1 });
    assert(record.tokens < expectedRawTokens, `第 ${index + 1} 次 provider 请求 token=${record.tokens} 不应回到未压缩基线 ${expectedRawTokens}`);
  }

  // ── 5) 产品设置确实生效：同样 ≈40K 历史，ratio 0.9 不整理、ratio 0.2 整理 ──────
  const highRatio = await ratioScenario("ratio-high", 0.9);
  assert.equal(highRatio.status.triggerTokens, 115_200, `ratio=0.9 时触发线必须是 115200，实际 ${highRatio.status.triggerTokens}`);
  assert(!SUMMARY_MARKER_PATTERN.test(requestText(highRatio.request)),
    `ratio=0.9（trigger 115200）时 ≈40K 历史不应自动整理：${requestText(highRatio.request).slice(0, 400)}`);
  assert(requestText(highRatio.request).includes(SEED_OLD_MARKER), "ratio=0.9 时 provider 必须收到完整种子历史");
  const lowRatio = await ratioScenario("ratio-low", 0.2);
  assert.equal(lowRatio.status.triggerTokens, 25_600, `ratio=0.2 时触发线必须是 25600，实际 ${lowRatio.status.triggerTokens}`);
  assert(SUMMARY_MARKER_PATTERN.test(requestText(lowRatio.request)),
    `ratio=0.2（trigger 25600）时 ≈40K 历史必须自动整理：${requestText(lowRatio.request).slice(0, 400)}`);
  assert(!requestText(lowRatio.request).includes(SEED_OLD_MARKER), "ratio=0.2 自动整理后旧 marker 必须消失");

  // ── 6) 无可整理内容：干净 runtime 的 compact() 必须如实 skipped ───────────────
  const summaryCallsBeforeEmpty = fixture.summaryCalls.length;
  empty = await openRuntime(botOptions({ directory: emptyDirectory, withSeed: false, seed: seeded, workspace, fixture, statusHistory }), "empty runtime");
  runtimes.push(empty);
  const emptyStatus = await statusOf(empty);
  assert.equal(emptyStatus.engine, "billion-context");
  assert.equal(emptyStatus.triggerTokens, EXPECTED_TRIGGER_TOKENS);
  const outcome = await withTimeout(empty.compact(), "compact empty history");
  assert.equal(outcome.applied, false, `空会话 compact 不得伪报 applied：${JSON.stringify(outcome)}`);
  assert.equal(outcome.engine, "billion-context", `空会话 compact 应走 billion-context：${JSON.stringify(outcome)}`);
  assert.equal(typeof outcome.skippedReason, "string", `无可整理内容必须返回 skippedReason：${JSON.stringify(outcome)}`);
  assert((outcome.skippedReason ?? "").trim().length > 0, `skippedReason 不得为空：${JSON.stringify(outcome)}`);
  assert.equal(fixture.summaryCalls.length, summaryCallsBeforeEmpty, "空历史 compact 不得调用摘要模型");

  console.log("");
  console.log("PASS 产品阈值生效：128K 窗口 × ratio 0.8 = 102400 触发线；ratio 0.9/0.2 对照证明设置真的改变自动整理行为");
  console.log("PASS 自动整理：provider 请求显著变小并出现摘要标记，后续请求（含重启后）持续重放已提交摘要");
  console.log("PASS 原文回查：真实 acp_retrieve 工具调用 + Durable tool-result entry，逐字取回种子原句与原文细节");
  console.log("PASS 重启恢复：同一 options 重开后摘要仍生效、blocks>0、摘要模型调用次数不增长");
  console.log("PASS 无可整理内容：compact() 返回 applied=false 且 skippedReason 非空");
  console.log("durable context management test passed");
} finally {
  for (const runtime of runtimes) {
    try { await withTimeout(runtime.close(), "cleanup close", 5_000); }
    catch (error) { console.warn("[context-test] cleanup close failed:", error instanceof Error ? error.message : String(error)); }
  }
  for (const [key, value] of savedEnv) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
}