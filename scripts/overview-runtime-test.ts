/**
 * overview-runtime-test.ts — 「概览」Runtime Observatory view-model 单测。
 *
 * 覆盖：主 Agent 状态映射；运行中子代理聚合（role fallback/耗时/摘要）；
 * 完成态子代理（状态映射/去重计数/防御解析/无 id 忽略）；后台任务
 * （终端会话 alive/exitCode 映射、bash 运行中命令、completed bash 不展示、
 * 不伪造 exit）；task scope 隔离（纯函数按 taskId 输入，无跨任务串数据）；
 * 畸形/缺失输入安全 fallback；elapsed/截断纯函数。
 */
import {
  buildMainAgent,
  buildRunningSubagents,
  buildDoneSubagents,
  buildBackgroundTasks,
  buildRuntimeOverview,
  formatElapsed,
  oneLine,
  readableRole,
  extractSubagentId,
} from "@/components/artifact/overview/overviewRuntime";
import type { ChatMessage } from "@/types";
import type { SubagentSummaryDto } from "@shared/agent-ipc";
import { terminalOwnerStoreKey, type TerminalSessionInfo } from "@shared/terminal-ipc";
import { modelBadgeTitle, modelSourceLabel, shortModelLabel } from "../src/renderer/src/lib/modelBadge";

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

function subagentDto(partial: Partial<SubagentSummaryDto> & { subagentId: string }): SubagentSummaryDto {
  return {
    role: "fixture",
    roleSource: "user",
    roleDescription: "",
    project: "C:/p",
    status: "running",
    createdAt: NOW - 60_000,
    updatedAt: NOW - 10_000,
    runCount: 1,
    steerCount: 0,
    pendingSteers: [],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
    depth: 1,
    ...partial,
  } as SubagentSummaryDto;
}

console.log("== 主 Agent 状态映射 ==");
{
  assert(buildMainAgent([]).label === "等待", "无消息 → 等待");
  assert(buildMainAgent([msg({ id: "m1", blocks: [] })]).label === "空闲", "最后 assistant 非 streaming → 空闲");
  const lastUser = [
    msg({ id: "m0", blocks: [] }),
    { id: "mu", role: "user" as const, blocks: [], text: "hi" } as unknown as ChatMessage,
  ];
  assert(buildMainAgent(lastUser).label === "等待", "最后消息是 user（agent 未响应）→ 等待");
  const running = msg({
    id: "m2",
    streaming: true,
    blocks: [
      { type: "thinking", text: "t" },
      { type: "tool", toolCall: { id: "tc1", tool: "write", summary: "src/foo.ts", status: "running" as const } },
    ],
  });
  const vm = buildMainAgent([running]);
  assert(vm.state === "working" && vm.label === "运行中", "streaming → 运行中");
  assert(vm.action === "正在 src/foo.ts", `action 取最近 running tool（${vm.action}）`);
  const noTool = msg({ id: "m3", streaming: true, blocks: [] });
  assert(buildMainAgent([noTool]).action === "正在生成回复…", "streaming 无 tool → 生成回复中");
  const doneFirst = [
    msg({ id: "m4", blocks: [{ type: "tool", toolCall: { id: "tc2", tool: "bash", summary: "old", status: "success" as const } }] }),
  ];
  assert(buildMainAgent(doneFirst).label === "空闲", "完成的 tool 不显示运行中");
}

