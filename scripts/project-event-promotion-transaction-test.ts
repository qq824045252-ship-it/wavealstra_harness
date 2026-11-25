import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { LibraryService } from "../src/main/library/LibraryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectEventIngestor } from "../src/main/project/ProjectEventIngestor";
import {
  ProjectEventPromoter,
  ProjectEventPromotionPartialStateError,
} from "../src/main/project/ProjectEventPromoter";
import type { ProjectEventPromotionDto } from "../src/shared/project-domain";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

const root = mkdtempSync(join(tmpdir(), "mybuddy-promotion-tx-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const nativeFlag = process.argv.indexOf("--native");
const runtimeAuditExecutable = nativeFlag < 0 ? undefined : locateRuntimeAudit(process.argv[nativeFlag + 1] ?? process.cwd());
if (nativeFlag >= 0) assert(runtimeAuditExecutable && existsSync(runtimeAuditExecutable), "Rust worker executable is required");
const db = new AppDatabase(join(root, "app.db"), { runtimeAuditExecutable });
const planRefreshes: string[] = [];
const memory = new MemoryService(db, { semantic: false });
const projects = new ProjectService(new ProjectRepository(db.connection, db.runtimeAuditReader), memory, id => planRefreshes.push(id));
const library = new LibraryService(db, { libraryRoot: join(root, "library") });
db.connection.prepare(`INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p1','P1',1,1),('p2','P2',1,1),('p3','P3',1,1),('p4','P4',1,1),('p5','P5',1,1)`).run();
let clock = 1000;
const ingestor = new ProjectEventIngestor(projects, { now: () => ++clock });
const promoter = new ProjectEventPromoter(projects, library, { now: () => ++clock });
const realInsertPromotion = projects.insertProjectEventPromotion.bind(projects);

function promotionCount(projectId: string, eventId: string, kind: string): number {
  return (db.connection.prepare(`SELECT COUNT(*) c FROM project_event_promotions WHERE project_id=? AND event_id=? AND target_kind=?`).get(projectId, eventId, kind) as { c: number }).c;
}

async function checkAtomicTodoPromotion(): Promise<void> {
  const native = db.runtimeAuditReader;
  if (native) assert.equal(await native.supportsProjectWrites("eventTodoPromotion"), true);
  const event = ingestor.ingest("p1", { source: "manual", kind: "note", title: "Concurrent event", ref: "atomic-race" });
  const countBefore = projects.listTodos("p1").length;
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => promoter.promoteAsync(event.id, {
    targetKind: "todo", todoTitle: `Plan request ${i + 1}`, todoDueAt: 1_800_000_000_000, todoPriority: "high",
  })));
  assert.equal(new Set(results.map(result => result.targetId)).size, 1);
  const created = results.find(result => !result.reused)!;
  assert.equal(results.filter(result => !result.reused).length, 1);
  assert.equal(promotionCount("p1", event.id, "todo"), 1);
  assert.equal(projects.listTodos("p1").length, countBefore + 1);
  assert.deepEqual(planRefreshes, ["p1"]);
  assert.deepEqual([created.promotion.eventId, created.promotion.eventTitle], [event.id, "Concurrent event"]);
  assert.deepEqual([(await projects.readTodo(created.targetId))?.dueAt, (await projects.readTodo(created.targetId))?.priority], [1_800_000_000_000, "high"]);

  const unchanged = projects.get("p1")!.updatedAt;
  const again = await promoter.promoteAsync(event.id, { targetKind: "todo" });
  assert.deepEqual([again.reused, again.targetMissing, again.targetId], [true, false, created.targetId]);
  assert.equal(projects.get("p1")?.updatedAt, unchanged);
  await projects.deleteTodoAsync(created.targetId);
  const missing = await promoter.promoteAsync(event.id, { targetKind: "todo", todoTitle: "Must not create a replacement" });
  assert.deepEqual([missing.reused, missing.targetMissing, missing.targetId], [true, true, created.targetId]);
  assert.equal(projects.listTodos("p1").length, countBefore);

  const failing = ingestor.ingest("p1", { source: "manual", kind: "note", title: "Link failure", ref: "atomic-link-failure" });
  const stampBeforeFailure = projects.get("p1")!.updatedAt;
  const refreshesBeforeFailure = planRefreshes.length;
  db.connection.exec(`CREATE TRIGGER fixture_reject_todo_promotion BEFORE INSERT ON project_event_promotions
    WHEN new.event_id='${failing.id}' BEGIN SELECT RAISE(ABORT,'fixture atomic link failure'); END;`);
  try {
    await assert.rejects(promoter.promoteAsync(failing.id, { targetKind: "todo", todoTitle: "Invisible after rollback" }), /fixture atomic link failure|项目数据写入失败/);
  } finally {
    db.connection.exec("DROP TRIGGER fixture_reject_todo_promotion");
  }
  assert.equal(projects.listTodos("p1").length, countBefore);
  assert.equal(promotionCount("p1", failing.id, "todo"), 0);
  assert.equal(projects.get("p1")?.updatedAt, stampBeforeFailure);
  assert.equal(planRefreshes.length, refreshesBeforeFailure);

  if (native) {
    const write = native.writeProject.bind(native);
    native.writeProject = async (...args) => {
      assert.equal(await write(...args), "changed");
      throw new Error("fixture lost reply after commit");
    };
    try {
      const recovered = await promoter.promoteAsync(failing.id, { targetKind: "todo", todoTitle: "Recovered commit" });
      assert.equal(recovered.reused, false);
      assert.equal((await projects.readTodo(recovered.targetId))?.title, "Recovered commit");
      assert.equal(promotionCount("p1", failing.id, "todo"), 1);
    } finally {
      native.writeProject = write;
    }

    const scoped = ingestor.ingest("p1", { source: "manual", kind: "note", title: "Scoped", ref: "atomic-agent-scope" });
    db.upsertTask({ id: "promotion-actor", title: "Promotion actor", updatedAt: 1, projectId: "p1" });
    native.writeProject = async (...args) => {
      db.upsertTask({ id: "promotion-actor", title: "Promotion actor", updatedAt: 2, projectId: "p2" });
      return write(...args);
    };
    try {
      await assert.rejects(promoter.promoteAsync(scoped.id, { targetKind: "todo", promotedBy: "agent", todoTitle: "Wrong project" },
        { taskId: "promotion-actor" }), /项目归属已变化/);
      assert.equal(promotionCount("p1", scoped.id, "todo"), 0);
      assert.equal(promotionCount("p2", scoped.id, "todo"), 0);
      assert(!projects.listTodos("p1").some(todo => todo.title === "Wrong project"));
    } finally {
      native.writeProject = write;
    }

    const evicted = ingestor.ingest("p1", { source: "manual", kind: "note", title: "Evicted before commit", ref: "atomic-eviction" });
    const retained = projects.listTodos("p1").length;
    native.writeProject = async (...args) => {
      db.connection.prepare("DELETE FROM project_events WHERE id=?").run(evicted.id);
      return write(...args);
    };
    try {
      await assert.rejects(promoter.promoteAsync(evicted.id, { targetKind: "todo", todoTitle: "No longer a source" }), /事件不存在/);
      assert.equal(promotionCount("p1", evicted.id, "todo"), 0);
      assert.equal(projects.listTodos("p1").length, retained);
    } finally {
      native.writeProject = write;
    }
  }
}

