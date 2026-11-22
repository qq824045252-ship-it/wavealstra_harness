import assert from "node:assert/strict";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { DOTS_TASK_ID } from "../src/shared/dots";

const db = new AppDatabase(":memory:");
try {
  db.openDots();
  db.upsertTask({ id: "parallel-owner", title: "Private conversation", updatedAt: 1 });
  const memory = new MemoryService(db, { semantic: false });
  const save = (source: string, role: "user" | "agent", content: string, task = DOTS_TASK_ID) =>
    memory.create({ title: role === "user" ? "Conversation note" : "Assistant response", content, kind: "fact",
      sourceType: role, scopeType: "task", scopeId: task, evidence: [{ evidenceKind: "conversation", refId: source }] });
  const quote = save("workshop", "user", "I glued thin cork sheets to the inside of the dome.");
  save("workshop", "agent", "Your answer explains how you insulated the observatory on your boat.");
  const privateQuote = save("workshop", "user", "I insulated the observatory on my boat using private materials.", "parallel-owner");
  for (let i = 0; i < 12; i++) save("catalog", "agent",
    "The catalog lists insulation materials for an observatory on a boat, entry " + i + ".");
  const query = "How did I insulate the observatory on my boat?";
  const read = (text: string, limit: number) => memory.searchHybrid({ taskId: DOTS_TASK_ID, query: text, limit });
  let hits = await read(query, 5);
  assert(hits.some(hit => hit.memory.id === quote.id), "a user's short answer travels with its topical source despite different words");
  assert(!hits.some(hit => hit.memory.id === privateQuote.id), "same source reference cannot expand authorization");
  const checked = memory.search({ taskId: DOTS_TASK_ID, query, limit: 5 });
  assert(checked.some(hit => hit.memory.id === quote.id), "synchronous and asynchronous scoped lookup both find the user's account");
  memory.forget(quote.id);
  assert(!(await read(query, 5)).some(hit => hit.memory.id === quote.id), "an adjacent passage cannot reintroduce forgotten evidence");
  const first = save("late-summer", "user", "I recorded two unusual pulsar signals beside the east ridge.");
  const second = save("midwinter", "user", "I recorded three unusual pulsar signals beside the west ridge.");
  for (let i = 0; i < 7; i++) save("late-summer", "agent",
    "The unusual pulsar signals I recorded beside the east ridge were discussed in entry " + i);
  hits = await read("What unusual pulsar signals did I record?", 4);
  assert(hits.some(hit => hit.memory.id === first.id) && hits.some(hit => hit.memory.id === second.id),
    "dense repetition in one source cannot consume the slots of both relevant first-person sources");
  const chinese = save("维修对话", "user", "我用一块蓝色的陶瓷片做标记。");
  save("维修对话", "agent", "这就说明了你如何区分左舷的两根绞盘线。");
  for (let i = 0; i < 8; i++) save("手册对话", "agent", "左舷的绞盘线有多种区分方式，手册列出方案 " + i);
  assert((await read("我如何区分左舷的绞盘线？", 5)).some(hit => hit.memory.id === chinese.id),
    "Chinese recall keeps the user's differently worded explanation");
  console.log("PASS Dots scoped recall of contextual user statements and distributed sources");
} finally {
  db.close();
}