console.log("== 运行中子代理聚合 ==");
{
  const dtos = [
    subagentDto({ subagentId: "sa-aaa111bbb222", role: "Review Agent", lastTask: "检查 CDP 架构", lastPromptAt: NOW - 92_000 }),
    subagentDto({ subagentId: "sa-2", role: "Test Agent", lastTask: "pnpm test", lastPromptAt: NOW - 5_000 }),
    // idle 但 worker 存活（工具调用间隙）→ 仍算运行中
    subagentDto({ subagentId: "sa-3", role: "Idle Agent", status: "idle", workerAlive: true }),
    // 已结束（非 active）→ 不显示为运行中
    subagentDto({ subagentId: "sa-4", role: "Done Agent", status: "completed", lastResultAt: NOW - 1_000 }),
    // worker 不存活也不显示
    subagentDto({ subagentId: "sa-5", role: "Dead Agent", status: "idle", workerAlive: false }),
  ];
  const list = buildRunningSubagents(dtos, NOW);
  assert(list.length === 3, `3 个 active（${list.length}）`);
  const r1 = list.find((s) => s.id === "sa-aaa111bbb222")!;
  assert(r1.role === "Review Agent" && r1.work === "检查 CDP 架构", "role + 当前工作摘要（lastTask）");
  assert(r1.elapsedMs === 92_000, "耗时 = now - lastPromptAt");
  const idle = list.find((s) => s.id === "sa-3")!;
  assert(idle.work === "等待工具调用", "idle+workerAlive → 等待工具调用");
  // role fallback
  const noRole = buildRunningSubagents([subagentDto({ subagentId: "super-long-id-123456789", role: "" })], NOW);
  assert(noRole[0].role.endsWith("…") && noRole[0].role.length <= 13, `role 回退 id 短形式（${noRole[0].role}）`);
  // 空/缺字段防御
  assert(buildRunningSubagents([], NOW).length === 0, "空列表 → 空");
  assert(
    buildRunningSubagents([subagentDto({ subagentId: "x", role: "", lastTask: "", createdAt: NOW })], NOW).length === 1,
    "缺 lastTask/时间戳不崩（回退默认）",
  );
}

console.log("== 完成态子代理（task 内短暂记录） ==");
{
  const doneOk = msg({
    id: "m5",
    blocks: [
      {
        type: "tool",
        toolCall: {
          id: "tc10",
          tool: "subagent",
          summary: "subagent",
          status: "success" as const,
          output: `\n> subagent: sa-ok-1（本次任务内临时实例，已结束）\nSMOKE_OK_ONE`,
        },
      },
      {
        type: "tool",
        toolCall: {
          id: "tc11",
          tool: "subagent",
          summary: "subagent",
          status: "error" as const,
          output: `\n> subagent: sa-ok-1\nFAILED`,
        },
      },
      {
        type: "tool",
        toolCall: {
          id: "tc12",
          tool: "subagent",
          summary: "subagent",
          status: "denied" as const,
          output: `\n> subagent: sa-deny-1\n`,
        },
      },
      // 未终结 → 忽略（运行中由 IPC 侧覆盖）
      { type: "tool", toolCall: { id: "tc13", tool: "subagent", summary: "s", status: "running" as const } },
      // 无法解析 id → 忽略（防御）
      { type: "tool", toolCall: { id: "tc14", tool: "subagent", summary: "s", status: "success" as const, output: "garbage" } },
    ],
  });
  const done = buildDoneSubagents([doneOk]);
  assert(done.length === 2, `2 条可聚合完成态（${done.length}）`);
  const ok1 = done.find((d) => d.id === "sa-ok-1")!;
  assert(ok1.count === 2, `同 id 多次调用聚合 ×2（${ok1.count}）`);
  assert(ok1.state === "failed" && ok1.summary === "FAILED", "状态/摘要取最后一次（最终态覆盖，后调用 error → failed）");
  const deny = done.find((d) => d.id === "sa-deny-1")!;
  assert(deny.state === "cancelled" && deny.summary === "已取消", "denied → cancelled（无文本 → 默认文案）");
  // 无 output → 默认文案
  const bare = buildDoneSubagents([
    msg({
      id: "m6",
      blocks: [{ type: "tool", toolCall: { id: "t", tool: "subagent", summary: "s", status: "success" as const, output: "> subagent: sa-bare-1" } }],
    }),
  ]);
  assert(bare[0].summary === "已完成", "无结果文本 → 已完成");
  // 空消息 → 空
  assert(buildDoneSubagents([]).length === 0, "空消息 → 空");
}