async function checkAtomicMemoryPromotion(): Promise<void> {
  const native = db.runtimeAuditReader;
  if (native) assert.equal(await native.supportsProjectWrites("memory"), true);
  db.upsertTask({ id: "memory-actor", title: "Memory task", updatedAt: 1, projectId: "p4" });
  const event = ingestor.ingest("p4", { source: "manual", kind: "note", title: "Calibration checked", ref: "memory-race" });
  const request = { targetKind: "memory", memoryKind: "decision", memoryTitle: "Calibration accepted",
    memoryContent: "Calibration stayed within tolerance.", memoryTags: ["lab"], memoryImportance: 2,
    promotedBy: "agent" } as const;
  const create = () => promoter.promoteAsync(event.id, { ...request, memoryTags: [...request.memoryTags] }, { taskId: "memory-actor" });
  const results = await Promise.all(Array.from({ length: 8 }, create));
  const created = results.find(result => !result.reused)!;
  assert.equal(results.filter(result => !result.reused).length, 1);
  assert.deepEqual([...new Set(results.map(result => result.targetId))], [created.targetId]);
  assert.equal(promotionCount("p4", event.id, "memory"), 1);
  assert.deepEqual(projects.listMemory("p4").map(item => [
    item.title, item.content, item.importance, item.tags, item.sourceType, item.sourceTaskId,
  ]), [["Calibration accepted", "Calibration stayed within tolerance.", 2, ["lab"], "agent", "memory-actor"]]);
  assert.deepEqual(memory.history(created.targetId).map(revision => [revision.revision, revision.title, revision.changedBy]),
    [[1, "Calibration accepted", "agent"]]);
  assert.deepEqual(memory.get(created.targetId)?.evidence.map(evidence => [evidence.evidenceKind, evidence.refId, evidence.refTitle]),
    [["project_event", event.id, "Calibration checked"]]);
  assert.deepEqual([created.promotion.eventTitle, created.promotion.promotedBy], ["Calibration checked", "agent"]);
  projects.deleteMemory({ projectId: "p4", id: created.targetId });
  const duplicate = await create();
  assert.deepEqual([duplicate.reused, duplicate.targetMissing, duplicate.targetId], [true, true, created.targetId]);
  assert.equal(projects.listMemory("p4").length, 0);

  const failed = ingestor.ingest("p4", { source: "manual", kind: "note", title: "Late link failure", ref: "memory-rollback" });
  const before = projects.get("p4")?.updatedAt;
  const beforeWithdrawals = db.connection.prepare("SELECT count(*) FROM memory_forget_targets").pluck().get();
  const promoteFailed = () => promoter.promoteAsync(failed.id, { targetKind: "memory", memoryKind: "fact", memoryTitle: "Temporary note" });
  db.connection.exec(`CREATE TRIGGER fixture_reject_memory_promotion BEFORE INSERT ON project_event_promotions
    WHEN new.event_id='${failed.id}' BEGIN SELECT RAISE(ABORT,'fixture memory link failure'); END`);
  try {
    await assert.rejects(promoteFailed(), /fixture memory link failure|项目数据写入失败/);
  } finally {
    db.connection.exec("DROP TRIGGER fixture_reject_memory_promotion");
  }
  assert.equal(projects.get("p4")?.updatedAt, before);
  assert.equal(projects.listMemory("p4").length, 0);
  assert.equal(promotionCount("p4", failed.id, "memory"), 0);
  assert.equal(db.connection.prepare("SELECT count(*) FROM memory_forget_targets").pluck().get(), beforeWithdrawals);

  const manual = () => projects.createMemoryAsync({
    projectId: "p4", kind: "fact", title: "Readings logged", content: "Technician logged the readings.",
    evidenceTaskId: "memory-actor",
  });
  if (native) {
    const write = native.writeProject.bind(native);
    native.writeProject = async (...args) => {
      assert.equal(await write(...args), "changed");
      throw new Error("fixture lost reply after memory promotion");
    };
    try {
      const saved = await promoteFailed();
      assert.equal(saved.reused, false);
      assert.equal(projects.getMemory("p4", saved.targetId)?.title, "Temporary note");
      assert.equal(promotionCount("p4", failed.id, "memory"), 1);
    } finally {
      native.writeProject = write;
    }

    const moved = ingestor.ingest("p4", { source: "manual", kind: "note", title: "Moved task", ref: "memory-moved-task" });
    let taskClock = 1;
    const bind = (projectId: string) =>
      db.upsertTask({ id: "memory-actor", title: "Memory task", updatedAt: ++taskClock, projectId });
    native.writeProject = async (...args) => {
      bind("p2");
      return write(...args);
    };
    try {
      await assert.rejects(promoter.promoteAsync(moved.id, {
        targetKind: "memory", memoryKind: "fact", memoryTitle: "Scope changed", promotedBy: "agent",
      }, { taskId: "memory-actor" }), /任务的项目归属已变化/);
      assert.equal(promotionCount("p4", moved.id, "memory"), 0);
      assert(!projects.listMemory("p4").some(item => item.title === "Scope changed"));
      bind("p4");
      await assert.rejects(manual(), /记忆证据已删除或项目归属已变化/);
      assert(!projects.listMemory("p4").some(item => item.title === "Readings logged"));
    } finally {
      native.writeProject = write;
      bind("p4");
    }
  }
  const saved = await manual();
  assert.equal(saved.title, "Readings logged");
  assert.deepEqual(memory.get(saved.id)?.evidence.map(item => [item.evidenceKind, item.refId]), [["task", "memory-actor"]]);
}

