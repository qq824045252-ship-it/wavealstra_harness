import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type { RuntimeGadgetInsert } from "../platform/runtime-audit";
import type { BlueprintTaskDefinition } from "../../shared/blueprint-types";

export interface RuntimeBlueprintInstance {
  blueprintId: string;
  createdAt: number;
  workspaces: Array<{ id: string; name: string; parentId: string | null; path: string }>;
  tasks: Array<{ id: string; workspaceId: string; title: string; status: string; welcomeMode?: BlueprintTaskDefinition["welcomeMode"] }>;
  libraryBindings: Array<{ workspaceId: string; librarySpaceId: string; optional: boolean }>;
  contexts: Array<{
    id: string; workspaceId: string; scopeId: string; revisionId: string;
    title: string; content: string; contentHash: string; metadataJson: string; createdAt: number;
  }>;
  gadgets: RuntimeGadgetInsert[];
  storage?: {
    workspaceInstancesRoot: string;
    seeds: Array<{ workspaceId: string; path: string; base64: string }>;
    gadgets: RuntimeBlueprintGadgetFiles[];
  };
}

export interface RuntimeBlueprintGadgetFiles {
  id: string;
  root: string;
  manifest: string;
  entry: string;
  backendEntry?: string;
  files: Array<{ path: string; base64: string }>;
}

export type RuntimeBlueprintInstanceStatus =
  | { kind: "committed"; skippedLibraries: string[] }
  | { kind: "missingBlueprint" }
  | { kind: "missingLibrary"; id: string }
  | { kind: "duplicateWorkspace"; name: string }
  | { kind: "scopeChanged" }
  | { kind: "failed"; message: string };

export class BlueprintCommitUnconfirmed extends Error {}

export async function writeBlueprintInstance(db: AppDatabase, instance: RuntimeBlueprintInstance): Promise<RuntimeBlueprintInstanceStatus | undefined> {
  const reader = db.runtimeAuditReader;
  const rustRequired = Boolean(db.connection.readonly || reader?.supervised);
  if (!reader || db.connection.inTransaction) {
    if (rustRequired) throw new Error("只读数据库模式下蓝图实例化需要 Rust 核心确认");
    return;
  }
  const operationId = randomUUID();
  const result = await reader.instantiateBlueprint(operationId, instance);
  if (result === "needsHost") {
    if (rustRequired) throw new Error("蓝图实例化未获 Rust 核心授权");
    return;
  }
  if (result) return result;

  const receipt = readReceipt(db, operationId);
  if (receipt) return receipt;
  if (instance.storage) {
    const retried = await reader.instantiateBlueprint(operationId, instance);
    if (retried && retried !== "needsHost") return retried;
    const receipt = readReceipt(db, operationId);
    if (receipt) return receipt;
  }
  throw new Error("蓝图实例数据库写入失败，请重试");
}

function readReceipt(db: AppDatabase, operationId: string): RuntimeBlueprintInstanceStatus | undefined {
  try {
    const receipt = db.connection.prepare("SELECT result_json FROM blueprint_instance_receipts WHERE operation_id=?")
      .get(operationId) as { result_json: string } | undefined;
    if (receipt) return JSON.parse(receipt.result_json) as RuntimeBlueprintInstanceStatus;
  } catch (error) {
    // Startup reconciles staged directories against committed database rows.
    throw new BlueprintCommitUnconfirmed("暂时无法确认蓝图实例是否提交", { cause: error });
  }
}
