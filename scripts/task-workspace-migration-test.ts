/**
 * TaskExecutionWorkspace 的目录改名和路径修复回归测试。
 * 使用临时工作目录与 SQLite 行为夹具。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { mapLegacyRootPath, migrateLegacyTaskWorkspacesDirs } from "../src/main/paths";
import {
  MANIFEST_FILENAME,
  TaskExecutionWorkspace,
  getTaskDirectoryName,
} from "../src/main/task/TaskExecutionWorkspace";
import { TaskExecutionWorkspaceLifecycle } from "../src/main/task/TaskExecutionWorkspaceLifecycle";

const cases: Array<{ name: string; run: () => void | Promise<void> }> = [];

function check(name: string, run: () => void | Promise<void>): void {
  cases.push({ name, run });
}

function tableExists(db: AppDatabase, name: string): boolean {
  return (
    db.connection.prepare(`SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !==
    undefined
  );
}

function rowCount(db: AppDatabase, name: string): number {
  return (db.connection.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c;
}

check("DB：全新库无旧表 → 新表可用，无迁移残留", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-db-new-"));
  try {
    const db = new AppDatabase(join(root, "fresh.db"));
    try {
      assert.ok(tableExists(db, "task_execution_workspace_state"));
      assert.ok(!tableExists(db, "task_project_state"));
      assert.equal(rowCount(db, "task_execution_workspace_state"), 0);
      db.upsertTaskExecutionWorkspaceState({
        taskId: "x",
        directoryName: "x--h",
        state: "active",
        createdAt: 1,
        updatedAt: 1,
      });
      assert.equal(db.getTaskExecutionWorkspaceState("x")?.state, "active");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 2. FS 目录迁移：projects → task-workspaces（含回收区）                 */
/* ------------------------------------------------------------------ */

