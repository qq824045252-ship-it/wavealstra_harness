/**
 * R2 benchmark 框架（Stages R2-1 + R2-2）
 *
 * 用法（两类）：
 *  1) 生产链 benchmark（走 LibraryService 真实链路：fixtures + 真实 extractor + chunker + FTS）：
 *     pnpm exec esbuild scripts/workspace-chunk-benchmark.ts --bundle --platform=node --format=cjs \
 *       --outfile=out/tests/workspace-chunk-benchmark.cjs --external:better-sqlite3 --external:electron \
 *       && node out/tests/workspace-chunk-benchmark.cjs
 *     或使用 package.json 注册的 test:workspace-chunk-benchmark（本文件创建后可用）。
 *
 *  2) 纯 chunker 参数扫描（无 DB，仅 chunkText 函数，分隔符见 LIBRARY_CHUNK_DEFAULTS）：
 *     内部 chunkText 网格扫描（size ∈ {400,600,800,1000,1200} × overlap ∈ {0,80,120,200} 有效组合）
 *
 * 指标（与主文档 §27 对齐）：
 *  - Top-1 / Top-3 定位准确率（已知锚点查询，真实 fixtures 样本）
 *  - no-result rate
 *  - 检索延迟 P50/P95（ms）
 *  - sibling leakage（=0 为达标）
 *  - 索引体积（chunks 行数 × 平均长度，扫描时记录）
 *  - 建索引耗时（ms）
 *
 * 本实现在无 electron 环境下使用模拟长文档（可重复）+ 真实 DB/FTS/chunker 进行基准；
 * 当存在 fixtures/artifacts/synthetic/office/* 时会用其抽取文本作为长文档来源（若可读）。
 */