console.log("== displayName（显示层字段） ==");
{
  // 运行中：displayName 与 role 并存，渲染层优先 displayName
  const running = buildRunningSubagents(
    [subagentDto({ subagentId: "sa-dn-1", role: "scout", displayName: "皮卡丘" })],
    NOW,
  );
  assert(running[0].displayName === "皮卡丘" && running[0].role === "scout", "运行中 displayName 与 role 并存");
  const runningNoName = buildRunningSubagents([subagentDto({ subagentId: "sa-dn-2", role: "scout" })], NOW);
  assert(runningNoName[0].displayName === undefined, "无 displayName → undefined（渲染回退 role）");

  // 完成态：从文本桥解析；摘要不得泄漏标记行
  const done = buildDoneSubagents([
    msg({
      id: "dn-1",
      blocks: [
        {
          type: "tool",
          toolCall: {
            id: "tc-dn",
            tool: "subagent",
            summary: "subagent",
            status: "success" as const,
            output: `\n\n> subagent-name: 皮卡丘\n> subagent: sa-dn-3（本次任务内临时实例，已结束）\n\n结果正文`,
          },
        },
      ],
    }),
  ]);
  assert(done[0].displayName === "皮卡丘", `完成态解析 displayName（${done[0].displayName}）`);
  assert(done[0].summary === "结果正文", `摘要不包含标记行（${done[0].summary}）`);
  assert(done[0].id === "sa-dn-3", "id 解析不受名字行影响");

  // 后一次调用没有名字 → 保留旧显示名
  const doneTwo = buildDoneSubagents([
    msg({
      id: "dn-2",
      blocks: [
        {
          type: "tool",
          toolCall: { id: "t1", tool: "subagent", summary: "s", status: "success" as const, output: "> subagent-name: 旧名\n> subagent: sa-dn-4\n正文一" },
        },
        { type: "tool", toolCall: { id: "t2", tool: "subagent", summary: "s", status: "success" as const, output: "> subagent: sa-dn-4\n正文二" } },
      ],
    }),
  ]);
  assert(doneTwo[0].displayName === "旧名", "无新名字的后续调用保留旧显示名");

  // 并行输出：header 行后带名字行
  const parallel = buildDoneSubagents([
    msg({
      id: "dn-3",
      blocks: [
        {
          type: "tool",
          toolCall: {
            id: "t3",
            tool: "subagent",
            summary: "s",
            status: "success" as const,
            output: "### [scout] completed (id: sa-dn-5)\n> subagent-name: 皮卡丘\n\n结果",
          },
        },
      ],
    }),
  ]);
  assert(parallel[0].id === "sa-dn-5" && parallel[0].displayName === "皮卡丘", "并行 header 后的名字行也能解析");
}

console.log("== Durable 结构化结果（details.results[]） ==");
{
  const detail = JSON.stringify({
    mode: "parallel",
    agentScope: "user",
    projectAgentsDir: null,
    results: [
      {
        agent: "worker",
        agentSource: "user",
        task: "审查 auth 补丁",
        subagentId: "durable-aaa-1",
        displayName: "皮卡丘",
        status: "completed",
        exitCode: 0,
        messages: [{ role: "assistant", content: [{ type: "text", text: "审查通过" }] }],
        resolvedModel: "openai/gpt-5",
      },
      {
        agent: "scout",
        agentSource: "user",
        task: "检索资料",
        subagentId: "durable-bbb-2",
        displayName: "杰尼龟",
        status: "failed",
        exitCode: 1,
        errorMessage: "超时",
      },
    ],
  });
  const done = buildDoneSubagents([
    msg({
      id: "structured-1",
      blocks: [
        {
          type: "tool",
          toolCall: {
            id: "tc-structured",
            tool: "subagent",
            summary: "subagent",
            status: "success" as const,
            output: "皮卡丘 (durable-aaa-1)\n审查通过\n\n杰尼龟 (durable-bbb-2)\n超时",
            detail: detail,
          },
        },
      ],
    }),
  ]);
  assert(done.length === 2, `一个工具调用拆出两条完成态（${done.length}）`);
  const a = done.find((item) => item.id === "durable-aaa-1")!;
  const b = done.find((item) => item.id === "durable-bbb-2")!;
  assert(a?.displayName === "皮卡丘" && a?.state === "completed" && a?.summary === "审查通过", "结构化结果：名字/状态/摘要");
  assert(a?.task === "审查 auth 补丁", "结构化结果：任务要求");
  assert(b?.displayName === "杰尼龟" && b?.state === "failed" && b?.summary === "超时", "结构化结果：失败态与错误摘要");
  assert(extractSubagentId("皮卡丘 (durable-aaa-1)", detail) === "durable-aaa-1", "工具 card 也能从结构化 detail 取 id");
}

