/**
 * message-lifecycle-test.ts — Chat 消息生命周期 invariant 测试（P0 修复验证）。
 *
 * 核心 invariant：assistant 已生成的正文（finalBlocks）不因工具调用/中断/取消/错误而消失；
 * tool_start 只冻结 prose 段（不迁移不清空）；terminal 状态（normal/cancel/error/abort）
 * 均保留已收到文本；无正文时不制造空白块。
 *
 * 场景：① thinking→text→cancel；② thinking→text→tool_start→cancel；
 * ③ text→tool_start→text→cancel；④ 多轮 tool；⑤ normal assistant_end；
 * ⑥ error/abort；⑦ 无正文 cancel 不产生空白块；⑧ 首轮反馈与结束收束。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPatchToMessage,
  freezeFinalTextSegment,
  nonEmptyFinalTextBlocks,
  upsertTextBlock,
} from "@/store/appStore";
import type { ChatMessage } from "@/types";
import { mapPiEventToPatches } from "../src/shared/pi-event-mapper";

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

function baseMessage(): ChatMessage {
  return {
    id: "m1",
    role: "assistant",
    blocks: [],
    finalBlocks: [],
    streaming: false,
    createdAt: 1,
  };
}

type Patch = Parameters<typeof applyPatchToMessage>[1];

const text = (delta: string, fin = true): Patch => ({ type: "text_delta", taskId: "t", messageId: "m1", delta, final: fin });
const thinking = (delta: string): Patch => ({ type: "thinking_delta", taskId: "t", messageId: "m1", delta });
const toolStart = (id: string, name = "read"): Patch => ({
  type: "tool_start",
  taskId: "t",
  messageId: "m1",
  toolCallId: id,
  tool: name,
  summary: name,
  status: "running",
});
const end = (): Patch => ({ type: "assistant_end", taskId: "t", messageId: "m1", durationMs: 100 });

const finalText = (m: ChatMessage): string =>
  nonEmptyFinalTextBlocks(m.finalBlocks)
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n");

console.log("== Provider 消息边界：截断围栏不能污染自动重试 ==");
{
  const ctx = { taskId: "t", messageId: "m1", startedAt: 1 };
  const start = () => mapPiEventToPatches({ type: "message_start", message: { role: "assistant" } } as Parameters<typeof mapPiEventToPatches>[0], ctx);
  let m = baseMessage();
  for (const patch of start()) m = applyPatchToMessage(m, patch);
  assert(nonEmptyFinalTextBlocks(m.finalBlocks).length === 0, "首条 provider 消息不制造空白正文");
  const interrupted = "```html\n<html><body><svg><g class=\"anim-";
  m = applyPatchToMessage(m, text(interrupted));
  assert(mapPiEventToPatches({ type: "agent_end", messages: [], willRetry: true }, ctx).length === 0,
    "自动重试继续同一个 UI 回合");
  for (const patch of [...start(), ...start()]) m = applyPatchToMessage(m, patch);
  const retried = "```svg\n<svg></svg>\n```\n\n### 验证方式\n\n**结论**：正常。";
  m = applyPatchToMessage(m, text(retried.slice(0, 10)));
  m = applyPatchToMessage(m, text(retried.slice(10)));
  const blocks = nonEmptyFinalTextBlocks(m.finalBlocks);
  assert(blocks.length === 2, "重试创建独立正文块，重复 start 不创建多余块");
  assert(blocks[0]?.type === "text" && blocks[0].text === interrupted, "保留失败尝试的完整原文");
  assert(blocks[1]?.type === "text" && blocks[1].text === retried, "重试增量只拼接在自己的 Markdown 块中");
  assert(mapPiEventToPatches({ type: "message_start", message: { role: "user", content: "继续" } } as Parameters<typeof mapPiEventToPatches>[0], ctx).length === 0,
    "用户消息不产生 assistant 正文边界");
}

console.log("== Thinking snapshot 对账：Pi 最终消息真源补齐 reasoning ==");
{
  type MapperEvent = Parameters<typeof mapPiEventToPatches>[0];
  const assistant = (thinkingText: string) => ({
    role: "assistant",
    content: thinkingText ? [{ type: "thinking", thinking: thinkingText }] : [],
  });
  const startEvent = { type: "message_start", message: assistant("") } as MapperEvent;
  const endEvent = (thinkingText: string) => ({ type: "message_end", message: assistant(thinkingText) }) as MapperEvent;
  const updateEvent = (eventType: "thinking_delta" | "thinking_end" | "text_delta", snapshot: string, delta?: string) => ({
    type: "message_update",
    message: assistant(snapshot),
    assistantMessageEvent: eventType === "thinking_delta"
      ? { type: "thinking_delta", delta: delta ?? snapshot }
      : eventType === "text_delta"
        ? { type: "text_delta", delta: delta ?? "" }
        : { type: "thinking_end" },
  }) as MapperEvent;

  const ctx = { taskId: "t", messageId: "m1", startedAt: 1 };
  mapPiEventToPatches(startEvent, ctx);
  const missingAll = mapPiEventToPatches(endEvent("完整思考"), ctx);
  assert(
    missingAll.length === 1 && missingAll[0]?.type === "thinking_delta" && missingAll[0].delta === "完整思考",
    "没有 thinking_delta 时，message_end 从 Pi 最终 snapshot 补回完整思考",
  );

  mapPiEventToPatches(startEvent, ctx);
  const streamed = mapPiEventToPatches(updateEvent("thinking_delta", "先想", "先想"), ctx);
  const suffix = mapPiEventToPatches(endEvent("先想清楚"), ctx);
  assert(
    streamed.length === 1 && streamed[0]?.type === "thinking_delta" && streamed[0].delta === "先想" &&
      suffix.length === 1 && suffix[0]?.type === "thinking_delta" && suffix[0].delta === "清楚",
    "只收到部分 thinking_delta 时，message_end 仅补缺失后缀",
  );

  mapPiEventToPatches(startEvent, ctx);
  const full = mapPiEventToPatches(updateEvent("thinking_delta", "不会重复", "不会重复"), ctx);
  const duplicate = mapPiEventToPatches(endEvent("不会重复"), ctx);
  assert(
    full.length === 1 && duplicate.length === 0,
    "thinking_delta 已完整到达时，message_end 不重复追加",
  );

  mapPiEventToPatches(startEvent, ctx);
  const textWithLateThinking = mapPiEventToPatches(updateEvent("text_delta", "正文开始时才出现的思考", "正文"), ctx);
  assert(
    textWithLateThinking.length === 1 && textWithLateThinking[0]?.type === "text_delta" &&
      textWithLateThinking[0].delta === "正文",
    "正文 delta 不扫描或提前重放 thinking snapshot",
  );
  const recoveredAtBoundary = mapPiEventToPatches(endEvent("正文开始时才出现的思考"), ctx);
  assert(recoveredAtBoundary.length === 1 && recoveredAtBoundary[0]?.type === "thinking_delta",
    "未发送的 snapshot 仅在结束边界兜底");

  mapPiEventToPatches(startEvent, ctx);
  mapPiEventToPatches(updateEvent("thinking_delta", "", "先"), ctx);
  const lagging = mapPiEventToPatches(updateEvent("thinking_delta", "先", "想"), ctx);
  assert(lagging.length === 1 && lagging[0]?.type === "thinking_delta" && lagging[0].delta === "想",
    "上一轮回归：滞后的非空 snapshot 不能吞掉新的 native delta");
  assert(mapPiEventToPatches(endEvent("先想"), ctx).length === 0, "滞后 snapshot 后最终对账不重复");
  mapPiEventToPatches(startEvent, ctx);
  const empty = mapPiEventToPatches(updateEvent("thinking_delta", "", ""), ctx);
  assert(empty.length === 0, "空 thinking delta 不制造可见空块");

  mapPiEventToPatches(startEvent, ctx);
  for (const patch of mapPiEventToPatches(updateEvent("thinking_delta", "同一段", "同一段"), ctx)) void patch;
  mapPiEventToPatches(startEvent, ctx);
  const nextMessage = mapPiEventToPatches(endEvent("同一段"), ctx);
  assert(nextMessage.length === 1, "下一条 provider 消息重新计数，不能误判同文为重复");

  mapPiEventToPatches(startEvent, ctx);
  const endOnly = mapPiEventToPatches(updateEvent("thinking_end", "仅 end 事件带完整思考"), ctx);
  const afterEndOnly = mapPiEventToPatches(endEvent("仅 end 事件带完整思考"), ctx);
  assert(
    endOnly.length === 1 && endOnly[0]?.type === "thinking_delta" &&
      endOnly[0].delta === "仅 end 事件带完整思考" && afterEndOnly.length === 0,
    "provider 只在 thinking_end snapshot 暴露 reasoning 时也能即时补齐且不重复",
  );

  let m = baseMessage();
  mapPiEventToPatches(startEvent, ctx);
  for (const patch of mapPiEventToPatches(endEvent("最终可见思考"), ctx)) m = applyPatchToMessage(m, patch);
  assert(
    m.blocks.some((block) => block.type === "thinking" && block.text === "最终可见思考"),
    "补齐 patch 能进入 ExecutionTimeline 的 thinking block",
  );
}

console.log("== 纯函数：upsertTextBlock / freezeFinalTextSegment / nonEmptyFinalTextBlocks ==");
{
  const b1 = upsertTextBlock([], "text", "A");
  assert(b1.length === 1 && b1[0].text === "A", "upsert 空数组 → 新 block");
  const b2 = upsertTextBlock(b1, "text", "B");
  assert(b2.length === 1 && b2[0].text === "AB", "同类型追加");
  const b3 = upsertTextBlock(b2, "thinking", "t");
  assert(b3.length === 2, "不同类型开新 block");
  const f1 = freezeFinalTextSegment([{ type: "text", text: "A" }]);
  assert(f1?.length === 2 && f1[1].type === "text" && f1[1].text === "", "冻结：末尾追加空 text 段");
  const f2 = freezeFinalTextSegment(f1);
  assert(f2 === f1, "已冻结（末尾空段）不重复冻结");
  const f3 = freezeFinalTextSegment(undefined);
  assert(f3 === undefined, "无正文不制造段");
  assert(nonEmptyFinalTextBlocks(f1).length === 1, "渲染过滤空段");
  assert(nonEmptyFinalTextBlocks(undefined).length === 0, "无 finalBlocks → 空");
}

console.log("== 场景①：thinking→text→cancel（正文保留） ==");
{
  let m = baseMessage();
  m = applyPatchToMessage(m, thinking("先想想"));
  m = applyPatchToMessage(m, text("已生成的正文"));
  m = applyPatchToMessage(m, end()); // cancel 也会走 assistant_end
  assert(finalText(m) === "已生成的正文", `cancel 后正文保留（${JSON.stringify(finalText(m))}）`);
  assert(m.streaming === false, "terminal 状态 streaming=false");
  // thinking 完整保留在 blocks（时间线），不因 cancel 丢失
  const th = m.blocks.filter((b) => b.type === "thinking").map((b) => b.text).join("");
  assert(th === "先想想", `cancel 后 thinking 保留（${JSON.stringify(th)}）`);
}

console.log("== 场景②：thinking→text→tool_start→cancel（正文不被移走） ==");
{
  let m = baseMessage();
  m = applyPatchToMessage(m, thinking("想"));
  m = applyPatchToMessage(m, text("正文A"));
  m = applyPatchToMessage(m, toolStart("tc1"));
  m = applyPatchToMessage(m, end());
  assert(finalText(m) === "正文A", `tool_start 后 cancel：正文仍在正文区（${JSON.stringify(finalText(m))}）`);
  assert(m.blocks.some((b) => b.type === "tool"), "tool 在时间线 blocks");
  assert(m.blocks.every((b) => b.type !== "text"), "时间线不含正文 text（无重复）");
}

console.log("== 场景③：text→tool_start→text→cancel（工具后正文开新段） ==");
{
  let m = baseMessage();
  m = applyPatchToMessage(m, text("正文A"));
  m = applyPatchToMessage(m, toolStart("tc1"));
  m = applyPatchToMessage(m, text("正文B"));
  m = applyPatchToMessage(m, end());
  const fb = nonEmptyFinalTextBlocks(m.finalBlocks);
  assert(fb.length === 2, `两个 prose 段（${fb.length}）`);
  assert(finalText(m) === "正文A\n正文B", `A+B 均在正文区（${JSON.stringify(finalText(m))}）`);
  assert(m.blocks.every((b) => b.type !== "text"), "时间线无重复正文");
}

console.log("== 场景④：多轮 tool call（正文不丢不重复） ==");
{
  let m = baseMessage();
  m = applyPatchToMessage(m, text("A"));
  m = applyPatchToMessage(m, toolStart("t1"));
  m = applyPatchToMessage(m, text("B"));
  m = applyPatchToMessage(m, toolStart("t2"));
  m = applyPatchToMessage(m, toolStart("t2")); // 重复 tool_start（幂等）
  m = applyPatchToMessage(m, text("C"));
  m = applyPatchToMessage(m, end());
  assert(finalText(m) === "A\nB\nC", `多工具轮正文完整（${JSON.stringify(finalText(m))}）`);
  assert(m.blocks.filter((b) => b.type === "tool").length === 2, "tool 不重复");
}

console.log("== 场景⑤：normal assistant_end ==");
{
  let m = baseMessage();
  m = applyPatchToMessage(m, text("完整正文"));
  m = applyPatchToMessage(m, end());
  assert(finalText(m) === "完整正文" && m.streaming === false, "normal end 正文正确");
}

console.log("== 场景⑥：error/abort（保留正文 + 错误提示） ==");
{
  let m = baseMessage();
  m = applyPatchToMessage(m, text("部分正文"));
  m = applyPatchToMessage(m, { type: "assistant_end", taskId: "t", messageId: "m1", error: "provider 500" });
  assert(finalText(m) === "部分正文\n错误：provider 500", `error 后已收正文保留 + 追加错误块（${JSON.stringify(finalText(m))}）`);
  // 幂等：重复 error patch 不重复追加
  const mErr2 = applyPatchToMessage(m, { type: "assistant_end", taskId: "t", messageId: "m1", error: "provider 500" });
  assert(finalText(mErr2) === finalText(m), "重复 error patch 幂等（不重复追加）");
  // 无正文时 error → 只显示错误块（既有行为）
  let m2 = baseMessage();
  m2 = applyPatchToMessage(m2, { type: "assistant_end", taskId: "t", messageId: "m1", error: "aborted" });
  assert(finalText(m2) === "错误：aborted", "无正文 error 只补错误块");
}

console.log("== 场景⑥b：text→tool→error（工具中断 + 错误） ==");
{
  let m = baseMessage();
  m = applyPatchToMessage(m, text("正文A"));
  m = applyPatchToMessage(m, toolStart("tc1"));
  m = applyPatchToMessage(m, { type: "assistant_end", taskId: "t", messageId: "m1", error: "tool crashed" });
  assert(finalText(m) === "正文A\n错误：tool crashed", `工具中断后 error：正文 + 错误块（${JSON.stringify(finalText(m))}）`);
  assert(m.blocks.some((b) => b.type === "tool"), "tool 仍在时间线");
  // 模型自身已写错误文本（文本相同）→ 不重复追加（非重复保护）
  let m3 = baseMessage();
  m3 = applyPatchToMessage(m3, text("正文"));
  m3 = applyPatchToMessage(m3, text("错误：already said"));
  m3 = applyPatchToMessage(m3, { type: "assistant_end", taskId: "t", messageId: "m1", error: "already said" });
  const fb3 = nonEmptyFinalTextBlocks(m3.finalBlocks);
  assert(fb3.length === 2 && fb3[1].text === "错误：already said", "错误文本相同 → 不重复追加");
}

console.log("== 场景⑦：无正文 cancel 不制造空白块 ==");
{
  let m = baseMessage();
  m = applyPatchToMessage(m, toolStart("tc1"));
  m = applyPatchToMessage(m, end());
  assert((m.finalBlocks ?? []).length === 0, `无正文 tool_start 不 push 空段（${(m.finalBlocks ?? []).length}）`);
  assert(nonEmptyFinalTextBlocks(m.finalBlocks).length === 0, "渲染过滤后无块");
  // 空 delta 防御
  let m3 = baseMessage();
  m3 = applyPatchToMessage(m3, text("", true));
  assert((m3.finalBlocks ?? []).length === 0, "空 text_delta 不制造块");
}

console.log("== 场景⑧：首轮反馈与结束收束结构 ==");
{
  const timeline = readFileSync(
    join(process.cwd(), "src", "renderer", "src", "components", "chat", "ExecutionTimeline.tsx"),
    "utf8",
  );
  const css = readFileSync(
    join(process.cwd(), "src", "renderer", "src", "styles", "global.css"),
    "utf8",
  );
  assert(
    timeline.includes('message.blocks.length === 0') &&
      timeline.includes("正在准备回复…") &&
      timeline.includes("!message.streaming || hasFinalOutput"),
    "空 streaming shell 显示准备状态，正文出现后立即退出",
  );
  assert(
    timeline.includes("timeline-body-shell") && timeline.includes("bodyMounted"),
    "时间线结束时保留 DOM 完成平滑收束",
  );
  assert(
    timeline.includes("const liveText = blocks.reduce") &&
      timeline.includes('className="timeline-text"') &&
      timeline.includes("normalizeThinkingText(liveText)") &&
      css.includes(".assistant-reasoning.streaming .assistant-reasoning-content") &&
      css.includes("white-space: normal"),
    "思考内容合并为单一直接文本流，不按增量 block 逐行渲染",
  );
  const normalizeMatch = timeline.match(
    /function normalizeThinkingText\(text: string\): string \{[\s\S]*?\r?\n\}/,
  );
  assert(Boolean(normalizeMatch), "找到实际 Thinking 文本规范化函数");
  if (normalizeMatch) {
    const normalizeSource = normalizeMatch[0].replace(
      "function normalizeThinkingText(text: string): string",
      "function normalizeThinkingText(text)",
    );
    const normalizeThinkingText = Function(`${normalizeSource}; return normalizeThinkingText;`)() as (
      text: string,
    ) => string;
    const clineDeepSeekFixture = "Now\n\n let\n\n me\n\n update\n\n the\n小屋\n\n memory\n\n.";
    assert(
      normalizeThinkingText(clineDeepSeekFixture) === "Now let me update the 小屋 memory ." &&
        !/[\r\n]/.test(normalizeThinkingText(clineDeepSeekFixture)),
      "Cline/DeepSeek 双换行 reasoning token 被折叠为自然横排文本",
    );
  }
  assert(
    css.includes(".timeline-body-shell.is-closed") && css.includes("grid-template-rows: 0fr"),
    "时间线收束使用高度过渡而非瞬时卸载",
  );
  assert(
    !css.includes("transition: padding-bottom") &&
      css.includes(".message-list--turn-anchor:not(.message-list--virtual)"),
    "首轮底部锚点空间在置顶测量前一次到位",
  );
}

console.log(`\n结果: passed=${passed} failed=${failed}`);
process.exit(failed > 0 ? 1 : 0);
