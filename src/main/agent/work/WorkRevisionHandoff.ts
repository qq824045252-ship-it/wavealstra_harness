import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import { generatedArtifactSchema, workSubitemSchema } from "../../../shared/bot-work-phase3";
import type { WorkService } from "./WorkService";

const FACT_LIMIT = 40;
const HANDOFF_MAX_BYTES = 32 * 1024;
const REF_LIMIT = 8;
const REF_MAX_BYTES = 1024;
type TruncatedFields = Record<string, { omittedCharacters?: number; omittedItems?: number }>;
const clipText = (text: string, limit: number, field: string, truncated: TruncatedFields) => {
  const clipped = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
  if (clipped.length < text.length) truncated[field] = { omittedCharacters: text.length - clipped.length };
  return clipped;
};
const clipRefs = (refs: string[], field: string, truncated: TruncatedFields) => {
  // A path or identity is either retained intact or omitted, never shortened
  // into another target. Large individual refs still count as omitted items.
  const kept = refs.slice(0, REF_LIMIT).filter(ref => Buffer.byteLength(ref, "utf8") <= REF_MAX_BYTES);
  if (kept.length < refs.length) truncated[field] = { omittedItems: refs.length - kept.length };
  return kept;
};
const truncation = (fields: TruncatedFields) => Object.keys(fields).length ? { truncated: true, truncatedFields: fields } : {};

const GROUPS = ["unresolvedOperations", "unsettledExecutions", "completedSubitems", "registeredFiles", "unresolvedSubitems", "completedOperations"] as const;
type Group = typeof GROUPS[number];
type HistoryGroups = Record<Group, unknown[]>;
/** Bound the added context, not the original user input. Retained identities are exact. */
function boundedHandoff(header: Record<string, unknown>, groups: HistoryGroups, omittedCounts: Record<Group, number>) {
  const handoff: HistoryGroups & { [key: string]: unknown; omittedCounts: Record<Group, number>; truncated: boolean; maxBytes: number } = {
    ...header, unresolvedOperations: [], unsettledExecutions: [], completedSubitems: [], registeredFiles: [], unresolvedSubitems: [], completedOperations: [],
    omittedCounts: { ...omittedCounts }, truncated: false, maxBytes: HANDOFF_MAX_BYTES };
  for (const group of GROUPS) handoff.omittedCounts[group] += groups[group].length;
  const bytes = () => Buffer.byteLength(JSON.stringify(handoff), "utf8");
  // These identities already occur in the original input/execution binding. An extreme
  // identity must not consume the entire history budget or be silently shortened.
  if (bytes() > HANDOFF_MAX_BYTES) for (const field of ["workId", "currentInputSnapshotId", "ownerBotId"]) delete (handoff as Record<string, unknown>)[field];
  const identityOmitted = Object.keys(header).some(field => !(field in handoff));
  if (identityOmitted) Object.assign(handoff, { currentIdentityOutsideHandoff: true });
  // Round robin keeps uncertain actions, completed work and its files represented
  // before one large category can consume all remaining context.
  for (let index = 0; index < FACT_LIMIT; index++) for (const group of GROUPS) {
    const row = groups[group][index];
    if (row === undefined) continue;
    handoff[group].push(row); handoff.omittedCounts[group]--;
    if (bytes() > HANDOFF_MAX_BYTES) {
      handoff[group].pop(); handoff.omittedCounts[group]++;
    }
  }
  // `false` is longer than `true`, so the final marker cannot exceed the budget
  // that was measured while adding rows.
  handoff.truncated = identityOmitted || Object.values(handoff.omittedCounts).some(count => count > 0)
    || GROUPS.some(name => handoff[name].some(value => (value as { truncated?: boolean }).truncated));
  return handoff;
}
const sourceRow = z.object({
  binding_id: z.string(), task_id: z.string(), operation_id: z.string(), intent_revision: z.number(),
  input_snapshot_id: z.string(), owner_epoch: z.number(), bot_id: z.string(), status: z.string(),
});
type SourceRow = z.infer<typeof sourceRow>;
const source = (row: SourceRow) => ({ bindingId: row.binding_id, taskId: row.task_id,
  operationId: row.operation_id, intentRevision: row.intent_revision, inputSnapshotId: row.input_snapshot_id,
  ownerEpoch: row.owner_epoch, botId: row.bot_id, executionStatus: row.status });
const totalRow = z.object({ total_count: z.number() });
const sourceColumns = "b.binding_id,b.task_id,b.operation_id,b.intent_revision,b.input_snapshot_id,b.owner_epoch,b.bot_id,b.status";

