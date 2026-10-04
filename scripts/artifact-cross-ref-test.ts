/**
 * Wave 3 收口 — 跨任务 Artifact 引用回归测试（P0/P1 机器 Gate）
 *
 * 覆盖（对应执行顺序 P0/P1）：
 *   X1  artifact 只存在 SQLite Domain、artifact-index 无任何新记录时：
 *       collectTaskDomainArtifacts（InputAddMenu「引用任务」的产物来源）仍能列出
 *       workspace-file 产物（带 path）并 lazy readContent 读取 managed-content 产物内容
 *   X2  新 Artifact 不再写 artifact-index（P1 写停止 Gate）：Domain register 流程
 *       结束后 artifact-index.json 不存在 / 不包含该 task
 *   X3  legacy artifact-index 数据仍可一次性迁移进 Domain（P1 兼容 Gate）：
 *       rememberTaskArtifact 旧数据 → ensureTaskLegacyMigrated/registerLegacy →
 *       Domain snapshot 可见 → 跨任务引用可列出
 *   X4  迁移后新旧数据并存：Domain 新产物 + legacy 产物在同一引用列表
 *
 * 运行：pnpm test:artifact-cross-ref（esbuild bundle → node；better-sqlite3 external）
 * 隔离：monkey-patch os.homedir → 临时目录，不触碰真实 ~/.mybuddy 数据。
 */
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import os from "node:os";

// ---------- 隔离：homedir → 临时目录（artifact-index 的 ~/.mybuddy 指向这里） ----------
const tmpRoot = mkdtempSync(join(tmpdir(), "mybuddy-crossref-"));
os.homedir = () => tmpRoot;

// ---------- 被测代码（与主进程 / renderer 同一份） ----------
import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactService } from "../src/main/artifact/ArtifactService";
import { ensureTaskLegacyMigrated } from "../src/main/artifact/ArtifactDomainSetup";
import { loadTaskArtifacts } from "../src/main/agent/artifact-index";
import {
  collectTaskDomainArtifacts,
  type ArtifactDomainReader,
} from "../src/renderer/src/lib/refTaskArtifacts";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

interface Harness {
  root: string;
  service: ArtifactService;
  close(): void;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-crossref-domain-"));
  const db = new Database(join(root, "app.db"));
  const storage = new ArtifactStorage(join(root, "artifacts"));
  const repository = new ArtifactRepository(db);
  const registry = new ArtifactRegistry();
  const service = new ArtifactService(storage, repository, registry, {});
  const h: Harness = { root, service, close: () => db.close() };
  openHarnesses.push(h);
  return h;
}

/** 异常兜底清理 */
const openHarnesses: Harness[] = [];
function cleanupAll(): void {
  for (const h of openHarnesses) {
    try {
      h.close();
    } catch {
      /* ignore */
    }
  }
  openHarnesses.length = 0;
}

/** preload artifactDomain 的 node 适配器：直接调用 Domain service（无 IPC） */
function domainReader(service: ArtifactService): ArtifactDomainReader {
  return {
    snapshot: async (req) => service.hydrateTask(req.taskId),
    list: async (req) => {
      const artifacts = service.listByTask(req.taskId);
      return { artifacts, state: artifacts.length ? "ready" : "unloaded" };
    },
    readContent: async (req) => service.readContent(req.artifactId),
  };
}

const indexFilePath = (): string => join(tmpRoot, ".mybuddy", "artifact-index.json");