console.log("== 后台任务（终端会话 + bash） ==");
{
  const termRunning: TerminalSessionInfo = {
    taskId: "task-1",
    sessionId: "s1",
    cwd: "C:/p",
    shell: "C:/Program Files/PowerShell/7/pwsh.exe",
    alive: true,
    exitCode: null,
    exitReason: null,
    startedAt: NOW - 120_000,
  };
  const termDone: TerminalSessionInfo = {
    ...termRunning,
    sessionId: "s2",
    alive: false,
    exitCode: 0,
    exitReason: "exit",
    startedAt: NOW - 300_000,
  };
  const termFail: TerminalSessionInfo = {
    ...termRunning,
    sessionId: "s3",
    alive: false,
    exitCode: 2,
    exitReason: "exit",
    startedAt: NOW - 10_000,
  };
  const termNoLifecycle: TerminalSessionInfo = { ...termRunning, sessionId: "s4", alive: false, exitCode: null };
  const m = msg({
    id: "m7",
    blocks: [
      { type: "tool", toolCall: { id: "tb1", tool: "bash", summary: "pnpm dev", status: "running" as const } },
      { type: "tool", toolCall: { id: "tb2", tool: "bash", summary: "vitest --run", status: "success" as const } },
      { type: "tool", toolCall: { id: "tw1", tool: "write", summary: "x.ts", status: "running" as const } },
    ],
  });
  const bg = buildBackgroundTasks([m], {
    "task-1": termRunning,
    "task-2": { ...termDone, taskId: "task-2" },
    "task-3": { ...termFail, taskId: "task-3" },
    "task-9": { ...termNoLifecycle, taskId: "task-9" },
  }, "task-1", NOW);
  assert(bg.length === 2, `task-1：终端 running + bash running（${bg.length}；瞬时 write 不计入）`);
  assert(bg[0].name === "pwsh" && bg[0].state === "running" && bg[0].elapsedMs === 120_000, "终端会话 basename + running + 耗时");
  assert(bg[1].name === "pnpm dev" && bg[1].state === "running", "运行中 bash 命令展示");
  // completed bash 无 exit code → 不展示（不伪造）；此处用无 running 命令的消息隔离终端断言
  const quiet = [msg({ id: "mQ", blocks: [] })];
  const bgDone = buildBackgroundTasks(quiet, { "task-1": termDone }, "task-1", NOW);
  assert(bgDone.length === 1 && bgDone[0].state === "completed" && bgDone[0].exitCode === 0, "completed 终端 → exit 0");
  const bgFail = buildBackgroundTasks(quiet, { "task-1": termFail }, "task-1", NOW);
  assert(bgFail.length === 1 && bgFail[0].state === "failed" && bgFail[0].exitCode === 2, "非零退出 → failed exit 2");
  const bgNone = buildBackgroundTasks(quiet, { "task-1": termNoLifecycle }, "task-1", NOW);
  assert(bgNone.length === 0, "死会话无 exitCode → 不展示该终端（不伪造 lifecycle）");
  // running 排序在前
  const bgSorted = buildBackgroundTasks(
    [msg({ id: "m8", blocks: [{ type: "tool", toolCall: { id: "tb3", tool: "bash", summary: "later", status: "running" as const } }] })],
    { "task-1": termDone },
    "task-1",
    NOW,
  );
  assert(bgSorted[0].state === "running", "running 排在 completed 前");
}

