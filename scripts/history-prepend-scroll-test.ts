import assert from "node:assert/strict";
import type { ChatMessage } from "../src/renderer/src/types";
import { isPrependOnly, mergeHistoryWindow, prependScrollTop } from "../src/renderer/src/lib/historyWindow";
import { shouldAdjustScrollCompensation } from "../src/renderer/src/lib/scrollFollow";

const row = (id: string, role: ChatMessage["role"] = "assistant"): ChatMessage => ({ id, role, blocks: [], createdAt: 0 });

// 前插补偿：上方长高多少，scrollTop 加多少；未长高/非法输入不产生位移。
const container = { scrollTop: 25, scrollHeight: 500 };
const previousTop = container.scrollTop;
const previousHeight = container.scrollHeight;
container.scrollHeight = 850;
container.scrollTop = prependScrollTop(previousTop, previousHeight, container.scrollHeight);
assert.equal(container.scrollTop, 375);
assert.equal(prependScrollTop(-10, -20, 30), 30);
assert.equal(prependScrollTop(12, 100, 50), 12);
assert.equal(prependScrollTop(Number.NaN, Infinity, 0), 0);

// 拼接语义：更旧的块在前（调用方保证），同 id 以实时窗口为准，实时行永远在最后。
const live = [row("durable-5", "user"), row("live")];
const merged = mergeHistoryWindow([[row("durable-1"), row("durable-3")], [row("durable-5")]], live);
assert.deepEqual(merged.map(message => message.id), ["durable-1", "durable-3", "durable-5", "live"]);
assert.equal(merged[2], live[0], "实时行与历史块同 id 时必须用实时版本");
assert.deepEqual(mergeHistoryWindow([], live).map(message => message.id), ["durable-5", "live"]);
assert.deepEqual(mergeHistoryWindow([], [row("live"), row("live")]).length, 1, "live 内部同 id 只留一条");

// 前插判定：只要原列表整体成为新列表的后缀就是前插，块里带用户消息也一样。
const before = [row("durable-7", "user"), row("durable-8"), row("live")];
assert.equal(isPrependOnly(before, [row("durable-5", "user"), row("durable-6"), ...before]), true, "更早历史块里含用户消息仍是前插");
assert.equal(isPrependOnly(before, [...before, row("durable-9")]), false, "尾部追加不是前插");
assert.equal(isPrependOnly(before, [before[0], row("durable-9"), ...before.slice(1)]), false, "中间插入不是前插");
assert.equal(isPrependOnly([], before), false, "首次恢复不是前插");
assert.equal(isPrependOnly(before, before.map((message, index) => index === 0 ? row("replaced", "user") : message)), false, "头部换人不是前插");

const context = { itemStart: 0, cachedSize: 20, delta: 5, scrollOffset: 100, scrollDirection: null, follow: false } as const;
assert.equal(shouldAdjustScrollCompensation(context), true);
assert.equal(shouldAdjustScrollCompensation({ ...context, compensationOwned: true }), false, "前插窗口由外部统一补偿，虚拟器不得再补一次");
console.log("PASS history prepend scroll, merging and compensation");
