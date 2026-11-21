import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { improvementAssetLabels, improvementOutcomeLabels, improvementPercent } from "../../../shared/improvement-report-format";
import type { ImprovementOutcome, ImprovementReport, ImprovementVersionEvidence } from "../../../shared/native-improvement";

const knownCases = new Set(["检查脚本", "原契约漏项", "变体漏项", "反馈具体缺项", "修复后独立读回",
  "完整交付放行", "无关请求不触发", "用户取消要求不触发", "原始保存版本与用户指出的缺项",
  "原始交付物指纹", "已撤回版本的失败输入"]);

function stableId(value: unknown): string | undefined {
  return typeof value === "string" && /^[\p{L}\p{N}_:.\-]{1,128}$/u.test(value) ? value : undefined;
}

function caseName(value: unknown, index: number): string {
  return typeof value === "string" && knownCases.has(value) ? value : `回放 ${index + 1}`;
}

function outcomeLine(o: ImprovementOutcome): string {
  const head = `- ${stableId(o.packageId) ?? "未知版本"} v${o.revision} · ${improvementOutcomeLabels[o.state]} · 适用 ${o.opportunities} · 验收 ${o.accepted} · 复发 ${o.corrections} · 异常 ${o.errors}`;
  const assets = o.assets?.map(a => `  - ${improvementAssetLabels[a.kind]} · ${improvementOutcomeLabels[a.state]} · 使用 ${a.used}/${a.opportunities} · 验收 ${a.accepted} · 复发 ${a.corrections} · 异常 ${a.errors}`) ?? [];
  return [head, ...assets].join("\n");
}