console.log("== 复用场景：同 id 先完成再运行 → running 优先，done 让位 ==");
{
  const msgs = [
    msg({
      id: "m-reuse",
      blocks: [
        {
          type: "tool",
          toolCall: { id: "t1", tool: "subagent", summary: "s", status: "success" as const, output: "> subagent: sa-reuse-1\nDONE" },
        },
        { type: "tool", toolCall: { id: "t2", tool: "subagent", summary: "s", status: "running" as const, output: "> subagent: sa-reuse-1\n" } },
      ],
    }),
  ];
  const vm = buildRuntimeOverview({
    taskId: "task-reuse",
    messages: msgs,
    activeSubagents: [subagentDto({ subagentId: "sa-reuse-1", role: "Reuse Agent", status: "running" })],
    terminalSessions: {},
    now: NOW,
  });
  assert(vm.runningSubagents.some((r) => r.id === "sa-reuse-1"), "复用运行中 → running 条目存在");
  assert(!vm.doneSubagents.some((d) => d.id === "sa-reuse-1"), "同 id done 旧记录让位（无双条目）");
  const vmNoRunning = buildRuntimeOverview({
    taskId: "task-reuse",
    messages: msgs,
    activeSubagents: [],
    terminalSessions: {},
    now: NOW,
  });
  assert(vmNoRunning.doneSubagents.some((d) => d.id === "sa-reuse-1" && d.state === "completed"), "实例已结束 → done 记录恢复展示");
}

console.log("== task scope 隔离（纯函数输入隔离） ==");
{
  const mTask1 = msg({
    id: "m9",
    streaming: true,
    blocks: [{ type: "tool", toolCall: { id: "a", tool: "bash", summary: "cmd A", status: "running" as const } }],
  });
  const mTask2 = msg({
    id: "m10",
    streaming: true,
    blocks: [{ type: "tool", toolCall: { id: "b", tool: "bash", summary: "cmd B", status: "running" as const } }],
  });
  const vm1 = buildRuntimeOverview({
    taskId: "task-1",
    messages: [mTask1],
    activeSubagents: [subagentDto({ subagentId: "sa-t1", role: "R1" })],
    terminalSessions: { "task-1": { ...termFor("task-1"), alive: true }, "task-2": { ...termFor("task-2"), alive: false, exitCode: 5 } },
    now: NOW,
  });
  const vm2 = buildRuntimeOverview({
    taskId: "task-2",
    messages: [mTask2],
    activeSubagents: [],
    terminalSessions: { "task-1": { ...termFor("task-1"), alive: true }, "task-2": { ...termFor("task-2"), alive: false, exitCode: 5 } },
    now: NOW,
  });
  assert(vm1.runningSubagents.length === 1 && vm2.runningSubagents.length === 0, "子代理按输入列表隔离");
  assert(vm1.backgroundTasks.some((b) => b.name === "cmd A" && b.state === "running"), "task-1 只见自己的 bash");
  assert(!vm1.backgroundTasks.some((b) => b.name === "cmd B"), "task-1 不见 task-2 的 bash");
  assert(vm2.backgroundTasks.some((b) => b.exitCode === 5 && b.state === "failed"), "task-2 只见自己的终端（exit 5）");
  assert(vm2.backgroundTasks.some((b) => b.name === "cmd B"), "task-2 的 bash 正常显示");
  function termFor(taskId: string): TerminalSessionInfo {
    return { taskId, sessionId: taskId, cwd: "C:/p", shell: "bash", alive: true, exitCode: null, exitReason: null, startedAt: NOW - 1000 };
  }
}

