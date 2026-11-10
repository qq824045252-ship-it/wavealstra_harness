import { z } from "zod";
import type Database from "better-sqlite3";
import type { WorkDeliverableDto, WorkExecutionBindingDto, WorkProjectionDto } from "../../../shared/bot-work";
import type { WorkFeedbackDto } from "../../../shared/bot-conversation";

type Report = NonNullable<WorkFeedbackDto["report"]>;
const text = z.string().min(1).max(8000);
const ref = z.string().min(1).max(500);
const draftSchema = z.object({
  format: z.literal("bot-team-report-v1"),
  requestMessageId: ref,
  conclusions: z.array(z.object({ text, evidenceRefs: z.array(ref).min(1).max(32) }).strict()).min(1).max(32),
  observations: z.array(text).max(32),
}).strict();
const contextSchema = z.object({
  userRequest: z.object({ messages: z.array(z.object({ messageId: ref, role: z.literal("user"), text: z.string() })) }),
  teamAssignment: z.object({ role: z.literal("owner_summary"), previousResults: z.array(z.object({
    botId: ref, displayName: text, responsibility: text, executionStatus: text,
    bindingId: ref.optional(), deliverableId: ref.optional(), failureReason: z.string().optional(), summary: z.string().optional(),
  })) }),
});

/** Frozen immediately before native submission, not reconstructed from a later
 * recovery's mutable task input. Optional storage never becomes an execution gate. */
export function captureTeamReportContext(db: Database.Database, binding: WorkExecutionBindingDto, input: string): void {
  try {
    const parsed = contextSchema.safeParse(JSON.parse(input));
    if (!parsed.success) return;
    db.exec(`CREATE TABLE IF NOT EXISTS work_report_contexts (
      binding_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, task_id TEXT NOT NULL,
      intent_revision INTEGER NOT NULL, owner_epoch INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL, context_json TEXT NOT NULL)`);
    db.prepare("INSERT OR IGNORE INTO work_report_contexts (binding_id,work_id,task_id,intent_revision,owner_epoch,input_snapshot_id,context_json) VALUES (?,?,?,?,?,?,?)").run(binding.bindingId, binding.workId, binding.taskId,
      binding.intentRevision, binding.ownerEpoch, binding.inputSnapshotId, JSON.stringify(parsed.data));
  } catch { /* The unchanged native input still executes; reporting falls back. */ }
}
export function capturedTeamReportContext(db: Database.Database, binding: WorkExecutionBindingDto): unknown {
  try {
    const row = db.prepare(`SELECT context_json FROM work_report_contexts WHERE binding_id=? AND work_id=? AND task_id=?
      AND intent_revision=? AND owner_epoch=? AND input_snapshot_id=?`).get(binding.bindingId, binding.workId, binding.taskId,
      binding.intentRevision, binding.ownerEpoch, binding.inputSnapshotId) as { context_json: string } | undefined;
    return row ? JSON.parse(row.context_json) : undefined;
  } catch { return undefined; }
}

/** Optional presentation only. A bad model format/reference never blocks a result,
 * starts another model turn, alters a Work, or implies semantic verification. */
