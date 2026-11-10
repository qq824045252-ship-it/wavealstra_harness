import { subagentHeaderMetrics } from "../src/renderer/src/lib/subagentHeaderMetrics";
/**
 * subagent-runs-test.ts — 子代理运行态的纯逻辑验收。
 *
 * 覆盖用户能直接看到的三条契约：
 * 1. 名字同步：侧栏/顶栏/对话页都只能经 subagentRunName 取名（displayName → role → id）；
 * 2. 完成不消失：运行中派发的 details.results[] 也必须出现在完成态；
 * 3. 窗口驱逐不消失：消息被裁掉后，记过账的条目补成「已结束」，且不重复。
 * 另外验收子会话消息 → 主聊天 ChatMessage 的映射（任务补位、工具卡、正文走 finalBlocks）。
 */
import {
  buildDoneSubagents,
  buildQueuedSubagents,
  buildRuntimeOverview,
  subagentRunName,
  type DoneSubagentVm,
} from "@/components/artifact/overview/overviewRuntime";
import {
  accumulateSubagentRuns,
  resetSubagentRunsAccumulator,
} from "@/lib/subagentRunsAccumulator";
import { childMessagesToChatMessages, findSubagentResultRun } from "@/lib/subagentChat";
import type { ChildMessage } from "@/lib/subagentDetails";
import type { ChatMessage } from "@/types";

let passed = 0;
let failed = 0;
function assert(cond: boolean, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

const NOW = 1_000_000;

function msg(partial: Partial<ChatMessage> & { id: string }): ChatMessage {
  return { role: "assistant", blocks: [], createdAt: NOW, ...partial };
}

function child(task: string, name: string, text: string, ts: number): ChildMessage[] {
  return [
    { role: "user", content: [{ type: "text", text: task }], timestamp: ts },
    {
      role: "assistant",
      model: "deepseek/deepseek-v4.1-flash",
      content: [
        { type: "thinking", thinking: "先看文件" },
        { type: "toolCall", id: "c1", name: "read", arguments: { path: "src/a.ts" } },
        { type: "text", text },
      ],
      timestamp: ts + 30_000,
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
      stopReason: "stop",
    },
    { role: "toolResult", toolCallId: "c1", toolName: "read", isError: false, content: [{ type: "text", text: "file body" }], timestamp: ts + 20_000 },
  ];
}

function dispatchDetail(options: { running: boolean; names?: [string, string] }): string {
  const [a, b] = options.names ?? ["耿鬼", "超梦"];
  return JSON.stringify({
    mode: "parallel",
    concurrency: { workers: 1, queued: 1, maxConcurrency: 1, serializedReason: "仓库禁止 worktree，本次派发串行（1 并发）" },
    plan: [
      { itemId: "item-0", index: 0, agent: "scout", displayName: a, task: "只读侦察 A", cwd: "C:/repo", required: true, dependencies: [], isolation: "shared" },
      { itemId: "item-1", index: 1, agent: "scout", displayName: b, task: "只读侦察 B", cwd: "C:/repo", required: true, dependencies: [], isolation: "shared" },
    ],
    results: [
      {
        subagentId: "item-0",
        agent: "scout",
        displayName: a,
        task: "只读侦察 A",
        status: "completed",
        exitCode: 0,
        resolvedModel: "deepseek/deepseek-v4.1-flash",
        workspace: { kind: "shared", cwd: "C:/repo" },
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 900, turns: 2 },
        messages: child("只读侦察 A", a, "A 的结论", NOW - 60_000),
      },
    ],
  });
}

const runningDispatch = (): ChatMessage[] => [
  msg({
    id: "m-dispatch",
    streaming: true,
    blocks: [{
      type: "tool",
      toolCall: { id: "tc-1", tool: "subagent", summary: "2 个并行：scout · 耿鬼、scout · 超梦", status: "running", detail: dispatchDetail({ running: true }) },
    }],
  }),
];

console.log("== 名字同步（唯一取名入口） ==");
{
  assert(subagentRunName({ displayName: "卡比兽", role: "reviewer", id: "durable-1" }) === "卡比兽", "displayName 优先");
  assert(subagentRunName({ displayName: "  ", role: "reviewer", id: "durable-1" }) === "reviewer", "空 displayName 回退 role");
  assert(subagentRunName({ role: "scout", agent: "reviewer", id: "durable-1" }) === "scout", "role 优先于 agent");
  assert(subagentRunName({ id: "durable-123456789012345" }) === "durable-1234…", "都没有时回退 id 短形式");
  assert(subagentRunName({ id: "" }) === "subagent", "空 id 也不产出空名字");
}

