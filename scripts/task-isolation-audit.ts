/**
 * 任务目录隔离历史审计 CLI（P0.5 / Batch 6）
 *
 * 默认 dry-run，不修改 DB / 不移动用户文件。
 *
 * 用法：
 *   pnpm run audit:task-isolation
 *   pnpm run audit:task-isolation -- --db <path> --workspaces-root <path>
 *   pnpm run audit:task-isolation -- --json out.json --markdown out.md
 *   pnpm run audit:task-isolation -- --task-id <id> --include-archived
 *   pnpm run audit:task-isolation -- --repair-safe-metadata
 *
 * 对应《P0-task-project-isolation-fix.md》§13。
 * 禁止无确认的 --fix-all（本 CLI 不提供该开关）。
 */
import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  formatAuditReportMarkdown,
  runTaskIsolationAudit,
  type TaskIsolationAuditReport,
} from "../src/main/task/TaskIsolationAudit";
import { getDbPath } from "../src/main/paths";

interface CliArgs {
  dryRun: boolean;
  json?: string;
  markdown?: string;
  taskId?: string;
  includeArchived: boolean;
  repairSafeMetadata: boolean;
  db?: string;
  workspacesRoot?: string;
  help: boolean;
}

function printHelp(): void {
  console.log(`MyBuddy task isolation audit (P0.5)

Usage:
  pnpm run audit:task-isolation -- [options]

Options:
  --dry-run                 Read-only audit (default; always true unless --repair-safe-metadata)
  --json <path>             Write full report JSON
  --markdown <path>         Write Markdown report
  --task-id <id>            Audit a single task
  --include-archived        Include archived tasks
  --repair-safe-metadata    Create canonical dirs, valid manifests, bind tasks.cwd only
  --db <path>               SQLite path (default: ~/.mybuddy/app.db)
  --workspaces-root <path>  Task workspaces root (default: ~/.mybuddy/task-workspaces)
  --help                    Show this help

Safety:
  - Never moves/deletes user files
  - Never rewrites historical artifact task_id
  - Never overwrites conflicting manifests
  - Repair always copies DB to <db>.audit-backup-<timestamp> first
  - No --fix-all switch (by design)
`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = {
    dryRun: true,
    includeArchived: false,
    repairSafeMetadata: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v == null || v.startsWith("--")) throw new Error(`缺少参数值：${a}`);
      return v;
    };
    switch (a) {
      case "--help":
      case "-h":
        args.help = true;
        break;
      case "--dry-run":
        args.dryRun = true;
        break;
      case "--json":
        args.json = next();
        break;
      case "--markdown":
        args.markdown = next();
        break;
      case "--task-id":
        args.taskId = next();
        break;
      case "--include-archived":
        args.includeArchived = true;
        break;
      case "--repair-safe-metadata":
        args.repairSafeMetadata = true;
        args.dryRun = false;
        break;
      case "--db":
        args.db = next();
        break;
      case "--workspaces-root":
        args.workspacesRoot = next();
        break;
      case "--fix-all":
        throw new Error("禁止 --fix-all。仅支持 --repair-safe-metadata（metadata 安全修复）。");
      default:
        if (a.startsWith("-")) throw new Error(`未知参数：${a}（使用 --help）`);
        throw new Error(`多余参数：${a}`);
    }
  }
  return args;
}

function printConsoleSummary(report: TaskIsolationAuditReport): void {
  const s = report.summary;
  console.log("");
  console.log("=== Task Isolation Audit ===");
  console.log(`mode:              ${report.mode}`);
  console.log(`db:                ${report.dbPath}`);
  console.log(`workspacesRoot:      ${report.workspacesRoot}`);
  console.log(`tasks:             ${s.taskCount}`);
  console.log(`canonical:         ${s.canonicalCount}`);
  console.log(`issues:            ${s.issueTaskCount}`);
  console.log(`blocking tasks:    ${s.blockingTaskCount}`);
  console.log(`legacy artifacts:  ${s.legacyArtifactCount}`);
  console.log(`blocking artifacts:${s.blockingArtifactCount}`);
  console.log(`cross-task entries:${s.crossTaskEntryGroupCount}`);
  if (report.mode === "repair-safe-metadata") {
    console.log(`repaired:          ${s.repairedCount}`);
    console.log(`skipped blocking:  ${s.skippedBlockingCount}`);
    console.log(`repair failed:     ${s.failedRepairCount}`);
    if (report.dbBackupPath) console.log(`db backup:         ${report.dbBackupPath}`);
  }
  console.log("");

  const problems = report.tasks.filter((t) => t.codes.some((c) => c !== "TASK_CANONICAL"));
  if (problems.length > 0) {
    console.log("Task findings:");
    for (const t of problems.slice(0, 40)) {
      const mark = t.blocking ? "BLOCK" : "WARN ";
      console.log(`  [${mark}] ${t.taskId}  ${t.codes.join(", ")}`);
      if (t.storedCwd !== t.expectedCwd) {
        console.log(`          stored=${t.storedCwd ?? "(null)"}`);
        console.log(`          expect=${t.expectedCwd}`);
      }
    }
    if (problems.length > 40) console.log(`  ... and ${problems.length - 40} more`);
    console.log("");
  }

  if (report.artifacts.length > 0) {
    console.log("Artifact findings (first 20):");
    for (const a of report.artifacts.slice(0, 20)) {
      const mark = a.blocking ? "BLOCK" : "WARN ";
      console.log(`  [${mark}] ${a.artifactId} task=${a.taskId}  ${a.codes.join(", ")}`);
    }
    if (report.artifacts.length > 20) console.log(`  ... and ${report.artifacts.length - 20} more`);
    console.log("");
  }
}

function main(): void {
  let args: CliArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 2;
    return;
  }

  if (args.help) {
    printHelp();
    return;
  }

  const dbPath = resolve(args.db ?? getDbPath());
  // 默认 task-workspaces root：优先新目录，兼容旧目录（不经 getTaskExecutionWorkspacesDir()，避免 dry-run 强制 mkdir）
  const defaultWorkspacesRoot = existsSync(join(homedir(), ".mybuddy", "task-workspaces"))
    ? join(homedir(), ".mybuddy", "task-workspaces")
    : join(homedir(), ".mybuddy", "projects");
  const workspacesRoot = resolve(args.workspacesRoot ?? defaultWorkspacesRoot);

  const report = runTaskIsolationAudit({
    dbPath,
    workspacesRoot,
    taskId: args.taskId,
    includeArchived: args.includeArchived,
    repairSafeMetadata: args.repairSafeMetadata,
  });

  printConsoleSummary(report);

  if (args.json) {
    const p = resolve(args.json);
    writeFileSync(p, JSON.stringify(report, null, 2) + "\n", "utf8");
    console.log(`JSON report written: ${p}`);
  }
  if (args.markdown) {
    const p = resolve(args.markdown);
    writeFileSync(p, formatAuditReportMarkdown(report), "utf8");
    console.log(`Markdown report written: ${p}`);
  }

  // 退出码：有阻塞项 → 1；仅告警 → 0（便于 CI 门禁选择关注阻塞）
  if (report.summary.blockingTaskCount > 0 || report.summary.blockingArtifactCount > 0) {
    process.exitCode = 1;
  }
  if (report.summary.failedRepairCount > 0) {
    process.exitCode = 1;
  }
}

main();
