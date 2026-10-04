/**
 * TaskIsolationAudit — 任务目录隔离历史审计（P0.5 / Batch 6）
 *
 * 对应《P0-task-project-isolation-fix.md》§13：
 *  - 默认只读 dry-run，识别共享 cwd、越界、manifest 冲突、跨 task entryFile
 *  - --repair-safe-metadata 仅允许：创建 canonical 目录、补合法 manifest、更新 tasks.cwd
 *  - 禁止移动/删除用户文件、改历史 task_id、覆盖冲突 manifest
 *
 * 不依赖 Renderer；workspacesRoot / db 路径可注入（测试用临时目录）。
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type Database from "better-sqlite3";
import { AppDatabase } from "../db/AppDatabase";
import {
  MANIFEST_FILENAME,
  TaskExecutionWorkspace,
  isPathInsideOrEqual,
  normalizePathForComparison,
  type TaskExecutionWorkspaceManifest,
} from "./TaskExecutionWorkspace";

/* ------------------------------------------------------------------ */
/* 状态码（§13 表）                                                     */
/* ------------------------------------------------------------------ */

export type AuditStatusCode =
  | "TASK_CANONICAL"
  | "TASK_CWD_NULL"
  | "TASK_CWD_LEGACY_SHARED"
  | "TASK_CWD_OUTSIDE_PROJECTS"
  | "TASK_DIR_MISSING"
  | "MANIFEST_MISSING"
  | "MANIFEST_TASK_MISMATCH"
  | "TASK_DIR_COLLISION"
  | "ARTIFACT_LEGACY_ROOT"
  | "ARTIFACT_ENTRY_OUTSIDE_ROOT"
  | "ARTIFACT_CROSS_TASK_ENTRY"
  | "ARTIFACT_FILE_MISSING"
  | "REALPATH_ESCAPE";

/** 阻塞项：禁止自动修复，需人工处理 */
export const BLOCKING_CODES: ReadonlySet<AuditStatusCode> = new Set([
  "MANIFEST_TASK_MISMATCH",
  "TASK_DIR_COLLISION",
  "ARTIFACT_ENTRY_OUTSIDE_ROOT",
  "REALPATH_ESCAPE",
]);

/** safe repair 可尝试处理的任务级码（不含 Artifact 只报告项） */
export const SAFE_REPAIRABLE_TASK_CODES: ReadonlySet<AuditStatusCode> = new Set([
  "TASK_CWD_NULL",
  "TASK_CWD_LEGACY_SHARED",
  "TASK_CWD_OUTSIDE_PROJECTS",
  "TASK_DIR_MISSING",
  "MANIFEST_MISSING",
]);

/* ------------------------------------------------------------------ */
/* 报告结构                                                             */
/* ------------------------------------------------------------------ */

export interface TaskAuditFinding {
  taskId: string;
  title: string;
  archived: boolean;
  storedCwd: string | null;
  expectedCwd: string;
  codes: AuditStatusCode[];
  /** 非阻塞/阻塞摘要 */
  blocking: boolean;
  details: string[];
}

export interface ArtifactAuditFinding {
  artifactId: string;
  taskId: string;
  entryFile: string | null;
  rootDir: string;
  codes: AuditStatusCode[];
  blocking: boolean;
  details: string[];
}

export interface RepairAction {
  taskId: string;
  action: "ensure_dir_and_manifest" | "bind_cwd" | "skipped_blocking" | "failed";
  cwd?: string;
  reason?: string;
}

export interface TaskIsolationAuditReport {
  version: 1;
  generatedAt: number;
  mode: "dry-run" | "repair-safe-metadata";
  dbPath: string;
  workspacesRoot: string;
  summary: {
    taskCount: number;
    canonicalCount: number;
    issueTaskCount: number;
    blockingTaskCount: number;
    legacyArtifactCount: number;
    blockingArtifactCount: number;
    crossTaskEntryGroupCount: number;
    repairedCount: number;
    skippedBlockingCount: number;
    failedRepairCount: number;
  };
  tasks: TaskAuditFinding[];
  artifacts: ArtifactAuditFinding[];
  crossTaskEntries: Array<{ entryFile: string; taskIds: string[]; artifactIds: string[] }>;
  repairs: RepairAction[];
  dbBackupPath?: string;
}

