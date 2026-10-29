import { strict as assert } from "node:assert";
import { resolveImageOwnerId } from "../app/remote/src/components/RemoteImages";

type Msg = Parameters<typeof resolveImageOwnerId>[1][number];
const messages: Msg[] = [
  { id: "durable-8", role: "user", tools: [] },
  { id: "durable-13", role: "assistant", tools: [{ id: "call_00_gD1" }, { id: "call_00_gD1:nested:bash:0" }] },
  { id: "durable-65", role: "user", tools: [] },
  { id: "durable-68", role: "assistant", tools: [{ id: "call_00_7atMlC0IUZtCsR9KCYDt8868" }, { id: "call_00_7atMlC0IUZtCsR9KCYDt8868:nested:computer_exec:0" }] },
  { id: "durable-126", role: "assistant", tools: [{ id: "call_00_JgTnBGaqrgPYHwpIrbxu1316" }] },
];
type Img = Parameters<typeof resolveImageOwnerId>[0];
const img = (over: Partial<Img>): Img => ({ id: "art-x", name: "x.png", kind: "image", version: 1, sources: [], ...over });

// 1) 工具调用 id（带 /序号 后缀）
assert.equal(resolveImageOwnerId(img({ createdByToolCallId: "call_00_7atMlC0IUZtCsR9KCYDt8868/1" }), messages), "durable-68");
// 2) 工具调用 id（nested 变体）也能回指
assert.equal(resolveImageOwnerId(img({ createdByToolCallId: "call_00_gD1:nested:bash:0" }), messages), "durable-13");
// 3) 没有工具 id：按消息 id 直接命中
assert.equal(resolveImageOwnerId(img({ createdByMessageId: "durable-126" }), messages), "durable-126");
// 4) 没有工具 id、消息 id 也不在列表里：退化为 durable 序号「最近的前一条 assistant」
assert.equal(resolveImageOwnerId(img({ createdByMessageId: "durable-110" }), messages), "durable-68");
// 5) 序号小于所有 assistant：没有「前一条 assistant」可挂，返回 null（进「其他图片」）
assert.equal(resolveImageOwnerId(img({ createdByMessageId: "durable-5" }), messages), null);
// 6) 完全认不出（另一套 id 空间）：不得瞎挂，返回 null 让调用方集中放置
assert.equal(resolveImageOwnerId(img({ createdByMessageId: "live-7" }), messages), null);
assert.equal(resolveImageOwnerId(img({}), messages), null);

// 同一张图重复解析必须稳定（不随调用次序漂移）
const sample = img({ createdByToolCallId: "call_00_JgTnBGaqrgPYHwpIrbxu1316/2", createdByMessageId: "durable-112" });
const runs = [resolveImageOwnerId(sample, messages), resolveImageOwnerId(sample, [...messages]), resolveImageOwnerId(sample, messages)];
assert.deepEqual(runs, ["durable-126", "durable-126", "durable-126"]);

console.log("image ownership tests passed");
