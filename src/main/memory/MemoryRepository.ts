import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type {
  MemoryCandidateDto,
  MemoryEvidenceDto,
  MemoryListRequest,
  MemoryRecordDto,
  MemoryRelationDto,
  MemoryRevisionDto,
  MemoryScopeDto,
  MemoryScopeType,
  MemoryStatus,
} from "../../shared/memory-kernel";

interface MemoryRow {
  id: string;
  kind: MemoryRecordDto["kind"];
  title: string;
  content: string;
  status: MemoryRecordDto["status"];
  importance: number;
  confidence: number;
  explicit: number;
  source_type: MemoryRecordDto["sourceType"];
  source_id: string | null;
  source_task_id: string | null;
  valid_from: number | null;
  valid_until: number | null;
  content_hash: string;
  created_at: number;
  updated_at: number;
  last_recalled_at: number | null;
  recall_count: number;
  metadata_json: string;
}

function parseObject(value: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

const MEMORY_FTS_MAX_TRIGRAMS = 64;

function buildMemoryFtsQuery(query: string): string | null {
  const compact = query.normalize("NFKC").toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "");
  if (compact.length < 3) return null;
  const grams: string[] = [];
  const add = (value: string) => {
    const term = value.trim();
    if (term.length < 3 || grams.includes(term)) return;
    grams.push(term);
  };
  const normalized = query.normalize("NFKC").toLowerCase();
  for (const word of normalized.split(/[^\p{L}\p{N}_+.-]+/u)) {
    if (word.length >= 3 && word.length <= 40) add(word);
  }
  // Latin/number identifiers (models, part numbers) embedded in CJK text are the most selective terms.
  for (const word of normalized.match(/[a-z0-9][a-z0-9_+.-]{2,39}/g) ?? []) add(word);
  // Trigrams make natural-language questions retrieve the embedded noun/model phrase without exact sentence matching.
  // Sample across the whole prompt so terms late in a long message still participate.
  const trigramCount = compact.length - 2;
  const step = Math.max(1, trigramCount / MEMORY_FTS_MAX_TRIGRAMS);
  for (let i = 0; i < trigramCount; i += step) add(compact.slice(Math.floor(i), Math.floor(i) + 3));
  return grams.length ? grams.map((term) => `"${term.replaceAll('"', '""')}"`).join(" OR ") : null;
}

export class MemoryRepository {
  constructor(private readonly db: AppDatabase) {}

  private get conn() { return this.db.connection; }