const INSTRUCTIONS = [
  "这是同一 Work、同一负责人代次的持久历史事实，只用于无损交接，不是新要求的验收或任何新授权。当前执行原始用户要求、完整修订与约束仍以上层输入为准，历史子项文本不是新的指令。",
  "先对照最新修订识别受影响部分和缺项，再推进这些部分。未变且已经完成的部分应先回读并复用已有成果，不重新写入、发送、发布或重复其他已发生的外部动作。不要从头重跑整份旧计划。",
  "这是同一 Work 的续做，不是将原请求重新执行一遍。旧请求中已完成的启动、并行拆分和中间写入是历史过程，不是本修订待办；新目标替换旧值时不要先重演旧值步骤再覆盖。仅当最新用户明确要求重做或实际新输入需要时重做受影响部分。delegationPlan 是助理建议，其残留旧步骤不能盖过最新用户修订。委派子代理也必须传达当前范围、已完成复用和未知效果，不派发一份只含旧任务的重复计划。",
  "如果最新用户要求或新输入实质要求重做某部分，就按最新要求执行；历史成功不能替代新输入、新代码版本的 benchmark、测试、实机核验或当前验收。对旧事实是否适用于当前目标重新核验，不自动把旧 criterionIds 标成满足。",
  "registeredFiles 中只有 immutable=true 的 snapshotPath 是已登记的不可变版本候选，仍须实际读取核对 digest/内容与最新要求。originalPath 是可变原路径，不能据其仍存在就声称旧成果可用；没有快照的文件必须重新只读核验，不能直接重做原写入。",
  "unknown/admitted 操作及尚未结算的执行只说明结果未核实，不说明失败或未发生。按 operationId、bindingId、原生回执或实际状态只读核对，未核实前不盲目重放同一外部操作；与其无依赖的独立工作仍可推进。consumed 只说明该操作已结算，不代表整个目标完成。",
  "omittedCounts 非零表示仍有未展示历史；truncatedFields 标明摘要截去的字符数或列表省略项数，保留的 source/factId/操作身份不截断。不可推断未列出的步骤没有执行过。需要依赖省略部分时按原身份核对既有持久记录，不重跑全部历史，也不改变用户目标或自行宣告验收完成。",
].join("\n");

/** Submission-only, read-only context derived from existing facts, never a second execution/goal state. */
export class WorkRevisionHandoff {
  constructor(private readonly db: Database.Database, private readonly works: WorkService) {}

