import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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

const root = mkdtempSync(join(tmpdir(), "mybuddy-promotion-tx-"));
const db = new AppDatabase(join(root, "app.db"));
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));
const library = new LibraryService(db, { libraryRoot: join(root, "library") });
db.connection.prepare(`INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p1','P1',1,1),('p2','P2',1,1),('p3','P3',1,1)`).run();
let clock = 1000;
const ingestor = new ProjectEventIngestor(projects, { now: () => ++clock });
const promoter = new ProjectEventPromoter(projects, library, { now: () => ++clock });
const realInsertPromotion = projects.insertProjectEventPromotion.bind(projects);

function promotionCount(projectId: string, eventId: string, kind: string): number {
  return (db.connection.prepare(`SELECT COUNT(*) c FROM project_event_promotions WHERE project_id=? AND event_id=? AND target_kind=?`).get(projectId, eventId, kind) as { c: number }).c;
}

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

  console.log("project event promotion transaction: PASS (target rollback, library-space rollback, UNIQUE winner, explicit partial state)");
} finally {
  (projects as any).insertProjectEventPromotion = realInsertPromotion;
  db.close();
  rmSync(root, { recursive: true, force: true });
}