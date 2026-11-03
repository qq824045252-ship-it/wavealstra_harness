import assert from "node:assert/strict";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryOrganizationService, type OrganizationModelInput } from "../src/main/memory/MemoryOrganizationService";
import type { MemoryOrganizationRun } from "../src/shared/memory-organization";
import type { MemoryRecordDto } from "../src/shared/memory-kernel";

type InputRecord = Pick<MemoryRecordDto, "id" | "kind" | "title" | "content">;
const model = { id: "fixture", provider: "fixture", maxTokens: 8192 } as OrganizationModelInput["model"];
const response = (body: unknown) => ({ content: [{ type: "text", text: JSON.stringify(body) }], stopReason: "stop" });
const dbs: AppDatabase[] = [];
function fixture() {
  const db = new AppDatabase(":memory:"); dbs.push(db);
  const memory = new MemoryService(db, { semantic: false });
  const service = new MemoryOrganizationService(db, memory);
  return { db, memory, service };
}
function input(answer: (records: InputRecord[]) => unknown | Promise<unknown>): OrganizationModelInput {
  return { model, isEnabled: () => true, modelRuntime: { completeSimple: async (_: unknown, request: { messages: Array<{ content: string }> }) => {
    const records = JSON.parse(request.messages[0]!.content).memories as InputRecord[];
    return response(await answer(records));
  } } as unknown as OrganizationModelInput["modelRuntime"] };
}
function unchanged(records: InputRecord[]) { return { reviewedIds: records.map(r => r.id), proposals: [] }; }
function merge(records: InputRecord[]) {
  const matches = records.filter(r => r.content.includes("共同事实"));
  return { reviewedIds: records.map(r => r.id), proposals: matches.length > 1 ? [{ action: "merge", sourceIds: matches.map(r => r.id), reason: "同一开发约束重复表达", after: [{ kind: matches[0]!.kind, title: "开发约束", content: "共同事实：先完善示波器，再开发频谱仪。" }] }] : [] };
}
async function settle(service: MemoryOrganizationService): Promise<MemoryOrganizationRun> {
  for (let i = 0; i < 300; i++) {
    await new Promise(resolve => setTimeout(resolve, 2));
    const run = service.latest();
    if (run && run.status !== "scanning") return run;
  }
  throw new Error("organization did not settle");
}
function fact(memory: MemoryService, title: string, content = "共同事实：先完善示波器，再开发频谱仪。", extra: Partial<Parameters<MemoryService["create"]>[0]> = {}) {
  return memory.create({ kind: "decision", title, content, scopeType: "global", sourceType: "manual", ...extra });
}