async function checkLibraryPromotion(): Promise<void> {
  const native = db.runtimeAuditReader;
  if (native) assert.equal(await native.supportsProjectWrites("eventLibraryPromotion"), true);
  const event = ingestor.ingest("p5", { source: "manual", kind: "note", title: "Calibration notes", ref: "library-concurrent" });
  const request = { targetKind: "library", libraryTitle: "Calibration page", libraryContent: "Instrument passed moonbridgefixture." } as const;
  const promote = () => promoter.promoteAsync(event.id, request);
  const before = readdirSync(library.root).sort();
  db.connection.exec(`CREATE TRIGGER fixture_reject_library_promotion BEFORE INSERT ON project_event_promotions
    WHEN new.event_id='${event.id}' BEGIN SELECT RAISE(ABORT,'fixture library link failure'); END`);
  try { await assert.rejects(promote(), /fixture library link failure/); }
  finally { db.connection.exec("DROP TRIGGER fixture_reject_library_promotion"); }
  assert.equal(library.listProjectSpaces("p5").length, 0);
  assert.equal(promotionCount("p5", event.id, "library"), 0);
  assert.deepEqual(readdirSync(library.root).sort(), before);
  assert.equal(library.search("moonbridgefixture").length, 0);

  const results = await Promise.all(Array.from({ length: 8 }, promote));
  const created = results.find(result => !result.reused)!;
  assert.equal(results.filter(result => !result.reused).length, 1);
  assert.deepEqual([...new Set(results.map(result => result.targetId))], [created.targetId]);
  assert.equal(promotionCount("p5", event.id, "library"), 1);
  const spaces = library.listProjectSpaces("p5");
  assert.deepEqual(spaces.map(space => space.name), ["P5·项目资料"]);
  const space = spaces[0]!;
  assert.deepEqual(library.listItems(space.id).map(item => item.id), [created.targetId]);
  assert.equal(library.readContent(created.targetId).content, "Instrument passed moonbridgefixture.");
  assert.equal(library.readVersion(created.targetId, 1), "# Calibration page\n\n");
  assert.deepEqual(library.search("moonbridgefixture").map(item => item.id), [created.targetId]);
  assert.deepEqual([created.promotion.eventTitle, created.targetTitle], ["Calibration notes", "Calibration page"]);

  const other = ingestor.ingest("p5", { source: "manual", kind: "note", title: "Existing project space", ref: "library-existing" });
  db.connection.prepare("UPDATE project_events SET payload_json='{' WHERE id=?").run(other.id);
  const saveOther = () => promoter.promoteAsync(other.id, { ...request, libraryTitle: "Second document", libraryContent: "Other original content." });
  if (native) {
    const write = native.promoteProjectEventToLibrary.bind(native);
    native.promoteProjectEventToLibrary = async input => {
      assert.equal((await write(input))?.status, "changed");
      return undefined;
    };
    try {
      const recovered = await saveOther();
      assert.equal(recovered.reused, false);
      assert.equal(library.getItem(recovered.targetId)?.spaceId, space.id);
      assert.equal(library.readContent(recovered.targetId).content, "Other original content.");
    } finally { native.promoteProjectEventToLibrary = write; }

    db.upsertTask({ id: "library-actor", title: "Document task", updatedAt: 1, projectId: "p5" });
    const moved = ingestor.ingest("p5", { source: "manual", kind: "note", title: "Reassigned task", ref: "library-reassigned" });
    native.promoteProjectEventToLibrary = async input => {
      db.upsertTask({ id: "library-actor", title: "Document task", updatedAt: 2, projectId: "p2" });
      return write(input);
    };
    try {
      await assert.rejects(promoter.promoteAsync(moved.id, { ...request, promotedBy: "agent" },
        { taskId: "library-actor" }), /任务的项目归属已变化/);
      assert.equal(promotionCount("p5", moved.id, "library"), 0);
      assert.equal(library.listItems(space.id).length, 2);
    } finally { native.promoteProjectEventToLibrary = write; }

    const operationId = randomUUID();
    const abandonedSpace = randomUUID();
    const itemId = randomUUID();
    const directory = join(library.root, abandonedSpace);
    mkdirSync(directory);
    const staged = join(directory, `.mybuddy-restore-${operationId}-${itemId}.tmp`);
    writeFileSync(staged, "Interrupted process wrote this file before committing.");
    linkSync(staged, join(directory, `${itemId}.md`));
    db.connection.prepare("INSERT INTO library_restore_files(root,operation_id,space_id,item_id,filename) VALUES (?,?,?,?,?)")
      .run(library.root, operationId, abandonedSpace, itemId, "Interrupted.md");
    await library.recoverLibraryRestores();
    assert.equal(existsSync(directory), false);
    assert.equal(db.connection.prepare("SELECT count(*) FROM library_restore_files").pluck().get(), 0);
  } else {
    const saved = await saveOther();
    assert.equal(library.getItem(saved.targetId)?.spaceId, space.id);
  }
  library.deleteItem(created.targetId);
  const repeated = await promote();
  assert.deepEqual([repeated.reused, repeated.targetMissing, repeated.targetId], [true, true, created.targetId]);
  assert.equal(library.listItems(space.id).length, 1);
}