export function projectTeamReport(summary: string, input: unknown): Pick<Report, "teamFacts" | "structured"> {
  const parsed = contextSchema.safeParse(input);
  if (!parsed.success) return {};
  const { userRequest, teamAssignment } = parsed.data;
  const identities = new Map<string, string>();
  for (const item of teamAssignment.previousResults) for (const id of [item.botId, item.bindingId, item.deliverableId]) {
    if (id) identities.set(id, item.displayName);
  }
  const ids = [...identities.keys()].sort((a, b) => b.length - a.length).map(id => id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const readableFailure = (reason: string | undefined): string | undefined => {
    if (!reason || !ids.length) return reason;
    // One pass, exact token boundaries: never replace a larger unknown identity
    // or recursively rewrite a member's human name. Raw diagnostics stay intact.
    return reason.replace(new RegExp(`(^|[^A-Za-z0-9:_-])(${ids.join("|")})(?=$|[^A-Za-z0-9:_-])`, "g"),
      (_match, before: string, id: string) => before + identities.get(id)!);
  };
  const teamFacts: NonNullable<Report["teamFacts"]> = teamAssignment.previousResults.map(item => ({
    displayName: item.displayName, responsibility: item.responsibility, executionStatus: item.executionStatus,
    failureReason: item.failureReason ?? (item.executionStatus === "not_started" ? item.summary : undefined),
    failureSummary: readableFailure(item.failureReason ?? (item.executionStatus === "not_started" ? item.summary : undefined)), sourceRefs: [item.botId, item.bindingId, item.deliverableId].filter((value): value is string => Boolean(value)),
  }));
  const result: Pick<Report, "teamFacts" | "structured"> = { teamFacts };
  const body = summary.trim();
  const fenced = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(body);
  let json: unknown;
  try { json = JSON.parse(fenced ? fenced[1] : body); } catch { return result; }
  const draft = draftSchema.safeParse(json);
  if (!draft.success) return result;
  const requests = new Map(userRequest.messages.map(item => [item.messageId, item.text]));
  const sources = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const item of teamAssignment.previousResults) {
    for (const source of [item.botId, item.bindingId, item.deliverableId]) if (source) {
      const label = `${item.displayName} · ${item.responsibility}`;
      if (sources.has(source) && sources.get(source) !== label) ambiguous.add(source);
      sources.set(source, label);
    }
  }
  // Models sometimes copy a field label together with its value. Accept only
  // an exact, correctly typed alias from this immutable evidence envelope.
  // Never guess an identifier, strip arbitrary prefixes, or cross task scopes.
  const aliases = new Map<string, string>();
  for (const item of teamAssignment.previousResults) {
    for (const key of ["botId", "bindingId", "deliverableId"] as const) {
      const value = item[key];
      if (value) aliases.set(`${key}:${value}`, value);
    }
  }
  const canonical = (source: string): string | undefined => {
    if (sources.has(source)) return ambiguous.has(source) ? undefined : source;
    const value = aliases.get(source);
    return value && !ambiguous.has(value) ? value : undefined;
  };
  // Existence is provenance, NOT proof that a sentence follows from its source.
  if (!requests.has(draft.data.requestMessageId) || draft.data.conclusions.some(item => item.evidenceRefs.some(source => !canonical(source)))) return result;
  result.structured = { version: 1, conclusions: draft.data.conclusions.map(item => ({
    text: item.text, requestMessageId: draft.data.requestMessageId, requestText: requests.get(draft.data.requestMessageId)!,
    sources: item.evidenceRefs.map(source => ({ ref: canonical(source)!, label: sources.get(canonical(source)!)! })),
  })), observations: draft.data.observations };
  return result;
}

export const TEAM_REPORT_FORMAT = `最终报告优先使用以下可选 JSON 格式（可包在 json 代码块中），不另写其他段落：
{"format":"bot-team-report-v1","requestMessageId":"userRequest.messages 中本次用户请求的真实 messageId","conclusions":[{"text":"针对本次用户请求的结论和必要证据","evidenceRefs":["teamAssignment.previousResults 中真实的 deliverableId、bindingId 或 botId"]}],"observations":["仅供补充、不影响用户目标的额外观察"]}
conclusions 只写本次请求相关结果与真实缺口；额外检查、建议和局限放 observations，没有则空数组。不要为了填字段新增业务动作。身份、分工、原生失败由宿主展示，不必重编。真实标识仅填写引用字段，不在面向用户的 text 中重复。引用直接复制字段值，不加 botId:、bindingId:、deliverableId: 等字段名前缀。引用只能使用当前输入中提供的真实标识；它们只证明来源存在，不保证结论正确，不能以引用代替核对。不要添加未有可靠依据的统计或精确比较。没有这些请求/来源标识时直接用普通文字交付，不等待、不要求用户补格式、不重跑任务。`;

/** Detail projections use the same immutable evidence as conversation reports. */
export function projectDeliverableReport(result: WorkDeliverableDto, bindings: WorkExecutionBindingDto[],
  context: (binding: WorkExecutionBindingDto) => unknown): WorkProjectionDto["deliverables"][number] {
  const binding = bindings.find(item => item.bindingId === result.executionId && item.botId === result.producerBotId
    && item.workId === result.workId && item.intentRevision === result.intentRevision
    && item.inputSnapshotId === result.inputSnapshotId && item.ownerEpoch === result.ownerEpoch);
  if (!binding) return result;
  try { return { ...result, presentation: projectTeamReport(result.summary, context(binding)) }; }
  catch { return result; } // Presentation never prevents loading the underlying result.
}
