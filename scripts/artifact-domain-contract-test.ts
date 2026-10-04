/**
 * Wave 2 — Artifact Domain Contract Tests（V3.5 §59-60）
 *
 * 覆盖：
 *   - 注册事务失败矩阵（§11-13）：materialize fail / DB fail+rollback /
 *     rollback fail→orphan / registry fail / event fail
 *   - commit point 语义（§10）：metadata 提交 = 创建成功
 *   - hydrateTask 语义（§21-23）：lazy hydrate + error state
 *   - Refresh（§68-69）：version++ 由 Repository 持久化（重启后正确）、
 *     affected mapping（rootDir 规则）、managed-content 跳过
 *   - Registry 可重建（§7）：清空后 hydrate/rebuild 恢复
 *   - orphan GC（§14）：文件存在 metadata 不存在 → 删除
 *   - 持久对象不含 raw content（§4）
 *
 * 运行：pnpm test:artifact-domain（esbuild bundle → node；better-sqlite3 external）
 */
import Database from "better-sqlite3";
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ArtifactStorage } from "../src/main/artifact/ArtifactStorage";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { ArtifactRegistry } from "../src/main/artifact/ArtifactRegistry";
import { ArtifactService, type ArtifactEventSink } from "../src/main/artifact/ArtifactService";
import { ArtifactRefreshCoordinator } from "../src/main/artifact/ArtifactRefreshCoordinator";
import { ensureTaskLegacyMigrated } from "../src/main/artifact/ArtifactDomainSetup";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

interface Harness {
  root: string;
  db: Database;
  storage: ArtifactStorage;
  repository: ArtifactRepository;
  registry: ArtifactRegistry;
  service: ArtifactService;
  sink: ArtifactEventSink & {
    events: Array<{
      type: string;
      artifactId: string;
      version?: number;
      revision?: number;
      descriptor?: ArtifactDescriptor;
    }>;
  };
  close(): void;
}

function makeHarness(): Harness {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-domain-"));
  const dbPath = join(root, "app.db");
  const db = new Database(dbPath);
  const storage = new ArtifactStorage(join(root, "artifacts"));
  const repository = new ArtifactRepository(db);
  const registry = new ArtifactRegistry();
  const events: Harness["sink"]["events"] = [];
  const sink: Harness["sink"] = {
    events,
    created: (e) => events.push({ type: "created", artifactId: e.artifactId, version: e.version, revision: e.revision, descriptor: e.descriptor }),
    updated: (e) => events.push({ type: "updated", artifactId: e.artifactId, version: e.version, revision: e.revision, descriptor: e.descriptor }),
    removed: (e) => events.push({ type: "removed", artifactId: e.artifactId, revision: e.revision }),
  };
  const service = new ArtifactService(storage, repository, registry, sink);
  const h: Harness = {
    root,
    db,
    storage,
    repository,
    registry,
    service,
    sink,
    close: () => {
      db.close(); // better-sqlite3 close 幂等，重复调用安全
      rmSync(root, { recursive: true, force: true });
    },
  };
  openHarnesses.push(h); // 异常兜底：即使测试中途抛错也能清理
  return h;
}

/** 未显式 close 的 harness 兜底清理（防异常路径污染 temp） */
const openHarnesses: Harness[] = [];
function cleanupAll(): void {
  for (const h of openHarnesses) {
    try {
      h.close();
    } catch {
      // 忽略清理自身失败
    }
  }
  openHarnesses.length = 0;
}

/** 直接构造 descriptor（repository 层测试用，不需要真实落盘） */
function makeDescriptor(id: string, taskId: string, createdAt: number): ArtifactDescriptor {
  return {
    id,
    taskId,
    kind: "html",
    source: { type: "managed-content", storagePath: `${taskId}/${id}/index.html`, rootDir: "unused" },
    version: 1,
    capabilities: {},
    createdAt,
    updatedAt: createdAt,
  };
}

