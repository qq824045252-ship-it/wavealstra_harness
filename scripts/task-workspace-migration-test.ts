/**
 * TaskExecutionWorkspace 语义纠偏迁移回归测试（2026-08）
 *
 * 覆盖：
 *  - DB：task_project_state → task_execution_workspace_state 迁移（行保留 / 旧表删除 / 重启幂等）
 *  - DB：新旧表并存（上次迁移中断）→ 补齐复制校验后删除旧表，不丢数据
 *  - DB：全新库不触发迁移，新表正常可用
 *  - FS：~/.mybuddy/projects[/-trash] → ~/.mybuddy/task-workspaces[/-trash] 一次改名迁移（内容完整）
 *  - FS：新旧目录并存 → 使用新目录，旧目录原样保留（绝不删除）
 *  - 旧 tasks.cwd 兼容：目录整体改名后 ensureTaskExecutionWorkspace 幂等命中 + cwd 重绑
 *  - 回收区整体改名后：DB 中旧 trash_path 经 resolveTrashPath 定位，restore / purge 可用
 *  - 收口重绑（P1）：rename 成功后 tasks.cwd / trash_path 一次性重绑新根（不等首次 Agent 交互）
 *  - 冲突语义（P2-1）：空旧表直删；同 task_id 内容冲突拒绝 drop 并回滚；新表额外记录不受影响
 *
 * 全部使用 mkdtemp 临时目录与临时 sqlite；不触碰真实 ~/.mybuddy。
 * 运行：pnpm run test:task-workspace-migration
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { mapLegacyRootPath, migrateLegacyTaskWorkspacesDirs } from "../src/main/paths";
import {
  MANIFEST_FILENAME,
  TaskExecutionWorkspace,
  getTaskDirectoryName,
} from "../src/main/task/TaskExecutionWorkspace";
import { TaskExecutionWorkspaceLifecycle } from "../src/main/task/TaskExecutionWorkspaceLifecycle";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve()
    .then(() => fn())
    .then(() => {
      results.push({ name, ok: true, detail: "" });
      console.log(`PASS  ${name}`);
    })
    .catch((err: unknown) => {
      const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
      results.push({ name, ok: false, detail });
      console.error(`FAIL  ${name}\n      ${detail}`);
    });
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

const LEGACY_STATE_DDL = `
  CREATE TABLE task_project_state (
    task_id TEXT PRIMARY KEY,
    directory_name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'active',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    trashed_at INTEGER,
    purge_after INTEGER,
    trash_path TEXT
  );
`;

/* ------------------------------------------------------------------ */
/* 1. DB 迁移：旧表 + 数据 → 新表行保留、旧表删除、重启幂等               */
/* ------------------------------------------------------------------ */

