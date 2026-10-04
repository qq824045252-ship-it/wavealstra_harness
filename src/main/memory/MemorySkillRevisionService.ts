import { createHash } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type {
  MemorySkillRevisionCandidateDto,
  MemorySkillRevisionStatus,
} from "../../shared/memory-kernel";

export interface LearnedSkillRevisionSource {
  skillId: string;
  candidateId?: string;
  version: string;
  title: string;
  description: string;
  instructions: string;
  contentHash: string;
  sourceMemoryIds: string[];
  scopeType: "global" | "workspace" | "project";
  scopeId?: string;
}

type RevisionRow = {
  id: string;
  skill_id: string;
  base_candidate_id: string | null;
  base_version: string;
  base_content_hash: string;
  title: string;
  status: MemorySkillRevisionStatus;
  issue_summary: string;
  base_description: string;
  base_instructions: string;
  proposed_description: string;
  proposed_instructions: string;
  negative_feedback_ids_json: string;
  source_memory_ids_json: string;
  feedback_signature: string;
  needs_revision_count: number;
  incorrect_count: number;
  failed_invocation_count: number;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  materialized_candidate_id: string | null;
  materialized_version: string | null;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseStringArray(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string") : [];
  } catch {
    return [];
  }
}

function mapRow(row: RevisionRow): MemorySkillRevisionCandidateDto {
  return {
    id: row.id,
    skillId: row.skill_id,
    baseCandidateId: row.base_candidate_id ?? undefined,
    baseVersion: row.base_version,
    baseContentHash: row.base_content_hash,
    title: row.title,
    status: row.status,
    issueSummary: row.issue_summary,
    baseDescription: row.base_description,
    baseInstructions: row.base_instructions,
    proposedDescription: row.proposed_description,
    proposedInstructions: row.proposed_instructions,
    negativeFeedbackIds: parseStringArray(row.negative_feedback_ids_json),
    sourceMemoryIds: parseStringArray(row.source_memory_ids_json),
    feedbackSignature: row.feedback_signature,
    needsRevisionCount: row.needs_revision_count,
    incorrectCount: row.incorrect_count,
    failedInvocationCount: row.failed_invocation_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at ?? undefined,
    materializedCandidateId: row.materialized_candidate_id ?? undefined,
    materializedVersion: row.materialized_version ?? undefined,
  };
}

function cleanNote(value: unknown): string {
  return typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, 1000) : "";
}

function buildIssueSummary(input: {
  needsRevisionCount: number;
  incorrectCount: number;
  failedInvocationCount: number;
  notes: string[];
}): string {
  const counts = [
    `需修订 ${input.needsRevisionCount}`,
    `错误 ${input.incorrectCount}`,
    `失败调用佐证 ${input.failedInvocationCount}`,
  ].join(" · ");
  if (input.notes.length === 0) return `${counts}。尚无具体修订说明，因此只能保持 draft。`;
  return `${counts}。明确反馈：${input.notes.join("；")}`.slice(0, 2400);
}

function buildProposedInstructions(base: string, notes: string[]): string {
  const body = base.trim();
  if (notes.length === 0) return body;
  const correction = [
    "",
    "## Corrections learned from explicit user feedback",
    "以下约束来自该技能真实调用后的用户明确纠正；执行时必须遵守：",
    ...notes.map((note) => `- ${note}`),
  ].join("\n");
  return `${body}${correction}`.slice(0, 24000);
}

/**
 * Converts explicit negative learned-Skill feedback into reviewable revision candidates.
 * Failed outcomes never trigger a revision on their own; they are corroborating evidence only.
 * This service never writes Skill files or Memory records.
 */
export class MemorySkillRevisionService {
  constructor(private readonly db: AppDatabase) {}

  private get conn() { return this.db.connection; }

  get(id: string): MemorySkillRevisionCandidateDto | undefined {
    const row = this.conn.prepare("SELECT * FROM memory_skill_revision_candidates WHERE id=?").get(id) as RevisionRow | undefined;
    return row ? mapRow(row) : undefined;
  }

