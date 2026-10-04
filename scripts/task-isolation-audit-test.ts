/**
 * P0.5 任务隔离历史审计测试
 *
 * 覆盖《P0-task-project-isolation-fix.md》§13 / Batch 6：
 *  - dry-run 识别共享 cwd / null cwd / 越界 / manifest 冲突 / 旧 Artifact
 *  - 同 entryFile 跨 task
 *  - safe repair 只建目录+manifest+bind cwd，不移动旧文件、不改 task_id
 *  - 冲突 manifest 不覆盖
 *  - 禁止 --fix-all（由 CLI 侧保证；此处测核心 API）
 *
 * 全部使用临时 DB/root，不触碰真实 ~/.mybuddy。
 * 运行：pnpm run test:task-isolation-audit
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import {
  formatAuditReportMarkdown,
  runTaskIsolationAudit,
  type TaskIsolationAuditReport,
} from "../src/main/task/TaskIsolationAudit";
import {
  MANIFEST_FILENAME,
  TaskExecutionWorkspace,
  atomicWriteJson,
} from "../src/main/task/TaskExecutionWorkspace";

const tempRoot = mkdtempSync(join(tmpdir(), "mybuddy-audit-"));
const workspacesRoot = join(tempRoot, "task-workspaces");
const dbPath = join(tempRoot, "app.db");
mkdirSync(workspacesRoot, { recursive: true });

const results: Array<{ name: string; ok: boolean; detail: string }> = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, ok: true, detail: "" });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const detail = err instanceof Error ? `${err.constructor.name}: ${err.message}` : String(err);
    results.push({ name, ok: false, detail });
    console.error(`FAIL  ${name}\n      ${detail}`);
  }
}

function seedDb(): AppDatabase {
  const db = new AppDatabase(dbPath);
  // ensure artifacts table exists via repository
  new ArtifactRepository(db.connection);
  return db;
}

function insertWorkspaceArtifact(
  db: AppDatabase,
  opts: {
    id: string;
    taskId: string;
    entryFile: string;
    rootDir: string;
  },
): void {
  const now = Date.now();
  db.connection
    .prepare(
      `INSERT INTO artifacts (id, task_id, space_id, kind, source_type, entry_file, root_dir,
         storage_path, version, capabilities_json, title, mime_type, created_at, updated_at)
       VALUES (@id, @task_id, NULL, 'document', 'workspace-file', @entry_file, @root_dir,
         NULL, 1, '{}', NULL, NULL, @created_at, @updated_at)`,
    )
    .run({
      id: opts.id,
      task_id: opts.taskId,
      entry_file: opts.entryFile,
      root_dir: opts.rootDir,
      created_at: now,
      updated_at: now,
    });
}

/* ------------------------------------------------------------------ */
/* 场景准备                                                             */
/* ------------------------------------------------------------------ */

const ws = new TaskExecutionWorkspace(workspacesRoot);
const db = seedDb();

const sharedCwd = join(tempRoot, "legacy-space");
mkdirSync(sharedCwd, { recursive: true });
writeFileSync(join(sharedCwd, "shared-a.md"), "A");
writeFileSync(join(sharedCwd, "shared-b.md"), "B");

// Task A/B：共享旧 cwd（典型污染根因）
db.upsertTask({
  id: "task-A",
  title: "任务A",
  updatedAt: Date.now(),
  cwd: sharedCwd,
});
db.upsertTask({
  id: "task-B",
  title: "任务B",
  updatedAt: Date.now(),
  cwd: sharedCwd,
});

// Task C：cwd 为空
db.upsertTask({
  id: "task-C",
  title: "任务C",
  updatedAt: Date.now(),
});

// Task D：cwd 在 workspaces 外的任意路径
const outside = join(tempRoot, "somewhere-else");
mkdirSync(outside, { recursive: true });
db.upsertTask({
  id: "task-D",
  title: "任务D",
  updatedAt: Date.now(),
  cwd: outside,
});

// Task E：canonical 已正确（对照）
const eDir = ws.ensureTaskExecutionWorkspace("task-E");
db.upsertTask({
  id: "task-E",
  title: "任务E-canonical",
  updatedAt: Date.now(),
  cwd: eDir,
});
writeFileSync(join(eDir, "ok.md"), "ok");

