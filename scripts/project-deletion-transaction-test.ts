import assert from "node:assert/strict";
import { existsSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { MemoryForgetWatermarks } from "../src/main/memory/MemoryForgetWatermarks";
import { MemoryService } from "../src/main/memory/MemoryService";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { deleteProjectWithLifecycle } from "../src/main/project/ProjectDeletion";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { LIBRARY_PERSONAL_SPACE_ID } from "../src/shared/library-ipc";

async function main(): Promise<void> {
  const nativeFlag = process.argv.indexOf("--native");
  const executable = nativeFlag < 0 ? undefined : locateRuntimeAudit(process.argv[nativeFlag + 1] ?? process.cwd());
  if (nativeFlag >= 0) assert(executable && existsSync(executable), "Rust worker executable is required");
  const root = mkdtempSync(join(tmpdir(), "mybuddy-project-delete-"));
  const dbPath = join(root, "app.db");
  const db = new AppDatabase(dbPath, { runtimeAuditExecutable: executable });
  const memory = new MemoryService(db, { semantic: false });
  const library = new LibraryService(db, { libraryRoot: join(root, "library") });
  const projects = new ProjectService(new ProjectRepository(db.connection, db.runtimeAuditReader), memory);
  const agent: CronAgent = {
    getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined, isTaskBusy: () => false,
    listSkills: () => [], listConnectors: () => [], loadTaskHistory: async () => ({ messages: [] }),
    prompt: async () => { throw new Error("unexpected prompt"); },
    waitForSubmission: async () => { throw new Error("unexpected submission"); },
  };
  const cron = new CronService(db, agent);
  const stoppedCadences: string[] = [];
  const removedJobs: string[] = [];
  const publish = cron.publishRemovedProjectJobs.bind(cron);
  cron.publishRemovedProjectJobs = ids => { publish(ids); removedJobs.push(...ids); };
  const removeProject = (id: string) => deleteProjectWithLifecycle(id, {
    db, projects, library, cron, cancelCadence: cleared => stoppedCadences.push(cleared),
  });
  try {
    const runtime = db.runtimeAuditReader;
    if (runtime) assert.equal(await runtime.supportsProjectWrites("deletion"), true);
    db.connection.exec(`INSERT INTO projects(id,name,created_at,updated_at) VALUES ('target','Target',1,1),('other','Other',1,1)`);
    db.upsertTask({ id: "kept-task", title: "Retained conversation", projectId: "target", cwd: root, updatedAt: 1 });
    const todo = projects.createTodo({ projectId: "target", title: "Owned plan" });
    const otherTodo = projects.createTodo({ projectId: "other", title: "Outside plan" });
    const edge = db.connection.prepare(`INSERT INTO work_graph_edges(id,from_type,from_id,relation,to_type,to_id,created_at,updated_at)
      VALUES (?, ?, ?, 'RELATES_TO', 'task', 'kept-task', 1, 1)`);
    edge.run("owned-plan-edge", "plan", todo.id);
    edge.run("owned-project-edge", "project", "target");
    edge.run("outside-edge", "plan", otherTodo.id);
    const ownedSpace = library.createSpace({ name: "Owned documents", projectId: "target" });
    const collection = library.createCollection({ name: "Owned folder", spaceId: ownedSpace.id });
    const owned = library.createItem({ spaceId: ownedSpace.id, collectionId: collection.id, kind: "markdown", title: "Owned note", content: "owned file" });
    library.ensureReady();
    const personal = library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "Personal note", content: "personal file" });
    const ownedPath = library.absolutePath(owned);
    const personalPath = library.absolutePath(personal);
    library.attachToTask({ itemId: owned.id, taskId: "kept-task" });
    for (const [jobId, projectId] of [["owned-job", "target"], ["outside-job", "other"]]) {
      db.upsertCronJob({ id: jobId, name: jobId, projectId, prompt: "fixture prompt", scheduleType: "every",
        scheduleExpr: "1h", timezone: "UTC", enabled: true, createdAt: 1, updatedAt: 1 });
      db.insertCronRun({ id: `${jobId}-run`, jobId, startedAt: 1, status: "running", taskId: "kept-task" });
      db.connection.prepare("INSERT INTO cron_run_inputs(run_id,request_json) VALUES (?,'{}')").run(`${jobId}-run`);
    }
    const privateMemory = memory.create({ kind: "fact", title: "ReleaseTag", content: "ReleaseTag is bronze", scopeType: "project", scopeId: "target",
      evidence: [{ evidenceKind: "external", refId: "manual-proof", excerpt: "用户：EvidenceTag is ruby" }] });
    memory.update({ id: privateMemory.id, content: "ReleaseTag is silver" });
    const sharedMemory = memory.create({ kind: "procedure", title: "SharedTag", content: "SharedTag is teal",
      scopeType: "global" });
    memory.promote(sharedMemory.id, "project", "target");
    await projects.archiveAsync("target", true);

    db.connection.exec(`CREATE TRIGGER reject_project_deletion BEFORE DELETE ON projects WHEN old.id='target'
      BEGIN SELECT RAISE(ABORT,'fixture late project delete failure'); END`);
    await assert.rejects(removeProject("target"), /fixture late project delete failure|项目删除失败/);
    db.connection.exec("DROP TRIGGER reject_project_deletion");
    assert.equal(projects.get("target")?.archived, true);
    assert.equal(db.getTask("kept-task")?.projectId, "target");
    assert.equal(projects.listTodos("target").length, 1);
    assert.equal(library.readContent(owned.id).content, "owned file");
    assert.equal(library.listTaskReferences("kept-task").items.length, 1);
    assert.ok(memory.get(privateMemory.id));
    assert.equal(memory.get(sharedMemory.id)?.scopes.length, 2);
    assert.equal(db.listCronRuns(20).length, 2);
    assert.equal(db.connection.prepare("SELECT count(*) FROM memory_forget_targets").pluck().get(), 0);
    assert.deepEqual([stoppedCadences, removedJobs], [[], []]);

    if (runtime) {
      await projects.archiveAsync("target", false);
      const request = runtime.deleteProject.bind(runtime);
      let staleRejected = false;
      runtime.deleteProject = async (...args) => {
        if (!staleRejected) {
          memory.update({ id: privateMemory.id, content: "ReleaseTag is platinum" });
          const stale = await request(...args);
          assert.equal(stale.status, "memoryChanged");
          assert.equal(library.readContent(owned.id).content, "owned file");
          staleRejected = true;
          return stale;
        }
        const committed = await request(...args);
        assert.equal(committed.status, "deleted");
        throw new Error("fixture lost the committed deletion reply");
      };
      try { await removeProject("target"); }
      finally { runtime.deleteProject = request; }
      assert.ok(staleRejected);
    } else {
      await removeProject("target");
    }

    assert.equal(await projects.readDetails("target"), undefined);
    assert.equal(db.getTask("kept-task")?.projectId, undefined);
    assert.equal(db.getTask("kept-task")?.cwd, root);
    assert.equal(await projects.readTodo(todo.id), undefined);
    assert.equal((await projects.readTodo(otherTodo.id))?.title, "Outside plan");
    assert.deepEqual(db.connection.prepare("SELECT id FROM work_graph_edges").pluck().all(), ["outside-edge"]);
    assert.equal(library.getItem(owned.id), null);
    assert.equal(existsSync(ownedPath), false);
    assert.equal(existsSync(personalPath), true);
    assert.equal(library.readContent(personal.id).content, "personal file");
    assert.equal(library.listTaskReferences("kept-task").items.length, 0);
    assert.equal(memory.get(privateMemory.id), undefined);
    assert.deepEqual(memory.get(sharedMemory.id)?.scopes.map(scope => scope.scopeType), ["global"]);
    const scope = { scopeType: "project" as const, scopeId: "target" };
    const watermarks = new MemoryForgetWatermarks(db.connection);
    for (const text of ["ReleaseTag is bronze", "ReleaseTag is silver", "EvidenceTag is ruby", "SharedTag is teal",
      ...(runtime ? ["ReleaseTag is platinum"] : [])]) {
      assert.equal(watermarks.sourceFilter([scope])(text, "", 1).userText, "", text);
    }
    assert.equal(watermarks.sourceFilter([{ scopeType: "global" }])("SharedTag is teal", "", 1).userText, "SharedTag is teal");
    assert.deepEqual((await cron.readJobs()).map(job => job.id), ["outside-job"]);
    assert.deepEqual(db.listCronRuns().map(run => run.id), ["outside-job-run"]);
    assert.deepEqual(db.connection.prepare("SELECT run_id FROM cron_run_inputs").pluck().all(), ["outside-job-run"]);
    assert.deepEqual([stoppedCadences, removedJobs], [["target"], ["owned-job"]]);
    assert.deepEqual(db.connection.pragma("foreign_key_check"), []);
    let blockedCleanup: { path: string; stashed: string } | undefined;
    if (runtime) {
      db.connection.exec(`INSERT INTO projects(id,name,created_at,updated_at) VALUES ('cleanup','Cleanup',1,1)`);
      const space = library.createSpace({ name: "Cleanup documents", projectId: "cleanup" });
      const path = join(library.root, space.id);
      const stashed = path + ".stashed";
      renameSync(path, stashed);
      writeFileSync(path, "fixture prevents directory cleanup");
      await removeProject("cleanup");
      assert.equal(projects.get("cleanup"), undefined);
      assert.equal(existsSync(path), true);
      assert.equal(db.connection.prepare("SELECT count(*) FROM library_file_cleanup").pluck().get(), 1);
      blockedCleanup = { path, stashed };
    }
    await runtime?.close();
    const reopened = new AppDatabase(dbPath, { runtimeAuditExecutable: executable });
    try {
      assert.equal(reopened.getTask("kept-task")?.projectId, undefined);
      assert.equal(reopened.getCronJob("owned-job"), undefined);
      if (blockedCleanup) {
        rmSync(blockedCleanup.path);
        renameSync(blockedCleanup.stashed, blockedCleanup.path);
        await new LibraryService(reopened, { libraryRoot: library.root }).recoverFileDeletes();
        assert.equal(existsSync(blockedCleanup.path), false);
      }
      assert.equal(reopened.connection.prepare("SELECT count(*) FROM library_file_cleanup").pluck().get(), 0);
    } finally {
      await reopened.runtimeAuditReader?.close();
      reopened.close();
    }
    console.log(`Project deletion transaction passed (${runtime ? "Rust worker" : "host"})`);
  } finally {
    cron.stop();
    await db.runtimeAuditReader?.close();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
