import type Database from "better-sqlite3";
import { resolve } from "node:path";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import { z } from "zod";
import type { WorkDeliverableDto, WorkDto } from "../../../shared/bot-work";

const observation = z.object({
  protocol: z.literal("watch-observation-v1"),
  status: z.enum(["observed", "unavailable"]),
  facts: z.array(z.object({ source: z.string().min(1), key: z.string().min(1), value: z.string() }).strict()).max(100),
  summary: z.string(),
}).strict();

export type WatchComparisonState = "no_baseline" | "unverified" | "unchanged" | "changed";
export interface WatchObservationPresentation {
  silent: boolean; summary: string; comparisonState: WatchComparisonState; baselineResultId?: string;
}

export const WATCH_COMPARISON_INSTRUCTIONS = `comparisonState 是宿主提供的比较状态，与是否通知或静默无关。no_baseline 表示没有本轮之前可用的同一观察历史：只报告本轮事实，可说明首次观察或暂无历史可比，禁止声称“无变化”“与上轮一致”或“有变化”。本轮结果、同轮成员结果、任务说明和长期记忆不是上一轮基线。unverified 表示有历史，但宿主尚未证实相同或不同；只有当前真实读取与所给历史记录中同一来源、同一属性的明确事实足以比较时，才可给出有依据的具体比较，否则说明无法可靠比较。unchanged / changed 才分别表示宿主已核对可比较的读取证据相同 / 不同。不要把缺失、失败、不完整的历史当成无变化，也不要照抄结果摘要中没有比较依据的变化判断。没有历史不是需要补查的缺项，不为构造过去的基线重新执行。`;

export const WATCH_OBSERVATION_INSTRUCTIONS = `本事项选择只在变化时通知。每次检查仍须执行真实只读工具，最终只返回一个 JSON 对象（不要另加说明）：
{"protocol":"watch-observation-v1","status":"observed","facts":[{"source":"实际来源的稳定路径或URL","key":"用户跟踪的属性，如file_content","value":"真实读取到的精确属性值"}],"summary":"变化时供用户阅读的简短报告"}。
facts 是稳定的业务事实，不是摘要措辞；不要包含检查时间、轮次、自己推算的哈希或会变化的汇报文案。文件内容使用精确原文。只有本次真实工具取得完整、可比较事实才使用 observed；来源读取失败、不完整、不能可靠比较则 status=unavailable，summary 说明缺口，不得用空值假装无变化。宿主负责建立基线、比较和静默，你不得自己发送通知。`;

export function parseWatchObservation(text: string) {
  try {
    const parsed = observation.safeParse(JSON.parse(text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/, "$1")));
    if (!parsed.success) return undefined;
    const value = parsed.data;
    const keys = value.facts.map(f => JSON.stringify([f.source, f.key]));
    if (value.status === "observed" && (!keys.length || new Set(keys).size !== keys.length)) return undefined;
    return value;
  } catch { return undefined; }
}

/** Compare stable source facts, never prose or a model's claimed changed flag.
 * The durable deliverables are the baseline, so restarting cannot reset it.
 * Unknown/malformed observations are visible, not silently treated as unchanged.
 */
export function watchObservationDelivery(work: WorkDto, result: WorkDeliverableDto, previous: WorkDeliverableDto[],
  evidence: (item: WorkDeliverableDto) => string | undefined = () => undefined): WatchObservationPresentation {
  // Repository order includes rowid as a deterministic tie-breaker. Never infer
  // chronological precedence from an arbitrary UUID when timestamps collide.
  const position = previous.findIndex(r => r.deliverableId === result.deliverableId);
  const predecessors = position >= 0 ? previous.slice(0, position) : previous.filter(r => r.createdAt < result.createdAt);
  const history = predecessors.filter(r => r.workId === result.workId && r.executionId !== result.executionId
    && r.intentRevision === result.intentRevision && r.inputSnapshotId === result.inputSnapshotId
    && r.ownerEpoch === result.ownerEpoch && r.producerBotId === result.producerBotId
    && !["superseded", "rejected"].includes(r.status));
  const comparisonState: WatchComparisonState = history.length ? "unverified" : "no_baseline";
  const changesOnly = work.mode === "watch" && work.watchRule?.notificationMode === "changes_only";
  const visible = (summary = result.summary): WatchObservationPresentation => ({ silent: false,
    summary: changesOnly ? summary : result.summary, comparisonState });
  if (work.mode !== "watch" || ["rejected", "superseded"].includes(result.status)
    || result.isSpeculation || result.hasWriteConflicts || result.uncoveredScope.length) return visible();
  const current = parseWatchObservation(result.summary);
  if (!current || current.status !== "observed") return visible(
    current?.summary || `本轮未取得可可靠比较的结构化观察，不能判断是否变化。\n${result.summary}`);
  const currentEvidence = evidence(result);
  if (!currentEvidence) return visible(`本轮缺少完整、可比对的来源读取回执，不能可靠判断无变化。\n${current.summary || result.summary}`);
  const prior = history.filter(r => !r.isSpeculation && !r.hasWriteConflicts && !r.uncoveredScope.length).reverse()
    .find(r => parseWatchObservation(r.summary)?.status === "observed");
  const previousEvidence = prior && evidence(prior);
  if (prior && !previousEvidence) return visible(`上轮来源回执不可用，无法可靠比较；本轮观察已保留。\n${current.summary || result.summary}`);
  return { silent: changesOnly && (prior ? previousEvidence === currentEvidence : !work.watchRule?.notifyInitial),
    comparisonState: prior ? previousEvidence === currentEvidence ? "unchanged" : "changed" : comparisonState,
    ...(prior ? { baselineResultId: prior.deliverableId } : {}),
    summary: changesOnly ? current.summary || `本轮跟踪来源内容：\n${current.facts.map(f => `${f.source} · ${f.key}：${f.value}`).join("\n")}` : result.summary };
}

