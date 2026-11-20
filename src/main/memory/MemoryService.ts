import { rankMemorySearch, rankMemorySearchAsync, tokenSimilarity } from "./MemoryRecallRanking";
import { botExtractionPolicy } from "./BotMemoryExtractionPolicy";
import { MemoryForgetWatermarks } from "./MemoryForgetWatermarks";
import type { MemoryForgetSource, MemoryRemovalIntent } from "./MemoryIntent";
import {
  MAX_INPUT_CHARS,
  EXTRACTION_SYSTEM_PROMPT,
  SKILL_DISTILLATION_PROMPT,
  type ExtractedCandidate,
  clamp,
  cleanText,
  cleanMultilineText,
  isSensitive,
  hashContent,
  responseText,
  extractCandidates,
} from "./MemoryCandidateExtraction";
import { resolveAssistantScopeChain, resolveWorkMemoryScope } from "./AssistantMemoryScopes";
import { botMemorySource, botMemoryTextEligible, botMemoryAutomaticBoundary, botPeerMemoryInput } from "./BotMemorySource";
import { projectMemoryContext } from "../agent/MemoryContextProjection";
import { randomUUID } from "node:crypto";
import type { AgentSession, ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AppDatabase } from "../db/AppDatabase";
import { LOCAL_USER_ID } from "../../shared/bot-work";
import {
  MEMORY_CONTENT_MAX_CHARS,
  MEMORY_EVIDENCE_KINDS,
  MEMORY_TITLE_MAX_CHARS,
  type MemoryCandidateDto,
  type MemoryCreateRequest,
  type MemoryEvidenceDto,
  type MemoryKernelStats,
  type MemoryIndexResult,
  type MemoryCoreProfileDto,
  type MemoryDismissedProjectionDto,
  type MemoryKind,
  type MemoryProjectionProposalDto,
  type MemoryProjectionDeleteRequest,
  type MemoryProjectionDeleteResult,
  type MemoryListRequest,
  type MemoryScenarioDto,
  type MemoryRecordDto,
  type MemoryRelationDto,
  type MemoryRevisionDto,
  type MemoryScopeType,
  type MemorySearchHit,
  type MemorySearchRequest,
  type MemoryTurnDto,
  type MemoryTurnListRequest,
  type MemoryUpdateRequest,
  type ResolvedMemoryContext,
} from "../../shared/memory-kernel";
import { MemoryRepository } from "./MemoryRepository";
import { MemoryTurnRepository } from "./MemoryTurnRepository";
import { MemoryCognitionService } from "./MemoryCognitionService";
import { MemorySkillLearningService } from "./MemorySkillLearningService";
import { procedureExecution } from "./MemoryProcedureEvidence";
import { MemorySemanticProvider, SemanticUnavailableError } from "./MemorySemanticProvider";

export interface MemoryExtractionInput {
  skillBatch?: import("./MemorySkillDistillation").SkillBatch;
  modelRuntime: ModelRuntime;
  model: NonNullable<AgentSession["model"]>;
  taskId: string;
  spaceId?: string;
  projectBound?: boolean;
  userText: string;
  assistantText: string;
  /** L0 source turns selected by MemoryPipelineManager. When present, extraction uses the whole bounded batch. */
  sourceTurns?: MemoryTurnDto[];
  isEnabled: () => boolean;
}

export interface MemoryExtractionResult {
  globalChanged: boolean;
  spaceChanged: boolean;
  projectChanged: boolean;
  taskChanged: boolean;
  extractedCount: number;
  committedCount: number;
  reviewCount: number;
}

/** 已完成启动期遗留候选清理的 AppDatabase：冷启动有 4 个 MemoryService 构造点，只允许清理一次。 */
const reapedDatabases = new WeakSet<AppDatabase>();

export class MemoryService {
  readonly repository: MemoryRepository;
  readonly cognition: MemoryCognitionService;
  readonly learning: MemorySkillLearningService;
  private readonly semantic: MemorySemanticProvider | null;
  private readonly forgetWatermarks: MemoryForgetWatermarks;

  constructor(private readonly db: AppDatabase, opts?: { semantic?: boolean }) {
    this.repository = new MemoryRepository(db);
    this.forgetWatermarks = new MemoryForgetWatermarks(db.connection);
    this.cognition = new MemoryCognitionService(db);
    this.learning = new MemorySkillLearningService(db, this.repository);
    this.semantic = opts?.semantic === false ? null : new MemorySemanticProvider(db);
    // Candidates stuck 'pending' from an interrupted extraction become reviewable instead of invisible.
    // 每个 AppDatabase 只跑一次：同一进程有 4 个构造点，重放会反复改判在飞候选。
    if (!reapedDatabases.has(db)) {
      reapedDatabases.add(db);
      try {
        const reaped = this.repository.reapStalePendingCandidates(Date.now() - 10 * 60_000);
        if (reaped > 0) console.info(`[MemoryKernel] reaped ${reaped} stale pending candidates → needs_review`);
      } catch (error) {
        console.warn("[MemoryKernel] stale candidate reap failed", error);
      }
    }
  }

  get(id: string): MemoryRecordDto | undefined { return this.repository.get(id); }

  /** Model-facing read; raw get stays available to audit and mutation internals. */
  getForRecall(id: string, request: MemorySearchRequest): MemoryRecordDto | undefined {
    const memory = this.repository.get(id);
    if (!memory) return;
    const scopes = this.resolveScopeChain({ ...request, includeInherited: request.includeInherited ?? true });
    if (!this.visibleInChain(memory, scopes, request)) return;
    return this.forgetWatermarks.projectEvidence(memory, scopes);
  }

  /** Scope-safe visibility check used by Agent/MCP surfaces; guessed ids must not cross scope boundaries. */
  canAccess(id: string, request: MemorySearchRequest): boolean {
    const memory = this.repository.get(id);
    if (!memory) return false;
    const chain = this.resolveScopeChain({ ...request, includeInherited: request.includeInherited ?? true });
    return this.visibleInChain(memory, chain, request);
  }

  /**
   * A selected turn snapshot survives normal fact updates, resolution and replacement.
   * New recall still selects only active facts. Deletion, invalidation, access loss
   * and an explicit validity boundary withdraw even an already-selected snapshot.
   */
  contextSnapshotRevocationReason(
    source: { id: string; revision: number },
    request: Pick<MemorySearchRequest, "taskId" | "projectId" | "workspaceId">,
    now = Date.now(),
  ): "deleted" | "invalid" | "scope" | "validity" | undefined {
    const memory = this.repository.get(source.id);
    if (!memory) return "deleted";
    if (memory.status === "invalid") return "invalid";
    if (!this.canAccess(source.id, request)) return "scope";
    if (memory.validFrom !== undefined && memory.validFrom > now) return "validity";

    let validUntil = memory.validUntil;
    if (memory.status === "superseded" && validUntil !== undefined && validUntil <= now) {
      // supersede() automatically closes the old fact's interval. That boundary
      // retires it from new recall; it does not revoke this turn's frozen evidence.
      // Verify the actual SUPERSEDES transition rather than exempting every expired
      // superseded record. A later explicit deadline must still take effect, and
      // the deadline before replacement must not be extended by the replacement.
      const history = this.history(source.id);
      const transition = history.findIndex((revision, index) => {
        const previous = history[index + 1];
        return previous && previous.revision >= source.revision && previous.status !== "superseded"
          && revision.status === "superseded" && revision.validUntil === validUntil
          && memory.relations.some((relation) => relation.relation === "SUPERSEDES"
            && relation.toMemoryId === source.id && relation.createdAt === revision.validUntil);
      });
      if (transition >= 0) validUntil = history[transition + 1]!.validUntil;
    }
    if (validUntil !== undefined && validUntil <= now) return "validity";
    return undefined;
  }

  /** Default durable scope for an Agent write: Project > Workspace > Task. Global requires explicit selection. */
  inferAgentScope(taskId: string): { scopeType: MemoryScopeType; scopeId?: string } {
    const work = this.workMemoryScope(taskId);
    if (work) return { scopeType: "work", scopeId: work.work_id };
    const conversation = botMemorySource(this.db, taskId);
    if (conversation?.shared) return { scopeType: "conversation", scopeId: taskId };
    if (conversation?.team_id) return { scopeType: "team", scopeId: conversation.team_id };
    const botId = this.channelBotId(taskId);
    if (botId) return { scopeType: "bot", scopeId: botId };
    const task = this.db.getTask(taskId);
    if (task?.projectId) return { scopeType: "project", scopeId: task.projectId };
    if (task?.spaceId) return { scopeType: "workspace", scopeId: task.spaceId };
    return { scopeType: "task", scopeId: taskId };
  }

