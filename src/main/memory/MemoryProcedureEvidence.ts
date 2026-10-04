import type { MemoryProcedureExecutionDto } from "../../shared/memory-kernel";

/** Capture host-owned tool results from this turn, never an assistant's claim of success. */
export function captureProcedureExecution(messages: unknown[]): MemoryProcedureExecutionDto | undefined {
  let start = messages.length;
  // Queued-turn activation may already have appended the next user message.
  if ((messages[start - 1] as { role?: string })?.role === "user") start--;
  let userIndex = start - 1;
  while (userIndex >= 0 && (messages[userIndex] as { role?: string })?.role !== "user") userIndex--;
  if (userIndex < 0) return undefined;
  const turn = messages.slice(userIndex + 1, start) as Array<Record<string, any>>;
  const final = [...turn].reverse().find((message) => message.role === "assistant");
  if (!final || final.stopReason !== "stop") return undefined;
  const calls = new Map<string, { name: string; arguments: string }>();
  const tools: MemoryProcedureExecutionDto["tools"] = [];
  for (const message of turn) {
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block.type !== "toolCall" || typeof block.id !== "string" || typeof block.name !== "string") continue;
        const args = JSON.stringify(block.arguments ?? {});
        // Memory/skill reads cannot bootstrap themselves into new learned procedures.
        if (/memory|skill/i.test(block.name) || /SKILL\.md|auth\.json|\.env(?:["/\\]|$)/i.test(args)) continue;
        calls.set(block.id, { name: block.name, arguments: args.slice(0, 1800) });
      }
    }
    if (message.role !== "toolResult" || message.isError !== false) continue;
    const call = calls.get(message.toolCallId);
    if (!call || message.toolName !== call.name || !Array.isArray(message.content)) continue;
    const result = message.content.filter((block: any) => block.type === "text" && typeof block.text === "string")
      .map((block: any) => block.text).join("\n").trim();
    if (!result || /(?:sk|ghp|github_pat|xox[baprs])[-_][A-Za-z0-9_-]{12,}|(?:password|access_token|refresh_token|api_key)\s*[=:]/i.test(result + call.arguments)) continue;
    calls.delete(message.toolCallId);
    tools.push({ toolCallId: message.toolCallId, name: call.name, arguments: call.arguments, result: result.slice(0, 2400) });
  }
  // A reusable workflow needs a sequence, rather than one isolated tool result.
  return tools.length >= 2 ? { version: 1, completed: true, tools: tools.slice(-8) } : undefined;
}

export function procedureExecution(metadata: Record<string, unknown>): MemoryProcedureExecutionDto | undefined {
  const value = metadata.procedureExecution as MemoryProcedureExecutionDto | undefined;
  if (value?.version !== 1 || value.completed !== true || !Array.isArray(value.tools) || value.tools.length < 2) return undefined;
  if (!value.tools.every((tool) => tool && typeof tool.toolCallId === "string" && typeof tool.name === "string"
    && typeof tool.arguments === "string" && typeof tool.result === "string" && tool.result.trim())) return undefined;
  return value;
}