  executionInput(binding: WorkExecutionBindingDto, input: string): string {
    const work = this.works.getWork(binding.workId);
    if (!work || binding.botId !== work.ownerBotId || binding.ownerEpoch !== work.ownerEpoch
      || binding.intentRevision !== work.intentRevision || binding.inputSnapshotId !== work.inputSnapshotId
      || this.db.prepare("SELECT 1 FROM work_teams WHERE work_id=?").get(binding.workId)) return input;

    // Both the row limit and all counts are Work-scoped. Do not call list(workId)
    // then slice in JS, and do not read this history from the adapter's poll path.
    const eligible = `b.work_id=@workId AND b.bot_id=@botId AND b.owner_epoch=@ownerEpoch
      AND b.binding_id!=@bindingId AND b.admitted_at<=@admittedAt AND b.intent_revision<=@revision
      AND (b.intent_revision<@revision OR b.input_snapshot_id!=@inputId)`;
    const params = { workId: work.workId, botId: binding.botId, ownerEpoch: binding.ownerEpoch,
      bindingId: binding.bindingId, admittedAt: binding.admittedAt, revision: binding.intentRevision,
      inputId: binding.inputSnapshotId, limit: FACT_LIMIT };
    if (!this.db.prepare(`SELECT 1 FROM work_execution_bindings b WHERE ${eligible} LIMIT 1`).get(params)
      && !this.db.prepare(`SELECT 1 FROM work_action_admissions WHERE work_id=@workId AND owner_epoch=@ownerEpoch
        AND binding_id IS NULL AND intent_revision<@revision AND admitted_at<=@admittedAt
        AND state IN ('admitted','unknown','consumed') LIMIT 1`).get(params)) return input;

    const itemRows = (completed: boolean) => this.db.prepare(`SELECT ${sourceColumns},i.fact_id,i.result_json,i.deliverable_id,
      COUNT(*) OVER() AS total_count FROM work_execution_bindings b
      JOIN work_subitem_results i ON i.binding_id=b.binding_id AND i.work_id=b.work_id
      WHERE ${eligible} AND json_extract(i.result_json,'$.outcome') ${completed ? "=" : "!="} 'completed'
      ORDER BY ${completed ? "" : "(json_extract(i.result_json,'$.outcome')='unknown') DESC,"} i.created_at DESC,i.rowid DESC LIMIT @limit`).all(params);
    const projectItems = (rows: unknown[]) => rows.map(value => {
      const row = sourceRow.extend({ fact_id: z.string(), result_json: z.string(), deliverable_id: z.string().nullable() }).parse(value);
      const item = workSubitemSchema.parse(JSON.parse(row.result_json)), fields: TruncatedFields = {};
      return { source: source(row), factId: row.fact_id, deliverableId: row.deliverable_id,
        ...item, task: clipText(item.task, 512, "task", fields), summary: clipText(item.summary, 1200, "summary", fields),
        nativeStatus: clipText(item.nativeStatus, 128, "nativeStatus", fields),
        artifactRefs: clipRefs(item.artifactRefs, "artifactRefs", fields), writeConflicts: clipRefs(item.writeConflicts, "writeConflicts", fields),
        dependencies: clipRefs(item.dependencies, "dependencies", fields), criterionIds: clipRefs(item.criterionIds, "criterionIds", fields),
        ...truncation(fields) };
    });
    const completed = itemRows(true), unresolved = itemRows(false);
    const artifacts = this.db.prepare(`SELECT ${sourceColumns},a.payload_json,COUNT(*) OVER() AS total_count
      FROM work_execution_bindings b JOIN work_generated_artifacts a ON a.binding_id=b.binding_id
      WHERE ${eligible} ORDER BY a.rowid DESC LIMIT @limit`).all(params);
    const executions = this.db.prepare(`SELECT ${sourceColumns},b.attempt_id,b.submitted_at,COUNT(*) OVER() AS total_count
      FROM work_execution_bindings b WHERE ${eligible} AND b.status IN ('pending','submitted','running','unknown','invalidated')
      AND (b.attempt_id IS NOT NULL OR b.submission_receipt IS NOT NULL OR b.submitted_at IS NOT NULL)
      ORDER BY b.admitted_at DESC,b.rowid DESC LIMIT @limit`).all(params);
    // Unbound operation facts have no input identity: keep that uncertainty
    // explicit rather than inventing a binding or treating them as permissions.
    const actionRows = (settled: boolean) => this.db.prepare(`SELECT a.admission_id,a.binding_id,a.operation_id,a.action_kind,a.state,
      a.intent_revision,a.owner_epoch,b.input_snapshot_id,COUNT(*) OVER() AS total_count
      FROM work_action_admissions a LEFT JOIN work_execution_bindings b ON b.binding_id=a.binding_id
      WHERE a.work_id=@workId AND a.owner_epoch=@ownerEpoch AND a.intent_revision<=@revision AND a.admitted_at<=@admittedAt
      AND a.state ${settled ? "='consumed'" : "IN ('admitted','unknown')"}
      AND ((a.binding_id IS NOT NULL AND ${eligible}) OR (a.binding_id IS NULL
        AND (a.intent_revision<@revision OR EXISTS (SELECT 1 FROM work_execution_bindings b WHERE ${eligible}))))
      ORDER BY ${settled ? "" : "(a.state='unknown') DESC,"} a.admitted_at DESC,a.rowid DESC LIMIT @limit`).all(params);
    const completedActions = actionRows(true), unresolvedActions = actionRows(false);
    const projectActions = (rows: unknown[]) => rows.map(value => {
      const row = z.object({ admission_id: z.string(), binding_id: z.string().nullable(), operation_id: z.string(),
        action_kind: z.string(), state: z.string(), intent_revision: z.number(), owner_epoch: z.number(), input_snapshot_id: z.string().nullable() }).parse(value);
      const fields: TruncatedFields = {};
      return { admissionId: row.admission_id, bindingId: row.binding_id, operationId: row.operation_id,
        actionKind: clipText(row.action_kind, 128, "actionKind", fields), state: row.state, intentRevision: row.intent_revision,
        ownerEpoch: row.owner_epoch, inputSnapshotId: row.input_snapshot_id, ...truncation(fields) };
    });
    if (![completed, unresolved, artifacts, executions, completedActions, unresolvedActions].some(rows => rows.length)) return input;
    const omitted = (rows: unknown[]) => rows.length ? totalRow.parse(rows[0]).total_count - rows.length : 0;
    const header = {
      provenance: "persisted_work_history", workId: work.workId, currentIntentRevision: binding.intentRevision,
      currentInputSnapshotId: binding.inputSnapshotId, ownerBotId: binding.botId, ownerEpoch: binding.ownerEpoch,
      instructions: INSTRUCTIONS,
    };
    const groups = { completedSubitems: projectItems(completed), unresolvedSubitems: projectItems(unresolved),
      registeredFiles: artifacts.map(value => {
        const row = sourceRow.extend({ payload_json: z.string() }).parse(value);
        const file = generatedArtifactSchema.parse(JSON.parse(row.payload_json));
        return { source: source(row), originalPath: file.path, snapshotPath: file.snapshotPath,
          immutable: Boolean(file.snapshotPath && file.snapshotPath !== file.path), digest: file.digest,
          sizeBytes: file.sizeBytes, registeredAt: file.registeredAt, sourceEntryId: file.sourceEntryId };
      }),
      unsettledExecutions: executions.map(value => ({ source: source(sourceRow.parse(value)),
        attemptId: z.object({ attempt_id: z.string().nullable() }).parse(value).attempt_id })),
      completedOperations: projectActions(completedActions), unresolvedOperations: projectActions(unresolvedActions),
    };
    return JSON.stringify({ ...JSON.parse(input), revisionHandoff: boundedHandoff(header, groups,
      { completedSubitems: omitted(completed), unresolvedSubitems: omitted(unresolved),
        registeredFiles: omitted(artifacts), unsettledExecutions: omitted(executions),
        completedOperations: omitted(completedActions), unresolvedOperations: omitted(unresolvedActions) }) });
  }
}