  get(id: string): MemoryRecordDto | undefined {
    const row = this.conn.prepare("SELECT * FROM memory_records WHERE id = ?").get(id) as MemoryRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  listAll(limit = 500): MemoryRecordDto[] {
    const rows = this.conn
      .prepare("SELECT * FROM memory_records ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(Math.max(1, Math.min(5000, limit))) as MemoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listByEvidence(evidenceKind: MemoryEvidenceDto["evidenceKind"], refId: string, limit = 200): MemoryRecordDto[] {
    const rows = this.conn.prepare(
      `SELECT DISTINCT m.*
       FROM memory_records m
       JOIN memory_evidence e ON e.memory_id=m.id
       WHERE e.evidence_kind=? AND e.ref_id=?
       ORDER BY m.updated_at DESC,m.id DESC
       LIMIT ?`,
    ).all(evidenceKind, refId, Math.max(1, Math.min(1000, limit))) as MemoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  /** Cross-scope browse query for the settings explorer; filters apply to the whole store, not a scope chain. */
  listFiltered(input: MemoryListRequest = {}): MemoryRecordDto[] {
    const where: string[] = [];
    const args: unknown[] = [];
    if (input.kind) { where.push("m.kind = ?"); args.push(input.kind); }
    if (input.status) { where.push("m.status = ?"); args.push(input.status); }
    if (input.scopeType) {
      where.push(`EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id = m.id AND s.scope_type = ?${input.scopeId !== undefined ? " AND s.scope_id = ?" : ""})`);
      args.push(input.scopeType);
      if (input.scopeId !== undefined) args.push(input.scopeId);
    }
    const q = input.query?.trim();
    if (q) {
      where.push("(m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')");
      const escaped = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      args.push(escaped, escaped);
    }
    const limit = Math.max(1, Math.min(5000, input.limit ?? 500));
    const offset = Math.max(0, input.offset ?? 0);
    const rows = this.conn.prepare(
      `SELECT m.* FROM memory_records m
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset) as MemoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  /** Complete exact-scope enumeration for reconciliation; never a top-N sample. */
  listScopeRecords(scopeType: MemoryScopeType, scopeId?: string, status: MemoryStatus = "active"): MemoryRecordDto[] {
    const rows = this.conn.prepare(`SELECT m.* FROM memory_records m WHERE m.status=? AND EXISTS (
      SELECT 1 FROM memory_scopes s WHERE s.memory_id=m.id AND s.scope_type=? AND COALESCE(s.scope_id,'')=?
    ) ORDER BY m.id`).all(status, scopeType, scopeId ?? "") as MemoryRow[];
    return rows.map(row => this.hydrate(row));
  }

  listByScopes(input: {
    scopes: Array<{ scopeType: MemoryScopeType; scopeId?: string; distance?: number }>;
    statuses?: MemoryStatus[];
    kinds?: MemoryRecordDto["kind"][];
    query?: string;
    limit?: number;
  }): Array<{ memory: MemoryRecordDto; scopeType: MemoryScopeType; scopeId?: string; binding: "owned" | "promoted" }> {
    if (input.scopes.length === 0) return [];
    const scopeClauses: string[] = [];
    const args: unknown[] = [];
    for (const scope of input.scopes) {
      if (scope.scopeType === "global") {
        scopeClauses.push("(s.scope_type = 'global' AND s.scope_id IS NULL)");
      } else {
        scopeClauses.push("(s.scope_type = ? AND s.scope_id = ?)");
        args.push(scope.scopeType, scope.scopeId ?? "");
      }
    }
    const where = [`(${scopeClauses.join(" OR ")})`];
    if (input.statuses?.length) {
      where.push(`m.status IN (${input.statuses.map(() => "?").join(",")})`);
      args.push(...input.statuses);
    }
    if (input.kinds?.length) {
      where.push(`m.kind IN (${input.kinds.map(() => "?").join(",")})`);
      args.push(...input.kinds);
    }
    const q = input.query?.trim();
    if (q) {
      where.push("(m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')");
      const escaped = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      args.push(escaped, escaped);
    }
    const limit = Math.max(1, Math.min(2000, input.limit ?? 100));
    args.push(limit);
    const rows = this.conn.prepare(
      `SELECT m.*, s.scope_type AS matched_scope_type, s.scope_id AS matched_scope_id, s.binding AS matched_binding
       FROM memory_records m
       JOIN memory_scopes s ON s.memory_id = m.id
       WHERE ${where.join(" AND ")}
       ORDER BY m.importance DESC, m.explicit DESC, m.updated_at DESC
       LIMIT ?`,
    ).all(...args) as Array<MemoryRow & {
      matched_scope_type: MemoryScopeType;
      matched_scope_id: string | null;
      matched_binding: "owned" | "promoted";
    }>;
    const seen = new Set<string>();
    const out: Array<{ memory: MemoryRecordDto; scopeType: MemoryScopeType; scopeId?: string; binding: "owned" | "promoted" }> = [];
    for (const row of rows) {
      const key = `${row.id}:${row.matched_scope_type}:${row.matched_scope_id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        memory: this.hydrate(row),
        scopeType: row.matched_scope_type,
        scopeId: row.matched_scope_id ?? undefined,
        binding: row.matched_binding,
      });
    }
    return out;
  }

  searchFts(query: string, allowedMemoryIds: readonly string[], limit = 80): Array<{ memoryId: string; rank: number; bm25: number }> {
    const ftsQuery = buildMemoryFtsQuery(query);
    const allowed = [...new Set(allowedMemoryIds)].filter(Boolean);
    if (!ftsQuery || !allowed.length) return [];
    try {
      const scored = new Map<string, number>();
      const batchSize = 300;
      for (let offset = 0; offset < allowed.length; offset += batchSize) {
        const batch = allowed.slice(offset, offset + batchSize);
        const placeholders = batch.map(() => "?").join(",");
        const rows = this.conn.prepare(
          `SELECT memory_id,bm25(memory_fts,0.0,3.0,1.0) AS score
           FROM memory_fts
           WHERE memory_fts MATCH ? AND memory_id IN (${placeholders})
           ORDER BY score LIMIT ?`,
        ).all(ftsQuery, ...batch, Math.max(limit * 3, 100)) as Array<{ memory_id: string; score: number }>;
        for (const row of rows) {
          const prev = scored.get(row.memory_id);
          if (prev === undefined || row.score < prev) scored.set(row.memory_id, row.score);
        }
      }
      return [...scored.entries()]
        .sort((a, b) => a[1] - b[1])
        .slice(0, Math.max(1, Math.min(200, limit)))
        .map(([memoryId, bm25], rank) => ({ memoryId, bm25, rank: rank + 1 }));
    } catch {
      return [];
    }
  }

  insert(record: MemoryRecordDto): MemoryRecordDto {
    this.conn.transaction(() => this.insertWithinTransaction(record))();
    return this.get(record.id)!;
  }

  private insertWithinTransaction(record: MemoryRecordDto): void {
    this.conn.prepare(
        `INSERT INTO memory_records (
          id, kind, title, content, status, importance, confidence, explicit,
          source_type, source_id, source_task_id, valid_from, valid_until, content_hash,
          created_at, updated_at, last_recalled_at, recall_count, metadata_json
        ) VALUES (
          @id, @kind, @title, @content, @status, @importance, @confidence, @explicit,
          @sourceType, @sourceId, @sourceTaskId, @validFrom, @validUntil, @contentHash,
          @createdAt, @updatedAt, @lastRecalledAt, @recallCount, @metadataJson
        )`,
    ).run({
      ...record,
      explicit: record.explicit ? 1 : 0,
      sourceId: record.sourceId ?? null,
      sourceTaskId: record.sourceTaskId ?? null,
      validFrom: record.validFrom ?? null,
      validUntil: record.validUntil ?? null,
      lastRecalledAt: record.lastRecalledAt ?? null,
      metadataJson: JSON.stringify(record.metadata ?? {}),
    });
    for (const scope of record.scopes) this.addScope(scope);
    for (const evidence of record.evidence) this.addEvidence(evidence);
    for (const relation of record.relations) this.addRelation(relation);
    this.insertRevision(record, record.sourceType, "created");
  }

  update(record: MemoryRecordDto, changedBy: MemoryRecordDto["sourceType"], changeReason?: string): MemoryRecordDto {
    const before = this.get(record.id);
    if (!before) throw new Error(`记忆不存在：${record.id}`);
    this.conn.transaction(() => this.updateWithinTransaction(record, changedBy, changeReason))();
    return this.get(record.id)!;
  }

  private updateWithinTransaction(
    record: MemoryRecordDto,
    changedBy: MemoryRecordDto["sourceType"],
    changeReason?: string,
  ): void {
    this.conn.prepare(
        `UPDATE memory_records SET
          kind=@kind, title=@title, content=@content, status=@status,
          importance=@importance, confidence=@confidence, explicit=@explicit,
          valid_from=@validFrom, valid_until=@validUntil, content_hash=@contentHash,
          updated_at=@updatedAt, metadata_json=@metadataJson
         WHERE id=@id`,
    ).run({
      id: record.id,
      kind: record.kind,
      title: record.title,
      content: record.content,
      status: record.status,
      importance: record.importance,
      confidence: record.confidence,
      explicit: record.explicit ? 1 : 0,
      validFrom: record.validFrom ?? null,
      validUntil: record.validUntil ?? null,
      contentHash: record.contentHash,
      updatedAt: record.updatedAt,
      metadataJson: JSON.stringify(record.metadata ?? {}),
    });
    this.insertRevision(record, changedBy, changeReason ?? "updated");
  }

  /**
   * L1 replacement is one durable state transition. A crash can never expose the
   * replacement without superseding the old record (or vice versa).
   */
  supersede(
    oldRecord: MemoryRecordDto,
    replacement: MemoryRecordDto,
    relation: MemoryRelationDto,
    changedBy: MemoryRecordDto["sourceType"],
    changeReason: string,
  ): MemoryRecordDto {
    if (!this.get(oldRecord.id)) throw new Error(`被替代记忆不存在：${oldRecord.id}`);
    this.conn.transaction(() => {
      this.insertWithinTransaction(replacement);
      this.updateWithinTransaction(oldRecord, changedBy, changeReason);
      this.addRelation(relation);
    })();
    return this.get(replacement.id)!;
  }

  addScope(scope: MemoryScopeDto): void {
    this.conn.prepare(
      `INSERT OR IGNORE INTO memory_scopes
       (id, memory_id, scope_type, scope_id, binding, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), scope.memoryId, scope.scopeType, scope.scopeId ?? null, scope.binding, scope.createdAt);
  }

  removeScope(memoryId: string, scopeType: MemoryScopeType, scopeId?: string): void {
    if (scopeType === "global") {
      this.conn.prepare("DELETE FROM memory_scopes WHERE memory_id=? AND scope_type='global' AND scope_id IS NULL").run(memoryId);
    } else {
      this.conn.prepare("DELETE FROM memory_scopes WHERE memory_id=? AND scope_type=? AND scope_id=?").run(memoryId, scopeType, scopeId ?? "");
    }
  }

  addEvidence(evidence: MemoryEvidenceDto): void {
    this.conn.prepare(
      `INSERT INTO memory_evidence
       (id, memory_id, evidence_kind, ref_id, ref_title, excerpt, created_at)
       VALUES (@id,@memoryId,@evidenceKind,@refId,@refTitle,@excerpt,@createdAt)
       ON CONFLICT(memory_id, evidence_kind, ref_id) DO NOTHING`,
    ).run({ ...evidence, refTitle: evidence.refTitle ?? null, excerpt: evidence.excerpt ?? null });
  }

  addRelation(relation: MemoryRelationDto): void {
    this.conn.prepare(
      `INSERT OR IGNORE INTO memory_relations
       (id, from_memory_id, relation, to_memory_id, created_at)
       VALUES (@id,@fromMemoryId,@relation,@toMemoryId,@createdAt)`,
    ).run(relation);
  }

  listRevisions(memoryId: string): MemoryRevisionDto[] {
    return (this.conn.prepare(
      `SELECT id, memory_id, revision, kind, title, content, status, importance, confidence,
              valid_from, valid_until, changed_by, change_reason, created_at
       FROM memory_revisions WHERE memory_id=? ORDER BY revision DESC`,
    ).all(memoryId) as Array<{
      id: string; memory_id: string; revision: number; kind: MemoryRevisionDto["kind"];
      title: string; content: string; status: MemoryRevisionDto["status"]; importance: number;
      confidence: number; valid_from: number | null; valid_until: number | null;
      changed_by: MemoryRevisionDto["changedBy"]; change_reason: string | null; created_at: number;
    }>).map((row) => ({
      id: row.id,
      memoryId: row.memory_id,
      revision: row.revision,
      kind: row.kind,
      title: row.title,
      content: row.content,
      status: row.status,
      importance: row.importance,
      confidence: row.confidence,
      validFrom: row.valid_from ?? undefined,
      validUntil: row.valid_until ?? undefined,
      changedBy: row.changed_by,
      changeReason: row.change_reason ?? undefined,
      createdAt: row.created_at,
    }));
  }

  hardDelete(id: string): void {
    this.conn.transaction(() => {
      this.conn.prepare("DELETE FROM memory_relations WHERE from_memory_id=? OR to_memory_id=?").run(id, id);
      this.conn.prepare("DELETE FROM memory_embeddings WHERE memory_id=?").run(id);
      this.conn.prepare("DELETE FROM memory_candidates WHERE resolved_memory_id=?").run(id);
      this.conn.prepare("DELETE FROM memory_records WHERE id=?").run(id);
    })();
  }

  markRecalled(ids: string[], now = Date.now()): void {
    const unique = [...new Set(ids)].filter(Boolean);
    if (!unique.length) return;
    const stmt = this.conn.prepare(
      "UPDATE memory_records SET last_recalled_at=?, recall_count=recall_count+1 WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(now, id); })();
  }

  insertCandidate(candidate: MemoryCandidateDto): void {
    this.conn.prepare(
      `INSERT INTO memory_candidates (
        id, task_id, kind, title, content, scope_type, scope_id, confidence, importance,
        explicit, operation_hint, replaces, status, raw_json, created_at, resolved_at, resolved_memory_id
      ) VALUES (
        @id,@taskId,@kind,@title,@content,@scopeType,@scopeId,@confidence,@importance,
        @explicit,@operationHint,@replaces,@status,@rawJson,@createdAt,@resolvedAt,@resolvedMemoryId
      )`,
    ).run({
      ...candidate,
      scopeId: candidate.scopeId ?? null,
      explicit: candidate.explicit ? 1 : 0,
      replaces: candidate.replaces ?? null,
      rawJson: candidate.rawJson ?? null,
      resolvedAt: candidate.resolvedAt ?? null,
      resolvedMemoryId: null,
    });
  }

  resolveCandidate(id: string, status: MemoryCandidateDto["status"], resolvedMemoryId?: string): void {
    this.conn.prepare(
      "UPDATE memory_candidates SET status=?, resolved_at=?, resolved_memory_id=? WHERE id=?",
    ).run(status, Date.now(), resolvedMemoryId ?? null, id);
  }

  getCandidate(id: string): MemoryCandidateDto | undefined {
    const row = this.conn.prepare("SELECT * FROM memory_candidates WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapCandidate(row) : undefined;
  }

  /** Candidates left 'pending' by an interrupted extraction become reviewable instead of invisible. */
  reapStalePendingCandidates(olderThan: number): number {
    const result = this.conn.prepare(
      "UPDATE memory_candidates SET status='needs_review', resolved_at=? WHERE status='pending' AND created_at < ?",
    ).run(Date.now(), olderThan);
    return Number(result.changes ?? 0);
  }

  listCandidates(status?: MemoryCandidateDto["status"], limit = 200): MemoryCandidateDto[] {
    const rows = (status
      ? this.conn.prepare("SELECT * FROM memory_candidates WHERE status=? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : this.conn.prepare("SELECT * FROM memory_candidates ORDER BY created_at DESC LIMIT ?").all(limit)) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapCandidate(row));
  }

  private mapCandidate(row: Record<string, unknown>): MemoryCandidateDto {
    return {
      id: String(row.id),
      taskId: String(row.task_id),
      kind: row.kind as MemoryCandidateDto["kind"],
      title: String(row.title),
      content: String(row.content),
      scopeType: row.scope_type as MemoryCandidateDto["scopeType"],
      scopeId: row.scope_id ? String(row.scope_id) : undefined,
      confidence: Number(row.confidence),
      importance: Number(row.importance),
      explicit: Boolean(row.explicit),
      operationHint: row.operation_hint as MemoryCandidateDto["operationHint"],
      replaces: row.replaces ? String(row.replaces) : undefined,
      status: row.status as MemoryCandidateDto["status"],
      rawJson: row.raw_json ? String(row.raw_json) : undefined,
      createdAt: Number(row.created_at),
      resolvedAt: row.resolved_at == null ? undefined : Number(row.resolved_at),
    };
  }

  stats(): { total: number; active: number; recalled: number; byKind: Record<string, number>; byScope: Record<string, number>; candidates: Record<string, number>; l0Turns: number; pendingTurns: number; failedTurns: number; scenarios: number; coreProfiles: number; skillCandidates: number; readySkillCandidates: number; skillExposures: number; skillInvocations: number; skillNegativeFeedback: number; skillRevisionCandidates: number; readySkillRevisionCandidates: number } {
    const total = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_records").get() as { n: number }).n);
    const active = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_records WHERE status='active'").get() as { n: number }).n);
    const recalled = Number((this.conn.prepare("SELECT COALESCE(SUM(recall_count),0) n FROM memory_records").get() as { n: number }).n);
    const byKind = Object.fromEntries((this.conn.prepare("SELECT kind,COUNT(1) n FROM memory_records GROUP BY kind").all() as Array<{ kind: string; n: number }>).map((r) => [r.kind, r.n]));
    const byScope = Object.fromEntries((this.conn.prepare("SELECT scope_type,COUNT(DISTINCT memory_id) n FROM memory_scopes GROUP BY scope_type").all() as Array<{ scope_type: string; n: number }>).map((r) => [r.scope_type, r.n]));
    const candidates = Object.fromEntries((this.conn.prepare("SELECT status,COUNT(1) n FROM memory_candidates GROUP BY status").all() as Array<{ status: string; n: number }>).map((r) => [r.status, r.n]));
    const l0Turns = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_turns").get() as { n: number }).n);
    // pendingTurns mirrors listPending's retry cap; turns that exhausted attempts surface as failedTurns.
    const pendingTurns = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_turns WHERE extraction_state='pending' OR (extraction_state='failed' AND attempt_count < 3)").get() as { n: number }).n);
    const failedTurns = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_turns WHERE extraction_state='failed' AND attempt_count >= 3").get() as { n: number }).n);
    const scenarios = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_scenarios WHERE status='active'").get() as { n: number }).n);
    const coreProfiles = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_core_profiles WHERE status='active'").get() as { n: number }).n);
    const skillCandidates = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_skill_candidates WHERE status IN ('draft','ready')").get() as { n: number }).n);
    const readySkillCandidates = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_skill_candidates WHERE status='ready'").get() as { n: number }).n);
    const skillExposures = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_skill_effectiveness").get() as { n: number }).n);
    const skillInvocations = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_skill_effectiveness WHERE invoked_at IS NOT NULL").get() as { n: number }).n);
    const skillNegativeFeedback = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_skill_effectiveness WHERE feedback_kind IN ('needs_revision','incorrect')").get() as { n: number }).n);
    const skillRevisionCandidates = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_skill_revision_candidates WHERE status IN ('draft','ready')").get() as { n: number }).n);
    const readySkillRevisionCandidates = Number((this.conn.prepare("SELECT COUNT(1) n FROM memory_skill_revision_candidates WHERE status='ready'").get() as { n: number }).n);
    return { total, active, recalled, byKind, byScope, candidates, l0Turns, pendingTurns, failedTurns, scenarios, coreProfiles, skillCandidates, readySkillCandidates, skillExposures, skillInvocations, skillNegativeFeedback, skillRevisionCandidates, readySkillRevisionCandidates };
  }

  private hydrate(row: MemoryRow): MemoryRecordDto {
    const scopes = (this.conn.prepare(
      "SELECT memory_id,scope_type,scope_id,binding,created_at FROM memory_scopes WHERE memory_id=? ORDER BY created_at",
    ).all(row.id) as Array<{ memory_id: string; scope_type: MemoryScopeType; scope_id: string | null; binding: "owned" | "promoted"; created_at: number }>).map((s) => ({
      memoryId: s.memory_id,
      scopeType: s.scope_type,
      scopeId: s.scope_id ?? undefined,
      binding: s.binding,
      createdAt: s.created_at,
    }));
    const evidence = (this.conn.prepare(
      "SELECT id,memory_id,evidence_kind,ref_id,ref_title,excerpt,created_at FROM memory_evidence WHERE memory_id=? ORDER BY created_at",
    ).all(row.id) as Array<{ id: string; memory_id: string; evidence_kind: MemoryEvidenceDto["evidenceKind"]; ref_id: string; ref_title: string | null; excerpt: string | null; created_at: number }>).map((e) => ({
      id: e.id,
      memoryId: e.memory_id,
      evidenceKind: e.evidence_kind,
      refId: e.ref_id,
      refTitle: e.ref_title ?? undefined,
      excerpt: e.excerpt ?? undefined,
      createdAt: e.created_at,
    }));
    const relations = (this.conn.prepare(
      "SELECT id,from_memory_id,relation,to_memory_id,created_at FROM memory_relations WHERE from_memory_id=? OR to_memory_id=? ORDER BY created_at",
    ).all(row.id, row.id) as Array<{ id: string; from_memory_id: string; relation: MemoryRelationDto["relation"]; to_memory_id: string; created_at: number }>).map((r) => ({
      id: r.id,
      fromMemoryId: r.from_memory_id,
      relation: r.relation,
      toMemoryId: r.to_memory_id,
      createdAt: r.created_at,
    }));
    return {
      id: row.id,
      kind: row.kind,
      title: row.title,
      content: row.content,
      status: row.status,
      importance: row.importance,
      confidence: row.confidence,
      explicit: Boolean(row.explicit),
      sourceType: row.source_type,
      sourceId: row.source_id ?? undefined,
      sourceTaskId: row.source_task_id ?? undefined,
      validFrom: row.valid_from ?? undefined,
      validUntil: row.valid_until ?? undefined,
      contentHash: row.content_hash,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      lastRecalledAt: row.last_recalled_at ?? undefined,
      recallCount: row.recall_count,
      metadata: parseObject(row.metadata_json),
      scopes,
      evidence,
      relations,
    };
  }

  private insertRevision(record: MemoryRecordDto, changedBy: MemoryRecordDto["sourceType"], reason?: string): void {
    const revision = Number((this.conn.prepare(
      "SELECT COALESCE(MAX(revision),0)+1 n FROM memory_revisions WHERE memory_id=?",
    ).get(record.id) as { n: number }).n);
    this.conn.prepare(
      `INSERT INTO memory_revisions (
        id,memory_id,revision,kind,title,content,status,importance,confidence,
        valid_from,valid_until,changed_by,change_reason,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      randomUUID(), record.id, revision, record.kind, record.title, record.content, record.status,
      record.importance, record.confidence, record.validFrom ?? null, record.validUntil ?? null,
      changedBy, reason ?? null, Date.now(),
    );
  }
}