  list(status?: MemorySkillRevisionStatus, limit = 200): MemorySkillRevisionCandidateDto[] {
    const capped = Math.max(1, Math.min(1000, limit));
    const rows = (status
      ? this.conn.prepare("SELECT * FROM memory_skill_revision_candidates WHERE status=? ORDER BY updated_at DESC,id ASC LIMIT ?").all(status, capped)
      : this.conn.prepare("SELECT * FROM memory_skill_revision_candidates ORDER BY updated_at DESC,id ASC LIMIT ?").all(capped)) as RevisionRow[];
    return rows.map(mapRow);
  }

  refresh(source: LearnedSkillRevisionSource): { candidate?: MemorySkillRevisionCandidateDto; created: boolean; staled: number } {
    if (!source.skillId.trim() || !source.instructions.trim()) return { created: false, staled: 0 };
    const rows = this.conn.prepare(
      `SELECT id,feedback_kind,feedback_note,outcome,updated_at
       FROM memory_skill_effectiveness
       WHERE skill_id=?
         AND COALESCE(candidate_id,'')=COALESCE(?, '')
         AND invoked_at IS NOT NULL
         AND feedback_kind IN ('needs_revision','incorrect')
       ORDER BY COALESCE(feedback_at,updated_at),id`,
    ).all(source.skillId, source.candidateId ?? null) as Array<{
      id: string;
      feedback_kind: "needs_revision" | "incorrect";
      feedback_note: string | null;
      outcome: string;
      updated_at: number;
    }>;

    const now = Date.now();
    if (rows.length === 0) {
      return { created: false, staled: this.staleOpenForBase(source.skillId, source.candidateId, source.contentHash, now) };
    }

    const notes = [...new Set(rows.map((row) => cleanNote(row.feedback_note)).filter(Boolean))];
    const feedbackIds = rows.map((row) => row.id);
    const needsRevisionCount = rows.filter((row) => row.feedback_kind === "needs_revision").length;
    const incorrectCount = rows.filter((row) => row.feedback_kind === "incorrect").length;
    const failedInvocationCount = Number((this.conn.prepare(
      `SELECT COUNT(1) n FROM memory_skill_effectiveness
       WHERE skill_id=? AND COALESCE(candidate_id,'')=COALESCE(?, '') AND invoked_at IS NOT NULL AND outcome='failed'`,
    ).get(source.skillId, source.candidateId ?? null) as { n: number }).n);
    // Signature is evidence-content based, not timestamp based: re-saving the same feedback must be idempotent.
    const feedbackSignature = hash(rows.map((row) => `${row.id}:${row.feedback_kind}:${cleanNote(row.feedback_note)}`).join("\n"));
    const id = `msrev_${hash(`${source.skillId}\n${source.candidateId ?? ""}\n${source.contentHash}\n${feedbackSignature}`).slice(0, 28)}`;
    const existing = this.get(id);
    const proposedStatus: MemorySkillRevisionStatus = notes.length > 0 ? "ready" : "draft";
    const preserveTerminal = existing?.status === "rejected" || existing?.status === "materialized";
    const status = preserveTerminal ? existing!.status : proposedStatus;
    const issueSummary = buildIssueSummary({ needsRevisionCount, incorrectCount, failedInvocationCount, notes });
    const proposedInstructions = buildProposedInstructions(source.instructions, notes);

    this.conn.prepare(
      `INSERT INTO memory_skill_revision_candidates (
        id,skill_id,base_candidate_id,base_version,base_content_hash,title,status,issue_summary,
        base_description,base_instructions,proposed_description,proposed_instructions,
        negative_feedback_ids_json,source_memory_ids_json,feedback_signature,
        needs_revision_count,incorrect_count,failed_invocation_count,
        created_at,updated_at,resolved_at,materialized_candidate_id,materialized_version
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET
        title=excluded.title,
        status=CASE WHEN memory_skill_revision_candidates.status IN ('rejected','materialized') THEN memory_skill_revision_candidates.status ELSE excluded.status END,
        issue_summary=excluded.issue_summary,
        proposed_description=excluded.proposed_description,
        proposed_instructions=excluded.proposed_instructions,
        negative_feedback_ids_json=excluded.negative_feedback_ids_json,
        source_memory_ids_json=excluded.source_memory_ids_json,
        feedback_signature=excluded.feedback_signature,
        needs_revision_count=excluded.needs_revision_count,
        incorrect_count=excluded.incorrect_count,
        failed_invocation_count=excluded.failed_invocation_count,
        updated_at=excluded.updated_at`,
    ).run(
      id,
      source.skillId,
      source.candidateId ?? null,
      source.version,
      source.contentHash,
      source.title.slice(0, 180),
      status,
      issueSummary,
      source.description,
      source.instructions,
      source.description,
      proposedInstructions,
      JSON.stringify(feedbackIds),
      JSON.stringify([...new Set(source.sourceMemoryIds)]),
      feedbackSignature,
      needsRevisionCount,
      incorrectCount,
      failedInvocationCount,
      existing?.createdAt ?? now,
      now,
      existing?.resolvedAt ?? null,
      existing?.materializedCandidateId ?? null,
      existing?.materializedVersion ?? null,
    );

    const staled = this.staleOtherOpen(source.skillId, source.candidateId, id, now);
    return { candidate: this.get(id)!, created: !existing, staled };
  }

