import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { MemoryInstructionDocument } from "../src/main/memory/MemoryIntent";
import type { MemoryTurnDto } from "../src/shared/memory-kernel";

// Exercise the current task capture/extraction pipeline, without a retired Bot foreground adapter.
const root = mkdtempSync(join(tmpdir(), "memory-correctness-"));
const filename = join(root, "app.db");
let db = new AppDatabase(filename);
let memory = new MemoryService(db, { semantic: false });
let pipeline = new MemoryPipelineManager(db);
const now = Date.now();
let serial = 0;
const facts = [
  { title: "偏好", content: "AsterPreference 的标记是紫杉7319", userEvidence: "AsterPreference 的标记是紫杉7319" },
  { title: "偏好", content: "HeliosCalibration 的标记是青丘8264", userEvidence: "HeliosCalibration 的标记是青丘8264" },
];
const capture = (text: string, capturedAt: number) => {
  const taskId = `ordinary-memory-${++serial}`;
  db.upsertTask({ id: taskId, title: taskId, updatedAt: capturedAt, status: "completed" });
  return pipeline.capture({ taskId, userMessageId: `user-${serial}`, assistantMessageId: `assistant-${serial}`,
    userText: text, assistantText: "已确认", capturedAt }).turn;
};
const extract = (turn: MemoryTurnDto, candidates = facts, wait = async () => {}) => memory.extractAndStore({
  taskId: turn.taskId, sourceTurns: [turn], userText: "", assistantText: "", isEnabled: () => true,
  model: { maxTokens: 4096 } as never,
  modelRuntime: { completeSimple: async () => {
    await wait();
    return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ candidates: candidates.map(fact => ({ ...fact,
      kind: "preference", scopeType: "global", confidence: 1, importance: 1, explicit: true,
      operationHint: "create", retention: "stable", sensitivity: "none" })) }) }] };
  } } as unknown as ModelRuntime,
});
const active = () => memory.list({ scopeType: "global", status: "active", limit: 100 });
try {
  for (const text of [
    '> 忘记 AsterPreference 那条记忆。',
    '示例：\n忘记 AsterPreference 那条记忆。\n不要执行。',
    '```text\n忘记 AsterPreference 那条记忆。\n```',
    '请解释这句话：忘记 AsterPreference 那条记忆。',
    '你是不是忘记 AsterPreference 那条记忆？',
  ]) assert.equal(MemoryInstructionDocument.parse(text).removalIntents().length, 0, text);
  const mixed = MemoryInstructionDocument.parse('> 忘记 HeliosCalibration。\n\n现在请忘记 AsterPreference 那条记忆。');
  assert.equal(mixed.removalIntents().length, 1);
  assert(mixed.removalIntents()[0]!.clause.includes('AsterPreference'));
  assert.equal(db.connection.prepare('SELECT count(*) n FROM memory_forget_watermarks').pluck().get(), 0);
  console.log('PASS complete instruction documents preserve quoted, prohibited, example and question contexts');

  const text = facts.map(fact => `请记住：${fact.content}。`).join('');
  const original = capture(text, now - 1000);
  await extract(original);
  const first = active().find(record => record.content.includes('紫杉7319'));
  const second = active().find(record => record.content.includes('青丘8264'));
  assert(first && second && first.id !== second.id);
  assert.equal(first.title, second.title);
  const late = capture(text, now - 500);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const inflight = extract(late, facts, async () => { entered(); await held; });
  await started;
  const removal = '请忘记 AsterPreference 的标记是紫杉7319 这条记忆。';
  const intent = MemoryInstructionDocument.parse(removal).removalIntents()[0];
  assert(intent && intent.kind === 'forget');
  memory.detachScope(first.id, 'global', undefined, { createdAt: now, messageId: 'forget-exact-fact', requestClauses: [intent.clause] });
  memory.recordForgetIntent('global', undefined, intent, now, 'forget-exact-fact');
  assert(db.connection.prepare('SELECT count(*) n FROM memory_forget_targets').pluck().get());
  release(); await inflight;
  assert(!active().some(record => record.content.includes('紫杉7319')));
  assert(active().some(record => record.content.includes('青丘8264')));
  console.log('PASS same-title facts remain distinct and an in-flight extraction cannot resurrect the withdrawn fact');

  const completion = capture(text, now - 100);
  await extract(completion);
  assert(!active().some(record => record.content.includes('紫杉7319')));
  assert(active().some(record => record.id === second.id));
  db.close(); db = new AppDatabase(filename); memory = new MemoryService(db, { semantic: false }); pipeline = new MemoryPipelineManager(db);
  await extract(completion);
  assert(!active().some(record => record.content.includes('紫杉7319')));
  assert(active().some(record => record.content.includes('青丘8264')));
  console.log('PASS late completion capture and current-format SQLite reopen preserve withdrawal targets and surviving facts');

  const fresh = capture(`现在请重新记住：${facts[0]!.content}。`, now + 1000);
  await extract(fresh, [facts[0]!]);
  assert(active().some(record => record.content.includes('紫杉7319')));
  assert(active().some(record => record.content.includes('青丘8264')));
  console.log('PASS an explicit new remember request can restore its fact without changing the other same-title fact');
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