console.log("== 完成态不消失：运行中的派发也要出完成行 ==");
{
  const done = buildDoneSubagents(runningDispatch());
  assert(done.length === 1, `运行中派发里已完结的 child 出现在完成态（${done.length} 条）`);
  assert(done[0]?.id === "item-0", "id 是真实 subagentId");
  assert(done[0]?.name === "耿鬼", `名字取 displayName（${done[0]?.name}）`);
  assert(done[0]?.state === "completed", "状态来自结构化结果");
  assert(done[0]?.cwd === "C:/repo", `工作目录来自 workspace.cwd（${done[0]?.cwd}）`);
  assert(done[0]?.durationMs === 30_000, `真实时长来自消息时间戳（${done[0]?.durationMs}）`);
  const vm = buildRuntimeOverview({ taskId: "t", messages: runningDispatch(), activeSubagents: [], terminalSessions: {}, now: NOW });
  assert(vm.doneSubagents.length === 1 && vm.queuedSubagents.length === 1, "同一份 details：已完成 1 + 排队 1");
  assert(vm.queuedSubagents[0]?.name === "超梦", `排队项同样有名字（${vm.queuedSubagents[0]?.name}）`);
  assert(vm.queuedSubagents[0]?.cwd === "C:/repo", "排队项带计划里的 cwd");
}

console.log("== 排队项：plan − results − 活跃 的差集 ==");
{
  const queued = buildQueuedSubagents(runningDispatch(), new Set(["item-1"]));
  assert(queued.queued.length === 0, "轮到并发名额后不再算排队");
  assert(queued.concurrency?.workers === 1 && queued.concurrency?.queued === 1, "并发口径来自 details");
  const legacy = buildQueuedSubagents(
    [msg({ id: "m-legacy", blocks: [{ type: "tool", toolCall: { id: "t", tool: "subagent", summary: "s", status: "running", detail: JSON.stringify({ mode: "parallel", plan: [{ itemId: "x", agent: "scout", task: "做了点事" }], results: [] }) } }] })],
    new Set(),
  );
  assert(legacy.queued.length === 1 && legacy.queued[0]?.name === "scout", "旧 details 无 displayName 时回退 agent");
  assert(legacy.concurrency === undefined, "旧 details 没有 concurrency 就不显示并发口径");
}

console.log("== 窗口驱逐不消失（记账） ==");
{
  resetSubagentRunsAccumulator();
  const live = buildRuntimeOverview({ taskId: "t-evict", messages: runningDispatch(), activeSubagents: [], terminalSessions: {}, now: NOW });
  const first = accumulateSubagentRuns("t-evict", live);
  assert(first.doneSubagents.length === 1, "首帧记下 1 条完成态");
  // 模拟历史前滚：子代理那条 tool call 被裁出内存窗口
  const evicted = buildRuntimeOverview({ taskId: "t-evict", messages: [msg({ id: "m-new", blocks: [] })], activeSubagents: [], terminalSessions: {}, now: NOW });
  const afterEvict = accumulateSubagentRuns("t-evict", evicted);
  assert(afterEvict.doneSubagents.length === 1, `窗口驱逐后仍保留（${afterEvict.doneSubagents.length}）`);
  assert(afterEvict.doneSubagents[0]?.id === "item-0", "保留的是同一条实例");
  assert(afterEvict.doneSubagents[0]?.name === "耿鬼", "保留时名字不变");
  assert(afterEvict.doneSubagents[0]?.state === "completed", "记住的是当时的真实状态（completed 不变）");
  // 再跑一次同样的派生：幂等，不重复
  const again = accumulateSubagentRuns("t-evict", evicted);
  assert(again.doneSubagents.length === 1, "重复派生不会产生重复条目");

  // 运行中条目彻底消失且没有结果 → 只能写「已结束」，不能写「已完成」
  resetSubagentRunsAccumulator();
  const runningVm = buildRuntimeOverview({
    taskId: "t-lost",
    messages: [msg({ id: "m-run", blocks: [] })],
    activeSubagents: [{
      subagentId: "sa-lost", role: "scout", displayName: "卡比兽", roleSource: "user", roleDescription: "", project: "C:/repo",
      status: "running", createdAt: NOW - 5_000, updatedAt: NOW, lastPromptAt: NOW - 5_000, runCount: 1, steerCount: 0,
      pendingSteers: [], usage: { input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 10, turns: 1 },
      depth: 1, workerAlive: true,
    }],
    terminalSessions: {}, now: NOW,
  });
  accumulateSubagentRuns("t-lost", runningVm);
  const lost = accumulateSubagentRuns("t-lost", buildRuntimeOverview({ taskId: "t-lost", messages: [], activeSubagents: [], terminalSessions: {}, now: NOW }));
  const lostRow: DoneSubagentVm | undefined = lost.doneSubagents.find((row) => row.id === "sa-lost");
  assert(Boolean(lostRow), "运行中实例消失后仍留下一条");
  assert(lostRow?.state === "unknown", `状态只能是 unknown（${lostRow?.state}）`);
}

