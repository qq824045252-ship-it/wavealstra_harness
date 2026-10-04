import { createHash } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type {
  MemoryRecordDto,
  MemorySkillCandidateDto,
  MemorySkillCandidateStatus,
} from "../../shared/memory-kernel";
import { MemoryRepository } from "./MemoryRepository";

type LearnableScope = Pick<MemorySkillCandidateDto, "scopeType" | "scopeId">;

type CandidateRow = {
  id: string;
  slug: string;
  title: string;
  description: string;
  instructions: string;
  status: MemorySkillCandidateStatus;
  scope_type: MemorySkillCandidateDto["scopeType"];
  scope_id: string | null;
  source_memory_ids_json: string;
  source_signature: string;
  support_count: number;
  distinct_task_count: number;
  completed_task_count: number;
  evidence_count: number;
  confidence: number;
  score: number;
  installed_skill_id: string | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function mapRow(row: CandidateRow): MemorySkillCandidateDto {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    description: row.description,
    instructions: row.instructions,
    status: row.status,
    scopeType: row.scope_type,
    scopeId: row.scope_id ?? undefined,
    sourceMemoryIds: parseStringArray(row.source_memory_ids_json),
    sourceSignature: row.source_signature,
    supportCount: row.support_count,
    distinctTaskCount: row.distinct_task_count,
    completedTaskCount: row.completed_task_count,
    evidenceCount: row.evidence_count,
    confidence: row.confidence,
    score: row.score,
    installedSkillId: row.installed_skill_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
  };
}

function chooseScope(memory: MemoryRecordDto): LearnableScope | null {
  const global = memory.scopes.find((scope) => scope.scopeType === "global");
  if (global) return { scopeType: "global" };
  const project = memory.scopes.find((scope) => scope.scopeType === "project" && scope.scopeId);
  if (project) return { scopeType: "project", scopeId: project.scopeId };
  const workspace = memory.scopes.find((scope) => scope.scopeType === "workspace" && scope.scopeId);
  if (workspace) return { scopeType: "workspace", scopeId: workspace.scopeId };
  // Task-only procedures are intentionally not promoted into reusable Skill candidates.
  return null;
}

function makeSlug(memory: MemoryRecordDto): string {
  const ascii = memory.title
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 42);
  const suffix = hash(memory.id).slice(0, 7);
  return `${ascii ? `learned-${ascii}` : "learned-procedure"}-${suffix}`.slice(0, 63);
}

function singleLine(text: string, max: number): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max);
}

function buildDescription(memory: MemoryRecordDto): string {
  const body = singleLine(memory.content, 210);
  return body || `从 Memory Kernel 学到的流程：${memory.title}`;
}

function buildInstructions(memory: MemoryRecordDto): string {
  return [
    `# ${memory.title}`,
    "",
    "## When to use",
    `当当前任务与“${memory.title}”这一稳定流程匹配时使用。`,
    "",
    "## Procedure",
    memory.content.trim(),
    "",
    "## Operating rules",
    "- 以用户当前消息和当前项目约束为最高优先级；若与本技能冲突，服从最新明确要求。",
    "- 执行前确认当前环境、路径、对象和权限仍满足前提，不把历史环境假设成当前事实。",
    "- 对不可逆、外部写入或高影响动作继续遵守现有权限与审批机制；本技能不会绕过 Gatekeeper。",
    "- 若流程依据已经变化或结果与预期不符，停止机械复用并回到 Memory / 当前证据重新判断。",
  ].join("\n");
}

export interface MemorySkillRefreshResult {
  evaluated: number;
  created: number;
  updated: number;
  staled: number;
  ready: number;
}

/**
 * Deterministic bridge from durable L1 procedure memory to reviewable Skill candidates.
 * This service never writes a real Skill. Human approval is required before SkillsService materializes SKILL.md.
 */
export class MemorySkillLearningService {
  private readonly memories: MemoryRepository;

  constructor(private readonly db: AppDatabase, memories?: MemoryRepository) {
    this.memories = memories ?? new MemoryRepository(db);
  }

  private get conn() { return this.db.connection; }

