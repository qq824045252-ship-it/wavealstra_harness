import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string): void {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
}
function tableExists(db: AppDatabase, name: string): boolean {
  return db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name) !== undefined;
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-project-current-schema-"));
try {
  console.log("== Project Memory current-schema contract ==");
  const dbPath = join(root, "current.db");
  const db = new AppDatabase(dbPath);
  const kernel = new MemoryService(db, { semantic: false });
  const repo = new ProjectRepository(db.connection);
  const service = new ProjectService(repo, kernel);
  const project = service.create({ name: "Current Project" });
  db.upsertTask({ id: "task-current", title: "Current Task", projectId: project.id, updatedAt: 1 });
  const beforeMemoryAt = service.get(project.id)!.updatedAt;
  const memory = service.createMemory(
    { projectId: project.id, kind: "decision", title: "Current decision", content: "current schema only" },
    { sourceType: "agent", sourceTaskId: "task-current" },
  );
  ok(db.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, "fresh database is current schema");
  ok(!tableExists(db, "project_memory"), "legacy project_memory is absent from fresh schema");
  ok(!tableExists(db, "project_memory_evidence"), "legacy evidence table is absent from fresh schema");
  ok(memory.id.startsWith("mem_"), "project memory writes directly to Memory Kernel");
  ok(service.get(project.id)!.updatedAt > beforeMemoryAt, "project-scoped L1 write advances Project activity clock");
  db.close();

  const reopened = new AppDatabase(dbPath);
  const reopenedKernel = new MemoryService(reopened, { semantic: false });
  const reopenedService = new ProjectService(new ProjectRepository(reopened.connection), reopenedKernel);
  ok(reopenedService.get(project.id)?.name === "Current Project", "same-version reopen preserves current project data");
  ok(reopenedService.listMemory(project.id).some((item) => item.id === memory.id), "same-version reopen preserves current project memory");
  const shared = reopenedService.createMemory(
    { projectId: project.id, kind: "fact", title: "Shared across scopes" },
    { sourceType: "manual" },
  );
  reopenedKernel.repository.addScope({
    memoryId: shared.id,
    scopeType: "global",
    binding: "promoted",
    createdAt: Date.now(),
  });
  reopenedService.delete(project.id);
  ok(reopenedKernel.get(memory.id) === undefined, "project-only L1 is removed with its last scope");
  ok(reopenedKernel.get(shared.id)?.scopes.some((scope) => scope.scopeType === "global") === true, "shared L1 keeps its unrelated global scope");
  ok(reopenedKernel.get(shared.id)?.scopes.some((scope) => scope.scopeType === "project") === false, "project deletion detaches only the exact project scope");
  ok(reopened.getTask("task-current")?.projectId === undefined, "current schema keeps tasks.project_id ON DELETE SET NULL");
  reopened.close();

  const oldPath = join(root, "old.db");
  const old = new Database(oldPath);
  old.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
    INSERT INTO projects VALUES ('old-project','must disappear');
    PRAGMA user_version = 1;
  `);
  old.close();
  const reset = new AppDatabase(oldPath);
  const resetKernel = new MemoryService(reset, { semantic: false });
  const resetService = new ProjectService(new ProjectRepository(reset.connection), resetKernel);
  ok(reset.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, "old project database resets directly to current schema");
  ok(resetService.get("old-project") === undefined, "old project data is intentionally discarded");
  ok(!tableExists(reset, "project_memory"), "reset database does not recreate legacy project_memory");
  const newProject = resetService.create({ name: "After Reset" });
  const newMemory = resetService.createMemory(
    { projectId: newProject.id, kind: "fact", title: "usable after reset" },
    { sourceType: "manual" },
  );
  ok(Boolean(newMemory.id), "project memory is usable immediately after destructive reset");
  reset.close();
} finally {
  rmSync(root, { recursive: true, force: true });
}

if (failed) {
  console.error(`project-memory-migration-test: ${failed} FAILED, ${passed} passed`);
  process.exit(1);
}
console.log(`project-memory-migration-test: PASS (${passed})`);
