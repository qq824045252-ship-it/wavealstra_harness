import type { Cursor, EntryRecord, SubmissionRecord, Tx } from "@earendil-works/pi-durable";
import { basename } from "node:path";
import type { ConversationInteractionDto } from "../../../shared/conversation-interaction";
import { collectReplyCitations, providedReplySources, replyToolSources } from "../../../shared/chat-reply-sources";
import type { ReplyCitation } from "../../../shared/chat-reply-content";
import { searchReportFromDetails } from "../../../shared/web-search";
import { nativeExecutionSucceeded } from "../../../shared/native-execution-receipt";
import { dotsDeliveryText, dotsMissingInputQuestion, readDotsWorkerOutcome, type DotsWorkerOutcome } from "../../dots/DotsWorkerOutcome";
import { durableRegisteredArtifact } from "./DurableArtifactRegistration";
import { durableContentText, nestedToolRow, type NestedCallDetail } from "./DurableHistoryProjection";

export function durableDotsReplySources(entry: EntryRecord, includeUser: boolean) {
  const sources: ReturnType<typeof replyToolSources> = [];
  for (const message of entry.model ?? []) {
    if (message.role === "user" && includeUser) {
      sources.push(...providedReplySources(durableContentText(message.content)));
    }
    if (message.role !== "toolResult" || !nativeExecutionSucceeded(message, { conversationId: entry.conversationId,
      toolTaskId: entry.byTaskId, toolName: message.toolName, callId: message.toolCallId })) continue;
    sources.push(...replyToolSources({ tool: message.toolName, status: "success", output: durableContentText(message.content),
      detail: message.details === undefined ? undefined : JSON.stringify(message.details), webSearch: searchReportFromDetails(message.details) }));
    if (message.toolName === "codemode") {
      const calls = (message.details as { calls?: readonly NestedCallDetail[] } | undefined)?.calls;
      if (Array.isArray(calls)) for (const [index, call] of calls.entries()) {
        sources.push(...replyToolSources(nestedToolRow(message.toolCallId, call, index)));
      }
    }
  }
  return sources;
}

/** Registered files name the producing input. Intermediate statements and tool
 * attachments belong only to its native interval, ending before the next user. */
export async function readDurableDotsResult(tx: Tx, input: Extract<SubmissionRecord, {type: "input"}>,
  directory: string, question?: ConversationInteractionDto, accepted?: { text: string; citations?: ReplyCitation[] },
  requestedFilename?: string) {
  const files = new Map<string, { path: string; snapshotPath: string; manifestPath?: string }>();
  const registeredForDelivery = new Set<string>();
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
      if (file) {
        files.set(file.path, { path: file.path, snapshotPath: file.snapshotPath, manifestPath: file.previewManifestPath });
        if (file.explicitlyRegistered) registeredForDelivery.add(file.path);
      }
      if (!inOwnTurn && item.byTaskId !== final?.byTaskId) continue;
      if (!accepted?.citations && (answer?.stopReason === "stop" || accepted))
        sources.push(...durableDotsReplySources(item, item.id === input.entry));
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
  const deliveryAssets = { files: assets.files.filter(file => registeredForDelivery.has(file.path)), messageIds: [] };
  if (question) {
    const options = question.options.filter(o => !o.disabled).map(o => o.description ? `${o.label}（${o.description}）` : o.label);
    const prompt = [question.title, question.description, options.length ? options.join(" / ") : undefined].filter(Boolean).join("\n");
    return { status: "blocked" as const, interactionId: question.id,
      text: [checkpoint?.result, prompt].filter(Boolean).join("\n\n"), ...deliveryAssets };
  }
  if (input.status === "placed") return { status: "running" as const, text: checkpoint ? JSON.stringify(checkpoint) : "", messageIds: [], files: [] };
  // An accepted Goal can be delivered even if the worker's final composition fails.
  // Only sources retained in this native input can verify its accepted body.
  const acceptedCitations = accepted && (accepted.citations ?? collectReplyCitations(accepted.text, sources));
  if (input.status === "unanswered") {
    const detail = typeof input.detail === "string" ? input.detail
      : input.detail && typeof input.detail === "object" && !Array.isArray(input.detail) && typeof input.detail.message === "string" ? input.detail.message : "";
    return { status: "failed" as const, text: detail || error || input.reason, citations: acceptedCitations, ...assets };
  }
  if (!answer || answer.stopReason !== "stop") {
    return { status: "failed" as const, text: answer?.errorMessage || error || "本次执行未能完成", citations: acceptedCitations, ...assets };
  }
  const text = durableContentText(answer.content).trim();
  const outcome = readDotsWorkerOutcome(text);
  const delivery = outcome ? dotsDeliveryText(outcome) : text;
  const citations = acceptedCitations ?? collectReplyCitations(delivery, sources);
  if (!accepted && outcome?.dotsState === "blocked") {
    return { status: "blocked" as const, text: delivery, ...deliveryAssets };
  }
  if (!accepted && outcome?.dotsState !== "progress") {
    const question = dotsMissingInputQuestion(delivery, outcome?.result ?? "");
    if (question) return { status: "blocked" as const, text: question, ...deliveryAssets };
  }
  if (outcome?.dotsState === "complete") {
    if (requestedFilename) {
      // A precisely named deliverable can use the host's immutable write/edit receipt.
      const named = assets.files.filter(file => basename(file.path) === requestedFilename);
      if (named.length !== 1) return { status: "failed" as const,
        text: `原任务未能唯一确认交付文件「${requestedFilename}」。`, messageIds: [], files: [] };
      return { status: "completed" as const, text: JSON.stringify({ dotsState: "complete", result: delivery }),
        citations, ...deliveryAssets, files: named };
    }
    if (outcome.delivery) return { status: "completed" as const,
      text: JSON.stringify({ dotsState: "complete", result: delivery }), citations, ...deliveryAssets };
  }
  return { status: "completed" as const, text, citations, ...(outcome?.dotsState === "progress" ? deliveryAssets : assets) };
}