check("FS：legacy 目录一次性改名迁移，内容完整", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-fs-"));
  try {
    const myBuddy = join(root, "home", ".mybuddy");
    const legacyWs = join(myBuddy, "projects");
    const legacyTrash = join(myBuddy, "projects-trash");
    const taskDir = join(legacyWs, "my-task--abcdef1234567890");
    mkdirSync(taskDir, { recursive: true });
    writeFileSync(join(taskDir, MANIFEST_FILENAME), JSON.stringify({ version: 1, taskId: "my-task", createdAt: 1 }));
    writeFileSync(join(taskDir, "notes.md"), "keep me");
    mkdirSync(join(legacyTrash, "old-task--deadbeef"), { recursive: true });
    writeFileSync(join(legacyTrash, "old-task--deadbeef", "x.txt"), "trash content");

    const dirs = migrateLegacyTaskWorkspacesDirs(myBuddy);
    assert.equal(dirs.workspacesDir, join(myBuddy, "task-workspaces"));
    assert.equal(dirs.trashDir, join(myBuddy, "task-workspaces-trash"));
    assert.ok(!existsSync(legacyWs), "旧工作区目录已改名");
    assert.ok(!existsSync(legacyTrash), "旧回收区目录已改名");
    assert.ok(existsSync(join(myBuddy, "task-workspaces", "my-task--abcdef1234567890", "notes.md")), "任务文件随迁");
    assert.ok(existsSync(join(myBuddy, "task-workspaces-trash", "old-task--deadbeef", "x.txt")), "回收内容随迁");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("FS：新旧目录并存 → 使用新目录，旧目录原样保留（不删除）", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-fs-both-"));
  try {
    const myBuddy = join(root, "home", ".mybuddy");
    mkdirSync(join(myBuddy, "projects", "stale-dir"), { recursive: true });
    writeFileSync(join(myBuddy, "projects", "stale-dir", "stale.md"), "stale");
    mkdirSync(join(myBuddy, "task-workspaces", "live-dir"), { recursive: true });
    writeFileSync(join(myBuddy, "task-workspaces", "live-dir", "live.md"), "live");

    const dirs = migrateLegacyTaskWorkspacesDirs(myBuddy);
    assert.equal(dirs.workspacesDir, join(myBuddy, "task-workspaces"));
    assert.ok(existsSync(join(myBuddy, "projects", "stale-dir", "stale.md")), "旧目录数据保留不动");
    assert.ok(existsSync(join(myBuddy, "task-workspaces", "live-dir", "live.md")), "新目录继续使用");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("FS：迁移幂等（重复调用不再改动）", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-fs-idem-"));
  try {
    const myBuddy = join(root, "home", ".mybuddy");
    mkdirSync(join(myBuddy, "projects", "t1--hash"), { recursive: true });
    writeFileSync(join(myBuddy, "projects", "t1--hash", "a.md"), "a");
    const first = migrateLegacyTaskWorkspacesDirs(myBuddy);
    const second = migrateLegacyTaskWorkspacesDirs(myBuddy);
    assert.equal(first.workspacesDir, second.workspacesDir);
    assert.ok(existsSync(join(myBuddy, "task-workspaces", "t1--hash", "a.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 3. 旧 tasks.cwd 兼容：目录改名后 ensure 幂等 + cwd 重绑                */
/* ------------------------------------------------------------------ */

check("旧 tasks.cwd 指向旧目录：迁移后 ensureTaskExecutionWorkspace 幂等命中，文件不丢，cwd 重绑", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-cwd-"));
  try {
    const myBuddy = join(root, "home", ".mybuddy");
    const legacyWs = join(myBuddy, "projects");
    const taskId = "old-task-42";
    const dirName = getTaskDirectoryName(taskId);
    const oldTaskDir = join(legacyWs, dirName);
    mkdirSync(oldTaskDir, { recursive: true });
    writeFileSync(join(oldTaskDir, MANIFEST_FILENAME), JSON.stringify({ version: 1, taskId, createdAt: 1 }));
    writeFileSync(join(oldTaskDir, "data.md"), "precious");

    const dirs = migrateLegacyTaskWorkspacesDirs(myBuddy);
    const db = new AppDatabase(join(myBuddy, "app.db"));
    try {
      // 模拟升级前绑定：cwd = 旧目录绝对路径
      db.bindTaskExecutionWorkspaceCwd(taskId, join(legacyWs, dirName));
      assert.equal(db.getTask(taskId)!.cwd, join(legacyWs, dirName));

      // 新代码解析：命中已迁移目录（manifest 匹配 → 不重建），再重绑为新路径
      const ws = new TaskExecutionWorkspace(dirs.workspacesDir);
      const canonical = ws.ensureTaskExecutionWorkspace(taskId);
      assert.equal(canonical, join(dirs.workspacesDir, dirName), "canonical = 新根下同名目录");
      assert.ok(existsSync(join(canonical, "data.md")), "旧任务文件随目录迁移仍在");
      assert.equal(ws.readManifest(taskId).taskId, taskId, "manifest 校验通过");
      db.bindTaskExecutionWorkspaceCwd(taskId, canonical);
      assert.equal(db.getTask(taskId)!.cwd, canonical, "cwd 重绑为新路径");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ */
/* 4. 回收区整体改名后：旧 trash_path 经 resolveTrashPath 定位            */
/* ------------------------------------------------------------------ */

function makeTrashCompatEnv(): {
  root: string;
  myBuddy: string;
  legacyTrash: string;
  trashDir: string;
  workspace: TaskExecutionWorkspace;
  db: AppDatabase;
  lifecycle: TaskExecutionWorkspaceLifecycle;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "mig-trash-"));
  const myBuddy = join(root, "home", ".mybuddy");
  const legacyTrash = join(myBuddy, "projects-trash");
  const legacyWs = join(myBuddy, "projects");
  mkdirSync(legacyTrash, { recursive: true });
  mkdirSync(legacyWs, { recursive: true });
  // 先让迁移发生：workspaces 与 trash 都改名
  const dirs = migrateLegacyTaskWorkspacesDirs(myBuddy);
  const db = new AppDatabase(join(myBuddy, "app.db"));
  const workspace = new TaskExecutionWorkspace(dirs.workspacesDir);
  const lifecycle = new TaskExecutionWorkspaceLifecycle({ db, workspace, trashRoot: dirs.trashDir, purgeAfterMs: 60_000 });
  return {
    root,
    myBuddy,
    legacyTrash,
    trashDir: dirs.trashDir,
    workspace,
    db,
    lifecycle,
    cleanup: () => {
      db.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

check("回收区改名后：旧 trash_path 的 restore 仍能找到副本并移回", () => {
  const env = makeTrashCompatEnv();
  try {
    const taskId = "trash-restore-task";
    const dirName = getTaskDirectoryName(taskId);
    // 模拟旧版：任务目录在回收区（迁移前旧路径），DB trash_path 记录旧绝对路径
    const trashCopy = join(env.trashDir, `${dirName}--${Date.now()}`);
    mkdirSync(trashCopy, { recursive: true });
    writeFileSync(join(trashCopy, MANIFEST_FILENAME), JSON.stringify({ version: 1, taskId, createdAt: 1 }));
    writeFileSync(join(trashCopy, "keep.md"), "restore me");
    const staleTrashPath = join(env.legacyTrash, basename(trashCopy)); // 迁移前旧路径（现已不存在）
    assert.ok(!existsSync(staleTrashPath), "旧 trash_path 已失效");

    env.db.upsertTask({ id: taskId, title: "旧回收任务", updatedAt: Date.now() });
    env.db.upsertTaskExecutionWorkspaceState({
      taskId,
      directoryName: dirName,
      state: "trashed",
      createdAt: 1,
      updatedAt: 1,
      trashedAt: Date.now(),
      purgeAfter: Date.now() + 60_000,
      trashPath: staleTrashPath,
    });

    const result = env.lifecycle.restore(taskId);
    assert.equal(result.state, "active");
    const restored = env.workspace.resolveTaskExecutionWorkspaceDir(taskId);
    assert.ok(existsSync(join(restored, "keep.md")), "副本已移回 canonical 工作区");
    assert.ok(!existsSync(trashCopy), "回收区副本已移走");
    assert.equal(env.db.getTaskExecutionWorkspaceState(taskId)!.state, "active");
    assert.equal(env.db.getTask(taskId)!.cwd, restored, "restore 后 cwd 重绑 canonical");
  } finally {
    env.cleanup();
  }
});

check("回收区改名后：旧 trash_path 的 purge(force) 仍能删除副本", async () => {
  const env = makeTrashCompatEnv();
  try {
    const taskId = "trash-purge-task";
    const dirName = getTaskDirectoryName(taskId);
    const trashCopy = join(env.trashDir, `${dirName}--${Date.now()}`);
    mkdirSync(trashCopy, { recursive: true });
    writeFileSync(join(trashCopy, MANIFEST_FILENAME), JSON.stringify({ version: 1, taskId, createdAt: 1 }));
    writeFileSync(join(trashCopy, "bye.md"), "x");
    const staleTrashPath = join(env.legacyTrash, basename(trashCopy));

    env.db.upsertTask({ id: taskId, title: "旧回收任务", updatedAt: Date.now() });
    env.db.upsertTaskExecutionWorkspaceState({
      taskId,
      directoryName: dirName,
      state: "trashed",
      createdAt: 1,
      updatedAt: 1,
      trashedAt: Date.now(),
      purgeAfter: Date.now() - 1, // 已过期
      trashPath: staleTrashPath,
    });

    const purge = await env.lifecycle.purge(taskId);
    assert.equal(purge.removedTrashDir, true, "旧路径副本被找到并删除");
    assert.equal(purge.removedTaskRow, true);
    assert.ok(!existsSync(trashCopy), "回收副本已删除");
    assert.equal(env.db.getTaskExecutionWorkspaceState(taskId), undefined, "state 行已删");
  } finally {
    env.cleanup();
  }
});

/* ------------------------------------------------------------------ */
/* 5. 收口重绑（P1）：rename 成功后 tasks.cwd / trash_path 一次性指向新根    */
/* ------------------------------------------------------------------ */

check("mapLegacyRootPath：旧根边界匹配 + 中间同名片段拒绝 + win32 大小写", () => {
  const legacy = join(tmpdir(), "mb-legacy-projects");
  const next = join(tmpdir(), "mb-next-workspaces");
  const taskDir = join(legacy, "my-task--abcdef1234567890");
  assert.equal(mapLegacyRootPath(legacy, next, taskDir), join(next, "my-task--abcdef1234567890"));
  assert.equal(mapLegacyRootPath(legacy, next, legacy), next, "root 本身映射到新根");
  assert.equal(
    mapLegacyRootPath(legacy, next, join(tmpdir(), "mb-legacy-projects2", "x")),
    null,
    "中间同名片段（projects2/x）不得误改",
  );
  assert.equal(mapLegacyRootPath(legacy, next, next), null, "已在新根下的路径不在旧根下");
  assert.equal(mapLegacyRootPath(legacy, next, join(tmpdir(), "other", "x")), null, "无关路径返回 null");
  // 分隔符混合（正斜杠存储）
  assert.equal(
    mapLegacyRootPath(legacy, next, legacy.replace(/\\/g, "/") + "/my-task--abcdef1234567890"),
    join(next, "my-task--abcdef1234567890"),
    "正斜杠形式同样映射",
  );
  if (process.platform === "win32") {
    assert.equal(
      mapLegacyRootPath(legacy, next, legacy.toUpperCase() + "\\my-task--abcdef1234567890"),
      join(next, "my-task--abcdef1234567890"),
      "win32 大小写不敏感",
    );
  }
});

check("收口：rename 成功后 tasks.cwd / trash_path 直接重绑为新根（不经过 Agent 交互）", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-rebind-"));
  try {
    const myBuddy = join(root, "home", ".mybuddy");
    const legacyWs = join(myBuddy, "projects");
    const legacyTrash = join(myBuddy, "projects-trash");
    const taskId = "rebind-task";
    const dirName = getTaskDirectoryName(taskId);
    const oldTaskDir = join(legacyWs, dirName);
    mkdirSync(oldTaskDir, { recursive: true });
    writeFileSync(join(oldTaskDir, MANIFEST_FILENAME), JSON.stringify({ version: 1, taskId, createdAt: 1 }));
    writeFileSync(join(oldTaskDir, "keep.md"), "data");
    const trashCopyName = `${dirName}--${Date.now()}`;
    mkdirSync(join(legacyTrash, trashCopyName), { recursive: true });
    writeFileSync(
      join(legacyTrash, trashCopyName, MANIFEST_FILENAME),
      JSON.stringify({ version: 1, taskId: "old-trashed", createdAt: 1 }),
    );

    const dbPath = join(myBuddy, "app.db");
    const db1 = new AppDatabase(dbPath);
    db1.upsertTask({ id: taskId, title: "旧任务", updatedAt: Date.now(), cwd: join(legacyWs, dirName) });
    db1.upsertTaskExecutionWorkspaceState({
      taskId: "old-trashed",
      directoryName: dirName,
      state: "trashed",
      createdAt: 1,
      updatedAt: 1,
      trashedAt: Date.now(),
      purgeAfter: Date.now() + 60_000,
      trashPath: join(legacyTrash, trashCopyName),
    });
    db1.close();

    // 模拟 index.ts 启动序列：目录决策 → AppDatabase → 收口重绑
    const migration = migrateLegacyTaskWorkspacesDirs(myBuddy);
    assert.equal(migration.workspacesMigrated, true, "工作区 rename 成功");
    assert.equal(migration.trashMigrated, true, "回收区 rename 成功");

    const db2 = new AppDatabase(dbPath);
    const rebind = db2.rebindLegacyTaskWorkspacePaths(
      migration.legacyWorkspacesDir,
      migration.workspacesDir,
      migration.legacyTrashDir,
      migration.trashDir,
    );
    assert.equal(rebind.cwds, 1, "1 条 cwd 重绑");
    assert.equal(rebind.trashPaths, 1, "1 条 trash_path 重绑");
    assert.equal(db2.getTask(taskId)!.cwd, join(myBuddy, "task-workspaces", dirName), "cwd 已是新根");
    assert.equal(
      db2.getTaskExecutionWorkspaceState("old-trashed")!.trashPath,
      join(myBuddy, "task-workspaces-trash", trashCopyName),
      "trash_path 已是新回收区",
    );
    // 直接重新打开 DB 验证持久化（不经过任何 Agent 交互）
    db2.close();
    const db3 = new AppDatabase(dbPath);
    try {
      assert.equal(db3.getTask(taskId)!.cwd, join(myBuddy, "task-workspaces", dirName), "重开 DB 后 cwd 保持新根");
      assert.equal(
        db3.getTaskExecutionWorkspaceState("old-trashed")!.trashPath,
        join(myBuddy, "task-workspaces-trash", trashCopyName),
        "重开 DB 后 trash_path 保持新回收区",
      );
      assert.equal(db3.getTask(taskId)!.title, "旧任务", "重绑不触碰其他字段");
    } finally {
      db3.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("收口：新旧并存（migrated=false）→ 绝不重绑（旧路径仍存在）", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-rebind-both-"));
  try {
    const myBuddy = join(root, "home", ".mybuddy");
    const legacyWs = join(myBuddy, "projects");
    mkdirSync(join(legacyWs, "stale-dir"), { recursive: true });
    writeFileSync(join(legacyWs, "stale-dir", "stale.md"), "stale");
    mkdirSync(join(myBuddy, "task-workspaces", "live-dir"), { recursive: true });
    writeFileSync(join(myBuddy, "task-workspaces", "live-dir", "live.md"), "live");

    const migration = migrateLegacyTaskWorkspacesDirs(myBuddy);
    assert.equal(migration.workspacesMigrated, false, "并存 → 旧内容未映射，不得重绑");
    assert.equal(migration.workspacesDir, join(myBuddy, "task-workspaces"), "生效根为新目录");

    const db = new AppDatabase(join(myBuddy, "app.db"));
    try {
      const taskId = "both-task";
      db.upsertTask({ id: taskId, title: "并存任务", updatedAt: Date.now(), cwd: join(legacyWs, "stale-dir") });
      // 防御性调用（生产代码仅在 migrated=true 时调用）：existsSync 守卫必须跳过
      const rebind = db.rebindLegacyTaskWorkspacePaths(
        migration.legacyWorkspacesDir,
        migration.workspacesDir,
        migration.legacyTrashDir,
        migration.trashDir,
      );
      assert.equal(rebind.cwds, 0, "旧路径仍存在 → 跳过重绑");
      assert.equal(db.getTask(taskId)!.cwd, join(legacyWs, "stale-dir"), "cwd 保持旧根（内容仍在旧目录）");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("收口：rename 失败（legacy fallback）→ migrated=false 且路径不被重写", () => {
  if (process.platform !== "win32") {
    console.log("SKIP  rename 失败模拟（仅 Windows：rename 当前目录必失败）");
    return;
  }
  const root = mkdtempSync(join(tmpdir(), "mig-rebind-fail-"));
  const prevCwd = process.cwd();
  try {
    const myBuddy = join(root, "home", ".mybuddy");
    const legacyWs = join(myBuddy, "projects");
    mkdirSync(join(legacyWs, "task-a--hash"), { recursive: true });
    writeFileSync(join(legacyWs, "task-a--hash", "a.md"), "a");
    // 把 legacy 工作区设为进程 cwd：Windows 上 rename 当前目录必失败 → legacy 回退
    process.chdir(legacyWs);
    const migration = migrateLegacyTaskWorkspacesDirs(myBuddy);
    assert.equal(migration.workspacesMigrated, false, "rename 失败 → 未映射");
    assert.equal(migration.workspacesDir, legacyWs, "生效根回退为旧目录");
    assert.ok(existsSync(join(legacyWs, "task-a--hash", "a.md")), "旧目录内容原样保留");

    const db = new AppDatabase(join(myBuddy, "app.db"));
    try {
      db.upsertTask({ id: "fallback-task", title: "回退任务", updatedAt: Date.now(), cwd: join(legacyWs, "task-a--hash") });
      const rebind = db.rebindLegacyTaskWorkspacePaths(
        migration.legacyWorkspacesDir,
        migration.workspacesDir,
        migration.legacyTrashDir,
        migration.trashDir,
      );
      assert.equal(rebind.cwds, 0, "fallback 下绝不重写");
      assert.equal(db.getTask("fallback-task")!.cwd, join(legacyWs, "task-a--hash"), "cwd 保持旧根");
    } finally {
      db.close();
    }
  } finally {
    process.chdir(prevCwd);
    rmSync(root, { recursive: true, force: true });
  }
});

async function main(): Promise<void> {
  let passed = 0;
  for (const { name, run } of cases) {
    try {
      await run();
      passed += 1;
      console.log(`PASS  ${name}`);
    } catch (error) {
      console.error(`FAIL  ${name}`, error);
      process.exitCode = 1;
    }
  }
  console.log(`\ntask-workspace-migration: ${passed}/${cases.length} PASS`);
}

void main();