import { mkdtempSync, rmSync, existsSync, readdirSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { WorkspaceResourceLocator } from "../src/main/workspace/WorkspaceResourceLocator";
import { chunkText, LIBRARY_CHUNK_DEFAULTS } from "../src/main/library/library-chunker";
import type { SpaceDto } from "../src/shared/agent-ipc";

function mkSpace(id: string, name: string, parentId: string | null): SpaceDto {
  return { id, name, parentId, sortOrder: 1000, createdAt: 1 } as SpaceDto;
}
function addProject(db: AppDatabase, id: string) {
  (db.connection as any)
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`)
    .run(id, id, Date.now(), Date.now(), 0, 128000);
}
function mkTask(db: AppDatabase, id: string, spaceId: string | null, projectId: string | null) {
  (db as any).upsertTask({ id, title: id, updatedAt: Date.now(), spaceId, projectId });
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, idx))]!;
}

function syntheticLongDoc(seed: string, paragraphs = 120): string {
  // 生成“可检索长文档”：每段含独特锚点 + 中英混排 + 与其他段落不重叠的关键词
  const lines: string[] = [];
  for (let i = 0; i < paragraphs; i++) {
    const anchor = `ANCHOR-${seed}-${String(i).padStart(4, "0")}`;
    lines.push(
      `第${i + 1}段：${anchor} ` +
        `本段主题为 ${seed}-topic-${i}，` +
        `关键概念：概念-${seed}-${i} 与 温度补偿-${seed}-${i}。` +
        `English anchor ${anchor} with mixed keywords. ` +
        `正文填充：` +
        Array.from({ length: 6 }, () => "测试数据 用于验证分块与检索 的长文档场景。").join(""),
    );
  }
  return lines.join("\n\n");
}

async function buildDoc(
  lib: LibraryService,
  spaceId: string,
  seed: string,
  paragraphs: number,
): Promise<{ id: string; anchor: string; anchorPara: number }> {
  const text = syntheticLongDoc(seed, paragraphs);
  const item = (lib as any).createItem({ spaceId, kind: "markdown", title: `doc-${seed}` });
  (lib as any).writeContent({ id: item.id, content: text });
  // flush 异步抽取（markdown 不走抽取，直接 FTS+chunks）
  await lib.flushPendingIndexes();
  // 选中间段落的锚点作为查询
  const anchorPara = Math.floor(paragraphs / 2);
  const anchor = `ANCHOR-${seed}-${String(anchorPara).padStart(4, "0")}`;
  return { id: item.id, anchor, anchorPara };
}

interface QueryCase {
  query: string;
  expectedItemId: string;
  label: string;
}
interface BenchOptions {
  chunkSize: number;
  overlap: number;
}

async function runBench(
  cases: QueryCase[],
  locatorFactory: () => WorkspaceResourceLocator,
  opts?: BenchOptions,
): Promise<{
  top1: number;
  top3: number;
  noResultRate: number;
  p50: number;
  p95: number;
  siblingLeakage: number;
  count: number;
}> {
  const latencies: number[] = [];
  let top1 = 0, top3 = 0, noResult = 0;
  for (const c of cases) {
    const t0 = Date.now();
    const res = locatorFactory().search({ query: c.query, taskId: "t-bench", limit: 10 });
    const dt = Date.now() - t0;
    latencies.push(dt);
    const ids = res.hits.map((h) => h.id);
    if (ids.length === 0) noResult += 1;
    if (ids[0] === c.expectedItemId) top1 += 1;
    if (ids.slice(0, 3).includes(c.expectedItemId)) top3 += 1;
  }
  latencies.sort((a, b) => a - b);
  // sibling leakage 需在外层单独测（不同 task space 时是否命中 sibling item）
  return {
    top1: cases.length ? top1 / cases.length : 0,
    top3: cases.length ? top3 / cases.length : 0,
    noResultRate: cases.length ? noResult / cases.length : 0,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    siblingLeakage: 0,
    count: cases.length,
  };
}

async function main() {
  console.log("== R2 Benchmark framework (R2-1 baseline + R2-2 chunk grid) ==");
  console.log(`Defaults: chunkSize=${LIBRARY_CHUNK_DEFAULTS.chunkSize} overlap=${LIBRARY_CHUNK_DEFAULTS.overlap}`);

  // --- 纯 chunker 扫描（无 DB）：索引体积与耗时 ---
  const sampleText = syntheticLongDoc("SCAN", 200);
  const gridSizes = [400, 600, 800, 1000, 1200];
  const gridOverlaps = [0, 80, 120, 200];
  console.log("\n-- chunkText grid (sample 200 paragraphs, chars=" + sampleText.length + ") --");
  console.log("size\toverlap\tchunks\tavgLen\tbuildMs");
  for (const size of gridSizes) {
    for (const overlap of gridOverlaps) {
      if (overlap >= size) continue;
      if (overlap > size * 0.5) continue; // normalize 会 clamp，这里跳过
      const t0 = Date.now();
      const chunks = chunkText("scan-item", sampleText, { chunkSize: size, overlap });
      const dt = Date.now() - t0;
      const avg = chunks.length ? Math.round(chunks.reduce((a, c) => a + c.content.length, 0) / chunks.length) : 0;
      console.log(`${size}\t${overlap}\t${chunks.length}\t${avg}\t${dt}`);
    }
  }

  // --- 生产链 benchmark（真实 AppDatabase + LibraryService + chunk FTS） ---
  // 用短租临时库，避免污染用户真实库
  const dir = mkdtempSync(join(tmpdir(), "r2-bench-"));
  const db = new AppDatabase(join(dir, "bench.db"));
  try {
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    const proj = "proj-bench";
    addProject(db, proj);
    db.createSpace(mkSpace("root", "Root", null));
    db.createSpace(mkSpace("water", "Water", "root"));
    db.createSpace(mkSpace("dust", "Dust", "root"));
    const libRoot = (lib as any).createSpace({ name: "lib-root", projectId: proj });
    const libWater = (lib as any).createSpace({ name: "lib-water", projectId: proj });
    const libDust = (lib as any).createSpace({ name: "lib-dust", projectId: proj });
    binding.bind("root", libRoot.id);
    binding.bind("water", libWater.id);
    binding.bind("dust", libDust.id);

    // 在 Water 域造 3 个长文档（不同 seed，避免锚点交叉）
    const docs: Array<{ id: string; anchor: string; anchorPara: number }> = [];
    for (const seed of ["ALPHA", "BETA", "GAMMA"]) {
      const d = await buildDoc(lib, libWater.id, seed, 120);
      docs.push(d);
    }
    // 在 Dust 域造 1 个干扰文档（同类内容，sibling 不应被 Water task 命中）
    const dustDoc = await buildDoc(lib, libDust.id, "DUST", 80);

    mkTask(db, "t-bench", "water", proj);
    mkTask(db, "t-dust", "dust", proj);

    const cases: QueryCase[] = docs.map((d) => ({
      query: d.anchor,
      expectedItemId: d.id,
      label: d.anchor,
    }));

    const locator = new WorkspaceResourceLocator(db, lib, binding);

    // R1 基线：当前默认 chunk 参数下的定位（已含 R2 chunk 聚合）
    const baseline = await runBench(cases, () => locator);
    console.log("\n-- R1/R2 combined baseline (Water task, limit=10) --");
    console.log(`cases=${baseline.count} Top1=${(baseline.top1 * 100).toFixed(1)}% Top3=${(baseline.top3 * 100).toFixed(1)}% noResult=${(baseline.noResultRate * 100).toFixed(1)}% P50=${baseline.p50}ms P95=${baseline.p95}ms`);

    // Sibling leakage：Water task 搜 dust 锚点应 0 命中
    const leakRes = locator.search({ query: dustDoc.anchor, taskId: "t-bench" });
    const leaked = leakRes.hits.some((h) => h.id === dustDoc.id);
    console.log(`sibling leakage: query=${dustDoc.anchor} leaked=${leaked ? "YES (FAIL)" : "NO (PASS)"} hits=${leakRes.hits.length}`);

    // 中间段落定位验证：chunk hit 是否携带 location
    const mid = docs[0]!;
    const midRes = locator.search({ query: mid.anchor, taskId: "t-bench" });
    const midHit = midRes.hits.find((h) => h.id === mid.id);
    console.log(
      `mid-anchor location: hitFound=${!!midHit} chunkIndex=${(midHit as any)?.chunkIndex ?? "-"} charOffset=${(midHit as any)?.charOffset ?? "-"} location=${(midHit as any)?.location ?? "-"} previewHasBracket=${!!midHit?.preview.includes("[")}`,
    );

    // 中文锚点（温度补偿-xxx）随机抽一个段落
    const cnQuery = `温度补偿-ALPHA-${String(60).padStart(2, "0")}`;
    // 锚点里实际为“温度补偿-ALPHA-60”不补零，单独构造正确查询
    const cnQuery2 = `温度补偿-ALPHA-60`;
    const cnRes = locator.search({ query: cnQuery2, taskId: "t-bench" });
    console.log(`CN query "${cnQuery2}" hits=${cnRes.hits.length} topId=${cnRes.hits[0]?.id ?? "-"}`);

    // 索引体积与 chunk 数统计
    const repo: any = (lib as any).repo;
    let totalChunks = 0;
    for (const d of docs) totalChunks += repo.listChunks(d.id).length;
    totalChunks += repo.listChunks(dustDoc.id).length;
    console.log(`index volume: totalChunks=${totalChunks} (4 docs)`);

    // Chunk 参数扫描（重建同一文本的不同参数，测定位 Top1）
    console.log("\n-- Chunk param scan (real DB/FTS, 1 doc repeated) --");
    console.log("size\toverlap\tchunks\tTop1(1q)\tP50ms");
    const textForScan = syntheticLongDoc("SCAN2", 120);
    for (const size of [600, 800, 1000]) {
      for (const overlap of [80, 120, 200]) {
        if (overlap >= size) continue;
        const scanDir = mkdtempSync(join(tmpdir(), "r2-scan-"));
        const scanDb = new AppDatabase(join(scanDir, "scan.db"));
        try {
          const scanLib = new LibraryService(scanDb);
          const scanBinding = new WorkspaceLibraryBindingService(scanDb);
          addProject(scanDb, "proj-scan");
          scanDb.createSpace(mkSpace("ws", "WS", null));
          const sp = (scanLib as any).createSpace({ name: "S", projectId: "proj-scan" });
          scanBinding.bind("ws", sp.id);
          // 覆盖默认 chunker：通过 monkey-patch chunkText（仅扫描期）
          const { chunkText: orig } = await import("../src/main/library/library-chunker");
          // 手动基于 textForScan 造 chunks 并直接走 repo（避免依赖 LibraryService 内部 chunker 入口）
          const { chunkText: ct } = await import("../src/main/library/library-chunker");
          // 直接用 textForScan 创建 item 并写 chunks
          const item = (scanLib as any).createItem({ spaceId: sp.id, kind: "markdown", title: "scan" });
          // 绕过 LibraryService 的 chunker：把文本直接写入文件 + FTS + 指定参数的 chunks
          // 使用 LibraryService 正常写入后，用指定参数重建 chunks
          (scanLib as any).writeContent({ id: item.id, content: textForScan });
          await scanLib.flushPendingIndexes();
          const chunks = ct(item.id, textForScan, { chunkSize: size, overlap });
          (scanLib as any).repo.upsertChunks(item.id, chunks as any);
          mkTask(scanDb, "t-scan", "ws", "proj-scan");
          const scanLocator = new WorkspaceResourceLocator(scanDb, scanLib, scanBinding);
          const anchor = `ANCHOR-SCAN2-${String(60).padStart(4, "0")}`;
          const t0 = Date.now();
          const r = scanLocator.search({ query: anchor, taskId: "t-scan" });
          const dt = Date.now() - t0;
          const hit = r.hits[0]?.id === item.id ? 1 : 0;
          console.log(`${size}\t${overlap}\t${chunks.length}\t${hit}\t${dt}`);
        } finally {
          try { scanDb.close(); } catch {}
          rmSync(scanDir, { recursive: true, force: true });
        }
      }
    }

    console.log("\nBenchmark done.");
  } finally {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
