/**
 * P1.5 任务执行工作区生命周期测试（Batch 9）
 *
 * 覆盖《P0-task-project-isolation-fix.md》§16：
 *  - archive 不移动目录
 *  - trash：direct-child + manifest 校验 → move 到 trash → DB 标记；保留 task 行
 *  - restore：冲突停止；成功移回
 *  - purge：期限前拒绝；force/到期后清理 trash + task 行
 *  - orphan 扫描只报告；moveOrphanToTrash；adopt
 *  - 不操作真实 ~/.mybuddy
 *
 * 运行：pnpm run test:task-workspace-lifecycle
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import {
  TaskLifecycleConflictError,
  TaskLifecycleError,
  TaskExecutionWorkspaceLifecycle,
} from "../src/main/task/TaskExecutionWorkspaceLifecycle";
import {
  MANIFEST_FILENAME,
  TaskExecutionWorkspace,
  getTaskDirectoryName,
} from "../src/main/task/TaskExecutionWorkspace";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

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
  const root = mkdtempSync(join(tmpdir(), "mybuddy-lifecycle-"));
  const workspacesRoot = join(root, "task-workspaces");
  const trashRoot = join(root, "task-workspaces-trash");
  mkdirSync(workspacesRoot, { recursive: true });
  mkdirSync(trashRoot, { recursive: true });
  const db = new AppDatabase(join(root, "app.db"));
  const workspace = new TaskExecutionWorkspace(workspacesRoot);
  const purged: string[] = [];
  const lifecycle = new TaskExecutionWorkspaceLifecycle({
    db,
    workspace,
    trashRoot,
    purgeAfterMs: 60_000,
    onPurgeArtifacts: (taskId) => {
      purged.push(taskId);
    },
  });
  return {
    root,
    workspacesRoot,
    trashRoot,
    db,
    workspace,
    lifecycle,
    purged,
    close: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

async function main(): Promise<void> {
  await check("archive：只改状态，目录与文件不动", async () => {
    const env = makeEnv();
    try {
      const id = "life-archive";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "note.md"), "keep");
      env.db.upsertTask({ id, title: "归档测", updatedAt: Date.now(), cwd: dir });

      const row = env.lifecycle.archive(id);
      assert.equal(row.state, "archived");
      assert.ok(existsSync(join(dir, "note.md")), "归档不得移动/删除文件");
      assert.equal(env.db.getTask(id)?.archived, true);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.state, "archived");

      env.lifecycle.unarchive(id);
      assert.equal(env.db.getTask(id)?.archived, false);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.state, "active");
      assert.ok(existsSync(join(dir, "note.md")));
    } finally {
      env.close();
    }
  });

  await check("trash：move 到回收区 + 保留 task 行 + 幂等", async () => {
    const env = makeEnv();
    try {
      const id = "life-trash";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "work.md"), "data");
      env.db.upsertTask({ id, title: "删除测", updatedAt: Date.now(), cwd: dir });

      const r1 = await env.lifecycle.trash(id);
      assert.equal(r1.state, "trashed");
      assert.equal(r1.directoryMissing, false);
      assert.ok(r1.trashPath && existsSync(r1.trashPath));
      assert.ok(existsSync(join(r1.trashPath!, "work.md")), "文件应在回收区");
      assert.ok(!existsSync(dir), "工作区下应已搬走");
      assert.ok(env.db.getTask(id), "task 行必须保留至 purge");
      assert.equal(env.db.getTask(id)?.archived, true);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.state, "trashed");
      assert.ok(env.db.getTaskExecutionWorkspaceState(id)?.purgeAfter);

      // 幂等
      const r2 = await env.lifecycle.trash(id);
      assert.equal(r2.state, "trashed");
      assert.equal(r2.trashPath, r1.trashPath);
    } finally {
      env.close();
    }
  });

  await check("trash：无目录时仅标记 metadata", async () => {
    const env = makeEnv();
    try {
      const id = "life-nodir";
      env.db.upsertTask({ id, title: "无目录", updatedAt: Date.now() });
      const r = await env.lifecycle.trash(id);
      assert.equal(r.directoryMissing, true);
      assert.equal(r.trashPath, undefined);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.state, "trashed");
      assert.ok(env.db.getTask(id));
    } finally {
      env.close();
    }
  });

  await check("trash：manifest 冲突拒绝，不移动", async () => {
    const env = makeEnv();
    try {
      const id = "life-mismatch";
      const dir = env.workspace.resolveTaskExecutionWorkspaceDir(id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, MANIFEST_FILENAME),
        JSON.stringify({ version: 1, taskId: "other-task", createdAt: 1 }),
      );
      writeFileSync(join(dir, "x.md"), "x");
      env.db.upsertTask({ id, title: "冲突", updatedAt: Date.now(), cwd: dir });

      await assert.rejects(() => env.lifecycle.trash(id), /清单|taskId|不匹配|占用/);
      assert.ok(existsSync(join(dir, "x.md")), "拒绝后目录必须仍在原位");
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.state, undefined);
    } finally {
      env.close();
    }
  });

  await check("restore：移回工作区 + 解归档", async () => {
    const env = makeEnv();
    try {
      const id = "life-restore";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "a.md"), "a");
      env.db.upsertTask({ id, title: "恢复", updatedAt: Date.now(), cwd: dir });

      const trashed = await env.lifecycle.trash(id);
      assert.ok(!existsSync(dir));

      const restored = env.lifecycle.restore(id);
      assert.equal(restored.state, "active");
      assert.ok(existsSync(join(dir, "a.md")));
      assert.ok(existsSync(join(dir, MANIFEST_FILENAME)));
      assert.equal(env.db.getTask(id)?.archived, false);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.state, "active");
      assert.equal(env.db.getTask(id)?.cwd, dir);
      if (trashed.trashPath) assert.ok(!existsSync(trashed.trashPath));
    } finally {
      env.close();
    }
  });

  await check("restore：目标被其他任务占用 → 冲突停止", async () => {
    const env = makeEnv();
    try {
      const id = "life-conflict";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "a.md"), "a");
      env.db.upsertTask({ id, title: "冲突恢复", updatedAt: Date.now(), cwd: dir });
      const trashed = await env.lifecycle.trash(id);
      assert.ok(trashed.trashPath);

      // 在原位置放上其他任务的 manifest
      mkdirSync(dir, { recursive: true });
      writeFileSync(
        join(dir, MANIFEST_FILENAME),
        JSON.stringify({ version: 1, taskId: "intruder", createdAt: 1 }),
      );

      assert.throws(() => env.lifecycle.restore(id), TaskLifecycleConflictError);
      assert.ok(existsSync(trashed.trashPath!), "冲突时 trash 副本不得被删");
      assert.equal(env.db.getTaskExecutionWorkspaceState(id)?.state, "trashed");
    } finally {
      env.close();
    }
  });

  await check("purge：期限前拒绝；force 永久清理", async () => {
    const env = makeEnv();
    try {
      const id = "life-purge";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "p.md"), "p");
      env.db.upsertTask({ id, title: "purge", updatedAt: Date.now(), cwd: dir });
      const trashed = await env.lifecycle.trash(id);

      await assert.rejects(() => env.lifecycle.purge(id), /purge 期限/);
      assert.ok(trashed.trashPath && existsSync(trashed.trashPath));

      const purged = await env.lifecycle.purge(id, { force: true });
      assert.equal(purged.removedTaskRow, true);
      assert.equal(purged.removedTrashDir, true);
      assert.ok(!existsSync(trashed.trashPath!));
      assert.equal(env.db.getTask(id), undefined);
      assert.equal(env.db.getTaskExecutionWorkspaceState(id), undefined);
      assert.ok(env.purged.includes(id));
    } finally {
      env.close();
    }
  });

  await check("purgeExpired：只清到期项", async () => {
    const env = makeEnv();
    try {
      const id = "life-expired";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      writeFileSync(join(dir, "e.md"), "e");
      env.db.upsertTask({ id, title: "expired", updatedAt: Date.now(), cwd: dir });
      await env.lifecycle.trash(id);

      // 人为把 purge_after 调到过去
      const st = env.db.getTaskExecutionWorkspaceState(id)!;
      env.db.upsertTaskExecutionWorkspaceState({ ...st, purgeAfter: Date.now() - 1 });

      const results = await env.lifecycle.purgeExpired();
      assert.equal(results.length, 1);
      assert.equal(results[0].taskId, id);
      assert.equal(env.db.getTask(id), undefined);
    } finally {
      env.close();
    }
  });

  await check("orphan：扫描 / 移入回收区 / 认领", async () => {
    const env = makeEnv();
    try {
      // 有 manifest 但无 task 行
      const ghostId = "ghost-task";
      const ghostDir = env.workspace.ensureTaskExecutionWorkspace(ghostId);
      writeFileSync(join(ghostDir, "g.md"), "g");
      // 故意不建 task 行

      // 无 manifest 目录
      const bare = join(env.workspacesRoot, "random-folder");
      mkdirSync(bare, { recursive: true });
      writeFileSync(join(bare, "x.txt"), "x");

      const reports = env.lifecycle.scanOrphans();
      assert.ok(reports.some((r) => r.manifestTaskId === ghostId && r.reason === "no_task_row"));
      assert.ok(reports.some((r) => r.directoryName === "random-folder" && r.reason === "manifest_missing"));

      // 正常任务目录不应报孤儿
      const okId = "ok-task";
      const okDir = env.workspace.ensureTaskExecutionWorkspace(okId);
      env.db.upsertTask({ id: okId, title: "ok", updatedAt: Date.now(), cwd: okDir });
      const reports2 = env.lifecycle.scanOrphans();
      assert.ok(!reports2.some((r) => r.manifestTaskId === okId));

      // 认领 ghost：先补 task 行再 adopt
      env.db.upsertTask({ id: ghostId, title: "ghost", updatedAt: Date.now() });
      const adopted = env.lifecycle.adoptOrphan(getTaskDirectoryName(ghostId), ghostId);
      assert.equal(adopted.taskId, ghostId);
      assert.equal(env.db.getTaskExecutionWorkspaceState(ghostId)?.state, "active");
      assert.equal(env.db.getTask(ghostId)?.cwd, env.workspace.resolveTaskExecutionWorkspaceDir(ghostId));

      // bare 移入 trash
      const moved = env.lifecycle.moveOrphanToTrash("random-folder");
      assert.ok(existsSync(moved.trashPath));
      assert.ok(!existsSync(bare));
    } finally {
      env.close();
    }
  });

  await check("非 active 状态：trashed 任务不可 archive", async () => {
    const env = makeEnv();
    try {
      const id = "life-no-arch";
      const dir = env.workspace.ensureTaskExecutionWorkspace(id);
      env.db.upsertTask({ id, title: "t", updatedAt: Date.now(), cwd: dir });
      await env.lifecycle.trash(id);
      assert.throws(() => env.lifecycle.archive(id), TaskLifecycleError);
    } finally {
      env.close();
    }
  });

  const failed = results.filter((r) => !r.ok);
  console.log("");
  console.log("------------------------------------------------------------------------");
  console.log(`task-workspace-lifecycle: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length) {
    for (const f of failed) console.error(`  FAIL ${f.name}: ${f.detail}`);
  }
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