// Task F：目录存在但 manifest 被其他 task 占用（阻塞）
const fDir = ws.resolveTaskExecutionWorkspaceDir("task-F");
mkdirSync(fDir, { recursive: true });
atomicWriteJson(join(fDir, MANIFEST_FILENAME), {
  version: 1,
  taskId: "intruder",
  createdAt: Date.now(),
});
db.upsertTask({
  id: "task-F",
  title: "任务F-manifest冲突",
  updatedAt: Date.now(),
  cwd: fDir,
});

// Task G：目录存在、缺 manifest
const gDir = ws.resolveTaskExecutionWorkspaceDir("task-G");
mkdirSync(gDir, { recursive: true });
writeFileSync(join(gDir, "orphan.md"), "g");
db.upsertTask({
  id: "task-G",
  title: "任务G-缺manifest",
  updatedAt: Date.now(),
  cwd: gDir,
});

// Artifacts：旧共享 root
insertWorkspaceArtifact(db, {
  id: "art-legacy-a",
  taskId: "task-A",
  entryFile: join(sharedCwd, "shared-a.md"),
  rootDir: sharedCwd,
});
insertWorkspaceArtifact(db, {
  id: "art-legacy-b",
  taskId: "task-B",
  entryFile: join(sharedCwd, "shared-b.md"),
  rootDir: sharedCwd,
});
// 同 entryFile 登记到两个 task（跨 task 污染）
insertWorkspaceArtifact(db, {
  id: "art-cross-a",
  taskId: "task-A",
  entryFile: join(sharedCwd, "shared-a.md"),
  rootDir: sharedCwd,
});
insertWorkspaceArtifact(db, {
  id: "art-cross-b",
  taskId: "task-B",
  entryFile: join(sharedCwd, "shared-a.md"),
  rootDir: sharedCwd,
});
// entry 越界
insertWorkspaceArtifact(db, {
  id: "art-outside",
  taskId: "task-E",
  entryFile: join(tempRoot, "evil.md"),
  rootDir: eDir,
});
// 文件丢失
insertWorkspaceArtifact(db, {
  id: "art-missing",
  taskId: "task-E",
  entryFile: join(eDir, "gone.md"),
  rootDir: eDir,
});
// 正常 artifact（不应进 findings）
insertWorkspaceArtifact(db, {
  id: "art-ok",
  taskId: "task-E",
  entryFile: join(eDir, "ok.md"),
  rootDir: eDir,
});

db.close();

/* ------------------------------------------------------------------ */
/* dry-run                                                              */
/* ------------------------------------------------------------------ */

let dryReport: TaskIsolationAuditReport;

check("dry-run：不修改 DB cwd / 不创建缺失任务目录", () => {
  const probeIds = ["task-A", "task-B", "task-C", "task-D", "task-E", "task-F", "task-G"];
  const beforeCwds = new Map(probeIds.map((id) => {
    const dbProbe = new AppDatabase(dbPath);
    try {
      const row = dbProbe.getTask(id);
      return [id, row?.cwd ?? null] as const;
    } finally { dbProbe.close(); }
  }));
  dryReport = runTaskIsolationAudit({
    dbPath,
    workspacesRoot,
    repairSafeMetadata: false,
  });
  assert.equal(dryReport.mode, "dry-run");
  assert.equal(dryReport.dbBackupPath, undefined);
  // task-A 目录应仍不存在
  assert.ok(!existsSync(ws.resolveTaskExecutionWorkspaceDir("task-A")));
  assert.ok(!existsSync(ws.resolveTaskExecutionWorkspaceDir("task-C")));
  // DB 语义未变（WAL/checkpoint 可能改字节，故对比 cwd 而非原始字节）
  const dbAfter = new AppDatabase(dbPath);
  try {
    for (const id of probeIds) {
      assert.equal(dbAfter.getTask(id)?.cwd ?? null, beforeCwds.get(id) ?? null, `${id} cwd 未变`);
    }
  } finally { dbAfter.close(); }
});

