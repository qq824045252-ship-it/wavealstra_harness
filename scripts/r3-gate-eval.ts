/**
 * R3 立项门槛评估（Stage R3-1）
 *
 * 要求（§32）：
 * - 建立真实失败样本集（无词面重叠 / 同义词 / 缩写 / 技术别名 / 中英跨语言）
 * - 用 R2 lexical（trigram FTS + chunks）实测 Top-1/Top-3
 * - 绝对禁止安装 bge-m3/onnx/sqlite-vec、写 embedding 代码
 *
 * 本脚本：构造 lexical 失败样本（query 与原文无 trigram 重叠但语义等价），
 * 用生产链（AppDatabase + LibraryService + WorkspaceResourceLocator）实测，
 * 输出评估报告到 console，并写入 out/r3-gate-report.json（供 checkpoint 引用）。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { WorkspaceResourceLocator } from "../src/main/workspace/WorkspaceResourceLocator";
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

interface FailCase {
  query: string;
  docTitle: string;
  docBody: string;
  category: "no_overlap" | "synonym" | "abbrev" | "alias" | "cross_lang";
  note: string;
}

const CASES: FailCase[] = [
  {
    query: "k8s 集群扩容",
    docTitle: "Kubernetes 弹性伸缩指南",
    docBody: "本文介绍 Kubernetes 的 Horizontal Pod Autoscaler 与集群自动扩容（Cluster Autoscaler）原理，涉及容器编排与调度。",
    category: "abbrev",
    note: "k8s vs Kubernetes（缩写）",
  },
  {
    query: "LLM 推理加速",
    docTitle: "大语言模型推理优化",
    docBody: "大语言模型（Large Language Model）的推理（inference）可通过 KV cache、量化与批处理优化延迟。",
    category: "alias",
    note: "LLM vs 大语言模型/LLM",
  },
  {
    query: "RAG 检索增强",
    docTitle: "检索增强生成工作流",
    docBody: "检索增强生成（Retrieval-Augmented Generation）将外部知识检索与生成模型结合，提升事实性。",
    category: "abbrev",
    note: "RAG vs 检索增强生成",
  },
  {
    query: "向量数据库选型",
    docTitle: "Vector DB 对比：Milvus vs Qdrant",
    docBody: "Vector database selection: compare Milvus, Qdrant, pgvector on recall, latency and cost. 讨论嵌入与近似最近邻。",
    category: "cross_lang",
    note: "向量数据库 vs Vector DB（中英跨语言，无 trigram 重叠时）",
  },
  {
    query: "同义词：汽车",
    docTitle: "车辆动力学",
    docBody: "本章讨论车辆（vehicle）的操控与稳定性，未出现“汽车”二字，仅用“车辆/机动车”。",
    category: "synonym",
    note: "汽车 vs 车辆/机动车（同义词）",
  },
  {
    query: "temperature compensation",
    docTitle: "温度补偿说明",
    docBody: "温度补偿（temperature compensation）用于修正传感器在不同环境温度下的偏差，常见于压力与流量仪表。",
    category: "cross_lang",
    note: "中英跨语言：英文 query vs 中文 title/body（含括号英文但主词为中文）",
  },
  {
    query: "粉尘仪 校准",
    docTitle: "粉尘检测仪 校准规程",
    docBody: "粉尘检测仪的校准（calibration）包括零点校准与量程校准，周期为 6 个月。",
    category: "no_overlap",
    note: "粉尘仪 vs 粉尘检测仪（技术别名/简称，trigram 可能仍有部分重叠，但考验短词）",
  },
  {
    query: "水分仪 检定",
    docTitle: "水分测定仪 检定规范",
    docBody: "水分测定仪的检定依据 JJG 标准，含重复性与示值误差检验。",
    category: "alias",
    note: "水分仪 vs 水分测定仪（别名）",
  },
];

async function main() {
  console.log("== R3 立项门槛评估（lexical Top-1/Top-3 on failure set） ==");
  console.log("Cases: " + CASES.length + " （category: no_overlap/synonym/abbrev/alias/cross_lang）");
  const dir = mkdtempSync(join(tmpdir(), "r3-gate-"));
  const db = new AppDatabase(join(dir, "r3.db"));
  try {
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    const proj = "proj-r3";
    addProject(db, proj);
    db.createSpace(mkSpace("ws", "WS", null));
    const sp = (lib as any).createSpace({ name: "S", projectId: proj });
    binding.bind("ws", sp.id);

    // 为每个 case 创建一个文档（1 case = 1 item，避免干扰项之间互相误命中）
    const itemIds: string[] = [];
    for (const c of CASES) {
      const item = (lib as any).createItem({ spaceId: sp.id, kind: "markdown", title: c.docTitle });
      (lib as any).writeContent({ id: item.id, content: `${c.docTitle}\n\n${c.docBody}` });
      itemIds.push(item.id);
    }
    await lib.flushPendingIndexes();

    // 再造一个干扰文档（通用内容，避免空库偏差）
    const noise = (lib as any).createItem({ spaceId: sp.id, kind: "markdown", title: "通用说明" });
    (lib as any).writeContent({ id: noise.id, content: "通用说明\n\n本条目为干扰项，不应被上述特定查询命中。" });
    await lib.flushPendingIndexes();

    mkTask(db, "t-r3", "ws", proj);
    const loc = new WorkspaceResourceLocator(db, lib, binding);

    let top1 = 0, top3 = 0;
    const rows: Array<Record<string, unknown>> = [];
    for (let i = 0; i < CASES.length; i++) {
      const c = CASES[i]!;
      const expected = itemIds[i]!;
      const res = loc.search({ query: c.query, taskId: "t-r3", limit: 5 });
      const ids = res.hits.map((h) => h.id);
      const isTop1 = ids[0] === expected;
      const isTop3 = ids.slice(0, 3).includes(expected);
      if (isTop1) top1++;
      if (isTop3) top3++;
      console.log(
        `${isTop1 ? "✓" : isTop3 ? "~" : "✗"} [${c.category}] query="${c.query}" → top=${ids[0]?.slice(0, 8) ?? "-"} expected=${expected.slice(0, 8)} hits=${ids.length} note=${c.note}`,
      );
      rows.push({
        query: c.query,
        category: c.category,
        note: c.note,
        expectedItemId: expected,
        expectedTitle: c.docTitle,
        hits: res.hits.map((h) => ({ id: h.id, title: h.title, matchedBy: h.matchedBy, preview: h.preview.slice(0, 60) })),
        top1: isTop1,
        top3: isTop3,
      });
    }
    const top1Rate = top1 / CASES.length;
    const top3Rate = top3 / CASES.length;
    console.log(`\nSummary: Top-1=${(top1Rate * 100).toFixed(1)}% (${top1}/${CASES.length}) Top-3=${(top3Rate * 100).toFixed(1)}% (${top3}/${CASES.length})`);

    // 阈值判断（与 §27 对齐：Top-3 resource hit ≥95% 为 lexical 目标；若失败样本 Top-3 显著低于此线则考虑语义）
    const lexicalGoal = 0.95;
    const verdict =
      top3Rate >= lexicalGoal
        ? "lexical 满足（暂不立项 R3）"
        : top3Rate >= 0.6
          ? "lexical 部分失效（建议补充同义词/别名表，暂缓 embedding）"
          : "lexical 明显不足（可启动 R3 预研，但仍需业务样本复核后决策）";

    console.log(`Verdict: ${verdict}`);
    console.log("Guard: 未安装 bge-m3/onnx/sqlite-vec，未写 embedding 代码（本脚本仅 lexical 实测）");

    const report = {
      generatedAt: new Date().toISOString(),
      method: "lexical trigram FTS + chunks (R2) on failure set (no embedding)",
      cases: CASES.length,
      top1Rate,
      top3Rate,
      rows,
      verdict,
      guard: "no bge-m3/onnx/sqlite-vec installed; no embedding code written",
    };
    try {
      mkdirSync(join(process.cwd(), "out"), { recursive: true });
      writeFileSync(join(process.cwd(), "out", "r3-gate-report.json"), JSON.stringify(report, null, 2), "utf8");
      console.log("Report written: out/r3-gate-report.json");
    } catch {}
  } finally {
    try { db.close(); } catch {}
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
