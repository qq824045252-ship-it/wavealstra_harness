import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";

const root = mkdtempSync(join(tmpdir(), "mybuddy-project-binding-matrix-"));
try {
  const db = new AppDatabase(join(root, "app.db"));
  const service = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));
  const a = join(root, "workspace-a");
  const b = join(root, "workspace-b");
  const shared = join(root, "workspace-shared");
  mkdirSync(a); mkdirSync(b); mkdirSync(shared);
  db.upsertSpace({ id: "space-a", name: "目录 A", path: a });
  db.upsertSpace({ id: "space-b", name: "目录 B", path: b });
  db.upsertSpace({ id: "space-shared", name: "共享目录", path: shared });

  const p1 = service.create({ name: "项目一" });
  const p2 = service.create({ name: "项目二" });
  service.update({ id: p1.id, defaultSpaceId: "space-a" });
  service.update({ id: p2.id, defaultSpaceId: "space-shared" });

  db.upsertTask({ id: "p1-a", title: "A", projectId: p1.id, spaceId: "space-a", updatedAt: 1 });
  db.upsertTask({ id: "p1-b", title: "B", projectId: p1.id, spaceId: "space-b", updatedAt: 2 });
  db.upsertTask({ id: "p1-independent", title: "Independent", projectId: p1.id, updatedAt: 3 });
  db.upsertTask({ id: "p1-shared", title: "Shared 1", projectId: p1.id, spaceId: "space-shared", updatedAt: 4 });
  db.upsertTask({ id: "p2-shared", title: "Shared 2", projectId: p2.id, spaceId: "space-shared", updatedAt: 5 });

  assert.equal(db.getTask("p1-a")?.spaceId, "space-a");
  assert.equal(db.getTask("p1-b")?.spaceId, "space-b", "same Project may retain a different task working directory");
  assert.equal(db.getTask("p1-independent")?.spaceId, undefined, "Project task may remain directory-independent");
  assert.equal(db.getTask("p1-shared")?.spaceId, "space-shared");
  assert.equal(db.getTask("p2-shared")?.spaceId, "space-shared", "two Projects may explicitly share the same Space");
  assert.equal(service.get(p1.id)?.defaultSpaceId, "space-a", "task bindings never rewrite Project default directory");
  assert.equal(service.get(p2.id)?.defaultSpaceId, "space-shared");

  service.update({ id: p1.id, defaultSpaceId: "space-b" });
  assert.equal(db.getTask("p1-a")?.spaceId, "space-a");
  assert.equal(db.getTask("p1-b")?.spaceId, "space-b");
  assert.equal(db.getTask("p1-independent")?.spaceId, undefined, "changing Project default must not bind an existing independent task");

  db.upsertSpace({ id: "space-missing", name: "失效目录", path: join(root, "does-not-exist") });
  assert.throws(() => service.update({ id: p1.id, defaultSpaceId: "space-missing" }), /路径不可用/);
  assert.equal(service.get(p1.id)?.defaultSpaceId, "space-b", "failed default update must preserve previous valid binding");

  service.delete(p1.id);
  assert.equal(db.getTask("p1-a")?.projectId, undefined, "Project deletion unbinds only Project identity");
  assert.equal(db.getTask("p1-a")?.spaceId, "space-a", "Project deletion preserves task working directory");
  assert.equal(db.getTask("p1-independent")?.spaceId, undefined);
  assert.equal(db.listSpaces().some((space) => space.id === "space-shared"), true, "shared Space survives Project deletion");
  db.close();
  console.log("project binding matrix: PASS (multi-directory, shared directory, independent task, missing path, delete boundary)");
} finally {
  rmSync(root, { recursive: true, force: true });
}