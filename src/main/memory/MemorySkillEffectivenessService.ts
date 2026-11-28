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
  private writeTail: Promise<void> = Promise.resolve();

  constructor(private readonly db: AppDatabase) {}

  private get conn() { return this.db.connection; }

  private get requiresRustWrites(): boolean {
    return Boolean(this.db.readonly || this.db.runtimeAuditReader?.supervised);
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private enqueueBatch3(context: string, request: Record<string, unknown>): void {
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error(`${context}：Rust 写入核心未就绪`);
    const next = this.writeTail.then(async () => {
      const result = await reader.batch3Write(request);
      if (result === undefined) throw new Error(`${context}：Rust 写入未收到确认`);
    });
    this.writeTail = next.then(() => undefined, () => undefined);
  }

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
    if (this.requiresRustWrites) {
      const exposures = [...unique.values()].map((skill) => ({
        id: idFor(input.taskId, input.assistantMessageId, skill.skillId),
        skillId: skill.skillId,
        candidateId: skill.candidateId ?? null,
        sourceMemoryIdsJson: JSON.stringify(skill.sourceMemoryIds),
      }));
      if (exposures.length > 0) {
        this.enqueueBatch3("记录技能曝光", {
          kind: "memorySkillEffectivenessOp",
          effAction: "recordExposure",
          taskId: input.taskId,
          assistantMessageId: input.assistantMessageId,
          exposures,
          skillId: null,
          invKind: null,
          toolCallId: null,
          outcome: null,
          id: null,
          feedbackKind: null,
          feedbackNote: null,
          at,
        });
      }
      return exposures.length;
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
    if (this.requiresRustWrites) {
      const fixture = this.db.fixtureConnection;
      const existing = fixture ? this.getByTurnSkill(input.taskId, input.assistantMessageId, input.skill.skillId) : undefined;
      const cleanSources = [...new Set(input.skill.sourceMemoryIds.filter(Boolean))];
      this.enqueueBatch3("记录技能调用", {
        kind: "memorySkillEffectivenessOp",
        effAction: "markInvoked",
        taskId: input.taskId,
        assistantMessageId: input.assistantMessageId,
        exposures: [{
          id: idFor(input.taskId, input.assistantMessageId, input.skill.skillId.trim()),
          skillId: input.skill.skillId.trim(),
          candidateId: input.skill.candidateId ?? null,
          sourceMemoryIdsJson: JSON.stringify(cleanSources),
        }],
        skillId: input.skill.skillId.trim(),
        invKind: input.kind,
        toolCallId: input.toolCallId ?? null,
        outcome: null,
        id: null,
        feedbackKind: null,
        feedbackNote: null,
        at,
      });
      return {
        id: existing?.id ?? idFor(input.taskId, input.assistantMessageId, input.skill.skillId),
        taskId: input.taskId,
        taskTitle: existing?.taskTitle ?? (fixture ? this.db.getTask(input.taskId)?.title : undefined),
        assistantMessageId: input.assistantMessageId,
        skillId: input.skill.skillId.trim(),
        candidateId: existing?.candidateId ?? input.skill.candidateId,
        sourceMemoryIds: existing && existing.sourceMemoryIds.length > 0 ? existing.sourceMemoryIds : cleanSources,
        exposedAt: existing?.exposedAt ?? at,
        invokedAt: existing?.invokedAt ?? at,
        invocationKind: existing?.invocationKind ?? input.kind,
        toolCallId: existing?.toolCallId ?? input.toolCallId,
        outcome: existing?.outcome ?? "pending",
        outcomeAt: existing?.outcomeAt,
        feedbackKind: existing?.feedbackKind,
        feedbackNote: existing?.feedbackNote,
        feedbackAt: existing?.feedbackAt,
        updatedAt: at,
      };
    }
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

  markTurnOutcome(taskId: string, assistantMessageId: string, outcome: Exclude<MemorySkillOutcome, "pending">, at = Date.now()): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("记录技能轮次结果", {
        kind: "memorySkillEffectivenessOp",
        effAction: "markTurnOutcome",
        taskId,
        assistantMessageId,
        exposures: [],
        skillId: null,
        invKind: null,
        toolCallId: null,
        outcome,
        id: null,
        feedbackKind: null,
        feedbackNote: null,
        at,
      });
      return;
    }
    this.conn.prepare(
      `UPDATE memory_skill_effectiveness
       SET outcome=?,outcome_at=?,updated_at=?
       WHERE task_id=? AND assistant_message_id=? AND outcome='pending'`,
    ).run(outcome, at, at, taskId, assistantMessageId);
  }

  abortPendingForTask(taskId: string, at = Date.now()): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("中止任务挂起技能统计", {
        kind: "memorySkillEffectivenessOp",
        effAction: "abortPendingForTask",
        taskId,
        assistantMessageId: null,
        exposures: [],
        skillId: null,
        invKind: null,
        toolCallId: null,
        outcome: null,
        id: null,
        feedbackKind: null,
        feedbackNote: null,
        at,
      });
      return;
    }
    this.conn.prepare(
      `UPDATE memory_skill_effectiveness
       SET outcome='aborted',outcome_at=?,updated_at=?
       WHERE task_id=? AND outcome='pending'`,
    ).run(at, at, taskId);
  }

  setFeedback(id: string, kind: MemorySkillFeedbackKind | null, note?: string): MemorySkillEffectivenessDto {
    const existing = this.get(id);
    if (!existing) throw new Error(`Skill effectiveness 记录不存在：${id}`);
    if (!existing.invokedAt) throw new Error("只有实际调用过的 Skill 才能记录效果反馈");
    const at = Date.now();
    const cleanNote = typeof note === "string" ? note.trim().slice(0, 1000) : "";
    if (this.requiresRustWrites) {
      this.enqueueBatch3("记录技能效果反馈", {
        kind: "memorySkillEffectivenessOp",
        effAction: "setFeedback",
        taskId: null,
        assistantMessageId: null,
        exposures: [],
        skillId: null,
        invKind: null,
        toolCallId: null,
        outcome: null,
        id,
        feedbackKind: kind,
        feedbackNote: kind ? (cleanNote || null) : null,
        at,
      });
      return {
        ...existing,
        feedbackKind: kind ?? undefined,
        feedbackNote: kind ? (cleanNote || undefined) : undefined,
        feedbackAt: kind ? at : undefined,
        updatedAt: at,
      };
    }
    this.conn.prepare(
      `UPDATE memory_skill_effectiveness
       SET feedback_kind=?,feedback_note=?,feedback_at=?,updated_at=? WHERE id=?`,
    ).run(kind, kind ? (cleanNote || null) : null, kind ? at : null, at, id);
    return this.get(id)!;
  }

  /** Host-resolved cross-Bot corrections retain the actual execution and Skill revision. */
  setWorkFeedback(input: { id: string; workId: string; executorBotId: string; candidateId: string;
    kind: MemorySkillFeedbackKind; note: string }): MemorySkillEffectivenessDto {
    const exposure = this.get(input.id);
    if (!exposure?.invokedAt || exposure.candidateId !== input.candidateId) {
      throw new Error("反馈未关联实际调用的 Skill 版本");
    }
    const binding = this.conn.prepare(`SELECT 1 FROM work_execution_bindings b
      JOIN works w ON w.work_id=b.work_id JOIN bots bot ON bot.bot_id=b.bot_id AND bot.user_id=w.user_id
      WHERE b.work_id=? AND b.bot_id=? AND b.task_id=? AND b.status!='invalidated'`)
      .get(input.workId, input.executorBotId, exposure.taskId);
    if (!binding) throw new Error("反馈不属于已关联 Work 的执行 Bot");
    return this.setFeedback(input.id, input.kind, input.note);
  }

  async getAsync(id: string): Promise<MemorySkillEffectivenessDto | undefined> {
    if (!this.db.coreIdentity) return this.get(id);
    const res = await this.db.runtimeAuditReader?.memoryRecordsData({
      kind: "skillEffectivenessQuery", action: "byId", id,
    });
    if (res?.kind !== "skillEffectiveness") throw new Error("Core 未确认技能效果读取");
    if (!res.row) return undefined;
    const row = res.row as unknown as EffectivenessRow;
    const task = await this.db.readTask(row.task_id, { includeExpertBinding: false });
    return mapRow(row, task?.title);
  }

  async getByTurnSkillAsync(taskId: string, assistantMessageId: string, skillId: string): Promise<MemorySkillEffectivenessDto | undefined> {
    if (!this.db.coreIdentity) return this.getByTurnSkill(taskId, assistantMessageId, skillId);
    const res = await this.db.runtimeAuditReader?.memoryRecordsData({
      kind: "skillEffectivenessQuery", action: "byTurnSkill", taskId, assistantMessageId, skillId,
    });
    if (res?.kind !== "skillEffectiveness") throw new Error("Core 未确认轮次技能效果读取");
    if (!res.row) return undefined;
    const row = res.row as unknown as EffectivenessRow;
    const task = await this.db.readTask(row.task_id, { includeExpertBinding: false });
    return mapRow(row, task?.title);
  }

  async listInvokedForTurnAsync(taskId: string, assistantMessageId: string): Promise<MemorySkillEffectivenessDto[]> {
    if (!this.db.coreIdentity) return this.listInvokedForTurn(taskId, assistantMessageId);
    const res = await this.db.runtimeAuditReader?.memoryRecordsData({
      kind: "skillEffectivenessQuery", action: "invokedForTurn", taskId, assistantMessageId,
    });
    if (res?.kind !== "skillEffectivenessList") throw new Error("Core 未确认轮次调用技能列表");
    return res.rows.map(r => mapRow(r as unknown as EffectivenessRow));
  }

  async latestInvocationAfterAsync(skillId: string, candidateId: string, after: number): Promise<number | undefined> {
    if (!this.db.coreIdentity) return this.latestInvocationAfter(skillId, candidateId, after);
    const res = await this.db.runtimeAuditReader?.memoryRecordsData({
      kind: "skillEffectivenessQuery", action: "latestInvocationAfter", skillId, candidateId, after,
    });
    if (res?.kind !== "skillEffectivenessLatest") throw new Error("Core 未确认技能最近调用时间");
    return res.latest ?? undefined;
  }

  async listRecentAsync(limit = 200, invokedOnly = true): Promise<MemorySkillEffectivenessDto[]> {
    if (!this.db.coreIdentity) return this.listRecent(limit, invokedOnly);
    const capped = Math.max(1, Math.min(1000, limit));
    const res = await this.db.runtimeAuditReader?.memoryRecordsData({
      kind: "skillEffectivenessQuery", action: "recent", limit: capped, invokedOnly,
    });
    if (res?.kind !== "skillEffectivenessList") throw new Error("Core 未确认技能效果列表");
    const rows = res.rows as unknown as EffectivenessRow[];
    const taskIds = [...new Set(rows.map(r => r.task_id))];
    const titles = new Map<string, string | undefined>();
    await Promise.all(taskIds.map(async tid => {
      const task = await this.db.readTask(tid, { includeExpertBinding: false });
      titles.set(tid, task?.title);
    }));
    return rows.map(row => mapRow(row, titles.get(row.task_id)));
  }

  async summariesAsync(limit = 100): Promise<MemorySkillEffectivenessSummaryDto[]> {
    if (!this.db.coreIdentity) return this.summaries(limit);
    const capped = Math.max(1, Math.min(500, limit));
    const res = await this.db.runtimeAuditReader?.memoryRecordsData({
      kind: "skillEffectivenessQuery", action: "summaries", limit: capped,
    });
    if (res?.kind !== "skillEffectivenessSummaries") throw new Error("Core 未确认技能效果汇总");
    return (res.rows as Array<{
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
    }>).map(row => {
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

  async setFeedbackAsync(id: string, kind: MemorySkillFeedbackKind | null, note?: string): Promise<MemorySkillEffectivenessDto> {
    if (!this.db.coreIdentity) return this.setFeedback(id, kind, note);
    const existing = await this.getAsync(id);
    if (!existing) throw new Error(`Skill effectiveness 记录不存在：${id}`);
    if (!existing.invokedAt) throw new Error("只有实际调用过的 Skill 才能记录效果反馈");
    const at = Date.now();
    const cleanNote = typeof note === "string" ? note.trim().slice(0, 1000) : "";
    this.enqueueBatch3("记录技能效果反馈", {
      kind: "memorySkillEffectivenessOp",
      effAction: "setFeedback",
      taskId: null,
      assistantMessageId: null,
      exposures: [],
      skillId: null,
      invKind: null,
      toolCallId: null,
      outcome: null,
      id,
      feedbackKind: kind,
      feedbackNote: kind ? (cleanNote || null) : null,
      at,
    });
    return {
      ...existing,
      feedbackKind: kind ?? undefined,
      feedbackNote: kind ? (cleanNote || undefined) : undefined,
      feedbackAt: kind ? at : undefined,
      updatedAt: at,
    };
  }

  async setWorkFeedbackAsync(input: { id: string; workId: string; executorBotId: string; candidateId: string;
    kind: MemorySkillFeedbackKind; note: string }): Promise<MemorySkillEffectivenessDto> {
    if (!this.db.coreIdentity) return this.setWorkFeedback(input);
    const exposure = await this.getAsync(input.id);
    if (!exposure?.invokedAt || exposure.candidateId !== input.candidateId) {
      throw new Error("反馈未关联实际调用的 Skill 版本");
    }
    const workScope = await this.db.runtimeAuditReader?.memoryRecordsData({
      kind: "assistantScopeContext", taskId: exposure.taskId, workId: input.workId, userId: "local-user",
    });
    const scopeInfo = workScope?.kind === "assistantScopeContext" ? workScope.workScope as { work_id?: string; bot_id?: string } | null : null;
    if (!scopeInfo || scopeInfo.work_id !== input.workId || scopeInfo.bot_id !== input.executorBotId) {
      throw new Error("反馈不属于已关联 Work 的执行 Bot");
    }
    return this.setFeedbackAsync(input.id, input.kind, input.note);
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

  listInvokedForTurn(taskId: string, assistantMessageId: string): MemorySkillEffectivenessDto[] {
    return (this.conn.prepare(`SELECT * FROM memory_skill_effectiveness
      WHERE task_id=? AND assistant_message_id=? AND invoked_at IS NOT NULL ORDER BY invoked_at,id`)
      .all(taskId, assistantMessageId) as EffectivenessRow[]).map(row => mapRow(row));
  }

  latestInvocationAfter(skillId: string, candidateId: string, after: number): number | undefined {
    const row = this.conn.prepare(`SELECT MAX(invoked_at) AS latest FROM memory_skill_effectiveness
      WHERE skill_id=? AND candidate_id=? AND invoked_at>?`).get(skillId, candidateId, after) as { latest: number | null };
    return row.latest ?? undefined;
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