export interface TaskIsolationAuditOptions {
  dbPath: string;
  workspacesRoot: string;
  /** 只审计指定 task */
  taskId?: string;
  /** 默认跳过已归档任务 */
  includeArchived?: boolean;
  /** 安全 metadata 修复（默认 false = dry-run） */
  repairSafeMetadata?: boolean;
  /**
   * 已打开的 DB 连接（测试注入）。
   * 若提供则不再 new AppDatabase；调用方负责生命周期。
   */
  db?: AppDatabase;
}

/* ------------------------------------------------------------------ */
/* 内部辅助                                                             */
/* ------------------------------------------------------------------ */

interface ArtifactRow {
  id: string;
  task_id: string;
  entry_file: string | null;
  root_dir: string;
  source_type: string;
}

function safeRealpath(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

function tryReadManifest(manifestPath: string): { ok: true; manifest: TaskExecutionWorkspaceManifest } | { ok: false; error: string } {
  if (!existsSync(manifestPath)) {
    return { ok: false, error: "missing" };
  }
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as Partial<TaskExecutionWorkspaceManifest>;
    if (parsed?.version !== 1 || typeof parsed.taskId !== "string" || typeof parsed.createdAt !== "number") {
      return { ok: false, error: `unsupported format version=${String(parsed?.version)}` };
    }
    return { ok: true, manifest: { version: 1, taskId: parsed.taskId, createdAt: parsed.createdAt } };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name) as { ok: number } | undefined;
  return Boolean(row);
}

/* ------------------------------------------------------------------ */
/* 审计主流程                                                           */
/* ------------------------------------------------------------------ */