async function main(): Promise<void> {
  const wsRoot = join(tmpRoot, "ws");
  mkdirSync(wsRoot, { recursive: true });

  // ---------- X1: Domain-only artifact（artifact-index 无记录）可列出 + 可读内容 ----------
  {
    const h = makeHarness();
    const taskId = "task-domain-only";
    const mdFile = join(wsRoot, "domain-report.md");
    writeFileSync(mdFile, "# Domain 周报\n\n只存在于 SQLite，artifact-index 从未写入。", "utf-8");

    // 模拟 3C Agent ingest：全部走 ArtifactService.register（生产唯一创建通道）
    await h.service.register({
      taskId,
      kind: "markdown",
      title: "domain-report.md",
      capabilities: { originalKind: "markdown" },
      workspaceFile: { entryFile: mdFile, rootDir: wsRoot },
    });
    await h.service.register({
      taskId,
      kind: "html",
      title: "canvas.html",
      capabilities: { executable: true, interactive: true, originalKind: "html" },
      content: "<!doctype html><html><body><h1>canvas</h1></body></html>",
    });

    // artifact-index 不得被上述 Domain 流程触碰
    const indexExists = existsSync(indexFilePath());
    let indexHasTask = false;
    if (indexExists) {
      const raw = JSON.parse(readFileSync(indexFilePath(), "utf-8")) as Record<string, unknown>;
      indexHasTask = raw[taskId] !== undefined;
    }
    check("X1a Domain register 不写 artifact-index（文件不存在或不含该 task）", !indexHasTask, indexExists ? "index exists, task absent" : "index absent");

    const items = await collectTaskDomainArtifacts(domainReader(h.service), taskId);
    check("X1b 跨任务引用列出 Domain-only 产物（2 个）", items.length === 2, `n=${items.length}`);

    const wsByName = items.find((i) => i.name === "domain-report.md");
    check("X1c workspace-file 产物带 path（Agent 读盘）", wsByName?.path === mdFile && wsByName?.content === undefined, `path=${wsByName?.path}`);
    check("X1d workspace-file 产物不带 content（不把 content 塞回列表）", wsByName?.content === undefined);

    const memItem = items.find((i) => i.name === "canvas.html");
    check("X1e managed-content 产物无 path", memItem !== undefined && memItem?.path === undefined);
    check(
      "X1f managed-content 产物内容 lazy readContent 可达",
      memItem?.content?.includes("<h1>canvas</h1>") === true,
      `len=${memItem?.content?.length ?? -1}`,
    );
    h.close();
  }

  // ---------- X2 + X3: legacy artifact-index 数据仍可迁移进 Domain ----------
  {
    const h = makeHarness();
    const taskId = "task-legacy";
    const legacyFile = join(wsRoot, "legacy-note.md");
    writeFileSync(legacyFile, "# Legacy 笔记\n\n来自旧 artifact-index 的数据。", "utf-8");

    // 构造旧版本数据：artifact-index.json 记录（生产 rememberTaskArtifact 已随 P1 移除，
    // 这里直接写旧格式文件，等价于老版本 App 留下的磁盘数据）
    const legacyIndex: Record<string, Array<{ path: string; messageId: string; updatedAt: number }>> = {
      [taskId]: [{ path: legacyFile, messageId: "msg-legacy-1", updatedAt: Date.now() }],
    };
    mkdirSync(join(tmpRoot, ".mybuddy"), { recursive: true });
    writeFileSync(indexFilePath(), `${JSON.stringify(legacyIndex, null, 2)}\n`, "utf-8");

    // 生产迁移路径（main/index.ts 同款）：hydrate 前 ensureTaskLegacyMigrated → registerLegacy
    const legacySource = {
      loadLegacyArtifacts: async (tid: string) => {
        const artifacts = await loadTaskArtifacts(tid);
        return { artifacts, cwd: wsRoot };
      },
    };
    await ensureTaskLegacyMigrated(h.service, legacySource, taskId);

    // 迁移后 Domain 可见
    const snap = h.service.hydrateTask(taskId);
    check(
      "X2a legacy artifact-index 数据迁移进 Domain（snapshot 可见）",
      snap.artifacts.some((a) => a.source.type === "workspace-file" && a.source.entryFile === legacyFile),
      `n=${snap.artifacts.length}`,
    );
    check("X2b 迁移只跑一次（isLegacyMigrated 已标记）", h.service.isLegacyMigrated(taskId));

    // 跨任务引用路径可列出 legacy 迁移产物
    const items = await collectTaskDomainArtifacts(domainReader(h.service), taskId);
    const legacyItem = items.find((i) => i.name === "legacy-note.md");
    check("X2c 跨任务引用列出 legacy 迁移产物", legacyItem?.path === legacyFile, `path=${legacyItem?.path}`);

    // 迁移完成后 index 仍保留（read-only 数据源不删除，避免老用户数据丢失）
    check("X2d 迁移不删除 artifact-index 原文件", existsSync(indexFilePath()));
    h.close();
  }

  // ---------- X4: Domain 新产物 + legacy 产物并存 ----------
  {
    const h = makeHarness();
    const taskId = "task-mixed";
    const newFile = join(wsRoot, "new-feature.ts");
    const oldFile = join(wsRoot, "old-doc.md");
    writeFileSync(newFile, "export const x = 1;\n", "utf-8");
    writeFileSync(oldFile, "# 旧文档\n", "utf-8");

    // 新数据：Domain 直接注册
    await h.service.register({
      taskId,
      kind: "code",
      title: "new-feature.ts",
      capabilities: { originalKind: "code" },
      workspaceFile: { entryFile: newFile, rootDir: wsRoot },
    });
    // 旧数据：artifact-index 记录
    writeFileSync(
      indexFilePath(),
      `${JSON.stringify({
        [taskId]: [{ path: oldFile, messageId: "msg-old", updatedAt: Date.now() }],
      })}\n`,
      "utf-8",
    );
    await ensureTaskLegacyMigrated(h.service, {
      loadLegacyArtifacts: async (tid) => {
        const artifacts = await loadTaskArtifacts(tid);
        return { artifacts, cwd: wsRoot };
      },
    }, taskId);

    const items = await collectTaskDomainArtifacts(domainReader(h.service), taskId);
    check("X4a 新旧产物并存（Domain 新 + legacy 旧）", items.some((i) => i.name === "new-feature.ts") && items.some((i) => i.name === "old-doc.md"), `n=${items.length}`);
    h.close();
  }

  // ---------- 汇总 ----------
  const failed = results.filter(([, pass]) => !pass);
  console.log(`\n===== Artifact Cross-Ref: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    for (const [name, , detail] of failed) console.log(`  - ${name}${detail ? ` (${detail})` : ""}`);
    process.exitCode = 1;
  }
  cleanupAll();
  rmSync(tmpRoot, { recursive: true, force: true });
}

void main();
