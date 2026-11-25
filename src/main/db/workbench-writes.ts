import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RuntimeAuditReader, RuntimeWorkbenchMutation, RuntimeWorkbenchWriteStatus } from "../platform/runtime-audit";

export async function writeWorkbench(
  db: Database.Database,
  reader: RuntimeAuditReader | undefined,
  mutation: RuntimeWorkbenchMutation,
): Promise<RuntimeWorkbenchWriteStatus | undefined> {
  if (!reader || db.inTransaction) return undefined;
  const operationId = randomUUID();
  const result = await reader.writeWorkbench(operationId, mutation);
  if (result === "needsHost") return undefined;
  if (result) return result;
  if (db.prepare("SELECT 1 FROM workbench_write_receipts WHERE operation_id=?").get(operationId)) return "changed";
  throw new Error("工作台数据写入失败，请重试");
}
