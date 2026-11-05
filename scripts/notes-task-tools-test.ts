import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { SessionExtensionAssembler } from "../src/main/agent/SessionExtensionAssembler";
import { durableDomainTools } from "../src/main/agent/durable/DurableDomainTools";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { WorkspaceNotesService } from "../src/main/workspace/WorkspaceNotesService";
import { ProjectNotesService } from "../src/main/project/ProjectNotesService";
import { createWorkspaceNotesExtension } from "../src/main/workspace/workspace-notes-extension";

const root = await mkdtemp(join(tmpdir(), "notes-task-tools-"));
process.env.HOME = root; process.env.USERPROFILE = root;
const model: any = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const ref = { provider: model.provider, modelId: model.id };
function models(reply: (context: any, options: any) => any): any {
  const api: any = { getAuth: async () => undefined, getModel: () => model, streamSimple: (_model: any, context: any, options: any) => {
    const stream = createAssistantMessageEventStream();
    void Promise.resolve().then(() => reply(context, options)).then(content => {
      const stopReason = content.some((c: any) => c.type === "toolCall") ? "toolUse" : "stop";
      const message: any = { role: "assistant", content, stopReason, api: model.api, model: model.id, provider: model.provider,
        timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      stream.push({ type: "done", reason: stopReason, message }); stream.end();
    }).catch(error => {
      stream.push({ type: "error", reason: "aborted", error: { role: "assistant", content: [], stopReason: "aborted", errorMessage: String(error), api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } } }); stream.end();
    });
    return stream;
  } };
  api.completeSimple = (model: any, context: any, options: any) => api.streamSimple(model, context, options).result();
  return api;
}
const text = (value: string) => [{ type: "text", text: value }];
const call = (name: string, args: object) => [{ type: "toolCall", id: "fixture-call", name, arguments: args }];

