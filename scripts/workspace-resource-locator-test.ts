/**
 * WorkspaceResourceLocator R1 Scope Completion — 真实 AppDatabase + LibraryService + FTS + Binding
 * 冻结契约（与主文档 §19 对齐）：
 * - Workspace 是 scope 权威：Current + ancestors，默认不含 sibling/child
 * - 与 Library 统一 task scope：当前项目 + 当前/祖先工作空间自有资料 + 精确引用
 * - explicitDirectChild 仅 direct child + !effectiveArchived 时临时加入 scope
 * - Search != Injection：仅轻量 hit，hit 不含 full content
 * - Source of Truth：真实 Library，hit 后需 library_read
 * - R1 仅 Library FTS5 trigram，无 embedding/vector/chunks/watcher
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { WorkspaceResourceLocator } from "../src/main/workspace/WorkspaceResourceLocator";
import { WorkspaceSemanticProvider, SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, f32ToBlob } from "../src/main/retrieval/WorkspaceSemanticProvider";
import type { SemanticRuntime } from "../src/main/retrieval/SemanticRuntime";
import { assembleWorkspaceSharedContext } from "../src/shared/workspace-shared-context";
import type { SpaceDto } from "../src/shared/agent-ipc";

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) { if (cond) { passed++; console.log(`  ✓ ${msg}`);} else { failed++; console.error(`  ✗ ${msg}`);} }
function eq<T>(a: T, b: T, msg: string) { try { assert.deepStrictEqual(a,b); passed++; console.log(`  ✓ ${msg}`);} catch(e){ failed++; console.error(`  ✗ ${msg}\n    expected ${JSON.stringify(b)}\n    actual ${JSON.stringify(a)}`);} }

function mkSpace(id: string, name: string, parentId: string | null, extra: Partial<SpaceDto> = {}): SpaceDto {
  return { id, name, parentId, sortOrder: 1000, createdAt: 1, ...extra };
}

function addProject(db: AppDatabase, id: string, name = id): void {
  db.connection
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`)
    .run(id, name, Date.now(), Date.now(), 0, 128000);
}

function mkTask(db: AppDatabase, id: string, spaceId: string | null, projectId: string | null): void {
  db.upsertTask({ id, title: id, updatedAt: Date.now(), spaceId, projectId } as any);
}

async function mkItem(lib: LibraryService, spaceId: string, title: string, content: string) {
  const item = lib.createItem({ spaceId, kind: "markdown", title } as any);
  lib.writeContent({ id: item.id, content });
  return item;
}

async function withTmpDb(fn: (db: AppDatabase, dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "r1scope-"));
  const db = new AppDatabase(join(dir, "test.db"));
  try { await fn(db, dir); } finally { try{ db.close(); }catch{} rmSync(dir,{recursive:true, force:true}); }
}

async function main() {
  console.log("== §19.2 Scope：Current+Ancestors 生效、sibling 隔离、绑定继承 ==");
  await withTmpDb(async (db, dir) => {
    const lib = new LibraryService(db, { libraryRoot: join(dir, "library") });
    const binding = new WorkspaceLibraryBindingService(db);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const proj = "proj-scope";
    addProject(db, proj);

    // Workspace 树：Root → R&D → { Water, Dust }；ERP 独立 sibling
    db.createSpace(mkSpace("root", "Root", null));
    db.createSpace(mkSpace("rd", "R&D", "root"));
    db.createSpace(mkSpace("water", "Water", "rd"));
    db.createSpace(mkSpace("dust", "Dust", "rd"));
    db.createSpace(mkSpace("erp", "ERP", null));

    // 工作空间自有资料：无需重复绑定；继承当前/祖先，兄弟保持隔离
    const libRoot = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "root" });
    const libRd = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "rd" });
    const libWater = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "water" });
    const libDust = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "dust" });
    const libErp = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "erp" });


    const iRoot = await mkItem(lib, libRoot.id, "root doc", "shared marker root");
    const iRd = await mkItem(lib, libRd.id, "rd doc", "shared marker rd");
    const iWater = await mkItem(lib, libWater.id, "water doc", "shared marker water");
    const iDust = await mkItem(lib, libDust.id, "dust doc", "shared marker dust");
    const iErp = await mkItem(lib, libErp.id, "erp doc", "shared marker erp");
    await lib.flushPendingIndexes();

    // 任务位于 Water
    mkTask(db, "t-water", "water", proj);
    const hits = loc.search({ query: "shared marker", taskId: "t-water" }).hits.map((h) => h.id);
    ok(hits.includes(iRoot.id), "lib-root（root binding）✅");
    ok(hits.includes(iRd.id), "lib-rd（R&D binding）✅");
    ok(hits.includes(iWater.id), "lib-water（Water binding）✅");
    ok(!hits.includes(iDust.id), "lib-dust（sibling Dust）❌");
    ok(!hits.includes(iErp.id), "lib-erp（sibling ERP）❌");

    // scope metadata 也确认 current+ancestors
    const res = loc.search({ query: "shared marker", taskId: "t-water" });
    ok(res.scopeSpaceIds.includes("water") && res.scopeSpaceIds.includes("rd") && res.scopeSpaceIds.includes("root"), "scope = Water+R&D+Root");
    ok(!res.scopeSpaceIds.includes("dust") && !res.scopeSpaceIds.includes("erp"), "scope 不含 sibling");
  });

  console.log("== §19.3 Child：默认隔离，显式 direct child 临时扩 scope，grandchild/archived 拒绝 ==");
  await withTmpDb(async (db, dir) => {
    const lib = new LibraryService(db, { libraryRoot: join(dir, "library") });
    const binding = new WorkspaceLibraryBindingService(db);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const proj = "proj-child";
    addProject(db, proj);

    db.createSpace(mkSpace("water", "Water", null));
    db.createSpace(mkSpace("child", "Child", "water"));
    db.createSpace(mkSpace("grand", "Grand", "child"));
    db.createSpace(mkSpace("archchild", "ArchChild", "water"));

    const libWater = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "water" });
    const libChild = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "child" });
    const libGrand = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "grand" });
    const libArch = lib.ensureOwnedSpace({ type: "workspace", workspaceId: "archchild" });

    const iChild = await mkItem(lib, libChild.id, "child doc", "child marker");
    const iGrand = await mkItem(lib, libGrand.id, "grand doc", "grand marker");
    const iArch = await mkItem(lib, libArch.id, "arch doc", "arch marker");
    db.archiveSpace("archchild", true);
    await lib.flushPendingIndexes();

    mkTask(db, "t-water", "water", proj);

    // 默认：child 隔离
    const defHits = loc.search({ query: "child marker", taskId: "t-water" }).hits;
    ok(!defHits.some((h) => h.id === iChild.id), "默认 child lib ❌");

    // 显式 direct child
    const expHits = loc.search({ query: "child marker", taskId: "t-water", explicitDirectChildSpaceId: "child" }).hits;
    ok(expHits.some((h) => h.id === iChild.id), "显式 direct child lib ✅");

    // grandchild 不能越级
    const grandHits = loc.search({ query: "grand marker", taskId: "t-water", explicitDirectChildSpaceId: "grand" }).hits;
    ok(!grandHits.some((h) => h.id === iGrand.id), "grandchild ❌");

    // archived child
    const archHits = loc.search({ query: "arch marker", taskId: "t-water", explicitDirectChildSpaceId: "archchild" }).hits;
    ok(!archHits.some((h) => h.id === iArch.id), "archived child ❌");
  });

  console.log("== §19.4 Permission：当前项目资料无需绑定；跨项目拒绝；Personal 须显式引用 ==");
  await withTmpDb(async (db, dir) => {
    const lib = new LibraryService(db, { libraryRoot: join(dir, "library") });
    const binding = new WorkspaceLibraryBindingService(db);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const projA = "proj-a";
    const projB = "proj-b";
    addProject(db, projA);
    addProject(db, projB);

    db.createSpace(mkSpace("ws", "WS", null));

    const libBoundSame = lib.createSpace({ name: "BoundSame", projectId: projA } as any);
    const libBoundWrong = lib.createSpace({ name: "BoundWrong", projectId: projB } as any);
    const libUnboundSame = lib.createSpace({ name: "UnboundSame", projectId: projA } as any);

    binding.bind("ws", libBoundSame.id);
    binding.bind("ws", libBoundWrong.id);
    // libUnboundSame 不绑定

    const iBoundSame = await mkItem(lib, libBoundSame.id, "bound same", "perm marker same");
    const iBoundWrong = await mkItem(lib, libBoundWrong.id, "bound wrong", "perm marker wrong");
    const iUnboundSame = await mkItem(lib, libUnboundSame.id, "unbound same", "perm marker unbound");

    // 显式恢复历史 personal 夹具；正常启动不再自动创建该空间。
    lib.ensureReady();
    // personal 未绑定
    const iPersonalUnbound = await mkItem(lib, "personal", "personal unbound", "perm marker personal");
    await lib.flushPendingIndexes();

    mkTask(db, "t-perm", "ws", projA);
    const hits = loc.search({ query: "perm marker", taskId: "t-perm" }).hits.map((h) => h.id);
    ok(hits.includes(iBoundSame.id), "team bound+同项目 ✅");
    ok(!hits.includes(iBoundWrong.id), "team bound+跨项目 ❌");
    ok(hits.includes(iUnboundSame.id), "当前项目资料不要求重复绑定工作空间 ✅");
    ok(!hits.includes(iPersonalUnbound.id), "personal 未绑定 ❌");

    // 绑定 personal 后可进入
    binding.bind("ws", "personal");
    const hits2 = loc.search({ query: "perm marker personal", taskId: "t-perm" }).hits.map((h) => h.id);
    ok(hits2.includes(iPersonalUnbound.id), "personal 绑定后 ✅");
  });

  console.log("== §19.4b Collection Binding：只检索绑定文件夹及其子树，不泄漏同库其他目录/根目录 ==");
  await withTmpDb(async (db, dir) => {
    const lib = new LibraryService(db, { libraryRoot: join(dir, "library") });
    const binding = new WorkspaceLibraryBindingService(db);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    db.createSpace(mkSpace("root", "Root", null));
    db.createSpace(mkSpace("child", "Child", "root"));
    lib.ensureReady();

    const publicFolder = lib.createCollection({ spaceId: "personal", parentId: null, name: "公共知识" } as any);
    const publicChild = lib.createCollection({ spaceId: "personal", parentId: publicFolder.id, name: "子目录" } as any);
    const privateFolder = lib.createCollection({ spaceId: "personal", parentId: null, name: "私人目录" } as any);

    const make = async (title: string, collectionId: string | null) => {
      const item = lib.createItem({ spaceId: "personal", collectionId, kind: "markdown", title } as any);
      lib.writeContent({ id: item.id, content: `COLLSCOPE ${title}` });
      return item;
    };
    const inRoot = await make("COLLSCOPE-A", publicFolder.id);
    const inChild = await make("COLLSCOPE-B", publicChild.id);
    const sibling = await make("COLLSCOPE-C", privateFolder.id);
    const personalRoot = await make("COLLSCOPE-ROOT", null);

    binding.bindCollection("root", "personal", publicFolder.id);
    const hits = loc.search({ query: "COLLSCOPE", currentSpaceId: "child", limit: 20 }).hits.map((h) => h.id);
    ok(hits.includes(inRoot.id), "绑定文件夹本级 ✅");
    ok(hits.includes(inChild.id), "绑定文件夹子目录 ✅");
    ok(!hits.includes(sibling.id), "同资料库 sibling 文件夹 ❌");
    ok(!hits.includes(personalRoot.id), "同资料库根目录文件 ❌");
    eq(new Set(hits).size, hits.length, "collection scope 检索结果无重复 item");
  });

  console.log("== §19.5 Retrieval：中文 / 中英混合 / filename / title / body / empty / no-result / limit / determinism / short-query ==");
  await withTmpDb(async (db, dir) => {
    db.createSpace(mkSpace("ws", "WS", null));
    const lib = new LibraryService(db, { libraryRoot: join(dir, "library") });
    const binding = new WorkspaceLibraryBindingService(db);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const proj = "proj-cn";
    addProject(db, proj);

    const libSpace = lib.createSpace({ name: "T", projectId: proj } as any);
    binding.bind("ws", libSpace.id);

    const itemTemp = await mkItem(lib, libSpace.id, "报告", "温度补偿 参数 需要 校准");
    const itemMixed = await mkItem(lib, libSpace.id, "Mixed", "hello 温度补偿 world");
    const itemTitle = await mkItem(lib, libSpace.id, "温度补偿表", "无关 body");
    const itemFilename = await mkItem(lib, libSpace.id, "其他标题", "无关 body 2");
    // filename 命中：通过 updateItem 改 filename 不易，改用 title 覆盖 filename 场景（title==filename 由 createItem 生成）
    await lib.flushPendingIndexes();

    mkTask(db, "t-cn", "ws", proj);

    ok(loc.search({ query: "温度补偿", taskId: "t-cn" }).hits.some((h) => h.id === itemTemp.id), "中文 body 命中");
    ok(loc.search({ query: "hello 温度补偿", taskId: "t-cn" }).hits.some((h) => h.id === itemMixed.id), "中英混合命中");
    ok(loc.search({ query: "温度补偿表", taskId: "t-cn" }).hits.some((h) => h.id === itemTitle.id), "title 命中");
    ok(loc.search({ query: "报告", taskId: "t-cn" }).hits.some((h) => h.id === itemTemp.id), "title 命中（报告）");
    ok(loc.search({ query: "   ", taskId: "t-cn" }).hits.length === 0, "空 query 无结果");
    ok(loc.search({ query: "不存在的XYZ123", taskId: "t-cn" }).hits.length === 0, "无结果为空");

    // limit + determinism
    const r1 = loc.search({ query: "温度", taskId: "t-cn", limit: 2 });
    ok(r1.hits.length <= 2, "limit 生效");
    const d1 = loc.search({ query: "温度", taskId: "t-cn", limit: 3 });
    const d2 = loc.search({ query: "温度", taskId: "t-cn", limit: 3 });
    eq(d1.hits.map((h) => h.id), d2.hits.map((h) => h.id), "determinism");

    // 短查询（<3）回退：真实走 LibraryService.search 的短查询兜底
    const short = loc.search({ query: "报", taskId: "t-cn" });
    ok(short.hits.some((h) => h.id === itemTemp.id), "短查询 title 命中");
  });

  console.log("== §19.6 Source of Truth：hit 无正文，library_read 读真实源 ==");
  await withTmpDb(async (db, dir) => {
    db.createSpace(mkSpace("ws", "WS", null));
    const lib = new LibraryService(db, { libraryRoot: join(dir, "library") });
    const binding = new WorkspaceLibraryBindingService(db);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const proj = "proj-sot";
    addProject(db, proj);
    const libSpace = lib.createSpace({ name: "S", projectId: proj } as any);
    binding.bind("ws", libSpace.id);
    const item = await mkItem(lib, libSpace.id, "sot", "sot body hello 真实正文");
    await lib.flushPendingIndexes();
    mkTask(db, "t-sot", "ws", proj);

    const res = loc.search({ query: "真实正文", taskId: "t-sot" });
    ok(res.hits.length > 0, "search 有结果");
    const hit = res.hits[0]!;
    ok(!("content" in (hit as any)) && !("body" in (hit as any)) && !("documentText" in (hit as any)), "hit 不含 body/fullContent/documentText");
    const read = lib.readContent(hit.id);
    ok(read.content.includes("真实正文"), "library_read 读真实正文");
  });

  console.log("== §19.7 Search ≠ Context：搜索前后 WorkspaceSharedContext digest 不变 ==");
  await withTmpDb(async (db, dir) => {
    db.createSpace(mkSpace("ws", "WS", null));
    const lib = new LibraryService(db, { libraryRoot: join(dir, "library") });
    const binding = new WorkspaceLibraryBindingService(db);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const proj = "proj-inj";
    addProject(db, proj);
    const libSpace = lib.createSpace({ name: "S", projectId: proj } as any);
    binding.bind("ws", libSpace.id);
    await mkItem(lib, libSpace.id, "inj", "inject body hello");
    await lib.flushPendingIndexes();
    mkTask(db, "t-inj", "ws", proj);

    const sharedInput = () => ({ spaces: [mkSpace("ws", "WS", null)], currentSpaceId: "ws" as string | null, itemsBySpace: {} });
    const before = assembleWorkspaceSharedContext(sharedInput()).digest;
    const searchRes = loc.search({ query: "inject", taskId: "t-inj" });
    ok(searchRes.hits.length > 0, "search 有结果");
    const after = assembleWorkspaceSharedContext(sharedInput()).digest;
    eq(before, after, "search 不改变 WorkspaceSharedContext digest");
  });

  console.log("== Unified task scope：精确引用在词法/分块/语义排名前限域，未知任务拒绝 ==");
  await withTmpDb(async (db, dir) => {
    db.createSpace(mkSpace("scope-workspace", "Scoped", null));
    const lib = new LibraryService(db, { libraryRoot: join(dir, "library") });
    lib.ensureReady();
    mkTask(db, "scope-task", "scope-workspace", null);
    // Unauthorized exact matches precede the authorized prefix hit. Filtering only after top-K would lose it.
    for (let i = 0; i < 12; i++) {
      await mkItem(lib, "personal", "scope-token", `scope-token private-${i} semantic content`);
    }
    const referenced = await mkItem(lib, "personal", "scope-token explicitly attached", "scope-token permitted semantic content");
    lib.attachToTask({ taskId: "scope-task", itemId: referenced.id });
    await lib.flushPendingIndexes();
    const loc = new WorkspaceResourceLocator(db, lib);
    eq(loc.search({ taskId: "scope-task", query: "scope-token", limit: 1 }).hits.map((hit) => hit.id), [referenced.id], "精确引用在SQL排名前限制，合法命中不被其他个人资料挤掉");
    eq(loc.search({ taskId: "unknown-task", currentSpaceId: "scope-workspace", projectId: "forged", query: "scope-token" }).hits, [], "未知task不能借工作空间或项目fallback检索");

    // Fixed one-hot vectors are test fixtures for SQL scoping, not a substitute production model.
    const vector = new Float32Array(SEMANTIC_DIMENSION); vector[0] = 1;
    const chunks = db.connection.prepare("SELECT id, hash FROM library_chunks").all() as Array<{ id: string; hash: string }>;
    const insert = db.connection.prepare(`INSERT INTO library_chunk_embeddings
      (chunk_id, model_id, model_version, chunk_hash, dimension, embedding, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const chunk of chunks) insert.run(chunk.id, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, chunk.hash, SEMANTIC_DIMENSION, f32ToBlob(vector), 1);
    const runtime = { embed: async () => vector, getLoadMs: () => 0 } as unknown as SemanticRuntime;
    const provider = new WorkspaceSemanticProvider(db, { runtime });
    const semantic = await provider.search({ query: "semantic synonym", allowedLibrarySpaceIds: [], allowedLibraryItemIds: [referenced.id], limit: 1 });
    eq(semantic.map((hit) => hit.itemId), [referenced.id], "语义Provider单条白名单在SQL召回前生效，不放大到整个人库");
    const semanticLoc = new WorkspaceResourceLocator(db, lib, undefined, { semanticProvider: provider });
    const semanticResult = await semanticLoc.searchAsync({ taskId: "scope-task", query: "unmatched semantic synonym", mode: "semantic", limit: 1 });
    eq(semanticResult.hits.map((hit) => hit.id), [referenced.id], "Locator显式引用的语义命中与词法读取范围一致");

    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const pausedRuntime = { embed: async () => { entered(); await waiting; return vector; }, getLoadMs: () => 0 } as unknown as SemanticRuntime;
    const paused = new WorkspaceResourceLocator(db, lib, undefined, { semanticProvider: new WorkspaceSemanticProvider(db, { runtime: pausedRuntime }) });
    const pending = paused.searchAsync({ taskId: "scope-task", query: "unmatched semantic synonym", mode: "semantic" });
    await started;
    lib.detachFromTask({ taskId: "scope-task", itemId: referenced.id });
    release();
    eq((await pending).hits, [], "异步语义检索期间取消引用，返回前撤销旧结果");
  });

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