  list(request: MemoryListRequest | number = {}): MemoryRecordDto[] {
    if (typeof request === "number") return this.repository.listAll(request);
    if (!request.query && !request.scopeType && !request.kind && !request.status) {
      return this.repository.listAll(request.limit ?? 500);
    }
    return this.repository.listFiltered(request);
  }
  listExactScope(
    scopeType: MemoryScopeType,
    scopeId?: string,
    statuses: MemoryRecordDto["status"][] = ["active", "superseded", "resolved"],
    limit = 2000,
  ): MemoryRecordDto[] {
    return this.repository.listByScopes({ scopes: [{ scopeType, scopeId }], statuses, limit })
      .map((item) => item.memory);
  }
  history(id: string): MemoryRevisionDto[] { return this.repository.listRevisions(id); }
  stats(): MemoryKernelStats { return this.repository.stats(); }
  listTurns(request: MemoryTurnListRequest = {}): MemoryTurnDto[] { return new MemoryTurnRepository(this.db).list(request); }
  historicalUserInputs(sessionId: string, taskId?: string): Array<{ id: string; userText: string }> {
    return new MemoryTurnRepository(this.db).historicalUserInputs(sessionId, taskId);
  }
  getTurn(id: string): MemoryTurnDto | undefined { return new MemoryTurnRepository(this.db).get(id); }
  memoriesForTurn(turnId: string): MemoryRecordDto[] { return this.repository.listByEvidence("conversation", turnId, 500); }
  retryFailedTurns(): { reset: number; taskIds: string[] } { return new MemoryTurnRepository(this.db).resetFailedTurns(); }

  /** Archived-project write guard exposed for callers that mutate through non-update paths (e.g. scope detach → hard delete). */
  assertMemoryWritable(id: string): void {
    const record = this.repository.get(id);
    if (record) this.assertRecordWritable(record);
  }

  dismissProjection(id: string, kind: "scenario" | "profile"): boolean { return this.cognition.dismissProjection(id, kind); }
  deleteProjectionRecords(request: MemoryProjectionDeleteRequest): MemoryProjectionDeleteResult { return this.cognition.deleteProjectionRecords(request); }
  restoreProjection(id: string): boolean { return this.cognition.restoreProjection(id); }
  listDismissedProjections(): MemoryDismissedProjectionDto[] { return this.cognition.listDismissedProjections(); }
  listProjectionProposals(status?: "pending" | "rejected"): MemoryProjectionProposalDto[] { return this.cognition.listProposals(status); }
  approveProjectionProposal(id: string): boolean { return this.cognition.approveProposal(id); }
  rejectProjectionProposal(id: string): boolean { return this.cognition.rejectProposal(id); }
  restoreProjectionProposal(id: string): boolean { return this.cognition.restoreProposal(id); }

  listScenarios(limit = 300): MemoryScenarioDto[] { return this.cognition.listScenarios(limit); }
  listCoreProfiles(limit = 100): MemoryCoreProfileDto[] { return this.cognition.listCoreProfiles(limit); }
  listSkillCandidates(status?: import("../../shared/memory-kernel").MemorySkillCandidateStatus, limit?: number) { return this.learning.list(status, limit); }
  refreshSkillCandidates() { return this.learning.refresh(); }
  deleteSkillHistory(request: import("../../shared/memory-kernel").MemorySkillHistoryDeleteRequest): number {
    if (!request || !["candidate", "revision"].includes(request.kind)
      || (request.all !== undefined && typeof request.all !== "boolean")
      || (request.ids !== undefined && (!Array.isArray(request.ids) || request.ids.some((id) => typeof id !== "string" || !id.trim())))
      || (request.all ? request.ids !== undefined : !Array.isArray(request.ids))) {
      throw new Error("请选择要删除的技能历史记录。");
    }
    const table = request.kind === "candidate" ? "memory_skill_candidates" : "memory_skill_revision_candidates";
    const conn = this.db.connection;
    return conn.transaction(() => {
      if (request.all) return conn.prepare(`DELETE FROM ${table} WHERE status IN ('stale','rejected')`).run().changes;
      const ids = [...new Set(request.ids!)];
      const lookup = conn.prepare(`SELECT status FROM ${table} WHERE id=?`);
      for (const id of ids) {
        const row = lookup.get(id) as { status: string } | undefined;
        if (row && row.status !== "stale" && row.status !== "rejected") throw new Error("只能删除已过期或已拒绝的历史记录；待处理记录请拒绝，已生成技能请在技能中心管理。");
      }
      const remove = conn.prepare(`DELETE FROM ${table} WHERE id=? AND status IN ('stale','rejected')`);
      return ids.reduce((deleted, id) => deleted + remove.run(id).changes, 0);
    })();
  }
  listCandidates(status?: MemoryCandidateDto["status"], limit?: number): MemoryCandidateDto[] {
    return this.repository.listCandidates(status, limit);
  }

  private buildRecord(request: MemoryCreateRequest, now = Date.now()): MemoryRecordDto {
    const title = cleanText(request.title, MEMORY_TITLE_MAX_CHARS);
    const content = cleanMultilineText(request.content ?? "", MEMORY_CONTENT_MAX_CHARS);
    if (!title) throw new Error("记忆标题不能为空");
    if (isSensitive(`${title} ${content}`)) throw new Error("记忆包含疑似敏感秘密，拒绝保存");
    this.assertScope(request.scopeType, request.scopeId);
    const id = `mem_${randomUUID()}`;
    if ((request.evidence ?? []).some((item) => !(MEMORY_EVIDENCE_KINDS as readonly string[]).includes(item.evidenceKind))) {
      throw new Error("记忆证据类型非法");
    }
    const evidence: MemoryEvidenceDto[] = (request.evidence ?? []).slice(0, 20).map((e) => ({
      id: `mev_${randomUUID()}`,
      memoryId: id,
      evidenceKind: e.evidenceKind,
      refId: cleanText(e.refId, 500),
      refTitle: cleanText(e.refTitle, 500) || undefined,
      excerpt: cleanText(e.excerpt, 1200) || undefined,
      createdAt: now,
    })).filter((e) => e.refId);
    return {
      id,
      kind: request.kind,
      title,
      content,
      status: request.status ?? "active",
      importance: Math.round(clamp(request.importance, 0, 3, 0)),
      confidence: clamp(request.confidence, 0, 1, request.explicit ? 1 : 0.8),
      explicit: request.explicit === true,
      sourceType: request.sourceType ?? (request.explicit ? "user" : "agent"),
      sourceId: cleanText(request.sourceId, 500) || undefined,
      sourceTaskId: cleanText(request.sourceTaskId, 200) || undefined,
      validFrom: request.validFrom,
      validUntil: request.validUntil,
      contentHash: hashContent(request.kind, title, content),
      createdAt: now,
      updatedAt: now,
      recallCount: 0,
      metadata: request.metadata ?? {},
      scopes: [{ memoryId: id, scopeType: request.scopeType, scopeId: request.scopeId, binding: "owned", createdAt: now }],
      evidence,
      relations: [],
    };
  }

  private invalidateProjectionScopes(scopes: MemoryRecordDto["scopes"]): void {
    this.cognition.projections.invalidateScopes(scopes);
  }

  /** Project-scoped L1 changes also advance the Project activity/version clock. */
  private touchProjectScopes(scopes: MemoryRecordDto["scopes"], now: number): void {
    const projectIds = new Set(
      scopes
        .filter((scope) => scope.scopeType === "project" && scope.scopeId)
        .map((scope) => scope.scopeId!),
    );
    const touch = this.db.connection.prepare(
      "UPDATE projects SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?",
    );
    for (const projectId of projectIds) touch.run(now, projectId);
  }

  create(request: MemoryCreateRequest): MemoryRecordDto {
    if (request.sourceTaskId && request.sourceType === "agent"
      && (this.workMemoryScope(request.sourceTaskId) || this.channelBotId(request.sourceTaskId))
      && !this.canPromoteFromTask(request.sourceTaskId, request.scopeType, request.scopeId)) {
      throw new Error("记忆写入范围不属于当前 Bot、团队、项目或 Work");
    }
    const record = this.buildRecord(request);
    const saved = this.db.connection.transaction(() => {
      const inserted = this.repository.insert(record);
      this.invalidateProjectionScopes(inserted.scopes);
      this.touchProjectScopes(inserted.scopes, inserted.updatedAt);
      return inserted;
    })();
    if (saved.kind === "procedure") {
      try { this.learning.invalidateByMemoryIds([saved.id]); } catch (error) { console.warn("[MemoryKernel] skill candidate invalidation failed", error); }
    }
    this.queueSemanticIndex(saved);
    return saved;
  }

  /** Model tools carry their host-bound task identity separately from memory provenance. */
  updateFromTask(taskId: string, request: MemoryUpdateRequest): MemoryRecordDto {
    return this.db.connection.transaction(() => {
      this.assertTaskMemoryWritable(taskId, request.id);
      return this.update(request);
    })();
  }

