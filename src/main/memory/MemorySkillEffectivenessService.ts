import { createHash } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type {
  MemorySkillEffectivenessDto,
  MemorySkillEffectivenessSummaryDto,
  MemorySkillFeedbackKind,
  MemorySkillInvocationKind,
  MemorySkillOutcome,
} from "../../shared/memory-kernel";

interface LearnedSkillRef {
  skillId: string;
  candidateId?: string;
  sourceMemoryIds: string[];
}

interface EffectivenessRow {
  id: string;
  task_id: string;
  assistant_message_id: string;
  skill_id: string;
  candidate_id: string | null;
  source_memory_ids_json: string;
  exposed_at: number;
  invoked_at: number | null;
  invocation_kind: MemorySkillInvocationKind | null;
  tool_call_id: string | null;
  outcome: MemorySkillOutcome;
  outcome_at: number | null;
  feedback_kind: MemorySkillFeedbackKind | null;
  feedback_note: string | null;
  feedback_at: number | null;
  updated_at: number;
}

function idFor(taskId: string, assistantMessageId: string, skillId: string): string {
  const digest = createHash("sha256").update(`${taskId}\n${assistantMessageId}\n${skillId}`).digest("hex").slice(0, 28);
  return `mseff_${digest}`;
}

function parseStringArray(raw: string): string[] {
  try {
    const value = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapRow(row: EffectivenessRow, taskTitle?: string): MemorySkillEffectivenessDto {
  return {
    id: row.id,
    taskId: row.task_id,
    taskTitle,
    assistantMessageId: row.assistant_message_id,
    skillId: row.skill_id,
    candidateId: row.candidate_id ?? undefined,
    sourceMemoryIds: parseStringArray(row.source_memory_ids_json),
    exposedAt: row.exposed_at,
    invokedAt: row.invoked_at ?? undefined,
    invocationKind: row.invocation_kind ?? undefined,
    toolCallId: row.tool_call_id ?? undefined,
    outcome: row.outcome,
    outcomeAt: row.outcome_at ?? undefined,
    feedbackKind: row.feedback_kind ?? undefined,
    feedbackNote: row.feedback_note ?? undefined,
    feedbackAt: row.feedback_at ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * Skill effectiveness is observational telemetry for learned Skills.
 * It never changes Memory, Skill files, enablement, or Candidate status.
 */
export class MemorySkillEffectivenessService {
  constructor(private readonly db: AppDatabase) {}

  private get conn() { return this.db.connection; }

  recordExposure(input: {
    taskId: string;
    assistantMessageId: string;
    skills: LearnedSkillRef[];
    at?: number;
  }): number {
    if (!input.taskId || !input.assistantMessageId || input.skills.length === 0) return 0;
    const at = input.at ?? Date.now();
    const unique = new Map<string, LearnedSkillRef>();
    for (const skill of input.skills) {
      const id = skill.skillId.trim();
      if (!id) continue;
      unique.set(id, { ...skill, skillId: id, sourceMemoryIds: [...new Set(skill.sourceMemoryIds.filter(Boolean))] });
    }
    let changes = 0;
    this.conn.transaction(() => {
      for (const skill of unique.values()) {
        const result = this.conn.prepare(
          `INSERT INTO memory_skill_effectiveness (
            id,task_id,assistant_message_id,skill_id,candidate_id,source_memory_ids_json,
            exposed_at,outcome,updated_at
          ) VALUES (?,?,?,?,?,?,?,'pending',?)
          ON CONFLICT(task_id,assistant_message_id,skill_id) DO UPDATE SET
            candidate_id=COALESCE(memory_skill_effectiveness.candidate_id,excluded.candidate_id),
            source_memory_ids_json=CASE
              WHEN memory_skill_effectiveness.source_memory_ids_json='[]' THEN excluded.source_memory_ids_json
              ELSE memory_skill_effectiveness.source_memory_ids_json
            END,
            updated_at=MAX(memory_skill_effectiveness.updated_at,excluded.updated_at)`,
        ).run(
          idFor(input.taskId, input.assistantMessageId, skill.skillId),
          input.taskId,
          input.assistantMessageId,
          skill.skillId,
          skill.candidateId ?? null,
          JSON.stringify(skill.sourceMemoryIds),
          at,
          at,
        );
        changes += result.changes;
      }
    })();
    return changes;
  }

  markInvoked(input: {
    taskId: string;
    assistantMessageId: string;
    skill: LearnedSkillRef;
    kind: MemorySkillInvocationKind;
    toolCallId?: string;
    at?: number;
  }): MemorySkillEffectivenessDto {
    const at = input.at ?? Date.now();
    this.recordExposure({
      taskId: input.taskId,
      assistantMessageId: input.assistantMessageId,
      skills: [input.skill],
      at,
    });
    this.conn.prepare(
      `UPDATE memory_skill_effectiveness SET
        invoked_at=COALESCE(invoked_at,?),
        invocation_kind=COALESCE(invocation_kind,?),
        tool_call_id=COALESCE(tool_call_id,?),
        updated_at=?
       WHERE task_id=? AND assistant_message_id=? AND skill_id=?`,
    ).run(
      at,
      input.kind,
      input.toolCallId ?? null,
      at,
      input.taskId,
      input.assistantMessageId,
      input.skill.skillId,
    );
    const row = this.getByTurnSkill(input.taskId, input.assistantMessageId, input.skill.skillId);
    if (!row) throw new Error("Skill effectiveness invocation write failed");
    return row;
  }

  markTurnOutcome(taskId: string, assistantMessageId: string, outcome: Exclude<MemorySkillOutcome, "pending">, at = Date.now()): number {
    const result = this.conn.prepare(
      `UPDATE memory_skill_effectiveness
       SET outcome=?,outcome_at=?,updated_at=?
       WHERE task_id=? AND assistant_message_id=? AND outcome='pending'`,
    ).run(outcome, at, at, taskId, assistantMessageId);
    return result.changes;
  }

  abortPendingForTask(taskId: string, at = Date.now()): number {
    const result = this.conn.prepare(
      `UPDATE memory_skill_effectiveness
       SET outcome='aborted',outcome_at=?,updated_at=?
       WHERE task_id=? AND outcome='pending'`,
    ).run(at, at, taskId);
    return result.changes;
  }

  setFeedback(id: string, kind: MemorySkillFeedbackKind | null, note?: string): MemorySkillEffectivenessDto {
    const existing = this.get(id);
    if (!existing) throw new Error(`Skill effectiveness 记录不存在：${id}`);
    if (!existing.invokedAt) throw new Error("只有实际调用过的 Skill 才能记录效果反馈");
    const at = Date.now();
    const cleanNote = typeof note === "string" ? note.trim().slice(0, 1000) : "";
    this.conn.prepare(
      `UPDATE memory_skill_effectiveness
       SET feedback_kind=?,feedback_note=?,feedback_at=?,updated_at=? WHERE id=?`,
    ).run(kind, kind ? (cleanNote || null) : null, kind ? at : null, at, id);
    return this.get(id)!;
  }

  get(id: string): MemorySkillEffectivenessDto | undefined {
    const row = this.conn.prepare("SELECT * FROM memory_skill_effectiveness WHERE id=?").get(id) as EffectivenessRow | undefined;
    if (!row) return undefined;
    return mapRow(row, this.db.getTask(row.task_id)?.title);
  }

  getByTurnSkill(taskId: string, assistantMessageId: string, skillId: string): MemorySkillEffectivenessDto | undefined {
    const row = this.conn.prepare(
      "SELECT * FROM memory_skill_effectiveness WHERE task_id=? AND assistant_message_id=? AND skill_id=?",
    ).get(taskId, assistantMessageId, skillId) as EffectivenessRow | undefined;
    if (!row) return undefined;
    return mapRow(row, this.db.getTask(row.task_id)?.title);
  }

  listRecent(limit = 200, invokedOnly = true): MemorySkillEffectivenessDto[] {
    const capped = Math.max(1, Math.min(1000, limit));
    const rows = (invokedOnly
      ? this.conn.prepare("SELECT * FROM memory_skill_effectiveness WHERE invoked_at IS NOT NULL ORDER BY invoked_at DESC,id DESC LIMIT ?").all(capped)
      : this.conn.prepare("SELECT * FROM memory_skill_effectiveness ORDER BY exposed_at DESC,id DESC LIMIT ?").all(capped)) as EffectivenessRow[];
    return rows.map((row) => mapRow(row, this.db.getTask(row.task_id)?.title));
  }

  summaries(limit = 100): MemorySkillEffectivenessSummaryDto[] {
    const capped = Math.max(1, Math.min(500, limit));
    const rows = this.conn.prepare(
      `SELECT
        skill_id,
        candidate_id,
        COUNT(*) exposures,
        SUM(CASE WHEN invoked_at IS NOT NULL THEN 1 ELSE 0 END) invocations,
        SUM(CASE WHEN invoked_at IS NOT NULL AND outcome='completed' THEN 1 ELSE 0 END) completed_invocations,
        SUM(CASE WHEN invoked_at IS NOT NULL AND outcome='failed' THEN 1 ELSE 0 END) failed_invocations,
        SUM(CASE WHEN invoked_at IS NOT NULL AND outcome='aborted' THEN 1 ELSE 0 END) aborted_invocations,
        SUM(CASE WHEN feedback_kind='helpful' THEN 1 ELSE 0 END) helpful_feedback,
        SUM(CASE WHEN feedback_kind='needs_revision' THEN 1 ELSE 0 END) revision_feedback,
        SUM(CASE WHEN feedback_kind='incorrect' THEN 1 ELSE 0 END) incorrect_feedback,
        MAX(invoked_at) last_invoked_at
       FROM memory_skill_effectiveness
       GROUP BY skill_id,candidate_id
       ORDER BY COALESCE(MAX(invoked_at),MAX(exposed_at)) DESC, skill_id ASC,candidate_id ASC
       LIMIT ?`,
    ).all(capped) as Array<{
      skill_id: string;
      candidate_id: string | null;
      exposures: number;
      invocations: number;
      completed_invocations: number;
      failed_invocations: number;
      aborted_invocations: number;
      helpful_feedback: number;
      revision_feedback: number;
      incorrect_feedback: number;
      last_invoked_at: number | null;
    }>;
    return rows.map((row) => {
      const outcomes = row.completed_invocations + row.failed_invocations + row.aborted_invocations;
      const feedbackTotal = row.helpful_feedback + row.revision_feedback + row.incorrect_feedback;
      return {
        skillId: row.skill_id,
        candidateId: row.candidate_id ?? undefined,
        exposures: row.exposures,
        invocations: row.invocations,
        completedInvocations: row.completed_invocations,
        failedInvocations: row.failed_invocations,
        abortedInvocations: row.aborted_invocations,
        helpfulFeedback: row.helpful_feedback,
        needsRevisionFeedback: row.revision_feedback,
        incorrectFeedback: row.incorrect_feedback,
        adoptionRate: row.exposures > 0 ? row.invocations / row.exposures : 0,
        completionRate: outcomes > 0 ? row.completed_invocations / outcomes : 0,
        correctionRate: feedbackTotal > 0 ? (row.revision_feedback + row.incorrect_feedback) / feedbackTotal : 0,
        lastInvokedAt: row.last_invoked_at ?? undefined,
      };
    });
  }
}
