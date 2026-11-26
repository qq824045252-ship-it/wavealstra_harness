import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { RuntimeAuditReader, RuntimeWorkbenchMutation, RuntimeWorkbenchWriteStatus } from "../platform/runtime-audit";

export async function writeWorkbench(
  db: Database.Database,
  reader: RuntimeAuditReader | undefined,
  mutation: RuntimeWorkbenchMutation,
): Promise<RuntimeWorkbenchWriteStatus | undefined> {
  const rustRequired = Boolean(db.readonly || reader?.supervised);
  if (!reader || db.inTransaction) {
    if (rustRequired) throw new Error("只读数据库模式下工作台写入需要 Rust 核心确认");
    return undefined;
  }
  const operationId = randomUUID();
  const result = await reader.writeWorkbench(operationId, mutation);
  if (result === "needsHost") {
    if (rustRequired) throw new Error("工作台数据写入未获 Rust 核心授权");
    return undefined;
  }
  if (result) return result;
  if (db.prepare("SELECT 1 FROM workbench_write_receipts WHERE operation_id=?").get(operationId)) return "changed";
  throw new Error("工作台数据写入失败，请重试");
}
