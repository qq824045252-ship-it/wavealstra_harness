/**
 * 流式"聚焦最新"视图纯函数单测（无 React / 无 Electron）。
 *
 * 覆盖（对应需求清单）：
 *   1. 流式只见最新思考：旧 thinking 段隐藏、末段活跃
 *   2. success 工具进入历史（计数 + 隐藏判定）
 *   3. running / pending_approval 豁免可见；success / error / denied 进入历史
 *   4. 用户展开历史（focusActive=false）→ 完整时间线恢复
 *   5. 非流式保持原行为（不启用聚焦）
 *   6. 思考段被工具打断后保持活跃（活跃段 = 最后一段含 thinking 块的段）；
 *      末段纯过程文本兜底不空窗
 *   7. callout/plan 等非 thinking/tool 块永不隐藏
 *
 * 运行：node scripts/timeline-focus-test.ts（或 npm run test:timeline-focus）
 */
import {
  computeFocusView,
  findActiveThinkingGroupIndex,
  isGroupHiddenInFocus,
  isToolExempt,
  shouldRenderGroup,
  type TimelineGroup,
} from "../src/renderer/src/components/chat/timelineFocus";
import type { MessageBlock, ToolStatus } from "../src/renderer/src/types";

let passed = 0;
let failed = 0;

function assert(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}

function thinking(seq: number, withThinking = true): TimelineGroup {
  return {
    kind: "thinking",
    key: `thinking-seg-${seq}`,
    blocks: [{ type: withThinking ? "thinking" : "text", text: `t${seq}` }],
  };
}

function tool(status: ToolStatus, dangerous = false): TimelineGroup {
  return {
    kind: "other",
    index: 0,
    key: `other-tool-${status}-${dangerous}`,
    block: {
      type: "tool",
      toolCall: { id: `id-${status}`, tool: "bash", summary: "bash", status, dangerous },
    },
  };
}

function other(block: MessageBlock): TimelineGroup {
  return { kind: "other", index: 0, key: `other-${block.type}`, block };
}

const calloutGroup = (): TimelineGroup =>
  other({ type: "callout", variant: "warning", text: "note" });
const planGroup = (): TimelineGroup =>
  other({ type: "plan", title: "plan", items: [{ id: "1", text: "x", done: false }] });