const db = new AppDatabase(join(root, "app.db"));
try {
  db.createSpace({ id: "space", name: "Workspace" });
  db.createSpace({ id: "other", name: "Other" });
  db.connection.prepare("INSERT INTO projects (id,name,created_at,updated_at) VALUES ('project','Project',1,1)").run();
  db.upsertTask({ id: "task", title: "Task", spaceId: "space", projectId: "project", updatedAt: 1 });
  const workspace = new WorkspaceNotesService(db);
  const project = new ProjectNotesService(db);
  // Only unrelated services are inert fixtures. Production assembly, runtime, tool dispatch and DB are real.
  const unused = new Proxy({}, { get: (_target, key) => { if (key === "then") return undefined; return () => { throw Error("Unexpected unrelated service: " + String(key)); }; } });
  const assembler = new SessionExtensionAssembler({ db, memory: unused, project: unused,
    libraryWorkspace: { library: () => unused, resourceLocator: () => unused },
  } as any);
  const names = ["workspace_notes_read", "workspace_notes_save", "project_notes_read", "project_notes_save"];
  const registered = await durableDomainTools(assembler.domainExtensions("task", false, null, {
    getPermissionMode: () => "auto", requestApproval: async () => true,
  }));
  for (const name of names) assert(registered.tools.some(tool => tool.name === name), "actual task assembly must register " + name);
  for (const mode of ["native", "codemode"] as const) {
    const cwd = join(root, mode); await mkdir(cwd);
    const spaceRevision = workspace.read("space").revision;
    const projectRevision = project.read("project").revision;
    const calls: Array<[string, object]> = [
      ["workspace_notes_read", {}], ["project_notes_read", {}],
      ["workspace_notes_save", { content: "Workspace written by " + mode, expectedRevision: spaceRevision }],
      ["project_notes_save", { content: "Project written by " + mode, expectedRevision: projectRevision }],
    ];
    const prior = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref, toolMode: mode,
      tools: registered.tools.filter(tool => !names.filter(name => name.endsWith("_save")).includes(tool.name)),
      instructions: () => "Previously only note reading was available", onSnapshot: () => {}, models: models(() => text("Old task history")),
    });
    try { assert.equal((await (await prior.submit("Read-only note history", "previous")).wait(ctx)).status, "done"); }
    finally { await prior.close(); }
    let requests = 0;
    const runtime = await DurableBotRuntime.open({ directory: join(cwd, "state"), cwd, model: ref, toolMode: mode,
      tools: registered.tools, instructions: () => "Read and update the task's project and workspace notes.", onSnapshot: () => {},
      models: models(context => {
        const offered = getCurrentTools(context.messages);
        for (const name of names) assert(mode === "native" ? offered.some(tool => tool.name === name) : offered.find(tool => tool.name === "codemode")?.description.includes(name), "model must discover " + name);
        assert(++requests < 8, "tool sequence must settle");
        if (mode === "native" && requests <= calls.length) return call(...calls[requests - 1]);
        if (mode === "codemode" && requests === 1) return call("codemode", { code: `
          const w = JSON.parse(await tools.workspace_notes_read({}));
          const p = JSON.parse(await tools.project_notes_read({}));
          text(await tools.workspace_notes_save({content: "Workspace written by codemode", expectedRevision:w.revision}));
          text(await tools.project_notes_save({content: "Project written by codemode", expectedRevision:p.revision}));
        ` });
        assert(!context.messages.some((message: any) => message.role === "toolResult" && message.isError), JSON.stringify(context.messages.filter((message: any) => message.role === "toolResult")));
        return text("Notes saved");
      }),
    });
    try {
      // Production DurableBotService refreshes task tools before every submission.
      await runtime.configure(ref, mode, undefined, registered.tools);
      const outcome = await (await runtime.submit("Update both notes", mode)).wait(ctx);
      assert.equal(outcome.status, "done", JSON.stringify({outcome, snapshot:runtime.snapshot}));
      assert.equal(workspace.read("space").content, "Workspace written by " + mode);
      assert.equal(project.read("project").content, "Project written by " + mode);
      assert.equal(workspace.read("space").revision, spaceRevision + 1);
      assert.equal(project.read("project").revision, projectRevision + 1);
      console.log("PASS actual task " + mode + ": model-visible project/workspace read and save tools persist to database");
    } finally { await runtime.close(); }
  }
  let readonly = false;
  const tools = new Map<string, any>();
  createWorkspaceNotesExtension({ service: workspace, resolveWorkspaceId: () => db.getTask("task")?.spaceId ?? null, getPermissionMode: () => readonly ? "readonly" : "auto" })({ registerTool: (tool: any) => tools.set(tool.name, tool) } as any);
  const save = (expectedRevision: number) => tools.get("workspace_notes_save").execute("test", { content: "patched", expectedRevision, workspaceId: "other" });
  const revision = workspace.read("space").revision;
  assert.equal((await save(revision)).isError, undefined);
  assert.equal(workspace.read("other").revision, 0, "cannot inject another workspace id");
  assert.equal((await save(revision)).isError, true, "stale task cannot overwrite newer changes");
  readonly = true;
  assert.equal((await save(revision + 1)).isError, true);
  assert.equal((await tools.get("workspace_notes_read").execute("test", {})).isError, undefined);
  readonly = false;
  db.connection.prepare("UPDATE spaces SET archived=1 WHERE id='space'").run();
  assert.equal((await save(revision + 1)).isError, true);
  db.connection.prepare("UPDATE tasks SET space_id='other' WHERE id='task'").run();
  assert.equal((await save(0)).isError, undefined, "existing tool resolves rebound task workspace afresh");
  assert.equal(workspace.read("other").content, "patched");
  db.connection.prepare("UPDATE tasks SET space_id=NULL WHERE id='task'").run();
  assert.equal((await save(revision + 1)).isError, true);
  assert.equal((await tools.get("workspace_notes_read").execute("test", {})).isError, true);
  console.log("PASS workspace task write boundaries: scope, conflict, readonly, archive, unbound");
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