  update(request: MemoryUpdateRequest): MemoryRecordDto {
    const current = this.repository.get(request.id);
    if (!current) throw new Error(`记忆不存在：${request.id}`);
    this.assertRecordWritable(current);
    const title = request.title === undefined ? current.title : cleanText(request.title, MEMORY_TITLE_MAX_CHARS);
    const content = request.content === undefined ? current.content : cleanMultilineText(request.content, MEMORY_CONTENT_MAX_CHARS);
    if (!title) throw new Error("记忆标题不能为空");
    if (isSensitive(`${title} ${content}`)) throw new Error("记忆包含疑似敏感秘密，拒绝保存");
    const kind = request.kind ?? current.kind;
    const metadata = request.metadata === undefined ? current.metadata : request.metadata;
    const status = request.status ?? current.status;
    const importance = request.importance === undefined ? current.importance : Math.round(clamp(request.importance, 0, 3, current.importance));
    const confidence = request.confidence === undefined ? current.confidence : clamp(request.confidence, 0, 1, current.confidence);
    const explicit = request.explicit ?? current.explicit;
    const validFrom = request.validFrom === undefined ? current.validFrom : request.validFrom ?? undefined;
    const validUntil = request.validUntil === undefined ? current.validUntil : request.validUntil ?? undefined;
    const contentHash = hashContent(kind, title, content);
    if (
      kind === current.kind && title === current.title && content === current.content &&
      status === current.status && importance === current.importance && confidence === current.confidence &&
      explicit === current.explicit && validFrom === current.validFrom && validUntil === current.validUntil &&
      contentHash === current.contentHash && JSON.stringify(metadata) === JSON.stringify(current.metadata)
    ) return current;
    const next: MemoryRecordDto = {
      ...current,
      kind,
      title,
      content,
      status,
      importance,
      confidence,
      explicit,
      validFrom,
      validUntil,
      metadata,
      contentHash,
      updatedAt: Date.now(),
    };
    const saved = this.db.connection.transaction(() => {
      const updated = this.repository.update(next, request.changedBy ?? "manual", request.changeReason);
      this.invalidateProjectionScopes(updated.scopes);
      this.touchProjectScopes(updated.scopes, updated.updatedAt);
      return updated;
    })();
    if (current.kind === "procedure" || saved.kind === "procedure") {
      try {
        const procedureMeaningChanged = current.kind !== saved.kind || current.status !== saved.status || current.contentHash !== saved.contentHash;
        if (procedureMeaningChanged) this.learning.invalidateByMemoryIds([saved.id]);
      } catch (error) { console.warn("[MemoryKernel] skill candidate invalidation failed", error); }
    }
    this.queueSemanticIndex(saved);
    return saved;
  }

  supersede(oldId: string, request: MemoryCreateRequest): MemoryRecordDto {
    const old = this.repository.get(oldId);
    if (!old) throw new Error(`被替代记忆不存在：${oldId}`);
    this.assertRecordWritable(old);
    const now = Date.now();
    const replacement = this.buildRecord({ ...request, validFrom: request.validFrom ?? now }, now);
    const superseded: MemoryRecordDto = {
      ...old,
      status: "superseded",
      validUntil: now,
      updatedAt: now,
    };
    const relation: MemoryRelationDto = {
      id: `mrel_${randomUUID()}`,
      fromMemoryId: replacement.id,
      relation: "SUPERSEDES",
      toMemoryId: old.id,
      createdAt: now,
    };
    const created = this.db.connection.transaction(() => {
      const inserted = this.repository.supersede(
        superseded,
        replacement,
        relation,
        request.sourceType ?? "agent",
        `superseded by ${replacement.id}`,
      );
      this.invalidateProjectionScopes([...old.scopes, ...inserted.scopes]);
      this.touchProjectScopes([...old.scopes, ...inserted.scopes], now);
      return inserted;
    })();
    if (old.kind === "procedure") {
      try { this.learning.invalidateByMemoryIds([old.id]); }
      catch (error) { console.warn("[MemoryKernel] skill candidate invalidation failed", error); }
    }
    if (created.kind === "procedure") {
      try { this.learning.invalidateByMemoryIds([created.id]); }
      catch (error) { console.warn("[MemoryKernel] skill candidate invalidation failed", error); }
    }
    this.queueSemanticIndex(created);
    return created;
  }

  resolve(id: string, changedBy: MemoryRecordDto["sourceType"] = "agent"): MemoryRecordDto {
    return this.update({ id, status: "resolved", changedBy, changeReason: "resolved" });
  }

  forget(id: string): void {
    const current = this.repository.get(id);
    if (current) this.assertRecordWritable(current);
    this.db.connection.transaction(() => {
      if (current) this.forgetWatermarks.withdrawRecord(current, this.repository.listRevisions(id), current.scopes);
      this.repository.hardDelete(id);
      if (current) {
        this.invalidateProjectionScopes(current.scopes);
        this.touchProjectScopes(current.scopes, Date.now());
      }
    })();
    if (current?.kind === "procedure") {
      try { this.learning.invalidateByMemoryIds([id]); }
      catch (error) { console.warn("[MemoryKernel] skill candidate invalidation failed", error); }
    }
  }

  recordForgetBoundary(scopeType: MemoryScopeType, scopeId: string | undefined, cutoffAt: number, allowedMessageId?: string): void {
    this.assertScope(scopeType, scopeId);
    this.forgetWatermarks.advance([{ scopeType, scopeId }], cutoffAt, allowedMessageId);
  }

  recordForgetIntent(scopeType: MemoryScopeType, scopeId: string | undefined, intent: Extract<MemoryRemovalIntent, { kind: "forget" }>, cutoffAt: number, messageId: string): void {
    this.assertScope(scopeType, scopeId);
    this.forgetWatermarks.recordIntent([{ scopeType, scopeId }], intent, cutoffAt, messageId);
  }

  /**
   * Detach one durable scope without deleting the L1 atom from other scopes.
   * If the removed scope was the atom's last binding, the atom is hard-forgotten.
   */
  detachScope(id: string, scopeType: MemoryScopeType, scopeId?: string, source?: MemoryForgetSource): { detached: boolean; forgotten: boolean } {
    const current = this.repository.get(id);
    if (!current) return { detached: false, forgotten: false };
    const target = current.scopes.find(
      (scope) => scope.scopeType === scopeType && (scope.scopeId ?? "") === (scopeId ?? ""),
    );
    if (!target) return { detached: false, forgotten: false };

    const forgotten = this.db.connection.transaction(() => {
      this.forgetWatermarks.withdrawRecord(current, this.repository.listRevisions(id), [target], source);
      this.repository.removeScope(id, scopeType, scopeId);
      const remaining = this.repository.get(id)?.scopes ?? [];
      if (remaining.length === 0) {
        this.repository.hardDelete(id);
        this.invalidateProjectionScopes(current.scopes);
        this.touchProjectScopes([target], Date.now());
        return true;
      }
      this.invalidateProjectionScopes([target]);
      this.touchProjectScopes([target], Date.now());
      return false;
    })();

    if (current.kind === "procedure") {
      try {
        this.learning.invalidateByMemoryIds([id]);
      } catch (error) {
        console.warn("[MemoryKernel] skill candidate scope invalidation failed", error);
      }
    }
    return { detached: true, forgotten };
  }

  /** Project/Workspace lifecycle cleanup. Exact scope only; inherited scopes are untouched. */
  detachAllInScope(scopeType: Exclude<MemoryScopeType, "global">, scopeId: string): { detached: number; forgotten: number } {
    const ids = (this.db.connection.prepare(
      "SELECT DISTINCT memory_id FROM memory_scopes WHERE scope_type=? AND scope_id=?",
    ).all(scopeType, scopeId) as Array<{ memory_id: string }>).map((row) => row.memory_id);
    let detached = 0;
    let forgotten = 0;
    for (const id of ids) {
      const result = this.detachScope(id, scopeType, scopeId);
      if (result.detached) detached += 1;
      if (result.forgotten) forgotten += 1;
    }
    return { detached, forgotten };
  }

