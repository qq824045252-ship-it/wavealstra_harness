import type { EntryRecord } from "@earendil-works/pi-durable";
import type { Message } from "@earendil-works/pi-ai";
import { captureProcedureExecution } from "../../memory/MemoryProcedureEvidence";
import type { CaptureMemoryTurnInput } from "../../memory/MemoryTurnRepository";

export function durableText(content: unknown): string {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter(part => part?.type === "text").map(part => part.text).join("\n") : "";
}

/** Pure projection of committed entries. Live streaming text, summaries and failed responses are not completed turns. */
export function durableCompletedTurns(taskId: string, conversationId: string, entries: readonly EntryRecord[],
  nested: ReadonlyMap<number, readonly EntryRecord[]> = new Map(), inputMetadata: ReadonlyMap<number, { text: string }> = new Map()): Array<CaptureMemoryTurnInput & { entryId: number }> {
  const turns: Array<CaptureMemoryTurnInput & { entryId: number }> = [];
  let users: EntryRecord[] = [], evidence: Message[] = [];
  for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
    if (entry.kind === "pi.user") {
      const previous = [...evidence].reverse().find(message => message.role === "assistant");
      if (previous?.role === "assistant" && ["error", "aborted", "length"].includes(previous.stopReason)) { users = []; evidence = []; }
      users.push(entry); evidence.push(...(entry.model ?? []));
    }
    else if (entry.kind === "pi.assistant" || entry.kind === "pi.tool-result") {
      for (const message of entry.model ?? []) {
        if (message.role === "toolResult" && message.toolName === "codemode") {
          const child = (message.details as { conversationId?: number } | undefined)?.conversationId;
          if (child) evidence.push(...(nested.get(child) ?? []).flatMap(value => [...value.model ?? []]));
        }
        evidence.push(message);
        if (message.role !== "assistant" || message.stopReason !== "stop" || !users.length) continue;
        const id = (value: number) => `durable:${taskId}:${conversationId}:${value}`;
        const procedureExecution = captureProcedureExecution(evidence);
        turns.push({ entryId: entry.id, taskId, sessionId: `durable:${taskId}:${conversationId}`,
          userMessageId: id(users[0].id), assistantMessageId: id(entry.id),
          userText: users.map(value => inputMetadata.get(value.id)?.text ?? (value.model ?? []).map(message => durableText(message.content)).join("\n")).join("\n"),
          assistantText: durableText(message.content), capturedAt: message.timestamp,
          metadata: { backend: "pi-durable", ...(procedureExecution ? { procedureExecution } : {}) },
        });
        users = []; evidence = [];
      }
    } else if (entry.kind === "pi.reset") { users = []; evidence = []; }
  }
  return turns;
}
