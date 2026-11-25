/**
 * 回收站（recycle bin）保留期与恢复测试。
 *
 * 覆盖用户可见行为：
 *  - 删除 = 移入回收区，保留期默认 7 天（TRASH_RETENTION_DAYS）
 *  - 回收站必须能列出已删除任务（否则既恢复不了、也清不掉 = "删除黑洞"）
 *  - 保留期内可恢复：目录搬回、archived 复位、purgeAfter 清空、任务回到列表
 *  - purgeExpired 只清理已过保留期的条目，未到期的不动
 *  - 彻底删除（force purge）清掉任务行、state 行与回收区目录
 *  - 无目录的 metadata-only 条目同样可列出/恢复
 *  - 不操作真实 ~/.mybuddy
 *
 * 运行：pnpm -s test:task-trash-retention
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { TRASH_RETENTION_DAYS, TRASH_RETENTION_MS } from "../src/shared/archive-deletion";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import {
  DEFAULT_PURGE_AFTER_MS,
  TaskExecutionWorkspaceLifecycle,
} from "../src/main/task/TaskExecutionWorkspaceLifecycle";
import { TaskExecutionWorkspace } from "../src/main/task/TaskExecutionWorkspace";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const useNative = process.argv.includes("--native");
const runtimeAuditExecutable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
if (useNative) assert.ok(runtimeAuditExecutable && existsSync(runtimeAuditExecutable));

async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    results.push({ name, ok: false, detail });
    console.error(`FAIL  ${name}\n      ${detail}`);
  }
}

function makeEnv() {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-trash-"));
  const workspacesRoot = join(root, "task-workspaces");
  const trashRoot = join(root, "task-workspaces-trash");
  mkdirSync(workspacesRoot, { recursive: true });
  mkdirSync(trashRoot, { recursive: true });
  const db = new AppDatabase(join(root, "app.db"), { runtimeAuditExecutable });
  const workspace = new TaskExecutionWorkspace(workspacesRoot);
  const purged: string[] = [];
  // 故意不传 purgeAfterMs：断言生产默认保留期
  const lifecycle = new TaskExecutionWorkspaceLifecycle({
    db,
    workspace,
    trashRoot,
    onPurgeArtifacts: (taskId) => {
      purged.push(taskId);
    },
  });
  return {
    root,
    db,
    workspace,
    lifecycle,
    purged,
    close: async () => {
      await db.runtimeAuditReader?.close();
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  await check("保留期默认 7 天", () => {
    assert.equal(TRASH_RETENTION_DAYS, 7);
    assert.equal(TRASH_RETENTION_MS, 7 * 24 * 60 * 60 * 1000);
    assert.equal(DEFAULT_PURGE_AFTER_MS, TRASH_RETENTION_MS, "默认 purge 期限必须用 7 天保留期");
  });

  await check("回收站可见：7 天后到期，且任务不出现在正常列表", async () => {
    const env = makeEnv();
    try {
      const id = "trash-visible";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "work.md"), "data");
      const now = Date.now();
      env.db.upsertTask({ id, title: "回收站可见", updatedAt: now, cwd: dir });

      const trashed = await env.lifecycle.trash(id);
      assert.equal(trashed.state, "trashed");
      assert.ok(trashed.trashPath && existsSync(trashed.trashPath), "保留期内必须留下可恢复的目录副本");

      const state = env.db.getTaskExecutionWorkspaceState(id)!;
      env.db.upsertTaskExecutionWorkspaceState({ ...state, trashPath: join(env.root, "old-trash", basename(trashed.trashPath)) });
      if (useNative) env.db.connection.exec("CREATE TEMP TABLE tasks AS SELECT * FROM main.tasks WHERE 0");
      const entry = (await env.lifecycle.listTrashedTasks()).find((item) => item.id === id);
      if (useNative) env.db.connection.exec("DROP TABLE temp.tasks");
      assert.ok(entry, "回收站必须列出已删除任务（否则就是删除黑洞）");
      assert.equal(entry.title, "回收站可见");
      assert.equal(entry.directoryMissing, false);
      assert.ok(entry.trashedAt && Math.abs(entry.trashedAt - now) < 60_000, "必须记录删除时间");
      assert.ok(entry.purgeAfter, "必须写入到期时间");
      assert.equal(entry.purgeAfter! - entry.trashedAt!, TRASH_RETENTION_MS, "到期 = 删除时间 + 7 天");
      assert.ok(
        !env.db.listNonTrashedTasks().some((task) => task.id === id),
        "已删除任务不得出现在正常任务列表",
      );
    } finally {
      await env.close();
    }
  });

  await check("保留期内可恢复：目录搬回、archived 复位、purgeAfter 清空", async () => {
    const env = makeEnv();
    try {
      const id = "trash-restore";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "work.md"), "data");
      env.db.upsertTask({ id, title: "可恢复", updatedAt: Date.now(), cwd: dir });
      await env.lifecycle.trash(id);

      if (useNative) env.db.connection.pragma("query_only = ON");
      await env.lifecycle.restoreFromTrash(id);

      const state = env.db.getTaskExecutionWorkspaceState(id);
      assert.equal(state?.state, "active");
      assert.equal(state?.purgeAfter, undefined, "恢复后必须清空到期时间");
      assert.equal(state?.trashPath, undefined);
      assert.equal(env.db.getTask(id)?.archived, false, "恢复后不得仍标记归档");
      assert.ok(env.db.listNonTrashedTasks().some((task) => task.id === id), "恢复后必须回到任务列表");
      assert.deepEqual(await env.lifecycle.listTrashedTasks(), [], "恢复后不得再列在回收站");
      assert.ok(existsSync(join(dir, "work.md")), "恢复后文件必须回到工作区");
    } finally {
      await env.close();
    }
  });

  await check("恢复写入失败：任务及回收目录保持可再次恢复", async () => {
    const env = makeEnv();
    try {
      const id = "trash-restore-retry";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "work.md"), "retained contents");
      env.db.upsertTask({ id, title: "恢复失败后可重试", updatedAt: Date.now(), cwd: dir });
      const { trashPath } = await env.lifecycle.trash(id);
      assert.ok(trashPath);
      env.db.connection.exec(`CREATE TRIGGER reject_task_restore BEFORE UPDATE OF archived ON tasks
        WHEN OLD.id='trash-restore-retry' AND NEW.archived=0 BEGIN SELECT RAISE(ABORT,'restore fixture failure'); END`);
      if (useNative) env.db.connection.pragma("query_only = ON");

      await assert.rejects(env.lifecycle.restoreFromTrash(id), /restore fixture failure/);
      assert.equal(env.db.getTask(id)?.archived, true);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.trashPath, trashPath);
      assert.equal(existsSync(dir), false);
      assert.equal(readFileSync(join(trashPath, "work.md"), "utf8"), "retained contents");

      if (useNative) env.db.connection.pragma("query_only = OFF");
      env.db.connection.exec("DROP TRIGGER reject_task_restore");
      if (useNative) env.db.connection.pragma("query_only = ON");
      const restoration = env.lifecycle.restoreFromTrash(id);
      const purge = assert.rejects(env.lifecycle.purge(id, { force: true }), /回收站操作尚未结束|仅可 purge 回收区任务/);
      await Promise.all([purge, restoration]);
      assert.equal(env.db.getTask(id)?.archived, false);
      assert.equal(readFileSync(join(dir, "work.md"), "utf8"), "retained contents");
    } finally {
      await env.close();
    }
  });

  await check("purgeExpired 只清理已过保留期的条目", async () => {
    const env = makeEnv();
    try {
      const expiredId = "trash-expired";
      const freshId = "trash-fresh";
      env.db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES('review','设备复核',1,1)").run();
      for (const [id, title] of [[expiredId, "已过期"], [freshId, "未过期"]] as const) {
        const dir = env.workspace.ensureTaskExecutionWorkspace(id);
        env.db.upsertTask({ id, title, updatedAt: Date.now(), cwd: dir, projectId: "review" });
        await env.lifecycle.trash(id);
      }
      // 把其中一个的到期时间改到过去，模拟"7 天已过"
      const expiredRow = env.db.getTaskExecutionWorkspaceState(expiredId)!;
      env.db.upsertTaskExecutionWorkspaceState({ ...expiredRow, purgeAfter: Date.now() - 1_000 });

      const purged = await env.lifecycle.purgeExpired();
      assert.deepEqual(purged, [{ taskId: expiredId, projectId: "review", removedTrashDir: true, removedTaskRow: true }]);

      assert.equal(env.db.getTask(expiredId), undefined, "过期任务行应被删除");
      assert.equal(env.db.getTaskExecutionWorkspaceState(expiredId), undefined);
      assert.ok(env.db.getTask(freshId), "未到期任务必须保留");
      assert.deepEqual((await env.lifecycle.listTrashedTasks()).map(item => [item.id, item.projectId]), [[freshId, "review"]]);
    } finally {
      await env.close();
    }
  });

  await check("彻底删除：force purge 清掉任务行、state 行与回收区目录", async () => {
    const env = makeEnv();
    try {
      const id = "trash-purge";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "work.md"), "data");
      env.db.upsertTask({ id, title: "彻底删除", updatedAt: Date.now(), cwd: dir });
      const trashed = await env.lifecycle.trash(id);
      assert.ok(trashed.trashPath && existsSync(trashed.trashPath));

      env.db.connection.exec(`CREATE TRIGGER reject_task_purge BEFORE DELETE ON tasks WHEN OLD.id='trash-purge'
        BEGIN SELECT RAISE(ABORT, 'purge fixture failure'); END`);
      env.db.connection.prepare(`INSERT INTO memory_turns (id,task_id,user_text,assistant_text,content_hash,captured_at)
        VALUES ('purge-turn',?,'原文','回答','hash',1)`).run(id);
      if (useNative) env.db.connection.pragma("query_only = ON");
      await assert.rejects(env.lifecycle.purge(id, { force: true }), /purge fixture failure/);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.state, "trashed");
      assert.deepEqual(env.db.connection.prepare("SELECT user_text FROM memory_turns WHERE id='purge-turn'").get(), { user_text: "原文" });
      if (useNative) env.db.connection.pragma("query_only = OFF");
      env.db.connection.exec("DROP TRIGGER reject_task_purge");
      if (useNative) env.db.connection.pragma("query_only = ON");
      await env.lifecycle.purge(id, { force: true });

      assert.equal(env.db.getTask(id), undefined);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id), undefined);
      assert.ok(!existsSync(trashed.trashPath!), "purge 必须清掉回收区目录");
      assert.equal(env.db.connection.prepare("SELECT id FROM memory_turns WHERE id='purge-turn'").get(), undefined);
      assert.deepEqual(await env.lifecycle.listTrashedTasks(), []);
      assert.deepEqual(env.purged, [id, id], "失败后重试仍会核对附属内容");
    } finally {
      await env.close();
    }
  });

  await check("metadata-only 条目（无工作目录）同样可列出与恢复", async () => {
    const env = makeEnv();
    try {
      const id = "trash-nodir";
      env.db.upsertTask({ id, title: "无目录", updatedAt: Date.now() });
      const trashed = await env.lifecycle.trash(id);
      assert.equal(trashed.directoryMissing, true);

      const entry = (await env.lifecycle.listTrashedTasks()).find((item) => item.id === id);
      assert.ok(entry, "无目录也必须可见（否则无法彻底清理）");
      assert.equal(entry.directoryMissing, true);

      if (useNative) env.db.connection.pragma("query_only = ON");
      await env.lifecycle.restoreFromTrash(id);
      assert.deepEqual(await env.lifecycle.listTrashedTasks(), []);
      assert.ok(env.db.listNonTrashedTasks().some((task) => task.id === id));
    } finally {
      await env.close();
    }
  });

  await check("存量对齐：只缩短旧的 30 天期限，不延长", async () => {
    const env = makeEnv();
    try {
      const legacyId = "trash-legacy";
      const freshId = "trash-fresh-align";
      for (const id of [legacyId, freshId]) {
        const dir = env.workspace.ensureTaskExecutionWorkspace(id);
        env.db.upsertTask({ id, title: id, updatedAt: Date.now(), cwd: dir });
        await env.lifecycle.trash(id);
      }
      // 旧策略存量：到期时间仍是 trashedAt + 30 天
      const legacy = env.db.getTaskExecutionWorkspaceState(legacyId)!;
      const legacyTrashedAt = legacy.trashedAt!;
      env.db.upsertTaskExecutionWorkspaceState({ ...legacy, purgeAfter: legacyTrashedAt + 30 * 24 * 60 * 60 * 1000 });
      // 已过期的条目：对齐不得把它往后推
      const fresh = env.db.getTaskExecutionWorkspaceState(freshId)!;
      const pastDeadline = Date.now() - 60_000;
      env.db.upsertTaskExecutionWorkspaceState({ ...fresh, purgeAfter: pastDeadline });

      if (useNative) env.db.connection.pragma("query_only = ON");
      const changed = await env.lifecycle.alignTrashRetention();
      assert.equal(await env.lifecycle.alignTrashRetention(), 0, "再次对齐不应改写任何条目");
      assert.equal(changed, 1, "只有被延长的旧条目需要改写");
      assert.equal(
        env.db.getTaskExecutionWorkspaceState(legacyId)?.purgeAfter,
        legacyTrashedAt + TRASH_RETENTION_MS,
        "存量必须收敛到 trashedAt + 7 天",
      );
      assert.equal(
        env.db.getTaskExecutionWorkspaceState(freshId)?.purgeAfter,
        pastDeadline,
        "已过期的条目不得被延长",
      );
    } finally {
      await env.close();
    }
  });

  const failed = results.filter((result) => !result.ok);
  console.log("");
  console.log("------------------------------------------------------------------------");
  console.log(`task-trash-retention: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    for (const failure of failed) console.error(`  FAIL ${failure.name}: ${failure.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