check("dry-run：识别共享 cwd（A/B）", () => {
  const a = dryReport.tasks.find((t) => t.taskId === "task-A")!;
  const b = dryReport.tasks.find((t) => t.taskId === "task-B")!;
  assert.ok(a.codes.includes("TASK_CWD_LEGACY_SHARED"), String(a.codes));
  assert.ok(b.codes.includes("TASK_CWD_LEGACY_SHARED"), String(b.codes));
  assert.equal(a.storedCwd, resolve(sharedCwd));
});

check("dry-run：识别 NULL cwd（C）", () => {
  const c = dryReport.tasks.find((t) => t.taskId === "task-C")!;
  assert.ok(c.codes.includes("TASK_CWD_NULL"), String(c.codes));
});

check("dry-run：识别 workspaces 外 cwd（D）", () => {
  const d = dryReport.tasks.find((t) => t.taskId === "task-D")!;
  assert.ok(d.codes.includes("TASK_CWD_OUTSIDE_PROJECTS"), String(d.codes));
});

check("dry-run：canonical 任务 E 正常", () => {
  const e = dryReport.tasks.find((t) => t.taskId === "task-E")!;
  assert.ok(e.codes.includes("TASK_CANONICAL"), String(e.codes));
  assert.equal(e.blocking, false);
});

check("dry-run：manifest 冲突阻塞（F）", () => {
  const f = dryReport.tasks.find((t) => t.taskId === "task-F")!;
  assert.ok(f.codes.includes("MANIFEST_TASK_MISMATCH"), String(f.codes));
  assert.equal(f.blocking, true);
});

check("dry-run：缺 manifest（G）", () => {
  const g = dryReport.tasks.find((t) => t.taskId === "task-G")!;
  assert.ok(g.codes.includes("MANIFEST_MISSING"), String(g.codes));
  assert.equal(g.blocking, false);
});

check("dry-run：旧共享 root Artifact + 跨 task entry + 越界 + 丢失", () => {
  assert.ok(dryReport.summary.legacyArtifactCount >= 2);
  assert.ok(dryReport.crossTaskEntries.length >= 1);
  const cross = dryReport.crossTaskEntries.find((g) =>
    g.taskIds.includes("task-A") && g.taskIds.includes("task-B"),
  );
  assert.ok(cross, "应报告 A/B 共享 entryFile");

  const outsideArt = dryReport.artifacts.find((a) => a.artifactId === "art-outside");
  assert.ok(outsideArt?.codes.includes("ARTIFACT_ENTRY_OUTSIDE_ROOT"));
  assert.equal(outsideArt?.blocking, true);

  const missing = dryReport.artifacts.find((a) => a.artifactId === "art-missing");
  assert.ok(missing?.codes.includes("ARTIFACT_FILE_MISSING"));

  // 正常 artifact 不进 findings
  assert.ok(!dryReport.artifacts.some((a) => a.artifactId === "art-ok"));
});

check("dry-run：Markdown 报告可生成且含摘要", () => {
  const md = formatAuditReportMarkdown(dryReport);
  assert.ok(md.includes("Task Isolation Audit Report"));
  assert.ok(md.includes("TASK_CWD_LEGACY_SHARED"));
  assert.ok(md.includes("task-F"));
});

check("dry-run：--task-id 过滤", () => {
  const r = runTaskIsolationAudit({
    dbPath,
    workspacesRoot,
    taskId: "task-C",
  });
  assert.equal(r.tasks.length, 1);
  assert.equal(r.tasks[0].taskId, "task-C");
});

/* ------------------------------------------------------------------ */
/* safe repair                                                          */
/* ------------------------------------------------------------------ */

