import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { prepareTaskWorkspace } from "../src/main/task/prepareTaskWorkspace";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { resolveTaskWorkspaceCwd } from "../src/main/task/TaskWorkspaceResolver";
import { ExecutionFailureRepository } from "../src/main/agent/ExecutionFailureRepository";
import { WorkspacePathError } from "../src/main/workspace/WorkspacePathError";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { WorkspaceMigrationBusyError } from "../src/main/agent/durable/DurableWorkspaceMigration";
import { DurableBotRuntime, type DurableBotOptions } from "../src/main/agent/durable/DurableBotRuntime";

// Service orchestration test: real SQLite and folders; native idle/migration is a controlled port.
// The separate native test exercises AgentDoc/checkpoint migration itself.
const root = mkdtempSync(join(tmpdir(), "durable-workspace-binding-"));
process.env.HOME = root; process.env.USERPROFILE = root;
const old = join(root, "isolated"), next = join(root, "space"), third = join(root, "other-space");
for (const cwd of [old, next, third]) mkdirSync(cwd);
const db = new AppDatabase(join(root, "app.db"));
const originalOpen = DurableBotRuntime.open;
const native = new Map<string, string>();
const busy = new Set<string>(), waiting = new Set<string>();
const created: Array<{ taskId: string; cwd: string; closed: boolean }> = [];
let failAfterNative = false, lateBusy = false;
const compactions: string[] = [];
const runtimeOptions = new Map<string, DurableBotOptions>();
const history = new Map<string, string[]>();
const fullHistory = new Map<string, Array<{ id: string; cwd: string; entries: number[] }>>();
const projected: Array<{ taskId: string; cwd: string; messageRoots: Map<string, string> }> = [];
let holdProjection: Promise<void> | undefined;
function snapshot(options: DurableBotOptions, ids: string[]) {
  options.onSnapshot({ epoch: Math.random().toString(), revision: 1, busy: false, queued: 0, outcome: "completed",
    messages: ids.map(id => ({ id, role: "assistant", text: "completed write", createdAt: 1 })) } as any);
}
DurableBotRuntime.open = async (options: DurableBotOptions) => {
  const taskId = options.taskId!;
  const previous = native.get(taskId);
  if (options.workspaceMigrationFrom) {
    if (lateBusy) { lateBusy = false; busy.add(taskId); throw new WorkspaceMigrationBusyError(); }
    assert(!busy.has(taskId), "native migration cannot redirect pending work");
    assert(previous === options.workspaceMigrationFrom || previous === options.cwd, "migration must identify exact old/new root");
  } else if (previous) assert.equal(options.cwd, previous);
  native.set(taskId, options.cwd);
  if (failAfterNative && options.workspaceMigrationFrom) { failAfterNative = false; throw new Error("injected native-to-SQLite crash window"); }
  const record = { taskId, cwd: options.cwd, closed: false }; created.push(record);
  runtimeOptions.set(taskId, options);
  if (history.has(taskId)) snapshot(options, history.get(taskId)!);
  return { snapshot: { busy: busy.has(taskId), queued: busy.has(taskId) ? 1 : 0, messages: [] },
    isSessionFailed: () => false, onSessionFailed: () => {},
    canRebindWorkspace: async () => !busy.has(taskId),
    close: async () => { record.closed = true; },
    compact: async () => { compactions.push(options.cwd); },
    harness: { commit: async (operation: (tx: any) => Promise<unknown>) => {
      const conversations = fullHistory.get(taskId) ?? [];
      return operation({
        scanConversations: async (_query: unknown, _limit: number, cursor: string | undefined) => {
          const offset = Number(cursor ?? 0);
          return { items: conversations.slice(offset, offset + 1), next: offset + 1 < conversations.length ? String(offset + 1) : undefined };
        },
        doc: async (_schema: unknown, id: string) => ({ cwd: conversations.find(row => row.id === id)!.cwd }),
        scanEntries: async (query: { conversationId: string }, _limit: number, cursor: string | undefined) => {
          const entries = conversations.find(row => row.id === query.conversationId)!.entries;
          const offset = Number(cursor ?? 0);
          return { items: entries.slice(offset, offset + 1).map(id => ({ id })), next: offset + 1 < entries.length ? String(offset + 1) : undefined };
        },
      });
    } },
  } as unknown as DurableBotRuntime;
};
const desired = new Map<string, string | undefined>();
const resolveErrors = new Set<string>();
const tools: Array<{ taskId: string; cwd: string; taskCwd: string | undefined }> = [];
function service() {
  return new DurableBotService({ db, agentDir: root, mcpDir: join(root, "mcp"),
    models: { getModel: () => ({ provider: "fixture", id: "fixture" }) } as any,
    resolveCwd: () => old,
    resolveNextCwd: id => { if (resolveErrors.has(id)) throw new Error("invalid space path"); return desired.get(id); },
    instructions: () => "fixture", toolMode: () => "native", defaultModel: () => "fixture/fixture", emit: () => {},
    waitingForInput: id => waiting.has(id),
    projectArtifacts: async (taskId, _snapshot, _before, cwd, messageRoots) => {
      await holdProjection;
      projected.push({ taskId, cwd, messageRoots: new Map(messageRoots) });
    },
    tools: async (task, cwd) => { tools.push({ taskId: task.id, cwd, taskCwd: task.cwd }); return { tools: [], contextHooks: [] }; },
  });
}
const open = (svc: DurableBotService, taskId: string, admission = false) => (svc as any).open(taskId, admission);
const binding = (id: string) => db.connection.prepare("SELECT directory,cwd FROM durable_bot_bindings WHERE task_id=?").get(id) as { directory: string; cwd: string };
const intent = (id: string) => db.connection.prepare("SELECT * FROM durable_bot_workspace_moves WHERE task_id=?").get(id);
function task(id: string) { db.upsertTask({ id, title: id, updatedAt: 1, welcomeMode: "general", modelId: "fixture/fixture" }); }
let svc = service();
try {
  task("idle"); await open(svc, "idle"); const directory = binding("idle").directory;
  desired.set("idle", next);
  await Promise.all([open(svc, "idle"), open(svc, "idle"), open(svc, "idle")]);
  assert.equal(binding("idle").cwd, next); assert.equal(db.getTask("idle")!.cwd, next);
  assert.equal(binding("idle").directory, directory); assert.equal(intent("idle"), undefined);
  assert.equal(created.filter(item => item.taskId === "idle" && item.cwd === next).length, 1, "concurrent opens share one migration");
  assert(tools.some(item => item.taskId === "idle" && item.cwd === next && item.taskCwd === next), "tool assembly uses new root consistently");
  await svc.release("idle"); await open(svc, "idle"); assert.equal(native.get("idle"), next);
  desired.set("idle", third); await open(svc, "idle"); assert.equal(binding("idle").cwd, third);
  desired.set("idle", old); await open(svc, "idle"); assert.equal(binding("idle").cwd, old, "removing organization binding restores isolated root");
  console.log("PASS idle/concurrent migration, stable durable identity, reopen and detach");

  task("busy"); await open(svc, "busy"); desired.set("busy", next); busy.add("busy");
  await open(svc, "busy"); assert.equal(binding("busy").cwd, old); assert.equal(intent("busy"), undefined);
  resolveErrors.add("busy"); await open(svc, "busy"); resolveErrors.delete("busy");
  busy.delete("busy"); waiting.add("busy"); await open(svc, "busy"); assert.equal(binding("busy").cwd, old);
  waiting.delete("busy"); await open(svc, "busy", true); assert.equal(binding("busy").cwd, next);
  console.log("PASS busy/queued/approval root pinning, invalid desired path does not block old runtime");

  task("continuation"); await open(svc, "continuation");
  db.bindTaskExecutionWorkspaceCwd("continuation", next); desired.set("continuation", undefined);
  await svc.release("continuation"); await open(svc, "continuation");
  assert.equal(binding("continuation").cwd, old); assert.equal(db.getTask("continuation")!.cwd, old, "execution-owned root beats renderer cwd");
  console.log("PASS execution-owned continuation pin and stale projection repair");

  task("admission"); await open(svc, "admission"); desired.set("admission", next);
  (svc as any).admissions.set("admission", new Set([Promise.resolve()]));
  await open(svc, "admission"); assert.equal(binding("admission").cwd, old);
  await open(svc, "admission", true); assert.equal(binding("admission").cwd, next);
  (svc as any).admissions.delete("admission");
  console.log("PASS admitted configuration cannot be migrated by incidental open");

  task("late-busy"); await open(svc, "late-busy"); desired.set("late-busy", next); lateBusy = true;
  await open(svc, "late-busy");
  assert.equal(binding("late-busy").cwd, old); assert.equal(intent("late-busy"), undefined);
  assert.equal(native.get("late-busy"), old, "native migration refusal never changes namespace");
  busy.delete("late-busy"); await open(svc, "late-busy"); assert.equal(binding("late-busy").cwd, next);
  console.log("PASS idle-to-native busy race restores reachable old namespace");

  task("restart-busy"); await open(svc, "restart-busy"); await svc.release("restart-busy");
  db.connection.prepare("INSERT INTO durable_bot_workspace_moves VALUES (?,?,?)").run("restart-busy", old, next);
  desired.set("restart-busy", next); lateBusy = true;
  await open(svc, "restart-busy"); assert.equal(binding("restart-busy").cwd, old); assert.equal(intent("restart-busy"), undefined);
  busy.delete("restart-busy"); await svc.compact("restart-busy");
  assert.equal(binding("restart-busy").cwd, next); assert.equal(compactions.at(-1), next, "compact runs through the same serialized binding boundary");
  console.log("PASS restart pending-intent refusal and compact admission boundary");

  task("invalid"); await open(svc, "invalid"); desired.set("invalid", join(root, "missing"));
  await assert.rejects(open(svc, "invalid"), /工作目录不存在/);
  assert.equal(binding("invalid").cwd, old); assert.equal(intent("invalid"), undefined);
  console.log("PASS invalid target fails closed without rewriting projection");

  task("crash"); await open(svc, "crash"); desired.set("crash", next); failAfterNative = true;
  await assert.rejects(open(svc, "crash"), /native-to-SQLite/);
  assert.equal(binding("crash").cwd, old); assert(intent("crash")); assert.equal(native.get("crash"), next);
  await svc.close(); svc = service();
  await open(svc, "crash"); assert.equal(binding("crash").cwd, next); assert.equal(intent("crash"), undefined);
  console.log("PASS restart reconciles committed native move and old SQLite projection");

  task("artifacts"); await open(svc, "artifacts");
  let releaseProjection!: () => void;
  holdProjection = new Promise<void>(resolve => { releaseProjection = resolve; });
  history.set("artifacts", ["old-write"]); snapshot(runtimeOptions.get("artifacts")!, ["old-write"]);
  desired.set("artifacts", next);
  let moved = false;
  const move = open(svc, "artifacts").then(() => { moved = true; });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(moved, false, "migration waits for previous directory's artifact projection");
  assert.equal(binding("artifacts").cwd, old);
  holdProjection = undefined; releaseProjection(); await move;
  history.set("artifacts", ["old-write", "new-write"]);
  snapshot(runtimeOptions.get("artifacts")!, history.get("artifacts")!);
  await svc.release("artifacts");
  const latest = projected.filter(item => item.taskId === "artifacts").at(-1)!;
  assert.equal(latest.cwd, next);
  assert.equal(latest.messageRoots.get("old-write"), old, "old relative write never points at a new space's same-name file");
  assert.equal(latest.messageRoots.get("new-write"), next);
  await svc.close(); svc = service(); await open(svc, "artifacts"); await svc.release("artifacts");
  assert.equal(projected.filter(item => item.taskId === "artifacts").at(-1)!.messageRoots.get("old-write"), old, "message roots persist across service restart");
  console.log("PASS artifact projection barrier and durable per-message original directory");

  task("windowed-artifacts"); await open(svc, "windowed-artifacts");
  const childRoot = join(root, "historical-child"); mkdirSync(childRoot);
  fullHistory.set("windowed-artifacts", [
    { id: "root", cwd: old, entries: [1, 2] },
    { id: "branch", cwd: old, entries: [3, 4] },
    { id: "child", cwd: childRoot, entries: [5, 6] },
  ]);
  history.set("windowed-artifacts", ["durable-4"]);
  snapshot(runtimeOptions.get("windowed-artifacts")!, ["durable-4"]);
  desired.set("windowed-artifacts", next); await open(svc, "windowed-artifacts");
  history.set("windowed-artifacts", ["durable-1", "durable-3", "durable-5", "durable-7"]);
  snapshot(runtimeOptions.get("windowed-artifacts")!, history.get("windowed-artifacts")!);
  await svc.release("windowed-artifacts");
  const windowed = projected.filter(item => item.taskId === "windowed-artifacts").at(-1)!;
  assert.equal(windowed.messageRoots.get("durable-1"), old, "window-excluded root entry retains original directory");
  assert.equal(windowed.messageRoots.get("durable-3"), old, "window-excluded branch entry retains original directory");
  assert.equal(windowed.messageRoots.get("durable-5"), childRoot, "isolated child history retains its own directory");
  assert.equal(windowed.messageRoots.get("durable-7"), next, "new entry belongs to current directory");
  assert.equal(windowed.messageRoots.get("durable-6"), childRoot, "all conversation/entry pagination is scanned");
  fullHistory.set("windowed-artifacts", [{ id: "root", cwd: next, entries: [1, 2, 3, 4, 7] }]);
  desired.set("windowed-artifacts", third); await open(svc, "windowed-artifacts"); await svc.release("windowed-artifacts");
  const remapped = projected.filter(item => item.taskId === "windowed-artifacts").at(-1)!;
  assert.equal(remapped.messageRoots.get("durable-1"), old, "a later move never overwrites earlier entry provenance");
  assert.equal(remapped.messageRoots.get("durable-7"), next);
  console.log("PASS complete paginated history provenance, branches, child roots and repeated migrations");

  task("prepare-input"); await open(svc, "prepare-input");
  db.upsertSpace({ id: "new-space", name: "New space", path: next });
  db.moveTaskInWorkspaceTree({ taskId: "prepare-input", targetSpaceId: "new-space" });
  desired.set("prepare-input", next); busy.add("prepare-input");
  await open(svc, "prepare-input");
  const workspace = new TaskExecutionWorkspace(join(root, "preparation-workspaces"));
  const failures = new ExecutionFailureRepository(db.connection);
  const authoritative = () => {
    const bound = svc.cwd("prepare-input");
    if (bound) { db.bindTaskExecutionWorkspaceCwd("prepare-input", bound); return bound; }
    return resolveTaskWorkspaceCwd(db, workspace, "prepare-input");
  };
  assert.equal(prepareTaskWorkspace(db, workspace, failures, "prepare-input", "queued-reply", authoritative), old,
    "queued input preparation preserves live native directory after sidebar space move");
  assert.equal(db.getTask("prepare-input")!.cwd, old, "preparation must not poison task cwd with desired directory while busy");
  busy.delete("prepare-input"); await open(svc, "prepare-input", true);
  assert.equal(prepareTaskWorkspace(db, workspace, failures, "prepare-input", "next-reply", authoritative), next);
  assert.equal(db.getTask("prepare-input")!.cwd, next);
  const missing = join(root, "unavailable-space");
  assert.throws(() => prepareTaskWorkspace(db, workspace, failures, "prepare-input", "failed-reply", () => {
    throw new WorkspacePathError("new-space", missing, "workspace-path-missing");
  }), WorkspacePathError);
  const failure = failures.list("prepare-input")[0]!;
  assert.equal(failure.causeCode, "workspace-path-missing"); assert.equal(failure.target, missing);
  assert.equal(failure.assistantMessageId, "failed-reply"); assert.equal(failure.resolvedAt, undefined);
  prepareTaskWorkspace(db, workspace, failures, "prepare-input", "recovered-reply", authoritative);
  assert(failures.list("prepare-input")[0]!.resolvedAt, "successful authoritative resolution clears workspace failure normally");
  console.log("PASS real request preparation pins busy cwd, adopts idle move, and retains failure/recovery recording");

  task("sql-failure"); await open(svc, "sql-failure"); desired.set("sql-failure", next);
  db.connection.exec("CREATE TRIGGER fail_workspace_projection BEFORE UPDATE OF cwd ON durable_bot_bindings WHEN NEW.task_id='sql-failure' BEGIN SELECT RAISE(ABORT,'injected projection failure'); END");
  await assert.rejects(open(svc, "sql-failure"), /injected projection failure/);
  assert.equal(binding("sql-failure").cwd, old); assert(intent("sql-failure"));
  assert(created.filter(item => item.taskId === "sql-failure" && item.cwd === next).every(item => item.closed), "failed projection must release newly opened runtime lease");
  db.connection.exec("DROP TRIGGER fail_workspace_projection");
  await open(svc, "sql-failure"); assert.equal(binding("sql-failure").cwd, next); assert.equal(intent("sql-failure"), undefined);
  console.log("PASS SQLite rollback retains migration intent and closes orphan runtime");
} finally { await svc.close(); DurableBotRuntime.open = originalOpen; db.close(); }
console.log("durable workspace binding service tests passed");
