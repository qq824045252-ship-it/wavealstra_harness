import type { BlueprintDefinition, WorkspaceBlueprintNode } from "@shared/blueprint-types";

export interface BlueprintSummary {
  workspaces: number;
  tasks: number;
  gadgets: number;
  files: number;
  hasContext: boolean;
}

export function summarizeBlueprintDefinition(definition: BlueprintDefinition): BlueprintSummary {
  const summary: BlueprintSummary = { workspaces: 0, tasks: 0, gadgets: 0, files: 0, hasContext: false };
  const visit = (node: WorkspaceBlueprintNode): void => {
    summary.workspaces += 1;
    summary.tasks += node.tasks?.length ?? 0;
    summary.gadgets += node.gadgets?.length ?? 0;
    summary.files += node.files?.length ?? 0;
    summary.hasContext ||= Boolean(node.defaultContext);
    for (const child of node.children ?? []) visit(child);
  };
  if (definition.kind === "workspace") visit(definition.workspace);
  if (definition.kind === "gadget") summary.gadgets = 1;
  if (definition.kind === "composite") {
    if (definition.workspace) visit(definition.workspace);
    summary.gadgets += definition.gadgets?.length ?? 0;
  }
  return summary;
}

export function blueprintSummaryParts(definition: BlueprintDefinition): string[] {
  const summary = summarizeBlueprintDefinition(definition);
  return [
    summary.workspaces ? `${summary.workspaces} 个工作空间` : "",
    summary.tasks ? `${summary.tasks} 个建议任务` : "",
    summary.gadgets ? `${summary.gadgets} 个 Gadget` : "",
    summary.hasContext ? "上下文结构" : "",
    summary.files ? `${summary.files} 个模板文件` : "",
  ].filter(Boolean);
}
