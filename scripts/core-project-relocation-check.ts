import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { artifactToRow } from "../src/main/artifact/ArtifactRepository";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { ProjectFolderRelocation } from "../src/main/project/ProjectFolderRelocation";
import { emptyProjectPolicies } from "../src/shared/project-domain";

const root = mkdtempSync(join(tmpdir(), "mybuddy-project-relocation-"));
const exe = resolve(process.argv[2] ?? "out/native/linux-x64/mybuddy-runtime-audit");
const path = join(root, "app.duckdb");
await initializeCoreDatabase(exe, root, path, CURRENT_DATABASE_SCHEMA_VERSION);
const db = await AppDatabase.open(path, { runtimeAuditExecutable: exe, runtimeAuditSupervised: true });
const reader = db.runtimeAuditReader!;
try {
  const old = join(root, "before"), next = join(root, "after");
  mkdirSync(old);
  writeFileSync(join(old, "index.html"), "entry");
  writeFileSync(join(old, "asset.txt"), "resource");
  await db.writeWorkspaceUpsert({ id: "folder", name: "folder", path: old });
  assert.equal(await reader.writeProject("create", { kind: "create",
    project: { id: "project", name: "Project", defaultSpaceId: "folder", createdAt: 1, updatedAt: 1, resourceBudgetChars: 128000 },
    policiesJson: JSON.stringify(emptyProjectPolicies()), resources: [
      { id: "ref", projectId: "project", kind: "file", title: "reference", value: join(old, "asset.txt"), enabled: true, sortOrder: 0, createdAt: 1, updatedAt: 1 },
    ],
  }), "changed");
  await db.writeTaskRecord({ id: "task", title: "Task", projectId: "project", spaceId: "folder", updatedAt: 1 });
  assert.ok(await reader.writeArtifact("task", "register", { kind: "register", row: artifactToRow({
    id: "result", taskId: "task", kind: "html", source: { type: "workspace-file", rootDir: old, entryFile: join(old, "index.html") },
    capabilities: {}, version: 1, createdAt: 1, updatedAt: 1,
  }) }));
  assert.ok(await reader.batch3Write({ kind: "artifactSetFileDependencies", artifactId: "result", taskId: "task",
    dependencies: [{ filePath: join(old, "asset.txt"), dependencyKind: "runtime" }], createdAt: 1 }));
  renameSync(old, next);
  const service = new ProjectFolderRelocation(db, () => false);
  const preview = () => service.previewAsync("project", next);
  const expired = await preview();
  const clock = Date.now;
  try {
    Date.now = () => clock() + 301_000;
    await assert.rejects(service.commit(expired.token), /预览已失效/);
  } finally { Date.now = clock; }
  const stale = await preview();
  writeFileSync(join(next, "asset.txt"), "changed");
  await assert.rejects(service.commit(stale.token), /重新预览/);
  const verify = async (expected: string, version: number) => {
    assert.equal((await db.readSpaces()).find(s => s.id === "folder")?.path, expected);
    const rows = await reader.projectMetadata<{ resources: Array<{ value: string }> }>({kind: "details", projectId: "project"});
    assert.equal(rows?.resources[0].value, join(expected, "asset.txt"));
    const result = await reader.artifactById("result");
    assert.equal(result?.version, version);
    assert.equal(result?.source.rootDir, expected);
    assert.equal(result?.source.type === "workspace-file" && result.source.entryFile, join(expected, "index.html"));
    assert.equal((await reader.artifactFileDependencies("result"))?.[0].filePath, join(expected, "asset.txt"));
  };
  await verify(old, 1);
  // Two distinct stored dependencies resolve to the same key after relocation.
  // DuckDB rejects the second insert after the workspace, reference and artifact updates.
  const setDependencies = (paths: string[]) => reader.batch3Write({ kind: "artifactSetFileDependencies",
    artifactId: "result", taskId: "task", dependencies: paths.map(filePath => ({ filePath, dependencyKind: "runtime" })), createdAt: 2 });
  assert.ok(await setDependencies([join(old, "asset.txt"), join(next, "asset.txt")]));
  const conflicting = await preview();
  await assert.rejects(service.commit(conflicting.token));
  assert.equal((await db.readSpaces()).find(s => s.id === "folder")?.path, old);
  assert.equal((await reader.artifactById("result"))?.version, 1);
  assert.equal((await reader.artifactFileDependencies("result"))?.length, 2);
  assert.ok(await setDependencies([join(old, "asset.txt")]));
  await verify(old, 1);
  const confirmed = await preview();
  assert.equal(confirmed.tasks[0].newCwd, next);
  assert.equal(confirmed.references[0].newPath, join(next, "asset.txt"));
  assert.equal(confirmed.artifacts?.[0].rootDir, next);
  await service.commit(confirmed.token);
  await verify(next, 2);
  await assert.rejects(service.commit(confirmed.token), /预览已失效/);
  assert.equal(existsSync(join(root, "app.db")), false);
  console.log("PASS project relocation preview, expiry, changed file rejection, constraint rollback, retry, workspace/reference/artifact/dependency paths and version");
} finally {
  await reader.close();
  await shutdownCoreWorker(root, path);
  rmSync(root, {recursive: true, force: true});
}