check("DB：旧表 task_project_state 迁移到新表，行数据完整保留", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-db-"));
  try {
    const dbPath = join(root, "legacy.db");
    const raw = new Database(dbPath);
    raw.exec(LEGACY_STATE_DDL);
    const now = Date.now();
    raw
      .prepare(
        `INSERT INTO task_project_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("t-active", "t-active--hash1", "active", now - 1000, now - 1000, null, null, null);
    raw
      .prepare(
        `INSERT INTO task_project_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "t-trashed",
        "t-trashed--hash2",
        "trashed",
        now - 2000,
        now - 500,
        now - 500,
        now + 30 * 24 * 3600 * 1000,
        join(root, "legacy-trash", "t-trashed--hash2"),
      );
    raw.close();

    const db = new AppDatabase(dbPath);
    try {
      assert.ok(tableExists(db, "task_execution_workspace_state"), "新表已创建");
      assert.ok(!tableExists(db, "task_project_state"), "旧表已删除");
      assert.equal(rowCount(db, "task_execution_workspace_state"), 2, "行数 2 完整迁移");

      const active = db.getTaskExecutionWorkspaceState("t-active")!;
      assert.equal(active.state, "active");
      assert.equal(active.directoryName, "t-active--hash1");
      const trashed = db.getTaskExecutionWorkspaceState("t-trashed")!;
      assert.equal(trashed.state, "trashed");
      assert.equal(trashed.purgeAfter, now + 30 * 24 * 3600 * 1000, "purgeAfter 保留");
      assert.equal(trashed.trashPath, join(root, "legacy-trash", "t-trashed--hash2"), "trash_path 原样保留");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("DB：迁移后重复打开（重启）幂等，不报错、数据不变", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-db-idem-"));
  try {
    const dbPath = join(root, "legacy.db");
    const raw = new Database(dbPath);
    raw.exec(LEGACY_STATE_DDL);
    raw
      .prepare(
        `INSERT INTO task_project_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("t1", "t1--hash", "active", 1, 2, null, null, null);
    raw.close();

    const db1 = new AppDatabase(dbPath);
    assert.equal(rowCount(db1, "task_execution_workspace_state"), 1);
    db1.close();

    const db2 = new AppDatabase(dbPath);
    try {
      assert.equal(rowCount(db2, "task_execution_workspace_state"), 1, "重启后行数不变");
      assert.equal(db2.getTaskExecutionWorkspaceState("t1")?.directoryName, "t1--hash");
    } finally {
      db2.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("DB：新旧表并存（上次迁移中断）→ 补齐复制后删除旧表，不丢数据", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-db-both-"));
  try {
    const dbPath = join(root, "legacy.db");
    const raw = new Database(dbPath);
    raw.exec(LEGACY_STATE_DDL);
    raw
      .prepare(
        `INSERT INTO task_project_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("a", "a--h", "active", 1, 1, null, null, null);
    raw
      .prepare(
        `INSERT INTO task_project_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("b", "b--h", "trashed", 1, 1, 1, 99, "/old/trash/b--h");
    // 模拟中断现场：新表已建但旧表还在（空）
    raw.exec(`
      CREATE TABLE task_execution_workspace_state (
        task_id TEXT PRIMARY KEY,
        directory_name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        trashed_at INTEGER,
        purge_after INTEGER,
        trash_path TEXT
      );
    `);
    raw.close();

    const db = new AppDatabase(dbPath);
    try {
      assert.ok(!tableExists(db, "task_project_state"), "旧表最终被删除");
      assert.equal(rowCount(db, "task_execution_workspace_state"), 2, "2 行全部补齐");
      assert.equal(db.getTaskExecutionWorkspaceState("b")?.trashPath, "/old/trash/b--h");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

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

/* ------------------------------------------------------------------ */
/* 6. 冲突检测语义（P2-1）：空旧表直删 / 逐行内容校验 / 冲突拒绝 drop        */
/* ------------------------------------------------------------------ */

check("P2-1：新表已有 N 条 + 旧空表 → 升级成功、旧表删除、N 条保留", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-empty-legacy-"));
  try {
    const dbPath = join(root, "app.db");
    const raw = new Database(dbPath);
    raw.exec(LEGACY_STATE_DDL); // 空旧表（降级旧版重建场景）
    raw.exec(`
      CREATE TABLE task_execution_workspace_state (
        task_id TEXT PRIMARY KEY,
        directory_name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        trashed_at INTEGER,
        purge_after INTEGER,
        trash_path TEXT
      );
    `);
    raw
      .prepare(
        `INSERT INTO task_execution_workspace_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("x", "x--h", "active", 1, 1, null, null, null);
    raw
      .prepare(
        `INSERT INTO task_execution_workspace_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("y", "y--h", "trashed", 1, 1, 1, 99, "/old/trash/y--h");
    raw.close();

    const db = new AppDatabase(dbPath);
    try {
      assert.ok(!tableExists(db, "task_project_state"), "空旧表被安全清理");
      assert.equal(rowCount(db, "task_execution_workspace_state"), 2, "新表 N 条原样保留");
      assert.equal(db.getTaskExecutionWorkspaceState("y")!.trashPath, "/old/trash/y--h");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("P2-1：新旧并存、旧表部分重叠 → 新表补齐全部旧记录 + 保留额外记录", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-overlap-"));
  try {
    const dbPath = join(root, "app.db");
    const raw = new Database(dbPath);
    raw.exec(LEGACY_STATE_DDL);
    const insertLegacy = raw.prepare(
      `INSERT INTO task_project_state
         (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertLegacy.run("A", "A--h", "active", 1, 1, null, null, null);
    insertLegacy.run("B", "B--h", "trashed", 2, 2, 2, 100, "/old/trash/B--h");
    raw.exec(`
      CREATE TABLE task_execution_workspace_state (
        task_id TEXT PRIMARY KEY,
        directory_name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        trashed_at INTEGER,
        purge_after INTEGER,
        trash_path TEXT
      );
    `);
    const insertNew = raw.prepare(
      `INSERT INTO task_execution_workspace_state
         (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    insertNew.run("B", "B--h", "trashed", 2, 2, 2, 100, "/old/trash/B--h"); // 与旧表一致
    insertNew.run("C", "C--h", "active", 3, 3, null, null, null); // 新表额外合法记录
    raw.close();

    const db = new AppDatabase(dbPath);
    try {
      assert.ok(!tableExists(db, "task_project_state"), "旧表已删除");
      assert.equal(rowCount(db, "task_execution_workspace_state"), 3, "A+B+C 全部保留");
      assert.equal(db.getTaskExecutionWorkspaceState("A")!.state, "active", "补齐的 A 内容与旧表一致");
      assert.equal(db.getTaskExecutionWorkspaceState("B")!.trashPath, "/old/trash/B--h", "B 保留旧表内容");
      assert.equal(db.getTaskExecutionWorkspaceState("C")!.state, "active", "新表额外记录不受影响");
    } finally {
      db.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

check("P2-1：同 task_id 内容冲突 → 迁移回滚、旧表保留、不覆盖、重启稳定", () => {
  const root = mkdtempSync(join(tmpdir(), "mig-conflict-"));
  try {
    const dbPath = join(root, "app.db");
    const raw = new Database(dbPath);
    raw.exec(LEGACY_STATE_DDL);
    raw
      .prepare(
        `INSERT INTO task_project_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("A", "A--h", "trashed", 1, 1, 1, 99, "/old/trash/A--h"); // 旧表：A 已回收
    raw.exec(`
      CREATE TABLE task_execution_workspace_state (
        task_id TEXT PRIMARY KEY,
        directory_name TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        trashed_at INTEGER,
        purge_after INTEGER,
        trash_path TEXT
      );
    `);
    raw
      .prepare(
        `INSERT INTO task_execution_workspace_state
           (task_id, directory_name, state, created_at, updated_at, trashed_at, purge_after, trash_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("A", "A--h", "active", 1, 1, null, null, null); // 新表：A 为 active（内容冲突）
    raw.close();

    const db = new AppDatabase(dbPath);
    try {
      assert.ok(tableExists(db, "task_project_state"), "冲突 → 回滚，旧表保留");
      assert.equal(db.getTaskExecutionWorkspaceState("A")!.state, "active", "新表内容不被覆盖");
    } finally {
      db.close();
    }
    // 重启稳定：同样结果，无数据丢失
    const db2 = new AppDatabase(dbPath);
    try {
      assert.ok(tableExists(db2, "task_project_state"), "再次启动仍保留旧表");
      assert.equal(db2.getTaskExecutionWorkspaceState("A")!.state, "active");
    } finally {
      db2.close();
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ------------------------------------------------------------------ *//* ------------------------------------------------------------------ */
/* 汇总                                                               */
/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log("\n" + "-".repeat(72));
console.log(`task-workspace-migration: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  for (const f of failed) console.error(`FAILED: ${f.name} — ${f.detail}`);
  process.exitCode = 1;
}
