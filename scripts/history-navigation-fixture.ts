import assert from "node:assert/strict";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type AssistantMessage } from "@earendil-works/pi-ai";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { readDurableReadOnlyHistory, readDurableUserQuestions } from "../src/main/agent/durable/DurableReadOnlyHistory";

export async function verifyHistoryNavigation(root: string, cwd: string) {
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  for (const [name, rounds, hidden] of [["pure", 3000, 0], ["mixed", 1200, 18]] as const) {
    const directory = join(root, name), models = createModels();
    const options = { directory, cwd, models, toolMode: "native" as const, instructions: () => "", onSnapshot: () => {} };
    let runtime = await DurableBotRuntime.open(options);
    const ids: number[] = [];
    try {
      for (let batch = 0; batch < rounds; batch += 100) await runtime.conversation.commit(async tx => {
        for (let n = batch; n < Math.min(batch + 100, rounds); n++) {
          const user = await tx.appendEntry(runtime.conversation.id, { kind: "pi.user", model: [{ role: "user", content: `question ${n + 1}`, timestamp: n * 20 }] });
          ids.push(user.id);
          const answer: AssistantMessage = { role: "assistant", content: [{ type: "text", text: `answer ${n + 1}` }], stopReason: "stop", api: "openai-completions", provider: "fixture", model: "fixture", timestamp: n * 20 + 1, usage };
          await tx.appendEntry(runtime.conversation.id, { kind: "pi.assistant", model: [answer] });
          for (let i = 0; i < hidden; i++) await tx.appendEntry(runtime.conversation.id, { kind: i % 2 ? "mybuddy.context-import" : "pi.tool", model: [] });
        }
      }, context);
      const snapshot = await runtime.refresh();
      await runtime.close();
      const first = await readDurableReadOnlyHistory(options);
      assert.equal(first.durable?.historyId, snapshot.historyId);
      assert.notEqual(first.durable?.epoch, snapshot.epoch);
      assert(first.durable?.historyBefore);
      const older = await readDurableReadOnlyHistory({ ...options, beforeEntryId: first.durable.historyBefore });
      assert.equal(older.page?.historyId, snapshot.historyId, "independent viewers must accept the same persistent history");
      assert.notEqual(older.durable?.epoch, first.durable.epoch, "runtime stream epochs remain independent");
      assert(older.messages.length > 0);
      assert(older.page?.before === undefined || older.page.before < first.durable.historyBefore);

      runtime = await DurableBotRuntime.open(options);
      const questions: Array<{ id: string; text: string }> = [];
      let nextBefore: number | undefined;
      let pages = 0;
      do {
        const page = await runtime.loadUserQuestions({ beforeEntryId: nextBefore, historyId: snapshot.historyId });
        assert(page.questions.length <= 200);
        assert(page.nextBefore === undefined || nextBefore === undefined || page.nextBefore < nextBefore);
        questions.unshift(...page.questions);
        nextBefore = page.nextBefore;
        assert(++pages < 100);
      } while (nextBefore !== undefined);
      assert.deepEqual(questions.map(q => q.text), Array.from({ length: rounds }, (_, n) => `question ${n + 1}`));
      assert.equal(new Set(questions.map(q => q.id)).size, rounds);
      const target = name === "pure" ? 2499 : 1099;
      assert.equal(questions[target].id, `durable-${ids[target]}`);
      const around = await runtime.loadHistoryWindow({ aroundEntryId: ids[target] });
      assert(around.messages.some(message => message.id === questions[target].id));
      assert(around.messages.length <= 50, "target positioning never loads intervening pages");
      const oldest = await runtime.loadHistoryWindow({ aroundEntryId: ids[0] });
      assert(oldest.messages.some(message => message.text === "question 1"));
      assert.equal(oldest.before, undefined);
      assert(oldest.after);
      const newer = await runtime.loadHistoryWindow({ afterEntryId: oldest.after });
      assert(newer.messages.every(message => !oldest.messages.some(old => old.id === message.id)));
      assert(around.before);
      const previous = await runtime.loadHistoryBlock(around.before);
      assert(previous.messages.every(message => !around.messages.some(old => old.id === message.id)));
      await assert.rejects(runtime.loadUserQuestions({ historyId: "stale" }), /历史分支/);
      const previousId = runtime.snapshot.historyId;
      await runtime.forkAt(ids[target]);
      await runtime.close();
      const branch = await readDurableReadOnlyHistory(options);
      assert.notEqual(branch.durable?.historyId, previousId, "regeneration/branch changes invalidate old cursors");
      await assert.rejects(readDurableUserQuestions({ ...options, query: { historyId: previousId } }), /历史分支/);
      console.log(`PASS ${name}: ${rounds} questions, ${pages} resumable pages, independent readers, direct first/middle anchors and branch fences`);
    } finally { await runtime.close(); }
  }
}
