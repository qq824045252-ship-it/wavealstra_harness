import type { ToolExecutionResult } from "@earendil-works/pi-durable";
import { z } from "zod";

const skill = z.object({ created: z.literal(true), result: z.object({ skill: z.object({
  id: z.string(), description: z.string(), installed: z.literal(true), filePath: z.string(),
}) }) });

function toolValue(result: ToolExecutionResult): unknown {
  if (result.structuredOutput ?? result.details) return result.structuredOutput ?? result.details;
  const first = result.output?.[0];
  if (first?.type !== "text") return undefined;
  try { return JSON.parse(first.text); } catch { return undefined; }
}

export function durableGoalToolEvidence(toolName: string, result: ToolExecutionResult): {
  skill?: z.infer<typeof skill>["result"]["skill"];
  readPath?: string;
} | undefined {
  if (result.isError) return undefined;
  if (toolName === "skill_authoring_create") {
    const value = skill.safeParse(toolValue(result));
    return value.success ? { skill: value.data.result.skill } : undefined;
  }
  return undefined;
}