export function runTaskIsolationAudit(options: TaskIsolationAuditOptions): TaskIsolationAuditReport {
  const workspacesRoot = resolve(options.workspacesRoot);
  const workspace = new TaskExecutionWorkspace(workspacesRoot);
  const ownDb = !options.db;
  const appDb = options.db ?? new AppDatabase(options.dbPath);
  const mode: TaskIsolationAuditReport["mode"] = options.repairSafeMetadata
    ? "repair-safe-metadata"
    : "dry-run";

  try {
    let tasks = appDb.listTasks();
    if (!options.includeArchived) {
      tasks = tasks.filter((t) => !t.archived);
    }
    if (options.taskId) {
      tasks = tasks.filter((t) => t.id === options.taskId);
    }

    // 按 stored cwd 分组，识别共享目录
    const cwdGroups = new Map<string, string[]>();
    for (const t of tasks) {
      if (!t.cwd?.trim()) continue;
      const key = normalizePathForComparison(t.cwd);
      const list = cwdGroups.get(key) ?? [];
      list.push(t.id);
      cwdGroups.set(key, list);
    }

    // 按 expected 目录名检测碰撞（理论上哈希防撞，但若目录被手动占用仍可能出现）
    const expectedDirOwners = new Map<string, string[]>();
    for (const t of tasks) {
      const expected = workspace.resolveTaskExecutionWorkspaceDir(t.id);
      const key = normalizePathForComparison(expected);
      const list = expectedDirOwners.get(key) ?? [];
      list.push(t.id);
      expectedDirOwners.set(key, list);
    }

    const taskFindings: TaskAuditFinding[] = [];

    for (const t of tasks) {
      const expectedCwd = workspace.resolveTaskExecutionWorkspaceDir(t.id);
      const storedCwd = t.cwd?.trim() ? resolve(t.cwd.trim()) : null;
      const codes: AuditStatusCode[] = [];
      const details: string[] = [];

      // --- cwd 状态 ---
      if (!storedCwd) {
        codes.push("TASK_CWD_NULL");
        details.push("tasks.cwd 为空，尚未绑定 canonical task root");
      } else {
        if (!isPathInsideOrEqual(workspacesRoot, storedCwd)) {
          codes.push("TASK_CWD_OUTSIDE_PROJECTS");
          details.push(`stored cwd 不在 task-workspaces root 内：${storedCwd}`);
        }
        const peers = cwdGroups.get(normalizePathForComparison(storedCwd)) ?? [];
        if (peers.length > 1) {
          codes.push("TASK_CWD_LEGACY_SHARED");
          details.push(
            `与其他任务共享 cwd（共 ${peers.length} 个）：${peers.filter((id) => id !== t.id).join(", ")}`,
          );
        }
        // 在 task-workspaces 内但与 canonical 不一致（且不是共享检测已覆盖的情况也要标）
        if (
          isPathInsideOrEqual(workspacesRoot, storedCwd) &&
          normalizePathForComparison(storedCwd) !== normalizePathForComparison(expectedCwd) &&
          !codes.includes("TASK_CWD_LEGACY_SHARED")
        ) {
          // 仍标 OUTSIDE 语义的一种变体：非 canonical（用 LEGACY 不够精确时补充 detail）
          codes.push("TASK_CWD_OUTSIDE_PROJECTS");
          details.push(`stored cwd 与 canonical 不一致：${storedCwd} ≠ ${expectedCwd}`);
        }
      }

      // --- 目录碰撞 ---
      const dirOwners = expectedDirOwners.get(normalizePathForComparison(expectedCwd)) ?? [];
      if (dirOwners.length > 1) {
        codes.push("TASK_DIR_COLLISION");
        details.push(`多个 taskId 映射到同一目录：${dirOwners.join(", ")}`);
      }

      // --- 磁盘 / manifest / realpath ---
      const dirExists = existsSync(expectedCwd);
      if (!dirExists) {
        codes.push("TASK_DIR_MISSING");
        details.push(`canonical 目录不存在：${expectedCwd}`);
      } else {
        const rootReal = safeRealpath(workspacesRoot);
        const dirReal = safeRealpath(expectedCwd);
        if (rootReal && dirReal && !isPathInsideOrEqual(rootReal, dirReal)) {
          codes.push("REALPATH_ESCAPE");
          details.push(`任务目录 realpath 逃逸：${expectedCwd} → ${dirReal}`);
        }

        const manifestPath = join(expectedCwd, MANIFEST_FILENAME);
        const man = tryReadManifest(manifestPath);
        if (!man.ok) {
          if (man.error === "missing") {
            codes.push("MANIFEST_MISSING");
            details.push(`缺少 ${MANIFEST_FILENAME}`);
          } else {
            codes.push("MANIFEST_MISSING");
            details.push(`manifest 不可用：${man.error}`);
          }
        } else if (man.manifest.taskId !== t.id) {
          codes.push("MANIFEST_TASK_MISMATCH");
          details.push(
            `manifest taskId 冲突：manifest=${man.manifest.taskId}，期望=${t.id}`,
          );
        }
      }

      // 若 stored 已是 canonical 且目录/manifest 均正常，且无共享/碰撞 → CANONICAL
      const issueCodes = codes.filter((c) => c !== "TASK_CANONICAL");
      if (
        issueCodes.length === 0 &&
        storedCwd &&
        normalizePathForComparison(storedCwd) === normalizePathForComparison(expectedCwd)
      ) {
        codes.push("TASK_CANONICAL");
      }

      const blocking = codes.some((c) => BLOCKING_CODES.has(c));
      taskFindings.push({
        taskId: t.id,
        title: t.title,
        archived: Boolean(t.archived),
        storedCwd,
        expectedCwd,
        codes,
        blocking,
        details,
      });
    }

    // --- Artifacts ---
    // 默认扫描全部 workspace-file（含归档 task 的产物），以便发现跨 task 污染；
    // --task-id 时仅限该任务。
    const artifactFindings: ArtifactAuditFinding[] = [];
    const crossMap = new Map<string, { taskIds: Set<string>; artifactIds: string[] }>();
    const artifactById = new Map<string, ArtifactAuditFinding>();
    const sqlite = appDb.connection;

    if (tableExists(sqlite, "artifacts")) {
      const rows = sqlite
        .prepare(
          `SELECT id, task_id, entry_file, root_dir, source_type
           FROM artifacts
           WHERE source_type = 'workspace-file'
           ORDER BY created_at, rowid`,
        )
        .all() as ArtifactRow[];

      const artifactRows = options.taskId
        ? rows.filter((r) => r.task_id === options.taskId)
        : rows;

      const expectedByTask = new Map(taskFindings.map((f) => [f.taskId, f.expectedCwd]));
      for (const r of artifactRows) {
        if (!expectedByTask.has(r.task_id)) {
          try {
            expectedByTask.set(r.task_id, workspace.resolveTaskExecutionWorkspaceDir(r.task_id));
          } catch {
            /* invalid taskId */
          }
        }
      }

      for (const r of artifactRows) {
        const codes: AuditStatusCode[] = [];
        const details: string[] = [];
        const rootDir = resolve(r.root_dir);
        const expected = expectedByTask.get(r.task_id);

        const isCanonicalRoot =
          expected != null &&
          normalizePathForComparison(rootDir) === normalizePathForComparison(expected);

        if (!isCanonicalRoot) {
          codes.push("ARTIFACT_LEGACY_ROOT");
          details.push(
            expected
              ? `root_dir 非 canonical：${rootDir}（期望 ${expected}）`
              : `root_dir 非 canonical：${rootDir}`,
          );
        }

        if (r.entry_file?.trim()) {
          const entryAbs = resolve(r.entry_file);
          if (!isPathInsideOrEqual(rootDir, entryAbs)) {
            codes.push("ARTIFACT_ENTRY_OUTSIDE_ROOT");
            details.push(`entry_file 越出 root_dir：${entryAbs}`);
          }
          if (!existsSync(entryAbs)) {
            codes.push("ARTIFACT_FILE_MISSING");
            details.push(`entry 文件不存在：${entryAbs}`);
          }
          // cross-task 分组用规范化绝对路径
          const entryKey = normalizePathForComparison(entryAbs);
          const group = crossMap.get(entryKey) ?? { taskIds: new Set<string>(), artifactIds: [] };
          group.taskIds.add(r.task_id);
          group.artifactIds.push(r.id);
          crossMap.set(entryKey, group);
        }

        const finding: ArtifactAuditFinding = {
          artifactId: r.id,
          taskId: r.task_id,
          entryFile: r.entry_file,
          rootDir,
          codes,
          blocking: codes.some((c) => BLOCKING_CODES.has(c)),
          details,
        };
        artifactById.set(r.id, finding);
      }
    }

    const crossTaskEntries: TaskIsolationAuditReport["crossTaskEntries"] = [];
    for (const [entryFile, group] of crossMap) {
      if (group.taskIds.size <= 1) continue;
      const taskIds = [...group.taskIds].sort();
      crossTaskEntries.push({
        entryFile,
        taskIds,
        artifactIds: [...group.artifactIds],
      });
      for (const aid of group.artifactIds) {
        const finding = artifactById.get(aid);
        if (!finding) continue;
        if (!finding.codes.includes("ARTIFACT_CROSS_TASK_ENTRY")) {
          finding.codes.push("ARTIFACT_CROSS_TASK_ENTRY");
          finding.details.push(`同 entryFile 归属多个 task：${taskIds.join(", ")}`);
        }
      }
    }

    // 只输出有问题的 artifact
    for (const f of artifactById.values()) {
      if (f.codes.length === 0) continue;
      f.blocking = f.codes.some((c) => BLOCKING_CODES.has(c));
      artifactFindings.push(f);
    }

    // --- 汇总（repair 前） ---
    const repairs: RepairAction[] = [];
    let dbBackupPath: string | undefined;

    if (options.repairSafeMetadata) {
      // 先备份 DB（禁止无备份修复）
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      dbBackupPath = `${options.dbPath}.audit-backup-${stamp}`;
      mkdirSync(dirname(dbBackupPath), { recursive: true });
      copyFileSync(options.dbPath, dbBackupPath);

      const repairable = taskFindings.filter(
        (f) =>
          !f.blocking &&
          f.codes.some((c) => SAFE_REPAIRABLE_TASK_CODES.has(c)),
      );

      // 单 transaction 完成 metadata 修改
      const tx = appDb.connection.transaction(() => {
        for (const f of repairable) {
          try {
            // 再次确认无阻塞（目录被占用时 ensure 会抛）
            if (existsSync(f.expectedCwd)) {
              const man = tryReadManifest(join(f.expectedCwd, MANIFEST_FILENAME));
              if (man.ok && man.manifest.taskId !== f.taskId) {
                repairs.push({
                  taskId: f.taskId,
                  action: "skipped_blocking",
                  reason: `manifest 冲突：${man.manifest.taskId}`,
                });
                continue;
              }
              const rootReal = safeRealpath(workspacesRoot);
              const dirReal = safeRealpath(f.expectedCwd);
              if (rootReal && dirReal && !isPathInsideOrEqual(rootReal, dirReal)) {
                repairs.push({
                  taskId: f.taskId,
                  action: "skipped_blocking",
                  reason: `realpath 逃逸：${dirReal}`,
                });
                continue;
              }
            }

            const cwd = workspace.ensureTaskExecutionWorkspace(f.taskId);
            repairs.push({ taskId: f.taskId, action: "ensure_dir_and_manifest", cwd });
            appDb.bindTaskExecutionWorkspaceCwd(f.taskId, cwd);
            repairs.push({ taskId: f.taskId, action: "bind_cwd", cwd });
          } catch (err) {
            repairs.push({
              taskId: f.taskId,
              action: "failed",
              reason: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });
      tx();

      // 阻塞任务记 skipped
      for (const f of taskFindings.filter((x) => x.blocking && x.codes.some((c) => SAFE_REPAIRABLE_TASK_CODES.has(c) || true))) {
        if (f.blocking && !repairs.some((r) => r.taskId === f.taskId)) {
          repairs.push({
            taskId: f.taskId,
            action: "skipped_blocking",
            reason: `阻塞码：${f.codes.filter((c) => BLOCKING_CODES.has(c)).join(", ")}`,
          });
        }
      }
    }

    const canonicalCount = taskFindings.filter((f) => f.codes.includes("TASK_CANONICAL")).length;
    const issueTaskCount = taskFindings.filter((f) => !f.codes.includes("TASK_CANONICAL") || f.codes.length > 1).length;
    // issue = 有任何非 CANONICAL 码，或仅有问题码
    const realIssueTaskCount = taskFindings.filter((f) => f.codes.some((c) => c !== "TASK_CANONICAL")).length;
    const blockingTaskCount = taskFindings.filter((f) => f.blocking).length;
    const legacyArtifactCount = artifactFindings.filter((f) =>
      f.codes.includes("ARTIFACT_LEGACY_ROOT"),
    ).length;
    const blockingArtifactCount = artifactFindings.filter((f) => f.blocking).length;
    const repairedCount = new Set(
      repairs.filter((r) => r.action === "bind_cwd").map((r) => r.taskId),
    ).size;
    const skippedBlockingCount = repairs.filter((r) => r.action === "skipped_blocking").length;
    const failedRepairCount = repairs.filter((r) => r.action === "failed").length;

    void issueTaskCount;

    return {
      version: 1,
      generatedAt: Date.now(),
      mode,
      dbPath: options.dbPath,
      workspacesRoot,
      summary: {
        taskCount: taskFindings.length,
        canonicalCount,
        issueTaskCount: realIssueTaskCount,
        blockingTaskCount,
        legacyArtifactCount,
        blockingArtifactCount,
        crossTaskEntryGroupCount: crossTaskEntries.length,
        repairedCount,
        skippedBlockingCount,
        failedRepairCount,
      },
      tasks: taskFindings,
      artifacts: artifactFindings,
      crossTaskEntries,
      repairs,
      dbBackupPath,
    };
  } finally {
    if (ownDb) {
      appDb.close();
    }
  }
}

/* ------------------------------------------------------------------ */
/* 报告格式化                                                           */
/* ------------------------------------------------------------------ */

export function formatAuditReportMarkdown(report: TaskIsolationAuditReport): string {
  const s = report.summary;
  const lines: string[] = [
    `# Task Isolation Audit Report`,
    ``,
    `- Generated: ${new Date(report.generatedAt).toISOString()}`,
    `- Mode: **${report.mode}**`,
    `- DB: \`${report.dbPath}\``,
    `- Projects root: \`${report.workspacesRoot}\``,
    report.dbBackupPath ? `- DB backup: \`${report.dbBackupPath}\`` : null,
    ``,
    `## Summary`,
    ``,
    `| Metric | Count |`,
    `|---|---:|`,
    `| Tasks scanned | ${s.taskCount} |`,
    `| Canonical | ${s.canonicalCount} |`,
    `| Tasks with issues | ${s.issueTaskCount} |`,
    `| Blocking tasks | ${s.blockingTaskCount} |`,
    `| Legacy artifacts | ${s.legacyArtifactCount} |`,
    `| Blocking artifacts | ${s.blockingArtifactCount} |`,
    `| Cross-task entry groups | ${s.crossTaskEntryGroupCount} |`,
    `| Repaired | ${s.repairedCount} |`,
    `| Skipped (blocking) | ${s.skippedBlockingCount} |`,
    `| Repair failed | ${s.failedRepairCount} |`,
    ``,
    `## Tasks`,
    ``,
  ].filter((x): x is string => x != null);

  if (report.tasks.length === 0) {
    lines.push("_No tasks._", ``);
  } else {
    for (const t of report.tasks) {
      const flag = t.blocking ? "🚫" : t.codes.includes("TASK_CANONICAL") ? "✅" : "⚠️";
      lines.push(`### ${flag} \`${t.taskId}\` — ${t.title}${t.archived ? " (archived)" : ""}`);
      lines.push(`- Codes: ${t.codes.map((c) => `\`${c}\``).join(", ") || "_(none)_"}`);
      lines.push(`- Stored cwd: \`${t.storedCwd ?? "(null)"}\``);
      lines.push(`- Expected cwd: \`${t.expectedCwd}\``);
      for (const d of t.details) lines.push(`- ${d}`);
      lines.push(``);
    }
  }

  lines.push(`## Artifacts`, ``);
  if (report.artifacts.length === 0) {
    lines.push("_No artifact issues._", ``);
  } else {
    for (const a of report.artifacts) {
      const flag = a.blocking ? "🚫" : "⚠️";
      lines.push(`### ${flag} \`${a.artifactId}\` (task \`${a.taskId}\`)`);
      lines.push(`- Codes: ${a.codes.map((c) => `\`${c}\``).join(", ")}`);
      lines.push(`- root_dir: \`${a.rootDir}\``);
      lines.push(`- entry_file: \`${a.entryFile ?? "(null)"}\``);
      for (const d of a.details) lines.push(`- ${d}`);
      lines.push(``);
    }
  }

  if (report.crossTaskEntries.length > 0) {
    lines.push(`## Cross-task entry files`, ``);
    for (const g of report.crossTaskEntries) {
      lines.push(`- \`${g.entryFile}\``);
      lines.push(`  - tasks: ${g.taskIds.map((id) => `\`${id}\``).join(", ")}`);
      lines.push(`  - artifacts: ${g.artifactIds.map((id) => `\`${id}\``).join(", ")}`);
    }
    lines.push(``);
  }

  if (report.repairs.length > 0) {
    lines.push(`## Repairs`, ``);
    for (const r of report.repairs) {
      lines.push(
        `- \`${r.taskId}\`: **${r.action}**${r.cwd ? ` → \`${r.cwd}\`` : ""}${r.reason ? ` (${r.reason})` : ""}`,
      );
    }
    lines.push(``);
  }

  lines.push(
    `---`,
    ``,
    `Safe repair only creates canonical dirs, writes valid manifests, and updates \`tasks.cwd\`.`,
    `It never moves files, rewrites historical \`task_id\`, deletes artifacts, or overwrites conflicting manifests.`,
    ``,
  );
  return lines.join("\n");
}
