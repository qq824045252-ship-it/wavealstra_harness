/**
 * ArtifactRepository — V3.5 Wave 2（§6/§10/§68）+ P1 溯源/精确依赖
 *
 * 唯一持久真相：SQLite artifacts 表 metadata。
 * - commit point = insert/update transaction 成功提交（§10）
 * - version++ 由 Repository transaction 完成（重启后 version 仍正确）
 * - P1：created_by_* 首次写入后不可变；message refs / file dependencies 独立表
 * - 通过注入的 better-sqlite3 Database 使用现有 SQLite（测试可用 :memory:）
 */
import type { Database } from "better-sqlite3";
import type {
  ArtifactDescriptor,
  ArtifactFileDependency,
  ArtifactMessageRef,
  ArtifactMessageRelation,
  ArtifactSource,
} from "../../shared/artifact-types";

interface ArtifactRow {
  id: string;
  task_id: string;
  space_id: string | null;
  kind: string;
  source_type: "workspace-file" | "managed-content";
  entry_file: string | null;
  root_dir: string;
  storage_path: string | null;
  version: number;
  capabilities_json: string;
  title: string | null;
  mime_type: string | null;
  created_by_message_id: string | null;
  created_by_tool_call_id: string | null;
  created_at: number;
  updated_at: number;
}

