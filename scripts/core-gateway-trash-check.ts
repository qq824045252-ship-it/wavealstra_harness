import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { encodeCronPlan } from "../src/main/db/CronPlanPersistence";
import { gatewayChannelDirectory } from "../src/main/gateway/gateway-task-space";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";
import { TaskExecutionWorkspaceLifecycle } from "../src/main/task/TaskExecutionWorkspaceLifecycle";

const interrupted = process.argv[3];
const root = process.argv[4] ?? mkdtempSync(join(tmpdir(), "mybuddy-gateway-trash-"));
const exe = resolve(process.argv[2] ?? "out/native/linux-x64/mybuddy-runtime-audit");
const path = join(root, "app.duckdb");
if (!interrupted) await initializeCoreDatabase(exe, root, path, CURRENT_DATABASE_SCHEMA_VERSION);
const db = await AppDatabase.open(path, { runtimeAuditExecutable: exe, runtimeAuditSupervised: true });
try {
  const core = db.runtimeAuditReader!;
  const ordinary = new TaskExecutionWorkspace(join(root, "ordinary"));
  const bots = new DurableBotService({ db, agentDir: join(root, "agent"), mcpDir: join(root, "mcp"),
    get models(): never { throw new Error("回收与恢复不应打开模型"); },
    instructions: () => "", toolMode: () => "native", resolveCwd: id => ordinary.resolveTaskExecutionWorkspaceDir(id),
    defaultModel: () => undefined, emit: () => {} });
  const cron = new CronService(db, new Proxy({} as CronAgent, { get() { throw new Error("回收不应调用模型"); } }));
  const lifecycle = new TaskExecutionWorkspaceLifecycle({ db, workspace: ordinary, trashRoot: join(root, "trash"),
    beforeTrash: async id => { await cron.withPlanMaintenance(() => cron.disableTask(id)); await bots.release(id); },
    prepareGatewayWorkspaceRestore: (id, from, to) => bots.prepareGatewayTrashRestore(id, from, to) });
  if (interrupted) {
    const id = process.argv[5], source = process.argv[6];
    const rename = fs.renameSync;
    fs.renameSync = (from, to) => {
      rename(from, to);
      if (from === source) process.kill(process.pid, "SIGKILL");
    };
    syncBuiltinESMExports();
    if (interrupted === "trash") await lifecycle.trash(id);
    else await lifecycle.restoreFromTrash(id);
    throw new Error("child did not reach the expected directory rename");
  }
  async function interrupt(operation: string, id: string, source: string) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), exe, operation, root, id, source], {stdio:"inherit"});
    const signal = await new Promise<NodeJS.Signals | null>((ok, fail) => {
      child.once("error", fail);
      child.once("exit", (_code, signal) => ok(signal));
    });
    assert.equal(signal,"SIGKILL");
  }
  const peerRoot = gatewayChannelDirectory(db, "discord-default", true);
  const channel = "qq-default";
  const home = gatewayChannelDirectory(db, channel, true);
  const ws = new TaskExecutionWorkspace(home);
  for (const [index, mode] of ["canonical", "legacy", "foreign"].entries()) {
    const id = "gateway-chat-" + String(index + 1).repeat(64);
    const target = ws.resolveTaskExecutionWorkspaceDir(id);
    const owner = mode === "legacy" ? ordinary : mode === "foreign" ? new TaskExecutionWorkspace(peerRoot) : ws;
    const from = owner.ensureTaskExecutionWorkspace(id);
    writeFileSync(join(from, "content"), id);
    const at = Date.now();
    assert.equal((await core.upsertTaskRecord({ id, title: id, cwd: from, at, preserveTitle: false, preserveWorkspace: false }))?.status, "saved");
    assert.deepEqual(await core.batch4aWrite({ kind: "gatewayBindConversationSpace", taskId: id, channelId: channel,
      rootSpaceId: "sp-gw-root", rootSpaceName: "Gateway", childSpaceId: "sp-gw-" + channel,
      childSpaceName: "QQ", childSpacePath: home, bindSidebar: true, updateTaskSpace: true, now: at }), { ok: true });
    assert.equal((await core.writeDurableTaskProjection({ kind: "bindBot", taskId: id, cwd: from,
      directory: join(home, "durable-" + id) }))?.status, "applied");
    if (mode === "foreign") {
      await assert.rejects(lifecycle.trash(id), /不属于/);
      assert.equal(readFileSync(join(from, "content"), "utf8"), id);
      assert.equal((await core.readTaskWorkspaceAuthority(id))?.archived, false);
      console.log("PASS foreign channel cwd rejected before moving bytes");
      continue;
    }
    const jobId = "job-" + id;
    assert.equal(await core.writeCronPlan({ kind: "save", expected: null, row: encodeCronPlan({
      id: jobId, name: "Gateway task plan", prompt: "Fixture", scheduleType: "every", scheduleExpr: "1h",
      timezone: "UTC", enabled: true, sourceTaskId: id, target: { kind: "task", taskId: id }, createdAt: at, updatedAt: at,
    }) }), true);
    await interrupt("trash", id, from);
    assert.equal(existsSync(from), false);
    await lifecycle.recoverGatewayRenames();
    assert.equal((await core.readTaskWorkspaceAuthority(id))?.trashed, true);
    const trashed = await lifecycle.trash(id);
    assert(trashed.trashPath);
    assert.equal((await db.readCronJobState(jobId))?.job.enabled, false);
    assert.equal(existsSync(from), false);
    assert.equal((await core.readTaskWorkspaceAuthority(id))?.trashed, true);
    assert.equal(readFileSync(join(trashed.trashPath, "content"), "utf8"), id);
    mkdirSync(target);
    writeFileSync(join(target, "keep"), "collision");
    await assert.rejects(lifecycle.restoreFromTrash(id), /不覆盖/);
    assert.equal(readFileSync(join(target, "keep"), "utf8"), "collision");
    assert.equal(readFileSync(join(trashed.trashPath, "content"), "utf8"), id);
    rmSync(target, { recursive: true });
    await interrupt("restore", id, trashed.trashPath);
    assert.equal(existsSync(trashed.trashPath), false);
    if (mode === "canonical") {
      const original = target + ".test-original";
      fs.renameSync(target, original);
      mkdirSync(target);
      writeFileSync(join(target, "keep"), "replacement");
      await assert.rejects(lifecycle.restoreFromTrash(id), /回执/);
      assert.equal(readFileSync(join(target, "keep"), "utf8"), "replacement");
      assert.equal((await core.readTaskWorkspaceAuthority(id))?.trashed, true);
      rmSync(target, {recursive:true});
      fs.renameSync(original, target);
    }
    await lifecycle.recoverGatewayRenames();
    assert.equal((await core.readTaskWorkspaceAuthority(id))?.trashed, false);
    assert.equal(readFileSync(join(target, "content"), "utf8"), id);
    const auth = await core.readTaskWorkspaceAuthority(id);
    assert(auth && !auth.archived && !auth.trashed);
    assert.equal(auth.spaceId, "sp-gw-" + channel);
    assert.equal((await db.readTask(id))?.gatewaySidebarChannelId, channel);
    assert.equal(auth.binding?.cwd, from);
    assert.equal(auth.cwd, from);
    assert.deepEqual(auth.workspaceMove, mode === "legacy" ? { fromCwd: from, toCwd: target } : null);
    assert.equal(existsSync(trashed.trashPath), false);
    console.log("PASS", mode, "Gateway SIGKILL after both renames, collision rejection and startup recovery preserve contents, channel and durable binding");
  }
  assert.equal(existsSync(join(root, "app.db")), false);
} finally {
  await db.runtimeAuditReader?.close();
  await shutdownCoreWorker(root, path);
  if (!interrupted) rmSync(root, { recursive: true, force: true });
}