  canPromoteFromTask(taskId: string, targetScopeType: MemoryScopeType, targetScopeId?: string): boolean {
    const work = this.workMemoryScope(taskId);
    if (work) return (targetScopeType === "task" && targetScopeId === taskId)
      || (targetScopeType === "work" && targetScopeId === work.work_id)
      || (!work.shared && targetScopeType === "project" && Boolean(work.project_id) && targetScopeId === work.project_id);
    const conversation = botMemorySource(this.db, taskId);
    if (conversation) return (targetScopeType === "conversation" && targetScopeId === taskId)
      || (!conversation.shared && targetScopeType === (conversation.team_id ? "team" : "bot") && targetScopeId === (conversation.team_id ?? conversation.bot_id));
    const channelBotId = this.channelBotId(taskId);
    if (channelBotId) return (targetScopeType === "bot" && targetScopeId === channelBotId)
      || (targetScopeType === "task" && targetScopeId === taskId);
    if (["bot", "team", "conversation", "work"].includes(targetScopeType)) return false;
    const task = this.db.getTask(taskId);
    if (!task) return false;
    if (targetScopeType === "global") return targetScopeId == null;
    if (targetScopeType === "task") return targetScopeId === taskId;
    if (targetScopeType === "project") return Boolean(task.projectId && targetScopeId === task.projectId);
    if (targetScopeType === "workspace") {
      if (!task.spaceId || !targetScopeId) return false;
      if (targetScopeId === task.spaceId) return true;
      return this.db.getSpaceAncestors(task.spaceId).some((space) => space.id === targetScopeId && !space.effectiveArchived);
    }
    return false;
  }

  promoteFromTask(taskId: string, id: string, scopeType: MemoryScopeType, scopeId?: string): MemoryRecordDto {
    return this.db.connection.transaction(() => {
      this.assertTaskMemoryWritable(taskId, id);
      if (taskId !== "transient" && !this.canPromoteFromTask(taskId, scopeType, scopeId)) {
        throw new Error("目标作用域不属于当前任务可写范围，拒绝越界提升");
      }
      return this.promote(id, scopeType, scopeId);
    })();
  }

  promote(id: string, scopeType: MemoryScopeType, scopeId?: string): MemoryRecordDto {
    const memory = this.repository.get(id);
    if (!memory) throw new Error(`记忆不存在：${id}`);
    this.assertScope(scopeType, scopeId);
    const now = Date.now();
    const promoted = this.db.connection.transaction(() => {
      const scope = { memoryId: id, scopeType, scopeId, binding: "promoted" as const, createdAt: now };
      this.repository.addScope(scope);
      this.invalidateProjectionScopes([scope]);
      this.touchProjectScopes([scope], now);
      return this.repository.get(id)!;
    })();
    if (promoted.kind === "procedure") {
      try { this.learning.invalidateByMemoryIds([promoted.id]); } catch (error) { console.warn("[MemoryKernel] skill candidate invalidation failed", error); }
    }
    return promoted;
  }

  search(request: MemorySearchRequest): MemorySearchHit[] {
    const scopes = this.resolveScopeChain(request);
    const query = request.query?.trim() ?? "";
    const scopeQuery = {
      scopes,
      statuses: request.statuses?.length ? request.statuses : ["active"],
      kinds: request.kinds,
    } satisfies import("./MemorySearchScope").MemorySearchScope;
    const candidates = query ? this.repository.searchScoped(query, scopeQuery, Math.max(Math.min(request.limit ?? 20, 100) * 4, 100),
      memory => this.visibleInChain(memory, scopes, request)) : undefined;
    const scoped = candidates?.scoped ?? this.repository.listByScopes({ ...scopeQuery, limit: Math.max((request.limit ?? 20) * 30, 500) });
    const ftsRank = candidates?.ftsRanks ?? new Map<string, number>();
    return rankMemorySearch({ scoped, ftsRank, query, request, scopes, visible: memory => this.visibleInChain(memory, scopes, request) })
      .map(hit => ({ ...hit, memory: this.forgetWatermarks.projectEvidence(hit.memory, scopes) }));
  }

  private async searchLexicalAsync(request: MemorySearchRequest): Promise<MemorySearchHit[]> {
    const query = request.query?.trim() ?? "";
    if (!query) return this.search(request);
    const stamp = this.recallScopeStamp(request);
    const scopes = this.resolveScopeChain(request);
    const candidates = await this.repository.searchScopedAsync(query, { scopes,
      statuses: request.statuses?.length ? request.statuses : ["active"], kinds: request.kinds },
      Math.max(Math.min(request.limit ?? 20, 100) * 4, 100), memory => this.visibleInChain(memory, scopes, request));
    if (!this.db.connection.open || this.recallScopeStamp(request) !== stamp) return [];
    const hits = await rankMemorySearchAsync({ scoped: candidates.scoped, ftsRank: candidates.ftsRanks, query, request, scopes,
      visible: memory => this.visibleInChain(memory, scopes, request), current: id => this.repository.get(id) });
    return this.db.connection.open && this.recallScopeStamp(request) === stamp
      ? hits.map(hit => ({ ...hit, memory: this.forgetWatermarks.projectEvidence(hit.memory, scopes) })) : [];
  }

  /** A pending external computation must never retain an old task/scope authorization. */
  private recallScopeStamp(request: MemorySearchRequest): string {
    const task = request.taskId ? this.db.getTask(request.taskId) : undefined;
    return JSON.stringify({ task: request.taskId ? {
      exists: Boolean(task), projectId: task?.projectId ?? null,
      workspaceId: task?.spaceId ?? null, archived: task?.archived ?? false,
    } : null, chain: this.resolveScopeChain(request) });
  }

