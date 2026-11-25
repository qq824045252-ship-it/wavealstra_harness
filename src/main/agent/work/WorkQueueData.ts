import type Database from "better-sqlite3";
import type { WorkCardReadResult } from "../../../shared/bot-work-phase5";
import type { RemoteWorkCursor } from "../../../../shared/src/remote-contract";

export type RemoteWorkQueueRequest = { includeClosed: boolean; cursor?: RemoteWorkCursor };
export type RuntimeWorkQueueQuery = RemoteWorkQueueRequest & { userId: string };

export type RuntimeWorkQueueSnapshot =
  | { kind: "snapshot"; cursor: RemoteWorkCursor; workIds: string[] }
  | { kind: "delta"; cursor: RemoteWorkCursor; from: number; hasMore: boolean; events: Array<
      { kind: "upsert"; sequence: number; workId: string }
      | { kind: "remove"; sequence: number; workId: string; reason: "closed" | "removed" }
    > }
  | { kind: "resync_required" }
  | { kind: "needsHost" };

export interface RuntimeWorkCardRead {
  userId: string;
  workId: string;
  semanticCardKey: string;
  readAt: number;
}

export type RuntimeWorkCardReadReply =
  | { status: "saved"; result: WorkCardReadResult }
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

export interface WorkQueueNativeReader {
  readWorkQueue(query: RuntimeWorkQueueQuery): Promise<RuntimeWorkQueueSnapshot | undefined>;
  markWorkCardRead(request: RuntimeWorkCardRead): Promise<RuntimeWorkCardReadReply | undefined>;
}

export async function readWorkQueueWithProjection<T>(
  db: Database.Database,
  native: WorkQueueNativeReader | undefined,
  query: RuntimeWorkQueueQuery,
  project: (snapshot: Exclude<RuntimeWorkQueueSnapshot, { kind: "needsHost" }>) => T,
  host: () => T,
): Promise<T> {
  if (!native || db.inTransaction) return host();
  const totalChanges = db.prepare("SELECT total_changes()").pluck();
  const before = totalChanges.get();
  const version = db.pragma("data_version", { simple: true });
  const snapshot = await native.readWorkQueue(query);
  if (!snapshot || snapshot.kind === "needsHost") return host();
  return db.transaction(() => {
    // Projection facts and the cursor retain the same commit boundary as the old
    // single transaction. A concurrent writer invalidates the sidecar snapshot.
    if (before !== totalChanges.get() || version !== db.pragma("data_version", { simple: true })) return host();
    return project(snapshot);
  }).immediate();
}
