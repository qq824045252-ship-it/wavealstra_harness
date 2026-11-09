import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import { canonicalControlInput, type WorkBlockerDto, type WorkDto } from "../../../shared/bot-work";

const receiptSchema = z.object({ operation_id: z.string(), payload_hash: z.string(), result_snapshot_json: z.string() });
const sourceSchema = z.object({ workId: z.string(), userId: z.string(), ownerBotId: z.string(), ownerEpoch: z.number().int().positive(),
  intentRevision: z.number().int().positive(), inputSnapshotId: z.string().min(1), stateVersion: z.number().int().positive() });

/** Fail-closed compatibility for pre-typed owner reports. A timestamp alone is
 * never provenance. Verify the original control payload hash and reject ambiguity.
 * This proves who reported it, not that its text is informational: the user must
 * separately and explicitly confirm that classification in the trusted UI. */
export function legacyUserInputSource(db: Database.Database, work: WorkDto, blocker: WorkBlockerDto): WorkBlockerDto["legacyUserInput"] {
  if (blocker.workId !== work.workId || blocker.status !== "open" || !blocker.waitingForUserInput
    || blocker.kind !== "operational" || blocker.reportedByBotId !== work.ownerBotId
    || !/^blocker-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(blocker.blockerId)
    || blocker.reasonCode || Object.keys(blocker.details ?? {}).length || blocker.sourceRef || blocker.subscriptionId
    || blocker.causalChainId || blocker.unknownExternalEffectRef
    || work.inputSnapshotId === "snapshot:unbound") return undefined;
  // 共享资源隔离与动作审批的数据已退役，只剩真实执行准入仍是机器引用。
  const machineReference = (id: string) => Boolean(
    db.prepare("SELECT 1 FROM work_action_admissions WHERE admission_id=? OR operation_id=? LIMIT 1").get(id, id));
  if (machineReference(blocker.blockerId)) return undefined;
  // The legacy receipt did not persist blockerId. Even a valid report hash cannot
  // identify one row if its immutable owner/reason/time tuple has been duplicated.
  const siblings = z.object({ count: z.number() }).parse(db.prepare(`SELECT COUNT(*) AS count FROM work_blockers
    WHERE work_id=? AND reported_by_bot_id=? AND reason=? AND kind=? AND created_at=?`)
    .get(work.workId, blocker.reportedByBotId, blocker.reason, blocker.kind, blocker.createdAt));
  if (siblings.count !== 1) return undefined;
  const matches: NonNullable<WorkBlockerDto["legacyUserInput"]>[] = [];
  const rows = db.prepare(`SELECT operation_id,payload_hash,result_snapshot_json FROM work_operation_receipts
    WHERE user_id=? AND work_id=? AND operation_type='reportBlocker' AND created_at=?`).all(work.userId, work.workId, blocker.createdAt);
  for (const row of rows) {
    const parsed = receiptSchema.safeParse(row); if (!parsed.success) continue;
    const receipt = parsed.data;
    let raw: unknown; try { raw = JSON.parse(receipt.result_snapshot_json); } catch { continue; }
    const source = sourceSchema.safeParse(raw); if (!source.success) continue;
    const original = source.data;
    if (original.workId !== work.workId || original.userId !== work.userId || original.ownerBotId !== blocker.reportedByBotId
      || original.ownerEpoch !== work.ownerEpoch || original.intentRevision !== work.intentRevision
      || original.inputSnapshotId !== work.inputSnapshotId || original.stateVersion > work.stateVersion
      || machineReference(receipt.operation_id)) continue;
    const versions = { expectedStateVersion: original.stateVersion - 1, expectedIntentRevision: original.intentRevision };
    let matched = false;
    for (const kind of [undefined, "operational"] as const) for (const versionGuard of [versions, { ...versions, expectedOwnerEpoch: original.ownerEpoch }]) {
      const payload = { operationId: receipt.operation_id, workId: work.workId, reason: blocker.reason,
        kind, waitingForUserInput: true, versionGuard };
      const hash = createHash("sha256").update(canonicalControlInput("reportBlocker", payload)).digest("hex");
      if (hash === receipt.payload_hash) matched = true;
    }
    if (!matched) continue;
    matches.push({ reportOperationId: receipt.operation_id, inputSnapshotId: original.inputSnapshotId,
      intentRevision: original.intentRevision, ownerEpoch: original.ownerEpoch,
      blockerSnapshot: JSON.stringify({ blockerId: blocker.blockerId, reason: blocker.reason, createdAt: blocker.createdAt,
        reportedByBotId: blocker.reportedByBotId, reportOperationId: receipt.operation_id,
        reportPayloadHash: receipt.payload_hash, source: original }) });
  }
  return matches.length === 1 ? matches[0] : undefined;
}