async function main() {
  {
    const { db, memory, service } = fixture();
    db.createSpace({ id: "space-a", name: "Space A" });
    db.createSpace({ id: "space-b", name: "Space B" });
    db.createSpace({ id: "archive", name: "Archive" });
    db.connection.prepare("UPDATE spaces SET archived=1 WHERE id='archive'").run();
    db.upsertTask({ id: "task", title: "Task", spaceId: "space-a", updatedAt: Date.now() });
    db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at,archived,resource_budget_chars) VALUES ('project','Project',1,1,0,128000)").run();
    for (let i = 0; i < 525; i++) fact(memory, `独立事实 ${i}`, `独立参数编号 ${i}，保持原值，不应自动合并。`, { kind: "fact" });
    const first = fact(memory, "开发顺序第一种说法", undefined, { evidence: [{ evidenceKind: "conversation", refId: "turn-a", excerpt: "先完善示波器" }] });
    const second = fact(memory, "开发顺序重复强调", undefined, { evidence: [{ evidenceKind: "conversation", refId: "turn-b", excerpt: "暂缓频谱仪" }] });
    fact(memory, "空间 A", undefined, { scopeType: "workspace", scopeId: "space-a" });
    fact(memory, "空间 B", undefined, { scopeType: "workspace", scopeId: "space-b" });
    fact(memory, "项目", undefined, { scopeType: "project", scopeId: "project" });
    fact(memory, "任务", undefined, { scopeType: "task", scopeId: "task" });
    const archived = fact(memory, "归档空间", undefined, { scopeType: "workspace", scopeId: "archive" });
    const shared = fact(memory, "共享记忆", undefined, { scopeType: "workspace", scopeId: "space-a" });
    memory.promote(shared.id, "global");
    let calls = 0;
    const reviewed = new Set<string>();
    service.start(input(records => { calls++; records.forEach(r => { assert(!reviewed.has(r.id), "each record is inspected exactly once, not once per inherited task"); reviewed.add(r.id); }); return merge(records); }));
    const preview = await settle(service);
    assert.equal(preview.status, "ready", preview.error);
    assert.equal(preview.total, 533);
    assert.equal(preview.scanned, 532);
    assert.equal(preview.skipped, 1);
    assert(!reviewed.has(archived.id));
    assert.equal(preview.proposals.length, 1, "identical text across distinct scopes cannot be merged");
    assert.equal(memory.get(first.id)?.status, "active", "preview never changes facts");
    assert.equal(memory.get(second.id)?.status, "active");
    const original = [memory.get(first.id)!, memory.get(second.id)!];
    service.apply(preview.id);
    const active = [memory.get(first.id)!, memory.get(second.id)!].filter(r => r.status === "active");
    assert.equal(active.length, 1);
    assert.equal(active[0]!.evidence.length, 2, "merged record retains both sources");
    assert.equal(memory.repository.listScopeRecords("global").filter(r => [first.id, second.id].includes(r.id)).length, 1, "old duplicates leave recall");
    assert.equal(memory.get(shared.id)!.scopes.length, 2, "visibility bindings remain intact");
    const beforeCalls = calls;
    service.start(input(records => { calls++; return merge(records); }));
    const secondRun = await settle(service);
    assert.equal(secondRun.status, "ready");
    assert.equal(secondRun.proposals.length, 0);
    assert.equal(calls, beforeCalls, "unchanged second run does not rewrite or pay for another full scan");
    service.undo(preview.id);
    for (const old of original) {
      const restored = memory.get(old.id)!;
      assert.equal(restored.status, "active"); assert.equal(restored.title, old.title); assert.equal(restored.content, old.content);
      assert.deepEqual(restored.evidence, old.evidence);
      assert(memory.history(old.id).some(r => r.changeReason === `undo-organization:${preview.id}`));
    }
    console.log("PASS full-store coverage beyond 500, all scopes, exact bindings, archived exclusions, preview/apply/undo, evidence and idempotence");
  }
  {
    const { memory, service } = fixture();
    const old = fact(memory, "很长很长的决定标题", "先完成示波器功能。未来再开发频谱仪。请始终保留这个顺序。");
    service.start(input(records => ({ reviewedIds: records.map(r => r.id), proposals: [{ action: "rewrite", sourceIds: [old.id], reason: "精简叙述", after: [{ kind: "decision", title: "开发顺序", content: "先完成示波器，再开发频谱仪。" }] }] })));
    const preview = await settle(service);
    memory.update({ id: old.id, content: "用户刚刚决定并行开发。" });
    assert.throws(() => service.apply(preview.id), /已改变/);
    assert.equal(memory.get(old.id)?.content, "用户刚刚决定并行开发。");
    service.dismiss(preview.id);
    console.log("PASS stale previews never overwrite newer facts");
  }
  {
    const { memory, service } = fixture();
    const a = fact(memory, "一次确认"); fact(memory, "第二次确认");
    service.start(input(merge));
    const preview = await settle(service); service.apply(preview.id);
    memory.update({ id: a.id, title: "后来修改" });
    assert.throws(() => service.undo(preview.id), /新的修改/);
    assert.equal(memory.get(a.id)?.title, "后来修改");
    console.log("PASS undo protects subsequent edits");
  }
  {
    const { db, memory, service } = fixture();
    for (let i = 0; i < 30; i++) fact(memory, `记忆 ${i}`, `独立内容 ${i}`);
    let calls = 0;
    service.start(input(records => { calls++; if (calls === 2) return { reviewedIds: [], proposals: [] }; return unchanged(records); }));
    const paused = await settle(service);
    assert.equal(paused.status, "paused"); assert.equal(paused.completedBatches, 1); assert.equal(paused.scanned, 24);
    const reopened = new MemoryOrganizationService(db, memory);
    const seen = new Set<string>();
    reopened.start(input(records => { records.forEach(r => seen.add(r.id)); return unchanged(records); }), paused.id);
    const done = await settle(reopened);
    assert.equal(done.status, "ready"); assert.equal(done.scanned, 30); assert.equal(seen.size, 6);
    console.log("PASS incomplete model response pauses, saved progress resumes without redoing completed batches");
  }
  {
    const { memory, service } = fixture();
    const old = fact(memory, "来源");
    let resolve!: (value: unknown) => void;
    service.start(input(() => new Promise(r => { resolve = r; })));
    memory.forget(old.id);
    resolve({ reviewedIds: [old.id], proposals: [] });
    await new Promise(r => setTimeout(r, 10));
    assert.equal(service.latest(), null, "forget removes persisted previews/backups and in-flight result cannot resurrect them");
    console.log("PASS hard-forget revokes saved and in-flight organization data");
  }
  {
    const { memory, service } = fixture();
    const old = fact(memory, "拆分的两个独立要求", "必须保留串口设置。必须支持保存截图。");
    service.start(input(records => ({ reviewedIds: records.map(r => r.id), proposals: [{ action: "split", sourceIds: [old.id], reason: "两个独立要求", after: [
      { kind: "decision", title: "串口设置", content: "必须保留串口设置。" }, { kind: "decision", title: "截图", content: "必须支持保存截图。" },
    ] }] })));
    const preview = await settle(service); assert.equal(preview.status, "ready", preview.error); service.apply(preview.id);
    assert.equal(memory.stats().active, 2);
    service.undo(preview.id); assert.equal(memory.stats().active, 1); assert.equal(memory.get(old.id)?.content, "必须保留串口设置。必须支持保存截图。");
    console.log("PASS independent facts can be split and reverted without losing the original");
  }
  {
    const { memory, service } = fixture();
    const a = fact(memory, "预算第一份", "预算是八万元。"); const b = fact(memory, "预算第二份", "预算是十万元。");
    service.start(input(records => ({ reviewedIds: records.map(r => r.id), proposals: [{ action: "conflict", sourceIds: [a.id, b.id], reason: "无法确认预算是否改变", after: [] }] })));
    const preview = await settle(service); assert.equal(preview.status, "ready");
    assert.throws(() => service.apply(preview.id), /没有可应用/);
    assert.equal(memory.stats().active, 2);
    console.log("PASS conflicts remain explicit and never become invented conclusions");
  }
  for (const invalid of ["foreign", "overlap", "retire", "longer"]) {
    const { memory, service } = fixture(); const a = fact(memory, "明确约束", "不改变范围。", { explicit: true });
    service.start(input(records => {
      const p = { action: invalid === "retire" ? "retire" : "rewrite", sourceIds: [invalid === "foreign" ? "foreign-id" : a.id], reason: "测试无效响应", after: invalid === "retire" ? [] : [{ kind: "decision", title: "约束", content: invalid === "longer" ? "扩展成大量来源没有的内容".repeat(10) : "不改变范围。" }] };
      return { reviewedIds: records.map(r => r.id), proposals: invalid === "overlap" ? [p, p] : [p] };
    }));
    const result = await settle(service); assert.equal(result.status, "paused", invalid); assert.equal(memory.get(a.id)?.status, "active");
  }
  console.log("PASS foreign IDs, overlapping edits, unauthorized retirement and expanded summaries are rejected");
  {
    const { memory, service } = fixture();
    const a = fact(memory, "原始要求一", "详细记录的长期要求一，保留所有原始内容。");
    const b = fact(memory, "原始要求二", "详细记录的长期要求二，保留所有原始内容。");
    const revisions = [memory.history(a.id).length, memory.history(b.id).length];
    service.start(input(records => ({ reviewedIds: records.map(r => r.id), proposals: [
      { action: "rewrite", sourceIds: [a.id], reason: "精简", after: [{ kind: "decision", title: "要求一", content: "长期要求一。" }] },
      { action: "rewrite", sourceIds: [b.id], reason: "精简", after: [{ kind: "decision", title: "password", content: "blocked" }] },
    ] })));
    const preview = await settle(service); assert.equal(preview.status, "ready");
    assert.throws(() => service.apply(preview.id), /敏感/);
    assert.equal(memory.get(a.id)?.title, a.title); assert.equal(memory.get(b.id)?.title, b.title);
    assert.deepEqual([memory.history(a.id).length, memory.history(b.id).length], revisions);
    assert.equal(service.latest()?.status, "ready");
    console.log("PASS failed batch application rolls back every fact and revision atomically");
  }
  {
    const { memory, service } = fixture(); fact(memory, "可暂停任务");
    let sawAbort = false;
    const config: OrganizationModelInput = { model, isEnabled: () => true, modelRuntime: { completeSimple: async (_m: unknown, _r: unknown, options: { signal: AbortSignal }) => new Promise((_resolve, reject) => {
      options.signal.addEventListener("abort", () => { sawAbort = true; reject(new Error("aborted")); }, { once: true });
    }) } as unknown as OrganizationModelInput["modelRuntime"] };
    const started = service.start(config); service.pause(started.id);
    await new Promise(resolve => setTimeout(resolve, 10));
    assert(sawAbort); assert.equal(service.latest()?.status, "paused"); assert.equal(service.latest()?.scanned, 0);
    service.start(input(unchanged), started.id);
    assert.equal((await settle(service)).status, "ready");
    console.log("PASS pause aborts the model request and resumes safely");
  }
  {
    const { memory, service } = fixture();
    const old = fact(memory, "用户旧要求", "重复事实内容", { importance: 0 });
    for (let i = 0; i < 90; i++) fact(memory, `无关要求 ${i}`, `无关事实 ${i}`, { importance: 3 });
    const result = await memory.extractAndStore({ taskId: "transient", userText: "重复事实内容", assistantText: "", model,
      modelRuntime: { completeSimple: async () => response({ candidates: [{ kind: "decision", title: "同一事实的新标题", content: "重复事实内容", scopeType: "global", operationHint: "create", confidence: 1, importance: 1, explicit: true, userEvidence: "重复事实内容" }] }) } as unknown as OrganizationModelInput["modelRuntime"], isEnabled: () => true });
    assert.equal(result.committedCount, 0); assert.equal(memory.stats().total, 91); assert(memory.get(old.id));
    assert(service.latest() === null);
    console.log("PASS incremental extraction detects exact duplicates beyond the previous 80-record window");
  }
  console.log("Memory organization tests passed.");
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => { for (const db of dbs) db.close(); });