  get(id: string): MemorySkillCandidateDto | undefined {
    const row = this.conn.prepare("SELECT * FROM memory_skill_candidates WHERE id=?").get(id) as CandidateRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  list(status?: MemorySkillCandidateStatus, limit = 200): MemorySkillCandidateDto[] {
    const capped = Math.max(1, Math.min(1000, limit));
    const rows = (status
      ? this.conn.prepare("SELECT * FROM memory_skill_candidates WHERE status=? ORDER BY updated_at DESC,id ASC LIMIT ?").all(status, capped)
      : this.conn.prepare("SELECT * FROM memory_skill_candidates ORDER BY updated_at DESC,id ASC LIMIT ?").all(capped)) as CandidateRow[];
    return rows.map(mapRow);
  }

  refreshMemory(memoryId: string): MemorySkillRefreshResult {
    const memory = this.memories.get(memoryId);
    const now = Date.now();
    if (!memory || memory.kind !== "procedure" || memory.status !== "active") {
      return { evaluated: 0, created: 0, updated: 0, staled: this.invalidateByMemoryIds([memoryId], now), ready: 0 };
    }
    const scope = chooseScope(memory);
    if (!scope || memory.content.trim().length < 12) {
      return { evaluated: 1, created: 0, updated: 0, staled: this.invalidateByMemoryIds([memoryId], now), ready: 0 };
    }
    const result = this.upsertCandidate(memory, scope, now);
    const staled = this.staleUngroundedForMemory(memory.id, now, result.candidate.id);
    return {
      evaluated: 1,
      created: result.created ? 1 : 0,
      updated: result.created ? 0 : 1,
      staled,
      ready: result.candidate.status === "ready" ? 1 : 0,
    };
  }

  refresh(): MemorySkillRefreshResult {
    const procedureIds = this.conn.prepare(
      "SELECT id FROM memory_records WHERE kind='procedure' AND status='active' ORDER BY updated_at DESC,id ASC",
    ).all() as Array<{ id: string }>;
    const now = Date.now();
    let created = 0;
    let updated = 0;
    let ready = 0;
    for (const row of procedureIds) {
      const memory = this.memories.get(row.id);
      if (!memory) continue;
      const scope = chooseScope(memory);
      if (!scope || memory.content.trim().length < 12) {
        this.invalidateByMemoryIds([memory.id], now);
        continue;
      }
      const result = this.upsertCandidate(memory, scope, now);
      if (result.created) created += 1;
      else updated += 1;
      if (result.candidate.status === "ready") ready += 1;
    }

    let staled = 0;
    const active = this.conn.prepare(
      "SELECT * FROM memory_skill_candidates WHERE status IN ('draft','ready','materialized')",
    ).all() as CandidateRow[];
    this.conn.transaction(() => {
      for (const row of active) {
        const candidate = mapRow(row);
        if (this.isCandidateGrounded(candidate)) continue;
        const result = this.conn.prepare(
          "UPDATE memory_skill_candidates SET status='stale',updated_at=? WHERE id=? AND status IN ('draft','ready','materialized')",
        ).run(now, row.id);
        staled += result.changes;
      }
    })();
    return { evaluated: procedureIds.length, created, updated, staled, ready };
  }

  private upsertCandidate(memory: MemoryRecordDto, scope: LearnableScope, now: number): { candidate: MemorySkillCandidateDto; created: boolean } {
    const support = this.supportStats(memory);
    const score = this.score(memory, scope, support.completedTaskCount, support.evidenceCount);
    const proposedStatus: MemorySkillCandidateStatus = this.isReady(memory, scope, support.completedTaskCount, support.evidenceCount)
      ? "ready"
      : "draft";
    const sourceSignature = hash([
      memory.id,
      memory.contentHash,
      scope.scopeType,
      scope.scopeId ?? "",
    ].join("\n"));
    const id = `mskill_${hash(`${memory.id}\n${memory.contentHash}\n${scope.scopeType}:${scope.scopeId ?? ""}`).slice(0, 28)}`;
    const existing = this.get(id);
    const preserveTerminal = existing?.status === "rejected" || existing?.status === "materialized";
    const status = preserveTerminal ? existing!.status : proposedStatus;
    this.conn.prepare(
      `INSERT INTO memory_skill_candidates (
        id,slug,title,description,instructions,status,scope_type,scope_id,
        source_memory_ids_json,source_signature,support_count,distinct_task_count,completed_task_count,evidence_count,
        confidence,score,installed_skill_id,created_at,updated_at,resolved_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        slug=excluded.slug,
        title=excluded.title,
        description=excluded.description,
        instructions=excluded.instructions,
        status=CASE
          WHEN memory_skill_candidates.status IN ('rejected','materialized') THEN memory_skill_candidates.status
          ELSE excluded.status
        END,
        scope_type=excluded.scope_type,
        scope_id=excluded.scope_id,
        source_memory_ids_json=excluded.source_memory_ids_json,
        source_signature=excluded.source_signature,
        support_count=excluded.support_count,
        distinct_task_count=excluded.distinct_task_count,
        completed_task_count=excluded.completed_task_count,
        evidence_count=excluded.evidence_count,
        confidence=excluded.confidence,
        score=excluded.score,
        updated_at=excluded.updated_at`,
    ).run(
      id,
      makeSlug(memory),
      memory.title.slice(0, 180),
      buildDescription(memory),
      buildInstructions(memory),
      status,
      scope.scopeType,
      scope.scopeId ?? null,
      JSON.stringify([memory.id]),
      sourceSignature,
      support.completedTaskCount,
      support.distinctTaskCount,
      support.completedTaskCount,
      support.evidenceCount,
      memory.confidence,
      score,
      existing?.installedSkillId ?? null,
      existing?.createdAt ?? now,
      now,
      existing?.resolvedAt ?? null,
    );
    return { candidate: this.get(id)!, created: !existing };
  }

  private staleUngroundedForMemory(memoryId: string, now: number, keepId?: string): number {
    const rows = this.conn.prepare(
      `SELECT * FROM memory_skill_candidates
       WHERE status IN ('draft','ready','materialized')
         AND EXISTS (SELECT 1 FROM json_each(source_memory_ids_json) j WHERE j.value=?)`,
    ).all(memoryId) as CandidateRow[];
    let changed = 0;
    this.conn.transaction(() => {
      for (const row of rows) {
        if (row.id === keepId) continue;
        const candidate = mapRow(row);
        if (this.isCandidateGrounded(candidate)) continue;
        changed += this.conn.prepare(
          "UPDATE memory_skill_candidates SET status='stale',updated_at=? WHERE id=? AND status IN ('draft','ready','materialized')",
        ).run(now, row.id).changes;
      }
    })();
    return changed;
  }

  invalidateByMemoryIds(memoryIds: readonly string[], now = Date.now()): number {
    const ids = [...new Set(memoryIds.filter(Boolean))];
    let changed = 0;
    for (const memoryId of ids) {
      const result = this.conn.prepare(
        `UPDATE memory_skill_candidates
         SET status='stale',updated_at=?
         WHERE status IN ('draft','ready','materialized')
           AND EXISTS (SELECT 1 FROM json_each(source_memory_ids_json) j WHERE j.value=?)`,
      ).run(now, memoryId);
      changed += result.changes;
    }
    return changed;
  }

  /** Resolve the governance record behind an installed learned Skill. */
  findByInstalledSkillId(installedSkillId: string): MemorySkillCandidateDto | undefined {
    const normalized = installedSkillId.trim().toLowerCase();
    if (!normalized) return undefined;
    const row = this.conn.prepare(
      `SELECT * FROM memory_skill_candidates
       WHERE lower(installed_skill_id)=?
       ORDER BY updated_at DESC,id ASC
       LIMIT 1`,
    ).get(normalized) as CandidateRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  isInstalledSkillRunnable(installedSkillId: string, sourceMemoryIds: readonly string[]): boolean {
    const candidate = this.findByInstalledSkillId(installedSkillId);
    if (!candidate || candidate.status !== "materialized" || !this.isCandidateGrounded(candidate)) return false;
    const candidateSources = [...candidate.sourceMemoryIds].sort();
    const packageSources = [...new Set(sourceMemoryIds)].sort();
    return candidateSources.length === packageSources.length && candidateSources.every((id, index) => id === packageSources[index]);
  }

  reject(id: string): MemorySkillCandidateDto {
    const candidate = this.get(id);
    if (!candidate) throw new Error(`Skill Candidate 不存在：${id}`);
    if (!["draft", "ready"].includes(candidate.status)) {
      throw new Error(`Skill Candidate 当前状态不可拒绝：${candidate.status}`);
    }
    const now = Date.now();
    this.conn.prepare(
      "UPDATE memory_skill_candidates SET status='rejected',resolved_at=?,updated_at=? WHERE id=?",
    ).run(now, now, id);
    return this.get(id)!;
  }

  markMaterialized(id: string, installedSkillId: string): MemorySkillCandidateDto {
    const candidate = this.get(id);
    if (!candidate) throw new Error(`Skill Candidate 不存在：${id}`);
    if (!["draft", "ready"].includes(candidate.status)) {
      throw new Error(`Skill Candidate 当前状态不可物化：${candidate.status}`);
    }
    if (!this.isCandidateGrounded(candidate)) {
      this.conn.prepare("UPDATE memory_skill_candidates SET status='stale',updated_at=? WHERE id=?").run(Date.now(), id);
      throw new Error("Skill Candidate 来源 Procedure 已变化，请刷新候选后重新审批");
    }
    const now = Date.now();
    this.conn.prepare(
      `UPDATE memory_skill_candidates
       SET status='materialized',installed_skill_id=?,resolved_at=?,updated_at=? WHERE id=?`,
    ).run(installedSkillId, now, now, id);
    return this.get(id)!;
  }

  isCandidateGrounded(candidate: MemorySkillCandidateDto): boolean {
    if (candidate.sourceMemoryIds.length === 0) return false;
    const memories = candidate.sourceMemoryIds.map((id) => this.memories.get(id));
    if (memories.some((memory) => !memory || memory.status !== "active" || memory.kind !== "procedure")) return false;
    const memory = memories[0]!;
    const scope = chooseScope(memory);
    if (!scope || scope.scopeType !== candidate.scopeType || (scope.scopeId ?? "") !== (candidate.scopeId ?? "")) return false;
    const signature = hash([
      memory.id,
      memory.contentHash,
      scope.scopeType,
      scope.scopeId ?? "",
    ].join("\n"));
    return signature === candidate.sourceSignature;
  }

  private supportStats(memory: MemoryRecordDto): { distinctTaskCount: number; completedTaskCount: number; evidenceCount: number } {
    const taskIds = new Set<string>();
    if (memory.sourceTaskId) taskIds.add(memory.sourceTaskId);
    const conversationIds: string[] = [];
    for (const evidence of memory.evidence) {
      if (evidence.evidenceKind === "task") taskIds.add(evidence.refId);
      else if (evidence.evidenceKind === "conversation") conversationIds.push(evidence.refId);
    }
    const uniqueConversationIds = [...new Set(conversationIds)];
    const batchSize = 200;
    for (let offset = 0; offset < uniqueConversationIds.length; offset += batchSize) {
      const batch = uniqueConversationIds.slice(offset, offset + batchSize);
      if (batch.length === 0) continue;
      const rows = this.conn.prepare(
        `SELECT DISTINCT task_id FROM memory_turns WHERE id IN (${batch.map(() => "?").join(",")})`,
      ).all(...batch) as Array<{ task_id: string }>;
      for (const row of rows) if (row.task_id) taskIds.add(row.task_id);
    }
    let completedTaskCount = 0;
    for (const taskId of taskIds) {
      if (this.db.getTask(taskId)?.status === "completed") completedTaskCount += 1;
    }
    return {
      distinctTaskCount: taskIds.size,
      completedTaskCount,
      evidenceCount: memory.evidence.length,
    };
  }

  private score(memory: MemoryRecordDto, scope: LearnableScope, completedTaskCount: number, evidenceCount: number): number {
    const confidence = clamp01(memory.confidence) * 0.35;
    const importance = clamp01(memory.importance / 3) * 0.15;
    const repetition = clamp01(completedTaskCount / 3) * 0.3;
    const explicit = memory.explicit ? 0.1 : 0;
    const global = scope.scopeType === "global" ? 0.1 : 0;
    const evidence = Math.min(0.05, Math.max(0, evidenceCount - 1) * 0.01);
    return Number(Math.min(1, confidence + importance + repetition + explicit + global + evidence).toFixed(4));
  }

  private isReady(memory: MemoryRecordDto, scope: LearnableScope, completedTaskCount: number, evidenceCount: number): boolean {
    if (scope.scopeType === "global" && memory.explicit && memory.confidence >= 0.85 && memory.importance >= 1) return true;
    if (completedTaskCount >= 2 && memory.confidence >= 0.72 && memory.importance >= 1) return true;
    if (scope.scopeType === "global" && memory.confidence >= 0.92 && evidenceCount >= 3) return true;
    return false;
  }
}
