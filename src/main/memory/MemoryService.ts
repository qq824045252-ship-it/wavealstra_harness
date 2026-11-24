import { DOTS_TASK_ID } from "../../shared/dots";
import { dotsRecordApplicability, dotsScopeCondition, dotsSourcePointer, dotsSubject, groundDotsClaim, matchesDotsApplicability,
  isDotsSingleUse, matchesDotsQuote, sameDotsApplicability, type DotsRevisionSource, type DotsSourceInput } from "./DotsRevisionSource";
import { dotsQuestionTerms, rankDotsEvidence } from "./DotsRecallRanking";
import { memorySearchWhere } from "./MemorySearchScope";
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
import { gatewayDotsMemorySource, hasGatewayDotsMemory } from "../gateway/GatewayDotsBindings";
import { isGatewayConversation } from "../../shared/gateway-task";
import { botMemorySource, botMemoryTextEligible, botMemoryConversationOnly, botMemoryWriteEvidenceAllowed, botMemoryAutomaticBoundary, botPeerMemoryInput } from "./BotMemorySource";
import { projectMemoryContext } from "../agent/MemoryContextProjection";
import { createHash, randomUUID } from "node:crypto";
import type { ObservationSource } from "../../shared/native-improvement";
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
    this.cognition = new MemoryCognitionService(db, (id, revision) => this.getDotsRevisionSource(id, revision));
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

  getDotsRevisionSource(id: string, revision: number): DotsRevisionSource | undefined {
    const ctx = { taskId: DOTS_TASK_ID };
    const row = this.db.connection.prepare("SELECT change_reason,content FROM memory_revisions WHERE memory_id=? AND revision=?")
      .get(id, revision) as { change_reason?: string; content: string } | undefined;
    const ref = dotsSourcePointer(row?.change_reason);
    if (!ref || this.contextSnapshotRevocationReason({ id, revision }, ctx)) return;
    const evidence = this.getForRecall(id, ctx)?.evidence;
    if (!evidence) return;
    const turn = ref.turnId ? this.getTurn(ref.turnId) : undefined;
    if (ref.turnId && (!turn || turn.userMessageId !== ref.messageId || (turn.taskId !== DOTS_TASK_ID
      && !gatewayDotsMemorySource(this.db.connection, turn.taskId, turn.metadata.gatewayOrigin, false)))) return;
    const linked = evidence.find(e => turn ? e.evidenceKind === "conversation" && e.refId === turn.id
      : e.evidenceKind === "message" && e.refId === ref.messageId);
    if (!linked) return;
    const quote = turn ? turn.userText.slice(ref.start, ref.start + ref.length)
      : linked.excerpt && matchesDotsQuote(linked.excerpt, ref.hash) ? linked.excerpt : row?.content;
    if (!quote || !matchesDotsQuote(quote, ref.hash)) return;
    const filter = this.forgetWatermarks.sourceFilter(this.resolveScopeChain(ctx));
    if (filter(quote, "", ref.capturedAt, ref.messageId).userText !== quote) return;
    return { turnId: ref.turnId, messageId: ref.messageId, role: "user", capturedAt: ref.capturedAt, quote, stance: ref.stance,
      applicability: ref.applicability ?? dotsScopeCondition(quote) };
  }

  /** Host-only backing record for a verified Durable incident. The weekly release controls exposure. */
  stageWeeklyObservationMemory(scope: { kind: "task" | "project" | "workspace"; id: string }, observation: ObservationSource): MemoryRecordDto {
    const reference = JSON.stringify([observation.taskId, observation.conversationId, observation.entry]);
    if (!observation.conversationId || !Number.isSafeInteger(observation.entry) || observation.entry < 1
      || !Number.isFinite(observation.at) || observation.at <= 0
      || !this.canPromoteFromTask(observation.taskId, scope.kind, scope.id)) {
      throw new Error("周改进的原生证据或记忆作用域无效");
    }
    const id = "mem_weekly_" + createHash("sha256").update(JSON.stringify([reference, scope.kind, scope.id])).digest("hex");
    const request = { taskId: observation.taskId };
    return this.db.connection.transaction(() => {
      const existing = this.repository.get(id);
      if (existing) {
        const live = this.getWeeklyObservationMemory(id, request);
        if (!live) throw new Error("周改进的原生记忆已撤销或不再可用");
        return live;
      }
      const title = "曾遗漏明确的交付要求";
      const content = "该任务的用户曾指出先前明确的交付要求被遗漏。";
      const filter = this.forgetWatermarks.sourceFilter(this.resolveScopeChain(request));
      if (filter(id, "", observation.at).userText !== id
        || filter(`${title}\n${content}`, "", observation.at).userText !== `${title}\n${content}`) {
        throw new Error("周改进证据已被遗忘");
      }
      const record = this.buildRecord({
        kind: "fact", status: "resolved", title, content,
        scopeType: scope.kind, scopeId: scope.id, sourceType: "event",
        sourceId: reference, sourceTaskId: observation.taskId,
        metadata: { weeklyObservationAt: observation.at },
        evidence: [{ evidenceKind: "message", refId: reference }],
      }, observation.at);
      return this.repository.insert({
        ...record,
        id,
        scopes: record.scopes.map(binding => ({ ...binding, memoryId: id })),
        evidence: record.evidence.map(evidence => ({ ...evidence, memoryId: id })),
      });
    }).immediate();
  }

  getWeeklyObservationMemory(id: string, request: Pick<MemorySearchRequest, "taskId">): MemoryRecordDto | undefined {
    if (!id.startsWith("mem_weekly_") || !request.taskId) return;
    const memory = this.repository.get(id);
    if (!memory || memory.status !== "resolved" || memory.sourceType !== "event" || !memory.sourceTaskId) return;
    if (memory.scopes.length !== 1) return;
    const [scope] = memory.scopes;
    if (!this.canPromoteFromTask(request.taskId, scope.scopeType, scope.scopeId)
      || !this.canPromoteFromTask(memory.sourceTaskId, scope.scopeType, scope.scopeId)) return;
    const at = memory.metadata.weeklyObservationAt;
    if (typeof at !== "number" || !Number.isFinite(at)) return;
    const scopes = this.resolveScopeChain(request);
    const sourceScopes = memory.sourceTaskId === request.taskId ? [] : this.resolveScopeChain({ taskId: memory.sourceTaskId });
    const filter = this.forgetWatermarks.sourceFilter([...scopes, ...sourceScopes]);
    const text = `${memory.title}\n${memory.content}`;
    if (filter(id, "", at).userText !== id || filter(text, "", at).userText !== text) return;
    return this.forgetWatermarks.projectEvidence(memory, scopes);
  }

  /** Model-facing read; raw get stays available to audit and mutation internals. */
  getForRecall(id: string, request: MemorySearchRequest): MemoryRecordDto | undefined {
    const memory = this.repository.get(id);
    if (!memory) return;
    const scopes = this.resolveScopeChain({ ...request, includeInherited: request.includeInherited ?? true });
    if (!this.visibleInChain(memory, scopes, request)) return;
    return this.forgetWatermarks.projectEvidence(memory, scopes);
  }

  currentDelegationSource(taskId: string, id: string, revision: number): MemoryRecordDto | undefined {
    const now = Date.now();
    const record = this.getForRecall(id, { taskId, statuses: ["active"] });
    if (record?.status !== "active" || (record.validFrom !== undefined && record.validFrom > now)
      || (record.validUntil !== undefined && record.validUntil <= now)
      || !this.getForRecall(id, {taskId: DOTS_TASK_ID, statuses: ["active"]})
      || this.history(id)[0]?.revision !== revision) return;
    return record;
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
    if (isGatewayConversation(taskId)) return { scopeType: "task", scopeId: taskId };
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
      excerpt: request.sourceTaskId === DOTS_TASK_ID && e.evidenceKind === "message" ? e.excerpt?.slice(0, 1200) : cleanText(e.excerpt, 1200) || undefined,
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

  private invalidateProjectionScopes(scopes: MemoryRecordDto["scopes"], changedId?: string): void {
    this.cognition.projections.invalidateScopes(scopes.filter(scope => scope.scopeType !== "task"));
    if (scopes.some(scope => scope.scopeType === "task" && scope.scopeId === DOTS_TASK_ID)) {
      if (changedId) this.cognition.projections.invalidateByMemoryIds([changedId]);
      this.cognition.queueDotsViews();
    }
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

  create(request: MemoryCreateRequest, revisionReason?: string): MemoryRecordDto {
    if (request.sourceTaskId && request.sourceType === "agent"
      && (isGatewayConversation(request.sourceTaskId) || this.workMemoryScope(request.sourceTaskId) || this.channelBotId(request.sourceTaskId))
      && !this.canPromoteFromTask(request.sourceTaskId, request.scopeType, request.scopeId)) {
      throw new Error("记忆写入范围不属于当前 Bot、团队、项目或 Work");
    }
    const record = this.buildRecord(request);
    const saved = this.db.connection.transaction(() => {
      const inserted = this.repository.insert(record, revisionReason);
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
  createFromTask(request: MemoryCreateRequest, source?: DotsSourceInput, sourceQuote?: string, applicability?: unknown): MemoryRecordDto {
    if (request.sourceTaskId !== DOTS_TASK_ID) return this.create(request);
    if (!source) throw new Error("缺少本轮用户原话，未写入 Dots 记忆");
    const globalCreate = request.scopeType === "global";
    const bound = groundDotsClaim(request, source, sourceQuote, { declaration: applicability, resolveName: this.resolveDotsScope,
      changeDefault: globalCreate, globalCreate });
    if (!bound) throw new Error("未写入记忆：sourceQuote 须逐字引用本轮支持这条规则的原话；范围声明放在 applicability.evidence");
    if (isDotsSingleUse(bound.quote, source.text)) throw new Error("本次例外只用于当前请求，无需写入长期记忆");
    if (globalCreate && bound.applicability) {
      throw new Error(bound.applicability.kind === "unresolved"
        ? "未写入全局记忆：本轮原话未能确认这条规则的全局适用范围"
        : "未写入全局记忆：本轮原话将这条规则限定在指定项目或工作空间");
    }
    if (globalCreate && (bound.kind !== request.kind || bound.stance !== "statement" && !bound.explicit)) {
      throw new Error("未写入全局记忆：请用本轮用户明确制定的原文作为 content");
    }
    const groundedRequest: MemoryCreateRequest = { ...request, kind: bound.kind, title: bound.title, content: bound.content,
      confidence: bound.confidence, explicit: bound.explicit,
      ...(bound.applicability ? { scopeType: "task", scopeId: DOTS_TASK_ID,
        metadata: { ...request.metadata, dotsApplicability: bound.applicability } } : {}),
      evidence: [{ evidenceKind: "message", refId: source.messageId, excerpt: bound.quote }] };
    const content = cleanMultilineText(bound.content, MEMORY_CONTENT_MAX_CHARS);
    return this.db.connection.transaction(() => {
      const existing = this.repository.listByEvidence("message", source.messageId).find(record =>
        record.sourceTaskId === DOTS_TASK_ID && record.status === "active" && record.content === content
        && record.evidence.some(evidence => evidence.evidenceKind === "message" && evidence.refId === source.messageId && evidence.excerpt === bound.quote)
        && record.scopes.some(scope => scope.scopeType === groundedRequest.scopeType && scope.scopeId === groundedRequest.scopeId)
        && sameDotsApplicability(dotsRecordApplicability(record), bound.applicability));
      return existing ?? this.create(groundedRequest, bound.reason);
    })();
  }

  private resolveDotsScope = (kind: "project" | "workspace", name: string, id?: string, allowTaskId = true): { id?: string; name: string } | undefined => {
    const rows = kind === "project"
      ? this.db.connection.prepare("SELECT id,name FROM projects WHERE archived=0").all() as Array<{ id: string; name: string }>
      : this.db.listSpaces().filter(space => !space.effectiveArchived);
    const canonicalName = (value: string) => value.normalize("NFKC").toLowerCase().trim().replace(/\s+/gu, " ");
    if (id) {
      const direct = rows.find(row => row.id === id);
      const task = !direct && allowTaskId ? this.db.getTask(id) : undefined;
      const boundId = kind === "project" ? task?.projectId : task?.spaceId;
      const match = direct ?? rows.find(row => row.id === boundId);
      if (name && match && canonicalName(match.name) !== name) return;
      return match && { id: match.id, name: canonicalName(match.name) };
    }
    if (!name || /^(?:这(?:个|项|里|里这)?|那(?:个|项)?|该|此|当前|甲方|乙方|客户|this|that|current|the|client|customer)$/iu.test(name)) return;
    const matches = rows.filter(row => canonicalName(row.name) === name);
    return matches.length <= 1 ? { name, id: matches[0]?.id } : undefined;
  };

  dotsExceptionApplies(record: MemoryRecordDto, context: Pick<MemorySearchRequest, "projectId" | "workspaceId" | "query">): boolean {
    const scope = dotsRecordApplicability(record);
    if (!scope || scope.kind === "unresolved") return false;
    const contextId = scope.kind === "project" ? context.projectId : context.workspaceId;
    const current = this.resolveDotsScope(scope.kind, scope.id ? "" : scope.name, scope.id, false);
    if (!current) return false;
    if (contextId) return Boolean(current.id && current.id === contextId);
    const query = context.query ?? "";
    if (current.id && query.split(/[^\p{L}\p{N}_-]+/u).includes(current.id)) return true;
    return Boolean(this.resolveDotsScope(scope.kind, current.name)) && matchesDotsApplicability({ ...scope, name: current.name }, query);
  }

  updateFromTask(taskId: string, request: MemoryUpdateRequest, source?: DotsSourceInput, sourceQuote?: string,
    applicability?: unknown): MemoryRecordDto {
    return this.db.connection.transaction(() => {
      this.assertTaskMemoryWritable(taskId, request.id);
      if (taskId === DOTS_TASK_ID && source) {
        const record = this.repository.get(request.id)!;
        const claim = { kind: request.kind ?? record.kind, title: request.title ?? record.title, content: request.content,
          explicit: request.explicit, confidence: request.confidence };
        const bound = groundDotsClaim(claim, source, sourceQuote, { declaration: applicability, resolveName: this.resolveDotsScope,
          changeDefault: ["preference", "constraint", "identity", "procedure"].includes(record.kind) });
        if (!bound) throw new Error("请在 sourceQuote 中提供本轮用户消息的一段明确原话，以定位这次更新");
        if (isDotsSingleUse(bound.quote, source.text)) throw new Error("本次例外只用于当前请求，长期规则继续适用");
        const changeMeaning = request.title !== undefined || request.content !== undefined;
        const excerpt = bound.quote;
        const newCondition = bound.applicability;
        const priorCondition = dotsRecordApplicability(record);
        if (changeMeaning && priorCondition && !newCondition) throw new Error("更新项目例外时请保留原适用条件");
        if (!changeMeaning && !sameDotsApplicability(newCondition, priorCondition) && newCondition) {
          throw new Error("项目例外不能改变原默认记录的状态");
        }
        if (changeMeaning && newCondition && !sameDotsApplicability(newCondition, priorCondition)) {
          return this.create({ ...this.inferAgentScope(taskId), title: bound.title, content: bound.content,
            kind: bound.kind, explicit: bound.explicit, confidence: bound.confidence, sourceType: "agent", sourceTaskId: taskId,
            metadata: { dotsApplicability: newCondition,
              ...(!priorCondition && newCondition.kind !== "unresolved" && (bound.stance === "statement" || bound.explicit) && bound.kind === record.kind
                ? { dotsOverrides: record.id } : {}) },
            evidence: [{ evidenceKind: "message", refId: source.messageId, excerpt }] }, bound.reason);
        }
        if (changeMeaning && (bound.stance === "reported" || bound.stance === "uncertain"
          || record.kind === "decision" && bound.stance !== "statement")) {
          return this.create({ ...this.inferAgentScope(taskId), title: bound.title, content: bound.content,
            kind: "fact", explicit: false, confidence: bound.confidence, sourceType: "agent", sourceTaskId: taskId,
            evidence: [{ evidenceKind: "message", refId: source.messageId, excerpt }] }, bound.reason);
        }
        this.repository.addEvidence({ id: `mev_${randomUUID()}`, memoryId: request.id, evidenceKind: "message",
          refId: source.messageId, excerpt, createdAt: source.createdAt });
        const title = !request.title && record.title !== record.content.slice(0, 76) ? record.title : bound.title;
        return this.update({ ...request, ...(changeMeaning
          ? { kind: bound.kind, title, content: bound.content, confidence: bound.confidence, explicit: bound.explicit,
            ...(newCondition ? { metadata: { ...record.metadata, dotsApplicability: newCondition } } : {}) } : {}),
          changeReason: bound.reason });
      }
      if (source) this.repository.addEvidence({ id: `mev_${randomUUID()}`, memoryId: request.id, evidenceKind: "message",
        refId: source.messageId, excerpt: source.text.slice(0, 1200), createdAt: source.createdAt });
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
      this.invalidateProjectionScopes(updated.scopes, updated.id);
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

  supersede(oldId: string, request: MemoryCreateRequest, replacementReason?: string): MemoryRecordDto {
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
        replacementReason,
      );
      this.invalidateProjectionScopes([...old.scopes, ...inserted.scopes], old.id);
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
      if (current?.id.startsWith("mem_weekly_")) this.forgetWatermarks.withdraw(current.scopes, [current.id]);
      this.cognition.projections.forgetDotsSource(id);
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

  latestWithdrawalAt(taskId: string): number {
    const lookup = this.db.connection.prepare(`SELECT MAX(stamp) AS stamp FROM (
      SELECT MAX(cutoff_at) AS stamp FROM memory_forget_watermarks WHERE scope_type=@scopeType AND scope_id=@scopeId
      UNION ALL SELECT MAX(cutoff_at) FROM memory_forget_targets WHERE scope_type=@scopeType AND scope_id=@scopeId)`);
    return this.resolveScopeChain({ taskId }).reduce((latest, scope) => {
      const row = lookup.get({ scopeType: scope.scopeType, scopeId: scope.scopeId ?? "" }) as { stamp: number | null };
      return Math.max(latest, row.stamp ?? 0);
    }, 0);
  }

  recordForgetBoundary(scopeType: MemoryScopeType, scopeId: string | undefined, cutoffAt: number, allowedMessageId?: string): void {
    this.assertScope(scopeType, scopeId);
    this.forgetWatermarks.advance([{ scopeType, scopeId }], cutoffAt, allowedMessageId);
    if (scopeType === "global" || (scopeType === "task" && scopeId === DOTS_TASK_ID)) this.cognition.invalidateDotsSources();
  }

  recordForgetIntent(scopeType: MemoryScopeType, scopeId: string | undefined, intent: Extract<MemoryRemovalIntent, { kind: "forget" }>, cutoffAt: number, messageId: string): void {
    this.assertScope(scopeType, scopeId);
    this.forgetWatermarks.recordIntent([{ scopeType, scopeId }], intent, cutoffAt, messageId);
    if (scopeType === "global" || (scopeType === "task" && scopeId === DOTS_TASK_ID)) this.cognition.invalidateDotsSources();
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
      if (current.id.startsWith("mem_weekly_")) this.forgetWatermarks.withdraw([target], [current.id], source?.createdAt, source?.messageId);
      if (scopeType === "task" && scopeId === DOTS_TASK_ID) this.cognition.projections.forgetDotsSource(id);
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
    if (isGatewayConversation(taskId)) return targetScopeType === "task" && targetScopeId === taskId;
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
    const visible = this.recallVisibility(request, scopes);
    const candidates = query ? this.repository.searchScoped(query, scopeQuery, Math.max(Math.min(request.limit ?? 20, 100) * 4, 100),
      visible) : undefined;
    const scoped = candidates?.scoped ?? this.repository.listByScopes({ ...scopeQuery, limit: Math.max((request.limit ?? 20) * 30, 500) });
    const ftsRank = candidates?.ftsRanks ?? new Map<string, number>();
    const dots = request.taskId === DOTS_TASK_ID && dotsQuestionTerms(query).length > 0;
    const hits = rankMemorySearch({ scoped, ftsRank, query, request: dots ? { ...request, limit: 100 } : request, scopes,
      visible })
      .map(hit => ({ ...hit, memory: this.forgetWatermarks.projectEvidence(hit.memory, scopes) }));
    return dots ? this.rankDotsQuery(request, hits) : hits;
  }

  private async searchLexicalAsync(request: MemorySearchRequest): Promise<MemorySearchHit[]> {
    const query = request.query?.trim() ?? "";
    if (!query) return this.search(request);
    const stamp = this.recallScopeStamp(request);
    const scopes = this.resolveScopeChain(request);
    const canRead = this.recallVisibility(request, scopes);
    const candidates = await this.repository.searchScopedAsync(query, { scopes,
      statuses: request.statuses?.length ? request.statuses : ["active"], kinds: request.kinds },
      Math.max(Math.min(request.limit ?? 20, 100) * 4, 100), canRead);
    if (!this.db.connection.open || this.recallScopeStamp(request) !== stamp) return [];
    const dots = request.taskId === DOTS_TASK_ID && dotsQuestionTerms(query).length > 0;
    const hits = await rankMemorySearchAsync({ scoped: candidates.scoped, ftsRank: candidates.ftsRanks, query,
      request: dots ? { ...request, limit: 100 } : request, scopes,
      visible: canRead, current: id => this.repository.get(id) });
    if (!this.db.connection.open || this.recallScopeStamp(request) !== stamp) return [];
    const visible = hits.map(hit => ({ ...hit, memory: this.forgetWatermarks.projectEvidence(hit.memory, scopes) }));
    return dots ? this.rankDotsQuery(request, visible) : visible;
  }

  private rankDotsQuery(request: MemorySearchRequest, hits: MemorySearchHit[]): MemorySearchHit[] {
    const query = request.query?.trim() ?? "";
    const limit = Math.max(1, Math.min(100, request.limit ?? 20));
    if (!hits.length) return [];
    const candidates = new Map(hits.map(hit => [hit.memory.id, hit]));
    const scopes = this.resolveScopeChain(request);
    const where = memorySearchWhere({ scopes, statuses: request.statuses, kinds: request.kinds });
    const neighbors = (before: boolean) => this.db.connection.prepare(`SELECT e.memory_id FROM memory_evidence e
      JOIN memory_records m ON m.id=e.memory_id WHERE e.evidence_kind=? AND e.ref_id=?
        AND e.rowid ${before ? "<" : ">"} (SELECT rowid FROM memory_evidence WHERE id=?) AND ${where.sql}
      ORDER BY e.rowid ${before ? "DESC" : "ASC"} LIMIT 2`);
    const previous = neighbors(true), next = neighbors(false);
    // A reply may say "the second one" while the question names the topic. Use the
    // immediately adjacent records of that same explicit source, never a whole workspace.
    for (const anchor of hits.slice(0, 8)) {
      const link = anchor.memory.evidence.find(ref => ref.evidenceKind === "message" || ref.evidenceKind === "conversation");
      if (!link) continue;
      for (const statement of [previous, next]) {
        const rows = statement.all(link.evidenceKind, link.refId, link.id, ...where.args) as Array<{ memory_id: string }>;
        for (const row of rows) {
          const existing = candidates.get(row.memory_id);
          if (existing) {
            if (!existing.reasons.includes("source-context") && existing.memory.evidence.some(ref =>
              ref.evidenceKind === link.evidenceKind && ref.refId === link.refId)) {
              candidates.set(row.memory_id, { ...existing, reasons: [...existing.reasons, "source-context"] });
            }
            continue;
          }
          const record = this.repository.get(row.memory_id);
          if (!record || !this.visibleInChain(record, scopes, request)) continue;
          const memory = this.forgetWatermarks.projectEvidence(record, scopes);
          if (!memory.evidence.some(ref => ref.evidenceKind === link.evidenceKind && ref.refId === link.refId)) continue;
          const scope = this.bestMatchedScope(memory, scopes);
          const distance = scopes.find(item => item.scopeType === scope.scopeType && item.scopeId === scope.scopeId)?.distance ?? 10;
          candidates.set(memory.id, { memory, score: 0, reasons: ["source-context"], scopeDistance: distance });
        }
      }
    }
    return rankDotsEvidence(query, [...candidates.values()], limit);
  }

  /** A pending external computation must never retain an old task/scope authorization. */
  private recallScopeStamp(request: MemorySearchRequest): string {
    const task = request.taskId ? this.db.getTask(request.taskId) : undefined;
    return JSON.stringify({ task: request.taskId ? {
      exists: Boolean(task), projectId: task?.projectId ?? null,
      workspaceId: task?.spaceId ?? null, archived: task?.archived ?? false,
    } : null, chain: this.resolveScopeChain(request), assistantContext: this.isAssistantMemoryContext(request) });
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
      if (request.taskId === DOTS_TASK_ID && !semantic.length) return lexical.slice(0, requestedLimit);
      const currentScopes = this.resolveScopeChain(request);
      const canRead = this.recallVisibility(request, currentScopes);
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
          || !canRead(memory)) return;
        fused.set(hit.memoryId, { ...fused.get(hit.memoryId), semanticRank: index + 1, memory });
      });
      const RRF_K = 60;
      const ranked = [...fused.values()].map((entry): MemorySearchHit => {
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
      }).sort((a, b) => b.score - a.score || b.memory.updatedAt - a.memory.updatedAt);
      return request.taskId === DOTS_TASK_ID
        ? rankDotsEvidence(query, ranked, requestedLimit, new Map(semantic.map(hit => [hit.memoryId, hit.score])))
        : ranked.slice(0, requestedLimit);
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
    const gatewayPrivate = isGatewayConversation(input.taskId) && hasGatewayDotsMemory(this.db.connection, input.taskId);
    const dotsPersonal = input.taskId === DOTS_TASK_ID && !input.skillBatch;
    const automaticOnly = Boolean(botSource) || input.taskId === DOTS_TASK_ID || gatewayPrivate;
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
      { systemPrompt: EXTRACTION_SYSTEM_PROMPT + (botSource ? "\n当前来源是用户与 Bot 或团队的直接对话。只提取有用户原话支持的身份、偏好、事实、决定或约束。稳定身份与偏好保存到当前Bot或团队专属范围，不读写成员私有记忆。任务要求、一次性约束、执行决定和局部事实必须与长期偏好分成不同候选；候选不要自行指定Work身份，宿主根据该候选原话所属的实际用户消息关联Work，无法唯一关联则限本对话。用户明确要求所有Bot共享时scopeType=global；明确仅本次对话时scopeType=conversation、retention=temporary；否则稳定信息retention=stable。一次性查询与任务本身、敏感细节和权限授予不得成为记忆。scope最终由宿主根据原话决定。每条候选 JSON 必须显式包含 retention（稳定事实为 \"stable\"，仅本会话为 \"temporary\"）和 sensitivity（非敏感为 \"none\"）；不得省略这两个字段。敏感内容不输出候选。不要把用户要求本轮直接回答或不调用工具误当作禁止后台提炼；只有明确不保存、不要记住或仅本会话等要求才限制记忆。userEvidence仅引用支持事实的最短原话。不重复输出已保存的相同事实。" : "") + (dotsPersonal ? "\n当前来源是 Dots 个人对话。长期偏好、身份、决定及带适用条件的例外写入 task。只对本次生效的要求和用户明确不要保存的内容不输出候选。每条候选提供 applicability 对象。kind 选 general（用户明确声明通用默认）、project、workspace 或 unresolved（局部引用的身份不明）。evidence 逐字引用说明本条事实适用范围的原话，相邻句子可引用范围标题。明确指名时保留 name；用户原文有 ID 时保留 id。识别范围要依据语义与指代，不依赖固定句式。多主题分别绑定各自的 userEvidence 和 applicability。项目例外不得改写默认记录。" : "")
        + (gatewayPrivate ? "\n当前是已关联的私人入口。身份、稳定偏好及长期约束须有本轮用户原话，并明确标记 retention（stable 或 temporary）和 sensitivity（none 或 sensitive）。敏感信息不输出候选。" : "")
        + (input.skillBatch ? "\n" + SKILL_DISTILLATION_PROMPT : ""), messages: [{ role: "user", content: JSON.stringify(payload), timestamp: Date.now() }] },
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
        if (rejected || (dotsPersonal && (candidate.operationHint === "forget" || candidate.retention === "temporary"))) continue;
        const privateDotsSource = gatewayPrivate && !input.skillBatch && !candidate.executionEvidence
          && candidate.retention === "stable" && candidate.sensitivity === "none"
          && ["identity", "preference", "constraint"].includes(candidate.kind)
          && candidate.operationHint !== "forget" && candidate.operationHint !== "resolve"
          && supportingTurns.some(turn => botMemoryTextEligible(turn.userText) && !botMemoryConversationOnly(turn.userText)
            && botMemoryWriteEvidenceAllowed(turn.userText, candidate.userEvidence ?? "")
            && gatewayDotsMemorySource(this.db.connection, input.taskId, turn.metadata.gatewayOrigin, true));
        const scope = privateDotsSource || dotsPersonal ? { scopeType: "task" as const, scopeId: DOTS_TASK_ID }
          : botSource && localFact && !temporary
          ? sourceWork ? { scopeType: "work" as const, scopeId: sourceWork } : { scopeType: "conversation" as const, scopeId: input.taskId }
          : publicShared ? { scopeType: "global" as const, scopeId: undefined }
          : this.normalizeCandidateScope(botSource ? temporary ? "conversation" : "bot" : candidate.scopeType, { projectId, workspaceId, taskId: input.taskId });
        if (!scope) continue;
        const availableTurns = automaticOnly && !candidate.executionEvidence ? supportingTurns : sourceTurns;
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
          rawJson: JSON.stringify({ ...candidate, publicShared, sourceTurnIds: (input.skillBatch || automaticOnly ? eligibleTurns : sourceTurns).map((turn) => turn.id) }),
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
              if (automaticOnly) this.repository.resolveCandidate(dto.id, "rejected");
              else reviewCount++;
            }
          };
          // A crash must not expose this automatic Bot path as pending/needs_review.
          // Keep source validation, reconciliation and rejection in one commit.
          if (automaticOnly) this.db.connection.transaction(apply)();
          else apply();
        } catch (error) {
          if (input.skillBatch) throw error;
          console.warn("[MemoryKernel] candidate reconcile failed", error);
          try { this.repository.resolveCandidate(dto.id, automaticOnly ? "rejected" : "needs_review"); } catch { /* candidate row may not exist */ }
          if (!automaticOnly) reviewCount++;
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
    let grounded: ReturnType<typeof groundDotsClaim>;
    const privateDotsSource = isGatewayConversation(candidate.taskId) && candidate.scopeType === "task" && candidate.scopeId === DOTS_TASK_ID;
    if (privateDotsSource && (force || !hasGatewayDotsMemory(this.db.connection, candidate.taskId))) {
      this.repository.resolveCandidate(candidate.id, "rejected");
      return { status: "rejected" };
    }
    if (!force && (candidate.taskId === DOTS_TASK_ID || privateDotsSource)) {
      const raw = JSON.parse(candidate.rawJson ?? "{}") as ExtractedCandidate;
      if (!raw.executionEvidence) {
        const sources = sourceTurns.filter(turn => (!raw.sourceTurnId || turn.id === raw.sourceTurnId)
          && raw.userEvidence && turn.userText.includes(raw.userEvidence));
        const turn = sources.length === 1 ? sources[0] : undefined;
        const original = turn && this.getTurn(turn.id);
        if (turn && original?.taskId === candidate.taskId && original.userMessageId
          && original.userMessageId === turn.userMessageId && (!privateDotsSource || botMemoryTextEligible(original.userText)
            && !botMemoryConversationOnly(original.userText) && botMemoryWriteEvidenceAllowed(original.userText, raw.userEvidence ?? "")
            && gatewayDotsMemorySource(this.db.connection, candidate.taskId, original.metadata.gatewayOrigin, true))) {
          grounded = groundDotsClaim(candidate, { messageId: original.userMessageId, turnId: turn.id,
            text: turn.userText, originalText: original.userText, createdAt: original.capturedAt }, raw.userEvidence, {
            declaration: raw.applicability, resolveName: this.resolveDotsScope,
            changeDefault: candidate.operationHint !== "create" && ["identity", "preference", "constraint", "procedure"].includes(candidate.kind),
          });
        }
        if (!grounded || !turn || isDotsSingleUse(grounded.quote, turn.userText)
          || privateDotsSource && (!["identity", "preference", "constraint"].includes(grounded.kind)
            || grounded.stance === "reported" || grounded.stance === "uncertain")) {
          this.repository.resolveCandidate(candidate.id, "rejected");
          return { status: "rejected" };
        }
        sourceTurns = [{ ...turn, userText: grounded.quote, assistantText: "" }];
      }
    }
    let publicShared = false;
    try { publicShared = Boolean(botSource) && JSON.parse(candidate.rawJson ?? "{}").publicShared === true; } catch { /* legacy candidate */ }
    const inCandidateScope = (scope: { scopeType: MemoryScopeType; scopeId?: string }) => scope.scopeType === candidate.scopeType && scope.scopeId === candidate.scopeId;
    const deferSharedMutation = (record: MemoryRecordDto): boolean => {
      if (force || (botSource && record.scopes.some(inCandidateScope)
        && (candidate.scopeType !== "global" || publicShared && record.metadata.publicShared === true))
        || (privateDotsSource && grounded && record.scopes.length === 1 && record.scopes.every(inCandidateScope))
        || this.canMutateFromTask(candidate.taskId, record)) return false;
      this.repository.resolveCandidate(candidate.id, "needs_review");
      return true;
    };
    if (candidate.taskId === DOTS_TASK_ID && sourceTurns.length) {
      const originalIds = sourceTurns.flatMap(turn => turn.userMessageId ? [turn.userMessageId] : []);
      if (originalIds.length) {
        const explicitWrites = this.db.connection.prepare(`SELECT DISTINCT m.id FROM memory_records m
          JOIN memory_evidence e ON e.memory_id=m.id WHERE m.status='active' AND e.evidence_kind='message'
          AND e.ref_id IN (${originalIds.map(() => "?").join(",")})
          AND ((m.kind=? AND m.content=?) OR (m.source_task_id=? AND e.excerpt=? AND m.content=?))`)
          .all(...originalIds, candidate.kind, candidate.content, DOTS_TASK_ID, grounded?.quote ?? null,
            cleanMultilineText(grounded?.content, MEMORY_CONTENT_MAX_CHARS)) as Array<{ id: string }>;
        const saved = explicitWrites.find(row => this.canAccess(row.id, { taskId: DOTS_TASK_ID }));
        if (saved) {
          this.addConversationEvidence(saved.id, sourceTurns);
          this.repository.resolveCandidate(candidate.id, "rejected", saved.id);
          return { status: "rejected", memoryId: saved.id };
        }
      }
    }
    const incomingCondition = grounded?.applicability;
    const records = this.repository.listScopeRecords(candidate.scopeType, candidate.scopeId);
    const globalMatches = grounded && !incomingCondition && candidate.taskId === DOTS_TASK_ID && candidate.replaces
      && (candidate.operationHint === "update" || candidate.operationHint === "supersede")
      ? this.repository.listScopeRecords("global").filter(record => record.title === candidate.replaces
        && record.kind === candidate.kind && !dotsRecordApplicability(record)
        && this.canAccess(record.id, { taskId: DOTS_TASK_ID })) : [];
    const scopedRecords = globalMatches.length === 1 && !records.some(record => record.title === candidate.replaces && !dotsRecordApplicability(record))
      ? [...records, globalMatches[0]!] : records;
    const matches = scopedRecords
      .filter(record => !grounded || sameDotsApplicability(dotsRecordApplicability(record), incomingCondition))
      .filter(record => force || !this.isCapturedSnapshot(record.id))
      .filter(record => !botSource || candidate.scopeType !== "global" || publicShared && record.metadata.publicShared === true);
    const targetText = candidate.replaces || candidate.title;
    let best = matches
      .map((m) => ({ m, score: Math.max(tokenSimilarity(targetText, m.title), tokenSimilarity(targetText, m.content), tokenSimilarity(candidate.title, m.title)) }))
      .sort((a, b) => b.score - a.score)[0];
    if (grounded && candidate.replaces && (!best || best.score < 0.95)) {
      // A stored quotation may have a different title from the extractor's
      // original subject. Only a unique, committed, in-scope antecedent qualifies.
      const refs = this.db.connection.prepare(`SELECT DISTINCT resolved_memory_id id FROM memory_candidates
        WHERE task_id=? AND status='committed' AND title=? AND resolved_memory_id IS NOT NULL`).all(candidate.taskId, candidate.replaces) as Array<{ id: string }>;
      const prior = matches.filter(record => refs.some(ref => ref.id === record.id));
      if (prior.length === 1) best = { m: prior[0]!, score: 1 };
    }
    const previousSubject = grounded && best && candidate.replaces && candidate.operationHint === "update"
      ? dotsSubject(candidate.replaces, best.m.title) : undefined;
    let overrideId: string | undefined;
    if (incomingCondition && incomingCondition.kind !== "unresolved" && candidate.replaces && grounded?.stance === "statement") {
      const priorCandidates = this.db.connection.prepare(`SELECT DISTINCT resolved_memory_id id FROM memory_candidates
        WHERE task_id=? AND status='committed' AND title=? AND resolved_memory_id IS NOT NULL`).all(candidate.taskId, candidate.replaces) as Array<{ id: string }>;
      const unscopedDefaults = [...records, ...this.repository.listScopeRecords("global")]
        .filter(record => record.status === "active" && !dotsRecordApplicability(record) && record.kind === grounded.kind
          && (record.title === candidate.replaces || priorCandidates.some(prior => prior.id === record.id))
          && this.canAccess(record.id, { taskId: DOTS_TASK_ID }));
      const ids = [...new Set(unscopedDefaults.map(record => record.id))];
      if (ids.length === 1) overrideId = ids[0];
    }
    if (grounded) candidate = { ...candidate, kind: grounded.kind, title: previousSubject ?? grounded.title, content: grounded.content,
      operationHint: incomingCondition?.kind === "unresolved" || grounded.stance === "reported" || grounded.stance === "uncertain"
        || best?.m.kind === "decision" && grounded.stance !== "statement" || incomingCondition && !best
        ? "create" : candidate.operationHint,
      confidence: grounded.confidence ?? 0.7, explicit: grounded.explicit };
    const comparableContent = (value: string) => value.normalize("NFKC").replace(/\s+/g, " ").trim();
    const duplicate = matches.find((m) => hashContent(candidate.kind, candidate.title, candidate.content) === m.contentHash
      || (candidate.content.trim() && m.kind === candidate.kind && comparableContent(candidate.content) === comparableContent(m.content)))
      ?? (!grounded && best && best.score >= 0.95 && tokenSimilarity(candidate.content, best.m.content) >= 0.92 ? best.m : undefined);
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
    if (!force && !grounded && !candidate.explicit && candidate.confidence < 0.68) {
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
      sourceType: candidate.explicit || privateDotsSource ? "user" : "agent",
      sourceTaskId: botMemorySource(this.db, candidate.taskId) ? undefined : candidate.taskId,
      sourceId: botMemorySource(this.db, candidate.taskId) ? candidate.taskId : undefined,
      scopeType: candidate.scopeType,
      scopeId: candidate.scopeId,
      metadata: incomingCondition ? { ...(privateDotsSource ? { dotsPrivateGateway: true } : {}),
        dotsApplicability: incomingCondition, ...(overrideId ? { dotsOverrides: overrideId } : {}) }
        : botSource ? { ...(publicShared ? { publicShared: true } : {}), botAutomaticScopePolicy: "source-work-v1",
        sourceUserMessageIds: [...new Set(sourceTurns.flatMap(turn => turn.userMessageId ? [turn.userMessageId] : []))] }
        : privateDotsSource ? { dotsPrivateGateway: true } : publicShared ? { publicShared: true } : undefined,
      evidence: [
        { evidenceKind: botMemorySource(this.db, candidate.taskId) ? "conversation" : "task", refId: candidate.taskId },
        ...sourceTurns.map((turn) => ({ evidenceKind: "conversation" as const, refId: turn.id, refTitle: "L0 conversation turn", excerpt: this.l0EvidenceExcerpt(turn) })),
      ],
    };
    if (candidate.operationHint === "supersede" && best && globalMatches.some(record => record.id === best.m.id)) {
      createReq.scopeType = "global";
      createReq.scopeId = undefined;
    }
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
        confidence: grounded ? candidate.confidence : Math.max(best.m.confidence, candidate.confidence),
        explicit: grounded ? candidate.explicit : best.m.explicit || candidate.explicit,
        ...(incomingCondition ? { metadata: { ...best.m.metadata, ...createReq.metadata } } : {}),
        changedBy: candidate.explicit ? "user" : "agent",
        changeReason: grounded?.reason ?? `candidate:${candidate.id}`,
      });
      this.addConversationEvidence(updated.id, sourceTurns);
      this.repository.resolveCandidate(candidate.id, "committed", updated.id);
      return { status: "committed", memoryId: updated.id };
    }
    if (candidate.operationHint === "supersede" && best && best.score >= 0.45) {
      if (deferSharedMutation(best.m)) return { status: "needs_review" };
      const created = this.supersede(best.m.id, createReq, grounded?.reason);
      this.repository.resolveCandidate(candidate.id, "committed", created.id);
      return { status: "committed", memoryId: created.id };
    }
    // If a candidate strongly overlaps an active memory but asks to create a materially different fact,
    // do not silently keep both active: require review unless it is an explicit user statement.
    if (!grounded && !force && best && best.score >= 0.72 && !candidate.explicit) {
      this.repository.resolveCandidate(candidate.id, "needs_review");
      return { status: "needs_review" };
    }
    const created = this.create(createReq, grounded?.reason);
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
    if (isGatewayConversation(taskId)) return memory.scopes.length === 1 && this.canPromoteFromTask(taskId, memory.scopes[0].scopeType, memory.scopes[0].scopeId);
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

  private isAssistantMemoryContext(request: MemorySearchRequest): boolean {
    return Boolean(request.botId || request.teamId || request.conversationId || request.workId
      || (request.taskId && (this.workMemoryScope(request.taskId) || this.channelBotId(request.taskId))));
  }

  private recallVisibility(request: MemorySearchRequest, chain: ReturnType<MemoryService["resolveScopeChain"]>) {
    let assistantContext: boolean | undefined;
    return (memory: MemoryRecordDto) => this.visibleInChain(memory, chain, request,
      () => assistantContext ??= this.isAssistantMemoryContext(request));
  }

  private visibleInChain(memory: MemoryRecordDto, chain: Array<{ scopeType: MemoryScopeType; scopeId?: string }>,
    request: MemorySearchRequest, assistantContext = () => this.isAssistantMemoryContext(request)): boolean {
    if (memory.id.startsWith("mem_weekly_")) return false;
    const personalDots = memory.scopes.length === 1 && memory.scopes[0].scopeType === "task"
      && memory.scopes[0].scopeId === DOTS_TASK_ID && ["identity", "preference", "constraint"].includes(memory.kind);
    if (memory.sourceTaskId && isGatewayConversation(memory.sourceTaskId) && memory.sourceTaskId !== request.taskId
      && (!personalDots || memory.metadata.dotsPrivateGateway !== true)) return false;
    if (request.taskId && isGatewayConversation(request.taskId)
      && !memory.scopes.some(scope => scope.scopeType === "task" && scope.scopeId === request.taskId)
      && !personalDots) return false;
    const legacyBoundary = botMemoryAutomaticBoundary(this.db, memory);
    if (legacyBoundary) return chain.some(scope => scope.scopeType === legacyBoundary.scopeType && scope.scopeId === legacyBoundary.scopeId);
    return memory.scopes.some(scope => chain.some(c => c.scopeType === scope.scopeType && (c.scopeId ?? "") === (scope.scopeId ?? ""))
      && (scope.scopeType !== "global" || memory.metadata.publicShared === true || !assistantContext()));
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
    if (isGatewayConversation(ctx.taskId)) return { scopeType: "task", scopeId: ctx.taskId };
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
