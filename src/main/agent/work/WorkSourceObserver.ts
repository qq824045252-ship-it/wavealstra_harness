import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { WorkActor, WorkGoalSourceDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

export interface AuthoritativeWorkSource {
  inputSnapshotId: string;
  sources: WorkGoalSourceDto[];
}

/** Source events are wakeups; only a fresh authoritative read can change the target. */
export class WorkSourceObserver {
  constructor(private readonly work: WorkService) {}

  async refresh(actor: Extract<WorkActor, { kind: "user" }>, workId: string, operationId: string,
    readCurrent: () => Promise<AuthoritativeWorkSource>) {
    const before = this.work.getWork(workId);
    if (!before || before.userId !== actor.userId) return { ok: false as const, code: "not_found" as const, message: "找不到 Work" };
    // No database transaction spans file/network I/O. Late observations must re-evaluate.
    const current = await readCurrent();
    const sources = current.sources.map(source => {
      const prior = before.goalSources.find(previous => previous.sourceType === source.sourceType
        && previous.sourceRef === source.sourceRef && previous.inputSnapshotId === source.inputSnapshotId);
      return prior ?? source;
    });
    return this.work.amendWork(actor, { operationId, workId, inputSnapshotId: current.inputSnapshotId,
      goalSources: sources, versionGuard: { expectedStateVersion: before.stateVersion,
        expectedIntentRevision: before.intentRevision, expectedOwnerEpoch: before.ownerEpoch } });
  }

  file(actor: Extract<WorkActor, { kind: "user" }>, workId: string, operationId: string, path: string) {
    return this.refresh(actor, workId, operationId, async () => {
      const sourceRef = resolve(path);
      const inputSnapshotId = `sha256:${createHash("sha256").update(await readFile(sourceRef)).digest("hex")}`;
      return { inputSnapshotId, sources: [{ sourceType: "file", sourceRef, inputSnapshotId, observedAt: Date.now() }] };
    });
  }
}
