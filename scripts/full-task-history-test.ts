import assert from "node:assert/strict";
import { mergeFullTaskHistory, readFullTaskHistory } from "../src/renderer/src/lib/fullTaskHistory";
import type { ChatMessage } from "../src/renderer/src/types";
import type { TaskHistoryDto } from "../src/shared/agent-ipc";

const row = (id: number): ChatMessage => ({ id: `durable-${id}`, role: "user", createdAt: id, blocks: [{ type: "text", text: String(id) }] });
const page = (ids: number[], before?: number, historyId = "history-a"): TaskHistoryDto => ({
  page: { historyId, before }, messages: ids.map(id => ({ id: `durable-${id}`, role: "user", text: String(id), createdAt: id })),
});

async function main(): Promise<void> {
  const requests: number[] = [];
  const older = await readFullTaskHistory({ before: 401, historyId: "history-a", isCurrent: () => true,
    load: async before => { requests.push(before); return before === 401 ? page([201, 400], 201) : page([1, 200]); },
  });
  assert.deepEqual(requests, [401, 201]);
  assert.deepEqual(older?.map(message => message.id), [1, 200, 201, 400].map(id => row(id).id));

  let archive = Array.from({ length: 600 }, (_, i) => row(i + 1));
  const updated = { ...row(600), blocks: [{ type: "text" as const, text: "updated" }] };
  archive = mergeFullTaskHistory(archive, [...Array.from({ length: 199 }, (_, i) => row(i + 402)), updated, row(601)]);
  assert.equal(archive.length, 601, "bounded 200-entry live snapshots must never evict displayed history");
  assert.equal(archive[599], updated, "live content replaces the existing row without reordering it");
  assert.equal(archive[0].id, "durable-1");

  const live = { ...row(4), id: "durable-live-run", presentationKey: "generation-1", streaming: true };
  const persisted = { ...row(5), presentationKey: "generation-1", streaming: false };
  assert.deepEqual(mergeFullTaskHistory([row(1), live], [persisted, row(6)]), [row(1), persisted, row(6)]);
  const anotherPersisted = { ...row(6), presentationKey: persisted.presentationKey };
  assert.deepEqual(mergeFullTaskHistory([persisted], [anotherPersisted]), [persisted, anotherPersisted],
    "distinct durable entries must not collapse merely because they share a presentation key");
  assert.deepEqual(mergeFullTaskHistory([row(1), live], [row(1), { ...persisted, presentationKey: "generation-1-aborted" }]),
    [row(1), { ...persisted, presentationKey: "generation-1-aborted" }], "cancelled transient shells must not remain streaming forever");
  const pending = { ...row(1), id: "optimistic-1", inputRequestId: "input-1" };
  const accepted = { ...row(2), inputRequestId: "input-1" };
  assert.deepEqual(mergeFullTaskHistory([pending], [accepted]), [accepted]);

  let current = true;
  let resolve!: (value: TaskHistoryDto) => void;
  const stale = readFullTaskHistory({ before: 100, historyId: "history-a", isCurrent: () => current,
    load: () => new Promise(done => { resolve = done; }),
  });
  current = false; // task switch, history branch change, epoch replacement or unmount
  resolve(page([1]));
  assert.equal(await stale, undefined, "stale in-flight history must never publish");
  await assert.rejects(readFullTaskHistory({ before: 100, historyId: "history-a", isCurrent: () => true,
    load: async () => page([1], undefined, "history-b"),
  }), /历史记录已变化/);
  await assert.rejects(readFullTaskHistory({ before: 100, historyId: "history-a", isCurrent: () => true,
    load: async () => page([1], 100),
  }), /游标/);
  await assert.rejects(readFullTaskHistory({ before: 100, historyId: "history-a", isCurrent: () => true,
    load: async () => ({ messages: [], historyError: "disk unavailable" }),
  }), /disk unavailable/);
  assert.deepEqual(await readFullTaskHistory({ before: undefined, historyId: "history-a", isCurrent: () => true,
    load: async () => { throw new Error("must not request history for a complete conversation"); },
  }), []);
  console.log("full-task-history: all assertions passed");
}
void main();
