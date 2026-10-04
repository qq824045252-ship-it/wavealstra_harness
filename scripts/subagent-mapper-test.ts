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
import { mapPiEventToPatches, summarizeToolInput, isDangerousTool } from "../src/shared/pi-event-mapper";

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
  assert(typeof p.output === "string" && p.output.length > 0, "output 含中间态文本");
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
  assert(isDangerousTool("bash", { command: "rm -rf x" }) === true, "bash 危险命令仍标记");
  assert(isDangerousTool("cad_freecad_run", {}) === true, "cad_freecad_run 恒危险（既有行为不回归）");
}

console.log("== summarizeToolInput 对 subagent 参数形态鲁棒 ==");
{
  const s = summarizeToolInput("subagent", { agent: "worker", task: "a".repeat(500), tasks: [] });
  assert(s.summary.length <= 120 && s.detail.length > 100, "长参数安全截断");
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
if (failed > 0) process.exit(1);
