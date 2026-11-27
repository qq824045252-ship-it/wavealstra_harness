import { createHash } from "node:crypto";
import { basename } from "node:path";
import type Database from "better-sqlite3";
import type { GoalActivityDto } from "../../shared/conversation-goal-activity";
import type { GoalSavedArtifactDto } from "../../shared/conversation-goal";

type NativeEvidence = NonNullable<GoalActivityDto["nativeEvidence"]>;
export type GoalSavedArtifactVerification = { artifactId: string; verifiedAt: number };

function savedArtifactId(path: string, digest: string, manifestPath?: string): string {
  return createHash("sha256").update(JSON.stringify([path, digest, manifestPath && basename(manifestPath)])).digest("hex");
}

export function goalSavedArtifactSource(id: string, evidence: NativeEvidence) {
  return evidence.flatMap(record => {
    if (record.kind !== "delivery" || !record.path || !record.digest || !record.saved
      || savedArtifactId(record.path, record.digest, record.saved.manifestPath) !== id) return [];
    return [{ taskId: record.taskId, conversationId: record.conversationId, generationTaskId: record.generationTaskId,
      toolTaskId: record.toolTaskId, path: record.path, digest: record.digest, ...record.saved }];
  }).sort((a, b) => a.registeredAt - b.registeredAt || a.toolTaskId - b.toolTaskId).at(-1);
}

export function projectGoalSavedArtifacts(evidence: NativeEvidence, rows: readonly GoalSavedArtifactVerification[]): GoalSavedArtifactDto[] {
  const verified = new Map(rows.map(row => [row.artifactId, row.verifiedAt]));
  const artifacts = new Map<string, { dto: GoalSavedArtifactDto; toolTaskId: number }>();
  const versionCounts = new Map<string, number>();
  const registrations = evidence.flatMap(record => {
    if (record.kind !== "delivery" || !record.path || !record.digest || !record.saved) return [];
    return [{ path: record.path, digest: record.digest, saved: record.saved, toolTaskId: record.toolTaskId }];
  }).sort((a, b) => a.saved.registeredAt - b.saved.registeredAt || a.toolTaskId - b.toolTaskId);
  for (const record of registrations) {
    const { snapshotPath, manifestPath, registeredAt } = record.saved;
    const id = savedArtifactId(record.path, record.digest, manifestPath);
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

export class ConversationGoalSavedArtifacts {
  constructor(private readonly fixture: Database.Database | undefined) {
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
    return projectGoalSavedArtifacts(evidence, rows.map(row => ({ artifactId: row.artifact_id, verifiedAt: row.verified_at })));
  }

  confirm(workId: string, artifact: GoalSavedArtifactDto): GoalSavedArtifactDto {
    if (this.db.readonly) throw new Error("只读 Goal 成果核验需通过 Core 范围确认");
    const verifiedAt = Date.now();
    this.db.prepare("INSERT OR IGNORE INTO conversation_goal_saved_artifact_verification VALUES (?,?,?)")
      .run(workId, artifact.id, verifiedAt);
    const row = this.db.prepare("SELECT verified_at FROM conversation_goal_saved_artifact_verification WHERE work_id=? AND artifact_id=?")
      .get(workId, artifact.id) as { verified_at: number };
    return { ...artifact, verification: { kind: "user", verifiedAt: row.verified_at } };
  }
}