  /** Scope-first hybrid recall. Re-read facts and visibility after every async boundary. */
  async searchHybrid(request: MemorySearchRequest,
    onLexicalFallback?: (reason: "short-query" | "unavailable") => void): Promise<MemorySearchHit[]> {
    const requestedLimit = Math.max(1, Math.min(100, request.limit ?? 20));
    const query = request.query?.trim() ?? "";
    const initialScopeStamp = this.recallScopeStamp(request);
    const freshLexical = async (): Promise<MemorySearchHit[]> => this.db.connection.open
      && this.recallScopeStamp(request) === initialScopeStamp
      ? this.searchLexicalAsync({ ...request, limit: Math.max(requestedLimit * 3, 40) }) : [];
    if (query.length < 4 || !this.semantic) {
      onLexicalFallback?.(query.length < 4 ? "short-query" : "unavailable");
      return (await freshLexical()).slice(0, requestedLimit);
    }

    const scopes = this.resolveScopeChain(request);
    try {
      const semantic = await this.semantic.search(query, { scopes,
        statuses: request.statuses?.length ? request.statuses : ["active"], kinds: request.kinds }, (id, hash) => {
          const memory = this.repository.get(id);
          return Boolean(memory && memory.contentHash === hash && this.visibleInChain(memory, this.resolveScopeChain(request), request));
        }, Math.max(requestedLimit * 3, 40));
      if (!this.db.connection.open || this.recallScopeStamp(request) !== initialScopeStamp) return [];
      // Cached DTOs are not authorization: a forget, supersede, expiry, scope detach,
      // or update may have happened while the embedding runtime was busy.
      const lexical = await freshLexical();
      if (!this.db.connection.open || this.recallScopeStamp(request) !== initialScopeStamp) return [];
      const currentScopes = this.resolveScopeChain(request);
      const statuses = new Set(request.statuses?.length ? request.statuses : ["active"]);
      const now = Date.now();
      const fused = new Map<string, { lexicalRank?: number; lexicalReasons?: string[]; semanticRank?: number; memory: MemoryRecordDto }>();
      lexical.forEach((hit, index) => fused.set(hit.memory.id, { lexicalRank: index + 1, lexicalReasons: hit.reasons, memory: hit.memory }));
      semantic.forEach((hit, index) => {
        const memory = this.repository.get(hit.memoryId);
        if (!memory || hit.contentHash !== memory.contentHash || !statuses.has(memory.status)
          || (request.kinds?.length && !request.kinds.includes(memory.kind))
          || (memory.status === "active" && ((memory.validFrom !== undefined && memory.validFrom > now)
            || (memory.validUntil !== undefined && memory.validUntil <= now)))
          || !this.visibleInChain(memory, currentScopes, request)) return;
        fused.set(hit.memoryId, { ...fused.get(hit.memoryId), semanticRank: index + 1, memory });
      });
      const RRF_K = 60;
      return [...fused.values()].map((entry): MemorySearchHit => {
        const scope = this.bestMatchedScope(entry.memory, currentScopes);
        const distance = currentScopes.find(item => item.scopeType === scope.scopeType && (item.scopeId ?? "") === (scope.scopeId ?? ""))?.distance ?? 10;
        let rrf = 0;
        const reasons: string[] = [];
        if (entry.lexicalRank !== undefined) { rrf += 1 / (RRF_K + entry.lexicalRank); reasons.push(entry.lexicalReasons?.includes("bm25") ? "bm25" : "lexical"); }
        if (entry.semanticRank !== undefined) { rrf += 1 / (RRF_K + entry.semanticRank); reasons.push("semantic"); }
        if (entry.lexicalRank !== undefined && entry.semanticRank !== undefined) reasons.push("rrf");
        const metadataBoost = Math.max(0, 7 - distance) + entry.memory.importance * 1.8 + entry.memory.confidence * 1.5 + (entry.memory.explicit ? 2 : 0);
        return { memory: this.forgetWatermarks.projectEvidence(entry.memory, currentScopes), score: rrf * 1000 + metadataBoost,
          reasons: [...reasons, `scope:${scope.scopeType}${distance ? `/${distance}` : ""}`], scopeDistance: distance };
      }).sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt).slice(0, requestedLimit);
    } catch (error) {
      onLexicalFallback?.("unavailable");
      if (!(error instanceof SemanticUnavailableError)) console.warn("[MemoryKernel] semantic recall failed", error);
      return (await freshLexical()).slice(0, requestedLimit);
    }
  }

  async reindexSemantic(limit?: number): Promise<MemoryIndexResult> {
    if (this.semantic) return this.semantic.backfill(limit);
    return { indexed: 0, current: 0, skipped: 0, failed: 0, pending: this.stats().active,
      issue: { kind: "runtime", detail: "当前记忆服务未启用语义检索" } };
  }

  /** Compatibility facade for Gateway callers; selection is owned by Context Projection. */
  resolveContext(input: MemorySearchRequest & { budgetChars?: number; trackRecall?: boolean }): ResolvedMemoryContext {
    return projectMemoryContext(this, input);
  }

  noteContextRecall(ids: string[]): void {
    if (ids.length) this.repository.markRecalled(ids);
  }
  async extractAndStore(input: MemoryExtractionInput): Promise<MemoryExtractionResult> {
    const empty = (): MemoryExtractionResult => ({
      globalChanged: false, spaceChanged: false, projectChanged: false, taskChanged: false,
      extractedCount: 0, committedCount: 0, reviewCount: 0,
    });
    if (!input.isEnabled()) return empty();
    const botSource = botMemorySource(this.db, input.taskId);
    if (botSource?.peer) return empty();
    if (/^(?:bot-conversation-|bot-peer-)/.test(input.taskId) && (!botSource || botSource.status !== "active")) return empty();
    const rawTurns = botSource ? (input.sourceTurns ?? []).map((turn): MemoryTurnDto | undefined => {
      if (botPeerMemoryInput(this.db, turn.userMessageId)) return undefined;
      const row = this.db.connection.prepare(`SELECT u.text,u.created_at,u.rowid AS source_ordinal FROM bot_send_receipts r
        JOIN bot_messages u ON u.message_id=r.user_message_id AND u.role='user' AND u.status='completed'
        JOIN bot_messages a ON a.message_id=r.assistant_message_id AND a.role='assistant' AND a.status='completed'
        WHERE r.user_id=? AND r.bot_id=? AND r.conversation_id=? AND r.user_message_id=? AND r.assistant_message_id=?
          AND u.conversation_id=r.conversation_id AND a.conversation_id=r.conversation_id
          AND u.bot_id=r.bot_id AND a.bot_id=r.bot_id AND u.request_id=r.request_id AND a.request_id=r.request_id`)
        .get(botSource.user_id, String(turn.metadata.botId ?? botSource.bot_id), input.taskId, turn.userMessageId ?? null, turn.assistantMessageId ?? null) as { text: string; created_at: number; source_ordinal: number } | undefined;
      return row && botMemoryTextEligible(row.text) ? { ...turn, capturedAt: row.created_at, metadata: { ...turn.metadata, sourceUserOrdinal: row.source_ordinal }, userText: row.text, assistantText: "" } : undefined;
    }).filter((turn): turn is MemoryTurnDto => Boolean(turn)) : input.sourceTurns;
    const userText = botSource ? rawTurns?.at(-1)?.userText ?? "" : input.userText.trim();
    if (botSource && !rawTurns?.length) return empty();
    // A short acknowledgement can close a batch containing earlier substantive turns.
    // Eligibility belongs to the captured batch, not the most recent input alone.
    if (!input.sourceTurns?.length && !userText) return empty();
    const extractionScopeStamp = this.recallScopeStamp({ taskId: input.taskId });
    const assertExtractionScope = () => {
      if (this.recallScopeStamp({ taskId: input.taskId }) !== extractionScopeStamp) {
        throw new Error("Memory extraction scope changed: 任务绑定范围已改变，本次候选未写入");
      }
    };
    const task = this.db.getTask(input.taskId);
    const projectId = task?.projectId ?? undefined;
    const workspaceId = input.spaceId ?? task?.spaceId ?? undefined;
    const existingQuery = (rawTurns?.map(turn => turn.userText).join("\n") || userText).slice(-2000);
    const existing = await this.searchHybrid({ taskId: input.taskId, projectId, workspaceId, query: existingQuery, limit: 40 });
    assertExtractionScope();
    const sourceFilter = this.forgetWatermarks.sourceFilter(this.resolveScopeChain({ taskId: input.taskId }));
    const sourceTurns = (rawTurns?.length ? rawTurns : [{
      id: `legacy:${input.taskId}:${Date.now()}`,
      taskId: input.taskId,
      userText,
      assistantText: input.assistantText,
      contentHash: "",
      capturedAt: Date.now(),
      extractionState: "processing" as const,
      attemptCount: 0,
      metadata: {},
    }]).slice(-8).map(turn => ({ ...turn, ...sourceFilter(turn.userText, turn.assistantText, turn.capturedAt, turn.userMessageId) }))
      .filter(turn => turn.userText.trim() || turn.assistantText.trim());
    if (!sourceTurns.length) return empty();
    let executionBudget = 24_000;
    const executionTurns = sourceTurns.slice().reverse().flatMap((turn) => {
      const execution = procedureExecution(turn.metadata);
      if (!execution) return [];
      const tools: typeof execution.tools = [];
      let used = 0;
      for (const tool of execution.tools.slice().reverse()) {
        const bytes = JSON.stringify(tool).length;
        if (used + bytes > executionBudget) continue;
        tools.unshift(tool);
        used += bytes;
      }
      if (tools.length < 2) return [];
      executionBudget -= used;
      return [{ id: turn.id, tools }];
    }).reverse();
    const payload = {
      task: { id: input.taskId, projectId: projectId ?? null, workspaceId: workspaceId ?? null },
      existingMemories: existing.map((x) => ({ id: x.memory.id, kind: x.memory.kind, title: x.memory.title, content: x.memory.content, status: x.memory.status, scopes: x.memory.scopes })),
      conversationTurns: sourceTurns.map((turn) => ({
        id: turn.id,
        user: turn.userText.trim().slice(-MAX_INPUT_CHARS),
        // Assistant output may echo a request-only capsule. For the manual skills pass
        // it provides context only. Candidate evidence still requires a user quote or a verified tool.
        ...(input.skillBatch && !botSource && !isSensitive(turn.assistantText)
          ? { assistantContext: turn.assistantText.trim().slice(-2400) } : {}),
        capturedAt: turn.capturedAt,
      })),
      executionTurns,
    };
    if (!input.isEnabled()) return empty();
    const response = await input.modelRuntime.completeSimple(
      input.model,
      { systemPrompt: EXTRACTION_SYSTEM_PROMPT + (botSource ? "\n当前来源是用户与 Bot 或团队的直接对话。只提取有用户原话支持的身份、偏好、事实、决定或约束。稳定身份与偏好保存到当前Bot或团队专属范围，不读写成员私有记忆。任务要求、一次性约束、执行决定和局部事实必须与长期偏好分成不同候选；候选不要自行指定Work身份，宿主根据该候选原话所属的实际用户消息关联Work，无法唯一关联则限本对话。用户明确要求所有Bot共享时scopeType=global；明确仅本次对话时scopeType=conversation、retention=temporary；否则稳定信息retention=stable。一次性查询与任务本身、敏感细节和权限授予不得成为记忆。scope最终由宿主根据原话决定。每条候选 JSON 必须显式包含 retention（稳定事实为 \"stable\"，仅本会话为 \"temporary\"）和 sensitivity（非敏感为 \"none\"）；不得省略这两个字段。敏感内容不输出候选。不要把用户要求本轮直接回答或不调用工具误当作禁止后台提炼；只有明确不保存、不要记住或仅本会话等要求才限制记忆。userEvidence仅引用支持事实的最短原话。不重复输出已保存的相同事实。" : "") + (input.skillBatch ? "\n" + SKILL_DISTILLATION_PROMPT : ""), messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }] },
      // Reasoning shares the response ceiling on Responses-compatible providers.
      // Leave room for both low-effort reasoning and the complete candidate JSON.
      { maxTokens: Math.min(input.model.maxTokens || 8192, input.model.reasoning ? 8192 : 4096), reasoning: "low", cacheRetention: "none", ...(input.skillBatch && { signal: input.skillBatch.signal }) },
    );
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "Memory extraction failed");
    if (response.stopReason === "length") throw new Error("记忆提炼输出被截断，请重试或减少本批对话");
    if (!input.isEnabled()) return empty();
    assertExtractionScope();
    const extracted = extractCandidates(responseText(response));
    const applyCandidates = (): MemoryExtractionResult => {
      const changed = new Set<MemoryScopeType>();
      let committedCount = 0;
      let reviewCount = 0;
      let createdSkills = 0;
      for (const candidate of extracted) {
        if (!input.isEnabled()) break;
        if (input.skillBatch && (candidate.kind !== "procedure" || candidate.operationHint !== "create")) continue;
        assertExtractionScope();
        const { supportingTurns, durableEvidence, localFact, sourceWork, temporary, publicShared, rejected } =
          botExtractionPolicy(this.db, input.taskId, candidate, sourceTurns, botSource);
        if (rejected) continue;
        const scope = botSource && localFact && !temporary
          ? sourceWork ? { scopeType: "work" as const, scopeId: sourceWork } : { scopeType: "conversation" as const, scopeId: input.taskId }
          : publicShared ? { scopeType: "global" as const, scopeId: undefined }
          : this.normalizeCandidateScope(botSource ? temporary ? "conversation" : "bot" : candidate.scopeType, { projectId, workspaceId, taskId: input.taskId });
        if (!scope) continue;
        const availableTurns = botSource ? supportingTurns : sourceTurns;
        const evidenceSources = input.skillBatch ? availableTurns.filter(turn => candidate.executionEvidence
          ? turn.id === candidate.executionEvidence.turnId
          : Boolean(candidate.userEvidence && turn.userText.includes(candidate.userEvidence))) : availableTurns;
        const eligibleTurns = this.forgetWatermarks.candidateSources(scope.scopeType, scope.scopeId, evidenceSources,
          `${candidate.title}\n${candidate.content}\n${candidate.userEvidence ?? ""}`);
        if (!eligibleTurns.length) continue;
        const dto: MemoryCandidateDto = {
          id: `mcand_${randomUUID()}`,
          taskId: input.taskId,
          kind: candidate.kind,
          title: candidate.title,
          content: candidate.content,
          scopeType: scope.scopeType,
          scopeId: scope.scopeId,
          confidence: candidate.executionEvidence ? Math.min(0.9, candidate.confidence) : candidate.explicit ? Math.max(0.98, candidate.confidence) : candidate.confidence,
          importance: candidate.importance,
          explicit: candidate.executionEvidence ? false : botSource ? durableEvidence || publicShared : candidate.explicit,
          operationHint: candidate.operationHint,
          replaces: candidate.replaces,
          status: "pending",
          rawJson: JSON.stringify({ ...candidate, publicShared, sourceTurnIds: (input.skillBatch ? eligibleTurns : sourceTurns).map((turn) => turn.id) }),
          createdAt: Date.now(),
        };
        // A single bad candidate (e.g. scope deleted between capture and extraction) must not
        // fail the whole batch: ordinary candidates remain reviewable; Bot candidates are rejected.
        try {
          const apply = () => {
            this.repository.insertCandidate(dto);
            // An in-flight pending candidate may already have been resolved from the review UI.
            if (this.repository.getCandidate(dto.id)?.status !== "pending") return;
            const freshTurns = this.forgetWatermarks.candidateSources(scope.scopeType, scope.scopeId, eligibleTurns,
              `${candidate.title}\n${candidate.content}\n${candidate.userEvidence ?? ""}`);
            if (!freshTurns.length) { this.repository.resolveCandidate(dto.id, "rejected"); return; }
            const evidenceTurns = botSource ? freshTurns
              .map(turn => ({ ...turn, userText: candidate.userEvidence!, assistantText: "" })) : freshTurns;
            const result = this.reconcileCandidate(dto, evidenceTurns);
            if (input.skillBatch && result.memoryId) createdSkills += this.learning.refreshMemory(result.memoryId).created;
            if (result.status === "committed") {
              committedCount++;
              changed.add(scope.scopeType);
            } else if (result.status === "needs_review") {
              if (botSource) this.repository.resolveCandidate(dto.id, "rejected");
              else reviewCount++;
            }
          };
          // A crash must not expose this automatic Bot path as pending/needs_review.
          // Keep source validation, reconciliation and rejection in one commit.
          if (botSource) this.db.connection.transaction(apply)();
          else apply();
        } catch (error) {
          if (input.skillBatch) throw error;
          console.warn("[MemoryKernel] candidate reconcile failed", error);
          try { this.repository.resolveCandidate(dto.id, botSource ? "rejected" : "needs_review"); } catch { /* candidate row may not exist */ }
          if (!botSource) reviewCount++;
        }
      }
      if (input.skillBatch) {
        // The model may correctly return no new method because an earlier L1 pass
        // already saved it. Include those grounded procedures in this same review queue.
        const ids = sourceTurns.map(turn => turn.id);
        const linked = this.db.connection.prepare(`SELECT DISTINCT m.id FROM memory_records m
          JOIN memory_evidence e ON e.memory_id=m.id
          WHERE m.kind='procedure' AND m.status='active' AND e.evidence_kind='conversation'
            AND e.ref_id IN (${ids.map(() => "?").join(",")})`).all(...ids) as Array<{ id: string }>;
        for (const row of linked) {
          if (this.canAccess(row.id, { taskId: input.taskId, includeInherited: true })) {
            createdSkills += this.learning.refreshMemory(row.id).created;
          }
        }
        input.skillBatch.complete(createdSkills);
      } else if (input.isEnabled()) this.learning.refresh();
      return {
        globalChanged: changed.has("global"),
        spaceChanged: changed.has("workspace"),
        projectChanged: changed.has("project"),
        taskChanged: changed.has("task"),
        extractedCount: extracted.length,
        committedCount,
        reviewCount,
      };
    };
    return input.skillBatch ? this.db.connection.transaction(applyCandidates)() : applyCandidates();
  }

  /**
   * User decision on a needs_review/stale-pending candidate. Approve re-runs reconcile in force mode:
   * confidence/overlap gates are bypassed, but physically impossible operations still fail.
   */
  resolveCandidateReview(id: string, decision: "approve" | "reject"): { status: "committed" | "rejected" | "needs_review"; memoryId?: string } {
    const candidate = this.repository.getCandidate(id);
    if (!candidate) throw new Error(`候选不存在：${id}`);
    if (candidate.status !== "needs_review" && candidate.status !== "pending") {
      throw new Error(`候选已被处置：${candidate.status}`);
    }
    if (decision === "reject") {
      this.repository.resolveCandidate(id, "rejected");
      return { status: "rejected" };
    }
    const sourceTurns = this.candidateSourceTurns(candidate);
    const result = this.reconcileCandidate(candidate, sourceTurns, true);
    if (candidate.kind === "procedure" && result.status === "committed") this.learning.refresh();
    return result;
  }

  private candidateSourceTurns(candidate: MemoryCandidateDto): MemoryTurnDto[] {
    try {
      const raw = candidate.rawJson ? JSON.parse(candidate.rawJson) as { sourceTurnIds?: unknown } : {};
      const ids = Array.isArray(raw.sourceTurnIds) ? raw.sourceTurnIds.filter((x): x is string => typeof x === "string") : [];
      const turns = new MemoryTurnRepository(this.db);
      return ids.map((id) => turns.get(id)).filter((turn): turn is MemoryTurnDto => Boolean(turn));
    } catch {
      return [];
    }
  }

  private reconcileCandidate(candidate: MemoryCandidateDto, sourceTurns: readonly MemoryTurnDto[] = [], force = false): { status: "committed" | "rejected" | "needs_review"; memoryId?: string } {
    // Scope checks and all mutations share one SQLite snapshot, including promoted atoms.
    return this.db.connection.transaction(() => this.reconcileCandidateInTransaction(candidate, sourceTurns, force))();
  }

  private reconcileCandidateInTransaction(candidate: MemoryCandidateDto, sourceTurns: readonly MemoryTurnDto[], force: boolean): { status: "committed" | "rejected" | "needs_review"; memoryId?: string } {
    const eligible = this.forgetWatermarks.reviewSources(candidate, sourceTurns);
    if (!eligible) {
      this.repository.resolveCandidate(candidate.id, "rejected");
      return { status: "rejected" };
    }
    sourceTurns = eligible;
    if (!force) {
      let execution: ExtractedCandidate["executionEvidence"];
      try { execution = JSON.parse(candidate.rawJson ?? "{}").executionEvidence; } catch { /* use user evidence below */ }
      if (execution) {
        const turn = sourceTurns.find((item) => item.id === execution?.turnId);
        const tool = turn && procedureExecution(turn.metadata)?.tools.find((item) => item.toolCallId === execution?.toolCallId);
        if (candidate.kind !== "procedure" || candidate.operationHint !== "create" || !tool
          || typeof execution.quote !== "string" || execution.quote.trim().length < 8 || !tool.result.includes(execution.quote)) {
          this.repository.resolveCandidate(candidate.id, "needs_review");
          return { status: "needs_review" };
        }
      } else {
        let quote = "";
        try { quote = String(JSON.parse(candidate.rawJson ?? "{}").userEvidence ?? "").trim(); } catch { /* require review */ }
        if (quote.length < 2 || !sourceTurns.some((turn) => turn.userText.includes(quote))) {
          this.repository.resolveCandidate(candidate.id, "needs_review");
          return { status: "needs_review" };
        }
      }
    }
    const botSource = botMemorySource(this.db, candidate.taskId);
    let publicShared = false;
    try { publicShared = Boolean(botSource) && JSON.parse(candidate.rawJson ?? "{}").publicShared === true; } catch { /* legacy candidate */ }
    const inCandidateScope = (scope: { scopeType: MemoryScopeType; scopeId?: string }) => scope.scopeType === candidate.scopeType && scope.scopeId === candidate.scopeId;
    const deferSharedMutation = (record: MemoryRecordDto): boolean => {
      if (force || (botSource && record.scopes.some(inCandidateScope)
        && (candidate.scopeType !== "global" || publicShared && record.metadata.publicShared === true))
        || this.canMutateFromTask(candidate.taskId, record)) return false;
      this.repository.resolveCandidate(candidate.id, "needs_review");
      return true;
    };
    const matches = this.repository.listScopeRecords(candidate.scopeType, candidate.scopeId)
      .filter(record => force || !this.isCapturedSnapshot(record.id))
      .filter(record => !botSource || candidate.scopeType !== "global" || publicShared && record.metadata.publicShared === true);
    const targetText = candidate.replaces || candidate.title;
    const best = matches
      .map((m) => ({ m, score: Math.max(tokenSimilarity(targetText, m.title), tokenSimilarity(targetText, m.content), tokenSimilarity(candidate.title, m.title)) }))
      .sort((a, b) => b.score - a.score)[0];
    const comparableContent = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
    const duplicate = matches.find((m) => hashContent(candidate.kind, candidate.title, candidate.content) === m.contentHash
      || (candidate.content.trim() && m.kind === candidate.kind && comparableContent(candidate.content) === comparableContent(m.content)))
      ?? (best && best.score >= 0.95 && tokenSimilarity(candidate.content, best.m.content) >= 0.92 ? best.m : undefined);
    if (candidate.operationHint === "forget") {
      const forgetThreshold = force ? 0.4 : 0.55;
      if ((!candidate.explicit && !force) || !best || best.score < forgetThreshold) {
        if (force) throw new Error("找不到足够相似的现有记忆可删除，请先在列表中手动删除");
        this.repository.resolveCandidate(candidate.id, "needs_review");
        return { status: "needs_review" };
      }
      if (deferSharedMutation(best.m)) return { status: "needs_review" };
      this.forget(best.m.id);
      this.repository.resolveCandidate(candidate.id, "committed");
      return { status: "committed" };
    }
    if (duplicate) {
      if (deferSharedMutation(duplicate)) return { status: "needs_review" };
      this.addConversationEvidence(duplicate.id, sourceTurns);
      this.repository.resolveCandidate(candidate.id, "rejected", duplicate.id);
      return { status: "rejected", memoryId: duplicate.id };
    }
    if (!force && !candidate.explicit && candidate.confidence < 0.68) {
      this.repository.resolveCandidate(candidate.id, "needs_review");
      return { status: "needs_review" };
    }
    const createReq: MemoryCreateRequest = {
      kind: candidate.kind,
      title: candidate.title,
      content: candidate.content,
      importance: candidate.importance,
      confidence: candidate.confidence,
      explicit: candidate.explicit,
      sourceType: candidate.explicit ? "user" : "agent",
      sourceTaskId: botMemorySource(this.db, candidate.taskId) ? undefined : candidate.taskId,
      sourceId: botMemorySource(this.db, candidate.taskId) ? candidate.taskId : undefined,
      scopeType: candidate.scopeType,
      scopeId: candidate.scopeId,
      metadata: botSource ? { ...(publicShared ? { publicShared: true } : {}), botAutomaticScopePolicy: "source-work-v1",
        sourceUserMessageIds: [...new Set(sourceTurns.flatMap(turn => turn.userMessageId ? [turn.userMessageId] : []))] }
        : publicShared ? { publicShared: true } : undefined,
      evidence: [
        { evidenceKind: botMemorySource(this.db, candidate.taskId) ? "conversation" : "task", refId: candidate.taskId },
        ...sourceTurns.map((turn) => ({ evidenceKind: "conversation" as const, refId: turn.id, refTitle: "L0 conversation turn", excerpt: this.l0EvidenceExcerpt(turn) })),
      ],
    };
    try {
      const execution = JSON.parse(candidate.rawJson ?? "{}").executionEvidence as ExtractedCandidate["executionEvidence"];
      const turn = execution && sourceTurns.find((item) => item.id === execution.turnId);
      const tool = turn && procedureExecution(turn.metadata)?.tools.find((item) => item.toolCallId === execution?.toolCallId);
      if (candidate.kind === "procedure" && tool) createReq.evidence!.push({ evidenceKind: "agent_run", refId: tool.toolCallId,
        refTitle: `成功工具检查：${tool.name}`, excerpt: `${tool.name}\n${tool.arguments}\n${tool.result}`.slice(0, 2400) });
    } catch { /* User-approved candidates may have legacy provenance. */ }
    if (botSource && best && best.m.scopes.some(scope => !inCandidateScope(scope))
      && ((candidate.operationHint === "update" && best.score >= 0.52)
        || (candidate.operationHint === "supersede" && best.score >= 0.45))) {
      if (deferSharedMutation(best.m)) return { status: "needs_review" };
      this.detachScope(best.m.id, candidate.scopeType, candidate.scopeId);
      const created = this.create(createReq);
      this.repository.resolveCandidate(candidate.id, "committed", created.id);
      return { status: "committed", memoryId: created.id };
    }
    if (candidate.operationHint === "resolve" && best && best.score >= 0.5) {
      if (deferSharedMutation(best.m)) return { status: "needs_review" };
      const resolved = this.resolve(best.m.id, candidate.explicit ? "user" : "agent");
      this.addConversationEvidence(resolved.id, sourceTurns);
      this.repository.resolveCandidate(candidate.id, "committed", resolved.id);
      return { status: "committed", memoryId: resolved.id };
    }
    if (candidate.operationHint === "update" && best && best.score >= 0.52) {
      if (deferSharedMutation(best.m)) return { status: "needs_review" };
      const updated = this.update({
        id: best.m.id,
        kind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
        importance: Math.max(best.m.importance, candidate.importance),
        confidence: Math.max(best.m.confidence, candidate.confidence),
        explicit: best.m.explicit || candidate.explicit,
        changedBy: candidate.explicit ? "user" : "agent",
        changeReason: `candidate:${candidate.id}`,
      });
      this.addConversationEvidence(updated.id, sourceTurns);
      this.repository.resolveCandidate(candidate.id, "committed", updated.id);
      return { status: "committed", memoryId: updated.id };
    }
    if (candidate.operationHint === "supersede" && best && best.score >= 0.45) {
      if (deferSharedMutation(best.m)) return { status: "needs_review" };
      const created = this.supersede(best.m.id, createReq);
      this.repository.resolveCandidate(candidate.id, "committed", created.id);
      return { status: "committed", memoryId: created.id };
    }
    // If a candidate strongly overlaps an active memory but asks to create a materially different fact,
    // do not silently keep both active: require review unless it is an explicit user statement.
    if (!force && best && best.score >= 0.72 && !candidate.explicit) {
      this.repository.resolveCandidate(candidate.id, "needs_review");
      return { status: "needs_review" };
    }
    const created = this.create(createReq);
    this.repository.resolveCandidate(candidate.id, "committed", created.id);
    return { status: "committed", memoryId: created.id };
  }

  private l0EvidenceExcerpt(turn: MemoryTurnDto): string {
    return cleanMultilineText(`用户：${turn.userText}\n助手：${turn.assistantText}`, 1200);
  }

  private addConversationEvidence(memoryId: string, sourceTurns: readonly MemoryTurnDto[]): void {
    for (const turn of sourceTurns) {
      this.repository.addEvidence({
        id: `mev_${randomUUID()}`,
        memoryId,
        evidenceKind: "conversation",
        refId: turn.id,
        refTitle: "L0 conversation turn",
        excerpt: this.l0EvidenceExcerpt(turn),
        createdAt: turn.capturedAt,
      });
    }
  }

  private isCapturedSnapshot(id: string): boolean {
    return Boolean(this.db.connection.prepare("SELECT 1 FROM memory_capture_receipts WHERE memory_id=? AND suppressed=0").get(id));
  }
  private canMutateFromTask(taskId: string, memory: MemoryRecordDto): boolean {
    if (this.isCapturedSnapshot(memory.id)) return false;
    const work = this.workMemoryScope(taskId);
    const conversation = botMemorySource(this.db, taskId);
    const botId = work || conversation?.team_id || conversation?.shared ? undefined : this.channelBotId(taskId);
    if (!work && !botId && !conversation) return true;
    // A retained local scope does not grant permission to rewrite the same atom
    // after it has been promoted to shared/project/global memory.
    return memory.scopes.length > 0 && memory.scopes.every(scope =>
      (scope.scopeType === "task" && scope.scopeId === taskId)
      || (work && scope.scopeType === "work" && scope.scopeId === work.work_id)
      || (work && !work.shared && memory.scopes.length === 1 && memory.sourceType === "agent" && Boolean(memory.sourceTaskId)
        && this.workMemoryScope(memory.sourceTaskId!)?.work_id === work.work_id
        && scope.scopeType === "project" && Boolean(work.project_id) && scope.scopeId === work.project_id)
      || (!work && scope.scopeType === "bot" && scope.scopeId === botId)
      || (conversation && scope.scopeType === "conversation" && scope.scopeId === taskId)
      || (conversation?.team_id && scope.scopeType === "team" && scope.scopeId === conversation.team_id));
  }

  private assertTaskMemoryWritable(taskId: string, id: string): void {
    const memory = this.repository.get(id);
    if (!memory || !this.canAccess(id, { taskId: taskId === "transient" ? undefined : taskId, includeInherited: true })) {
      throw new Error("记忆不存在或不属于当前任务可见作用域");
    }
    if (!this.canMutateFromTask(taskId, memory)) {
      throw new Error("当前 Bot / Work 执行者不能改写共享事实或其他身份的记忆，请修改原属范围或仅移除当前绑定");
    }
  }

  private channelBotId(taskId: string): string | undefined {
    const row = this.db.connection.prepare(`SELECT bot_id FROM bot_channel_bindings
      WHERE channel_type='desktop' AND channel_identifier=?`).get(JSON.stringify([LOCAL_USER_ID, taskId])) as { bot_id: string } | undefined;
    return row?.bot_id ?? botMemorySource(this.db, taskId)?.bot_id;
  }

  private workMemoryScope(taskId: string) { return resolveWorkMemoryScope(this.db, taskId); }

  private visibleInChain(memory: MemoryRecordDto, chain: Array<{ scopeType: MemoryScopeType; scopeId?: string }>, request: MemorySearchRequest): boolean {
    const legacyBoundary = botMemoryAutomaticBoundary(this.db, memory);
    if (legacyBoundary) return chain.some(scope => scope.scopeType === legacyBoundary.scopeType && scope.scopeId === legacyBoundary.scopeId);
    const assistantContext = Boolean(request.botId || request.teamId || request.conversationId || request.workId
      || (request.taskId && (this.workMemoryScope(request.taskId) || this.channelBotId(request.taskId))));
    return memory.scopes.some(scope => chain.some(c => c.scopeType === scope.scopeType && (c.scopeId ?? "") === (scope.scopeId ?? ""))
      && (scope.scopeType !== "global" || !assistantContext || memory.metadata.publicShared === true));
  }

  /** Stable private preferences are automatic only in personal Bot contexts.
   * Team executors keep their existing explicit retrieval behavior, not a new private baseline.
   */
  allowsPersonalBotBaseline(request: MemorySearchRequest): boolean {
    if (!this.resolveScopeChain(request).some(scope => scope.scopeType === "bot")) return false;
    if (!request.taskId) return true;
    const hasTeams = this.db.connection.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_teams'").get();
    if (hasTeams && this.db.connection.prepare(`SELECT 1 FROM work_execution_bindings b
      JOIN work_teams t ON t.work_id=b.work_id WHERE b.task_id=? LIMIT 1`).get(request.taskId)) return false;
    return !this.db.connection.prepare("SELECT 1 FROM bot_conversations WHERE conversation_id=? AND team_id IS NOT NULL").get(request.taskId);
  }

  resolveScopeChain(request: MemorySearchRequest) {
    return resolveAssistantScopeChain(this.db, request, taskId => this.channelBotId(taskId));
  }

  bestMatchedScope(memory: MemoryRecordDto, chain: Array<{ scopeType: MemoryScopeType; scopeId?: string; distance: number }>) {
    return [...memory.scopes]
      .map((scope) => ({ scope, chain: chain.find((c) => c.scopeType === scope.scopeType && (c.scopeId ?? "") === (scope.scopeId ?? "")) }))
      .filter((x) => x.chain)
      .sort((a, b) => a.chain!.distance - b.chain!.distance)[0]?.scope
      ?? memory.scopes[0]
      ?? { memoryId: memory.id, scopeType: "global" as const, binding: "owned" as const, createdAt: memory.createdAt };
  }

  private normalizeCandidateScope(scopeType: MemoryScopeType, ctx: { projectId?: string; workspaceId?: string; taskId: string }): { scopeType: MemoryScopeType; scopeId?: string } | null {
    const conversation = botMemorySource(this.db, ctx.taskId);
    if (conversation) return scopeType === "conversation" || conversation.shared ? { scopeType: "conversation", scopeId: ctx.taskId }
      : { scopeType: conversation.team_id ? "team" : "bot", scopeId: conversation.team_id ?? conversation.bot_id };
    const work = this.workMemoryScope(ctx.taskId);
    if (work) return !work.shared && scopeType === "project" && work.project_id ? { scopeType: "project", scopeId: work.project_id }
      : { scopeType: "work", scopeId: work.work_id };
    if (this.channelBotId(ctx.taskId)) return { scopeType: "task", scopeId: ctx.taskId };
    if (scopeType === "global") return { scopeType: "global" };
    if (scopeType === "project") {
      if (ctx.projectId) return { scopeType: "project", scopeId: ctx.projectId };
      if (ctx.workspaceId) return { scopeType: "workspace", scopeId: ctx.workspaceId };
      return { scopeType: "task", scopeId: ctx.taskId };
    }
    // Workspace scope is only for tasks without a project binding; project-bound knowledge stays visible on the project page.
    if (scopeType === "workspace") {
      if (ctx.projectId) return { scopeType: "project", scopeId: ctx.projectId };
      return ctx.workspaceId ? { scopeType, scopeId: ctx.workspaceId } : { scopeType: "task", scopeId: ctx.taskId };
    }
    return { scopeType: "task", scopeId: ctx.taskId };
  }

  private queueSemanticIndex(record: MemoryRecordDto): void {
    if (!this.semantic) return;
    void this.semantic.index(record).catch((error) => {
      if (!(error instanceof SemanticUnavailableError)) console.warn("[MemoryKernel] semantic index failed", error);
    });
  }

  private assertScope(scopeType: MemoryScopeType, scopeId?: string): void {
    if (scopeType === "global") {
      if (scopeId) throw new Error("global 记忆不能携带 scopeId");
      return;
    }
    if (!scopeId?.trim()) throw new Error(`${scopeType} 记忆必须携带 scopeId`);
    if (scopeType === "bot" && !this.db.connection.prepare("SELECT 1 FROM bots WHERE bot_id=?").get(scopeId)) throw new Error("Bot 不存在");
    if (scopeType === "conversation" && !botMemorySource(this.db, scopeId)) throw new Error("对话不存在");
    if (scopeType === "work" && !this.db.connection.prepare("SELECT 1 FROM works WHERE work_id=? AND user_id=?").get(scopeId, LOCAL_USER_ID)) throw new Error("Work 不存在");
    if (scopeType === "team" && !this.db.connection.prepare("SELECT 1 FROM work_team_templates WHERE template_id=? AND user_id=?").get(scopeId, LOCAL_USER_ID)) throw new Error("团队不存在");
    if (scopeType === "workspace" && !this.db.getSpace(scopeId)) throw new Error(`工作空间不存在：${scopeId}`);
    if (scopeType === "task" && !this.db.getTask(scopeId)) throw new Error(`任务不存在：${scopeId}`);
    if (scopeType === "project") {
      const row = this.db.connection.prepare("SELECT archived FROM projects WHERE id=?").get(scopeId) as { archived: number } | undefined;
      if (!row) throw new Error(`项目不存在：${scopeId}`);
      if (row.archived) throw new Error("项目已归档（只读），不能写入项目记忆");
    }
  }

  private assertRecordWritable(record: MemoryRecordDto): void {
    const projectIds = record.scopes
      .filter((scope) => scope.scopeType === "project" && scope.scopeId)
      .map((scope) => scope.scopeId!);
    if (projectIds.length === 0) return;
    const archived = this.db.connection
      .prepare(`SELECT id FROM projects WHERE archived=1 AND id IN (${projectIds.map(() => "?").join(",")}) LIMIT 1`)
      .get(...projectIds) as { id: string } | undefined;
    if (archived) throw new Error("项目已归档（只读），不能修改其关联记忆");
  }
}