check("repair-safe：备份 DB + 修复可修任务 + 不搬旧文件", () => {
  const report = runTaskIsolationAudit({
    dbPath,
    workspacesRoot,
    repairSafeMetadata: true,
  });
  assert.equal(report.mode, "repair-safe-metadata");
  assert.ok(report.dbBackupPath);
  assert.ok(existsSync(report.dbBackupPath!), "应创建 DB 备份");

  // 旧共享目录文件仍在原位
  assert.ok(existsSync(join(sharedCwd, "shared-a.md")), "不得移动旧共享文件");
  assert.ok(existsSync(join(sharedCwd, "shared-b.md")), "不得移动旧共享文件");

  const db2 = new AppDatabase(dbPath);
  for (const id of ["task-A", "task-B", "task-C", "task-D", "task-G"]) {
    const row = db2.getTask(id)!;
    const expected = ws.resolveTaskExecutionWorkspaceDir(id);
    assert.equal(row.cwd, expected, `${id} cwd 应绑定 canonical`);
    assert.ok(existsSync(join(expected, MANIFEST_FILENAME)), `${id} 应有合法 manifest`);
    const man = JSON.parse(readFileSync(join(expected, MANIFEST_FILENAME), "utf8")) as {
      taskId: string;
    };
    assert.equal(man.taskId, id);
  }

  // F 冲突：不得覆盖，cwd 可保持原样（阻塞跳过）
  const f = db2.getTask("task-F")!;
  assert.ok(
    report.repairs.some((r) => r.taskId === "task-F" && r.action === "skipped_blocking"),
    "F 应 skipped_blocking",
  );
  const fMan = JSON.parse(readFileSync(join(fDir, MANIFEST_FILENAME), "utf8")) as { taskId: string };
  assert.equal(fMan.taskId, "intruder", "冲突 manifest 不得被覆盖");
  // F 的 cwd 不应被错误写成 “修好了” 若 ensure 失败；skipped 时 bind 不执行
  // （stored 可能仍是 fDir）
  assert.equal(f.cwd, fDir);

  // G 目录原有文件仍在
  assert.ok(existsSync(join(gDir, "orphan.md")), "G 目录内原有文件不得删除");

  // Artifact task_id / entry 不得被改写
  const art = db2.connection
    .prepare("SELECT task_id, entry_file FROM artifacts WHERE id = ?")
    .get("art-legacy-a") as { task_id: string; entry_file: string };
  assert.equal(art.task_id, "task-A");
  assert.equal(art.entry_file, join(sharedCwd, "shared-a.md"));

  // E 保持 canonical
  assert.equal(db2.getTask("task-E")!.cwd, eDir);

  assert.ok(report.summary.repairedCount >= 4, `repairedCount=${report.summary.repairedCount}`);
  db2.close();
});

check("repair 后 dry-run：A/B/C/D/G 应变 canonical；F 仍阻塞", () => {
  const r = runTaskIsolationAudit({ dbPath, workspacesRoot });
  for (const id of ["task-A", "task-B", "task-C", "task-D", "task-E", "task-G"]) {
    const t = r.tasks.find((x) => x.taskId === id)!;
    assert.ok(t.codes.includes("TASK_CANONICAL"), `${id} codes=${t.codes.join(",")}`);
  }
  const f = r.tasks.find((x) => x.taskId === "task-F")!;
  assert.ok(f.codes.includes("MANIFEST_TASK_MISMATCH"));
  assert.equal(f.blocking, true);
  // 旧 Artifact 仍只报告，不消失
  assert.ok(r.summary.legacyArtifactCount >= 1);
});

check("幂等：二次 repair 不破坏已 canonical 任务", () => {
  const r = runTaskIsolationAudit({
    dbPath,
    workspacesRoot,
    repairSafeMetadata: true,
  });
  const db2 = new AppDatabase(dbPath);
  assert.equal(db2.getTask("task-A")!.cwd, ws.resolveTaskExecutionWorkspaceDir("task-A"));
  assert.equal(db2.getTask("task-E")!.title, "任务E-canonical");
  // 备份存在
  assert.ok(r.dbBackupPath && existsSync(r.dbBackupPath));
  db2.close();
});

/* ------------------------------------------------------------------ */
/* 清理与汇总                                                           */
/* ------------------------------------------------------------------ */

const failed = results.filter((r) => !r.ok);
console.log("");
console.log("------------------------------------------------------------------------");
console.log(`task-isolation-audit: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length) {
  for (const f of failed) console.error(`  FAIL ${f.name}: ${f.detail}`);
}
// 清理临时目录
try {
  rmSync(tempRoot, { recursive: true, force: true });
  console.log(`tempRoot 已清理: ${tempRoot}`);
} catch (err) {
  console.warn(`清理 tempRoot 失败: ${err}`);
}
process.exitCode = failed.length ? 1 : 0;
