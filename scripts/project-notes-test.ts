import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { ProjectNotesService } from "../src/main/project/ProjectNotesService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { createProjectNotesExtension } from "../src/main/project/project-notes-extension";
import { PROJECT_NOTE_MAX_CHARS } from "../src/shared/project-notes";
import { MUTATING_BUILTIN_TOOLS, isMyBuddyNativeExtensionToolName } from "../src/shared/native-tools";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "project-notes-"));
  let db = new AppDatabase(join(root, "app.db"));
  try {
    for (const id of ["a", "b"]) db.connection.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES (?,?,1,1)").run(id, id);
    db.upsertTask({ id: "task", title: "Task", projectId: "a", updatedAt: 1 });
    db.upsertTask({ id: "peer", title: "Peer", projectId: "a", updatedAt: 1 });
    // Simulate a current-schema database created before the additive notes table existed.
    db.connection.exec("DROP TABLE project_notes");
    db.close(); db = new AppDatabase(join(root, "app.db"));
    assert.equal(db.getTask("task")?.projectId, "a", "adding notes preserves existing tasks and projects");
    let service = new ProjectNotesService(db);
    assert.equal(service.read("a").revision, 0);
    assert.throws(() => service.read("missing"), /不存在/);
    service.save({ projectId: "b", content: "B private", expectedRevision: 0 });
    let readonly = false;
    type Result = { isError?: boolean; details: { note?: { content: string; revision: number; projectId: string }; error?: string } };
    const tools = new Map<string, { execute: (id: string, params: unknown) => Promise<Result> }>();
    createProjectNotesExtension({ service, resolveProjectId: () => db.getTask("task")?.projectId ?? null, getPermissionMode: () => readonly ? "readonly" : "auto" })({
      registerTool: (tool: unknown) => { const t = tool as { name: string; execute: (id: string, params: unknown) => Promise<Result> }; tools.set(t.name, t); },
    } as unknown as ExtensionAPI);
    const read = () => tools.get("project_notes_read")!.execute("read", {});
    const save = (content: string, expectedRevision: number, extra = {}) => tools.get("project_notes_save")!.execute("save", { content, expectedRevision, ...extra });
    assert.equal((await read()).details.note?.revision, 0);
    assert.equal((await save("# Shared\n- [ ] checklist", 0, { projectId: "b" })).isError, undefined);
    assert.equal(service.read("b").content, "B private", "cannot inject another project id");
    assert(service.sources("peer")[0].text.includes("checklist"), "peer task sees shared note without a space binding");
    assert.equal(service.sources("unknown").length, 0);
    assert.equal((await save("stale", 0)).isError, true);
    assert.equal((await save("x".repeat(PROJECT_NOTE_MAX_CHARS + 1), 1)).isError, true);
    assert.equal((await save("invalid", -1)).isError, true);
    const evidence = service.sources("task")[0];
    service.save({ projectId: "a", content: "User update", expectedRevision: 1 });
    assert.throws(() => evidence.validate(), /已更新/);
    assert.equal((await save("Agent stale", 1)).isError, true, "user edit wins over stale agent version");
    assert.equal((await read()).details.note?.content, "User update");
    assert(service.forSubagent("task").includes("User update"));
    readonly = true;
    assert.equal((await read()).isError, undefined);
    assert.equal((await save("no", 2)).isError, true);
    readonly = false;
    db.connection.prepare("UPDATE projects SET archived=1 WHERE id='a'").run();
    assert.equal((await save("no", 2)).isError, true);
    assert.equal(service.sources("task").length, 0);
    db.connection.prepare("UPDATE projects SET archived=0 WHERE id='a'").run();
    service.save({ projectId: "a", content: "中".repeat(PROJECT_NOTE_MAX_CHARS), expectedRevision: 2 });
    assert(Buffer.byteLength(service.forSubagent("task"), "utf8") <= 12_000);
    db.upsertTask({ id: "task", title: "Task", projectId: "b", updatedAt: 2 });
    assert.equal((await read()).details.note?.content, "B private", "existing tool resolves task binding afresh");
    assert(!service.forSubagent("task").includes("中中中"));
    db.connection.prepare("UPDATE tasks SET project_id=NULL WHERE id='task'").run();
    assert.equal((await read()).isError, true);
    assert.equal((await save("no", 0)).isError, true);
    service.save({ projectId: "a", content: "", expectedRevision: 3 });
    assert.equal(service.sources("peer").length, 0);
    db.close(); db = new AppDatabase(join(root, "app.db")); service = new ProjectNotesService(db);
    assert.equal(db.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
    assert.equal(service.read("a").revision, 4, "additive schema preserves the database on reopen");
    assert.equal(service.read("b").content, "B private");
    new ProjectRepository(db.connection).delete("b");
    assert.equal(db.connection.prepare("SELECT 1 FROM project_notes WHERE project_id='b'").get(), undefined);
    assert(isMyBuddyNativeExtensionToolName("project_notes_read"));
    assert(isMyBuddyNativeExtensionToolName("project_notes_save"));
    assert((MUTATING_BUILTIN_TOOLS as readonly string[]).includes("project_notes_save"));
    console.log("PASS project notes: task tools, shared scope, isolation, conflicts, readonly, archive, fresh context, budget, persistence, cascade");
  } finally { db.close(); rmSync(root, { recursive: true, force: true }); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