  reject(id: string): MemorySkillRevisionCandidateDto {
    const candidate = this.get(id);
    if (!candidate) throw new Error(`Skill Revision Candidate 不存在：${id}`);
    if (!["draft", "ready"].includes(candidate.status)) throw new Error(`Skill Revision Candidate 当前状态不可拒绝：${candidate.status}`);
    const now = Date.now();
    this.conn.prepare("UPDATE memory_skill_revision_candidates SET status='rejected',resolved_at=?,updated_at=? WHERE id=?").run(now, now, id);
    return this.get(id)!;
  }

  markStale(id: string): MemorySkillRevisionCandidateDto {
    const candidate = this.get(id);
    if (!candidate) throw new Error(`Skill Revision Candidate 不存在：${id}`);
    if (candidate.status === "materialized" || candidate.status === "rejected") return candidate;
    this.conn.prepare("UPDATE memory_skill_revision_candidates SET status='stale',updated_at=? WHERE id=?").run(Date.now(), id);
    return this.get(id)!;
  }

  markMaterialized(id: string, materializedCandidateId: string, version: string): MemorySkillRevisionCandidateDto {
    const candidate = this.get(id);
    if (!candidate) throw new Error(`Skill Revision Candidate 不存在：${id}`);
    if (candidate.status !== "ready") throw new Error(`Skill Revision Candidate 当前状态不可物化：${candidate.status}`);
    const now = Date.now();
    this.conn.prepare(
      `UPDATE memory_skill_revision_candidates
       SET status='materialized',materialized_candidate_id=?,materialized_version=?,resolved_at=?,updated_at=? WHERE id=?`,
    ).run(materializedCandidateId, version, now, now, id);
    return this.get(id)!;
  }

  private staleOtherOpen(skillId: string, candidateId: string | undefined, keepId: string, now: number): number {
    return this.conn.prepare(
      `UPDATE memory_skill_revision_candidates SET status='stale',updated_at=?
       WHERE skill_id=? AND COALESCE(base_candidate_id,'')=COALESCE(?, '') AND id<>? AND status IN ('draft','ready')`,
    ).run(now, skillId, candidateId ?? null, keepId).changes;
  }

  staleMissingSkills(activeSkillIds: ReadonlySet<string>, now = Date.now()): number {
    const rows = this.conn.prepare(
      "SELECT id,skill_id FROM memory_skill_revision_candidates WHERE status IN ('draft','ready')",
    ).all() as Array<{ id: string; skill_id: string }>;
    let changed = 0;
    this.conn.transaction(() => {
      for (const row of rows) {
        if (activeSkillIds.has(row.skill_id)) continue;
        changed += this.conn.prepare(
          "UPDATE memory_skill_revision_candidates SET status='stale',updated_at=? WHERE id=? AND status IN ('draft','ready')",
        ).run(now, row.id).changes;
      }
    })();
    return changed;
  }

  private staleOpenForBase(skillId: string, candidateId: string | undefined, _contentHash: string, now: number): number {
    return this.conn.prepare(
      `UPDATE memory_skill_revision_candidates SET status='stale',updated_at=?
       WHERE skill_id=? AND COALESCE(base_candidate_id,'')=COALESCE(?, '') AND status IN ('draft','ready')`,
    ).run(now, skillId, candidateId ?? null).changes;
  }
}