/** Host-recorded successful tool output, never a model-provided digest or a
 * post-hoc filesystem reread. Missing/partial/pruned/unsupported sources cannot
 * establish an equality proof. Supports complete file/knowledge reads and single-URL raw/readable web tool content.
 */
export function watchReadEvidence(db: Database.Database, binding: WorkExecutionBindingDto | undefined,
  result: WorkDeliverableDto): string | undefined {
  if (!binding || binding.status !== "completed" || binding.bindingId !== result.executionId
    || binding.workId !== result.workId || binding.intentRevision !== result.intentRevision
    || binding.inputSnapshotId !== result.inputSnapshotId || binding.ownerEpoch !== result.ownerEpoch) return undefined;
  const current = parseWatchObservation(result.summary);
  if (current?.status !== "observed") return undefined;
  try {
    const rows = db.prepare(`SELECT payload_json FROM work_native_inbox WHERE binding_id=?
      ORDER BY received_at DESC,rowid DESC`).all(binding.bindingId) as Array<{payload_json: string}>;
    const payload = rows.map(row => JSON.parse(row.payload_json)).find(value => value.status === "completed"
      && typeof value.summary === "string" && value.summary.trim() === result.summary);
    if (!payload || !Array.isArray(payload.readEvidence)) return undefined;
    const items: Array<{target:string;kind:string;toolName:string;outputHash:string;partial:boolean;at:number}> = payload.readEvidence;
    const proofs = current.facts.map(fact => {
      // Native inbox preserves entry order. Select the LAST matching attempt
      // first, including failures/metadata/partial reads, then validate it.
      const matching = items.filter(item => item &&
        (item.kind === "file-content" && item.toolName === "read"
          && resolve(binding.workspaceBinding, item.target) === resolve(binding.workspaceBinding, fact.source)
          || ["project_knowledge_read", "fetch_content"].includes(item.toolName) && item.target === fact.source));
      const latest = matching.at(-1);
      const item = latest && !latest.partial && ["file-content", "knowledge-content", "web-content"].includes(latest.kind)
        && /^[a-f0-9]{64}$/.test(latest.outputHash) ? latest : undefined;
      return item ? { source: item.kind === "file-content" ? resolve(binding.workspaceBinding,item.target) : item.target,
        key: fact.key, outputHash: item.outputHash } : undefined;
    });
    if (proofs.some(item => !item)) return undefined;
    return JSON.stringify(proofs.sort((a,b) => JSON.stringify([a!.source,a!.key]).localeCompare(JSON.stringify([b!.source,b!.key]))));
  } catch { return undefined; }
}

/** Team owner evidence is the immutable per-round member read receipts, not the
 * owner's prose. All member results must be complete and agree on shared keys. */
export function watchTeamReadEvidence(db: Database.Database, repo: import("./WorkRepository").WorkRepository,
  binding: WorkExecutionBindingDto | undefined, result: WorkDeliverableDto): string | undefined {
  const direct = watchReadEvidence(db,binding,result);
  if (!binding || binding.status !== "completed") return direct;
  const observation = parseWatchObservation(result.summary);
  if (observation?.status !== "observed") return undefined;
  try {
    const assignment = JSON.parse(repo.executionInput(binding)).teamAssignment;
    if (assignment?.role !== "owner_summary" || !assignment.watchRound) return direct;
    if (!Array.isArray(assignment.previousResults) || !assignment.previousResults.length) return undefined;
    const proofs = new Map<string,{source:string;key:string;outputHash:string}>();
    for (const member of assignment.previousResults) {
      const source = repo.getBinding(member.bindingId);
      const value = repo.listDeliverables(binding.workId).find(r=>r.deliverableId===member.deliverableId && r.executionId===member.bindingId);
      if (!source || !value || source.inboxEventId !== binding.inboxEventId || source.workId !== binding.workId
        || value.isSpeculation || value.hasWriteConflicts || value.uncoveredScope.length) return undefined;
      const evidence = watchReadEvidence(db,source,value); if (!evidence) return undefined;
      for (const proof of JSON.parse(evidence) as Array<{source:string;key:string;outputHash:string}>) {
        const key=JSON.stringify([proof.source,proof.key]);
        if (proofs.has(key) && proofs.get(key)!.outputHash!==proof.outputHash) return undefined;
        proofs.set(key,proof);
      }
    }
    const selected = observation.facts.map(f=>proofs.get(JSON.stringify([resolve(binding.workspaceBinding,f.source),f.key]))
      ?? proofs.get(JSON.stringify([f.source,f.key])));
    const selectedKeys = new Set(selected.filter(Boolean).map(p=>JSON.stringify([p!.source,p!.key])));
    if (selected.some(p=>!p) || selectedKeys.size!==selected.length || selectedKeys.size!==proofs.size
      || [...proofs.keys()].some(key=>!selectedKeys.has(key))) return undefined;
    return JSON.stringify(selected.sort((a,b)=>JSON.stringify([a!.source,a!.key]).localeCompare(JSON.stringify([b!.source,b!.key]))));
  } catch { return undefined; }
}