console.log("== 子会话消息 → 主聊天 ChatMessage ==");
{
  const rows = childMessagesToChatMessages(child("只读侦察 A", "耿鬼", "A 的结论", NOW), {
    prefix: "sa-1",
    task: "只读侦察 A",
    durationLabel: "30s",
  });
  assert(rows.length === 2, `user + assistant 两行（${rows.length}）`);
  assert(rows[0]?.role === "user" && rows[0]?.blocks[0]?.type === "text", "任务正文作为 user 行");
  const assistant = rows[1]!;
  const toolBlocks = assistant.blocks.filter((block) => block.type === "tool");
  assert(toolBlocks.length === 1, "工具调用进 blocks");
  const tool = toolBlocks[0]?.type === "tool" ? toolBlocks[0].toolCall : undefined;
  assert(tool?.tool === "read" && tool?.status === "success", "工具状态由 toolResult 决定");
  assert(tool?.output === "file body", "工具输出来自 toolResult");
  assert(assistant.blocks.some((block) => block.type === "thinking"), "思考块保留");
  assert(!assistant.blocks.some((block) => block.type === "text"), "正文不进过程块（与 durable 行一致）");
  assert(assistant.finalBlocks?.[0]?.type === "text", "正文走 finalBlocks");
  assert(assistant.durationLabel === "30s", "时长标签落在最后一条助手消息");

  const noUser = childMessagesToChatMessages([{ role: "assistant", content: [{ type: "text", text: "直接回答" }] }], {
    prefix: "sa-2",
    task: "补进来的任务",
  });
  assert(noUser.length === 2 && noUser[0]?.role === "user", "缺 user 消息时用任务正文补位");

  const found = findSubagentResultRun(runningDispatch(), "item-0");
  assert(found?.displayName === "耿鬼" && found.messages.length === 3, "完成态能按 id 找到完整子会话");
  assert(findSubagentResultRun(runningDispatch(), "nope") === null, "找不到就返回 null，不伪造");
}


console.log("== 子代理头部用量：同一快照 / 缺失不补零 ==");
{
  const metrics = (usage?: Parameters<typeof subagentHeaderMetrics>[0]) => Object.fromEntries(subagentHeaderMetrics(usage).map(m => [m.key, m]));
  const measured = metrics({ input: 1000, output: 2000, cacheRead: 8000, cacheWrite: 1000, turns: 2 });
  assert(measured.input.value === "0.001M" && measured.output.value === "0.002M", "输入/输出取当前子代理累计值，不把 contextTokens 当用量");
  assert(measured.hit.value === "80%", "命中率以缓存读/(新输入+缓存读+缓存写)计算");
  assert(measured.cacheWrite.value === "0.001M", "缓存写独立显示，不吞进输入或缓存读取");
  assert(measured.cacheRead.title.includes("8,000 tokens"), "悬停显示精确 token 数");
  const partial = metrics({ input: 1000, output: 300 });
  assert(partial.input.value === "0.001M" && partial.cacheRead.value === "—" && partial.hit.value === "—", "部分缺失保留已知值，未知缓存不伪造 0%");
  const invalid = metrics({ input: -1, output: NaN, cacheRead: Infinity, cacheWrite: 0 });
  assert(invalid.input.value === "—" && invalid.output.value === "—" && invalid.hit.value === "—", "负数/NaN/Infinity 不可作为计量");
  assert(metrics().hit.value === "—" && metrics().input.value === "—", "无用量时保持未知");
  assert(metrics({input:0,output:0,cacheRead:0,cacheWrite:0,turns:0}).input.value === "—", "未启动的占位 0 不冒充实测");
  assert(metrics({input:0,output:0,cacheRead:0,cacheWrite:0,turns:1}).input.value === "—", "失败响应的全零归一化占位不冒充计量");
  const zero = metrics({input:1000,output:0,cacheRead:0,cacheWrite:0,turns:1});
  assert(zero.hit.value === "0%" && zero.cacheRead.value === "0.000M", "明确测量的 0 命中与缺失区分");
  assert(metrics({input:0,output:100,cacheRead:0,cacheWrite:0,turns:1}).hit.value === "—", "零分母不伪造命中率");
  assert(metrics({input:Number.MAX_VALUE,cacheRead:Number.MAX_VALUE,cacheWrite:0}).hit.value === "—", "溢出分母不伪造有效百分比");
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exitCode = 1;
