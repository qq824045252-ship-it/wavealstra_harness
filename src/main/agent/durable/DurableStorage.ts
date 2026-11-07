import type { Storage } from "@earendil-works/pi-durable";
import { JsonlStorage, openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { DurableReadOnlyFiles } from "./DurableReadOnlyFiles";
import { repairDurableJsonlLog, type DurableLogRepairReport } from "./DurableLogRepair";
import { claimDurableStorageLease, type DurableStorageLease } from "./DurableStorageLease";

/**
 * Durable 存储的唯一打开入口：先取单写者租约，再打开 JSONL。
 *
 * 打开失败且原因是非法的 JSONL（多实例并发写入留下的重复 commit seq）时，
 * 先做一次确定性修复并重试一次；修复报告回传给服务层，用于在会话界面提示用户
 * 「历史已恢复、原文件已备份」，而不是静默变成空白会话。
 */

type JsonlContext = Parameters<typeof openNodeJsonlStorage>[1];

export interface DurableStorageHandle {
  storage: Storage;
  lease: DurableStorageLease;
  repair?: DurableLogRepairReport;
}

export function isJsonlCorruption(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { name?: unknown; message?: unknown };
  if (candidate.name === "JsonlCorruptionError") return true;
  return typeof candidate.message === "string" && candidate.message.includes("JsonlCorruptionError");
}

export async function openDurableStorage(directory: string, context: JsonlContext, options: { readOnly?: boolean } = {}): Promise<DurableStorageHandle> {
  const lease = claimDurableStorageLease(directory);
  try {
    try {
      const storage = options.readOnly
        ? await JsonlStorage.open(directory, new DurableReadOnlyFiles({ cwd: directory }), context, { fsync: true })
        : await openNodeJsonlStorage(directory, context, { fsync: true });
      return { storage, lease };
    } catch (error) {
      if (options.readOnly || !isJsonlCorruption(error)) throw error;
      const repair = repairDurableJsonlLog(directory);
      if (!repair) throw error;
      console.warn(`[Durable] Repaired corrupted log ${directory}: kept ${repair.keptMainCommits} commits, dropped ${repair.droppedMainCommits} duplicate commits and ${repair.droppedSidecarRecords} sidecar records; backup: ${repair.backupDirectory}`);
      return { storage: await openNodeJsonlStorage(directory, context, { fsync: true }), lease, repair };
    }
  } catch (error) {
    lease.release();
    throw error;
  }
}