console.log("== 任务与空间多终端：按归属汇总并按 sessionId 去重 ==");
{
  const wsTerm: TerminalSessionInfo = {
    workspaceId: "ws-1",
    terminalId: "tab-workspace",
    sessionId: "s-ws",
    cwd: "C:/Users/servi/Desktop/mybuddy",
    shell: "pwsh",
    alive: true,
    exitCode: null,
    exitReason: null,
    startedAt: NOW - 5000,
  };
  const taskTerm: TerminalSessionInfo = { ...termFor("task-1"), terminalId: "tab-task" };
  const bg = buildBackgroundTasks([], { "ws-1": wsTerm, "task-1": taskTerm }, "task-1", NOW, "ws-1");
  assert(bg.length === 2 && bg.some((item) => item.name === "pwsh") && bg.some((item) => item.name === "bash"), "同时展示当前任务与绑定空间的终端");
  assert(bg.every((item) => item.state === "running"), "任务与空间的存活会话都保留 running 状态");

  const secondWorkspaceTerm: TerminalSessionInfo = {
    ...wsTerm, sessionId: "s-ws-second", terminalId: "tab-workspace-second", shell: "zsh",
  };
  const foreignWorkspaceTerm: TerminalSessionInfo = {
    ...wsTerm, workspaceId: "ws-other", sessionId: "s-ws-other", terminalId: "tab-foreign-workspace",
  };
  const foreignTaskTerm: TerminalSessionInfo = {
    ...termFor("task-other"), terminalId: "tab-foreign-task",
  };
  const sessions: Record<string, TerminalSessionInfo> = {
    // The store mirrors both per-tab owner keys and legacy owner aliases.
    [terminalOwnerStoreKey(wsTerm)!]: wsTerm,
    "ws-1": wsTerm,
    [terminalOwnerStoreKey(taskTerm)!]: taskTerm,
    "task-1": taskTerm,
    [terminalOwnerStoreKey(secondWorkspaceTerm)!]: secondWorkspaceTerm,
    [terminalOwnerStoreKey(foreignWorkspaceTerm)!]: foreignWorkspaceTerm,
    [terminalOwnerStoreKey(foreignTaskTerm)!]: foreignTaskTerm,
  };
  const multi = buildBackgroundTasks([], sessions, "task-1", NOW, "ws-1");
  assert(multi.length === 3, "同空间多标签与任务终端全部汇总，别名不重复计数");
  assert(multi.filter((item) => item.terminalId === wsTerm.terminalId).length === 1, "空间会话的标签键与旧别名按 sessionId 去重");
  assert(multi.filter((item) => item.terminalId === taskTerm.terminalId).length === 1, "任务会话的标签键与旧别名按 sessionId 去重");
  assert(multi.some((item) => item.terminalId === secondWorkspaceTerm.terminalId && item.name === "zsh"), "同一空间的第二个真实会话保持独立");
  assert(!multi.some((item) => item.terminalId === foreignWorkspaceTerm.terminalId || item.terminalId === foreignTaskTerm.terminalId), "排除其它任务与其它空间的会话");

  const bgTask = buildBackgroundTasks([], { "task-9": termFor("task-9") }, "task-9", NOW);
  assert(bgTask.length === 1 && bgTask[0].name === "bash", "独立任务仍按 taskId 查找");
  function termFor(taskId: string): TerminalSessionInfo {
    return { taskId, sessionId: taskId, cwd: "C:/p", shell: "bash", alive: true, exitCode: null, exitReason: null, startedAt: NOW - 1000 };
  }
}

