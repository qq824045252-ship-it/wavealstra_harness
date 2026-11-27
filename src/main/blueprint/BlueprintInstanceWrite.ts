import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import type { RuntimeGadgetInsert } from "../platform/runtime-audit";
import { RuntimeAuditUnknownOperationError } from "../platform/runtime-audit";
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

export async function writeBlueprintInstance(db: Pick<AppDatabase, "runtimeAuditReader" | "readonly" | "connection">,
  instance: RuntimeBlueprintInstance): Promise<RuntimeBlueprintInstanceStatus | undefined> {
  const reader = db.runtimeAuditReader;
  const rustRequired = Boolean(reader?.supervised || db.readonly);
  if (!reader || (!rustRequired && db.connection.inTransaction)) {
    if (rustRequired) throw new Error("只读数据库模式下蓝图实例化需要 Rust 核心确认");
    return;
  }
  const operationId = randomUUID();
  let result: RuntimeBlueprintInstanceStatus | "needsHost" | undefined;
  try {
    result = await reader.instantiateBlueprint(operationId, instance);
  } catch (error) {
    if (!(error instanceof RuntimeAuditUnknownOperationError)) throw error;
  }
  if (result === "needsHost") {
    if (rustRequired) throw new Error("蓝图实例化未获 Rust 核心授权");
    return;
  }
  if (result) return result;

  try {
    const rows = await reader.workbenchData<{ result_json: string }>({ kind: "blueprintReceipt", operationId });
    if (rows?.[0]) return JSON.parse(rows[0].result_json) as RuntimeBlueprintInstanceStatus;
    const retried = await reader.instantiateBlueprint(operationId, instance);
    if (retried && retried !== "needsHost") return retried;
  } catch (error) {
    throw new BlueprintCommitUnconfirmed("暂时无法确认蓝图实例是否提交", { cause: error });
  }
  throw new BlueprintCommitUnconfirmed("暂时无法确认蓝图实例是否提交，请刷新后查看生成的工作空间");
}
