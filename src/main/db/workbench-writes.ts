import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader, type RuntimeWorkbenchMutation, type RuntimeWorkbenchWriteStatus } from "../platform/runtime-audit";

export async function writeWorkbench(
  fixture: Database.Database | undefined,
  reader: RuntimeAuditReader | undefined,
  mutation: RuntimeWorkbenchMutation,
): Promise<RuntimeWorkbenchWriteStatus | undefined> {
  const rustRequired = !fixture || Boolean(reader?.supervised || fixture.readonly);
  if (!reader || fixture?.inTransaction) {
    if (rustRequired) throw new Error("只读数据库模式下工作台写入需要 Rust 核心确认");
    return undefined;
  }
  const operationId = randomUUID();
  let result: RuntimeWorkbenchWriteStatus | "needsHost" | undefined;
  try {
    result = await reader.writeWorkbench(operationId, mutation);
  } catch (error) {
    if (!(error instanceof RuntimeAuditUnknownOperationError)) throw error;
  }
  if (result === "needsHost") {
    if (rustRequired) throw new Error("工作台数据写入未获 Rust 核心授权");
    return undefined;
  }
  if (result) return result;
  const receipt = await reader.workbenchData<{ status: RuntimeWorkbenchWriteStatus }>({ kind: "workbenchReceipt", operationId });
  if (receipt?.[0]) return receipt[0].status;
  const replay = await reader.writeWorkbench(operationId, mutation);
  if (replay && replay !== "needsHost") return replay;
  throw new Error("工作台操作结果未获 Rust Core 确认，请刷新后查看当前状态");
}