console.log("== 模型标识展示（主 Agent / 运行中 / 完成态） ==");
{
  // 主 Agent：任务级 activeModelId + 目录名称
  const withModel = buildMainAgent([], { id: "deepseek/deepseek-v4.1-flash", name: "DeepSeek V4.1 Flash" });
  assert(withModel.model?.label === "DeepSeek V4.1 Flash", `主 Agent 用目录名显示（${withModel.model?.label}）`);
  assert(withModel.model?.full === "deepseek/deepseek-v4.1-flash", "主 Agent title 保留完整 id");
  assert(buildMainAgent([]).model === undefined, "无 activeModelId → 不伪造模型");

  // 运行中子代理：实测值优先，解析值进 note，来源映射成可读文案
  const running = buildRunningSubagents(
    [
      subagentDto({
        subagentId: "sa-model-1",
        status: "running",
        resolvedModel: "openai/gpt-5",
        actualModel: "gpt-5",
        modelSource: "invocation",
      }),
      subagentDto({ subagentId: "sa-model-2", status: "running", resolvedModel: "deepseek/deepseek-v4.1-flash", modelSource: "parent" }),
      subagentDto({ subagentId: "sa-model-3", status: "running" }),
    ],
    NOW,
    { "openai/gpt-5": "GPT-5", "deepseek/deepseek-v4.1-flash": "DeepSeek V4.1 Flash" },
  );
  const m1 = running.find((s) => s.id === "sa-model-1")!;
  assert(m1.model?.label === "GPT-5" && m1.model?.full === "gpt-5", "实测模型优先，名称取解析值对应的目录名");
  assert(m1.model?.note === "解析值 openai/gpt-5", "实测与解析不一致时保留解析值（不静默丢弃）");
  assert(m1.model?.source === "手动指定", `来源 invocation → 手动指定（${m1.model?.source}）`);
  const m2 = running.find((s) => s.id === "sa-model-2")!;
  assert(m2.model?.label === "DeepSeek V4.1 Flash" && m2.model?.source === "继承父模型", "继承父模型也有模型标签");
  assert(running.find((s) => s.id === "sa-model-3")!.model === undefined, "无模型记录 → 不显示（宁缺毋伪造）");

  // 完成态：只认工具结果里的结构化证据行
  const doneMessages = [
    msg({
      id: "m-model",
      blocks: [
        {
          type: "tool",
          toolCall: {
            id: "tm1",
            tool: "subagent",
            summary: "subagent",
            status: "success" as const,
            output: `\n> subagent: sa-done-model\nResolved model: openai/gpt-5; thinking: high\nObserved model: gpt-5\n\nDONE`,
          },
        },
        {
          type: "tool",
          toolCall: {
            id: "tm2",
            tool: "subagent",
            summary: "subagent",
            status: "success" as const,
            output: "\n> subagent: sa-done-model\n没有任何证据行",
          },
        },
        {
          type: "tool",
          toolCall: {
            id: "tm3",
            tool: "subagent",
            summary: "subagent",
            status: "success" as const,
            output: "\n> subagent: sa-done-nomodel\nDONE",
          },
        },
      ],
    }),
  ];
  const done = buildDoneSubagents(doneMessages, { "openai/gpt-5": "GPT-5" });
  const doneModel = done.find((d) => d.id === "sa-done-model")!;
  assert(doneModel.model?.label === "GPT-5" && doneModel.model?.full === "openai/gpt-5", "完成态从证据行解析 Resolved model");
  assert(doneModel.count === 2, "后续无证据调用不破坏聚合计数");
  assert(done.find((d) => d.id === "sa-done-nomodel")!.model === undefined, "无证据行 → 完成态不猜模型");

  // 总入口透传：mainModel + modelNames 一次装配
  const overview = buildRuntimeOverview({
    taskId: "task-model",
    messages: [],
    activeSubagents: [subagentDto({ subagentId: "sa-ov", status: "running", resolvedModel: "openai/gpt-5" })],
    terminalSessions: {},
    now: NOW,
    mainModel: { id: "openai/gpt-5", name: "GPT-5" },
    modelNames: { "openai/gpt-5": "GPT-5" },
  });
  assert(overview.mainAgent.model?.label === "GPT-5", "总入口透传主 Agent 模型");
  assert(overview.runningSubagents[0].model?.label === "GPT-5", "总入口透传子代理模型");

  // 纯函数边界
  assert(shortModelLabel("openai/gpt-5") === "gpt-5", "id 末段作为回退短名");
  assert(shortModelLabel("auto") === "自动选择", "占位值 auto → 自动选择（不冒充模型名）");
  assert(shortModelLabel("provider/this-is-an-extremely-long-model-identifier-for-testing").endsWith("…"), "超长短名截断");
  assert(modelSourceLabel("role") === "角色指定" && modelSourceLabel(undefined) === undefined, "来源文案映射/缺省");
  assert(modelBadgeTitle({ label: "x", full: "p/x", source: "手动指定" }) === "模型：p/x · 来源：手动指定", "title 带完整标识与来源");
}

console.log("== 纯函数（elapsed / 截断 / role / id 解析） ==");
{
  assert(formatElapsed(0) === "刚刚", "0ms → 刚刚");
  assert(formatElapsed(12_000) === "12s", "12s");
  assert(formatElapsed(92_000) === "1m 32s", "1m 32s");
  assert(formatElapsed(3_600_000 + 300_000) === "1h 05m", "1h 05m");
  assert(formatElapsed(-5) === "刚刚", "负值防御");
  assert(oneLine("a\nb", 10) === "a", "只取首行");
  assert(oneLine("12345678901234567890", 8) === "12345678…", "限长截断");
  assert(oneLine("", 8) === "", "空 → 空");
  assert(readableRole("id", "  ") === "id", "空白 role → id");
  assert(extractSubagentId("> subagent: sa-x-1（结束）", undefined) === "sa-x-1", "output 首行解析");
  assert(extractSubagentId(undefined, "(id: sa-y-2)") === "sa-y-2", "detail 解析");
  assert(extractSubagentId("garbage", undefined) === null, "无法解析 → null");
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);

