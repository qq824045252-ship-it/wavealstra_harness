import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppDatabase } from "../db/AppDatabase";
import { memoryListScopeWhere, type MemorySearchScope } from "./MemorySearchScope";
import { buildMemoryFtsQuery, normalizeSearchText } from "./MemorySearchText";
import { MemoryQueryCandidates } from "./MemoryQueryCandidates";
import { memoryListQuery, memoryMetadata, memoryRecordFromWire } from "./MemoryRecordsData";
import type {
  MemoryCandidateDto,
  MemoryEvidenceDto,
  MemoryKernelStats,
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

const normalizedConnections = new WeakSet<object>();

export class MemoryRepository {
  private readonly prepared?: {
    record: Database.Statement<[string], MemoryRow>;
    scopes: Database.Statement<[string]>;
    evidence: Database.Statement<[string]>;
    relations: Database.Statement<[string, string]>;
  };
  private writeTail: Promise<void> = Promise.resolve();
  private pendingWriteCount = 0;
  private readonly pendingRecords = new Map<string, MemoryRecordDto | null>();
  private readonly pendingCandidates = new Map<string, MemoryCandidateDto | null>();

  constructor(private readonly db: AppDatabase) {
    const fixture = db.fixtureConnection;
    if (!fixture) return;
    this.prepared = {
      record: fixture.prepare("SELECT * FROM memory_records WHERE id = ?"),
      scopes: fixture.prepare("SELECT memory_id,scope_type,scope_id,binding,created_at FROM memory_scopes WHERE memory_id=? ORDER BY created_at"),
      evidence: fixture.prepare("SELECT id,memory_id,evidence_kind,ref_id,ref_title,excerpt,created_at FROM memory_evidence WHERE memory_id=? ORDER BY created_at"),
      relations: fixture.prepare("SELECT id,from_memory_id,relation,to_memory_id,created_at FROM memory_relations WHERE from_memory_id=? OR to_memory_id=? ORDER BY created_at"),
    };
    if (!normalizedConnections.has(fixture)) {
      fixture.function("memory_search_normalize", { deterministic: true },
        (value: unknown) => typeof value === "string" ? normalizeSearchText(value) : "");
      normalizedConnections.add(fixture);
    }
  }

  private get conn() { return this.db.connection; }

  private get fixtureQueries() {
    if (!this.prepared) throw new Error("记忆记录需要通过 Rust Core 读取");
    return this.prepared;
  }

  private get requiresRustWrites(): boolean {
    return Boolean(this.db.readonly || this.db.runtimeAuditReader?.supervised);
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private enqueueBatch3(context: string, request: Record<string, unknown>): void {
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error(`${context}：Rust 写入核心未就绪`);
    this.pendingWriteCount += 1;
    const next = this.writeTail.then(async () => {
      try {
        const result = await reader.batch3Write(request);
        if (result === undefined) throw new Error(`${context}：Rust 写入未收到确认`);
      } finally {
        this.pendingWriteCount -= 1;
        if (this.pendingWriteCount === 0) {
          this.pendingRecords.clear();
          this.pendingCandidates.clear();
        }
      }
    });
    this.writeTail = next.then(() => undefined, () => undefined);
  }

  queueWorkSnapshotRepairMeta(memoryId: string, sourceKey: string): void {
    this.enqueueBatch3("修复 Work 记忆元数据", {
      kind: "workMemoryRepairMeta",
      memoryId,
      sourceKey,
      updatedAt: Date.now(),
    });
    const cached = this.pendingRecords.get(memoryId) ?? this.get(memoryId);
    if (cached) {
      this.pendingRecords.set(memoryId, {
        ...cached,
        sourceType: "event",
        sourceId: undefined,
        sourceTaskId: undefined,
      });
    }
  }

  private async runBatch3<T = Record<string, unknown>>(context: string, request: Record<string, unknown>): Promise<T> {
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error(`${context}：Rust 写入核心未就绪`);
    const next = this.writeTail.then(async () => {
      const result = await reader.batch3Write<T>(request);
      if (result === undefined) throw new Error(`${context}：Rust 写入未收到确认`);
      return result;
    });
    this.writeTail = next.then(() => undefined, () => undefined);
    return next;
  }

  private toRustRecord(record: MemoryRecordDto) {
    return {
      id: record.id,
      kind: record.kind,
      title: record.title,
      content: record.content,
      status: record.status,
      importance: record.importance,
      confidence: record.confidence,
      explicit: record.explicit,
      sourceType: record.sourceType,
      sourceId: record.sourceId ?? null,
      sourceTaskId: record.sourceTaskId ?? null,
      validFrom: record.validFrom ?? null,
      validUntil: record.validUntil ?? null,
      contentHash: record.contentHash,
      createdAt: record.createdAt,
      updatedAt: record.updatedAt,
      lastRecalledAt: record.lastRecalledAt ?? null,
      recallCount: record.recallCount,
      metadataJson: JSON.stringify(record.metadata ?? {}),
      scopes: record.scopes.map((s) => ({
        id: randomUUID(),
        memoryId: s.memoryId,
        scopeType: s.scopeType,
        scopeId: s.scopeId ?? null,
        binding: s.binding,
        createdAt: s.createdAt,
      })),
      evidence: record.evidence.map((e) => ({
        id: e.id,
        memoryId: e.memoryId,
        evidenceKind: e.evidenceKind,
        refId: e.refId,
        refTitle: e.refTitle ?? null,
        excerpt: e.excerpt ?? null,
        createdAt: e.createdAt,
      })),
      relations: record.relations.map((r) => ({
        id: r.id,
        fromMemoryId: r.fromMemoryId,
        relation: r.relation,
        toMemoryId: r.toMemoryId,
        createdAt: r.createdAt,
      })),
    };
  }

  get(id: string): MemoryRecordDto | undefined {
    if (this.pendingRecords.has(id)) {
      return this.pendingRecords.get(id) ?? undefined;
    }
    const row = this.fixtureQueries.record.get(id);
    return row ? this.hydrate(row) : undefined;
  }

  async readDetail(id: string): Promise<MemoryRecordDto | undefined> {
    const data = await this.db.runtimeAuditReader?.memoryRecordsData({ kind: "detail", id });
    if (data?.kind !== "detail") return this.get(id);
    return data.record ? memoryRecordFromWire(data.record) : undefined;
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

  async readForTurn(turnId: string): Promise<MemoryRecordDto[]> {
    const data = await this.db.runtimeAuditReader?.memoryRecordsData({ kind: "forTurn", turnId });
    if (data?.kind === "forTurn") return data.records.map(memoryRecordFromWire);
    if (!this.db.fixtureConnection) throw new Error("Core 未确认对话关联记忆");
    return this.listByEvidence("conversation", turnId, 500);
  }

  /** Cross-scope browse query for the settings explorer; filters apply to the whole store, not a scope chain. */
  listFiltered(input: MemoryListRequest = {}): MemoryRecordDto[] {
    const { recordKind, status, scopeType, scopeId, pattern, limit, offset } = memoryListQuery(input);
    const where: string[] = [];
    const args: unknown[] = [];
    if (recordKind) { where.push("m.kind = ?"); args.push(recordKind); }
    if (status) { where.push("m.status = ?"); args.push(status); }
    if (scopeType) {
      where.push(`EXISTS (SELECT 1 FROM memory_scopes s WHERE s.memory_id = m.id AND s.scope_type = ?${scopeId !== undefined ? " AND s.scope_id = ?" : ""})`);
      args.push(scopeType);
      if (scopeId !== undefined) args.push(scopeId);
    }
    if (pattern) {
      where.push("(m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')");
      args.push(pattern, pattern);
    }
    const rows = this.conn.prepare(
      `SELECT m.* FROM memory_records m
       ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
       ORDER BY m.updated_at DESC, m.id DESC
       LIMIT ? OFFSET ?`,
    ).all(...args, limit, offset) as MemoryRow[];
    return rows.map((row) => this.hydrate(row));
  }

  async readFiltered(input: MemoryListRequest): Promise<MemoryRecordDto[]> {
    const query = memoryListQuery(input);
    if (Number.isSafeInteger(query.limit) && Number.isSafeInteger(query.offset)) {
      const data = await this.db.runtimeAuditReader?.memoryRecordsData(query);
      if (data?.kind === "list") return data.records.map(memoryRecordFromWire);
    }
    if (!this.db.fixtureConnection) throw new Error("Core 未确认记忆列表读取");
    return this.listFiltered(input);
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
    const scope = memoryListScopeWhere(input);
    const args: Array<string | number> = scope.args;
    const where = [scope.sql];
    const q = input.query?.trim();
    if (q) {
      where.push("(m.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')");
      const escaped = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
      args.push(escaped, escaped);
    }
    // The scope-first join is costly for a large personal/global corpus with
    // only a few preferences. Probe the kind index with a bounded read before
    // choosing which side to start from. Both plans apply the same bindings.
    const kinds = input.kinds;
    const kindProbeLimit = 1024;
    const selectiveKinds = kinds?.length && Number(this.conn.prepare(`
      SELECT COUNT(*) FROM (
        SELECT 1 FROM memory_records INDEXED BY idx_memory_records_kind_updated
        WHERE kind IN (${kinds.map(() => "?").join(",")}) LIMIT ?
      )`).pluck().get(...kinds, kindProbeLimit + 1)) <= kindProbeLimit;
    const atomAndScope = selectiveKinds
      ? "memory_records m INDEXED BY idx_memory_records_kind_updated CROSS JOIN memory_scopes s"
      : "memory_records m JOIN memory_scopes s";
    const limit = Math.max(1, Math.min(2000, input.limit ?? 100));
    args.push(limit);
    const rows = this.conn.prepare(
      `SELECT m.*, s.scope_type AS matched_scope_type, s.scope_id AS matched_scope_id, s.binding AS matched_binding
       FROM ${atomAndScope} ON s.memory_id = m.id
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

  searchScoped(query: string, input: MemorySearchScope, limit: number, accept: (memory: MemoryRecordDto) => boolean) {
    return new MemoryQueryCandidates({ db: this.conn, repository: this, query, scope: input, limit, accept }).search();
  }

  searchScopedAsync(query: string, input: MemorySearchScope, limit: number, accept: (memory: MemoryRecordDto) => boolean) {
    return new MemoryQueryCandidates({ db: this.conn, repository: this, query, scope: input, limit, accept }).searchAsync(this.db.runtimeAuditReader);
  }

  insert(record: MemoryRecordDto, changeReason?: string): MemoryRecordDto {
    if (this.requiresRustWrites) {
      for (const scope of record.scopes) {
        if (scope.scopeType === "project") {
          const project = this.conn.prepare("SELECT archived FROM projects WHERE id=?").get(scope.scopeId) as { archived: number } | undefined;
          if (!project) throw new Error(`项目不存在：${scope.scopeId}`);
          if (project.archived) throw new Error("项目已归档（只读），不能写入项目记忆");
        }
      }
      this.enqueueBatch3("写入记忆", {
        kind: "memoryInsertRecord",
        record: this.toRustRecord(record),
        changeReason: changeReason ?? "created",
        revisionId: randomUUID(),
      });
      const saved: MemoryRecordDto = {
        ...record,
        metadata: { ...(record.metadata ?? {}) },
        scopes: record.scopes.map((s) => ({ ...s })),
        evidence: record.evidence.map((e) => ({ ...e })),
        relations: record.relations.map((r) => ({ ...r })),
      };
      this.pendingRecords.set(record.id, saved);
      return saved;
    }
    this.conn.transaction(() => this.insertWithinTransaction(record, changeReason))();
    return this.get(record.id)!;
  }

  private insertWithinTransaction(record: MemoryRecordDto, changeReason = "created"): void {
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
    this.insertRevision(record, record.sourceType, changeReason);
  }

  update(record: MemoryRecordDto, changedBy: MemoryRecordDto["sourceType"], changeReason?: string): MemoryRecordDto {
    const before = this.get(record.id);
    if (!before) throw new Error(`记忆不存在：${record.id}`);
    if (this.requiresRustWrites) {
      this.enqueueBatch3("更新记忆", {
        kind: "memoryUpdateRecord",
        id: record.id,
        memoryKind: record.kind,
        title: record.title,
        content: record.content,
        status: record.status,
        importance: record.importance,
        confidence: record.confidence,
        explicit: record.explicit,
        validFrom: record.validFrom ?? null,
        validUntil: record.validUntil ?? null,
        contentHash: record.contentHash,
        updatedAt: record.updatedAt,
        metadataJson: JSON.stringify(record.metadata ?? {}),
        changedBy,
        changeReason: changeReason ?? "updated",
        revisionId: randomUUID(),
      });
      const saved: MemoryRecordDto = {
        ...before,
        ...record,
        metadata: { ...(record.metadata ?? {}) },
        scopes: [...before.scopes],
        evidence: [...before.evidence],
        relations: [...before.relations],
      };
      this.pendingRecords.set(record.id, saved);
      return saved;
    }
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
    replacementReason?: string,
  ): MemoryRecordDto {
    if (!this.get(oldRecord.id)) throw new Error(`被替代记忆不存在：${oldRecord.id}`);
    if (this.requiresRustWrites) {
      for (const scope of replacement.scopes) {
        if (scope.scopeType === "project") {
          const project = this.conn.prepare("SELECT archived FROM projects WHERE id=?").get(scope.scopeId) as { archived: number } | undefined;
          if (!project) throw new Error(`项目不存在：${scope.scopeId}`);
          if (project.archived) throw new Error("项目已归档（只读），不能写入项目记忆");
        }
      }
      this.enqueueBatch3("替换记忆", {
        kind: "memorySupersede",
        oldId: oldRecord.id,
        oldStatus: oldRecord.status,
        oldValidUntil: oldRecord.validUntil ?? null,
        oldUpdatedAt: oldRecord.updatedAt,
        oldKind: oldRecord.kind,
        oldTitle: oldRecord.title,
        oldContent: oldRecord.content,
        oldImportance: oldRecord.importance,
        oldConfidence: oldRecord.confidence,
        oldExplicit: oldRecord.explicit,
        oldValidFrom: oldRecord.validFrom ?? null,
        oldContentHash: oldRecord.contentHash,
        oldMetadataJson: JSON.stringify(oldRecord.metadata ?? {}),
        oldRevisionId: randomUUID(),
        changedBy,
        changeReason,
        replacement: this.toRustRecord(replacement),
        replacementReason: replacementReason ?? "created",
        replacementRevisionId: randomUUID(),
        relation: {
          id: relation.id,
          fromMemoryId: relation.fromMemoryId,
          relation: relation.relation,
          toMemoryId: relation.toMemoryId,
          createdAt: relation.createdAt,
        },
      });
      const saved: MemoryRecordDto = {
        ...replacement,
        metadata: { ...(replacement.metadata ?? {}) },
        scopes: replacement.scopes.map((s) => ({ ...s })),
        evidence: replacement.evidence.map((e) => ({ ...e })),
        relations: replacement.relations.map((r) => ({ ...r })),
      };
      const priorOld = this.get(oldRecord.id);
      if (priorOld) {
        this.pendingRecords.set(oldRecord.id, {
          ...priorOld,
          ...oldRecord,
          metadata: { ...(oldRecord.metadata ?? {}) },
        });
      }
      this.pendingRecords.set(replacement.id, saved);
      return saved;
    }
    this.conn.transaction(() => {
      this.insertWithinTransaction(replacement, replacementReason);
      this.updateWithinTransaction(oldRecord, changedBy, changeReason);
      this.addRelation(relation);
    })();
    return this.get(replacement.id)!;
  }

  addScope(scope: MemoryScopeDto): void {
    if (this.requiresRustWrites) {
      if (scope.scopeType === "project") {
        const project = this.conn.prepare("SELECT archived FROM projects WHERE id=?").get(scope.scopeId) as { archived: number } | undefined;
        if (!project) throw new Error(`项目不存在：${scope.scopeId}`);
        if (project.archived) throw new Error("项目已归档（只读），不能写入项目记忆");
      }
      this.enqueueBatch3("绑定记忆范围", {
        kind: "memoryAddScope",
        id: randomUUID(),
        memoryId: scope.memoryId,
        scopeType: scope.scopeType,
        scopeId: scope.scopeId ?? null,
        binding: scope.binding,
        createdAt: scope.createdAt,
      });
      const cached = this.get(scope.memoryId);
      if (cached && !cached.scopes.some((s) => s.scopeType === scope.scopeType && (s.scopeId ?? "") === (scope.scopeId ?? ""))) {
        this.pendingRecords.set(scope.memoryId, { ...cached, scopes: [...cached.scopes, { ...scope }] });
      }
      return;
    }
    const insert = () => this.conn.prepare(
      `INSERT OR IGNORE INTO memory_scopes
       (id, memory_id, scope_type, scope_id, binding, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), scope.memoryId, scope.scopeType, scope.scopeId ?? null, scope.binding, scope.createdAt);
    if (scope.scopeType !== "project") {
      insert();
      return;
    }
    this.conn.transaction(() => {
      const project = this.conn.prepare("SELECT archived FROM projects WHERE id=?").get(scope.scopeId) as { archived: number } | undefined;
      if (!project) throw new Error(`项目不存在：${scope.scopeId}`);
      if (project.archived) throw new Error("项目已归档（只读），不能写入项目记忆");
      insert();
    }).immediate();
  }

  removeScope(memoryId: string, scopeType: MemoryScopeType, scopeId?: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("移除记忆范围", {
        kind: "memoryRemoveScope",
        memoryId,
        scopeType,
        scopeId: scopeType === "global" ? null : (scopeId ?? ""),
      });
      const cached = this.get(memoryId);
      if (cached) {
        this.pendingRecords.set(memoryId, {
          ...cached,
          scopes: cached.scopes.filter((s) => !(s.scopeType === scopeType && (s.scopeId ?? "") === (scopeId ?? ""))),
        });
      }
      return;
    }
    if (scopeType === "global") {
      this.conn.prepare("DELETE FROM memory_scopes WHERE memory_id=? AND scope_type='global' AND scope_id IS NULL").run(memoryId);
    } else {
      this.conn.prepare("DELETE FROM memory_scopes WHERE memory_id=? AND scope_type=? AND scope_id=?").run(memoryId, scopeType, scopeId ?? "");
    }
  }

  removeAllScopes(memoryId: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("清空记忆范围", {
        kind: "memoryRemoveScope",
        memoryId,
        scopeType: null,
        scopeId: null,
      });
      const cached = this.get(memoryId);
      if (cached) {
        this.pendingRecords.set(memoryId, { ...cached, scopes: [] });
      }
      return;
    }
    this.conn.prepare("DELETE FROM memory_scopes WHERE memory_id=?").run(memoryId);
  }

  addEvidence(evidence: MemoryEvidenceDto): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("添加记忆证据", {
        kind: "memoryAddEvidence",
        evidence: {
          id: evidence.id,
          memoryId: evidence.memoryId,
          evidenceKind: evidence.evidenceKind,
          refId: evidence.refId,
          refTitle: evidence.refTitle ?? null,
          excerpt: evidence.excerpt ?? null,
          createdAt: evidence.createdAt,
        },
      });
      const cached = this.get(evidence.memoryId);
      if (cached && !cached.evidence.some((e) => e.evidenceKind === evidence.evidenceKind && e.refId === evidence.refId)) {
        this.pendingRecords.set(evidence.memoryId, { ...cached, evidence: [...cached.evidence, { ...evidence }] });
      }
      return;
    }
    this.conn.prepare(
      `INSERT INTO memory_evidence
       (id, memory_id, evidence_kind, ref_id, ref_title, excerpt, created_at)
       VALUES (@id,@memoryId,@evidenceKind,@refId,@refTitle,@excerpt,@createdAt)
       ON CONFLICT(memory_id, evidence_kind, ref_id) DO NOTHING`,
    ).run({ ...evidence, refTitle: evidence.refTitle ?? null, excerpt: evidence.excerpt ?? null });
  }

  addRelation(relation: MemoryRelationDto): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("添加记忆关联", {
        kind: "memoryAddRelation",
        relation: {
          id: relation.id,
          fromMemoryId: relation.fromMemoryId,
          relation: relation.relation,
          toMemoryId: relation.toMemoryId,
          createdAt: relation.createdAt,
        },
      });
      for (const mid of [relation.fromMemoryId, relation.toMemoryId]) {
        const cached = this.get(mid);
        if (cached && !cached.relations.some((r) => r.id === relation.id)) {
          this.pendingRecords.set(mid, { ...cached, relations: [...cached.relations, { ...relation }] });
        }
      }
      return;
    }
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

  async readRevisions(memoryId: string): Promise<MemoryRevisionDto[]> {
    const data = await this.db.runtimeAuditReader?.memoryRecordsData({ kind: "history", id: memoryId });
    return data?.kind === "history"
      ? data.revisions.map(({ validFrom, validUntil, changeReason, ...revision }) => ({
          ...revision, validFrom: validFrom ?? undefined, validUntil: validUntil ?? undefined, changeReason: changeReason ?? undefined,
        }))
      : this.listRevisions(memoryId);
  }

  hardDelete(id: string): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("彻底删除记忆", { kind: "memoryHardDelete", id });
      this.pendingRecords.set(id, null);
      return;
    }
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
    if (this.requiresRustWrites) {
      this.enqueueBatch3("记录记忆召回", { kind: "memoryRecordRecall", ids: unique, now });
      for (const id of unique) {
        const cached = this.get(id);
        if (cached) {
          this.pendingRecords.set(id, {
            ...cached,
            lastRecalledAt: now,
            recallCount: cached.recallCount + 1,
          });
        }
      }
      return;
    }
    const stmt = this.conn.prepare(
      "UPDATE memory_records SET last_recalled_at=?, recall_count=recall_count+1 WHERE id=?",
    );
    this.conn.transaction(() => { for (const id of unique) stmt.run(now, id); })();
  }

  insertCandidate(candidate: MemoryCandidateDto): void {
    if (this.requiresRustWrites) {
      this.enqueueBatch3("写入候选记忆", {
        kind: "memoryInsertCandidate",
        id: candidate.id,
        taskId: candidate.taskId,
        memoryKind: candidate.kind,
        title: candidate.title,
        content: candidate.content,
        scopeType: candidate.scopeType,
        scopeId: candidate.scopeId ?? null,
        confidence: candidate.confidence,
        importance: candidate.importance,
        explicit: candidate.explicit,
        operationHint: candidate.operationHint,
        replaces: candidate.replaces ?? null,
        status: candidate.status,
        rawJson: candidate.rawJson ?? null,
        createdAt: candidate.createdAt,
        resolvedAt: candidate.resolvedAt ?? null,
      });
      this.pendingCandidates.set(candidate.id, { ...candidate });
      return;
    }
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
    const now = Date.now();
    if (this.requiresRustWrites) {
      this.enqueueBatch3("更新候选记忆状态", {
        kind: "memoryResolveCandidate",
        id,
        status,
        resolvedAt: now,
        resolvedMemoryId: resolvedMemoryId ?? null,
        pendingOnly: false,
      });
      const cached = this.getCandidate(id);
      if (cached) {
        this.pendingCandidates.set(id, { ...cached, status, resolvedAt: now });
      }
      return;
    }
    this.conn.prepare(
      "UPDATE memory_candidates SET status=?, resolved_at=?, resolved_memory_id=? WHERE id=?",
    ).run(status, now, resolvedMemoryId ?? null, id);
  }

  resolvePendingCandidate(id: string, status: "rejected" | "needs_review"): void {
    const now = Date.now();
    if (this.requiresRustWrites) {
      this.enqueueBatch3("处理待审核候选记忆", {
        kind: "memoryResolveCandidate",
        id,
        status,
        resolvedAt: now,
        resolvedMemoryId: null,
        pendingOnly: true,
      });
      const cached = this.getCandidate(id);
      if (cached && cached.status === "pending") {
        this.pendingCandidates.set(id, { ...cached, status, resolvedAt: now });
      }
      return;
    }
    this.conn.prepare(`UPDATE memory_candidates SET status=?, resolved_at=?, resolved_memory_id=NULL
      WHERE id=? AND status='pending'`).run(status, now, id);
  }

  getCandidate(id: string): MemoryCandidateDto | undefined {
    if (this.pendingCandidates.has(id)) {
      return this.pendingCandidates.get(id) ?? undefined;
    }
    const row = this.conn.prepare("SELECT * FROM memory_candidates WHERE id=?").get(id) as Record<string, unknown> | undefined;
    return row ? this.mapCandidate(row) : undefined;
  }

  /** Candidates left 'pending' by an interrupted extraction become reviewable instead of invisible. */
  reapStalePendingCandidates(olderThan: number): number {
    if (this.requiresRustWrites) {
      const staleCount = Number((this.conn.prepare(
        "SELECT COUNT(1) n FROM memory_candidates WHERE status='pending' AND created_at < ?",
      ).get(olderThan) as { n: number }).n);
      if (staleCount > 0) {
        this.enqueueBatch3("清理过期候选记忆", {
          kind: "memoryReapStaleCandidates",
          olderThan,
          now: Date.now(),
        });
      }
      return staleCount;
    }
    const result = this.conn.prepare(
      "UPDATE memory_candidates SET status='needs_review', resolved_at=? WHERE status='pending' AND created_at < ?",
    ).run(Date.now(), olderThan);
    return Number(result.changes ?? 0);
  }

  async recoverPendingCandidates(olderThan: number): Promise<number> {
    if (!this.requiresRustWrites) return this.reapStalePendingCandidates(olderThan);
    const result = await this.db.runtimeAuditReader?.batch3Write<{ changes: number }>({
      kind: "memoryReapStaleCandidates", olderThan, now: Date.now(),
    });
    if (!result) throw new Error("候选记忆启动恢复未获 Rust Core 确认");
    return result.changes;
  }

  listCandidates(status?: MemoryCandidateDto["status"], limit = 200): MemoryCandidateDto[] {
    const rows = (status
      ? this.conn.prepare("SELECT * FROM memory_candidates WHERE status=? ORDER BY created_at DESC LIMIT ?").all(status, limit)
      : this.conn.prepare("SELECT * FROM memory_candidates ORDER BY created_at DESC LIMIT ?").all(limit)) as Array<Record<string, unknown>>;
    return rows.map((row) => this.mapCandidate(row));
  }

  async readCandidates(status?: MemoryCandidateDto["status"], limit = 200): Promise<MemoryCandidateDto[]> {
    if (!this.db.inTransaction && Number.isSafeInteger(limit)) {
      const data = await this.db.runtimeAuditReader?.memoryRecordsData({ kind: "candidateList", status, limit });
      if (data?.kind === "candidateList") return data.candidates.map(row => this.mapCandidate(row));
    }
    return this.listCandidates(status, limit);
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

  async readStats(): Promise<MemoryKernelStats> {
    const data = await this.db.runtimeAuditReader?.memoryRecordsData({ kind: "stats" });
    return data?.kind === "stats" ? data.stats : this.stats();
  }

  stats(): MemoryKernelStats {
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
    const scopes = (this.fixtureQueries.scopes.all(row.id) as Array<{ memory_id: string; scope_type: MemoryScopeType; scope_id: string | null; binding: "owned" | "promoted"; created_at: number }>).map((s) => ({
      memoryId: s.memory_id,
      scopeType: s.scope_type,
      scopeId: s.scope_id ?? undefined,
      binding: s.binding,
      createdAt: s.created_at,
    }));
    const evidence = (this.fixtureQueries.evidence.all(row.id) as Array<{ id: string; memory_id: string; evidence_kind: MemoryEvidenceDto["evidenceKind"]; ref_id: string; ref_title: string | null; excerpt: string | null; created_at: number }>).map((e) => ({
      id: e.id,
      memoryId: e.memory_id,
      evidenceKind: e.evidence_kind,
      refId: e.ref_id,
      refTitle: e.ref_title ?? undefined,
      excerpt: e.excerpt ?? undefined,
      createdAt: e.created_at,
    }));
    const relations = (this.fixtureQueries.relations.all(row.id, row.id) as Array<{ id: string; from_memory_id: string; relation: MemoryRelationDto["relation"]; to_memory_id: string; created_at: number }>).map((r) => ({
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
      metadata: memoryMetadata(row.metadata_json),
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