function main(): void {
  console.log("[timeline-focus-test]");

  // ---- 1. 流式只见最新思考 -------------------------------------------------
  const g1 = [thinking(0), tool("success"), thinking(1)];
  const f1 = computeFocusView(g1, 2, true);
  assert(f1.liveIdx === 2, "活跃段为末段 thinking");
  assert(f1.hiddenThinking === 1, "旧 thinking 段进历史（计数 1）");
  assert(f1.hiddenTools === 1, "success 工具进历史（计数 1）");
  assert(shouldRenderGroup(g1[0], 0, true, f1.liveIdx) === false, "旧 thinking 不渲染");
  assert(shouldRenderGroup(g1[2], 2, true, f1.liveIdx) === true, "最新 thinking 渲染");
  assert(shouldRenderGroup(g1[1], 1, true, f1.liveIdx) === false, "success 工具不渲染");
  assert(isGroupHiddenInFocus(g1[1]) === true, "success 工具 isHidden=true");

  // ---- 2. 豁免：仅运行/审批；所有终态（成功/失败/拒绝）都应折叠 --------
  for (const st of ["running", "pending_approval"] as ToolStatus[]) {
    const tg = tool(st);
    assert(isGroupHiddenInFocus(tg) === false, `${st} 工具豁免可见`);
    assert(isToolExempt(st, false) === true, `isToolExempt(${st})`);
  }
  for (const st of ["success", "error", "denied"] as ToolStatus[]) {
    const tg = tool(st);
    assert(isGroupHiddenInFocus(tg) === true, `${st} 工具结束后进历史`);
    assert(isToolExempt(st, false) === false, `isToolExempt(${st})=false`);
  }
  const dangSuccess = tool("success", true);
  assert(isGroupHiddenInFocus(dangSuccess) === true, "dangerous(success) 完成后进历史");
  assert(isToolExempt("success", true) === false, "isToolExempt(success,dangerous)=false");
  assert(isToolExempt("error", true) === false, "dangerous(error) 失败后进历史");
  assert(isToolExempt(undefined, true) === true, "dangerous 未结束时保持可见");
  assert(isToolExempt("success", false) === false, "普通 success 不豁免");
  // 豁免项在聚焦视图中仍渲染
  const g2 = [thinking(0), tool("running")];
  const f2 = computeFocusView(g2, -1, true);
  assert(shouldRenderGroup(g2[1], 1, true, f2.liveIdx) === true, "running 工具聚焦中渲染");

  // ---- 3. 用户展开历史 → 完整时间线 ----------------------------------------
  assert(shouldRenderGroup(g1[0], 0, false, -1) === true, "展开历史后旧思考渲染");
  assert(shouldRenderGroup(g1[1], 1, false, -1) === true, "展开历史后 success 工具渲染");
  assert(shouldRenderGroup(g1[2], 2, false, -1) === true, "展开历史后末段渲染");

  // ---- 4. 非流式保持原行为 --------------------------------------------------
  const f3 = computeFocusView(g1, 0, false);
  assert(f3.liveIdx === -1 && f3.hiddenThinking === 0 && f3.hiddenTools === 0, "非流式无聚焦计数");
  assert(shouldRenderGroup(g1[0], 0, false, -1) === true, "非流式全部渲染");

  // ---- 5. 活跃段 = 最后一段含 thinking 块的段；过程文本不抢占 -----------------
  // 有真正 thinking 段时，过程文本段（无 thinking 块）不抢占活跃段
  const g4 = [thinking(0), thinking(1, false)];
  const active4 = findActiveThinkingGroupIndex(g4, true, false);
  assert(active4 === 0, "过程文本段不抢占活跃段");
  const f4 = computeFocusView(g4, active4, true);
  assert(f4.liveIdx === 0, "活跃段为真正 thinking 段");
  assert(shouldRenderGroup(g4[0], 0, true, f4.liveIdx) === true, "thinking 段渲染");
  assert(shouldRenderGroup(g4[1], 1, true, f4.liveIdx) === false, "过程文本段聚焦隐藏");
  // 完全无 thinking 块时，末段过程文本兜底为活跃段（不空窗）
  const g4b = [tool("running"), thinking(1, false)];
  assert(findActiveThinkingGroupIndex(g4b, true, false) === -1, "无 thinking 块时无活跃段");
  const f4b = computeFocusView(g4b, -1, true);
  assert(f4b.liveIdx === 1, "无 thinking 块时末段过程文本兜底活跃");
  assert(shouldRenderGroup(g4b[1], 1, true, f4b.liveIdx) === true, "末段文本渲染");

  // ---- 6. 思考后被工具打断 → 思考段保持活跃（不因末组变 tool 收起） ----------
  const g5 = [thinking(0), tool("running")];
  assert(findActiveThinkingGroupIndex(g5, true, false) === 0, "工具打断后思考段仍活跃");
  const f5 = computeFocusView(g5, 0, true);
  assert(f5.liveIdx === 0, "工具打断后活跃段仍为思考段");
  assert(shouldRenderGroup(g5[0], 0, true, f5.liveIdx) === true, "思考段仍渲染");
  assert(shouldRenderGroup(g5[1], 1, true, f5.liveIdx) === true, "running 工具仍可见");

  // ---- 7. 非 thinking/tool 块永不隐藏 --------------------------------------
  const g6 = [calloutGroup(), thinking(0), planGroup(), thinking(1)];
  const f6 = computeFocusView(g6, 3, true);
  assert(shouldRenderGroup(g6[0], 0, true, f6.liveIdx) === true, "callout 不隐藏");
  assert(shouldRenderGroup(g6[2], 2, true, f6.liveIdx) === true, "plan 不隐藏");
  assert(f6.liveIdx === 3, "末段 thinking 为活跃段");
  assert(f6.hiddenThinking === 1 && f6.hiddenTools === 0, "计数只含旧思考段（不含 callout/plan）");
  assert(isGroupHiddenInFocus(g6[0]) === false, "callout isHidden=false");
  assert(isGroupHiddenInFocus(g6[2]) === false, "plan isHidden=false");

  // ---- 8. 空输入 ------------------------------------------------------------
  const f7 = computeFocusView([], 0, true);
  assert(f7.liveIdx === -1 && f7.hiddenThinking === 0 && f7.hiddenTools === 0, "空组安全");

  // ---- 9. findActiveThinkingGroupIndex：活跃段规则（展开/收起时机） ----------
  // 历史消息（非流式）/ 空组 → 无活跃段（历史深度思考默认折叠）
  assert(findActiveThinkingGroupIndex(g1, false, false) === -1, "非流式无活跃段");
  assert(findActiveThinkingGroupIndex([], true, false) === -1, "空组无活跃段");
  // 已开始最终回复 → 无活跃段（最终回答开始即收起思考）
  assert(findActiveThinkingGroupIndex([thinking(0)], true, true) === -1, "最终回复开始后无活跃段");
  // 思考 → 多个工具：思考段保持活跃（工具打断不收起）
  const g9 = [thinking(0), tool("running"), tool("success")];
  assert(findActiveThinkingGroupIndex(g9, true, false) === 0, "多工具打断后思考段仍活跃");
  // 新的思考段开始 → 活跃段前移（旧段失活收起，最新一段展开）
  const g10 = [thinking(0), tool("success"), thinking(1)];
  assert(findActiveThinkingGroupIndex(g10, true, false) === 2, "新思考段开始后活跃段前移");
  // 工具后的过程文本（无 thinking 块）不改变活跃段
  const g11 = [thinking(0), tool("success"), thinking(1, false)];
  assert(findActiveThinkingGroupIndex(g11, true, false) === 0, "工具后过程文本不改变活跃段");
  // 纯文本段（无 thinking 块）→ 无活跃段
  assert(
    findActiveThinkingGroupIndex([thinking(0, false)], true, false) === -1,
    "纯文本段无活跃段",
  );

  console.log(`\n[timeline-focus-test] ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main();