function toDescriptor(row: ArtifactRow): ArtifactDescriptor {
  const source: ArtifactSource =
    row.source_type === "managed-content"
      ? { type: "managed-content", storagePath: row.storage_path ?? "", rootDir: row.root_dir }
      : { type: "workspace-file", entryFile: row.entry_file ?? "", rootDir: row.root_dir };
  return {
    id: row.id,
    taskId: row.task_id,
    spaceId: row.space_id ?? undefined,
    kind: row.kind as ArtifactDescriptor["kind"],
    source,
    version: row.version,
    capabilities: JSON.parse(row.capabilities_json) as Record<string, unknown>,
    title: row.title ?? undefined,
    mimeType: row.mime_type ?? undefined,
    createdByMessageId: row.created_by_message_id ?? undefined,
    createdByToolCallId: row.created_by_tool_call_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toRow(d: ArtifactDescriptor): ArtifactRow {
  const source = d.source;
  return {
    id: d.id,
    task_id: d.taskId,
    space_id: d.spaceId ?? null,
    kind: d.kind,
    source_type: source.type,
    entry_file: source.type === "workspace-file" ? source.entryFile : null,
    root_dir: source.rootDir,
    storage_path: source.type === "managed-content" ? source.storagePath : null,
    version: d.version,
    capabilities_json: JSON.stringify(d.capabilities ?? {}),
    title: d.title ?? null,
    mime_type: d.mimeType ?? null,
    created_by_message_id: d.createdByMessageId ?? null,
    created_by_tool_call_id: d.createdByToolCallId ?? null,
    created_at: d.createdAt,
    updated_at: d.updatedAt,
  };
}

const DDL = `
  CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    space_id TEXT,
    kind TEXT NOT NULL,
    source_type TEXT NOT NULL,
    entry_file TEXT,
    root_dir TEXT NOT NULL,
    storage_path TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    capabilities_json TEXT NOT NULL DEFAULT '{}',
    title TEXT,
    mime_type TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_artifacts_task ON artifacts(task_id);
  CREATE INDEX IF NOT EXISTS idx_artifacts_space ON artifacts(space_id);
  -- task 级 artifact 集合/事件序列版本（3A 前置决策：与 artifact.version 分离）
  CREATE TABLE IF NOT EXISTS artifact_task_revisions (
    task_id TEXT PRIMARY KEY,
    revision INTEGER NOT NULL
  );
  -- task 级迁移状态（3B：legacy artifact 一次性迁移 marker）
  CREATE TABLE IF NOT EXISTS artifact_task_state (
    task_id TEXT PRIMARY KEY,
    legacy_migrated_at INTEGER
  );
  -- P1 §14：消息/工具级溯源（task-scoped；历史行 NULL）
  CREATE TABLE IF NOT EXISTS artifact_message_refs (
    task_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    artifact_id TEXT NOT NULL,
    relation TEXT NOT NULL,
    tool_call_id TEXT,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (task_id, message_id, artifact_id, relation),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_artifact_message_refs_task
    ON artifact_message_refs(task_id, message_id);
  CREATE INDEX IF NOT EXISTS idx_artifact_message_refs_artifact
    ON artifact_message_refs(task_id, artifact_id);
  -- P1 §15：多文件显式依赖（不得把整个 taskRoot 当长期依赖）
  CREATE TABLE IF NOT EXISTS artifact_file_dependencies (
    artifact_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    dependency_kind TEXT NOT NULL DEFAULT 'runtime',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (artifact_id, file_path),
    FOREIGN KEY (artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS idx_artifact_file_deps_artifact
    ON artifact_file_dependencies(artifact_id);
`;

export class ArtifactRepository {
  constructor(private readonly db: Database) {
    db.exec(DDL);
    this.migrateProvenanceColumns();
    // FK 对已有连接默认关闭；message_refs/dependencies 依赖 CASCADE
    try {
      db.pragma("foreign_keys = ON");
    } catch {
      /* ignore */
    }
  }

  /** 幂等：缺列才 ALTER；历史行保持 NULL，不伪造来源（P1 §14） */
  private migrateProvenanceColumns(): void {
    const cols = this.db.pragma("table_info(artifacts)") as Array<{ name: string }>;
    const names = new Set(cols.map((c) => c.name));
    if (!names.has("created_by_message_id")) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN created_by_message_id TEXT");
    }
    if (!names.has("created_by_tool_call_id")) {
      this.db.exec("ALTER TABLE artifacts ADD COLUMN created_by_tool_call_id TEXT");
    }
  }

  /** 唯一持久 commit point（§10）：insert 事务提交 = 创建成功 */
  insert(descriptor: ArtifactDescriptor): void {
    const row = toRow(descriptor);
    this.db
      .prepare(
        `INSERT INTO artifacts (id, task_id, space_id, kind, source_type, entry_file, root_dir,
           storage_path, version, capabilities_json, title, mime_type,
           created_by_message_id, created_by_tool_call_id, created_at, updated_at)
         VALUES (@id, @task_id, @space_id, @kind, @source_type, @entry_file, @root_dir,
           @storage_path, @version, @capabilities_json, @title, @mime_type,
           @created_by_message_id, @created_by_tool_call_id, @created_at, @updated_at)`,
      )
      .run(row);
  }

  get(id: string): ArtifactDescriptor | null {
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    return row ? toDescriptor(row) : null;
  }

  listByTask(taskId: string): ArtifactDescriptor[] {
    // 稳定 FIFO：created_at 排序 + rowid 兜底（同毫秒创建仍保持创建序，§W2.2①）
    const rows = this.db
      .prepare("SELECT * FROM artifacts WHERE task_id = ? ORDER BY created_at, rowid")
      .all(taskId) as ArtifactRow[];
    return rows.map(toDescriptor);
  }

  listAll(): ArtifactDescriptor[] {
    // rebuild 用：同样保持稳定创建序（Registry 重建后顺序一致）
    const rows = this.db
      .prepare("SELECT * FROM artifacts ORDER BY created_at, rowid")
      .all() as ArtifactRow[];
    return rows.map(toDescriptor);
  }

  /**
   * 元数据更新（title/mime/capabilities）；version 以传入为准（调用方决定是否 bump）。
   * created_by_* 永不被 UPDATE 覆盖（P1：首次写入后不可变）。
   */
  update(descriptor: ArtifactDescriptor): void {
    const row = toRow(descriptor);
    this.db
      .prepare(
        `UPDATE artifacts SET space_id=@space_id, kind=@kind, source_type=@source_type,
           entry_file=@entry_file, root_dir=@root_dir, storage_path=@storage_path,
           version=@version, capabilities_json=@capabilities_json, title=@title,
           mime_type=@mime_type, updated_at=@updated_at WHERE id=@id`,
      )
      .run(row);
  }

  /**
   * 内容变化 → version++（§68）：Repository transaction 原子完成并返回新 descriptor。
   * Refresh 链路（markFilesChanged）专用；重启后 version 仍正确。
   */
  markChanged(id: string): ArtifactDescriptor | null {
    const existing = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow | undefined;
    if (!existing) return null;
    const now = Date.now();
    this.db
      .prepare("UPDATE artifacts SET version = version + 1, updated_at = ? WHERE id = ?")
      .run(now, id);
    const row = this.db.prepare("SELECT * FROM artifacts WHERE id = ?").get(id) as ArtifactRow;
    return toDescriptor(row);
  }

  remove(id: string): boolean {
    const result = this.db.prepare("DELETE FROM artifacts WHERE id = ?").run(id);
    return result.changes > 0;
  }

  removeByTask(taskId: string): number {
    return this.db.prepare("DELETE FROM artifacts WHERE task_id = ?").run(taskId).changes;
  }

  /**
   * task revision++（3A）：必须在与业务写入同一个事务内调用（insert/update/remove/markChanged）。
   * 单调递增、重启后持久；任何 task 集合/事件序列变化都 bump。
   */
  bumpTaskRevision(taskId: string): number {
    const current = this.getTaskRevision(taskId);
    const next = current + 1;
    this.db
      .prepare(
        `INSERT INTO artifact_task_revisions (task_id, revision) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET revision = excluded.revision`,
      )
      .run(taskId, next);
    return next;
  }

  /** 当前 task revision（无记录 = 0） */
  getTaskRevision(taskId: string): number {
    const row = this.db
      .prepare("SELECT revision FROM artifact_task_revisions WHERE task_id = ?")
      .get(taskId) as { revision: number } | undefined;
    return row?.revision ?? 0;
  }

  // ---------- P1 message refs（§14） ----------

  /**
   * 幂等写入消息引用。PRIMARY KEY (task_id, message_id, artifact_id, relation)。
   * 必须 task-scoped：调用方传入的 taskId 须与 artifact.taskId 一致，否则拒绝。
   * @returns true 表示新插入；false 表示已存在（幂等跳过）
   */
  addMessageRef(ref: {
    taskId: string;
    messageId: string;
    artifactId: string;
    relation: ArtifactMessageRelation;
    toolCallId?: string;
  }): boolean {
    if (!ref.taskId || !ref.messageId || !ref.artifactId || !ref.relation) {
      throw new Error("addMessageRef 需要 taskId/messageId/artifactId/relation");
    }
    const art = this.get(ref.artifactId);
    if (!art) throw new Error(`addMessageRef: artifact 不存在 ${ref.artifactId}`);
    if (art.taskId !== ref.taskId) {
      throw new Error(
        `addMessageRef: task 不匹配（artifact.taskId=${art.taskId}, ref.taskId=${ref.taskId}）`,
      );
    }
    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO artifact_message_refs
           (task_id, message_id, artifact_id, relation, tool_call_id, created_at)
         VALUES (@task_id, @message_id, @artifact_id, @relation, @tool_call_id, @created_at)`,
      )
      .run({
        task_id: ref.taskId,
        message_id: ref.messageId,
        artifact_id: ref.artifactId,
        relation: ref.relation,
        tool_call_id: ref.toolCallId ?? null,
        created_at: Date.now(),
      });
    return result.changes > 0;
  }

  /** task-scoped 查询；不可仅凭 artifactId 跨任务读取 */
  listMessageRefs(taskId: string, filter?: { messageId?: string; artifactId?: string }): ArtifactMessageRef[] {
    if (!taskId) return [];
    let sql =
      "SELECT task_id, message_id, artifact_id, relation, tool_call_id, created_at FROM artifact_message_refs WHERE task_id = ?";
    const params: unknown[] = [taskId];
    if (filter?.messageId) {
      sql += " AND message_id = ?";
      params.push(filter.messageId);
    }
    if (filter?.artifactId) {
      sql += " AND artifact_id = ?";
      params.push(filter.artifactId);
    }
    sql += " ORDER BY created_at, rowid";
    const rows = this.db.prepare(sql).all(...params) as Array<{
      task_id: string;
      message_id: string;
      artifact_id: string;
      relation: string;
      tool_call_id: string | null;
      created_at: number;
    }>;
    return rows.map((r) => ({
      taskId: r.task_id,
      messageId: r.message_id,
      artifactId: r.artifact_id,
      relation: r.relation as ArtifactMessageRelation,
      toolCallId: r.tool_call_id ?? undefined,
      createdAt: r.created_at,
    }));
  }

  // ---------- P1 file dependencies（§15） ----------

  /** 替换某 artifact 的全部依赖（调用方已校验路径边界） */
  replaceFileDependencies(
    artifactId: string,
    deps: Array<{ filePath: string; dependencyKind?: string }>,
  ): void {
    this.db.prepare("DELETE FROM artifact_file_dependencies WHERE artifact_id = ?").run(artifactId);
    const insert = this.db.prepare(
      `INSERT INTO artifact_file_dependencies (artifact_id, file_path, dependency_kind, created_at)
       VALUES (?, ?, ?, ?)`,
    );
    const now = Date.now();
    for (const d of deps) {
      insert.run(artifactId, d.filePath, d.dependencyKind ?? "runtime", now);
    }
  }

  listFileDependencies(artifactId: string): ArtifactFileDependency[] {
    const rows = this.db
      .prepare(
        `SELECT artifact_id, file_path, dependency_kind, created_at
         FROM artifact_file_dependencies WHERE artifact_id = ? ORDER BY created_at, rowid`,
      )
      .all(artifactId) as Array<{
      artifact_id: string;
      file_path: string;
      dependency_kind: string;
      created_at: number;
    }>;
    return rows.map((r) => ({
      artifactId: r.artifact_id,
      filePath: r.file_path,
      dependencyKind: r.dependency_kind,
      createdAt: r.created_at,
    }));
  }

  // ---------- legacy migration marker（3B） ----------

  /** 是否已执行过 legacy artifact 迁移（0 artifact 也算完成） */
  isLegacyMigrated(taskId: string): boolean {
    const row = this.db
      .prepare("SELECT legacy_migrated_at FROM artifact_task_state WHERE task_id = ?")
      .get(taskId) as { legacy_migrated_at: number } | undefined;
    return row?.legacy_migrated_at !== undefined;
  }

  /** 标记 task legacy 迁移完成（迁移只运行一次） */
  markLegacyMigrated(taskId: string): void {
    this.db
      .prepare(
        `INSERT INTO artifact_task_state (task_id, legacy_migrated_at) VALUES (?, ?)
         ON CONFLICT(task_id) DO UPDATE SET legacy_migrated_at = excluded.legacy_migrated_at`,
      )
      .run(taskId, Date.now());
  }

  /** 显式事务包装（注册流程的 DB 阶段用） */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  get inTransaction(): boolean { return this.db.inTransaction; }

  /** managed-content rows 的 storage_path 集合（orphan GC 对比用） */
  managedPaths(): Set<string> {
    const rows = this.db
      .prepare("SELECT storage_path FROM artifacts WHERE source_type = 'managed-content' AND storage_path IS NOT NULL")
      .all() as Array<{ storage_path: string }>;
    return new Set(rows.map((r) => r.storage_path.replace(/\\/g, "/")));
  }
}