async function main(): Promise<void> {
  // ---------- T1/T2/T3: 注册基础语义 ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws");
    mkdirSync(ws, { recursive: true });
    const mdFile = join(ws, "report.md");
    writeFileSync(mdFile, "# 报告\n", "utf-8");

    // T1 workspace-file
    const d1 = await h.service.register({
      taskId: "task-a",
      kind: "markdown",
      title: "周报",
      workspaceFile: { entryFile: mdFile, rootDir: ws },
    });
    check(
      "T1 register workspace-file → descriptor 正确",
      d1.taskId === "task-a" && d1.version === 1 && d1.source.type === "workspace-file",
      `${d1.kind} v${d1.version} ${d1.source.type}`,
    );

    // T2 managed-content + 落盘
    const d2 = await h.service.register({
      taskId: "task-a",
      kind: "html",
      title: "图表",
      content: "<!doctype html><html><body>hi</body></html>",
    });
    const storagePath = d2.source.type === "managed-content" ? d2.source.storagePath : "";
    check(
      "T2 register managed-content → 文件落盘",
      d2.source.type === "managed-content" && h.storage.exists(storagePath),
      `path=${storagePath}`,
    );
    check("T2b 持久对象不含 raw content", !("content" in d2) && !(d2 as unknown as { content?: string }).content);
    check("T2c created 事件已广播", h.sink.events.some((e) => e.type === "created" && e.artifactId === d2.id));
    check("T2d entryPathOf workspace-file → 入口文件", h.service.entryPathOf(d1.id) === mdFile);
    check(
      "T2e entryPathOf managed-content → Storage 内入口文件",
      h.service.entryPathOf(d2.id) === h.storage.resolve(storagePath),
    );

    // T3 roundtrip
    check("T3a get 命中 registry", h.service.get(d1.id)?.id === d1.id);
    check("T3b listByTask 2 个", h.service.listByTask("task-a").length === 2);
    h.close();
  }

  // ---------- T4: materialize fail → 无 DB row（§11-A） ----------
  {
    const h = makeHarness();
    // storage root 指向一个普通文件 → materialize 的 mkdirSync 必然失败（ENOTDIR）
    const blocked = join(h.root, "blocked-as-file");
    writeFileSync(blocked, "not a directory", "utf-8");
    const badStorage = new ArtifactStorage(blocked);
    const badService = new ArtifactService(badStorage, h.repository, h.registry, h.sink);
    let threw = false;
    try {
      await badService.register({ taskId: "task-x", kind: "html", content: "<html></html>" });
    } catch {
      threw = true;
    }
    check("T4 materialize fail → 抛错", threw);
    check("T4b materialize fail → 无 DB row", h.repository.listByTask("task-x").length === 0);
    h.close();
  }

  // ---------- T5: DB fail → 已 materialize 内容被回滚删除（§11-B） ----------
  {
    const h = makeHarness();
    const before = await h.service.register({ taskId: "task-y", kind: "svg", content: "<svg/>" });
    const storagePath = before.source.type === "managed-content" ? before.source.storagePath : "";
    check("T5 前置：内容已落盘", h.storage.exists(storagePath));
    // 用 spy storage 记录 remove 调用（验证 rollback 链）
    const spyStorage = new ArtifactStorage(h.storage.root);
    const removedPaths: string[] = [];
    (spyStorage as unknown as { remove: (p: string) => boolean }).remove = (p: string) => {
      removedPaths.push(p);
      return ArtifactStorage.prototype.remove.call(spyStorage, p);
    };
    const svcSpy = new ArtifactService(spyStorage, h.repository, h.registry, h.sink);
    // 破坏 artifacts 表 → 后续 insert 抛错
    h.db.exec("DROP TABLE artifacts");
    let threw = false;
    try {
      await svcSpy.register({ taskId: "task-y", kind: "svg", content: "<svg>new</svg>" });
    } catch {
      threw = true;
    }
    check("T5 DB fail → 抛错", threw);
    check("T5b rollback 调用 storage.remove", removedPaths.length === 1, `removed=${removedPaths.length}`);
    const dirs = readdirSync(join(h.storage.root, "task-y"));
    console.log(`      [T5 debug] task-y dirs=${dirs.length} ${dirs.join(",")}`);
    for (const d of dirs) {
      console.log(`      [T5 debug]   ${d}/ → ${readdirSync(join(h.storage.root, "task-y", d)).join(",")}`);
    }
    check("T5c 新内容已回滚删除（仅剩 1 个 artifact 目录）", dirs.length === 1, `dirs=${dirs.length}`);
    h.close();
  }

  // ---------- T6: rollback fail → orphan → GC 清理（§11-B/§14） ----------
  {
    const h = makeHarness();
    // 包装 storage：remove 恒失败 → rollback 失败 → orphan
    const failingRemove = new ArtifactStorage(h.storage.root);
    const originalRemove = failingRemove.remove.bind(failingRemove);
    (failingRemove as unknown as { remove: () => boolean }).remove = () => false;
    const repo2 = new ArtifactRepository(h.db);
    const svc2 = new ArtifactService(failingRemove, repo2, h.registry, h.sink);
    h.db.exec("DROP TABLE artifacts"); // insert 失败
    let threw = false;
    try {
      await svc2.register({ taskId: "task-z", kind: "html", content: "<html>orphan me</html>" });
    } catch {
      threw = true;
    }
    check("T6 rollback fail → 抛错且内容成孤儿", threw);
    // DROP 只用于制造 insert 失败；重建空表 → managedPaths=∅ → 全部文件视为 orphan
    const repoGC = new ArtifactRepository(h.db);
    // orphan GC（用正常 storage 执行扫描）
    const gc = new ArtifactService(h.storage, repoGC, h.registry, h.sink);
    const orphanCount = h.storage.orphanCandidates(repoGC.managedPaths()).length;
    check("T6b orphanCandidates 识别孤儿", orphanCount >= 1, `orphans=${orphanCount}`);
    const gcResult = await gc.orphanGC();
    check("T6c orphanGC 清理孤儿", gcResult.removed.length >= 1 || h.storage.orphanCandidates(repoGC.managedPaths()).length === 0, `removed=${gcResult.removed.length}`);
    void originalRemove;
    h.close();
  }

  // ---------- T7: Registry fail → DB 保留，hydrate 重建（§12/§7） ----------
  {
    const h = makeHarness();
    const d = await h.service.register({ taskId: "task-r", kind: "code", content: "const x = 1;" });
    // 注入 upsert 抛错的 registry
    const brokenRegistry = new ArtifactRegistry();
    const originalUpsert = brokenRegistry.upsert.bind(brokenRegistry);
    (brokenRegistry as unknown as { upsert: () => void }).upsert = () => {
      throw new Error("boom");
    };
    const svcBroken = new ArtifactService(h.storage, h.repository, brokenRegistry, h.sink);
    let threw = false;
    try {
      await svcBroken.register({ taskId: "task-r", kind: "code", content: "const y = 2;" });
    } catch {
      threw = true;
    }
    check("T7 Registry fail → register 不抛错（DB 保留）", !threw);
    check("T7b DB 中有 2 条", h.repository.listByTask("task-r").length === 2);
    // 恢复 registry → hydrate 重建
    const fresh = new ArtifactRegistry();
    const svcFresh = new ArtifactService(h.storage, h.repository, fresh, h.sink);
    const snap = svcFresh.hydrateTask("task-r");
    check("T7c hydrate 从 Repository 重建（含全部 2 条）", snap.state === "ready" && snap.artifacts.length === 2, `state=${snap.state}`);
    check("T7d get 恢复命中", svcFresh.get(d.id)?.id === d.id);
    void originalUpsert;
    h.close();
  }

  // ---------- T8: event fail → DB 保留（§13） ----------
  {
    const h = makeHarness();
    const badSink: ArtifactEventSink = {
      created: () => {
        throw new Error("sink boom");
      },
    };
    const svcBad = new ArtifactService(h.storage, h.repository, h.registry, badSink);
    const d = await svcBad.register({ taskId: "task-e", kind: "markdown", content: "# x" });
    check("T8 event fail → register 正常返回", d.id.length > 0);
    check("T8b DB 保留", h.repository.get(d.id) !== null);
    h.close();
  }

  // ---------- T9/T10: Refresh —— version++ 持久化 + affected mapping（§68-69） ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws");
    mkdirSync(ws, { recursive: true });
    const fileA = join(ws, "a.md");
    writeFileSync(fileA, "# a", "utf-8");
    const d = await h.service.register({
      taskId: "task-refresh",
      kind: "markdown",
      workspaceFile: { entryFile: fileA, rootDir: ws },
    });
    // rootDir 外文件 → 不命中
    const coord = new ArtifactRefreshCoordinator(h.service);
    const noHit = await coord.onWorkspaceChanged({
      taskId: "task-refresh",
      cwd: ws,
      changedFiles: [join(h.root, "elsewhere.md")],
    });
    check("T9a rootDir 外 changed file 不命中", noHit.length === 0);
    // P1 精确刷新：entryFile 命中 → version++（同回合无关兄弟文件不额外 bump）
    const hit = await coord.onWorkspaceChanged({
      taskId: "task-refresh",
      cwd: ws,
      changedFiles: [join(ws, "a.md"), join(ws, "sub", "b.md")],
    });
    check("T9b entryFile 命中 → updated 事件 version=2", hit.length === 1 && hit[0]?.version === 2, `v=${hit[0]?.version}`);
    check("T9c updated 事件已广播", h.sink.events.some((e) => e.type === "updated" && e.artifactId === d.id && e.version === 2));
    // P1：仅兄弟文件变化（非 entry / 非 dependency）不得 bump
    const siblingOnly = await coord.onWorkspaceChanged({
      taskId: "task-refresh",
      cwd: ws,
      changedFiles: [join(ws, "sub", "b.md")],
    });
    check("T9b2 非 entry 兄弟文件不 bump", siblingOnly.length === 0 && h.service.get(d.id)?.version === 2, `n=${siblingOnly.length} v=${h.service.get(d.id)?.version}`);
    // managed-content 不参与 refresh
    await h.service.register({ taskId: "task-refresh", kind: "html", content: "<html/>" });
    const noManaged = await coord.onWorkspaceChanged({ taskId: "task-refresh", cwd: ws, changedFiles: [join(ws, "a.md")] });
    // 仍 1 个命中（workspace-file 再次被改 → version 2→3）；managed-content artifact 不在其中
    check("T9d managed-content 跳过 refresh（仍 1 个命中）", noManaged.length === 1 && noManaged[0]?.version === 3, `n=${noManaged.length}, v=${noManaged[0]?.version}`);
    // 重启模拟：新 db 连接（同文件）→ version 仍是 3
    h.db.close();
    const db2 = new Database(join(h.root, "app.db"));
    const repo2 = new ArtifactRepository(db2);
    const dAfter = repo2.get(d.id);
    check("T9e 重启后 version 持久（Repository 持久化）", dAfter?.version === 3, `v=${dAfter?.version}`);
    db2.close();
    h.close();
  }

  // ---------- T10: 原生媒体同回合去重 + PPTD 项目依赖刷新 ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws-ppt");
    const deck = join(ws, "deck");
    const pages = join(deck, "pages");
    const media = join(deck, "media");
    mkdirSync(pages, { recursive: true });
    mkdirSync(media, { recursive: true });
    const generated = join(ws, "generated.png");
    writeFileSync(generated, "image", "utf-8");
    const image = await h.service.register({
      taskId: "task-ppt",
      kind: "image",
      workspaceFile: { entryFile: generated, rootDir: ws },
      producerMessageId: "msg-generate",
      producerToolCallId: "tool-image",
    });
    const coord = new ArtifactRefreshCoordinator(h.service);
    const sameTurn = await coord.onWorkspaceChanged({
      taskId: "task-ppt", cwd: ws, changedFiles: [generated], messageId: "msg-generate",
    });
    check(
      "T10a 原生媒体刚注册后同回合 snapshot 不重复 version++",
      sameTurn.length === 0 && h.service.get(image.id)?.version === 1,
      `n=${sameTurn.length} v=${h.service.get(image.id)?.version}`,
    );
    const manifest = join(deck, "deck.pptd");
    const page = join(pages, "001.page");
    const hero = join(media, "hero.png");
    writeFileSync(manifest, "pages:\n  - pages/001.page", "utf-8");
    writeFileSync(page, "page: 1", "utf-8");
    writeFileSync(hero, "hero", "utf-8");
    const project = await h.service.register({
      taskId: "task-ppt", kind: "markdown", workspaceFile: { entryFile: manifest, rootDir: ws },
      producerMessageId: "msg-create-project",
    });
    const pageHit = await coord.onWorkspaceChanged({
      taskId: "task-ppt", cwd: ws, changedFiles: [page, hero], messageId: "msg-edit-project",
    });
    check(
      "T10b PPTD pages/media 变化聚合刷新 manifest Artifact 一次",
      pageHit.length === 1 && pageHit[0]?.artifactId === project.id && pageHit[0]?.version === 2,
      `n=${pageHit.length} v=${pageHit[0]?.version}`,
    );
    const sibling = join(deck, "notes.txt");
    writeFileSync(sibling, "notes", "utf-8");
    const noSibling = await coord.onWorkspaceChanged({
      taskId: "task-ppt", cwd: ws, changedFiles: [sibling], messageId: "msg-notes",
    });
    check(
      "T10c PPTD 项目普通兄弟文件不被隐式聚合",
      noSibling.length === 0 && h.service.get(project.id)?.version === 2,
      `n=${noSibling.length} v=${h.service.get(project.id)?.version}`,
    );
    h.close();
  }

  // ---------- T11: hydrate error state + 空 task ----------
  {
    const h = makeHarness();
    const snapEmpty = h.service.hydrateTask("task-empty");
    check("T11a 空 task → ready + 0 条", snapEmpty.state === "ready" && snapEmpty.artifacts.length === 0);
    h.db.close(); // db 关闭 → hydrate 抛错 → error state
    const snapErr = await h.service.hydrateTask("task-broken");
    check("T11b db 故障 → hydrate error state", snapErr.state === "error" && snapErr.error !== undefined, `state=${snapErr.state}`);
    h.close();
  }

  // ---------- T12: remove 全链删除 ----------
  {
    const h = makeHarness();
    const d = await h.service.register({ taskId: "task-del", kind: "svg", content: "<svg/>" });
    const storagePath = d.source.type === "managed-content" ? d.source.storagePath : "";
    const ok = h.service.remove(d.id);
    check("T12a remove 返回 true", ok);
    check("T12b DB 无记录", h.repository.get(d.id) === null);
    check("T12c 内容已删除", !h.storage.exists(storagePath));
    check("T12d registry 无记录", h.registry.get(d.id) === undefined);
    check("T12e removed 事件已广播", h.sink.events.some((e) => e.type === "removed" && e.artifactId === d.id));
    check("T12f 重复 remove → false", !h.service.remove(d.id));
    h.close();
  }

  // ---------- T13: rebuildRegistry（§7 启动重建） ----------
  {
    const h = makeHarness();
    const a = await h.service.register({ taskId: "task-rebuild", kind: "html", content: "<html>A</html>" });
    const b = await h.service.register({ taskId: "task-rebuild", kind: "svg", content: "<svg>B</svg>" });
    h.registry.clear();
    check("T13a registry 清空后 get miss", h.registry.get(a.id) === undefined);
    h.service.rebuildRegistry();
    check("T13b rebuild 后 registry 完整", h.registry.get(a.id)?.id === a.id && h.registry.get(b.id)?.id === b.id);
    h.close();
  }

  // ---------- T14: update 元数据不 bump version ----------
  {
    const h = makeHarness();
    const d = await h.service.register({ taskId: "task-upd", kind: "markdown", content: "# x", title: "旧标题" });
    const updated = await h.service.update(d.id, { title: "新标题" });
    check("T14a update 改标题", updated?.title === "新标题");
    check("T14b update 不 bump version", updated?.version === 1, `v=${updated?.version}`);
    check("T14c registry 同步", h.registry.get(d.id)?.title === "新标题");
    h.close();
  }

  // ---------- T15: listByTask 稳定 FIFO（创建序升序；同毫秒由 rowid 兜底） ----------
  {
    const h = makeHarness();
    const a = await h.service.register({ taskId: "task-fifo", kind: "html", content: "<html>A</html>" });
    const b = await h.service.register({ taskId: "task-fifo", kind: "html", content: "<html>B</html>" });
    const list = h.service.listByTask("task-fifo").map((d) => d.id);
    check("T15a registry 顺序 = 创建序（旧在前）", list[0] === a.id && list[1] === b.id, list.join(","));
    // hydrate 重建后顺序保持
    const fresh = new ArtifactRegistry();
    const svcFresh = new ArtifactService(h.storage, h.repository, fresh, h.sink);
    const snap = svcFresh.hydrateTask("task-fifo");
    const list2 = snap.artifacts.map((d) => d.id);
    check("T15b hydrate 重建后顺序保持", snap.state === "ready" && list2[0] === a.id && list2[1] === b.id, list2.join(","));
    // 同毫秒确定性：直插两条相同 createdAt（rowid 兜底）
    const c = makeDescriptor("fifo-c", "task-fifo", 1000);
    const d = makeDescriptor("fifo-d", "task-fifo", 1000);
    h.repository.transaction(() => {
      h.repository.insert(c);
      h.repository.insert(d);
    });
    const list3 = h.repository.listByTask("task-fifo").map((x) => x.id);
    check("T15c 同毫秒 → rowid 兜底顺序", list3[0] === "fifo-c" && list3[1] === "fifo-d", list3.join(","));
    h.close();
  }

  // ---------- T16: register 重复 ID → conflict（register 不做 upsert） ----------
  {
    const h = makeHarness();
    const d1 = await h.service.register({ id: "dup-1", taskId: "task-dup", kind: "markdown", content: "# one" });
    check("T16a 显式 id 注册成功", d1.id === "dup-1");
    let threw = false;
    try {
      await h.service.register({ id: "dup-1", taskId: "task-dup", kind: "markdown", content: "# two" });
    } catch {
      threw = true;
    }
    check("T16b 重复 id → conflict 抛错", threw);
    check("T16c DB 仍只有 1 条", h.repository.listByTask("task-dup").length === 1);
    const dirs = existsSync(join(h.storage.root, "task-dup")) ? readdirSync(join(h.storage.root, "task-dup")) : [];
    check("T16d conflict 在 materialize 之前拦截（无 orphan 文件）", dirs.length === 1, `dirs=${dirs.length}`);
    const err = h.service.update("not-exists", { title: "x" });
    check("T16e update 不存在 id → null（不创建）", err === null);
    h.close();
  }

  // ---------- T17: 单 event 多文件 → 每 artifact 最多 +1（不会 5→8） ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws17");
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, "a.md"), "# a", "utf-8");
    writeFileSync(join(ws, "b.md"), "# b", "utf-8");
    writeFileSync(join(ws, "c.md"), "# c", "utf-8");
    const d1 = await h.service.register({ taskId: "task-v", kind: "markdown", workspaceFile: { entryFile: join(ws, "a.md"), rootDir: ws } });
    const d2 = await h.service.register({ taskId: "task-v", kind: "markdown", workspaceFile: { entryFile: join(ws, "b.md"), rootDir: ws } });
    const coord = new ArtifactRefreshCoordinator(h.service);
    const evts = await coord.onWorkspaceChanged({ taskId: "task-v", cwd: ws, changedFiles: [join(ws, "a.md"), join(ws, "b.md"), join(ws, "c.md")] });
    check("T17a 3 文件单 event → 2 个 artifact 各 +1（每 artifact 每 event 最多 1 次）", evts.length === 2, `n=${evts.length}`);
    check(
      "T17b 每个 artifact version 只 +1（v=2）",
      evts.every((e) => e.version === 2) && h.service.get(d1.id)?.version === 2 && h.service.get(d2.id)?.version === 2,
      `v1=${h.service.get(d1.id)?.version}, v2=${h.service.get(d2.id)?.version}`,
    );
    h.close();
  }

  // ---------- T18: cross-task 隔离（事件 taskId 限定，即使文件同时落在两个 rootDir） ----------
  {
    const h = makeHarness();
    const wsA = join(h.root, "wsA");
    const wsB = join(h.root, "wsB");
    mkdirSync(wsA, { recursive: true });
    mkdirSync(wsB, { recursive: true });
    const fileA = join(wsA, "x.md");
    writeFileSync(fileA, "# a", "utf-8");
    const fileB = join(wsB, "x.md");
    writeFileSync(fileB, "# b", "utf-8");
    const a = await h.service.register({ taskId: "task-iso-a", kind: "markdown", workspaceFile: { entryFile: fileA, rootDir: wsA } });
    const b = await h.service.register({ taskId: "task-iso-b", kind: "markdown", workspaceFile: { entryFile: fileB, rootDir: wsB } });
    const coord = new ArtifactRefreshCoordinator(h.service);
    // 事件属于 task-iso-a；changedFiles 同时覆盖 wsA/wsB，也只 bump task-iso-a
    const evts = await coord.onWorkspaceChanged({ taskId: "task-iso-a", cwd: wsA, changedFiles: [fileA, fileB] });
    check("T18a 事件只影响本 task 的 artifact", evts.length === 1 && evts[0]?.artifactId === a.id, `n=${evts.length}`);
    check("T18b 其他 task 不受影响（vB 仍 1）", h.service.get(b.id)?.version === 1, `vB=${h.service.get(b.id)?.version}`);
    h.close();
  }

  // ---------- T19: remove workspace-file（无 managed 内容可删；源文件不归 Domain 管） ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws19");
    mkdirSync(ws, { recursive: true });
    const entry = join(ws, "note.md");
    writeFileSync(entry, "# note", "utf-8");
    const d = await h.service.register({ taskId: "task-rmf", kind: "markdown", workspaceFile: { entryFile: entry, rootDir: ws } });
    const ok = h.service.remove(d.id);
    check("T19a remove workspace-file → true", ok);
    check("T19b DB 无记录", h.repository.get(d.id) === null);
    check("T19c registry 无记录", h.registry.get(d.id) === undefined);
    check("T19d removed 事件已广播", h.sink.events.some((e) => e.type === "removed" && e.artifactId === d.id));
    check("T19e 源文件未被触碰（workspace 文件不归 Domain 管）", existsSync(entry));
    h.close();
  }

  // ---------- T20: remove 时 storage 删除失败 → metadata 已删、文件变 orphan（后续 GC） ----------
  {
    const h = makeHarness();
    const d = await h.service.register({ taskId: "task-orphan", kind: "html", content: "<html>keep me</html>" });
    const storagePath = d.source.type === "managed-content" ? d.source.storagePath : "";
    // 包装 storage：remove 恒失败
    const failingStorage = new ArtifactStorage(h.storage.root);
    (failingStorage as unknown as { remove: () => boolean }).remove = () => false;
    const svcFailing = new ArtifactService(failingStorage, h.repository, h.registry, h.sink);
    const ok = svcFailing.remove(d.id);
    check("T20a DB 删除成功（commit point 不受 storage 影响）", ok && h.repository.get(d.id) === null);
    check("T20b registry 已移除", h.registry.get(d.id) === undefined);
    check("T20c removed 事件已广播", h.sink.events.some((e) => e.type === "removed" && e.artifactId === d.id));
    check("T20d 文件残留（orphan）", h.storage.exists(storagePath));
    // 正常 storage GC 清理
    const gc = new ArtifactService(h.storage, h.repository, new ArtifactRegistry(), h.sink);
    const res = await gc.orphanGC();
    check(
      "T20e GC 清理 orphan",
      !h.storage.exists(storagePath) && res.removed.includes(storagePath.replace(/\\/g, "/")),
      `removed=${res.removed.join(",")}`,
    );
    h.close();
  }

  // ---------- T21: hydrate error → task cache invalidate；重试可恢复 ----------
  {
    const h = makeHarness();
    const d = await h.service.register({ taskId: "task-hyd", kind: "svg", content: "<svg/>" });
    check("T21a 前置：registry 已缓存", h.registry.get(d.id)?.id === d.id);
    h.db.close();
    const snapErr = h.service.hydrateTask("task-hyd");
    check("T21b db 故障 → hydrate error state", snapErr.state === "error");
    check("T21c hydrate 失败 → task cache invalidate（无残留半份/旧数据）", h.registry.get(d.id) === undefined, `cached=${h.registry.get(d.id)?.id ?? "none"}`);
    // 重试：重开 db → hydrate 成功
    const db2 = new Database(join(h.root, "app.db"));
    const repo2 = new ArtifactRepository(db2);
    const fresh = new ArtifactRegistry();
    const svc2 = new ArtifactService(h.storage, repo2, fresh, h.sink);
    const snap2 = svc2.hydrateTask("task-hyd");
    check("T21d 重试 → ready + 1 条", snap2.state === "ready" && snap2.artifacts.length === 1 && snap2.artifacts[0]?.id === d.id, `state=${snap2.state}`);
    db2.close();
    h.close();
  }

  // ---------- T22: task-level revision（3A：集合/事件序列版本，与 artifact.version 分离） ----------
  {
    const h = makeHarness();
    const snap0 = h.service.hydrateTask("task-rev");
    check("T22a 空 task snapshot revision=0", snap0.revision === 0 && snap0.state === "ready", `rev=${snap0.revision}`);
    const d1 = await h.service.register({ taskId: "task-rev", kind: "markdown", content: "# one", title: "一" });
    const createdEv = h.sink.events.find((e) => e.type === "created" && e.artifactId === d1.id);
    const createdDesc = createdEv?.descriptor;
    check(
      "T22b created 事件 revision=1 且带完整 descriptor",
      createdEv?.revision === 1 && createdDesc?.source.type === "managed-content" && createdDesc?.title === "一",
      `rev=${createdEv?.revision}`,
    );
    const snap1 = h.service.hydrateTask("task-rev");
    check("T22c snapshot revision=1（register bump）", snap1.revision === 1 && snap1.artifacts.length === 1, `rev=${snap1.revision}`);
    await h.service.register({ taskId: "task-rev", kind: "svg", content: "<svg/>" });
    check("T22d 第二个 register → snapshot revision=2", h.service.hydrateTask("task-rev").revision === 2);
    const updated = h.service.update(d1.id, { title: "二" });
    check("T22e update → revision=3、artifact.version 仍 1", updated?.version === 1 && h.service.hydrateTask("task-rev").revision === 3, `v=${updated?.version}`);
    const updEv = h.sink.events.filter((e) => e.type === "updated").at(-1);
    check("T22f updated 事件 revision=3 + descriptor.title 更新", updEv?.revision === 3 && updEv?.descriptor?.title === "二", `rev=${updEv?.revision}`);
    const ok = h.service.remove(d1.id);
    const remEv = h.sink.events.filter((e) => e.type === "removed").at(-1);
    check("T22g remove → removed 事件 revision=4、snapshot revision=4", ok && remEv?.revision === 4 && h.service.hydrateTask("task-rev").revision === 4, `rev=${remEv?.revision}`);
    // 跨 task 独立：其他 task 的活动不影响 task-rev
    await h.service.register({ taskId: "task-other", kind: "html", content: "<html/>" });
    check("T22h 跨 task revision 独立", h.service.hydrateTask("task-rev").revision === 4 && h.service.hydrateTask("task-other").revision === 1);
    // 重启持久
    h.db.close();
    const db2 = new Database(join(h.root, "app.db"));
    const repo2 = new ArtifactRepository(db2);
    check("T22i 重启后 revision 持久（task-rev=4）", repo2.getTaskRevision("task-rev") === 4, `rev=${repo2.getTaskRevision("task-rev")}`);
    db2.close();
    h.close();
  }

  // ---------- T23: markFilesChanged → revision++ 且 updated 事件带新 descriptor ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws23");
    mkdirSync(ws, { recursive: true });
    const file = join(ws, "a.md");
    writeFileSync(file, "# a", "utf-8");
    const d = await h.service.register({ taskId: "task-mc", kind: "markdown", workspaceFile: { entryFile: file, rootDir: ws } });
    const coord = new ArtifactRefreshCoordinator(h.service);
    const evts = await coord.onWorkspaceChanged({ taskId: "task-mc", cwd: ws, changedFiles: [file] });
    check("T23a markFilesChanged → updated 事件 revision=2 + version=2", evts.length === 1 && evts[0]?.revision === 2 && evts[0]?.version === 2, `rev=${evts[0]?.revision}, v=${evts[0]?.version}`);
    const desc = evts[0]?.descriptor;
    check("T23b updated 事件 descriptor 完整（version=2、source 保留）", desc?.version === 2 && desc?.source.type === "workspace-file", `v=${desc?.version}`);
    check("T23c snapshot revision=2", h.service.hydrateTask("task-mc").revision === 2);
    h.close();
  }

  // ---------- T24: removeByTask —— task 生命周期全链删除（3B.6, D1-D6） ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws24");
    mkdirSync(ws, { recursive: true });
    const file = join(ws, "a.md");
    writeFileSync(file, "# a", "utf-8");
    const d1 = await h.service.register({ taskId: "task-del-all", kind: "markdown", workspaceFile: { entryFile: file, rootDir: ws } });
    const d2 = await h.service.register({ taskId: "task-del-all", kind: "html", content: "<html>x</html>" });
    const storagePath = d2.source.type === "managed-content" ? d2.source.storagePath : "";
    const before = h.sink.events.filter((e) => e.type === "removed").length;
    const res = h.service.removeByTask("task-del-all");
    check("T24a removeByTask → removed=2, orphaned=0（D1）", res.removed === 2 && res.orphaned === 0, `removed=${res.removed}, orphaned=${res.orphaned}`);
    check("T24b DB rows 全删（D2）", h.repository.listByTask("task-del-all").length === 0 && h.repository.get(d1.id) === null && h.repository.get(d2.id) === null);
    check("T24c managed content 已清理（D3）", !h.storage.exists(storagePath));
    check("T24d registry invalidate（D5）", h.registry.get(d1.id) === undefined && h.registry.get(d2.id) === undefined);
    const removedEvents = h.sink.events.filter((e) => e.type === "removed").slice(before);
    check("T24e removed 事件每 artifact 一条（D6）", removedEvents.length === 2, `n=${removedEvents.length}`);
    check(
      "T24f removed 事件共享同 revision 且 > 0",
      removedEvents.every((e) => e.revision === removedEvents[0]?.revision) && (removedEvents[0]?.revision ?? 0) > 0,
      `rev=${removedEvents[0]?.revision}`,
    );
    check("T24g 重复 removeByTask → removed=0（幂等）", h.service.removeByTask("task-del-all").removed === 0);
    h.close();
  }

  // ---------- T24b: removeByTask storage 失败 → orphan（D4） ----------
  {
    const h = makeHarness();
    const d = await h.service.register({ taskId: "task-del-orphan", kind: "svg", content: "<svg/>" });
    const storagePath = d.source.type === "managed-content" ? d.source.storagePath : "";
    const failingStorage = new ArtifactStorage(h.storage.root);
    (failingStorage as unknown as { remove: () => boolean }).remove = () => false;
    const svc = new ArtifactService(failingStorage, h.repository, h.registry, h.sink);
    const res = svc.removeByTask("task-del-orphan");
    check("T24h storage 失败 → orphaned=1", res.removed === 1 && res.orphaned === 1, `removed=${res.removed}, orphaned=${res.orphaned}`);
    check("T24i DB 已删但文件残留（orphan）", h.repository.listByTask("task-del-orphan").length === 0 && h.storage.exists(storagePath));
    const gc = new ArtifactService(h.storage, h.repository, new ArtifactRegistry(), h.sink);
    await gc.orphanGC();
    check("T24j GC 清理 orphan", !h.storage.exists(storagePath));
    h.close();
  }

  // ---------- T25: legacy migration（3B.2-3.4, M1-M7） ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws25");
    mkdirSync(ws, { recursive: true });
    const realFile = join(ws, "report.md");
    writeFileSync(realFile, "# legacy report", "utf-8");
    // M1 workspace-file / M2 raw→managed / M5 坏条目跳过
    const r1 = await h.service.registerLegacy(
      "task-leg",
      [
        { name: "report.md", kind: "markdown", path: realFile },
        { name: "chart", kind: "svg", content: "<svg/>" },
        { name: "broken", kind: "html", path: join(ws, "missing.html") },
      ],
      ws,
    );
    check("T25a 部分成功：registered=2, failed=1（M1/M2/M5）", r1.registered === 2 && r1.failed === 1, `r=${r1.registered}, f=${r1.failed}`);
    const list = h.repository.listByTask("task-leg");
    check(
      "T25b workspace-file 直指不复制内容（M1）",
      list.length === 2 && list.some((d) => d.source.type === "workspace-file" && d.source.entryFile === realFile),
    );
    const managed = list.find((d) => d.source.type === "managed-content");
    check("T25c raw content → managed-content 落盘（M2）", managed !== undefined && h.storage.exists(managed.source.storagePath));
    check("T25d 迁移后已标记（M4 前置）", h.service.isLegacyMigrated("task-leg"));
    // M4: 标记后 ensureTaskLegacyMigrated 短路，不再读 legacy 源
    const sourceCalls: string[] = [];
    const before = h.repository.listByTask("task-leg").length;
    await ensureTaskLegacyMigrated(
      h.service,
      {
        loadLegacyArtifacts: async () => {
          sourceCalls.push("called");
          return { artifacts: [{ name: "x", kind: "html", content: "<html/>" }], cwd: ws };
        },
      },
      "task-leg",
    );
    check("T25e 已迁移 → 不再读取 legacy 源、不重复注册（M4）", sourceCalls.length === 0 && h.repository.listByTask("task-leg").length === before);
    h.close();
  }

  {
    const h = makeHarness();
    // M3: 0 artifact 也标记完成
    await h.service.registerLegacy("task-empty-leg", []);
    check("T25f 0 artifact 也标记 migrated（M3）", h.service.isLegacyMigrated("task-empty-leg"));
    // M7: 重启后 marker 持久、不重复迁移
    h.db.close();
    const db2 = new Database(join(h.root, "app.db"));
    const repo2 = new ArtifactRepository(db2);
    check("T25g 重启后 marker 持久（M7）", repo2.isLegacyMigrated("task-empty-leg"));
    db2.close();
    h.close();
  }

  {
    const h = makeHarness();
    // M6: 迁移整体失败（legacy 源抛错）→ 不标记 → 重试成功 → 标记
    let threw = false;
    try {
      await ensureTaskLegacyMigrated(
        h.service,
        {
          loadLegacyArtifacts: async () => {
            throw new Error("legacy source down");
          },
        },
        "task-retry",
      );
    } catch {
      threw = true;
    }
    check("T25h 迁移失败 → 抛错且不标记（M6）", threw && !h.service.isLegacyMigrated("task-retry"));
    await ensureTaskLegacyMigrated(
      h.service,
      {
        loadLegacyArtifacts: async () => ({
          artifacts: [{ name: "gone.md", kind: "markdown", path: join(h.root, "nonexist.md") }],
          cwd: h.root,
        }),
      },
      "task-retry",
    );
    check("T25i 重试成功 → 标记 migrated（M6）", h.service.isLegacyMigrated("task-retry"));
    h.close();
  }

  // ---------- T26: readContent（3C：managed→storage；workspace-file→fs+root 边界） ----------
  {
    const h = makeHarness();
    const managed = await h.service.register({ taskId: "task-rc", kind: "html", content: "<html>hello</html>", capabilities: { originalKind: "html" } });
    const mc = await h.service.readContent(managed.id);
    check("T26a managed-content → storage 内容", mc?.content === "<html>hello</html>" && mc?.kind === "html", `kind=${mc?.kind}`);
    const ws = join(h.root, "ws26");
    mkdirSync(ws, { recursive: true });
    const file = join(ws, "report.md");
    writeFileSync(file, "# report", "utf-8");
    const wf = await h.service.register({
      taskId: "task-rc",
      kind: "markdown",
      capabilities: { originalKind: "markdown" },
      workspaceFile: { entryFile: file, rootDir: ws },
    });
    const wc = await h.service.readContent(wf.id);
    check("T26b workspace-file → fs 内容", wc?.content === "# report", `content=${wc?.content?.slice(0, 20)}`);
    // P0：rootDir 外 entryFile → register 直接抛错（不再允许登记后再靠 read 拒绝）
    const outside = join(h.root, "outside.md");
    writeFileSync(outside, "# outside", "utf-8");
    let registerThrew = false;
    try {
      await h.service.register({
        taskId: "task-rc",
        kind: "markdown",
        workspaceFile: { entryFile: outside, rootDir: ws },
      });
    } catch {
      registerThrew = true;
    }
    check("T26c root 外 entryFile → register 拒绝（P0 边界）", registerThrew);
    check(
      "T26c2 越界注册后 listByTask 不增加",
      h.service.listByTask("task-rc").length === 2,
      `n=${h.service.listByTask("task-rc").length}`,
    );
    check("T26d 不存在 id → null", (await h.service.readContent("nope")) === null);
    check("T26d2 entryPathOf 不存在 id → null", h.service.entryPathOf("nope") === null);
    h.close();
  }

  // ---------- T27: findByEntryFile（3C refresh 新/旧文件判断） ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws27");
    mkdirSync(ws, { recursive: true });
    const file = join(ws, "a.md");
    writeFileSync(file, "# a", "utf-8");
    const d = await h.service.register({ taskId: "task-fef", kind: "markdown", workspaceFile: { entryFile: file, rootDir: ws } });
    check("T27a 精确命中（大小写/分隔符归一）", h.service.findByEntryFile("task-fef", file.replace(/\\/g, "/").toUpperCase())?.id === d.id);
    check("T27b 不同 task 不命中", h.service.findByEntryFile("other-task", file) === null);
    check("T27c 未注册路径 miss", h.service.findByEntryFile("task-fef", join(ws, "nope.md")) === null);
    // managed-content 不参与（无 entryFile）
    const m = await h.service.register({ taskId: "task-fef", kind: "html", content: "<html/>" });
    void m;
    check("T27d managed-content 不命中", h.service.findByEntryFile("task-fef", join(h.root, "any")) === null);
    h.close();
  }

  // ---------- T28: Refresh 集成（3C Agent 流程：同 turn 多文件每 artifact 只 +1；refresh 不重复注册） ----------
  {
    const h = makeHarness();
    const ws = join(h.root, "ws28");
    mkdirSync(ws, { recursive: true });
    const a = join(ws, "index.html");
    const b = join(ws, "style.css");
    const c = join(ws, "script.js");
    writeFileSync(a, "<html/>", "utf-8");
    writeFileSync(b, "body {}", "utf-8");
    writeFileSync(c, "console.log(1)", "utf-8");
    const d = await h.service.register({ taskId: "task-ref", kind: "html", workspaceFile: { entryFile: a, rootDir: ws } });
    const coord = new ArtifactRefreshCoordinator(h.service);
    // 同一 Agent turn：3 个文件都属于同 rootDir → 只 +1（不 7→10）
    const evts = await coord.onWorkspaceChanged({ taskId: "task-ref", cwd: ws, changedFiles: [a, b, c] });
    check("T28a 同 turn 3 文件 → 单 artifact 只 +1（R2）", evts.length === 1 && evts[0]?.artifactId === d.id && evts[0]?.version === 2, `v=${evts[0]?.version}`);
    // refresh 后 findByEntryFile 命中（不重复注册）
    check("T28b refresh 后 findByEntryFile 命中（不重复注册）", h.service.findByEntryFile("task-ref", a)?.id === d.id);
    // 未注册新文件 miss（走 register）
    check("T28c 新文件 miss → 走 register 路径", h.service.findByEntryFile("task-ref", b) === null && h.service.findByEntryFile("task-ref", c) === null);
    // 第二次 turn 再改 3 文件 → 再 +1（每 turn 最多 +1）
    const evts2 = await coord.onWorkspaceChanged({ taskId: "task-ref", cwd: ws, changedFiles: [a, b, c] });
    check("T28d 第二 turn → version=3（每 turn 每 artifact 最多 +1）", evts2.length === 1 && evts2[0]?.version === 3, `v=${evts2[0]?.version}`);
    h.close();
  }

  // ---------- 汇总 ----------
  const failed = results.filter(([, p]) => !p);
  console.log(`\n===== Artifact Domain Contract: ${results.length - failed.length}/${results.length} 通过 =====`);
  if (failed.length) {
    for (const [name, , detail] of failed) console.log(`  - ${name}${detail ? ` (${detail})` : ""}`);
    process.exit(1);
  }
}

main().catch((error) => {
  // 异常路径：先兜底清理所有 temp harness，再以非零退出（禁止 process.exit 强过测试）
  cleanupAll();
  console.error("\n[artifact-domain] 未捕获异常，测试中止:", error);
  process.exitCode = 1;
});



