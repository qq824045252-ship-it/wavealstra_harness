/**
 * Subagent → renderer progress 映射测试（F）。
 *
 * 验证：subagent 扩展的 onUpdate（工具执行中的中间态）经 pi AgentSessionEvent
 * （tool_execution_update，partialResult 含扩展 partial content/details）进入
 * pi-event-mapper 后，会产出渲染层可消费的 AgentUiPatch（tool_update，status running），
 * 而不是被 mapper 丢弃 → 主聊天中 subagent 运行状态真实可见。
 * 另验证危险工具标记 / tool_call 详情摘要函数对 subagent 参数形态的鲁棒性。
 * 必须经 scripts/test-guard.mjs 执行。
 */
import { mapPiEventToPatches, summarizeToolInput, isDangerousTool, isSideEffectTool } from "../src/shared/pi-event-mapper";
import { assistantRow, nestedToolRow } from "../src/main/agent/durable/DurableHistoryProjection";

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

const ctx = { taskId: "task-1", messageId: "msg-1", modelName: "m", startedAt: Date.now() };

console.log("== subagent onUpdate → renderer patch（tool_execution_update） ==");
{
  // 模拟 subagent 扩展 onUpdate 产生的 partialResult（AgentToolResult 形状）
  const partial = {
    content: [{ type: "text", text: "(running...)" }],
    details: {
      mode: "single",
      agentScope: "user",
      projectAgentsDir: null,
      results: [
        {
          agent: "worker", status: "running", subagentId: "worker-abc", exitCode: -1,
          messages: [], task: "do the thing",
        },
      ],
    },
  };
  const patches = mapPiEventToPatches(
    {
      type: "tool_execution_update",
      toolCallId: "call_1",
      toolName: "subagent",
      args: { agent: "worker", task: "do the thing" },
      partialResult: partial,
    },
    ctx,
  );
  assert(patches.length === 1, "产生 1 条 patch");
  const p = patches[0];
  // 契约：tool_start 已置 status=running；中间态更新走 tool_update + output（累计）
  assert(p.type === "tool_update", "中间态 → tool_update");
  assert(p.type === "tool_update" && typeof p.output === "string" && p.output.length > 0, "output 含中间态文本");
}

console.log("== subagent 完成/错误 → renderer patch ==");
{
  const endPatches = mapPiEventToPatches(
    {
      type: "tool_execution_end",
      toolCallId: "call_1",
      toolName: "subagent",
      result: {
        content: [{ type: "text", text: "Agent failed: boom" }],
      },
      isError: true,
    },
    ctx,
  );
  assert(endPatches.length === 1 && endPatches[0].type === "tool_update" && endPatches[0].status === "error", "失败 → tool_update status=error");
}

console.log("== 危险工具判定（subagent 自身不是危险工具；内部 bash 由子进程策略约束） ==");
{
  assert(isDangerousTool("subagent", {}) === false, "subagent 工具本身不标记危险（审批面在主会话保持现状）");
  // bash 属于「写类工具」（MUTATING_BUILTIN_TOOLS），由 isSideEffectTool 判定并要求审批；
  // isDangerousTool 是另一类（execute_code/browser_exec/ui_exec/computer_exec）。
  // 旧断言查错了函数：isDangerousTool 自初始提交起就没有 bash 分支，因此该断言从未成立。
  assert(isSideEffectTool("bash", { command: "rm -rf x" }) === true, "bash 仍按写类工具要求审批（isSideEffectTool）");
  assert(isDangerousTool("bash", { command: "rm -rf x" }) === false, "bash 不属于 isDangerousTool 类别（职责分离）");
  assert(isDangerousTool("execute_code", { code: "1" }) === true, "execute_code 恒危险（逃生通道不回归）");
}

console.log("== summarizeToolInput 对 subagent 参数形态鲁棒 ==");
{
  const s = summarizeToolInput("subagent", { agent: "worker", task: "a".repeat(500), tasks: [] });
  assert(s.summary.length <= 120 && (s.detail?.length ?? 0) > 100, "长参数安全截断");
}

console.log("== subagent 委派摘要是人读文本，不是参数 JSON ==");
{
  const single = summarizeToolInput("subagent", { agent: "worker", task: "改一行", displayName: "写入测试工" });
  assert(single.summary === "worker · 写入测试工", `单任务 → agent · displayName（${single.summary}）`);
  const parallel = summarizeToolInput("subagent", { tasks: [{ agent: "worker" }, { agent: "reviewer" }] });
  assert(parallel.summary === "2 个并行：worker、reviewer", `tasks → 并行数 + 角色（${parallel.summary}）`);
  const chain = summarizeToolInput("subagent", { chain: [{ agent: "planner" }, { agent: "worker" }] });
  assert(chain.summary === "2 步顺序链：planner → worker", `chain → 步数 + 顺序（${chain.summary}）`);
  const bare = summarizeToolInput("subagent", {});
  assert(bare.summary === "子代理委派", `无参数不落回 JSON（${bare.summary}）`);
  // 截图里的实参形态：任何形态都不得回落到字符串化参数
  for (const args of [{ agent: "worker", task: "x", tasks: [] }, { tasks: [{ agent: "worker", task: "y" }] }]) {
    assert(!summarizeToolInput("subagent", args).summary.trimStart().startsWith("{"), "摘要不是 JSON");
  }
}

console.log("== durable 工具行改用同一摘要（running 行不再吐参数 JSON） ==");
{
  const message = {
    role: "assistant" as const, content: [{ type: "toolCall" as const, id: "tc-1", name: "subagent",
      arguments: { tasks: [{ agent: "worker", subagentId: "selftest-worker-01", displayName: "写入测试工", isolation: "shared", cwd: "/tmp" }] } }],
    timestamp: 1_000, model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }, stopReason: "stop" as const,
  };
  const row = assistantRow("durable-x", undefined, message as never).tools?.[0];
  assert(row?.summary === "worker · 写入测试工", `assistantRow summary（${row?.summary}）`);
  assert((row?.detail ?? "").includes("selftest-worker-01"), "原始参数进 detail，可展开");
  const nestedString = nestedToolRow("parent", { name: "bash", args: "pnpm dev" }, 0);
  assert(nestedString.summary === "pnpm dev", "嵌套字符串参数保持原样");
  const nestedObject = nestedToolRow("parent", { name: "subagent", args: { agent: "worker", displayName: "皮卡丘" } }, 1);
  assert(nestedObject.summary === "worker · 皮卡丘", `嵌套对象参数走统一摘要（${nestedObject.summary}）`);
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
