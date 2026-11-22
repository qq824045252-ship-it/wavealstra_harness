import type { Cursor, SubmissionRecord, Tx } from "@earendil-works/pi-durable";
import type { ConversationInteractionDto } from "../../../shared/conversation-interaction";
import { collectReplyCitations, providedReplySources, replyToolSources } from "../../../shared/chat-reply-sources";
import { searchReportFromDetails } from "../../../shared/web-search";
import { readDotsWorkerOutcome, type DotsWorkerOutcome } from "../../dots/DotsWorkerOutcome";
import { durableRegisteredArtifact } from "./DurableArtifactRegistration";
import { durableContentText, nestedToolRow, type NestedCallDetail } from "./DurableHistoryProjection";

/** Registered files name the producing input. Intermediate statements and tool
 * attachments belong only to its native interval, ending before the next user. */
export async function readDurableDotsResult(tx: Tx, input: Extract<SubmissionRecord, {type: "input"}>,
  directory: string, question?: ConversationInteractionDto) {
  const files = new Map<string, { path: string; snapshotPath: string; manifestPath?: string }>();
  const messageIds = new Set<string>();
  const sources: ReturnType<typeof replyToolSources> = [];
  const final = input.status === "done" ? await tx.entry(input.answer) : undefined;
  const answer = final?.model?.find(message => message.role === "assistant");
  let error = "";
  let checkpoint: Extract<DotsWorkerOutcome, { dotsState: "progress" }> | undefined;
  let inOwnTurn = true;
  let cursor: Cursor | undefined;
  if (input.entry !== undefined) do {
    const page = await tx.scanEntries({ conversationId: input.conversationId, minEntryId: input.entry,
      ...(input.status === "done" ? { maxEntryId: input.answer } : {}), order: "ascending" }, 100, cursor);
    for (const item of page.items) {
      if (item.id !== input.entry && (item.kind === "pi.user" || item.kind === "mybuddy.user")) inOwnTurn = false;
      if (!inOwnTurn && input.status !== "done") break;
      const file = durableRegisteredArtifact(item, input.id, undefined, directory);
      if (file) files.set(file.path, { path: file.path, snapshotPath: file.snapshotPath, manifestPath: file.previewManifestPath });
      if (!inOwnTurn && item.byTaskId !== final?.byTaskId) continue;
      if (answer?.stopReason === "stop") for (const message of item.model ?? []) {
        if (message.role === "user" && item.id === input.entry) {
          sources.push(...providedReplySources(durableContentText(message.content)));
        }
        if (message.role !== "toolResult" || message.isError) continue;
        sources.push(...replyToolSources({ tool: message.toolName, status: "success", output: durableContentText(message.content),
          detail: message.details === undefined ? undefined : JSON.stringify(message.details), webSearch: searchReportFromDetails(message.details) }));
        if (message.toolName === "codemode") {
          const calls = (message.details as { calls?: readonly NestedCallDetail[] } | undefined)?.calls;
          if (Array.isArray(calls)) for (const [index, call] of calls.entries()) {
            sources.push(...replyToolSources(nestedToolRow(message.toolCallId, call, index)));
          }
        }
      }
      if (item.kind !== "pi.assistant" || item.byTaskId === undefined) continue;
      messageIds.add(`durable-${item.id}`);
      const assistant = item.model?.find(m => m.role === "assistant");
      if (assistant?.errorMessage) error = assistant.errorMessage;
      if (assistant?.stopReason === "toolUse") {
        const candidate = readDotsWorkerOutcome(durableContentText(assistant.content));
        if (candidate?.dotsState === "progress" && candidate.result.trim()) checkpoint = candidate;
      }
    }
    cursor = inOwnTurn || input.status === "done" ? page.next : undefined;
  } while (cursor);
  if (final) messageIds.add(`durable-${final.id}`);
  const assets = { files: [...files.values()], messageIds: [...messageIds] };
  if (question) {
    const options = question.options.filter(o => !o.disabled).map(o => o.description ? `${o.label}（${o.description}）` : o.label);
    const prompt = [question.title, question.description, options.length ? options.join(" / ") : undefined].filter(Boolean).join("\n");
    return { status: "blocked" as const, interactionId: question.id,
      text: [checkpoint?.result, prompt].filter(Boolean).join("\n\n"), ...assets };
  }
  if (input.status === "placed") return { status: "running" as const, text: checkpoint ? JSON.stringify(checkpoint) : "", messageIds: [], files: [] };
  if (input.status === "unanswered") {
    const detail = typeof input.detail === "string" ? input.detail
      : input.detail && typeof input.detail === "object" && !Array.isArray(input.detail) && typeof input.detail.message === "string" ? input.detail.message : "";
    return { status: "failed" as const, text: detail || error || input.reason, ...assets };
  }
  if (!answer || answer.stopReason !== "stop") {
    return { status: "failed" as const, text: answer?.errorMessage || error || "本次执行未能完成", ...assets };
  }
  const text = durableContentText(answer.content).trim();
  const citations = collectReplyCitations(readDotsWorkerOutcome(text)?.result ?? text, sources);
  return { status: "completed" as const, text, citations, ...assets };
}
