/**
 * WorkGraph Agent Extension — Phase 6/8 (read-only query)
 *
 * Agent can query work graph relations (no mutation).
 * Phase 8: also covers SPAWNED / PRODUCES / DERIVED_FROM lineage.
 */
import type { ExtensionAPI, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { WorkGraphService } from "./WorkGraphService";

function textResult(text: string, details?: unknown) {
  return { content: [{ type: "text" as const, text }], details: details ?? { text } };
}
function errorResult(prefix: string, error: unknown) {
  const msg = error instanceof Error ? error.message : String(error);
  return { content: [{ type: "text" as const, text: `[${prefix}] ${msg}` }], isError: true as const, details: { error: msg } };
}

export function createWorkGraphAgentExtension(service: WorkGraphService): ExtensionFactory {
  return (pi: ExtensionAPI) => {
    pi.registerTool({
      name: "query_work_graph",
      label: "工作图谱 · 查询关联",
      description:
        "查询工作图谱的关系（只读）。输入节点类型与 id，可查 outgoing/incoming/related。可过滤 relation（RELATES_TO/DEPENDS_ON/PRODUCES/DERIVED_FROM/BELONGS_TO/CONTAINS/SPAWNED）。返回关联边列表（含对方节点与 relation）。不改变 Workspace 上下文与权限。",
      parameters: Type.Object(
        {
          type: Type.Union([
            Type.Literal("workspace"),
            Type.Literal("task"),
            Type.Literal("project"),
            Type.Literal("plan"),
            Type.Literal("artifact"),
            Type.Literal("library_item"),
            Type.Literal("agent_run"),
          ]),
          id: Type.String({ minLength: 1 }),
          direction: Type.Optional(
            Type.Union([Type.Literal("outgoing"), Type.Literal("incoming"), Type.Literal("related")]),
          ),
          relation: Type.Optional(
            Type.Union([
              Type.Literal("RELATES_TO"),
              Type.Literal("DEPENDS_ON"),
              Type.Literal("PRODUCES"),
              Type.Literal("DERIVED_FROM"),
              Type.Literal("BELONGS_TO"),
              Type.Literal("CONTAINS"),
              Type.Literal("SPAWNED"),
            ]),
          ),
        },
        { additionalProperties: false },
      ),
      execute: async (_toolCallId: string, params: { type: string; id: string; direction?: string; relation?: string }) => {
        const direction = (params.direction ?? "related") as "outgoing" | "incoming" | "related";
        const rel = params.relation as import("../../shared/work-graph").WorkGraphRelation | undefined;
        try {
          const type = params.type as import("../../shared/work-graph").WorkGraphNodeType;
          let edges: import("../../shared/work-graph").WorkGraphEdgeDto[] = [];
          if (direction === "outgoing") edges = service.listOutgoing(type, params.id, rel);
          else if (direction === "incoming") edges = service.listIncoming(type, params.id, rel);
          else edges = service.listRelated(type, params.id, rel);
          if (edges.length === 0) {
            return textResult(`无关联（${type}:${params.id}${rel ? ` / ${rel}` : ""} / ${direction}）`, { edges: [] });
          }
          const lines = [
            `关联数 ${edges.length}（${type}:${params.id} / ${direction}${rel ? ` / ${rel}` : ""}）：`,
            ...edges.map(
              (e) => `- [${e.relation}] ${e.fromType}:${e.fromId} → ${e.toType}:${e.toId} · id=${e.id}`,
            ),
          ];
          return textResult(lines.join("\n"), { edges });
        } catch (e) {
          return errorResult("query_work_graph", e);
        }
      },
    });
  };
}