/** Immutable snapshots plus one atomic pointer keep each week's files coherent. */
export async function writeImprovementWeek(directory: string, report: ImprovementReport, week: string, replays: unknown[]): Promise<void> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(week) || Number.isNaN(Date.parse(`${week}T00:00:00Z`)) || new Date(`${week}T00:00:00Z`).toISOString().slice(0, 10) !== week) throw new Error("Invalid improvement week");
  const metrics = report.weeklyMetrics.filter(m => m.week === week);
  // Export only aggregate numeric values. Paths, prompts, model output and source excerpts stay local to the app.
  const metricKeys = ["opportunities", "accepted", "corrections", "unassisted", "recurrences", "exposed", "used", "errors", "falseTriggers", "durationMs", "modelRequests", "toolCalls", "userInputs"];
  const safeMetrics = metrics.map(m => Object.fromEntries([["week", week], ...metricKeys.flatMap(k => {
    const v = (m as unknown as Record<string, unknown>)[k]; return v === null || typeof v === "number" && Number.isFinite(v) ? [[k, v]] : [];
  })]));
  const cycle = report.runs.find(r => r.week === week);
  const versions: ImprovementVersionEvidence[] = report.versionEvidence ?? report.packages.map(p => ({
    packageId: p.id, revision: p.revision, active: p.enabled, retired: !p.enabled, week: p.week, previous: p.previous,
    source: p.source, cases: [], useCount: 0, uses: [],
  }));
  const changes = versions.filter(v => v.week === week).map(v => {
    const current = report.packages.find(p => p.id === v.packageId && p.revision === v.revision);
    const source = v.source ?? current?.source;
    const hash = v.hash ?? current?.hash;
    const kinds = v.assets ?? current?.assets;
    const replay = v.cases.length ? ` · 回放 ${v.cases.filter(c => c.passed).length}/${v.cases.length} 通过` : " · 回放证据缺失";
    const origin = source ? ` · 来源 ${stableId(source.taskId) ?? "未知任务"}/${stableId(source.conversationId) ?? "未知会话"} #${source.entry}` : "";
    const assets = kinds?.length ? ` · 资产 ${kinds.map(a => improvementAssetLabels[a.kind]).join("、")}` : "";
    const integrity = hash && /^[0-9a-f]{64}$/.test(hash) ? ` · 指纹 ${hash}` : "";
    const state = v.active ? "启用" : v.retired ? "已撤回" : current ? "已停用" : "历史版本";
    return `- ${stableId(v.packageId) ?? "未知版本"} · v${v.revision} · ${state} · 上一版本 ${v.previous ?? "无"}${replay} · 运行回执 ${v.useCount} 条${origin}${assets}${integrity}`;
  }).join("\n");
  const outcomes = report.outcomes.filter(o => o.week === week).map(outcomeLine).join("\n");
  const replaySummary = replays.map((r, index) => {
    const value = r && typeof r === "object" ? r as Record<string, unknown> : {};
    const cases = Array.isArray(value.cases) ? value.cases.map((c, caseIndex) => {
      const item = c && typeof c === "object" ? c as Record<string, unknown> : {};
      return { name: caseName(item.name, caseIndex), passed: item.passed === true, evidenceHash: createHash("sha256").update(JSON.stringify([item.expected, item.observed])).digest("hex") };
    }) : [];
    const source = value.source && typeof value.source === "object" ? value.source as Record<string, unknown> : {};
    return { index: index + 1, packageId: stableId(value.packageId), revision: Number.isSafeInteger(value.revision) ? value.revision : undefined,
      source: { taskId: stableId(source.taskId), conversationId: stableId(source.conversationId), entry: Number.isSafeInteger(source.entry) ? source.entry : undefined },
      hash: typeof value.hash === "string" && /^[0-9a-f]{64}$/.test(value.hash) ? value.hash : undefined, cases };
  });
  const weekMetrics = metrics[0];
  const statistics = weekMetrics
    ? `原生输入 ${weekMetrics.userInputs}，适用交付任务 ${weekMetrics.opportunities}，有版本运行证据 ${weekMetrics.exposed}。独立验收且无需纠正 ${weekMetrics.unassisted}/${weekMetrics.opportunities}（${improvementPercent(weekMetrics.unassisted, weekMetrics.opportunities)}）。实际使用 ${weekMetrics.used}/${weekMetrics.exposed}（${improvementPercent(weekMetrics.used, weekMetrics.exposed)}）。已关联复发 ${weekMetrics.recurrences}/${weekMetrics.exposed}（${improvementPercent(weekMetrics.recurrences, weekMetrics.exposed)}）。执行异常 ${weekMetrics.errors}，误触发 ${weekMetrics.falseTriggers ?? "未测量"}。`
    : "本周期尚无指标记录。";
  const backfill = outcomes || "本周期尚无已结算的回填。";
  const files: Record<string, string> = {
    "metrics.jsonl": safeMetrics.map(m => JSON.stringify(m)).join("\n") + (safeMetrics.length ? "\n" : ""),
    "ledger/changes.md": `# 改进变更\n\n周期：${week}\n\n${changes || "本周期没有可列出的变更。"}\n\n## 后续回填\n\n${backfill}\n`,
    "replays/summary.json": JSON.stringify(replaySummary, null, 2) + "\n",
    "retro.md": `# 每周复盘\n\n周期：${week}\n\n${cycle ? `扫描 ${cycle.scanned} 条，新增 ${cycle.added} 条，发布 ${cycle.published} 项，待处理问题 ${cycle.issues.length} 项。` : "本周期尚无完成记录。"}\n\n${statistics}\n\n## 后续回填\n\n${backfill}\n`,
  };
  const hash = createHash("sha256").update(JSON.stringify(files)).digest("hex");
  const root = join(directory, week), snapshots = join(root, "snapshots"), target = join(snapshots, hash);
  await mkdir(snapshots, { recursive: true });
  const temporary = join(snapshots, `.pending-${randomUUID()}`);
  try {
    await mkdir(temporary);
    for (const [name, content] of Object.entries(files)) {
      const path = join(temporary, name);
      await mkdir(join(path, ".."), { recursive: true });
      await writeFile(path, content, { encoding: "utf8", flag: "wx" });
    }
    try { await rename(temporary, target); }
    catch (e) {
      if (!["EEXIST", "ENOTEMPTY", "EPERM"].includes((e as NodeJS.ErrnoException).code ?? "")) throw e;
      for (const [name, content] of Object.entries(files)) if (await readFile(join(target, name), "utf8") !== content) throw new Error("Improvement snapshot integrity check failed");
    }
    const pointer = join(root, `.current-${randomUUID()}.tmp`);
    try { await writeFile(pointer, JSON.stringify({ week, snapshot: `snapshots/${hash}` }) + "\n", { flag: "wx" }); await rename(pointer, join(root, "current.json")); }
    finally { await rm(pointer, { force: true }); }
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
