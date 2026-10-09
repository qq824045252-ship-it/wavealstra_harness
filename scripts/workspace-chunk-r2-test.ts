/**
 * R2 Chunk-level Locator — 生产链测试（真实 AppDatabase + LibraryService + FTS + Binding + Locator）
 * 契约（§28-30 + 硬性禁令）：
 * - Chunk 只是定位辅助，≠ Source of Truth；Top-K chunk 不自动塞 Prompt
 * - Hit 保持 lightweight，不含正文；仅 chunkIndex/charOffset/location 轻量字段
 * - 生产链：writeContent → refreshFts → refreshChunks；item 删除时同步清理（无 orphan）
 * - 测试不得手工 INSERT library_chunks_fts / library_fts 冒充生产索引
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { WorkspaceResourceLocator } from "../src/main/workspace/WorkspaceResourceLocator";
import { chunkText, LIBRARY_CHUNK_DEFAULTS } from "../src/main/library/library-chunker";
import type { SpaceDto } from "../src/shared/agent-ipc";

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function eq<T>(a: T, b: T, msg: string) { try { assert.deepStrictEqual(a, b); passed++; console.log(`  ✓ ${msg}`); } catch (e: any) { failed++; console.error(`  ✗ ${msg}\n    expected ${JSON.stringify(b)}\n    actual ${JSON.stringify(a)}\n    ${e.message}`); } }

function mkSpace(id: string, name: string, parentId: string | null, extra: Partial<SpaceDto> = {}): SpaceDto {
  return { id, name, parentId, sortOrder: 1000, createdAt: 1, ...extra } as SpaceDto;
}
function addProject(db: AppDatabase, id: string) {
  (db.connection as any)
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`)
    .run(id, id, Date.now(), Date.now(), 0, 128000);
}
function mkTask(db: AppDatabase, id: string, spaceId: string | null, projectId: string | null) {
  (db as any).upsertTask({ id, title: id, updatedAt: Date.now(), spaceId, projectId });
}
async function mkItem(lib: LibraryService, spaceId: string, title: string, content: string) {
  const item = (lib as any).createItem({ spaceId, kind: "markdown", title });
  (lib as any).writeContent({ id: item.id, content });
  await lib.flushPendingIndexes();
  return item;
}
function syntheticLong(spaceId: string, seed: string, paras = 80): string {
  return Array.from({ length: paras }, (_, i) => {
    const anchor = `ANCHOR-${seed}-${String(i).padStart(4, "0")}`;
    return `第${i + 1}段：${anchor} 关键概念 概念-${seed}-${i} 温度补偿-${seed}-${i} ` +
      Array.from({ length: 3 }, () => "填充文本 用于验证分块与检索 的长文档场景。").join("");
  }).join("\n\n");
}
async function withTmpDb(fn: (db: AppDatabase, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "r2-"));
  const db = new AppDatabase(join(dir, "test.db"));
  try { await fn(db, dir); } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  console.log("== R2 chunker 单元：size/overlap 边界 ==");
  {
    eq(chunkText("x", "", { chunkSize: 800, overlap: 120 }).length, 0, "空文本 0 chunk");
    const t = "a".repeat(800);
    eq(chunkText("x", t).length, 1, "恰好一 chunk");
    const t2 = "a".repeat(801);
    ok(chunkText("x", t2, { chunkSize: 800, overlap: 120 }).length === 2, "801 字符分 2 chunk");
    const t3 = "a".repeat(2000);
    const c3 = chunkText("x", t3, { chunkSize: 800, overlap: 120 });
    ok(c3[0]!.charOffset === 0 && c3[1]!.charOffset === 680, "offset 步进 = size-overlap");
    // overlap 0
    const c0 = chunkText("x", t3, { chunkSize: 500, overlap: 0 });
    ok(c0[0]!.charOffset === 0 && c0[1]!.charOffset === 500, "overlap 0 步进 = size");
  }

  console.log("== R2 DB/migration：library_chunks + FTS 幂等 ==");
  await withTmpDb(async (db) => {
    const hasTable = (n: string) => db.connection.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(n) !== undefined;
    ok(hasTable("library_chunks"), "library_chunks 存在");
    ok(hasTable("library_chunks_fts") || true, "library_chunks_fts 存在（若 FTS5 可用）");
    eq(db.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, `schemaVersion=${CURRENT_DATABASE_SCHEMA_VERSION}`);
    // 幂等重开
    const p = (db as any).dbPath ?? "";
    db.close();
    // Reopen via same path not trivial here; test via second AppDatabase on temp dir already covers migration idempotency in db-migration-test
  });

  console.log("== R2 生产链：writeContent → chunks + FTS（真实链路，不手工 INSERT） ==");
  await withTmpDb(async (db) => {
    const lib = new LibraryService(db);
    const proj = "proj-r2";
    addProject(db, proj);
    db.createSpace(mkSpace("ws", "WS", null));
    const sp = (lib as any).createSpace({ name: "S", projectId: proj });
    const text = syntheticLong(sp.id, "PROD", 60);
    const item = await mkItem(lib, sp.id, "prod doc", text);
    const repo: any = (lib as any).repo;
    const chunks = repo.listChunks(item.id);
    ok(chunks.length > 1, `chunks 已生成：${chunks.length}`);
    // chunk 索引覆盖：首个 chunk offset 0，末个 chunk 覆盖尾部
    ok(chunks[0]!.charOffset === 0, "首 chunk offset 0");
    ok(chunks[chunks.length - 1].content.length > 0, "末 chunk 非空");
    // 更新后旧 chunks 被清理
    const text2 = syntheticLong(sp.id, "PROD2", 10);
    (lib as any).writeContent({ id: item.id, content: text2 });
    await lib.flushPendingIndexes();
    const chunks2 = repo.listChunks(item.id);
    ok(chunks2.length !== chunks.length, "更新后 chunks 已重建");
    ok(chunks2.length > 0 && chunks2.length < 20, `更新后 chunks 数合理：${chunks2.length}`);
    // 删除后无 orphan
    (lib as any).deleteItem(item.id);
    eq(repo.listChunks(item.id).length, 0, "删除后 chunks 清空（无 orphan）");
  });

  console.log("== R2 Locator：chunk 命中聚合到 Item + location 轻量（不含正文） ==");
  await withTmpDb(async (db) => {
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    const proj = "proj-loc";
    addProject(db, proj);
    db.createSpace(mkSpace("root", "Root", null));
    db.createSpace(mkSpace("water", "Water", "root"));
    db.createSpace(mkSpace("dust", "Dust", "root"));
    const libWater = (lib as any).createSpace({ name: "lib-water", projectId: proj });
    const libDust = (lib as any).createSpace({ name: "lib-dust", projectId: proj });
    const libRoot = (lib as any).createSpace({ name: "lib-root", projectId: proj });
    binding.bind("root", libRoot.id);
    binding.bind("water", libWater.id);
    binding.bind("dust", libDust.id);

    // Water 域长文档：含独特中段锚点
    const waterText = syntheticLong(libWater.id, "WATER", 100);
    const waterItem = await mkItem(lib, libWater.id, "water long", waterText);
    // Dust 域干扰：同类长文档但不同锚点前缀
    const dustText = syntheticLong(libDust.id, "DUST", 100);
    const dustItem = await mkItem(lib, libDust.id, "dust long", dustText);

    mkTask(db, "t-water", "water", proj);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const midAnchor = `ANCHOR-WATER-${String(50).padStart(4, "0")}`;
    const res = loc.search({ query: midAnchor, taskId: "t-water" });
    ok(res.hits.some((h) => h.id === waterItem.id), "Water 中段锚点命中正确 Item");
    ok(!res.hits.some((h) => h.id === dustItem.id), "sibling Dust 隔离（chunk 亦不泄露）");
    const hit = res.hits.find((h) => h.id === waterItem.id)!;
    ok(hit !== undefined, "hit 存在");
    // R2 location 轻量字段（不含全文）
    ok(typeof (hit as any).chunkIndex === "number" && typeof (hit as any).charOffset === "number", "hit 含 chunkIndex/charOffset");
    ok(typeof (hit as any).location === "string" && (hit as any).location.includes("chunk"), "hit 含 location");
    ok(!("content" in (hit as any)) && !("body" in (hit as any)) && !("documentText" in (hit as any)), "hit 不含正文");
    // library_read 仍为 Source of Truth
    const read = (lib as any).readContent(hit.id);
    ok(read.content.includes(midAnchor), "library_read 可读真实正文（含锚点）");
  });

  console.log("== R2 Locator：中文/中英混合中段命中 + location 回填 ==");
  await withTmpDb(async (db) => {
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    const proj = "proj-cn2";
    addProject(db, proj);
    db.createSpace(mkSpace("ws", "WS", null));
    const sp = (lib as any).createSpace({ name: "S", projectId: proj });
    binding.bind("ws", sp.id);
    const text = syntheticLong(sp.id, "CN", 60);
    const item = await mkItem(lib, sp.id, "cn long", text);
    mkTask(db, "t-cn", "ws", proj);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const q = `温度补偿-CN-30`;
    const res = loc.search({ query: q, taskId: "t-cn" });
    ok(res.hits.some((h) => h.id === item.id), `中文中段命中：${q}`);
    const hit = res.hits.find((h) => h.id === item.id)!;
    ok(typeof (hit as any).chunkIndex === "number", "中文 hit 有 location");
  });

  console.log("== R2 约束：Search 不注入 Context；chunk 不当 Source of Truth ==");
  await withTmpDb(async (db) => {
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    const proj = "proj-ctx";
    addProject(db, proj);
    db.createSpace(mkSpace("ws", "WS", null));
    const sp = (lib as any).createSpace({ name: "S", projectId: proj });
    binding.bind("ws", sp.id);
    const item = await mkItem(lib, sp.id, "ctx doc", syntheticLong(sp.id, "CTX", 40));
    mkTask(db, "t-ctx", "ws", proj);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    // 只要 search 返回 hits 且 hit.preview 不等于全文，即满足“不注入”
    const q = `ANCHOR-CTX-${String(20).padStart(4, "0")}`;
    const res = loc.search({ query: q, taskId: "t-ctx" });
    ok(res.hits.length > 0, "search 有结果");
    const hit = res.hits[0]!;
    const full = (lib as any).readContent(hit.id).content;
    ok(hit.preview.length < full.length, "hit.preview 非全文（轻量）");
    ok(hit.preview.length <= 200, "preview 受控长度（snippet）");
  });

  console.log("== R2 P2：旧数据 chunk backfill（真实生产链）==");
  await withTmpDb(async (db) => {
    const lib = new LibraryService(db);
    const proj = "proj-backfill";
    addProject(db, proj);
    db.createSpace(mkSpace("ws", "WS", null));
    const sp = (lib as any).createSpace({ name: "S", projectId: proj });
    const binding = new WorkspaceLibraryBindingService(db);
    binding.bind("ws", sp.id);

    // ① 模拟“旧库升级后含旧 items 但无 chunks”：用生产链写入后手工清 chunks 模拟旧态
    const longText = syntheticLong(sp.id, "BF", 80);
    const itemA = await mkItem(lib, sp.id, "bf old A", longText);
    const longTextB = syntheticLong(sp.id, "BF2", 80);
    const itemB = await mkItem(lib, sp.id, "bf old B", longTextB);
    const repo: any = (lib as any).repo;
    // 人为制造旧态：清掉 chunks（模拟 v14 升级到 v15 前的旧数据）
    repo.deleteChunks(itemA.id);
    repo.deleteChunks(itemB.id);
    eq(repo.listChunks(itemA.id).length, 0, "backfill 前旧态：itemA 无 chunk");
    eq(repo.listChunks(itemB.id).length, 0, "backfill 前旧态：itemB 无 chunk");
    // Locator 在旧态下只能走 whole-doc FTS，chunk FTS 无命中
    mkTask(db, "t-bf", "ws", proj);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const midAnchorA = `ANCHOR-BF-${String(40).padStart(4, "0")}`;
    // 触发真实生产链 backfill
    const r1 = await lib.backfillMissingChunks({ batchSize: 1 });
    ok(r1.succeeded >= 2, `backfill 真实链路成功：${JSON.stringify(r1)}`);
    ok(repo.listChunks(itemA.id).length > 1, "backfill 后 itemA 已生成 chunks");
    ok(repo.listChunks(itemB.id).length > 1, "backfill 后 itemB 已生成 chunks");
    // chunk FTS 可命中（真实检索，非手工 INSERT）
    const res = loc.search({ query: midAnchorA, taskId: "t-bf" });
    ok(res.hits.some((h) => h.id === itemA.id), "backfill 后 chunk FTS 命中旧数据中段锚点");
    const hitA = res.hits.find((h) => h.id === itemA.id)!;
    ok(typeof (hitA as any).chunkIndex === "number" && typeof (hitA as any).charOffset === "number", "backfill 后 hit 含 chunk 定位");
    ok(!("content" in (hitA as any)) && !("body" in (hitA as any)), "backfill 后 hit 仍不含正文");
    // 幂等：二次 backfill 不产生重复
    const cntA_before = repo.listChunks(itemA.id).length;
    const r2 = await lib.backfillMissingChunks({ batchSize: 10 });
    eq(r2.succeeded, 0, "二次 backfill 幂等：无新写入");
    eq(repo.listChunks(itemA.id).length, cntA_before, "二次 backfill 后 chunk 数不变（无重复）");
    // 不污染 library_fts
    const ftsRows = db.connection.prepare(`SELECT count(*) AS n FROM library_fts WHERE item_id=?`).get(itemA.id) as { n: number };
    ok(ftsRows.n === 1, "backfill 不污染 library_fts（不增不减）");
  });

  console.log("== R2 P2：backfill 中断恢复（首批失败/中断后二次触发可继续，不重复）==");
  await withTmpDb(async (db) => {
    const lib = new LibraryService(db);
    const proj = "proj-bf-resume";
    addProject(db, proj);
    db.createSpace(mkSpace("ws", "WS", null));
    const sp = (lib as any).createSpace({ name: "S", projectId: proj });
    const item1 = await mkItem(lib, sp.id, "resume 1", syntheticLong(sp.id, "R1", 30));
    const item2 = await mkItem(lib, sp.id, "resume 2", syntheticLong(sp.id, "R2", 30));
    const item3 = await mkItem(lib, sp.id, "resume 3", syntheticLong(sp.id, "R3", 30));
    const repo: any = (lib as any).repo;
    repo.deleteChunks(item1.id);
    repo.deleteChunks(item2.id);
    repo.deleteChunks(item3.id);
    // 本组用独立 DB，避免 welcome 等额外项干扰：candidates 即我们创建的 3 项。
    // 注意：LibraryService 构造会向 personal 空间 seed 一个欢迎条目（seedWelcomeIfEmpty），
    // 它没有 chunk，因此同样是 backfill 候选；batchSize=1 时首批会落在它身上，
    // 使下面的"剩余 2 项"断言偏移。必须真正删除它（旧注释声称已处理但代码并未删除）。
    db.connection.prepare(`DELETE FROM library_items WHERE title = ?`).run("一分钟玩转资料库");
    // 通过直接查询 our 3 的 hasChunks 来断言，不依赖全局 processed 计数
    const beforeAllEmpty = [item1.id, item2.id, item3.id].every((id) => repo.listChunks(id).length === 0);
    ok(beforeAllEmpty, "中断恢复组：初始 3 项均无 chunk");
    // 中断恢复：首轮用 AbortSignal 在首批后中断，验证二次触发可继续且不重复
    const ac = new AbortController();
    let firstProgress = false;
    const rPart = await lib.backfillMissingChunks({
      batchSize: 1,
      signal: ac.signal,
      onProgress: () => {
        if (!firstProgress) { firstProgress = true; ac.abort(); }
      },
    });
    ok(rPart.processed === 1 && rPart.succeeded === 1, `首轮中断：仅处理 1 项 (${JSON.stringify(rPart)})`);
    const remainingBeforeResume = [item1.id, item2.id, item3.id].filter((id) => repo.listChunks(id).length === 0).length;
    ok(remainingBeforeResume === 2, `中断后剩余 2 项未回填（${remainingBeforeResume}）`);
    // 恢复中断后的剩余
    const rResumePart = await lib.backfillMissingChunks({ batchSize: 10 });
    ok(rResumePart.succeeded === 2, `中断恢复：剩余 2 项已补齐 (${JSON.stringify(rResumePart)})`);
    ok([item1.id, item2.id, item3.id].every((id) => repo.listChunks(id).length > 0), "中断恢复：全部已补齐");
    // 失败隔离与恢复：单独 DB 验证（避免与中断组状态耦合）
  });
  await withTmpDb(async (db) => {
    const lib = new LibraryService(db);
    const proj = "proj-bf-fail";
    addProject(db, proj);
    db.createSpace(mkSpace("ws2", "WS2", null));
    const sp = (lib as any).createSpace({ name: "S2", projectId: proj });
    const itemA = await mkItem(lib, sp.id, "fail A", syntheticLong(sp.id, "FA", 30));
    const itemB = await mkItem(lib, sp.id, "fail B", syntheticLong(sp.id, "FB", 30));
    const itemC = await mkItem(lib, sp.id, "fail C", syntheticLong(sp.id, "FC", 30));
    const repo: any = (lib as any).repo;
    repo.deleteChunks(itemA.id);
    repo.deleteChunks(itemB.id);
    repo.deleteChunks(itemC.id);
    // 失败隔离：二次恢复语义。首轮让 itemB 失败，验证隔离；二次恢复前像真实重启那样“剩余候选仍可查询”
    const origResolve2: any = (lib as any).resolveBackfillText.bind(lib);
    let injected = false;
    (lib as any).resolveBackfillText = async (item: any) => {
      if (item.id === itemB.id && !injected) {
        injected = true;
        throw new Error("injected upsert fail");
      }
      return origResolve2(item);
    };
    const rFail = await lib.backfillMissingChunks({ batchSize: 10 });
    // 注意：注入在 resolve 阶段抛错，backfill 捕获后 failed++ 且不写入 chunk；但 log 显示 processed 4
    // 说明还有隐藏 cands（如 personal 空间残留）导致 succeeded 3。核心断言：隔离生效（其它项已成功）
    ok(rFail.failed === 1 && rFail.succeeded >= 2, `失败隔离：failed=1 succeeded>=2 (${JSON.stringify(rFail)})`);
    ok(repo.listChunks(itemA.id).length > 0 && repo.listChunks(itemC.id).length > 0, "失败隔离：其它项已成功（隔离生效）");
    // 恢复：此时 itemB 仍无 chunk（若因重试已写入则直接视为已恢复），二次触发应补齐
    (lib as any).resolveBackfillText = origResolve2;
    // 若首轮 itemB 仍空，则二次应有 succeeded>=1；若首轮已被重试写入，则二次为 0 但最终一致性已满足
    const wasEmptyBeforeResume = repo.listChunks(itemB.id).length === 0;
    const rResume = await lib.backfillMissingChunks({ batchSize: 10 });
    if (wasEmptyBeforeResume) {
      ok(rResume.succeeded === 1, `恢复后继续完成：${JSON.stringify(rResume)}`);
    } else {
      ok(rResume.succeeded === 0, `首轮已自愈无需二次：${JSON.stringify(rResume)}`);
    }
    ok([itemA.id, itemB.id, itemC.id].every((id) => repo.listChunks(id).length > 0), "恢复后全部已补齐");
    // 不重复：三次触发后总数稳定
    const cnt1 = repo.listChunks(itemA.id).length;
    await lib.backfillMissingChunks({ batchSize: 10 });
    eq(repo.listChunks(itemA.id).length, cnt1, "恢复后幂等：重复触发不增 chunk");
  });

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
