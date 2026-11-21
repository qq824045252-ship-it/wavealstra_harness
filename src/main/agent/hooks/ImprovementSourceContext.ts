import type Database from "better-sqlite3";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { GenerationTask, type EntryId, type Storage, type TaskId } from "@earendil-works/pi-durable";
import type { ObservationSource } from "../../../shared/native-improvement";
import { openDurablePassiveStorage } from "../durable/DurableStorage";
import { readGoalNativeEvidence } from "../durable/DurableGoalNativeEvidence";

type Row = Record<string, unknown>;
const object = (v: unknown): Row => v && typeof v === "object" && !Array.isArray(v) ? v as Row : {};
const json = (v: unknown): Row => { try { return object(JSON.parse(String(v))); } catch { return {}; } };
const table = (db: Database.Database, name: string) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));

/** Resolve only an explicitly referenced native entry, never a later task or timestamp match. */
export async function sourceGeneration(storage: Pick<Storage, "entry" | "task" | "submission">, source: ObservationSource): Promise<number | undefined> {
  let entryId = source.trigger;
  if (source.childReceipt) {
    const submission = await storage.submission(source.entry as never, ctx);
    if (!submission || String(submission.conversationId) !== source.conversationId || submission.type !== "input" || submission.status !== "done") return;
    entryId = submission.answer;
  }
  const entry = (await storage.entry(entryId as EntryId, ctx))?.entry;
  if (!entry || String(entry.conversationId) !== source.conversationId || entry.byTaskId === undefined) return;
  let taskId: TaskId | undefined = entry.byTaskId;
  const seen = new Set<number>();
  while (taskId !== undefined && !seen.has(taskId)) {
    seen.add(taskId);
    const task = await storage.task(taskId, ctx);
    if (!task || String(task.conversationId) !== source.conversationId) return;
    if (task.kind === GenerationTask.definition.name) return task.id;
    taskId = task.owner;
  }
}

export function sourceDiagnostics(db: Database.Database, source: ObservationSource, generation: number) {
  const selectDiagnostics = (name: "task_request_diagnostics" | "task_tool_diagnostics") => {
    if (!table(db, name)) return null;
    return (db.prepare(`SELECT record_json FROM ${name} WHERE task_id=? AND json_extract(record_json,'$.conversationId')=?
      AND json_extract(record_json,'$.generationTaskId')=? AND json_extract(record_json,'$.sourceKind')=?
      AND (json_extract(record_json,'$.executionScope')=? OR json_extract(record_json,'$.executionScope') IS NULL)
      ORDER BY started_at LIMIT 64`).all(source.taskId,source.conversationId,generation,source.actor,source.taskId) as {record_json:string}[]).map(row => {
        const r = json(row.record_json);
        const keys = name === "task_request_diagnostics" ? ["id","executionId","provider","model","status","outcome","startedAt","finishedAt","usage","error"]
          : ["id","executionId","toolTaskId","name","callId","status","startedAt","finishedAt","isError","error"];
        return Object.fromEntries(keys.filter(k => r[k] !== undefined).map(k => [k,r[k]]));
      });
  };
  const requests = selectDiagnostics("task_request_diagnostics");
  const tools = selectDiagnostics("task_tool_diagnostics");
  const executionIds = [...new Set([...(requests ?? []), ...(tools ?? [])].flatMap(r => typeof r.executionId === "string" && r.executionId ? [r.executionId] : []))];
  const interactions = table(db, "conversation_interactions") && executionIds.length ? executionIds.flatMap(id => db.prepare(`SELECT id,execution_id,kind,status,created_at,resolved_at FROM conversation_interactions WHERE task_id=? AND execution_id=? ORDER BY created_at LIMIT 100`).all(source.taskId,id)) : null;
  return { requests, tools, interactions };
}

/** Read-only context joined on task, native conversation and exact originating generation. */
export async function improvementSourceContext(db: Database.Database, directory: string, source: ObservationSource,
  hooks?: Pick<import("./NativeHookStore").NativeHookStore, "generationReceipts">): Promise<Row> {
  const storage = await openDurablePassiveStorage(directory, ctx);
  if (!storage) return { identity: { task: source.taskId, conversation: source.conversationId }, availability: "原生会话不可用" };
  try {
    const generation = await sourceGeneration(storage, source);
    const identity = { task: source.taskId, conversation: source.conversationId, actor: source.actor, generation: generation ?? null };
    const sourceInput = (await storage.entry(source.input as EntryId, ctx))?.entry;
    const data = String(sourceInput?.conversationId) === source.conversationId ? object(sourceInput?.data) : {};
    const audit = object(object(data.mybuddyInput).audit);
    const recommendation = object(audit.recommendation);
    const skillContext = Object.keys(audit).length ? {
      assistantMessageId: audit.assistantMessageId ?? null,
      available: Array.isArray(audit.skills) ? audit.skills : null,
      decisions: Array.isArray(recommendation.capabilities) ? recommendation.capabilities.filter(v => object(v).kind === "skill") : null,
    } : null;
    if (generation === undefined) return { identity, skillContext, availability: "来源未能可靠关联原生 generation；请求、等待和交付证据未知" };
    const { requests, tools, interactions } = sourceDiagnostics(db, source, generation);
    const nativeTasks = [generation, ...(tools ?? []).flatMap(r => {
      const match = typeof r.id === "string" ? /:(\d+)$/.exec(r.id) : null;
      const id = match ? Number(match[1]) : NaN;
      return Number.isSafeInteger(id) ? [id] : [];
    })];
    const rules = hooks?.generationReceipts(source.taskId,source.conversationId,nativeTasks) ?? null;
    let loadout: unknown = null;
    if (table(db,"agent_loadout_observations") && typeof audit.assistantMessageId === "string") {
      const row = db.prepare("SELECT actual_json,blocked_json,used_skill_ids_json,outcome FROM agent_loadout_observations WHERE task_id=? AND assistant_message_id=?").get(source.taskId,audit.assistantMessageId) as Row | undefined;
      if (row) loadout = { actual: JSON.parse(String(row.actual_json)), blocked: JSON.parse(String(row.blocked_json)), used: JSON.parse(String(row.used_skill_ids_json)), outcome: row.outcome };
    }
    let goal: unknown = null, goalEvidence: unknown = null, learnedSkills: unknown = null;
    if (table(db,"conversation_goal_generations")) {
      goal = db.prepare("SELECT work_id,metadata,outcome FROM conversation_goal_generations WHERE task_id=? AND conversation_id=? AND generation_id=?")
        .get(source.taskId,source.conversationId,generation) ?? null;
      if (goal) {
        goalEvidence = await readGoalNativeEvidence(directory,[{conversationId:source.conversationId,generationTaskId:generation}]);
        if (table(db,"conversation_goal_learned_skills")) learnedSkills = db.prepare("SELECT evidence_json FROM conversation_goal_learned_skills WHERE task_id=? AND conversation_id=? AND generation_id=?")
          .all(source.taskId,source.conversationId,generation);
      }
    }
    return { identity, skillContext, loadout, requests, tools, interactions, rules, goal, goalEvidence, learnedSkills,
      limitations: "空记录不证明未发生；仅包含可由原生身份直接关联的事实。Work 和 Pstack 未关联到此 generation 时为未知。" };
  } finally { await storage.close(ctx); }
}
