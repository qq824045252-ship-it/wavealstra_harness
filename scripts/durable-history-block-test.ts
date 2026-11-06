import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";

const directory = await mkdtemp(join(tmpdir(), "durable-history-block-"));
const cwd = join(directory, "workspace");
await mkdir(cwd);
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const runtime = await DurableBotRuntime.open({ directory: join(directory, "state"), cwd, models: createModels(), toolMode: "native", instructions: () => "", onSnapshot: () => {} });
try {
  for (let batch = 0; batch < 12; batch++) {
    await runtime.conversation.commit(async tx => {
      for (let i = 0; i < 20; i++) {
        const n = batch * 20 + i;
        await tx.appendEntry(runtime.conversation.id, { kind: "pi.user", model: [{ role: "user", content: `question ${n}`, timestamp: n * 3 + 1 }] });
        const assistant: AssistantMessage = { role: "assistant", content: [{ type: "text", text: `answer ${n}` }, { type: "toolCall", id: `tool-${n}`, name: "fixture", arguments: {} }], stopReason: "toolUse", api: "openai-completions", model: "fixture", provider: "fixture", timestamp: n * 3 + 2, usage };
        await tx.appendEntry(runtime.conversation.id, { kind: "pi.assistant", model: [assistant] });
        await tx.appendEntry(runtime.conversation.id, { kind: "pi.tool", model: [{ role: "toolResult", toolCallId: `tool-${n}`, toolName: "fixture", content: [{ type: "text", text: "done" }], isError: false, timestamp: n * 3 + 3 }] });
        for (let hidden = 0; hidden < (n === 80 ? 12 : 1); hidden++) {
          await tx.appendEntry(runtime.conversation.id, { kind: "mybuddy.context-import", model: [{ role: "user", content: "hidden", timestamp: n * 3 + 3 }] });
        }
      }
    }, context);
    await runtime.refresh();
  }
  const snapshot = runtime.snapshot;
  assert(snapshot.historyBefore !== undefined);
  const liveIds = new Set(snapshot.messages.map(message => message.id));
  let before: number | undefined = snapshot.historyBefore;
  let messages = [...snapshot.messages];
  let blocks = 0;
  while (before !== undefined) {
    const block = await runtime.loadHistoryBlock(before, 7);
    assert(block.messages.length > 0);
    assert.equal(block.epoch, snapshot.epoch);
    assert(block.before === undefined || block.before < before);
    assert(block.messages.every(message => !liveIds.has(message.id)));
    assert.deepEqual(Object.keys(block).sort(), ["before", "epoch", "messages"]);
    messages = [...block.messages, ...messages];
    before = block.before;
    assert(++blocks < 500);
  }
  assert.equal(new Set(messages.map(message => message.id)).size, messages.length);
  assert.deepEqual(messages.map(message => message.text), Array.from({ length: 240 }, (_, n) => [`question ${n}`, `answer ${n}`]).flat());
  assert(messages.filter(message => message.role === "assistant").every(message => message.tools?.[0]?.status === "success"));
  assert.equal(runtime.snapshot, snapshot);
  console.log(`PASS ${blocks} history blocks, complete ordered transcript, tool results and live snapshot isolation`);
} finally {
  await runtime.close();
  await rm(directory, { recursive: true, force: true });
}
