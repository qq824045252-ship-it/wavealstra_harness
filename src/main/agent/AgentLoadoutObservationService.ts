import { createHash, randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import { normalizeWelcomeMode } from "../../shared/mode-profile";
import type {
  AgentLoadoutCapabilityKind,
  AgentLoadoutObservationContextDto,
  AgentLoadoutObservationDto,
  AgentLoadoutObservationOutcome,
  AgentLoadoutRecommendationDto,
} from "../../shared/agent-loadout";

export const AGENT_LOADOUT_MAX_RECORDS_PER_TASK = 200;
export const AGENT_LOADOUT_MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;

interface LoadoutObservationRow {
  id: string;
  task_id: string;
  user_message_id: string;
  assistant_message_id: string;
  query_hash: string;
  context_json: string;
  recommended_json: string;
  actual_json: string;
  matched_actual_json: string;
  not_selected_json: string;
  blocked_json: string;
  used_skill_ids_json: string;
  outcome: AgentLoadoutObservationOutcome;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function parseContext(value: string): AgentLoadoutObservationContextDto {
  try {
    const parsed = JSON.parse(value) as Partial<AgentLoadoutObservationContextDto> | null;
    if (!parsed || typeof parsed !== "object") throw new Error("invalid context");
    return {
      mode: normalizeWelcomeMode(parsed.mode) ?? "coding",
      projectId: typeof parsed.projectId === "string" && parsed.projectId ? parsed.projectId : undefined,
      workspaceId: typeof parsed.workspaceId === "string" && parsed.workspaceId ? parsed.workspaceId : undefined,
      tagId: typeof parsed.tagId === "string" && parsed.tagId ? parsed.tagId : undefined,
      memoryIds: Array.isArray(parsed.memoryIds) ? parsed.memoryIds.filter((id): id is string => typeof id === "string") : [],
      scenarioIds: Array.isArray(parsed.scenarioIds) ? parsed.scenarioIds.filter((id): id is string => typeof id === "string") : [],
      profileIds: Array.isArray(parsed.profileIds) ? parsed.profileIds.filter((id): id is string => typeof id === "string") : [],
    };
  } catch {
    return { mode: "coding", memoryIds: [], scenarioIds: [], profileIds: [] };
  }
}

function mapRow(row: LoadoutObservationRow): AgentLoadoutObservationDto {
  return {
    id: row.id,
    taskId: row.task_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    queryHash: row.query_hash,
    context: parseContext(row.context_json),
    recommended: parseArray(row.recommended_json),
    actual: parseArray(row.actual_json),
    matchedActual: parseArray(row.matched_actual_json),
    notSelected: parseArray(row.not_selected_json),
    blocked: parseArray(row.blocked_json),
    usedSkillIds: parseArray<string>(row.used_skill_ids_json),
    outcome: row.outcome,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at ?? undefined,
  };
}

function key(kind: AgentLoadoutCapabilityKind, id: string): string {
  return `${kind}:${id.toLowerCase()}`;
}

/** Observational only. Never changes Expert/Skill/Connector/MCP configuration. */
export class AgentLoadoutObservationService {
  constructor(private readonly db: AppDatabase) {}

  private get conn() { return this.db.connection; }

  recordAcceptedTurn(input: {
    taskId: string;
    userMessageId: string;
    assistantMessageId: string;
    recommendation: Pick<AgentLoadoutRecommendationDto, "query" | "mode" | "projectId" | "workspaceId" | "tagId" | "context" | "capabilities">;
    at?: number;
  }): AgentLoadoutObservationDto {
    const at = input.at ?? Date.now();
    const actual = input.recommendation.capabilities
      .filter((item) => item.actual)
      .map((item) => ({ kind: item.kind, id: item.id }));
    const actualKeys = new Set(actual.map((item) => key(item.kind, item.id)));
    const recommended = input.recommendation.capabilities
      .filter((item) => item.recommended)
      .map((item) => ({ kind: item.kind, id: item.id, score: item.score, evidence: item.evidence }));
    const blocked = input.recommendation.capabilities
      .filter((item) => item.recommended && item.blocked)
      .map((item) => ({ kind: item.kind, id: item.id, reason: item.blockReason ?? "policy_denied" }));
    const blockedKeys = new Set(blocked.map((item) => key(item.kind, item.id)));
    const matchedActual = recommended
      .filter((item) => actualKeys.has(key(item.kind, item.id)) && !blockedKeys.has(key(item.kind, item.id)))
      .map(({ kind, id }) => ({ kind, id }));
    const notSelected = recommended
      .filter((item) => !actualKeys.has(key(item.kind, item.id)) && !blockedKeys.has(key(item.kind, item.id)))
      .map(({ kind, id }) => ({ kind, id, reason: "not_selected" }));
    const queryHash = createHash("sha256").update(input.recommendation.query).digest("hex");
    const context: AgentLoadoutObservationContextDto = {
      mode: input.recommendation.mode,
      projectId: input.recommendation.projectId,
      workspaceId: input.recommendation.workspaceId,
      tagId: input.recommendation.tagId,
      memoryIds: input.recommendation.context.memoryIds,
      scenarioIds: input.recommendation.context.scenarioIds,
      profileIds: input.recommendation.context.profileIds,
    };
    const id = `aload_${randomUUID()}`;
    this.conn.prepare(
      `INSERT INTO agent_loadout_observations (
        id,task_id,user_message_id,assistant_message_id,query_hash,context_json,
        recommended_json,actual_json,matched_actual_json,not_selected_json,blocked_json,used_skill_ids_json,
        outcome,created_at,updated_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'pending',?,?)
      ON CONFLICT(task_id,assistant_message_id) DO UPDATE SET
        user_message_id=excluded.user_message_id,
        query_hash=excluded.query_hash,
        context_json=excluded.context_json,
        recommended_json=excluded.recommended_json,
        actual_json=excluded.actual_json,
        matched_actual_json=excluded.matched_actual_json,
        not_selected_json=excluded.not_selected_json,
        blocked_json=excluded.blocked_json,
        used_skill_ids_json='[]',
        outcome='pending',
        completed_at=NULL,
        created_at=excluded.created_at,
        updated_at=excluded.updated_at`,
    ).run(
      id,
      input.taskId,
      input.userMessageId,
      input.assistantMessageId,
      queryHash,
      JSON.stringify(context),
      JSON.stringify(recommended),
      JSON.stringify(actual),
      JSON.stringify(matchedActual),
      JSON.stringify(notSelected),
      JSON.stringify(blocked),
      JSON.stringify([]),
      at,
      at,
    );
    this.prune(input.taskId, at);
    const row = this.getByTurn(input.taskId, input.assistantMessageId);
    if (!row) throw new Error("Loadout observation write failed");
    return row;
  }

  markSkillUsed(taskId: string, assistantMessageId: string, skillId: string, at = Date.now()): void {
    const current = this.getByTurn(taskId, assistantMessageId);
    if (!current) return;
    const next = [...new Set([...current.usedSkillIds, skillId].filter(Boolean))];
    this.conn.prepare(
      "UPDATE agent_loadout_observations SET used_skill_ids_json=?,updated_at=? WHERE task_id=? AND assistant_message_id=?",
    ).run(JSON.stringify(next), at, taskId, assistantMessageId);
  }

  markOutcome(
    taskId: string,
    assistantMessageId: string,
    outcome: Exclude<AgentLoadoutObservationOutcome, "pending">,
    at = Date.now(),
  ): void {
    this.conn.prepare(
      `UPDATE agent_loadout_observations SET outcome=?,completed_at=?,updated_at=?
       WHERE task_id=? AND assistant_message_id=? AND outcome='pending'`,
    ).run(outcome, at, at, taskId, assistantMessageId);
  }

  abortPendingForTask(taskId: string, at = Date.now()): void {
    this.conn.prepare(
      `UPDATE agent_loadout_observations SET outcome='aborted',completed_at=?,updated_at=?
       WHERE task_id=? AND outcome='pending'`,
    ).run(at, at, taskId);
  }

  getByTurn(taskId: string, assistantMessageId: string): AgentLoadoutObservationDto | undefined {
    const row = this.conn.prepare(
      "SELECT * FROM agent_loadout_observations WHERE task_id=? AND assistant_message_id=?",
    ).get(taskId, assistantMessageId) as LoadoutObservationRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  list(taskId: string, limit = 50): AgentLoadoutObservationDto[] {
    const capped = Math.max(1, Math.min(AGENT_LOADOUT_MAX_RECORDS_PER_TASK, limit));
    const rows = this.conn.prepare(
      "SELECT * FROM agent_loadout_observations WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT ?",
    ).all(taskId, capped) as LoadoutObservationRow[];
    return rows.map(mapRow);
  }

  clear(taskId?: string): number {
    const result = taskId
      ? this.conn.prepare("DELETE FROM agent_loadout_observations WHERE task_id=?").run(taskId)
      : this.conn.prepare("DELETE FROM agent_loadout_observations").run();
    return result.changes;
  }

  private prune(taskId: string, now = Date.now()): void {
    const cutoff = now - AGENT_LOADOUT_MAX_AGE_MS;
    this.conn.prepare("DELETE FROM agent_loadout_observations WHERE task_id=? AND created_at<?").run(taskId, cutoff);
    this.conn.prepare(
      `DELETE FROM agent_loadout_observations
       WHERE task_id=? AND id NOT IN (
         SELECT id FROM agent_loadout_observations WHERE task_id=?
         ORDER BY created_at DESC,rowid DESC LIMIT ?
       )`,
    ).run(taskId, taskId, AGENT_LOADOUT_MAX_RECORDS_PER_TASK);
  }
}