async function main(): Promise<void> {
try {
  // 1. Memory target must be compensated when provenance insert fails.
  const evMem = ingestor.ingest("p1", { source: "manual", kind: "note", title: "mem", ref: "mem" });
  const beforeMem = projects.listMemory("p1").length;
  (projects as any).insertProjectEventPromotion = () => { throw new Error("fixture promotion insert failure"); };
  assert.throws(() => promoter.promote(evMem.id, { targetKind: "memory", memoryKind: "fact", memoryTitle: "temporary memory" }), /fixture promotion insert failure/);
  (projects as any).insertProjectEventPromotion = realInsertPromotion;
  assert.equal(projects.listMemory("p1").length, beforeMem, "memory target is rolled back when provenance insert fails");
  assert.equal(promotionCount("p1", evMem.id, "memory"), 0);

  // 2. Todo target must be compensated on the same boundary.
  const evTodo = ingestor.ingest("p1", { source: "manual", kind: "note", title: "todo", ref: "todo" });
  const beforeTodos = projects.listTodos("p1").length;
  (projects as any).insertProjectEventPromotion = () => { throw new Error("fixture todo link failure"); };
  assert.throws(() => promoter.promote(evTodo.id, { targetKind: "todo", todoTitle: "temporary todo" }), /fixture todo link failure/);
  (projects as any).insertProjectEventPromotion = realInsertPromotion;
  assert.equal(projects.listTodos("p1").length, beforeTodos, "todo target is rolled back when provenance insert fails");

  // 3. Library target and a lazily-created project Library Space are both rolled back.
  const evLib = ingestor.ingest("p2", { source: "manual", kind: "note", title: "lib", ref: "lib" });
  assert.equal(library.listProjectSpaces("p2").length, 0);
  (projects as any).insertProjectEventPromotion = () => { throw new Error("fixture library link failure"); };
  assert.throws(() => promoter.promote(evLib.id, { targetKind: "library", libraryTitle: "temporary doc", libraryContent: "temporary body" }), /fixture library link failure/);
  (projects as any).insertProjectEventPromotion = realInsertPromotion;
  assert.equal(library.listProjectSpaces("p2").length, 0, "new empty project Library Space is removed with the failed promotion");
  assert.equal(promotionCount("p2", evLib.id, "library"), 0);

  // 4. Existing project Library Space is preserved while only the failed target item is removed.
  const existingSpace = library.createSpace({ name: "Existing P3", projectId: "p3" });
  const evLibExisting = ingestor.ingest("p3", { source: "manual", kind: "note", title: "lib-existing", ref: "lib-existing" });
  (projects as any).insertProjectEventPromotion = () => { throw new Error("fixture existing-space link failure"); };
  assert.throws(() => promoter.promote(evLibExisting.id, { targetKind: "library", libraryTitle: "temporary existing", libraryContent: "body" }), /fixture existing-space link failure/);
  (projects as any).insertProjectEventPromotion = realInsertPromotion;
  assert(library.getSpace(existingSpace.id), "pre-existing project Library Space must not be removed by compensation");
  assert.equal(library.listItems(existingSpace.id).length, 0, "failed target item is removed from pre-existing space");

  // 5. Simulated UNIQUE winner: durable winner is returned and this attempt's new target is removed.
  const evRace = ingestor.ingest("p1", { source: "manual", kind: "note", title: "race", ref: "race" });
  const winner = projects.createTodo({ projectId: "p1", title: "winner todo" });
  const beforeRaceTodos = projects.listTodos("p1").length;
  (projects as any).insertProjectEventPromotion = (attempt: ProjectEventPromotionDto) => {
    const winnerPromotion: ProjectEventPromotionDto = {
      ...attempt,
      id: "pepr-winner",
      targetId: winner.id,
      targetTitle: winner.title,
    };
    realInsertPromotion(winnerPromotion);
    return realInsertPromotion(attempt); // UNIQUE path returns winnerPromotion.
  };
  const raceResult = promoter.promote(evRace.id, { targetKind: "todo", todoTitle: "loser todo" });
  (projects as any).insertProjectEventPromotion = realInsertPromotion;
  assert.equal(raceResult.reused, true);
  assert.equal(raceResult.targetId, winner.id, "result follows durable promotion winner, not the discarded local target");
  assert.equal(projects.listTodos("p1").length, beforeRaceTodos, "loser target is compensated; only pre-existing winner remains");
  assert.equal(promotionCount("p1", evRace.id, "todo"), 1);

  // 6. If compensation itself fails, do not hide the residual target.
  const evPartial = ingestor.ingest("p1", { source: "manual", kind: "note", title: "partial", ref: "partial" });
  (projects as any).insertProjectEventPromotion = () => { throw new Error("fixture link failure before rollback"); };
  const realDeleteTodo = projects.deleteTodo.bind(projects);
  (projects as any).deleteTodo = () => { throw new Error("fixture rollback failure"); };
  let partial: ProjectEventPromotionPartialStateError | undefined;
  try {
    promoter.promote(evPartial.id, { targetKind: "todo", todoTitle: "residual todo" });
  } catch (error) {
    if (error instanceof ProjectEventPromotionPartialStateError) partial = error;
    else throw error;
  }
  (projects as any).deleteTodo = realDeleteTodo;
  (projects as any).insertProjectEventPromotion = realInsertPromotion;
  assert(partial, "rollback failure must surface typed partial-state error");
  assert.equal(partial!.targetKind, "todo");
  assert(projects.getTodo(partial!.targetId), "typed partial state points at the residual target that still exists");
  realDeleteTodo(partial!.targetId);

  await checkAtomicTodoPromotion();
  await checkAtomicMemoryPromotion();
  await checkLibraryPromotion();
  console.log("project event promotion transaction: PASS (plan, memory and documents, rollback, receipts, scope and file recovery)");
} finally {
  (projects as any).insertProjectEventPromotion = realInsertPromotion;
  await db.runtimeAuditReader?.close();
  db.close();
  rmSync(root, { recursive: true, force: true });
}
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
