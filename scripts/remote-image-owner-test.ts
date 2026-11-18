import { strict as assert } from "node:assert";
import { resolveImageOwnerId } from "../app/remote/src/lib/imageOwner";

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

// 7) 归属落在 user 消息上：用户气泡不渲染图片，必须改挂到这一轮的回复（时刻最近的前一条 assistant）
{
  const withTimes: Msg[] = [
    { id: "durable-96", role: "assistant", createdAt: 1_000, tools: [] },
    { id: "durable-97", role: "user", createdAt: 2_000, tools: [] },
    { id: "durable-98", role: "assistant", createdAt: 3_000, tools: [] },
  ];
  assert.equal(resolveImageOwnerId(img({ createdByMessageId: "durable-97", createdAt: 3_500 }), withTimes), "durable-98",
    "图片在 durable-97 这一轮产生 → 归到这一轮的回复，而不是上一轮");
  assert.equal(resolveImageOwnerId(img({ createdByMessageId: "durable-97" }), withTimes), "durable-96",
    "旧服务端没有 createdAt 时才退化为序号口径");
}

// 8) producer id 属于另一套 id 空间（durable-live-* / durable-tool-*）：按创建时刻归位
{
  const settled: Msg[] = [
    { id: "durable-13", role: "assistant", createdAt: 1_000, tools: [] },
    { id: "durable-65", role: "user", createdAt: 2_000, tools: [] },
    { id: "durable-68", role: "assistant", createdAt: 3_000, tools: [] },
  ];
  assert.equal(resolveImageOwnerId(img({ createdByMessageId: "durable-live-t1", createdAt: 3_200 }), settled), "durable-68");
  assert.equal(resolveImageOwnerId(img({ createdByMessageId: "durable-tool-abc", createdAt: 1_500 }), settled), "durable-13");
  assert.equal(resolveImageOwnerId(img({ createdAt: 900 }), settled), null, "比所有回复都早 → 没有可挂的回复");
  assert.equal(resolveImageOwnerId(img({ createdByMessageId: "durable-live-t1" }), settled), null,
    "既没有可用时刻也没有序号 → 交给「其他图片」，不得瞎挂");
}

// 同一张图重复解析必须稳定（不随调用次序漂移）
const sample = img({ createdByToolCallId: "call_00_JgTnBGaqrgPYHwpIrbxu1316/2", createdByMessageId: "durable-112" });
const runs = [resolveImageOwnerId(sample, messages), resolveImageOwnerId(sample, [...messages]), resolveImageOwnerId(sample, messages)];
assert.deepEqual(runs, ["durable-126", "durable-126", "durable-126"]);

console.log("image ownership tests passed");
