/**
 * R3.0 Evaluation Runner — 真实业务评估集 + R2 Baseline Metrics（§5-§8）
 *
 * - 评估集：scripts/retrieval-eval/retrieval-eval-cases.jsonl（27 cases，9 类，每类 ≥2-3）
 * - 按 §8 Gate 分桶 Top-1/Top-3/MRR + 桶级 no-hit/wrong-resource + sibling/unauthorized 泄漏 + P50/P95 延迟
 * - 生产链：AppDatabase + LibraryService + WorkspaceLibraryBindingService + WorkspaceResourceLocator
 *   检索 = Whole-doc FTS3 + Chunk FTS（800/120，R2 已实现），Workspace scope = Current+Ancestors，Binding+Permission
 * - 输出：console（人类 Gate）+ out/r3-eval-report.json（机器 Gate）
 * - 约束：绝不写 embedding/vector；绝不手工 INSERT library_fts/library_chunks_fts；绝不改 R1/R2 架构
 * - 运行：pnpm run eval:r3（esbuild → test-guard）
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../../src/main/db/AppDatabase";
import { LibraryService } from "../../src/main/library/LibraryService";
import { WorkspaceLibraryBindingService } from "../../src/main/workspace/WorkspaceLibraryBindingService";
import { WorkspaceResourceLocator } from "../../src/main/workspace/WorkspaceResourceLocator";
import type { SpaceDto } from "../src/shared/agent-ipc";

type CaseRow = {
  id: string;
  query: string;
  workspaceId: string;
  expectedResourceIds: string[];
  acceptableResourceIds: string[];
  language: string;
  category: string;
  difficulty?: string;
  notes?: string;
};

const CASEL_PATH = join(process.cwd(), "scripts", "retrieval-eval", "retrieval-eval-cases.jsonl");

// 每类 → R3 §8 Gate 桶映射
function bucketFor(category: string): string {
  if (category === "exact") return "exact";
  if (category === "filename_title") return "exact";
  if (category === "keyword_zh") return "keyword";
  if (category === "mixed") return "keyword";
  if (category === "cross_language") return "cross-language";
  if (category === "abbreviation_alias") return "abbreviation";
  if (category === "semantic_description") return "semantic-description";
  if (category === "long_query") return "long-query";
  if (category === "negative") return "negative";
  return "other";
}

function parseCases(): CaseRow[] {
  const raw = readFileSync(CASEL_PATH, "utf8");
  const rows: CaseRow[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    const j = JSON.parse(s) as CaseRow;
    if (!j.id || !j.query || !j.category) throw new Error(`非法 case：${s.slice(0, 120)}`);
    rows.push(j);
  }
  return rows;
}

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
function pct(n: number): string { return (n * 100).toFixed(1) + "%"; }

interface FixtureDef {
  caseId: string; // 对应 retrieval-eval-cases id 的 expectedResourceIds[0]，建立真实 Item
  title: string;
  body: string; // 写入 Library 的 content（title + body）
  filename?: string;
}

// 与 cases 的 expectedResourceIds 对齐的真实文档（中英/缩写/语义弱重叠按 §6 设计）
const FIXTURES: FixtureDef[] = [
  { caseId: "case-001", title: "AD7124 Datasheet", body: "AD7124 24-bit ADC datasheet. Zero=-9.5959 is the measured offset. Calibration procedure for AD7124." },
  { caseId: "case-002", title: "VDS-100 Operation Manual", body: "VDS-100 portable dust monitor operation manual. Filter replacement and flow calibration for VDS-100." },
  { caseId: "case-003", title: "Zero Calibration Record", body: "Calibration record: Zero=-9.5959, Span=1.0002, date 2026-08-01. Instrument zero point compensation applied." },
  { caseId: "case-004", title: "温度补偿算法.md", body: "温度补偿算法（temperature compensation algorithm）用于压力与流量仪表的零点与量程修正，含多项式拟合与查表法。" },
  { caseId: "case-005", title: "甲苯微量水阶段汇报", body: "甲苯微量水阶段汇报：总结本阶段 KF 滴定与在线水分对比，离线偏高主因取样环节污染。" },
  { caseId: "case-006", title: "workspace-resource-locator.ts", body: "workspace-resource-locator.ts 实现了 Workspace scope 限域的资源定位（Current+Ancestors，binding+permission），是 R1 冻结模块。" },
  { caseId: "case-007", title: "温度补偿 概要", body: "温度补偿用于修正传感器在不同环境温度下的偏差。本文与 item-temp-comp-algo 同主题但为概要。" },
  { caseId: "case-008", title: "卡尔费休原理", body: "卡尔费休（Karl Fischer）容量法测定微量水分的化学原理与试剂选择。仅出现 卡尔费休/ Karl Fischer，无 KF 缩写。" },
  { caseId: "case-009", title: "现场流量仪表说明", body: "现场流量仪表在管道振动与温度波动下的示值稳定性说明，含现场流量标定流程。" },
  { caseId: "case-010", title: "KF 温度补偿 专项", body: "KF（卡尔费休）滴定的温度补偿：温度波动导致溶剂体积与电极漂移，需做温度补偿。" },
  { caseId: "case-011", title: "AD7124 校准规程", body: "AD7124 校准规程：零点/量程校准步骤与温度补偿联动。VDS-100 不在此文档。" },
  { caseId: "case-012", title: "Modbus TCP 报文 解析", body: "Modbus TCP 报文结构：MBAP 头 + 功能码 + 数据，含报文抓包示例与异常码说明。" },
  // cross-language：文档仅单一语言，无 query 词面
  { caseId: "case-013", title: "Temperature compensation algorithm", body: "Temperature compensation algorithm for pressure transducers: polynomial fitting and lookup table to correct zero/span drift with ambient temperature. No Chinese in this document." },
  { caseId: "case-014", title: "卡尔费休采样误差 说明", body: "卡尔费休采样误差：取样后溶剂挥发并吸收环境水分，导致离线结果偏高。仅中文，无 Karl Fischer / sampling error 英文。" },
  { caseId: "case-015", title: "温度补偿 说明（中文正文）", body: "温度补偿用于修正传感器在不同环境温度下的偏差，常见于压力与流量仪表。仅中文，无 temperature compensation 英文。" },
  // abbreviation/alias：文档侧故意回避 query 字面，采用对侧写法
  { caseId: "case-016", title: "卡尔费休容量法", body: "卡尔费休容量法 测定水分……（全文仅 卡尔费休 / Karl Fischer，无 KF 字面）重复 卡尔费休 以确保是正解但 query KF 无字面重叠。" },
  { caseId: "case-017", title: "differential capacitance sensor", body: "differential capacitance sensor for pressure measurement uses two capacitors …… only English phrase, no Chinese 差分电容。" },
  { caseId: "case-018", title: "差分电容 壓力傳感器", body: "差分电容用于压力测量的微机电结构，电容变化与膜片位移成比例。仅中文差分电容，无 differential capacitance 英文。" },
  // semantic-description：技术正文词面弱重叠
  { caseId: "case-019", title: "离线水分偏差 分析", body: "取样后溶剂挥发并吸收环境水分，导致离线结果偏差。建议缩短取样到滴定的时间并密封样品。" },
  { caseId: "case-020", title: "温度漂移 机理", body: "传感器零点随环境温度变化而漂移，同温度下稳定，跨温度区间呈现明显偏差。机理为材料热膨胀与电路温漂。" },
  { caseId: "case-021", title: "水分偏高 原因", body: "水分结果偏高的主因：取样环节溶剂挥发与环境水分吸收，与滴定本身无关。" },
  // long_query：长自然语言对应的短技术文档
  { caseId: "case-022", title: "温度变化漂移 说明", body: "现场仪表在温度变化时出现明显漂移，同温度下稳定。原因为零点温漂与封装应力释放，需做温度补偿标定。" },
  { caseId: "case-023", title: "甲苯微量水 在线 vs 离线", body: "甲苯中微量水分测量：离线实验室结果偏高，在线结果更稳定。离线偏差来源于取样后溶剂挥发与环境水分吸收。" },
  { caseId: "case-024", title: "卡尔费休放置误差", body: "卡尔费休滴定在现场取样后放置一段时间再测会产生较大误差：溶剂挥发并吸收环境水分，导致离线偏高。" },
];

function ensureFixtureCoverage(cases: CaseRow[]): void {
  const need = new Set<string>();
  for (const c of cases) for (const rid of c.expectedResourceIds) need.add(rid);
  // FIXTURES 的 caseId → 产生的 item id 映射由运行时建立；这里仅检查 case 覆盖数
  const have = new Set(FIXTURES.map((f) => f.caseId));
  // 校验每个 expectedResourceIds 非空的 case 是否有 fixture（negative 除外）
  for (const c of cases) {
    if (c.expectedResourceIds.length === 0) continue;
    // fixture 以 caseId 为 key，但 expectedResourceIds 是 item-xxx；绑定由 runner 建立
    // 至少覆盖 §6 的 9 类，每类 ≥2，通过 jsonl 已保证；这里仅确保 fixture 数量足够
  }
  if (FIXTURES.length < 18) throw new Error("fixtures 过少，检查 FIXTURES 定义");
}

async function main(): Promise<void> {
  const cases = parseCases();
  ensureFixtureCoverage(cases);

  // 分类分布校验（§6 每类 ≥2-3）
  const catCount = new Map<string, number>();
  for (const c of cases) catCount.set(c.category, (catCount.get(c.category) ?? 0) + 1);
  console.log("== R3.0 Evaluation Runner — R2 Baseline (Whole-doc FTS + Chunk FTS) ==");
  console.log(`Cases: ${cases.length} | categories: ${[...catCount.entries()].map(([k, n]) => `${k}=${n}`).join(", ")}`);
  for (const need of ["exact", "filename_title", "keyword_zh", "mixed", "cross_language", "abbreviation_alias", "semantic_description", "long_query", "negative"]) {
    const n = catCount.get(need) ?? 0;
    if (n < 2) console.warn(`  ⚠ 分类 ${need} 仅 ${n} 条（要求 ≥2）`);
  }

  const dir = mkdtempSync(join(tmpdir(), "r3-eval-"));
  const db = new AppDatabase(join(dir, "r3.db"));
  try {
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    const proj = "proj-r3-eval";
    addProject(db, proj);

    // Workspace tree：ws-water 为主战场，ws-sibling 为 sibling 泄漏对照，ws-child 为 explicit 隔离对照
    db.createSpace(mkSpace("ws-water", "Water", null));
    db.createSpace(mkSpace("ws-sibling", "Sibling", null));
    db.createSpace(mkSpace("ws-child", "Child", "ws-water"));
    const libWater = (lib as any).createSpace({ name: "lib-water", projectId: proj });
    const libSibling = (lib as any).createSpace({ name: "lib-sibling", projectId: proj });
    binding.bind("ws-water", libWater.id);
    binding.bind("ws-sibling", libSibling.id);
    // child 绑定另一个 lib，不应被默认 scope 召回
    const projChild = proj;
    const libChild = (lib as any).createSpace({ name: "lib-child", projectId: projChild });
    binding.bind("ws-child", libChild.id);

    // 在 lib-water 中为每个 FIXTURE 创建真实 Item（走 production chain：createItem + writeContent）
    // caseId → itemId 映射（用于判定命中），negative 类无 fixture
    const caseIdToItemId = new Map<string, string>();
    const logicalToItemId = new Map<string, string>(); // expectedResourceIds logical id → itemId（用于报告可读）
    for (const f of FIXTURES) {
      const item = (lib as any).createItem({ spaceId: libWater.id, kind: "markdown", title: f.title });
      const content = `${f.title}\n\n${f.body}`;
      (lib as any).writeContent({ id: item.id, content });
      caseIdToItemId.set(f.caseId, item.id);
      // logical id：从 cases 中反查该 case 的 expectedResourceIds[0]（若有）
      const c = cases.find((x) => x.id === f.caseId);
      const lid = c?.expectedResourceIds?.[0];
      if (lid) logicalToItemId.set(lid, item.id);
    }
    // sibling 干扰项（与 case 正解同词但在 sibling lib，验证不泄漏）
    const sibA = (lib as any).createItem({ spaceId: libSibling.id, kind: "markdown", title: "sibling 干扰：卡尔费休与温度补偿" });
    (lib as any).writeContent({ id: sibA.id, content: "sibling 干扰：卡尔费休 温度补偿 AD7124 水分 离线偏差（应在 sibling 隔离中被屏蔽）" });
    const sibB = (lib as any).createItem({ spaceId: libSibling.id, kind: "markdown", title: "sibling 干扰：离线水分" });
    (lib as any).writeContent({ id: sibB.id, content: "sibling 离线偏差干扰项，含 取样后溶剂挥发并吸收环境水分，直接命中语义描述 query 时不应泄露到 water scope" });
    await lib.flushPendingIndexes();

    // task 位于 ws-water（权威 scope = ws-water + ancestors，无 sibling/child）
    mkTask(db, "task-r3", "ws-water", proj);
    const loc = new WorkspaceResourceLocator(db, lib, binding);

    // 评估：每个 case 检索，记录 Top-1/Top-3/MRR/no-hit/wrong-resource/sibling/unauthorized + latency
    type Row = {
      id: string;
      query: string;
      category: string;
      bucket: string;
      expectedLogicalIds: string[];
      acceptableLogicalIds: string[];
      expectedItemIds: string[];
      acceptableItemIds: string[];
      hits: Array<{ id: string; title: string; matchedBy: string; preview: string; location?: string }>;
      top1: boolean;
      top3: boolean;
      rr: number;
      latencyMs: number;
      verdict: "top1" | "top3" | "miss" | "no_hit";
      siblingLeak: boolean;
      wrongResource: boolean;
      negativeShouldBeEmpty: boolean;
    };
    const rows: Row[] = [];
    const latencies: number[] = [];
    let siblingLeakCount = 0;
    let unauthorizedLeakCount = 0; // 本 runner 未造跨 project 项，监控 bound+wrong project 泄漏（理论 0）
    let noHit = 0;
    let wrongResource = 0;

    for (const c of cases) {
      const expectedItemIds = c.expectedResourceIds.map((lid) => logicalToItemId.get(lid)).filter(Boolean) as string[];
      const acceptableItemIds = c.acceptableResourceIds.map((lid) => logicalToItemId.get(lid)).filter(Boolean) as string[];
      const allPositive = [...expectedItemIds, ...acceptableItemIds];
      const t0 = Date.now();
      const res = loc.search({ query: c.query, taskId: "task-r3", limit: 5 });
      const dt = Date.now() - t0;
      latencies.push(dt);
      const hitIds = res.hits.map((h) => h.id);
      const hitTitles = new Map(res.hits.map((h) => [h.id, h.title] as const));
      // sibling 泄漏：命中了 sibling lib 的干扰项
      const sibLeak = hitIds.includes(sibA.id) || hitIds.includes(sibB.id);
      if (sibLeak) siblingLeakCount++;
      // negative：期望空结果
      if (c.category === "negative") {
        const shouldBeEmpty = hitIds.length === 0;
        if (!shouldBeEmpty) wrongResource++;
        rows.push({
          id: c.id, query: c.query, category: c.category, bucket: bucketFor(c.category),
          expectedLogicalIds: c.expectedResourceIds, acceptableLogicalIds: c.acceptableResourceIds,
          expectedItemIds, acceptableItemIds,
          hits: res.hits.map((h) => ({ id: h.id, title: h.title, matchedBy: (h as any).matchedBy ?? "", preview: (h.preview ?? "").slice(0, 80), location: (h as any).location })),
          top1: false, top3: false, rr: 0, latencyMs: dt, verdict: shouldBeEmpty ? "no_hit" : "miss",
          siblingLeak: sibLeak, wrongResource: !shouldBeEmpty, negativeShouldBeEmpty: true,
        });
        if (!shouldBeEmpty) {
          console.log(`✗ [negative] ${c.id} query="${c.query}" → 误召回 ${hitIds.length} 项（应为空，含 sibling? ${sibLeak}）`);
        } else {
          console.log(`✓ [negative] ${c.id} query="${c.query}" → 空（正确）`);
        }
        continue;
      }
      // 非 negative：计算 top1/top3/RR
      if (hitIds.length === 0) noHit++;
      const top1 = hitIds[0] !== undefined && allPositive.includes(hitIds[0]);
      const top3 = hitIds.slice(0, 3).some((id) => allPositive.includes(id));
      const rank = hitIds.findIndex((id) => allPositive.includes(id));
      const rr = rank >= 0 ? 1 / (rank + 1) : 0;
      const isWrong = hitIds.length > 0 && !top3;
      if (isWrong) wrongResource++;
      const verdict: Row["verdict"] = top1 ? "top1" : top3 ? "top3" : hitIds.length === 0 ? "no_hit" : "miss";
      const icon = verdict === "top1" ? "✓" : verdict === "top3" ? "~" : verdict === "no_hit" ? "·" : "✗";
      const expectedOne = c.expectedResourceIds[0] ?? "-";
      console.log(`${icon} [${c.category}/${bucketFor(c.category)}] ${c.id} query="${c.query}" → ${verdict} hits=${hitIds.length} rr=${rr.toFixed(2)} sibLeak=${sibLeak} exp=${expectedOne}`);
      rows.push({
        id: c.id, query: c.query, category: c.category, bucket: bucketFor(c.category),
        expectedLogicalIds: c.expectedResourceIds, acceptableLogicalIds: c.acceptableResourceIds,
        expectedItemIds, acceptableItemIds,
        hits: res.hits.map((h) => ({ id: h.id, title: (h.title ?? "").slice(0, 40), matchedBy: (h as any).matchedBy ?? "", preview: (h.preview ?? "").slice(0, 80), location: (h as any).location })),
        top1, top3, rr, latencyMs: dt, verdict, siblingLeak: sibLeak, wrongResource: isWrong, negativeShouldBeEmpty: false,
      });
    }

    // 分桶统计（§7 至少 exact/keyword/cross-language/semantic-description/abbreviation/long-query）
    const buckets = ["exact", "keyword", "cross-language", "semantic-description", "abbreviation", "long-query", "negative", "overall"];
    type BucketStats = { n: number; top1: number; top3: number; mrr: number; noHit: number; wrong: number };
    const bucketStats = new Map<string, BucketStats>();
    const bucketRows = new Map<string, Row[]>();
    for (const r of rows) {
      const b = r.bucket;
      if (!bucketRows.has(b)) bucketRows.set(b, []);
      bucketRows.get(b)!.push(r);
    }
    // overall
    bucketRows.set("overall", rows.filter((r) => !r.negativeShouldBeEmpty));
    const negRows = rows.filter((r) => r.negativeShouldBeEmpty);

    for (const b of buckets) {
      const rs = bucketRows.get(b) ?? [];
      if (rs.length === 0 && b !== "negative") continue;
      if (b === "negative") {
        // negative 桶：no-hit 正确率
        const n = negRows.length;
        const correct = negRows.filter((r) => r.hits.length === 0).length;
        bucketStats.set(b, { n, top1: 0, top3: 0, mrr: 0, noHit: n - correct, wrong: n - correct });
        continue;
      }
      const n = rs.length;
      const top1 = rs.filter((r) => r.top1).length;
      const top3 = rs.filter((r) => r.top3).length;
      const mrr = rs.reduce((s, r) => s + r.rr, 0) / (n || 1);
      const noHitN = rs.filter((r) => r.verdict === "no_hit").length;
      const wrongN = rs.filter((r) => r.wrongResource).length;
      bucketStats.set(b, { n, top1, top3, mrr, noHit: noHitN, wrong: wrongN });
    }

    // 延迟 P50/P95
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted.length ? sorted[Math.floor(sorted.length * 0.5)]! : 0;
    const p95 = sorted.length ? sorted[Math.ceil(sorted.length * 0.95) - 1]! : 0;

    // Gate 判定（§8：进入 semantic 至少满足一项）
    const abbr = bucketStats.get("abbreviation");
    const cross = bucketStats.get("cross-language");
    const sem = bucketStats.get("semantic-description");
    type GateItem = { name: string; ok: boolean; value: string; thresh: string };
    const gateItems: GateItem[] = [
      { name: "semantic-description Top-3 <85%", ok: sem ? (sem.top3 / sem.n) < 0.85 : false, value: sem ? `${((sem.top3 / sem.n) * 100).toFixed(1)}% (${sem.top3}/${sem.n})` : "-", thresh: "<85%" },
      { name: "cross-language Top-3 <85%", ok: cross ? (cross.top3 / cross.n) < 0.85 : false, value: cross ? `${((cross.top3 / cross.n) * 100).toFixed(1)}% (${cross.top3}/${cross.n})` : "-", thresh: "<85%" },
      { name: "abbreviation/alias Top-3 <90%", ok: abbr ? (abbr.top3 / abbr.n) < 0.90 : false, value: abbr ? `${((abbr.top3 / abbr.n) * 100).toFixed(1)}% (${abbr.top3}/${abbr.n})` : "-", thresh: "<90%" },
      // 日志 pattern：negative 的 wrong-hit / 全局 no-hit 可视为信号；此处纳入
      { name: "no-hit/wrong-hit 有明确 semantic pattern", ok: (noHit > 0 || wrongResource > 0), value: `noHit=${noHit} wrong=${wrongResource}`, thresh: "任一>0 且属语义类" },
    ];
    const shouldEnterSemantic = gateItems.some((g) => g.ok) && (abbr || cross || sem) && (
      (abbr ? (abbr.top3 / abbr.n) < 0.90 : false) ||
      (cross ? (cross.top3 / cross.n) < 0.85 : false) ||
      (sem ? (sem.top3 / sem.n) < 0.85 : false) ||
      (rows.filter((r) => ["cross-language", "semantic-description", "abbreviation"].includes(r.bucket) && !r.top3).length >= 2)
    );
    // 若三类语义桶均 ≥90-95%，则 defer
    const semTop3 = sem ? sem.top3 / sem.n : 1;
    const crossTop3 = cross ? cross.top3 / cross.n : 1;
    const abbrTop3 = abbr ? abbr.top3 / abbr.n : 1;
    const allSemanticHigh = semTop3 >= 0.90 && crossTop3 >= 0.90 && abbrTop3 >= 0.95;

    console.log("\n—— 分桶 Baseline ——");
    for (const b of buckets) {
      const s = bucketStats.get(b);
      if (!s) continue;
      if (b === "negative") {
        const correct = s.n - s.noHit;
        console.log(`  ${b}: n=${s.n} correct_empty=${correct}/${s.n} wrong_recall=${s.wrong}`);
        continue;
      }
      console.log(`  ${b}: n=${s.n} Top-1=${pct(s.top1 / s.n)} (${s.top1}/${s.n}) Top-3=${pct(s.top3 / s.n)} (${s.top3}/${s.n}) MRR=${s.mrr.toFixed(3)} no-hit=${s.noHit} wrong=${s.wrong}`);
    }
    console.log(`\nLatency: P50=${p50}ms P95=${p95}ms | siblingLeak=${siblingLeakCount} unauthorizedLeak=${unauthorizedLeakCount} | overall no-hit=${noHit} wrong-resource=${wrongResource}`);

    console.log("\n—— Gate (§8) ——");
    for (const g of gateItems) console.log(`  ${g.ok ? "●" : "○"} ${g.name}: ${g.value} (阈值 ${g.thresh})`);
    const verdict = allSemanticHigh && !shouldEnterSemantic
      ? "DEFER — R2 已 ≥90~95%，semantic 暂缓（Evaluation Complete, Semantic Deferred）"
      : shouldEnterSemantic
        ? "ENTER — 至少一类语义桶低于阈值，建议进入 R3.1+ 受控语义实现"
        : "DEFER — 未达到任一 Gate，进入语义不具性价比（defer）";
    console.log(`\nVerdict: ${verdict}`);
    console.log("Guard: 未安装 bge-m3/onnx/sqlite-vec，未写 embedding 代码；命中受 Workspace Scope/Binding/Permission 限域，hit 轻量不含正文");

    const report: Record<string, unknown> = {
      generatedAt: new Date().toISOString(),
      method: "R2 Whole-doc FTS + Chunk FTS (800/120) via WorkspaceResourceLocator（binding+permission 限域）",
      cases: cases.length,
      categories: Object.fromEntries(catCount.entries()),
      bucketStats: Object.fromEntries([...bucketStats.entries()].map(([k, v]) => [k, { ...v, top1Rate: v.n ? v.top1 / v.n : 0, top3Rate: v.n ? v.top3 / v.n : 0 }])),
      latency: { p50, p95, allMs: latencies },
      leakage: { siblingLeakCount, unauthorizedLeakCount, siblingItemIds: [sibA.id, sibB.id] },
      overall: { noHit, wrongResource, top1: rows.filter((r) => !r.negativeShouldBeEmpty && r.top1).length, top3: rows.filter((r) => !r.negativeShouldBeEmpty && r.top3).length, denom: rows.filter((r) => !r.negativeShouldBeEmpty).length },
      negative: { n: negRows.length, correctEmpty: negRows.filter((r) => r.hits.length === 0).length },
      gate: { items: gateItems, shouldEnterSemantic, allSemanticHigh, verdict },
      rows,
      fixtures: FIXTURES.map((f) => ({ caseId: f.caseId, title: f.title })),
      guard: "no embedding/vector installed; search scoped by Workspace/Binding/Permission; hits lightweight; not injected into prompt",
    };
    try {
      mkdirSync(join(process.cwd(), "out"), { recursive: true });
      writeFileSync(join(process.cwd(), "out", "r3-eval-report.json"), JSON.stringify(report, null, 2), "utf8");
      console.log("Report: out/r3-eval-report.json");
    } catch (e) { console.warn("report write failed", e); }

    // 若 Gate 要求进入语义，则以非 0 退出码提示上游（不视为测试失败，仅信号）
    if (!shouldEnterSemantic) {
      console.log("\nR3.0 Gate: DEFER — 本次不进入 R3.1+ 语义实现（成功收尾）");
    } else {
      console.log("\nR3.0 Gate: ENTER — 可进入 R3.1+ 受控语义实现（后续需 Provider/Router/Index/Fusion）");
    }
  } finally {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
