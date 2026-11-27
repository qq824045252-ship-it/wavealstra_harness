import { createHash } from "node:crypto";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { GoalActivityDto } from "../../shared/conversation-goal-activity";
import type { GoalSavedArtifactDto } from "../../shared/conversation-goal";

export class ConversationGoalSavedArtifacts {
  constructor(
    private readonly fixture: Database.Database | undefined,
    private readonly reader?: import("../platform/runtime-audit").RuntimeAuditReader,
  ) {
    const db = fixture;
    if (!db || db.readonly) return;
    db.exec(`CREATE TABLE IF NOT EXISTS conversation_goal_saved_artifact_verification (
      work_id TEXT NOT NULL REFERENCES works(work_id) ON DELETE CASCADE,
      artifact_id TEXT NOT NULL,
      verified_at INTEGER NOT NULL,
      PRIMARY KEY(work_id,artifact_id)
    );`);
  }

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("目标成果记录需要通过 Rust Core 读取或写入");
    return this.fixture;
  }

  read(workId: string, evidence: NonNullable<GoalActivityDto["nativeEvidence"]>): GoalSavedArtifactDto[] {
    const rows = this.db.prepare("SELECT artifact_id, verified_at FROM conversation_goal_saved_artifact_verification WHERE work_id=?")
      .all(workId) as Array<{ artifact_id: string; verified_at: number }>;
    const verified = new Map(rows.map(row => [row.artifact_id, row.verified_at]));
    const artifacts = new Map<string, { dto: GoalSavedArtifactDto; toolTaskId: number }>();
    const versionCounts = new Map<string, number>();
    const registrations = evidence.flatMap(record => {
      if (record.kind !== "delivery" || !record.path || !record.digest || !record.saved) return [];
      return [{ path: record.path, digest: record.digest, saved: record.saved, toolTaskId: record.toolTaskId }];
    }).sort((a, b) => a.saved.registeredAt - b.saved.registeredAt || a.toolTaskId - b.toolTaskId);
    for (const record of registrations) {
      const { snapshotPath, manifestPath, registeredAt } = record.saved;
      const id = createHash("sha256").update(JSON.stringify([record.path, record.digest, manifestPath && basename(manifestPath)])).digest("hex");
      const existing = artifacts.get(id);
      const version = existing?.dto.version ?? (versionCounts.get(record.path) ?? 0) + 1;
      if (!existing) versionCounts.set(record.path, version);
      const verifiedAt = verified.get(id);
      artifacts.set(id, { toolTaskId: record.toolTaskId, dto: { id, path: record.path, digest: record.digest, version, registeredAt,
        request: { snapshotPath, manifestPath, name: basename(record.path) },
        ...(verifiedAt == null ? {} : { verification: { kind: "user", verifiedAt } }) } });
    }
    return [...artifacts.values()].sort((a, b) =>
      b.dto.registeredAt - a.dto.registeredAt || b.toolTaskId - a.toolTaskId).map(item => item.dto);
  }

  confirm(workId: string, artifact: GoalSavedArtifactDto): GoalSavedArtifactDto {
    if (this.db.readonly) throw new Error("只读数据库模式下请使用 confirmAsync");
    const verifiedAt = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO conversation_goal_saved_artifact_verification VALUES (?,?,?)")
      .run(workId, artifact.id, verifiedAt);
    const row = this.db.prepare("SELECT verified_at FROM conversation_goal_saved_artifact_verification WHERE work_id=? AND artifact_id=?")
      .get(workId, artifact.id) as { verified_at: number };
    return { ...artifact, verification: { kind: "user", verifiedAt: row.verified_at } };
  }

  async confirmAsync(workId: string, artifact: GoalSavedArtifactDto): Promise<GoalSavedArtifactDto> {
    if (!this.reader) return this.confirm(workId, artifact);
    const res = await this.reader.batch1Write<{ verifiedAt?: number }>({
      kind: "goalSavedArtifactConfirm",
      workId,
      artifactId: artifact.id,
      verifiedAt: Date.now(),
    });
    if (res && typeof res.verifiedAt === "number") {
      return { ...artifact, verification: { kind: "user", verifiedAt: res.verifiedAt } };
    }
    if (this.fixture && !this.fixture.readonly && !this.reader.supervised) return this.confirm(workId, artifact);
    throw new Error("成果核验状态写入未获 Rust 核心确认");
  }
}
