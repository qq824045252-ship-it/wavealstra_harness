/**
 * 远程端「更早历史」前插窗口：
 *   1. appendOlderBlocks —— 前插顺序 / epoch 校验 / durable-<entryId> 去重
 *   2. prependScrollTop  —— 前插后的滚动补偿（.chat-timeline 有 overflow-anchor: none）
 *   3. isPrependOnly     —— 只有「列表头变了」才算前插
 *   4. 与 buildRemoteTimeline 合起来：前插块 + 实时窗口仍是一条时间正序、无重复轮次的时间轴
 *
 * Run: npx esbuild scripts/remote-history-window-test.ts --bundle --platform=node --format=cjs \
 *        --alias:@mybuddy/shared=./shared/src --outfile=out/tests/remote-history-window-test.cjs \
 *      && node out/tests/remote-history-window-test.cjs
 */
import assert from "node:assert/strict";
import type { RemoteHistoryMessage } from "../shared/src/remote-contract";
import {
  appendOlderBlocks,
  isPrependOnly,
  prependScrollTop,
  type OlderHistoryBlock,
} from "../app/remote/src/lib/historyWindow";
import { buildRemoteTimeline } from "../app/remote/src/store/remoteTimeline";

const T0 = 1_760_000_000_000;

function msg(id: string, role: "user" | "assistant", createdAt: number, text = id): RemoteHistoryMessage {
  return { id, role, text, createdAt };
}

function block(epoch: string, messages: RemoteHistoryMessage[]): OlderHistoryBlock {
  return { taskId: "t", epoch, messages };
}

function idsOf(blocks: OlderHistoryBlock[]): string[] {
  return blocks.flatMap((item) => item.messages.map((message) => message.id));
}

// 1. 前插：数组永远「新 → 旧」，flat() 出来就是时间正序。
{
  const newer = block("e1", [msg("durable-3", "user", T0 + 2000), msg("durable-4", "assistant", T0 + 3000)]);
  const older = block("e1", [msg("durable-1", "user", T0), msg("durable-2", "assistant", T0 + 1000)]);
  const first = appendOlderBlocks([], newer);
  assert.equal(first.length, 1, "空列表也要接受第一块");
  const both = appendOlderBlocks(first, older);
  assert.deepEqual(both.map((item) => item.messages[0].id), ["durable-1", "durable-3"], "新块必须在数组首部");
  assert.deepEqual(idsOf(both), ["durable-1", "durable-2", "durable-3", "durable-4"], "flat() 必须是时间正序");
  assert.equal(first.length, 1, "不得改动入参（纯函数）");
}

// 2. epoch 不一致 = 会话被重建/切了分支：旧块整组丢弃，只留新世代这一块。
{
  const old = appendOlderBlocks([], block("e1", [msg("durable-3", "user", T0)]));
  const rebuilt = appendOlderBlocks(old, block("e2", [msg("durable-1", "user", T0 + 10)]));
  assert.deepEqual(idsOf(rebuilt), ["durable-1"], "跨世代的块不能混进同一条时间轴");
  assert.equal(rebuilt[0].epoch, "e2");
}

// 3. 相邻两页重叠（块内 context-import 被过滤后可能出现）：按 durable-<entryId> 去重，不渲染两遍。
{
  const loaded = appendOlderBlocks([], block("e1", [
    msg("durable-5", "user", T0 + 4000),
    msg("durable-6", "assistant", T0 + 5000),
  ]));
  const overlapping = appendOlderBlocks(loaded, block("e1", [
    msg("durable-3", "user", T0 + 2000),
    msg("durable-5", "user", T0 + 4000),
  ]));
  assert.deepEqual(idsOf(overlapping), ["durable-3", "durable-5", "durable-6"], "重叠消息只保留一份");
  assert.notEqual(overlapping, loaded, "有新消息时必须返回新数组（调用方据此做滚动补偿）");
}

// 4. 整页都是重复（重复请求/服务端回退了游标）：原样返回同一引用，调用方据此跳过重渲染与滚动补偿。
{
  const loaded = appendOlderBlocks([], block("e1", [msg("durable-5", "user", T0)]));
  const again = appendOlderBlocks(loaded, block("e1", [msg("durable-5", "user", T0)]));
  assert.equal(again, loaded, "没有新消息时必须返回原引用");
}

// 5. 块内自身重复也不能渲染两遍。
{
  const once = appendOlderBlocks([], block("e1", [
    msg("durable-1", "user", T0),
    msg("durable-1", "user", T0),
  ]));
  assert.deepEqual(idsOf(once), ["durable-1"]);
}

// 6. 前插补偿：内容在上方长高多少，scrollTop 就加多少，视觉锚点不动。
{
  assert.equal(prependScrollTop(1200, 8000, 9000), 2200, "长高 1000 → scrollTop +1000");
  assert.equal(prependScrollTop(0, 5000, 6200), 1200, "原本贴在顶部：补偿后应该停在新块之后");
  assert.equal(prependScrollTop(500, 8000, 8000), 500, "高度没变就不动");
  assert.equal(prependScrollTop(500, 9000, 8000), 500, "内容反而变短时不许往回拉");
  assert.equal(prependScrollTop(Number.NaN, 9000, 9999), 0, "非法 scrollTop 归零");
  assert.equal(prependScrollTop(10, Number.NaN, 9999), 10, "非法高度当作没变");
}

// 7. isPrependOnly：只有「列表头换人」才算前插。
{
  assert.equal(isPrependOnly("durable-5", "durable-1"), true);
  assert.equal(isPrependOnly("durable-5", "durable-5"), false, "只在尾部追加不是前插");
  assert.equal(isPrependOnly(undefined, "durable-1"), false, "从空时间轴变成有内容不是前插补偿");
  assert.equal(isPrependOnly("durable-5", undefined), false);
}

// 8. 端到端：前插块 + 实时窗口 → buildRemoteTimeline 仍是一条时间正序、轮次不重复的时间轴。
{
  const older = block("e1", [msg("durable-1", "user", T0), msg("durable-2", "assistant", T0 + 1000)]);
  const windowMessages = [
    msg("durable-3", "user", T0 + 2000),
    msg("durable-4", "assistant", T0 + 3000),
  ];
  const blocks = appendOlderBlocks([], older);
  const flattened = [...blocks.flatMap((item) => item.messages), ...windowMessages];
  const timeline = buildRemoteTimeline(flattened, {});
  assert.deepEqual(timeline.map((message) => message.id),
    ["durable-1", "durable-2", "durable-3", "durable-4"], "前插块必须排在实时窗口之前");
  assert.equal(timeline.filter((message) => message.role === "user").length, 2, "轮次不重复、不丢");
  assert.equal(timeline.filter((message) => message.role === "assistant").length, 2);
}

// 9. 块边界切在一轮中间：块首是 assistant 时它没有更早的 owner，退化为「时间轴最前面」，不得丢失或错位到尾部。
{
  const boundary = block("e1", [msg("durable-6", "assistant", T0 + 5000)]);
  const windowMessages = [msg("durable-7", "user", T0 + 6000), msg("durable-8", "assistant", T0 + 7000)];
  const flattened = [...appendOlderBlocks([], boundary).flatMap((item) => item.messages), ...windowMessages];
  const timeline = buildRemoteTimeline(flattened, {});
  assert.deepEqual(timeline.map((message) => message.id), ["durable-6", "durable-7", "durable-8"]);
}

console.log("remote-history-window-test: ok");
